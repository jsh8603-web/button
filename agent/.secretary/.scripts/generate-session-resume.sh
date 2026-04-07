#!/bin/bash
# generate-session-resume.sh — 세션 맥락 복원용 리줌 생성
# Claude Code 자동 요약과 중복 제거 후 고유 정보만 주입:
#   - 압축 직전 화면 스냅샷 (Claude Code 요약에 없음)
#   - 미완료 TODO 목록 (plan.md - [ ] 파싱)
#   - 실제 git diff 코드 (요약에 없음)
#   - 최근 편집 파일 목록 (요약은 설명형, 이건 경로 직접)
#   - 현재 활성 psmux 세션 목록
#   ❌ 제거: 대화 흐름·reads·MEMORY.md (Claude Code 요약이 더 상세)
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
[ ! -f "$JSONL_FILE" ] && exit 1

"$PYTHON" - "$JSONL_FILE" > "$RESUME_FILE" << 'PYEOF'
import sys, json

path = sys.argv[1]
last_prompt = ''
edit_files = []
reads = []
bashes = []
agents = []
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
                        last_assistant_text = txt  # 마지막 것만 보존
                elif c.get('type') == 'tool_use':
                    name = c.get('name', '')
                    inp = c.get('input', {})
                    if name in ('Edit', 'Write') and 'file_path' in inp:
                        edit_files.append(inp['file_path'])
                    elif name == 'Read' and 'file_path' in inp:
                        reads.append(inp['file_path'])
                    elif name == 'Bash':
                        bashes.append(inp.get('command', '')[:120])
                    elif name == 'Agent':
                        agents.append(inp.get('description', '')[:60])
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

print('## Session Resume (secretary — compression recovery)')
print()

# 1. 마지막 사용자 요청 (Claude Code 요약과 중복이지만 가장 중요 — 유지)
if last_prompt:
    print('### Last User Request')
    print(f'> {last_prompt}')
    print()

# 2. 어시스턴트 마지막 응답 (압축 직전 상태)
if last_assistant_text:
    print('### Last Assistant Response')
    print(last_assistant_text[:800])
    print()

# 3. 최근 편집 파일 (경로 직접 참조용)
edited = recent_unique(edit_files, 10)
if edited:
    print('### Recently Edited Files')
    for f in edited:
        print(f'- {f}')
    print()

# 3. 최근 읽은 파일 (Claude Code 요약에 없는 경로 정보)
read_list = recent_unique(reads, 8)
if read_list:
    print('### Recently Read Files')
    for f in read_list:
        print(f'- {f}')
    print()

# 3. 최근 bash 명령
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

# 1. 압축 직전 화면 스냅샷 (가장 고유한 정보)
echo "### Screen State Before Compression" >> "$RESUME_FILE"
"$PSMUX_PATH" capture-pane -p -S 0 -t "$SESSION" 2>/dev/null | tail -50 >> "$RESUME_FILE" || echo "(snapshot unavailable)" >> "$RESUME_FILE"
echo "" >> "$RESUME_FILE"

# 2. 미완료 TODO (plan.md - [ ] 항목만)
PLAN_FILE="$DIR/plan.md"
if [ -f "$PLAN_FILE" ]; then
  TODOS=$(grep '^\- \[ \]' "$PLAN_FILE" | head -15)
  if [ -n "$TODOS" ]; then
    echo "### Pending TODOs (from plan.md)" >> "$RESUME_FILE"
    echo "$TODOS" >> "$RESUME_FILE"
    echo "" >> "$RESUME_FILE"
  fi
fi

# 3. git diff — 실제 코드 변경 내용 (Claude Code 요약에 없음)
echo "### Uncommitted Changes (git diff)" >> "$RESUME_FILE"
git -C "$DIR" diff --stat 2>/dev/null >> "$RESUME_FILE"
echo "" >> "$RESUME_FILE"
git -C "$DIR" diff --unified=2 2>/dev/null | head -120 >> "$RESUME_FILE"
git -C "$DIR" diff --cached --unified=2 2>/dev/null | head -80 >> "$RESUME_FILE"

# 4. 현재 살아있는 psmux 세션 목록 (멀티에이전트 상태 파악)
echo "" >> "$RESUME_FILE"
echo "### Active psmux Sessions" >> "$RESUME_FILE"
"$PSMUX_PATH" ls 2>/dev/null | cut -d: -f1 >> "$RESUME_FILE" || echo "(none)" >> "$RESUME_FILE"

echo "$RESUME_FILE"
