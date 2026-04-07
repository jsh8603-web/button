#!/bin/bash
# msg.sh — 파일 기반 메시지 전송 (200자+ 대응)
# [ACTION] 접두사: Telegram 승인 요청 + dead-letter 폴백
# [INFO] 또는 없음: 세션 직접 전송

SESSION="$1"
[ -z "$SESSION" ] && { echo "MSG_FAIL: SESSION not specified" >&2; exit 1; }
MSG_FILE="$2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETARY_DIR="$SCRIPT_DIR/.."
CONFIG="$SECRETARY_DIR/.sonnet-config.json"

PSMUX=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)
DEAD_LETTER_DIR="$SECRETARY_DIR/$(jq -r '.dead_letter_dir // ".dead-letter"' "$CONFIG" 2>/dev/null)"

AUDIT_LOG_DIR="$HOME/.claude/audit-log"
AUDIT_LOG="$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"

if [ ! -f "$MSG_FILE" ]; then
  echo "MSG_FAIL: file not found: $MSG_FILE"
  exit 1
fi

log_action() {
  mkdir -p "$AUDIT_LOG_DIR"
  jq -n --arg ts "$(date -Iseconds)" --arg type "ACTION" --arg session "$SESSION" \
    --arg event "action_pending_approval" --arg context "$1" --arg action "telegram" \
    '{ts:$ts,type:$type,session:$session,event:$event,context:$context,action:$action}' \
    >> "$AUDIT_LOG"
}

send_telegram() {
  local MSG="$1"
  local HTTP_CODE
  HTTP_CODE=$(curl -s -w "%{http_code}" -o /dev/null \
    "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${AGENT_SECRET:-}" \
    -d "$(jq -n --arg msg "$MSG" '{message: $msg}')")
  if [ "$HTTP_CODE" != "200" ]; then
    mkdir -p "$DEAD_LETTER_DIR"
    echo "$MSG" > "$DEAD_LETTER_DIR/$(date +%s)-telegram.txt"
  fi
}

FIRST_LINE=$(head -1 "$MSG_FILE")
MSG_CONTENT=$(cat "$MSG_FILE")

if echo "$FIRST_LINE" | grep -q "^\[ACTION\]"; then
  send_telegram "[approval needed] $MSG_CONTENT"
  log_action "$FIRST_LINE"
  exit 0
fi

# [INFO] 또는 접두사 없음 → 세션 직접 전송
"$PSMUX" send-keys -t "$SESSION" "Read $(realpath "$MSG_FILE") 의 내용을 참고하세요." Enter
