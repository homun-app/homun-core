/** Own exactly one engine process; startup failure always tears it down. */
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function startEngine({ executable, args = [], dataDir, cwd, timeout = 20000, signal }) {
  const token = randomBytes(32).toString('hex');
  const child = spawn(executable, [...args, 'serve', '--port', '0'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOMUN_DATA_DIR: dataDir, HOMUN_SESSION_TOKEN: token,
      HOMUN_SESSION_ACTOR_ID: 'person_fabio', HOMUN_MEMORY_BACKEND: 'sqlite', HOMUN_PARENT_WATCHDOG: '1', PYTHONUNBUFFERED: '1' },
  });
  let baseUrl, exited = false, failed = false, buffer = '';
  child.once('error', () => { failed = true; });
  child.once('exit', () => { exited = true; });
  child.stderr.on('data', () => {}); // Provider/storage diagnostics must not leak into renderer.
  child.stdout.on('data', chunk => {
    buffer = (buffer + chunk).slice(-8192);
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.startsWith('HOMUN_SOCKET ')) {
        try {
          const { port } = JSON.parse(line.slice(13));
          if (Number.isInteger(port) && port > 0 && port < 65536) baseUrl = `http://127.0.0.1:${port}`;
        } catch { failed = true; }
      }
    }
  });
  async function stop() {
    if (exited || !child.pid) return;
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
      if (!exited) { child.kill('SIGKILL'); await done; }
    } finally { clearTimeout(timer); }
  }
  try {
    const deadline = Date.now() + timeout;
    const canBecomeReady = () => Date.now() < deadline && !failed && !exited && !signal?.aborted;
    while (canBecomeReady()) {
      if (baseUrl) {
        try {
          const probeTimeout = AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())));
          const probeSignal = signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout;
          const response = await fetch(baseUrl + '/v1/health', { headers: { Authorization: `Bearer ${token}` }, signal: probeSignal });
          if (response.ok && (await response.json()).status === 'ok' && canBecomeReady()) {
            return { baseUrl, token, stop, child };
          }
        } catch { /* Startup isn't ready yet. */ }
      }
      await delay(50);
    }
    throw new Error('The owned Homun engine did not become ready');
  } catch (error) { await stop(); throw error; }
}
module.exports = { startEngine };
