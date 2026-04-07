#!/bin/bash
# wake-opus.sh — Opus 세션 생성/깨우기 (S-2 — 심층 에러 분석)

SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
[ -f "$CONFIG" ] || { echo "CONFIG not found: $CONFIG" >&2; exit 1; }

PSMUX=$(jq -r '.psmux_path' "$CONFIG")
OPUS_SESSION=$(jq -r '.opus_session // "secretary-opus"' "$CONFIG")
OPUS_QUEUE_DIR="$SECRETARY_DIR/$(jq -r '.opus_queue_dir // ".opus-queue"' "$CONFIG")"
LOG_DIR="$SECRETARY_DIR/$(jq -r '.log_dir' "$CONFIG")"
DEAD_LETTER_DIR="$SECRETARY_DIR/$(jq -r '.dead_letter_dir' "$CONFIG")"
OPUS_DAILY_CAP=$(jq -r '.opus_daily_cap // 10' "$CONFIG")

AUDIT_LOG_DIR="$HOME/.claude/audit-log"
AUDIT_LOG="$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"

# === flock (이중 호출 방지) ===
mkdir -p "$OPUS_QUEUE_DIR"
WAKE_LOCK="$OPUS_QUEUE_DIR/.wake-lock"
if [ -f "$WAKE_LOCK" ]; then
  OLD_PID=$(cat "$WAKE_LOCK" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "wake-opus already running (PID $OLD_PID)"; exit 0
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
CAP_FILE="$OPUS_QUEUE_DIR/.daily-cap"
TODAY=$(date +%Y%m%d)
CURRENT=$(grep "^$TODAY:" "$CAP_FILE" 2>/dev/null | cut -d: -f2 || echo 0)

if [ "$CURRENT" -ge "$OPUS_DAILY_CAP" ]; then
  send_telegram "[scriptagent] Opus daily cap (${OPUS_DAILY_CAP}) reached. Using Telegram fallback."
  log_event WARN "opus_daily_cap_exceeded" "count=$CURRENT" "telegram_fallback"
  exit 0
fi

# 카운트 증가
grep -v "^$TODAY:" "$CAP_FILE" 2>/dev/null > /tmp/opus-cap-tmp || true
echo "$TODAY:$((CURRENT + 1))" >> /tmp/opus-cap-tmp
mv /tmp/opus-cap-tmp "$CAP_FILE"

# 디렉토리 초기화
mkdir -p "$LOG_DIR" "$OPUS_QUEUE_DIR/done" "$OPUS_QUEUE_DIR/locks" "$DEAD_LETTER_DIR"

# === 세션 생성/작업 전달 ===
if "$PSMUX" has-session -t "$OPUS_SESSION" 2>/dev/null; then
  "$PSMUX" send-keys -t "$OPUS_SESSION" \
    "Read $OPUS_QUEUE_DIR/ 의 새 작업을 처리해." Enter
  log_event INFO "opus_wakeup" "session=existing" "send-keys"
else
  "$PSMUX" new-session -d -s "$OPUS_SESSION" -x 200 -y 50
  sleep 1
  "$PSMUX" send-keys -t "$OPUS_SESSION" \
    "claude --model opus --dangerously-skip-permissions" Enter

  for i in $(seq 1 15); do
    sleep 1
    "$PSMUX" capture-pane -t "$OPUS_SESSION" -p -S 0 -E 50 2>/dev/null | \
      grep -qi "bypasspermission\|claude" && break
  done

  sleep 1
  "$PSMUX" send-keys -t "$OPUS_SESSION" Enter
  sleep 1

  "$PSMUX" send-keys -t "$OPUS_SESSION" \
    "Read $SECRETARY_DIR/.messages/opus-constitution.txt 의 규칙을 숙지하고 $OPUS_QUEUE_DIR/ 의 작업을 처리해." Enter

  log_event INFO "opus_wakeup" "session=new" "new-session"
  bash "$SECRETARY_DIR/.scripts/sonnet-idle-monitor.sh" "$OPUS_SESSION" &
fi
