# Button — WOL Web App

## Summary

모바일에서 집 PC를 원버튼으로 켜고 끄는 웹앱.
Vercel에 호스팅된 Next.js 앱이 Wake-on-LAN 매직 패킷을 직접 전송하고,
PC에 상주하는 Agent가 30초마다 heartbeat를 보내 온라인 상태와 명령을 Supabase KV로 주고받는다.
브라우저에서 4자리 PIN을 입력하면 JWT 쿠키가 발급되어 이후 API 호출이 인증된다.

```
[모바일 브라우저] → [Vercel Next.js API] ←→ [Supabase KV] ←→ [PC Agent]
                         │                                         │
                    WOL: UDP 직접 + 공유기 API 이중 전송   30초 heartbeat 루프
                    그 외: KV에 command 저장               KV에서 command pull → 실행
```

## 아키텍처 (Heartbeat Push Model)

- Web↔Agent 직접 통신 없음: Supabase KV를 매개로 비동기 통신
- WOL 이중 전송: ① Vercel에서 직접 UDP Magic Packet (Shutdown용) ② 공유기 WOL API 호출 (Sleep/Hibernate용, port 88)
- 공유기 세션 유지: Agent 부팅 시 KV 쿠키 복원(유효→CAPTCHA 스킵) → pg_cron 5분마다 keep-alive → 세션 영구 유지
- Sleep/Hibernate 전: 쿠키 유효성 확인 후 KV에 24h TTL로 저장 (CAPTCHA 재풀이 불필요)
- Agent는 heartbeat 응답으로 대기 명령을 수신하고, 실행 후 KV에서 삭제 (1회 실행 보장)
- Heartbeat에 `sessions: [{name, protected}]` 포함 → 웹 UI에서 세션 관리

## 구조
```
web/                          → Next.js 웹앱 (Vercel 배포)
  src/app/
    layout.tsx                → 루트 레이아웃 (viewport, theme-color)
    page.tsx                  → 메인 페이지 (PinEntry → Dashboard, SVG 아이콘 컴포넌트)
    globals.css               → Tailwind v4 + glow 애니메이션 키프레임
    api/
      auth/route.ts           → PIN → bcrypt 검증 → JWT 쿠키 발급 (24h, httpOnly)
      heartbeat/route.ts      → Agent 상태+sessions 수신 + 대기 명령 반환 + KV 쿠키 복원 (Bearer 인증)
      status/route.ts         → KV에서 heartbeat 읽기 (45초 이내 → online, sessions 포함)
      wake/route.ts           → UDP 매직패킷 + 공유기 WOL API 이중 전송 (Sleep/Shutdown 모두 대응)
      shutdown/route.ts       → KV에 shutdown 명령 저장 (TTL 120초)
      run/route.ts            → KV에 action 명령 저장 (모든 action 공통)
      projects/route.ts       → KV에서 프로젝트 목록 캐시 읽기
      cron/router-keepalive/route.ts → 공유기 세션 keep-alive (Vercel Cron 30분)
  src/lib/
    auth.ts                   → bcrypt PIN 검증 + JWT 생성/검증
    kv.ts                     → Supabase KV 클라이언트 (kvGet/kvSet/kvDel, SessionInfo/Heartbeat 타입)
  middleware.ts               → JWT 구조 검증 (Edge Runtime, /api/auth·heartbeat 제외)

agent/                        → PC Agent (Express, Windows 서비스)
  server.js                   → 메인 서버 + heartbeat 루프 + 세션 보호 + 프로젝트 관리
  .protected-sessions         → 보호된 세션 목록 (JSON, 재시작 시에도 유지)
  close-window.ps1            → 윈도우 창 닫기 (Win32 EnumWindows + WM_CLOSE)
  maximize-window.ps1         → 윈도우 창 최대화 (Win32 ShowWindow, 폴링)
  kill-sessions.sh            → btn-* tmux 세션 정리 (Ctrl+C → /exit → kill, 세션명 인자)
  add-firewall.bat            → Agent 포트 방화벽 규칙 추가
  install.bat                 → Task Scheduler 등록 (SYSTEM, onstart)
  enable-autologin.bat        → Windows 자동 로그인 레지스트리 설정

supabase/migrations/          → agent_kv 테이블 생성 SQL (RLS 적용)
```

## 명령어
```bash
cd web && npm install         # 웹 의존성 설치
cd web && npm run dev         # 로컬 개발
cd web && npm run build       # 빌드
cd agent && npm install       # Agent 의존성 설치
cd agent && node server.js    # Agent 실행
```

## wf 빌드/테스트
1. `cd web && npm run build` — 빌드 확인
2. 수동 테스트: 브라우저에서 PIN 입력 → 버튼 동작 확인

## 환경변수
- `web/.env.local`: PIN_HASH, JWT_SECRET, PC_HOST, PC_MAC, WOL_PORT, AGENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ROUTER_PASSWORD
- `Vercel env (Production)`: 위 항목 + CRON_SECRET (Supabase pg_cron keep-alive 인증)
- `agent/.env`: PORT, PIN_HASH, ALLOWED_ORIGIN, VERCEL_URL, AGENT_SECRET, PROJECTS_DIR, EDITOR_CMD, EDITOR_TITLE, BASH_PATH, CLAUDE_BIN, CLAUDE_MODEL, IGNORE_DIRS, ANTHROPIC_API_KEY, ROUTER_PASSWORD, CAPTCHA_API_KEY, OPENAI_API_KEY
- 상세 설명: 각 디렉토리의 `.env.example` 참조

## Supabase
- 프로젝트: `aocsyodhcdvhkspfpbyj` (babyplace, Seoul region)
- 테이블: `agent_kv` (key-value store, RLS 적용)
- Extensions: `pg_cron` + `pg_net` (라우터 세션 keep-alive용)
- pg_cron job: `router-keepalive` — 5분마다 `/api/cron/router-keepalive` 호출 → 공유기 세션 영구 유지
- 관리: `npx supabase db query --linked "SELECT * FROM cron.job;"`

## CAPTCHA 시스템
- 핵심 코드: `agent/router-wol.js` (3-solver: CapSolver ~69% + Claude Opus + GPT-4o-mini)
- 학습 데이터: `agent/.captcha-learned.json`
- keepAlive 엔드포인트: `/web/main.html` (inner_data.html은 port 80에서 빈 응답)
- **CAPTCHA는 1회용**: 첫 오답 후 무효화됨 → 같은 CAPTCHA로 재시도 불가 → POST는 최고 점수 1회만 시도

## Critical Rules
- Agent 화이트리스트 명령만 실행: `shutdown`, `proj`, `editor`, `protect-session`, `unprotect-session`, `kill-session`, `sleep`, `hibernate`, `display_off`, `captcha-fetch`, `captcha-answer`, `captcha-close`
- `.env` 파일 커밋 금지
- `x-pin-hash`에는 평문 PIN 전송 → Agent가 bcrypt.compare
- Heartbeat Bearer 토큰 = `AGENT_SECRET` (Agent↔Vercel 인증)
- KV TTL: heartbeat 45초, projects 300초, command 120초, routerCookie 3600초 (pre-sleep: 86400초)
- middleware는 JWT 서명 검증 없이 구조+만료만 체크 (Edge Runtime 호환)
- heartbeat는 라우터 로그인(CAPTCHA)에 블로킹되면 안 됨: 로그인 진행 중이면 쿠키 null로 즉시 전송
- 세션 보호 optimistic UI: action 후 35초간 서버 sessions 폴링 무시 (깜빡임 방지)
- lpNum: 성공 로그인 카운터, 현재 임계값 30 (초과 시 로그인 중단)
- manualCaptchaMode 중에는 heartbeatKeepAlive/auto-login 전부 skip
- 공유기 동시 로그인 불가: 브라우저 세션 중이면 Agent 로그인 100% 실패 (CAPTCHA 답 무관)
- RSA encrypt 출력은 nVal 길이로 zero-pad 필수 (rsa.js가 leading zero 누락)

## UI 아이콘 인덱스 (모두 SVG)

### 메인
| 아이콘 | 위치 | 동작 |
|--------|------|------|
| ⏻ Power (SVG) | 메인 (큰 원) | OFF→WOL 매직패킷, ON→Shutdown (confirm) |

### Quick Actions (온라인 시 표시, 활성 드롭다운은 색상 하이라이트)
| 아이콘 | 색상 | 이름 | 동작 |
|--------|------|------|------|
| Moon | 보라 | Power Menu | Sleep/Hibernate/Display Off 드롭다운 |
| Terminal | 파랑 (badge: 세션수) | Sessions | 세션 관리 드롭다운 |
| Folder | 앰버 | Projects | 프로젝트 열기 드롭다운. **미보호 세션 전부 kill 후 열기** |

### Power Menu 드롭다운
| 아이콘 | 색상 | 이름 | Windows 명령 |
|--------|------|------|-------------|
| Moon | 보라 | Sleep | `rundll32 powrprof.dll,SetSuspendState` (컨텍스트 유지) |
| Snowflake | 파랑 | Hibernate | `shutdown /h` (최대 절전) |
| MonitorOff | 시안 | Display Off | `SendMessage SC_MONITORPOWER` (모니터만 끔) |

### Sessions 드롭다운
| 아이콘 | 색상 | 동작 |
|--------|------|------|
| Shield (filled + ✓) | 녹색 | 보호 중 — 탭→보호 해제 |
| Shield (outline) | 회색 | 미보호 — 탭→보호 적용 |
| X | 빨강 (미보호만 표시) | 세션 종료 (confirm → tmux+Claude+VSCode kill) |

### Projects 드롭다운
| 표시 | 의미 |
|------|------|
| Shield (filled + ✓) 14px | 프로젝트에 보호된 활성 세션 있음 |
| (아이콘 없음) | 일반 프로젝트 |

### 하단
| 아이콘 | 위치 | 동작 |
|--------|------|------|
| ? | 좌하단 | 인앱 아이콘 도움말 패널 토글 |
| log | 우하단 | WOL 전송 로그 패널 토글 |
