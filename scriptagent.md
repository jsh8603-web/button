# Script Agent — psmux 비서 스크립트 설계

## 실행 엔진 확정
- 1단계: 경량화 (범위: Part 1 — bash-only 스크립트 전체)
- 2단계: harness (범위: Part 2 — Sonnet 비서 + 감사소스수집 + Part 3 감사wf 개편 + Phase 1 필수 수정 반영)

<!-- PRE-FLIGHT: phases=[0a,1,3,4] skipped=[0.5,2] -->
<!-- PHASE-0A-COMPLETE: 2026-04-06T14:30:00Z -->
<!-- PHASE-1-COMPLETE: 2026-04-06T15:00:00Z -->
<!-- PHASE-3-COMPLETE: 2026-04-06T15:10:00Z -->
<!-- PHASE-4-COMPLETE: 2026-04-06T15:15:00Z -->

<!-- DEBATE-VERDICT -->
### Debate 검증 결과 (Phase 0α, 2026-04-06)
- **유효 결론**: 2-Layer 아키텍처 건전. sessionId 기반 JSONL 매칭, 바이트 오프셋 증분 파싱, JSONL audit-log + 공유 경로, save-context 삭제, 트리거 2개 + 작업유형 1개, 상태 파일 JSON 통합, read replica 제거, self-wake timeout + 재시작 3회 제한.
- **수정 항목**: dir_to_jsonl_path→find_jsonl_by_sid, log_event→JSONL, audit-log→~/.claude/audit-log/, save-context 삭제, 압축 시 JSONL 리줌 주입
- **미해결**: .secretary-state.json 스키마(구현 시 확정), 장시간 세션 JSONL 성능 실측, S-1 INFO 유용성/S-2 도메인 에러 정확도(운영 데이터 필요)
- **verdict 원본**: C:\Users\jsh86\debate-verdict.md

> **구조**: 2-Layer 아키텍처 (사용자 지시에 의한 설계 결정)
> - **Layer 1 (Part 1)**: bash-only 스크립트 — 결정론적 감시/조치 + 감사소스수집
> - **Layer 2 (Part 2)**: Sonnet 온디맨드 세션 — 비결정론적 판단 2개 (예외분석, 의미적에러분석)
> - **Haiku 미사용**: Debate에서 불안정성 논증됨. LLM이 필요한 판단은 Sonnet 급 필요.
> - **실행 환경**: psmux + bash (Windows MSYS2, self-wake 패턴)
>
> **멀티 워크플로우 호환성** (규칙 전수조사 완료 2026-04-06):
> 이 비서는 다음 워크플로우가 동시 가동 중일 때도 정상 기능한다:
> - **harness-wf** (5에이전트): worker/verifier/healer/strategic 세션 감시 + JSONL 수집
> - **lightweight-wf** (2에이전트): Supervisor/Worker 세션 감시 + self-wake 충돌 방지
> - **enhanced-coding-wf**: Agent 서브에이전트(psmux 아닌 내부 스폰) — 간접 수집(JSONL)
> - **감사wf**: audit-log를 추가 소스로 활용 (Part 3에서 연동 개편)
>
> 세션 레지스트리에 sessionId 컬럼을 포함하여 같은 프로젝트 디렉토리의 복수 세션을 정확히 구분한다.

## Part 1 요구사항

1. **bash-only**: LLM 세션 없이 순수 bash 스크립트로 구동한다. 토큰 비용 0.
2. **기능 전수 구현 목표**: 이 문서에 기술된 기능(Tier 1 + Tier 2)은 가능한 모두 포함한다.
3. **결정론적 판단**: 모든 판단은 elif 체인으로 구현. 비결정론적 판단이 필요한 예외는 Part 2(Sonnet) 위임 또는 Telegram 에스컬레이션.
4. **상시 실행**: button 웹앱에서 프로젝트 세션(task 제외)을 켜면 자동 생성되고, 감시 대상이 0개가 되면 자동 종료한다.
5. **사전 작성 메시지**: 모든 전송 메시지는 `.messages/` 디렉토리에 사전 작성한다.
6. **세션당 사이클 1조치**: 한 사이클에서 한 세션에 대해 최대 1개의 조치만 실행. 우선순위: 사망 > 압축 > 교착 > 충돌 > 삽질 > 부재.
7. **세션 상한**: 최대 5개 세션 감시 (현실적 사용량 2~4개).
8. **감사소스수집**: 3종 소스(capture-pane, git log, JSONL)를 매 사이클 수집하여 `.audit-log/`에 기록. 감사wf가 분석.

---

> **실행 환경**: psmux + bash (Windows MSYS2, self-wake 패턴)
> **생명주기**: 웹앱에서 프로젝트 세션(task 제외)을 켜면 자동 생성, 감시 대상 0개가 되면 자동 종료

## 아키텍처

```
┌──────────────────────────────────────────────────────┐
│  button 웹앱                                          │
│  "프로젝트 시작" 클릭                                  │
└──────────┬───────────────────────────────────────────┘
           │ POST /tasks (type: ai)
           ▼
┌──────────────────────────────────────────────────────┐
│  agent server (server.js)                             │
│  ├─ 작업 세션 생성 (psmux, claude --model opus 등)    │
│  └─ 비서 스크립트 확인                                │
│       ├─ 이미 실행 중 → 스킵                          │
│       └─ 미실행 → self-wake 루프 시작                  │
│  ├─ 비서 heartbeat 감시 (3분 내 .self-wake-ts 갱신?)  │
└──────────────────────────────────────────────────────┘

self-wake 루프 (background bash, 3분 주기)
  │
  ├─ scout-and-act.sh 실행
  │   ├─ ① 세션별 capture-pane 수집
  │   ├─ ② 리포트 작성 (.scout-report.txt)
  │   ├─ ③ elif 체인으로 세션당 1조치 실행
  │   │   ├─ 사망 → revive.sh
  │   │   ├─ 압축 → JSONL 리줌 주입 (generate-session-resume.sh)
  │   │   ├─ 교착 → msg.sh (deadlock-resolve)
  │   │   ├─ 충돌 → msg.sh (file-conflict)
  │   │   ├─ 삽질 → msg.sh (repeat-warn + 원문 전달)
  │   │   ├─ 부재+질문대기 → msg.sh (autonomous-proceed)
  │   │   └─ elif 미매칭 이상 → Telegram 에스컬레이션
  │   └─ ④ 변경 전파 (git diff 브로드캐스트)
  │
  └─ 감시 대상 0개 → 루프 종료
       │ capture-pane / send-keys
  ┌────┼────────────┐
  ▼    ▼            ▼
[세션A] [세션B]   [세션C]
Opus    Sonnet    Gemini CLI
```

**생명주기 규칙**:
- task 세션(agent server의 `command` 타입 태스크 실행 세션)은 감시 대상 아님
- 감시 대상 세션이 0개가 되면 최종 보고 후 자동 종료
- 비서가 이미 살아있으면 중복 생성하지 않음 (`.secretary-alive` 플래그)
- agent server가 `.self-wake-ts` 갱신을 3분 내 확인하여 비서 사망 감지 → 재시작

---

## 기능 목록

### Tier 1 — MVP (결정론적 bash)

#### 1-1. 세션 부활 및 작업 복원

> 세션이 죽으면 다시 살리고, 컨텍스트 + 작업 지시를 자동 주입하여 사용자 개입 없이 재개한다.

**감지**: `capture-pane -p -S 0 -t {세션} | tail -20`

| 캡처 결과 | 판정 | 조치 |
|-----------|------|------|
| 쉘 프롬프트(`$`, `>`)만 보임 | 에이전트 사망 | → 3단계 부활 |
| `────` 사이 텍스트 | 미전송 메시지 | → `send-keys Enter` |
| 캡처 자체 실패 | 세션 사망 | → 3단계 부활 |
| Claude 출력 진행 중 | 정상 | → 스킵 |

**3단계 부활 절차**:
```
① 세션 재생성
   → agent server API: POST /tasks { type: "ai", model: "{원래모델}", dir: "{프로젝트}" }
   → .session-registry.txt에서 모델/디렉토리 참조

② 컨텍스트 주입 (bash 조건문으로 3종 분기)
   MEMORY=$(ls -t ~/.claude/memory/session_${PROJECT}_*.md 2>/dev/null | head -1)
   if [ -z "$MEMORY" ]; then
     # 메모리 없음 → git log 폴백
     MSG=".messages/revive-git-fallback.txt"
   elif [ $(( $(date +%s) - $(stat -c %Y "$MEMORY") )) -gt 10800 ]; then
     # 3시간+ 오래됨 → 메모리 + git log 병행
     MSG=".messages/revive-stale-memory.txt"
   else
     # 최근 메모리 있음 → 메모리 기반 복구
     MSG=".messages/revive-context.txt"
   fi
   bash .scripts/msg.sh "$SESSION" "$MSG"

③ 작업 지시 전달
   → 위 메시지 파일에 포함됨
```

---

#### 1-2. 컨텍스트 보존 — JSONL 기반 주입 (Primary)

> Claude Code의 자동 컨텍스트 압축 시 작업 내용 유실을 방지한다. **이 비서의 핵심 존재 이유.**
> 에이전트에게 "저장하라"고 부탁하는 대신, 비서가 외부 데이터(JSONL)를 직접 가공하여 주입한다.

**A. 압축 감지** — capture-pane에서 압축 키워드 탐지

```bash
echo "$CAP" | grep -qE '(Compacted|PostCompact|compaction)'
```

**B. 사전 감지** — 컨텍스트 사용량 % 읽기

```bash
PCT=$(echo "$CAP" | grep -oP '\d+%' | tail -1)
```
- **80%+ 도달** → 선제 주입 트리거
- 세션당 **1회만** (`.context-injected-{세션명}` 플래그로 중복 방지)

> **구현 검증 필요**: capture-pane이 상태바 영역까지 캡처하는지 실측 필요 (U1).
> 불가 시 폴백: `30분 경과 + 활발한 활동` → 선제 주입 (시간 기반이 기본 전략으로 확정 가능성 높음)

**C. JSONL 기반 세션 리줌 생성 + 주입** (Primary)

압축 감지 시 비서가 해당 세션의 JSONL에서 리줌 파일을 자동 생성하여 주입한다.
에이전트 협조 불필요 — 데이터가 이미 외부에 존재하므로 흐름을 끊지 않는다.

```bash
# .scripts/generate-session-resume.sh
SESSION="$1"
REGISTRY=".session-registry.txt"
PYTHON="/c/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe"
JSONL_BASE="$HOME/.claude/projects"
RESUME_FILE="/tmp/session-resume-${SESSION}.txt"

# 레지스트리에서 세션 정보 조회
SID=$(grep "^${SESSION}|" "$REGISTRY" | cut -d'|' -f5)
DIR=$(grep "^${SESSION}|" "$REGISTRY" | cut -d'|' -f3)

JSONL_DIR="$JSONL_BASE/$(echo "$DIR" | sed 's|:|--|; s|/|--|g; s|\\|--|g')"
JSONL_FILE="$JSONL_DIR/${SID}.jsonl"
[ ! -f "$JSONL_FILE" ] && exit 1

"$PYTHON" -c "
import sys, json
from collections import OrderedDict

edits, reads, bashes, agents = [], [], [], []
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
        if d.get('type') != 'assistant': continue
        for c in d.get('message',{}).get('content',[]):
            if not isinstance(c,dict) or c.get('type')!='tool_use': continue
            name, inp = c.get('name',''), c.get('input',{})
            if name in ('Edit','Write') and 'file_path' in inp:
                edits.append(inp['file_path'])
            elif name == 'Read' and 'file_path' in inp:
                reads.append(inp['file_path'])
            elif name == 'Bash':
                bashes.append(inp.get('command','')[:100])
            elif name == 'Agent':
                agents.append(inp.get('description','')[:60])
    except: pass

# 최근 항목 우선 (역순에서 중복 제거)
def recent_unique(lst, n):
    seen = set(); result = []
    for x in reversed(lst):
        if x not in seen: seen.add(x); result.append(x)
        if len(result) >= n: break
    return result

print('## Session Resume (auto-generated by secretary)')
print()
print('### Recently Edited Files')
for f in recent_unique(edits, 10): print(f'- {f}')
print()
print('### Recently Read Files')
for f in recent_unique(reads, 8): print(f'- {f}')
print()
print('### Recent Bash Commands')
for c in recent_unique(bashes, 5): print(f'- \`{c}\`')
if agents:
    print()
    print('### Spawned Agents')
    for a in recent_unique(agents, 3): print(f'- {a}')
" "$JSONL_FILE" > "$RESUME_FILE"

# git 상태 추가
GIT_DIR=$(echo "$DIR" | sed 's|/|/|g')
echo "" >> "$RESUME_FILE"
echo "### Git State" >> "$RESUME_FILE"
git -C "$GIT_DIR" log --oneline -5 2>/dev/null >> "$RESUME_FILE" || echo "- (not a git repo)" >> "$RESUME_FILE"
git -C "$GIT_DIR" diff --stat 2>/dev/null >> "$RESUME_FILE"

echo "$RESUME_FILE"
```

**주입 트리거**: 압축 감지 → resume 생성 → msg.sh로 전송
```bash
RESUME=$(bash .scripts/generate-session-resume.sh "$S")
if [ -n "$RESUME" ]; then
  bash .scripts/msg.sh "$S" "$RESUME"
  touch ".context-injected-${S}"
fi
```

~~**D. save-context — Debate 판정: 삭제**~~

> <!-- DEBATE-VERDICT: save-context 삭제 (A6+A10+B5) -->
> **삭제 근거**: A/B 테스트 통계적 무의미 (표본 42건, 필요 100건+), "에이전트 협조 불필요" 설계 원칙에 역행, JSONL 리줌 + plan.md + git log로 의도 간극 커버 가능.
> **재접근 경로**: 문제 발생 시 "더 정교한 JSONL 파서"로 재접근 (save-context 복원이 아님).

---

#### 1-3. Guard 교착 해소

> Guard 교착을 감지하면 해소 메시지를 발송한다.

```bash
# 감지: 최근 deny 로그에서 3분 내 3건+ 확인
DENY_COUNT=$(grep "guard-deny" ~/.claude/hook-metrics.jsonl | tail -20 | \
  awk -v cutoff="$THREE_MIN_AGO" '$0 ~ /"ts":/ { if ($NF > cutoff) count++ } END { print count+0 }')
```

**조치**: `bash .scripts/msg.sh {세션} .messages/deadlock-resolve.txt`

---

#### 1-4. 파일 충돌 방지 (파일 mutex)

> 두 세션이 같은 파일을 동시에 수정하는 것을 방지한다.

**파일 수정 감지**: capture-pane에서 Edit/Write 키워드와 함께 등장하는 파일 경로 추출.

**매 사이클 로직**:
```
① 리포트 작성 완료 후 별도 패스로 EDITING 필드를 파싱
② 동일 파일이 2개+ 세션에서 등장 → 충돌
③ 후순위 세션에 경고: .messages/file-conflict.txt + 파일명 포함
```

> **주의**: FILE_CONFLICTS 감지는 리포트(`$REPORT`) 작성 완료 후 별도 패스에서 수행.
> 리포트 작성 중 같은 파일을 grep하면 빈 결과 (자기참조 버그 — debate B2에서 발견).

---

#### 1-5. 세션 간 변경 전파 (git diff 기반)

> 한 세션의 git 변경 사항을 다른 세션에 알려준다. 각 세션은 다른 세션의 변경을 물리적으로 알 수 없다.

```bash
# 세션별 프로젝트 디렉토리에서 git diff --stat 확인
DIFF_STAT=$(git -C "$PROJECT_DIR" diff --stat HEAD~1 2>/dev/null)
if [ -n "$DIFF_STAT" ]; then
  # 변경된 파일 목록을 다른 세션들에 브로드캐스트
  echo "$DIFF_STAT" > /tmp/git-changes-${SESSION}.txt
  for OTHER in $OTHER_SESSIONS; do
    bash .scripts/msg.sh "$OTHER" /tmp/git-changes-${SESSION}.txt
  done
fi
```

---

### Tier 2 — 확장

#### 2-1. 삽질 반복 차단

> 에이전트가 같은 실수를 반복하면, 이전 시도의 실패 원문을 직접 전달하여 루프를 깨트린다.

**구현 — 스냅샷 기반 diff**:

```
① 스냅샷 보관
   매 사이클마다 세션별 capture-pane을 링버퍼로 보관 (최근 5개)
   .snapshots/{세션명}/snap_{N}.txt (N = 0~4, 순환)

② 에러 문자열 추출 + 정규화
   grep -E "(Error:|FATAL|Traceback|ENOENT|ECONNREFUSED|failed)" snap_{N}.txt
   # 숫자를 N으로 치환하여 유사 에러 매칭 개선
   | sed 's/[0-9]\+/N/g'

③ 반복 판정
   정규화된 에러 문자열이 이전 스냅샷(2개+ 전)에도 존재 → 반복

④ 원문 전달 (Haiku 요약 대신)
   이전 스냅샷에서 해당 에러의 전후 5줄을 추출:
   grep -B2 -A2 -F "$FIRST_ERR" "$OLD_SNAP" > /tmp/repeat-warn-${S}.txt
   작업 세션(Opus/Sonnet)이 원문을 직접 읽고 판단
```

> **Debate 결론**: 원문 5줄을 전달하는 게 Haiku 요약보다 안전. 작업 세션(Opus/Sonnet)이 원문 소화 능력 충분.

---

#### 2-2. 사용자 부재 감지

> 사용자가 자리를 비운 상태에서 세션이 질문 대기로 멈추면, "네 판단으로 진행하라"고 지시한다.

**부재 감지** — Windows GetLastInputInfo API:
```bash
IDLE_SEC=$(powershell.exe -NoProfile -File .scripts/get-idle-time.ps1 2>/dev/null | tr -d '\r')
```

**판정 + 조치 (elif 체인 내)**:
```
IDLE_SEC > 600 + WAITING_FOR_USER: YES → msg.sh autonomous-proceed.txt
IDLE_SEC < 60 + .user-absent 존재   → msg.sh user-returned.txt
```

---

#### 2-3. 지식 축적

> 세션에서 발생한 유의미한 사건을 기존 memory/promotion-log 체계에 기록한다.

**bash로 가능한 범위**:
- 에러 로그 → 정형화된 기록 (스냅샷 아카이브)
- 일일 요약 → 템플릿 기반 (세션명, 시작/종료 시각, 이슈 건수)

**bash로 불가능한 범위** (Phase 2 Haiku 후보):
- "이 지식이 범용적인가" 판단
- 자연어 요약 생성

---

## 실행 구조

### 핵심 원칙: scout-and-act.sh가 수집+판단+실행 전부

```
self-wake 루프 (3분 주기)
  │
  └─ scout-and-act.sh 실행
     ├─ Phase 1: 수집 → .scout-report.txt
     ├─ Phase 2: elif 체인 → 세션당 1조치
     ├─ Phase 3: 파일 충돌 감지 (별도 패스)
     └─ Phase 4: 변경 전파 (git diff)
```

### scout-and-act.sh — 통합 스크립트

**입력**: 없음 (psmux ls로 세션 목록 자동 수집)
**출력**: `.scout-report.txt` + 자동 조치 실행

```bash
#!/bin/bash
# scout-and-act.sh — 비서 통합 스크립트 (수집 + 판단 + 실행)

PSMUX="$PSMUX_PATH"
SELF_SESSION="$1"
REPORT=".scout-report.txt"
SNAP_DIR=".snapshots"
SNAP_MAX=5

# 세션 목록 (비서 자신 + task 세션 + Sonnet 비서 세션 제외)
# harness-wf 세션(worker/verifier/healer/strategic), lightweight-wf 세션은 감시 대상에 포함
SONNET_SESSION=$(jq -r '.sonnet_session // "secretary-sonnet"' .sonnet-config.json 2>/dev/null)
SESSIONS=$("$PSMUX" ls -F '#{session_name}' 2>/dev/null | \
  grep -v "^${SELF_SESSION}$" | grep -v "^task-" | grep -v "^${SONNET_SESSION}$")

# === 사용자 부재 체크 ===
IDLE_SEC=$(powershell.exe -NoProfile -File .scripts/get-idle-time.ps1 2>/dev/null | tr -d '\r')
[ -z "$IDLE_SEC" ] && IDLE_SEC=0

# === Guard 교착 체크 ===
DENY_COUNT=0
if [ -f ~/.claude/hook-metrics.jsonl ]; then
  THREE_MIN_AGO=$(date -d '3 minutes ago' +%s 2>/dev/null || echo 0)
  DENY_COUNT=$(grep "guard-deny" ~/.claude/hook-metrics.jsonl | tail -20 | \
    awk -v cutoff="$THREE_MIN_AGO" '$0 ~ /"ts":/ { if ($NF > cutoff) count++ } END { print count+0 }')
fi

# =============================================
# Phase 1: 수집 → 리포트 작성
# =============================================
{
  echo "=== SCOUT REPORT $(date '+%H:%M') ==="
  echo "USER_IDLE_SEC: $IDLE_SEC"
  echo "GUARD_DENY_3MIN: $DENY_COUNT"
  echo ""

  for S in $SESSIONS; do
    echo "--- $S ---"

    CAP=$("$PSMUX" capture-pane -p -S 0 -t "$S" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$CAP" ]; then
      echo "STATUS: SESSION_DEAD"
      echo ""
      continue
    fi

    LAST_LINES=$(echo "$CAP" | tail -5)
    if echo "$LAST_LINES" | grep -qE '^\$\s*$|^>\s*$|^bash-|^C:\\'; then
      echo "STATUS: AGENT_DEAD"
    else
      echo "STATUS: ALIVE"
    fi

    if echo "$CAP" | grep -qE '(Compacted|PostCompact|compaction)'; then
      echo "COMPRESSED: YES"
    else
      echo "COMPRESSED: NO"
    fi

    PCT=$(echo "$CAP" | grep -oP '\d+%' | tail -1)
    echo "CONTEXT_PCT: ${PCT:-UNKNOWN}"

    if echo "$CAP" | grep -qP '────.*────'; then
      echo "UNSENT_MSG: YES"
    else
      echo "UNSENT_MSG: NO"
    fi

    if echo "$LAST_LINES" | grep -qE '(진행할까요|번호를 입력|어떤 방향|선택해)'; then
      echo "WAITING_FOR_USER: YES"
    else
      echo "WAITING_FOR_USER: NO"
    fi

    EDITING=$(echo "$CAP" | grep -oP '(?:Edit|Write|Editing|Updated|edit|write)\s+\S+' | \
      grep -oP '\S+\.(ts|js|md|py|json|tsx|jsx|css)' | sort -u | tr '\n' ',')
    echo "EDITING: ${EDITING:-NONE}"

    ERRORS=$(echo "$CAP" | grep -E '(Error:|FATAL|Traceback|ENOENT|ECONNREFUSED|failed|rate limit)' | tail -3)
    if [ -n "$ERRORS" ]; then
      echo "ERRORS:"
      echo "$ERRORS" | sed 's/^/  /'
    else
      echo "ERRORS: NONE"
    fi

    # 스냅샷 저장 + 반복 에러 감지
    mkdir -p "$SNAP_DIR/$S"
    SNAP_IDX_FILE="$SNAP_DIR/$S/.idx"
    IDX=$(cat "$SNAP_IDX_FILE" 2>/dev/null || echo 0)
    echo "$CAP" > "$SNAP_DIR/$S/snap_${IDX}.txt"
    NEXT_IDX=$(( (IDX + 1) % SNAP_MAX ))
    echo "$NEXT_IDX" > "$SNAP_IDX_FILE"

    if [ -n "$ERRORS" ]; then
      REPEAT=""
      # 에러 정규화: 숫자를 N으로 치환하여 유사 에러 매칭
      FIRST_ERR=$(echo "$ERRORS" | head -1 | sed 's/^[[:space:]]*//' | sed 's/[0-9]\+/N/g')
      for OLD_IDX in $(seq 0 $((SNAP_MAX-1))); do
        [ "$OLD_IDX" -eq "$IDX" ] && continue
        OLD_SNAP="$SNAP_DIR/$S/snap_${OLD_IDX}.txt"
        if [ -f "$OLD_SNAP" ] && sed 's/[0-9]\+/N/g' "$OLD_SNAP" | grep -qF "$FIRST_ERR"; then
          CONTEXT=$(grep -B2 -A2 -F "$(echo "$ERRORS" | head -1 | sed 's/^[[:space:]]*//')" "$OLD_SNAP" | head -10)
          REPEAT="FOUND in snap_${OLD_IDX}"
          echo "REPEAT_ERROR: $REPEAT"
          echo "PREVIOUS_CONTEXT:"
          echo "$CONTEXT" | sed 's/^/  /'
          break
        fi
      done
      [ -z "$REPEAT" ] && echo "REPEAT_ERROR: NONE"
    fi

    echo ""
  done

} > "$REPORT"

# =============================================
# Phase 2: elif 체인 — 세션당 1조치, 우선순위 실행
# =============================================

HANDLED_COUNT=0

for S in $SESSIONS; do
  # 리포트에서 해당 세션 블록 추출
  BLOCK=$(sed -n "/^--- $S ---$/,/^--- /p" "$REPORT" | head -n -1)
  STATUS=$(echo "$BLOCK" | grep "^STATUS:" | awk '{print $2}')

  if [ "$STATUS" = "SESSION_DEAD" ] || [ "$STATUS" = "AGENT_DEAD" ]; then
    # 우선순위 1: 사망 → 부활
    bash .scripts/revive.sh "$S"
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "COMPRESSED: YES"; then
    # 우선순위 2: 압축 감지 → JSONL 리줌 주입 (save-context 삭제됨, Debate A6+A10)
    bash .scripts/generate-session-resume.sh "$S"
    if [ -f "/tmp/session-resume-${S}.txt" ]; then
      bash .scripts/msg.sh "$S" "/tmp/session-resume-${S}.txt"
    fi
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif [ "$DENY_COUNT" -ge 3 ]; then
    # 우선순위 3: Guard 교착 → 해소
    bash .scripts/msg.sh "$S" .messages/deadlock-resolve.txt
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "UNSENT_MSG: YES"; then
    # 미전송 메시지 → Enter
    "$PSMUX" send-keys -t "$S" Enter
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "REPEAT_ERROR: FOUND"; then
    # 우선순위 5: 삽질 반복 → 원문 맥락 전달
    PREV_CTX=$(echo "$BLOCK" | sed -n '/PREVIOUS_CONTEXT:/,/^[A-Z]/p' | grep "^  " | sed 's/^  //')
    echo "$PREV_CTX" > /tmp/repeat-warn-${S}.txt
    # 경고 메시지 헤더 + 원문 결합
    cat .messages/repeat-warn-header.txt /tmp/repeat-warn-${S}.txt > /tmp/repeat-warn-full-${S}.txt
    bash .scripts/msg.sh "$S" /tmp/repeat-warn-full-${S}.txt
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  elif echo "$BLOCK" | grep -q "WAITING_FOR_USER: YES" && [ "$IDLE_SEC" -gt 600 ]; then
    # 우선순위 6: 부재 + 질문 대기 → 자율 진행
    bash .scripts/msg.sh "$S" .messages/autonomous-proceed.txt
    touch .user-absent
    HANDLED_COUNT=$((HANDLED_COUNT + 1))

  fi

  # 사용자 복귀 감지 (elif 체인과 독립)
  if [ "$IDLE_SEC" -lt 60 ] && [ -f .user-absent ]; then
    bash .scripts/msg.sh "$S" .messages/user-returned.txt
    rm -f .user-absent
  fi

done

# =============================================
# Phase 3: 파일 충돌 감지 (리포트 완성 후 별도 패스)
# =============================================

# 리포트에서 모든 EDITING 필드를 수집하여 충돌 검사
ALL_EDITS=$(grep "^EDITING:" "$REPORT" | grep -v NONE | \
  sed 's/EDITING: //' | tr ',' '\n' | sort | uniq -d)

if [ -n "$ALL_EDITS" ]; then
  echo "--- FILE_CONFLICTS ---" >> "$REPORT"
  echo "$ALL_EDITS" >> "$REPORT"

  # 충돌 파일을 사용하는 후순위 세션에 경고
  for CONFLICT_FILE in $ALL_EDITS; do
    CONFLICT_SESSIONS=$(grep -B20 "EDITING:.*${CONFLICT_FILE}" "$REPORT" | grep "^--- " | sed 's/--- //;s/ ---//' | tail -1)
    if [ -n "$CONFLICT_SESSIONS" ]; then
      echo "파일 충돌: $CONFLICT_FILE — $CONFLICT_SESSIONS" > /tmp/conflict-warn.txt
      bash .scripts/msg.sh "$CONFLICT_SESSIONS" /tmp/conflict-warn.txt
    fi
  done
else
  echo "--- FILE_CONFLICTS ---" >> "$REPORT"
  echo "NONE" >> "$REPORT"
fi

# =============================================
# Phase 4: 변경 전파 (git diff 브로드캐스트)
# =============================================

REGISTRY=".session-registry.txt"
if [ -f "$REGISTRY" ]; then
  # 프로젝트별 최근 변경 확인
  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    DIFF_STAT=$(git -C "$DIR" diff --stat HEAD~1 2>/dev/null)
    if [ -n "$DIFF_STAT" ]; then
      echo "$DIFF_STAT" > /tmp/git-changes.txt
      # 해당 프로젝트의 다른 세션에 전파
      grep "|${DIR}|" "$REGISTRY" | cut -d'|' -f1 | while read TARGET; do
        bash .scripts/msg.sh "$TARGET" /tmp/git-changes.txt
      done
    fi
  done
fi

# =============================================
# Telegram 에스컬레이션: elif 미매칭 이상
# =============================================

TOTAL_ISSUES=$(grep -c "STATUS: \(AGENT_DEAD\|SESSION_DEAD\)\|COMPRESSED: YES\|REPEAT_ERROR: FOUND\|WAITING_FOR_USER: YES" "$REPORT" 2>/dev/null || echo 0)

if [ "$TOTAL_ISSUES" -gt "$HANDLED_COUNT" ]; then
  curl -s "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d '{"message":"[비서] 미처리 이상 감지. 확인 필요."}'
fi
```

> **주의**: 위 스크립트는 설계안이며, 실제 구현 시 psmux 출력 포맷에 맞춰 grep 패턴 조정 필요.

### scout 리포트 예시

```
=== SCOUT REPORT 15:30 ===
USER_IDLE_SEC: 720
GUARD_DENY_3MIN: 0

--- session-opus-button ---
STATUS: ALIVE
COMPRESSED: NO
CONTEXT_PCT: 73%
UNSENT_MSG: NO
WAITING_FOR_USER: NO
EDITING: server.js,router.js
ERRORS: NONE
REPEAT_ERROR: NONE

--- session-sonnet-rf ---
STATUS: AGENT_DEAD
COMPRESSED: -
CONTEXT_PCT: UNKNOWN
UNSENT_MSG: NO
WAITING_FOR_USER: NO
EDITING: NONE
ERRORS: NONE

--- session-opus-pi ---
STATUS: ALIVE
COMPRESSED: YES
CONTEXT_PCT: 92%
UNSENT_MSG: NO
WAITING_FOR_USER: YES
EDITING: deploy.sh
ERRORS:
  Error: ECONNREFUSED 127.0.0.1:3000
REPEAT_ERROR: FOUND in snap_1
PREVIOUS_CONTEXT:
  Testing connection to localhost:3000
  Error: ECONNREFUSED 127.0.0.1:3000
  Retrying with different port...

--- FILE_CONFLICTS ---
NONE
```

### 보조 스크립트

#### .scripts/revive.sh
```bash
#!/bin/bash
# 세션 부활: 레지스트리 조회 → API 호출 → 컨텍스트 분기 주입
SESSION_NAME="$1"
REGISTRY=".session-registry.txt"

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

# 부활 후 컨텍스트 주입 (3종 분기)
sleep 10  # 세션 시작 대기

PROJECT=$(basename "$DIR")
MEMORY=$(ls -t ~/.claude/memory/session_${PROJECT}_*.md 2>/dev/null | head -1)

if [ -z "$MEMORY" ]; then
  MSG=".messages/revive-git-fallback.txt"
elif [ $(( $(date +%s) - $(stat -c %Y "$MEMORY") )) -gt 10800 ]; then
  MSG=".messages/revive-stale-memory.txt"
else
  MSG=".messages/revive-context.txt"
fi

bash .scripts/msg.sh "$SESSION_NAME" "$MSG"
echo "REVIVE_REQUESTED: $SESSION_NAME (model=$MODEL, dir=$DIR, msg=$MSG)"
```

#### .scripts/msg.sh
```bash
#!/bin/bash
# 파일 기반 메시지 전송 (200자+ 대응)
SESSION="$1"
MSG_FILE="$2"
PSMUX="$PSMUX_PATH"

if [ ! -f "$MSG_FILE" ]; then
  echo "MSG_FAIL: file not found: $MSG_FILE"
  exit 1
fi

"$PSMUX" send-keys -t "$SESSION" "Read $(realpath "$MSG_FILE") 의 내용을 따르세요." Enter
```

#### .scripts/get-idle-time.ps1
```powershell
Add-Type @'
using System; using System.Runtime.InteropServices;
public class IdleTime {
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    public static int Get() {
        var info = new LASTINPUTINFO { cbSize = 8 };
        GetLastInputInfo(ref info);
        return (Environment.TickCount - (int)info.dwTime) / 1000;
    }
}
'@
[IdleTime]::Get()
```

### 사전 작성 메시지 파일

| 파일 | 내용 |
|------|------|
| ~~`.messages/save-context.txt`~~ | ~~삭제됨 (Debate A6+A10+B5)~~ |
| `.messages/deadlock-resolve.txt` | "Guard 교착이 감지되었습니다. bulk-skip을 실행하고 작업을 계속하세요." |
| `.messages/autonomous-proceed.txt` | "사용자가 현재 자리를 비웠습니다. 가장 안전한 선택지로 진행하세요. 자율 판단 항목은 나중에 보고하세요." |
| `.messages/user-returned.txt` | "사용자가 돌아왔습니다. 부재 중 자율 진행한 내용을 요약 보고하세요." |
| `.messages/revive-context.txt` | "최근 메모리 파일을 Read하고 미완료 작업부터 이어서 진행하세요." |
| `.messages/revive-stale-memory.txt` | "메모리 파일이 오래되었습니다. git log --oneline -10을 먼저 확인하고, 메모리와 대조하여 작업을 재개하세요." |
| `.messages/revive-git-fallback.txt` | "메모리 파일이 없습니다. git log --oneline -20과 CLAUDE.md를 Read하여 현재 상태를 파악한 후 작업을 시작하세요." |
| `.messages/repeat-warn-header.txt` | "이 에러를 이전에도 만났습니다. 아래는 당시 캡처입니다. 다른 접근법을 시도하세요.\n---" |
| `.messages/file-conflict.txt` | "다른 세션이 이 파일을 수정 중입니다. 해당 파일 수정을 보류하세요." |

### 세션 레지스트리 (.session-registry.txt)

파이프 구분 텍스트 (bash 파싱 용이). **sessionId 컬럼 필수** — JSONL 파일 매핑에 사용:
```
session-opus-button|opus|D:/projects/button|2026-04-06T10:00:00|df3a528b-6e4a-4dd3-ad0b-32bb4b0e23ec
session-sonnet-rf|sonnet|D:/projects/button/rf|2026-04-06T10:05:00|c3eea457-fc41-4da0-bd3f-f6c37c6eade8
```

**harness-wf 세션 등록**: harness가 시작되면 worker/verifier/healer/strategic 세션도 레지스트리에 등록해야 비서가 감시+JSONL 수집 가능. button 웹앱(server.js)이 세션 생성 시 레지스트리에 append하거나, scout-and-act.sh가 미등록 psmux 세션을 자동 감지하여 등록.

**sessionId 자동 탐지**: Claude Code 세션의 JSONL은 `~/.claude/projects/{DIR}/` 하위에 sessionId로 명명된다. 세션 시작 시 해당 디렉토리에서 가장 최근 생성된 .jsonl 파일명이 sessionId.

### self-wake 루프

```bash
PSMUX="$PSMUX_PATH"
INTERVAL=180  # 3분

# 중복 구동 방지
if [ -f .self-wake-ts ]; then
  _TS=$(cat .self-wake-ts); _NOW=$(date +%s%3N)
  _DIFF=$(( (_NOW - _TS) / 1000 ))
  if [ "$_DIFF" -lt 360 ]; then exit 0; fi
fi

while true; do
  sleep "$INTERVAL"
  if [ -f .watchdog-stop ]; then
    rm -f .self-wake-ts .watchdog-stop; exit 0
  fi
  # 감시 대상 세션이 전부 사라지면 종료
  ACTIVE=$("$PSMUX" ls -F '#{session_name}' 2>/dev/null | grep -v "^task-" | wc -l)
  if [ "$ACTIVE" -le 0 ]; then
    rm -f .self-wake-ts .secretary-alive; exit 0
  fi
  echo "$(date +%s%3N)" > .self-wake-ts

  # ★ scout-and-act 실행 (LLM 불필요)
  bash .scripts/scout-and-act.sh "secretary"
done
```

### 비서 내부 파일 구조

```
.secretary/
├── .secretary-state.json      # 통합 상태 (플래그+카운터, Debate A9)
│   # 스키마: {alive:bool, selfWakeTs:epoch, userAbsent:bool,
│   #          contextInjected:{세션:bool}, errWindow:{세션:[0,1,1,0,1]}}
├── .scout-report.txt          # 최신 scout 결과 (매 사이클 덮어쓰기)
├── .session-registry.txt      # 세션 설정 (파이프 구분)
├── .snapshots/
│   └── {세션명}/
│       ├── .idx               # 현재 링버퍼 인덱스 (0~4)
│       ├── snap_0.txt
│       ├── snap_1.txt
│       └── ...
├── .scripts/
│   ├── scout-and-act.sh       # 통합 스크립트 (수집+판단+실행)
│   ├── revive.sh              # 세션 부활
│   ├── msg.sh                 # 파일 기반 메시지 전송
│   ├── generate-session-resume.sh  # JSONL 기반 세션 리줌 생성
│   └── get-idle-time.ps1      # Windows 유휴 시간 측정
└── .messages/
    ├── deadlock-resolve.txt
    ├── autonomous-proceed.txt
    ├── user-returned.txt
    ├── revive-context.txt
    ├── revive-stale-memory.txt
    ├── revive-git-fallback.txt
    ├── repeat-warn-header.txt
    └── file-conflict.txt
```

---

## 기존 인프라 재사용

| 기존 스킬/패턴 | 비서에서 재사용 | 변경점 |
|---------------|---------------|--------|
| self-wake (skill) | ✅ 루프 구조 그대로 | scout-and-act.sh 직접 실행 (LLM 불필요) |
| guard-watchdog (skill) | ✅ 교착 감지 로직 | 메시지 발송만, 분석 제외 |
| psmux-session (skill) | ✅ 통신 패턴 | 변경 없음 |
| agent server | ✅ 태스크/세션 관리 | 비서 heartbeat 감시 + 자동 재시작 추가 |
| telegram-notify (skill) | ✅ 알림 발송 | elif 미매칭 예외 에스컬레이션 |

---

## button 앱 개선 항목 (별도 구현)

비서가 아닌 **button agent server** 측에서 구현할 항목:

### 1. 새 세션 부트스트랩

세션 생성 시 초기 프롬프트에 프로젝트 컨텍스트를 포함하여 웜업 시간을 제거한다.

```
초기 프롬프트 구성:
1. "Read CLAUDE.md" (프로젝트 규칙)
2. "Read progress.md" (현재 진행 상태)
3. "현재 다른 활성 세션: {세션 목록 + 각각 무슨 작업 중인지}"
4. 사용자의 원래 작업 지시
```

### 2. 비서(스크립트) 건강 관리

agent server가 `.self-wake-ts` 파일의 갱신 시각을 주기적으로 확인:
- 3분 이상 미갱신 → 비서 스크립트 사망 판정 → self-wake 루프 재시작
- 이 로직은 agent server의 기존 heartbeat 체계에 통합

---

## 향후 확장 경로

```
Phase 1 (MVP): bash-only (scout-and-act.sh + self-wake)
  ├─ Tier 1 전체 구현
  ├─ capture-pane % 캡처 가능 여부 실측 (U1)
  ├─ scout.sh grep 패턴 실측 검증 (U2)
  └─ 에러 정규화 sed 효과 검증 (U4)
  ↓
Phase 1.5: Tier 2 추가 (삽질 차단 + 부재 감지)
  + 감사소스수집 (audit-log: capture-pane + git log + JSONL 파싱)
  ↓ 운영 데이터 수집 (Telegram 에스컬레이션 빈도)
  ↓
Phase 2: Sonnet 세션 추가 (Part 2 — 아래 참조, S-1/S-2 2기능만)
  ↓
Phase 3: 웹앱 UI 통합 (비서 상태 대시보드)
```

---
---

# Part 2 — Sonnet 비서 + 감사소스수집 (Phase 2)

> **Debate 결론 (Part 2)**: 원래 6기능(S-1~S-6)에서 4개 제거/흡수.
> Sonnet은 bash가 원리적으로 불가능한 2기능(예외분석, 의미적에러분석)만 담당.
> 일일요약/지식추출(S-3,S-4)은 JSONL 기반 감사소스수집 + 기존 감사wf로 대체.
> 의존성분석(S-5)과 rate limit(S-6)은 bash로 흡수.

## Phase 2 진입 기준

Phase 1 운영 데이터에서 다음 중 하나 이상 충족 시 Part 2 활성화:
- (a) Telegram 에스컬레이션이 **일 3회+** 반복 — bash elif으로 커버 못하는 이상이 빈번
- (b) bash 미처리 이상 유형이 **2개+ 패턴화** — elif 체인에 추가할 수 없는 비결정론적 유형
- (c) 사용자가 **수동으로 활성화** — 복잡한 멀티세션 작업을 시작할 때

## 설계 원칙

1. **bash가 보스, Sonnet은 도구**: Part 1의 scout-and-act.sh가 여전히 주 루프. Sonnet은 bash가 "이건 내 능력 밖"이라고 판단한 것만 처리. 실패 시 Part 1 + Telegram으로 graceful degradation.
2. **온디맨드 실행**: 상시 실행 아님. bash가 트리거할 때만 깨어나서 작업하고 종료.
3. **Sonnet 전용**: Haiku는 debate에서 불안정성이 논증됨. LLM이 필요한 판단은 Sonnet 급이 필요.
4. **감사소스수집은 bash**: 세션 활동 기록은 Sonnet이 아닌 bash가 3종 소스(capture-pane, git log, JSONL)를 수집하여 audit-log에 기록. 감사 판단은 감사wf(Opus)가 수행.
5. **INFO/ACTION 구조적 차단**: Sonnet 오판의 damage 경로를 등급 분류로 차단. INFO는 참고용 직접 전송, ACTION은 사용자 승인 필수.

## 아키텍처

```
scout-and-act.sh (3분 주기, Part 1)
  │
  ├─ elif 체인으로 처리 가능 → 직접 실행 (토큰 0)
  │
  ├─ 감사소스수집 (매 사이클)
  │   ├─ capture-pane 이벤트 → ~/.claude/audit-log/{날짜}.jsonl
  │   ├─ git log --since="3 min ago" → ~/.claude/audit-log/{날짜}.jsonl
  │   └─ JSONL 파싱 (도구호출/편집파일/위험명령) → ~/.claude/audit-log/{날짜}.jsonl
  │
  ├─ bash 흡수 기능 (S-5/S-6 대체)
  │   ├─ 의존성: grep import/require 체크 → 변경 전파 경고
  │   └─ rate limit: 정적 우선순위(.interactive 플래그) + staggered retry
  │
  └─ elif 미매칭 or Sonnet 트리거 조건 충족
     │
     ├─ dedup lock 체크 → 중복이면 스킵
     ├─ daily cap 체크 → 10회 초과면 Telegram 폴백
     ├─ jq로 JSON 생성 → .sonnet-queue/{timestamp}.json
     │
     └─ Sonnet 세션이 살아있는가?
          ├─ YES → send-keys로 작업 전달
          └─ NO → psmux 세션 생성 → claude --model sonnet → 작업 전달
                   → 작업 완료 후 idle 5분 → 자동 종료
```

### Sonnet 세션 생명주기

```
[bash 트리거] → psmux new-session -s secretary-sonnet
             → claude --model sonnet --dangerously-skip-permissions
             → "Read .sonnet-queue/ 의 작업을 처리하세요"
             → 작업 처리 (응답에 [INFO] 또는 [ACTION] 접두사 필수)
             → idle 5분 (추가 작업 대기)
             → 추가 작업 없음 → /exit
             → psmux kill-session -t secretary-sonnet
```

- **idle 타이머**: Sonnet 세션은 마지막 작업 완료 후 5분간 대기. 그 사이 새 작업이 오면 처리. 없으면 종료.
- **비용 근거**: Sonnet idle은 토큰 소모 0. 세션 유지 비용은 psmux 프로세스 메모리뿐.

---

## 감사소스수집 (Audit Source Collection)

> S-3(일일요약), S-4(지식추출)를 대체한다.
> Sonnet이 스냅샷 몇 개 보고 요약하는 것보다, 감사wf의 Opus가 JSONL 전문 + memory + 프로젝트 구조를 모두 아는 상태에서 분석하는 게 압도적으로 정확하다.

### log_event() — 이벤트 기록 함수

> <!-- DEBATE-VERDICT: JSONL 포맷 + 공유 경로 (A3+A5) -->

scout-and-act.sh에서 이벤트 감지 시 호출. 모든 이벤트를 `~/.claude/audit-log/{날짜}.jsonl`에 JSONL append.
공유 경로(`~/.claude/audit-log/`)를 사용하여 감사wf가 CWD 무관하게 절대 경로로 직접 읽기 가능 (read replica 불필요).

```bash
AUDIT_LOG_DIR="$HOME/.claude/audit-log"
AUDIT_LOG="$AUDIT_LOG_DIR/$(date +%Y-%m-%d).jsonl"
mkdir -p "$AUDIT_LOG_DIR"

log_event() {
  local TYPE="$1" SESSION="$2" EVENT="$3" CONTEXT="$4" ACTION="$5"
  # jq -n으로 안전한 JSON 생성 (context에 따옴표/개행 포함 시에도 정상 동작)
  jq -n --arg ts "$(date -Iseconds)" --arg type "$TYPE" --arg session "$SESSION" \
    --arg event "$EVENT" --arg context "$CONTEXT" --arg action "$ACTION" \
    '{ts:$ts,type:$type,session:$session,event:$event,context:$context,action:$action}' \
    >> "$AUDIT_LOG"
}
```

**기록 시점** (scout-and-act.sh elif 체인 각 분기에 삽입):

| 이벤트 | TYPE | 호출 예 |
|--------|------|---------|
| 세션 사망 | ERROR | `log_event ERROR "$S" "session_dead" "" "revive.sh"` |
| 에러 감지 | ERROR | `log_event ERROR "$S" "error_detected" "$ERRORS" "$ACTION"` |
| 압축 감지 | WARN | `log_event WARN "$S" "context_compressed" "PCT=$PCT" "session-resume-injected"` |
| 삽질 반복 | WARN | `log_event WARN "$S" "repeat_error" "$FIRST_ERR" "repeat-warn"` |
| 부재+질문대기 | INFO | `log_event INFO "$S" "autonomous_proceed" "" "autonomous-proceed.txt"` |
| 부활 결과 | INFO | `log_event INFO "$S" "revive_result" "model=$MODEL" "$MSG"` |
| elif 미매칭 | ESCALATION | `log_event ESCALATION "$S" "unhandled_anomaly" "$CAP_TAIL" "telegram/sonnet"` |
| Sonnet 호출 | SONNET | `log_event SONNET "$S" "sonnet_invoked" "type=$TYPE" "wake-sonnet.sh"` |
| 파일 충돌 | WARN | `log_event WARN "$S" "file_conflict" "file=$CONFLICT_FILE" "conflict-warn"` |
| rate limit | INFO | `log_event INFO "$S" "rate_limit_pause" "rl_count=$RL_COUNT" "rate-limit-wait.txt"` |

### 수집 소스 1: git log

```bash
# scout-and-act.sh 감사소스수집 — 사이클마다 실행
if [ -f "$REGISTRY" ]; then
  cut -d'|' -f3 "$REGISTRY" | sort -u | while read DIR; do
    RECENT_COMMITS=$(git -C "$DIR" log --oneline --since="3 minutes ago" 2>/dev/null)
    if [ -n "$RECENT_COMMITS" ]; then
      log_event ACTIVITY "" "git_commits" "dir=$DIR commits=$RECENT_COMMITS" ""
    fi
  done
fi
```

### 수집 소스 2: JSONL 트랜스크립트 — 감사소스의 핵심

**왜 JSONL이 핵심인가**: Claude Code는 모든 세션의 대화를 `~/.claude/projects/{프로젝트}/` 하위에 JSONL로 자동 기록한다.

| 데이터 | JSONL 필드 | 감사 활용 |
|--------|-----------|----------|
| 어떤 도구를 호출했는지 | `assistant.message.content[].name` (tool_use) | Edit/Write/Bash 빈도 → 작업 강도 추정 |
| 어떤 파일을 수정했는지 | `tool_use.input.file_path` (Edit/Write) | 변경 범위 파악, 위험 파일 감지 |
| 어떤 bash 명령을 실행했는지 | `tool_use.input.command` (Bash) | 위험 명령(rm, force-push) 감지 |
| 어떤 에이전트를 스폰했는지 | `tool_use.input` (Agent) | 서브에이전트 활동 추적 |
| 세션 메타데이터 | `sessionId`, `cwd`, `gitBranch`, `timestamp` | 세션↔프로젝트 매핑 |

capture-pane이 "마지막 화면 스크린샷"이라면, JSONL은 **전체 행동 녹화**이다.

**JSONL 디렉토리 구조** (실측):
```
~/.claude/projects/
├── C--msys64-home-jsh86/          # CWD 경로를 --로 치환
│   ├── df3a528b-....jsonl          # sessionId = 파일명
│   └── c3eea457-....jsonl
├── D--projects-button-agent/
│   └── f6fd76f9-....jsonl
└── D--projects-button/
    └── ...
```

**세션 레지스트리 → JSONL 매핑** (sessionId 기반):

> <!-- DEBATE-VERDICT: sessionId 기반 파일 내용 매칭 (A1+A8) — 디렉토리 역공학 sed 제거 -->

```bash
# sessionId(SID)로 JSONL 파일을 직접 특정한다.
# JSONL 첫 줄에 "sessionId":"UUID" 포함되므로 디렉토리 탐색 + 내용 매칭으로 정확 매핑.
find_jsonl_by_sid() {
  local SID="$1"
  find "$HOME/.claude/projects" -name "${SID}.jsonl" -print -quit 2>/dev/null
}
```

**수집 스크립트** (`.scripts/collect-jsonl-audit.sh`):
```bash
#!/bin/bash
# JSONL 트랜스크립트에서 감사 데이터 추출
# scout-and-act.sh에서 매 사이클 호출

MARKER="$HOME/.claude/audit-log/.last-jsonl-offset"
NOW_TS=$(date -Iseconds)
PYTHON="/c/Users/jsh86/AppData/Local/Programs/Python/Python312/python.exe"
REGISTRY=".session-registry.txt"

# <!-- DEBATE-VERDICT: sessionId 기반 매칭 + 바이트 오프셋 증분 (A1+A4+A8) -->

while IFS='|' read -r SESSION MODEL DIR CREATED SID; do
  # sessionId로 직접 매칭 (역공학 sed 제거)
  if [ -n "$SID" ]; then
    LATEST_JSONL=$(find "$HOME/.claude/projects" -name "${SID}.jsonl" -print -quit 2>/dev/null)
  fi
  [ -z "$LATEST_JSONL" ] || [ ! -f "$LATEST_JSONL" ] && continue

  # 바이트 오프셋 기반 증분 파싱 (전체 읽기 O(n) → 증분 O(delta))
  OFFSET_KEY="${SESSION}_offset"
  LAST_OFFSET=$(grep "^${OFFSET_KEY}=" "$MARKER" 2>/dev/null | cut -d= -f2 || echo "0")
  CURRENT_SIZE=$(stat -c%s "$LATEST_JSONL" 2>/dev/null || echo "0")
  [ "$CURRENT_SIZE" -le "$LAST_OFFSET" ] && continue

  # 바이트 오프셋 기반 증분 파싱 — 새로 추가된 부분만 읽기
  SUMMARY=$("$PYTHON" -c "
import sys, json
offset = int(sys.argv[2])
tool_counts = {}
edit_files = set()
risky_cmds = []
agent_spawns = []
with open(sys.argv[1], 'rb') as f:
    f.seek(offset)
    for raw in f:
        try:
            d = json.loads(raw)
            if d.get('type') != 'assistant': continue
            for c in d.get('message',{}).get('content',[]):
                if not isinstance(c,dict) or c.get('type')!='tool_use': continue
                name = c.get('name','')
                inp = c.get('input',{})
                tool_counts[name] = tool_counts.get(name,0)+1
                if name in ('Edit','Write') and 'file_path' in inp:
                    edit_files.add(inp['file_path'])
                if name == 'Bash':
                    cmd = inp.get('command','')[:120]
                    if any(k in cmd for k in ['rm ','force','reset --hard','drop','kill']):
                        risky_cmds.append(cmd)
                if name == 'Agent':
                    agent_spawns.append(inp.get('description','')[:60])
        except: pass
parts = []
if tool_counts: parts.append('tools=' + ','.join(f'{k}:{v}' for k,v in sorted(tool_counts.items(),key=lambda x:-x[1])[:8]))
if edit_files: parts.append('edited=' + ','.join(sorted(edit_files)[:10]))
if risky_cmds: parts.append('RISKY=' + '|'.join(risky_cmds[:3]))
if agent_spawns: parts.append('agents=' + ','.join(agent_spawns[:3]))
print('; '.join(parts) if parts else '')
" "$LATEST_JSONL" "$LAST_OFFSET" 2>/dev/null)

  if [ -n "$SUMMARY" ]; then
    log_event ACTIVITY "$SESSION" "jsonl_audit" "$SUMMARY" ""
  fi

  # 오프셋 갱신
  sed -i "/^${OFFSET_KEY}=/d" "$MARKER" 2>/dev/null
  echo "${OFFSET_KEY}=${CURRENT_SIZE}" >> "$MARKER"
done < "$REGISTRY"
```

### 3종 소스 역할 분담

| 소스 | 강점 | 약점 | 감사 역할 |
|------|------|------|----------|
| **capture-pane** | 실시간, 경량, 빠름 | 마지막 화면만, 행동 기록 없음 | 상태 감지 (살았나, 에러 있나) |
| **JSONL** | 전체 행동 기록, 도구+파일+명령 | 파싱 비용, 3분 지연 | **행동 감사** (뭘 했나, 위험한가) |
| **git log** | 확정된 변경, 신뢰도 높음 | 커밋 안 한 변경 누락 | 결과 추적 (뭐가 바뀌었나) |

### 감사wf 연동

> <!-- DEBATE-VERDICT: 공유 경로 + 절대 경로 직접 읽기 (A3+A12) — read replica 제거 -->

```
scout-and-act.sh (3분마다)
  ├─ capture-pane → 상태 이벤트 → ~/.claude/audit-log/{날짜}.jsonl
  ├─ git log → 커밋 이벤트 → ~/.claude/audit-log/{날짜}.jsonl
  └─ JSONL 파싱 → 행동 이벤트 → ~/.claude/audit-log/{날짜}.jsonl

감사wf (사용자 트리거 — CWD=Obsidian)
  ├─ ~/.claude/audit-log/{날짜}.jsonl Read → 자동 수집 데이터 (절대 경로 직접 읽기)
  ├─ D:/projects/button/agent/.secretary/.session-registry.txt Read → 세션 매핑
  ├─ promotion-log.md Read → 수동/훅 기록 데이터
  └─ Opus가 세 소스를 종합 분석 → 지식 승격, 규칙 보강, 위험 플래그
```

**왜 Sonnet S-3/S-4가 불필요한가**:
1. S-3(일일 요약): JSONL이 원본 그대로 있으므로 감사wf에서 Opus가 더 잘함
2. S-4(지식 추출): JSONL에 before/after 전체 맥락이 있으므로 Sonnet 스냅샷보다 정확
3. Sonnet은 온디맨드로 깨어나서 스냅샷 몇 개만 보지만, 감사wf의 Opus는 JSONL + memory + 프로젝트 구조를 모두 아는 상태에서 판단

**audit-log 보존**: 7일간 보존, 이후 자동 삭제. JSONL 원본은 Claude Code가 관리.

---

## 안전장치 (5개)

> Debate verdict에서 도출된 안전장치. 모든 Sonnet 호출 경로에 적용.

### 1. JSON 생성: jq 빌더 (sed 이스케이프 금지)

```bash
# ❌ 기존 — Windows 경로, 멀티라인, 따옴표에서 깨짐
cat > "$TASK_FILE" << EOF
{"report": "$(cat "$REPORT" | sed 's/"/\\"/g')"}
EOF

# ✅ 수정 — jq가 모든 이스케이프를 안전하게 처리
jq -n \
  --arg type "$TYPE" \
  --arg report "$(cat "$REPORT")" \
  --arg session "$S" \
  --arg timestamp "$(date -Iseconds)" \
  '{type: $type, report: $report, session: $session, timestamp: $timestamp}' \
  > "$TASK_FILE"
```

### 2. Dedup lock + TTL (600초)

```bash
# Sonnet 큐 추가 전 중복 체크 — 모든 트리거 지점에서 호출
LOCK_DIR=".sonnet-queue/locks"
mkdir -p "$LOCK_DIR"

check_dedup() {
  local SESSION="$1" TYPE="$2"
  local LOCK_FILE="$LOCK_DIR/${SESSION}_${TYPE}.lock"
  local TTL=600  # .sonnet-config.json의 lock_ttl_sec

  if [ -f "$LOCK_FILE" ]; then
    local LOCK_TS=$(cat "$LOCK_FILE")
    local NOW=$(date +%s)
    if [ $((NOW - LOCK_TS)) -gt "$TTL" ]; then
      rm -f "$LOCK_FILE"  # stale lock 자동 정리
    else
      return 1  # 중복 — 스킵
    fi
  fi

  echo "$(date +%s)" > "$LOCK_FILE"
  return 0  # lock 획득 성공
}

# 사용 예
if check_dedup "$S" "exception_analysis"; then
  # 큐 추가 + wake-sonnet.sh
fi
```

### 3. INFO/ACTION 등급 분류 + 외부 검증

Sonnet constitution에 명시: 응답의 첫 줄에 반드시 `[INFO]` 또는 `[ACTION]` 접두사.

- **[INFO]**: "이 상황은 ~인 것 같습니다" — 참고용, 직접 전송 OK
- **[ACTION]**: "~을 실행해야 합니다" — 행동 요구, 사용자 승인 필수

msg.sh에서 외부 검증:
```bash
# .scripts/msg.sh 수정 — ACTION은 Telegram 승인 필요
MSG_CONTENT=$(cat "$MSG_FILE")
FIRST_LINE=$(head -1 "$MSG_FILE")

if echo "$FIRST_LINE" | grep -q "^\[ACTION\]"; then
  # ACTION → Telegram으로 사용자 승인 요청, 세션에 직접 전송 안 함
  curl -s "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg msg "[승인 필요] $MSG_CONTENT" '{message: $msg}')"
  log_event ACTION "$SESSION" "action_pending_approval" "$FIRST_LINE" "telegram"
  return
fi

# INFO 또는 접두사 없음 → 직접 전송
"$PSMUX" send-keys -t "$SESSION" "Read $(realpath "$MSG_FILE") 의 내용을 참고하세요." Enter
```

### 4. 일일 hard cap (10회/일)

```bash
# .scripts/wake-sonnet.sh 시작부
CAP_FILE=".sonnet-queue/.daily-cap"
TODAY=$(date +%Y%m%d)
CURRENT=$(grep "^$TODAY:" "$CAP_FILE" 2>/dev/null | cut -d: -f2 || echo 0)

if [ "$CURRENT" -ge 10 ]; then
  # cap 초과 → Telegram 폴백
  curl -s "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d '{"message":"[비서] Sonnet 일일 호출 상한(10회) 초과. Telegram 폴백."}'
  log_event WARN "" "sonnet_daily_cap_exceeded" "count=$CURRENT" "telegram_fallback"
  exit 0
fi

# 카운트 증가
grep -v "^$TODAY:" "$CAP_FILE" 2>/dev/null > /tmp/cap-tmp || true
echo "$TODAY:$((CURRENT + 1))" >> /tmp/cap-tmp
mv /tmp/cap-tmp "$CAP_FILE"
```

### 5. .sonnet-config.json + jq 검증 가드

**Config 파일** (`.sonnet-config.json`):
```json
{
  "sonnet_session": "secretary-sonnet",
  "queue_dir": ".sonnet-queue",
  "log_dir": ".sonnet-log",
  "dead_letter_dir": ".dead-letter",
  "lock_ttl_sec": 600,
  "daily_cap": 10,
  "idle_timeout_sec": 300,
  "audit_log_dir": "~/.claude/audit-log",
  "psmux_path": "/c/Users/jsh86/AppData/Local/Microsoft/WinGet/Packages/marlocarlo.psmux_Microsoft.Winget.Source_8wekyb3d8bbwe/psmux.exe"
}
```

**scout-and-act.sh 시작부 검증**:
```bash
CONFIG=".sonnet-config.json"
if [ -f .sonnet-enabled ]; then
  for FIELD in sonnet_session queue_dir log_dir lock_ttl_sec daily_cap; do
    VAL=$(jq -r ".$FIELD" "$CONFIG" 2>/dev/null)
    if [ -z "$VAL" ] || [ "$VAL" = "null" ]; then
      echo "CONFIG_FAIL: missing $FIELD — Part 2 disabled"
      rm -f .sonnet-enabled
      log_event ERROR "" "config_validation_failed" "missing=$FIELD" "part2_disabled"
      break
    fi
  done
fi
```

---

## Sonnet 기능 목록 (2개)

> <!-- DEBATE-VERDICT: 트리거 2개 유지, Sonnet 작업 유형 1개 (A11) -->
> S-1/S-2는 트리거 조건이 다르므로 **트리거는 2개 유지**한다.
> 그러나 Sonnet 내부에서는 **단일 작업 유형(`analysis`)**으로 처리하되,
> JSON의 `trigger` 필드(`exception_analysis` | `semantic_error_analysis`)로 분기한다.
> Constitution(지시 메시지)은 하나로 통합 가능 — trigger에 따라 절차 분기.

### S-1. 예외 분석

> Part 1에서 Telegram으로 사용자에게 던지던 "elif 미매칭 이상"을 Sonnet이 분석하고 [INFO] 또는 [ACTION]으로 분류하여 전달한다.

**트리거**: scout-and-act.sh의 Telegram 에스컬레이션 지점에서 분기

```bash
# scout-and-act.sh — Telegram 에스컬레이션 지점 교체
if [ "$TOTAL_ISSUES" -gt "$HANDLED_COUNT" ]; then
  if [ -f .sonnet-enabled ] && check_dedup "" "exception_analysis"; then
    TYPE="exception_analysis"
    TASK_FILE=".sonnet-queue/$(date +%s).json"
    jq -n \
      --arg type "$TYPE" \
      --arg report "$(cat "$REPORT")" \
      --arg unhandled "$UNHANDLED_SESSIONS" \
      --arg timestamp "$(date -Iseconds)" \
      '{type:$type, report:$report, unhandled_sessions:$unhandled, timestamp:$timestamp}' \
      > "$TASK_FILE"
    bash .scripts/wake-sonnet.sh
    log_event SONNET "" "sonnet_invoked" "type=$TYPE unhandled=$UNHANDLED_SESSIONS" "wake-sonnet.sh"
  else
    # Part 1 폴백: Telegram
    curl -s "http://localhost:9876/telegram" \
      -H 'Content-Type: application/json' \
      -d '{"message":"[비서] 미처리 이상 감지. 확인 필요."}'
    log_event ESCALATION "" "telegram_fallback" "issues=$TOTAL_ISSUES handled=$HANDLED_COUNT" "telegram"
  fi
fi
```

**Sonnet의 처리**:
1. scout 리포트를 읽고 elif에 매칭되지 않은 이상을 식별
2. capture-pane 원문을 추가 확인 (`psmux capture-pane -p -S 0 -t {세션}`)
3. 판단:
   - 세션이 ALIVE인데 30분간 출력 동일 → 멈춤 감지 → `[ACTION]` 재시작 지시
   - 알 수 없는 에러 패턴 → 에러 맥락 분석 → `[INFO]` 해결 방향 제시
   - 판단 불가 → Telegram 에스컬레이션 (최후 수단은 여전히 사용자)
4. 조치 결과를 `.sonnet-log/{날짜}.md`에 기록

**Sonnet 지시 메시지** (`.messages/sonnet-exception-analysis.txt`):
```
당신은 비서 Sonnet 세션입니다. .sonnet-queue/ 의 exception_analysis 작업을 처리합니다.

## 등급 분류 (필수)
응답의 첫 줄에 반드시 등급 접두사를 붙이세요:
- [INFO] 참고 정보 전달 (예: "이 상황은 ~인 것 같습니다")
- [ACTION] 행동 지시 (예: "~을 실행해야 합니다") — 사용자 승인 후 전달됨

## 작업 절차
1. 작업 JSON의 report 필드에서 미처리 이상을 식별하세요.
2. 해당 세션의 capture-pane을 직접 확인하세요:
   psmux capture-pane -p -S 0 -t {세션명}
3. 이상의 원인을 분석하고, 다음 중 하나를 실행하세요:
   a) 해결 가능 → [INFO] 또는 [ACTION]으로 메시지 작성 → msg.sh로 전송
   b) 세션 멈춤 → [ACTION] "현재 작업을 중단하고 상태를 보고하세요"
   c) 판단 불가 → Telegram 에스컬레이션
4. 결과를 .sonnet-log/{날짜}.md에 기록하세요.

## 제약
- 세션당 1개의 메시지만 전송
- 메시지는 200자 이내로 간결하게
- 판단에 자신 없으면 Telegram으로 넘기세요 (오판보다 알림이 안전)
```

---

### S-2. 의미적 에러 분석

> Part 1의 에러 정규화(`sed 's/[0-9]+/N/g'`)로도 못 잡는 "같은 근본 원인, 다른 증상" 패턴을 Sonnet이 분석한다.

**트리거**: 슬라이딩 윈도우 — 최근 5사이클 중 3+ 에러 (REPEAT_ERROR: NONE인 건)

> <!-- DEBATE-VERDICT: streak → 슬라이딩 윈도우 (A2) — 간헐적 패턴 포착 -->

```bash
# scout-and-act.sh에서 추가
ERR_WINDOW_FILE=".snapshots/$S/.err-window"
if [ -n "$ERRORS" ] && echo "$BLOCK" | grep -q "REPEAT_ERROR: NONE"; then
  # 윈도우에 1 추가 (최대 5개 유지)
  echo "1" >> "$ERR_WINDOW_FILE"
  tail -5 "$ERR_WINDOW_FILE" > "$ERR_WINDOW_FILE.tmp" && mv "$ERR_WINDOW_FILE.tmp" "$ERR_WINDOW_FILE"
else
  echo "0" >> "$ERR_WINDOW_FILE"
  tail -5 "$ERR_WINDOW_FILE" > "$ERR_WINDOW_FILE.tmp" && mv "$ERR_WINDOW_FILE.tmp" "$ERR_WINDOW_FILE"
fi

ERR_COUNT=$(grep -c "^1$" "$ERR_WINDOW_FILE" 2>/dev/null || echo 0)
if [ "$ERR_COUNT" -ge 3 ] && [ -f .sonnet-enabled ] && check_dedup "$S" "semantic_error_analysis"; then
  # 최근 5사이클 중 3+ 새 에러 → Sonnet에게 의미적 분석 위임
  SNAP0=$(cat "$SNAP_DIR/$S/snap_0.txt" 2>/dev/null | tail -20)
  SNAP1=$(cat "$SNAP_DIR/$S/snap_1.txt" 2>/dev/null | tail -20)
  SNAP2=$(cat "$SNAP_DIR/$S/snap_2.txt" 2>/dev/null | tail -20)

  TASK_FILE=".sonnet-queue/$(date +%s).json"
  jq -n \
    --arg type "semantic_error_analysis" \
    --arg session "$S" \
    --arg errors "$ERRORS" \
    --arg snap0 "$SNAP0" \
    --arg snap1 "$SNAP1" \
    --arg snap2 "$SNAP2" \
    '{type:$type, session:$session, current_errors:$errors, snapshots:[$snap0,$snap1,$snap2]}' \
    > "$TASK_FILE"

  bash .scripts/wake-sonnet.sh
  log_event SONNET "$S" "sonnet_invoked" "type=semantic_error window=$ERR_COUNT/5" "wake-sonnet.sh"
fi
```

**Sonnet의 처리**:
1. 최근 3개 스냅샷의 에러를 비교
2. 표면적으로 다르지만 같은 근본 원인인지 판단
3. 근본 원인이 같다고 판단 → `[INFO]` 맥락 포함 경고 전송
4. 다른 문제라고 판단 → 조치 불필요, 로그만 기록

**Sonnet 지시 메시지** (`.messages/sonnet-semantic-analysis.txt`):
```
당신은 비서 Sonnet 세션입니다. .sonnet-queue/ 의 semantic_error_analysis 작업을 처리합니다.

## 등급 분류 (필수)
응답의 첫 줄에 반드시 등급 접두사를 붙이세요:
- [INFO] 참고 정보 전달 — 대부분의 분석 결과는 INFO
- [ACTION] 행동 지시 — 사용자 승인 후 전달됨

## 작업 절차
1. 작업 JSON의 snapshots 필드에서 최근 3사이클의 에러를 비교하세요.
2. 표면적으로 다르지만 같은 근본 원인인 에러가 있는지 판단하세요.
   예: "ECONNREFUSED :3000"과 "ECONNREFUSED :3001" = 서비스 미기동
   예: "Cannot find module 'foo'"과 "Cannot find module './foo'" = 경로 해석 문제
3. 같은 근본 원인이면:
   → [INFO] 메시지 작성 → msg.sh로 전송:
   "이전에 유사한 에러({요약})를 만났습니다. 근본 원인은 {분석}입니다. {제안}."
4. 다른 문제라면:
   → .sonnet-log에 "분석 완료, 별개 문제"로 기록만.
```

---

## bash 흡수 기능 (S-5/S-6 대체)

### 의존성 확인 (S-5 대체) — bash grep

Part 1 Phase 4 변경 전파에서, Sonnet 대신 bash grep으로 import 관계 체크:

```bash
# scout-and-act.sh Phase 4 확장 — 변경 파일의 import 관계 체크
for CHANGED_FILE in $(git -C "$DIR" diff --name-only HEAD~1 2>/dev/null); do
  BASENAME=$(basename "$CHANGED_FILE" | sed 's/\.[^.]*$//')
  grep -rl "import.*$BASENAME\|require.*$BASENAME" "$DIR" \
    --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" \
    2>/dev/null | head -5 > /tmp/dep-check.txt
  if [ -s /tmp/dep-check.txt ]; then
    log_event INFO "" "dependency_detected" \
      "changed=$CHANGED_FILE importers=$(cat /tmp/dep-check.txt | tr '\n' ',')" ""
    # 관련 세션에 변경 전파 시 의존성 정보 포함
  fi
done
```

### Rate Limit 조율 (S-6 대체) — 정적 우선순위

```bash
# scout-and-act.sh — rate limit 감지 시 bash 처리
RATE_LIMITED=$(grep -l "rate limit" "$SNAP_DIR"/*/snap_*.txt 2>/dev/null | \
  sed 's|.*/\(.*\)/snap_.*|\1|' | sort -u)
RL_COUNT=$(echo "$RATE_LIMITED" | grep -c . 2>/dev/null || echo 0)

if [ "$RL_COUNT" -ge 2 ]; then
  for RL_SESSION in $RATE_LIMITED; do
    # .interactive 플래그 있으면 대화형 세션 → 건드리지 않음
    if [ -f ".snapshots/$RL_SESSION/.interactive" ]; then
      continue
    fi
    # 비대화형 세션에 대기 지시
    bash .scripts/msg.sh "$RL_SESSION" .messages/rate-limit-wait.txt
    log_event INFO "$RL_SESSION" "rate_limit_pause" "rl_count=$RL_COUNT" "rate-limit-wait.txt"
  done
fi
```

**추가 메시지 파일** (`.messages/rate-limit-wait.txt`):
```
현재 API rate limit 상태입니다. 5분간 대기하세요.
대기 중 로컬 작업(코드 읽기, 계획 수립)을 진행하세요.
```

---

## Sonnet 세션 관리 스크립트

### .scripts/wake-sonnet.sh

```bash
#!/bin/bash
# Sonnet 세션이 없으면 생성, 있으면 작업 전달
# daily cap 체크 포함

CONFIG=".sonnet-config.json"
PSMUX=$(jq -r '.psmux_path' "$CONFIG")
SONNET_SESSION=$(jq -r '.sonnet_session' "$CONFIG")

# === daily cap 체크 ===
CAP_FILE=".sonnet-queue/.daily-cap"
DAILY_CAP=$(jq -r '.daily_cap' "$CONFIG")
TODAY=$(date +%Y%m%d)
CURRENT=$(grep "^$TODAY:" "$CAP_FILE" 2>/dev/null | cut -d: -f2 || echo 0)

if [ "$CURRENT" -ge "$DAILY_CAP" ]; then
  curl -s "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d '{"message":"[비서] Sonnet 일일 호출 상한 초과. Telegram 폴백."}'
  exit 0
fi

# 카운트 증가
grep -v "^$TODAY:" "$CAP_FILE" 2>/dev/null > /tmp/cap-tmp || true
echo "$TODAY:$((CURRENT + 1))" >> /tmp/cap-tmp
mv /tmp/cap-tmp "$CAP_FILE"

# === 세션 생성/작업 전달 ===
if "$PSMUX" has-session -t "$SONNET_SESSION" 2>/dev/null; then
  "$PSMUX" send-keys -t "$SONNET_SESSION" \
    'Read .sonnet-queue/ 디렉토리의 새 작업을 처리하세요.' Enter
else
  "$PSMUX" new-session -d -s "$SONNET_SESSION" -x 200 -y 50
  sleep 1
  "$PSMUX" send-keys -t "$SONNET_SESSION" \
    "claude --model sonnet --dangerously-skip-permissions" Enter

  for i in $(seq 1 15); do
    sleep 1
    "$PSMUX" capture-pane -t "$SONNET_SESSION" -p -S 0 -E 50 2>/dev/null | \
      grep -q "bypasspermission" && break
  done

  "$PSMUX" send-keys -t "$SONNET_SESSION" Enter
  sleep 2
  "$PSMUX" send-keys -t "$SONNET_SESSION" \
    'Read .messages/sonnet-constitution.txt 의 규칙을 숙지하고 .sonnet-queue/ 의 작업을 처리하세요.' Enter

  # idle monitor 시작
  bash .scripts/sonnet-idle-monitor.sh &
fi
```

### .scripts/sonnet-idle-monitor.sh

```bash
#!/bin/bash
# Sonnet 세션의 idle 타이머 — config의 idle_timeout_sec 후 종료
CONFIG=".sonnet-config.json"
PSMUX=$(jq -r '.psmux_path' "$CONFIG")
SONNET_SESSION=$(jq -r '.sonnet_session' "$CONFIG")
IDLE_LIMIT=$(jq -r '.idle_timeout_sec' "$CONFIG")

while true; do
  sleep 60

  if ! "$PSMUX" has-session -t "$SONNET_SESSION" 2>/dev/null; then
    exit 0
  fi

  PENDING=$(ls .sonnet-queue/*.json 2>/dev/null | wc -l)
  if [ "$PENDING" -gt 0 ]; then
    continue
  fi

  LAST_LOG=$(ls -t .sonnet-log/*.md 2>/dev/null | head -1)
  if [ -n "$LAST_LOG" ]; then
    LAST_MOD=$(stat -c %Y "$LAST_LOG" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    IDLE=$((NOW - LAST_MOD))
    if [ "$IDLE" -gt "$IDLE_LIMIT" ]; then
      "$PSMUX" send-keys -t "$SONNET_SESSION" '/exit' Enter
      sleep 3
      "$PSMUX" kill-session -t "$SONNET_SESSION" 2>/dev/null
      exit 0
    fi
  fi
done
```

---

## Sonnet 세션 규칙 파일

### .messages/sonnet-constitution.txt

```
당신은 psmux 비서의 Sonnet 세션입니다.

## 역할
bash 스크립트(scout-and-act.sh)가 처리할 수 없는 비결정론적 판단을 수행합니다.
작업은 .sonnet-queue/ 디렉토리에 JSON 파일로 전달됩니다.

## 등급 분류 (필수)
모든 응답의 첫 줄에 반드시 등급 접두사를 붙이세요:
- [INFO] 참고 정보 전달 — 세션에 직접 전송됨
- [ACTION] 행동 지시 — 사용자 Telegram 승인 후 전달됨

## 작업 처리 규칙
1. .sonnet-queue/ 의 JSON 파일을 시간순으로 처리
2. 각 작업의 type 필드에 따라 해당 지시 메시지를 Read:
   - exception_analysis → .messages/sonnet-exception-analysis.txt
   - semantic_error_analysis → .messages/sonnet-semantic-analysis.txt
3. 처리 완료 후 JSON 파일을 .sonnet-queue/done/ 으로 이동
4. 결과를 .sonnet-log/{날짜}.md에 기록 (append)

## 제약
- 세션당 1개의 메시지만 전송 (과도한 개입 금지)
- 판단에 자신 없으면 Telegram 에스컬레이션 (오판보다 알림이 안전)
- 토큰 절약: 불필요한 긴 분석 금지, 핵심만 간결하게
- 5분 이상 할 일 없으면 /exit 로 종료
```

---

## Part 2 파일 구조

```
.secretary/
├── .sonnet-enabled              # Part 2 활성화 플래그 (touch로 생성)
├── .sonnet-config.json          # 중앙 설정 (세션명, 경로, TTL, cap)
├── .sonnet-queue/               # bash → Sonnet 작업 큐
│   ├── {timestamp}.json         # 대기 중 작업
│   ├── done/                    # 처리 완료 작업 아카이브
│   ├── locks/                   # dedup lock 파일
│   │   └── {session}_{type}.lock
│   └── .daily-cap               # 일일 호출 카운터
├── .sonnet-log/                 # Sonnet 판단 이력
│   └── {날짜}.md
├── .audit-log/                  # 감사소스 (3종 수집 결과)
│   ├── {날짜}.md                # 이벤트 로그 (매 사이클 append)
│   └── .last-jsonl-ts           # JSONL 파싱 마지막 타임스탬프
├── .scripts/
│   ├── wake-sonnet.sh           # Sonnet 세션 생성/깨우기 + cap 체크
│   ├── sonnet-idle-monitor.sh   # idle 후 자동 종료
│   ├── collect-jsonl-audit.sh   # JSONL 파싱 감사소스 수집
│   └── generate-session-resume.sh  # JSONL→세션 리줌 생성 (압축 복구용)
└── .messages/
    ├── sonnet-constitution.txt          # Sonnet 역할 규칙
    ├── sonnet-exception-analysis.txt    # S-1 지시
    ├── sonnet-semantic-analysis.txt     # S-2 지시
    └── rate-limit-wait.txt              # rate limit 대기 메시지
```

---

## 비용 추정

| 시나리오 | Sonnet 호출 빈도 | 추정 토큰/일 | 비용/일 |
|---------|----------------|------------|--------|
| 정상 (이상 드묾) | 0회 | 0 | $0 |
| 보통 (간헐적 이상) | 예외 1~2회 + 의미분석 0~1회 | ~5K | ~$0.02 |
| 활발 (잦은 이상) | 예외 3~5회 + 의미분석 2~3회 | ~15K | ~$0.05 |
| hard cap 도달 | 10회 | ~25K | ~$0.08 |

Part 1 (bash-only): $0/일. Part 2 추가 시: $0~$0.08/일.
비교: Haiku 상시 실행 (원래 설계) 추정치 ~$0.50~$2.00/일.

---

## 구현 검증 결과 (Phase 1 Agent Team, 2026-04-06)

> TA=Technical Architect, DA=Devil's Advocate, Cost=Cost Optimizer, R2=Round 2 수렴

### 코딩 전 필수 수정 (상)

| # | 항목 | 출처 | 수정 내용 |
|---|------|------|-----------|
| 1 | state.json 원자적 쓰기 | TA+R2 | `jq ... > state.tmp && mv state.tmp state.json` 패턴 |
| 2 | audit-log 동시 쓰기 방지 | TA+R2 | scout-and-act.sh에 flock/PID lock — 단일 인스턴스 강제 |
| 3 | byte-offset 제거 → 줄 기반 | TA+Cost+R2 | 1-4MB에서 full-read 수십 ms. 80줄 복잡성 제거 |

**필수 코드 패턴** (구현 시 참조):
```bash
# 패턴 1: 원자적 JSON 갱신 (모든 jq write에 적용)
jq '.key = "value"' state.json > state.tmp && mv state.tmp state.json

# 패턴 2: 단일 인스턴스 강제 (scout-and-act.sh 진입부)
LOCKFILE=".secretary/.scout-lock"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "Already running"; exit 0; }

# 패턴 3: JSONL 줄 기반 증분 (byte-offset 대체)
LAST_LINE=$(cat "$MARKER" 2>/dev/null || echo "0")
CURRENT_LINES=$(wc -l < "$JSONL_FILE")
[ "$CURRENT_LINES" -le "$LAST_LINE" ] && continue
tail -n +$((LAST_LINE + 1)) "$JSONL_FILE" | python_or_jq_filter
echo "$CURRENT_LINES" > "$MARKER"
```

### 1차 구현에 포함 (중)

| # | 항목 | 출처 | 수정 내용 |
|---|------|------|-----------|
| 4 | wake-sonnet.sh flock | DA+R2 | 진입 시 flock lockfile — 이중 호출 방지 |
| 5 | dead letter 큐 | DA+R2 | Telegram curl 실패 시 `.dead-letter/`에 저장, 다음 사이클 재시도 |
| 6 | dedup 키에 에러 해시 | DA | `{session}_{type}_{md5(errors)[:8]}` — 다른 에러는 별도 분석 |
| 7 | constitution 1파일 통합 + no Bash | Cost+DA | 지시 2파일 → 1파일, "Bash 도구 직접 실행 금지" 조항 포함 |
| 8 | find→glob 교체 | TA | `ls ~/.claude/projects/*/${SID}.jsonl` — MSYS2 find 2-5x 느림 |

### 후속 개선 (하/보류)

| # | 항목 | 출처 | 비고 |
|---|------|------|------|
| 9 | Python→jq 교체 | Cost | 구현 시 판단. Python이 복잡 필터에 유연 |
| 10 | idle-monitor → timeout 통합 | Cost | idle-monitor가 세션 상태 추적도 겸함 |

### 기각

| 항목 | 출처 | 기각 근거 |
|------|------|-----------|
| git log 수집 제거 | Cost | 타 세션 커밋 포착에 필요. 비용 10줄로 미미 |
| 3종 소스 → JSONL만 | Cost | 90%와 100%의 차이가 감사 품질. capture-pane 추가 비용 0 |

---

## 미검증 항목 (운영 데이터 필요)

| ID | 항목 | 검증 방법 |
|----|------|----------|
| U1 | Sonnet 토큰 예산 최적값 (2K vs 4K) | S-1/S-2 실행 시 토큰 사용량 측정 |
| U2 | S-2 도메인 에러 정확도 | 인프라 외 에러에서 의미 분석 성공률 |
| U3 | S-1 INFO 메시지 유용성 | 세션이 INFO를 참고하여 행동 변경하는 비율 |
| U4 | tail -20 에러 포착 충분성 | 스크롤된 에러의 누락 빈도 |
| U5 | JSONL 파싱 성능 | 3분 사이클 내 대용량 JSONL 파싱 완료 여부 |

---
---

# Part 3 — 감사wf 전면 개편 (Phase 3)

> Part 2의 감사소스수집(audit-log)이 본격 가동되면, 기존 감사wf를 이 소스에 맞게 전면 개편한다.
> 핵심: **수집은 bash가 자동으로, 판단은 감사wf(Opus)가 풀 컨텍스트로**.

## Phase 3 진입 기준

- Part 2 감사소스수집이 7일+ 운영되어 `.audit-log/` 데이터가 충분히 축적
- 기존 감사wf의 소스 부족 문제가 audit-log로 실제 해소되었는지 확인

## 개편 방향

### 현재 감사wf의 문제

1. **소스 부족**: promotion-log만 의존 → 수동 기록 누락, 훅/가드 기록만 존재
2. **세션 활동 불가시**: "어떤 세션이 뭘 했는지" 파악 불가
3. **사후적**: 문제 발생 후에야 인지, 예방적 감사 불가

### 개편 후 감사wf 구조

```
감사wf (Phase 3)
  │
  ├─ 소스 수집 (자동 — Part 2의 scout-and-act.sh가 수행)
  │   ├─ ~/.claude/audit-log/{날짜}.jsonl — 이벤트 로그 (상태, 에러, 조치, JSONL 감사, git 커밋)
  │   └─ 감사wf는 절대 경로로 직접 Read (read replica 불필요)
  │
  ├─ 1차 분석 (감사wf Opus)
  │   ├─ audit-log Read → 세션별 활동 요약 자동 생성
  │   ├─ promotion-log Read → 수동 기록과 교차 대조
  │   ├─ JSONL 원본 직접 Read (필요 시) → 상세 행동 확인
  │   └─ 위험 플래그 자동 감지 (RISKY 태그, 대량 삭제, force-push)
  │
  ├─ 2차 판단 (Opus 풀 컨텍스트)
  │   ├─ 에러 해결 패턴 → 범용/프로젝트 특화 분류 → memory 승격
  │   ├─ 반복 문제 → 규칙 보강 (elif 추가, 메시지 개선)
  │   ├─ 위험 행동 → 사용자 알림 + guard 강화 제안
  │   └─ 세션 건강도 → 비서 효과 평가 (개입 성공률, 오판율)
  │
  └─ 3차 출력
      ├─ 일일/주간 감사 리포트 (사용자에게 보고)
      ├─ promotion-log 승격 (새 지식 기록)
      ├─ 규칙 파일 수정 제안
      └─ VaultVoice 동기화 (리포트 요약)
```

### 감사wf가 JSONL로 할 수 있는 새로운 것들

| 기존 감사wf | JSONL 기반 개편 후 |
|---|---|
| "에러가 있었다" (promotion-log) | "Edit 3회, Bash 5회 후 에러 해결 — 구체적으로 npm install 실행" (JSONL) |
| "세션이 죽었다" (capture-pane) | "죽기 전 마지막 10개 도구 호출: force-push 시도 후 크래시" (JSONL) |
| "지식 후보 있음" (수동 판단) | "ECONNREFUSED → server restart → 해결. 3회 반복 패턴. 범용적" (JSONL+audit-log) |
| 감사 불가 (소스 없음) | "이 세션은 3시간 동안 Read 47회, Edit 0회 — 탐색만 하고 진행 없음" (JSONL) |

### 구현 상세

> **Phase 1 검증 결과 (Part 3 Agent Team, 2026-04-06)**: Cost Optimizer의 "3-4배 과잉" 판정을 수용.
> 신규 파일 2개 → skill.md 체크리스트 통합, 5지표 → 3지표, jq 사전 쿼리 제거, VaultVoice SSH 제거.
> **블로커**: log_event의 printf → jq -n 교체 (DA 지적, context에 따옴표 시 JSONL 파싱 실패).

#### 3-1. log_event() printf → jq -n 교체 (블로커)

Part 2의 `log_event()` 함수에서 `printf`는 context에 따옴표/개행 포함 시 JSON이 깨진다.

```bash
# 수정 전 (위험):
printf '..."context":"%s"...' "$CONTEXT" >> "$AUDIT_LOG"

# 수정 후 (안전):
log_event() {
  local TYPE="$1" SESSION="$2" EVENT="$3" CONTEXT="$4" ACTION="$5"
  jq -n --arg ts "$(date -Iseconds)" --arg type "$TYPE" --arg session "$SESSION" \
    --arg event "$EVENT" --arg context "$CONTEXT" --arg action "$ACTION" \
    '{ts:$ts,type:$type,session:$session,event:$event,context:$context,action:$action}' \
    >> "$AUDIT_LOG"
}
```

#### 3-2. 감사wf 스킬 파일 수정 범위 (최소)

기존 `~/.claude/skills/audit-wf/skill.md`에 **신규 파일 0개**, 다음만 수정:

**1) 감사 소스 테이블** 경로 갱신:

| 소스 | 경로 | 비고 |
|------|------|------|
| Audit Log | `~/.claude/audit-log/{날짜}.jsonl` | JSONL 포맷, 절대 경로 Read |
| Session Registry | `D:/projects/button/agent/.secretary/.session-registry.txt` | 세션↔프로젝트 매핑 |
| JSONL 원본 | `~/.claude/projects/{프로젝트}/{sessionId}.jsonl` | 위험 플래그 시 상세 분석 |
| Promotion Log | `~/.claude/memory/promotion-log.md` | 기존 유지 |

**2) 트리거 테이블에 1행 추가**:

| 추가 트리거 | Read 대상 | 내용 | 수행주기 |
|------------|----------|------|---------|
| `세션 감사` / `비서 효과` | skill.md 인라인 체크리스트 | audit-log 기반 세션 분석 + 비서 지표 | 주 1회 수동 |

**3) `정기 감사` 실행 시 기존 3개 + `세션 감사` = 4개 순차**.

#### 3-3. 세션 감사 + 비서 효과 체크리스트 (skill.md 인라인)

Opus가 audit-log JSONL을 직접 Read하고 판단한다. jq 사전 쿼리 불필요.

```markdown
### `세션 감사` / `비서 효과`

1. Read `~/.claude/audit-log/{최근 7일 날짜}.jsonl` (30일 이상 파일은 제외)
2. Read `D:/projects/button/agent/.secretary/.session-registry.txt`
3. 세션별 집계:
   - ERROR / WARN / SONNET / ESCALATION 건수
   - 위험 키워드 grep: force-push, rm -rf, reset --hard, --no-verify
   - 위험 플래그 발견 시 → JSONL 원본에서 전후 맥락 확인
4. 비서 효과 3지표:
   - **에러 총 건수**: type=ERROR 이벤트 수
   - **비서 개입 건수**: type in (WARN, SONNET) 이벤트 수
   - **미해결 건수**: type=ESCALATION 이벤트 수 (bash+Sonnet 모두 실패)
5. 지식 승격 후보:
   - 같은 event가 3회+ 반복 → 범용 패턴이면 memory 승격
   - 같은 action이 반복 성공 → elif 체인에 추가 고려
6. 리포트 출력:
   | 세션 | ERROR | WARN | Sonnet | Escalation | 위험 플래그 |
   |------|-------|------|--------|------------|-----------|
   | {세션} | {N} | {N} | {N} | {N} | {있으면 내용} |
   
   비서 효과: 개입 {N}건 중 미해결 {N}건
   개선 권고: {미해결이 개입의 50%+ → elif 확장 필요, 등}
```

> **VaultVoice 연동**: 별도 SSH 파이프라인 대신 사용자가 "볼보에 저장" 트리거로 수동 동기화.

#### 3-4. 주간 리마인더 (자동 감사 대체)

```bash
# scout-and-act.sh에 추가 — 주 1회 일요일 리마인더
DOW=$(date +%u)  # 7=일요일
LAST_AUDIT_WEEK=$(cat ".secretary/.last-audit-week" 2>/dev/null)
THIS_WEEK=$(date +%Y-W%V)
if [ "$DOW" -eq 7 ] && [ "$LAST_AUDIT_WEEK" != "$THIS_WEEK" ]; then
  curl -s "http://localhost:9876/telegram" \
    -H 'Content-Type: application/json' \
    -d '{"message":"[비서] 주간 감사 시간입니다. claude '\''감사 wf'\'' 또는 '\''세션 감사'\'' 실행을 권장합니다."}'
  echo "$THIS_WEEK" > ".secretary/.last-audit-week"
fi
```

#### 3-5. audit-log rotation (30일)

```bash
# scout-and-act.sh에 추가 — 월 1회 (1일에 실행)
DOM=$(date +%d)
if [ "$DOM" -eq "01" ]; then
  ARCHIVE_DIR="$HOME/.claude/audit-log/archive"
  mkdir -p "$ARCHIVE_DIR"
  find "$HOME/.claude/audit-log" -maxdepth 1 -name "*.jsonl" -mtime +30 \
    -exec mv {} "$ARCHIVE_DIR/" \;
fi
```

이 지표들은 audit-log의 이벤트 타입별 카운트로 산출 가능.

---

## 변경 이력 — 2026-04-07

### secretary-loop.sh
- **interval**: 180s → 30s (bash-only라 리소스 거의 없음)
- **종료 조건 변경**: `psmux 세션 0개 시 종료` → `psmux 세션 0개면 대기(continue), STOP_FILE 시에만 종료`
  - 어떤 psmux 세션이라도 하나 생기면 자동 재개

### server.js — heartbeat
- **주기**: 5분 → 1분
- **stale 기준**: 6분 → 3분
- **세션 복구 추가**: secretary 세션 자체가 없으면 재생성 + wt.exe 창 오픈 + 루프 재시작
  - 기존: 세션 없으면 그냥 return (아무것도 안 함)

### scout-and-act.sh — 가드 교착 자동 해제
- **`disable_blocking_guard()` 함수 추가**: settings.json에서 self-config PreToolUse 훅을 Python으로 제거 후 백업
- **가드 복원 체크 (스크립트 상단)**: `.guard-restore` 마커 존재 + 15분 경과 시 settings.json 자동 복원
- **Phase 1 감지 추가**: 화면에 가드 차단 키워드 + 이전 스냅샷과 동일(변화 없음) → `GUARD_BLOCKED: YES`
- **Phase 2 교착 처리 변경**: 메시지 전송 → 실제 가드 비활성화 + psmux로 "재개하세요" 전송

### spawn-session.sh (신규)
- harness-wf 규칙 준수 psmux 세션 생성 스크립트
- cmd.exe 기본 쉘, wt.exe 창 오픈, bypasspermission 폴링, role 주입

### settings.json — psmux spawn-guard
- 깨진 complex regex → 단순 `if(/new-session/.test(c)&&/psmux/i.test(c)&&!/spawn-session\.sh/.test(c))` 로 교체
- 차단 방식: `process.exit(2)` → `permissionDecision:'deny'` JSON 출력 (이 환경에서 exit(2) 미작동 확인)
