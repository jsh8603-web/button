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
const AGENT_SECRET = process.env.AGENT_SECRET;

// Warn if path-sensitive env vars use short command names (may fail without PATH)
for (const [name, val] of [['EDITOR_CMD', EDITOR_CMD], ['CLAUDE_BIN', CLAUDE_BIN]]) {
  if (!val.includes('/') && !val.includes('\\')) {
    console.warn(`[config] WARNING: ${name}="${val}" is not a full path. Set absolute path in .env to avoid PATH issues.`);
  }
}

// --- Middleware ---

app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

// --- Auth: Bearer token (AGENT_SECRET) ---

function verifySecret(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${AGENT_SECRET}`) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
  next();
}

// --- Rate limiting (in-memory) ---

const authAttempts = [];
const AUTH_WINDOW_MS = 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

let lockoutUntil = 0;

function recordFailedAttempt() {
  const now = Date.now();
  authAttempts.push(now);
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

// --- PIN verification (for direct access from Pi relay) ---

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

// PIN verification endpoint (Pi relay uses this to validate user PINs)
app.post('/verify-pin', async (req, res) => {
  if (isLockedOut()) {
    return res.status(429).json({ ok: false, message: 'Too many failed attempts' });
  }
  const { pin } = req.body;
  if (!pin || !PIN_HASH) {
    recordFailedAttempt();
    return res.status(401).json({ ok: false });
  }
  try {
    const match = await bcrypt.compare(pin, PIN_HASH);
    if (!match) {
      recordFailedAttempt();
      return res.status(401).json({ ok: false });
    }
    return res.json({ ok: true });
  } catch {
    recordFailedAttempt();
    return res.status(401).json({ ok: false });
  }
});

// Health check (no auth — used by Pi to detect online/offline)
app.get('/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime() });
});

// Full status: sessions, projects, uptime (Pi relay calls this)
app.get('/status', verifySecret, async (req, res) => {
  const activeSessions = await getActiveSessions();
  let protectedList = getProtectedSessions();

  // Clean stale protected entries
  if (activeSessions.length > 0) {
    const cleaned = protectedList.filter(s => activeSessions.includes(s));
    if (cleaned.length !== protectedList.length) {
      protectedList = cleaned;
      setProtectedSessions(protectedList);
    }
  }

  const sessions = activeSessions.map(name => ({
    name,
    protected: protectedList.includes(name),
  }));

  res.json({
    status: 'online',
    uptime: process.uptime(),
    sessions,
    projects: getProjectList(),
  });
});

app.post('/shutdown', verifySecret, (req, res) => {
  if (!canShutdown()) {
    return res.status(429).json({ ok: false, message: 'Rate limit: max 3 shutdown attempts per minute' });
  }

  recordShutdownAttempt();
  showToast('Shutting down in 10s...', 10);
  exec('shutdown /s /t 10', (err) => {
    if (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
    res.json({ ok: true, message: 'Shutting down in 10s' });
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
  killUnprotectedSessions();

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

  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(tasksFile, JSON.stringify(buildTasksJson(name), null, 2));

  const settingsFile = path.join(vscodeDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  settings['task.allowAutomaticTasks'] = 'on';
  settings['powershell.integratedConsole.startInBackground'] = true;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  setTimeout(() => {
    const session = `${SESSION_PREFIX}${name}`;
    const projMsys = toMsys(PROJECTS_DIR);
    const claudeBinMsys = toMsys(CLAUDE_BIN);

    const createCmd = `tmux kill-session -t ${session} 2>/dev/null; tmux new-session -d -s ${session} -c ${projMsys}/${name}; tmux send-keys -t ${session} '${claudeBinMsys} --dangerously-skip-permissions --model ${CLAUDE_MODEL} --name ${name}' Enter`;
    exec(`"${BASH_PATH}" -lc "${createCmd}"`, (err) => {
      if (err) {
        console.error('[proj] tmux session create error:', err.message);
        return;
      }
      console.log(`[proj] Created tmux session: ${session}`);

      const MAX_WAIT = 60000;
      const POLL_INTERVAL = 2000;
      const STABLE_INTERVAL = 1500;
      const startTime = Date.now();
      let lastReadyOutput = null;

      function capturePaneTail(cb) {
        exec(`"${BASH_PATH}" -lc "tmux capture-pane -t ${session} -p | sed '/^[[:space:]]*$/d' | tail -10"`, { encoding: 'utf8' }, cb);
      }

      function hasTrustPrompt(output) {
        return output.includes('trust this folder') || output.includes('I trust');
      }

      function hasClaudePrompt(output) {
        if (hasTrustPrompt(output)) return false;
        return output.includes('>') || output.includes('\u256D') || output.includes('human');
      }

      let trustHandled = false;

      function sendRemoteControl() {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[proj] Claude stable in ${elapsed}s, sending /remote-control`);
        exec(`"${BASH_PATH}" -lc "tmux send-keys -t ${session} '/remote-control' Enter"`, (err) => {
          if (err) console.error('[proj] /remote-control send error:', err.message);
          else console.log(`[proj] Sent /remote-control to ${session}`);

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

          if (!trustHandled && hasTrustPrompt(output)) {
            trustHandled = true;
            console.log(`[proj] Trust prompt detected at ${elapsed}s, sending Enter to accept`);
            exec(`"${BASH_PATH}" -lc "tmux send-keys -t ${session} Enter"`, () => {});
            lastReadyOutput = null;
            setTimeout(waitForClaude, POLL_INTERVAL);
            return;
          }

          const isReady = hasClaudePrompt(output);
          console.log(`[proj] Poll ${elapsed}s: ready=${isReady} output=${output.slice(-120)}`);

          if (isReady) {
            if (lastReadyOutput === null) {
              lastReadyOutput = output;
              console.log(`[proj] Prompt detected at ${elapsed}s, confirming stability...`);
              setTimeout(waitForClaude, STABLE_INTERVAL);
            } else {
              sendRemoteControl();
            }
          } else {
            lastReadyOutput = null;
            setTimeout(waitForClaude, POLL_INTERVAL);
          }
        });
      }

      setTimeout(waitForClaude, 2000);
    });

    console.log(`[proj] Opening editor: "${EDITOR_CMD}" "${projDir}"`);
    const child = exec(`"${EDITOR_CMD}" "${projDir}"`, (err) => {
      if (err) console.error('[proj] Editor launch error:', err.message);
    });
    child.unref();

    const maxScript = path.join(__dirname, 'maximize-window.ps1');
    exec(`powershell.exe -ExecutionPolicy Bypass -File "${maxScript}" -TitlePrefix "${name}"`, (err) => {
      if (err) console.error('[proj] Maximize error:', err.message);
    });
  }, 5000);
}

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

// List project directories
app.get('/projects', verifySecret, (req, res) => {
  try {
    res.json({ projects: getProjectList() });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Run actions (Pi relay forwards commands here)
app.post('/run', verifySecret, (req, res) => {
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

  if (action === 'sleep' || action === 'hibernate') {
    const delaySec = req.body.params?.delay ? parseInt(req.body.params.delay, 10) : 0;
    executeSleepAction(action, delaySec);
    return res.json({ ok: true, action });
  }

  if (action === 'display_off') {
    exec('powershell.exe -Command "(Add-Type -MemberDefinition \'[DllImport(\\"user32.dll\\")]public static extern int SendMessage(int hWnd,int Msg,int wParam,int lParam);\' -Name a -Passthru)::SendMessage(-1,0x0112,0xF170,2)"', (err) => {
      if (err) console.error('[display_off] Error:', err.message);
    });
    return res.json({ ok: true, action });
  }

  if (action === 'hibernate-cancel') {
    if (pendingHibernateTimer) {
      clearTimeout(pendingHibernateTimer);
      pendingHibernateTimer = null;
      clearHibernateSchedule();
      showToast('Hibernate cancelled');
      console.log('[hibernate] Cancelled by user');
    }
    return res.json({ ok: true, action });
  }

  return res.status(400).json({ ok: false, message: `Unknown action: ${action}` });
});

// --- Helpers ---

function showToast(message, seconds = 3) {
  const safe = message.replace(/"/g, "'");
  exec(`msg * /TIME:${seconds} "${safe}"`, (err) => {
    if (err) console.error('[toast] Error:', err.message);
  });
}

let pendingHibernateTimer = null;
const HIBERNATE_SCHEDULE_FILE = path.join(__dirname, '.hibernate-schedule');

function saveHibernateSchedule(action, executeAt) {
  fs.writeFileSync(HIBERNATE_SCHEDULE_FILE, JSON.stringify({ action, executeAt }));
}

function clearHibernateSchedule() {
  try { fs.unlinkSync(HIBERNATE_SCHEDULE_FILE); } catch {}
}

function restoreHibernateSchedule() {
  try {
    const data = JSON.parse(fs.readFileSync(HIBERNATE_SCHEDULE_FILE, 'utf8'));
    const remaining = data.executeAt - Date.now();
    if (remaining <= 0) {
      console.log('[hibernate] Restoring expired schedule — executing now');
      clearHibernateSchedule();
      executeSleepAction(data.action, 0);
    } else {
      const mins = Math.round(remaining / 60000);
      console.log(`[hibernate] Restoring schedule — ${mins}min remaining`);
      showToast(`Hibernate in ${mins}min (restored)`);
      pendingHibernateTimer = setTimeout(() => {
        pendingHibernateTimer = null;
        clearHibernateSchedule();
        executeSleepAction(data.action, 0);
      }, remaining);
    }
  } catch {
    // No schedule file — nothing to restore
  }
}

async function executeSleepAction(action, delaySec = 0) {
  if (pendingHibernateTimer) {
    clearTimeout(pendingHibernateTimer);
    pendingHibernateTimer = null;
    clearHibernateSchedule();
    console.log('[hibernate] Cancelled pending scheduled hibernate');
  }

  if (delaySec > 0) {
    const hours = Math.round(delaySec / 3600);
    const executeAt = Date.now() + delaySec * 1000;
    console.log(`[hibernate] Scheduled in ${delaySec}s (${hours}h)`);
    showToast(`Hibernate in ${hours}h scheduled`);
    saveHibernateSchedule(action, executeAt);
    pendingHibernateTimer = setTimeout(() => {
      pendingHibernateTimer = null;
      clearHibernateSchedule();
      executeSleepAction(action, 0);
    }, delaySec * 1000);
    return;
  }

  if (action === 'hibernate') {
    showToast('Hibernating now...');
    setTimeout(() => {
      exec('shutdown /h', (err) => {
        if (err) console.error('[hibernate] Error:', err.message);
        else console.log('[hibernate] Entering hibernate mode');
      });
    }, 3000);
    return;
  }

  // Sleep
  showToast('Entering sleep...');
  setTimeout(() => {
    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (err) => {
      if (err) console.error('[sleep] Error:', err.message);
      else console.log('[sleep] Entering sleep mode');
    });
  }, 3000);
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
  tmuxReady = true;
  console.warn(`[boot] tmux not detected after ${maxWaitMs / 1000}s, proceeding anyway`);
}

// --- Start ---

app.listen(PORT, async () => {
  console.log(`Button Agent listening on port ${PORT}`);
  await waitForTmux();
  restoreHibernateSchedule();
  console.log('[agent] Ready — waiting for commands from Pi relay');
});
