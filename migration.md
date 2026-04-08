# Plan: Secretary → Server.js 통합

<!-- PRE-FLIGHT: phases=[0.5,1,3,4] skipped=[0a,2] -->
<!-- PHASE-0.5-COMPLETE: 2026-04-08T09:30:00Z -->
<!-- PHASE-1-COMPLETE: 2026-04-08T09:50:00Z -->
<!-- PHASE-3-COMPLETE: 2026-04-08T11:30:00Z -->
<!-- PHASE-4-COMPLETE: 2026-04-08T11:35:00Z -->
<!-- DEBATE-VERDICT: 불필요 (기존 코드 내부 리팩토링, 접근 방식 합의 완료) -->

## 실행 엔진 (확정)

- 1단계 (Phase 1~2, 기반+단순개입 15개): **경량화** ✅ 확정
- 2단계 (Phase 3~4, git+에스컬레이션 7개): **Harness** ✅ 확정
- 3단계 (Phase 5~7, 감사+넛지+정리 7개): **경량화** ✅ 확정
- Supervisor: 이 대화 (Opus) — 3단계 연속 실행

---

## 목표

비서(bash scout-and-act.sh ~1200줄 + 보조 스크립트 6개)를 server.js로 통합.
단일 프로세스에서 모든 세션 관리 → 상태 충돌 제거, 디버깅 일원화.

## 현재 상태

- **완료**: session heartbeat (생사 관리 + protected 기반 복원 + /remote-control)
- **완료**: 비서 revive 로직 제거 (로그 + Telegram 알림만)
- **완료**: .secretary-disabled 플래그 + Stop hook psmux 세션 제외
- **남은 것**: 비서 모니터링 + 개입 기능 → 20개 (6개 삭제 확정)

## 확정된 설계 원칙 (Agent Team 검증 결과)

1. **단일 setTimeout 재귀 + 내부 카운터** (setInterval 금지)
   - 15s: screen scraping, 넛지, 에러 감지
   - cycle % 4 (60s): JSONL 감사, git 연동, struggle 감지
   - cycle % 20 (300s): dedup GC, weekly reminder, 로그 로테이션
2. **capturePane 공유 캐시** (10s TTL) — RC watchdog, session-HB, secretary 공유
3. **핵심 상태 영속화** — dedup lock + escalation level + .guard-restore만 파일. 나머지 인메모리
4. **서버 init 시 .guard-restore 체크 필수** (보안 회귀 방지)
5. **detect-struggle.py → JS 재구현** (Python exec 제거)
6. **반쪽 마이그레이션 규칙**: bash Phase 먼저 비활성화 → Node 활성화 순서 엄수
7. **모듈 구조**: secretary.js 단일 파일 시작 → 500줄 초과 시 분리
8. **레지스트리**: bash 공존 기간 파이프 텍스트 유지 → 완전 제거 후 JSON 전환

## 삭제 확정 피처 (3개)

| 피처 | 근거 |
|------|------|
| 커밋 빈도 모니터링 | 작업 흐름 방해, 탐색/설계 중 오탐 |
| 의존성 감지 (import grep) | 오탐 많고 실질 조치 없음 (log_event만) |
| Weekly audit | 메인 루프 300s 사이클에 if문으로 흡수 (기능 유지, 독립 피처 제거) |

## 복원 피처 (3개, 삭제 목록에서 복원)

| 피처 | 복원 근거 |
|------|----------|
| Circular work 감지 | STUCK(화면 불변)과 다른 패턴 — 코드가 원점 회귀하는 삽질 감지 |
| promotion-log nudge | 사용자 필수 기능 — 에러/커밋/WF종료/JSONL 4개 트리거 |
| git diff 브로드캐스트 | send-keys 주입 = 사용자 입력과 동일 → 다른 세션 인지 가치 |

---

## Phase 1: 기반 인프라 + 화면 수집

| # | 기능 | 비고 |
|---|------|------|
| 1 | **secretary.js 모듈 골격** | setTimeout 재귀 루프, 카운터, exports |
| 2 | **capturePane 공유 캐시** | 10s TTL Map, tmuxRun 래퍼 |
| 3 | **sendMessage 유틸** | msg.sh 대체: 파일 작성 → `Read {path}` send-keys |
| 4 | **log_event 유틸** | JSONL 감사 로그 (일별 로테이션) |
| 5 | **dedup 유틸** | Map<key, timestamp> + TTL 600s + 영속화 (.state.json) |
| 6 | **Screen scraping + report** | capture-pane → STATUS/ERRORS/WAITING/EDITING 파싱 |
| 7 | **Snapshot rotation (5-cycle)** | MD5 해시 기반 progress 추적 (인메모리 링버퍼) |
| 8 | **서버 init .guard-restore 체크** | 시작 시 guard 복원 로직 |

검증: Node report 생성 → bash report와 비교

---

## Phase 2: 단순 개입 (report 기반 → 메시지 전송)

| # | 기능 | 비고 |
|---|------|------|
| 9 | **Stuck detection (N-gram)** | 5-cycle 해시 동일 → 넛지 |
| 10 | **Circular work detection** | 5-cycle net LOC ≈ 0 + 수정 과다 → 삽질 넛지 (STUCK과 별개) |
| 11 | **Context warning (auto-compact)** | remain 1–20% → memory 저장 알림 |
| 12 | **Memory save validation** | PENDING→DONE 전환 (인메모리 Map) |
| 13 | **User presence + autonomous proceed** | PowerShell idle time + 자율 진행 |
| 14 | **Rate limit throttling** | 2+ 세션 rate limit → 대기 알림 |
| 15 | **File conflict detection** | EDITING 집합 교집합 → 경고 |

---

## Phase 3: Git 연동

| # | 기능 | 비고 |
|---|------|------|
| 16 | **Work completion detection** | 커밋 + idle + 부재 → Telegram |
| 17 | **Simplify reminder** | 커밋 diff ≥ 50줄 → simplify 넛지 |
| 18 | **Git diff broadcast** | 커밋 감지 → 다른 세션에 send-keys 주입 (변경 인지) |

---

## Phase 4: 에러 에스컬레이션 체인

| # | 기능 | 비고 |
|---|------|------|
| 19 | **Solution cache** | .error-solutions.json → 인메모리 Map + flush |
| 20 | **Multi-level error escalation** | elif 체인 → cache hit → Opus → Telegram |
| 21 | **Struggle detection (JS 재구현)** | detect-struggle.py → JS (fix-fail + bash retry + consecutive errors) |
| 22 | **Guard deadlock detection + unlock** | settings.json 수정 + 복원, 영속화 |

---

## Phase 5: JSONL 감사 + 자동 등록

| # | 기능 | 비고 |
|---|------|------|
| 23 | **JSONL audit collection** | collect-jsonl-audit → JS 이식 (Python 제거) |
| 24 | **Auto-registration** | 미등록 psmux 세션 자동 등록 |
| 25 | **WF orphan cleanup** | .wf-active stale → 정리 |

---

## Phase 6: 주기적 넛지 + 정리

| # | 기능 | 비고 |
|---|------|------|
| 26 | **Promotion-log nudge (4-trigger)** | 에러/커밋/WF종료/JSONL 감지 → promo-log 기록 넛지 |
| 27 | **WF completion → promo-log check** | WF 종료 감지 → execution-log 삭제 + promo-log 미갱신 시 넛지 |
| 28 | **Weekly audit + log rotation** | 300s 사이클 if문 |
| 29 | **Telegram aggregated alert** | 사이클 말미 통합 알림 |

---

## Phase 7: 정리

| 작업 | 설명 |
|------|------|
| bash 비서 아카이브 | secretary-loop.sh, scout-and-act.sh, 보조 스크립트 |
| secretary heartbeat 제거 | server.js 비서 재생성 코드 삭제 |
| .sonnet-config.json 정리 | 필요 설정 .env 이전 |
| 레지스트리 JSON 전환 | 파이프 텍스트 → Map + JSON dump |
| CLAUDE.md 업데이트 | 비서 → server.js 통합 모니터링 |
| docs/session-lifecycle.md 업데이트 | 최종 아키텍처 |

---

## 구현 상세 (Phase 3 Coder Readiness 보완)

### secretary.js exports
```javascript
// secretary.js
module.exports = { startSecretary, stopSecretary };
// startSecretary(server) — server 인스턴스 받아 capturePane 캐시 공유
// stopSecretary() — clearTimeout + state flush
```

### capturePane 공유 캐시 API
```javascript
const paneCacheMap = new Map(); // key: sessionName, value: {text, ts}
const PANE_CACHE_TTL = 10_000;
async function capturePane(sessionName) {
  const cached = paneCacheMap.get(sessionName);
  if (cached && Date.now() - cached.ts < PANE_CACHE_TTL) return cached.text;
  const text = await tmuxRun(`capture-pane -p -S 0 -t ${sessionName}`);
  paneCacheMap.set(sessionName, { text, ts: Date.now() });
  return text;
}
```

### sendMessage 유틸
```javascript
// msg.sh 대체: 파일 작성 → psmux send-keys "Read {path}"
async function sendMessage(sessionName, message) {
  const tmpPath = path.join(os.tmpdir(), `sec-msg-${sessionName}-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, message);
  await tmuxRun(`send-keys -t ${sessionName} "Read ${tmpPath}" Enter`);
}
```

### Circular work 판정 수치 (bash 원본 기준)
- 5사이클 누적: `git diff --shortstat` → insertions/deletions/files 추적
- 판정: |insertions - deletions| ≤ 5 AND files ≥ 10 → CIRCULAR
- 인메모리 링버퍼 (5-slot)

### detect-struggle.py → JS 판정 조건
| exit code | 유형 | 조건 |
|-----------|------|------|
| 1 | fix-fail loop | Edit(X) → [다른 도구] → Edit(X), 같은 파일 3+ 사이클 |
| 2 | bash retry | 동일 Bash 명령 3+ 연속, 사이에 Edit 없음 |
| 10 | bash failure | Bash exit code ≠ 0 |
| 11 | edit failure | Edit 에러 (not unique / not found) |
| 12 | consecutive errors | 3+ 연속 도구 에러 |
- 윈도우: 최근 10분 (JSONL mtime 10분+ → idle 판정, skip)
- 최대 파싱 줄: window_min × 50

### 에러 에스컬레이션 체인 (4단계)
1. **경고 전송** — 에러 감지 → 해당 세션에 self-verify 메시지
2. **반복 에러** — 다음 사이클 동일 에러 → Opus 큐 분석 요청
3. **Opus 무효** — Opus 분석 후에도 에러 지속 → Telegram 에스컬레이션
4. **Telegram** — 사용자에게 직접 알림

### promotion-log nudge 4개 트리거
| 트리거 | 조건 | dedup key |
|--------|------|-----------|
| 에러 감지 | S-1 elif 미매칭 에러 | `promo_error_remind` (1회/세션) |
| 커밋 직후 | git log --since="3 min" 결과 있음 | `promo_commit_remind` (1회/세션) |
| WF 종료 | .wf-active 소멸 + promo-log 5분+ 미갱신 | `wf_promo_check` (1회) |
| JSONL 분석 | docs Read 1+ 또는 Edit/Write 3+ | `request_remind_{date}` / `pattern_remind_{date}` (1회/일) |

### git diff broadcast
- 커밋 감지된 세션의 `git diff HEAD~1 --stat` 출력
- 다른 btn-* 세션 (WF/task/secretary 제외)에 send-keys 주입
- dedup: 커밋 해시 기반

### 외부 의존성 경로
| 의존성 | 경로/엔드포인트 |
|--------|----------------|
| psmux CLI | `psmux` (PATH에 있음) |
| Telegram | Agent `/telegram` 엔드포인트 (localhost:9876, Bearer AGENT_SECRET) |
| PowerShell idle time | `powershell -C "(Get-Date) - (Get-Process -Id (Get-WmiObject Win32_Process...).CreationDate)"` → 기존 scout-and-act.sh 방식 유지 |
| git CLI | `git -C {dir}` (레지스트리 dir 컬럼) |
| JSONL 파일 | `~/.claude/projects/{encoded-dir}/{sid}.jsonl` |

---

## 리스크 완화 (Agent Team 확정)

| 리스크 | 완화책 |
|--------|--------|
| setInterval 중첩 | setTimeout 재귀 (확정) |
| capture-pane 동시성 | 공유 캐시 10s TTL (확정) |
| 에스컬레이션 상태 손실 | 핵심 3가지 파일 영속화 (확정) |
| guard 영구 비활성화 | 서버 init 체크 (확정) |
| 반쪽 마이그레이션 중복 | bash 먼저 비활성화 순서 (확정) |
| Python exec 병목 | JS 재구현 (확정) |
| server.js 비대화 | secretary.js 모듈 분리 (확정) |

## 예상

- 피처 수: 23개 (26 원본 - 3 삭제)
- secretary.js: 850~950줄
- 마이그레이션 순서: Phase 1→2→3→4→5→6→7
