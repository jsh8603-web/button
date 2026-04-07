#!/bin/bash
# 세션 부활: 레지스트리 조회 → API 호출 → 컨텍스트 분기 주입
SESSION_NAME="$1"
SECRETARY_DIR="$(dirname "$0")/.."
REGISTRY="$SECRETARY_DIR/.session-registry.txt"

MODEL=$(grep "^${SESSION_NAME}|" "$REGISTRY" | cut -d'|' -f2)
DIR=$(grep "^${SESSION_NAME}|" "$REGISTRY" | cut -d'|' -f3)

if [ -z "$MODEL" ]; then
  echo "REVIVE_FAIL: $SESSION_NAME not in registry"
  exit 1
fi

# agent server API 호출
curl -s -X POST http://localhost:9876/tasks \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"ai\",\"model\":\"$MODEL\",\"dir\":\"$DIR\",\"name\":\"$SESSION_NAME\"}"

# 부활 후 컨텍스트 주입
sleep 10  # 세션 시작 대기

# generate-session-resume.sh로 JSONL 기반 맥락 복원 시도
RESUME=$(bash "$(dirname "$0")/generate-session-resume.sh" "$SESSION_NAME" 2>/dev/null)

if [ -f "$RESUME" ]; then
  bash "$(dirname "$0")/msg.sh" "$SESSION_NAME" "$RESUME"
  echo "REVIVE_REQUESTED: $SESSION_NAME (model=$MODEL, dir=$DIR, msg=resume)"
else
  # JSONL 없거나 실패 시 정적 메시지 폴백
  PROJECT=$(basename "$DIR")
  MEMORY=$(ls -t ~/.claude/memory/session_${PROJECT}_*.md 2>/dev/null | head -1)
  if [ -z "$MEMORY" ]; then
    MSG="$SECRETARY_DIR/.messages/revive-git-fallback.txt"
  elif [ $(( $(date +%s) - $(stat -c %Y "$MEMORY") )) -gt 10800 ]; then
    MSG="$SECRETARY_DIR/.messages/revive-stale-memory.txt"
  else
    MSG="$SECRETARY_DIR/.messages/revive-context.txt"
  fi
  bash "$(dirname "$0")/msg.sh" "$SESSION_NAME" "$MSG"
  echo "REVIVE_REQUESTED: $SESSION_NAME (model=$MODEL, dir=$DIR, msg=$MSG)"
fi
