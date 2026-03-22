# CAPTCHA Solver Rules

## 현재 CAPTCHA 형식 (LG U+ 공유기)
- **길이**: 정확히 6글자
- **문자**: 영문 소문자만 (a-z), 숫자 없음
- 105+ 성공 로그인에서 예외 없음

## 형식이 바뀌면
사용자가 "캡차 기준이 바뀌었다"고 알려줌. 수정할 곳:
1. `CAPTCHA_LENGTH` 상수 (router-wol.js 상단)
2. `CAPTCHA_PATTERN` 정규식
3. `DIGIT_TO_LETTER` 맵 (필요 시)
4. 솔버 프롬프트: `CAPTCHA_SYSTEM_PROMPT`, `CAPTCHA_USER_PROMPT`, `CAPTCHA_GROUNDING_PROMPT`
5. `isValidCaptcha()` 함수
- 하위 scoring/variant 시스템은 자동 적응 (length voting 유지)

## 3-solver 아키텍처
GPT-4o-mini (2 reads) + Gemini Flash (3 reads) + CapSolver (1) — 병렬 실행
- 모든 솔버 출력은 `cleanCaptchaRead()` → `isValidCaptcha()` 통과 필수
- 동적 가중치: Bayesian smoothed accuracy (prior_weight=10)
- Cross-solver variants: 같은 길이 후보 간 문자 조합
- Beam search: top 10 variant 순차 시도

## 학습 시스템
- `.captcha-learned.json`: gptToCap(diff), winMappings(승리 치환), posDiffs/posWins(위치별)
- 동적 pruning: global >80 entries → count≤1 제거, positional >500 → count≤1 제거
- Anti-pollution: solver가 안 읽은 문자는 top solver score의 15%까지만 주입
- Cascade prevention: solver-originated chars에서만 learned bonus 파생
