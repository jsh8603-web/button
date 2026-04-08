'use strict';
/**
 * secretary.js — JS-native session monitor (replaces bash scout-and-act.sh)
 * Phase 1+2: infrastructure + simple interventions
 *
 * module.exports = { startSecretary, stopSecretary }
 * startSecretary(deps) — inject from server.js
 * stopSecretary()      — clearTimeout + state flush
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { exec } = require('child_process');

// ─────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────
let deps      = {};
let loopTimer = null;
let cycleCount = 0;

// capturePane shared cache  — key: psmuxSessionName, value: {text, ts}
const paneCacheMap   = new Map();
const PANE_CACHE_TTL = 10_000; // 10 s

// dedup lock — key: string → last-fired timestamp
const dedupMap = new Map();

// Snapshot ring buffer — key: sessionName → string[] (MD5 hashes, max 5)
const snapshotMap   = new Map();
const SNAPSHOT_SLOTS = 5;

// Circular work ring buffer — key: sessionName → [{ins,del,files}] (max 5)
const circularMap = new Map();

// Compression protection — prevent DEAD false positive after auto-compact
const compressedRecentlyMap = new Map(); // key: sessionName → timestamp
const COMPRESS_PROTECT_MS = 5 * 60_000; // 5 min

// User-presence last-check timestamp
let lastPresenceCheck = 0;

// Git commit tracking — key: dir → last seen commit hash
const lastCommitMap = new Map();

// Escalation state — key: sessionName → {level, lastError, lastTs}
const escalationMap = new Map();

// Guard first-seen tracking — key: sessionName → timestamp
const guardDetectedAt = new Map();

// Solution cache — loaded from .error-solutions.json
const solutionCache = new Map();

// JSONL audit offset — key: sessionKey → lineCount
const auditOffsetMap = new Map();

// WF completion tracking
let wfWasActive = false;

// Cycle-level alert accumulator (for Telegram aggregated alert)
const cycleAlerts = [];

// ─────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────
const SECRETARY_DIR    = path.join(__dirname, '.secretary');
const DEDUP_STATE_FILE = path.join(SECRETARY_DIR, '.secretary-state.json');
const SOLUTIONS_FILE   = path.join(SECRETARY_DIR, '.error-solutions.json');
const GUARD_RESTORE_FILE = path.join(__dirname, '.guard-restore');
const SETTINGS_PATH    = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'settings.json');
const AUDIT_DIR        = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'audit-log');
const OFFSET_MARKER    = path.join(AUDIT_DIR, '.last-jsonl-lines');
const WF_ACTIVE_FILE   = path.join(__dirname, '.wf-active');
const PROMO_LOG_PATH   = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'promotion-log.md');
const EXEC_LOG_PATH    = path.join(__dirname, '..', 'execution-log.md');

// ─────────────────────────────────────────────────────────
// Session name validation — prevent command injection via crafted names
const SAFE_SESSION_RE = /^[a-zA-Z0-9_\-\.]+$/;
function assertSafeSession(name) {
  if (!SAFE_SESSION_RE.test(name)) throw new Error(`[secretary] unsafe session name: ${name}`);
}

// capturePane — shared cache wrapper around tmuxRun
// ─────────────────────────────────────────────────────────
async function capturePane(sessionName) {
  assertSafeSession(sessionName);
  const cached = paneCacheMap.get(sessionName);
  if (cached && Date.now() - cached.ts < PANE_CACHE_TTL) return cached.text;
  const text = await deps.tmuxRun(`capture-pane -p -S -200 -t ${sessionName}`);
  paneCacheMap.set(sessionName, { text, ts: Date.now() });
  return text;
}

// ─────────────────────────────────────────────────────────
// sendMessage — file-based to handle 200+ char messages safely
// ─────────────────────────────────────────────────────────
async function sendMessage(sessionName, message) {
  assertSafeSession(sessionName);
  const tmpPath = path.join(os.tmpdir(), `sec-msg-${sessionName}-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, message, 'utf8');
  await deps.tmuxRun(`send-keys -t ${sessionName} "Read ${tmpPath}" Enter`);
  // Delay delete — agent might be busy and process the Read later
  setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 5 * 60_000);

}

// ─────────────────────────────────────────────────────────
// log_event — daily JSONL audit (rotate on date change)
// ─────────────────────────────────────────────────────────
let _logDate = '';
let _logPath = '';

function getLogPath() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== _logDate) {
    _logDate = d;
    _logPath = path.join(AUDIT_DIR, `${d}.jsonl`);
    try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}
  }
  return _logPath;
}

function log_event(type, data) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n';
    fs.appendFileSync(getLogPath(), line, 'utf8');
  } catch {}
}

// ─────────────────────────────────────────────────────────
// dedup — returns true if key is within TTL (skip), false if new (fire)
// ─────────────────────────────────────────────────────────
function dedup(key, ttlMs = 600_000) {
  const now  = Date.now();
  const last = dedupMap.get(key);
  if (last && now - last < ttlMs) return true;
  dedupMap.set(key, now);
  return false;
}

function flushDedupState() {
  try {
    fs.writeFileSync(DEDUP_STATE_FILE, JSON.stringify(Object.fromEntries(dedupMap)), 'utf8');
  } catch {}
}

function loadDedupState() {
  try {
    const obj = JSON.parse(fs.readFileSync(DEDUP_STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) dedupMap.set(k, Number(v));
  } catch {}
}

// ─────────────────────────────────────────────────────────
// Screen-scraping parsers
// ─────────────────────────────────────────────────────────
const WORKING_RE = [/Thinking\.\.\./, /Tool call/, /esc to interrupt/i, /[◓◑◒◐]/, /Ruminating|Spinning|Wibbling|Wandering|Grooving|Julienning/];
const WAITING_RE = [/blocked by.*guard/i, /PreToolUse.*denied/i, /Do you want to proceed.*\?\s*$/im, /Do you trust.*\?\s*$/im, /Y\/n/i, /\[y\/N\]/i];
// Claude Code indicators: ❯ prompt, bypass permissions, ⏵⏵
const CLAUDE_ALIVE_RE = [/❯/, /bypass permissions/i, /⏵/, /esc to interrupt/i, /shift\+tab/i];
const BARE_SHELL_RE = /^\s*\$\s*$/m;

function parseStatus(text) {
  if (WORKING_RE.some(p => p.test(text))) return 'WORKING';
  if (WAITING_RE.some(p => p.test(text))) return 'WAITING';
  // Claude Code is alive but idle at prompt
  if (CLAUDE_ALIVE_RE.some(p => p.test(text))) return 'IDLE';
  // Bare shell prompt only — Claude exited, psmux session still alive
  if (BARE_SHELL_RE.test(text)) return 'AGENT_DEAD';
  // No recognizable output — session might be gone or starting up
  return 'DEAD';
}

// Match actual Claude Code tool error output, not words in code being discussed
const ERROR_RE = [
  /Exit code [1-9]\d*/,                    // Bash tool failure
  /tool_use was rejected/i,                // tool denied by user/guard
  /The user doesn't want to proceed/i,     // tool rejection message
  /ENOENT.*no such file/i,                 // actual file not found (full pattern)
  /old_string.*not found|not unique/i,     // Edit tool failure
  /Command timed out/i,                    // Bash timeout
];
function parseErrors(text) {
  return ERROR_RE.filter(p => p.test(text)).map(p => p.source);
}

function parseWaiting(text) {
  return WAITING_RE.some(p => p.test(text));
}

function parseEditing(text) {
  const results = [];
  // Claude Code shows tool calls as "Edit(filepath)" or "Update(filepath)" or "Write(filepath)"
  const re = /(?:Edit|Update|Write)\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fp = m[1].trim();
    if (fp && !results.includes(fp)) results.push(fp);
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// Registry reader — pipe-text format: name|model|dir|ts|sid
// ─────────────────────────────────────────────────────────
function getRegisteredSessions() {
  try {
    const lines = fs.readFileSync(deps.SECRETARY_REGISTRY, 'utf8').split('\n').filter(Boolean);
    return lines.map(l => {
      const parts = l.split('|');
      return { name: parts[0], model: parts[1], dir: parts[2], sid: parts[4] };
    }).filter(s => s.name);
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────
// Build report — capture all registered sessions
// ─────────────────────────────────────────────────────────
async function buildReport() {
  const registered = getRegisteredSessions();
  const sessions = [];
  for (const reg of registered) {
    try {
      const text = await capturePane(reg.name);
      let status = parseStatus(text);
      // Compression protection: downgrade AGENT_DEAD/DEAD to IDLE within 5 min of compression
      if ((status === 'AGENT_DEAD' || status === 'DEAD') && compressedRecentlyMap.has(reg.name)) {
        if (Date.now() - compressedRecentlyMap.get(reg.name) < COMPRESS_PROTECT_MS) status = 'IDLE';
        else compressedRecentlyMap.delete(reg.name);
      }
      sessions.push({
        name   : reg.name,
        dir    : reg.dir,
        status,
        errors : parseErrors(text),
        waiting: parseWaiting(text),
        editing: parseEditing(text),
        text,
      });
    } catch {
      // capture-pane failed = psmux session gone = SESSION_DEAD
      sessions.push({
        name: reg.name, dir: reg.dir, status: 'SESSION_DEAD',
        errors: [], waiting: false, editing: [], text: '',
      });
    }
  }
  return { sessions, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────
// Snapshot rotation — 5-slot MD5 ring buffer
// ─────────────────────────────────────────────────────────
function updateSnapshot(sessionName, text) {
  const hash  = crypto.createHash('md5').update(text || '').digest('hex');
  const slots = snapshotMap.get(sessionName) || [];
  slots.push(hash);
  if (slots.length > SNAPSHOT_SLOTS) slots.shift();
  snapshotMap.set(sessionName, slots);
  return hash;
}

function isStuck(sessionName) {
  const slots = snapshotMap.get(sessionName) || [];
  if (slots.length < SNAPSHOT_SLOTS) return false;
  return slots.every(h => h === slots[0]);
}

// ─────────────────────────────────────────────────────────
// .guard-restore check — called once on startSecretary
// ─────────────────────────────────────────────────────────
function checkGuardRestore() {
  if (!fs.existsSync(GUARD_RESTORE_FILE)) return;
  try {
    const backup   = JSON.parse(fs.readFileSync(GUARD_RESTORE_FILE, 'utf8'));
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Restore only permissions.deny (not full overwrite)
    if (backup.permissions?.deny) {
      settings.permissions = settings.permissions || {};
      settings.permissions.deny = backup.permissions.deny;
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    fs.unlinkSync(GUARD_RESTORE_FILE);
    console.log('[secretary] .guard-restore applied and removed');
    log_event('guard_restore', { applied: true });
  } catch (e) {
    console.error('[secretary] .guard-restore error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────
// Phase 2 interventions
// ─────────────────────────────────────────────────────────

// #9 — Stuck detection
async function checkStuck(session) {
  if (!isStuck(session.name)) return;
  if (dedup(`stuck_${session.name}`)) return;
  await sendMessage(
    session.name,
    '5사이클 동안 화면 변화 없음. 현재 상태 확인하고 다음 단계로 진행해.'
  );
  log_event('stuck', { session: session.name });
}

// #10 — Circular work detection (60s cycle, git diff --shortstat)
async function checkCircularWork(session) {
  if (!session.dir) return;
  return new Promise(resolve => {
    exec(`git -C "${session.dir}" diff --shortstat`, { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout?.trim()) return resolve();
      const ins   = parseInt(stdout.match(/(\d+) insertion/)?.[1]  || '0', 10);
      const del   = parseInt(stdout.match(/(\d+) deletion/)?.[1]   || '0', 10);
      const files = parseInt(stdout.match(/(\d+) file/)?.[1]       || '0', 10);
      const slots = circularMap.get(session.name) || [];
      slots.push({ ins, del, files });
      if (slots.length > 5) slots.shift();
      circularMap.set(session.name, slots);
      if (slots.length < 5) return resolve();
      const totIns   = slots.reduce((a, s) => a + s.ins,   0);
      const totDel   = slots.reduce((a, s) => a + s.del,   0);
      const totFiles = slots.reduce((a, s) => a + s.files, 0);
      if (Math.abs(totIns - totDel) <= 5 && totFiles >= 10) {
        if (!dedup(`circular_${session.name}`)) {
          sendMessage(
            session.name,
            '5사이클 동안 코드 변경이 원점 회귀 중. 접근 방법 재고해.'
          );
          log_event('circular_work', { session: session.name, totIns, totDel, totFiles });
        }
      }
      resolve();
    });
  });
}

// #11 — Context warning (pre-compression) + Compression detection (post-compression resume injection)
// Pattern from commit 8ace18d: Claude Code shows "X% until auto-compact" in status bar (last 3 lines)
const COMPRESSED_RE = /^\s*(Compacted|Auto-compacted)|⎿\s+Compacted/m;

async function checkContextWarning(session) {
  const text = session.text || '';

  // A. Post-compression: resume injection (핵심 기능 — scriptagent.md §1-2)
  if (COMPRESSED_RE.test(text)) {
    // Mark as recently compressed — prevent AGENT_DEAD false positive for 5 min
    compressedRecentlyMap.set(session.name, Date.now());
    if (!dedup(`compressed_${session.name}`, 5 * 60_000)) {
      const resume = await generateSessionResume(session);
      if (resume) {
        await sendMessage(session.name, resume);
        log_event('compression_resume_injected', { session: session.name });
      }
    }
    return; // 압축 발생 시 사전 경고는 스킵
  }

  // B. Pre-compression: "X% until auto-compact" → warn at ≤20%
  const tail3 = text.split('\n').slice(-3).join('\n');
  const autoCompact = tail3.match(/(\d+)%[^]*?until[^]*?auto[^-]*compact/i);
  if (!autoCompact) return;
  const remain = parseInt(autoCompact[1], 10);
  if (remain > 20 || remain <= 0) return; // 0% = 압축 진행 중, 스킵
  if (dedup(`ctx_warn_${session.name}`)) return;
  await sendMessage(session.name, `컨텍스트 ${remain}% 남음. 핵심 정보를 memory에 저장해.`);
  log_event('context_warning', { session: session.name, remain });
}

// #11-B — JSONL-based session resume generation (replaces generate-session-resume.sh)
// 압축/부활 시 세션에 주입할 컨텍스트 복원 데이터 생성
async function generateSessionResume(session) {
  const reg = getRegisteredSessions().find(r => r.name === session.name);
  const dir = reg?.dir || session.dir;
  const sid = reg?.sid;
  const lines = [];

  lines.push('## Session Resume (compression recovery)');
  lines.push('');

  // 1. JSONL 파싱 — last-prompt, writes, edits, errors, bashes, agents
  if (sid) {
    const homeDir = process.env.USERPROFILE || os.homedir();
    const projDir = path.join(homeDir, '.claude', 'projects');
    let jsonlPath = null;
    try {
      for (const entry of fs.readdirSync(projDir)) {
        const candidate = path.join(projDir, entry, `${sid}.jsonl`);
        if (fs.existsSync(candidate)) { jsonlPath = candidate; break; }
      }
    } catch {}

    if (jsonlPath) {
      try {
        const raw = fs.readFileSync(jsonlPath, 'utf8');
        const jsonlLines = raw.split('\n').filter(l => l.trim());
        let lastPrompt = '', lastAssistant = '';
        const writes = [], edits = [], bashes = [], agents = [], errors = [];

        for (const line of jsonlLines) {
          let d; try { d = JSON.parse(line); } catch { continue; }
          if (d.type === 'last-prompt' && d.lastPrompt) lastPrompt = d.lastPrompt;
          if (d.type === 'assistant') {
            for (const c of (d.message?.content || [])) {
              if (!c || typeof c !== 'object') continue;
              if (c.type === 'text' && c.text?.length > 80) lastAssistant = c.text;
              if (c.type !== 'tool_use') continue;
              const { name = '', input: inp = {} } = c;
              if (name === 'Write' && inp.file_path) writes.push(inp.file_path);
              if (name === 'Edit' && inp.file_path) edits.push(inp.file_path);
              if (name === 'Bash') bashes.push((inp.command || '').slice(0, 120));
              if (name === 'Agent') agents.push((inp.description || '').slice(0, 60));
            }
          }
          if (d.type === 'user') {
            for (const c of (d.message?.content || [])) {
              if (c?.type === 'tool_result' && c.is_error) {
                const txt = (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 200);
                if (txt) errors.push(txt.replace(/\n/g, ' '));
              }
            }
          }
        }

        const uniq = (arr, n) => [...new Set(arr.slice(-n * 2))].slice(-n);

        if (lastPrompt) { lines.push('### Last User Request'); lines.push(`> ${lastPrompt.slice(0, 500)}`); lines.push(''); }
        if (lastAssistant) { lines.push('### Last Assistant Response'); lines.push(lastAssistant.slice(0, 800)); lines.push(''); }
        const cre = uniq(writes, 8);
        if (cre.length) { lines.push('### Created Files (Write)'); cre.forEach(f => lines.push(`- ${f}`)); lines.push(''); }
        const mod = uniq(edits, 10);
        if (mod.length) { lines.push('### Modified Files (Edit)'); mod.forEach(f => lines.push(`- ${f}`)); lines.push(''); }
        const errs = uniq(errors, 5);
        if (errs.length) { lines.push('### Tool Errors'); errs.forEach(e => lines.push(`- ${e}`)); lines.push(''); }
        const cmds = uniq(bashes, 5);
        if (cmds.length) { lines.push('### Recent Bash Commands'); cmds.forEach(c => lines.push(`- \`${c}\``)); lines.push(''); }
        if (agents.length) { lines.push('### Spawned Agents'); uniq(agents, 3).forEach(a => lines.push(`- ${a}`)); lines.push(''); }
      } catch (e) { console.error('[secretary] resume JSONL parse error:', e.message); }
    }
  }

  // 2. 화면 스냅샷 (JSONL에 없는 고유 정보)
  try {
    const snap = await deps.tmuxRun(`capture-pane -p -S -200 -t ${session.name}`);
    if (snap) {
      const tail50 = snap.split('\n').filter(l => l.trim()).slice(-50).join('\n');
      lines.push('### Screen State Before Compression'); lines.push(tail50); lines.push('');
    }
  } catch {}

  // 3. .wf-active 상태
  if (dir) {
    const wfFile = path.join(dir, '.wf-active');
    try {
      if (fs.existsSync(wfFile)) {
        lines.push('### Active Workflow'); lines.push(fs.readFileSync(wfFile, 'utf8').trim()); lines.push('');
      }
    } catch {}

    // 4. plan.md 체크박스
    for (const planName of ['plan.md', 'progress.md']) {
      const planFile = path.join(dir, planName);
      try {
        if (!fs.existsSync(planFile)) continue;
        const planText = fs.readFileSync(planFile, 'utf8');
        const done = (planText.match(/^- \[x\]/gm) || []).length;
        const todo = (planText.match(/^- \[ \]/gm) || []).length;
        lines.push(`### ${planName} (${done}/${done + todo} done)`);
        planText.split('\n').filter(l => /^- \[/.test(l)).slice(0, 25).forEach(l => lines.push(l));
        lines.push('');
      } catch {}
    }

    // 5. execution-log.md 마지막 30줄
    const execLog = path.join(dir, '.harness', 'execution-log.md');
    try {
      if (fs.existsSync(execLog)) {
        const logText = fs.readFileSync(execLog, 'utf8');
        const logLines = logText.split('\n');
        lines.push('### Execution Log (last 30 lines)');
        if (logLines[0]) lines.push(logLines[0]); // WF 헤더
        lines.push('...');
        logLines.slice(-30).forEach(l => lines.push(l));
        lines.push('');
      }
    } catch {}

    // 6. git diff
    try {
      const diffStat = await gitRun(dir, 'diff --stat');
      if (diffStat) { lines.push('### Uncommitted Changes'); lines.push(diffStat); lines.push(''); }
    } catch {}
  }

  // 7. 활성 psmux 세션 목록
  try {
    const sessions = await deps.tmuxRun('list-sessions');
    if (sessions) {
      lines.push('### Active psmux Sessions');
      sessions.split('\n').forEach(l => { const n = l.split(':')[0]?.trim(); if (n) lines.push(`- ${n}`); });
      lines.push('');
    }
  } catch {}

  if (lines.length <= 2) return null; // 데이터 없으면 주입 안 함
  return lines.join('\n');
}

// #13 — User presence (PowerShell Win32 idle time)
const PS_IDLE_SCRIPT = [
  'Add-Type @\'',
  'using System; using System.Runtime.InteropServices;',
  'namespace Sec { public static class UI {',
  '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTII p);',
  '  internal struct LASTII { public uint cbSize; public uint dwTime; }',
  '  public static long Idle { get {',
  '    var l=new LASTII(); l.cbSize=(uint)System.Runtime.InteropServices.Marshal.SizeOf(l);',
  '    GetLastInputInfo(ref l); return Environment.TickCount-l.dwTime; } }',
  '} }',
  '\'@',
  '[Sec.UI]::Idle',
].join(' ');

let userAbsentFlag = false;

async function checkUserPresence(sessions) {
  if (Date.now() - lastPresenceCheck < 60_000) return;
  lastPresenceCheck = Date.now();
  return new Promise(resolve => {
    exec(`powershell -NoProfile -C "${PS_IDLE_SCRIPT}"`, { timeout: 6000 }, (err, stdout) => {
      if (err) return resolve();
      const idleMs = parseInt(stdout?.trim(), 10);
      if (isNaN(idleMs)) return resolve();

      // User returned detection: was absent, now active (idle < 60s)
      if (idleMs < 60_000 && userAbsentFlag) {
        userAbsentFlag = false;
        for (const s of sessions) {
          if (s.status === 'SESSION_DEAD' || s.status === 'AGENT_DEAD') continue;
          if (!dedup(`user_returned_${s.name}`, 30 * 60_000)) {
            sendMessage(s.name, '사용자 복귀함.').catch(() => {});
          }
        }
        log_event('user_returned', {});
        return resolve();
      }

      if (idleMs < 10 * 60 * 1000) return resolve();

      // User absent: 10min+ idle
      userAbsentFlag = true;
      const WF_EXCLUDE = /^(worker|verifier|healer|strategic)$/;
      for (const s of sessions) {
        if (s.status !== 'WAITING') continue;
        if (WF_EXCLUDE.test(s.name)) continue; // WF 세션 제외 — Supervisor가 관리
        if (!dedup(`presence_${s.name}`, 30 * 60_000)) {
          sendMessage(s.name, '사용자 10분+ 부재. 자율적으로 진행해.');
          log_event('user_absent', { session: s.name, idleMs });
        }
      }
      resolve();
    });
  });
}

// #14 — Rate limit
async function checkRateLimit(sessions) {
  const rl = sessions.filter(s => /rate limit|429/i.test(s.text || ''));
  if (rl.length < 2) return;
  if (dedup('rate_limit')) return;
  for (const s of sessions) {
    if (s.status === 'WORKING') {
      await sendMessage(s.name, 'Rate limit 감지. 세션 수 줄이거나 대기해.');
    }
  }
  log_event('rate_limit', { sessions: rl.map(s => s.name) });
}

// #15 — File conflict
async function checkFileConflict(sessions) {
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      const aSet = new Set(a.editing || []);
      for (const f of (b.editing || [])) {
        if (!aSet.has(f)) continue;
        if (dedup(`conflict_${f}`)) continue;
        await sendMessage(a.name, `파일 충돌: ${f} — ${b.name}도 수정 중`);
        await sendMessage(b.name, `파일 충돌: ${f} — ${a.name}도 수정 중`);
        log_event('file_conflict', { file: f, sessions: [a.name, b.name] });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// Phase 3: Git integration (#16 ~ #18)
// ─────────────────────────────────────────────────────────

// Shared helper — run git command and return trimmed stdout or null
// Uses execFile to prevent shell injection via dir/args
const { execFile } = require('child_process');
function gitRun(dir, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args.split(/\s+/)], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : (stdout?.trim() || null));
    });
  });
}

// Fetch latest commit within last 90s; returns {hash, message} or null
async function getLatestCommit(dir) {
  const out = await gitRun(dir, 'log -1 --format="%H %s" --since="90 seconds ago"');
  if (!out) return null;
  const spaceIdx = out.indexOf(' ');
  if (spaceIdx < 0) return null;
  return { hash: out.slice(0, spaceIdx), message: out.slice(spaceIdx + 1) };
}

// #16 — Work completion: commit + idle + user absent → Telegram
async function checkWorkCompletion(session, commitInfo) {
  if (session.status !== 'IDLE') return;
  // User absent check: lastPresenceCheck is updated by checkUserPresence.
  // If never checked (0) or last check > 10min ago → treat as absent.
  const userAbsent = lastPresenceCheck === 0 || Date.now() - lastPresenceCheck > 10 * 60_000;
  if (!userAbsent) return;
  if (dedup(`work_complete_${session.name}`, 30 * 60_000)) return;
  const msg = `✅ *작업 완료 감지*\n세션: \`${session.name}\`\n커밋: ${commitInfo.message.slice(0, 80)}`;
  deps.telegram.notify(msg, { parse_mode: 'Markdown' });
  log_event('work_complete', { session: session.name, hash: commitInfo.hash });
}

// #17 — Simplify reminder: diff ≥ 50 lines → sendMessage nudge
async function checkSimplifyReminder(session, commitInfo) {
  if (dedup(`simplify_${commitInfo.hash}`)) return;
  const out = await gitRun(session.dir, 'diff HEAD~1 --stat');
  if (!out) return;
  const added   = parseInt(out.match(/(\d+) insertion/)?.[1]  || '0', 10);
  const deleted = parseInt(out.match(/(\d+) deletion/)?.[1]   || '0', 10);
  const total   = added + deleted;
  if (total < 50) return;
  await sendMessage(session.name, `커밋 diff ${total}줄. /simplify 고려해.`);
  log_event('simplify_reminder', { session: session.name, hash: commitInfo.hash, total });
}

// Session name patterns to exclude from broadcast
const WF_RE        = /^(worker|verifier|healer|strategic)$/;
const SKIP_NAME_RE = /^(task|schedule|secretary)/;

// #18 — Git diff broadcast: send diff stat to other registered btn-* sessions
async function broadcastGitDiff(session, commitInfo) {
  if (dedup(`broadcast_${commitInfo.hash}`)) return;
  const out = await gitRun(session.dir, 'diff HEAD~1 --stat');
  if (!out) return;
  // Use last line of --stat as the summary
  const lines = out.split('\n');
  const summary = lines[lines.length - 1] || '';
  const msg = `[diff] ${session.name}: ${summary.trim()}`;
  const targets = getRegisteredSessions().filter(s =>
    s.name !== session.name && !WF_RE.test(s.name) && !SKIP_NAME_RE.test(s.name)
  );
  for (const t of targets) {
    try { await sendMessage(t.name, msg); } catch {}
  }
  if (targets.length > 0) {
    log_event('diff_broadcast', { from: session.name, hash: commitInfo.hash, targets: targets.map(t => t.name) });
  }
}

// Called in 60s cycle — check all sessions for new commits
async function processCommits(sessions) {
  for (const s of sessions) {
    if (!s.dir) continue;
    const commitInfo = await getLatestCommit(s.dir);
    if (!commitInfo) continue;
    if (lastCommitMap.get(s.dir) === commitInfo.hash) continue;
    lastCommitMap.set(s.dir, commitInfo.hash);
    await checkWorkCompletion(s, commitInfo);
    await checkSimplifyReminder(s, commitInfo);
    await broadcastGitDiff(s, commitInfo);
    // Trigger 2: promo-log nudge after commit (1x per session per day)
    if (!dedup(`promo_commit_remind_${s.name}`, 86_400_000)) {
      await sendMessage(s.name, '커밋 감지. promotion-log에 기록 필요하면 추가해.');
      log_event('promo_nudge', { trigger: 'commit', session: s.name });
    }
  }
}

// ─────────────────────────────────────────────────────────
// Phase 4: Error escalation chain (#19 ~ #22)
// ─────────────────────────────────────────────────────────

// #19 — Solution cache
function loadSolutionCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(SOLUTIONS_FILE, 'utf8'));
    solutionCache.clear();
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry.pattern && entry.solution) solutionCache.set(entry.pattern, entry.solution);
      }
    }
  } catch {}
}

function matchSolution(errorText) {
  for (const [pattern, solution] of solutionCache) {
    try {
      if (new RegExp(pattern, 'i').test(errorText)) return solution;
    } catch {}
  }
  return null;
}

function saveSolutionCache(pattern, solution) {
  solutionCache.set(pattern, solution);
  try {
    const arr = [...solutionCache.entries()].map(([p, s]) => ({ pattern: p, solution: s }));
    fs.writeFileSync(SOLUTIONS_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch {}
}

// #20 — Multi-level error escalation — declarative FSM
// States: normal → warned → analyzing → escalated → cooldown → normal
const ESCALATION_FSM = {
  normal:    { error: 'warned' },
  warned:    { same_error: 'analyzing', resolved: 'normal' },
  analyzing: { same_error: 'escalated', resolved: 'normal' },
  escalated: { sent: 'cooldown' },
  cooldown:  { timeout: 'normal' },
};

// Entry actions executed when FSM enters a new state
async function onEnterState(sessionName, nextState, errKey) {
  if (nextState === 'warned') {
    const hint = matchSolution(errKey || '') ? `\n💡 ${matchSolution(errKey)}` : '';
    await sendMessage(sessionName, `에러 감지. 현재 상태 확인해.${hint}`);
    log_event('escalation_warned', { session: sessionName, error: errKey });
    // Trigger 1: promo-log nudge on first error per session per day
    if (!dedup(`promo_error_remind_${sessionName}`, 86_400_000)) {
      sendMessage(sessionName, '에러 해결 후 promotion-log에 기록해.').catch(() => {});
      log_event('promo_nudge', { trigger: 'error', session: sessionName });
    }
  } else if (nextState === 'analyzing') {
    // Model-based branching: check if target session runs Opus or Sonnet
    const reg = getRegisteredSessions().find(r => r.name === sessionName);
    const model = (reg?.model || '').toLowerCase();
    if (model.includes('opus')) {
      // Opus session → self-verify (Opus can analyze its own errors)
      await sendMessage(sessionName, `동일 에러 반복 중. 지금 접근 방식 멈추고 다시 분석해.\n에러: ${(errKey || '').slice(0, 300)}`);
      log_event('escalation_self_verify', { session: sessionName, model: 'opus' });
    } else {
      // Sonnet session → spawn Opus analysis session
      await sendMessage(sessionName, '동일 에러 반복. 분석 세션 소환 중... 잠깐 기다려.');
      await spawnOpusAnalyst(sessionName, errKey, reg);
      log_event('escalation_opus_spawned', { session: sessionName, model: 'sonnet' });
    }
  } else if (nextState === 'escalated') {
    // Opus/self-verify didn't resolve → Telegram as final fallback
    addCycleAlert('escalation_escalated', sessionName);
    deps.telegram.notify(
      `⚠️ *에러 지속*\n세션: \`${sessionName}\`\n${(errKey || '').slice(0, 200)}`,
      { parse_mode: 'Markdown' }
    );
    log_event('escalation_escalated', { session: sessionName });
  }
}

// Core FSM transition; event = 'error'|'same_error'|'resolved'|'sent'|'timeout' (or null = auto-derive)
// Normalize error text for comparison: numbers→N, paths→.../
function normalizeError(err) {
  return (err || '').replace(/\d+/g, 'N').replace(/\/[^\s\/]+\//g, '/.../').replace(/\\[^\s\\]+\\/g, '\\...\\');
}

async function transitionEscalation(session, event, errKey) {
  const sn  = session.name;
  const st  = escalationMap.get(sn) || { state: 'normal', lastError: '', stateTs: 0 };
  const normKey = normalizeError(errKey);

  // Auto-derive event if not provided
  let evt = event;
  if (!evt) {
    if (!normKey)                                    evt = 'resolved';
    else if (normKey === normalizeError(st.lastError)) evt = 'same_error';
    else                                               evt = 'error';
  }

  // Cooldown timeout auto-transition
  if (st.state === 'cooldown' && Date.now() - st.stateTs > 30 * 60_000) evt = 'timeout';

  // Look up next state from FSM table
  const nextState = ESCALATION_FSM[st.state]?.[evt];
  if (!nextState) { escalationMap.set(sn, st); return; } // no transition

  // 3-min minimum dwell time (except normal → warned which is immediate)
  if (st.state !== 'normal' && Date.now() - st.stateTs < 3 * 60_000) {
    escalationMap.set(sn, st); return;
  }

  // Execute entry action then commit transition
  await onEnterState(sn, nextState, errKey || st.lastError);
  st.state    = nextState;
  st.stateTs  = Date.now();
  st.lastError = errKey || st.lastError;
  escalationMap.set(sn, st);

  // escalated → immediately send 'sent' to move to cooldown
  if (nextState === 'escalated') await transitionEscalation(session, 'sent', errKey);
}

// Public wrapper called in 60s cycle
async function checkEscalation(session) {
  const errKey = (session.errors || []).length > 0 ? session.errors.join('|') : null;
  // Rate limit skip — rate limit/overloaded errors don't escalate (wait resolves them)
  if (errKey && /rate.limit|overloaded/i.test(errKey)) return;
  // Solution cache hit → send directly, skip escalation entirely
  if (errKey) {
    const cachedSol = matchSolution(errKey);
    if (cachedSol && !dedup(`cache_hit_${session.name}`, 10 * 60_000)) {
      sendMessage(session.name, `이 에러 전에 해결한 적 있어. 이 방법 먼저 써봐:\n${cachedSol}`).catch(() => {});
      log_event('solution_cache_hit', { session: session.name });
      return;
    }
  }
  // S-2 sliding window: track error cycles per session
  const errCount = updateErrWindow(session.name, !!errKey);
  // 5사이클 중 3+에러 축적 → 구조적 문제 → force escalation
  if (errCount >= 3 && !dedup(`s2_window_${session.name}`, 10 * 60_000)) {
    // Check solution cache first
    const cachedSol = matchSolution(errKey || '');
    if (cachedSol) {
      await sendMessage(session.name, `이 에러 전에 해결한 적 있어. 이 방법 먼저 써봐:\n${cachedSol}`);
      log_event('solution_cache_hit_s2', { session: session.name });
      return;
    }
    await transitionEscalation(session, 'same_error', errKey); // force into analyzing
    return;
  }
  await transitionEscalation(session, null, errKey);
}

// #21 — Struggle detection (JS reimplementation of detect-struggle.py)
function detectStruggle(sessionDir, sid) {
  if (!sid) return null;
  const homeDir  = process.env.USERPROFILE || os.homedir();
  const projDir  = path.join(homeDir, '.claude', 'projects');

  // Locate {sid}.jsonl by scanning all project subdirs
  let jsonlPath = null;
  try {
    for (const entry of fs.readdirSync(projDir)) {
      const candidate = path.join(projDir, entry, `${sid}.jsonl`);
      if (fs.existsSync(candidate)) { jsonlPath = candidate; break; }
    }
  } catch { return null; }
  if (!jsonlPath) return null;

  try {
    const stat = fs.statSync(jsonlPath);
    if (Date.now() - stat.mtimeMs > 10 * 60_000) return null; // idle > 10 min
  } catch { return null; }

  let raw;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch { return null; }

  const events = [];
  for (const line of raw.split('\n').slice(-500)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }

  // 1. fix-fail loop: same file edited 3+ times
  const editCounts = {};
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    for (const block of (Array.isArray(ev.message?.content) ? ev.message.content : [])) {
      if (block.type !== 'tool_use') continue;
      if (block.name !== 'Edit' && block.name !== 'Write') continue;
      const file = block.input?.file_path || '';
      if (!file) continue;
      editCounts[file] = (editCounts[file] || 0) + 1;
      if (editCounts[file] >= 3) return { type: 'fix-fail loop', details: `${file} x${editCounts[file]}` };
    }
  }

  // 2. bash retry: same command 3+ consecutive without Edit between
  let lastCmd = null, bashStreak = 0;
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    for (const block of (Array.isArray(ev.message?.content) ? ev.message.content : [])) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'Bash') {
        const cmd = (block.input?.command || '').slice(0, 100);
        if (cmd === lastCmd) { bashStreak++; }
        else { lastCmd = cmd; bashStreak = 1; }
        if (bashStreak >= 3) return { type: 'bash retry', details: `"${cmd}" x${bashStreak}` };
      } else if (block.name === 'Edit' || block.name === 'Write') {
        lastCmd = null; bashStreak = 0;
      }
    }
  }

  // 3. consecutive errors: 3+ consecutive tool_result is_error
  let consErr = 0;
  for (const ev of events) {
    if (ev.type !== 'user') continue;
    const hasError = (Array.isArray(ev.message?.content) ? ev.message.content : [])
      .some(c => c.type === 'tool_result' && c.is_error);
    if (hasError) { consErr++; if (consErr >= 3) return { type: 'consecutive errors', details: `${consErr}` }; }
    else { consErr = 0; }
  }

  return null;
}

// Called in 60s cycle — struggle check for all active sessions
const struggleCountMap = new Map(); // key: sessionName → consecutive struggle cycle count

async function processStruggle(sessions) {
  const registered = getRegisteredSessions();
  for (const s of sessions) {
    if (s.status === 'IDLE' || s.status === 'DEAD' || s.status === 'AGENT_DEAD' || s.status === 'SESSION_DEAD') continue;
    const reg = registered.find(r => r.name === s.name);
    if (!reg?.sid) continue;
    const result = detectStruggle(s.dir, reg.sid);
    if (!result) { struggleCountMap.set(s.name, 0); continue; }

    const count = (struggleCountMap.get(s.name) || 0) + 1;
    struggleCountMap.set(s.name, count);

    if (count === 1) {
      // 1차: 넛지 (자기 정리 유도)
      if (!dedup(`struggle_${s.name}_${result.type}`, 10 * 60_000)) {
        await sendMessage(s.name, `삽질 감지: ${result.type}. ${result.details}\n\n지금 접근 방식 멈추고 정리해:\n1. 마지막 에러 메시지가 정확히 뭐야?\n2. 시도한 것들이 왜 안 됐어?\n3. 근본 원인이 다른 데 있을 수 있어?`);
        log_event('struggle_nudge', { session: s.name, count: 1, ...result });
      }
    } else if (count >= 2) {
      // 2차: 모델 기반 에스컬레이션 (같은 체인 연결)
      if (!dedup(`struggle_escalate_${s.name}`, 30 * 60_000)) {
        addCycleAlert('struggle', s.name);
        await transitionEscalation(s, 'error', `struggle:${result.type}`);
        log_event('struggle_escalated', { session: s.name, count, ...result });
      }
    }
  }
}

// Guard blocking patterns — only match actual Claude Code guard/hook messages
const GUARD_BLOCK_RE = [
  /blocked by.*guard/i,                    // PreToolUse guard block
  /PreToolUse.*denied/i,                   // hook guard denial
  /doesn't want to proceed with this tool/i, // user rejection via guard
  /Do you want to proceed.*\?\s*$/im,      // permission prompt (line-end, not in code)
  /Do you trust.*\?\s*$/im,               // trust prompt (line-end, not in code)
];

// #22 — Guard deadlock detection + unlock
async function checkGuardDeadlock(session) {
  const text      = session.text || '';
  const isBlocked = GUARD_BLOCK_RE.some(p => p.test(text));

  if (!isBlocked) {
    // Guard no longer blocked → session resumed. Restore settings if backup exists.
    if (guardDetectedAt.has(session.name) && fs.existsSync(GUARD_RESTORE_FILE)) {
      try {
        const backup = JSON.parse(fs.readFileSync(GUARD_RESTORE_FILE, 'utf8'));
        const current = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        // Restore only permissions.deny from backup (not full overwrite)
        if (backup.permissions?.deny) {
          current.permissions = current.permissions || {};
          current.permissions.deny = backup.permissions.deny;
          fs.writeFileSync(SETTINGS_PATH, JSON.stringify(current, null, 2), 'utf8');
        }
        fs.unlinkSync(GUARD_RESTORE_FILE);
        console.log('[secretary] guard auto-restored after session resumed');
        log_event('guard_auto_restored', { session: session.name });
      } catch (e) { console.error('[secretary] guard restore error:', e.message); }
    }
    guardDetectedAt.delete(session.name);
    return;
  }

  const first = guardDetectedAt.get(session.name);
  if (!first) { guardDetectedAt.set(session.name, Date.now()); return; }
  if (Date.now() - first < 3 * 60_000) return;       // not yet 3 min
  if (dedup(`guard_deadlock_${session.name}`, 10 * 60_000)) return;

  let blockedMatch = '';
  for (const p of GUARD_BLOCK_RE) {
    const m = text.match(p);
    if (m) { blockedMatch = m[0]; break; }
  }

  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Backup only permissions.deny before modifying (not full settings — prevents overwrite risk)
    if (!fs.existsSync(GUARD_RESTORE_FILE) && Array.isArray(settings.permissions?.deny)) {
      fs.writeFileSync(GUARD_RESTORE_FILE, JSON.stringify({ permissions: { deny: settings.permissions.deny } }, null, 2), 'utf8');
    }

    let patched = false;
    if (Array.isArray(settings.permissions?.deny)) {
      const keyword = blockedMatch.toLowerCase().slice(0, 20);
      settings.permissions.deny = settings.permissions.deny.filter(rule => {
        const match = keyword && rule.toLowerCase().includes(keyword);
        if (match) patched = true;
        return !match;
      });
    }

    if (patched) {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
      await sendMessage(session.name, 'guard 임시 해제됨. 작업 재개해.');
      log_event('guard_deadlock_unlock', { session: session.name, guard: blockedMatch });
      addCycleAlert('guard_deadlock_unlock', session.name);
    } else {
      // Pattern found but no deny rule matched — just nudge
      fs.unlinkSync(GUARD_RESTORE_FILE); // no restore needed
      await sendMessage(session.name, 'guard 차단 감지. 설정 확인 후 재개해.');
      log_event('guard_deadlock_nudge', { session: session.name, guard: blockedMatch });
    }
  } catch (e) {
    console.error('[secretary] guard deadlock error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────
// Phase 5: JSONL audit (#23) — JS-native, no Python/jq
// ─────────────────────────────────────────────────────────

function loadAuditOffsets() {
  try {
    for (const line of fs.readFileSync(OFFSET_MARKER, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      auditOffsetMap.set(line.slice(0, eq), parseInt(line.slice(eq + 1), 10) || 0);
    }
  } catch {}
}

function saveAuditOffsets() {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const lines = [...auditOffsetMap.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(OFFSET_MARKER, lines + '\n', 'utf8');
  } catch {}
}

// Parse JSONL lines from skipCount onwards — returns { summary, editFiles }
function parseJsonlLines(lines, skipCount) {
  const toolCounts = {}, editFiles = new Set(), riskyCmds = [], agentSpawns = [], agentResults = [];
  const pendingAgents = {};
  const RISKY = ['rm ', '--force', 'reset --hard', 'drop', 'kill'];

  for (let i = skipCount; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let d; try { d = JSON.parse(lines[i]); } catch { continue; }

    if (d.type === 'assistant') {
      for (const c of (d.message?.content || [])) {
        if (!c || c.type !== 'tool_use') continue;
        const { name = '', input: inp = {}, id: tid = '' } = c;
        toolCounts[name] = (toolCounts[name] || 0) + 1;
        if ((name === 'Edit' || name === 'Write') && inp.file_path) editFiles.add(inp.file_path);
        if (name === 'Bash') {
          const cmd = (inp.command || '').slice(0, 120);
          if (RISKY.some(k => cmd.includes(k))) riskyCmds.push(cmd);
        }
        if (name === 'Agent') {
          agentSpawns.push((inp.description || '').slice(0, 60));
          if (tid) pendingAgents[tid] = agentSpawns[agentSpawns.length - 1];
        }
      }
    } else if (d.type === 'tool' && d.tool_use_id && pendingAgents[d.tool_use_id]) {
      const desc = pendingAgents[d.tool_use_id]; delete pendingAgents[d.tool_use_id];
      let txt = '';
      for (const rc of (d.content || [])) {
        if (rc?.type === 'text') { txt = (rc.text || '').slice(0, 300); break; }
        else if (typeof rc === 'string') { txt = rc.slice(0, 300); break; }
      }
      const m = txt.match(/\b(CRITICAL|MUST FIX|PASSED?|FAILED?|PARTIAL_PASS|WARNING)\b/i);
      agentResults.push(`${desc}:${m ? m[1].toUpperCase() : 'ok'}`);
    }
  }

  const parts = [];
  const top = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length)          parts.push('tools='   + top.map(([k, v]) => `${k}:${v}`).join(','));
  if (editFiles.size)      parts.push('edited='  + [...editFiles].sort().slice(0, 10).join(','));
  if (riskyCmds.length)    parts.push('RISKY='   + riskyCmds.slice(0, 3).join('|'));
  if (agentSpawns.length)  parts.push('agents='  + agentSpawns.slice(0, 3).join(','));
  if (agentResults.length) parts.push('results=' + agentResults.slice(0, 5).join(','));
  return { summary: parts.join('; '), editFiles: [...editFiles] };
}

async function collectJsonlAudit() {
  const homeDir   = process.env.USERPROFILE || os.homedir();
  const projDir   = path.join(homeDir, '.claude', 'projects');
  const registered = getRegisteredSessions();
  const knownSids  = new Set(registered.map(r => r.sid).filter(Boolean));
  const scannedDirs = new Set();

  for (const reg of registered) {
    if (!reg.sid) continue;
    let jsonlPath = null;
    try {
      for (const sub of fs.readdirSync(projDir)) {
        const c = path.join(projDir, sub, `${reg.sid}.jsonl`);
        if (fs.existsSync(c)) { jsonlPath = c; break; }
      }
    } catch { continue; }
    if (!jsonlPath) continue;

    const key   = `${reg.name}_lines`;
    const lastN = auditOffsetMap.get(key) || 0;
    let lines; try { lines = fs.readFileSync(jsonlPath, 'utf8').split('\n'); } catch { continue; }
    if (lines.length > lastN) {
      const r = parseJsonlLines(lines, lastN);
      if (r.summary) log_event('jsonl_audit', { session: reg.name, sid: reg.sid.slice(0, 8), context: r.summary });
      auditOffsetMap.set(key, lines.length);
    }

    const dir = path.dirname(jsonlPath);
    if (scannedDirs.has(dir)) continue;
    scannedDirs.add(dir);

    // Subagent scan — JSONL files in same dir not in registry
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const subSid = f.slice(0, -6);
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(subSid)) continue;
        if (knownSids.has(subSid)) continue;
        const subKey  = `sub_${subSid.replace(/-/g, '')}_lines`;
        const subLast = auditOffsetMap.get(subKey) || 0;
        let subLines; try { subLines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch { continue; }
        if (subLines.length <= subLast) continue;
        const r = parseJsonlLines(subLines, subLast);
        if (r.summary) log_event('jsonl_audit', { session: reg.name, subagent: true, sid: subSid.slice(0, 8), context: r.summary });
        auditOffsetMap.set(subKey, subLines.length);
      }
    } catch {}
  }

  // Cleanup stale sub-agent offset keys
  const stale = [];
  for (const key of auditOffsetMap.keys()) {
    if (!key.startsWith('sub_') || !key.endsWith('_lines')) continue;
    const raw = key.slice(4, -6);
    if (raw.length !== 32) continue;
    const uuid = `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
    let found = false;
    try { for (const e of fs.readdirSync(projDir)) { if (fs.existsSync(path.join(projDir, e, `${uuid}.jsonl`))) { found = true; break; } } } catch {}
    if (!found) stale.push(key);
  }
  for (const k of stale) auditOffsetMap.delete(k);
  saveAuditOffsets();
}

// ─────────────────────────────────────────────────────────
// Phase 5: Auto-registration (#24)
// ─────────────────────────────────────────────────────────
const WF_SESSION_RE = /^(worker|verifier|healer|strategic)$/;
const SKIP_REG_RE   = /^(task|schedule|secretary)/;

async function autoRegisterSessions() {
  const out = await deps.tmuxRun('list-sessions');
  if (!out) return;
  const names = out.split('\n')
    .map(l => { const m = l.match(/^([^:]+):/); return m ? m[1].trim() : null; })
    .filter(Boolean);
  const registered = new Set(getRegisteredSessions().map(r => r.name));

  let added = 0;
  for (const name of names) {
    if (WF_SESSION_RE.test(name))  continue;
    if (SKIP_REG_RE.test(name))    continue;
    if (registered.has(name))      continue;

    // Get CWD from psmux session
    let dir = 'unknown';
    try {
      const cwd = await deps.tmuxRun(`display-message -p "#{pane_current_path}" -t ${name}`);
      if (cwd?.trim()) dir = cwd.trim();
    } catch {}

    // Find SID: most recent JSONL in ~/.claude/projects/ modified in last 120 min
    let sid = '';
    const homeDir = process.env.USERPROFILE || os.homedir();
    const projDir = path.join(homeDir, '.claude', 'projects');
    const registeredSids = new Set(getRegisteredSessions().map(r => r.sid).filter(Boolean));
    try {
      const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
      const cutoff = Date.now() - 120 * 60_000;
      for (const entry of fs.readdirSync(projDir)) {
        const subdir = path.join(projDir, entry);
        try {
          for (const f of fs.readdirSync(subdir)) {
            if (!f.endsWith('.jsonl')) continue;
            const candidate = f.slice(0, -6);
            if (!UUID_RE.test(candidate)) continue;
            if (registeredSids.has(candidate)) continue;
            const stat = fs.statSync(path.join(subdir, f));
            if (stat.mtimeMs > cutoff) { sid = candidate; break; }
          }
        } catch {}
        if (sid) break;
      }
    } catch {}

    // Model: strategic=opus, default=sonnet
    const model = name === 'strategic' ? 'opus' : 'sonnet';
    const ts = new Date().toISOString();
    try { fs.appendFileSync(deps.SECRETARY_REGISTRY, `${name}|${model}|${dir}|${ts}|${sid}\n`, 'utf8'); added++; } catch {}
    log_event('auto_register', { session: name, dir, sid: sid ? sid.slice(0, 8) : 'none' });
  }
  if (added) console.log(`[secretary] auto-registered ${added} sessions`);
}

// ─────────────────────────────────────────────────────────
// Phase 5: WF orphan cleanup (#25)
// ─────────────────────────────────────────────────────────
async function cleanupOrphanWf() {
  if (!fs.existsSync(WF_ACTIVE_FILE)) return;
  let stat; try { stat = fs.statSync(WF_ACTIVE_FILE); } catch { return; }
  if (Date.now() - stat.mtimeMs < 2 * 3_600_000) return; // < 2h

  const out   = await deps.tmuxRun('list-sessions');
  const hasWf = out && /\b(worker|verifier|healer|strategic)\b/.test(out);
  if (!hasWf) {
    try { fs.unlinkSync(WF_ACTIVE_FILE); } catch {}
    log_event('wf_orphan_cleanup', { staleMin: Math.round((Date.now() - stat.mtimeMs) / 60000) });
    console.log('[secretary] .wf-active orphan removed');
  }
}

// ─────────────────────────────────────────────────────────
// Phase 6: Promotion-log nudge (#26) — triggers 3 + 4
// ─────────────────────────────────────────────────────────
async function checkPromotionNudge(sessions) {
  const today  = new Date().toISOString().slice(0, 10);
  const active = sessions.filter(s => s.status !== 'DEAD');
  if (!active.length) return;

  // Trigger 3 (WF ended + promo-log stale) handled by checkWfCompletion — no duplicate here

  // Trigger 4: docs Read 1+ or Edit/Write 3+ in today's audit log
  try {
    const logPath = path.join(AUDIT_DIR, `${today}.jsonl`);
    if (!fs.existsSync(logPath)) return;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-200);
    let docsReads = 0, docsEdits = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type !== 'jsonl_audit' || !ev.context) continue;
        if (/tools=.*Read/i.test(ev.context) && /docs\//i.test(ev.context)) docsReads++;
        if (/edited=.*docs\//i.test(ev.context)) docsEdits++;
      } catch {}
    }
    if (docsReads >= 1 && !dedup(`request_remind_${today}`, 86_400_000)) {
      await sendMessage(active[0].name, 'docs Read 감지. 유용한 요청 있으면 promotion-log에 기록해.');
      log_event('promo_nudge', { trigger: 'docs_read', today });
    }
    if (docsEdits >= 3 && !dedup(`pattern_remind_${today}`, 86_400_000)) {
      await sendMessage(active[0].name, 'docs Edit 3+회 감지. 새 패턴 있으면 promotion-log에 기록해.');
      log_event('promo_nudge', { trigger: 'docs_edit', today });
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────
// Phase 6: progress.md 생성 넛지 (#15 복원)
// ─────────────────────────────────────────────────────────
async function checkProgressNudge(sessions) {
  const today = new Date().toISOString().slice(0, 10);
  const registered = getRegisteredSessions();
  for (const s of sessions) {
    if (s.status === 'SESSION_DEAD' || s.status === 'AGENT_DEAD') continue;
    const reg = registered.find(r => r.name === s.name);
    if (!reg?.dir || reg.dir === 'unknown') continue;
    const planExists = fs.existsSync(path.join(reg.dir, 'plan.md'));
    const progressExists = fs.existsSync(path.join(reg.dir, 'progress.md'));
    if (!planExists || progressExists) continue;
    // 세션 30분+ (레지스트리 타임스탬프 기반, 없으면 스킵)
    if (!reg.ts) continue;
    try {
      const created = new Date(reg.ts).getTime();
      if (Date.now() - created < 30 * 60_000) continue;
    } catch { continue; }
    if (dedup(`progress_nudge_${s.name}_${today}`, 86_400_000)) continue;
    await sendMessage(s.name, 'plan.md가 있는데 progress.md가 없어. 진행 추적용으로 만들어.');
    log_event('progress_nudge', { session: s.name });
  }
}

// ─────────────────────────────────────────────────────────
// Phase 6: WF completion → promo-log check (#27)
// ─────────────────────────────────────────────────────────
async function checkWfCompletion(sessions) {
  const wfActive = fs.existsSync(WF_ACTIVE_FILE);
  if (wfActive) { wfWasActive = true; return; }
  if (!wfWasActive) return;
  wfWasActive = false;

  const active = sessions.filter(s => s.status !== 'DEAD');
  // Nudge to clean up execution-log if present
  if (fs.existsSync(EXEC_LOG_PATH) && active.length) {
    await sendMessage(active[0].name, 'WF 완료. execution-log.md 정리(삭제/아카이브) 고려해.');
  }
  // Nudge promo-log if stale
  try {
    const stat = fs.statSync(PROMO_LOG_PATH);
    if (Date.now() - stat.mtimeMs > 5 * 60_000 && !dedup('wf_promo_check', 3_600_000) && active.length) {
      await sendMessage(active[0].name, 'WF 종료. promotion-log 업데이트 고려해.');
      log_event('promo_nudge', { trigger: 'wf_complete' });
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────
// Phase 6: Cycle alert accumulator (#29)
// ─────────────────────────────────────────────────────────
function addCycleAlert(type, session) {
  const IMPORTANT = new Set(['escalation_escalated', 'struggle', 'guard_deadlock_unlock']);
  if (IMPORTANT.has(type)) cycleAlerts.push({ type, session });
}

async function flushTelegramAgg(cycleNum) {
  if (!cycleAlerts.length) return;
  const copy = cycleAlerts.splice(0);
  if (dedup(`telegram_agg_${cycleNum}`, 120_000)) return;
  const summary = copy.map(e => `• ${e.type}: ${e.session || ''}`).join('\n');
  deps.telegram.notify(`🔔 *사이클 알림*\n${summary}`, { parse_mode: 'Markdown' });
  log_event('telegram_agg', { count: copy.length, events: copy });
}

// ─────────────────────────────────────────────────────────
// Phase 6: Weekly audit + log rotation (#28)
// ─────────────────────────────────────────────────────────
async function runWeeklyAudit() {
  const now = new Date();
  if (now.getDay() !== 0) return; // Sunday only
  if (now.getHours() < 9 || now.getHours() > 10) return; // 9~10 AM
  if (dedup('weekly_audit', 23 * 3_600_000)) return;
  deps.telegram.notify('📊 *주간 감사 리마인더*\npromotion-log 및 시스템 점검 진행해.', { parse_mode: 'Markdown' });
  log_event('weekly_audit', {});
}

function rotateAuditLogs() {
  const cutoff = Date.now() - 30 * 24 * 3_600_000; // 30 days
  try {
    for (const f of fs.readdirSync(AUDIT_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const fp = path.join(AUDIT_DIR, f);
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); console.log(`[secretary] rotated: ${f}`); }
      } catch {}
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────
// Main loop — setTimeout recursive (no setInterval)
// ─────────────────────────────────────────────────────────
async function runCycle() {
  cycleCount++;
  try {
    const report   = await buildReport();
    const sessions = report.sessions;

    // Per-session: dead detection + snapshot + stuck + context
    for (const s of sessions) {
      // DEAD/SESSION_DEAD → Telegram alert (dedup per session)
      if ((s.status === 'SESSION_DEAD' || s.status === 'AGENT_DEAD') && !dedup(`dead_notify_${s.name}`, 30 * 60_000)) {
        addCycleAlert(`${s.status.toLowerCase()}`, s.name);
        log_event('session_dead', { session: s.name, status: s.status });
      }
      if (s.status === 'SESSION_DEAD') continue; // 사라진 세션은 다른 처리 불필요
      updateSnapshot(s.name, s.text);
      await checkStuck(s);
      await checkContextWarning(s);
    }

    // Cross-session
    await checkRateLimit(sessions);
    await checkFileConflict(sessions);
    await checkUserPresence(sessions);

    // 60 s cycle (every 4th = 4 × 15s)
    if (cycleCount % 4 === 0) {
      for (const s of sessions) await checkCircularWork(s);
      // Phase 3: git integration
      await processCommits(sessions);
      // Phase 4: escalation chain + struggle + guard deadlock
      for (const s of sessions) await checkEscalation(s);
      for (const s of sessions) await checkGuardDeadlock(s);
      await processStruggle(sessions);
      // Phase 5+6: auto-register + WF completion + promo nudge
      await autoRegisterSessions();
      await checkWfCompletion(sessions);
      await checkPromotionNudge(sessions);
      await checkProgressNudge(sessions);
      // Phase 6: Telegram aggregated alert (end of 60s cycle)
      await flushTelegramAgg(cycleCount);
      log_event('cycle_60s', { cycleCount, sessions: sessions.length });
    }

    // 300 s cycle (every 20th = 20 × 15s)
    if (cycleCount % 20 === 0) {
      loadSolutionCache(); // reload error-solutions.json
      flushDedupState();
      const cutoff = Date.now() - 3_600_000; // 1 hour
      for (const [k, v] of dedupMap) {
        if (v < cutoff) dedupMap.delete(k);
      }
      // Phase 5+6: JSONL audit + WF orphan cleanup + weekly audit + log rotation
      await collectJsonlAudit();
      await cleanupOrphanWf();
      await runWeeklyAudit();
      rotateAuditLogs();
      // Sweep dead session entries from all Maps
      const liveNames = new Set(sessions.map(s => s.name));
      for (const m of [paneCacheMap, snapshotMap, circularMap, escalationMap, guardDetectedAt, lastCommitMap]) {
        for (const k of m.keys()) { if (!liveNames.has(k)) m.delete(k); }
      }
    }

  } catch (e) {
    console.error('[secretary] cycle error:', e.message);
  }

  loopTimer = setTimeout(runCycle, 15_000);
}

// ─────────────────────────────────────────────────────────
// Opus analyst session spawn (for Sonnet session error analysis)
// ─────────────────────────────────────────────────────────
const SPAWN_SCRIPT = path.join(__dirname, '.secretary', '.scripts', 'spawn-session.sh');
const ANALYST_SESSION = 'opus-analyst';
const ANALYST_ROLE_FILE = path.join(__dirname, '.harness', `${ANALYST_SESSION}-role.md`);

async function spawnOpusAnalyst(targetSession, errKey, reg) {
  // Write analysis task role file
  const sid = reg?.sid || '';
  const dir = reg?.dir || '';
  const roleContent = [
    '## Opus 분석 태스크',
    '',
    `타겟 세션: ${targetSession}`,
    `에러: ${(errKey || '').slice(0, 500)}`,
    `프로젝트 디렉토리: ${dir}`,
    sid ? `JSONL SID: ${sid}` : '(JSONL 없음)',
    '',
    '### 실행 순서',
    '1. 타겟 세션의 JSONL을 Read해서 최근 작업 맥락 파악 (뭘 하다가 에러났는지)',
    sid ? `   경로: ~/.claude/projects/ 에서 ${sid}.jsonl 검색` : '   (JSONL 없으면 git log --oneline -10 으로 대체)',
    `2. 프로젝트 디렉토리(${dir})에서 관련 소스 파일 Read → 에러 원인 특정`,
    '3. 근본 원인 + 구체적 수정 방향을 정리해서 타겟 세션에 전달:',
    `   Bash: psmux send-keys -t ${targetSession} "Read {결과파일경로}" Enter`,
    '4. 전달 완료 후 /exit 로 종료',
    '',
    '### 결과 파일',
    `Write 도구로 /tmp/opus-analysis-${targetSession}.txt 에 분석 결과 저장 후 Read 지시`,
    '',
    '### 제약',
    '- 타겟 세션의 코드를 직접 수정하지 마. 분석+방향 제시만.',
    '- 5분 이내 완료해.',
  ].join('\n');

  try {
    fs.mkdirSync(path.dirname(ANALYST_ROLE_FILE), { recursive: true });
    fs.writeFileSync(ANALYST_ROLE_FILE, roleContent, 'utf8');
  } catch (e) {
    console.error('[secretary] opus-analyst role write error:', e.message);
    return;
  }

  // Spawn via spawn-session.sh (handles session creation, Claude launch, handshake, role injection)
  const spawnCmd = `bash "${SPAWN_SCRIPT.replace(/\\/g, '/')}" ${ANALYST_SESSION}`;
  exec(spawnCmd, { timeout: 120_000 }, (err) => {
    if (err) {
      console.error('[secretary] opus-analyst spawn error:', err.message);
      // Spawn failed → Telegram fallback
      deps.telegram.notify(`⚠️ Opus 분석 세션 스폰 실패: ${targetSession}\n${(errKey || '').slice(0, 200)}`, { parse_mode: 'Markdown' });
    } else {
      console.log(`[secretary] opus-analyst spawned for ${targetSession}`);
      // Auto-kill after 6 minutes (safety net)
      setTimeout(() => {
        exec(`"${deps.PSMUX_BIN}" kill-session -t ${ANALYST_SESSION}`, () => {
          console.log('[secretary] opus-analyst auto-killed (timeout)');
        });
      }, 6 * 60_000);
    }
  });
}

// ─────────────────────────────────────────────────────────
// S-2 sliding window: 5-cycle error accumulation detection
// ─────────────────────────────────────────────────────────
const errWindowMap = new Map(); // key: sessionName → number[] (1=error, 0=clean, max 5)

function updateErrWindow(sessionName, hasError) {
  const win = errWindowMap.get(sessionName) || [];
  win.push(hasError ? 1 : 0);
  if (win.length > 5) win.shift();
  errWindowMap.set(sessionName, win);
  return win.reduce((a, b) => a + b, 0); // count of error cycles
}

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

/**
 * startSecretary(deps)
 * deps: { tmuxRun, parseSessionNames, captureTail, PSMUX_BIN,
 *         getActiveSessionObjects, SECRETARY_REGISTRY, ALWAYS_PROTECTED,
 *         SESSION_PREFIX, AI_TASK_PREFIX, BASH_PATH, AGENT_SECRET, telegram }
 */
function startSecretary(injectedDeps) {
  deps = injectedDeps;
  checkGuardRestore();
  loadDedupState();
  loadSolutionCache();
  loadAuditOffsets();
  console.log('[secretary] JS loop started (15 s cycle)');
  loopTimer = setTimeout(runCycle, 5_000); // small initial delay
}

function stopSecretary() {
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  flushDedupState();
  console.log('[secretary] stopped');
}

module.exports = { startSecretary, stopSecretary, generateSessionResume };
