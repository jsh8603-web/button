# Secretary.js 기능 명세 + 평가

> secretary.js (1541줄) vs scriptagent.md (1974줄) + plan.md (244줄) 대조 분석
> 분석 일자: 2026-04-08 (2차 갱신)

---

## 사용자용 요약 — 비서 시스템이 뭘 해주는지

비서(secretary.js)는 백그라운드에서 15초마다 돌면서 모든 AI 세션을 감시하고, 문제가 생기면 자동으로 개입하는 프로그램이다. 사용자가 자리를 비워도 AI 세션들이 멈추거나 삽질하지 않게 관리해 준다.

### 감시 기능 (문제 감지)

| 뭘 하는 건지 | 어떤 상황에서 작동하는지 | 뭘 해주는지 |
|---|---|---|
| **세션 상태 추적** | 15초마다 모든 등록된 세션 화면을 캡처 | 각 세션이 "작업 중/대기 중/쉬는 중/에이전트 죽음/세션 사라짐" 5가지 상태 중 어디인지 판별 |
| **멈춤 감지** | 75초(5사이클) 동안 화면이 전혀 안 변하면 | "멈췄다, 다음 단계로 가라"고 알려줌 |
| **삽질 감지** | 같은 파일을 3번 이상 수정하거나, 같은 명령을 3번 반복하거나, 에러가 3번 연속 나면 | 1차: "멈추고 접근 방식 재고해"라고 넛지. 2차(계속 삽질): Opus 분석 세션 띄우거나 Telegram으로 에스컬레이션 |
| **원점 회귀 감지** | 코드를 추가했다 삭제했다 반복해서 실질 변경이 0에 가까우면 | "삽질 중이다, 다른 방법 생각해"라고 알려줌 |
| **세션 사망 감지** | AI 에이전트가 꺼졌거나 세션 자체가 사라지면 | Telegram으로 알려줌 |
| **파일 충돌 감지** | 두 세션이 같은 파일을 동시에 수정하면 | 양쪽 세션 모두에 "누가 같은 파일 수정 중"이라고 경고 |

### 자동 개입 기능 (문제 해결)

| 뭘 하는 건지 | 어떤 상황에서 작동하는지 | 뭘 해주는지 |
|---|---|---|
| **에러 단계별 처리** | 에러 감지 → 반복 → 분석 → 에스컬레이션 순서로 심각도 올림 | 1단계 경고, 2단계 Opus/Sonnet 모델에 따라 자기분석 또는 분석 세션 소환, 3단계 Telegram으로 사용자에게 알림 |
| **Opus 분석 세션** | Sonnet 세션이 같은 에러를 반복할 때 | 별도 Opus 세션을 띄워서 에러 원인 분석 + 해결 방향을 알려주고, 6분 후 자동 종료 |
| **컨텍스트 압축 복원** | AI 세션의 메모리가 가득 차서 자동 압축될 때 | 이전 작업 기록(수정 파일, 에러, 명령어, 마지막 요청 등)을 정리해서 세션에 다시 주입 — 압축 후 방황 방지 |
| **guard 교착 해소** | 보안 규칙(guard)이 세션을 3분 이상 차단해서 작업이 멈추면 | 차단 규칙 임시 해제 → 작업 재개 후 규칙 자동 복원 |
| **솔루션 캐시** | 이전에 해결한 적 있는 에러가 다시 나면 | 에스컬레이션 없이 바로 이전 해결법 전달 |
| **사용자 부재 시 자율 진행** | 사용자가 10분 이상 PC를 안 만지고, AI 세션이 질문 대기 중이면 | "사용자 부재, 자율적으로 진행해"라고 지시 |
| **사용자 복귀 감지** | 부재 상태에서 사용자가 돌아오면 (마우스/키보드 60초 이내) | 세션들에 "사용자 복귀함" 알림 |
| **rate limit 조율** | 2개 이상 세션이 동시에 API 한도에 걸리면 | 작업 중인 세션에 "세션 줄이거나 기다려"라고 알려줌 |

### 관리/기록 기능

| 뭘 하는 건지 | 어떤 상황에서 작동하는지 | 뭘 해주는지 |
|---|---|---|
| **커밋 감지 + 알림** | 세션이 git 커밋을 하면 | 작업 완료 Telegram 알림(사용자 부재 시) + 다른 세션에 변경 사항 공유 + 대형 커밋 시 /simplify 추천 |
| **세션 자동 등록** | 비서가 모르는 새 세션이 생기면 | 자동으로 등록 + 작업 디렉토리와 세션ID 조회 |
| **JSONL 감사** | 5분마다 | 각 세션의 도구 사용 기록, 수정 파일, 위험 명령, 서브에이전트 활동을 감사 로그에 기록 |
| **WF 잔여 정리** | 워크플로우(.wf-active) 파일이 2시간 넘게 방치되면 | 실제 WF 세션이 없으면 파일 자동 삭제 |
| **progress.md 넛지** | plan.md는 있는데 progress.md가 없고 30분 넘게 작업 중이면 | "progress.md 만들어"라고 넛지 |
| **주간 감사 리마인더** | 일요일 오전 9~10시 | Telegram으로 시스템 점검 리마인더 |
| **로그 자동 정리** | 5분마다 | 30일 넘은 감사 로그 자동 삭제 |

---

## 기능 목록 (31개)

### #1: 모듈 골격 (setTimeout 재귀 루프)

- **목적**: setInterval 대신 setTimeout 재귀로 사이클 중첩을 원천 차단. 15s 기본 사이클 + 60s/300s 분기.
- **트리거**: startSecretary() 호출 시 5s 지연 후 첫 사이클, 이후 15s 간격 무한 반복
- **동작**: cycleCount++ → buildReport → per-session 처리 → cross-session → 60s(4배수) → 300s(20배수) → setTimeout(runCycle, 15000)
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 정확히 일치. setTimeout 재귀, 카운터 기반 분기(cycle%4=60s, cycle%20=300s), startSecretary/stopSecretary exports 모두 구현됨.
- **개선 사항**: 없음

---

### #2: capturePane 공유 캐시

- **목적**: RC watchdog, session-HB, secretary가 같은 세션을 반복 캡처하지 않도록 10s TTL 캐시 공유.
- **트리거**: capturePane(sessionName) 호출 시마다
- **동작**: paneCacheMap에서 TTL 내 캐시 히트 → 즉시 반환. 미스 → tmuxRun 실행 후 캐시 저장.
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md의 `paneCacheMap = new Map(), PANE_CACHE_TTL = 10_000` 설계와 동일. assertSafeSession으로 커맨드 인젝션 방지도 추가됨. capturePane 범위가 `-S 0`에서 `-S -200`으로 확대되어 더 넓은 화면 기록을 캡처.
- **개선 사항**: 없음

---

### #3: sendMessage 유틸

- **목적**: 200자+ 메시지를 안전하게 전달. 파일 작성 → `Read {path}` send-keys 패턴.
- **트리거**: 각 개입 기능에서 메시지 전송 시
- **동작**: tmpPath에 메시지 파일 작성 → send-keys `Read {path}` Enter → 5분 후 파일 삭제 (setTimeout)
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치. 파일 삭제가 즉시에서 5분 지연으로 변경 — 에이전트가 바쁠 때 Read가 늦어지는 상황 대응. finally 블록 대신 setTimeout으로 지연 삭제 구현.
- **개선 사항**: 없음

---

### #4: log_event 유틸

- **목적**: 일별 JSONL 감사 로그 기록. 감사wf가 `~/.claude/audit-log/`에서 직접 읽기.
- **트리거**: 모든 이벤트 감지/조치 시점
- **동작**: getLogPath()로 일별 경로 결정 → JSON.stringify + appendFileSync
- **현재 구현 상태**: ✅ 완전
- **평가**: 원본 bash의 `jq -n` 기반 log_event와 동일한 역할. JSON 생성이 JS 네이티브이므로 bash의 "따옴표/개행 깨짐" 문제가 원천 해소됨.
- **개선 사항**: 없음

---

### #5: dedup 유틸

- **목적**: 동일 이벤트 중복 발송 방지. TTL 기반 Map + 영속화.
- **트리거**: 모든 조치 전 dedup(key, ttl) 호출
- **동작**: dedupMap에서 TTL 내 존재 확인 → true(스킵)/false(발사). flushDedupState/loadDedupState로 .secretary-state.json에 영속화.
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md의 `Map<key, timestamp> + TTL 600s + 영속화` 설계와 일치. 300s 사이클에서 1시간 초과 키 GC도 구현됨.
- **개선 사항**: 없음

---

### #6: Screen scraping + report (buildReport)

- **목적**: 등록된 세션들의 capture-pane을 수집하여 STATUS/ERRORS/WAITING/EDITING 파싱.
- **트리거**: 매 15s 사이클 시작 시
- **동작**: getRegisteredSessions() → 각 세션 capturePane(-S -200) → parseStatus/parseErrors/parseWaiting/parseEditing → report 반환. capture 실패 시 `SESSION_DEAD` 반환.
- **현재 구현 상태**: ✅ 완전
- **평가**:
  - parseStatus: 5상태 분류 완전 구현 — `WORKING`(도구 실행 중), `WAITING`(guard 차단/프롬프트), `IDLE`(Claude 프롬프트 대기), `AGENT_DEAD`(쉘 프롬프트만 = Claude 종료), `SESSION_DEAD`(capturePane 실패). bash 원본의 `AGENT_DEAD` vs `SESSION_DEAD` 구분이 정확히 복원됨.
  - 압축 후 DEAD 오탐 방지: `compressedRecentlyMap`으로 auto-compact 직후 5분간 AGENT_DEAD/DEAD를 IDLE로 다운그레이드 — 압축 중간 상태에서 사망 오판 방지.
  - COMPRESSED 감지: `COMPRESSED_RE` 패턴(`Compacted|Auto-compacted`)으로 압축 감지 → #11에서 리줌 주입 연결.
  - parseEditing: `Edit(filepath)` 괄호 형태 정규식으로 Claude Code 실제 출력 패턴 매칭.
  - ERROR_RE: 실제 Claude Code 도구 에러 출력 패턴 (`Exit code`, `tool_use was rejected`, `ENOENT`, `old_string not found`, `Command timed out`) — 코드 내 에러 문자열과 혼동 방지.
  - GUARD_BLOCK_RE: 실제 guard 메시지 패턴으로 교체.
  - UNSENT_MSG(미전송 메시지) 감지: 여전히 미구현.
- **개선 사항**: 미전송 메시지(UNSENT_MSG) 감지 + Enter 전송 로직 추가 고려

---

### #7: Snapshot rotation (5-cycle 링버퍼)

- **목적**: MD5 해시 기반 화면 변화 추적. Stuck 감지, 반복 에러 판정의 기초 데이터.
- **트리거**: 매 사이클 per-session 처리 시 updateSnapshot 호출
- **동작**: MD5 해시 → snapshotMap 링버퍼(5슬롯). isStuck()으로 5슬롯 전부 동일 여부 판정.
- **현재 구현 상태**: ⚠️ 부분
- **평가**: MD5 해시 기반 링버퍼는 구현됨. 그러나 bash 원본은 **전체 캡처 텍스트**를 `.snapshots/{세션}/snap_{N}.txt`에 파일로 저장하여 반복 에러 감지 시 이전 스냅샷의 에러 원문을 추출했음. JS는 해시만 저장하므로 반복 에러의 **원문 맥락 전달**이 불가능.
- **개선 사항**: 해시 외에 최근 5개 스냅샷의 원문 텍스트(또는 에러 부분)도 인메모리 보관하여 repeat-error 원문 전달 가능하게 할 것

---

### #8: 서버 init .guard-restore 체크

- **목적**: guard 임시 해제 후 서버 재시작 시 원래 설정 복원 (보안 회귀 방지).
- **트리거**: startSecretary() 시 1회
- **동작**: .guard-restore 파일 존재 → `permissions.deny`만 복원 → 파일 삭제
- **현재 구현 상태**: ✅ 완전
- **평가**: 이전 리뷰에서 지적된 "settings 전체 덮어쓰기 위험"이 해결됨. 이제 `.guard-restore`에는 `permissions.deny`만 백업하고, 복원 시에도 `permissions.deny`만 패치하여 다른 설정을 건드리지 않음. #22의 guard-restore 백업 방식도 동일하게 수정됨.
- **개선 사항**: 없음

---

### #9: Stuck detection (N-gram)

- **목적**: 5사이클 동안 화면 변화 없음 = 에이전트가 멈춤. 넛지 메시지 전송.
- **트리거**: 매 15s 사이클, per-session
- **동작**: isStuck() → 5슬롯 해시 전부 동일 → dedup 확인 → sendMessage 넛지
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치. dedup key는 `stuck_{session.name}`, 기본 TTL 600s.
- **개선 사항**: 없음

---

### #10: Circular work detection

- **목적**: 코드가 원점 회귀하는 삽질 감지. STUCK과는 다른 패턴 — 화면은 변하지만 net LOC ≈ 0.
- **트리거**: 60s 사이클, per-session
- **동작**: `git diff --shortstat` → insertions/deletions/files 링버퍼(5슬롯) → |totIns - totDel| ≤ 5 AND totFiles ≥ 10 → 넛지
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md의 판정 수치(|ins-del|≤5, files≥10)와 정확히 일치. 60s 사이클 배치도 올바름.
- **개선 사항**: 없음

---

### #11: Context warning + 압축 복원 (핵심 기능)

- **목적**: (A) 컨텍스트 잔량 20% 이하 → memory 저장 알림. (B) 압축 감지 → JSONL 기반 세션 리줌 주입.
- **트리거**: 매 15s 사이클, per-session
- **동작**:
  - (A) `X% until auto-compact` 패턴 → 20% 이하 → 경고 넛지
  - (B) `COMPRESSED_RE` 패턴 감지 → `compressedRecentlyMap`에 5분 보호 등록 → `generateSessionResume()` 호출 → 세션에 리줌 데이터 주입
- **현재 구현 상태**: ✅ 완전
- **평가**: 이전 리뷰에서 "핵심 존재 이유인데 미구현"으로 지적된 JSONL 기반 세션 리줌이 완전 구현됨. `generateSessionResume()` 함수가 7개 데이터 소스(JSONL 파싱, 화면 스냅샷, .wf-active, plan.md/progress.md, execution-log.md, git diff, 활성 세션 목록)를 종합하여 리줌 문서를 생성. bash 원본의 `generate-session-resume.sh` 대비 더 풍부한 데이터 포함(lastAssistant, plan.md 체크박스 진행률, execution-log 등). 압축 후 DEAD 오탐 방지(`compressedRecentlyMap`, 5분 보호)도 통합.
- **개선 사항**: 없음

---

### #12: Memory save validation

- **목적**: 세션이 memory에 파일을 저장했는지 추적. PENDING→DONE 전환.
- **트리거**: 매 15s 사이클, per-session
- **동작**: `Write {*memory/*}` 패턴 감지 → pending Set에 추가 → fs.existsSync로 실제 존재 확인 → 완료 로그
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치. 다만 이 기능의 실질적 가치가 불명확 — pending이 쌓여도 세션에 알림을 보내지 않으며, 로그 기록만 함.
- **개선 사항**: pending이 오래 해소되지 않을 때 넛지 전송 고려

---

### #13: User presence + autonomous proceed

- **목적**: 사용자 10분+ 부재 + 세션이 질문 대기 → "자율적으로 진행하세요" 지시. 사용자 복귀 시 알림.
- **트리거**: 60s 간격 (lastPresenceCheck 기반)
- **동작**: PowerShell GetLastInputInfo API → idleMs > 10분 → WAITING 상태 세션에 넛지. WF 세션(worker/verifier/healer/strategic) 제외.
- **현재 구현 상태**: ✅ 완전
- **평가**:
  - 이전 리뷰에서 지적된 3가지 문제 모두 해결:
  - **(해결)** 대상 조건: `s.status === 'WAITING'`으로 수정됨 — 질문 대기 세션에만 부재 알림 전송.
  - **(해결)** 사용자 복귀 감지: `userAbsentFlag` + idle < 60s → `user_returned` 이벤트 발생 + 세션에 "사용자 복귀함" 알림.
  - **(해결)** WF 세션 제외: `WF_EXCLUDE` 정규식으로 worker/verifier/healer/strategic 세션은 자율 진행 넛지에서 제외 (Supervisor가 관리하므로).
- **개선 사항**: 없음

---

### #14: Rate limit throttling

- **목적**: 2+ 세션이 rate limit에 걸리면 대기 알림.
- **트리거**: 매 15s 사이클, cross-session
- **동작**: `rate limit|429` 패턴 매칭 → 2개+ 세션 해당 → WORKING 세션에 넛지
- **현재 구현 상태**: ✅ 완전
- **평가**: bash 원본의 rate limit 처리와 동등. 추가로 checkEscalation에서 `rate.limit|overloaded` 패턴을 에스컬레이션에서 제외하여 rate limit이 에러 에스컬레이션을 오동작시키지 않음.
- **개선 사항**: 없음

---

### #15: File conflict detection

- **목적**: 두 세션이 같은 파일을 동시에 수정하는 것을 감지하여 경고.
- **트리거**: 매 15s 사이클, cross-session
- **동작**: sessions 이중 루프 → editing 집합 교집합 → 양쪽 세션에 경고
- **현재 구현 상태**: ✅ 완전
- **평가**: 양쪽 세션 모두에 알림을 보내는 점이 bash(후순위 세션만)보다 개선됨.
- **개선 사항**: 없음

---

### #16: Work completion detection

- **목적**: 커밋 완료 + idle + 사용자 부재 → Telegram 알림 (작업 끝남을 사용자에게 알림).
- **트리거**: 60s 사이클, processCommits 내
- **동작**: getLatestCommit(90s 이내) → session.status === 'IDLE' → userAbsent 확인 → Telegram notify
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치. dedup key는 `work_complete_{session.name}`, TTL 30분.
- **개선 사항**: 없음

---

### #17: Simplify reminder

- **목적**: 커밋 diff ≥ 50줄 → /simplify 실행 넛지.
- **트리거**: 60s 사이클, 커밋 감지 시
- **동작**: `git diff HEAD~1 --stat` → insertions + deletions ≥ 50 → sendMessage
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치.
- **개선 사항**: 없음

---

### #18: Git diff broadcast

- **목적**: 커밋 감지 → 다른 세션에 변경 사항 알림. 세션 간 변경 인지.
- **트리거**: 60s 사이클, 커밋 감지 시
- **동작**: `git diff HEAD~1 --stat` → WF/task/secretary 제외한 다른 세션에 sendMessage
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치. 세션 필터링(WF_RE, SKIP_NAME_RE)도 올바름. dedup은 커밋 해시 기반.
- **개선 사항**: 없음

---

### #19: Solution cache

- **목적**: 이전에 해결한 에러 패턴을 캐시하여 재발 시 즉시 힌트 제공.
- **트리거**: startSecretary 시 로드, 300s 사이클 시 리로드, 에러 감지 시 매칭
- **동작**: .error-solutions.json → solutionCache Map. pattern(정규식) → solution 매핑. matchSolution/saveSolutionCache.
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치. 추가로 checkEscalation에서 솔루션 캐시 히트 시 에스컬레이션 자체를 스킵하고 바로 이전 해결법을 전달하여 불필요한 에스컬레이션 방지. S-2 슬라이딩 윈도우 강제 에스컬레이션에서도 캐시 우선 체크.
- **개선 사항**: saveSolutionCache가 호출되는 경로가 없음 — 현재 코드에서는 로드만 하고 새 솔루션을 저장하는 트리거가 없음. escalation 해결 시 자동 저장 연결 필요.

---

### #20: Multi-level error escalation

- **목적**: 에러 감지 → 경고 → 반복 시 분석 → Telegram. 4단계 에스컬레이션 + 모델 기반 분기.
- **트리거**: 60s 사이클, per-session
- **동작**: 선언적 FSM (normal→warned→analyzing→escalated→cooldown→normal). 자동 이벤트 파생(error/same_error/resolved). onEnterState에서 모델 기반 분기.
- **현재 구현 상태**: ✅ 완전
- **평가**:
  - FSM 구조 우수. 3분 최소 체류 시간(dwell time) 구현.
  - **에러 정규화**: `normalizeError()` 함수로 숫자→N, 경로→`/.../` 치환. 같은 에러의 숫자/경로만 다른 변형을 동일 에러로 판정하여 `same_error` 이벤트 정확도 향상.
  - **모델 기반 에스컬레이션**: `onEnterState('analyzing')` 진입 시 레지스트리에서 세션 모델 확인. Opus 세션 → 자기 분석 지시(self-verify). Sonnet 세션 → `spawnOpusAnalyst()` 호출로 별도 Opus 분석 세션 소환.
  - **rate limit 스킵**: `rate.limit|overloaded` 패턴은 에스컬레이션에서 무시.
  - **S-2 슬라이딩 윈도우**: `errWindowMap`으로 5사이클 중 3+에러 축적 시 구조적 문제로 판단 → `same_error`로 강제 에스컬레이션.
- **개선 사항**: 없음

---

### #21: Struggle detection (JS 재구현)

- **목적**: detect-struggle.py를 JS로 재구현. fix-fail loop, bash retry, consecutive errors 3가지 패턴 감지.
- **트리거**: 60s 사이클, processStruggle 내
- **동작**: JSONL 파일에서 최근 500줄 파싱 → 3가지 패턴 판정 → 넛지 + FSM에 에러 피드
- **현재 구현 상태**: ✅ 완전
- **평가**:
  - plan.md의 3가지 판정 조건 정확히 구현됨.
  - **2단계 에스컬레이션**: `struggleCountMap`으로 연속 삽질 사이클 추적. 1차(count=1): 자기 정리 유도 넛지("멈추고 접근 방식 재고해"). 2차(count≥2): `transitionEscalation`으로 모델 기반 에스컬레이션 체인 연결 + `addCycleAlert('struggle')` Telegram 알림.
  - 삽질 해소 시 `struggleCountMap.set(s.name, 0)`으로 카운트 리셋.
- **개선 사항**: 없음

---

### #22: Guard deadlock detection + unlock + 자동 복원

- **목적**: guard 차단으로 세션이 교착 상태에 빠지면 settings.json에서 차단 규칙을 임시 제거. 세션 작업 재개 시 자동 복원.
- **트리거**: 60s 사이클, per-session
- **동작**:
  - 교착 판정: GUARD_BLOCK_RE 패턴 + 3분 이상 지속 → settings.json 수정 → `.guard-restore`에 `permissions.deny`만 백업
  - 자동 복원: 세션이 작업 재개(guard 해소) 감지 시 `.guard-restore`에서 `permissions.deny` 복원 + 백업 파일 삭제
- **현재 구현 상태**: ✅ 완전
- **평가**:
  - 이전 리뷰에서 지적된 **"settings 전체 덮어쓰기 위험"이 해결됨**: `.guard-restore`에 `permissions.deny`만 저장 (`JSON.stringify({ permissions: { deny: ... } })`). 복원 시에도 `permissions.deny`만 패치.
  - **런타임 자동 복원 추가**: 세션이 작업을 재개하면(`isBlocked=false + guardDetectedAt.has(session.name)`) 자동으로 원래 deny 규칙 복원. 서버 재시작 시 #8에서도 동일하게 복원. 이중 복원 경로로 보안 회귀 방지.
  - GUARD_BLOCK_RE: 실제 guard 메시지 패턴으로 교체 (`blocked by.*guard`, `PreToolUse.*denied`, `doesn't want to proceed`, `Do you want to proceed`, `Do you trust`).
- **개선 사항**: 없음

---

### #23: JSONL audit collection

- **목적**: 세션별 JSONL 트랜스크립트에서 도구 호출, 수정 파일, 위험 명령, 에이전트 스폰을 증분 파싱하여 감사 로그에 기록.
- **트리거**: 300s 사이클
- **동작**: collectJsonlAudit() → 등록 세션 SID로 JSONL 탐색 → 줄 기반 증분 파싱 → log_event + 서브에이전트 자동 탐지 + stale 키 정리
- **현재 구현 상태**: ✅ 완전
- **평가**: bash의 collect-jsonl-audit.sh를 JS 네이티브 줄 기반으로 재구현. Agent 결과 추적(tool_use_id → tool 응답 매칭)은 bash 원본에 없던 개선.
- **개선 사항**: 
  - 300s(5분)마다 실행이므로 지연이 큼. 원본 bash는 매 사이클 실행. 60s 사이클로 변경 고려.
  - 전체 파일을 readFileSync로 읽은 뒤 split('\n')하므로 대용량 JSONL에서 메모리 부하. 스트림 기반 또는 바이트 오프셋 방식이 바람직.

---

### #24: Auto-registration

- **목적**: 미등록 psmux 세션을 자동으로 레지스트리에 추가.
- **트리거**: 60s 사이클
- **동작**: tmuxRun list-sessions → WF/task/secretary 제외 → 미등록이면 dir(psmux display-message) + sid(JSONL 스캔) 조회 후 등록
- **현재 구현 상태**: ✅ 완전
- **평가**:
  - 이전 리뷰에서 지적된 문제 모두 해결:
  - **(해결)** btn- 접두사 필터 제거: `WF_SESSION_RE`와 `SKIP_REG_RE`만 사용, 이름 패턴 제한 없음.
  - **(해결)** DIR 조회: `psmux display-message -p "#{pane_current_path}"`로 실제 작업 디렉토리 조회.
  - **(해결)** SID 조회: `~/.claude/projects/` 하위에서 최근 120분 내 수정된 미등록 JSONL 파일을 스캔하여 SID 매칭.
  - 모델 기본값: `strategic` → opus, 그 외 → sonnet.
- **개선 사항**: 없음

---

### #25: WF orphan cleanup

- **목적**: .wf-active가 2시간+ stale이고 WF 세션이 없으면 파일 삭제.
- **트리거**: 300s 사이클
- **동작**: .wf-active 존재 + mtime 2시간+ → list-sessions에서 WF 세션 확인 → 없으면 삭제
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치.
- **개선 사항**: 없음

---

### #26: Promotion-log nudge (4-trigger)

- **목적**: 에러/커밋/WF종료/JSONL 감지 시 promotion-log 기록을 넛지.
- **트리거**: 60s 사이클 (트리거 4만 여기서 처리. 트리거 1은 #20에서, 트리거 2는 processCommits에서, 트리거 3은 #27에서)
- **동작**: 
  - 트리거 4: 금일 audit-log에서 docs Read 1+ 또는 docs Edit 3+ → 넛지
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md의 4개 트리거가 모두 구현됨. 분산 배치가 합리적.
- **개선 사항**: 없음

---

### #27: WF completion → promo-log check

- **목적**: WF 종료 감지 → execution-log 정리 넛지 + promo-log 미갱신 시 넛지.
- **트리거**: 60s 사이클
- **동작**: wfWasActive 플래그 전환 감지 → execution-log 존재 시 정리 넛지 + promo-log mtime 5분+ stale 시 업데이트 넛지
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치.
- **개선 사항**: 없음

---

### #28: Weekly audit + log rotation

- **목적**: 주간 감사 리마인더(일요일 9~10시) + 30일 초과 audit-log 삭제.
- **트리거**: 300s 사이클
- **동작**: runWeeklyAudit(일요일 9~10시 → Telegram) + rotateAuditLogs(30일 초과 삭제)
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치.
- **개선 사항**: 없음

---

### #29: Telegram aggregated alert

- **목적**: 사이클 말미에 중요 이벤트를 통합하여 단일 Telegram 알림으로 전송.
- **트리거**: 60s 사이클 말미
- **동작**: addCycleAlert로 축적 → flushTelegramAgg에서 일괄 전송 (IMPORTANT 세트: escalation_escalated, struggle, guard_deadlock_unlock). SESSION_DEAD/AGENT_DEAD도 addCycleAlert로 축적.
- **현재 구현 상태**: ✅ 완전
- **평가**: plan.md 설계와 일치.
- **개선 사항**: 없음

---

### #30: progress.md 생성 넛지 (신규)

- **목적**: plan.md가 있는데 progress.md가 없는 세션에 생성 넛지.
- **트리거**: 60s 사이클
- **동작**: 등록 세션의 dir에서 plan.md 존재 + progress.md 부재 + 세션 30분+ 경과 → 넛지
- **현재 구현 상태**: ✅ 완전
- **평가**: 전역 규칙("3단계+ 순차 작업 시 progress.md 생성")의 자동 강제. 레지스트리 타임스탬프로 30분 경과 확인. 일 1회 dedup.
- **개선 사항**: 없음

---

### #31: Opus 분석 세션 소환 (spawnOpusAnalyst)

- **목적**: Sonnet 세션이 에러를 반복할 때 별도 Opus 세션을 띄워 에러 원인 분석 + 해결 방향 전달.
- **트리거**: #20 onEnterState('analyzing')에서 Sonnet 세션일 때
- **동작**: `.harness/opus-analyst-role.md`에 분석 태스크 역할 파일 작성 → `spawn-session.sh` 실행으로 Opus 세션 생성 → 6분 후 auto-kill (안전장치). 스폰 실패 시 Telegram 폴백.
- **현재 구현 상태**: ✅ 완전
- **평가**: 역할 파일에 타겟 세션, 에러, 프로젝트 디렉토리, JSONL SID, 실행 순서, 결과 파일 경로, 제약 사항 모두 포함. 분석 전용(코드 직접 수정 금지) 제약 명시. 6분 auto-kill로 리소스 누수 방지.
- **개선 사항**: 없음

---

## 누락 기능 (scriptagent.md에 있지만 secretary.js에 없는 것)

### N-1: 세션 부활 (revive) → 부분 복원

- **원본**: scriptagent.md §1-1. 세션 사망 감지 → 3단계 부활(세션 재생성 → 컨텍스트 분기 주입 → 작업 지시 전달).
- **JS 상태**: 부분 — AGENT_DEAD/SESSION_DEAD 판정은 완전 구현됨(5상태 분류). DEAD 감지 시 Telegram 알림(`addCycleAlert`)과 로그 기록 수행. 그러나 **자동 부활(세션 재생성 + 컨텍스트 주입)** 로직은 없음. server.js heartbeat가 일부 커버.
- **심각도**: 중 — DEAD 감지와 JSONL 리줌 생성(#11)은 갖추었으므로, 부활 시 주입할 데이터는 준비되어 있음. 실제 세션 재생성 + 주입만 연결하면 됨.

### N-3: 미전송 메시지 감지 + Enter 전송

- **원본**: bash Phase 2 elif 체인에서 `UNSENT_MSG: YES` → `send-keys Enter`.
- **JS 상태**: 완전 누락.
- **심각도**: 하 — 실제 발생 빈도가 낮을 수 있음.

### N-4: 삽질 반복 — 원문 맥락 전달

- **원본**: scriptagent.md §2-1. 에러 정규화로 이전 스냅샷과 비교 → 반복 에러 시 원문 전달.
- **JS 상태**: 부분 — normalizeError() 함수로 에러 정규화는 구현됨(숫자→N, 경로 치환). #21 detectStruggle이 JSONL 기반 삽질 감지를 하지만, bash 원본의 "스냅샷 기반 에러 원문 전달" 방식과는 다름. #7 스냅샷이 해시만 보관하므로 원문 전달 불가.
- **심각도**: 하 — normalizeError + JSONL 분석으로 대부분 커버됨.

### N-7: 의존성 감지 (import grep) → 삭제 확정

- **원본**: bash 흡수 기능. git diff 변경 파일의 import 관계 체크.
- **JS 상태**: 완전 누락.
- **심각도**: — (plan.md에서 "삭제 확정"으로 분류됨)

---

## 종합 평가

### 이식률

- **31개 기능 중 28개 완전 구현, 1개 부분 구현(#7 스냅샷 원문), 2개 미구현(N-1 부활, N-3 미전송)**
- 삭제 확정(N-7) 제외
- 완전 이식: 93% (28/30)
- 부분 이식 포함: 97% (29/30)

### 이전 리뷰 대비 해결된 핵심 이슈

| 이전 지적 | 해결 상태 |
|---|---|
| N-2: JSONL 리줌 미구현 (최상 리스크) | ✅ `generateSessionResume()` 7개 소스 통합 구현 |
| #13: User presence 조건 반전 (WORKING→WAITING) | ✅ `s.status === 'WAITING'`으로 수정 |
| #8+#22: guard-restore 전체 덮어쓰기 위험 | ✅ `permissions.deny`만 백업/복원 |
| N-6: 사용자 복귀 감지 미구현 | ✅ `userAbsentFlag` + idle < 60s 구현 |
| #24: btn- 필터 + DIR/SID 없음 | ✅ 필터 제거, display-message + JSONL 스캔 구현 |
| N-5: Sonnet/Opus 세션 관리 부재 | ✅ 모델 기반 분기 + `spawnOpusAnalyst` 구현 |
| N-8: Dead sessions 처리 | ✅ 5상태 분류(SESSION_DEAD/AGENT_DEAD) + Telegram 알림 |

### 신규 추가 기능 (이전 리뷰에 없던 것)

| 기능 | 설명 |
|---|---|
| 압축 후 DEAD 오탐 방지 | `compressedRecentlyMap`, 5분 보호 |
| 에러 정규화 | `normalizeError()` — 숫자/경로 치환으로 같은 에러 변형 매칭 |
| 모델 기반 에스컬레이션 | Opus→self-verify, Sonnet→spawnOpusAnalyst |
| S-2 슬라이딩 윈도우 | 5사이클 3+에러 → 구조적 문제 강제 에스컬레이션 |
| 삽질 2단계 에스컬레이션 | 1차 넛지 → 2차 FSM 연결 |
| guard 런타임 자동 복원 | 세션 작업 재개 시 deny 규칙 실시간 복원 |
| rate limit 스킵 | 에스컬레이션에서 rate limit 에러 제외 |
| solution cache 히트 시 스킵 | 캐시 히트 → 에스컬레이션 없이 바로 전달 |
| progress.md 넛지 | plan.md 존재 + progress.md 부재 + 30분 → 생성 넛지 |
| WF 세션 제외 | 자율 진행 넛지에서 WF 세션 제외 |
| sendMessage 5분 지연 삭제 | 에이전트 처리 지연 대응 |
| 메시지 어조 통일 | [비서] 접두사 제거, 반말 통일 |

### 잔여 리스크 (Top 2)

1. **세션 자동 부활 미구현 (N-1)**: DEAD 감지와 리줌 데이터 생성은 갖추었으나, 실제 세션 재생성 + 리줌 주입을 자동으로 수행하는 연결 경로가 없음. server.js heartbeat가 일부 커버하지만 세밀한 컨텍스트 분기 주입 불가.

2. **saveSolutionCache 미연결 (#19)**: 솔루션 캐시 로드/매칭/저장 함수는 모두 존재하나, 에스컬레이션 해결 후 자동으로 새 솔루션을 저장하는 트리거가 없음. 캐시가 수동 편집에만 의존.

### 우선 개선 항목

| 순서 | 항목 | 난이도 | 영향 |
|------|------|--------|------|
| 1 | N-1: 세션 자동 부활 (DEAD 감지 → 세션 재생성 + 리줌 주입) | 중 (50~80줄) | 상 — 자율 운영 |
| 2 | #19: saveSolutionCache 트리거 연결 | 하 (10줄) | 중 — 캐시 자동 축적 |
| 3 | N-3: 미전송 메시지 Enter 전송 | 하 (10줄) | 하 |

### 전체 소감

secretary.js는 2차 갱신을 거치며 이전 리뷰에서 지적된 7개 핵심 이슈를 모두 해결했다. 특히 **"핵심 존재 이유"인 JSONL 기반 세션 리줌** 완전 구현(7개 데이터 소스 통합), **모델 기반 에스컬레이션** (Opus self-verify + Sonnet→Opus 분석 세션 소환), **guard-restore의 permissions.deny 한정 백업/복원**, **사용자 복귀 감지**가 완성되면서, bash 원본 대비 기능적으로 거의 동등하거나 구조적으로 우수한 수준에 도달했다.

잔여 미구현은 세션 자동 부활(N-1)과 미전송 메시지(N-3) 2건이며, 전자는 DEAD 감지와 리줌 생성이 갖추어져 있어 연결만 하면 되는 상태다. 93% 완전 이식, 97% 부분 이식 포함으로 JS 포팅이 실질적으로 완료된 상태다.
