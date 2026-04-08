# Progress — Secretary → Server.js 통합

## 1단계: Phase 1~2 (경량화) — 기반 인프라 + 단순 개입

### Phase 1: 기반 인프라 + 화면 수집 ✅
- [x] #1 secretary.js 모듈 골격 (setTimeout 재귀 루프, 카운터, exports)
- [x] #2 capturePane 공유 캐시 (10s TTL Map, tmuxRun 래퍼)
- [x] #3 sendMessage 유틸 (msg.sh 대체: 파일 작성 → Read send-keys)
- [x] #4 log_event 유틸 (JSONL 감사 로그, 일별 로테이션)
- [x] #5 dedup 유틸 (Map + TTL 600s + .state.json 영속화)
- [x] #6 Screen scraping + report (capture-pane → STATUS/ERRORS/WAITING/EDITING 파싱)
- [x] #7 Snapshot rotation (5-cycle MD5 해시 링버퍼)
- [x] #8 서버 init .guard-restore 체크

### Phase 2: 단순 개입 (report 기반 → 메시지 전송) ✅
- [x] #9 Stuck detection (N-gram, 5-cycle 해시 동일 → 넛지)
- [x] #10 Circular work detection (net LOC ≈ 0 + 수정 과다 → 삽질 넛지)
- [x] #11 Context warning (auto-compact, remain 1-20% → memory 저장 알림)
- [x] #12 Memory save validation (PENDING→DONE 전환, 인메모리 Map)
- [x] #13 User presence + autonomous proceed (PowerShell idle time)
- [x] #14 Rate limit throttling (2+ 세션 rate limit → 대기 알림)
- [x] #15 File conflict detection (EDITING 집합 교집합 → 경고)

## 2단계: Phase 3~4 (Harness) — Git 연동 + 에스컬레이션 ✅
- [x] #16 Work completion detection (커밋 + idle + 부재 → Telegram)
- [x] #17 Simplify reminder (커밋 diff ≥ 50줄 → simplify 넛지)
- [x] #18 Git diff broadcast (커밋 → 다른 세션 send-keys 주입)
- [x] #19 Solution cache (.error-solutions.json → 인메모리 Map + flush)
- [x] #20 Multi-level error escalation (FSM 상태머신, SR directive 채택)
- [x] #21 Struggle detection JS 재구현 (detect-struggle.py → JS, Healer 수정 1건)
- [x] #22 Guard deadlock detection + unlock (settings.json 수정 + 복원)

## 3단계: Phase 5~7 (경량화) — 감사 + 넛지 + 정리 ✅
- [x] #23 JSONL audit collection (JS-native 파서, 증분 오프셋, 서브에이전트 스캔)
- [x] #24 Auto-registration (btn-* 미등록 세션 자동 등록, 60s 사이클)
- [x] #25 WF orphan cleanup (.wf-active 2h+ stale → 삭제, 300s 사이클)
- [x] #26 Promotion-log nudge (4-trigger: 에러/커밋/WF종료/docs)
- [x] #27 WF completion → promo-log check (wfWasActive 플래그)
- [x] #28 Weekly audit + log rotation (일요일 리마인더 + 30일 로테이션)
- [x] #29 Telegram aggregated alert (60s 사이클 말미 통합 알림)
- [x] Phase 7: server.js 주석 처리 + SIGTERM 핸들러 + CLAUDE.md 갱신
