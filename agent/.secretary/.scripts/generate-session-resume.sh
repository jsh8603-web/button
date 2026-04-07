#!/bin/bash
# generate-session-resume.sh — 세션 맥락 복원용 리줌 생성
# Claude Code 자동 요약과 중복 제거 후 고유 정보만 주입:
#   - 압축 직전 화면 스냅샷 (Claude Code 요약에 없음)
#   - .wf-active 상태 (WF 타입+시작 시각)
#   - plan.md 전체 체크박스 (완료+미완료 카운트)
#   - execution-log.md 마지막 30줄 (WF truth source)
#   - 신규 생성(Write) vs 수정(Edit) 파일 구분
#   - 도구 에러 목록 (is_error + error/failed 패턴)
#   - 실제 git diff 코드 (요약에 없음)
#   - 현재 활성 psmux 세션 목록
#   ❌ 제거: reads (Claude Code 요약이 더 상세)
SESSION="$1"
SECRETARY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="$SECRETARY_DIR/.session-registry.txt"
PYTHON="/c/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe"
PSMUX_PATH=$(jq -r '.psmux_path' "$SECRETARY_DIR/.sonnet-config.json" 2>/dev/null)
JSONL_BASE="$HOME/.claude/projects"
TMPDIR="$SECRETARY_DIR/.tmp"
mkdir -p "$TMPDIR"
RESUME_FILE="$TMPDIR/session-resume-${SESSION}.txt"

# 레지스트리에서 세션 정보 조회
SID=$(grep "^${SESSION}|" "$REGISTRY" | cut -d'|' -f5)
DIR=$(grep "^${SESSION}|" "$REGISTRY" | cut -d'|' -f3)

JSONL_DIR="$JSONL_BASE/$(echo "$DIR" | sed 's|:|--|; s|/|--|g; s|\\|--|g')"
JSONL_FILE="$JSONL_DIR/${SID}.jsonl"
if [ -f "$JSONL_FILE" ]; then
  HAS_JSONL=1
else
  HAS_JSONL=0
fi

if [ "$HAS_JSONL" = "1" ]; then
"$PYTHON" - "$JSONL_FILE" > "$RESUME_FILE" << 'PYEOF'
import sys, json

path = sys.argv[1]
last_prompt = ''
write_files = []   # Write tool = 신규 생성
edit_files = []    # Edit tool = 기존 수정
bashes = []
agents = []
errors = []        # 도구 에러 (is_error 또는 error 패턴)
last_assistant_text = ''

with open(path, 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()

for raw in lines:
    try:
        d = json.loads(raw)
        t = d.get('type', '')

        if t == 'last-prompt':
            lp = d.get('lastPrompt', '')
            if lp:
                last_prompt = lp

        elif t == 'assistant':
            for c in d.get('message', {}).get('content', []):
                if not isinstance(c, dict):
                    continue
                if c.get('type') == 'text':
                    txt = c.get('text', '').strip()
                    if len(txt) > 80:
                        last_assistant_text = txt
                elif c.get('type') == 'tool_use':
                    name = c.get('name', '')
                    inp = c.get('input', {})
                    if name == 'Write' and 'file_path' in inp:
                        write_files.append(inp['file_path'])
                    elif name == 'Edit' and 'file_path' in inp:
                        edit_files.append(inp['file_path'])
                    elif name == 'Bash':
                        bashes.append(inp.get('command', '')[:120])
                    elif name == 'Agent':
                        agents.append(inp.get('description', '')[:60])

        elif t == 'tool_result':
            # 도구 에러 수집
            is_err = d.get('is_error', False)
            content = ''
            for c in d.get('content', []):
                if isinstance(c, dict) and c.get('type') == 'text':
                    content = c.get('text', '')
                    break
            if is_err or (content and ('error' in content.lower()[:100] or 'failed' in content.lower()[:100])):
                tool_id = d.get('tool_use_id', '')
                # 짧은 요약만 보존
                err_summary = content[:200].replace('\n', ' ').strip()
                if err_summary:
                    errors.append(err_summary)
    except:
        pass

def recent_unique(lst, n):
    seen = set(); result = []
    for x in reversed(lst):
        if x not in seen:
            seen.add(x); result.append(x)
        if len(result) >= n:
            break
    return result

print('## Session Resume (compression recovery)')
print()

# 1. 마지막 사용자 요청
if last_prompt:
    print('### Last User Request')
    print(f'> {last_prompt}')
    print()

# 2. 어시스턴트 마지막 응답 (압축 직전 상태)
if last_assistant_text:
    print('### Last Assistant Response')
    print(last_assistant_text[:800])
    print()

# 3. 신규 생성 파일 (Write)
created = recent_unique(write_files, 8)
if created:
    print('### Created Files (Write)')
    for f in created:
        print(f'- {f}')
    print()

# 4. 수정 파일 (Edit)
edited = recent_unique(edit_files, 10)
if edited:
    print('### Modified Files (Edit)')
    for f in edited:
        print(f'- {f}')
    print()

# 5. 도구 에러 (실패 원인 즉시 파악용)
recent_errors = recent_unique(errors, 5)
if recent_errors:
    print('### Tool Errors')
    for e in recent_errors:
        print(f'- {e}')
    print()

# 6. 최근 bash 명령
recent_bash = recent_unique(bashes, 5)
if recent_bash:
    print('### Recent Bash Commands')
    for c in recent_bash:
        print(f'- `{c}`')
    print()

if agents:
    print('### Spawned Agents')
    for a in recent_unique(agents, 3):
        print(f'- {a}')
    print()
PYEOF
else
  # JSONL not found — generate minimal resume header
  echo "## Session Resume (compression recovery, no JSONL)" > "$RESUME_FILE"
  echo "" >> "$RESUME_FILE"
fi

# 1. 압축 직전 화면 스냅샷 (가장 고유한 정보)
echo "### Screen State Before Compression" >> "$RESUME_FILE"
"$PSMUX_PATH" capture-pane -p -S -200 -t "$SESSION" 2>/dev/null | tail -50 >> "$RESUME_FILE" || echo "(snapshot unavailable)" >> "$RESUME_FILE"
echo "" >> "$RESUME_FILE"

# 2. .wf-active 상태 (WF 타입 + 시작 시각)
WF_ACTIVE="$DIR/.wf-active"
if [ -f "$WF_ACTIVE" ]; then
  echo "### Active Workflow" >> "$RESUME_FILE"
  cat "$WF_ACTIVE" >> "$RESUME_FILE"
  echo "" >> "$RESUME_FILE"
fi

# 3. plan.md 전체 체크박스 상태 (완료+미완료 카운트 + 전체 항목)
PLAN_FILE="$DIR/plan.md"
if [ -f "$PLAN_FILE" ]; then
  DONE=$(grep -c '^\- \[x\]' "$PLAN_FILE" 2>/dev/null || echo 0)
  TODO=$(grep -c '^\- \[ \]' "$PLAN_FILE" 2>/dev/null || echo 0)
  TOTAL=$((DONE + TODO))
  echo "### Plan Checkpoint (${DONE}/${TOTAL} done)" >> "$RESUME_FILE"
  grep '^\- \[' "$PLAN_FILE" | head -25 >> "$RESUME_FILE"
  echo "" >> "$RESUME_FILE"
fi

PROGRESS_FILE="$DIR/progress.md"
if [ -f "$PROGRESS_FILE" ]; then
  P_DONE=$(grep -c '^\- \[x\]' "$PROGRESS_FILE" 2>/dev/null || echo 0)
  P_TODO=$(grep -c '^\- \[ \]' "$PROGRESS_FILE" 2>/dev/null || echo 0)
  P_TOTAL=$((P_DONE + P_TODO))
  echo "### Progress Checkpoint (${P_DONE}/${P_TOTAL} done)" >> "$RESUME_FILE"
  grep '^\- \[' "$PROGRESS_FILE" | head -25 >> "$RESUME_FILE"
  echo "" >> "$RESUME_FILE"
fi

# 4. execution-log.md 마지막 30줄 (WF truth source)
EXEC_LOG="$DIR/execution-log.md"
if [ -f "$EXEC_LOG" ]; then
  echo "### Execution Log (last 30 lines)" >> "$RESUME_FILE"
  # 첫 줄 (WF 헤더: Phase/Status) 항상 포함
  head -1 "$EXEC_LOG" >> "$RESUME_FILE"
  echo "..." >> "$RESUME_FILE"
  tail -30 "$EXEC_LOG" >> "$RESUME_FILE"
  echo "" >> "$RESUME_FILE"
fi

# 5. git diff — 실제 코드 변경 내용 (Claude Code 요약에 없음)
echo "### Uncommitted Changes (git diff)" >> "$RESUME_FILE"
git -C "$DIR" diff --stat 2>/dev/null >> "$RESUME_FILE"
echo "" >> "$RESUME_FILE"
git -C "$DIR" diff --unified=2 2>/dev/null | head -120 >> "$RESUME_FILE"
git -C "$DIR" diff --cached --unified=2 2>/dev/null | head -80 >> "$RESUME_FILE"

# 6. 현재 살아있는 psmux 세션 목록 (멀티에이전트 상태 파악)
echo "" >> "$RESUME_FILE"
echo "### Active psmux Sessions" >> "$RESUME_FILE"
"$PSMUX_PATH" ls 2>/dev/null | cut -d: -f1 >> "$RESUME_FILE" || echo "(none)" >> "$RESUME_FILE"

echo "$RESUME_FILE"
