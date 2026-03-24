# tmux Setting for Claude Code

Claude Code + tmux 스크롤/렌더링 이슈 해결 설정 (msys2 환경).

## 핵심 원칙

**최소 설정 유지**. Claude Code의 Ink(React) 렌더러는 초당 4,000~6,700 스크롤 이벤트를 생성하며,
렌더 경로 간 커서 위치 충돌이 근본 원인 (tmux 설정으로 완전 해결 불가).
설정을 추가할수록 상호작용이 복잡해져 오히려 버그 발생.

## tmux.conf (검증된 최소 설정)

```bash
# Minimal Claude Code config — reset 2026-03-24
# Sources: blle.co, angular.schule, claude-code#4851, claude-code#9935

# Terminal + True Color
set -g default-terminal "xterm-256color"
set -ag terminal-overrides ",xterm-256color:Tc"

# Mouse
set -g mouse on

# Scrollback — moderate (high values cause lag with Claude Code's scroll event flood)
set -g history-limit 5000

# Zero escape delay
set -sg escape-time 0

# Focus events
set -g focus-events on

# Clipboard
set -g set-clipboard on

# Disable right-click menu (prevents accidental pane split)
unbind -n MouseDown3Pane
unbind -n M-MouseDown3Pane
```

## 제거하고 넣지 않는 설정

| 설정 | 제거 이유 |
|------|----------|
| `allow-passthrough on` | msys2에서 효과 미확인, 보안 리스크 |
| `extended-keys on` | Claude Code에서 불필요, 잠재적 키 충돌 |
| `history-limit 250000` | **스크롤 래그의 직접 원인** — 4k+/sec 이벤트와 결합 시 성능 저하 |
| `terminal-features extkeys` | extended-keys와 연동, 불필요 |
| `terminal-overrides RGB` | `Tc`로 충분, RGB는 중복 |

## msys2 주의사항

- `default-terminal`은 반드시 `xterm-256color` (msys2에 `tmux-256color` terminfo 없음)
- tmux.conf 자동 로딩 안 됨 → `tmux new-session` 후 `tmux source-file ~/.tmux.conf` 별도 실행
- `set -ga` (append) 중복 주의 → `source-file` 여러 번 실행 시 값 누적

## 붙여넣기

tmux 세션 안에서는 **Ctrl+V** 또는 **Shift+우클릭** 사용.
일반 우클릭은 tmux가 가로채서 pane split 등 오동작 발생.

## 스크롤/렌더링 문제 발생 시

1. `/clear` 입력 (가장 빠름)
2. 안 되면 세션 재시작
3. 근본 해결: [claude-chill](https://github.com/davidbeesley/claude-chill) — PTY 프록시로 Ink 렌더러 출력을 diff하여 atomic 업데이트

## Sources

- [Claude Code scrolling fix (angular.schule)](https://angular.schule/blog/2026-02-claude-code-scrolling/)
- [Claude Code + tmux config (blle.co)](https://www.blle.co/blog/claude-code-tmux-beautiful-terminal)
- [Scrollback Buffer Lag #4851](https://github.com/anthropics/claude-code/issues/4851)
- [Excessive scroll events #9935](https://github.com/anthropics/claude-code/issues/9935)
- [claude-chill (PTY proxy)](https://github.com/davidbeesley/claude-chill)
