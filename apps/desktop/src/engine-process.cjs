/** Own exactly one engine process; startup failure always tears it down. */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The installer bundles cua-driver next to the engine venv when present;
// surface it to the engine without overriding an explicit user setting.
function bundledCuaDriver(cwd) {
  try {
    const dev = path.join(cwd, 'engine/.venv/bin/cua-driver');
    if (fs.existsSync(dev)) return dev;
    const packaged = path.join(process.resourcesPath || '', 'engine', 'bin', 'cua-driver');
    if (fs.existsSync(packaged)) return packaged;
  } catch (_) { /* unavailable resources path: engine falls back to PATH */ }
  return undefined;
}
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function launchOnce({ executable, args = [], dataDir, cwd, timeout = 20000, signal }) {
  const token = randomBytes(32).toString('hex');
  const child = spawn(executable, [...args, 'serve', '--port', '0'], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOMUN_DATA_DIR: dataDir, HOMUN_SESSION_TOKEN: token,
      HOMUN_SESSION_ACTOR_ID: 'person_fabio', HOMUN_MEMORY_BACKEND: 'sqlite', HOMUN_PARENT_WATCHDOG: '1', PYTHONUNBUFFERED: '1',
      ...(process.env.HOMUN_CUA_DRIVER_BIN ? {} : { HOMUN_CUA_DRIVER_BIN: bundledCuaDriver(cwd) }) },
  });
  let baseUrl, exited = false, failed = false, buffer = '', startupFailure;
  child.once('error', () => { failed = true; });
  child.once('exit', () => { exited = true; });
  child.stderr.on('data', c => { if (process.env.HOMUN_ENGINE_DEBUG_LOG) require('node:fs').appendFileSync(process.env.HOMUN_ENGINE_DEBUG_LOG, c); }); // Provider/storage diagnostics must not leak into renderer.
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
      } else if (line.startsWith('HOMUN_STARTUP_FAILED ')) {
        try { startupFailure = JSON.parse(line.slice(21)); } catch { startupFailure = { reason: 'unreadable' }; }
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
            return { engine: { baseUrl, token, stop, child } };
          }
        } catch { /* Startup isn't ready yet. */ }
      }
      await delay(50);
    }
    await stop();
    const error = new Error('The owned Homun engine did not become ready');
    if (startupFailure) error.info = { startupFailure };
    return { error };
  } catch (error) {
    await stop();
    if (startupFailure && !error.info) error.info = { startupFailure };
    return { error };
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function releaseBusyHolder(pid) {
  // The engine names the stale owner of the data dir on stdout; verify it is
  // really a Homun engine before killing, so a recycled pid never turns the
  // recovery into a shotgun.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return { killed: false, reason: 'holder-unknown', holderPid: pid ?? null };
  if (!processAlive(pid)) return { killed: true, recoveredFrom: pid };
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    if (!/homun/i.test(stdout)) return { killed: false, reason: 'foreign-process', holderPid: pid };
  } catch { return { killed: false, reason: 'holder-unknown', holderPid: pid }; }
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') return { killed: false, reason: 'not-permitted', holderPid: pid }; }
  for (let i = 0; i < 10 && processAlive(pid); i++) await delay(300);
  if (!processAlive(pid)) return { killed: true, recoveredFrom: pid };
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  for (let i = 0; i < 6 && processAlive(pid); i++) await delay(300);
  return processAlive(pid) ? { killed: false, reason: 'unkillable', holderPid: pid } : { killed: true, recoveredFrom: pid };
}

async function startEngine(options) {
  const first = await launchOnce(options);
  if (first.engine) return first.engine;
  const failure = first.error.info?.startupFailure;
  if (failure?.reason !== 'engine-dir-busy' || options.signal?.aborted) throw first.error;
  const recovery = Number.isInteger(failure.holder_pid)
    ? await releaseBusyHolder(failure.holder_pid)
    : { killed: false, reason: 'holder-unknown', holderPid: failure.holder_pid ?? null };
  if (!recovery.killed) { first.error.info = { ...first.error.info, recovery }; throw first.error; }
  const retry = await launchOnce(options);
  if (retry.engine) { retry.engine.recoveredFromPid = recovery.recoveredFrom; return retry.engine; }
  retry.error.info = { ...retry.error.info, recovery };
  throw retry.error;
}
module.exports = { startEngine };
