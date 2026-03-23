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

function agentRequest(method, path, body) {
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
      timeout: 10000,
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  // --- All routes below require auth ---
  if (!requireAuth(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  // --- Status: check if Agent is online, get sessions/projects ---
  if (req.method === 'GET' && pathname === '/api/status') {
    try {
      const result = await agentRequest('GET', '/status');
      return sendJson(res, 200, result.data);
    } catch {
      return sendJson(res, 200, { status: 'offline' });
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

  // --- Run: forward action to Agent ---
  if (req.method === 'POST' && pathname === '/api/run') {
    try {
      const body = await parseBody(req);
      const result = await agentRequest('POST', '/run', body);
      return sendJson(res, result.status, result.data);
    } catch {
      return sendJson(res, 502, { ok: false, error: 'Agent unreachable' });
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

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Button Pi relay listening on port ${PORT}`);
  console.log(`Agent: ${AGENT_HOST}:${AGENT_PORT}`);
  console.log(`WOL target: ${PC_MAC} via ${BROADCAST}`);
});
