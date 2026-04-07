#!/bin/bash
# secretary-loop.sh — 비서 self-wake 루프 (3분 주기로 scout-and-act 실행)

SECRETARY_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
PSMUX_PATH=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)
PSMUX="$PSMUX_PATH"
INTERVAL=30  # 30초

TS_FILE="$SECRETARY_DIR/.self-wake-ts"
STOP_FILE="$SECRETARY_DIR/.watchdog-stop"
ALIVE_FILE="$SECRETARY_DIR/.secretary-alive"

# 중복 구동 방지
if [ -f "$TS_FILE" ]; then
  _TS=$(cat "$TS_FILE"); _NOW=$(date +%s%3N)
  _DIFF=$(( (_NOW - _TS) / 1000 ))
  if [ "$_DIFF" -lt 360 ]; then
    echo "[secretary-loop] 루프 이미 동작 중 (${_DIFF}s ago)"
    exit 0
  fi
fi

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
