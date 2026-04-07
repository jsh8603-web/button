#!/bin/bash
# wake-sonnet.sh — Sonnet 세션 생성/깨우기 + daily cap 체크
# flock으로 이중 호출 방지

SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
[ -f "$CONFIG" ] || { echo "CONFIG not found: $CONFIG" >&2; exit 1; }

PSMUX=$(jq -r '.psmux_path' "$CONFIG")
SONNET_SESSION=$(jq -r '.sonnet_session' "$CONFIG")
QUEUE_DIR="$SECRETARY_DIR/$(jq -r '.queue_dir' "$CONFIG")"
LOG_DIR="$SECRETARY_DIR/$(jq -r '.log_dir' "$CONFIG")"
DEAD_LETTER_DIR="$SECRETARY_DIR/$(jq -r '.dead_letter_dir' "$CONFIG")"
DAILY_CAP=$(jq -r '.daily_cap' "$CONFIG")

AUDIT_LOG_DIR="$HOME/.claude/audit-log"
AUDIT_LOG="$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"

# === flock (이중 호출 방지) ===
mkdir -p "$QUEUE_DIR"
WAKE_LOCK="$QUEUE_DIR/.wake-lock"
if [ -f "$WAKE_LOCK" ]; then
  OLD_PID=$(cat "$WAKE_LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "wake-sonnet already running (PID $OLD_PID)"; exit 0
  fi
fi
echo $$ > "$WAKE_LOCK"
trap "rm -f '$WAKE_LOCK'" EXIT

log_event() {
  local TYPE="$1" EVENT="$2" CONTEXT="$3" ACTION="$4"
  mkdir -p "$AUDIT_LOG_DIR"
  jq -n --arg ts "$(date -Iseconds)" --arg type "$TYPE" --arg session "" \
    --arg event "$EVENT" --arg context "$CONTEXT" --arg action "$ACTION" \
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

# === daily cap 체크 ===
CAP_FILE="$QUEUE_DIR/.daily-cap"
TODAY=$(date +%Y%m%d)
CURRENT=$(grep "^$TODAY:" "$CAP_FILE" 2>/dev/null | cut -d: -f2 || echo 0)

if [ "$CURRENT" -ge "$DAILY_CAP" ]; then
  send_telegram "[secretary] Sonnet daily cap (${DAILY_CAP}) reached. Using Telegram fallback."
  log_event WARN "sonnet_daily_cap_exceeded" "count=$CURRENT" "telegram_fallback"
  exit 0
fi

# 카운트 증가 (원자적 갱신)
grep -v "^$TODAY:" "$CAP_FILE" 2>/dev/null > /tmp/cap-tmp || true
echo "$TODAY:$((CURRENT + 1))" >> /tmp/cap-tmp
mv /tmp/cap-tmp "$CAP_FILE"

# 디렉토리 초기화
mkdir -p "$LOG_DIR" "$QUEUE_DIR/done" "$QUEUE_DIR/locks" "$DEAD_LETTER_DIR"

# === 세션 생성/작업 전달 ===
if "$PSMUX" has-session -t "$SONNET_SESSION" 2>/dev/null; then
  "$PSMUX" send-keys -t "$SONNET_SESSION" \
    "Read $QUEUE_DIR/ 의 새 작업을 처리하세요." Enter
  log_event INFO "sonnet_wakeup" "session=existing" "send-keys"
else
  "$PSMUX" new-session -d -s "$SONNET_SESSION" -x 200 -y 50
  sleep 1
  "$PSMUX" send-keys -t "$SONNET_SESSION" \
    "claude --model sonnet --dangerously-skip-permissions" Enter

  # 시작 대기 (최대 15초)
  for i in $(seq 1 15); do
    sleep 1
    "$PSMUX" capture-pane -t "$SONNET_SESSION" -p -S 0 -E 50 2>/dev/null | \
      grep -qi "bypasspermission\|claude" && break
  done

  sleep 1
  "$PSMUX" send-keys -t "$SONNET_SESSION" Enter
  sleep 1

  # constitution 숙지 + 작업 전달
  "$PSMUX" send-keys -t "$SONNET_SESSION" \
    "Read $SECRETARY_DIR/.messages/sonnet-constitution.txt 의 규칙을 숙지하고 $QUEUE_DIR/ 의 작업을 처리하세요." Enter

  log_event INFO "sonnet_wakeup" "session=new" "new-session"

  # idle monitor 시작 (백그라운드)
  bash "$SECRETARY_DIR/.scripts/sonnet-idle-monitor.sh" &
fi
