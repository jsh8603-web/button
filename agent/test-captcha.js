/**
 * CAPTCHA solver test harness
 * Runs login() N times, logs results, analyzes every 5 attempts.
 * Usage: node test-captcha.js [count=10]
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const ROUTER_IP = '192.168.219.1';
const HEADERS = {
  Host: ROUTER_IP,
  Origin: `http://${ROUTER_IP}`,
  Referer: `http://${ROUTER_IP}/web/intro.html`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

function httpReq(method, reqPath, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: ROUTER_IP, port: 80, path: reqPath, method, headers: { ...HEADERS } };
    if (cookie) opts.headers.Cookie = cookie;
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function logoutRouter(cookie) {
  try {
    await httpReq('GET', '/web/logout.html', cookie);
    console.log('[test] Logged out existing session');
  } catch (e) {
    console.log('[test] Logout failed (may not be logged in):', e.message);
  }
}

async function main() {
  const totalRuns = parseInt(process.argv[2]) || 10;
  const analyzeEvery = 5;

  // Import the login function from router-wol
  const routerWol = require('./router-wol.js');

  // Force logout any existing session first
  if (routerWol.getCookie && routerWol.getCookie()) {
    await logoutRouter(routerWol.getCookie());
  }
  // Also try bare logout
  await logoutRouter();

  // Clear current cookie so login() starts fresh
  if (routerWol._resetCookie) routerWol._resetCookie();

  const results = [];

  for (let i = 1; i <= totalRuns; i++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[test] === Run ${i}/${totalRuns} ===`);
    console.log('='.repeat(60));

    const start = Date.now();
    let success = false;
    let error = null;

    try {
      // Must logout between attempts to allow fresh login
      if (routerWol.getCookie && routerWol.getCookie()) {
        await logoutRouter(routerWol.getCookie());
        if (routerWol._resetCookie) routerWol._resetCookie();
      }

      const cookie = await routerWol.login();
      success = !!cookie;
      if (cookie) {
        console.log(`[test] ✓ SUCCESS — got cookie`);
        // Logout after success to allow next attempt
        await logoutRouter(cookie);
        if (routerWol._resetCookie) routerWol._resetCookie();
      } else {
        console.log(`[test] ✗ FAILED — no cookie returned`);
      }
    } catch (err) {
      error = err.message;
      console.log(`[test] ✗ ERROR — ${err.message}`);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ run: i, success, error, elapsed: parseFloat(elapsed) });

    // Analyze every N attempts
    if (i % analyzeEvery === 0 || i === totalRuns) {
      const batch = results.slice(Math.max(0, i - analyzeEvery), i);
      const batchSuccesses = batch.filter(r => r.success).length;
      const totalSuccesses = results.filter(r => r.success).length;
      const avgTime = (batch.reduce((s, r) => s + r.elapsed, 0) / batch.length).toFixed(1);

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`[analysis] Batch ${Math.floor((i-1)/analyzeEvery)+1}: ${batchSuccesses}/${batch.length} success (${(batchSuccesses/batch.length*100).toFixed(0)}%)`);
      console.log(`[analysis] Cumulative: ${totalSuccesses}/${i} success (${(totalSuccesses/i*100).toFixed(0)}%)`);
      console.log(`[analysis] Avg time: ${avgTime}s per attempt`);

      const errors = batch.filter(r => r.error);
      if (errors.length > 0) {
        console.log(`[analysis] Errors: ${errors.map(r => `#${r.run}: ${r.error}`).join(', ')}`);
      }
      console.log('─'.repeat(60));
    }

    // Small delay between attempts
    if (i < totalRuns) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Final summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('[FINAL] Results:');
  const wins = results.filter(r => r.success).length;
  console.log(`  Total: ${wins}/${totalRuns} (${(wins/totalRuns*100).toFixed(0)}%)`);
  console.log(`  Avg time: ${(results.reduce((s,r) => s + r.elapsed, 0) / totalRuns).toFixed(1)}s`);
  console.log(`  Results: ${results.map(r => r.success ? '✓' : '✗').join(' ')}`);
  console.log('='.repeat(60));

  process.exit(0);
}

main().catch(err => {
  console.error('[test] Fatal:', err);
  process.exit(1);
});
