# CAPTCHA System — Lessons & Architecture Reference

## Status: Dormant (code preserved in agent/router-wol.js)

Pi relay handles WOL via LAN broadcast — CAPTCHA/router login no longer needed.
All CAPTCHA code is preserved for potential future use if router changes.

## Preserved Files
- `agent/router-wol.js` — Full CAPTCHA solver + router login logic
- `agent/router-js/` — RSA encryption library for router auth
- `agent/CAPTCHA-SYSTEM.md` — Detailed architecture documentation
- `agent/.captcha-learned.json` — Learned solver data (position diffs, win mappings)

## Key Lessons (applicable to other multi-solver systems)

### 1. CAPTCHA is Single-Use
First wrong answer invalidates the CAPTCHA image. Only submit the highest-confidence answer once.
Beam search must sort by score and try only the top candidate per CAPTCHA fetch.

### 2. Multi-Solver Consensus
Combine multiple AI solvers (GPT, Gemini, CapSolver) with weighted voting.
Position-level decomposition: score each character position independently.
Cross-solver variants: combine characters from different solvers for new candidates.
See: `~/.claude/rules/multi-solver-consensus.md` for generalized pattern.

### 3. Adaptive Learning with Anti-Pollution
Record solver differences and successful substitutions in `.captcha-learned.json`.
Cap learned bonuses: solver-unseen characters get max 15% of top solver score.
Prevent cascade: only derive learned bonus from solver-originated characters.

### 4. Router Session Architecture
LG U+ router binds sessions to client IP — LAN-only cookies can't be used from WAN.
Port 88 (WAN) doesn't issue `set-cookie` headers at all.
Conclusion: any router-dependent feature must run from LAN (Pi relay solves this).

### 5. Concurrent Login Prevention
Router allows only one active login session. Browser session blocks Agent login.
Agent must detect active sessions before attempting CAPTCHA solve.
