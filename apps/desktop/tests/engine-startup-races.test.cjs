const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { startEngine } = require('../src/engine-process.cjs');

// Real child/socket. Headers arrive immediately; body publication is controlled
// through a file so cancellation happens at a known asynchronous boundary.
const fixture = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.HOMUN_DATA_DIR;
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
require('node:http').createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'application/json'});
  res.flushHeaders();
  fs.writeFileSync(path.join(dir, 'requested'), 'yes');
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(dir, 'release'))) {
      clearInterval(timer); res.end(JSON.stringify({status:'ok'}));
    }
  }, 10);
  res.on('close', () => clearInterval(timer));
}).listen(0, '127.0.0.1', function() {
  console.log('HOMUN_SOCKET ' + JSON.stringify({port:this.address().port}));
});`;

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error('Fixture did not reach health probe');
}

for (const scenario of ['abort', 'deadline']) {
  test(`health body arriving after ${scenario} cannot publish a ready engine`, { timeout: 10000 }, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homun-startup-race-'));
    const controller = new AbortController();
    let engine;
    const pending = startEngine({ executable: process.execPath, args: ['-e', fixture],
      dataDir, cwd: dataDir, signal: controller.signal, timeout: scenario === 'deadline' ? 500 : 5000,
    }).then(value => { engine = value; return { engine: value }; }, error => ({ error }));
    try {
      await waitForFile(path.join(dataDir, 'requested'));
      const pid = Number(await readFile(path.join(dataDir, 'pid'), 'utf8'));
      if (scenario === 'abort') controller.abort();
      else await delay(550);
      await writeFile(path.join(dataDir, 'release'), 'yes');
      const outcome = await pending;
      assert.ok(outcome.error, 'Startup returned ready after cancellation/deadline');
      assert.match(outcome.error.message, /did not become ready/);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'Child must exit before rejection');
    } finally {
      controller.abort();
      await pending;
      await engine?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
