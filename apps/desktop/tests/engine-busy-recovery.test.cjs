const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { startEngine } = require('../src/engine-process.cjs');

// A stale data-dir owner that survives SIGTERM, like a wedged uvicorn shutdown.
// The 'homun-engine stand-in' text matters: recovery must only kill homun processes.
const WEDGED_HOLDER = `
process.on('SIGTERM', () => {}); // homun-engine stand-in: wedged graceful shutdown
setInterval(() => {}, 1000);`;

const FOREIGN_HOLDER = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);`;

// First run reports the busy directory like the real engine does; the retry serves health.
const BUSY_ENGINE = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.HOMUN_DATA_DIR;
const attemptsFile = path.join(dir, 'attempts');
const attempts = fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, 'utf8')) : 0;
fs.writeFileSync(attemptsFile, String(attempts + 1));
if (attempts === 0) {
  const holderPid = Number(fs.readFileSync(path.join(dir, 'holder.pid'), 'utf8'));
  console.log('HOMUN_STARTUP_FAILED ' + JSON.stringify({ reason: 'engine-dir-busy', holder_pid: holderPid }));
  process.exit(1);
}
require('node:http').createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({status: 'ok'}));
}).listen(0, '127.0.0.1', function() {
  console.log('HOMUN_SOCKET ' + JSON.stringify({port: this.address().port}));
});`;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

test('busy data dir: stale wedged holder is force-killed and startup retries once', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homun-busy-recovery-'));
  const holder = spawn(process.execPath, ['-e', WEDGED_HOLDER], { stdio: 'ignore' });
  await once(holder, 'spawn');
  let engine;
  try {
    await writeFile(path.join(dataDir, 'holder.pid'), String(holder.pid));
    engine = await startEngine({ executable: process.execPath, args: ['-e', BUSY_ENGINE], dataDir, cwd: dataDir, timeout: 15000 });
    assert.equal(engine.recoveredFromPid, holder.pid);
    assert.ok(!processAlive(holder.pid), 'Stale holder must be force-killed');
    assert.equal((await fetch(engine.baseUrl + '/v1/health', { headers: { Authorization: `Bearer ${engine.token}` } })).status, 200);
    assert.equal(Number(await readFile(path.join(dataDir, 'attempts'), 'utf8')), 2, 'Engine must retry exactly once');
  } finally {
    await engine?.stop();
    holder.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('busy data dir: a foreign holder is reported, never killed', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homun-foreign-holder-'));
  const holder = spawn(process.execPath, ['-e', FOREIGN_HOLDER], { stdio: 'ignore' });
  await once(holder, 'spawn');
  try {
    await writeFile(path.join(dataDir, 'holder.pid'), String(holder.pid));
    await assert.rejects(
      startEngine({ executable: process.execPath, args: ['-e', BUSY_ENGINE], dataDir, cwd: dataDir, timeout: 15000 }),
      error => {
        assert.match(error.message, /did not become ready/);
        assert.equal(error.info.startupFailure.reason, 'engine-dir-busy');
        assert.equal(error.info.recovery.reason, 'foreign-process');
        return true;
      });
    assert.ok(processAlive(holder.pid), 'Foreign process must survive recovery');
  } finally {
    holder.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  }
});
