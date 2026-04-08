#!/bin/bash
# 세션 부활: 레지스트리 조회 → psmux 직접 재생성 → claude 실행 → /remote-control → 컨텍스트 주입
SESSION_NAME="$1"
SECRETARY_DIR="$(dirname "$0")/.."
REGISTRY="$SECRETARY_DIR/.session-registry.txt"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"

MODEL=$(grep "^${SESSION_NAME}|" "$REGISTRY" | cut -d'|' -f2)
DIR=$(grep "^${SESSION_NAME}|" "$REGISTRY" | cut -d'|' -f3)

if [ -z "$MODEL" ]; then
  echo "REVIVE_FAIL: $SESSION_NAME not in registry"
  exit 1
fi

PSMUX=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)
BASH_PATH=$(jq -r '.bash_path // "C:/msys64/usr/bin/bash.exe"' "$CONFIG" 2>/dev/null)
CLAUDE_BIN=$(jq -r '.claude_bin // "claude"' "$CONFIG" 2>/dev/null)

# Windows 경로 변환 (psmux -c 인자용)
WIN_DIR=$(echo "$DIR" | sed 's|/\([a-z]\)/|\1:/|' | sed 's|/|\\|g')

# psmux 세션 생성 (기존 세션 정리 후)
"$PSMUX" kill-session -t "$SESSION_NAME" 2>/dev/null
"$PSMUX" new-session -d -s "$SESSION_NAME" -c "$WIN_DIR" -- "$BASH_PATH" -l
if [ $? -ne 0 ]; then
  echo "REVIVE_FAIL: psmux new-session failed for $SESSION_NAME"
  exit 1
fi

sleep 2
# Claude 실행
"$PSMUX" send-keys -t "$SESSION_NAME" "$CLAUDE_BIN --dangerously-skip-permissions" Enter

# 백그라운드: Claude 시작 대기 → /remote-control → resume 주입
_S="$SESSION_NAME" _SDIR="$SECRETARY_DIR" _PSMUX="$PSMUX" bash -c '
  TMPDIR="$_SDIR/.tmp"
  # Claude Code 실행 대기 → /remote-control 전송 (최대 60초, 5초 간격)
  _RC_MARKER="$_SDIR/.remote-control-${_S}"
  rm -f "$_RC_MARKER" 2>/dev/null
  for i in $(seq 1 12); do
    sleep 5
    _CAP=$("$_PSMUX" capture-pane -p -S -20 -t "$_S" 2>/dev/null)
    # Claude 실행 중인지
    echo "$_CAP" | grep -qE "bypass permissions" || continue
    # 사용자 입력 중이면 다음 폴링
    echo "$_CAP" | grep -qE "^[>❯]\s+\S" && continue
    "$_PSMUX" send-keys -t "$_S" "/remote-control" Enter
    touch "$_RC_MARKER"
    sleep 5
    break
  done
  # resume 주입
  bash "$_SDIR/.scripts/generate-session-resume.sh" "$_S" >/dev/null 2>&1
  if [ -f "$TMPDIR/session-resume-${_S}.txt" ]; then
    bash "$_SDIR/.scripts/msg.sh" "$_S" "$TMPDIR/session-resume-${_S}.txt"
  else
    # JSONL 없으면 정적 메시지 폴백
    PROJECT=$(basename "$(grep "^${_S}|" "$_SDIR/.session-registry.txt" | cut -d"|" -f3)"  2>/dev/null)
    MEMORY=$(ls -t ~/.claude/memory/session_${PROJECT}_*.md 2>/dev/null | head -1)
    if [ -z "$MEMORY" ]; then
      MSG="$_SDIR/.messages/revive-git-fallback.txt"
    else
      PYTHON="/c/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe"
      MEMORY_AGE=$("$PYTHON" -c "import os,time; print(int(time.time()-os.path.getmtime('"'"'$MEMORY'"'"')))" 2>/dev/null || echo 99999)
      if [ "${MEMORY_AGE:-99999}" -gt 10800 ]; then
        MSG="$_SDIR/.messages/revive-stale-memory.txt"
      else
        MSG="$_SDIR/.messages/revive-context.txt"
      fi
    fi
    bash "$_SDIR/.scripts/msg.sh" "$_S" "$MSG"
  fi
' &

echo "REVIVE_REQUESTED: $SESSION_NAME (model=$MODEL, dir=$DIR)"
