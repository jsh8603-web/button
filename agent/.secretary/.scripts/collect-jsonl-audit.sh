#!/bin/bash
# collect-jsonl-audit.sh — JSONL 트랜스크립트 증분 파싱 + 감사 데이터 수집
# Phase 1: 등록된 세션 + tool_result 수집
# Phase 2: 서브에이전트 JSONL 자동 탐지 (Agent tool 내부 스폰, parent 귀속 포함)
# Phase 3: offset marker 정리

SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
[ -f "$CONFIG" ] || { echo "CONFIG not found" >&2; exit 1; }

REGISTRY="$SECRETARY_DIR/.session-registry.txt"
AUDIT_LOG_DIR="$HOME/.claude/audit-log"
OFFSET_MARKER="$AUDIT_LOG_DIR/.last-jsonl-lines"
PYTHON="/c/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe"

mkdir -p "$AUDIT_LOG_DIR"

log_event() {
  local TYPE="$1" SESSION="$2" EVENT="$3" CONTEXT="$4"
  jq -n --arg ts "$(date -Iseconds)" --arg type "$TYPE" --arg session "$SESSION" \
    --arg event "$EVENT" --arg context "$CONTEXT" --arg action "jsonl-audit" \
    '{ts:$ts,type:$type,session:$session,event:$event,context:$context,action:$action}' \
    >> "$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"
}

# sed 패턴 이스케이프 — SESSION명에 메타문자 포함될 경우 대비 [상 fix]
escape_sed() { printf '%s' "$1" | sed 's/[][\.*^$()+?{|]/\\&/g'; }

# =============================================
# Python 파서: 등록 세션용 (tool_result 포함)
# =============================================
parse_jsonl() {
  local JSONL_FILE="$1" SKIP_LINES="$2"
  "$PYTHON" - "$JSONL_FILE" "$SKIP_LINES" << 'PYEOF'
import sys, json, re
path = sys.argv[1]
skip = int(sys.argv[2])
tool_counts = {}
edit_files = set()
risky_cmds = []
agent_spawns = []
agent_results = []
pending_agents = {}  # tool_use_id → description

with open(path, 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()

for i, raw in enumerate(lines):
    if i < skip:
        continue
    try:
        d = json.loads(raw)
        msg_type = d.get('type')

        if msg_type == 'assistant':
            for c in d.get('message', {}).get('content', []):
                if not isinstance(c, dict) or c.get('type') != 'tool_use':
                    continue
                name = c.get('name', '')
                inp = c.get('input', {})
                tool_id = c.get('id', '')
                tool_counts[name] = tool_counts.get(name, 0) + 1
                if name in ('Edit', 'Write') and 'file_path' in inp:
                    edit_files.add(inp['file_path'])
                if name == 'Bash':
                    cmd = inp.get('command', '')[:120]
                    if any(k in cmd for k in ['rm ', '--force', 'reset --hard', 'drop', 'kill']):
                        risky_cmds.append(cmd)
                if name == 'Agent':
                    desc = inp.get('description', '')[:60]
                    agent_spawns.append(desc)
                    if tool_id:
                        pending_agents[tool_id] = desc

        elif msg_type == 'tool':
            # tool_result — tool_use_id는 최상위 필드 [상 fix: content 배열 안이 아님]
            tool_id = d.get('tool_use_id', '')
            if tool_id in pending_agents:
                desc = pending_agents.pop(tool_id)
                result_text = ''
                for rc in d.get('content', []):
                    if isinstance(rc, dict) and rc.get('type') == 'text':
                        result_text = rc.get('text', '')[:300]
                        break
                    elif isinstance(rc, str):
                        result_text = rc[:300]
                        break
                m = re.search(r'(CRITICAL|MUST FIX|PASSED?|FAILED?|PARTIAL_PASS|WARNING)', result_text, re.I)
                verdict = m.group(1).upper() if m else 'ok'
                agent_results.append(f'{desc}:{verdict}')

    except Exception:
        pass

parts = []
if tool_counts:
    parts.append('tools=' + ','.join(f'{k}:{v}' for k, v in sorted(tool_counts.items(), key=lambda x: -x[1])[:8]))
if edit_files:
    parts.append('edited=' + ','.join(sorted(edit_files)[:10]))
if risky_cmds:
    parts.append('RISKY=' + '|'.join(risky_cmds[:3]))
if agent_spawns:
    parts.append('agents=' + ','.join(agent_spawns[:3]))
if agent_results:
    parts.append('results=' + ','.join(agent_results[:5]))
print('; '.join(parts) if parts else '')
PYEOF
}

# =============================================
# Python 파서: 서브에이전트용 (agent 타입 + 활동)
# =============================================
parse_subagent_jsonl() {
  local JSONL_FILE="$1" SKIP_LINES="$2"
  "$PYTHON" - "$JSONL_FILE" "$SKIP_LINES" << 'PYEOF'
import sys, json, re
path = sys.argv[1]
skip = int(sys.argv[2])
tool_counts = {}
edit_files = set()
risky_cmds = []
agent_task = ''

with open(path, 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()

# 첫 번째 user 메시지에서 agent 타입 추출 — 첫 30줄 스캔
for raw in lines[:30]:
    try:
        d = json.loads(raw)
        if d.get('type') == 'user':
            for c in d.get('message', {}).get('content', []):
                if isinstance(c, dict) and c.get('type') == 'text':
                    text = c.get('text', '')[:200].replace('\n', ' ')
                    # 알려진 agent 타입 패턴 [중 fix: Guardian/Verifier/Worker 등 추가]
                    m = re.search(
                        r'([\w-]+(?:reviewer|agent|healer|generator|explorer|planner|'
                        r'guardian|verifier|worker|orchestrator|supervisor))',
                        text, re.I
                    )
                    agent_task = m.group(1) if m else text[:80]
                    break
        if agent_task:
            break
    except Exception:
        pass

for i, raw in enumerate(lines):
    if i < skip:
        continue
    try:
        d = json.loads(raw)
        if d.get('type') != 'assistant':
            continue
        for c in d.get('message', {}).get('content', []):
            if not isinstance(c, dict) or c.get('type') != 'tool_use':
                continue
            name = c.get('name', '')
            inp = c.get('input', {})
            tool_counts[name] = tool_counts.get(name, 0) + 1
            if name in ('Edit', 'Write') and 'file_path' in inp:
                edit_files.add(inp['file_path'])
            if name == 'Bash':
                cmd = inp.get('command', '')[:120]
                if any(k in cmd for k in ['rm ', '--force', 'reset --hard', 'drop', 'kill']):
                    risky_cmds.append(cmd)
    except Exception:
        pass

parts = []
if agent_task:
    parts.append(f'agent={agent_task}')
if tool_counts:
    parts.append('tools=' + ','.join(f'{k}:{v}' for k, v in sorted(tool_counts.items(), key=lambda x: -x[1])[:8]))
if edit_files:
    parts.append('edited=' + ','.join(sorted(edit_files)[:10]))
if risky_cmds:
    parts.append('RISKY=' + '|'.join(risky_cmds[:3]))
print('; '.join(parts) if parts else '')
PYEOF
}

[ -f "$REGISTRY" ] || exit 0

# =============================================
# Phase 1: 등록된 세션 JSONL 증분 파싱
# =============================================

declare -A PROJ_JSONL_DIRS    # project_dir_key → JSONL 디렉토리 경로
declare -A SESSIONS_BY_DIR    # JSONL 디렉토리 → 콤마 연결 세션명들
declare -A SCANNED_PROJ_DIRS  # 서브에이전트 중복 스캔 방지

while IFS='|' read -r SESSION MODEL DIR CREATED SID; do
  [ -z "$SID" ] && continue

  LATEST_JSONL=$(find "$HOME/.claude/projects" -name "${SID}.jsonl" -print -quit 2>/dev/null)
  # [상 fix: ||/&& 우선순위 — if 블록으로 교체]
  if [ -z "$LATEST_JSONL" ] || [ ! -f "$LATEST_JSONL" ]; then
    continue
  fi

  # 줄 기반 증분 파싱 — awk NR로 개행 없는 마지막 줄도 카운트 [중 fix: wc -l → awk]
  OFFSET_KEY="${SESSION}_lines"
  LAST_LINES=$(grep "^$(escape_sed "$OFFSET_KEY")=" "$OFFSET_MARKER" 2>/dev/null | cut -d= -f2)
  LAST_LINES="${LAST_LINES:-0}"
  CURRENT_LINES=$(awk 'END{print NR}' "$LATEST_JSONL" 2>/dev/null || echo "0")

  if [ "$CURRENT_LINES" -gt "$LAST_LINES" ]; then
    SUMMARY=$(parse_jsonl "$LATEST_JSONL" "$LAST_LINES")
    [ -n "$SUMMARY" ] && log_event ACTIVITY "$SESSION" "jsonl_audit" "$SUMMARY"
    sed -i "/^$(escape_sed "$OFFSET_KEY")=/d" "$OFFSET_MARKER" 2>/dev/null
    echo "${OFFSET_KEY}=${CURRENT_LINES}" >> "$OFFSET_MARKER"
  fi

  # JSONL 디렉토리 수집 — 같은 디렉토리에 여러 세션도 모두 기록
  PROJ_DIR=$(dirname "$LATEST_JSONL")
  PROJ_JSONL_DIRS["$DIR"]="$PROJ_DIR"
  if [ -z "${SESSIONS_BY_DIR[$PROJ_DIR]}" ]; then
    SESSIONS_BY_DIR["$PROJ_DIR"]="$SESSION"
  else
    SESSIONS_BY_DIR["$PROJ_DIR"]="${SESSIONS_BY_DIR[$PROJ_DIR]},${SESSION}"
  fi

done < "$REGISTRY"

# =============================================
# Phase 2: 서브에이전트 JSONL 자동 탐지
# =============================================

KNOWN_SIDS=$(cut -d'|' -f5 "$REGISTRY" 2>/dev/null | grep -v '^$')

for DIR in "${!PROJ_JSONL_DIRS[@]}"; do
  PROJ_DIR="${PROJ_JSONL_DIRS[$DIR]}"

  # 같은 PROJ_DIR 중복 스캔 방지
  [ "${SCANNED_PROJ_DIRS[$PROJ_DIR]}" = "1" ] && continue
  SCANNED_PROJ_DIRS["$PROJ_DIR"]="1"

  ALL_SESSIONS="${SESSIONS_BY_DIR[$PROJ_DIR]}"

  while IFS= read -r SUB_JSONL; do
    SUB_SID=$(basename "$SUB_JSONL" .jsonl)

    [[ "$SUB_SID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || continue
    echo "$KNOWN_SIDS" | grep -qF "$SUB_SID" && continue

    SUB_KEY="sub_${SUB_SID//-/}_lines"
    LAST_LINES=$(grep "^${SUB_KEY}=" "$OFFSET_MARKER" 2>/dev/null | cut -d= -f2)
    LAST_LINES="${LAST_LINES:-0}"
    CURRENT_LINES=$(awk 'END{print NR}' "$SUB_JSONL" 2>/dev/null || echo "0")  # [중 fix: awk]
    [ "$CURRENT_LINES" -le "$LAST_LINES" ] && continue

    SUMMARY=$(parse_subagent_jsonl "$SUB_JSONL" "$LAST_LINES")

    if [ -n "$SUMMARY" ]; then
      log_event SUBAGENT "${ALL_SESSIONS}" "subagent_jsonl" \
        "parent=${ALL_SESSIONS} sid=${SUB_SID:0:8} ${SUMMARY}"
    fi

    sed -i "/^$(escape_sed "$SUB_KEY")=/d" "$OFFSET_MARKER" 2>/dev/null
    echo "${SUB_KEY}=${CURRENT_LINES}" >> "$OFFSET_MARKER"

  done < <(find "$PROJ_DIR" -maxdepth 1 -name "*.jsonl" 2>/dev/null)

done

# =============================================
# Phase 3: 오래된 서브에이전트 오프셋 정리
# =============================================

if [ -f "$OFFSET_MARKER" ]; then
  TMP_MARKER=$(mktemp) || { echo "[collect-jsonl] mktemp failed" >&2; exit 1; }  # [하 fix]
  while IFS='=' read -r KEY VAL; do
    if [[ "$KEY" =~ ^sub_([0-9a-f]{32})_lines$ ]]; then
      RAW_SID="${BASH_REMATCH[1]}"
      UUID="${RAW_SID:0:8}-${RAW_SID:8:4}-${RAW_SID:12:4}-${RAW_SID:16:4}-${RAW_SID:20:12}"
      FOUND=$(find "$HOME/.claude/projects" -name "${UUID}.jsonl" -print -quit 2>/dev/null)
      [ -n "$FOUND" ] && echo "${KEY}=${VAL}" >> "$TMP_MARKER"
    else
      echo "${KEY}=${VAL}" >> "$TMP_MARKER"
    fi
  done < "$OFFSET_MARKER"
  mv "$TMP_MARKER" "$OFFSET_MARKER"
fi
