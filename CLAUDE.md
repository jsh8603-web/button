# Button — WOL Web App

## Summary

모바일에서 집 PC를 원버튼으로 켜고 끄는 웹앱.
Raspberry Pi가 웹 UI + API를 모두 서빙하고, LAN에서 WOL + Agent 명령을 중개한다.
외부 의존성 없음 (Vercel, Supabase 등 미사용).

```
[모바일 브라우저] → [Caddy :443 HTTPS] → [Pi wol-server :7777] ← 웹 UI + API + WOL
                                                ↓ (Bearer AGENT_SECRET)
                                          [PC Agent :9876] ← 명령 실행 (즉시 응답, ~500ms)
```

## 아키텍처 (Pi All-in-One)

- **Pi = 웹 서버 + API 게이트웨이**: 정적 파일 서빙 + PIN 인증(JWT) + WOL + Agent 중개
- **Agent = 명령 실행기**: Express 서버, Pi로부터 HTTP 요청 받아 즉시 실행 + 메트릭 수집 + 태스크 큐
- **인증**: PIN → Pi가 Agent `/verify-pin`으로 검증 → JWT 발급 → 브라우저 localStorage
- **WOL**: Pi가 LAN에서 UDP 매직패킷 직접 전송
- **HTTPS**: Caddy 리버스 프록시 (Let's Encrypt 자동 갱신)
- **DDNS**: DuckDNS (`jsh-button.duckdns.org`) — 5분마다 IP 자동 갱신
- **반응 속도**: ~500ms (직접 HTTP, heartbeat 폴링 없음)

## 접속 URL

- **외부 (모바일 데이터)**: `https://jsh-button.duckdns.org`
- **LAN**: `http://192.168.219.125:7777` (헤어핀 NAT 미지원)

## 구조
```
web/                          → Next.js 소스 (빌드 후 Pi에 배포)
  src/app/
    layout.tsx                → 루트 레이아웃 (viewport, theme-color)
    page.tsx                  → 메인 페이지 (PinEntry → Dashboard, SVG 아이콘)
    globals.css               → Tailwind v4 + glow 애니메이션 키프레임

pi/                           → Raspberry Pi (웹 + API + WOL + 스케줄러)
  wol-server.js               → HTTP 서버 (정적 파일 + 인증 + WOL + Agent 중개 + 스케줄러 + 경고)
  schedules.json              → 전원 예약 목록 (영속 파일)
  public/                     → 빌드된 정적 파일 (web/out/ 복사본)
  setup.sh                    → systemd 서비스 등록 스크립트
  duckdns-setup.sh            → DuckDNS 자동 업데이트 설정
  caddy-setup.sh              → Caddy HTTPS 리버스 프록시 설정

agent/                        → PC Agent (Express, Windows 서비스)
  server.js                   → Express 서버 (상태/명령/메트릭/태스크 큐)
  .task-queue.json            → 태스크 큐 (영속 파일)
  .protected-sessions         → 보호된 세션 목록 (JSON, 재시작 시에도 유지)
  .hibernate-schedule         → 예약 hibernate 영속 파일 (재부팅 시 복원)
  close-window.ps1            → 윈도우 창 닫기
  maximize-window.ps1         → 윈도우 창 최대화
  kill-sessions.sh            → btn-* tmux 세션 정리
  add-firewall.bat            → Agent 포트 방화벽 규칙 추가
  install.bat                 → Task Scheduler 등록
  enable-autologin.bat        → Windows 자동 로그인 레지스트리 설정
```

CAPTCHA 관련 파일 → §CAPTCHA 시스템 참조 (dormant, 삭제 금지)

## 명령어
```bash
cd web && npm run build              # 정적 빌드 (out/ 생성)
cd web && npm run dev                # 로컬 개발
cd agent && npm install && node server.js  # Agent 실행
ssh pi@192.168.219.125               # Pi 접속 (SSH 키 등록됨)
```

## 배포 (커밋 후 변경 대상에 따라 자동 실행)

커밋/푸시 완료 후, 변경된 디렉토리 기준으로 아래를 실행한다.
복수 대상 변경 시 모두 수행. **배포/재실행까지 완료해야 커밋 완료.**

### web/ 변경 시 (빌드 + Pi 배포)
```bash
cd web && NEXT_PUBLIC_API_URL="" npx next build
tar czf /tmp/public.tar.gz -C out .
scp /tmp/public.tar.gz pi@192.168.219.125:~/wol-relay/
ssh pi@192.168.219.125 "cd ~/wol-relay && tar xzf public.tar.gz -C public && rm public.tar.gz && sudo systemctl restart wol-relay"
```

### pi/ 변경 시 (Pi 배포)
```bash
scp pi/wol-server.js pi@192.168.219.125:~/wol-relay/wol-server.js
ssh pi@192.168.219.125 "sudo systemctl restart wol-relay"
```

### agent/ 변경 시 (Agent 재실행)
```bash
# 포트 9876 프로세스 kill → 재실행
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 9876).OwningProcess -Force"
cd agent && node server.js &
```

## wf 빌드/테스트
1. `cd web && npm run build` — 빌드 확인
2. 수동 테스트: 브라우저에서 PIN 입력 → 버튼 동작 확인

## 환경변수
- `pi/.env`: PORT, AGENT_SECRET, PC_MAC, BROADCAST, AGENT_HOST, AGENT_PORT, PIN_HASH, JWT_SECRET
- `agent/.env`: PORT, PIN_HASH, ALLOWED_ORIGIN, AGENT_SECRET, PROJECTS_DIR, EDITOR_CMD, EDITOR_TITLE, BASH_PATH, CLAUDE_BIN, CLAUDE_MODEL, IGNORE_DIRS
- 상세 설명: 각 디렉토리의 `.env.example` 참조

## Pi 엔드포인트

| Method | Path | Auth | 동작 |
|--------|------|------|------|
| GET | / | - | 웹 UI (정적 파일) |
| GET | /health | - | 헬스체크 |
| POST | /api/auth | - | PIN → JWT 토큰 발급 |
| GET | /api/status | JWT | Agent 상태 (online/offline, metrics, alerts, sessions) |
| POST | /api/wake | JWT | WOL 매직패킷 (LAN 브로드캐스트) |
| POST | /api/shutdown | JWT | Agent에 shutdown 전달 |
| POST | /api/run | JWT | Agent에 action 전달 (proj, sleep, hibernate 등) |
| GET | /api/projects | JWT | Agent에서 프로젝트 목록 조회 |
| GET/POST/DELETE/PATCH | /api/schedules | JWT | 전원 예약 CRUD |
| GET/POST/DELETE | /api/wake-at | JWT | 일회성 WOL 타이머 (delayMinutes 또는 at) |

## Agent 엔드포인트

| Method | Path | Auth | 동작 |
|--------|------|------|------|
| GET | /health | - | 상태 확인 (online, uptime) |
| GET | /status | Bearer | 세션+프로젝트+metrics+uptime 전체 상태 |
| POST | /verify-pin | - | PIN bcrypt 검증 (Pi용) |
| POST | /shutdown | Bearer | 10초 후 shutdown |
| POST | /run | Bearer | 명령 실행 (proj, sleep, hibernate, task-add/list/cancel/log 등) |
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
- 세션 보호 optimistic UI: action 후 35초간 서버 sessions 폴링 무시
- CAPTCHA 코드 삭제 금지 — dormant 보존

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
