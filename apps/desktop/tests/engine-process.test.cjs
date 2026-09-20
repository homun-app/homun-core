const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startEngine } = require('../src/engine-process.cjs');

function runtimeCommand(root) {
  return process.env.HOMUN_TEST_ENGINE
    ? { executable: process.env.HOMUN_TEST_ENGINE, args: [] }
    : { executable: process.env.HOMUN_TEST_PYTHON || path.join(root, 'engine/.venv/bin/python'), args: ['-m', 'homun'] };
}

test('owned real engine authenticates all reads and shuts down without an orphan', { timeout: 30000 }, async () => {
  const root = path.resolve(__dirname, '../../..');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homun-desktop-test-'));
  let engine;
  try {
    engine = await startEngine({ ...runtimeCommand(root), dataDir, cwd: root });
    assert.equal((await fetch(engine.baseUrl+'/v1/health')).status, 401);
    assert.equal((await fetch(engine.baseUrl+'/v1/health', { headers: { Authorization: 'Bearer '+engine.token } })).status, 200);
    assert.equal((await fetch(engine.baseUrl+'/v1/health', { headers: { Authorization: 'Bearer '+engine.token, 'X-Homun-Actor-Id': 'person_fabio' } })).status, 200);
    assert.equal((await fetch(engine.baseUrl+'/v1/health', { headers: { Authorization: 'Bearer '+engine.token, 'X-Homun-Actor-Id': 'other-person' } })).status, 403);
    await engine.stop();
    assert.ok(engine.child.exitCode === 0 || engine.child.signalCode === 'SIGTERM');
    await assert.rejects(fetch(engine.baseUrl+'/v1/health'));
  } finally { await engine?.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('startup cancellation tears down a spawned engine before returning', { timeout: 15000 }, async () => {
  const root = path.resolve(__dirname, '../../..');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homun-desktop-abort-'));
  const controller = new AbortController();
  const pending = startEngine({ ...runtimeCommand(root), dataDir, cwd: root, signal: controller.signal });
  controller.abort();
  try { await assert.rejects(pending, /did not become ready/); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('abrupt desktop death closes ownership pipe and stops engine', { timeout: 30000 }, async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { setTimeout: delay } = require('node:timers/promises');
  const root = path.resolve(__dirname, '../../..');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'homun-owner-death-'));
  const modulePath = path.join(root, 'apps/desktop/src/engine-process.cjs');
  const script = `require(${JSON.stringify(modulePath)}).startEngine({...JSON.parse(process.argv[1]),dataDir:process.argv[2],cwd:process.argv[3]}).then(e=>console.log(JSON.stringify({url:e.baseUrl,pid:e.child.pid})));`;
  const owner = spawn(process.execPath, ['-e', script, JSON.stringify(runtimeCommand(root)), dataDir, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let baseUrl;
  try {
    const deadline = Date.now()+20000;
    let text = '';
    owner.stdout.on('data', data => { text += data; });
    while (!text.includes('\n') && Date.now() < deadline) await delay(50);
    baseUrl = JSON.parse(text).url;
    assert.equal((await fetch(baseUrl+'/v1/health')).status, 401);
    const exited = once(owner, 'exit');
    owner.kill('SIGKILL'); await exited;
    let stopped = false;
    while (Date.now() < deadline) {
      try { await fetch(baseUrl+'/v1/health', { signal: AbortSignal.timeout(500) }); }
      catch { stopped = true; break; }
      await delay(50);
    }
    assert.ok(stopped, 'Engine survived its owner');
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); await rm(dataDir, { recursive: true, force: true }); }
});
