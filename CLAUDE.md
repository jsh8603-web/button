# Button — WOL Web App

## Summary

모바일에서 집 PC를 원버튼으로 켜고 끄는 웹앱.
Vercel에 호스팅된 Next.js 앱이 Wake-on-LAN 매직 패킷을 직접 전송하고,
PC에 상주하는 Agent가 30초마다 heartbeat를 보내 온라인 상태와 명령(shutdown/프로젝트 열기)을 Supabase KV로 주고받는다.
브라우저에서 4자리 PIN을 입력하면 JWT 쿠키가 발급되어 이후 API 호출이 인증된다.

```
[모바일 브라우저] → [Vercel Next.js API] ←→ [Supabase KV] ←→ [PC Agent]
                         │                                         │
                    WOL: UDP 매직 패킷 직접 전송            30초 heartbeat 루프
                    그 외: KV에 command 저장               KV에서 command pull → 실행
```

## 아키텍처 (Heartbeat Push Model)

- Web↔Agent 직접 통신 없음: Supabase KV를 매개로 비동기 통신
- WOL만 예외: Vercel에서 직접 UDP Magic Packet 전송 (dgram)
- Agent는 heartbeat 응답으로 대기 명령을 수신하고, 실행 후 KV에서 삭제 (1회 실행 보장)

## 구조
```
web/                          → Next.js 웹앱 (Vercel 배포)
  src/app/
    layout.tsx                → 루트 레이아웃 (viewport, theme-color)
    page.tsx                  → 메인 페이지 (PinEntry → Dashboard)
    globals.css               → Tailwind v4 + glow 애니메이션 키프레임
    api/
      auth/route.ts           → PIN → bcrypt 검증 → JWT 쿠키 발급 (24h, httpOnly)
      heartbeat/route.ts      → Agent 상태 수신 + 대기 명령 반환 (Bearer 인증)
      status/route.ts         → KV에서 heartbeat 읽기 (90초 이내 → online)
      wake/route.ts           → dgram UDP Magic Packet 전송 (DNS resolve 포함)
      shutdown/route.ts       → KV에 shutdown 명령 저장 (TTL 120초)
      run/route.ts            → KV에 action 명령 저장 (proj/editor)
      projects/route.ts       → KV에서 프로젝트 목록 캐시 읽기
  src/lib/
    auth.ts                   → bcrypt PIN 검증 + JWT 생성/검증
    kv.ts                     → Supabase KV 클라이언트 (kvGet/kvSet/kvDel)
  middleware.ts               → JWT 구조 검증 (Edge Runtime, /api/auth·heartbeat 제외)

agent/                        → PC Agent (Express, Windows 서비스)
  server.js                   → 메인 서버 + heartbeat 루프 + 프로젝트 관리
  close-window.ps1            → 윈도우 창 닫기 (Win32 EnumWindows + WM_CLOSE)
  maximize-window.ps1         → 윈도우 창 최대화 (Win32 ShowWindow, 폴링)
  kill-sessions.sh            → btn-* tmux 세션 정리 (Ctrl+C → /exit → kill)
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
- `web/.env.local`: PIN_HASH, JWT_SECRET, PC_HOST, PC_MAC, WOL_PORT, AGENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
- `agent/.env`: PORT, PIN_HASH, ALLOWED_ORIGIN, VERCEL_URL, AGENT_SECRET, PROJECTS_DIR, EDITOR_CMD, BASH_PATH, CLAUDE_BIN, IGNORE_DIRS
- 상세 설명: 각 디렉토리의 `.env.example` 참조

## Critical Rules
- Agent 화이트리스트 명령만 실행: `shutdown`, `proj`, `editor`
- `.env` 파일 커밋 금지
- `x-pin-hash`에는 평문 PIN 전송 → Agent가 bcrypt.compare
- Heartbeat Bearer 토큰 = `AGENT_SECRET` (Agent↔Vercel 인증)
- KV TTL: heartbeat 90초, projects 300초, command 120초
- middleware는 JWT 서명 검증 없이 구조+만료만 체크 (Edge Runtime 호환)
