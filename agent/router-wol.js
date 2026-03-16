/**
 * Router WOL — Auto-login to LG U+ router and maintain session cookie
 *
 * Flow: fetch CAPTCHA → Claude Haiku reads it → RSA-encrypt password + CAPTCHA → login → store cookie
 * The session cookie is reused for router's built-in WOL API (LAN broadcast, works for Sleep/Hibernate)
 */

const vm = require('vm');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const ROUTER_IP = '192.168.219.1';
const ROUTER_URL = `http://${ROUTER_IP}`;
const CAPTCHA_URL = `${ROUTER_URL}/web/public_data.html?func=get_captcha(intro)`;
const LOGIN_URL = `${ROUTER_URL}/web/intro.html`;

const BROWSER_HEADERS = {
  'Host': ROUTER_IP,
  'Origin': ROUTER_URL,
  'Referer': `${ROUTER_URL}/`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Connection': 'keep-alive',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

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
    alert: console.error,
    Math: Math,
    Date: Date,
    Array: Array,
    parseInt: parseInt,
    String: String,
    Uint8Array: Uint8Array,
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
  return vm.runInContext(`
    var rsa = new RSAKey();
    rsa.setPublic("${nVal}", "${eVal}");
    rsa.encrypt("${escaped}") || "";
  `, vmContext);
}

// --- Session state ---

let currentCookie = null;
let lastLoginTime = 0;

// --- CAPTCHA solving via Claude API ---

async function solveCaptcha(imageBuffer) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });
  const base64Image = imageBuffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/gif',
            data: base64Image,
          },
        },
        {
          type: 'text',
          text: 'Read the text in this CAPTCHA image. Reply with ONLY the text, nothing else.',
        },
      ],
    }],
  });

  const text = response.content[0]?.text?.trim();
  if (!text) throw new Error('Claude returned empty CAPTCHA text');
  return text;
}

// --- Router login flow ---

async function fetchCaptcha() {
  const res = await fetch(CAPTCHA_URL, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`CAPTCHA fetch failed: ${res.status}`);

  const text = await res.text();

  // Response format: func=get_captcha(intro)&nVal=...&eVal=...&captcha_image=data:image/gif;base64,...
  const nMatch = text.match(/nVal=([^&]+)/);
  const eMatch = text.match(/eVal=([^&]+)/);
  const imgMatch = text.match(/captcha_image=data:image\/gif;base64,([^\s&]+)/);

  if (!nMatch || !eMatch || !imgMatch) {
    throw new Error(`Failed to parse CAPTCHA response: ${text.substring(0, 200)}`);
  }

  // Extract cookie from response
  const setCookie = res.headers.get('set-cookie');

  return {
    nVal: nMatch[1],
    eVal: eMatch[1],
    imageBase64: imgMatch[1],
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

async function login() {
  const password = process.env.ROUTER_PASSWORD;
  if (!password) {
    console.error('[router] ROUTER_PASSWORD not set, skipping login');
    return null;
  }

  initVM();

  const captchaData = await fetchCaptcha();
  console.log('[router] CAPTCHA fetched, solving with Claude...');

  // Solve CAPTCHA
  const imageBuffer = Buffer.from(captchaData.imageBase64, 'base64');
  const captchaAnswer = await solveCaptcha(imageBuffer);
  console.log(`[router] CAPTCHA answer: "${captchaAnswer}"`);

  // Encrypt password and CAPTCHA answer
  const encryptedPassword = passEnc2(password, captchaData.nVal, captchaData.eVal);
  const encryptedCaptcha = passEnc2(
    Buffer.from(captchaAnswer).toString('base64'),
    captchaData.nVal,
    captchaData.eVal
  );

  // Build login form data
  const formData = new URLSearchParams({
    page: 'intro',
    http_passwd: encryptedPassword,
    captcha: encryptedCaptcha,
    captcha_image: `data:image/gif;base64,${captchaData.imageBase64}`,
    lp_num: '',
    hidden_action: 'Login',
  });

  // Send login request
  const loginHeaders = {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (captchaData.cookie) {
    loginHeaders['Cookie'] = captchaData.cookie;
  }

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: loginHeaders,
    body: formData.toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });

  // Extract session cookie from response
  const setCookieHeader = res.headers.get('set-cookie');
  const responseText = await res.text();

  // Check for login success: redirect (302) or page without login form
  const isSuccess = res.status === 302 ||
    (res.ok && !responseText.includes('captcha') && !responseText.includes('http_passwd'));

  if (setCookieHeader) {
    const sessionCookie = setCookieHeader.split(';')[0];
    if (isSuccess || sessionCookie.includes('=')) {
      console.log(`[router] Login successful (status=${res.status})`);
      return sessionCookie;
    }
  }

  // If we got a cookie from the CAPTCHA step and the login didn't reject
  if (captchaData.cookie && isSuccess) {
    console.log(`[router] Login successful using CAPTCHA cookie (status=${res.status})`);
    return captchaData.cookie;
  }

  throw new Error(`Login failed: status=${res.status}, body=${responseText.substring(0, 300)}`);
}

/**
 * Attempt router login with retries
 * @returns {string|null} Session cookie or null on failure
 */
async function loginWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[router] Login attempt ${attempt}/${maxRetries}...`);
      const cookie = await login();
      if (cookie) {
        currentCookie = cookie;
        lastLoginTime = Date.now();
        return cookie;
      }
    } catch (err) {
      console.error(`[router] Login attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxRetries) {
        // Wait before retry
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
    const res = await fetch(`${ROUTER_URL}/web/inner_data.html?func=get_basic_info`, {
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': currentCookie,
      },
      signal: AbortSignal.timeout(5000),
    });

    const text = await res.text();
    // If response contains login page, session expired
    if (text.includes('captcha') || text.includes('http_passwd') || text.includes('intro')) {
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

/**
 * Called on boot and when session expires
 */
async function initRouterSession() {
  console.log('[router] Initializing router session...');
  return await loginWithRetry();
}

/**
 * Called on each heartbeat — keep-alive or re-login if expired
 * @returns {string|null} Current cookie
 */
async function heartbeatKeepAlive() {
  if (currentCookie) {
    const alive = await keepAlive();
    if (alive) return currentCookie;
    // Session expired, re-login
    console.log('[router] Session expired during heartbeat, re-logging in...');
  }
  return await loginWithRetry();
}

/**
 * Get current session cookie (without network call)
 */
function getCookie() {
  return currentCookie;
}

module.exports = {
  initRouterSession,
  heartbeatKeepAlive,
  getCookie,
};
