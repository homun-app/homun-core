const { app, BrowserWindow, protocol, session, dialog, safeStorage } = require('electron');
const path = require('node:path');
const { startEngine } = require('./engine-process.cjs');
const { createProtocolHandler } = require('./protocol.cjs');

app.setName('Homun');
if (process.env.HOMUN_DESKTOP_PROFILE) {
  require('node:fs').mkdirSync(process.env.HOMUN_DESKTOP_PROFILE, { recursive: true });
  app.setPath('userData', process.env.HOMUN_DESKTOP_PROFILE);
}
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'homun', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let engine, startup, stopping = false;
const startupAbort = new AbortController();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  startupAbort.abort();
  try { await startup?.catch(() => {}); await engine?.stop(); } finally { app.exit(process.exitCode || 0); }
}
app.on('before-quit', event => { event.preventDefault(); void shutdown(); });
app.on('window-all-closed', () => app.quit());
if (!app.requestSingleInstanceLock()) app.exit();
else app.whenReady().then(async () => {
  // Expose the web content to accessibility: without this macOS lists only the
  // native window chrome, and assistive technology (or automated QA) cannot
  // reach buttons and fields inside the page.
  app.setAccessibilitySupportEnabled(true);
  const root = path.resolve(__dirname, '../../..');
  const dataDir = process.env.HOMUN_DESKTOP_DATA_DIR || path.join(app.getPath('userData'), 'engine');
  const bundled = path.join(process.resourcesPath, 'engine', 'homun-engine');
  startup = startEngine({ signal: startupAbort.signal, executable: app.isPackaged ? bundled : path.join(root, 'engine/.venv/bin/python'),
    args: app.isPackaged ? [] : ['-m', 'homun'], dataDir, cwd: app.isPackaged ? process.resourcesPath : root });
  engine = await startup;
  if (stopping) { await engine.stop(); return; }
  const isolated = session.fromPartition('persist:homun-desktop');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.protocol.handle('homun', createProtocolHandler({ webRoot: app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(root, 'apps/web/dist'), engine }));
  const window = new BrowserWindow({ width: 1380, height: 920, title: 'Homun',
    webPreferences: { session: isolated, preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('homun://app/')) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  engine.child.once('exit', () => { if (!stopping) window.setTitle('Homun — motore arrestato'); });
  await window.loadURL('homun://app/');
  const smoke = process.argv.includes('--smoke');
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      const updater = require('./updater.cjs');
      updater.registerUpdaterIpc();
      // The smoke skips the feed check (offline reproducibility), not the API.
      if (!smoke) updater.initUpdater();
    } catch (error) { console.error('updater init failed:', error.message); }
  }
  if (process.argv.includes('--smoke')) {
    const result = await window.webContents.executeJavaScript(`(async () => ({
      title: document.title, rendered: document.getElementById('root').childElementCount > 0,
      nodeHidden: typeof window.require === 'undefined', sessionHidden: !('token' in window.homunDesktop), updateApi: typeof window.homunDesktop.updateCheck === 'function',
      health: await fetch(window.homunDesktop.engineBaseUrl+'/v1/health').then(r=>r.status)
    }))()`);
    result.unauthenticated = (await fetch(engine.baseUrl + '/v1/health')).status;
    result.keychainAvailable = safeStorage.isEncryptionAvailable();
    if (result.keychainAvailable) {
      const synthetic = 'Homun synthetic secret only';
      result.syntheticRoundtrip = safeStorage.decryptString(safeStorage.encryptString(synthetic)) === synthetic;
    }
    console.log('HOMUN_DESKTOP_SMOKE ' + JSON.stringify(result));
    if (!result.rendered || result.health !== 200 || !result.nodeHidden || !result.sessionHidden || result.unauthenticated !== 401 || !result.updateApi) process.exitCode = 1;
    if (process.env.HOMUN_DESKTOP_SCREENSHOT) await require('node:fs/promises').writeFile(process.env.HOMUN_DESKTOP_SCREENSHOT, (await window.capturePage()).toPNG());
    app.quit();
  }
}).catch(async error => {
  if (stopping) return;
  console.error('Desktop startup failed:', error.message);
  if (!process.argv.includes('--smoke')) dialog.showErrorBox('Homun non disponibile', 'Il motore locale non si è avviato. Controlla che la directory non sia già in uso.');
  await engine?.stop(); app.exit(1);
});
