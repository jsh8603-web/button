const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '7777', 10);
const SECRET = process.env.AGENT_SECRET;
const PC_MAC = process.env.PC_MAC || '00:00:00:00:00:00';
const BROADCAST = process.env.BROADCAST || '192.168.219.255';
const AGENT_HOST = process.env.AGENT_HOST || '192.168.219.100';
const AGENT_PORT = parseInt(process.env.AGENT_PORT || '9876', 10);
const PIN_HASH = process.env.PIN_HASH;
const JWT_SECRET = process.env.JWT_SECRET;

// --- JWT (minimal, no dependencies) ---

function base64UrlEncode(data) {
  return Buffer.from(data).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function createJwt(payload, secret) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return null;
    const payload = JSON.parse(base64UrlDecode(body).toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- bcrypt verification (compare with $2b$ hash) ---
// Minimal: use crypto to check bcrypt (requires spawning python or external tool)
// Instead: Pi sends PIN to Agent's /verify-pin endpoint for validation

// --- Rate limiting ---

const failureMap = new Map();

function isRateLimited(ip) {
  const entry = failureMap.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  if (entry.lockedUntil > 0 && entry.lockedUntil <= Date.now()) {
    failureMap.delete(ip);
    return false;
  }
  return false;
}

function recordFailure(ip) {
  const entry = failureMap.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 60_000;
    entry.count = 0;
  }
  failureMap.set(ip, entry);
}

// --- Schedule persistence ---

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
function loadSchedules() { try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); } catch { return []; } }
function saveSchedules(list) { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2)); }

// --- Deferred task queue (for when PC is offline) ---
const DEFERRED_FILE = path.join(__dirname, 'deferred-tasks.json');
function loadDeferred() { try { return JSON.parse(fs.readFileSync(DEFERRED_FILE, 'utf8')); } catch { return []; } }
function saveDeferred(list) { fs.writeFileSync(DEFERRED_FILE, JSON.stringify(list, null, 2)); }
const DEFERRED_EXPIRY_MS = 10 * 60 * 1000; // 10 min expiry

// --- Wake-at: one-time delayed WOL ---
const WAKE_AT_FILE = path.join(__dirname, '.wake-at.json');
function loadWakeAt() { try { return JSON.parse(fs.readFileSync(WAKE_AT_FILE, 'utf8')); } catch { return null; } }
function saveWakeAt(data) { fs.writeFileSync(WAKE_AT_FILE, JSON.stringify(data, null, 2)); }
function clearWakeAt() { try { fs.unlinkSync(WAKE_AT_FILE); } catch {} }

// --- Task cache (visible when PC is offline) ---
const TASK_CACHE_FILE = path.join(__dirname, '.task-cache.json');
function loadTaskCache() { try { return JSON.parse(fs.readFileSync(TASK_CACHE_FILE, 'utf8')); } catch { return null; } }
function saveTaskCache(data) { fs.writeFileSync(TASK_CACHE_FILE, JSON.stringify(data)); }

// --- Cron expression matcher (no dependencies) ---
// Format: "min hour dayOfMonth month dayOfWeek"
// Supports: *, numbers, ranges (1-5), lists (1,3,5), */N

function matchField(field, value) {
  if (field === '*') return true;
  if (field.includes('/')) { const [, step] = field.split('/'); return value % parseInt(step) === 0; }
  return field.split(',').some(part => {
    if (part.includes('-')) { const [a, b] = part.split('-').map(Number); return value >= a && value <= b; }
    return parseInt(part) === value;
  });
}

function matchesCron(cronExpr, date) {
  const [minF, hourF, domF, monF, dowF] = cronExpr.split(/\s+/);
  const min = date.getMinutes(), hour = date.getHours();
  const dom = date.getDate(), mon = date.getMonth() + 1, dow = date.getDay();
  return matchField(minF, min) && matchField(hourF, hour) && matchField(domF, dom) && matchField(monF, mon) && matchField(dowF, dow);
}

// --- Alert thresholds ---

let alerts = [];
const ALERT_THRESHOLDS = { diskPercent: 90, cpuPercent: 95, gpuTemp: 85 };

function checkAlerts(metrics) {
  if (!metrics) return;
  const next = [];

  // Disk alerts
  if (Array.isArray(metrics.disks)) {
    for (const disk of metrics.disks) {
      const pct = disk.usedPercent ?? disk.used_percent;
      if (pct != null && pct > ALERT_THRESHOLDS.diskPercent) {
        next.push({ type: 'disk', message: `${disk.drive || disk.mount}: ${Math.round(pct)}% full`, since: alerts.find(a => a.type === 'disk' && a.message.startsWith(disk.drive || disk.mount))?.since || new Date().toISOString() });
      }
    }
  }

  // CPU alert
  const cpu = metrics.cpu ?? metrics.cpuPercent ?? metrics.cpu_percent;
  if (cpu != null && cpu > ALERT_THRESHOLDS.cpuPercent) {
    next.push({ type: 'cpu', message: `CPU ${Math.round(cpu)}%`, since: alerts.find(a => a.type === 'cpu')?.since || new Date().toISOString() });
  }

  // GPU temp alert
  const gpuTemp = metrics.gpuTemp ?? metrics.gpu_temp;
  if (gpuTemp != null && gpuTemp > ALERT_THRESHOLDS.gpuTemp) {
    next.push({ type: 'gpu_temp', message: `GPU ${Math.round(gpuTemp)}°C`, since: alerts.find(a => a.type === 'gpu_temp')?.since || new Date().toISOString() });
  }

  alerts = next;
}

// --- WOL ---

function createMagicPacket(mac) {
  const macBytes = mac.split(':').map(h => parseInt(h, 16));
  const packet = Buffer.alloc(102);
  for (let i = 0; i < 6; i++) packet[i] = 0xff;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = macBytes[j];
    }
  }
  return packet;
}

function sendWol() {
  return new Promise((resolve, reject) => {
    const packet = createMagicPacket(PC_MAC);
    const client = dgram.createSocket('udp4');
    client.bind(() => {
      client.setBroadcast(true);
      let sent = 0;
      const total = 3;
      function sendOne() {
        client.send(packet, 0, packet.length, 9, BROADCAST, (err) => {
          if (err) { client.close(); return reject(err); }
          sent++;
          if (sent < total) setTimeout(sendOne, 250);
          else { client.close(); resolve(sent); }
        });
      }
      sendOne();
    });
  });
}

// --- Agent proxy helper ---

function agentRequest(method, path, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: AGENT_HOST,
      port: AGENT_PORT,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${SECRET}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Agent timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- HTTP helpers ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function corsHeaders(req) {
  // CORS for local dev (production is same-origin, no CORS needed)
  const origin = req.headers.origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// req is stored per-request so sendJson can access it
let _currentReq = null;

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(_currentReq ? corsHeaders(_currentReq) : {}),
    ...headers,
  });
  res.end(JSON.stringify(data));
}

// --- Auth middleware ---

function requireAuth(req) {
  if (!JWT_SECRET) return false;
  // Accept token from Authorization header (Bearer) or cookie
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : getCookie(req, 'token');
  if (!token) return false;
  return verifyJwt(token, JWT_SECRET) !== null;
}

// --- Static file serving ---

const STATIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.txt': 'text/plain',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(STATIC_DIR, pathname);
  // Directory → index.html
  if (pathname === '/' || !path.extname(pathname)) {
    const indexPath = path.join(filePath, 'index.html');
    if (fs.existsSync(indexPath)) filePath = indexPath;
    else if (!path.extname(pathname)) filePath += '.html';
  }
  // Security: prevent path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); return res.end();
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheControl = pathname.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl });
    res.end(data);
  } catch {
    return null; // File not found — let caller handle
  }
  return true;
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  _currentReq = req;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders(req), 'Access-Control-Max-Age': '86400' });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // --- Health (no auth) ---
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, uptime: process.uptime() });
  }

  // --- Static files (before auth, non-API GET requests) ---
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    if (serveStatic(req, res, pathname)) return;
  }

  // --- Auth: PIN → JWT cookie ---
  if (req.method === 'POST' && pathname === '/api/auth') {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { error: 'rate_limited' });
    }

    try {
      const body = await parseBody(req);
      const { pin } = body;

      if (!pin || typeof pin !== 'string' || !PIN_HASH) {
        recordFailure(ip);
        return sendJson(res, 401, { error: 'invalid' });
      }

      // Forward PIN verification to Agent (it has bcrypt)
      let valid = false;
      try {
        const result = await agentRequest('POST', '/verify-pin', { pin });
        valid = result.status === 200 && result.data.ok;
      } catch {
        valid = false;
      }

      if (!valid) {
        recordFailure(ip);
        return sendJson(res, 401, { error: 'invalid' });
      }

      failureMap.delete(ip);

      const token = createJwt(
        { authorized: true, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 },
        JWT_SECRET
      );

      return sendJson(res, 200, { ok: true, token });
    } catch {
      return sendJson(res, 400, { error: 'invalid' });
    }
  }

  // --- All routes below require auth (localhost + Agent IP bypass) ---
  const clientIp = getClientIp(req);
  const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
  const isAgent = clientIp === AGENT_HOST || clientIp === `::ffff:${AGENT_HOST}`;
  if (!isLocalhost && !isAgent && !requireAuth(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  // --- Status: check if Agent is online, get sessions/projects ---
  if (req.method === 'GET' && pathname === '/api/status') {
    try {
      const result = await agentRequest('GET', '/status', null, 2000);
      if (result.data?.metrics) checkAlerts(result.data.metrics);
      // Cache tasks from status response for offline use
      if (result.data?.tasks) {
        saveTaskCache({ tasks: result.data.tasks, cachedAt: new Date().toISOString() });
      }
      return sendJson(res, 200, { ...result.data, alerts });
    } catch {
      const cache = loadTaskCache();
      return sendJson(res, 200, {
        status: 'offline',
        alerts,
        ...(cache?.tasks ? { tasks: cache.tasks, tasksCached: true, tasksCachedAt: cache.cachedAt } : {}),
      });
    }
  }

  // --- Wake: send WOL magic packet (Pi is on LAN) ---
  if (req.method === 'POST' && pathname === '/api/wake') {
    try {
      const count = await sendWol();
      console.log(`[wol] Sent ${count} magic packets to ${PC_MAC} via ${BROADCAST}`);
      return sendJson(res, 200, { ok: true, packets: count, mac: PC_MAC });
    } catch (err) {
      console.error('[wol] Error:', err.message);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // --- Shutdown: forward to Agent ---
  if (req.method === 'POST' && pathname === '/api/shutdown') {
    try {
      const result = await agentRequest('POST', '/shutdown');
      return sendJson(res, result.status, result.data);
    } catch {
      return sendJson(res, 502, { ok: false, error: 'Agent unreachable' });
    }
  }

  // --- Wake-at: one-time delayed WOL ---
  if (pathname === '/api/wake-at') {
    if (req.method === 'GET') {
      const timer = loadWakeAt();
      return sendJson(res, 200, timer || { active: false });
    }
    if (req.method === 'POST') {
      try {
        const body = await parseBody(req);
        let wakeAt;
        if (body.at) {
          wakeAt = new Date(body.at).toISOString();
        } else if (body.delayMinutes) {
          wakeAt = new Date(Date.now() + body.delayMinutes * 60_000).toISOString();
        } else {
          return sendJson(res, 400, { error: 'at (ISO8601) or delayMinutes required' });
        }
        const timer = { active: true, wakeAt, createdAt: new Date().toISOString() };
        saveWakeAt(timer);
        console.log(`[wake-at] Scheduled WOL at ${wakeAt}`);
        return sendJson(res, 201, timer);
      } catch {
        return sendJson(res, 400, { error: 'invalid' });
      }
    }
    if (req.method === 'DELETE') {
      clearWakeAt();
      console.log('[wake-at] Cancelled');
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- Run: forward action to Agent (with deferred fallback for task-add, cache for task-list) ---
  if (req.method === 'POST' && pathname === '/api/run') {
    try {
      const body = await parseBody(req);

      // Scheduled delivery: task-add with deliverAt → always defer
      if (body.action === 'task-add' && body.deliverAt) {
        const deferred = loadDeferred();
        deferred.push({ body, createdAt: new Date().toISOString(), deliverAt: body.deliverAt, wolSent: false });
        saveDeferred(deferred);
        console.log(`[deferred] Scheduled task-add for delivery at ${body.deliverAt}`);
        return sendJson(res, 202, { ok: true, deferred: true, deliverAt: body.deliverAt, message: 'Task scheduled for delivery' });
      }

      try {
        const result = await agentRequest('POST', '/run', body);
        // Cache task-list responses
        if (body.action === 'task-list' && result.data?.tasks) {
          saveTaskCache({ tasks: result.data.tasks, cachedAt: new Date().toISOString() });
        }
        // After successful task-add, refresh cache so offline status shows updated tasks
        if (body.action === 'task-add' && result.data?.ok) {
          try {
            const listResult = await agentRequest('POST', '/run', { action: 'task-list' });
            if (listResult.data?.tasks) {
              saveTaskCache({ tasks: listResult.data.tasks, cachedAt: new Date().toISOString() });
            }
          } catch { /* best effort */ }
        }
        return sendJson(res, result.status, result.data);
      } catch {
        // Agent unreachable — if task-add, defer + WOL
        if (body.action === 'task-add') {
          const deferred = loadDeferred();
          deferred.push({ body, createdAt: new Date().toISOString(), deliverAt: null, wolSent: false });
          saveDeferred(deferred);
          console.log(`[deferred] Saved task-add (PC offline), sending WOL`);
          sendWol().catch(err => console.error('[deferred] WOL error:', err.message));
          return sendJson(res, 202, { ok: true, deferred: true, message: 'PC offline — WOL sent, task queued for delivery' });
        }
        // Return cached tasks when offline
        if (body.action === 'task-list') {
          const cache = loadTaskCache();
          if (cache?.tasks) {
            return sendJson(res, 200, { ok: true, tasks: cache.tasks, cached: true, cachedAt: cache.cachedAt });
          }
        }
        return sendJson(res, 502, { ok: false, error: 'Agent unreachable' });
      }
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Invalid request body' });
    }
  }

  // --- Projects: forward to Agent ---
  if (req.method === 'GET' && pathname === '/api/projects') {
    try {
      const result = await agentRequest('GET', '/projects');
      return sendJson(res, 200, result.data);
    } catch {
      return sendJson(res, 502, { ok: false, error: 'Agent unreachable' });
    }
  }

  // --- Deferred tasks query ---
  if (req.method === 'GET' && pathname === '/api/deferred') {
    return sendJson(res, 200, loadDeferred());
  }

  // --- Schedules CRUD ---
  if (pathname === '/api/schedules') {
    if (req.method === 'GET') {
      return sendJson(res, 200, loadSchedules());
    }
    if (req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { action, cron, label, enabled } = body;
        if (!action || !cron || !label) return sendJson(res, 400, { error: 'action, cron, label required' });
        const schedule = { id: crypto.randomUUID(), type: 'power', action, cron, label, enabled: enabled !== false };
        const list = loadSchedules();
        list.push(schedule);
        saveSchedules(list);
        return sendJson(res, 201, schedule);
      } catch {
        return sendJson(res, 400, { error: 'invalid' });
      }
    }
  }

  const scheduleIdMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleIdMatch) {
    const id = scheduleIdMatch[1];
    if (req.method === 'DELETE') {
      const list = loadSchedules();
      const next = list.filter(s => s.id !== id);
      if (next.length === list.length) return sendJson(res, 404, { error: 'Not found' });
      saveSchedules(next);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      try {
        const body = await parseBody(req);
        const list = loadSchedules();
        const idx = list.findIndex(s => s.id === id);
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        const { action, cron, label, enabled } = body;
        if (action !== undefined) list[idx].action = action;
        if (cron !== undefined) list[idx].cron = cron;
        if (label !== undefined) list[idx].label = label;
        if (enabled !== undefined) list[idx].enabled = enabled;
        saveSchedules(list);
        return sendJson(res, 200, list[idx]);
      } catch {
        return sendJson(res, 400, { error: 'invalid' });
      }
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

let lastScheduleMinute = -1;
function runScheduler() {
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();

  // --- Deferred task delivery (runs every cycle, not just once per minute) ---
  const deferred = loadDeferred();
  if (deferred.length > 0) {
    // Expire old tasks (only those without deliverAt or past deliverAt)
    const valid = deferred.filter(d => {
      if (d.deliverAt) return (now - new Date(d.deliverAt)) < DEFERRED_EXPIRY_MS;
      return (now - new Date(d.createdAt)) < DEFERRED_EXPIRY_MS;
    });
    if (valid.length !== deferred.length) {
      const expired = deferred.length - valid.length;
      console.log(`[deferred] Expired ${expired} task(s)`);
      saveDeferred(valid);
    }

    // Split: ready (deliverAt <= now or no deliverAt) vs waiting
    const ready = valid.filter(d => !d.deliverAt || new Date(d.deliverAt) <= now);
    if (ready.length > 0) {
      agentRequest('GET', '/health').then(() => {
        console.log(`[deferred] Agent online — delivering ${ready.length} task(s)`);
        const remaining = [...valid];
        let changed = false;
        const deliver = (i) => {
          if (i >= remaining.length) { if (changed) saveDeferred(remaining.filter(Boolean)); return; }
          // Skip tasks not yet ready
          if (remaining[i]?.deliverAt && new Date(remaining[i].deliverAt) > now) { deliver(i + 1); return; }
          if (!remaining[i]) { deliver(i + 1); return; }
          agentRequest('POST', '/run', remaining[i].body).then(result => {
            console.log(`[deferred] Delivered task ${i + 1}/${remaining.length}: ${result.data?.ok ? 'OK' : 'FAIL'}`);
            remaining[i] = null;
            changed = true;
            deliver(i + 1);
          }).catch(err => {
            console.error(`[deferred] Delivery failed for task ${i + 1}:`, err.message);
            deliver(i + 1);
          });
        };
        deliver(0);
      }).catch(() => {
        // Agent offline — send WOL for ready tasks that haven't had WOL sent yet
        let wolNeeded = false;
        for (const d of ready) {
          if (!d.wolSent) { d.wolSent = true; wolNeeded = true; }
        }
        if (wolNeeded) {
          saveDeferred(valid);
          console.log(`[deferred] Agent offline at delivery time — sending WOL`);
          sendWol().catch(err => console.error('[deferred] WOL error:', err.message));
        }
      });
    }
  }

  // --- Wake-at: one-time WOL timer check ---
  const wakeTimer = loadWakeAt();
  if (wakeTimer?.active && new Date(wakeTimer.wakeAt) <= now) {
    console.log(`[wake-at] Firing WOL (scheduled: ${wakeTimer.wakeAt})`);
    sendWol().then(count => console.log(`[wake-at] Sent ${count} magic packets`))
      .catch(err => console.error('[wake-at] WOL error:', err.message));
    clearWakeAt();
  }

  // --- Cron schedules (once per minute) ---
  if (currentMinute === lastScheduleMinute) return;
  lastScheduleMinute = currentMinute;

  const schedules = loadSchedules();
  for (const s of schedules) {
    if (!s.enabled) continue;
    if (matchesCron(s.cron, now)) {
      console.log(`[scheduler] Executing: ${s.label} (${s.action})`);
      if (s.action === 'wake') sendWol().catch(err => console.error('[scheduler] WOL error:', err.message));
      else agentRequest('POST', '/run', { action: s.action }).catch(err => console.error('[scheduler] Agent error:', err.message));
    }
  }
}

server.listen(PORT, () => {
  console.log(`Button Pi relay listening on port ${PORT}`);
  console.log(`Agent: ${AGENT_HOST}:${AGENT_PORT}`);
  console.log(`WOL target: ${PC_MAC} via ${BROADCAST}`);
  function scheduleLoop() { runScheduler(); setTimeout(scheduleLoop, 60_000); }
  setTimeout(scheduleLoop, 5_000); // first run 5s after boot
});
