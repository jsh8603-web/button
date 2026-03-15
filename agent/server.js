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

// Action whitelist — returns shell command string, or null for custom-handled actions
const ACTIONS = {
  antigravity: () => {
    return 'powershell.exe -Command "Start-Process shell:AppsFolder\\Google.Antigravity"';
  },
  'claude-remote': () => {
    return 'C:\\msys64\\usr\\bin\\bash.exe -lc "tmux new-session -d -s remote -c /d/projects 2>/dev/null; tmux send-keys -t remote \'claude\' Enter"';
  },
  proj: null, // handled separately in /run route
};

// tasks.json: open tmux session with claude on folder open
function buildTasksJson(name) {
  // Create or attach tmux session, send claude command, then attach
  // Start claude, wait for trust prompt, auto-accept with Enter, then attach
  const tmuxCmd = `tmux new-session -d -s ${name} -c /d/projects/${name} 2>/dev/null; tmux send-keys -t ${name} 'claude --dangerously-skip-permissions --model opus' Enter; sleep 3; tmux send-keys -t ${name} Enter; tmux attach-session -t ${name}`;
  return {
    version: "2.0.0",
    tasks: [{
      label: "claude-tmux",
      type: "shell",
      command: tmuxCmd,
      runOptions: { runOn: "folderOpen" },
      presentation: { reveal: "always", focus: true },
      isBackground: true,
      problemMatcher: []
    }]
  };
}

function openProjectInAntigravity(name) {
  const projDir = path.join('D:\\projects', name);
  const vscodeDir = path.join(projDir, '.vscode');
  const tasksFile = path.join(vscodeDir, 'tasks.json');

  // Ensure project and .vscode dirs exist
  fs.mkdirSync(vscodeDir, { recursive: true });

  // Always write tasks.json with project-specific tmux session name
  fs.writeFileSync(tasksFile, JSON.stringify(buildTasksJson(name), null, 2));

  // Open in Antigravity
  const child = exec(`D:\\projects\\Antigravity\\bin\\antigravity.cmd "${projDir}"`);
  child.unref();
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

app.post('/run', verifyPin, (req, res) => {
  const { action, name } = req.body;

  if (!action || !(action in ACTIONS)) {
    return res.status(400).json({ ok: false, message: `Unknown action: ${action}` });
  }

  // Handle proj separately (uses Node fs + exec)
  if (action === 'proj') {
    if (!name || !SAFE_NAME_RE.test(name)) {
      return res.status(400).json({ ok: false, message: 'Invalid project name' });
    }
    try {
      openProjectInAntigravity(name);
      return res.json({ ok: true, action });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }

  const cmd = ACTIONS[action]();

  // Fire-and-forget: respond immediately, let the command run in background
  const child = exec(cmd);
  child.unref();
  res.json({ ok: true, action });
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`Button Agent listening on port ${PORT}`);
});
