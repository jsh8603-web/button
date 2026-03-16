/**
 * Router WOL — Auto-login to LG U+ router and maintain session cookie
 *
 * Hybrid CAPTCHA solving:
 *   1. Claude AI (5x reads, 2 models) → variants → try login
 *   2. Fallback: 2Captcha API (human solvers, 99%+ accuracy) if CAPTCHA_API_KEY set
 *
 * The session cookie is reused for router's built-in WOL API (LAN broadcast, works for Sleep/Hibernate)
 */

const http = require('http');
const https = require('https');
const vm = require('vm');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const sharp = require('sharp');

const ROUTER_IP = '192.168.219.1';
const HEADERS = {
  Host: ROUTER_IP,
  Origin: `http://${ROUTER_IP}`,
  Referer: `http://${ROUTER_IP}/web/intro.html`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Connection: 'keep-alive',
  Accept: '*/*',
  'Accept-Language': 'ko',
};

// --- HTTP helper (matches proven router-login.js pattern) ---

function httpReq(method, reqPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: ROUTER_IP, port: 80, path: reqPath, method,
      headers: { ...HEADERS },
    };
    if (cookie) opts.headers.Cookie = cookie;
    if (body) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          data: Buffer.concat(chunks),
          setCookie: sc ? sc.map(c => c.split(';')[0]).join('; ') : null,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// --- RSA encryption via router's own JS libraries in VM sandbox ---

let vmContext = null;

function initVM() {
  if (vmContext) return;

  const jsbnCode = fs.readFileSync(path.join(__dirname, 'router-js', 'jsbn.js'), 'utf8');
  const prng4Code = fs.readFileSync(path.join(__dirname, 'router-js', 'prng4.js'), 'utf8');
  const rngCode = fs.readFileSync(path.join(__dirname, 'router-js', 'rng.js'), 'utf8');
  const rsaCode = fs.readFileSync(path.join(__dirname, 'router-js', 'rsa.js'), 'utf8');

  const sandbox = {
    navigator: { appName: 'Netscape', appVersion: '5.0' },
    alert: console.error, Math, Date, Array, parseInt, String, Uint8Array,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.window.crypto = {
    getRandomValues: (arr) => {
      const buf = crypto.randomBytes(arr.length);
      for (let i = 0; i < arr.length; i++) arr[i] = buf[i];
      return arr;
    },
  };

  vmContext = vm.createContext(sandbox);
  vm.runInContext(jsbnCode, vmContext);
  vm.runInContext(prng4Code, vmContext);
  vm.runInContext(rngCode, vmContext);
  vm.runInContext(rsaCode, vmContext);

  console.log('[router] VM sandbox initialized with router crypto libraries');
}

function passEnc2(keyStr, nVal, eVal) {
  const escaped = keyStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return vm.runInContext(`var rsa = new RSAKey(); rsa.setPublic("${nVal}", "${eVal}"); rsa.encrypt("${escaped}") || "";`, vmContext);
}

// --- Session state ---

let currentCookie = null;
let lastLoginTime = 0;

// --- CAPTCHA solving via Claude API (3x read → all unique + charVote + variants) ---

function charVote(reads) {
  const validReads = reads.filter(r => r.length >= 4 && r.length <= 8);
  if (validReads.length === 0) return null;

  const lenCounts = {};
  for (const r of validReads) lenCounts[r.length] = (lenCounts[r.length] || 0) + 1;
  const targetLen = parseInt(Object.entries(lenCounts).sort((a, b) => b[1] - a[1])[0][0]);

  const sameLen = validReads.filter(r => r.length === targetLen);
  if (sameLen.length === 0) return validReads[0];

  let result = '';
  for (let pos = 0; pos < targetLen; pos++) {
    const charCounts = {};
    for (const r of sameLen) {
      charCounts[r[pos]] = (charCounts[r[pos]] || 0) + 1;
    }
    result += Object.entries(charCounts).sort((a, b) => b[1] - a[1])[0][0];
  }
  return result;
}

async function preprocessImage(imageBuffer) {
  // Grayscale → high-contrast threshold → 3x upscale → sharpen
  return sharp(imageBuffer)
    .greyscale()
    .threshold(140)
    .resize({ width: 600 })
    .sharpen()
    .png()
    .toBuffer();
}

async function solveCaptcha(imageBuffer) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });

  // Preprocess: denoise + high contrast + upscale
  const processed = await preprocessImage(imageBuffer);
  const base64Image = processed.toString('base64');

  // 3x parallel reads with Opus (Sonnet generates English words instead of CAPTCHA text)
  const responses = await Promise.all(Array.from({ length: 3 }, () =>
    client.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image } },
          { type: 'text', text: 'Read the distorted text in this CAPTCHA image. Give your top 3 guesses, one per line, lowercase only. Nothing else.' },
        ],
      }],
    }).then(r => {
      const lines = (r.content[0]?.text || '').split('\n')
        .map(l => l.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(l => l.length >= 4 && l.length <= 8);
      return lines;
    }).catch(() => [])
  ));

  // Collect all unique AI readings
  const allReads = new Set();
  for (const lines of responses) {
    for (const line of lines) allReads.add(line);
  }

  // Also add charVote consensus from first-choice readings
  const firstChoices = responses.map(lines => lines[0]).filter(Boolean);
  const voted = charVote(firstChoices);
  if (voted) allReads.add(voted);

  // Filter out common English words (model sometimes "autocompletes" CAPTCHAs into words)
  const ENGLISH_WORDS = new Set(['figure', 'figaro', 'master', 'basket', 'netizen', 'whisker', 'whimper', 'whisked', 'whipped', 'whailed', 'whaled']);
  for (const word of ENGLISH_WORDS) allReads.delete(word);

  const candidates = [...allReads];
  if (candidates.length === 0) throw new Error('All CAPTCHA reads invalid');

  console.log(`[router] CAPTCHA candidates (${candidates.length}): ${candidates.join(', ')}`);
  return candidates;
}

// --- 2Captcha fallback solver (human workers, 99%+ accuracy) ---

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

function httpsPost(url, formData) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formData) },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(formData);
    req.end();
  });
}

async function solveCaptcha2Captcha(imageBuffer) {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) return null;

  const base64 = imageBuffer.toString('base64');
  const form = `key=${apiKey}&method=base64&body=${encodeURIComponent(base64)}&json=1&min_len=4&max_len=8`;

  const submitRes = JSON.parse(await httpsPost('https://2captcha.com/in.php', form));
  if (submitRes.status !== 1) {
    console.log(`[router] 2Captcha submit failed: ${submitRes.request}`);
    return null;
  }

  const taskId = submitRes.request;
  console.log(`[router] 2Captcha task ${taskId}, waiting for solution...`);

  // Poll for result (human solvers take ~10-15s)
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const result = JSON.parse(await httpsGet(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`));
    if (result.status === 1) {
      const answer = result.request.trim().toLowerCase();
      console.log(`[router] 2Captcha solved: "${answer}"`);
      return [answer];
    }
    if (result.request !== 'CAPCHA_NOT_READY') {
      console.log(`[router] 2Captcha error: ${result.request}`);
      return null;
    }
  }

  console.log('[router] 2Captcha timeout');
  return null;
}

// --- Character confusion map for CAPTCHA variant generation ---

const CONFUSIONS = {
  'i': ['j', 'l', '1'], 'j': ['i', 'l'], 'l': ['i', 'j', '1'],
  'c': ['s', 'e', 'o'], 's': ['c', 'e', '5'],
  'b': ['d', 'h', '6'], 'd': ['b'],
  'p': ['q', 'g'], 'q': ['p', 'g', 'a', '9'],
  'n': ['h', 'r', 'm'], 'h': ['n', 'b'],
  'v': ['y', 'u', 'w'], 'y': ['v', 'u'],
  'u': ['v', 'n'], 'a': ['o', 'e', 'q'],
  'o': ['a', 'c', '0'], 'e': ['c', 'a'],
  'r': ['n', 't'], 't': ['r', 'f', '7'],
  'k': ['h'], 'f': ['t', 'r'],
  'g': ['q', 'p', '9'],
  '0': ['o', 'a'], '1': ['i', 'l', 'j'],
  '2': ['z'], '3': ['e'],
  '5': ['s', 'c'], '6': ['b', 'g'],
  '8': ['b'], '9': ['g', 'q', 'p'],
  'z': ['2'], 'w': ['v', 'vv'],
  'm': ['n', 'rn'],
};

function generateAllVariants(candidates, maxTotal = 80) {
  const variants = new Set();
  // Add all raw candidates first (highest priority)
  for (const c of candidates) variants.add(c);
  // Add length variants (trim last char, in case model added extra)
  for (const c of candidates) {
    if (c.length > 4) variants.add(c.substring(0, c.length - 1));
  }
  // Then generate single-char substitutions for each candidate
  for (const answer of candidates) {
    for (let i = 0; i < answer.length; i++) {
      const alts = CONFUSIONS[answer[i]] || [];
      for (const alt of alts) {
        if (alt.length === 1) {
          variants.add(answer.substring(0, i) + alt + answer.substring(i + 1));
        }
        if (variants.size >= maxTotal) return [...variants];
      }
    }
  }
  return [...variants];
}

// --- Router login flow ---

async function login(use2CaptchaOnly = false) {
  const password = process.env.ROUTER_PASSWORD;
  if (!password) {
    console.error('[router] ROUTER_PASSWORD not set, skipping login');
    return null;
  }

  initVM();

  // Step 1: Fetch CAPTCHA params
  const r1 = await httpReq('GET', '/web/public_data.html?func=get_captcha(intro)');
  const parts = r1.data.toString().split('&');
  if (parts.length < 4) throw new Error(`Bad CAPTCHA response: ${r1.data.toString().substring(0, 200)}`);

  const imgPath = parts[0], lpNum = parts[1], eVal = parts[2], nVal = parts[3];

  // Step 2: Download CAPTCHA image
  const imgRes = await httpReq('GET', '/' + imgPath);
  console.log('[router] CAPTCHA fetched, solving with Claude...');

  // Step 3: Get CAPTCHA candidates
  let candidates = null;

  if (!use2CaptchaOnly) {
    try {
      candidates = await solveCaptcha(imgRes.data);
    } catch (err) {
      console.log(`[router] Claude CAPTCHA failed: ${err.message}`);
    }
  }

  // Fallback to 2Captcha if Claude failed or forced
  if (!candidates || candidates.length === 0) {
    candidates = await solveCaptcha2Captcha(imgRes.data);
    if (!candidates) throw new Error('All CAPTCHA solvers failed');
  }

  // Step 4: Generate variants of ALL candidates
  const variants = generateAllVariants(candidates);
  console.log(`[router] Trying ${variants.length} variants (from ${candidates.length} readings)...`);

  // Step 5: Try each variant
  const captchaImage = imgPath.split('/')[1].split('.')[0];
  const encPwd = passEnc2(password, nVal, eVal);

  for (const variant of variants) {
    const encCap = passEnc2(Buffer.from(variant).toString('base64'), nVal, eVal);
    const formData = `page=web/intro.html&http_passwd=${encodeURIComponent(encPwd)}&captcha=${encodeURIComponent(encCap)}&captcha_image=${encodeURIComponent(captchaImage)}&lp_num=${lpNum}&hidden_action=Login`;

    const loginRes = await httpReq('POST', '/web/intro.html', formData);

    if (loginRes.setCookie) {
      console.log(`[router] Login successful with "${variant}"! Cookie: ${loginRes.setCookie.substring(0, 30)}...`);
      return loginRes.setCookie;
    }
  }

  throw new Error(`All ${variants.length} variants failed`);
}

/**
 * Attempt router login with retries
 */
let loginInProgress = null;

async function loginWithRetry(maxRetries = 5) {
  if (loginInProgress) return loginInProgress;
  loginInProgress = _loginWithRetry(maxRetries).finally(() => { loginInProgress = null; });
  return loginInProgress;
}

async function _loginWithRetry(maxRetries) {
  let consecutiveFails = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // After 2 consecutive Claude failures, try 2Captcha-only if available
      const use2CaptchaOnly = consecutiveFails >= 2 && process.env.CAPTCHA_API_KEY;
      if (use2CaptchaOnly) {
        console.log(`[router] Login attempt ${attempt}/${maxRetries} (2Captcha fallback)...`);
      } else {
        console.log(`[router] Login attempt ${attempt}/${maxRetries}...`);
      }

      const cookie = await login(use2CaptchaOnly);
      if (cookie) {
        currentCookie = cookie;
        lastLoginTime = Date.now();
        return cookie;
      }
    } catch (err) {
      consecutiveFails++;
      console.error(`[router] Login attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  console.error(`[router] All ${maxRetries} login attempts failed`);
  return null;
}

/**
 * Keep-alive: access a page to prevent session timeout
 */
async function keepAlive() {
  if (!currentCookie) return false;

  try {
    const res = await httpReq('GET', '/web/inner_data.html?func=get_basic_info', null, currentCookie);
    const text = res.data.toString();

    if (text.length < 50 || text.includes('captcha') || text.includes('http_passwd') || text.includes('intro.html')) {
      console.log('[router] Session expired, need re-login');
      currentCookie = null;
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[router] Keep-alive error: ${err.message}`);
    return false;
  }
}

async function initRouterSession() {
  console.log('[router] Initializing router session...');
  return await loginWithRetry();
}

async function heartbeatKeepAlive() {
  if (currentCookie) {
    const alive = await keepAlive();
    if (alive) return currentCookie;
    console.log('[router] Session expired during heartbeat, re-logging in...');
  }
  return await loginWithRetry();
}

function getCookie() {
  return currentCookie;
}

module.exports = { initRouterSession, heartbeatKeepAlive, getCookie };
