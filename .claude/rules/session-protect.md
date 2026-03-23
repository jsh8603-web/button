# Session Protection Rules

## 동작 원리
- `proj` action 실행 시: 미보호 btn-* 세션 전부 kill → 새 세션 생성
- 보호된 세션은 kill에서 제외 (`.protected-sessions` 파일로 영속화)
- 데스크탑에서 직접 연 tmux 세션 (btn- 접두사 없음)은 영향 없음

## Agent actions (Pi relay → Agent /run)
- `protect-session`: `.protected-sessions`에 추가
- `unprotect-session`: `.protected-sessions`에서 제거
- `kill-session`: 보호 해제 → `kill-sessions.sh` (Ctrl+C→/exit→kill) → `close-window.ps1`

## Status (Pi relay → Agent /status)
- Agent `/status` 응답에 `sessions: [{name, protected}]` 포함
- Agent가 `.protected-sessions`에서 실제 없는 세션 자동 제거 (유령 정리)

## Web UI
- Terminal 버튼 = 세션 관리 드롭다운
- Shield SVG (녹색 filled+check = 보호, 회색 outline = 미보호)
- X 버튼 = 세션 종료 (미보호만 표시, confirm 필요)
- Optimistic UI: action 후 35초간 서버 sessions 폴링 무시 (깜빡임 방지)

## Power actions
- `hibernate`: `shutdown /h` (즉시 또는 지연 실행, params.delay로 초 단위 지정)
