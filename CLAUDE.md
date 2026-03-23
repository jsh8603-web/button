# Button — WOL Web App

## Summary

모바일에서 집 PC를 원버튼으로 켜고 끄는 웹앱.
Vercel에 정적 호스팅된 Next.js 앱 → Raspberry Pi가 API 게이트웨이 → PC Agent가 명령 실행.
Pi가 LAN에서 WOL 매직패킷을 직접 브로드캐스트하고, Agent의 상태/세션/프로젝트를 중개한다.

```
[모바일 브라우저] → [Vercel 정적 사이트]
         ↓ (API 호출, Bearer JWT)
   [Raspberry Pi :7777] ← API 게이트웨이 (인증 + WOL + Agent 중개)
         ↓ (Bearer AGENT_SECRET)
   [PC Agent :9876] ← 명령 실행 (즉시 응답, ~500ms)
```

## 아키텍처 (Pi Relay Model)

- **Vercel = 정적 호스팅만**: API 라우트 없음, `output: 'export'`
- **Pi = API 게이트웨이**: PIN 인증(JWT 발급), WOL 브로드캐스트, Agent 상태/명령 중개
- **Agent = 명령 실행기**: Express 서버, Pi로부터 HTTP 요청 받아 즉시 실행
- **인증**: PIN → Pi가 Agent `/verify-pin`으로 검증 → JWT 토큰 발급 → 브라우저 localStorage
- **WOL**: Pi가 LAN에서 UDP 매직패킷 직접 전송 (Sleep/Hibernate/Shutdown 모두 대응)
- **반응 속도**: 명령 즉시 실행 (~500ms), 상태 조회도 직접 HTTP (heartbeat 폴링 없음)

## 구조
```
web/                          → Next.js 정적 웹앱 (Vercel 배포, API 없음)
  src/app/
    layout.tsx                → 루트 레이아웃 (viewport, theme-color)
    page.tsx                  → 메인 페이지 (PinEntry → Dashboard, SVG 아이콘, Pi API 호출)
    globals.css               → Tailwind v4 + glow 애니메이션 키프레임

pi/                           → Raspberry Pi API 게이트웨이
  wol-server.js               → HTTP 서버 (인증 + WOL + Agent 중개)
  setup.sh                    → systemd 서비스 등록 스크립트

agent/                        → PC Agent (Express, Windows 서비스)
  server.js                   → Express 서버 (상태/명령 엔드포인트)
  router-wol.js               → [dormant] CAPTCHA solver + 공유기 로그인 (보존)
  CAPTCHA-SYSTEM.md           → [dormant] CAPTCHA 아키텍처 문서 (보존)
  .captcha-learned.json       → [dormant] CAPTCHA 학습 데이터 (보존)
  router-js/                  → [dormant] 공유기 RSA 라이브러리 (보존)
  .protected-sessions         → 보호된 세션 목록 (JSON, 재시작 시에도 유지)
  close-window.ps1            → 윈도우 창 닫기
  maximize-window.ps1         → 윈도우 창 최대화
  kill-sessions.sh            → btn-* tmux 세션 정리
  add-firewall.bat            → Agent 포트 방화벽 규칙 추가
  install.bat                 → Task Scheduler 등록
  enable-autologin.bat        → Windows 자동 로그인 레지스트리 설정
```

## 명령어
```bash
cd web && npm install && npm run build  # 정적 빌드 (out/ 생성)
cd web && npm run dev                    # 로컬 개발
cd agent && npm install && node server.js  # Agent 실행
cd pi && node wol-server.js              # Pi relay 실행
```

## wf 빌드/테스트
1. `cd web && npm run build` — 빌드 확인
2. 수동 테스트: 브라우저에서 PIN 입력 → 버튼 동작 확인

## 환경변수
- `web/.env.local`: NEXT_PUBLIC_API_URL (Pi relay URL, e.g. http://your-ip:7777)
- `pi/.env`: PORT, AGENT_SECRET, PC_MAC, BROADCAST, AGENT_HOST, AGENT_PORT, PIN_HASH, JWT_SECRET
- `agent/.env`: PORT, PIN_HASH, ALLOWED_ORIGIN, AGENT_SECRET, PROJECTS_DIR, EDITOR_CMD, EDITOR_TITLE, BASH_PATH, CLAUDE_BIN, CLAUDE_MODEL, IGNORE_DIRS
- 상세 설명: 각 디렉토리의 `.env.example` 참조

## Pi API 엔드포인트

| Method | Path | Auth | 동작 |
|--------|------|------|------|
| POST | /api/auth | - | PIN → JWT 토큰 발급 |
| GET | /api/status | JWT | Agent 상태 (online/offline, sessions, projects) |
| POST | /api/wake | JWT | WOL 매직패킷 (LAN 브로드캐스트) |
| POST | /api/shutdown | JWT | Agent에 shutdown 전달 |
| POST | /api/run | JWT | Agent에 action 전달 (proj, sleep, hibernate 등) |
| GET | /api/projects | JWT | Agent에서 프로젝트 목록 조회 |

## Agent 엔드포인트

| Method | Path | Auth | 동작 |
|--------|------|------|------|
| GET | /health | - | 상태 확인 (online, uptime) |
| GET | /status | Bearer | 세션+프로젝트+uptime 전체 상태 |
| POST | /verify-pin | - | PIN bcrypt 검증 (Pi relay용) |
| POST | /shutdown | Bearer | 10초 후 shutdown |
| POST | /run | Bearer | 명령 실행 (proj, sleep, hibernate 등) |
| GET | /projects | Bearer | 프로젝트 목록 |

## CAPTCHA 시스템 (dormant)
- 핵심 코드: `agent/router-wol.js` (3-solver: CapSolver + Gemini Flash + GPT-4o-mini)
- 학습 데이터: `agent/.captcha-learned.json`
- 아키텍처 문서: `agent/CAPTCHA-SYSTEM.md`
- 레슨/포인터: `.claude/rules/captcha-lessons.md`
- 솔버 규칙: `.claude/rules/captcha-solver.md`

## Critical Rules
- Agent Bearer 토큰 = `AGENT_SECRET` (Pi↔Agent 인증)
- `.env` 파일 커밋 금지
- 세션 보호 optimistic UI: action 후 35초간 서버 sessions 폴링 무시 (깜빡임 방지)
- CAPTCHA 코드(`router-wol.js`, `router-js/`, `.captcha-learned.json`, `CAPTCHA-SYSTEM.md`) 삭제 금지 — dormant 보존

## UI 아이콘 인덱스 (모두 SVG)

### 메인
| 아이콘 | 위치 | 동작 |
|--------|------|------|
| Power (SVG) | 메인 (큰 원) | OFF→WOL 매직패킷, ON→Shutdown (confirm) |

### Quick Actions (온라인 시 표시)
| 아이콘 | 색상 | 이름 | 동작 |
|--------|------|------|------|
| Snowflake | 파랑 | Power Menu | Sleep + Hibernate 드롭다운 |
| Terminal | 파랑 (badge: 세션수) | Sessions | 세션 관리 드롭다운 |
| Folder | 앰버 | Projects | 프로젝트 열기 드롭다운 |

### 하단
| 아이콘 | 위치 | 동작 |
|--------|------|------|
| ? | 좌하단 | 인앱 도움말 패널 토글 |
| log | 우하단 | WOL 전송 로그 패널 토글 |
