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
  return vm.runInContext(`var rsa = new RSAKey(); rsa.setPublic("${nVal}", "${eVal}"); rsa.encrypt("${escaped}") || "";`, vmContext);
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
- Output ONLY lowercase letters (a-z) and digits (0-9)
- CAPTCHAs are typically 4-7 characters long
- Watch for commonly confused characters: i/j/l/1, o/0/a, c/e/s, b/d/h, n/r/m, v/y/u, p/q/g, t/f/7, z/2, w/vv
- Read each character position independently — do not form English words
- Give exactly 3 guesses, one per line, most confident first`;

// #14: Strict user prompt with format enforcement
const CAPTCHA_USER_PROMPT = `Read the distorted text in this CAPTCHA image.
Output exactly 3 guesses, one per line.
Each guess: lowercase letters and digits only, 4-7 characters.
Most confident guess first. Nothing else.`;

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
function cleanCaptchaRead(raw) {
  let s = raw.trim().toLowerCase();
  // Strip leading list numbers like "1.", "2)", "3:" etc.
  s = s.replace(/^\d+[.):\-\s]+/, '');
  return s.replace(/[^a-z0-9]/g, '');
}

function isValidCaptcha(s) {
  return /^[a-z0-9]{4,8}$/.test(s);
}

async function solveCaptchaGPT(imageBuffer) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const client = new OpenAI({ apiKey });

  // #6: Preprocess image (upscale + sharpen + PNG)
  const processedImage = await preprocessImage(imageBuffer);
  const base64Image = processedImage.toString('base64');

  // #1-5: 5x parallel reads with GPT-4o mini (detail:high, low temp, expert prompt)
  const NUM_READS = 5;
  const responses = await Promise.all(Array.from({ length: NUM_READS }, () =>
    client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      temperature: 0.3,           // #2: low temp for OCR but enough diversity across 5 reads
      top_p: 0.3,                 // #3: restrict to likely tokens
      messages: [
        { role: 'system', content: CAPTCHA_SYSTEM_PROMPT },  // #5: expert prompt
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: 'high',      // #1: high detail for better resolution
            }},
            { type: 'text', text: CAPTCHA_USER_PROMPT },     // #14: strict format
          ],
        },
      ],
    }).then(r => {
      const lines = (r.choices[0]?.message?.content || '').split('\n')
        .map(l => cleanCaptchaRead(l))       // #11: regex post-processing
        .filter(l => isValidCaptcha(l));      // #11: validation
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

  const answer = result.solution?.text?.trim()?.toLowerCase();
  if (!answer) {
    console.log('[router] CapSolver returned no text');
    return null;
  }

  console.log(`[router] CapSolver solved: "${answer}"`);
  return [answer];
}

// --- Confidence-scored variant generation ---

const CONFUSIONS = {
  'i': ['j', 'l', '1', 't'], 'j': ['i', 'l', '1'],
  'l': ['i', 'j', '1', 't'], '1': ['i', 'l', 'j', '7'],
  'c': ['s', 'e', 'o', 'a'], 's': ['c', 'e', '5', 'z'],
  'b': ['d', 'h', '6', '8'], 'd': ['b', 'a', 'o'],
  'p': ['q', 'g', '9'], 'q': ['p', 'g', 'a', '9'],
  'n': ['h', 'r', 'm', 'u'], 'h': ['n', 'b', 'k'],
  'v': ['y', 'u', 'w'], 'y': ['v', 'u', 'j'],
  'u': ['v', 'n', 'a'], 'a': ['o', 'e', 'q', 'u', 'd'],
  'o': ['a', 'c', '0', 'e', 'q'], 'e': ['c', 'a', 'o', '3'],
  'r': ['n', 't', 'v'], 't': ['r', 'f', '7', 'l', 'i'],
  'k': ['h', 'x'], 'f': ['t', 'r', '7'],
  'g': ['q', 'p', '9', 'a'],
  '0': ['o', 'a', 'c'], '2': ['z', 'a'],
  '3': ['e', '8'], '4': ['a'],
  '5': ['s', 'c', '6'], '6': ['b', 'g', '5'],
  '7': ['t', 'f', '1'], '8': ['b', '3', '6'],
  '9': ['g', 'q', 'p', 'a'],
  'z': ['2', 's'], 'w': ['v'],
  'm': ['n'], 'x': ['k', 'z'],
};

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
  // Determine target length (weighted majority vote — higher-weight sources have more say)
  const lenCounts = {};
  for (const { text, weight } of allReadings) {
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

  // Add confusion alternatives with small weight
  for (let i = 0; i < targetLen; i++) {
    const existingChars = Object.keys(positions[i]);
    for (const ch of existingChars) {
      const alts = CONFUSIONS[ch] || [];
      for (const alt of alts) {
        if (alt.length === 1 && !positions[i][alt]) {
          positions[i][alt] = 0.3;
        }
      }
    }
  }

  // Add learned confusion bonuses (dynamic caps based on data confidence)
  if (learned && weights) {
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
    // Win mappings: higher weight, verified corrections
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
      const existingChars = Object.keys(positions[i]);
      for (const ch of existingChars) {
        const alts = learnedLookup[ch] || [];
        for (const { to, weight } of alts) {
          positions[i][to] = (positions[i][to] || 0) + weight;
        }
      }
    }
  }

  // Also compute scores for ±1 length as secondary
  const altLens = Object.entries(lenCounts)
    .sort((a, b) => b[1] - a[1])
    .filter(([len]) => parseInt(len) !== targetLen)
    .map(([len]) => parseInt(len))
    .slice(0, 2);

  return { positions, targetLen, altLens };
}

/**
 * Generate scored variants sorted by confidence (highest first).
 * Uses beam search: at each position, keep top-K candidates.
 */
function generateScoredVariants(allReadings, learned, weights, maxTotal = 30) {
  const { positions, targetLen, altLens } = buildPositionScores(allReadings, learned, weights);

  // Log position analysis
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

  // Add raw readings that didn't match targetLen (high confidence originals)
  for (const { text, weight } of allReadings) {
    if (text.length !== targetLen && !seen.has(text) && isValidCaptcha(text)) {
      seen.add(text);
      result.push({ text, score: weight * 2 }); // raw readings get decent score
    }
  }

  // Add length variants (±1) of top candidates
  for (const item of result.slice(0, 5)) {
    if (item.text.length > 4) {
      const trimLast = item.text.substring(0, item.text.length - 1);
      const trimFirst = item.text.substring(1);
      if (!seen.has(trimLast)) { seen.add(trimLast); result.push({ text: trimLast, score: item.score * 0.5 }); }
      if (!seen.has(trimFirst)) { seen.add(trimFirst); result.push({ text: trimFirst, score: item.score * 0.5 }); }
    }
  }

  return result;
}

// --- Cross-solver variant generation (GPT×CapSolver character diff) ---

function generateCrossSolverVariants(gptCandidates, capAnswer) {
  const crossVariants = new Set();
  if (!capAnswer) return [];

  for (const gpt of gptCandidates) {
    // Only compare same-length reads (or ±1)
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
    stats: { attempts: 0, successes: 0, capHits: 0, capTotal: 0, gptHits: 0, gptTotal: 0 },
  };
  try {
    if (fs.existsSync(LEARNED_FILE)) {
      const data = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
      const result = {
        gptToCap: data.gptToCap || {},
        winMappings: data.winMappings || {},
        stats: { ...defaults.stats, ...(data.stats || {}) },
      };
      const n = Object.keys(result.gptToCap).length;
      if (n > 0) console.log(`[router] Loaded ${n} GPT→CapSolver confusion patterns`);
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
 * Starts with equal base weights, then adjusts as accuracy data accumulates.
 * Returns { cap, gptTop, gpt, cross, confusionBase, learnedCapGpt, learnedCapWin }
 */
function getDynamicWeights(learned) {
  const s = learned.stats;
  const MIN_SAMPLES = 5; // need at least 5 data points before adjusting

  // Base weights (used when insufficient data)
  const BASE_CAP = 3, BASE_GPT_TOP = 3, BASE_GPT = 1, BASE_CROSS = 2;

  let capW = BASE_CAP, gptTopW = BASE_GPT_TOP;

  if (s.capTotal >= MIN_SAMPLES && s.gptTotal >= MIN_SAMPLES) {
    const capRate = s.capHits / s.capTotal;   // 0~1
    const gptRate = s.gptHits / s.gptTotal;   // 0~1

    // Scale weights: 1.5 + 3.5 * accuracy  (range: 1.5 ~ 5.0)
    capW = 1.5 + 3.5 * capRate;
    gptTopW = 1.5 + 3.5 * gptRate;

    console.log(`[router] Dynamic weights: cap=${capW.toFixed(1)} (${(capRate*100).toFixed(0)}% of ${s.capTotal}), gptTop=${gptTopW.toFixed(1)} (${(gptRate*100).toFixed(0)}% of ${s.gptTotal})`);
  }

  // Learned bonus caps scale with data confidence
  // More successes → trust learned data more (cap: 0.5~2.0 for gptToCap, 0.5~3.0 for winMappings)
  const dataConfidence = Math.min(s.successes / 10, 1.0); // 0~1, saturates at 10 wins
  const learnedCapGpt = 0.5 + 1.5 * dataConfidence;      // 0.5 → 2.0
  const learnedCapWin = 0.5 + 2.5 * dataConfidence;      // 0.5 → 3.0

  // Min observation threshold scales inversely with total attempts (more data → trust smaller counts)
  const minObsGptToCap = s.attempts >= 20 ? 2 : 3;
  const minObsWin = 1; // win data is always high-value

  return {
    cap: capW, gptTop: gptTopW, gpt: BASE_GPT, cross: BASE_CROSS,
    confusionBase: 0.3,
    learnedCapGpt, learnedCapWin,
    minObsGptToCap, minObsWin,
  };
}

/**
 * Record GPT↔CapSolver character diffs on EVERY attempt.
 * Even without a winning answer, CapSolver's reading is valuable.
 * gptToCap: "h→n": 5 means GPT read 'h' where CapSolver read 'n' five times.
 */
function recordSolverDiffs(gptCandidates, capAnswer, learned) {
  if (!capAnswer || !gptCandidates || gptCandidates.length === 0) return;

  for (const gpt of gptCandidates) {
    if (gpt.length !== capAnswer.length) continue;
    for (let i = 0; i < gpt.length; i++) {
      if (gpt[i] !== capAnswer[i]) {
        const key = `${gpt[i]}→${capAnswer[i]}`;
        learned.gptToCap[key] = (learned.gptToCap[key] || 0) + 1;
      }
    }
  }

  learned.stats.attempts++;

  // Prune: keep top 100 mappings by count, remove noise (count ≤ 1 if >80 entries)
  const keys = Object.keys(learned.gptToCap);
  if (keys.length > 80) {
    for (const k of keys) {
      if (learned.gptToCap[k] <= 1) delete learned.gptToCap[k];
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
  }

  for (const cand of candidates) {
    if (cand.length !== winningVariant.length) continue;
    for (let i = 0; i < cand.length; i++) {
      if (cand[i] !== winningVariant[i]) {
        const key = `${cand[i]}→${winningVariant[i]}`;
        learned.winMappings[key] = (learned.winMappings[key] || 0) + 1;
      }
    }
  }

  saveLearned(learned);
  const { capHits = 0, capTotal = 0, gptHits = 0, gptTotal = 0 } = learned.stats;
  console.log(`[router] Recorded win: "${winningVariant}" (overall: ${learned.stats.successes}/${learned.stats.attempts}, cap: ${capHits}/${capTotal}, gpt: ${gptHits}/${gptTotal})`);
}

// --- Router login flow ---

async function login() {
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
  console.log('[router] CAPTCHA fetched, solving...');

  // --- Phase 1: GPT + CapSolver parallel (학습 + 1차 시도) ---
  // Send preprocessed image to CapSolver too (better accuracy)
  const processedForCap = await preprocessImage(imgRes.data);
  const [gptResult, capResult] = await Promise.all([
    solveCaptchaGPT(imgRes.data).catch(err => {   // GPT preprocesses internally
      console.log(`[router] GPT CAPTCHA failed: ${err.message}`);
      return [];
    }),
    solveCaptchaCapSolver(processedForCap).catch(() => null),
  ]);

  const learned = loadLearned();
  const weights = getDynamicWeights(learned);
  const capAnswer = capResult && capResult.length > 0 ? capResult[0] : null;
  const gptTopAnswer = gptResult && gptResult.length > 0 ? gptResult[0] : null;

  // Record GPT↔CapSolver diffs on EVERY attempt (학습 — winning 불필요)
  if (capAnswer && gptResult && gptResult.length > 0) {
    recordSolverDiffs(gptResult, capAnswer, learned);
  }

  // Build weighted readings (dynamic weights from accuracy history)
  const allReadings = [];

  if (capAnswer) {
    allReadings.push({ text: capAnswer, weight: weights.cap, source: 'capsolver' });
  }

  if (gptResult && gptResult.length > 0) {
    allReadings.push({ text: gptResult[0], weight: weights.gptTop, source: 'gpt-top' });
    for (let i = 1; i < gptResult.length; i++) {
      allReadings.push({ text: gptResult[i], weight: weights.gpt, source: 'gpt' });
    }
  }

  // Cross-solver variants
  if (capAnswer && gptResult && gptResult.length > 0) {
    const crossVariants = generateCrossSolverVariants(gptResult, capAnswer);
    for (const cv of crossVariants) {
      allReadings.push({ text: cv, weight: weights.cross, source: 'cross' });
    }
    if (crossVariants.length > 0) console.log(`[router] Cross-solver variants: ${crossVariants.length}`);
  }

  if (allReadings.length === 0) throw new Error('All CAPTCHA solvers failed');

  // Generate scored variants and try login
  const scoredVariants = generateScoredVariants(allReadings, learned, weights);
  console.log(`[router] Phase 1: ${scoredVariants.length} scored variants (top: "${scoredVariants[0]?.text}" s=${scoredVariants[0]?.score.toFixed(1)})`);

  const captchaImage = imgPath.split('/')[1].split('.')[0];
  const encPwd = passEnc2(password, nVal, eVal);
  const candidateTexts = allReadings.map(r => r.text);
  const solverAnswers = { cap: capAnswer, gptTop: gptTopAnswer };

  for (const { text: variant, score } of scoredVariants) {
    const encCap = passEnc2(Buffer.from(variant).toString('base64'), nVal, eVal);
    const formData = `page=web/intro.html&http_passwd=${encodeURIComponent(encPwd)}&captcha=${encodeURIComponent(encCap)}&captcha_image=${encodeURIComponent(captchaImage)}&lp_num=${lpNum}&hidden_action=Login`;

    const loginRes = await httpReq('POST', '/web/intro.html', formData);

    if (loginRes.setCookie) {
      console.log(`[router] Phase 1 success with "${variant}" (s=${score.toFixed(1)})!`);
      recordSuccess(candidateTexts, variant, learned, solverAnswers);
      return loginRes.setCookie;
    }
  }

  // --- Phase 2: CapSolver-only fallback (실질적 해결 — 새 CAPTCHA 3회) ---
  console.log('[router] Phase 1 failed, trying CapSolver-only fallback (3 attempts)...');

  for (let fb = 1; fb <= 3; fb++) {
    try {
      // Fetch fresh CAPTCHA for each fallback attempt
      const fbR1 = await httpReq('GET', '/web/public_data.html?func=get_captcha(intro)');
      const fbParts = fbR1.data.toString().split('&');
      if (fbParts.length < 4) continue;

      const fbImgPath = fbParts[0], fbLpNum = fbParts[1], fbEVal = fbParts[2], fbNVal = fbParts[3];
      const fbImgRes = await httpReq('GET', '/' + fbImgPath);

      // CapSolver with preprocessed image (better accuracy)
      const fbProcessed = await preprocessImage(fbImgRes.data);
      const fbCap = await solveCaptchaCapSolver(fbProcessed).catch(() => null);
      if (!fbCap || fbCap.length === 0) continue;

      const fbAnswer = fbCap[0];
      const fbCaptchaImage = fbImgPath.split('/')[1].split('.')[0];
      const fbEncPwd = passEnc2(password, fbNVal, fbEVal);

      // Try CapSolver answer directly + confusion variants from learned data
      const fbVariants = [fbAnswer];

      // Add learned confusion variants anchored on CapSolver answer
      for (let i = 0; i < fbAnswer.length; i++) {
        const ch = fbAnswer[i];
        const alts = CONFUSIONS[ch] || [];
        for (const alt of alts) {
          if (alt.length === 1) {
            fbVariants.push(fbAnswer.substring(0, i) + alt + fbAnswer.substring(i + 1));
          }
        }
      }

      console.log(`[router] Fallback ${fb}/3: CapSolver="${fbAnswer}" + ${fbVariants.length - 1} variants`);

      for (const variant of fbVariants.slice(0, 25)) {
        const encCap = passEnc2(Buffer.from(variant).toString('base64'), fbNVal, fbEVal);
        const formData = `page=web/intro.html&http_passwd=${encodeURIComponent(fbEncPwd)}&captcha=${encodeURIComponent(encCap)}&captcha_image=${encodeURIComponent(fbCaptchaImage)}&lp_num=${fbLpNum}&hidden_action=Login`;

        const loginRes = await httpReq('POST', '/web/intro.html', formData);

        if (loginRes.setCookie) {
          console.log(`[router] Fallback success with "${variant}"!`);
          // Learn: CapSolver was close, record the diff if variant ≠ original
          if (variant !== fbAnswer) {
            recordSuccess([fbAnswer], variant, learned, { cap: fbAnswer });
          } else {
            recordSuccess([], variant, learned, { cap: fbAnswer });
          }
          return loginRes.setCookie;
        }
      }
    } catch (err) {
      console.log(`[router] Fallback ${fb} error: ${err.message}`);
    }
  }

  throw new Error('All phases failed (scored variants + CapSolver fallback)');
}

/**
 * Attempt router login with retries
 */
let loginInProgress = null;

async function loginWithRetry(maxRetries = 5, onProgress = null) {
  if (loginInProgress) return loginInProgress;
  loginInProgress = _loginWithRetry(maxRetries, onProgress).finally(() => { loginInProgress = null; });
  return loginInProgress;
}

async function _loginWithRetry(maxRetries, onProgress) {
  let consecutiveFails = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[router] Login attempt ${attempt}/${maxRetries}...`);
      if (onProgress) onProgress(`CAPTCHA 풀이 중 (${attempt}/${maxRetries})`);

      const cookie = await login();
      if (cookie) {
        currentCookie = cookie;
        lastLoginTime = Date.now();
        if (onProgress) onProgress('CAPTCHA 성공');
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
  if (onProgress) onProgress('CAPTCHA 실패');
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

  return await loginWithRetry(5, onProgress);
}

let heartbeatLoginFailed = false;

async function heartbeatKeepAlive(onProgress = null) {
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
  loginWithRetry(5, onProgress).then(cookie => {
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
  return await loginWithRetry(5, onProgress);
}

module.exports = { initRouterSession, heartbeatKeepAlive, getCookie, refreshBeforeSleep };
