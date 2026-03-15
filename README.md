# Button — Wake-on-LAN Web App

모바일에서 집 PC를 원버튼으로 켜고 끄는 웹앱.

![Architecture](https://img.shields.io/badge/Next.js_16-black?logo=next.js) ![Tailwind](https://img.shields.io/badge/Tailwind_v4-06B6D4?logo=tailwindcss&logoColor=white) ![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?logo=supabase&logoColor=white)

## How It Works

```
[모바일 브라우저] → [Vercel API] ←→ [Supabase KV] ←→ [PC Agent]
```

1. **Wake**: Vercel에서 UDP Magic Packet을 직접 전송하여 PC 부팅
2. **Status**: PC Agent가 30초마다 heartbeat를 Supabase KV에 push → 웹에서 online/offline 판정
3. **Shutdown / Run**: 웹에서 KV에 명령 저장 → Agent가 heartbeat 시 pull하여 실행
4. **Auth**: 4자리 PIN → bcrypt 검증 → JWT 쿠키 (24시간)

## Quick Start

### 1. Supabase 설정

1. [Supabase](https://supabase.com)에서 프로젝트 생성
2. SQL Editor에서 `supabase/migrations/20260315072315_create_agent_kv.sql` 실행
3. Settings → API에서 `URL`과 `service_role` 키 복사

### 2. Web (Vercel)

```bash
cd web
cp .env.example .env.local
# .env.local 편집: PIN_HASH, JWT_SECRET, PC_HOST, PC_MAC, AGENT_SECRET, Supabase 키 입력
npm install
npm run dev
```

**PIN_HASH 생성:**
```bash
node -e "require('bcrypt').hash('YOUR_PIN', 10).then(console.log)"
```

### 3. Agent (Windows PC)

```bash
cd agent
cp .env.example .env
# .env 편집: PIN_HASH, ALLOWED_ORIGIN, VERCEL_URL, AGENT_SECRET 입력
npm install
node server.js
```

**Windows 서비스 등록 (선택):**
```cmd
# 관리자 권한 CMD에서:
agent\install.bat          # Task Scheduler 등록 (부팅 시 자동 실행)
agent\add-firewall.bat     # 방화벽 포트 개방
agent\enable-autologin.bat # WOL 부팅 후 자동 로그인
```

### 4. 네트워크 설정

- 라우터에서 UDP 포트 9를 브로드캐스트 주소로 포트포워딩 (WOL용)
- PC NIC에서 Wake-on-LAN 활성화
- BIOS에서 Wake on PCI-E 활성화

### 5. Vercel 배포

```bash
cd web
npx vercel --prod
# Vercel 대시보드에서 환경변수 설정 (.env.local과 동일)
```

## 환경변수 요약

| 변수 | 위치 | 설명 |
|------|------|------|
| `PIN_HASH` | web + agent | bcrypt 해시 (양쪽 동일) |
| `JWT_SECRET` | web | JWT 서명 키 (랜덤 32자) |
| `PC_HOST` | web | PC 공인 IP 또는 DDNS |
| `PC_MAC` | web | PC NIC MAC 주소 (AA:BB:CC:DD:EE:FF) |
| `WOL_PORT` | web | Magic Packet 포트 (기본 9) |
| `AGENT_SECRET` | web + agent | heartbeat Bearer 토큰 (양쪽 동일) |
| `SUPABASE_URL` | web | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | web | Supabase service_role 키 |
| `PORT` | agent | Agent 서버 포트 (기본 9876) |
| `ALLOWED_ORIGIN` | agent | CORS 허용 오리진 (Vercel URL) |
| `VERCEL_URL` | agent | heartbeat 전송 대상 URL |
| `PROJECTS_DIR` | agent | 프로젝트 루트 경로 (기본 `D:\projects`) |
| `EDITOR_CMD` | agent | 에디터 실행 명령 (기본 `code`) |
| `BASH_PATH` | agent | bash 경로 — tmux 세션용 (기본 `C:\msys64\usr\bin\bash.exe`) |
| `CLAUDE_BIN` | agent | Claude CLI 경로 (기본 `claude`) |
| `IGNORE_DIRS` | agent | 프로젝트 목록 제외 디렉토리 (기본 `node_modules,screenshots`) |

## License

MIT
