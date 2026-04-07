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
REGISTRY="$SECRETARY_DIR/.session-registry.txt"
WF_ACTIVE_FILE="$SECRETARY_DIR/../.wf-active"
touch "$REGISTRY" 2>/dev/null  # 레지스트리 파일 보장

# 기능 6종 지원 디렉토리
CTX_WARN_TS_DIR="$SECRETARY_DIR/.ctx-warn-ts"   # Feature 3: 메모리 저장 검증
SOLUTIONS_FILE="$SECRETARY_DIR/.error-solutions.json"  # Feature 5: 솔루션 캐시
PYTHON="/c/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe"
TMPDIR="$SECRETARY_DIR/.tmp"
mkdir -p "$CTX_WARN_TS_DIR" "$TMPDIR"
[ -f "$SOLUTIONS_FILE" ] || echo "[]" > "$SOLUTIONS_FILE"

# 모니터링 대상: 비서 자신만 제외, 나머지 전체 풀 모니터링
ALL_PSMUX=$("$PSMUX" ls 2>/dev/null | cut -d: -f1)
SESSIONS=$(echo "$ALL_PSMUX" | grep -v "^${SELF_SESSION}$")

# WF 세션 목록 (autonomous-proceed + revive만 제외, 나머지는 모니터링)
WF_SESSION_LIST=""
if [ -f "$WF_ACTIVE_FILE" ]; then
  WF_SESSION_LIST=$(cat "$WF_ACTIVE_FILE" 2>/dev/null)
  [ -z "$WF_SESSION_LIST" ] && WF_SESSION_LIST="worker verifier healer strategic"
fi

# DEAD_SESSIONS: 레지스트리 등록됐지만 psmux에 없는 세션 → revive 대상
# WF 세션은 Supervisor가 관리하므로 제외
REGISTERED=$(cut -d'|' -f1 "$REGISTRY" 2>/dev/null)
DEAD_SESSIONS=""
for _S in $REGISTERED; do
  [ "$_S" = "$SELF_SESSION" ] && continue
  echo "$ALL_PSMUX" | grep -qxF "$_S" && continue  # alive
  echo "$WF_SESSION_LIST" | tr ' ' '\n' | grep -qxF "$_S" && continue  # WF — skip
  DEAD_SESSIONS="$DEAD_SESSIONS $_S"
done

# === 사용자 부재 체크 ===
IDLE_SEC=$(powershell.exe -NoProfile -File "$SECRETARY_DIR/.scripts/get-idle-time.ps1" 2>/dev/null | tr -d '\r')
IDLE_SEC=$(echo "$IDLE_SEC" | grep -oE '^[0-9]+$' || echo 0)
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
    MARKER_TS=$("C:/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe" \
      -c "import os,time; print(int(os.path.getmtime('$RESTORE_MARKER')))" 2>/dev/null || echo 0)
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

  # 레지스트리 등록됐지만 psmux에서 사라진 세션 → SESSION_DEAD
  for S in $DEAD_SESSIONS; do
    echo "--- $S ---"
    echo "STATUS: SESSION_DEAD"
    echo ""
  done

  for S in $SESSIONS; do
    echo "--- $S ---"

    CAP=$("$PSMUX" capture-pane -p -S -200 -t "$S" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$CAP" ]; then
      echo "STATUS: SESSION_DEAD"
      echo ""
      continue
    fi

    LAST_LINES=$(echo "$CAP" | tail -5)
    if echo "$LAST_LINES" | grep -qE '^\$\s*$|^bash-|^[A-Z]:[/\\]|^PS '; then
      echo "STATUS: AGENT_DEAD"
    elif echo "$LAST_LINES" | grep -qE '^[>❯]\s*$'; then
      # '>'/'❯'는 Claude Code 대기 프롬프트이기도 함 — 전체 pane에 Claude 컨텍스트 있으면 ALIVE
      if echo "$CAP" | grep -qE '(Claude Code|claude-opus|claude-sonnet|claude-haiku|Opus|Sonnet|Haiku)'; then
        echo "STATUS: ALIVE"
      else
        echo "STATUS: AGENT_DEAD"
      fi
    else
      echo "STATUS: ALIVE"
    fi

    # 줄 시작 기준으로만 감지 — 대화 텍스트 중 'PostCompact' 언급에 오탐 방지
    if echo "$CAP" | grep -qE '^\s*(Compacted|Auto-compacted)|⎿\s+Compacted'; then
      echo "COMPRESSED: YES"
    else
      echo "COMPRESSED: NO"
    fi

    # "X% until auto-compact" 패턴에서 남은 비율 추출 — 상태바는 하단에 고정되므로 마지막 3줄만 스캔
    AUTO_COMPACT_REMAIN=$(echo "$CAP" | tail -3 | grep -oP '[0-9]+(?=%.{0,5}until.{0,5}auto.{0,5}compact)' | head -1)
    echo "AUTO_COMPACT_REMAIN: ${AUTO_COMPACT_REMAIN:-NONE}"

    if echo "$LAST_LINES" | grep -qE '(진행할까요|번호를 입력|어떤 방향|선택해)'; then
      echo "WAITING_FOR_USER: YES"
    else
      echo "WAITING_FOR_USER: NO"
    fi

    EDITING=$(echo "$CAP" | grep -oP '(?:Edit|Write|Editing|Updated|edit|write)\s+\S+' | \
      grep -oP '\S+\.(ts|js|md|py|json|tsx|jsx|css)' | sort -u | tr '\n' ',')
    echo "EDITING: ${EDITING:-NONE}"

    # 마지막 30줄만 스캔 (Claude 응답 텍스트 오탐 방지) + 구체적 에러 패턴만
    ERRORS=$(echo "$CAP" | tail -30 | \
      grep -E '(^Error:|^ERROR:|FATAL|Traceback \(most recent|ENOENT|ECONNREFUSED|ETIMEDOUT|exit code [1-9]|npm ERR!|SyntaxError:|TypeError:|ReferenceError:|rate limit exceeded)' | \
      grep -v '^\s*#' | grep -v 'revive failed\|unlock_failed\|revival_failed' | tail -3)
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

    # Feature 2: N-gram 진전 추적 — 5사이클 내용 해시 비교
    CONTENT_HASH=$(echo "$CAP" | tail -20 | grep -vE '^\s*$|^[─╭╰│╮╯┤├]' | md5sum | cut -c1-8)
    PROGRESS_FILE="$SNAP_DIR/$S/.progress"
    echo "$CONTENT_HASH" >> "$PROGRESS_FILE"
    tail -5 "$PROGRESS_FILE" > "${PROGRESS_FILE}.tmp" && mv "${PROGRESS_FILE}.tmp" "$PROGRESS_FILE"
    UNIQUE_P=$(sort -u "$PROGRESS_FILE" | wc -l | tr -d ' \r\n')
    LINES_P=$(wc -l < "$PROGRESS_FILE" | tr -d ' \r\n')
    if [ "${UNIQUE_P:-2}" -eq 1 ] && [ "${LINES_P:-0}" -ge 5 ]; then
      echo "STUCK: YES"
    else
      echo "STUCK: NO"
    fi

    # 세션이 idle 상태인지 감지 (일 없이 대기 중 = 정상, stuck 아님)
    IDLE_PROMPT="NO"
    if echo "$LAST_LINES" | grep -qE '^[>❯]\s*$' && \
       echo "$CAP" | grep -qE '(Claude Code|claude-opus|claude-sonnet|claude-haiku|Opus|Sonnet|Haiku)'; then
      IDLE_PROMPT="YES"
    fi
    echo "IDLE_PROMPT: $IDLE_PROMPT"

    # promotion-signal 교착 감지 (pending-promotion.txt 미완료 항목 있으면 모든 tool 차단)
    if [ -f "$HOME/.claude/pending-promotion.txt" ] && \
       grep -q '^\[ \]' "$HOME/.claude/pending-promotion.txt"; then
      echo "PROMO_BLOCKED: YES"
    else
      echo "PROMO_BLOCKED: NO"
    fi

    # Circular work: 5사이클 unstaged diff 누적 추적 (net LOC ≈ 0 + 수정 > N)
    CIRC_DIR=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f3)
    if [ -n "$CIRC_DIR" ] && [ "$CIRC_DIR" != "unknown" ] && \
       git -C "$CIRC_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      DIFF_SHORT=$(git -C "$CIRC_DIR" diff --shortstat 2>/dev/null)
      CIRC_INS=$(echo "$DIFF_SHORT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
      CIRC_DEL=$(echo "$DIFF_SHORT" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
      CIRC_FILES=$(echo "$DIFF_SHORT" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo 0)
      CIRCULAR_FILE="$SNAP_DIR/$S/.circular"
      echo "${CIRC_INS:-0}:${CIRC_DEL:-0}:${CIRC_FILES:-0}" >> "$CIRCULAR_FILE"
      tail -5 "$CIRCULAR_FILE" > "${CIRCULAR_FILE}.tmp" && mv "${CIRCULAR_FILE}.tmp" "$CIRCULAR_FILE"
      CIRC_LINES=$(wc -l < "$CIRCULAR_FILE" | tr -d ' \r\n')
      if [ "${CIRC_LINES:-0}" -ge 5 ]; then
        CIRC_TOTAL_INS=$(cut -d: -f1 "$CIRCULAR_FILE" | awk '{s+=$1}END{print s+0}')
        CIRC_TOTAL_DEL=$(cut -d: -f2 "$CIRCULAR_FILE" | awk '{s+=$1}END{print s+0}')
        CIRC_TOTAL_FILES=$(cut -d: -f3 "$CIRCULAR_FILE" | awk '{s+=$1}END{print s+0}')
        CIRC_NET=$(( CIRC_TOTAL_INS - CIRC_TOTAL_DEL ))
        [ "$CIRC_NET" -lt 0 ] && CIRC_NET=$(( -CIRC_NET ))
        if [ "$CIRC_NET" -le 5 ] && [ "${CIRC_TOTAL_FILES:-0}" -ge 10 ]; then
          echo "CIRCULAR: YES"
        else
          echo "CIRCULAR: NO"
        fi
      else
        echo "CIRCULAR: NO"
      fi
    else
      echo "CIRCULAR: NO"
    fi

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
TELEGRAM_NEEDED=0
TELEGRAM_REASONS=""

# === 헬퍼 함수 ===
queue_sonnet_task() {
  local TYPE="$1" SESSION="$2" CONTEXT="$3"

  # S-2(semantic_error_analysis)는 Opus, 나머지(S-1, S-3)는 Sonnet
  local WAKE_SCRIPT QUEUE_KEY MODEL_TAG
  if [ "$TYPE" = "semantic_error_analysis" ]; then
    QUEUE_KEY="opus_queue_dir"
    WAKE_SCRIPT="wake-opus.sh"
    MODEL_TAG="opus"
  else
    QUEUE_KEY="queue_dir"
    WAKE_SCRIPT="wake-sonnet.sh"
    MODEL_TAG="sonnet"
  fi

  local QUEUE_DIR="$SECRETARY_DIR/$(jq -r ".${QUEUE_KEY} // \".sonnet-queue\"" "$CONFIG" 2>/dev/null)"
  mkdir -p "$QUEUE_DIR"

  # 레지스트리에서 JSONL 경로 계산
  local SID DIR JSONL_PATH
  SID=$(grep "^${SESSION}|" "$REGISTRY" | cut -d'|' -f5)
  DIR=$(grep "^${SESSION}|" "$REGISTRY" | cut -d'|' -f3)
  local JSONL_BASE="$HOME/.claude/projects"
  local JSONL_DIR="$JSONL_BASE/$(echo "$DIR" | sed 's|:|--|; s|/|--|g; s|\\|--|g')"
  JSONL_PATH="$JSONL_DIR/${SID}.jsonl"
  [ ! -f "$JSONL_PATH" ] && JSONL_PATH=""

  jq -n --arg type "$TYPE" --arg session "$SESSION" \
    --arg context "$CONTEXT" --arg timestamp "$(date -Iseconds)" \
    --arg jsonl_path "$JSONL_PATH" --arg dir "$DIR" --arg sid "$SID" \
    '{type:$type,session:$session,context:$context,timestamp:$timestamp,
      jsonl_path:$jsonl_path,dir:$dir,sid:$sid}' \
    > "$QUEUE_DIR/$(date +%s).json"
  bash "$SECRETARY_DIR/.scripts/$WAKE_SCRIPT"
  log_event SONNET "$SESSION" "sonnet_invoked" "type=$TYPE model=$MODEL_TAG" "$WAKE_SCRIPT"
}

send_telegram_alert() {
  local MSG="$1"
  log_event ESCALATION "" "telegram_alert" "$MSG" "telegram"
  local _SECRET _CFG
  _SECRET=$(jq -r '.agent_secret // ""' "$CONFIG" 2>/dev/null)
  _CFG=$(mktemp)
  printf 'header = "Authorization: Bearer %s"\n' "$_SECRET" > "$_CFG"
  curl -s -K "$_CFG" "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg msg "$MSG" '{message:$msg}')"
  rm -f "$_CFG"
}

for S in $SESSIONS $DEAD_SESSIONS; do
  BLOCK=$(sed -n "/^--- $S ---$/,/^--- /p" "$REPORT" | head -n -1)
  STATUS=$(echo "$BLOCK" | grep "^STATUS:" | awk '{print $2}')
  ERRORS=$(echo "$BLOCK" | grep -A3 "^ERRORS:" | grep "^  " | sed 's/^  //')
  FIRST_ERR=$(echo "$ERRORS" | head -1 | sed 's/[0-9]\+/N/g')

  # Feature 3: 메모리 저장 검증 (elif 체인과 독립)
  CTX_WARN_TS_FILE="$CTX_WARN_TS_DIR/${S}.ts"
  if [ -f "$CTX_WARN_TS_FILE" ]; then
    WARN_INFO=$(cat "$CTX_WARN_TS_FILE")
    WARN_TS="${WARN_INFO%%|*}"
    WARN_DIR="${WARN_INFO##*|}"
    WARN_AGE=$(( $(date +%s) - ${WARN_TS:-0} ))
    if [ "$WARN_AGE" -gt 90 ] && [ "$WARN_AGE" -lt 600 ]; then
      PROJ_KEY=$(echo "$WARN_DIR" | sed 's|:|--|; s|/|--|g; s|\\|--|g')
      NEW_MEM=$("$PYTHON" -c "
import os, glob
path = os.path.expanduser('~/.claude/projects/$PROJ_KEY/memory/')
ts = $WARN_TS
files = glob.glob(path + '*.md') if os.path.exists(path) else []
print(len([f for f in files if os.path.getmtime(f) > ts]))
" 2>/dev/null || echo 0)
      if [ "${NEW_MEM:-0}" -eq 0 ]; then
        if check_dedup "$S" "memory_save_remind"; then
          echo "컨텍스트 압축이 임박해. 현재 작업 상태와 핵심 결정사항을 지금 바로 memory 파일에 저장해." > "$TMPDIR/mem-remind-${S}.txt"
          bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$TMPDIR/mem-remind-${S}.txt"
          log_event WARN "$S" "memory_save_reminded" "age=${WARN_AGE}s no_new_files" "memory-remind"
        fi
      else
        rm -f "$CTX_WARN_TS_FILE"
      fi
    elif [ "$WARN_AGE" -ge 600 ]; then
      rm -f "$CTX_WARN_TS_FILE"
    fi
  fi

  if [ "$STATUS" = "AGENT_DEAD" ]; then
    # 우선순위 1a: psmux 살아있지만 Claude만 종료 → claude 재실행 (proj 불필요)
    echo "$WF_SESSION_LIST" | tr ' ' '\n' | grep -qxF "$S" 2>/dev/null && IS_WF=1 || IS_WF=0
    case "$S" in task-*) IS_TASK=1 ;; *) IS_TASK=0 ;; esac
    [ "$S" = "$SONNET_SESSION" ] && IS_SONNET=1 || IS_SONNET=0
    if [ "$IS_WF" -eq 1 ] || [ "$IS_TASK" -eq 1 ] || [ "$IS_SONNET" -eq 1 ]; then
      log_event WARN "$S" "agent_dead_skip" "status=AGENT_DEAD reason=wf/task/sonnet" "skip"
    elif check_dedup "$S" "agent_dead"; then
      CLAUDE_BIN=$(jq -r '.claude_bin // "claude"' "$CONFIG" 2>/dev/null)
      log_event WARN "$S" "agent_dead_restart" "status=AGENT_DEAD" "restart-claude"
      "$PSMUX" send-keys -t "$S" "$CLAUDE_BIN --dangerously-skip-permissions" Enter
      # 시작 대기 후 resume 주입 (백그라운드)
      _S="$S" _SDIR="$SECRETARY_DIR" _TMPDIR="$TMPDIR" _PSMUX="$PSMUX" bash -c '
        sleep 12
        bash "$_SDIR/.scripts/generate-session-resume.sh" "$_S" >/dev/null 2>&1
        if [ -f "$_TMPDIR/session-resume-${_S}.txt" ]; then
          bash "$_SDIR/.scripts/msg.sh" "$_S" "$_TMPDIR/session-resume-${_S}.txt"
        fi
      ' &
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif [ "$STATUS" = "SESSION_DEAD" ]; then
    # 우선순위 1b: psmux 세션 자체 사망 → revive.sh (API 통한 완전 재생성)
    echo "$WF_SESSION_LIST" | tr ' ' '\n' | grep -qxF "$S" 2>/dev/null && IS_WF=1 || IS_WF=0
    case "$S" in task-*) IS_TASK=1 ;; *) IS_TASK=0 ;; esac
    [ "$S" = "$SONNET_SESSION" ] && IS_SONNET=1 || IS_SONNET=0
    if [ "$IS_WF" -eq 1 ] || [ "$IS_TASK" -eq 1 ] || [ "$IS_SONNET" -eq 1 ]; then
      log_event WARN "$S" "session_dead_no_revive" "status=$STATUS reason=wf/task/sonnet" "skip"
    elif check_dedup "$S" "session_dead"; then
      log_event ERROR "$S" "session_dead" "status=$STATUS" "revive.sh"
      bash "$SECRETARY_DIR/.scripts/revive.sh" "$S"
    elif check_dedup "$S" "revival_failed"; then
      # revive 이미 시도했는데 다음 사이클도 사망 → 1회만 Telegram
      TELEGRAM_NEEDED=$((TELEGRAM_NEEDED + 1))
      TELEGRAM_REASONS="$TELEGRAM_REASONS revival_failed:$S"
      log_event ERROR "$S" "revival_failed" "status=$STATUS" "telegram"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "COMPRESSED: YES"; then
    # 우선순위 2: 압축 감지 → JSONL 리줌 주입
    log_event WARN "$S" "context_compressed" "session=$S" "session-resume-injected"
    bash "$SECRETARY_DIR/.scripts/generate-session-resume.sh" "$S"
    if [ -f "$TMPDIR/session-resume-${S}.txt" ]; then
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$TMPDIR/session-resume-${S}.txt"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif REMAIN=$(echo "$BLOCK" | grep "^AUTO_COMPACT_REMAIN:" | awk '{print $2}'); \
       [ -n "$REMAIN" ] && [ "$REMAIN" != "NONE" ] && [ "${REMAIN}" -le 20 ] 2>/dev/null; then
    # 우선순위 2.5: "X% until auto-compact" 20% 이하 → 메모리 저장 요청
    if check_dedup "$S" "context_near_limit"; then
      CTX_WARN_FILE="$TMPDIR/ctx-warn-${S}.txt"
      TMPL="$SECRETARY_DIR/.messages/memory-save-template.md"
      echo "컨텍스트 압축까지 ${REMAIN}% 남았어. 당장 ${TMPL} 읽고 memory 파일에 저장해." > "$CTX_WARN_FILE"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$CTX_WARN_FILE"
      log_event WARN "$S" "context_near_limit" "remain=${REMAIN}%" "pre-compression-warn"
      # Feature 3: 메모리 저장 검증용 타임스탬프 기록
      CTX_WARN_DIR_VAL=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f3)
      echo "$(date +%s)|${CTX_WARN_DIR_VAL:-unknown}" > "$CTX_WARN_TS_DIR/${S}.ts"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "GUARD_BLOCKED: YES" || \
       ([ "$DENY_COUNT" -ge 5 ] && echo "$BLOCK" | grep -q "STUCK: YES"); then
    # 우선순위 3: Guard 교착 (화면 stagnation 확인된 경우만) → 1차: 스크립트 해제 / 실패 시: Sonnet 분석
    if [ ! -f "$RESTORE_MARKER" ]; then
      BACKUP=$(disable_blocking_guard)
      if [ "$BACKUP" != "FAIL" ] && [ -n "$BACKUP" ]; then
        echo "$BACKUP" > "$RESTORE_MARKER"
        echo "$S" > "${RESTORE_MARKER}.session"
        log_event WARN "$S" "guard_unlocked" "backup=$BACKUP deny=$DENY_COUNT" "guard-unlock"
        "$PSMUX" send-keys -t "$S" "Guard 잠깐 해제했어. 작업 계속해." Enter
      else
        log_event WARN "$S" "guard_unlock_failed" "deny=$DENY_COUNT" "guard-unlock-fail"
        # 스크립트 해제 실패 → Obsidian 세션 스폰 + guard-watchdog 실행
        if check_dedup "$S" "guard_unlock_obsidian"; then
          OBS_SESSION="guard-$(date +%s)"
          WIN_OBS_DIR="C:\\Users\\jsh86\\.claude"
          CLAUDE_BIN=$(jq -r '.claude_bin // "claude"' "$CONFIG" 2>/dev/null)
          "$PSMUX" new-session -d -s "$OBS_SESSION" -- cmd.exe
          sleep 2
          "$PSMUX" send-keys -t "$OBS_SESSION" "cd /d $WIN_OBS_DIR" Enter
          sleep 1
          "$PSMUX" send-keys -t "$OBS_SESSION" "$CLAUDE_BIN --model sonnet --dangerously-skip-permissions" Enter
          sleep 15
          "$PSMUX" send-keys -t "$OBS_SESSION" \
            "Read ~/.claude/skills/guard-unlock/skill.md and follow all instructions. TARGET_SESSION=${S}" Enter
          log_event WARN "$S" "guard_unlock_obsidian_spawned" "obs_session=$OBS_SESSION deny=$DENY_COUNT" "guard-watchdog"
        else
          # Obsidian 세션도 이미 시도했는데 여전히 교착 → Telegram
          TELEGRAM_NEEDED=$((TELEGRAM_NEEDED + 1))
          TELEGRAM_REASONS="$TELEGRAM_REASONS guard_unlock_failed:$S"
        fi
      fi
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "PROMO_BLOCKED: YES"; then
    # promotion-signal 교착 → promotion-log.md 기록 요청 (STUCK 오판 방지)
    if check_dedup "$S" "promo_blocked"; then
      echo "pending-promotion.txt에 미완료 항목 있어. tool이 전부 차단된 상태야. promotion-log.md 먼저 기록하고 나서 계속해." \
        > "$TMPDIR/promo-blocked-${S}.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$TMPDIR/promo-blocked-${S}.txt"
      log_event WARN "$S" "promo_blocked_detected" "pending-promotion.txt has unchecked items" "promo-blocked-warn"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "STUCK: YES" && ! echo "$BLOCK" | grep -q "IDLE_PROMPT: YES"; then
    # Feature 2: 5사이클+ 무진전 → 넛지 (idle 대기 중인 세션은 제외)
    if check_dedup "$S" "stuck_warn"; then
      echo "5사이클 넘게 진전이 없어. 지금 접근 방식 안 되는 거야. 다른 방법으로 바꿔서 다시 해봐." > "$TMPDIR/stuck-warn-${S}.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$TMPDIR/stuck-warn-${S}.txt"
      log_event WARN "$S" "stuck_detected" "5+ cycles no progress" "stuck-warn"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "CIRCULAR: YES" && ! echo "$BLOCK" | grep -q "IDLE_PROMPT: YES"; then
    # Circular work: 5사이클 net LOC ≈ 0 + 수정 과다 → 삽질 넛지
    if check_dedup "$S" "circular_work"; then
      echo "같은 파일을 계속 수정하다가 원점으로 돌아오는 패턴이야. 지금 방향이 맞는 건지 다시 생각해봐. 일단 커밋하고 다른 접근으로 해봐." > "$TMPDIR/circular-warn-${S}.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$TMPDIR/circular-warn-${S}.txt"
      log_event WARN "$S" "circular_work_detected" "net_loc_near_0 high_edit_count" "circular-warn"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "REPEAT_ERROR: FOUND"; then
    # 우선순위 5: 반복 에러 → 1차: 경고 전송 / 2차(지속): Sonnet 에스컬레이션
    if check_dedup "$S" "repeat_error"; then
      log_event WARN "$S" "repeat_error" "$FIRST_ERR" "repeat-warn"
      PREV_CTX=$(echo "$BLOCK" | sed -n '/PREVIOUS_CONTEXT:/,/^[A-Z]/p' | grep "^  " | sed 's/^  //')
      echo "$PREV_CTX" > /tmp/repeat-warn-${S}.txt
      cat "$SECRETARY_DIR/.messages/repeat-warn-header.txt" /tmp/repeat-warn-${S}.txt > /tmp/repeat-warn-full-${S}.txt
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" /tmp/repeat-warn-full-${S}.txt
    else
      # 경고 보냈는데 다음 사이클도 동일 에러 → Sonnet 분석 (S-2와 공유 키로 중복 방지)
      if [ -f "$SECRETARY_DIR/.sonnet-enabled" ] && check_dedup "$S" "semantic_error_analysis"; then
        SNAP_CTX=$(cat "$SNAP_DIR/$S/snap_$(cat "$SNAP_DIR/$S/.idx" 2>/dev/null || echo 0).txt" 2>/dev/null | tail -30)
        queue_sonnet_task "semantic_error_analysis" "$S" \
          "session=$S persistent_error=$FIRST_ERR context=$SNAP_CTX"
        log_event SONNET "$S" "repeat_error_escalated" "$FIRST_ERR" "sonnet"
      fi
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "WAITING_FOR_USER: YES" && [ "$IDLE_SEC" -gt 600 ]; then
    # 우선순위 6: 부재 + 질문 대기 → 자율 진행 (WF 세션 제외 — Supervisor가 관리)
    if echo "$WF_SESSION_LIST" | tr ' ' '\n' | grep -qxF "$S"; then
      log_event INFO "$S" "autonomous_proceed_skipped" "wf_session" "skip"
    else
      log_event INFO "$S" "autonomous_proceed" "" "autonomous-proceed.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$SECRETARY_DIR/.messages/autonomous-proceed.txt"
      touch "$SECRETARY_DIR/.user-absent"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif [ -n "$ERRORS" ]; then
    # S-1: elif 미매칭 에러 → rate limit 시 skip, 모델별 분기
    if echo "$ERRORS" | grep -qi "rate.limit\|overloaded"; then
      log_event INFO "$S" "rate_limit_skip" "rate_limit_detected — no action" "skip"
    else
    log_event ERROR "$S" "error_detected" "$ERRORS" "exception_analysis"
    SESSION_MODEL=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f2)
    if echo "$SESSION_MODEL" | grep -qi "opus"; then
      # Opus 세션 → 직접 self-verify 메시지 (소환 없음)
      if check_dedup "$S" "exception_analysis"; then
        SELF_VERIFY="$SECRETARY_DIR/.messages/self-verify-opus.txt"
        bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$SELF_VERIFY"
        log_event WARN "$S" "opus_self_verify_requested" "$ERRORS" "self-verify"
      fi
    elif [ -f "$SECRETARY_DIR/.sonnet-enabled" ] && check_dedup "$S" "exception_analysis"; then
      # Sonnet 세션 → secretary-opus 소환
      SNAP_CTX=$(cat "$SNAP_DIR/$S/snap_$(cat "$SNAP_DIR/$S/.idx" 2>/dev/null || echo 0).txt" 2>/dev/null | tail -30)
      queue_sonnet_task "exception_analysis" "$S" "errors=$ERRORS context=$SNAP_CTX"
    fi
    fi  # end: rate_limit else
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  fi

  # 사용자 복귀 감지 (elif 체인과 독립)
  if [ "$IDLE_SEC" -lt 60 ] && [ -f "$SECRETARY_DIR/.user-absent" ]; then
    bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$SECRETARY_DIR/.messages/user-returned.txt"
    rm -f "$SECRETARY_DIR/.user-absent"
  fi

  # Work completion detection (elif 체인과 독립)
  # 사이클 N: 새 커밋 → .ts 저장 / 사이클 N+1: IDLE_PROMPT + 사용자 부재 → Telegram
  COMMIT_TS_FILE="$TMPDIR/committed-${S}.ts"
  WC_REG_DIR=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f3)
  RECENT_COMMITS_WC=""
  if [ -n "$WC_REG_DIR" ] && [ "$WC_REG_DIR" != "unknown" ]; then
    RECENT_COMMITS_WC=$(git -C "$WC_REG_DIR" log --oneline --since="3 minutes ago" 2>/dev/null)
  fi
  if [ -n "$RECENT_COMMITS_WC" ]; then
    # 이번 사이클 커밋 있음 → 타임스탬프+커밋메시지+프로젝트명 저장
    WC_COMMIT_MSG=$(echo "$RECENT_COMMITS_WC" | head -1 | sed 's/^[a-f0-9]* //')
    WC_PROJ=$(basename "$WC_REG_DIR")
    echo "$(date +%s)|${WC_COMMIT_MSG}|${WC_PROJ}" > "$COMMIT_TS_FILE"
  elif [ -f "$COMMIT_TS_FILE" ] && echo "$BLOCK" | grep -q "IDLE_PROMPT: YES" && [ "$IDLE_SEC" -gt 300 ]; then
    # 이전 사이클 커밋 있었고 + 현재 idle + 사용자도 부재 → 완료 Telegram
    WC_INFO=$(cat "$COMMIT_TS_FILE")
    WC_MSG="${WC_INFO#*|}"; WC_MSG="${WC_MSG%|*}"
    WC_PROJ_NAME="${WC_INFO##*|}"
    if check_dedup "$S" "work_completion"; then
      send_telegram_alert "✅ [${WC_PROJ_NAME}] Work done / commit: ${WC_MSG} / session: ${S}"
      log_event INFO "$S" "work_completion_detected" "proj=${WC_PROJ_NAME} commit=${WC_MSG}" "telegram"
    fi
    rm -f "$COMMIT_TS_FILE"
  fi

  # S-2 슬라이딩 윈도우 — 5사이클 중 3+ 새 에러 → 의미적 분석 트리거
  ERR_WINDOW_FILE="$SNAP_DIR/$S/.err-window"
  mkdir -p "$SNAP_DIR/$S"
  if [ -n "$ERRORS" ] && echo "$BLOCK" | grep -q "REPEAT_ERROR: NONE" && \
     ! echo "$ERRORS" | grep -qi "rate.limit\|overloaded"; then
    echo "1" >> "$ERR_WINDOW_FILE"
  else
    echo "0" >> "$ERR_WINDOW_FILE"
  fi
  tail -5 "$ERR_WINDOW_FILE" > "${ERR_WINDOW_FILE}.tmp" && mv "${ERR_WINDOW_FILE}.tmp" "$ERR_WINDOW_FILE"

  ERR_COUNT=$(grep -c "^1$" "$ERR_WINDOW_FILE" 2>/dev/null || echo 0)
  ERR_COUNT=$(echo "$ERR_COUNT" | tr -d '\r\n' | grep -oE '[0-9]+' || echo 0)
  if [ "${ERR_COUNT:-0}" -ge 3 ] && [ -f "$SECRETARY_DIR/.sonnet-enabled" ]; then
    # Feature 5: 솔루션 캐시 확인 (Opus 호출 전)
    NORM_ERR=$(echo "$FIRST_ERR" | sed 's|/[^/]*/|/.../|g')
    CACHED_SOL=$(jq -r --arg p "$NORM_ERR" \
      '.[] | select(.normalized_pattern == $p) | .solution' \
      "$SOLUTIONS_FILE" 2>/dev/null | head -1)

    if [ -n "$CACHED_SOL" ]; then
      # 캐시 히트 → Opus 없이 바로 전송
      echo "이 에러 전에 해결한 적 있어. 아래 방법 먼저 써봐:
$CACHED_SOL" > "$TMPDIR/cached-sol-${S}.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$TMPDIR/cached-sol-${S}.txt"
      log_event INFO "$S" "solution_cache_hit" "pattern=$NORM_ERR" "cached-solution"
      jq --arg p "$NORM_ERR" \
        '(.[] | select(.normalized_pattern == $p) | .hit_count) += 1' \
        "$SOLUTIONS_FILE" > "$TMPDIR/sol-tmp.json" && mv "$TMPDIR/sol-tmp.json" "$SOLUTIONS_FILE"

    elif check_dedup "$S" "semantic_error_analysis"; then
      S2_MODEL=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f2)
      if echo "$S2_MODEL" | grep -qi "opus"; then
        # Opus 세션 → self-verify 메시지 직접 전송
        bash "$SECRETARY_DIR/.scripts/msg.sh" "$S" "$SECRETARY_DIR/.messages/self-verify-opus.txt"
        log_event WARN "$S" "opus_self_verify_s2" "window=$ERR_COUNT/5" "self-verify"
      else
        # Sonnet 세션 → secretary-opus 소환
        RIDX=$(cat "$SNAP_IDX_FILE" 2>/dev/null || echo 0)
        IDX0=$(( (RIDX - 1 + SNAP_MAX) % SNAP_MAX ))
        IDX1=$(( (RIDX - 2 + SNAP_MAX) % SNAP_MAX ))
        IDX2=$(( (RIDX - 3 + SNAP_MAX) % SNAP_MAX ))
        SNAP0=$(cat "$SNAP_DIR/$S/snap_${IDX0}.txt" 2>/dev/null | tail -20)
        SNAP1=$(cat "$SNAP_DIR/$S/snap_${IDX1}.txt" 2>/dev/null | tail -20)
        SNAP2=$(cat "$SNAP_DIR/$S/snap_${IDX2}.txt" 2>/dev/null | tail -20)
        OPUS_QDIR="$SECRETARY_DIR/$(jq -r '.opus_queue_dir // ".opus-queue"' "$CONFIG" 2>/dev/null)"
        mkdir -p "$OPUS_QDIR"
        S2_SID=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f5)
        S2_DIR=$(grep "^${S}|" "$REGISTRY" | cut -d'|' -f3)
        S2_JSONL_DIR="$HOME/.claude/projects/$(echo "$S2_DIR" | sed 's|:|--|; s|/|--|g; s|\\|--|g')"
        S2_JSONL="$S2_JSONL_DIR/${S2_SID}.jsonl"
        [ ! -f "$S2_JSONL" ] && S2_JSONL=""
        jq -n \
          --arg type "semantic_error_analysis" \
          --arg session "$S" \
          --arg errors "$ERRORS" \
          --arg snap0 "$SNAP0" \
          --arg snap1 "$SNAP1" \
          --arg snap2 "$SNAP2" \
          --arg jsonl_path "$S2_JSONL" \
          --arg dir "$S2_DIR" \
          --arg sid "$S2_SID" \
          '{type:$type, session:$session, current_errors:$errors, snapshots:[$snap0,$snap1,$snap2],
            jsonl_path:$jsonl_path, dir:$dir, sid:$sid}' \
          > "$OPUS_QDIR/$(date +%s).json"
        bash "$SECRETARY_DIR/.scripts/wake-opus.sh"
        log_event SONNET "$S" "opus_invoked" "type=semantic_error window=$ERR_COUNT/5" "wake-opus.sh"
      fi

    else
      # Feature 1: Opus 이미 시도했는데 에러 지속 → Feature 6 에스컬레이션 체인 4단계: Telegram
      if check_dedup "$S" "opus_no_effect"; then
        TELEGRAM_NEEDED=$((TELEGRAM_NEEDED + 1))
        TELEGRAM_REASONS="$TELEGRAM_REASONS opus_no_effect:$S"
        log_event ESCALATION "$S" "opus_no_effect" "error persists after opus analysis" "telegram"
      fi
    fi
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

if [ -f "$REGISTRY" ]; then
  # 감사소스수집: git log
  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    RECENT_COMMITS=$(git -C "$DIR" log --oneline --since="3 minutes ago" 2>/dev/null)
    if [ -n "$RECENT_COMMITS" ]; then
      log_event ACTIVITY "" "git_commits" "dir=$DIR commits=$RECENT_COMMITS" ""
    fi
  done

  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    RECENT=$(git -C "$DIR" log --oneline --since="3 minutes ago" 2>/dev/null)
    [ -z "$RECENT" ] && continue  # 3분 내 새 커밋 없으면 브로드캐스트 스킵
    DIFF_STAT=$(git -C "$DIR" diff --stat HEAD~1 2>/dev/null)
    if [ -n "$DIFF_STAT" ]; then
      echo "$DIFF_STAT" > /tmp/git-changes.txt
      grep "|${DIR}|" "$REGISTRY" | cut -d'|' -f1 | while read TARGET; do
        bash "$SECRETARY_DIR/.scripts/msg.sh" "$TARGET" /tmp/git-changes.txt
      done
    fi
  done
fi

# Feature 4: Git 커밋 빈도 모니터링 (세션 등록 2시간+ && 최근 2시간 커밋 없음)
if [ -f "$REGISTRY" ]; then
  while IFS='|' read -r FS FM FD FT FSID; do
    echo "$SESSIONS" | grep -qxF "$FS" || continue  # alive 세션만
    [ "$FD" = "unknown" ] && continue
    SESSION_AGE=$("$PYTHON" -c "
import time
from datetime import datetime
try:
    ts = datetime.fromisoformat('$FT'.replace('+09:00','+0900'))
    print(int(time.time() - ts.timestamp()))
except:
    print(0)
" 2>/dev/null || echo 0)
    if [ "${SESSION_AGE:-0}" -gt 7200 ]; then
      RECENT_COMMITS=$(git -C "$FD" log --oneline --since="2 hours ago" 2>/dev/null | wc -l | tr -d ' \r\n')
      if [ "${RECENT_COMMITS:-0}" -eq 0 ]; then
        if check_dedup "$FS" "no_commit_warn"; then
          echo "2시간 넘게 커밋이 없어. 지금 진행 상황 커밋해줘." > "$TMPDIR/commit-warn-${FS}.txt"
          bash "$SECRETARY_DIR/.scripts/msg.sh" "$FS" "$TMPDIR/commit-warn-${FS}.txt"
          log_event WARN "$FS" "no_commit_warn" "age=${SESSION_AGE}s no_recent_commits" "commit-frequency"
        fi
      fi
    fi
  done < <(cat "$REGISTRY")
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
# S-1: Telegram — 자율 복구 실패 시에만
# =============================================
# 조건: revive 후에도 사망 지속 / 가드 해제 스크립트+Sonnet 모두 실패
if [ "$TELEGRAM_NEEDED" -gt 0 ]; then
  # TELEGRAM_REASONS format: "revival_failed:sess1 guard_unlock_failed:sess2"
  # Build human-readable message with session names
  TG_MSG="[agent] Intervention needed ($(date '+%H:%M')):"
  for REASON_ENTRY in $TELEGRAM_REASONS; do
    REASON_TYPE="${REASON_ENTRY%%:*}"
    REASON_SESSION="${REASON_ENTRY##*:}"
    case "$REASON_TYPE" in
      revival_failed)   TG_MSG="$TG_MSG  - Session '$REASON_SESSION': revive failed (still dead)" ;;
      guard_unlock_failed) TG_MSG="$TG_MSG  - Session '$REASON_SESSION': guard deadlock unresolvable" ;;
      opus_no_effect)   TG_MSG="$TG_MSG  - Session '$REASON_SESSION': Opus analysis sent but error persists" ;;
      *) TG_MSG="$TG_MSG  - Session '$REASON_SESSION': $REASON_TYPE" ;;
    esac
  done
  send_telegram_alert "$TG_MSG"
fi

# =============================================
# Phase 4.6: 미등록 psmux 세션 자동 등록
# 제외: secretary(자기자신), task-*(task queue 관리), sonnet(온디맨드), WF 세션(Supervisor 관리)
# 나머지 전부 자동 등록 → revive 포함 전체 기능 적용
# =============================================

if [ -f "$REGISTRY" ]; then
  KNOWN_NAMES=$(cut -d'|' -f1 "$REGISTRY" 2>/dev/null)

  for CAND_SESSION in $ALL_PSMUX; do
    [ "$CAND_SESSION" = "$SELF_SESSION" ] && continue
    [ "$CAND_SESSION" = "$SONNET_SESSION" ] && continue
    [[ "$CAND_SESSION" == task-* ]] && continue
    echo "$WF_SESSION_LIST" | tr ' ' '\n' | grep -qxF "$CAND_SESSION" && continue
    echo "$KNOWN_NAMES" | grep -qxF "$CAND_SESSION" && continue  # 이미 등록됨

    # 현재 작업 디렉토리 — psmux에서 직접 읽기
    CAND_DIR=$("$PSMUX" display-message -p "#{pane_current_path}" -t "$CAND_SESSION" 2>/dev/null)
    [ -z "$CAND_DIR" ] && CAND_DIR="unknown"

    # 모델: strategic=opus, 나머지=sonnet (기본값)
    CAND_MODEL="sonnet"
    [ "$CAND_SESSION" = "strategic" ] && CAND_MODEL="opus"

    # SID: 최근 120분 내 JSONL 중 미등록 것
    REGISTERED_SIDS=$(cut -d'|' -f5 "$REGISTRY" 2>/dev/null | grep -v '^$')
    CAND_SID=""
    while IFS= read -r JSONL_FILE; do
      SID_C=$(basename "$JSONL_FILE" .jsonl)
      [[ "$SID_C" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || continue
      echo "$REGISTERED_SIDS" | grep -qF "$SID_C" && continue
      CAND_SID="$SID_C"
      break
    done < <(/usr/bin/find "$HOME/.claude/projects" -name "*.jsonl" -mmin -120 \
               -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')

    echo "${CAND_SESSION}|${CAND_MODEL}|${CAND_DIR}|$(date -Iseconds)|${CAND_SID}" >> "$REGISTRY"
    KNOWN_NAMES=$(printf '%s\n%s' "$KNOWN_NAMES" "$CAND_SESSION")
    if [ -z "$CAND_SID" ]; then
      log_event WARN "$CAND_SESSION" "session_auto_registered_no_sid" \
        "dir=${CAND_DIR} model=${CAND_MODEL} — resume unavailable" "registry"
    else
      log_event INFO "$CAND_SESSION" "session_auto_registered" \
        "dir=${CAND_DIR} sid=${CAND_SID:0:8} model=${CAND_MODEL}" "registry"
    fi
  done
fi

# =============================================
# Phase 4.75: .wf-active 고아 정리
# 조건: mtime > 10분 + 모든 WF세션+supervisor psmux에 없음 + Telegram 후 삭제
# =============================================

if [ -f "$WF_ACTIVE_FILE" ]; then
  WF_ORPHAN_AGE=$("$PYTHON" -c \
    "import os,time; print(int(time.time()-os.path.getmtime('$WF_ACTIVE_FILE')))" 2>/dev/null || echo 0)
  if [ "${WF_ORPHAN_AGE:-0}" -gt 600 ]; then
    ALL_WF_DEAD=true
    for WF_CAND in $WF_SESSION_LIST supervisor; do
      if echo "$ALL_PSMUX" | grep -qxF "$WF_CAND"; then
        ALL_WF_DEAD=false
        break
      fi
    done
    if [ "$ALL_WF_DEAD" = true ]; then
      if check_dedup "wf_active" "orphan_cleanup"; then
        WF_ORPHAN_CONTENT=$(cat "$WF_ACTIVE_FILE" 2>/dev/null | tr '\n' ' ' | head -c 100)
        send_telegram_alert "[agent] .wf-active orphan (${WF_ORPHAN_AGE}s, sessions: ${WF_ORPHAN_CONTENT}). Cleaning up."
        rm -f "$WF_ACTIVE_FILE"
        log_event WARN "" "wf_active_orphan_cleaned" "age=${WF_ORPHAN_AGE}s sessions=${WF_ORPHAN_CONTENT}" "cleanup"
      fi
    fi
  fi
fi

# =============================================
# Phase 4.7: request/pattern 기록 강제 nudge
# 세션 JSONL에서 docs/ Read(request) 또는 Edit/Write 3건+(pattern) 감지
# promotion-log.md 편집 없이 threshold 도달 시 → 에이전트에 기록 요청
# =============================================

if [ -f "$REGISTRY" ]; then
  TODAY=$(date +%Y%m%d)
  while IFS='|' read -r FS FM FD FC FSID; do
    [ -z "$FS" ] || [[ "$FS" == \#* ]] && continue
    [ -z "$FSID" ] && continue

    # JSONL 경로 탐색
    PRJ_KEY=$(echo "$FD" | sed 's|.*[/\\]||; s|[^a-zA-Z0-9_-]|-|g')
    JSONL_FILE=$(/usr/bin/find "$HOME/.claude/projects" -name "${FSID}.jsonl" 2>/dev/null | head -1)
    [ -z "$JSONL_FILE" ] || [ ! -f "$JSONL_FILE" ] && continue

    # promotion-log.md 이미 수정했는지 확인 → 했으면 skip
    PROMO_EDIT=$(grep -c '"name":"Edit"' "$JSONL_FILE" 2>/dev/null | head -1 || echo 0)
    PROMO_LOGGED=$(grep '"file_path"' "$JSONL_FILE" 2>/dev/null | grep -c "promotion-log" || echo 0)
    [ "${PROMO_LOGGED:-0}" -gt 0 ] && continue

    # request 감지: docs/ 경로 Read
    DOCS_READ_COUNT=$(grep -o '"file_path":"[^"]*"' "$JSONL_FILE" 2>/dev/null \
      | grep -c '/docs/' || echo 0)

    # pattern 감지: Edit + Write 합산
    EDIT_COUNT=$(grep -o '"name":"Edit"\|"name":"Write"' "$JSONL_FILE" 2>/dev/null | wc -l | tr -d ' ')

    if [ "${DOCS_READ_COUNT:-0}" -gt 0 ] && check_dedup "$FS" "request_remind_${TODAY}"; then
      echo "docs/ 파일 읽으면서 작업했어. 반복 가능한 작업이면 promotion-log.md에 R{번호}로 기록해줘." \
        > "$TMPDIR/request-remind-${FS}.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$FS" "$TMPDIR/request-remind-${FS}.txt"
      log_event INFO "$FS" "request_remind_sent" "docs_reads=${DOCS_READ_COUNT}" "request-remind"
    fi

    if [ "${EDIT_COUNT:-0}" -ge 3 ] && check_dedup "$FS" "pattern_remind_${TODAY}"; then
      echo "이번 세션에서 파일 ${EDIT_COUNT}개 수정했어. 여러 단계 조합한 작업이면 promotion-log.md에 P{번호}로 기록해줘." \
        > "$TMPDIR/pattern-remind-${FS}.txt"
      bash "$SECRETARY_DIR/.scripts/msg.sh" "$FS" "$TMPDIR/pattern-remind-${FS}.txt"
      log_event INFO "$FS" "pattern_remind_sent" "edit_count=${EDIT_COUNT}" "pattern-remind"
    fi
  done < <(cat "$REGISTRY")
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
    -d '{"message":"[agent] Weekly audit reminder. Run: claude audit-wf or session-audit."}'; then
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
