# Router CAPTCHA Solving System

## 개요

LG U+ 공유기 자동 로그인을 위한 하이브리드 CAPTCHA 해결 시스템.
공유기 내장 WOL API 접근에 필요한 세션 쿠키를 획득한다.

## 아키텍처

```
Agent 부팅 → KV 쿠키 복원 시도 → 유효하면 CAPTCHA 스킵
                ↓ (만료/없음)
         [Phase 1: 학습 + 1차 시도]
         GPT-4o mini (5x 병렬) + CapSolver (1x) 동시 실행
                ↓
         Confidence Scoring → Beam Search → 상위 30개 변형 순차 시도
                ↓ (실패 시)
         [Phase 2: CapSolver 전용 Fallback]
         새 CAPTCHA 3회 × CapSolver + Confusion 변형
```

## Phase 1: GPT + CapSolver 병렬 (학습 목적)

### 이미지 전처리
- sharp로 400px 업스케일 (cubic interpolation)
- 샤프닝 (sigma=1.5) + contrast 정규화
- GIF → PNG 변환 (GPT vision 호환)

### GPT-4o mini (5x 병렬 읽기)
- `detail: "high"` — 최대 해상도
- `temperature: 0.3`, `top_p: 0.3` — 낮은 온도 + 약간의 다양성
- Expert OCR system prompt (혼동 문자 가이드 포함)
- 각 읽기당 3개 추측, 총 최대 15개 후보
- charVote: position별 다수결 합의

### CapSolver (1x 병렬)
- ImageToTextTask API
- 초기 가중치 3 → 정답률 기반 동적 조정 (1.5~5.0)
- ~1초 응답

### Confidence Scoring (점수 기반 변형 생성)

**가중치 체계 (동적):**
| 소스 | 초기값 | 동적 범위 | 역할 |
|------|--------|-----------|------|
| CapSolver | 3 | 1.5~5.0 | 정답률 기반 동적 조정 |
| GPT 1순위 | 3 | 1.5~5.0 | 정답률 기반 동적 조정 |
| GPT 나머지 | 1 | 1 (고정) | 보조 읽기 |
| Cross-solver | 2 | 2 (고정) | GPT×CapSolver 교차 조합 |
| Confusion map | 0.3 | 0.3 (고정) | 유사 문자 대안 |
| 학습된 gptToCap | 0.1×count | cap 0.5~2.0 | 데이터 신뢰도에 따라 상한 증가 |
| 학습된 winMappings | 0.2×count | cap 0.5~3.0 | 승리 데이터 축적에 따라 상한 증가 |

**동적 가중치 (`getDynamicWeights`):**
- 최소 5회 이상 solver별 데이터 수집 후 적용
- 정답률 공식: `weight = 1.5 + 3.5 × accuracy` (범위 1.5~5.0)
- 학습 보너스 상한: `successes/10` 비율로 스케일 (10회 승리 시 최대)

**Position별 분석:**
```
pos0: q:42.0 a:36.0 9:0.3 p:0.3  ← CapSolver 'a' vs GPT 'q' 경쟁
pos1: k:78.0 h:0.3 x:0.3         ← 양쪽 일치, 높은 확신
```

**Beam Search:**
- 각 position에서 상위 6~8개 문자 선택
- 순차 확장하며 상위 100개 유지
- 최종 30개 변형 (점수 높은 순)
- ±1 길이 변형도 추가

## Phase 2: CapSolver 전용 Fallback (실질적 해결)

Phase 1 실패 시 새 CAPTCHA 3회 발급받아 CapSolver만 사용:
- CapSolver 답변 직접 시도
- Confusion map 기반 변형 (최대 25개)
- GPT 호출 없음 → 빠름 (~2초/회)

## 적응형 학습 (.captcha-learned.json)

### 매 시도 학습 (winning 불필요)
- `gptToCap`: GPT↔CapSolver character-level 차이 기록
  - 예: `"h→n": 5` — GPT가 'h'라고 읽었는데 CapSolver는 'n'이 5회
- CapSolver ≈ ground truth이므로, 실패해도 학습 가능

### 성공 시 학습 (gold standard)
- `winMappings`: 실제 정답과 모든 후보의 char 차이 기록
  - 예: `"a→o": 3` — 후보가 'a'였는데 정답은 'o'가 3회
- 가중치 더 높음 (검증된 정보)

### 학습 데이터 활용 (동적 상한)
- GPT 패턴: `minObs`회+ 관측 시 적용 (attempts≥20이면 2회, 아니면 3회)
- 승리 패턴: 1회+ 관측 시 적용
- **상한이 데이터 신뢰도에 따라 증가**: successes 0→10회에 따라 gptToCap cap 0.5→2.0, win cap 0.5→3.0
- **상한 제한 유지**: 학습 데이터가 실제 읽기를 override하지 못함

### Solver별 정답률 추적
- `stats.capHits/capTotal`: CapSolver의 직접 답변이 정답과 일치한 횟수/시도
- `stats.gptHits/gptTotal`: GPT 1순위 답변이 정답과 일치한 횟수/시도
- 5회+ 데이터 축적 후 `getDynamicWeights()`가 solver 가중치를 정답률에 비례하여 조정

### 자동 정리
- 80개+ 매핑 축적 시 count≤1 항목 제거 (noise 정리)

## Confusion Map (혼동 문자) — 자동 진화

`BASE_CONFUSIONS` (정적 테이블) + 학습 데이터로 자동 보강/정리.

**기본 혼동 쌍:**
```
i↔j↔l↔1, c↔s↔e, b↔d↔h↔6↔8↔u↔k, n↔h↔r↔m
o↔a↔0↔c, p↔q↔g↔9, v↔y↔u↔w, t↔r↔f↔7
```

**자동 보강 (`buildConfusions` at startup):**
- `winMappings`에서 2회+ 성공한 from→to 매핑 → CONFUSIONS에 자동 추가
- 예: `u→b` 16회 성공 → `u` 항목에 `b` 자동 등록

**자동 정리 (30+ attempts 이후):**
- `gptToCap`에 5회+ 관측되었지만 `winMappings`에 0회인 매핑 → 노이즈로 판단, 제거
- 솔버들이 자주 혼동하지만 실제 정답과 무관한 매핑을 정리하여 검색 공간 축소

**로그 예시:**
```
[router] Confusions: +3 from wins, -2 pruned (52 attempts)
```

## CAPTCHA 진행 상태 (웹앱 표시)

Agent가 CAPTCHA 진행 상태를 KV(`btn:captcha-status`)에 기록 → 웹앱에 실시간 표시.

**표시 시점:** 부팅, heartbeat 백그라운드 로그인, sleep/hibernate 모두
**메시지 종류:**
- `CAPTCHA 풀이 중 (2/5)` — 진행 중 (N번째 시도)
- `CAPTCHA 성공` — 로그인 성공
- `CAPTCHA 실패` — 전체 실패
- `CAPTCHA 실패 — sleep 취소됨` — sleep/hibernate 시 실패로 취소

**웹앱 표시 위치:** `actionFeedback` (파워 버튼 아래 amber 텍스트)

## Sleep/Hibernate CAPTCHA 정책

| 상황 | 동작 |
|------|------|
| 쿠키 유효 | CAPTCHA 안 풀고 즉시 sleep |
| 쿠키 만료/없음 | CAPTCHA 5회 시도 |
| CAPTCHA 성공 | 쿠키 KV에 24h TTL 저장 → sleep 실행 |
| CAPTCHA 실패 | **sleep 취소** (쿠키 없이 sleep하면 WOL 불가) |

## Heartbeat CAPTCHA 정책

| 상황 | 동작 |
|------|------|
| 쿠키 유효 | keepAlive → 그대로 사용 |
| 쿠키 만료 | 백그라운드 로그인 시작 (heartbeat 비블로킹) |
| 로그인 진행 중 | heartbeat는 쿠키 null로 즉시 전송 |
| 로그인 실패 | `heartbeatLoginFailed` 플래그 → 재시도 안 함 |

## 세션 유지: Supabase pg_cron Keep-Alive

CAPTCHA는 최초 1회만 풀면 된다. 이후 세션은 pg_cron이 Agent와 독립적으로 유지.

```
Agent 부팅 → KV 쿠키 복원 or CAPTCHA → 쿠키 KV 저장
                                              ↓
                                   pg_cron (30분마다, Agent 독립)
                                   → KV에서 쿠키 읽기
                                   → 공유기에 GET keep-alive
                                   → 세션 살아있으면 TTL 24h 갱신
                                   → 세션 만료면 KV에서 쿠키 삭제
```

**PC 상태별 동작:**
| PC 상태 | 세션 유지 주체 | CAPTCHA 필요? |
|---------|--------------|:------------:|
| 켜짐 | Agent heartbeat (30초) + pg_cron (30분) | 최초 1회만 |
| Sleep/Hibernate | pg_cron만 (30분) | 불필요 |
| Shutdown | pg_cron만 (30분) | 불필요 (UDP WOL 사용) |
| 공유기 재부팅 후 | Agent 부팅 시 재로그인 | 필요 |

**Cron 설정:**
- Supabase `pg_cron` + `pg_net`: `*/30 * * * *` (30분 간격)
- Route: `/api/cron/router-keepalive?secret={CRON_SECRET}`
- Vercel Hobby 플랜은 일 1회 제한 → Supabase pg_cron으로 대체
- 관리: `npx supabase db query --linked "SELECT * FROM cron.job;"`

## 성능 지표

- Phase 1 소요: ~3-5초 (GPT+CapSolver 병렬) + ~15초 (30 variants POST)
- Phase 2 소요: ~2초/회 × 3회
- 총 최대 시도: 5회 retry × (Phase1 + Phase2)
- 목표: 1~2 attempt 내 성공 (학습 누적 후)
- 현재 성공률: ~13.5% (52 attempts, 7 successes) — 학습 + confusion 자동 보강으로 개선 중

## 환경변수

| 변수 | 위치 | 용도 |
|------|------|------|
| `OPENAI_API_KEY` | agent/.env | GPT-4o mini API |
| `CAPTCHA_API_KEY` | agent/.env | CapSolver API |
| `ROUTER_PASSWORD` | agent/.env | 공유기 비밀번호 (**반드시 따옴표로 감싸기** — `#` 문자 때문) |
| `CRON_SECRET` | Vercel env | Cron 엔드포인트 인증 (Vercel 자동 주입) |

## 파일

| 파일 | 역할 |
|------|------|
| `agent/router-wol.js` | CAPTCHA 해결 + 로그인 + 세션 관리 + confusion 자동 진화 |
| `agent/.captcha-learned.json` | 학습된 혼동 매핑 (자동 생성, git 제외) |
| `agent/router-js/` | 공유기 RSA 암호화 라이브러리 (jsbn, rsa 등) |
| `web/src/app/api/cron/router-keepalive/route.ts` | pg_cron 세션 keep-alive |
| `web/src/app/api/heartbeat/route.ts` | captchaStatus KV 저장 + storedRouterCookie 반환 |
| `web/src/app/api/status/route.ts` | captchaStatus 웹앱에 전달 |
