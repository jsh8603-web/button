const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  module.exports = {
    init() { console.log('[telegram] Disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set'); },
    notify() {},
    bot: null,
  };
  return;
}

const bot = new TelegramBot(TOKEN, { polling: true });
const chatId = String(CHAT_ID);

// --- State (injected by server.js via init()) ---
let getActiveSessionObjects = null;
let getProtectedSessions = null;
let sessionRunnerMap = null;
let PSMUX_BIN = null;
let SESSION_PREFIX = null;
let AI_TASK_PREFIX = null;

// --- Session state ---
let selectedSession = null; // currently selected psmux session name

// Completion detection: poll for idle prompt after sending
const IDLE_PATTERNS = [
  /❯\s*$/,          // Claude Code prompt
  />>>\s*$/,         // Gemini prompt
  /\$\s*$/,          // bash prompt
  />\s*$/,           // generic prompt
];
const POLL_INTERVAL = 5000;   // check every 5s
const STABLE_THRESHOLD = 10000; // output unchanged for 10s = done
let completionWatcher = null;

function init(deps) {
  getActiveSessionObjects = deps.getActiveSessionObjects;
  getProtectedSessions = deps.getProtectedSessions;
  sessionRunnerMap = deps.sessionRunnerMap;
  PSMUX_BIN = deps.PSMUX_BIN;
  SESSION_PREFIX = deps.SESSION_PREFIX;
  AI_TASK_PREFIX = deps.AI_TASK_PREFIX;

  console.log(`[telegram] Bot started — chat_id: ${chatId}`);

  bot.on('message', (msg) => {
    if (String(msg.chat.id) !== chatId) return;
    handleMessage(msg);
  });

  bot.on('callback_query', (query) => {
    if (String(query.message.chat.id) !== chatId) return;
    handleCallback(query);
  });

  bot.on('polling_error', () => {});
}

// --- Message handler ---
async function handleMessage(msg) {
  const text = (msg.text || '').trim();

  if (text === '/start' || text === '/help') {
    return send(
      '*Clauni Bot*\n\n' +
      '/sessions — 세션 목록 + 선택\n' +
      '/tasks — 태스크 큐\n' +
      '/view — 현재 세션 화면 캡처\n' +
      '/disconnect — 세션 연결 해제\n\n' +
      '세션 선택 후 메시지 → 프롬프트 전달 → 완료 시 결과 보고',
      { parse_mode: 'Markdown' }
    );
  }

  if (text === '/sessions') return showSessions();
  if (text === '/tasks') return showTasks();
  if (text === '/view') return viewSession();
  if (text === '/disconnect') return disconnect();

  // Send to selected session
  if (selectedSession) {
    return sendPrompt(selectedSession, text);
  }

  // No session selected — auto-select if only one
  const sessions = await getActiveSessions();
  if (sessions.length === 0) return send('활성 세션이 없습니다.');
  if (sessions.length === 1) {
    selectedSession = sessions[0].psmuxName;
    send(`\`${sessions[0].name}\` 자동 선택`, { parse_mode: 'Markdown' });
    return sendPrompt(selectedSession, text);
  }
  return send('세션을 먼저 선택해주세요:', { reply_markup: buildSessionKeyboard(sessions) });
}

// --- Callback handler ---
async function handleCallback(query) {
  const data = query.data;
  bot.answerCallbackQuery(query.id);

  if (data.startsWith('select:')) {
    const psmuxName = data.slice('select:'.length);
    selectedSession = psmuxName;
    send(`*${psmuxName}* 연결됨`, { parse_mode: 'Markdown' });
  } else if (data.startsWith('capture:')) {
    const psmuxName = data.slice('capture:'.length);
    const output = await capturePane(psmuxName);
    send(`\`\`\`\n${truncate(output, 3800)}\n\`\`\``, { parse_mode: 'Markdown' });
  }
}

// --- Core ---

async function getActiveSessions() {
  if (!getActiveSessionObjects) return [];
  try { return await getActiveSessionObjects(); } catch { return []; }
}

async function showSessions() {
  const sessions = await getActiveSessions();
  if (sessions.length === 0) return send('활성 세션이 없습니다.');

  const protectedList = getProtectedSessions();
  const lines = sessions.map(s => {
    const shield = protectedList.includes(s.name) ? '\u{1F6E1}' : '';
    let runner = '';
    if (s.type === 'btn') {
      const projName = s.name.slice(SESSION_PREFIX.length);
      runner = sessionRunnerMap.get(projName) || 'claude';
    } else if (s.type === 'schedule') {
      runner = 'ai-task';
    }
    const tag = runner ? ` (${runner})` : '';
    const active = selectedSession === s.psmuxName ? ' \u25C0' : '';
    return `${shield} \`${s.name}\`${tag}${active}`;
  });

  send(lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: buildSessionKeyboard(sessions),
  });
}

async function showTasks() {
  try {
    const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, '.task-queue.json'), 'utf8'));
    const active = tasks.filter(t => ['pending', 'running'].includes(t.status));
    if (active.length === 0) return send('대기/실행 중인 태스크가 없습니다.');
    const lines = active.map(t => {
      const icon = t.status === 'running' ? '\u{1F7E2}' : '\u{1F7E1}';
      return `${icon} \`${t.id.slice(0,8)}\` ${t.name || t.command || 'ai-task'} — ${t.status}`;
    });
    send(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch {
    send('태스크 큐를 읽을 수 없습니다.');
  }
}

async function viewSession() {
  if (!selectedSession) return send('연결된 세션이 없습니다. /sessions 로 선택하세요.');
  const output = await capturePane(selectedSession);
  send(`\`\`\`\n${truncate(output, 3800)}\n\`\`\``, { parse_mode: 'Markdown' });
}

function disconnect() {
  stopCompletionWatcher();
  const was = selectedSession;
  selectedSession = null;
  if (was) send(`\`${was}\` 연결 해제`, { parse_mode: 'Markdown' });
  else send('연결된 세션이 없습니다.');
}

function buildSessionKeyboard(sessions) {
  const buttons = sessions.map(s => ([
    { text: `\u{1F4AC} ${s.name}`, callback_data: `select:${s.psmuxName}` },
    { text: `\u{1F4CB} 출력`, callback_data: `capture:${s.psmuxName}` },
  ]));
  return { inline_keyboard: buttons };
}

// --- Prompt send + completion detection ---

function getSessionRunner(psmuxName) {
  // btn-{name} → check sessionRunnerMap for {name}
  if (psmuxName.startsWith(SESSION_PREFIX)) {
    const projName = psmuxName.slice(SESSION_PREFIX.length);
    return sessionRunnerMap.get(projName) || 'claude';
  }
  return 'claude';
}

function sendPrompt(psmuxName, text) {
  const escaped = text.replace(/'/g, "'\\''");
  const runner = getSessionRunner(psmuxName);

  if (runner === 'gemini') {
    // Gemini needs: text → 2s → Enter → 2s → Enter → 2s → Enter
    exec(`"${PSMUX_BIN}" send-keys -t ${psmuxName} '${escaped}'`, (err) => {
      if (err) return send(`\u274C 전송 실패: ${err.message}`);
      setTimeout(() => {
        exec(`"${PSMUX_BIN}" send-keys -t ${psmuxName} Enter`, () => {
          setTimeout(() => {
            exec(`"${PSMUX_BIN}" send-keys -t ${psmuxName} Enter`, () => {
              setTimeout(() => {
                exec(`"${PSMUX_BIN}" send-keys -t ${psmuxName} Enter`, () => {
                  send(`\u{1F4E8} 전송됨 → \`${psmuxName}\` (gemini)\n작업 완료 시 결과를 보고합니다.`, { parse_mode: 'Markdown' });
                  watchForCompletion(psmuxName);
                });
              }, 2000);
            });
          }, 2000);
        });
      }, 2000);
    });
  } else {
    exec(`"${PSMUX_BIN}" send-keys -t ${psmuxName} '${escaped}' Enter`, (err) => {
      if (err) return send(`\u274C 전송 실패: ${err.message}`);
      send(`\u{1F4E8} 전송됨 → \`${psmuxName}\`\n작업 완료 시 결과를 보고합니다.`, { parse_mode: 'Markdown' });
      watchForCompletion(psmuxName);
    });
  }
}

function watchForCompletion(psmuxName) {
  stopCompletionWatcher();

  let lastOutput = '';
  let lastChangeTime = Date.now();
  let baselineSet = false;

  // Wait 3s before starting to let the prompt be consumed
  setTimeout(() => {
    completionWatcher = setInterval(async () => {
      const current = await capturePane(psmuxName);
      if (!baselineSet) {
        lastOutput = current;
        lastChangeTime = Date.now();
        baselineSet = true;
        return;
      }

      if (current !== lastOutput) {
        lastOutput = current;
        lastChangeTime = Date.now();
        return;
      }

      // Output stable — check if prompt is idle
      const stableFor = Date.now() - lastChangeTime;
      if (stableFor < STABLE_THRESHOLD) return;

      const trimmed = current.trimEnd();
      const isIdle = IDLE_PATTERNS.some(p => p.test(trimmed));
      if (!isIdle) return;

      // Done — extract result (last meaningful output)
      stopCompletionWatcher();
      const lines = current.split('\n').filter(l => l.trim());
      // Take last ~60 lines as result (skip prompt line)
      const result = lines.slice(Math.max(0, lines.length - 60), -1).join('\n');
      send(
        `\u2705 *작업 완료* — \`${psmuxName}\`\n\`\`\`\n${truncate(result, 3600)}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    }, POLL_INTERVAL);
  }, 3000);
}

function stopCompletionWatcher() {
  if (completionWatcher) {
    clearInterval(completionWatcher);
    completionWatcher = null;
  }
}

// --- Capture ---

function capturePane(psmuxName) {
  return new Promise((resolve) => {
    exec(`"${PSMUX_BIN}" capture-pane -t ${psmuxName} -p`, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? `(capture error: ${err.message})` : (stdout || '(empty)'));
    });
  });
}

// --- Notification API (called by server.js) ---

function notify(message, opts) {
  send(message, opts);
}

function send(text, opts = {}) {
  if (!text) return;
  bot.sendMessage(chatId, text, opts).catch(err => {
    console.error('[telegram] Send error:', err.message);
  });
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(str.length - max) + '\n...(truncated)';
}

module.exports = { init, notify, bot };
