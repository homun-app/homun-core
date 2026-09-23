// Small always-on-top window showing the update download progress.
// Self-contained inline HTML: no app assets, no Node in the renderer.
const { BrowserWindow } = require('electron');

const PAGE = (version) => `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Aggiornamento Homun</title>
<style>
  body { font: 13px -apple-system, system-ui, sans-serif; color: #1d2721; margin: 0; padding: 18px 20px 20px;
         -webkit-user-select: none; cursor: default; }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0 0 14px; color: #5c6b5e; font-size: 12px; }
  .bar { height: 6px; border-radius: 999px; background: #e3e8e1; overflow: hidden; }
  .bar > div { height: 100%; width: 0%; border-radius: 999px; background: #4f7942; transition: width .2s; }
  .row { display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; color: #5c6b5e; }
</style></head>
<body>
  <h1>Download della versione ${version}</h1>
  <p>Homun continua a funzionare: l'aggiornamento si installa solo con il tuo consenso.</p>
  <div class="bar"><div id="fill"></div></div>
  <div class="row"><span id="bytes">0 MB di 0 MB</span><span id="percent">0%</span></div>
  <script>
    function setProgress(transferredMB, totalMB, percent) {
      document.getElementById('fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
      document.getElementById('percent').textContent = Math.floor(percent) + '%';
      document.getElementById('bytes').textContent = transferredMB.toFixed(1) + ' MB di ' + totalMB.toFixed(1) + ' MB';
    }
  </script>
</body></html>`;

function mb(bytes) {
  return bytes / (1024 * 1024);
}

function createUpdateProgressWindow(version) {
  const win = new BrowserWindow({
    width: 400, height: 170, show: false, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: false,
    title: 'Aggiornamento Homun', autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE(version)));
  win.once('ready-to-show', () => win.show());
  return {
    update(info) {
      if (win.isDestroyed()) return;
      const script = `setProgress(${mb(info.transferred)}, ${mb(info.total)}, ${info.percent})`;
      win.webContents.executeJavaScript(script).catch(() => {});
    },
    close() {
      if (!win.isDestroyed()) win.close();
    },
  };
}

module.exports = { createUpdateProgressWindow };
