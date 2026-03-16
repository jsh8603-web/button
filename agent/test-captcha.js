/**
 * CAPTCHA solving test runner — runs N login attempts and logs detailed results
 * Usage: node test-captcha.js [count=5]
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const COUNT = parseInt(process.argv[2] || '5', 10);
const results = [];

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

async function main() {
  console.log(`Starting ${COUNT} CAPTCHA tests...\n`);
  const totalStart = Date.now();

  for (let i = 0; i < COUNT; i++) {
    const mod = freshRequire('./router-wol');
    const start = Date.now();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[TEST ${i + 1}/${COUNT}]`);
    console.log('='.repeat(60));

    try {
      const cookie = await mod.initRouterSession();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (cookie) {
        console.log(`\n>>> TEST ${i + 1}: SUCCESS in ${elapsed}s`);
        results.push({ test: i + 1, success: true, elapsed: parseFloat(elapsed) });
      } else {
        console.log(`\n>>> TEST ${i + 1}: FAILED (null) in ${elapsed}s`);
        results.push({ test: i + 1, success: false, elapsed: parseFloat(elapsed) });
      }
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`\n>>> TEST ${i + 1}: ERROR in ${elapsed}s: ${err.message}`);
      results.push({ test: i + 1, success: false, elapsed: parseFloat(elapsed), error: err.message });
    }

    if (i < COUNT - 1) await new Promise(r => setTimeout(r, 2000));
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(0);
  const successes = results.filter(r => r.success).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${successes}/${COUNT} success (${(successes / COUNT * 100).toFixed(0)}%)`);
  console.log(`Total time: ${totalElapsed}s`);
  console.log('='.repeat(60));

  results.forEach(r => {
    const status = r.success ? 'OK  ' : 'FAIL';
    console.log(`  Test ${String(r.test).padStart(2)}: ${status} ${r.elapsed}s${r.error ? ' — ' + r.error : ''}`);
  });

  const fs = require('fs');
  fs.writeFileSync(
    require('path').join(__dirname, '.captcha-test-results.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), count: COUNT, successes, results }, null, 2)
  );
  console.log('\nResults saved to .captcha-test-results.json');
}

main().catch(console.error);
