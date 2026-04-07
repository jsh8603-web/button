#!/bin/bash
# spawn-session.sh — harness-wf 규칙대로 psmux 세션 생성
# Usage: spawn-session.sh <session-name> [role-file]
#   session-name: worker | verifier | healer | strategic | <custom>
#   role-file: .harness/<session>-role.md (기본값, 없으면 role 주입 생략)
#
# 규칙 준수 (harness-wf common.md + psmux-session/skill.md):
#   - cmd.exe 기본 쉘 세션 (psmux 표준)
#   - wt.exe 창 먼저 열기 (Claude 스폰 이전)
#   - bypasspermission 폴링 후 Enter
#   - cmd.exe 환경변수: set VAR=value && claude ...
#   - role 파일 존재 시 주입

SESSION="$1"
ROLE_ARG="${2:-}"

if [ -z "$SESSION" ]; then
  echo "Usage: spawn-session.sh <session-name> [role-file]" >&2
  exit 1
fi

SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"
PSMUX=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)

# role 파일: 인자 우선, 없으면 .harness/<session>-role.md
PROJECT_DIR="$(cd "$(dirname "$SECRETARY_DIR")" && pwd)"
if [ -n "$ROLE_ARG" ]; then
  ROLE_FILE="$ROLE_ARG"
else
  ROLE_FILE="$PROJECT_DIR/.harness/${SESSION}-role.md"
fi

# 모델: strategic → opus, 나머지 → sonnet
case "$SESSION" in
  strategic) MODEL="opus";;
  *) MODEL="sonnet";;
esac

# wt.exe 창 위치 (2560×1440 기준)
case "$SESSION" in
  worker)    POS="0,0";    SIZE="130,40";;
  verifier)  POS="1280,0"; SIZE="130,40";;
  healer)    POS="0,720";  SIZE="130,40";;
  strategic) POS="1280,720"; SIZE="130,40";;
  *)         POS="640,360"; SIZE="130,40";;
esac

TITLE="${SESSION} (${MODEL})"

echo "[spawn] Session: ${SESSION} | Model: ${MODEL} | Role: ${ROLE_FILE}"

# 1. 기존 동명 세션 정리
if "$PSMUX" has-session -t "$SESSION" 2>/dev/null; then
  echo "[spawn] Killing existing session: ${SESSION}"
  "$PSMUX" kill-session -t "$SESSION"
fi

# 2. 세션 생성 (cmd.exe 기본 쉘)
"$PSMUX" new-session -d -s "$SESSION" -x 200 -y 50
echo "[spawn] Session created: $?"

# 3. wt.exe 창 열기 (Claude 스폰 이전 — 사용자가 시작 과정 확인)
wt.exe --pos "$POS" --size "$SIZE" --title "$TITLE" psmux attach-session -t "$SESSION" &
sleep 1

# 4. cd + Claude 스폰
SUPERVISOR_SESSION=$("$PSMUX" display-message -p '#S' 2>/dev/null || echo "main")
WIN_PROJECT_DIR=$(echo "$PROJECT_DIR" | sed 's|^/\([a-z]\)/|\1:/|; s|/|\\\\|g')

"$PSMUX" send-keys -t "$SESSION" "cd /d ${WIN_PROJECT_DIR}" Enter
"$PSMUX" send-keys -t "$SESSION" "set PSMUX_SESSION=${SESSION} && claude --dangerously-skip-permissions --model ${MODEL}" Enter

echo "[spawn] Claude spawned in ${SESSION}. Waiting for bypasspermission prompt..."

# 5. bypasspermission 폴링 (최대 60초)
READY=false
for i in $(seq 1 30); do
  sleep 2
  if "$PSMUX" capture-pane -t "$SESSION" -p -S 0 2>/dev/null | grep -qi "bypass"; then
    READY=true
    echo "[spawn] Ready after $((i*2))s"
    break
  fi
done

if [ "$READY" = false ]; then
  echo "[spawn] WARNING: bypasspermission not detected after 60s. Manual action may be needed." >&2
fi

# 6. Trust Enter
"$PSMUX" send-keys -t "$SESSION" Enter

# 7. Role injection
sleep 3
if [ -f "$ROLE_FILE" ]; then
  "$PSMUX" send-keys -t "$SESSION" "Read ${ROLE_FILE} and follow all instructions inside. This is your role assignment." Enter
  echo "[spawn] Role injected from: ${ROLE_FILE}"
else
  echo "[spawn] No role file at ${ROLE_FILE} — skipping injection"
fi

echo "[spawn] Done: ${SESSION} is up."
