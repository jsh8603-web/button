# 비서 → 에이전트 메시지 카탈로그

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
