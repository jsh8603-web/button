# Button — Wake-on-LAN Web App

모바일에서 집 PC를 원버튼으로 켜고 끄는 웹앱.
Raspberry Pi 하나로 웹 UI + API + WOL을 모두 처리. 외부 서비스(Vercel, Supabase 등) 불필요.

## Architecture

```
[모바일 브라우저] ──HTTPS/HTTP──→ [Raspberry Pi :7777]
                                    ├─ 정적 웹 UI (Next.js 빌드 결과물)
                                    ├─ API 게이트웨이 (인증, WOL, Agent 중개)
                                    └─ WOL 매직패킷 (LAN 브로드캐스트)
                                            │
                                            │ Bearer AGENT_SECRET (HTTP)
                                            ▼
                                   [Windows PC Agent :9876]
                                    ├─ 전원: shutdown, sleep, hibernate, 모니터끄기
                                    ├─ 세션: tmux + Claude Code 자동 실행
                                    └─ 프로젝트: VS Code + Claude 세션 열기
```

**인증 흐름**: PIN 4자리 → Pi가 Agent `/verify-pin`으로 bcrypt 검증 → JWT 발급 → 브라우저 localStorage 저장 (30일)

## 필요한 것

| 항목 | 설명 |
|------|------|
| Raspberry Pi | 모델 무관 (Zero W도 가능). 24시간 켜져있어야 함 |
| Windows PC | Wake-on-LAN 지원 NIC, Node.js 18+ |
| 공유기 | 포트포워딩 설정 가능해야 함 |
| 같은 LAN | Pi와 PC가 동일 서브넷에 있어야 WOL 동작 |

## 디렉토리 구조

```
button/
├── web/                    → Next.js 프론트엔드 (빌드 후 Pi에 배포)
│   ├── src/app/page.tsx    → 메인 UI (PIN 입력 → 대시보드)
│   ├── next.config.ts      → output: "export" (정적 빌드)
│   └── out/                → 빌드 결과물 (gitignore)
│
├── pi/                     → Raspberry Pi 서버
│   ├── wol-server.js       → HTTP 서버 (정적파일 + API + WOL)
│   ├── package.json        → 의존성 없음 (Node.js 내장 모듈만 사용)
│   ├── env.example         → 환경변수 템플릿
│   ├── setup.sh            → systemd 서비스 자동 등록 스크립트
│   └── public/             → 빌드된 정적 파일 (Pi에서만 존재, gitignore)
│
└── agent/                  → Windows PC Agent
    ├── server.js           → Express 서버 (명령 실행)
    ├── package.json        → 의존성: express, cors, bcrypt, dotenv
    ├── .env.example        → 환경변수 템플릿
    ├── install.bat          → Task Scheduler 등록 (부팅 시 자동 실행)
    ├── add-firewall.bat     → 방화벽 포트 허용
    ├── enable-autologin.bat → Windows 자동 로그인 설정
    ├── kill-sessions.sh     → tmux 세션 정리 (bash)
    ├── close-window.ps1     → VS Code 창 닫기 (PowerShell)
    └── maximize-window.ps1  → VS Code 창 최대화 (PowerShell)
```

## Setup Guide

### Step 1: 환경변수 생성

Pi와 Agent가 공유하는 시크릿 2개를 먼저 생성합니다.

```bash
# 1) AGENT_SECRET (Pi ↔ Agent 인증 토큰)
openssl rand -hex 32
# → 예: a1b2c3d4e5f6...

# 2) PIN_HASH (사용자 인증용 PIN의 bcrypt 해시)
#    Node.js로 생성 (원하는 4자리 PIN으로 변경):
node -e "require('bcrypt').hash('1234', 10).then(h => console.log(h))"
# → 예: $2b$10$ARp6X6Cry...

# 3) JWT_SECRET (Pi에서 JWT 서명용)
openssl rand -hex 32
# → 예: f7e8d9c0b1a2...
```

### Step 2: PC 하드웨어 설정 (Wake-on-LAN)

1. **BIOS 설정**:
   - `Wake on PCI-E` 또는 `Wake on LAN` → **Enabled**
   - `Deep Sleep` → **Disabled** (일부 보드에서 WOL 차단)

2. **Windows NIC 설정**:
   - 장치 관리자 → 네트워크 어댑터 → 속성
   - **전원 관리**: "이 장치가 컴퓨터를 깨울 수 있음" 체크
   - **고급**: `Wake on Magic Packet` → **Enabled**

3. **PC MAC 주소 확인**:
   ```cmd
   ipconfig /all
   ```
   → 유선 어댑터의 "물리적 주소" (예: `AA-BB-CC-DD-EE-FF` → `AA:BB:CC:DD:EE:FF`로 변환)

4. **Windows 자동 로그인** (WOL 후 잠금화면 없이 바로 사용):
   ```cmd
   :: 관리자 CMD에서 실행
   cd agent && enable-autologin.bat
   ```

### Step 3: Agent 설치 (Windows PC)

```bash
cd agent
npm install
cp .env.example .env
```

`.env` 편집:
```env
PORT=9876
PIN_HASH=$2b$10$여기에_Step1에서_생성한_해시
AGENT_SECRET=여기에_Step1에서_생성한_토큰

# 프로젝트 관리 (선택)
PROJECTS_DIR=D:\projects
EDITOR_CMD=C:\Users\사용자\AppData\Local\Programs\Microsoft VS Code\Code.exe
EDITOR_TITLE=Visual Studio Code
BASH_PATH=C:\msys64\usr\bin\bash.exe
CLAUDE_BIN=C:\Users\사용자\.claude\local\claude.exe
CLAUDE_MODEL=opus

# 프로젝트 목록에서 제외할 디렉토리
IGNORE_DIRS=node_modules,screenshots
```

방화벽 + 자동 시작 등록 (관리자 CMD):
```cmd
cd agent
add-firewall.bat
install.bat
```

실행 확인:
```bash
node server.js
# → "Button Agent listening on port 9876"
# → "[agent] Ready — waiting for commands from Pi relay"
```

### Step 4: Web 빌드

```bash
cd web
npm install
NEXT_PUBLIC_API_URL="" npm run build
# → out/ 디렉토리에 정적 파일 생성
```

> `NEXT_PUBLIC_API_URL=""`은 same-origin 요청을 위해 필수. Pi가 UI와 API를 같은 포트에서 서빙하므로 빈 문자열로 설정.

### Step 5: Pi 설치

```bash
# PC에서 Pi로 파일 전송
PI_IP=192.168.219.125   # ← Pi의 LAN IP로 변경

# 서버 코드 전송
scp pi/wol-server.js pi/package.json pi/env.example pi/setup.sh pi@$PI_IP:~/wol-relay/

# 빌드된 웹 UI 전송
tar czf /tmp/public.tar.gz -C web/out .
scp /tmp/public.tar.gz pi@$PI_IP:~/wol-relay/
ssh pi@$PI_IP "cd ~/wol-relay && mkdir -p public && tar xzf public.tar.gz -C public && rm public.tar.gz"
```

Pi에서 `.env` 설정:
```bash
ssh pi@$PI_IP
cd ~/wol-relay
cp env.example .env
nano .env
```

```env
PORT=7777
AGENT_SECRET=여기에_Step1에서_생성한_토큰    # Agent와 동일해야 함
PC_MAC=AA:BB:CC:DD:EE:FF                     # Step 2에서 확인한 MAC
BROADCAST=192.168.219.255                     # LAN 브로드캐스트 (보통 .255)
AGENT_HOST=192.168.219.100                    # PC의 LAN IP
AGENT_PORT=9876
PIN_HASH=$2b$10$여기에_Step1에서_생성한_해시   # Agent와 동일해야 함
JWT_SECRET=여기에_Step1에서_생성한_JWT시크릿
```

systemd 서비스 등록 + 시작:
```bash
cd ~/wol-relay && bash setup.sh
# → "Active: active (running)" 확인
```

### Step 6: 네트워크 (공유기)

공유기 관리 페이지에서 **포트포워딩** 설정:

| 외부 포트 | 내부 IP | 내부 포트 | 프로토콜 |
|-----------|---------|-----------|---------|
| 7777 | Pi LAN IP (예: 192.168.219.125) | 7777 | TCP |

> Agent 포트(9876)는 포워딩 불필요 — Pi가 LAN에서 직접 접근.

### Step 7: 접속 확인

```bash
# Pi 헬스체크
curl http://PI_IP:7777/health
# → {"ok":true,"uptime":...}

# Agent 헬스체크 (PC에서)
curl http://localhost:9876/health
# → {"status":"online","uptime":...}

# 외부 접속 (모바일)
# → http://공인IP:7777 또는 DDNS 도메인
```

브라우저에서 PIN 4자리 입력 → 대시보드 진입.

## 기능

### 메인 버튼
| 상태 | 동작 |
|------|------|
| PC OFF (빨간색) | WOL 매직패킷 전송 → PC 부팅 |
| PC ON (초록색) | Shutdown (확인 후 10초 후 종료) |

### Power Menu (Snowflake 아이콘)
| 항목 | 동작 |
|------|------|
| Monitor Off | 모니터만 끄기 |
| Sleep | 즉시 절전 |
| Sleep 1h / 2h | 예약 절전 |
| Hibernate | 즉시 최대절전 |
| Hibernate 1h / 2h | 예약 최대절전 |

예약된 작업은 PC 재부팅 후에도 유지됩니다 (`.hibernate-schedule` 파일로 영속화).

### Sessions (Terminal 아이콘)
- tmux 세션 목록 확인
- Shield 아이콘: 세션 보호/해제 (보호된 세션은 프로젝트 열기 시에도 유지)
- X 아이콘: 세션 종료

### Projects (Folder 아이콘)
- 프로젝트 목록 (PROJECTS_DIR 하위 디렉토리)
- 클릭 시: VS Code + tmux + Claude Code 자동 실행
- "+ New Repo": 새 프로젝트 디렉토리 생성 + 열기

## 재배포 (코드 수정 후)

```bash
# 1. 웹 빌드
cd web && NEXT_PUBLIC_API_URL="" npm run build

# 2. Pi 배포
tar czf /tmp/public.tar.gz -C out .
scp /tmp/public.tar.gz pi@PI_IP:~/wol-relay/
ssh pi@PI_IP "cd ~/wol-relay && tar xzf public.tar.gz -C public && rm public.tar.gz && sudo systemctl restart wol-relay"

# 3. Agent 재시작 (server.js 수정 시)
# PC에서 Task Manager로 node.exe 종료 후 재실행, 또는:
taskkill /F /FI "WINDOWTITLE eq ButtonAgent" && node agent/server.js
```

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| WOL 안 됨 | BIOS WOL 비활성 | BIOS에서 Wake on PCI-E 활성화 |
| WOL 안 됨 | NIC 설정 누락 | 장치관리자 → NIC → Wake on Magic Packet 활성화 |
| WOL 안 됨 | MAC 주소 오류 | `ipconfig /all`로 재확인, 유선 어댑터 사용 |
| Agent 연결 실패 | 방화벽 차단 | `add-firewall.bat` 실행 |
| Agent 연결 실패 | PC IP 변경 | 공유기에서 PC에 고정 IP 할당 |
| PIN 거부 | 해시 불일치 | Pi와 Agent의 PIN_HASH가 동일한지 확인 |
| 외부 접속 안 됨 | 포트포워딩 미설정 | 공유기에서 7777 → Pi IP 포워딩 |
| Shutdown 후 WOL 안 됨 | 완전 종료 | Hibernate 사용 권장 (전원 완전 차단 시 WOL 불가한 보드 있음) |

## License

MIT
