#!/bin/bash
# spawn-session.sh — harness-wf 스펙 완전 구현
# 세션 생성 → wt.exe 창 → Claude 스폰(system-prompt) → 핸드셰이크(ACK) → 역할 주입
#
# Usage:
#   spawn-session.sh <session-name> [role-file]
#   session-name: worker | verifier | healer | strategic | <custom>
#   role-file: 기본값 .harness/<session>-role.md (없으면 역할 주입 생략)
#
# 병렬 실행:
#   bash spawn-session.sh worker &
#   bash spawn-session.sh verifier &
#   bash spawn-session.sh healer &
#   bash spawn-session.sh strategic &
#   wait
#   # → 4세션 동시 기동, 각각 ACK까지 완료 후 리턴

SESSION="$1"
ROLE_ARG="${2:-}"

if [ -z "$SESSION" ]; then
  echo "Usage: spawn-session.sh <session-name> [role-file]" >&2
  exit 1
fi

# ── 경로 설정 ──
SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$SECRETARY_DIR/.sonnet-config.json"

# jq 없으면 grep fallback
if command -v jq &>/dev/null; then
  PSMUX=$(jq -r '.psmux_path' "$CONFIG" 2>/dev/null)
else
  PSMUX=$(grep -o '"psmux_path"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG" | sed 's/.*"psmux_path"[[:space:]]*:[[:space:]]*"//;s/"$//')
fi

if [ -z "$PSMUX" ] || [ ! -f "$PSMUX" ]; then
  echo "[spawn:${SESSION}] ERROR: psmux not found (PSMUX=$PSMUX)" >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$SECRETARY_DIR")" && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
WIN_PROJECT_DIR=$(echo "$PROJECT_DIR" | sed 's|^/\([a-z]\)/|\1:/|; s|/|\\\\|g')
WIN_PROJECT_DIR_SLASH=$(echo "$PROJECT_DIR" | sed 's|^/\([a-z]\)/|\1:/|')

# role 파일
if [ -n "$ROLE_ARG" ]; then
  ROLE_FILE="$ROLE_ARG"
else
  ROLE_FILE="$PROJECT_DIR/.harness/${SESSION}-role.md"
fi

# ACK 파일 (공유, 병렬 안전 — append는 atomic)
HARNESS_DIR="$PROJECT_DIR/.harness"
mkdir -p "$HARNESS_DIR"
ACK_FILE="$HARNESS_DIR/acks.txt"

# ── Supervisor 세션명 ──
SUPERVISOR_SESSION=$("$PSMUX" display-message -p '#S' 2>/dev/null || echo "")
if [ -z "$SUPERVISOR_SESSION" ]; then
  # psmux 밖에서 실행 시 fallback
  SUPERVISOR_SESSION="main"
fi

# ── 모델 + wt.exe 배치 ──
case "$SESSION" in
  strategic) MODEL="opus";;
  *) MODEL="sonnet";;
esac

case "$SESSION" in
  worker)    POS="0,0";      SIZE="130,40"; STAGGER=0;;
  verifier)  POS="1280,0";   SIZE="130,40"; STAGGER=1;;
  healer)    POS="0,720";    SIZE="130,40"; STAGGER=2;;
  strategic) POS="1280,720"; SIZE="130,40"; STAGGER=3;;
  *)         POS="640,360";  SIZE="130,40"; STAGGER=4;;
esac

TITLE="${SESSION} (${MODEL})"

# ── system-prompt (역할별, common.md 스펙) ──
case "$SESSION" in
  worker)
    SYSTEM_PROMPT="Harness Worker. sessions: worker/${SUPERVISOR_SESSION}/verifier/healer/strategic. Korean. 컨텍스트 압축 시 execution-log.md Read하여 현재 Phase + 마지막 Sub-obj 복원."
    ;;
  verifier)
    SYSTEM_PROMPT="Harness Verifier. sessions: verifier/${SUPERVISOR_SESSION}/worker/healer/strategic. Korean. 컨텍스트 압축 시 execution-log.md Read하여 현재 Phase + 마지막 검증 상태 복원. FAIL 판정 시 ~/.claude/memory/promotion-log.md에 ERROR 기록 필수(상황/원인/해결/방지책 각 20자+)."
    ;;
  healer)
    SYSTEM_PROMPT="Harness Healer. sessions: healer/${SUPERVISOR_SESSION}/verifier/worker. Korean. 컨텍스트 압축 시 execution-log.md Read하여 수정 대기 중인 FAIL Sub-obj 복원."
    ;;
  strategic)
    SYSTEM_PROMPT="Harness Strategic Reviewer. sessions: strategic/${SUPERVISOR_SESSION}. Korean. 컨텍스트 압축 시 execution-log.md Read하여 현재 Phase + 마지막 리뷰 상태 복원. 리서치 결과는 반드시 ~/.claude/docs/archive/research-raw/${PROJECT_NAME}-sr-$(date +%Y-%m-%d).txt에 원본 저장 후 핵심만 지시서에 포함."
    ;;
  *)
    SYSTEM_PROMPT="Harness Agent (${SESSION}). sessions: ${SESSION}/${SUPERVISOR_SESSION}. Korean."
    ;;
esac

echo "[spawn:${SESSION}] Session: ${SESSION} | Model: ${MODEL} | Supervisor: ${SUPERVISOR_SESSION}"

# ── 1. 기존 동명 세션 정리 + 생성 ──
if "$PSMUX" has-session -t "$SESSION" 2>/dev/null; then
  echo "[spawn:${SESSION}] Killing existing session"
  "$PSMUX" kill-session -t "$SESSION"
fi

"$PSMUX" new-session -d -s "$SESSION" -x 200 -y 50
if [ $? -ne 0 ]; then
  echo "[spawn:${SESSION}] ERROR: session creation failed" >&2
  exit 1
fi
echo "[spawn:${SESSION}] Session created"

# ── 2. wt.exe 창 (stagger로 병렬 충돌 방지) ──
sleep "$STAGGER"
powershell.exe -WindowStyle Hidden -Command "Start-Process wt.exe -ArgumentList '--pos','${POS}','--size','${SIZE}','--title','\"${TITLE}\"','psmux','attach-session','-t','${SESSION}'" &
sleep 1

# ── 3. cd + Claude 스폰 (system-prompt 포함) ──
"$PSMUX" send-keys -t "$SESSION" "cd /d ${WIN_PROJECT_DIR}" Enter
"$PSMUX" send-keys -t "$SESSION" "set PSMUX_SESSION=${SESSION} && claude --dangerously-skip-permissions --model ${MODEL} --system-prompt \"${SYSTEM_PROMPT}\"" Enter

echo "[spawn:${SESSION}] Claude spawning..."

# ── 4. bypasspermission 폴링 (최대 90초) ──
READY=false
for i in $(seq 1 45); do
  sleep 2
  if "$PSMUX" capture-pane -t "$SESSION" -p -S 0 2>/dev/null | grep -qi "bypass"; then
    READY=true
    echo "[spawn:${SESSION}] Claude ready after $((i*2))s"
    break
  fi
done

if [ "$READY" = false ]; then
  echo "[spawn:${SESSION}] WARNING: bypasspermission not detected after 90s" >&2
fi

# ── 5. Trust Enter ──
"$PSMUX" send-keys -t "$SESSION" Enter
sleep 3

# ── 6. 핸드셰이크 전송 ──
echo "[spawn:${SESSION}] Sending handshake..."
"$PSMUX" send-keys -t "$SESSION" "HANDSHAKE: Bash 도구로 다음 명령 실행: echo '${SESSION}_ACK' >> ${WIN_PROJECT_DIR_SLASH}/.harness/acks.txt" Enter

# ── 7. ACK 폴링 (최대 60초) ──
ACK_OK=false
for i in $(seq 1 12); do
  sleep 5
  if grep -q "${SESSION}_ACK" "$ACK_FILE" 2>/dev/null; then
    ACK_OK=true
    echo "[spawn:${SESSION}] ACK received after $((i*5))s"
    break
  fi
done

if [ "$ACK_OK" = false ]; then
  echo "[spawn:${SESSION}] WARNING: ACK not received after 60s — retry once" >&2
  # 재시도 1회
  "$PSMUX" send-keys -t "$SESSION" "HANDSHAKE 재시도: Bash 도구로 실행: echo '${SESSION}_ACK' >> ${WIN_PROJECT_DIR_SLASH}/.harness/acks.txt" Enter
  for i in $(seq 1 6); do
    sleep 5
    if grep -q "${SESSION}_ACK" "$ACK_FILE" 2>/dev/null; then
      ACK_OK=true
      echo "[spawn:${SESSION}] ACK received on retry"
      break
    fi
  done
fi

if [ "$ACK_OK" = false ]; then
  echo "[spawn:${SESSION}] ERROR: ACK failed — manual intervention needed" >&2
  exit 2
fi

# ── 8. 역할 주입 ──
if [ -f "$ROLE_FILE" ]; then
  sleep 2
  "$PSMUX" send-keys -t "$SESSION" "Read ${ROLE_FILE} and follow all instructions inside. This is your role assignment for the current harness workflow." Enter
  echo "[spawn:${SESSION}] Role injected: ${ROLE_FILE}"
else
  echo "[spawn:${SESSION}] No role file at ${ROLE_FILE} — skipping"
fi

echo "[spawn:${SESSION}] DONE (session=${SESSION}, model=${MODEL}, ack=OK)"
