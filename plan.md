# Plan: Secretary.js 누락 기능 복원 + 변질 수정

## 목표

psmux 시절 bash 비서와 1:1 전수 대조하여 발견된 누락/변질을 수정하고,
scriptagent2.md를 최종 반영한다.

## Phase 1: 인프라 수정 (다른 기능의 전제조건)

| # | 기능 | 수정 내용 |
|---|------|----------|
| 1 | capturePane 범위 확장 | `-S 0` → `-S -200` (스크롤백 200줄 포함) |
| 2 | 상태 판정 정교화 | IDLE/DEAD 분리: Claude 프롬프트(`❯`, `bypass permissions`) 있으면 IDLE, 쉘 프롬프트(`$`)만 있으면 AGENT_DEAD. 레지스트리에 있지만 psmux에 없는 세션 = SESSION_DEAD |
| 3 | 압축 후 DEAD 오탐 방지 | 압축 감지 시 `compressedRecentlyMap.set(name, Date.now())`, 5분 이내면 DEAD→IDLE 강제 |
| 4 | 에러 정규화 | errKey 비교 시 숫자/경로 치환 (`line 42`→`line N`, `/src/foo/`→`/.../`). FSM `same_error` 판정 정확도 향상 |

## Phase 2: 누락 기능 복원

| # | 기능 | 수정 내용 |
|---|------|----------|
| 5 | DEAD 세션 감지 + Telegram | buildReport에서 레지스트리 vs live 세션 비교 → SESSION_DEAD를 리포트에 포함 + dedup Telegram 알림 |
| 6 | 모델 기반 에스컬레이션 통합 | detectStruggle(JSONL, 신뢰도 높음) 기반으로만 풀 체인 트리거. 흐름: ① rate limit/overloaded → skip ② solution cache 히트 → 해결법 직접 전송, 에스컬레이션 스킵 ③ Opus 세션 → self-verify 메시지 주입 (정규화된 에러 원문 포함) ④ Sonnet 세션 → 타겟에 "잠깐 기다려" → Opus 분석 세션 스폰 → 결과 주입 ⑤ 미해결 → Telegram. parseErrors(화면, 신뢰도 낮음)는 넛지+dedup만 (Opus 소환 안 함) |
| 7 | Opus 분석 세션 스폰 | `.harness/opus-analyst-role.md`에 태스크 작성 → `exec('bash spawn-session.sh opus-analyst')` 호출. Opus constitution: Step 0(타겟 일시정지) → Step 1(JSONL) → Step 2(스냅샷 비교) → Step 3(소스 Read) → Step 4(근본 원인+수정 방향 전송). 완료 후 세션 kill |
| 8 | S-2 슬라이딩 윈도우 | 5사이클 중 3+사이클 에러 축적 → 구조적 문제 판단 → #6 동일 모델 분기 흐름 연결. FSM(같은 에러 반복)과 보완: S-2는 다양한 에러 축적 감지 |
| 9 | 삽질 2단계 에스컬레이션 | processStruggle에서 같은 세션 2사이클 연속 삽질 → #6 모델 분기 연결 (1차 넛지 → 2차 Opus/self-verify) |
| 10 | auto-register dir/sid 조회 | `psmux display-message -p "#{pane_current_path}"` 로 CWD 확인 + JSONL 디렉토리에서 최신 120분 내 미등록 SID 매칭 |
| 11 | guard 자동 복원 (런타임) | guard 해제 후 세션 작업 재개 감지(guardDetectedAt 삭제 = 화면 변화) 시 .guard-restore에서 settings.json 복원 |
| 12 | rate limit skip | 에러 감지에서 `rate limit`, `overloaded` 패턴은 에스컬레이션 안 함 |
| 13 | 사용자 복귀 감지 | idle < 60초 + 이전에 부재였음 → "사용자 복귀" 알림 + 부재 플래그 해제 |
| 14 | WF 세션 제외 | checkUserPresence에서 WF 세션(worker/verifier/healer/strategic) 자율 진행 넛지 제외 |
| 15 | progress.md 생성 넛지 | `plan.md 존재 + progress.md 없음 + 세션 30분+` → "progress.md 만들어" 넛지 (60s 사이클, dedup 1회/일) |
| 16 | solution cache 히트 시 에스컬레이션 스킵 | 캐시 히트 → 해결법 직접 전송 + FSM을 `normal`로 유지 (warned 안 감) |

## Phase 3: 테스트

| # | 테스트 | 방법 | 기대 결과 |
|---|--------|------|----------|
| T1 | capturePane 범위 | resume에 스크롤 위 내용 포함 확인 | 200줄 스크롤백 캡처 |
| T2 | 상태 판정 | Claude 프롬프트 vs 쉘 프롬프트 세션 | IDLE vs AGENT_DEAD 정확 분류 |
| T3 | 압축 후 보호 | 압축 후 5분 이내 DEAD 판정 안 됨 | DEAD 대신 IDLE |
| T4 | DEAD 세션 Telegram | 레지스트리 세션 kill → Telegram 수신 | dedup 1회 Telegram |
| T5 | 에스컬레이션 분기 | (수동) Sonnet 세션 삽질 → Opus 소환 확인 | opus-analyst 세션 생성 + 분석 결과 주입 |
| T6 | S-2 윈도우 | (관찰) 5사이클 3+에러 축적 시 트리거 | 에스컬레이션 발동 |
| T7 | auto-register 정보 | 새 세션 → dir/sid 포함 등록 | `name\|model\|dir\|ts\|sid` |
| T8 | guard 자동 복원 | guard 해제 후 작업 재개 → settings 원복 | .guard-restore 삭제 + settings 복원 |
| T9 | progress.md 넛지 | plan.md 있고 progress.md 없는 세션 | 30분+ 후 넛지 |
| T10 | syntax | `node --check secretary.js && node --check server.js` | OK |

## Phase 4: 문서 + 배포

| # | 작업 |
|---|------|
| 17 | scriptagent2.md 최종 업데이트 (기능별 현재 구현 상태 반영) |
| 18 | 커밋 + push + Agent 재실행 |
