const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
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
const AI_TASK_MODEL = process.env.AI_TASK_MODEL || 'sonnet';
const AGENT_SECRET = process.env.AGENT_SECRET;
const PI_HOST = process.env.PI_HOST || '192.168.219.125';
const PI_PORT = parseInt(process.env.PI_PORT || '7777', 10);

// Windows path → MSYS path (e.g. D:\projects → /d/projects)
const toMsys = (p) => p.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d) => `/${d.toLowerCase()}`);

// Shared tmux socket — SYSTEM (Task Scheduler) and user session use same server
// MSYS2 /tmp maps to C:\msys64\tmp — use Windows path for icacls ACL
const TMUX_SOCK_DIR = '/tmp/button-tmux';
const TMUX_SOCK_DIR_WIN = 'C:\\msys64\\tmp\\button-tmux';
const TMUX_SOCKET = `${TMUX_SOCK_DIR}/default`;
const TMUX_SOCKET_WIN = `${TMUX_SOCK_DIR_WIN}\\default`;
const TMUX = `tmux -S ${TMUX_SOCKET}`;

// Ensure socket dir is accessible by all users (SYSTEM creates, user attaches via VS Code)
// chmod doesn't work for Windows ACLs on sockets — use icacls to grant Everyone Full Control
exec(`"${BASH_PATH}" -lc "mkdir -p ${TMUX_SOCK_DIR}"`, () => {
  exec(`icacls "${TMUX_SOCK_DIR_WIN}" /grant Everyone:F /T /Q`, () => {});
});

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

// --- System Metrics ---

let metricsCache = null;
let metricsCacheTime = 0;
const METRICS_TTL_MS = 10_000;

function execPromise(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function collectMetrics() {
  const now = Date.now();
  if (metricsCache && now - metricsCacheTime < METRICS_TTL_MS) return metricsCache;

  const [cpuOut, memOut, diskOut, gpuOut] = await Promise.all([
    execPromise('wmic cpu get loadpercentage /value'),
    execPromise('wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /value'),
    execPromise('wmic logicaldisk where "DriveType=3" get Caption,FreeSpace,Size /format:csv'),
    execPromise('nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader'),
  ]);

  // CPU
  const cpuMatch = cpuOut.match(/LoadPercentage=(\d+)/i);
  const cpu = cpuMatch ? parseInt(cpuMatch[1], 10) : null;

  // Memory (KB → GB)
  const freeKBMatch = memOut.match(/FreePhysicalMemory=(\d+)/i);
  const totalKBMatch = memOut.match(/TotalVisibleMemorySize=(\d+)/i);
  const memTotal = totalKBMatch ? Math.round(parseInt(totalKBMatch[1], 10) / 1024 / 1024 * 10) / 10 : null;
  const memFree = freeKBMatch ? parseInt(freeKBMatch[1], 10) / 1024 / 1024 : null;
  const memUsed = (memTotal !== null && memFree !== null)
    ? Math.round((memTotal - memFree) * 10) / 10
    : null;

  // Disks (CSV: Node,Caption,FreeSpace,Size — bytes)
  const disks = [];
  const diskLines = diskOut.trim().split('\n').filter(l => l.trim() && !l.startsWith('Node'));
  for (const line of diskLines) {
    const parts = line.trim().split(',');
    if (parts.length < 4) continue;
    const caption = parts[1].trim();
    const freeBytes = parseInt(parts[2].trim(), 10);
    const totalBytes = parseInt(parts[3].trim(), 10);
    if (!caption || isNaN(freeBytes) || isNaN(totalBytes) || totalBytes === 0) continue;
    disks.push({
      drive: caption,
      freeGB: Math.round(freeBytes / 1024 / 1024 / 1024),
      totalGB: Math.round(totalBytes / 1024 / 1024 / 1024),
    });
  }

  // GPU temp (nvidia-smi, optional)
  const gpuTempMatch = gpuOut.trim().match(/^(\d+)/);
  const gpuTemp = gpuTempMatch ? parseInt(gpuTempMatch[1], 10) : null;

  metricsCache = { cpu, memUsed, memTotal, disks, gpuTemp, uptime: Math.floor(process.uptime()) };
  metricsCacheTime = now;
  return metricsCache;
}

// --- Task Runner ---

const TASK_QUEUE_FILE = path.join(__dirname, '.task-queue.json');

const BUILTIN_TASKS = {
  'windows-update': 'powershell -Command "Install-Module PSWindowsUpdate -Force -ErrorAction SilentlyContinue; Get-WindowsUpdate -Install -AcceptAll -AutoReboot:$false"',
  'disk-cleanup': 'cleanmgr /sagerun:1',
  'defrag': 'defrag C: /O',
  'restart': 'shutdown /r /t 60',
};

function readTaskQueue() {
  try { return JSON.parse(fs.readFileSync(TASK_QUEUE_FILE, 'utf8')); } catch { return []; }
}

function writeTaskQueue(tasks) {
  fs.writeFileSync(TASK_QUEUE_FILE, JSON.stringify(tasks, null, 2));
}

// --- AI Task Learning ---

const LEARNED_FILE = path.join(__dirname, '.task-learned.json');
const AI_TASK_TIMEOUT = 1_800_000; // 30 minutes

function readLearned() {
  try { return JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')); } catch { return {}; }
}

function writeLearned(data) {
  fs.writeFileSync(LEARNED_FILE, JSON.stringify(data, null, 2));
}

const ACTION_VERBS = ['install', 'uninstall', 'download', 'delete', 'remove', 'update', 'upgrade', 'create', 'destroy', 'enable', 'disable', 'start', 'stop', 'open', 'close'];

function findLearnedApproach(taskName) {
  if (!taskName) return null;
  const learned = readLearned();
  const words = taskName.toLowerCase().split(/\s+/);
  const taskVerb = words.find(w => ACTION_VERBS.includes(w));
  let bestMatch = null, bestOverlap = 0;
  for (const [key, val] of Object.entries(learned)) {
    const keyWords = key.toLowerCase().split(/\s+/);
    // Skip if action verbs conflict (e.g. install vs uninstall, download vs delete)
    const keyVerb = keyWords.find(w => ACTION_VERBS.includes(w));
    if (taskVerb && keyVerb && taskVerb !== keyVerb) continue;
    const overlap = words.filter(w => keyWords.includes(w)).length;
    if (overlap >= 2 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = val;
    }
  }
  return bestMatch;
}

function saveLearned(taskName, approach, failed = false) {
  if (!taskName || !approach) return;
  const learned = readLearned();
  if (failed) {
    // Append to failedApproaches array (keep last 3)
    const existing = learned[taskName] || {};
    const failures = existing.failedApproaches || [];
    failures.push({ approach, date: new Date().toISOString() });
    if (failures.length > 3) failures.shift();
    learned[taskName] = { ...existing, failedApproaches: failures };
  } else {
    learned[taskName] = {
      approach,
      lastUsed: new Date().toISOString(),
      successCount: (learned[taskName]?.successCount || 0) + 1,
      failedApproaches: learned[taskName]?.failedApproaches || undefined,
    };
  }
  writeLearned(learned);
  console.log(`[ai-task] Saved ${failed ? 'failed' : 'successful'} approach for "${taskName}"`);
}

// --- AI Task Execution ---

// Track multiple concurrent AI tasks: taskId → { task, editorPid, editorCloseTimer }
const runningAiTasks = new Map();

function cleanupLingeringScheduleSessions() {
  exec(`"${BASH_PATH}" -lc "${TMUX} list-sessions -F '#S' 2>/dev/null"`, (err, stdout) => {
    if (err || !stdout) return;
    const sessions = stdout.trim().split('\n').filter(s => s.startsWith(AI_TASK_PREFIX));
    if (sessions.length === 0) return;
    console.log(`[ai-task] Cleaning up ${sessions.length} lingering schedule session(s): ${sessions.join(', ')}`);
    const closeScript = path.join(__dirname, 'close-window.ps1');
    for (const s of sessions) {
      exec(`"${BASH_PATH}" -lc "${TMUX} kill-session -t ${s} 2>/dev/null"`, () => {});
      // Close editor window for the task's project
      if (EDITOR_TITLE) {
        const safeName = s.slice(AI_TASK_PREFIX.length);
        const taskProject = readTaskQueue().find(t => {
          const n = t.name ? t.name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40) : t.id.slice(0, 8);
          return n === safeName;
        })?.project;
        const editorName = taskProject ? path.basename(taskProject) : safeName;
        const titleQuery = `${editorName} - ${EDITOR_TITLE}`;
        exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
          if (err) console.error(`[cleanup] close-window error for ${s}:`, err.message);
        });
      }
    }
    // Remove from protected list
    const protectedList = getProtectedSessions();
    const cleaned = protectedList.filter(p => !sessions.includes(p));
    if (cleaned.length !== protectedList.length) setProtectedSessions(cleaned);
  });
}

function scheduleEditorClose(task, editorPid) {
  if (!editorPid) return;

  const taskId = task.id;
  const session = `${AI_TASK_PREFIX}${taskId.slice(0, 8)}`;
  let snapshot = null;

  // Capture current pane output as baseline
  exec(`"${BASH_PATH}" -lc "${TMUX} capture-pane -t ${session} -p 2>/dev/null | tail -20"`, { encoding: 'utf8' }, (err, out) => {
    snapshot = err ? null : out;
  });

  const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  const CHECK_INTERVAL = 60 * 1000;    // check every 1 min
  const startTime = Date.now();

  const interval = setInterval(() => {
    // Check if session still exists
    exec(`"${BASH_PATH}" -lc "${TMUX} has-session -t ${session} 2>/dev/null"`, (err) => {
      if (err) {
        // Session gone — close editor
        clearInterval(interval);
        try { process.kill(editorPid); } catch {}
        console.log(`[ai-task] Session gone, closed editor (PID ${editorPid})`);
        return;
      }

      // Capture current output and compare with snapshot
      exec(`"${BASH_PATH}" -lc "${TMUX} capture-pane -t ${session} -p 2>/dev/null | tail -20"`, { encoding: 'utf8' }, (err2, current) => {
        if (err2) return;
        if (snapshot && current !== snapshot) {
          // User interacted — cancel scheduled close
          clearInterval(interval);
          console.log(`[ai-task] User activity detected in ${session}, keeping editor open`);
          return;
        }

        // No activity — check if idle timeout reached
        if (Date.now() - startTime >= IDLE_TIMEOUT) {
          clearInterval(interval);
          try { process.kill(editorPid); } catch {}
          exec(`"${BASH_PATH}" -lc "${TMUX} kill-session -t ${session} 2>/dev/null"`, () => {});
          console.log(`[ai-task] 10min idle, closed editor (PID ${editorPid}) and killed session ${session}`);
        }
      });
    });
  }, CHECK_INTERVAL);

  setTimeout(() => { clearInterval(interval); }, IDLE_TIMEOUT + CHECK_INTERVAL);
}

function executeAiTask(task) {
  runningAiTasks.set(task.id, { task, editorPid: null, editorCloseTimer: null });
  const shortId = task.id.slice(0, 8);
  // Session name: schedule-{taskName} (sanitized) or schedule-{shortId} as fallback
  const safeName = task.name ? task.name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40) : shortId;
  const session = `${AI_TASK_PREFIX}${safeName}`;
  const project = task.project || 'D:/projects/common-task';
  const projMsys = toMsys(project);
  const claudeBinMsys = toMsys(CLAUDE_BIN);

  // Build prompt and save to temp file (multi-line prompts break tmux send-keys)
  const learned = findLearnedApproach(task.name);
  let prompt = `You are executing a scheduled task. Work autonomously as much as possible.\n\nTask: ${task.name || 'Unnamed task'}\n\nInstructions:\n${task.instructions}\n`;
  if (learned) {
    if (learned.approach) prompt += `\nPreviously successful approach for similar task:\n${learned.approach}\n`;
    if (learned.failedApproaches?.length) {
      prompt += `\nPreviously FAILED approaches (DO NOT repeat these):\n`;
      for (const f of learned.failedApproaches) {
        prompt += `- [${f.date}] ${f.approach}\n`;
      }
    }
  }
  prompt += `
=== MANDATORY EXECUTION ORDER ===
You MUST follow these steps sequentially. Before moving to the next step, output the step result.
Skipping steps or jumping ahead is PROHIBITED — document why each step was insufficient before proceeding.

STEP 1: Check learned approaches
- Read D:/projects/button/agent/.task-learned.json
- Read D:/projects/button/agent/.task-queue.json (check similar completed/failed tasks)
- Output: "STEP 1 RESULT: [MATCH: {approach}]" or "STEP 1 RESULT: [NO MATCH — {reason}]"
- If match found → use that approach. Go to execution.
- If no match → proceed to Step 2.

STEP 2: Programmatic approach (non-GUI)
- Try ALL non-GUI methods: CLI tools, APIs, PowerShell, shell scripts, package managers, direct file operations, registry edits, web requests, etc.
- Research alternatives if the first attempt fails (WebSearch, --help, docs).
- Output: "STEP 2 RESULT: [SUCCESS: {method}]" or "STEP 2 RESULT: [FAILED: {what you tried} — {error}]" or "STEP 2 RESULT: [NO PROGRAMMATIC METHOD: {reason}]"
- If success → done. If failed/none → proceed to Step 3.

STEP 3: GUI automation (last resort — screenshot, click, visual interaction)
- Only when Step 2 exhausted all programmatic options.
- Read ~/.claude/rules/pc-tools.md for tool inventory.
- Read the relevant skill file (from ~/.claude/docs/) before using any GUI tool.
- Output: "STEP 3: Using {tool} because: Step 1={reason}, Step 2={reason}"

=== RULES ===
- Install missing tools yourself (winget, npm, choco) — never fail because something is not installed
- NEVER kill, close, or interfere with existing tmux sessions (btn-* or schedule-*). Your session is ${session} — only interact with that session.
- NEVER close VS Code windows or editor windows that belong to other projects.
- If you need user credentials, login info, or a decision you cannot make, clearly state what you need and WAIT for the user to respond. The user will check this session via remote.
- Progress updates and status messages: write in Korean (한국어). Code, commands, and file operations stay in English.
- At the end, output exactly: SUCCESS: <summary in Korean> or FAILURE: <reason in Korean>
- Include which steps you followed in your final output (e.g., "SUCCESS: steamcmd로 삭제 완료 (Step 1 match)")
`;

  const promptFile = path.join(__dirname, `.ai-task-prompt-${shortId}.txt`);
  fs.writeFileSync(promptFile, prompt);
  const promptFileMsys = toMsys(promptFile);

  const createCmd = `${TMUX} kill-session -t ${session} 2>/dev/null; ${TMUX} new-session -d -s ${session} -c ${projMsys}; ${TMUX} source-file ~/.tmux.conf 2>/dev/null; ${TMUX} send-keys -t ${session} '${claudeBinMsys} --dangerously-skip-permissions --model ${AI_TASK_MODEL}' Enter`;

  console.log(`[ai-task] Creating tmux session: ${session} in ${project}`);
  exec(`"${BASH_PATH}" -lc "${createCmd}"`, (err) => {
    // Grant socket access to all users (SYSTEM→user cross-session)
    exec(`icacls "${TMUX_SOCKET_WIN}" /grant Everyone:F /Q`, () => {});
    if (err) {
      console.error(`[ai-task] Session create error:`, err.message);
      finishAiTask(task, 'failed', `Session create error: ${err.message}`);
      return;
    }

    // Auto-protect AI task session (like proj sessions)
    const protectedList = getProtectedSessions();
    if (!protectedList.includes(session)) {
      protectedList.push(session);
      setProtectedSessions(protectedList);
      console.log(`[ai-task] Protected session: ${session}`);
    }

    // Write tasks.json to auto-attach AI task tmux session on editor open
    const projDir = project.replace(/\//g, '\\');
    const projName = path.basename(project);
    const vscodeDir = path.join(projDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    const tasksFile = path.join(vscodeDir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(buildTasksJson(session), null, 2));

    // Set allowAutomaticTasks so folderOpen task runs on editor open
    const settingsFile = path.join(vscodeDir, 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    settings['task.allowAutomaticTasks'] = 'on';
    settings['powershell.integratedConsole.startInBackground'] = true;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    // Close existing editor window for this project, then open fresh (same as proj action)
    const closeScript = path.join(__dirname, 'close-window.ps1');
    if (EDITOR_TITLE) {
      const titleQuery = `${projName} - ${EDITOR_TITLE}`;
      exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
        if (err) console.error('[ai-task] close-window error:', err.message);
      });
    }

    setTimeout(() => {
      console.log(`[ai-task] Opening editor: "${EDITOR_CMD}" "${projDir}"`);
      const editorChild = exec(`"${EDITOR_CMD}" "${projDir}"`, (err) => {
        if (err) console.error('[ai-task] Editor launch error:', err.message);
      });
      const entry = runningAiTasks.get(task.id);
      if (entry) entry.editorPid = editorChild.pid;
      editorChild.unref();

      const maxScript = path.join(__dirname, 'maximize-window.ps1');
      exec(`powershell.exe -ExecutionPolicy Bypass -File "${maxScript}" -TitlePrefix "${projName}"`, (err) => {
        if (err) console.error('[ai-task] Maximize error:', err.message);
      });
    }, 3000);

    const startTime = Date.now();
    const PROMPT_DETECT_TIMEOUT = 120000; // 2 min to detect Claude prompt
    let trustHandled = false;
    let instructionsSent = false;

    function capture(cb) {
      exec(`"${BASH_PATH}" -lc "${TMUX} capture-pane -t ${session} -p -S - | sed '/^[[:space:]]*$/d' | tail -15"`, { encoding: 'utf8' }, cb);
    }

    function hasTrustPrompt(output) {
      return output.includes('trust this folder') || output.includes('I trust');
    }

    function hasClaudePrompt(output) {
      if (hasTrustPrompt(output)) return false;
      return output.includes('\u276F') || output.includes('>') || output.includes('\u256D') || output.includes('human');
    }

    let promptIdleCount = 0;
    const PROMPT_IDLE_THRESHOLD = 3; // require 3 consecutive polls (~30s) before marking as waiting

    function poll() {
      if (Date.now() - startTime > AI_TASK_TIMEOUT) {
        console.error(`[ai-task] Timeout for "${task.id}" — session ${session} kept alive`);
        finishAiTask(task, 'failed', 'Timeout: exceeded 30 minutes');
        return;
      }

      capture((err, stdout) => {
        if (err) { setTimeout(poll, 3000); return; }
        const output = (stdout || '').trim();

        // Phase 1: Wait for Claude to start, handle trust prompt
        if (!instructionsSent) {
          if (!trustHandled && hasTrustPrompt(output)) {
            trustHandled = true;
            console.log(`[ai-task] Trust prompt detected, accepting...`);
            exec(`"${BASH_PATH}" -lc "${TMUX} send-keys -t ${session} Enter"`, () => {});
            setTimeout(poll, 3000);
            return;
          }

          const promptDetected = hasClaudePrompt(output);
          const promptTimedOut = Date.now() - startTime > PROMPT_DETECT_TIMEOUT;

          if (promptDetected || promptTimedOut) {
            instructionsSent = true;
            if (promptTimedOut && !promptDetected) {
              console.warn(`[ai-task] Prompt not detected within ${PROMPT_DETECT_TIMEOUT / 1000}s, sending anyway (output: "${output.slice(-100)}")`);
            } else {
              console.log(`[ai-task] Claude ready, sending /remote-control then instructions for "${task.id}"`);
            }
            // Send /remote-control first (like proj sessions), then instructions
            function sendRcWithRetry(attempt = 1) {
              const MAX_RC = 3;
              exec(`"${BASH_PATH}" -lc "${TMUX} send-keys -t ${session} '/remote-control' Enter"`, (err) => {
                if (err) console.error(`[ai-task] /remote-control send error:`, err.message);
                else console.log(`[ai-task] Sent /remote-control to ${session} (attempt ${attempt}/${MAX_RC})`);
                if (attempt === 1) {
                  // Send instructions after first /remote-control attempt (don't block on verify)
                  setTimeout(() => {
                    exec(`"${BASH_PATH}" -lc "${TMUX} load-buffer ${promptFileMsys} && ${TMUX} paste-buffer -t ${session} && sleep 1 && ${TMUX} send-keys -t ${session} Enter && sleep 1 && ${TMUX} send-keys -t ${session} Enter"`, (err) => {
                      if (err) console.error(`[ai-task] Send error:`, err.message);
                      try { fs.unlinkSync(promptFile); } catch {}
                    });
                  }, 3000);
                }
                // Verify /remote-control took effect, retry if needed
                setTimeout(() => {
                  exec(`"${BASH_PATH}" -lc "${TMUX} capture-pane -t ${session} -p -S - | sed '/^[[:space:]]*$/d' | tail -15"`, { encoding: 'utf8' }, (err, stdout) => {
                    if (err) return;
                    const pane = (stdout || '').trim();
                    const hasRemote = pane.includes('remote') || pane.includes('Remote');
                    if (!hasRemote && attempt < MAX_RC) {
                      console.log(`[ai-task] /remote-control not detected, retrying (${attempt + 1}/${MAX_RC})`);
                      sendRcWithRetry(attempt + 1);
                    }
                  });
                }, 5000);
              });
            }
            sendRcWithRetry();
            // Wait for Claude to start working before checking completion
            setTimeout(poll, 20000);
            return;
          }

          const waitElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          if (Number(waitElapsed) % 15 === 0) {
            console.log(`[ai-task] Waiting for Claude prompt... (${waitElapsed}s, output length: ${output.length})`);
          }
          setTimeout(poll, 3000);
          return;
        }

        // Phase 2: Check full buffer for SUCCESS/FAILURE markers (after prompt text)
        exec(`"${BASH_PATH}" -lc "${TMUX} capture-pane -t ${session} -p -S -"`, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, fullOutput) => {
          const buffer = (fullOutput || '').trim();
          // Skip the prompt portion to avoid matching "SUCCESS: <summary>" from instructions
          const markerCutoff = buffer.lastIndexOf('At the end, output exactly');
          const searchArea = markerCutoff >= 0 ? buffer.slice(markerCutoff + 80) : buffer;
          const successMatch = searchArea.match(/SUCCESS:\s*(.+)/);
          const failureMatch = searchArea.match(/FAILURE:\s*(.+)/);

          if (successMatch) {
            console.log(`[ai-task] Claude finished for "${task.id}", collecting results`);
            saveLearned(task.name, successMatch[1].trim());
            finishAiTask(task, 'completed', successMatch[1].trim());
            return;
          }
          if (failureMatch) {
            console.log(`[ai-task] Claude finished for "${task.id}", collecting results`);
            saveLearned(task.name, failureMatch[1].trim(), true);
            finishAiTask(task, 'failed', failureMatch[1].trim());
            return;
          }

          // No markers yet — if Claude prompt persists across multiple polls, it may be waiting for user input
          if (hasClaudePrompt(output)) {
            promptIdleCount++;
            if (promptIdleCount >= PROMPT_IDLE_THRESHOLD) {
              setTaskWaitingForInput(task, true);
            }
          } else {
            promptIdleCount = 0;
            setTaskWaitingForInput(task, false);
          }

          setTimeout(poll, 10000);
        });
      });
    }

    setTimeout(poll, 5000);
  });
}

function setTaskWaitingForInput(task, waiting) {
  const tasks = readTaskQueue();
  const t = tasks.find(x => x.id === task.id);
  if (!t) return;
  if (t.waitingForInput === waiting) return; // no change
  t.waitingForInput = waiting;
  writeTaskQueue(tasks);
  if (waiting) console.log(`[ai-task] Task "${task.id}" is waiting for user input`);
}

function finishAiTask(task, status, result) {
  const entry = runningAiTasks.get(task.id);
  const editorPid = entry?.editorPid || null;
  runningAiTasks.delete(task.id);

  const tasks = readTaskQueue();
  const t = tasks.find(x => x.id === task.id);
  if (!t) return;

  t.status = status;
  t.result = result;
  t.waitingForInput = false;
  t.completedAt = new Date().toISOString();
  t.log = result;

  if (t.repeat) {
    const next = nextCronRun(t.repeat);
    t.scheduledAt = next ? next.toISOString() : null;
    t.status = t.scheduledAt ? 'pending' : t.status;
    t.result = null;
    t.completedAt = null;
    t.log = null;
  }

  writeTaskQueue(tasks);
  console.log(`[ai-task] Finished "${t.id}" — status: ${status}, result: ${(result || '').slice(0, 100)}`);

  // Schedule editor close after 10 min idle (cancel if user interacts)
  scheduleEditorClose(task, editorPid);

  // Remove AI task session from protected list (allows cleanup on next proj call)
  const session = `${AI_TASK_PREFIX}${task.id.slice(0, 8)}`;
  const updatedProtected = getProtectedSessions().filter(s => s !== session);
  setProtectedSessions(updatedProtected);
  console.log(`[ai-task] Unprotected completed session: ${session}`);

  // Restore tasks.json to original project session
  const project = task.project || 'D:/projects/common-task';
  const projName = path.basename(project);
  const projDir = project.replace(/\//g, '\\');
  const vscodeDir = path.join(projDir, '.vscode');
  const tasksFile = path.join(vscodeDir, 'tasks.json');
  try {
    fs.writeFileSync(tasksFile, JSON.stringify(buildTasksJson(projName), null, 2));
    console.log(`[ai-task] Restored tasks.json to ${projName} session`);
  } catch (e) {
    console.error(`[ai-task] Failed to restore tasks.json:`, e.message);
  }

  if (t.onComplete && status === 'completed') {
    console.log(`[ai-task] onComplete action: ${t.onComplete}`);
    executeSleepAction(t.onComplete, 0);
  }
}

// Parse simple cron "M H * * *" or "M H * * D" → next Date from now
function nextCronRun(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [m, h, , , dow] = parts;
  const minute = parseInt(m, 10);
  const hour = parseInt(h, 10);
  if (isNaN(minute) || isNaN(hour)) return null;

  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(minute);
  candidate.setHours(hour);

  // Advance to tomorrow if time already passed today
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);

  // If day-of-week is specified (0=Sun … 6=Sat)
  if (dow !== '*') {
    const targetDow = parseInt(dow, 10);
    if (!isNaN(targetDow)) {
      while (candidate.getDay() !== targetDow) {
        candidate.setDate(candidate.getDate() + 1);
      }
    }
  }

  return candidate;
}

function startTaskRunner() {
  function runCycle() {
    const tasks = readTaskQueue();
    const now = new Date();
    let changed = false;

    for (const task of tasks) {
      if (task.status !== 'pending') continue;
      if (!task.scheduledAt || new Date(task.scheduledAt) > now) continue;

      // AI task branch
      if (task.type === 'ai') {
        task.status = 'running';
        changed = true;
        writeTaskQueue(tasks);
        executeAiTask(task);
        continue;
      }

      const command = task.command || BUILTIN_TASKS[task.name] || null;
      if (!command) {
        task.status = 'completed';
        task.log = `No command found for task "${task.name}"`;
        task.completedAt = new Date().toISOString();
        changed = true;
        continue;
      }

      console.log(`[task] Running "${task.id}" (${task.name || task.command})`);
      task.status = 'running';
      changed = true;
      writeTaskQueue(tasks);

      exec(command, { encoding: 'utf8', timeout: 600_000 }, (err, stdout, stderr) => {
        const allTasks = readTaskQueue();
        const t = allTasks.find(x => x.id === task.id);
        if (!t) return;

        t.log = (stdout + stderr).trim() || (err ? err.message : '(no output)');
        t.completedAt = new Date().toISOString();

        if (t.repeat) {
          const next = nextCronRun(t.repeat);
          t.scheduledAt = next ? next.toISOString() : null;
          t.status = t.scheduledAt ? 'pending' : 'completed';
          console.log(`[task] Repeat task "${t.id}" next run: ${t.scheduledAt || 'none'}`);
        } else {
          t.status = 'completed';
        }

        writeTaskQueue(allTasks);
        console.log(`[task] Completed "${t.id}" — status: ${t.status}`);

        if (t.onComplete) {
          console.log(`[task] onComplete action: ${t.onComplete}`);
          executeSleepAction(t.onComplete, 0);
        }
      });
    }

    if (changed) writeTaskQueue(tasks);
    setTimeout(runCycle, 30_000);
  }
  setTimeout(runCycle, 5_000); // first check 5s after boot
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

  // Clean stale protected entries — but only when tmux has active sessions
  // (after hibernate wake, tmux may return empty list temporarily; wiping protected list would be destructive)
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
    metrics: await collectMetrics(),
    tasks: readTaskQueue(),
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

// tasks.json: open tmux session with claude on folder open
const SESSION_PREFIX = 'btn-';
const AI_TASK_PREFIX = 'schedule-';

function buildTasksJson(sessionOrName) {
  // If already a full session name (schedule- or btn-), use as-is; otherwise prepend SESSION_PREFIX
  const session = sessionOrName.startsWith(AI_TASK_PREFIX) ? sessionOrName : `${SESSION_PREFIX}${sessionOrName}`;
  const attachCmd = `timeout=30; while [ $timeout -gt 0 ] && ! ${TMUX} has-session -t ${session} 2>/dev/null; do sleep 0.5; timeout=$((timeout-1)); done; ${TMUX} attach-session -t ${session}`;
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
    exec(`"${BASH_PATH}" -lc "${TMUX} list-sessions -F '#S' 2>/dev/null"`, (err, stdout) => {
      if (err) return resolve([]);
      const all = stdout.trim().split('\n').filter(Boolean);
      const sessions = [];
      for (const s of all) {
        if (s.startsWith(SESSION_PREFIX)) sessions.push(s.slice(SESSION_PREFIX.length));
        else if (s.startsWith(AI_TASK_PREFIX)) sessions.push(s); // schedule- sessions: use full name
      }
      resolve(sessions);
    });
  });
}

function killUnprotectedSessions() {
  if (runningAiTasks.size > 0) {
    console.log('[kill] Skipping killUnprotectedSessions — AI task is running');
    return;
  }
  const scriptPath = path.join(__dirname, 'kill-sessions.sh').replace(/\\/g, '/');
  const closeScript = path.join(__dirname, 'close-window.ps1');

  getActiveSessions().then(activeSessions => {
    const protectedList = getProtectedSessions();
    // Only kill btn- sessions, never schedule- sessions
    const btnSessions = activeSessions.filter(s => !s.startsWith(AI_TASK_PREFIX));
    const toKill = btnSessions.filter(s => !protectedList.includes(s));

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

    const createCmd = `${TMUX} kill-session -t ${session} 2>/dev/null; ${TMUX} new-session -d -s ${session} -c ${projMsys}/${name}; ${TMUX} source-file ~/.tmux.conf 2>/dev/null; ${TMUX} send-keys -t ${session} '${claudeBinMsys} --dangerously-skip-permissions --model ${CLAUDE_MODEL} --name ${name}' Enter`;
    exec(`"${BASH_PATH}" -lc "${createCmd}"`, (err) => {
      // Grant socket access to all users (SYSTEM→user cross-session)
      exec(`icacls "${TMUX_SOCKET_WIN}" /grant Everyone:F /Q`, () => {});
      if (err) {
        console.error('[proj] tmux session create error:', err.message);
        return;
      }
      console.log(`[proj] Created tmux session: ${session}`);

      // Protect proj session so killUnprotectedSessions doesn't kill it
      const protectedList = getProtectedSessions();
      if (!protectedList.includes(name)) {
        protectedList.push(name);
        setProtectedSessions(protectedList);
        console.log(`[proj] Protected session: ${session}`);
      }

      const MAX_WAIT = 120000;
      const POLL_INTERVAL = 2000;
      const STABLE_INTERVAL = 1500;
      const startTime = Date.now();
      let lastReadyOutput = null;

      function capturePaneTail(cb) {
        exec(`"${BASH_PATH}" -lc "${TMUX} capture-pane -t ${session} -p -S - | sed '/^[[:space:]]*$/d' | tail -15"`, { encoding: 'utf8' }, cb);
      }

      function hasTrustPrompt(output) {
        return output.includes('trust this folder') || output.includes('I trust');
      }

      function hasClaudePrompt(output) {
        if (hasTrustPrompt(output)) return false;
        return output.includes('\u276F') || output.includes('>') || output.includes('\u256D') || output.includes('human');
      }

      let trustHandled = false;
      let captureErrors = 0;

      function sendRemoteControl(attempt = 1) {
        const MAX_RC_ATTEMPTS = 3;
        const RC_VERIFY_DELAY = 5000;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[proj] Claude stable in ${elapsed}s, sending /remote-control (attempt ${attempt}/${MAX_RC_ATTEMPTS})`);
        exec(`"${BASH_PATH}" -lc "${TMUX} send-keys -t ${session} '/remote-control' Enter"`, (err) => {
          if (err) console.error('[proj] /remote-control send error:', err.message);
          else console.log(`[proj] Sent /remote-control to ${session}`);

          setTimeout(() => {
            capturePaneTail((err, stdout) => {
              if (err) {
                console.error('[proj] health-check capture error:', err.message);
                return;
              }
              const pane = (stdout || '').trim();
              const hasRemote = pane.includes('remote') || pane.includes('Remote');
              const alive = !pane.includes('$') || hasRemote;
              console.log(`[proj] Health check (${session}): ${alive ? 'OK' : 'Claude may have exited'}, remote=${hasRemote}`);
              if (!hasRemote && alive && attempt < MAX_RC_ATTEMPTS) {
                console.log(`[proj] /remote-control not detected, retrying (${attempt + 1}/${MAX_RC_ATTEMPTS})`);
                sendRemoteControl(attempt + 1);
              } else if (!alive) {
                console.log(`[proj] Pane content:\n${pane}`);
              }
            });
          }, RC_VERIFY_DELAY);
        });
      }

      function cleanupFailedSession() {
        console.log(`[proj] Cleaning up failed session: ${session}`);
        exec(`"${BASH_PATH}" -lc "${TMUX} kill-session -t ${session} 2>/dev/null"`, () => {});
        setProtectedSessions(getProtectedSessions().filter(s => s !== name));
      }

      function waitForClaude() {
        if (Date.now() - startTime > MAX_WAIT) {
          capturePaneTail((err, stdout) => {
            const output = (stdout || '').trim();
            console.error(`[proj] Claude did not start within ${MAX_WAIT / 1000}s in ${session}`);
            console.error(`[proj] Pane content at timeout:\n${output || '(empty)'}`);
            // If pane shows bare shell (no Claude indicators), clean up
            if (!output || (!output.includes('\u256D') && !output.includes('human') && !output.includes('Claude'))) {
              cleanupFailedSession();
            } else {
              // Claude may be loading — send /remote-control as fallback
              console.log(`[proj] Sending /remote-control despite timeout`);
              exec(`"${BASH_PATH}" -lc "${TMUX} send-keys -t ${session} '/remote-control' Enter"`, (err) => {
                if (err) console.error('[proj] /remote-control send error:', err.message);
                else console.log(`[proj] Sent /remote-control to ${session} (timeout fallback)`);
              });
            }
          });
          return;
        }

        capturePaneTail((err, stdout) => {
          if (err) {
            captureErrors++;
            console.error(`[proj] capture-pane error (${captureErrors}):`, err.message);
            if (captureErrors >= 5) {
              console.error(`[proj] Session ${session} appears dead after ${captureErrors} capture errors`);
              cleanupFailedSession();
              return;
            }
            setTimeout(waitForClaude, POLL_INTERVAL);
            return;
          }
          captureErrors = 0;
          const output = (stdout || '').trim();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          if (!trustHandled && hasTrustPrompt(output)) {
            trustHandled = true;
            console.log(`[proj] Trust prompt detected at ${elapsed}s, sending Enter to accept`);
            exec(`"${BASH_PATH}" -lc "${TMUX} send-keys -t ${session} Enter"`, () => {});
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
    // schedule- sessions already have full name from getActiveSessions(); btn- sessions need prefix
    const tmuxSession = name.startsWith(AI_TASK_PREFIX) ? name : `${SESSION_PREFIX}${name}`;

    // For schedule- sessions, also kill editor process and cancel idle timer
    let editorName;
    if (name.startsWith(AI_TASK_PREFIX)) {
      const safeName = name.slice(AI_TASK_PREFIX.length);
      const running = [...runningAiTasks.values()].find(e => {
        const n = e.task.name ? e.task.name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40) : e.task.id.slice(0, 8);
        return n === safeName;
      });
      if (running) {
        if (running.editorPid) try { process.kill(running.editorPid); } catch {}
        if (running.editorCloseTimer) clearInterval(running.editorCloseTimer);
        runningAiTasks.delete(running.task.id);
      }
      const taskProject = running?.task?.project
        || readTaskQueue().find(t => {
          const n = t.name ? t.name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40) : t.id.slice(0, 8);
          return n === safeName;
        })?.project;
      editorName = taskProject ? path.basename(taskProject) : safeName;
    } else {
      editorName = name;
    }

    exec(`"${BASH_PATH}" -l "${scriptPath}" "${tmuxSession}"`, (err) => {
      if (err) console.error(`[kill-session] Error:`, err.message);
      const titleQuery = EDITOR_TITLE ? `${editorName} - ${EDITOR_TITLE}` : editorName;
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

  if (action === 'task-add') {
    const { name: taskName, command, instructions, type, project, scheduledAt, repeat, onComplete, inputNeeded } = req.body.params || req.body;
    if (!scheduledAt) {
      return res.status(400).json({ ok: false, message: 'scheduledAt is required' });
    }
    const taskType = type || (instructions ? 'ai' : 'command');
    if (taskType === 'ai') {
      if (!instructions) {
        return res.status(400).json({ ok: false, message: 'instructions is required for AI tasks' });
      }
    } else {
      const resolvedCommand = command || BUILTIN_TASKS[taskName] || null;
      if (!resolvedCommand && !taskName) {
        return res.status(400).json({ ok: false, message: 'name or command is required' });
      }
    }
    const task = {
      id: crypto.randomUUID(),
      type: taskType,
      name: taskName || null,
      command: taskType === 'ai' ? null : (command || BUILTIN_TASKS[taskName] || null),
      instructions: taskType === 'ai' ? instructions : null,
      project: taskType === 'ai' ? (project || null) : null,
      scheduledAt,
      repeat: repeat || null,
      onComplete: onComplete || null,
      status: 'pending',
      inputNeeded: inputNeeded || null,
      waitingForInput: false,
      result: null,
      log: null,
      completedAt: null,
    };
    const tasks = readTaskQueue();
    tasks.push(task);
    writeTaskQueue(tasks);
    console.log(`[task] Added ${taskType} task "${task.id}" (${task.name || task.command || 'AI'}) at ${scheduledAt}`);

    // Auto-register wake-at on Pi (2 min before scheduledAt) so PC wakes up in time
    const schedTime = new Date(scheduledAt).getTime();
    const wakeAtTime = schedTime - 2 * 60_000;
    if (wakeAtTime > Date.now()) {
      const wakeAtISO = new Date(wakeAtTime).toISOString();
      const postData = JSON.stringify({ at: wakeAtISO });
      const wakeReq = http.request({
        hostname: PI_HOST, port: PI_PORT, path: '/api/wake-at',
        method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 3000,
      }, (wakeRes) => {
        let d = '';
        wakeRes.on('data', c => d += c);
        wakeRes.on('end', () => console.log(`[task] Registered wake-at on Pi: ${wakeAtISO}`, d));
      });
      wakeReq.on('error', (e) => console.error(`[task] Failed to register wake-at:`, e.message));
      wakeReq.on('timeout', () => { wakeReq.destroy(); console.error('[task] wake-at request timed out'); });
      wakeReq.write(postData);
      wakeReq.end();
    }

    return res.json({ ok: true, task });
  }

  if (action === 'task-list') {
    return res.json({ ok: true, tasks: readTaskQueue() });
  }

  if (action === 'task-update') {
    const { taskId, instructions, inputNeeded, name, scheduledAt, onComplete } = req.body.params || req.body;
    if (!taskId) return res.status(400).json({ ok: false, message: 'taskId is required' });
    const tasks = readTaskQueue();
    const t = tasks.find(x => x.id === taskId);
    if (!t) return res.status(404).json({ ok: false, message: 'Task not found' });
    // Running tasks: only allow clearing inputNeeded (display flag)
    if (t.status === 'running') {
      if (inputNeeded !== undefined) {
        t.inputNeeded = inputNeeded || null;
        writeTaskQueue(tasks);
        console.log(`[task] Updated running task "${taskId}" — inputNeeded=${inputNeeded || 'null'}`);
        return res.json({ ok: true, task: t });
      }
      return res.status(400).json({ ok: false, message: 'Running tasks can only update inputNeeded' });
    }
    if (t.status !== 'pending') return res.status(400).json({ ok: false, message: 'Only pending/running tasks can be updated' });
    if (instructions !== undefined) t.instructions = instructions;
    if (inputNeeded !== undefined) t.inputNeeded = inputNeeded || null;
    if (name !== undefined) t.name = name;
    if (scheduledAt !== undefined) t.scheduledAt = scheduledAt;
    if (onComplete !== undefined) t.onComplete = onComplete || null;
    writeTaskQueue(tasks);
    const changes = [];
    if (instructions !== undefined) changes.push('instructions');
    if (inputNeeded !== undefined) changes.push(`inputNeeded=${inputNeeded || 'null'}`);
    if (name !== undefined) changes.push(`name=${name}`);
    if (scheduledAt !== undefined) changes.push(`scheduledAt=${scheduledAt}`);
    if (onComplete !== undefined) changes.push(`onComplete=${onComplete || 'null'}`);
    console.log(`[task] Updated task "${taskId}" — ${changes.join(', ')}`);
    return res.json({ ok: true, task: t });
  }

  if (action === 'task-cancel') {
    const { taskId } = req.body.params || req.body;
    if (!taskId) return res.status(400).json({ ok: false, message: 'taskId is required' });

    // If running, kill tmux session + editor
    const running = runningAiTasks.get(taskId);
    if (running) {
      const safeName = running.task.name ? running.task.name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40) : taskId.slice(0, 8);
      const session = `${AI_TASK_PREFIX}${safeName}`;
      if (running.editorPid) try { process.kill(running.editorPid); } catch {}
      if (running.editorCloseTimer) clearInterval(running.editorCloseTimer);
      runningAiTasks.delete(taskId);
      exec(`"${BASH_PATH}" -lc "${TMUX} kill-session -t ${session} 2>/dev/null"`, () => {});
      setProtectedSessions(getProtectedSessions().filter(s => s !== session));
      if (EDITOR_TITLE) {
        const projName = running.task.project ? path.basename(running.task.project) : safeName;
        const titleQuery = `${projName} - ${EDITOR_TITLE}`;
        const closeScript = path.join(__dirname, 'close-window.ps1');
        exec(`powershell.exe -ExecutionPolicy Bypass -File "${closeScript}" -TitlePrefix "${titleQuery}"`, (err) => {
          if (err) console.error(`[task-cancel] close-window error:`, err.message);
        });
      }
    }

    const tasks = readTaskQueue().filter(t => t.id !== taskId);
    writeTaskQueue(tasks);
    console.log(`[task] Cancelled task "${taskId}"`);
    return res.json({ ok: true, action });
  }

  if (action === 'task-log') {
    const { taskId } = req.body.params || req.body;
    if (!taskId) return res.status(400).json({ ok: false, message: 'taskId is required' });
    const task = readTaskQueue().find(t => t.id === taskId);
    if (!task) return res.status(404).json({ ok: false, message: 'Task not found' });
    return res.json({ ok: true, task });
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
  startTaskRunner();
  console.log('[agent] Ready — waiting for commands from Pi relay');
});
