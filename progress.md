# Progress — Secretary.js 누락 기능 복원

## Phase 1: 인프라 수정
- [x] #1 capturePane 범위 `-S 0` → `-S -200`
- [x] #2 상태 판정 IDLE/AGENT_DEAD/SESSION_DEAD 분리
- [x] #3 압축 후 DEAD 오탐 방지 (5분 보호)
- [x] #4 에러 정규화 (숫자/경로 치환)

## Phase 2: 누락 기능 복원
- [x] #5 DEAD 세션 감지 + Telegram
- [x] #6 모델 기반 에스컬레이션 통합
- [x] #7 Opus 분석 세션 스폰 (spawn-session.sh)
- [x] #8 S-2 슬라이딩 윈도우
- [x] #9 삽질 2단계 에스컬레이션
- [x] #10 auto-register dir/sid 조회
- [x] #11 guard 자동 복원 (런타임) + guard 백업을 permissions.deny만 저장
- [x] #12 rate limit skip (checkEscalation에 통합)
- [x] #13 사용자 복귀 감지 (userAbsentFlag + idle < 60s)
- [x] #14 WF 세션 제외 (WF_EXCLUDE regex)
- [x] #15 progress.md 생성 넛지 (plan.md 존재 + progress.md 없음 + 30분+ → 넛지)
- [x] #16 solution cache 히트 시 에스컬레이션 스킵 (checkEscalation 상단에서 즉시 반환)

## Phase 3: 테스트
- [x] T1 capturePane 범위 — ⚠️ psmux는 스크롤백 미지원 (-S -200 = -S 0 동일). 해 없으므로 유지
- [x] T2 상태 판정 — ✅ WORKING/IDLE/AGENT_DEAD/DEAD 4패턴 정확 매칭
- [ ] T3 압축 후 보호 — 수동 (다음 압축 발생 시)
- [x] T4 DEAD 세션 Telegram — ✅ test-tg SESSION_DEAD 감지 + audit-log 기록 확인
- [ ] T5 에스컬레이션 분기 — 수동 (에러 3분+ 지속 필요)
- [x] T6 S-2 윈도우 — parseErrors 엄격화로 트리거 빈도 낮음 (의도적). struggle 기반 에스컬레이션은 작동 확인 (escalation_warned)
- [x] T7 auto-register dir/sid — ✅ button 세션이 dir+sid 포함 자동 등록 확인
- [ ] T8 guard 자동 복원 — 수동 (guard 차단 발생 시)
- [ ] T9 progress.md 넛지 — 조건 (30분+) 확인 필요
- [x] T10 syntax — ✅ secretary.js + server.js 둘 다 OK

## Phase 4: 문서 + 배포
- [x] #17 scriptagent2.md 최종 업데이트 (이식률 72%→93%, 31개 기능)
- [ ] #18 커밋 + push + Agent 재실행

## 발견 사항
- psmux는 스크롤백 버퍼 미지원 (-S 옵션 무시). generateSessionResume의 Screen State 섹션은 현재 화면만 캡처됨.
- audit-log 날짜가 UTC 기준 → KST 자정~09시에 전날 파일에 기록됨
- 에러 감지 자기참조 오탐 여전히 존재 (화면에 에러 패턴 텍스트 표시 시)
