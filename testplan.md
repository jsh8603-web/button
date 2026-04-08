# Button 프로젝트 스트레스 테스트 + 코드 개선 계획

## Context
모든 기능이 정상 동작하는지 체계적으로 검증하면서, 발견된 버그는 즉시 수정.
사용자 관점에서 웹앱 표시가 올바른지(시간 KST, 상태 레이블, 한국어 표시) 함께 확인.
세션은 tmux가 아니므로 proj 실행에 영향 없음. hibernate 전에는 반드시 memory 저장.

## 대상 파일
- `agent/server.js` — Agent 전체 로직
- `pi/wol-server.js` — Pi 릴레이
- `web/src/app/page.tsx` — Web UI
- `agent/.protected-sessions`, `pi/schedules.json` — 영속 파일

## 버그 수정 전략
발견 즉시 수정 → 해당 테스트 재실행. 마지막에 몰아 수정 금지.

## Memory 저장 규칙
- **매 Phase 완료 시** memory에 테스트 결과(pass/fail + 발견된 이슈 + 수정 내역) 저장
- **hibernate 직전** 반드시 전체 진행 상황 memory 저장 (세션 만료 대비)
- **다른 프로젝트 proj 실행 전** 완료된 수정사항 memory 저장
- 저장 위치: `~/.claude/projects/D--projects-button/memory/project_stress_test_progress.md`
- 세션 복구 시: memory에서 마지막 완료 Phase 확인 → 다음 Phase부터 재개

---

## Phase 0: 환경 확인 (5분)
- Agent health, Pi health, Agent status 응답 구조 확인
- AGENT_SECRET 환경변수 확보
- **Memory 저장**: 환경 상태 확인 결과

## Phase 1: 인증 테스트 (10분)
- 올바른/잘못된 PIN → 응답 코드 확인
- 5회 실패 → 429 rate limit 확인 (Pi + Agent 이중 lockout 여부도 확인)
- 60초 후 lockout 해제 확인
- JWT 유효/무효/누락 → 401 확인
- **웹앱**: PIN 입력 화면 스크린샷, 잘못된 PIN 시 shake 애니메이션, rate limit 시 메시지
- **Memory 저장**: 인증 테스트 pass/fail, 이중 lockout 확인 결과

## Phase 2: 상태 + 메트릭 (10분)
- `/api/status` 응답: sessions, metrics, tasks, alerts 구조 확인
- metrics 값 합리성 (cpu 0-100, mem > 0, disks 비어있지 않음)
- alert 임계값 (disk>90%, cpu>95%, gpu>85°C)
- **웹앱 Monitor 탭**: CPU/RAM/디스크 progress bar, GPU 온도, 업타임 스크린샷
- **사용자 관점**: 숫자 단위(%, GB, °C), 업타임 h/m 형식, 카운트다운 "Refresh in Xs"
- **Memory 저장**: 메트릭 정확성, UI 표시 적절성

## Phase 3: 세션 관리 (15분)
- proj 액션으로 테스트 세션 생성 → status에 표시 확인
- protect → `.protected-sessions` 영속 확인
- unprotect → 파일에서 제거 확인
- kill → tmux 세션 + 에디터 윈도우 정리 확인
- 새 proj 열기 → 미보호 세션 kill, 보호 세션 유지
- **웹앱 Terminal 드롭다운**: Shield 아이콘(filled/outline), X 버튼, badge 숫자 스크린샷
- **사용자 관점**: 보호 상태가 직관적인지, kill 후 즉시 UI 반영(optimistic 35초)
- **Memory 저장**: 세션 관리 pass/fail, optimistic UI 동작 결과

## Phase 4: AI 태스크 + 프로젝트 (20분)
- 프로젝트 목록 → IGNORE_DIRS 제외 확인
- 잘못된 프로젝트 이름 (`../etc`) → 400 거부
- task-add (command type) → pending → 실행 → completed
- task-add (AI type, 간단한 echo 태스크) → 실행 → SUCCESS 마커 → learned 저장
- task-cancel (pending + running 상태)
- task-update (pending 가능, running은 inputNeeded만)
- verb 충돌 방지: "Uninstall X"가 "Download X" learned에 매칭 안 되는지
- **웹앱 Schedule 탭**: Tasks 섹션 — pending/running/completed 상태 표시, AI 마크, "Needs Input" 뱃지
- **사용자 관점**:
  - 시간 표시가 KST인지 (scheduledAt이 UTC ISO로 저장 → 브라우저 타임존 변환 확인)
  - task result가 한국어로 표시되는지 (방금 추가한 한국어 진행 보고)
  - completed/failed 시 결과 텍스트가 의미 있는지
- **Memory 저장**: 태스크 lifecycle 결과, 학습 시스템 동작, UI 시간 표시

## Phase 5: 전원 관리 + Hibernate (15분 + 대기)
- display_off → 모니터 꺼짐 확인
- delayed hibernate (60초) → `.hibernate-schedule` 파일 생성 확인
- hibernate-cancel → 파일 삭제 + "cancelled" 응답
- **웹앱**: Power Menu 드롭다운 — Sleep/Hibernate/Cancel 표시 스크린샷
- **사용자 관점**: 지연 시간 표시가 직관적인지 (예: "Hibernate in 1h scheduled" → 한국어?)
- **Memory 저장 (hibernate 직전)**: Phase 0~5 전체 결과 + 발견된 버그 + 수정사항 + 남은 Phase 목록
- **즉시 hibernate** → PC 꺼짐
- 사용자 수동 wake (또는 WOL 시도)
- wake 후: Agent 자동 시작 확인, orphaned task cleanup, status online 전환
- **웹앱**: 오프라인 상태에서 cached tasks 표시 확인 → 온라인 전환 후 실시간 갱신
- **Memory 저장**: hibernate 복구 결과

## Phase 6: 스케줄 + Deferred + Wake-at (15분)
- schedule CRUD: 생성/목록/수정/비활성화/삭제
- wake-at: 설정/확인/취소
- deliverAt task-add: Agent 온라인 → 즉시 전달 + wake-at 예약
- task cache: Pi `.task-cache.json` 갱신 확인
- deferred 목록: `/api/deferred` 응답
- **웹앱 Schedule 탭**: 스케줄 목록, 토글 버튼, New Schedule 폼 스크린샷
- **사용자 관점**: cron → 사람이 읽을 수 있는 형식인지 (예: "매일 08:30" vs "30 8 * * *")
- **Memory 저장**: 스케줄/deferred/wake-at 결과

## Phase 7: 통합 UI 검증 (10분)
- Home 탭: 온라인 상태 — 초록 파워 버튼, "PC is ON", Quick Actions
- Power Menu: 모든 옵션 표시
- Terminal 드롭다운: 세션 목록 + 상태
- Project 드롭다운: 프로젝트 목록 + "+ New Repo"
- Monitor 탭: 메트릭 전체
- Schedule 탭: 스케줄 + Tasks
- Help 패널, WOL Log 패널
- **사용자 관점 체크리스트**:
  - [ ] 모든 시간이 KST로 표시
  - [ ] 영어/한국어 혼용이 자연스러운지
  - [ ] 상태 레이블이 직관적인지 (pending/running/completed/failed)
  - [ ] 에러 메시지가 사용자에게 유용한지
  - [ ] 빈 상태(세션 0개, 태스크 0개) 표시가 적절한지
- **Memory 저장**: 최종 UI 검증 결과, 전체 테스트 요약

---

## 잠재적 이슈 (코드 분석에서 발견, 테스트 중 확인)
1. **Pi + Agent 이중 rate limit**: Pi 5회 실패 → Agent도 5회 호출 → 연쇄 lockout
2. **Deferred expiry 10분**: PC 부팅 10분 초과 시 deferred task 소멸
3. **Schedule UI 분 해상도**: UI는 00/30분만, API는 임의 분 허용 → 불일치
4. **KST 미보장**: 시간 표시가 브라우저 타임존 의존 — Pi UTC 시 문제

## 검증 방법
- API: curl 명령으로 응답 코드/구조 확인
- 웹앱: PyAutoGUI 스크린샷 + 육안 검증
- 파일: cat/Read로 영속 파일 내용 확인
- 버그: 즉시 수정 → 재테스트 → commit

---

# Secretary.js 기능 테스트 계획 (2026-04-09)

## T1: capturePane 범위 (스크롤백 200줄)
**목적**: -S -200이 실제로 스크롤 위 내용을 캡처하는지
**방법**: `psmux capture-pane -p -S -200 -t button | wc -l` 로 줄 수 확인
**기대**: 50줄+ 캡처

## T2: 상태 판정 (5상태 분류)
**목적**: WORKING/WAITING/IDLE/AGENT_DEAD/SESSION_DEAD 정확 분류
**방법**:
1. 이 세션(button): IDLE 또는 WORKING
2. `psmux new-session -d -s test-dead` (Claude 안 띄움) → AGENT_DEAD
3. 레지스트리에 존재하지만 psmux에 없는 세션 → SESSION_DEAD
4. audit-log에서 상태 확인

## T3: 압축 후 DEAD 오탐 방지
**목적**: 압축 직후 5분간 DEAD 판정 방지
**방법**: 실제 압축 발생 시 확인 (수동). 코드 레벨로 compressedRecentlyMap 로직 검증.

## T4: DEAD 세션 Telegram
**목적**: 사라진 세션이 Telegram 알림 트리거
**방법**:
1. `psmux new-session -d -s test-tg`
2. 레지스트리에 등록: `echo "test-tg|sonnet|unknown" >> agent/.secretary/.session-registry.txt`
3. `psmux kill-session -t test-tg`
4. 60초 대기 → audit-log에서 `session_dead` 확인 + Telegram 수신

## T5: 에스컬레이션 분기 (모델 기반)
**목적**: Opus→self-verify, Sonnet→Opus 소환
**방법**: 에러 3분+ 지속 필요 → 수동 장기 관찰. 코드 레벨로 onEnterState 분기 확인.

## T6: S-2 슬라이딩 윈도우
**목적**: 5사이클 3+에러 축적 시 에스컬레이션
**방법**: 5분 관찰 → `grep "s2_window" ~/.claude/audit-log/$(date +%Y-%m-%d).jsonl`

## T7: auto-register dir/sid
**목적**: 새 세션이 dir/sid 포함 등록
**방법**:
1. `psmux new-session -d -s test-reg -c "D:\projects\button"`
2. 60초 대기 → `grep test-reg agent/.secretary/.session-registry.txt`
3. dir 필드 확인
**정리**: 세션 kill + 레지스트리에서 삭제

## T8: guard 자동 복원
**목적**: guard 해제 후 작업 재개 시 settings.json 복원
**방법**: 실제 guard 차단 발생 시 수동 확인. 코드 레벨로 백업/복원이 permissions.deny만 다루는지 확인.

## T9: progress.md 넛지
**목적**: plan.md O + progress.md X + 30분+ → 넛지
**방법**: progress.md 임시 이름변경 → 60초 대기 → 넛지 수신 확인 (30분+ 조건 충족 필요)

## T10: syntax 최종
**방법**: `node --check agent/secretary.js && node --check agent/server.js`

## 장기 관찰 / 수동 테스트
| 테스트 | 이유 | 확인 시점 |
|--------|------|----------|
| 압축→리줌 주입 | 실제 압축 필요 | 다음 압축 시 |
| Opus 분석 세션 스폰 | FSM analyzing 도달 필요 | 에러 3분+ 지속 시 |
| 사용자 복귀 감지 | 10분+ 부재 후 복귀 | 다음 AFK 시 |
| solution cache 학습 | saveSolutionCache 호출부 미연결 | 향후 |
