# External Router Login (비활성 — 코드 보존)

## 왜 비활성화했는가

LG U+ 공유기는 세션을 클라이언트 IP에 바인딩한다.
- LAN(port 80) 쿠키는 외부 IP(Vercel)에서 사용 불가
- WAN(port 88, 원격관리) 포트는 `set-cookie` 헤더를 아예 발급하지 않음
- 따라서 Vercel에서 공유기 세션을 생성/유지하는 것이 **물리적으로 불가능**

결과: Sleep 상태에서 원격 WOL(공유기 API)이 불가능 → **Sleep 대신 Hibernate** 사용.
(Hibernate는 전원 완전 차단 → UDP 매직패킷으로 Wake 가능)

## 비활성화 위치 (다시 켜려면 여기만 수정)

### 1. Agent 부팅 시 외부 로그인 스킵
**`agent/server.js`** — `server.listen` 콜백 내부:
```
// Initialize router session — local port 80 only
// External login (port 88) disabled: router WAN doesn't issue cookies, so
// Vercel can't maintain session. Code preserved in router-wol.js for future use.
```
- `initRouterSession()`만 호출 (로컬 port 80 로그인)
- `loginExternal()` 호출 없음

**다시 켜려면**: `initRouterSession()` `.then()` 안에서 `loginExternal()` 호출 추가

### 2. refreshBeforeSleep에서 external 로그인 시도
**`agent/router-wol.js`** `refreshBeforeSleep()`:
- 현재도 `loginExternal()` 호출 코드가 있음 (비활성 아님)
- 하지만 port 88이 쿠키를 안 주므로 항상 실패 → `catch {}`로 무시됨

### 3. Heartbeat에서 external cookie 전달
**`agent/server.js`** `sendHeartbeat()`:
```js
routerCookie: getExternalCookie() || routerCookie,
```
- `getExternalCookie()`는 항상 null 반환 (external 로그인 안 했으므로)
- 로컬 `routerCookie`가 fallback으로 전송됨

### 4. Web UI에서 Sleep 메뉴 제거
**`web/src/app/page.tsx`** Power Menu 드롭다운:
- Sleep 버튼 제거됨, Hibernate + Display Off만 남음
- CAPTCHA 수동 풀기 UI 전부 제거됨 (모달, 입력, 상태변수)
- Help 패널에서 CAPTCHA 관련 설명 제거됨

### 5. Cron keepalive 쿠키 삭제 방지
**`web/src/app/api/cron/router-keepalive/route.ts`**:
- 세션 만료 감지 시 KV 쿠키를 삭제하지 않도록 수정됨
- 이전에는 삭제해서 Wake도 실패했음

## 보존된 코드 (router-wol.js)

| 함수 | 위치 | 용도 |
|------|------|------|
| `loginExternal(onProgress)` | :1251 | 외부 IP:88로 CAPTCHA 로그인 |
| `getExternalCookie()` | :1242 | 외부 세션 쿠키 반환 |
| `keepAliveWith(cookie, host, port)` | :1169 | 특정 호스트/포트로 keep-alive |
| `httpReq(method, path, body, cookie, hostOverride, portOverride)` | :44 | host/port 오버라이드 지원 HTTP 헬퍼 |

`login()`, `loginWithRetry()`, `_loginWithRetry()` 모두 `host`, `port` 파라미터 지원.
기본값 생략 시 로컬(`192.168.219.1:80`)으로 동작.

## 외부 로그인이 가능해지는 조건

다음 중 하나라도 충족되면 기능 복원 가능:
1. **공유기 펌웨어 업데이트**로 port 88에서 `set-cookie` 발급
2. **릴레이 장치** (라즈베리파이 등)를 LAN에 설치 → 내부 port 80 로그인 대행
3. **다른 공유기**로 교체 (외부 세션 바인딩 없는 모델)

## 3-Solver CAPTCHA 아키텍처 (보존)

코드 전부 `router-wol.js`에 보존됨:
- GPT-4o-mini (2 reads) + Gemini Flash (3 reads) + CapSolver (1) — 병렬
- 동적 가중치: Bayesian smoothed accuracy
- Cross-solver variants + Beam search (top 10)
- 학습 데이터: `.captcha-learned.json`
- 상세 규칙: `.claude/rules/captcha-solver.md`
