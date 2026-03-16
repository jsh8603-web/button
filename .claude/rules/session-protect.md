# Session Protection Rules

- proj action: kill ALL unprotected btn-* sessions → create new session
- Protected sessions survive proj kills (`.protected-sessions` file persists across restarts)
- heartbeat includes `sessions: [{name, protected}]` for web UI
- Web 💻 button = session management (protect/unprotect/kill)
- Whitelisted actions: `protect-session`, `unprotect-session`, `kill-session` (+ existing shutdown/proj/editor)
- kill-session: removes protection → kills tmux session + Claude process + VS Code window
- Protected sessions hide ✕ button (must unprotect first to kill)
- Desktop-opened tmux sessions (no btn- prefix) are never affected
