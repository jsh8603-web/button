# Session Lifecycle Management

## 변경 이력

- **2026-04-08** (ef9b968): 비서 → agent heartbeat로 세션 라이프사이클 이전

## 아키텍처

### 역할 분리

| 구성요소 | 역할 |
|----------|------|
| **agent server.js** | 세션 생성, 유지, 복원 (heartbeat), kill |
| **secretary** | 모니터링, resume 주입, Telegram 알림 (세션 생성/kill 안 함) |
| **웹앱 (Pi relay)** | 사용자 요청 전달 (proj, kill-session 등) |

### 세션 heartbeat (server.js)

- **주기**: 60초
- **데이터 소스**: `.secretary/.session-registry.txt`
- **대상**: `btn-*` 접두사 세션만

#### 판정 로직

```
레지스트리 세션 순회:
  ├─ psmux 세션 존재 + Claude 실행 중 → ALIVE (skip)
  ├─ psmux 세션 존재 + Claude 미실행 → AGENT_DEAD
  │   └─ runner 재실행 (claude/gemini)
  └─ psmux 세션 없음 → SESSION_DEAD
      └─ createPsmuxSession() + runner + /remote-control (15초 후)
```

#### 복원 조건

| 상태 | 조건 | 동작 |
|------|------|------|
| AGENT_DEAD (psmux 살아있음, Claude 종료) | 무조건 | runner 재실행 |
| SESSION_DEAD (psmux 없음) | **protected일 때만** | psmux 재생성 + runner + /remote-control |
| SESSION_DEAD + not protected | - | 레지스트리에서 제거, 복원 안 함 |

#### 제외 대상 (heartbeat 미적용)

- `secretary` / `vaultvoice` (ALWAYS_PROTECTED → 별도 heartbeat)
- `schedule-*`, `task-*` (AI task)
- `worker`, `verifier`, `healer`, `strategic` (WF 세션)

#### 재시도

- 최대 3회 시도 (sessionReviveCounts Map)
- 3회 초과 시 포기 (다음 agent 재시작까지)

### 세션 종료 경로

| 경로 | protected | 레지스트리 | heartbeat 복원 |
|------|-----------|-----------|---------------|
| 웹앱 kill-session | 제거됨 | 제거됨 | X |
| 웹앱 unprotect → exit | 제거됨 | 유지 | X (not protected) |
| 사용자 exit/Ctrl+C (protected 유지) | 유지됨 | 유지됨 | O |
| 세션 크래시 (protected 유지) | 유지됨 | 유지됨 | O |
| killUnprotectedSessions (proj action) | 이미 없음 | 제거됨 | X |
| 데스크탑 터미널 닫기 (protected 유지) | 유지됨 | 유지됨 | O |

### .secretary-disabled 플래그

`agent/.secretary/.secretary-disabled` 파일이 존재하면:
- proj action 시 비서 세션 생성 안 함
- heartbeat에서 비서 재시작 안 함
- 삭제하면 즉시 비서 복원

## 관련 파일

| 파일 | 역할 |
|------|------|
| `agent/server.js` | 세션 heartbeat + secretary heartbeat |
| `agent/.secretary/.scripts/scout-and-act.sh` | 모니터링 전용 (revive 제거됨) |
| `agent/.secretary/.session-registry.txt` | 세션 등록 정보 (psmuxName\|model\|dir\|ts\|sid) |
| `agent/.protected-sessions` | 보호 세션 목록 (JSON array) |
| `agent/.secretary/.secretary-disabled` | 비서 비활성화 플래그 |
