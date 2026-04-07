# 비서 → 에이전트 메시지 카탈로그

---

## 전역 Hook/Guard 다이어트 결정 (2026-04-07 논의)

기존 전역 settings.json 훅/가드를 scriptagent 메시지로 대체하는 방향으로 결정.

### 결정 원칙

1. **scriptagent 메시지로 대체**: 사용자 말로 인식 → 준수율 높고 작업 차단 없음
2. **가드 유지 조건**: ① 행동 전에 막아야 하고 ② scriptagent이 사전 감지 불가인 경우만
3. **문서**: 전역 자동 로드 최소화 → on-demand 포인터만 CLAUDE.md에
4. **다른 에이전트는 시스템 존재를 모름**: scriptagent만 알면 됨

---

### 각 Hook/Guard 결정 상세

#### PreToolUse

| ID | 기능 | 결정 | 이유 |
|----|------|------|------|
| `safe.rm-block` | `rm -rf /~` 차단 | **KEEP** | 복구 불가, scriptagent 사전 감지 불가 |
| `research.scrape-block` | Playwright 스크래핑 감지 → Gemini 안내 (inject) | **REMOVE** | 차단 아님, scriptagent JSONL로 대체 가능 |
| `pending-promotion 가드` | 미완료 항목 있으면 거의 모든 도구 차단 | **REMOVE** | 가장 방해됨. scriptagent이 이벤트 감지 후 "promotion-log.md 기록해줘" 메시지로 대체. 작성 규칙은 promotion-log.md 내부에 |
| `research.block` | WebSearch/WebFetch 완전 차단 → Gemini 강제 | **KEEP** | 환경에서 실제 불가, 비용 발생, 에러 메시지에 대안 명시 |
| `remote.plan-block` | psmux에서 EnterPlanMode 차단 | **KEEP** | GUI 렌더링 불가, 실행 시 세션 교착, scriptagent 사전 감지 불가 |
| `remote.ask-block` | psmux에서 AskUserQuestion 차단 | **KEEP** | 동일: 사용자가 질문 못 보면 세션 교착 |
| `psmux.spawn-guard` | psmux new-session 직접 호출 차단 | **KEEP** | spawn-session.sh 강제 (역할 주입/레지스트리 누락 방지) |

#### PostToolUse

| ID | 기능 | 결정 | 이유 |
|----|------|------|------|
| `bash-post` | Bash 후 시그널 수집 | **REMOVE** | pending 체인 소비처 없어짐, scriptagent JSONL로 감지 |
| `request` | Read 후 시그널 수집 | **REMOVE** | 동일 |
| `output` | Write/Edit 후 코드품질·cv·changelog inject | **REMOVE** | 매 Edit마다 발동, 가장 무거운 hook. scriptagent 대체 가능 |
| `unlock` | Edit 후 pending 플래그 삭제 | **REMOVE** | pending 가드 제거하면 불필요 |
| `knowledge` | WebSearch 후 시그널 수집 | **REMOVE** | research.block으로 WebSearch 차단되어 실질 발동 없음 |
| `agent-review` | Agent 결과 파싱 inject | **REMOVE** | pending 체인 일부, 10초 timeout 부담 |

#### 기타

| ID | 기능 | 결정 | 이유 |
|----|------|------|------|
| `UserPromptSubmit inject` | 매 메시지마다 pending 체크리스트 표시 | **REMOVE** | 가장 빈번, pending 가드 제거하면 불필요 |
| `PostToolUseFailure error` | 도구 실패 시 시그널 수집 | **REMOVE** | pending 체인 일부 |
| `perm-allow` (PermissionRequest) | 모든 도구 권한 자동승인 | **KEEP** | 차단이 아닌 허용, 편의 기능 |
| `remote.detect` (SessionStart) | PSMUX_TARGET_SESSION → .remote-session | **KEEP** | remote 가드들이 이 플래그 의존 |
| SessionStart progress.md 감지 | .progress-detected 플래그 | **REMOVE** | progress.md 훅 체계 제거 시 불필요 |
| SessionStart signal-orphan | 이전 시그널 체크 | **REMOVE** | 시그널 체계 제거 |
| SessionStart 플래그 삭제 | 세션 시작 시 플래그 일괄 삭제 | **슬림화** | 유지 항목 관련 플래그만 남김 |
| PostCompact resume 주입 | 압축 후 generate-session-resume.sh | **KEEP** | psmux 세션 체크 추가 완료 (false positive 수정) |
| PostCompact compact-restore | progress.md 관련 | **REMOVE** | progress.md 체계 제거 |
| `sys.tts-notify` (Stop) | 작업 완료 TTS | **KEEP** | 사용자 편의, 부작용 없음 |
| `analyze` (Stop) | 세션 종료 시 git diff/log 아카이브 | **KEEP** | 감사 wf 활용, 조용히 실행 |

---

### progress.md / pipeline 훅 결정 (확정)

**기존 기능 → 전부 REMOVE**:
- `pipe.progress-inject`: progress.md 생성 시 작업 지침 inject
- `pipe.issue-gate`: 미완료 항목 있으면 타 파일 수정 차단
- `pipe.session-start`: 세션 시작 시 progress.md 복원 안내
- `pipe.post-compact`: 압축 후 progress.md 복원 강제
- `pipe.checklist-prior`: 에러 있는데 체크리스트 없으면 경고
- `pipe.changelog-guard`: 규칙/코드 수정 후 change-log 미기록 시 차단

**결정**:
- progress.md 개념 유지. 훅/가드 없이 아래 두 가지로 대체
- pipe.issue-gate 등 하드 블록 전부 제거

#### 대체 메커니즘

**1. CLAUDE.md 규칙 (생성 안내)**:
- "3단계+ 순차 작업 시 첫 수정 전 plan.md + progress.md 생성"
- 형식 인라인: `# 작업명 / ## Phase 진행 (체크리스트) / ## 이슈 목록`
- 에이전트가 사용자 말로 인식 → 자발적 생성

**2. scriptagent 감지 (생성 넛지, 세션당 1회)**:
- 트리거: `plan.md 존재 + progress.md 없음`
  - plan.md 생성 = 에이전트가 이미 다단계 작업이라 판단한 증거
- 전송 메시지: `"plan.md 작성한 거 봤어. progress.md도 같은 위치에 만들어줘. 형식: # 작업명 / ## Phase 진행 (체크리스트) / ## 이슈 목록"`
- `check_dedup "$S" "progress_missing"` 으로 1회만 전송
- 구현 위치: scout-and-act.sh Phase 3 (파일 충돌 감지 블록 근처)

**3. generate-session-resume.sh 확장 (압축 후 복원)**:
- 압축 후 resume 생성 시 progress.md 미완료 항목(`- [ ]`) 포함
- `pipe.post-compact` 없어도 압축 후 에이전트가 남은 작업 파악 가능

---

### 문서 변경 계획

| 문서 | 변경 |
|------|------|
| `CLAUDE.md` | "file-standards.md 자동 로드" 언급 제거, on-demand 포인터로 |
| `rules/file-standards.md` | frontmatter `load/always` → `load/on-demand` |
| `rules/remote-session.md` | 동일, on-demand 전환 |
| `promotion-log.md` | 파일 상단에 작성 템플릿 직접 추가 (inject hook 제거 보완) |

---

### 이미 완료된 수정

| 커밋/변경 | 내용 |
|-----------|------|
| `2bfa902` | IDLE_PROMPT `^[>❯]\s*$` 수정 (STUCK 오탐 방지) |
| `796fca4` | COMPRESSED 오탐 수정 (라인 시작 앵커) |
| settings.json PostCompact | `PSMUX_TARGET_SESSION` 체크 추가 (resume 오탐 방지) |

---


비서 스크립트(scout-and-act.sh)가 에이전트 세션에 전송하는 모든 메시지 목록.

---

## msg.sh — 메시지 전송 도구

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

"$PSMUX" send-keys -t "$SESSION" "Read $(realpath "$MSG_FILE") 의 내용을 참고하세요." Enter
```

---

## 메시지 트리거 전체 표

| 트리거 조건 | 파일 | 설명 |
|-------------|------|------|
| 세션 사망 + 메모리 없음 | `revive-git-fallback.txt` | git log 기반 복구 |
| 세션 사망 + 메모리 3시간+ 경과 | `revive-stale-memory.txt` | 메모리 + git 병행 복구 |
| 세션 사망 + 최신 메모리 있음 | `revive-context.txt` | 메모리 기반 복구 |
| 압축 후 컨텍스트 주입 | `/tmp/session-resume-{S}.txt` | generate-session-resume.sh 생성 파일 |
| Guard 교착 (GUARD_BLOCKED / DENY+STUCK) | `deadlock-resolve.txt` | bulk-skip 지시 |
| 파일 충돌 (2개+ 세션 동일 파일 편집) | `file-conflict.txt` | 해당 파일 수정 보류 요청 |
| git 변경 발생 (타 세션 브로드캐스트) | `/tmp/git-changes.txt` | diff --stat 전달 |
| 같은 에러 반복 | `repeat-warn-header.txt` + 원문 | 이전 실패 캡처 전달 |
| Rate limit 감지 | `rate-limit-wait.txt` | 5분 대기 + 로컬 작업 안내 |
| 사용자 부재 + WAITING_FOR_USER 600초+ | `autonomous-proceed.txt` | 자율 진행 지시 |
| 사용자 복귀 (.user-absent 존재 + 60초 미만) | `user-returned.txt` | 복귀 보고 요청 |
| STUCK 감지 + .sonnet-enabled | wake-sonnet.sh 큐 → Sonnet S-1 분석 | Sonnet이 화면 확인 후 넛지 |
| 반복 에러 5사이클 3+ + .sonnet-enabled | wake-sonnet.sh 큐 → Opus S-2 분석 | Opus가 근본 원인 분석 |
| Opus 막힘 감지 | `self-verify-opus.txt` | 스스로 constitution 읽고 처리 |

---

## 세션 부활 컨텍스트 주입

### 컨텍스트 분기 (3종)

```bash
MEMORY=$(ls -t ~/.claude/memory/session_${PROJECT}_*.md 2>/dev/null | head -1)
if [ -z "$MEMORY" ]; then
  MSG=".messages/revive-git-fallback.txt"
elif [ $(( $(date +%s) - $(stat -c %Y "$MEMORY") )) -gt 10800 ]; then
  MSG=".messages/revive-stale-memory.txt"
else
  MSG=".messages/revive-context.txt"
fi
bash .scripts/msg.sh "$SESSION" "$MSG"
```

### 압축 후 JSONL 기반 리줌 주입

PostCompact hook → `generate-session-resume.sh` 실행 → msg.sh로 전송.

```bash
# 트리거 (PostCompact hook 또는 scout 압축 감지)
RESUME=$(bash .scripts/generate-session-resume.sh "$S")
if [ -n "$RESUME" ]; then
  bash .scripts/msg.sh "$S" "$RESUME"
  touch ".context-injected-${S}"
fi
```

generate-session-resume.sh는 JSONL 없어도 화면+git+psmux 최소 리줌을 생성한다.

---

## 메시지 파일 현행 내용 (.messages/)

### revive-context.txt
```
최근 메모리 파일 Read하고 미완료 작업부터 이어서 해줘.
```

### revive-stale-memory.txt
```
메모리 파일이 오래됐어. git log --oneline -10 먼저 확인하고, 메모리랑 대조해서 작업 재개해.
```

### revive-git-fallback.txt
```
메모리 파일이 없어. git log --oneline -20이랑 CLAUDE.md 읽어서 현재 상태 파악하고 작업 시작해.
```

### deadlock-resolve.txt
```
Guard 교착 걸렸어. bulk-skip 실행하고 작업 계속해.
```

### file-conflict.txt
```
다른 세션이 이 파일 수정 중이야. 해당 파일 수정 잠깐 보류해.
```

### repeat-warn-header.txt
```
이 에러 전에도 만났어. 아래는 그때 캡처야. 다른 접근으로 해봐.
---
```

### rate-limit-wait.txt
```
지금 API rate limit 걸린 상태야. 5분 기다려.
대기 중에 로컬 작업(코드 읽기, 계획 수립)해.
```

### autonomous-proceed.txt
```
나 잠깐 자리 비웠어. 제일 안전한 선택지로 계속 진행해. 자율 판단한 것들은 나중에 보고해줘.
```

### user-returned.txt
```
나 돌아왔어. 자리 비운 동안 자율 진행한 내용 요약해서 보고해줘.
```

### self-verify-opus.txt
```
지금 막히는 부분이 감지됐어. ~/.claude/agent/.secretary/.messages/opus-constitution.txt 읽고 아래 절차대로 직접 처리해.

## 절차
1. 현재 에러/막힌 지점 파악
2. 관련 파일 Read
3. Specialist 라우팅 (의무 — 반드시 호출):
   auth/sql/xss/sanitize  → security-reviewer Agent
   복잡도/함수3개+         → quality-reviewer Agent
   N+1/캐시/async과다      → performance-reviewer Agent
   조건 2개+              → 병렬 호출
   ※ "직접 판단" 없음 — 반드시 specialist 거쳐서 검증
4. Specialist 결과 바탕으로 직접 수정
5. 수정 후 작업 재개
```

---

## Sonnet / Opus 세션 지시 메시지 (constitution)

실제 파일: `agent/.secretary/.messages/`

| 파일 | 용도 |
|------|------|
| `sonnet-constitution.txt` | Sonnet triage 세션 역할 + S-1/S-3 작업 절차 |
| `opus-constitution.txt` | Opus 심층 분석 세션 역할 + S-2 작업 절차 + Specialist 라우팅 |

**Sonnet이 받는 트리거 메시지** (wake-sonnet.sh가 `.sonnet-queue/` JSON 파일로 전달):
```json
// S-1: exception_analysis
{ "type": "exception_analysis", "report": "...", "unhandled_sessions": "...", "timestamp": "..." }

// S-3: guard_unlock_analysis
{ "type": "guard_unlock_analysis", "session": "...", "context": { "deny_count": 5 }, "timestamp": "..." }
```

**Opus가 받는 트리거 메시지** (`.opus-queue/` JSON 파일):
```json
// S-2: semantic_error_analysis
{ "type": "semantic_error_analysis", "session": "...", "current_errors": "...", "snapshots": [...], "jsonl_path": "..." }
```

constitution 파일 전체 내용 → 해당 `.messages/*.txt` 직접 참조.
