/**
 * lpNum 가설 검증 v3
 * 각 가설 3회 검증. 모니터링 규칙에 따라 결과 기록.
 *
 * H1: get_captcha + 실패 POST 조합이 lpNum 트리거
 * H2: "유효한 solver 답" POST만 lpNum 증가 (vs "zzzzzz")
 * H3: 시간 기반 리셋 주기 측정
 * H4: 성공 로그인 → lpNum 리셋
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const http = require('http');
const ROUTER_IP = '192.168.219.1';
const HEADERS = {
  Host: ROUTER_IP, Origin: `http://${ROUTER_IP}`,
  Referer: `http://${ROUTER_IP}/web/intro.html`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};
const routerWol = require('./router-wol.js');

function httpReq(method, reqPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: ROUTER_IP, port: 80, path: reqPath, method, headers: { ...HEADERS } };
    if (cookie) opts.headers.Cookie = cookie;
    if (body) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.headers['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, data: buf.toString(), rawData: buf, setCookie: sc ? sc.map(c => c.split(';')[0]).join('; ') : null });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function getCaptchaParams() {
  const r = await httpReq('GET', '/web/public_data.html?func=get_captcha(intro)');
  const parts = r.data.split('&');
  return { imgPath: parts[0], lpNum: parseInt(parts[1], 10), eVal: parts[2], nVal: parts[3] };
}

async function getLpNum() {
  return (await getCaptchaParams()).lpNum;
}

// Submit login form with given captcha answer (RSA encrypted, proper format)
async function submitCaptchaAnswer(answer, cap) {
  if (!cap) cap = await getCaptchaParams();
  const password = process.env.ROUTER_PASSWORD;
  const captchaImage = cap.imgPath.split('/')[1].split('.')[0];
  const encPwd = routerWol._passEnc2(password, cap.nVal, cap.eVal);
  const encCap = routerWol._passEnc2(Buffer.from(answer).toString('base64'), cap.nVal, cap.eVal);
  const formData = `page=web/intro.html&http_passwd=${encodeURIComponent(encPwd)}&captcha=${encodeURIComponent(encCap)}&captcha_image=${encodeURIComponent(captchaImage)}&e_val=${encodeURIComponent(cap.eVal)}&n_val=${encodeURIComponent(cap.nVal)}&lp_num=${cap.lpNum}&hidden_action=Login`;
  return await httpReq('POST', '/web/intro.html', formData);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function doRealLogin() {
  routerWol._resetCookie();
  try {
    const cookie = await routerWol.login();
    if (cookie) {
      await httpReq('GET', '/web/logout.html', null, cookie).catch(() => {});
      routerWol._resetCookie();
      return true;
    }
    return false;
  } catch { return false; }
}

// Get solver's actual answer for a captcha (without submitting login)
async function getSolverAnswer(cap) {
  const imgRes = await httpReq('GET', '/' + cap.imgPath);
  const sharp = require('sharp');
  const processed = await sharp(imgRes.rawData)
    .resize(400, null, { kernel: 'lanczos3' })
    .sharpen({ sigma: 1.5 }).normalise().png().toBuffer().catch(() => Buffer.from(imgRes.data, 'binary'));

  // Use CapSolver for a quick answer
  const https = require('https');
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) return null;

  const body = JSON.stringify({
    clientKey: apiKey,
    task: { type: 'ImageToTextTask', body: processed.toString('base64'), module: 'common' }
  });

  return new Promise((resolve) => {
    const req = https.request({ hostname: 'api.capsolver.com', path: '/createTask', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          resolve(r.solution?.text?.toLowerCase() || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Corrupt a solver answer by changing 1 char (so it's plausible but wrong)
function corruptAnswer(answer) {
  if (!answer || answer.length === 0) return 'abcdef';
  const i = Math.floor(Math.random() * answer.length);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let replacement;
  do { replacement = chars[Math.floor(Math.random() * chars.length)]; } while (replacement === answer[i]);
  return answer.substring(0, i) + replacement + answer.substring(i + 1);
}

async function main() {
  routerWol._initVM();
  const hypothesis = process.argv[2] || 'all';

  console.log('=== lpNum 가설 검증 v3 ===');
  console.log(`현재 lpNum: ${await getLpNum()}\n`);

  // ============ H2: 유효한 solver 답 vs "zzzzzz" ============
  if (hypothesis === 'all' || hypothesis === 'h2') {
    console.log('━━━ H2: "유효한 solver 답" POST만 lpNum 증가? ━━━');
    console.log('  방법: CapSolver 답을 1글자 변경 → 제출 → lpNum 확인\n');

    for (let t = 1; t <= 3; t++) {
      const cap = await getCaptchaParams();
      const lpBefore = cap.lpNum;
      const solverAns = await getSolverAnswer(cap);
      if (!solverAns) { console.log(`  시행 ${t}: CapSolver 실패 — 건너뜀`); continue; }
      const wrongAns = corruptAnswer(solverAns);
      console.log(`  시행 ${t}: solver="${solverAns}", 제출="${wrongAns}" (1글자 변경)`);
      await submitCaptchaAnswer(wrongAns, cap);
      const lpAfter = await getLpNum();
      console.log(`    lpNum: ${lpBefore} → ${lpAfter} (${lpAfter !== lpBefore ? 'Δ' + (lpAfter - lpBefore) + ' ← lpNum 증가!' : '변화없음'})`);
      await sleep(1000);
    }

    // 대조군: "zzzzzz" 답으로 3회
    console.log('\n  대조군: "zzzzzz" 답 3회');
    for (let t = 1; t <= 3; t++) {
      const cap = await getCaptchaParams();
      const lpBefore = cap.lpNum;
      await submitCaptchaAnswer('zzzzzz', cap);
      const lpAfter = await getLpNum();
      console.log(`    시행 ${t}: lpNum: ${lpBefore} → ${lpAfter} (${lpAfter !== lpBefore ? 'Δ' + (lpAfter - lpBefore) : '변화없음'})`);
    }
    console.log();
  }

  // ============ H3: 시간 기반 리셋 주기 ============
  if (hypothesis === 'all' || hypothesis === 'h3') {
    const currentLp = await getLpNum();
    console.log(`━━━ H3: 시간 기반 리셋 주기 (현재 lpNum=${currentLp}) ━━━`);

    if (currentLp === 0) {
      console.log('  lpNum=0이라 증가시켜야 함. login() 3회 시도...');
      for (let i = 0; i < 3; i++) { await doRealLogin(); await sleep(1000); }
      const after = await getLpNum();
      console.log(`  login() 3회 후 lpNum: ${after}`);
      if (after === 0) {
        console.log('  lpNum 여전히 0 — H3 테스트 불가. 나중에 재시도.\n');
      }
    }

    const startLp = await getLpNum();
    if (startLp > 0) {
      console.log(`  시작 lpNum=${startLp}, 1분 단위 모니터링 (최대 15분)...`);
      for (let m = 1; m <= 15; m++) {
        await sleep(60000);
        const lp = await getLpNum();
        const delta = lp - startLp;
        console.log(`  ${m}분: lpNum=${lp}${delta !== 0 ? ` (Δ${delta})` : ''}`);
        if (lp === 0) { console.log(`  → ${m}분에 리셋 확인!`); break; }
      }
    }
    console.log();
  }

  // ============ H4: 성공 로그인 → lpNum 리셋 ============
  if (hypothesis === 'all' || hypothesis === 'h4') {
    console.log('━━━ H4: 성공 로그인 → lpNum 리셋? ━━━');
    const currentLp = await getLpNum();
    console.log(`  현재 lpNum=${currentLp}`);

    if (currentLp === 0) {
      console.log('  lpNum=0이라 증가 필요. login() 실패 유도...');
      for (let i = 0; i < 5; i++) { await doRealLogin(); await sleep(1000); }
    }

    const startLp = await getLpNum();
    if (startLp > 0) {
      let verified = 0;
      for (let t = 1; t <= 8 && verified < 3; t++) {
        const lpBefore = await getLpNum();
        process.stdout.write(`  시행 ${t}: lpNum=${lpBefore}, login...`);
        const ok = await doRealLogin();
        const lpAfter = await getLpNum();
        console.log(` ${ok ? 'OK' : 'FAIL'}: ${lpBefore}→${lpAfter}`);
        if (ok) verified++;
      }
      if (verified < 3) console.log(`  주의: 성공 ${verified}/3회만 확보`);
    } else {
      console.log('  lpNum=0 유지 — H4 테스트 불가');
    }
    console.log();
  }

  console.log(`최종 lpNum: ${await getLpNum()}`);
  console.log('=== 완료 ===');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
