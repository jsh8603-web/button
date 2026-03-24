# Terminal Multiplexer Setting for Claude Code

Claude Code + 터미널 멀티플렉서 스크롤/렌더링 이슈 해결 기록.

## 현재 상태: psmux (Windows 네이티브)

msys2 tmux에서 **psmux**로 전환 완료 (2026-03-25).
psmux는 Windows ConPTY를 직접 사용하는 네이티브 멀티플렉서로,
msys2 PTY 계층 문제를 근본적으로 우회한다.

### psmux 정보
- **버전**: 3.3.0
- **설치**: `winget install marlocarlo.psmux`
- **경로**: `C:\Users\jsh86\AppData\Local\Microsoft\WinGet\Packages\marlocarlo.psmux_Microsoft.Winget.Source_8wekyb3d8bbwe\psmux.exe`
- **GitHub**: https://github.com/psmux/psmux
- **특징**: tmux 명령어 호환, ConPTY 네이티브, Claude Code agent teams 지원

### agent server.js 연동
- `PSMUX_BIN` 환경변수로 경로 지정 가능 (기본값 = WinGet 설치 경로)
- 모든 세션 관리를 psmux 직접 호출 (bash -lc 래퍼 제거)
- 세션 내 셸: `-- "C:\msys64\usr\bin\bash.exe" -l` (msys2 bash)
- VS Code 연동: PowerShell로 psmux attach-session

### psmux 호환성 (검증 완료)

| tmux 명령 | psmux 지원 | 비고 |
|-----------|-----------|------|
| `new-session -d -s name` | O | |
| `new-session -c dir` | O | Windows 경로 사용 |
| `new-session -- cmd args` | O | bash -l로 시작 |
| `send-keys -t session` | O | |
| `capture-pane -t -p` | O | |
| `capture-pane -p -S -` | O | 전체 버퍼 |
| `has-session -t` | O | |
| `kill-session -t` | O | |
| `load-buffer` | O | Windows 경로 필수 |
| `paste-buffer -t` | O | |
| `list-sessions` | O | |
| `-S` 소켓 (직접 호출) | O | |
| **`-F '#S'` 포맷** | **X** | Node.js에서 파싱으로 대체 |
| **msys2 bash -lc 경유** | **X** | IPC 격리 — 직접 호출 필수 |

### 제한사항
- `-F` 포맷 미지원 → `parseSessionNames()` 헬퍼로 대체
- bash -lc에서 호출 불가 → Node.js exec로 직접 호출
- `source-file ~/.tmux.conf` → psmux 자체 설정은 별도 (필요 시 `~/.config/psmux.toml`)

## 이전 상태: msys2 tmux (archived)

### 근본 원인
Claude Code의 Ink(React) 렌더러가 초당 4,000~6,700 스크롤 이벤트 생성.
렌더 경로 간 커서 위치 충돌이 근본 원인 (tmux 설정으로 완전 해결 불가).

### 검토한 대안들

| 방안 | 결과 | 비고 |
|------|------|------|
| tmux 설정 최적화 | 부분 해결 | `allow-passthrough on` 핵심, 완전 해결 불가 |
| **psmux** | **채택** | ConPTY 네이티브, msys2 PTY 우회 |
| claude-chill | Windows 미지원 | Linux/macOS PTY proxy, Unix PTY 의존 |
| WSL2 이전 | 과도한 비용 | 전체 환경 이전 필요, I/O 성능 저하 |

### claude-chill 참고
- **GitHub**: https://github.com/davidbeesley/claude-chill
- PTY 프록시로 Ink 렌더러 출력을 diff → atomic 업데이트
- Linux/macOS 전용 (Unix PTY 의존, Windows 컴파일 불가)
- msys2 tmux 세션에서만 사용 가능 (WSL2 불가 — IPC 격리)

### 이전 msys2 tmux.conf (참고용)
```bash
set -g default-terminal "xterm-256color"
set -ag terminal-overrides ",xterm-256color:Tc"
set -g mouse on
set -g history-limit 5000
set -g escape-time 0
set -g focus-events on
set -g set-clipboard on
unbind -n MouseDown3Pane
unbind -n M-MouseDown3Pane
```

### 제거했던 설정 (msys2 tmux)
| 설정 | 제거 이유 |
|------|----------|
| `allow-passthrough on` | msys2에서 효과 미확인, 보안 리스크 |
| `extended-keys on` | Claude Code에서 불필요, 잠재적 키 충돌 |
| `history-limit 250000` | 스크롤 래그의 직접 원인 |

## Sources
- [psmux (GitHub)](https://github.com/psmux/psmux)
- [claude-chill (GitHub)](https://github.com/davidbeesley/claude-chill)
- [Claude Code scrolling fix (angular.schule)](https://angular.schule/blog/2026-02-claude-code-scrolling/)
- [Issue #9935: Excessive scroll events](https://github.com/anthropics/claude-code/issues/9935)
- [Issue #16939: Windows 11 flickering](https://github.com/anthropics/claude-code/issues/16939)
- [tmux-claude-code config](https://github.com/sethdford/tmux-claude-code)
