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
- [ ] T1 capturePane 범위 확인
- [ ] T2 상태 판정 검증
- [ ] T3 압축 후 보호 검증
- [ ] T4 DEAD 세션 Telegram 검증
- [ ] T5 에스컬레이션 분기 검증
- [ ] T6 S-2 윈도우 검증
- [ ] T7 auto-register dir/sid 검증
- [ ] T8 guard 자동 복원 검증
- [ ] T9 progress.md 넛지 검증
- [ ] T10 syntax 검증

## Phase 4: 문서 + 배포
- [ ] #17 scriptagent2.md 최종 업데이트
- [ ] #18 커밋 + push + Agent 재실행
