/**
 * Router WOL — Auto-login to LG U+ router and maintain session cookie
 *
 * Two-phase CAPTCHA solving:
 *   Phase 1: GPT-4o mini (5x) + CapSolver (parallel) → confidence-scored variants → try login
 *   Phase 2: CapSolver-only fallback (3x new CAPTCHAs) → direct + confusion variants
 *
 * Scoring system:
 *   - Per-position character confidence from weighted readings (CapSolver:5, GPT-top:3, GPT:1)
 *   - Cross-solver variants (GPT×CapSolver character diff combinations)
 *   - Beam search generates top 50 variants sorted by confidence score
 *   - Confusion map for similar-looking character alternatives
 *
 * Adaptive learning (.captcha-learned.json):
 *   - Records GPT↔CapSolver char diffs on EVERY attempt (CapSolver ≈ ground truth)
 *   - Records winning answer diffs on success (gold standard)
 *   - Learned patterns supplement scoring (capped weight, never overrides real readings)
 *
 * The session cookie is reused for router's built-in WOL API (LAN broadcast, works for Sleep/Hibernate)
 */

const http = require('http');
const https = require('https');
const vm = require('vm');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai').default;
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
  let hex = vm.runInContext(`var rsa = new RSAKey(); rsa.setPublic("${nVal}", "${eVal}"); rsa.encrypt("${escaped}") || "";`, vmContext);
  // Pad RSA output to key size — rsa.js only ensures even length, not full modulus length
  while (hex.length < nVal.length) hex = '0' + hex;
  return hex;
}

// --- Session state ---

let currentCookie = null;
let lastLoginTime = 0;

// --- Image preprocessing via sharp (#6: upscale to 400px PNG) ---

async function preprocessImage(imageBuffer) {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const targetWidth = Math.max(400, (meta.width || 200) * 2);

    const processed = await sharp(imageBuffer)
      .resize(targetWidth, null, {
        kernel: sharp.kernel.cubic,
        withoutEnlargement: false,
      })
      .sharpen({ sigma: 1.5 })           // #8: sharpen edges
      .normalise()                         // #9: normalize contrast
      .png()                               // convert GIF→PNG for better GPT vision
      .toBuffer();

    console.log(`[router] Image preprocessed: ${meta.width}x${meta.height} → ${targetWidth}px wide PNG`);
    return processed;
  } catch (err) {
    console.log(`[router] Image preprocess failed (using original): ${err.message}`);
    return imageBuffer;
  }
}

// --- CAPTCHA solving via GPT-4o mini (5x read, detail:high, low temp, expert prompt) ---

// #5: Expert OCR system prompt with confusion guidance
const CAPTCHA_SYSTEM_PROMPT = `You are an expert CAPTCHA OCR reader. You specialize in reading distorted text from CAPTCHA images.

Rules:
- The answer is EXACTLY 6 lowercase letters (a-z only, NO digits, NO uppercase)
- Watch for commonly confused characters: i/j/l, o/a, c/e/s, b/d/h, n/r/m, v/y/u, p/q/g, t/f, w/vv
- Read each character position independently — do not form English words
- Give exactly 3 guesses, one per line, most confident first`;

// #14: Strict user prompt with format enforcement
const CAPTCHA_USER_PROMPT = `Read the distorted text in this CAPTCHA image.
Output exactly 3 guesses, one per line.
Each guess: exactly 6 lowercase letters (a-z only, no digits).
Most confident guess first. Nothing else.`;

// #15: Position-by-position grounding prompt (forces visual analysis per character)
const CAPTCHA_GROUNDING_PROMPT = `Analyze this CAPTCHA image character by character.
The answer is exactly 6 lowercase letters (a-z only, no digits).
For each of the 6 positions, describe what you see visually, then decide the character.
After analysis, output your final answer on the LAST line: exactly 6 lowercase letters.`;

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

// #11: Regex post-processing validation
// CAPTCHA format: exactly 6 lowercase letters (a-z only, no digits).
// Verified across 105+ successful logins — zero exceptions.
// If format changes, update CAPTCHA_LENGTH, CAPTCHA_PATTERN, and solver prompts.
const CAPTCHA_LENGTH = 6;
const CAPTCHA_PATTERN = new RegExp(`^[a-z]{${CAPTCHA_LENGTH}}$`);
const DIGIT_TO_LETTER = { '0': 'o', '1': 'l', '2': 'z', '3': 'a', '4': 'q', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g' };

function cleanCaptchaRead(raw) {
  let s = raw.trim().toLowerCase();
  // Strip leading list numbers like "1.", "2)", "3:" etc.
  s = s.replace(/^\d+[.):\-\s]+/, '');
  // Convert digits to most likely letter equivalents (from win data)
  s = s.replace(/[0-9]/g, d => DIGIT_TO_LETTER[d] || '');
  // Keep only lowercase letters
  return s.replace(/[^a-z]/g, '');
}

// Common garbage fragments from vision models (natural language leaking into CAPTCHA reads)
// Filter natural language fragments that happen to be 6 lowercase letters
const GARBAGE_PATTERNS = /^(letme|sorry|position|thetext|thisis|icanno|cannot|image|captcha|charac|appear|readin|analyz|lookin|hereis|herear|based|second|letter|number|please|answer|should|output|result)/;

function isValidCaptcha(s) {
  if (!CAPTCHA_PATTERN.test(s)) return false;
  if (GARBAGE_PATTERNS.test(s)) return false;
  return true;
}

async function solveCaptchaGPT(imageBuffer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const client = new OpenAI({ apiKey });

  // #6: Preprocess image (upscale + sharpen + PNG)
  const processedImage = await preprocessImage(imageBuffer);
  const base64Image = processedImage.toString('base64');

  // 2 parallel reads: 1x low temp (precision) + 1x higher temp (diversity)
  const readConfigs = [
    { temp: 0.2, topP: 0.3, system: CAPTCHA_SYSTEM_PROMPT, user: CAPTCHA_USER_PROMPT },
    { temp: 0.5, topP: 0.5, system: CAPTCHA_SYSTEM_PROMPT, user: CAPTCHA_USER_PROMPT },
  ];
  const responses = await Promise.all(readConfigs.map(cfg =>
    client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: cfg.maxTokens || 50,
      temperature: cfg.temp,
      top_p: cfg.topP,
      messages: [
        { role: 'system', content: cfg.system },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: 'high',
            }},
            { type: 'text', text: cfg.user },
          ],
        },
      ],
    }).then(r => {
      const text = r.choices[0]?.message?.content || '';
      // For grounding prompt, take only the last line as the answer
      const lines = (cfg.maxTokens > 50 ? text.split('\n').slice(-3) : text.split('\n'))
        .map(l => cleanCaptchaRead(l))
        .filter(l => isValidCaptcha(l));
      return lines;
    }).catch(e => { console.log(`[router] GPT error: ${e.message}`); return []; })
  ));

  // Collect all unique readings
  const allReads = new Set();
  for (const lines of responses) {
    for (const line of lines) allReads.add(line);
  }

  // Add charVote consensus from first choices
  const firstChoices = responses.map(lines => lines[0]).filter(Boolean);
  const voted = charVote(firstChoices);
  if (voted) allReads.add(voted);

  // Add charVote from all choices (second-level consensus)
  const allChoices = responses.flatMap(lines => lines).filter(Boolean);
  const votedAll = charVote(allChoices);
  if (votedAll) allReads.add(votedAll);

  const candidates = [...allReads];
  if (candidates.length === 0) throw new Error('All CAPTCHA reads invalid');

  console.log(`[router] GPT candidates (${candidates.length}): ${candidates.join(', ')}`);
  return candidates;
}

// --- Claude Vision CAPTCHA solver (alternative to GPT) ---

async function solveCaptchaClaude(imageBuffer) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const processedImage = await preprocessImage(imageBuffer);
  const base64Image = processedImage.toString('base64');

  // 3 parallel reads: 2x low temp (precision) + 1x grounding prompt
  const readConfigs = [
    { temp: 0.2, system: CAPTCHA_SYSTEM_PROMPT, user: CAPTCHA_USER_PROMPT },
    { temp: 0.3, system: CAPTCHA_SYSTEM_PROMPT, user: CAPTCHA_USER_PROMPT },
    { temp: 0.2, system: CAPTCHA_SYSTEM_PROMPT, user: CAPTCHA_GROUNDING_PROMPT, maxTokens: 200 },
  ];

  const responses = await Promise.all(readConfigs.map(cfg =>
    client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: cfg.maxTokens || 50,
      temperature: cfg.temp,
      system: cfg.system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image } },
          { type: 'text', text: cfg.user },
        ],
      }],
    }).then(r => {
      const text = r.content[0]?.text || '';
      const lines = (cfg.maxTokens > 50 ? text.split('\n').slice(-3) : text.split('\n'))
        .map(l => cleanCaptchaRead(l))
        .filter(l => isValidCaptcha(l));
      return lines;
    }).catch(e => { console.log(`[router] Claude error: ${e.message}`); return []; })
  ));

  const allReads = new Set();
  for (const lines of responses) {
    for (const line of lines) allReads.add(line);
  }

  const firstChoices = responses.map(lines => lines[0]).filter(Boolean);
  const voted = charVote(firstChoices);
  if (voted) allReads.add(voted);

  const allChoices = responses.flatMap(lines => lines).filter(Boolean);
  const votedAll = charVote(allChoices);
  if (votedAll) allReads.add(votedAll);

  const candidates = [...allReads];
  if (candidates.length === 0) throw new Error('All Claude CAPTCHA reads invalid');

  console.log(`[router] Claude candidates (${candidates.length}): ${candidates.join(', ')}`);
  return candidates;
}

// --- CapSolver API (AI solver, fast + accurate) ---

function httpsPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

async function solveCaptchaCapSolver(imageBuffer) {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) return null;

  const base64 = imageBuffer.toString('base64');
  const result = await httpsPostJson('https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ImageToTextTask',
      body: base64,
    },
  });

  if (!result || result.errorId) {
    console.log(`[router] CapSolver error: ${result?.errorDescription || 'unknown'}`);
    return null;
  }

  const raw = result.solution?.text?.trim()?.toLowerCase();
  if (!raw) {
    console.log('[router] CapSolver returned no text');
    return null;
  }

  // Apply same cleaning as other solvers (digit→letter conversion)
  const answer = cleanCaptchaRead(raw);
  console.log(`[router] CapSolver solved: "${answer}"${raw !== answer ? ` (raw: "${raw}")` : ''}`);
  if (!isValidCaptcha(answer)) {
    console.log(`[router] CapSolver answer invalid after cleaning: "${answer}"`);
    return null;
  }
  return [answer];
}

// --- Confidence-scored variant generation ---

// All answers are lowercase a-z only — no digits in confusion map
const BASE_CONFUSIONS = {
  'i': ['j', 'l', 't'], 'j': ['i', 'l', 'r'],
  'l': ['i', 'j', 't'], 'c': ['s', 'e', 'o', 'a', 'q'],
  's': ['c', 'e', 'z', 'd'], 'b': ['d', 'h', 'u', 'k'],
  'd': ['b', 'a', 'o', 'z', 's'], 'p': ['q', 'g', 'r'],
  'q': ['p', 'g', 'a'], 'n': ['h', 'r', 'm', 'u', 'k'],
  'h': ['n', 'b', 'k', 'l', 'f', 'j'], 'v': ['y', 'u', 'w'],
  'y': ['v', 'u', 'j', 'f'], 'u': ['v', 'n', 'a', 'b'],
  'a': ['o', 'e', 'q', 'u', 'd', 'g', 'n'],
  'o': ['a', 'c', 'e', 'q', 'd'], 'e': ['c', 'a', 'o', 'd'],
  'r': ['n', 't', 'v', 'p'], 't': ['r', 'f', 'l', 'i'],
  'k': ['h', 'x', 'b', 'g'], 'f': ['t', 'r', 'j', 'y'],
  'g': ['q', 'p', 'a', 'u', 'f', 'k'],
  'z': ['s', 'd'], 'w': ['v', 'u'],
  'm': ['n', 'r'], 'x': ['k', 'z', 'v'],
};

// Build CONFUSIONS from BASE + learned wins, then prune low-value mappings.
// Add: winMappings 2+ wins → merge into table
// Prune: gptToCap 5+ observations + 0 wins → remove (noise, not real confusion)
// Only prune after 30+ total attempts (enough data to judge)
function buildConfusions() {
  const merged = {};
  for (const [k, v] of Object.entries(BASE_CONFUSIONS)) {
    merged[k] = [...v];
  }
  try {
    const learnedPath = path.join(__dirname, '.captcha-learned.json');
    if (!fs.existsSync(learnedPath)) return merged;
    const data = JSON.parse(fs.readFileSync(learnedPath, 'utf8'));
    const wins = data.winMappings || {};
    const diffs = data.gptToCap || {};
    const attempts = data.stats?.attempts || 0;

    // Add: high-frequency win mappings
    let added = 0;
    for (const [key, count] of Object.entries(wins)) {
      if (count < 2) continue;
      const [from, to] = key.split('→');
      if (!from || !to || to.length !== 1) continue;
      if (!merged[from]) merged[from] = [];
      if (!merged[from].includes(to)) {
        merged[from].push(to);
        added++;
      }
    }

    // Prune: never-winning mappings (BASE or learned)
    // Keep at least 2 alternatives per character to maintain search diversity
    const MIN_ALTS = 2;
    let pruned = 0;
    if (attempts >= 30) {
      for (const [from, alts] of Object.entries(merged)) {
        if (alts.length <= MIN_ALTS) continue;
        const pruneable = [];
        for (const to of alts) {
          const observed = (diffs[`${from}→${to}`] || 0) + (diffs[`${to}→${from}`] || 0);
          const winCount = (wins[`${from}→${to}`] || 0) + (wins[`${to}→${from}`] || 0);
          // Prune if: (a) 10+ observations but 0 wins, or
          //           (b) 0 observations + 0 wins after 50+ attempts (dead-weight BASE entry)
          if ((observed >= 10 && winCount === 0) ||
              (observed === 0 && winCount === 0 && attempts >= 50)) {
            pruneable.push(to);
          }
        }
        // Only prune down to MIN_ALTS
        const maxPrune = alts.length - MIN_ALTS;
        const toPrune = new Set(pruneable.slice(0, maxPrune));
        if (toPrune.size > 0) {
          merged[from] = alts.filter(to => !toPrune.has(to));
          pruned += toPrune.size;
        }
      }
    }

    if (added > 0 || pruned > 0) {
      console.log(`[router] Confusions: +${added} from wins, -${pruned} pruned (${attempts} attempts)`);
    }
  } catch {}
  return merged;
}

const CONFUSIONS = buildConfusions();

/**
 * Build per-position character confidence from all readings.
 * Each reading contributes weight based on source:
 *   - GPT first choice: 3 points
 *   - GPT other choices: 1 point
 *   - CapSolver: 2 points (generally close to answer)
 *   - Learned mapping bonus: +1 per historical hit
 *   - Confusion map alternatives: 0.3 points
 */
function buildPositionScores(allReadings, learned, weights) {
  // Target length from readings (isValidCaptcha enforces allowed lengths upstream)
  // Currently all readings are 6 chars (enforced by isValidCaptcha /^[a-z]{6}$/)
  // If CAPTCHA format changes, update isValidCaptcha and this adapts automatically
  const lenCounts = {};
  for (const { text, weight, source } of allReadings) {
    if (source === 'cross') continue;
    lenCounts[text.length] = (lenCounts[text.length] || 0) + weight;
  }
  const targetLen = parseInt(Object.entries(lenCounts).sort((a, b) => b[1] - a[1])[0][0]);

  // Build per-position scores
  const positions = [];
  for (let i = 0; i < targetLen; i++) {
    positions.push({});  // char → score
  }

  // Score from readings
  for (const { text, weight } of allReadings) {
    if (text.length !== targetLen) continue;
    for (let i = 0; i < targetLen; i++) {
      positions[i][text[i]] = (positions[i][text[i]] || 0) + weight;
    }
  }

  // Snapshot solver-originated chars BEFORE learned/confusion additions
  // Used to cap injection weight for chars no solver ever read
  const solverChars = [];
  for (let i = 0; i < targetLen; i++) {
    solverChars.push(new Set(Object.keys(positions[i])));
  }

  // Add confusion alternatives with dynamic weight (only for chars already seen by solvers)
  const confW = (weights && weights.confusionBase) || 0.3;
  for (let i = 0; i < targetLen; i++) {
    for (const ch of solverChars[i]) {
      const alts = CONFUSIONS[ch] || [];
      for (const alt of alts) {
        if (alt.length === 1 && !positions[i][alt]) {
          positions[i][alt] = confW;
        }
      }
    }
  }

  // Add learned confusion bonuses: positional data (precise) + global fallback
  // Key anti-pollution: chars not from any solver get hard-capped total weight
  if (learned && weights) {
    // Accumulate learned bonuses into a separate map, then merge with caps
    const learnedBonus = [];
    for (let i = 0; i < targetLen; i++) learnedBonus.push({});

    // Helper: accumulate bonus for position i, char `to`
    const addBonus = (i, to, w) => {
      learnedBonus[i][to] = (learnedBonus[i][to] || 0) + w;
    };

    // Step 1: Positional learned data (higher weight, position-specific)
    // CRITICAL: Only derive bonuses from SOLVER-originated chars to prevent cascade amplification
    // Precompute O(1) lookups from positional data (instead of scanning all entries per char)
    const posApplied = new Set();
    if (learned.posDiffs || learned.posWins) {
      const posDiffLookup = {}; // posDiffLookup[pos:from] = [{to, count}, ...]
      for (const [posKey, count] of Object.entries(learned.posDiffs || {})) {
        const m = posKey.match(/^(\d+):(.+)→(.+)$/);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        if (!posDiffLookup[key]) posDiffLookup[key] = [];
        posDiffLookup[key].push({ to: m[3], count });
      }
      const posWinLookup = {};
      for (const [posKey, count] of Object.entries(learned.posWins || {})) {
        const m = posKey.match(/^(\d+):(.+)→(.+)$/);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        if (!posWinLookup[key]) posWinLookup[key] = [];
        posWinLookup[key].push({ to: m[3], count });
      }

      for (let i = 0; i < targetLen; i++) {
        for (const ch of solverChars[i]) {
          for (const { to, count } of (posDiffLookup[`${i}:${ch}`] || [])) {
            if (count < weights.minObsPos) continue;
            addBonus(i, to, Math.min(count * 0.15, weights.learnedPosGpt));
            posApplied.add(`${i}:${ch}→${to}`);
          }
          for (const { to, count } of (posWinLookup[`${i}:${ch}`] || [])) {
            if (count < weights.minObsWin) continue;
            addBonus(i, to, Math.min(count * 0.25, weights.learnedPosWin));
            posApplied.add(`${i}:${ch}→${to}`);
          }
        }
      }
    }

    // Step 2: Global learned data as fallback (lower weight)
    const learnedLookup = {};
    for (const [key, count] of Object.entries(learned.gptToCap || {})) {
      const parts = key.split('→');
      if (parts.length !== 2) continue;
      const [from, to] = parts;
      if (count >= weights.minObsGptToCap) {
        if (!learnedLookup[from]) learnedLookup[from] = [];
        learnedLookup[from].push({ to, weight: Math.min(count * 0.1, weights.learnedCapGpt) });
      }
    }
    for (const [key, count] of Object.entries(learned.winMappings || {})) {
      const parts = key.split('→');
      if (parts.length !== 2) continue;
      const [from, to] = parts;
      if (count >= weights.minObsWin) {
        if (!learnedLookup[from]) learnedLookup[from] = [];
        learnedLookup[from].push({ to, weight: Math.min(count * 0.2, weights.learnedCapWin) });
      }
    }

    for (let i = 0; i < targetLen; i++) {
      // Only derive bonuses from solver-originated chars (prevent cascade amplification)
      for (const ch of solverChars[i]) {
        const alts = learnedLookup[ch] || [];
        for (const { to, weight } of alts) {
          if (posApplied.has(`${i}:${ch}→${to}`)) continue;
          addBonus(i, to, weight);
        }
      }
    }

    // Step 3: Merge learned bonuses into positions with anti-pollution cap
    // Chars from solvers: add full bonus. Chars NOT from solvers: cap at 15% of top solver score.
    for (let i = 0; i < targetLen; i++) {
      const topSolverScore = Math.max(...Object.values(positions[i]), 1);
      const injectionCap = topSolverScore * 0.15; // max weight for non-solver chars

      for (const [ch, bonus] of Object.entries(learnedBonus[i])) {
        if (solverChars[i].has(ch)) {
          // Solver-originated char: add full bonus
          positions[i][ch] = (positions[i][ch] || 0) + bonus;
        } else {
          // Non-solver char: cap total injection weight
          const existing = positions[i][ch] || 0;
          positions[i][ch] = Math.min(existing + bonus, injectionCap);
        }
      }
    }
  }

  // Compute per-position confidence: ratio of top1 to top2 score
  // High ratio = clear winner, low ratio = ambiguous position
  let confidence = 1.0;
  for (let i = 0; i < targetLen; i++) {
    const sorted = Object.entries(positions[i]).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2 && sorted[0][1] > 0) {
      confidence *= (sorted[0][1] / (sorted[0][1] + sorted[1][1]));
    }
  }
  // Normalize: confidence^(1/len) gives per-position average
  const avgConfidence = Math.pow(confidence, 1 / targetLen);

  return { positions, targetLen, avgConfidence };
}

/**
 * Generate scored variants sorted by confidence (highest first).
 * Uses beam search: at each position, keep top-K candidates.
 */
function generateScoredVariants(allReadings, learned, weights, maxTotal = 30) {
  const { positions, targetLen, avgConfidence } = buildPositionScores(allReadings, learned, weights);

  // Log position analysis + confidence
  console.log(`[router] Confidence: ${(avgConfidence * 100).toFixed(0)}%`);
  for (let i = 0; i < targetLen; i++) {
    const sorted = Object.entries(positions[i]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const display = sorted.map(([ch, sc]) => `${ch}:${sc.toFixed(1)}`).join(' ');
    console.log(`[router]   pos${i}: ${display}`);
  }

  // Beam search: generate top variants
  // Start with top chars at pos 0, expand at each position, keep top maxTotal
  let beam = [];  // [{text, score}]

  // Initialize with top chars at position 0
  const sortedPos0 = Object.entries(positions[0]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [ch, sc] of sortedPos0) {
    beam.push({ text: ch, score: sc });
  }

  // Expand beam through remaining positions
  for (let i = 1; i < targetLen; i++) {
    const sortedChars = Object.entries(positions[i]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const newBeam = [];
    for (const prev of beam) {
      for (const [ch, sc] of sortedChars) {
        newBeam.push({ text: prev.text + ch, score: prev.score + sc });
      }
    }
    // Keep top candidates
    newBeam.sort((a, b) => b.score - a.score);
    beam = newBeam.slice(0, maxTotal * 2);
  }

  // Final sort and deduplicate
  beam.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const result = [];
  for (const item of beam) {
    if (!seen.has(item.text)) {
      seen.add(item.text);
      result.push(item);
      if (result.length >= maxTotal) break;
    }
  }

  // All variants are exactly 6 chars (enforced by isValidCaptcha + targetLen=6)
  result.avgConfidence = avgConfidence;
  return result;
}

// --- Cross-solver variant generation (GPT×CapSolver character diff) ---

function generateCrossSolverVariants(gptCandidates, capAnswer) {
  const crossVariants = new Set();
  if (!capAnswer) return [];

  for (const gpt of gptCandidates) {
    // Allow ±1 length (cross variants excluded from length vote, so safe)
    if (Math.abs(gpt.length - capAnswer.length) > 1) continue;

    const baseLen = Math.min(gpt.length, capAnswer.length);
    const diffPositions = [];

    for (let i = 0; i < baseLen; i++) {
      if (gpt[i] !== capAnswer[i]) {
        diffPositions.push({ pos: i, gptChar: gpt[i], capChar: capAnswer[i] });
      }
    }

    if (diffPositions.length === 0 || diffPositions.length > 4) continue;

    // Generate combinations: for each diff position, try GPT char or CapSolver char
    // This creates 2^N variants for N diff positions (max 16 for 4 diffs)
    const combos = 1 << diffPositions.length;
    for (let mask = 0; mask < combos; mask++) {
      const chars = [...(gpt.length >= capAnswer.length ? gpt : capAnswer)];
      for (let d = 0; d < diffPositions.length; d++) {
        const { pos, gptChar, capChar } = diffPositions[d];
        chars[pos] = (mask & (1 << d)) ? capChar : gptChar;
      }
      crossVariants.add(chars.join(''));
    }
  }

  return [...crossVariants];
}

// --- Adaptive confusion learning ---
// Records GPT↔CapSolver diffs on EVERY attempt (not just successes).
// CapSolver is treated as near-ground-truth (~high accuracy).
// Over time, learns systematic GPT misreadings (e.g. GPT reads 'n' as 'h').

const LEARNED_FILE = path.join(__dirname, '.captcha-learned.json');

function loadLearned() {
  const defaults = {
    gptToCap: {}, winMappings: {},
    posDiffs: {}, posWins: {},  // positional: "0:a→q" format
    stats: { attempts: 0, successes: 0, capHits: 0, capTotal: 0, gptHits: 0, gptTotal: 0, opusHits: 0, opusTotal: 0, capFails: 0 },
  };
  try {
    if (fs.existsSync(LEARNED_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
      const result = {
        gptToCap: data.gptToCap || {},
        winMappings: data.winMappings || {},
        posDiffs: data.posDiffs || {},
        posWins: data.posWins || {},
        stats: { ...defaults.stats, ...(data.stats || {}) },
      };
      const n = Object.keys(result.gptToCap).length;
      const np = Object.keys(result.posDiffs).length;
      const nw = Object.keys(result.posWins).length;
      if (n > 0) console.log(`[router] Loaded ${n} global + ${np} pos-diffs + ${nw} pos-wins patterns`);
      return result;
    }
  } catch (err) {
    console.log(`[router] Failed to load learned data: ${err.message}`);
  }
  return defaults;
}

function saveLearned(learned) {
  try {
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 2));
  } catch (err) {
    console.log(`[router] Failed to save learned data: ${err.message}`);
  }
}

/**
 * Dynamic solver weights based on cumulative accuracy.
 * 3-solver architecture: GPT-4o-mini (2 reads) + Claude Opus (3 reads) + CapSolver (1)
 * ALL weights adapt to observed solver performance — no static values.
 */
function getDynamicWeights(learned) {
  const s = learned.stats;
  // Base weights: Opus starts highest (best observed accuracy), then Cap, then GPT
  let capW = 3, opusTopW = 4, opusW = 2, gptTopW = 2, gptW = 1, crossW = 2, confusionW = 0.3;

  // Bayesian smoothed accuracy: blend prior belief with observed data
  // Prior weight = 10 virtual samples — prevents volatile swings from small samples
  // As real samples grow, prior influence shrinks (e.g., 84 cap samples → prior is ~11% of estimate)
  const PRIOR_WEIGHT = 10;
  const capRate = (0.73 * PRIOR_WEIGHT + (s.capHits || 0)) / (PRIOR_WEIGHT + (s.capTotal || 0));
  const gptRate = (0.45 * PRIOR_WEIGHT + (s.gptHits || 0)) / (PRIOR_WEIGHT + (s.gptTotal || 0));
  const opusRate = (0.80 * PRIOR_WEIGHT + (s.opusHits || 0)) / (PRIOR_WEIGHT + (s.opusTotal || 0));

  if ((s.capTotal || 0) >= 5 || (s.gptTotal || 0) >= 5 || (s.opusTotal || 0) >= 5) {
    // Primary solver weights: 1.5 + 3.5 * accuracy (range: 1.5 ~ 5.0)
    capW = 1.5 + 3.5 * capRate;
    opusTopW = 1.5 + 3.5 * opusRate;
    gptTopW = 1.5 + 3.5 * gptRate;

    // Non-top reads: lower base, same ratio
    opusW = 0.5 + 2.0 * opusRate;
    gptW = 0.5 + 1.5 * gptRate;

    // Cross-solver weight: based on cap+opus avg (primary solvers, GPT too volatile)
    const primaryAvg = (capRate + opusRate) / 2;
    crossW = 1.0 + 2.0 * primaryAvg;

    // Confusion base: decreases as solver accuracy improves
    const avgRate = (capRate + gptRate + opusRate) / 3;
    confusionW = Math.max(0.1, 0.5 - 0.3 * avgRate);

    console.log(`[router] Dynamic weights: cap=${capW.toFixed(1)} (${(capRate*100).toFixed(0)}%), opus=${opusTopW.toFixed(1)} (${(opusRate*100).toFixed(0)}%), gpt=${gptTopW.toFixed(1)} (${(gptRate*100).toFixed(0)}%), cross=${crossW.toFixed(1)}, conf=${confusionW.toFixed(2)}`);
  }

  // Data confidence: log scale — grows gradually, saturates at ~50 wins
  // log2(1+10)/log2(51) ≈ 0.61, log2(1+30)/log2(51) ≈ 0.88, log2(1+50)/log2(51) = 1.0
  const dataConfidence = Math.min(Math.log2(1 + s.successes) / Math.log2(51), 1.0);

  // Global learned data weights
  const learnedCapGpt = 0.5 + 1.5 * dataConfidence;      // 0.5 → 2.0
  const learnedCapWin = 0.5 + 2.5 * dataConfidence;      // 0.5 → 3.0

  // Positional learned data: higher weight (more precise signal)
  const learnedPosGpt = 0.5 + 2.0 * dataConfidence;      // 0.5 → 2.5
  const learnedPosWin = 0.5 + 3.5 * dataConfidence;      // 0.5 → 4.0

  // Min observation thresholds
  const minObsGptToCap = s.attempts >= 20 ? 2 : 3;
  const minObsWin = 1;
  const minObsPos = 1; // positional data is sparse, trust even 1 observation

  return {
    cap: capW, opusTop: opusTopW, opus: opusW, gptTop: gptTopW, gpt: gptW, cross: crossW,
    confusionBase: confusionW,
    learnedCapGpt, learnedCapWin,
    learnedPosGpt, learnedPosWin,
    minObsGptToCap, minObsWin, minObsPos,
  };
}

/**
 * Record vision↔CapSolver character diffs on EVERY attempt.
 * Records diffs from all vision candidates (GPT + Opus) against CapSolver ground truth.
 * gptToCap: "h→n": 5 means a vision solver read 'h' where CapSolver read 'n' five times.
 */
function recordSolverDiffs(visionCandidates, capAnswer, learned) {
  if (!capAnswer || !visionCandidates || visionCandidates.length === 0) return;

  if (!learned.posDiffs) learned.posDiffs = {};

  for (const cand of visionCandidates) {
    if (cand.length !== capAnswer.length) continue;
    for (let i = 0; i < cand.length; i++) {
      if (cand[i] !== capAnswer[i]) {
        // Global
        const key = `${cand[i]}→${capAnswer[i]}`;
        learned.gptToCap[key] = (learned.gptToCap[key] || 0) + 1;
        // Positional
        const posKey = `${i}:${key}`;
        learned.posDiffs[posKey] = (learned.posDiffs[posKey] || 0) + 1;
      }
    }
  }

  learned.stats.attempts++;

  // Prune global: remove noise (count ≤ 1 if >80 entries)
  const keys = Object.keys(learned.gptToCap);
  if (keys.length > 80) {
    for (const k of keys) {
      if (learned.gptToCap[k] <= 1) delete learned.gptToCap[k];
    }
  }
  // Prune positional: remove noise (count ≤ 1 if >500 entries)
  const posKeys = Object.keys(learned.posDiffs);
  if (posKeys.length > 500) {
    for (const k of posKeys) {
      if (learned.posDiffs[k] <= 1) delete learned.posDiffs[k];
    }
  }

  saveLearned(learned);
}

/**
 * Record a successful login: store winning variant mapping + per-solver accuracy.
 * This is the gold standard — we know this answer was correct.
 * @param {string[]} candidates - all candidate texts
 * @param {string} winningVariant - the variant that succeeded
 * @param {object} learned - learned data object
 * @param {object} [solverAnswers] - { cap: string|null, gptTop: string|null } for accuracy tracking
 */
function recordSuccess(candidates, winningVariant, learned, solverAnswers) {
  learned.stats.successes++;
  if (!learned.posWins) learned.posWins = {};

  // Per-solver accuracy: did this solver's direct answer match the winning variant?
  if (solverAnswers) {
    if (solverAnswers.cap !== undefined) {
      learned.stats.capTotal = (learned.stats.capTotal || 0) + 1;
      if (solverAnswers.cap === winningVariant) learned.stats.capHits = (learned.stats.capHits || 0) + 1;
    }
    if (solverAnswers.gptTop !== undefined) {
      learned.stats.gptTotal = (learned.stats.gptTotal || 0) + 1;
      if (solverAnswers.gptTop === winningVariant) learned.stats.gptHits = (learned.stats.gptHits || 0) + 1;
    }
    if (solverAnswers.opusTop !== undefined) {
      learned.stats.opusTotal = (learned.stats.opusTotal || 0) + 1;
      if (solverAnswers.opusTop === winningVariant) learned.stats.opusHits = (learned.stats.opusHits || 0) + 1;
    }
  }

  for (const cand of candidates) {
    if (cand.length !== winningVariant.length) continue;
    for (let i = 0; i < cand.length; i++) {
      if (cand[i] !== winningVariant[i]) {
        // Global (backward compat)
        const key = `${cand[i]}→${winningVariant[i]}`;
        learned.winMappings[key] = (learned.winMappings[key] || 0) + 1;
        // Positional
        const posKey = `${i}:${key}`;
        learned.posWins[posKey] = (learned.posWins[posKey] || 0) + 1;
      }
    }
  }

  saveLearned(learned);
  const { capHits = 0, capTotal = 0, gptHits = 0, gptTotal = 0, opusHits = 0, opusTotal = 0 } = learned.stats;
  console.log(`[router] Recorded win: "${winningVariant}" (overall: ${learned.stats.successes}/${learned.stats.attempts}, cap: ${capHits}/${capTotal}, opus: ${opusHits}/${opusTotal}, gpt: ${gptHits}/${gptTotal})`);
}

// --- Router login flow ---

async function login() {
  const password = process.env.ROUTER_PASSWORD;
  if (!password) {
    console.error('[router] ROUTER_PASSWORD not set, skipping login');
    return null;
  }

  initVM();

  // Step 0: Visit intro page first (initializes CAPTCHA session on router)
  // Track session cookie across requests (browser-like behavior)
  let sessionCookie = '';
  const introRes = await httpReq('GET', '/web/intro.html');
  if (introRes.setCookie) sessionCookie = introRes.setCookie;

  // Step 1: Fetch CAPTCHA params
  const r1 = await httpReq('GET', '/web/public_data.html?func=get_captcha(intro)', null, sessionCookie || undefined);
  if (r1.setCookie) sessionCookie = r1.setCookie;
  const parts = r1.data.toString().split('&');
  if (parts.length < 4) throw new Error(`Bad CAPTCHA response: ${r1.data.toString().substring(0, 200)}`);

  const imgPath = parts[0], lpNum = parts[1], eVal = parts[2], nVal = parts[3];

  // lpNum = successful login counter. Increments +1 per successful login(), NOT per failed attempt.
  // Failed login() and failed POSTs do NOT increment lpNum.
  // Reset mechanism unclear (not time-based within 30min, possibly router reboot).
  // e_val/n_val must be included in POST.
  const lpNumInt = parseInt(lpNum, 10);
  if (lpNumInt >= 30) {
    throw new Error(`lpNum=${lpNum} — too many attempts, stopping`);
  }

  // Step 2: Download CAPTCHA image (with session cookie)
  const imgRes = await httpReq('GET', '/' + imgPath, null, sessionCookie || undefined);
  if (imgRes.setCookie) sessionCookie = imgRes.setCookie;
  console.log('[router] CAPTCHA fetched, solving...');

  // --- Phase 1: GPT + Opus + CapSolver parallel (3-solver architecture) ---
  const processedForCap = await preprocessImage(imgRes.data);
  const [gptResult, opusResult, capResult] = await Promise.all([
    solveCaptchaGPT(imgRes.data).catch(err => {
      console.log(`[router] GPT CAPTCHA failed: ${err.message}`);
      return [];
    }),
    solveCaptchaClaude(imgRes.data).catch(err => {
      console.log(`[router] Opus CAPTCHA failed: ${err.message}`);
      return [];
    }),
    solveCaptchaCapSolver(processedForCap).catch(() => null),
  ]);

  const learned = loadLearned();
  const weights = getDynamicWeights(learned);
  const capAnswer = capResult && capResult.length > 0 ? capResult[0] : null;
  const gptTopAnswer = gptResult && gptResult.length > 0 ? gptResult[0] : null;
  const opusTopAnswer = opusResult && opusResult.length > 0 ? opusResult[0] : null;

  // Track CapSolver failures
  if (!capAnswer) {
    learned.stats.capFails = (learned.stats.capFails || 0) + 1;
    saveLearned(learned);
  }

  // Record vision↔CapSolver diffs on EVERY attempt (학습)
  const allVisionCandidates = [...(gptResult || []), ...(opusResult || [])];
  if (capAnswer && allVisionCandidates.length > 0) {
    recordSolverDiffs(allVisionCandidates, capAnswer, learned);
  }

  // Build weighted readings from all 3 solvers (isValidCaptcha enforces 6 a-z)
  const allReadings = [];

  if (capAnswer) {
    allReadings.push({ text: capAnswer, weight: weights.cap, source: 'capsolver' });
  }

  // Opus readings (highest weight)
  if (opusResult && opusResult.length > 0) {
    allReadings.push({ text: opusResult[0], weight: weights.opusTop, source: 'opus-top' });
    for (let i = 1; i < opusResult.length; i++) {
      allReadings.push({ text: opusResult[i], weight: weights.opus, source: 'opus' });
    }
  }

  // GPT readings (lower weight)
  if (gptResult && gptResult.length > 0) {
    allReadings.push({ text: gptResult[0], weight: weights.gptTop, source: 'gpt-top' });
    for (let i = 1; i < gptResult.length; i++) {
      allReadings.push({ text: gptResult[i], weight: weights.gpt, source: 'gpt' });
    }
  }

  // Cross-solver variants (from all vision candidates against CapSolver)
  if (capAnswer && allVisionCandidates.length > 0) {
    const crossVariants = generateCrossSolverVariants(allVisionCandidates, capAnswer);
    for (const cv of crossVariants) {
      allReadings.push({ text: cv, weight: weights.cross, source: 'cross' });
    }
    if (crossVariants.length > 0) console.log(`[router] Cross-solver variants: ${crossVariants.length}`);
  }

  if (allReadings.length === 0) throw new Error('All CAPTCHA solvers failed');

  // Generate scored variants and try login
  const scoredVariants = generateScoredVariants(allReadings, learned, weights);
  const conf = scoredVariants.avgConfidence || 0;
  console.log(`[router] Phase 1: ${scoredVariants.length} variants (top: "${scoredVariants[0]?.text}" s=${scoredVariants[0]?.score.toFixed(1)}, conf=${(conf*100).toFixed(0)}%)`);

  const captchaImage = imgPath.split('/')[1].split('.')[0];
  const encPwd = passEnc2(password, nVal, eVal);
  console.log(`[router] Phase 1 login: lpNum=${lpNum}`);
  const candidateTexts = allReadings.map(r => r.text);
  const solverAnswers = { cap: capAnswer, gptTop: gptTopAnswer, opusTop: opusTopAnswer };

  // CAPTCHA is single-use: invalidated after first wrong answer.
  // Only the top-scored variant matters — retrying on same CAPTCHA is useless.
  if (manualCaptchaMode) return null;
  const bestVariant = scoredVariants[0];
  const encCap = passEnc2(Buffer.from(bestVariant.text).toString('base64'), nVal, eVal);
  const formData = `page=web/intro.html&http_passwd=${encodeURIComponent(encPwd)}&captcha=${encodeURIComponent(encCap)}&captcha_image=${encodeURIComponent(captchaImage)}&e_val=${encodeURIComponent(eVal)}&n_val=${encodeURIComponent(nVal)}&lp_num=${lpNum}&hidden_action=Login`;

  const loginRes = await httpReq('POST', '/web/intro.html', formData, sessionCookie || undefined);

  if (loginRes.setCookie) {
    console.log(`[router] Login success with "${bestVariant.text}" (s=${bestVariant.score.toFixed(1)})!`);
    recordSuccess(candidateTexts, bestVariant.text, learned, solverAnswers);
    return loginRes.setCookie;
  }

  throw new Error(`Login failed with "${bestVariant.text}" — CAPTCHA single-use, need fresh one`);
}

/**
 * Attempt router login with retries
 */
let loginInProgress = null;
let manualCaptchaMode = false;

function setManualCaptchaMode(on) {
  manualCaptchaMode = on;
  if (on) console.log('[router] Manual CAPTCHA mode ON — auto-login paused');
  else console.log('[router] Manual CAPTCHA mode OFF — auto-login resumed');
}

async function loginWithRetry(maxRetries = 10, onProgress = null) {
  if (loginInProgress) return loginInProgress;
  loginInProgress = _loginWithRetry(maxRetries, onProgress).finally(() => { loginInProgress = null; });
  return loginInProgress;
}

async function _loginWithRetry(maxRetries, onProgress) {
  let consecutiveFails = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Abort auto-login if user is solving manually
    if (manualCaptchaMode) {
      console.log(`[router] Auto-login aborted (manual CAPTCHA mode)`);
      if (onProgress) onProgress('');
      return null;
    }
    try {
      console.log(`[router] Login attempt ${attempt}/${maxRetries}...`);
      if (onProgress) onProgress(`Solving CAPTCHA (${attempt}/${maxRetries})`);

      const cookie = await login();
      if (cookie) {
        currentCookie = cookie;
        lastLoginTime = Date.now();
        if (onProgress) onProgress('CAPTCHA solved!');
        return cookie;
      }
    } catch (err) {
      consecutiveFails++;
      console.error(`[router] Login attempt ${attempt} failed: ${err.message}`);
      // If lpNum too high, stop immediately and suggest manual solving
      if (err.message.includes('lpNum=')) {
        if (onProgress) onProgress('CAPTCHA failed — solve manually');
        return null;
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  console.error(`[router] All ${maxRetries} login attempts failed`);
  if (onProgress) onProgress('CAPTCHA failed — solve manually');
  return null;
}

/**
 * Keep-alive: access main.html to check session and prevent timeout.
 * inner_data.html returns empty on port 80 — use main.html instead.
 * Logged in: len > 1000 (full page). Not logged in: len ≈ 733 (intro redirect).
 */
async function keepAlive() {
  if (!currentCookie) return false;

  try {
    const res = await httpReq('GET', '/web/main.html', null, currentCookie);
    const text = res.data.toString();

    if (text.length < 1000 || text.includes('intro.html')) {
      console.log(`[router] Session expired, need re-login (len=${text.length})`);
      currentCookie = null;
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[router] Keep-alive error: ${err.message}`);
    return false;
  }
}

async function initRouterSession(storedCookie, onProgress = null) {
  console.log('[router] Initializing router session...');

  // Try stored cookie from KV first (avoids CAPTCHA)
  if (storedCookie) {
    currentCookie = storedCookie;
    const alive = await keepAlive();
    if (alive) {
      console.log('[router] Restored session from KV cookie — CAPTCHA skipped');
      lastLoginTime = Date.now();
      return currentCookie;
    }
    console.log('[router] KV cookie expired, falling back to CAPTCHA login...');
    currentCookie = null;
  }

  return await loginWithRetry(10, onProgress);
}

let heartbeatLoginFailed = false;

async function heartbeatKeepAlive(onProgress = null) {
  if (manualCaptchaMode) return null; // Don't touch router while user solving
  if (currentCookie) {
    heartbeatLoginFailed = false;
    const alive = await keepAlive();
    if (alive) return currentCookie;
    console.log('[router] Session expired during heartbeat, re-logging in...');
    heartbeatLoginFailed = false; // allow retry on expiry
  }
  // If login is already in progress, don't block heartbeat — return null
  if (loginInProgress) {
    return null;
  }
  // Don't retry if previous background login already failed
  if (heartbeatLoginFailed) {
    return null;
  }
  // No cookie and no login in progress — start login but don't block heartbeat
  loginWithRetry(10, onProgress).then(cookie => {
    if (!cookie) heartbeatLoginFailed = true;
    else if (onProgress) onProgress('');
  }).catch(err => {
    heartbeatLoginFailed = true;
    console.error('[router] Background login failed:', err.message);
  });
  return null;
}

function getCookie() {
  return currentCookie;
}

/**
 * Refresh router cookie right before sleep/hibernate.
 * If current session is alive, just return it (no CAPTCHA needed).
 * Only re-login if session expired.
 */
async function refreshBeforeSleep(onProgress = null) {
  if (currentCookie) {
    const alive = await keepAlive();
    if (alive) {
      console.log('[router] Pre-sleep: session alive — reusing current cookie');
      if (onProgress) onProgress('CAPTCHA 성공');
      return currentCookie;
    }
    console.log('[router] Pre-sleep: session expired — re-logging in...');
  }
  return await loginWithRetry(10, onProgress);
}

// Cache solver candidates for manual CAPTCHA learning
let manualCaptchaCandidates = { gptCandidates: [], capAnswer: null, solverAnswers: { cap: null, gptTop: null } };

/**
 * Fetch a fresh CAPTCHA image for manual solving.
 * Also runs GPT/CapSolver in background to collect candidates for learning.
 * Returns { imageBase64, params } or null on error.
 */
async function fetchManualCaptcha() {
  try {
    setManualCaptchaMode(true);
    // Wait for any in-progress auto-login to fully abort before touching router
    if (loginInProgress) {
      console.log('[manual-captcha] Waiting for auto-login to abort...');
      await loginInProgress.catch(() => {});
      console.log('[manual-captcha] Auto-login finished, proceeding with manual fetch');
    }
    // Reset router login state by visiting login page (resets lpNum counter)
    console.log('[manual-captcha] Resetting router login page...');
    await httpReq('GET', '/web/intro.html');
    const r1 = await httpReq('GET', '/web/public_data.html?func=get_captcha(intro)');
    const parts = r1.data.toString().split('&');
    if (parts.length < 4) return null;

    const [imgPath, lpNum, eVal, nVal] = parts;
    console.log(`[manual-captcha] Fetched: lpNum=${lpNum}`);
    const imgRes = await httpReq('GET', '/' + imgPath);
    const captchaImage = imgPath.split('/')[1].split('.')[0];

    // Run all 3 solvers in background for learning (don't block manual flow)
    manualCaptchaCandidates = { gptCandidates: [], capAnswer: null, solverAnswers: { cap: null, gptTop: null, opusTop: null } };
    Promise.allSettled([
      solveCaptchaGPT(imgRes.data).then(r => {
        if (r && r.length > 0) {
          manualCaptchaCandidates.gptCandidates.push(...r);
          manualCaptchaCandidates.solverAnswers.gptTop = r[0];
        }
      }),
      solveCaptchaClaude(imgRes.data).then(r => {
        if (r && r.length > 0) {
          manualCaptchaCandidates.gptCandidates.push(...r);
          manualCaptchaCandidates.solverAnswers.opusTop = r[0];
        }
      }),
      solveCaptchaCapSolver(imgRes.data).then(r => {
        if (r && r.length > 0) {
          manualCaptchaCandidates.capAnswer = r[0];
          manualCaptchaCandidates.solverAnswers.cap = r[0];
        }
      }),
    ]).then(() => {
      console.log(`[manual-captcha] Solver hints: Opus=${manualCaptchaCandidates.solverAnswers.opusTop || 'none'}, GPT=${manualCaptchaCandidates.solverAnswers.gptTop || 'none'}, Cap=${manualCaptchaCandidates.capAnswer || 'none'}`);
    });

    return {
      imageBase64: imgRes.data.toString('base64'),
      params: { nVal, eVal, lpNum, captchaImage },
    };
  } catch (err) {
    console.error('[router] Failed to fetch manual CAPTCHA:', err.message);
    return null;
  }
}

/**
 * Attempt login with user-provided CAPTCHA answer.
 * @param {string} answer - user's CAPTCHA text
 * @param {object} params - { nVal, eVal, lpNum, captchaImage }
 */
async function submitManualCaptcha(answer, params) {
  try {
    const password = process.env.ROUTER_PASSWORD;
    if (!password) throw new Error('ROUTER_PASSWORD not set');
    initVM();
    const { nVal, eVal, lpNum, captchaImage } = params;
    console.log(`[manual-captcha] Submit: answer="${answer}", lpNum=${lpNum}`);
    // If already logged in, return existing cookie as success
    if (currentCookie) {
      const alive = await keepAlive();
      if (alive) {
        console.log(`[manual-captcha] Already logged in — returning existing cookie`);
        setManualCaptchaMode(false);
        return currentCookie;
      }
      // Cookie expired, proceed with login
      currentCookie = null;
    }
    const encPwd = passEnc2(password, nVal, eVal);
    const encCap = passEnc2(Buffer.from(answer).toString('base64'), nVal, eVal);
    const formData = `page=web/intro.html&http_passwd=${encodeURIComponent(encPwd)}&captcha=${encodeURIComponent(encCap)}&captcha_image=${encodeURIComponent(captchaImage)}&e_val=${encodeURIComponent(eVal)}&n_val=${encodeURIComponent(nVal)}&lp_num=${lpNum}&hidden_action=Login`;

    const loginRes = await httpReq('POST', '/web/intro.html', formData);
    const bodyStr = loginRes.data?.toString() || '';
    const alertMatch = bodyStr.match(/alert\(['"](.*?)['"]\)/);
    console.log(`[manual-captcha] Response: cookie=${!!loginRes.setCookie}, lpNum=${lpNum}${alertMatch ? ', alert=' + alertMatch[1] : ''}`);

    if (loginRes.setCookie) {
      currentCookie = loginRes.setCookie;
      lastLoginTime = Date.now();
      heartbeatLoginFailed = false;
      setManualCaptchaMode(false);
      console.log(`[manual-captcha] SUCCESS — user="${answer}", GPT=${manualCaptchaCandidates.gptCandidates.join(',') || 'none'}, Cap=${manualCaptchaCandidates.capAnswer || 'none'}`);

      // Record to learning system
      const learned = loadLearned();
      const { gptCandidates, capAnswer, solverAnswers } = manualCaptchaCandidates;
      const allCandidates = [...gptCandidates];
      if (capAnswer) allCandidates.push(capAnswer);
      if (allCandidates.length > 0) {
        recordSolverDiffs(gptCandidates, capAnswer, learned);
        recordSuccess(allCandidates, answer, learned, solverAnswers);
      } else {
        learned.stats.successes++;
        learned.stats.attempts++;
        saveLearned(learned);
      }

      return currentCookie;
    }
    console.log(`[manual-captcha] FAILED — user="${answer}", GPT=${manualCaptchaCandidates.gptCandidates.join(',') || 'none'}, Cap=${manualCaptchaCandidates.capAnswer || 'none'}`);
    return null;
  } catch (err) {
    console.error('[manual-captcha] ERROR:', err.message);
    return null;
  }
}

module.exports = { initRouterSession, heartbeatKeepAlive, getCookie, refreshBeforeSleep, fetchManualCaptcha, submitManualCaptcha, setManualCaptchaMode, login, _resetCookie: () => { currentCookie = null; }, _initVM: initVM, _passEnc2: passEnc2 };
