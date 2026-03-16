const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 9876;
const PIN_HASH = process.env.PIN_HASH;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const PROJECTS_DIR = process.env.PROJECTS_DIR || 'D:\\projects';
const EDITOR_CMD = process.env.EDITOR_CMD || 'code';
const BASH_PATH = process.env.BASH_PATH || 'C:\\msys64\\usr\\bin\\bash.exe';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const IGNORE_DIRS_ENV = process.env.IGNORE_DIRS || 'node_modules,screenshots';
const EDITOR_TITLE = process.env.EDITOR_TITLE || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'opus';

// Warn if path-sensitive env vars use short command names (may fail without PATH)
for (const [name, val] of [['EDITOR_CMD', EDITOR_CMD], ['CLAUDE_BIN', CLAUDE_BIN]]) {
  if (!val.includes('/') && !val.includes('\\')) {
    console.warn(`[config] WARNING: ${name}="${val}" is not a full path. Set absolute path in .env to avoid PATH issues.`);
  }
}

// --- Middleware ---

app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

// --- Rate limiting (in-memory) ---

const authAttempts = [];
const AUTH_WINDOW_MS = 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

let lockoutUntil = 0;

function recordFailedAttempt() {
  const now = Date.now();
  authAttempts.push(now);
  // Prune old entries
  while (authAttempts.length > 0 && authAttempts[0] < now - AUTH_WINDOW_MS) {
    authAttempts.shift();
  }
  if (authAttempts.length >= MAX_FAILED_ATTEMPTS) {
    lockoutUntil = now + LOCKOUT_MS;
    authAttempts.length = 0;
  }
}

function isLockedOut() {
  return Date.now() < lockoutUntil;
}

// Shutdown rate limit: max 3 per minute
const shutdownAttempts = [];
const SHUTDOWN_WINDOW_MS = 60 * 1000;
const MAX_SHUTDOWN_ATTEMPTS = 3;

function canShutdown() {
  const now = Date.now();
  while (shutdownAttempts.length > 0 && shutdownAttempts[0] < now - SHUTDOWN_WINDOW_MS) {
    shutdownAttempts.shift();
  }
  return shutdownAttempts.length < MAX_SHUTDOWN_ATTEMPTS;
}

function recordShutdownAttempt() {
  shutdownAttempts.push(Date.now());
}

// --- PIN verification middleware ---

async function verifyPin(req, res, next) {
  if (isLockedOut()) {
    return res.status(429).json({ ok: false, message: 'Too many failed attempts. Try again later.' });
  }

  const pin = req.headers['x-pin-hash'];
  if (!pin || !PIN_HASH) {
    recordFailedAttempt();
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }

  try {
    const match = await bcrypt.compare(pin, PIN_HASH);
    if (!match) {
      recordFailedAttempt();
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }
    next();
  } catch (err) {
    recordFailedAttempt();
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
}

// --- Routes ---

app.get('/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime() });
});

app.post('/shutdown', verifyPin, (req, res) => {
  if (!canShutdown()) {
    return res.status(429).json({ ok: false, message: 'Rate limit: max 3 shutdown attempts per minute' });
  }

  recordShutdownAttempt();
  exec('shutdown /s /t 5', (err) => {
    if (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
    res.json({ ok: true, message: 'Shutting down in 5s' });
  });
});

// --- Projects ---

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const IGNORE_DIRS = new Set(IGNORE_DIRS_ENV.split(',').map(s => s.trim()).filter(Boolean));

// Windows path → MSYS path (e.g. D:\projects → /d/projects)
const toMsys = (p) => p.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/${d.toLowerCase()}`);

// tasks.json: open tmux session with claude on folder open
const SESSION_PREFIX = 'btn-';

function buildTasksJson(name) {
  const session = `${SESSION_PREFIX}${name}`;
  // Task only attaches to existing session (agent creates it independently)
  // Wait loop handles race: session may not exist yet when VS Code task starts
  const attachCmd = `timeout=30; while [ $timeout -gt 0 ] && ! tmux has-session -t ${session} 2>/dev/null; do sleep 0.5; timeout=$((timeout-1)); done; tmux attach-session -t ${session}`;
  return {
    version: "2.0.0",
    tasks: [{
      label: "claude-tmux",
      type: "shell",
      command: attachCmd,
      options: {
        shell: {
          executable: BASH_PATH,
          args: ["-l", "-c"]
        }
      },
      runOptions: { runOn: "folderOpen" },
      presentation: { reveal: "always", focus: true, panel: "dedicated" },
      isBackground: true,
      problemMatcher: []
    }]
  };
}

// Protected sessions file (survives agent restart)
const PROTECTED_FILE = path.join(__dirname, '.protected-sessions');

function getProtectedSessions() {
  try { return JSON.parse(fs.readFileSync(PROTECTED_FILE, 'utf8')); } catch { return []; }
}

function setProtectedSessions(list) {
  fs.writeFileSync(PROTECTED_FILE, JSON.stringify(list));
}

async function getActiveSessions() {
  return new Promise((resolve) => {
    exec(`"${BASH_PATH}" -lc "tmux list-sessions -F '#S' 2>/dev/null"`, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.trim().split('\n')
        .filter(s => s.startsWith(SESSION_PREFIX))
        .map(s => s.slice(SESSION_PREFIX.length)));
    });
  });
}

function killUnprotectedSessions() {
  const scriptPath = path.join(__dirname, 'kill-sessions.sh').replace(/\\/g, '/');
  const closeScript = path.join(__dirname, 'close-window.ps1');

  getActiveSessions().then(activeSessions => {
    const protectedList = getProtectedSessions();
    const toKill = activeSessions.filter(s => !protectedList.includes(s));

    if (toKill.length === 0) return;

    console.log(`[kill] Killing unprotected sessions: ${toKill.join(', ')} (protected: ${protectedList.join(', ') || 'none'})`);

    for (const session of toKill) {
      exec(`"${BASH_PATH}" -l "${scriptPath}" "${SESSION_PREFIX}${session}"`, (err) => {
        if (err) console.error(`[kill-sessions] Error killing ${session}:`, err.message);
        const titleQuery = EDITOR_TITLE ? `${session} - ${EDITOR_TITLE}` : session;
        exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
          if (err) console.error(`[close-window] Error closing ${session}:`, err.message);
        });
      });
    }
  });
}

function openProjectInEditor(name) {
  // Kill all unprotected btn-* sessions before opening new project
  killUnprotectedSessions();

  // Also close any existing window for the project we're about to open
  // (prevents VS Code from reusing an already-open window where folderOpen won't re-trigger)
  const closeScript = path.join(__dirname, 'close-window.ps1');
  if (EDITOR_TITLE) {
    const titleQuery = `${name} - ${EDITOR_TITLE}`;
    exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
      if (err) console.error('[close-window] Error closing current project window:', err.message);
    });
  }

  const projDir = path.join(PROJECTS_DIR, name);
  const vscodeDir = path.join(projDir, '.vscode');
  const tasksFile = path.join(vscodeDir, 'tasks.json');

  // Ensure project and .vscode dirs exist
  fs.mkdirSync(vscodeDir, { recursive: true });

  // Write tasks.json (attach-only, agent creates session independently)
  fs.writeFileSync(tasksFile, JSON.stringify(buildTasksJson(name), null, 2));

  // Enable auto-run tasks without prompt
  const settingsFile = path.join(vscodeDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  settings['task.allowAutomaticTasks'] = 'on';
  // Prevent PowerShell Extension from stealing focus from claude-tmux task terminal
  settings['powershell.integratedConsole.startInBackground'] = true;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  // Wait for kill-sessions.sh to finish (~3s) before creating new session
  setTimeout(() => {
    const session = `${SESSION_PREFIX}${name}`;
    const projMsys = toMsys(PROJECTS_DIR);
    const claudeBinMsys = toMsys(CLAUDE_BIN);

    // Create tmux session + start Claude directly from agent
    const createCmd = `tmux kill-session -t ${session} 2>/dev/null; tmux new-session -d -s ${session} -c ${projMsys}/${name}; tmux send-keys -t ${session} '${claudeBinMsys} --dangerously-skip-permissions --model ${CLAUDE_MODEL}' Enter`;
    exec(`"${BASH_PATH}" -lc "${createCmd}"`, (err) => {
      if (err) {
        console.error('[proj] tmux session create error:', err.message);
        return;
      }
      console.log(`[proj] Created tmux session: ${session}`);

      // Poll tmux pane until Claude prompt is stable, then send /remote-control
      const MAX_WAIT = 60000;
      const POLL_INTERVAL = 2000;
      const STABLE_INTERVAL = 1500; // shorter re-check to confirm stability
      const startTime = Date.now();
      let lastReadyOutput = null;

      function capturePaneTail(cb) {
        // Strip blank lines before tail — Claude's TUI leaves many empty lines at bottom of pane
        exec(`"${BASH_PATH}" -lc "tmux capture-pane -t ${session} -p | sed '/^[[:space:]]*$/d' | tail -10"`, { encoding: 'utf8' }, cb);
      }

      function hasClaudePrompt(output) {
        // Claude shows ">" prompt, "╭" welcome box, or "human" turn indicator when ready
        return output.includes('>') || output.includes('\u256D') || output.includes('human');
      }

      function sendRemoteControl() {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[proj] Claude stable in ${elapsed}s, sending /remote-control`);
        exec(`"${BASH_PATH}" -lc "tmux send-keys -t ${session} '/remote-control' Enter"`, (err) => {
          if (err) console.error('[proj] /remote-control send error:', err.message);
          else console.log(`[proj] Sent /remote-control to ${session}`);

          // Health check: verify Claude processed /remote-control
          setTimeout(() => {
            capturePaneTail((err, stdout) => {
              if (err) {
                console.error('[proj] health-check capture error:', err.message);
                return;
              }
              const pane = (stdout || '').trim();
              const alive = !pane.includes('$') || pane.includes('remote');
              console.log(`[proj] Health check (${session}): ${alive ? 'OK' : 'Claude may have exited'}`);
              if (!alive) console.log(`[proj] Pane content:\n${pane}`);
            });
          }, 5000);
        });
      }

      function waitForClaude() {
        if (Date.now() - startTime > MAX_WAIT) {
          capturePaneTail((err, stdout) => {
            console.error(`[proj] Claude did not start within ${MAX_WAIT / 1000}s in ${session}`);
            console.error(`[proj] Pane content at timeout:\n${(stdout || '(empty)').trim()}`);
          });
          return;
        }

        capturePaneTail((err, stdout) => {
          if (err) {
            console.error('[proj] capture-pane error:', err.message);
            setTimeout(waitForClaude, POLL_INTERVAL);
            return;
          }
          const output = (stdout || '').trim();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const isReady = hasClaudePrompt(output);
          console.log(`[proj] Poll ${elapsed}s: ready=${isReady} output=${output.slice(-120)}`);

          if (isReady) {
            if (lastReadyOutput === null) {
              // First ready detection — re-check after short delay to confirm stable
              lastReadyOutput = output;
              console.log(`[proj] Prompt detected at ${elapsed}s, confirming stability...`);
              setTimeout(waitForClaude, STABLE_INTERVAL);
            } else {
              // Second consecutive ready — Claude is stable, send command
              sendRemoteControl();
            }
          } else {
            lastReadyOutput = null; // reset if output changed back to non-ready
            setTimeout(waitForClaude, POLL_INTERVAL);
          }
        });
      }

      // Start polling after initial delay for Claude binary to load
      setTimeout(waitForClaude, 2000);
    });

    // Open editor
    console.log(`[proj] Opening editor: "${EDITOR_CMD}" "${projDir}"`);
    const child = exec(`"${EDITOR_CMD}" "${projDir}"`, (err) => {
      if (err) console.error('[proj] Editor launch error:', err.message);
    });
    child.unref();

    // Maximize the editor window once it appears
    const maxScript = path.join(__dirname, 'maximize-window.ps1');
    exec(`powershell.exe -ExecutionPolicy Bypass -File "${maxScript}" -TitlePrefix "${name}"`, (err) => {
      if (err) console.error('[proj] Maximize error:', err.message);
    });
  }, 5000);
}

// List project directories
app.get('/projects', verifyPin, (req, res) => {
  try {
    res.json({ projects: getProjectList() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Run actions
app.post('/run', verifyPin, (req, res) => {
  const { action, name } = req.body;

  if (action === 'proj') {
    if (!name || !SAFE_NAME_RE.test(name)) {
      return res.status(400).json({ ok: false, message: 'Invalid project name' });
    }
    try {
      openProjectInEditor(name);
      return res.json({ ok: true, action });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }

  if (action === 'editor') {
    const child = exec(`"${EDITOR_CMD}"`);
    child.unref();
    return res.json({ ok: true, action });
  }

  if (action === 'protect-session') {
    const list = getProtectedSessions();
    if (name && !list.includes(name)) {
      list.push(name);
      setProtectedSessions(list);
    }
    return res.json({ ok: true, action });
  }

  if (action === 'unprotect-session') {
    if (name) setProtectedSessions(getProtectedSessions().filter(s => s !== name));
    return res.json({ ok: true, action });
  }

  if (action === 'kill-session') {
    if (!name || !SAFE_NAME_RE.test(name)) {
      return res.status(400).json({ ok: false, message: 'Invalid session name' });
    }
    setProtectedSessions(getProtectedSessions().filter(s => s !== name));
    const scriptPath = path.join(__dirname, 'kill-sessions.sh').replace(/\\/g, '/');
    const closeScript = path.join(__dirname, 'close-window.ps1');
    exec(`"${BASH_PATH}" -l "${scriptPath}" "${SESSION_PREFIX}${name}"`, (err) => {
      if (err) console.error(`[kill-session] Error:`, err.message);
      const titleQuery = EDITOR_TITLE ? `${name} - ${EDITOR_TITLE}` : name;
      exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
        if (err) console.error(`[close-window] Error:`, err.message);
      });
    });
    return res.json({ ok: true, action });
  }

  if (action === 'sleep') {
    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (err) => {
      if (err) console.error('[sleep] Error:', err.message);
    });
    return res.json({ ok: true, action });
  }

  if (action === 'hibernate') {
    exec('shutdown /h', (err) => {
      if (err) console.error('[hibernate] Error:', err.message);
    });
    return res.json({ ok: true, action });
  }

  if (action === 'display_off') {
    exec('powershell.exe -Command "(Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")]public static extern int SendMessage(int hWnd,int Msg,int wParam,int lParam);\' -Name a -Passthru)::SendMessage(-1,0x0112,0xF170,2)"', (err) => {
      if (err) console.error('[display_off] Error:', err.message);
    });
    return res.json({ ok: true, action });
  }

  return res.status(400).json({ ok: false, message: `Unknown action: ${action}` });
});

// --- Heartbeat (push status to Vercel via Redis) ---

const VERCEL_URL = process.env.VERCEL_URL;
const AGENT_SECRET = process.env.AGENT_SECRET;
const HEARTBEAT_INTERVAL = 30_000;

function getProjectList() {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && !IGNORE_DIRS.has(e.name))
      .map(e => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch {
    return [];
  }
}

function executeCommand(command) {
  console.log(`[heartbeat] Received command: ${command.action}`);

  if (command.action === 'shutdown') {
    if (!canShutdown()) {
      console.log('[heartbeat] Shutdown rate limited');
      return;
    }
    recordShutdownAttempt();
    exec('shutdown /s /t 5', (err) => {
      if (err) console.error('[heartbeat] Shutdown error:', err.message);
      else console.log('[heartbeat] Shutting down in 5s');
    });
  } else if (command.action === 'proj') {
    if (command.name && SAFE_NAME_RE.test(command.name)) {
      openProjectInEditor(command.name);
      console.log(`[heartbeat] Opened project: ${command.name}`);
    } else {
      console.error(`[heartbeat] Invalid project name: ${command.name}`);
    }
  } else if (command.action === 'editor') {
    const child = exec(`"${EDITOR_CMD}"`);
    child.unref();
    console.log('[heartbeat] Launched editor');
  } else if (command.action === 'protect-session') {
    const list = getProtectedSessions();
    if (command.name && !list.includes(command.name)) {
      list.push(command.name);
      setProtectedSessions(list);
      console.log(`[session] Protected: ${command.name}`);
    }
  } else if (command.action === 'unprotect-session') {
    if (command.name) {
      setProtectedSessions(getProtectedSessions().filter(s => s !== command.name));
      console.log(`[session] Unprotected: ${command.name}`);
    }
  } else if (command.action === 'kill-session') {
    if (command.name && SAFE_NAME_RE.test(command.name)) {
      setProtectedSessions(getProtectedSessions().filter(s => s !== command.name));
      const scriptPath = path.join(__dirname, 'kill-sessions.sh').replace(/\\/g, '/');
      const closeScript = path.join(__dirname, 'close-window.ps1');
      exec(`"${BASH_PATH}" -l "${scriptPath}" "${SESSION_PREFIX}${command.name}"`, (err) => {
        if (err) console.error(`[kill-session] Error:`, err.message);
        const titleQuery = EDITOR_TITLE ? `${command.name} - ${EDITOR_TITLE}` : command.name;
        exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
          if (err) console.error(`[close-window] Error:`, err.message);
        });
      });
      console.log(`[session] Killed: ${command.name}`);
    }
  } else if (command.action === 'sleep') {
    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (err) => {
      if (err) console.error('[sleep] Error:', err.message);
      else console.log('[heartbeat] Entering sleep mode');
    });
  } else if (command.action === 'hibernate') {
    exec('shutdown /h', (err) => {
      if (err) console.error('[hibernate] Error:', err.message);
      else console.log('[heartbeat] Entering hibernate mode');
    });
  } else if (command.action === 'display_off') {
    exec('powershell.exe -Command "(Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")]public static extern int SendMessage(int hWnd,int Msg,int wParam,int lParam);\' -Name a -Passthru)::SendMessage(-1,0x0112,0xF170,2)"', (err) => {
      if (err) console.error('[display_off] Error:', err.message);
      else console.log('[heartbeat] Display turned off');
    });
  }
}

async function sendHeartbeat() {
  if (!VERCEL_URL || !AGENT_SECRET) return;

  try {
    // Collect active sessions and clean up stale protected entries
    const activeSessions = await getActiveSessions();
    const protectedList = getProtectedSessions();
    const cleanedProtected = protectedList.filter(s => activeSessions.includes(s));
    if (cleanedProtected.length !== protectedList.length) {
      setProtectedSessions(cleanedProtected);
    }

    const sessions = activeSessions.map(name => ({
      name,
      protected: cleanedProtected.includes(name),
    }));

    const res = await fetch(`${VERCEL_URL}/api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_SECRET}`,
      },
      body: JSON.stringify({
        uptime: process.uptime(),
        projects: getProjectList(),
        sessions,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.command) {
        executeCommand(data.command);
      }
    } else {
      console.error(`[heartbeat] HTTP ${res.status}`);
    }
  } catch (err) {
    console.error('[heartbeat] Error:', err.message);
  }
}

// --- Boot readiness: wait for tmux before accepting commands ---

let tmuxReady = false;

function checkTmux() {
  return new Promise((resolve) => {
    exec(`"${BASH_PATH}" -lc "tmux -V"`, (err) => resolve(!err));
  });
}

async function waitForTmux(maxWaitMs = 60_000) {
  const start = Date.now();
  const interval = 2_000;
  while (Date.now() - start < maxWaitMs) {
    if (await checkTmux()) {
      tmuxReady = true;
      console.log(`[boot] tmux ready (${Math.round((Date.now() - start) / 1000)}s after start)`);
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  // Proceed anyway after timeout — tmux may still work by the time user opens a project
  tmuxReady = true;
  console.warn(`[boot] tmux not detected after ${maxWaitMs / 1000}s, proceeding anyway`);
}

// --- Start ---

app.listen(PORT, async () => {
  console.log(`Button Agent listening on port ${PORT}`);

  // Wait for tmux/MSYS2 to be ready before starting heartbeat
  await waitForTmux();

  // Start heartbeat loop
  if (VERCEL_URL && AGENT_SECRET) {
    console.log(`[heartbeat] Pushing to ${VERCEL_URL} every ${HEARTBEAT_INTERVAL / 1000}s`);
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  } else {
    console.log('[heartbeat] VERCEL_URL or AGENT_SECRET not set, heartbeat disabled');
  }
});
