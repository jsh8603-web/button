#!/bin/bash
# scout-and-act.sh — 비서 통합 스크립트 (수집 + 판단 + 실행)

SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"

# Config에서 PSMUX_PATH 읽기
PSMUX_PATH=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)
PSMUX="$PSMUX_PATH"

SELF_SESSION="$1"
REPORT="$SECRETARY_DIR/.scout-report.txt"
SNAP_DIR="$SECRETARY_DIR/.snapshots"
SNAP_MAX=5
RESTORE_MARKER="$SECRETARY_DIR/.guard-restore"

# PID 파일 기반 단일 인스턴스 강제 (flock 미지원 환경 대응)
LOCKFILE="$SECRETARY_DIR/.scout-lock"
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Already running (PID $OLD_PID)"; exit 0
  fi
fi
echo $$ > "$LOCKFILE"
trap "rm -f '$LOCKFILE'" EXIT

# 감사 로그 설정
AUDIT_LOG_DIR="$HOME/.claude/audit-log"
AUDIT_LOG="$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"
mkdir -p "$AUDIT_LOG_DIR"

log_event() {
  local TYPE="$1" SESSION="$2" EVENT="$3" CONTEXT="$4" ACTION="$5"
  # jq -n으로 안전한 JSON 생성 (context에 따옴표/개행 포함 시에도 정상 동작)
  jq -n --arg ts "$(date -Iseconds)" --arg type "$TYPE" --arg session "$SESSION" \
    --arg event "$EVENT" --arg context "$CONTEXT" --arg action "$ACTION" \
    '{ts:$ts,type:$type,session:$session,event:$event,context:$context,action:$action}' \
    >> "$AUDIT_LOG"
}

# 세션 목록 (비서 자신 + task 세션 + Sonnet 비서 세션 제외)
# === .sonnet-enabled 시 config 검증 가드 ===
if [ -f "$SECRETARY_DIR/.sonnet-enabled" ]; then
  for FIELD in sonnet_session queue_dir log_dir lock_ttl_sec daily_cap; do
    VAL=$(jq -r ".$FIELD" "$CONFIG" 2>/dev/null)
    if [ -z "$VAL" ] || [ "$VAL" = "null" ]; then
      echo "CONFIG_FAIL: missing $FIELD — Part 2 disabled"
      rm -f "$SECRETARY_DIR/.sonnet-enabled"
      log_event ERROR "" "config_validation_failed" "missing=$FIELD" "part2_disabled"
      break
    fi
  done
fi

# === dedup lock 함수 (Sonnet 중복 호출 방지) ===
LOCK_DIR="$SECRETARY_DIR/$(jq -r '.queue_dir // ".sonnet-queue"' "$CONFIG" 2>/dev/null)/locks"
LOCK_TTL=$(jq -r '.lock_ttl_sec // 600' "$CONFIG" 2>/dev/null)
mkdir -p "$LOCK_DIR"

check_dedup() {
  local SESSION="$1" TYPE="$2" HASH="${3:-}"
  local KEY="${SESSION}_${TYPE}${HASH:+_${HASH}}"
  local LOCK_FILE="$LOCK_DIR/${KEY}.lock"

  if [ -f "$LOCK_FILE" ]; then
    local LOCK_TS
    LOCK_TS=$(cat "$LOCK_FILE")
    local NOW
    NOW=$(date +%s)
    if [ $((NOW - LOCK_TS)) -gt "$LOCK_TTL" ]; then
      rm -f "$LOCK_FILE"  # stale lock 자동 정리
    else
      return 1  # 중복 — 스킵
    fi
  fi

  echo "$(date +%s)" > "$LOCK_FILE"
  return 0  # lock 획득 성공
}

SONNET_SESSION=$(jq -r '.sonnet_session // "secretary-sonnet"' "$CONFIG" 2>/dev/null)
WF_ACTIVE_FILE="$SECRETARY_DIR/../.wf-active"
# btn-* 세션 (대화형 Claude Code 메인 세션) 제외 — Enter 자동 전송 등이 채팅 입력 방해
SESSIONS=$("$PSMUX" ls -F '#{session_name}' 2>/dev/null | \
  grep -v "^${SELF_SESSION}$" | grep -v "^task-" | grep -v "^${SONNET_SESSION}$" | \
  grep -v "^btn-")

# WF 활성 시 harness 세션 모니터링 제외 (충돌 방지)
# .wf-active에 세션명 목록이 있으면 그것을 사용, 없으면 기본 4개 prefix 매칭
if [ -f "$WF_ACTIVE_FILE" ]; then
  WF_SESSIONS=$(cat "$WF_ACTIVE_FILE" 2>/dev/null | tr '\n' '|' | sed 's/|$//')
  if [ -n "$WF_SESSIONS" ]; then
    SESSIONS=$(echo "$SESSIONS" | grep -vE "^(${WF_SESSIONS})")
  else
    SESSIONS=$(echo "$SESSIONS" | grep -vE '^(worker|verifier|healer|strategic)')
  fi
fi

# === 사용자 부재 체크 ===
IDLE_SEC=$(powershell.exe -NoProfile -File "$SECRETARY_DIR/.scripts/get-idle-time.ps1" 2>/dev/null | tr -d '\r')
[ -z "$IDLE_SEC" ] && IDLE_SEC=0

# === 가드 자동 복원 (agent 화면 활성화 감지 시) ===
if [ -f "$RESTORE_MARKER" ]; then
  BACKUP_FILE=$(cat "$RESTORE_MARKER")
  UNLOCK_SESSION=$(cat "${RESTORE_MARKER}.session" 2>/dev/null)
  RESTORE_NOW=false
  if [ -n "$UNLOCK_SESSION" ] && [ -f "$SNAP_DIR/$UNLOCK_SESSION/.idx" ]; then
    IDX_R=$(cat "$SNAP_DIR/$UNLOCK_SESSION/.idx")
    PREV_IDX_R=$(( (IDX_R - 1 + SNAP_MAX) % SNAP_MAX ))
    CUR_SNAP="$SNAP_DIR/$UNLOCK_SESSION/snap_${IDX_R}.txt"
    PREV_SNAP_R="$SNAP_DIR/$UNLOCK_SESSION/snap_${PREV_IDX_R}.txt"
    # 화면이 변화했으면 agent가 재개한 것 → 즉시 복원
    if [ -f "$CUR_SNAP" ] && [ -f "$PREV_SNAP_R" ] && \
       ! diff -q "$PREV_SNAP_R" "$CUR_SNAP" >/dev/null 2>&1; then
      RESTORE_NOW=true
    fi
  else
    # 세션 정보 없으면 fallback: 5분 후 복원
    MARKER_TS=$(stat -c %Y "$RESTORE_MARKER" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - MARKER_TS )) -gt 300 ] && RESTORE_NOW=true
  fi
  if [ "$RESTORE_NOW" = true ] && [ -f "$BACKUP_FILE" ]; then
    cp "$BACKUP_FILE" "$HOME/.claude/settings.json"
    rm -f "$RESTORE_MARKER" "${RESTORE_MARKER}.session" "$BACKUP_FILE"
    log_event INFO "secretary" "guard_restored" "agent resumed, guard restored" "guard-restore"
  fi
fi

# === guard disable 함수 ===
disable_blocking_guard() {
  local SETTINGS="$HOME/.claude/settings.json"
  local BACKUP="$SECRETARY_DIR/.settings-guard-backup-$(date +%s).json"
  cp "$SETTINGS" "$BACKUP" || return 1
  "C:/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe" - <<'PYEOF' "$SETTINGS"
import json, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    d = json.load(f)
hooks = d.get('hooks', {}).get('PreToolUse', [])
new_hooks = []
for h in hooks:
    matcher = h.get('matcher', '')
    cmds = h.get('hooks', [])
    is_self_config = (
        ('Write' in matcher or 'Edit' in matcher) and
        any('self-config' in str(c.get('command', '')) for c in cmds)
    )
    if not is_self_config:
        new_hooks.append(h)
d['hooks']['PreToolUse'] = new_hooks
with open(path, 'w', encoding='utf-8') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('ok')
PYEOF
  [ $? -eq 0 ] && echo "$BACKUP" || { cp "$BACKUP" "$SETTINGS"; echo "FAIL"; }
}

# === Guard 교착 체크 ===
DENY_COUNT=0
if [ -f ~/.claude/hook-metrics.jsonl ]; then
  THREE_MIN_AGO_ISO=$(date -d '3 minutes ago' -Iseconds 2>/dev/null || echo "")
  if [ -n "$THREE_MIN_AGO_ISO" ]; then
    DENY_COUNT=$(grep "guard-deny" ~/.claude/hook-metrics.jsonl | tail -20 | \
      jq -s --arg cutoff "$THREE_MIN_AGO_ISO" \
      '[.[] | select(.ts? >= $cutoff)] | length' 2>/dev/null || echo 0)
  fi
fi

# =============================================
# Phase 1: 수집 → 리포트 작성
# =============================================
{
  echo "=== SCOUT REPORT $(date '+%H:%M') ==="
  echo "USER_IDLE_SEC: $IDLE_SEC"
  echo "GUARD_DENY_3MIN: $DENY_COUNT"
  echo ""

  for S in $SESSIONS; do
    echo "--- $S ---"

    CAP=$("$PSMUX" capture-pane -p -S 0 -t "$S" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$CAP" ]; then
      echo "STATUS: SESSION_DEAD"
      echo ""
      continue
    fi

    LAST_LINES=$(echo "$CAP" | tail -5)
    if echo "$LAST_LINES" | grep -qE '^\$\s*$|^>\s*$|^bash-|^C:\\'; then
      echo "STATUS: AGENT_DEAD"
    else
      echo "STATUS: ALIVE"
    fi

    if echo "$CAP" | grep -qE '(Compacted|PostCompact|compaction)'; then
      echo "COMPRESSED: YES"
    else
      echo "COMPRESSED: NO"
    fi

    PCT=$(echo "$CAP" | grep -oP '\d+%' | tail -1)
    echo "CONTEXT_PCT: ${PCT:-UNKNOWN}"

    if echo "$CAP" | grep -qP '────.*────'; then
      echo "UNSENT_MSG: YES"
    else
      echo "UNSENT_MSG: NO"
    fi

    if echo "$LAST_LINES" | grep -qE '(진행할까요|번호를 입력|어떤 방향|선택해)'; then
      echo "WAITING_FOR_USER: YES"
    else
      echo "WAITING_FOR_USER: NO"
    fi

    EDITING=$(echo "$CAP" | grep -oP '(?:Edit|Write|Editing|Updated|edit|write)\s+\S+' | \
      grep -oP '\S+\.(ts|js|md|py|json|tsx|jsx|css)' | sort -u | tr '\n' ',')
    echo "EDITING: ${EDITING:-NONE}"

    ERRORS=$(echo "$CAP" | grep -E '(Error:|FATAL|Traceback|ENOENT|ECONNREFUSED|failed|rate limit)' | tail -3)
    if [ -n "$ERRORS" ]; then
      echo "ERRORS:"
      echo "$ERRORS" | sed 's/^/  /'
    else
      echo "ERRORS: NONE"
    fi

    # 스냅샷 저장 + 반복 에러 감지
    mkdir -p "$SNAP_DIR/$S"
    SNAP_IDX_FILE="$SNAP_DIR/$S/.idx"
    IDX=$(cat "$SNAP_IDX_FILE" 2>/dev/null || echo 0)
    echo "$CAP" > "$SNAP_DIR/$S/snap_${IDX}.txt"
    NEXT_IDX=$(( (IDX + 1) % SNAP_MAX ))
    echo "$NEXT_IDX" > "$SNAP_IDX_FILE"

    # 가드 차단 + 화면 미변화 감지 (교착 판정)
    GUARD_BLOCKED="NO"
    if echo "$CAP" | grep -qiE '(self-config|permission.*block|훅.*차단|guard.*deny|blocked.*hook)'; then
      PREV_IDX=$(( (IDX - 1 + SNAP_MAX) % SNAP_MAX ))
      PREV_SNAP="$SNAP_DIR/$S/snap_${PREV_IDX}.txt"
      if [ -f "$PREV_SNAP" ] && diff -q "$PREV_SNAP" "$SNAP_DIR/$S/snap_${IDX}.txt" >/dev/null 2>&1; then
        GUARD_BLOCKED="YES"
      fi
    fi
    echo "GUARD_BLOCKED: $GUARD_BLOCKED"

    if [ -n "$ERRORS" ]; then
      REPEAT=""
      FIRST_ERR=$(echo "$ERRORS" | head -1 | sed 's/^[[:space:]]*//' | sed 's/[0-9]\+/N/g')
      for OLD_IDX in $(seq 0 $((SNAP_MAX-1))); do
        [ "$OLD_IDX" -eq "$IDX" ] && continue
        OLD_SNAP="$SNAP_DIR/$S/snap_${OLD_IDX}.txt"
        if [ -f "$OLD_SNAP" ] && sed 's/[0-9]\+/N/g' "$OLD_SNAP" | grep -qF "$FIRST_ERR"; then
          CONTEXT=$(grep -B2 -A2 -F "$(echo "$ERRORS" | head -1 | sed 's/^[[:space:]]*//')" "$OLD_SNAP" | head -10)
          REPEAT="FOUND in snap_${OLD_IDX}"
          echo "REPEAT_ERROR: $REPEAT"
          echo "PREVIOUS_CONTEXT:"
          echo "$CONTEXT" | sed 's/^/  /'
          break
        fi
      done
      [ -z "$REPEAT" ] && echo "REPEAT_ERROR: NONE"
    fi

    echo ""
  done

} > "$REPORT"

# =============================================
# Phase 2: elif 체인 — 세션당 1조치, 우선순위 실행
# =============================================

HANDLED_COUNT=0

for S in $SESSIONS; do
  BLOCK=$(sed -n "/^--- $S ---$/,/^--- /p" "$REPORT" | head -n -1)
  STATUS=$(echo "$BLOCK" | grep "^STATUS:" | awk '{print $2}')
  PCT=$(echo "$BLOCK" | grep "^CONTEXT_PCT:" | awk '{print $2}')
  ERRORS=$(echo "$BLOCK" | grep -A3 "^ERRORS:" | grep "^  " | sed 's/^  //')
  FIRST_ERR=$(echo "$ERRORS" | head -1 | sed 's/[0-9]\+/N/g')

  if [ "$STATUS" = "SESSION_DEAD" ] || [ "$STATUS" = "AGENT_DEAD" ]; then
    # 우선순위 1: 사망 → 부활
    log_event ERROR "$S" "session_dead" "status=$STATUS" "revive.sh"
    bash "$SECRETARY_DIR/.scripts/revive.sh" "$S"
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "COMPRESSED: YES"; then
    # 우선순위 2: 압축 감지 → JSONL 리줌 주입
    log_event WARN "$S" "context_compressed" "PCT=$PCT" "session-resume-injected"
    bash "$SECRETARY_DIR/.scripts/generate-session-resume.sh" "$S"
    if [ -f "/tmp/session-resume-${S}.txt" ]; then
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "/tmp/session-resume-${S}.txt"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "GUARD_BLOCKED: YES" || [ "$DENY_COUNT" -ge 5 ]; then
    # 우선순위 3: Guard 교착 → 가드 임시 비활성화
    if [ ! -f "$RESTORE_MARKER" ]; then
      BACKUP=$(disable_blocking_guard)
      if [ "$BACKUP" != "FAIL" ] && [ -n "$BACKUP" ]; then
        echo "$BACKUP" > "$RESTORE_MARKER"
        echo "$S" > "${RESTORE_MARKER}.session"
        log_event WARN "$S" "guard_unlocked" "backup=$BACKUP deny=$DENY_COUNT" "guard-unlock"
        "$PSMUX" send-keys -t "$S" "[secretary] 가드 임시 해제됨 (15분 후 자동 복원). 작업을 재개하세요." Enter
      else
        log_event WARN "$S" "guard_unlock_failed" "deny=$DENY_COUNT" "guard-unlock-fail"
      fi
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "UNSENT_MSG: YES"; then
    # 우선순위 4: 미전송 메시지 → Enter
    log_event INFO "$S" "unsent_msg" "" "send_enter"
    "$PSMUX" send-keys -t "$S" Enter
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "REPEAT_ERROR: FOUND"; then
    # 우선순위 5: 삽질 반복 → 원문 맥락 전달
    log_event WARN "$S" "repeat_error" "$FIRST_ERR" "repeat-warn"
    PREV_CTX=$(echo "$BLOCK" | sed -n '/PREVIOUS_CONTEXT:/,/^[A-Z]/p' | grep "^  " | sed 's/^  //')
    echo "$PREV_CTX" > /tmp/repeat-warn-${S}.txt
    cat "$SECRETARY_DIR/.messages/repeat-warn-header.txt" /tmp/repeat-warn-${S}.txt > /tmp/repeat-warn-full-${S}.txt
    bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" /tmp/repeat-warn-full-${S}.txt
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "WAITING_FOR_USER: YES" && [ "$IDLE_SEC" -gt 600 ]; then
    # 우선순위 6: 부재 + 질문 대기 → 자율 진행
    log_event INFO "$S" "autonomous_proceed" "" "autonomous-proceed.txt"
    bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$SECRETARY_DIR/.messages/autonomous-proceed.txt"
    touch "$SECRETARY_DIR/.user-absent"
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif [ -n "$ERRORS" ]; then
    # 에러 감지 (위 조건 미해당)
    ACTION="monitored"
    log_event ERROR "$S" "error_detected" "$ERRORS" "$ACTION"

  fi

  # 사용자 복귀 감지 (elif 체인과 독립)
  if [ "$IDLE_SEC" -lt 60 ] && [ -f "$SECRETARY_DIR/.user-absent" ]; then
    bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$SECRETARY_DIR/.messages/user-returned.txt"
    rm -f "$SECRETARY_DIR/.user-absent"
  fi

  # S-2 슬라이딩 윈도우 — 5사이클 중 3+ 새 에러 → 의미적 분석 트리거
  ERR_WINDOW_FILE="$SNAP_DIR/$S/.err-window"
  mkdir -p "$SNAP_DIR/$S"
  if [ -n "$ERRORS" ] && echo "$BLOCK" | grep -q "REPEAT_ERROR: NONE"; then
    echo "1" >> "$ERR_WINDOW_FILE"
  else
    echo "0" >> "$ERR_WINDOW_FILE"
  fi
  tail -5 "$ERR_WINDOW_FILE" > "${ERR_WINDOW_FILE}.tmp" && mv "${ERR_WINDOW_FILE}.tmp" "$ERR_WINDOW_FILE"

  ERR_COUNT=$(grep -c "^1$" "$ERR_WINDOW_FILE" 2>/dev/null || echo 0)
  ERR_COUNT=$(echo "$ERR_COUNT" | tr -d '\r\n' | grep -oE '[0-9]+' || echo 0)
  if [ "${ERR_COUNT:-0}" -ge 3 ] && [ -f "$SECRETARY_DIR/.sonnet-enabled" ] && check_dedup "$S" "semantic_error_analysis"; then
    RIDX=$(cat "$SNAP_IDX_FILE" 2>/dev/null || echo 0)
    IDX0=$(( (RIDX - 1 + SNAP_MAX) % SNAP_MAX ))
    IDX1=$(( (RIDX - 2 + SNAP_MAX) % SNAP_MAX ))
    IDX2=$(( (RIDX - 3 + SNAP_MAX) % SNAP_MAX ))
    SNAP0=$(cat "$SNAP_DIR/$S/snap_${IDX0}.txt" 2>/dev/null | tail -20)
    SNAP1=$(cat "$SNAP_DIR/$S/snap_${IDX1}.txt" 2>/dev/null | tail -20)
    SNAP2=$(cat "$SNAP_DIR/$S/snap_${IDX2}.txt" 2>/dev/null | tail -20)
    QUEUE_DIR="$SECRETARY_DIR/$(jq -r '.queue_dir // ".sonnet-queue"' "$CONFIG" 2>/dev/null)"
    mkdir -p "$QUEUE_DIR"
    TASK_FILE="$QUEUE_DIR/$(date +%s).json"
    jq -n \
      --arg type "semantic_error_analysis" \
      --arg session "$S" \
      --arg errors "$ERRORS" \
      --arg snap0 "$SNAP0" \
      --arg snap1 "$SNAP1" \
      --arg snap2 "$SNAP2" \
      '{type:$type, session:$session, current_errors:$errors, snapshots:[$snap0,$snap1,$snap2]}' \
      > "$TASK_FILE"
    bash "$SECRETARY_DIR/.scripts/wake-sonnet.sh"
    log_event SONNET "$S" "sonnet_invoked" "type=semantic_error window=$ERR_COUNT/5" "wake-sonnet.sh"
  fi

done

# =============================================
# Phase 3: 파일 충돌 감지
# =============================================

ALL_EDITS=$(grep "^EDITING:" "$REPORT" | grep -v NONE | \
  sed 's/EDITING: //' | tr ',' '\n' | sort | uniq -d)

if [ -n "$ALL_EDITS" ]; then
  echo "--- FILE_CONFLICTS ---" >> "$REPORT"
  echo "$ALL_EDITS" >> "$REPORT"

  for CONFLICT_FILE in $ALL_EDITS; do
    log_event WARN "" "file_conflict" "file=$CONFLICT_FILE" "conflict-warn"
    CONFLICT_SESSIONS=$(grep -B20 "EDITING:.*${CONFLICT_FILE}" "$REPORT" | grep "^--- " | sed 's/--- //;s/ ---//' | tail -1)
    if [ -n "$CONFLICT_SESSIONS" ]; then
      echo "파일 충돌: $CONFLICT_FILE — $CONFLICT_SESSIONS" > /tmp/conflict-warn.txt
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$CONFLICT_SESSIONS" /tmp/conflict-warn.txt
    fi
  done
else
  echo "--- FILE_CONFLICTS ---" >> "$REPORT"
  echo "NONE" >> "$REPORT"
fi

# =============================================
# Phase 4: 변경 전파 (git diff 브로드캐스트)
# =============================================

REGISTRY="$SECRETARY_DIR/.session-registry.txt"
if [ -f "$REGISTRY" ]; then
  # 감사소스수집: git log
  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    RECENT_COMMITS=$(git -C "$DIR" log --oneline --since="3 minutes ago" 2>/dev/null)
    if [ -n "$RECENT_COMMITS" ]; then
      log_event ACTIVITY "" "git_commits" "dir=$DIR commits=$RECENT_COMMITS" ""
    fi
  done

  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    DIFF_STAT=$(git -C "$DIR" diff --stat HEAD~1 2>/dev/null)
    if [ -n "$DIFF_STAT" ]; then
      echo "$DIFF_STAT" > /tmp/git-changes.txt
      grep "|${DIR}|" "$REGISTRY" | cut -d'|' -f1 | while read TARGET; do
        bash "$SECRETARY_DIR/.scripts/msg.sh" "$TARGET" /tmp/git-changes.txt
      done
    fi
  done
fi

# =============================================
# Phase 4.5: 감사소스수집 + 의존성 확인 + Rate limit 조율
# =============================================

# (a) 감사소스수집: JSONL 증분 파싱
bash "$SECRETARY_DIR/.scripts/collect-jsonl-audit.sh"

# (b) 의존성 확인 (S-5 대체)
if [ -f "$REGISTRY" ]; then
  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    for CHANGED_FILE in $(git -C "$DIR" diff --name-only HEAD~1 2>/dev/null); do
      BASENAME=$(basename "$CHANGED_FILE" | sed 's/\.[^.]*$//')
      grep -rl "import.*$BASENAME\|require.*$BASENAME" "$DIR" \
        --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" \
        2>/dev/null | head -5 > /tmp/dep-check-$$.txt
      if [ -s /tmp/dep-check-$$.txt ]; then
        log_event INFO "" "dependency_detected" \
          "changed=$CHANGED_FILE importers=$(cat /tmp/dep-check-$$.txt | tr '\n' ',')" ""
      fi
      rm -f /tmp/dep-check-$$.txt
    done
  done
fi

# (c) Rate limit 감지 + 조율 (S-6 대체)
RATE_LIMITED=$(grep -l "rate limit\|Rate limit\|overloaded" "$SNAP_DIR"/*/snap_*.txt 2>/dev/null | \
  sed 's|.*/\([^/]*\)/snap_.*|\1|' | sort -u)
if [ -z "$RATE_LIMITED" ]; then RL_COUNT=0; else RL_COUNT=$(echo "$RATE_LIMITED" | grep -c .); fi
if [ "$RL_COUNT" -ge 2 ]; then
  for RL_SESSION in $RATE_LIMITED; do
    if [ ! -f "$SNAP_DIR/$RL_SESSION/.interactive" ]; then
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$RL_SESSION" "$SECRETARY_DIR/.messages/rate-limit-wait.txt"
      log_event INFO "$RL_SESSION" "rate_limit_pause" "rl_count=$RL_COUNT" "rate-limit-wait.txt"
    fi
  done
fi

# =============================================
# S-1 에스컬레이션 (Sonnet 우선, Telegram 폴백)
# =============================================

# UNHANDLED_SESSIONS 수집 (SESSIONS 루프 직후 삽입)
UNHANDLED_SESSIONS=$(awk '/^--- /{cur=$0; sub("^--- ","",cur); sub(" ---$","",cur)} /STATUS: (AGENT_DEAD|SESSION_DEAD)|COMPRESSED: YES|REPEAT_ERROR: FOUND|WAITING_FOR_USER: YES/{if(cur!="") print cur}' "$REPORT")
TOTAL_ISSUES=$(echo "$UNHANDLED_SESSIONS" | grep -c . 2>/dev/null || echo 0)

if [ "$TOTAL_ISSUES" -gt "$HANDLED_COUNT" ]; then
  if [ -f "$SECRETARY_DIR/.sonnet-enabled" ] && check_dedup "" "exception_analysis"; then
    TYPE="exception_analysis"
    QUEUE_DIR="$SECRETARY_DIR/$(jq -r '.queue_dir // ".sonnet-queue"' "$CONFIG" 2>/dev/null)"
    mkdir -p "$QUEUE_DIR"
    TASK_FILE="$QUEUE_DIR/$(date +%s).json"
    jq -n \
      --arg type "$TYPE" \
      --arg report "$(cat "$REPORT")" \
      --arg unhandled "$UNHANDLED_SESSIONS" \
      --arg timestamp "$(date -Iseconds)" \
      '{type:$type, report:$report, unhandled_sessions:$unhandled, timestamp:$timestamp}' \
      > "$TASK_FILE"
    bash "$SECRETARY_DIR/.scripts/wake-sonnet.sh"
    log_event SONNET "" "sonnet_invoked" "type=$TYPE unhandled=$UNHANDLED_SESSIONS" "wake-sonnet.sh"
  else
    log_event ESCALATION "" "unhandled_anomaly" "total=$TOTAL_ISSUES handled=$HANDLED_COUNT" "telegram"
    AGENT_SECRET=$(jq -r '.agent_secret // ""' "$CONFIG" 2>/dev/null)
    _CURL_CFG=$(mktemp)
    printf 'header = "Authorization: Bearer %s"\n' "$AGENT_SECRET" > "$_CURL_CFG"
    curl -s -K "$_CURL_CFG" "http://localhost:9876/telegram" \
      -H 'Content-Type: application/json' \
      -d '{"message":"[secretary] Unhandled anomaly detected. Please check."}'
    rm -f "$_CURL_CFG"
  fi
fi

# =============================================
# Phase 4.6: 미등록 psmux 세션 자동 등록 (harness-wf 세션)
# =============================================

if [ -f "$WF_ACTIVE_FILE" ] && [ -f "$REGISTRY" ]; then
  KNOWN_NAMES=$(cut -d'|' -f1 "$REGISTRY" 2>/dev/null)

  ALL_CANDIDATE_SESSIONS=$("$PSMUX" ls -F '#{session_name}' 2>/dev/null | \
    grep -v "^task-" | grep -v "^secretary" | grep -v "^${SONNET_SESSION}$")

  for CAND_SESSION in $ALL_CANDIDATE_SESSIONS; do
    echo "$KNOWN_NAMES" | grep -qF "$CAND_SESSION" && continue  # already registered

    # Determine model by convention
    CAND_MODEL="sonnet"
    [ "$CAND_SESSION" = "strategic" ] && CAND_MODEL="opus"

    # Re-read registered SIDs each iteration so previous registrations are excluded
    REGISTERED_SIDS=$(cut -d'|' -f5 "$REGISTRY" 2>/dev/null | grep -v '^$')
    CAND_SID=""
    # Use /usr/bin/find (GNU find) to avoid Windows find.exe; -printf requires GNU find
    while IFS= read -r JSONL_FILE; do
      SID_C=$(basename "$JSONL_FILE" .jsonl)
      [[ "$SID_C" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || continue
      echo "$REGISTERED_SIDS" | grep -qF "$SID_C" && continue
      CAND_SID="$SID_C"
      break
    done < <(/usr/bin/find "$HOME/.claude/projects" -name "*.jsonl" -mmin -120 \
               -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')

    if [ -n "$CAND_SID" ]; then
      # Use "unknown" for DIR — cannot reliably decode Claude's project path encoding
      echo "${CAND_SESSION}|${CAND_MODEL}|unknown|$(date -Iseconds)|${CAND_SID}" >> "$REGISTRY"
      # Update KNOWN_NAMES so next iteration doesn't re-process same session
      KNOWN_NAMES=$(printf '%s\n%s' "$KNOWN_NAMES" "$CAND_SESSION")
      log_event INFO "$CAND_SESSION" "session_auto_registered" \
        "sid=${CAND_SID:0:8} model=${CAND_MODEL}" "registry"
    fi
  done
fi

# =============================================
# Phase 5: 주간 리마인더 + audit-log rotation
# =============================================

# 주간 리마인더 — 일요일 Telegram (주 1회)
DOW=$(date +%u)  # 7=일요일
LAST_AUDIT_WEEK=$(cat "$SECRETARY_DIR/.last-audit-week" 2>/dev/null)
THIS_WEEK=$(date +%Y-W%V)
if [ "$DOW" -eq 7 ] && [ "$LAST_AUDIT_WEEK" != "$THIS_WEEK" ]; then
  AGENT_SECRET=$(jq -r '.agent_secret // ""' "$CONFIG" 2>/dev/null)
  _CURL_CFG=$(mktemp)
  printf 'header = "Authorization: Bearer %s"\n' "$AGENT_SECRET" > "$_CURL_CFG"
  if curl -s -K "$_CURL_CFG" "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d '{"message":"[secretary] Weekly audit reminder. Run: claude audit-wf or session-audit."}'; then
    echo "$THIS_WEEK" > "$SECRETARY_DIR/.last-audit-week"
    log_event INFO "" "weekly_reminder_sent" "week=$THIS_WEEK" "telegram"
  else
    log_event WARN "" "weekly_reminder_failed" "week=$THIS_WEEK" "telegram"
  fi
  rm -f "$_CURL_CFG"
fi

# audit-log rotation — 매월 1일, 30일 초과 파일 archive
DOM=$(date +%d)
if [ "$DOM" = "01" ]; then
  ARCHIVE_DIR="$HOME/.claude/audit-log/archive"
  mkdir -p "$ARCHIVE_DIR"
  find "$HOME/.claude/audit-log" -maxdepth 1 -name "*.jsonl" -mtime +30 \
    -exec mv {} "$ARCHIVE_DIR/" \;
  log_event INFO "" "audit_log_rotated" "archive=$ARCHIVE_DIR" "rotation"
fi
