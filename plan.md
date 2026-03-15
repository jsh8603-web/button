# Button — WOL Web App

모바일(LTE)에서 집 PC를 Wake-on-LAN으로 켜고/끄는 원버튼 웹앱.
부팅 후 Antigravity(VS Code 포크) + Claude Code tmux 세션 자동 셋업 포함.

## 기술스택

| 레이어 | 선택 | 이유 |
|--------|------|------|
| Frontend + API | Next.js 16 (App Router) + Tailwind CSS v4 | Vercel 무료 호스팅, API Route에서 UDP 전송 |
| 호스팅 | Vercel (Hobby) | 무료, HTTPS 자동, 서버리스 |
| PC Agent | Node.js + Express 4 | Windows 서비스로 상주, 명령 수신/실행 |
| 인증 | 4자리 PIN → bcrypt 검증 → JWT 쿠키 (24h) | 단순, 본인만 사용 |
| 에디터 | Antigravity (VS Code 포크) | `D:\projects\Antigravity\bin\antigravity.cmd` |

## 아키텍처

```
[모바일 브라우저]
       │
       ▼
[Vercel (Next.js)]  ← 항상 접근 가능 (https://web-eight-roan-40.vercel.app)
  ├─ POST /api/wake     → UDP Magic Packet → 공인IP:9 → 라우터 → 브로드캐스트 → NIC
  ├─ POST /api/shutdown → HTTP → 공인IP:9876 → 라우터 → PC Agent → shutdown /s /t 5
  ├─ GET  /api/status   → HTTP → 공인IP:9876 → PC Agent → health check (3초 timeout)
  ├─ POST /api/run      → HTTP → 공인IP:9876 → PC Agent → 앱/명령 실행
  └─ GET  /api/projects → HTTP → 공인IP:9876 → PC Agent → D:\projects 디렉토리 목록
       │
[라우터 (192.168.219.1)]
  ├─ UDP 9    → 192.168.219.255 (브로드캐스트)
  └─ TCP 9876 → 192.168.219.102 (PC Agent)
       │
[PC (192.168.219.102)]
  ├─ NIC: Realtek 2.5GbE (RTL8125), MAC 74-56-3C-CD-C9-FB
  ├─ WOL: Magic Packet + Shutdown WOL Enabled
  └─ Agent: Express on :9876 (Task Scheduler, SYSTEM 계정)
```

## 파일 구조

```
web/                          → Next.js 웹앱 (Vercel 배포)
  src/
    app/
      layout.tsx              → 루트 레이아웃 (viewport, theme)
      page.tsx                → 메인 페이지 (PinEntry → Dashboard)
      globals.css             → Tailwind + glow 애니메이션 키프레임
      api/
        auth/route.ts         → PIN 검증 → JWT 쿠키 발급
        wake/route.ts         → dgram UDP Magic Packet 전송
        status/route.ts       → Agent /health 프록시 (3초 timeout)
        shutdown/route.ts     → Agent /shutdown 프록시 (5초 timeout)
        run/route.ts          → Agent /run 프록시 (5초 timeout)
        projects/route.ts     → Agent /projects 프록시 (5초 timeout)
    lib/
      auth.ts                 → bcrypt PIN 검증 + JWT 생성/검증
    middleware.ts             → JWT 쿠키 검증 (/api/* 보호, /api/auth 제외)

agent/                        → PC Agent (Express, port 9876)
  server.js                   → 메인 서버 (모든 엔드포인트 + 프로젝트 관리)
  close-window.ps1            → Antigravity 창 닫기 (Win32 EnumWindows + WM_CLOSE)
  maximize-window.ps1         → Antigravity 창 최대화 (Win32 ShowWindow, 10초 대기)
  kill-sessions.sh            → btn-* tmux 세션 정리 (Ctrl+C → /exit → kill-server)
  install.bat                 → Task Scheduler 등록 (SYSTEM, onstart)
  enable-autologin.bat        → Windows 자동 로그인 레지스트리 설정
```

## 환경변수

### Vercel (`web/.env.local`)
```
PIN_HASH=<bcrypt hash of 4-digit PIN>
JWT_SECRET=<random 32 char string>
PC_HOST=<공인 IP: 125.248.17.75>
PC_PORT=9876
PC_MAC=74:56:3C:CD:C9:FB
WOL_PORT=9
AGENT_PIN=<평문 4자리 PIN — Agent가 bcrypt.compare>
```

### PC Agent (`agent/.env`)
```
PORT=9876
PIN_HASH=<bcrypt hash>
ALLOWED_ORIGIN=<Vercel URL>
```

## 웹앱 상세

### 인증 흐름
1. 첫 방문 → `/api/status` 호출로 기존 JWT 쿠키 유효성 확인
2. 미인증 → `PinEntry` 렌더링 (4칸 숫자 입력, 마지막 자릿수 입력 시 자동 submit)
3. `POST /api/auth` → bcrypt 검증 → JWT 쿠키 발급 (httpOnly, secure, sameSite strict, 24h)
4. Rate limiting: IP별 5회 실패 → 60초 잠금 (서버 인메모리 Map)

### 대시보드 UI
```
┌──────────────────────────┐
│                          │
│     ┌──────────────┐     │
│     │              │     │  ← Power Button (120×120px 원형)
│     │   ◉ POWER    │     │     online: green glow
│     │              │     │     offline: red glow
│     └──────────────┘     │     waking/shutting-down: amber pulse
│                          │
│       PC is ON           │  ← 상태 텍스트
│     Checked 5s ago       │  ← 마지막 확인 (1초마다 갱신)
│                          │
│     [🚀] [📂]            │  ← Quick Actions (online일 때만 표시)
│                          │     🚀 Antigravity, 📂 프로젝트 선택
│     ┌──────────────┐     │
│     │ + New Repo   │     │  ← 프로젝트 드롭다운 (📂 클릭 시)
│     │ babyplace    │     │     새 레포 이름 입력 가능
│     │ button       │     │
│     │ excel        │     │
│     └──────────────┘     │
│                          │
│                    [log] │  ← Wake 로그 (우하단, localStorage 최대 10개)
└──────────────────────────┘
```

### 상태 폴링
- 기본: 10초 간격 (`/api/status`)
- 전환 중 (waking/shutting-down): 3초 간격
- waking 타임아웃: 30초 후 offline 복귀
- shutting-down 타임아웃: 15초 후 online 복귀
- 전환 상태에서는 상태 폴링 결과로 덮어쓰지 않음

### Wake 로그
- `localStorage`에 JSON 배열로 저장 (key: `wake-logs`, 최대 10개)
- API 응답의 `log` 객체를 flat하게 저장 (timestamp, result, step, error 등)
- 우하단 `[log]` 버튼으로 토글

## PC Agent 상세

### 엔드포인트

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/health` | 없음 | `{ status: "online", uptime }` |
| POST | `/shutdown` | PIN | `shutdown /s /t 5` 실행, rate limit 3/분 |
| GET | `/projects` | PIN | `D:\projects` 디렉토리 목록 (필터링 적용) |
| POST | `/run` | PIN | 화이트리스트 명령 실행 |

### PIN 검증
- `x-pin-hash` 헤더로 평문 PIN 수신 → `bcrypt.compare(pin, PIN_HASH)`
- Rate limiting: 5회 실패 → 60초 잠금 (인메모리 배열)

### /run 액션 (화이트리스트)

| action | 동작 | 상세 |
|--------|------|------|
| `antigravity` | Antigravity 앱 실행 | PowerShell `Start-Process shell:AppsFolder\Google.Antigravity -WindowStyle Maximized` |
| `proj` | 프로젝트를 Antigravity로 열기 | `openProjectInAntigravity(name)` — 아래 절차 참조 |

### 프로젝트 열기 절차 (`openProjectInAntigravity`)

1. **이전 세션 정리** (`killExistingSessions`)
   - `kill-sessions.sh` 실행: btn-* tmux 세션에 Ctrl+C → `/exit` → `tmux kill-server`
   - `close-window.ps1` 실행: 이전 프로젝트 Antigravity 창에 WM_CLOSE 전송
2. **tasks.json 생성** (`buildTasksJson`)
   - 프로젝트 `.vscode/tasks.json`에 `claude-tmux` 태스크 작성
   - 셸: MSYS2 bash (`C:\msys64\usr\bin\bash.exe -l -c`)
   - `folderOpen` 시 자동 실행: tmux 세션(`btn-{name}`) 생성 → Claude Code 시작 → `/remote-control` 진입
3. **Antigravity 실행** (1초 대기 후)
   - `antigravity.cmd "{projDir}"` 실행
   - `maximize-window.ps1` 실행: 창 타이틀로 Antigravity 창 찾아 최대화 (최대 10초 대기)

### 프로젝트 필터링
- `D:\projects` 하위 디렉토리만 표시
- 제외: `.` 접두사, `_` 접두사, `Antigravity`, `_Global_Orchestrator`, `node_modules`, `screenshots`
- 이름 검증: `/^[a-zA-Z0-9_-]+$/`

### PowerShell 스크립트

**close-window.ps1** — Antigravity 창 닫기
- `EnumWindows`로 `"{TitlePrefix} - Antigravity"` 제목 매칭
- `PostMessage(WM_CLOSE)`로 안전하게 닫기 (프로세스 kill 아님)

**maximize-window.ps1** — Antigravity 창 최대화
- 최대 10초간 500ms 간격으로 폴링
- `EnumWindows`로 `"{TitlePrefix}"` + `"Antigravity"` 포함 창 검색
- `ShowWindow(SW_MAXIMIZE)`로 최대화

### Shell 스크립트

**kill-sessions.sh** — tmux 세션 정리
- `btn-*` 패턴 세션에 `Ctrl+C` 전송 (1초 대기)
- `/exit` 전송으로 Claude Code remote 세션 해제 (2초 대기)
- `tmux kill-server`로 전체 정리

## 보안

- Agent: 화이트리스트 명령만 실행, 임의 명령 금지
- Agent: PIN bcrypt 검증 + rate limiting (인증 5/분, shutdown 3/분)
- Web: JWT httpOnly 쿠키, secure + sameSite strict
- Web: middleware에서 모든 `/api/*` 보호 (`/api/auth` 제외)
- `.env` 파일 커밋 금지

## 배포

- **Vercel**: `https://web-eight-roan-40.vercel.app`
- **Project ID**: `prj_3BrHwOBIQFaELkM1HeIUTIMOn31G`
- **GitHub**: `https://github.com/jsh8603-web/button`
- **Agent**: `install.bat` → Task Scheduler (`ButtonAgent`, SYSTEM, onstart)
- **자동 로그인**: `enable-autologin.bat` → WOL 부팅 후 자동 데스크톱 진입
