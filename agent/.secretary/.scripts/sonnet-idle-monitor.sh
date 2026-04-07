#!/bin/bash
# sonnet-idle-monitor.sh — Sonnet 세션 idle 타이머
# idle_timeout_sec 경과 후 자동 종료 (대기 중 작업 도착 시 카운터 리셋)

SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
[ -f "$CONFIG" ] || { echo "CONFIG not found: $CONFIG" >&2; exit 1; }

PSMUX=$(jq -r '.psmux_path' "$CONFIG")
SONNET_SESSION=$(jq -r '.sonnet_session' "$CONFIG")
IDLE_LIMIT=$(jq -r '.idle_timeout_sec' "$CONFIG")
QUEUE_DIR="$SECRETARY_DIR/$(jq -r '.queue_dir' "$CONFIG")"
LOG_DIR="$SECRETARY_DIR/$(jq -r '.log_dir' "$CONFIG")"

AUDIT_LOG_DIR="$HOME/.claude/audit-log"
AUDIT_LOG="$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"

log_event() {
  local TYPE="$1" EVENT="$2" CONTEXT="$3"
  mkdir -p "$AUDIT_LOG_DIR"
  jq -n --arg ts "$(date -Iseconds)" --arg type "$TYPE" --arg session "$SONNET_SESSION" \
    --arg event "$EVENT" --arg context "$CONTEXT" --arg action "idle-monitor" \
    '{ts:$ts,type:$type,session:$session,event:$event,context:$context,action:$action}' \
    >> "$AUDIT_LOG"
}

START_TIME=$(date +%s)

while true; do
  sleep 60

  # 세션이 없으면 모니터 종료
  if ! "$PSMUX" has-session -t "$SONNET_SESSION" 2>/dev/null; then
    exit 0
  fi

  # 대기 중인 작업이 있으면 idle 카운터 리셋
  PENDING=$(ls "$QUEUE_DIR"/*.json 2>/dev/null | wc -l)
  if [ "$PENDING" -gt 0 ]; then
    continue
  fi

  # 마지막 로그 파일 수정 시간 기준 idle 측정
  LAST_LOG=$(ls -t "$LOG_DIR"/*.md 2>/dev/null | head -1)
  if [ -f "$LAST_LOG" ]; then
    LAST_MOD=$(stat -c %Y "$LAST_LOG" 2>/dev/null || echo 0)
  else
    LAST_MOD=$START_TIME
  fi

  NOW=$(date +%s)
  IDLE=$((NOW - LAST_MOD))
  if [ "$IDLE" -gt "$IDLE_LIMIT" ]; then
    log_event INFO "sonnet_idle_exit" "idle_sec=$IDLE limit=$IDLE_LIMIT"
    "$PSMUX" send-keys -t "$SONNET_SESSION" '/exit' Enter
    sleep 3
    "$PSMUX" kill-session -t "$SONNET_SESSION" 2>/dev/null
    exit 0
  fi
done
