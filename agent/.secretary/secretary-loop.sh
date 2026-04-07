#!/bin/bash
# secretary-loop.sh — 비서 self-wake 루프 (3분 주기로 scout-and-act 실행)

SECRETARY_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
PSMUX_PATH=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)
PSMUX="$PSMUX_PATH"
INTERVAL=15  # 15초

TS_FILE="$SECRETARY_DIR/.self-wake-ts"
STOP_FILE="$SECRETARY_DIR/.watchdog-stop"
ALIVE_FILE="$SECRETARY_DIR/.secretary-alive"

# 중복 구동 방지 — PID 기반 (타임스탬프 기반은 stale TS에 의한 오탈지 발생)
PIDFILE="$SECRETARY_DIR/.secretary-loop.pid"
if [ -f "$PIDFILE" ]; then
  _OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$_OLD_PID" ] && kill -0 "$_OLD_PID" 2>/dev/null; then
    echo "[secretary-loop] 루프 이미 동작 중 (PID $_OLD_PID)"
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE" "$ALIVE_FILE"' EXIT

touch "$ALIVE_FILE"
echo "[secretary-loop] 시작 (interval=${INTERVAL}s, $(date '+%H:%M'))"

while true; do
  sleep "$INTERVAL"

  # sentinel 종료
  if [ -f "$STOP_FILE" ]; then
    rm -f "$TS_FILE" "$STOP_FILE" "$ALIVE_FILE"
    exit 0
  fi

  # psmux 세션이 하나도 없으면 대기 (생기면 자동 재개)
  ACTIVE=$("$PSMUX" ls 2>/dev/null | wc -l)
  if [ "$ACTIVE" -le 0 ]; then
    continue
  fi

  echo "$(date +%s%3N)" > "$TS_FILE"

  # scout-and-act 실행 (LLM 불필요)
  bash "$SECRETARY_DIR/.scripts/scout-and-act.sh" "secretary"
done
