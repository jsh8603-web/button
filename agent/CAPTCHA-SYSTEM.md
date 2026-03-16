# Router CAPTCHA Solving System

## 개요

LG U+ 공유기 자동 로그인을 위한 하이브리드 CAPTCHA 해결 시스템.
공유기 내장 WOL API 접근에 필요한 세션 쿠키를 획득한다.

## 아키텍처

```
Agent 부팅 → login() → 세션 쿠키 → KV 저장 → Vercel wake route가 공유기 WOL API 호출
                ↓
         [Phase 1: 학습 + 1차 시도]
         GPT-4o mini (5x 병렬) + CapSolver (1x) 동시 실행
                ↓
         Confidence Scoring → Beam Search → 상위 50개 변형 순차 시도
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
- 가중치 5 (near-ground-truth anchor)
- ~1초 응답, 높은 정확도

### Confidence Scoring (점수 기반 변형 생성)

**가중치 체계:**
| 소스 | 가중치 | 역할 |
|------|--------|------|
| CapSolver | 5 | Ground truth 앵커 |
| GPT 1순위 | 3 | 주요 읽기 |
| GPT 나머지 | 1 | 보조 읽기 |
| Cross-solver | 2 | GPT×CapSolver 교차 조합 |
| Confusion map | 0.3 | 유사 문자 대안 |
| 학습된 매핑 | 0.1~1.5 | 과거 경험 (보조만, override 금지) |

**Position별 분석:**
```
pos0: q:42.0 a:36.0 9:0.3 p:0.3  ← CapSolver 'a' vs GPT 'q' 경쟁
pos1: k:78.0 h:0.3 x:0.3         ← 양쪽 일치, 높은 확신
```

**Beam Search:**
- 각 position에서 상위 6~8개 문자 선택
- 순차 확장하며 상위 100개 유지
- 최종 50개 변형 (점수 높은 순)
- ±1 길이 변형도 추가

## Phase 2: CapSolver 전용 Fallback (실질적 해결)

Phase 1 실패 시 새 CAPTCHA 3회 발급받아 CapSolver만 사용:
- CapSolver 답변 직접 시도
- Confusion map 기반 변형 (최대 20개)
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

### 학습 데이터 활용
- 3회+ 관측된 GPT 패턴 → position 점수에 0.1~1.0 보너스
- 1회+ 관측된 승리 패턴 → position 점수에 0.2~1.5 보너스
- **상한 제한**: 학습 데이터가 실제 읽기를 override하지 못함

### 자동 정리
- 80개+ 매핑 축적 시 count≤1 항목 제거 (noise 정리)

## Confusion Map (혼동 문자)

자주 혼동되는 문자 쌍:
```
i↔j↔l↔1, c↔s↔e, b↔d↔h↔6↔8, n↔h↔r↔m
o↔a↔0↔c, p↔q↔g↔9, v↔y↔u↔w, t↔r↔f↔7
```

## 세션 유지: Vercel Cron Keep-Alive

CAPTCHA는 최초 1회만 풀면 된다. 이후 세션은 Cron이 자동 유지.

```
Agent 부팅 → CAPTCHA 풀어서 로그인 → 쿠키 KV 저장
                                         ↓
                              Vercel Cron (30분마다)
                              → KV에서 쿠키 읽기
                              → 공유기에 GET keep-alive
                              → 세션 살아있으면 TTL 24h 갱신
                              → 세션 만료면 KV에서 쿠키 삭제
```

**PC 상태별 동작:**
| PC 상태 | 세션 유지 주체 | CAPTCHA 필요? |
|---------|--------------|:------------:|
| 켜짐 | Agent heartbeat (30초) + Cron (30분) | 최초 1회만 |
| Sleep/Hibernate | Cron만 (30분) | 불필요 |
| Shutdown | Cron만 (30분) | 불필요 (UDP WOL 사용) |
| 공유기 재부팅 후 | Agent 부팅 시 재로그인 | 필요 |

**Pre-sleep 흐름:**
1. Sleep/Hibernate 명령 수신
2. `refreshBeforeSleep()` — 세션 살아있으면 그대로 사용 (CAPTCHA 안 풀음)
3. 쿠키를 KV에 24h TTL로 저장
4. 실제 sleep/hibernate 실행
5. 이후 Cron이 30분마다 세션 유지

**Cron 설정:**
- `vercel.json`: `*/30 * * * *` (30분 간격)
- Route: `/api/cron/router-keepalive`
- 인증: `CRON_SECRET` 환경변수 (Vercel 자동 주입)

## 성능 지표

- Phase 1 소요: ~3-5초 (GPT+CapSolver 병렬) + ~15초 (50 variants POST)
- Phase 2 소요: ~2초/회 × 3회
- 총 최대 시도: 5회 retry × (Phase1 + Phase2)
- 목표: 1~2 attempt 내 성공 (학습 누적 후)
- 현재 성공률: 20% (10 attempts, 2 successes) — 학습 데이터 누적 중

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
| `agent/router-wol.js` | CAPTCHA 해결 + 로그인 + 세션 관리 |
| `agent/.captcha-learned.json` | 학습된 혼동 매핑 (자동 생성) |
| `agent/router-js/` | 공유기 RSA 암호화 라이브러리 (jsbn, rsa 등) |
| `web/src/app/api/cron/router-keepalive/route.ts` | Vercel Cron 세션 keep-alive |
| `web/vercel.json` | Cron 스케줄 설정 (30분) |
