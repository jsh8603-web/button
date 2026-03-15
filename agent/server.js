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

// --- Projects ---

const PROJECTS_DIR = 'D:\\projects';
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const IGNORE_DIRS = new Set(['Antigravity', '_Global_Orchestrator', 'node_modules', 'screenshots']);

// tasks.json: open tmux session with claude on folder open
const SESSION_PREFIX = 'btn-';

function buildTasksJson(name) {
  const session = `${SESSION_PREFIX}${name}`;
  const claudeBin = '/c/Users/jsh86/.local/bin/claude';
  const tmuxCmd = `tmux new-session -d -s ${session} -c /d/projects/${name} 2>/dev/null; tmux send-keys -t ${session} '${claudeBin} --dangerously-skip-permissions --model opus' Enter; sleep 3; tmux send-keys -t ${session} Enter; sleep 2; tmux send-keys -t ${session} '/remote-control' Enter; tmux attach-session -t ${session}`;
  return {
    version: "2.0.0",
    tasks: [{
      label: "claude-tmux",
      type: "shell",
      command: tmuxCmd,
      options: {
        shell: {
          executable: "C:\\msys64\\usr\\bin\\bash.exe",
          args: ["-l", "-c"]
        }
      },
      runOptions: { runOn: "folderOpen" },
      presentation: { reveal: "always", focus: true },
      isBackground: true,
      problemMatcher: []
    }]
  };
}

// Last project opened by the web app (null = none)
let lastWebAppProject = null;

function killExistingSessions() {
  // Gracefully exit Claude in btn-* sessions to deregister remote, then kill tmux
  const scriptPath = path.join(__dirname, 'kill-sessions.sh').replace(/\\/g, '/');
  exec(`C:\\msys64\\usr\\bin\\bash.exe -l "${scriptPath}"`);
  // Close only the Antigravity window opened by the web app (WM_CLOSE by window title)
  if (lastWebAppProject) {
    const scriptPath = path.join(__dirname, 'close-window.ps1');
    exec(`powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}" -TitlePrefix "${lastWebAppProject}"`);
    lastWebAppProject = null;
  }
}

function openProjectInAntigravity(name) {
  // Kill previous web-app-opened Antigravity + tmux sessions
  killExistingSessions();

  const projDir = path.join(PROJECTS_DIR, name);
  const vscodeDir = path.join(projDir, '.vscode');
  const tasksFile = path.join(vscodeDir, 'tasks.json');

  // Ensure project and .vscode dirs exist
  fs.mkdirSync(vscodeDir, { recursive: true });

  // Write tasks.json with project-specific tmux session name
  fs.writeFileSync(tasksFile, JSON.stringify(buildTasksJson(name), null, 2));

  // Track this project for future cleanup
  lastWebAppProject = name;

  // Wait a moment for cleanup, then open in Antigravity
  setTimeout(() => {
    const child = exec(`D:\\projects\\Antigravity\\bin\\antigravity.cmd "${projDir}"`);
    child.unref();
    // Maximize the Antigravity window once it appears
    const maxScript = path.join(__dirname, 'maximize-window.ps1');
    exec(`powershell.exe -ExecutionPolicy Bypass -File "${maxScript}" -TitlePrefix "${name}"`);
  }, 1000);
}

// List project directories
app.get('/projects', verifyPin, (req, res) => {
  try {
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && !IGNORE_DIRS.has(e.name))
      .map(e => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    res.json({ projects });
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
      openProjectInAntigravity(name);
      return res.json({ ok: true, action });
    } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
    }
  }

  if (action === 'antigravity') {
    const child = exec('powershell.exe -Command "Start-Process shell:AppsFolder\\Google.Antigravity -WindowStyle Maximized"');
    child.unref();
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
      openProjectInAntigravity(command.name);
      console.log(`[heartbeat] Opened project: ${command.name}`);
    }
  } else if (command.action === 'antigravity') {
    const child = exec('powershell.exe -Command "Start-Process shell:AppsFolder\\Google.Antigravity -WindowStyle Maximized"');
    child.unref();
    console.log('[heartbeat] Launched Antigravity');
  }
}

async function sendHeartbeat() {
  if (!VERCEL_URL || !AGENT_SECRET) return;

  try {
    const res = await fetch(`${VERCEL_URL}/api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_SECRET}`,
      },
      body: JSON.stringify({
        uptime: process.uptime(),
        projects: getProjectList(),
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

// --- Start ---

app.listen(PORT, () => {
  console.log(`Button Agent listening on port ${PORT}`);

  // Start heartbeat loop
  if (VERCEL_URL && AGENT_SECRET) {
    console.log(`[heartbeat] Pushing to ${VERCEL_URL} every ${HEARTBEAT_INTERVAL / 1000}s`);
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  } else {
    console.log('[heartbeat] VERCEL_URL or AGENT_SECRET not set, heartbeat disabled');
  }
});
