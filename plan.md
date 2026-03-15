# Button — WOL Web App

PC를 외부에서 켜고/끄는 원버튼 웹앱.

## Context + 결정사항

- 모바일(LTE)에서 집 PC를 Wake-on-LAN으로 켜고, 원격 종료하는 개인용 웹앱
- "button"이라는 이름답게 최소 UI: PIN 입력 → 큰 버튼 하나 (토글)
- 부팅 후 앱 실행 + 작업 환경 자동 셋업 기능 포함
- BIOS WOL 설정 완료, NIC WOL Enabled 확인됨

## 기술스택

| 레이어 | 선택 | 이유 |
|--------|------|------|
| Frontend + API | Next.js 14 (App Router) | Vercel 무료 호스팅, API Route에서 UDP 전송 가능 |
| 호스팅 | Vercel (Hobby) | 무료, HTTPS 자동, 서버리스 |
| PC Agent | Node.js + Express | Windows 서비스로 상주, shutdown 명령 수신 |
| 인증 | 4자리 PIN → JWT 쿠키 | 단순, 본인만 사용 |
| DDNS | 공유기 내장 or DuckDNS | 공인 IP 변경 대응 |

## 아키텍처

```
[모바일 브라우저]
       │
       ▼
[Vercel (Next.js)]  ← 항상 접근 가능
  ├─ POST /api/wake     → UDP Magic Packet → 공인IP:9 → 라우터 → 브로드캐스트 → NIC
  ├─ POST /api/shutdown → HTTP → 공인IP:9876 → 라우터 → PC Agent → shutdown /s
  ├─ GET  /api/status   → HTTP → 공인IP:9876 → PC Agent → 200 OK or timeout
  └─ POST /api/run      → HTTP → 공인IP:9876 → PC Agent → 앱/명령 실행
       │
[라우터 (192.168.219.1)]
  ├─ UDP 9    → 192.168.219.255 (브로드캐스트)
  ├─ TCP 9876 → 192.168.219.102 (PC Agent)
  └─ DDNS 활성화
       │
[PC (192.168.219.102)]
  ├─ NIC: Realtek 2.5GbE, MAC 74-56-3C-CD-C9-FB
  ├─ WOL: Magic Packet Enabled, Shutdown WOL Enabled
  └─ Agent: Express on :9876
```

## PC 정보 (확인됨)

- NIC: Realtek Gaming 2.5GbE (RTL8125)
- MAC: `74-56-3C-CD-C9-FB`
- IP: `192.168.219.102` (고정 DHCP 필요)
- Gateway: `192.168.219.1` (KT Davolink)
- Wake on Magic Packet: Enabled
- Shutdown Wake-On-Lan: Enabled
- WOL & Shutdown Link Speed: 10 Mbps First
- BIOS WOL: 이전 세션에서 확인 완료

## DB 스키마

없음. 상태 저장 불필요 (PC Agent 응답 여부 = 상태).

## 구현 순서

### Phase 1: 인프라 + PC Agent
1. 공유기 설정: 고정 DHCP, 포트포워딩 (UDP 9, TCP 9876), DDNS
2. PC Agent: Express 서버, `/health`, `/shutdown` 엔드포인트
3. PC Agent를 Windows 시작 프로그램 등록 (Task Scheduler)
4. 포트포워딩 + Agent 동작 테스트 (외부에서 curl)

### Phase 2: Vercel 웹앱
5. Next.js 프로젝트 초기화 + Vercel 배포
6. API Route: `/api/wake` (dgram UDP Magic Packet 전송)
7. API Route: `/api/shutdown` (PC Agent로 HTTP 프록시)
8. API Route: `/api/status` (PC Agent health check, 3초 timeout)
9. API Route: `/api/auth` (PIN 검증 → JWT 쿠키 발급)
10. 프론트엔드: PIN 입력 → 토글 버튼 UI

## 필요한 API 키/서비스

| 서비스 | 용도 | 발급처 |
|--------|------|--------|
| Vercel | 웹앱 호스팅 | vercel.com (GitHub 연동) |
| DDNS | 공인 IP 추적 | 공유기 내장 or duckdns.org |

- 외부 API 키 불필요. 모든 통신은 직접 연결.

## 환경변수

### Vercel (.env)
```
PIN_HASH=<bcrypt hash of 4-digit PIN>
JWT_SECRET=<random 32 char string>
PC_HOST=<DDNS hostname or 공인 IP>
PC_PORT=9876
PC_MAC=74:56:3C:CD:C9:FB
WOL_PORT=9
```

### PC Agent (.env)
```
PORT=9876
PIN_HASH=<same bcrypt hash>
```

## API Route 스펙

### POST /api/auth
- Body: `{ "pin": "1234" }`
- 성공: Set-Cookie `token=<JWT>`, `{ "ok": true }`
- 실패: 429 (5회 실패 시 1분 잠금), `{ "error": "invalid" }`

### POST /api/wake
- Header: Cookie `token=<JWT>`
- 동작: `dgram` 소켓으로 Magic Packet (6×FF + 16×MAC) UDP 전송 → `PC_HOST:WOL_PORT`
- 응답: `{ "ok": true, "message": "Magic packet sent" }`

### POST /api/shutdown
- Header: Cookie `token=<JWT>`
- 동작: HTTP POST → `PC_HOST:PC_PORT/shutdown` (PIN_HASH 전달)
- 응답: `{ "ok": true }` or `{ "error": "PC unreachable" }`

### GET /api/status
- Header: Cookie `token=<JWT>`
- 동작: HTTP GET → `PC_HOST:PC_PORT/health` (timeout 3초)
- 응답: `{ "status": "online" | "offline" }`

### POST /api/run
- Header: Cookie `token=<JWT>`
- Body: `{ "action": "antigravity" | "claude-remote" | "proj", "name?": "button" }`
- 동작: HTTP POST → `PC_HOST:PC_PORT/run`
- 응답: `{ "ok": true, "action": "antigravity" }` or `{ "error": "PC unreachable" }`

## PC Agent 엔드포인트

### GET /health
- 응답: `{ "status": "online", "uptime": 3600 }`

### POST /shutdown
- Header: `X-Pin-Hash: <hash>`
- 동작: `shutdown /s /t 5` 실행 (5초 딜레이, 취소 가능)
- 응답: `{ "ok": true, "message": "Shutting down in 5s" }`

### POST /run
- Header: `X-Pin-Hash: <hash>`
- Body: `{ "action": "antigravity" | "claude-remote" }`
- 동작: 사전 등록된 명령만 실행 (화이트리스트)
- 응답: `{ "ok": true, "action": "antigravity" }`

### 화이트리스트 명령

| action | 실행 명령 | 설명 |
|--------|----------|------|
| `antigravity` | `start "" "shell:AppsFolder\Google.Antigravity"` | Antigravity 앱 실행 |
| `claude-remote` | `bash -c 'tmux new-session -d -s remote -c /d/projects && tmux send-keys -t remote "claude" Enter'` | tmux 세션 + Claude 실행 |
| `proj` | `bash -c 'proj /d/projects/{name}'` | 특정 프로젝트 tmux 세션 (name은 body에서 전달) |

- **보안**: 임의 명령 실행 금지, 화이트리스트 외 action은 400 에러
- `proj` action의 `name`은 `/d/projects/` 하위 디렉토리 존재 여부 검증

## UI 디자인 가이드

### 디자인 원칙
- 원버튼: 한 손, 한 번의 터치로 완료
- 상태 즉시 인지: 색상으로 ON/OFF 구분
- 최소 UI: PIN 입력 + 버튼 + 상태 텍스트

### 색상
| 용도 | Hex |
|------|-----|
| Background (dark) | `#0a0a0a` |
| ON 상태 (green glow) | `#22c55e` |
| OFF 상태 (red glow) | `#ef4444` |
| 전환 중 (amber pulse) | `#f59e0b` |
| Text primary | `#ffffff` |
| Text secondary | `#a1a1aa` |

### 레이아웃 (모바일 최적화)
```
┌──────────────────────┐
│                      │
│      [ STATUS ]      │  ← "PC is ON" / "PC is OFF"
│                      │
│    ┌────────────┐    │
│    │            │    │
│    │  ◉ BUTTON  │    │  ← 큰 원형 토글 (120px)
│    │            │    │     ON=green glow, OFF=red glow
│    └────────────┘    │     전환중=amber pulse animation
│                      │
│   Last: 2min ago     │  ← 마지막 상태 확인 시각
│                      │
│  ┌─────┐ ┌─────┐    │  ← Quick Actions (PC ON일 때만)
│  │ AG  │ │ CLI │    │     AG=Antigravity, CLI=Claude Remote
│  └─────┘ └─────┘    │     작은 아이콘 버튼 (48px)
│                      │
└──────────────────────┘
```

### 컴포넌트
- PIN 입력: 4칸 숫자 입력 (자동 submit)
- Power Button: 원형, 120×120px, box-shadow glow, 터치 영역 160px
- Status Text: 16px, 상태별 색상 매칭
- Tailwind CSS 사용

## 검증 방법

| 기능 | 검증 |
|------|------|
| WOL | PC 끈 상태 → 웹앱 Wake → PC 부팅 확인 |
| Shutdown | PC 켠 상태 → 웹앱 Shutdown → PC 종료 확인 |
| Status | PC ON → "online" 표시, PC OFF → "offline" 표시 |
| PIN | 틀린 PIN → 거부, 5회 → 잠금, 맞는 PIN → 토큰 발급 |
| Antigravity | PC ON → AG 버튼 → 앱 실행 확인 |
| Claude Remote | PC ON → CLI 버튼 → tmux 세션 + Claude 실행 확인 |
| DDNS | 공인 IP 변경 후에도 접근 가능 |

## 리스크

1. **Vercel dgram UDP**: Vercel 서버리스에서 `dgram` 모듈 사용 가능 여부 → Phase 2 #6에서 검증, 불가 시 Cloudflare Worker로 전환
2. **라우터 브로드캐스트 포워딩**: UDP 9 → 192.168.219.255 지원 여부 → Phase 1 #1에서 검증, 불가 시 고정 ARP + 단일 IP 포워딩
3. **Shutdown 보안**: PC Agent 포트 인터넷 노출 → PIN 검증 + rate limiting으로 보호
