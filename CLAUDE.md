# Button — WOL Web App

모바일에서 집 PC를 Wake-on-LAN으로 켜고/끄는 원버튼 웹앱.

## 기술스택
- **Web**: Next.js 16 (App Router) + Tailwind CSS, Vercel 호스팅
- **Agent**: Node.js + Express (PC에 상주, Windows Task Scheduler)
- **인증**: 4자리 PIN → JWT 쿠키 (24h)

## 구조
```
web/           → Next.js 웹앱 (Vercel 배포)
  src/app/     → 페이지 + API Routes
  src/lib/     → auth (bcrypt + JWT)
  src/middleware.ts → JWT 검증 (API 보호)
agent/         → PC Agent (Express, port 9876)
  server.js    → health/shutdown/run 엔드포인트
plan.md        → 설계 문서
```

## 배포
- **Vercel**: `https://web-eight-roan-40.vercel.app`
- **Project ID**: `prj_3BrHwOBIQFaELkM1HeIUTIMOn31G`
- **GitHub**: `https://github.com/jsh8603-web/button`
- **Agent**: PC 로그온 시 Task Scheduler로 자동 시작

## 네트워크
- PC IP: `192.168.219.102` (고정), MAC: `74:56:3C:CD:C9:FB`
- 공인 IP: `125.248.17.75` (LG U+, 동적)
- 라우터: `192.168.219.1`, 포트포워딩 필요 (UDP 9 → broadcast, TCP 9876 → PC)

## 명령어
```bash
cd web && npm run dev     # 로컬 개발
cd web && npm run build   # 빌드
cd agent && node server.js # Agent 실행
```

## wf 빌드/테스트
1. `cd web && npm run build` — 빌드 확인
2. 수동 테스트: 브라우저에서 PIN 입력 → 버튼 동작 확인

## 환경변수
- `web/.env.local`: PIN_HASH, JWT_SECRET, PC_HOST, PC_PORT, PC_MAC, WOL_PORT, AGENT_PIN
- `agent/.env`: PORT, PIN_HASH, ALLOWED_ORIGIN

## Critical Rules
- Agent 화이트리스트 명령만 실행 (임의 명령 금지)
- `.env` 파일 커밋 금지
- `x-pin-hash`에는 평문 PIN 전송 → Agent가 bcrypt.compare
