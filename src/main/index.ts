// Main Electron. DUE modalità dello STESSO eseguibile (fase rilascio A1):
// - UI (default): finestra, tray, deep link, client del daemon;
// - daemon (--homun-daemon): niente finestre né lock d'istanza, activation
//   policy accessory, e il runtime degli agenti (loop, coda durevole,
//   scheduler, sandbox, MCP) gira NEL PROCESSO — niente più
//   ELECTRON_RUN_AS_NODE, così il fuse RunAsNode può restare spento (A4).
//   La finestra chiusa non ferma i bot: il main inoltra RPC ed eventi.
//
// Fase rilascio A5: la pagina è servita dal protocollo dell'app homun://app/
// (non da file://), la finestra è sandbox:true con preload CommonJS, i link
// esterni passano da shell.openExternal dopo il controllo dello schema, la
// navigazione resta nella stessa origine, i webview sono vietati e i permessi
// del browser sono tutti negati salvo la scrittura degli appunti.
import { app, BrowserWindow, protocol, safeStorage, screen, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc, emitLocal } from './ipc'
import { setDataDir, listAgents, createAgent } from './store/db'
import { createTray, refreshTray } from './tray'
import { initMainLanguage, applyStartupLanguage } from './i18n'
// fase 17c (C4): la descrizione del Bot principale è un messaggio del bot
// all'utente — lingua dell'utente (al primo avvio: lingue di sistema, il
// setting ui.activeLanguage non è ancora stato pubblicato)
import { formatUi, ui } from '../shared/ui-text'
import { UI } from '../shared/ui-messages'
import { resolveUiLanguage } from '../shared/ui-language'
import { DaemonClient } from './daemon-client'
import { setDaemonSpawnContext } from './daemon-context'
import { userDataDir } from './paths'
import { isDaemonMode, resolveDataDirArgv } from './mode'
import { runDaemonRuntime } from '../daemon/runtime'
import { APP_BUILD_ID } from './build-id'
import { createRendererHandler, RENDERER_CSP } from './protocol'
import { canOpenExternally } from './external-url'
import { permissionAllowed } from './permissions'
import { cleanupLegacyLaunchAgent } from './launchagent'
import { findLegacyHomun2Dir, legacyNoticeMarkerPath } from './legacy-homun2'
import { initUpdater, setUpdaterDaemonStopper, shouldAutoCheckUpdates, hasUpdateConfig } from './updater'
import { safeStorageBackendForEnv } from '../daemon/master-keys'

// fase 16 (U0b): la cartella dati reale dell'utente è …/Application
// Support/sandbot (minuscolo), di prima del cambio di nome visibile in
// "Homun". Va fissata PRIMA di app.whenReady() e di ogni getPath('userData'),
// altrimenti Electron ricaverebbe …/Homun e l'utente ritroverebbe l'app vuota.
// Fase rilascio (A8): SANDBOT_TEST_USER_DATA la sposta per intero (prove con
// la .app impacchettata senza toccare i dati veri).
app.setPath('userData', userDataDir(app.getName(), app.getPath('appData')))

// A5: il protocollo dell'app si registra PRIVILEGIATO prima del ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'homun',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

if (isDaemonMode(process.argv)) {
  // ---- modalità daemon (A1): stesso eseguibile, nessuna finestra ----
  app.setActivationPolicy('accessory')
  app.whenReady().then(() => {
    const argDir = resolveDataDirArgv(process.argv) ?? process.env.SANDBOT_DATA_DIR
    setDataDir(argDir ?? join(app.getPath('userData'), 'data'))
    // il backend safeStorage del daemon è quello VERO di Electron, salvo il
    // finto dei test (SANDBOT_TEST_FAKE_SAFESTORAGE): mai il Portachiavi vero
    // in una prova
    void runDaemonRuntime({
      dataDir: argDir ?? join(app.getPath('userData'), 'data'),
      getVersion: () => app.getVersion(),
      buildId: APP_BUILD_ID,
      safeStorage: safeStorageBackendForEnv(safeStorage)
    }).catch((e) => {
      console.error('[sandbotd] avvio fallito:', e)
      app.exit(1)
    })
  })
  // niente lock d'istanza (quello è della UI), niente tray, niente Dock:
  // il daemon vive finché l'utente non lo ferma o arriva l'aggiornamento (A2)
} else {
  // ---- modalità UI ----
  // A5: istanza singola — un secondo avvio porta in primo piano la finestra
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.show()
          w.focus()
        }
      }
    })

    // fase rilascio (A1): il client del daemon lancia process.execPath con
    // --homun-daemon; qui sta il contesto (impacchettata? versione?) che la
    // build pubblica non può ricavare altrimenti
    setDaemonSpawnContext({ isPackaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(), buildId: APP_BUILD_ID })

    // il preload è CommonJS (A5): sandbox:true non carica preload ESM
    const preloadPath = join(__dirname, '../preload/index.cjs')
    const preload = existsSync(preloadPath) ? preloadPath : join(__dirname, '../preload/index.js')

    let mainWindow: BrowserWindow | undefined

    function getMainWindow(): BrowserWindow | undefined {
      return mainWindow ?? BrowserWindow.getAllWindows()[0]
    }

    function openAgent(agentId: string): void {
      const win = getMainWindow()
      if (!win) return
      win.show()
      win.focus()
      win.webContents.send('sandbot:event', { type: 'open-agent', agentId })
    }

    function createWindow(): void {
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#0b0d10',
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          // A5: sandbox VERA — il preload è solo contextBridge + ipcRenderer (.cjs)
          sandbox: true,
          webviewTag: false
        }
      })
      mainWindow = win
      win.on('closed', () => { if (mainWindow === win) mainWindow = undefined })

      // A5: niente finestre/popup dal renderer; i link http(s) al browser
      // esterno SOLO dopo il controllo dello schema (mai file:, javascript:,
      // schemi personalizzati)
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (canOpenExternally(url)) void shell.openExternal(url)
        return { action: 'deny' }
      })
      // A5: la navigazione resta nell'origine dell'app (homun://app in
      // produzione, il dev server in sviluppo)
      const appOrigin = process.env.ELECTRON_RENDERER_URL
        ? new URL(process.env.ELECTRON_RENDERER_URL).origin + '/'
        : 'homun://app/'
      const isAppNavigation = (url: string): boolean => {
        if (url.startsWith(appOrigin)) return true
        try {
          return new URL(url).href === new URL(appOrigin).href
        } catch {
          return false
        }
      }
      win.webContents.on('will-navigate', (event, url) => {
        if (!isAppNavigation(url)) event.preventDefault()
      })
      win.webContents.on('will-redirect', (event, url) => {
        if (!isAppNavigation(url)) event.preventDefault()
      })
      // A5: nessun <webview>
      win.webContents.on('will-attach-webview', (event) => event.preventDefault())

      if (process.env.ELECTRON_RENDERER_URL) {
        void win.loadURL(process.env.ELECTRON_RENDERER_URL)
      } else {
        void win.loadURL('homun://app/')
      }
    }

    app.whenReady().then(() => {
      // fase 17a (L5): la lingua del main (tray, notifiche native) dalle
      // lingue preferite di sistema; cambierà col setting via IPC
      initMainLanguage()
      // il path dati è quello storico dell'app (userData/data): app e daemon
      // condividono lo stesso store
      setDataDir(join(app.getPath('userData'), 'data'))

      // A5: permessi del browser — tutto negato salvo ciò che l'app usa
      // davvero (la copia del testo negli appunti). Il microfono non serve a
      // nessuna funzione: negato.
      const allowPermission = (permission: string): boolean => permissionAllowed(permission)
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowPermission(permission)))
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowPermission(permission))

      // A5: la pagina dal protocollo dell'app, non da file://
      protocol.handle('homun', createRendererHandler(join(__dirname, '../renderer')))

      // fase rilascio (A3): pulizia del vecchio LaunchAgent di SandBot, solo
      // quel file esatto (bootout/unload + unlink), best-effort
      void cleanupLegacyLaunchAgent(process.getuid?.()).catch(() => undefined)

      // client del daemon: lo avvia se non attivo, inoltra RPC/host API/eventi
      const client = new DaemonClient()
      client.registerHost('host.screen.scaleFactor', () => screen.getPrimaryDisplay().scaleFactor || 1)
      // K1.7 (fase rilascio — correzioni): le API ASINCRONE di safeStorage
      // (Electron 45 depreca le sincrone e avvisa nel log)
      client.registerHost('host.safeStorage.encrypt', async ([plain]) =>
        (await safeStorage.encryptStringAsync(String(plain))).toString('base64'))
      client.registerHost('host.safeStorage.decrypt', async ([b64]) =>
        await safeStorage.decryptStringAsync(Buffer.from(String(b64), 'base64')))
      // fase 5: apre il browser di sistema per l'autorizzazione OAuth dei connettori
      client.registerHost('host.openExternal', ([url]) => {
        if (!canOpenExternally(String(url))) return Promise.reject(new Error('URL non apribile'))
        return shell.openExternal(String(url))
      })
      registerIpc(client, () => BrowserWindow.getAllWindows())
      // A8: prima di installare un aggiornamento il daemon si ferma BENE
      setUpdaterDaemonStopper(async () => {
        try {
          await client.call('daemon:restart')
        } finally {
          await client.waitDaemonExit(15_000).catch(() => undefined)
        }
      })
      void client.start()
        .then(() => {
          // fase 17a (K1): il setting 'ui.language' salvato decide la lingua del
          // tray anche al riavvio (stessa strada dell'handler IPC settings:get);
          // se il daemon non risponde resta la lingua di sistema.
          // fase 17b (A2): la lingua risolta viene anche pubblicata come setting
          // 'ui.activeLanguage' (settings:set), la legge currentUserLanguage
          return applyStartupLanguage(
            () => client.call('settings:get', ['ui.language', 'system']),
            (key, value) => client.call('settings:set', [key, value])
          )
        })
        .then(() => refreshTray())
        .catch((e) => console.error('[sandbot] daemon non avviabile:', e))

      if (listAgents().length === 0) {
        // primo avvio: agente principale, come il "Bot principale" dell'originale
        createAgent('Bot', formatUi(ui(UI.mainBotDescription), resolveUiLanguage(null, app.getPreferredSystemLanguages())))
      }
      createWindow()
      createTray(getMainWindow)
      refreshTray()
      emitLocal({ type: 'agents' }, () => BrowserWindow.getAllWindows())

      // deep link sandbot://agent/<id>
      app.setAsDefaultProtocolClient('sandbot')
      app.on('open-url', (_e, url) => {
        const m = url.match(/^sandbot:\/\/agent\/([A-Za-z0-9_-]+)$/)
        if (m) openAgent(m[1]!)
        else { getMainWindow()?.show(); getMainWindow()?.focus() }
      })

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })

      // A8: l'aggiornamento si controlla solo nell'app impacchettata e mai
      // quando ci sono variabili SANDBOT_TEST_* (le prove non toccano la rete).
      // K6: e mai quando manca app-update.yml (build --dir): niente ENOENT nel log
      if (shouldAutoCheckUpdates(app.isPackaged, process.env, hasUpdateConfig())) initUpdater()
    })

    app.on('window-all-closed', () => {
      // il daemon resta attivo: chiudere la finestra non ferma i bot (§6.2)
      if (process.platform !== 'darwin') app.quit()
    })
  }
}
