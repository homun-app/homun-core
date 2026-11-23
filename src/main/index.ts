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
import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { setDataDir, dataDir } from './store/db'
import { initMainLanguage, applyStartupLanguage } from './i18n'
import { DaemonClient } from './daemon-client'
import { setDaemonSpawnContext } from './daemon-context'
import { userDataDir } from './paths'
import { daemonSessionDataDir, isDaemonMode, registersProtocolClient, resolveDataDirArgv } from './mode'
import { runDaemonRuntime } from '../daemon/runtime'
import { APP_BUILD_ID } from './build-id'
import { createRendererHandler, realFs, RENDERER_CSP } from './protocol'
import { canOpenExternally, isSpaNavigationBlocked } from './external-url'
import { permissionAllowed } from './permissions'
import { cleanupLegacyLaunchAgent } from './launchagent'
import { findLegacyHomun2Dir, legacyNoticeMarkerPath } from './legacy-homun2'
import { initUpdater, setUpdaterDaemonStopper, shouldAutoCheckUpdates, hasUpdateConfig, openTestUpdateWindowIfRequested } from './updater'
// RV1 (fase beta.2): l'app fuori da Applicazioni o translocata (sola lettura)
import { appLocationAction, proposeMoveToApplications, setAppNeedsMove, appNeedsMove } from './app-location'
import { stopRunningDaemon, setDaemonRestartListener } from './daemon-client'
// SV4 (fase schermo-vivo): la finestra PiP
import { PipManager, type PipWindowHandle } from './pip'
// W1 (fase avvio-finestra): la porta UNICA della finestra principale
import { createMainWindowManager } from './main-window'
// W2 (fase avvio-finestra): lo stato del caricamento mentre il daemon si avvia
import { BootStatusTracker } from './boot-status'
import { UPDATE_CHANNEL_SETTING, parseUpdateChannel } from '../shared/update-channel'
import { safeStorageBackendForEnv } from '../daemon/master-keys'
// U6 (fase mcp-ui): il registro del ciclo di vita e la decisione del
// second-instance mentre l'app sta uscendo (relaunch)
import { createLifecycleLog, mainLogDir } from './lifecycle-log'
// P1 (fase primo-avvio): il registro della finestra (caricamento, primo paint,
// fotografia a 5 s) e gli orari nel daemon.log
import { watchWindow, type DisplayLike, type Rect, type WatchDeps, type WindowWatch } from './window-lifecycle'
import { installDaemonLogTimestamps } from '../daemon/log-timestamp'
import { secondInstanceWhileQuitting } from './quit-behavior'
// U6: il tray si distrugge all'uscita
import { createTray, refreshTray, destroyTray } from './tray'
import { guardStdioEpipe } from './stdio-guard'

// un log su uno stdout/stderr ormai chiuso non deve aprire il dialogo
// «A JavaScript error occurred in the main process» (vale anche per il daemon)
guardStdioEpipe([process.stdout, process.stderr])

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
  // P3.1 (fase primo-avvio): i dati di Chromium del daemon in una cartella
  // sua DENTRO userData — PRIMA di whenReady. UI e daemon non aprono più gli
  // stessi file (cache, Local Storage, i LOCK di LevelDB); userData e i dati
  // di Homun restano dove sono. Il daemon non legge niente dal profilo della UI.
  app.setPath('sessionData', daemonSessionDataDir(app.getPath('userData')))
  // P1: ogni riga [sandbotd] con l'orario ISO — PRIMA di qualunque riga
  installDaemonLogTimestamps()
  // U6: anche il daemon scrive la sua riga di boot nello stesso registro
  const daemonLog = createLifecycleLog(mainLogDir(() => app.getPath('logs')))
  daemonLog.line('boot', { pid: process.pid, version: app.getVersion(), mode: 'daemon' })
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
  // U6 (fase mcp-ui): il registro del ciclo di vita del main, sempre attivo
  // e leggero (con SANDBOT_TEST_USER_DATA finisce nei dati temporanei delle
  // prove, MAI nel ~/Library/Logs/Homun vero)
  const lifecycle = createLifecycleLog(mainLogDir(() => app.getPath('logs')))
  lifecycle.line('boot', { pid: process.pid, version: app.getVersion(), mode: 'ui' })
  // U6: il flag d'uscita — imposto in before-quit, letto da second-instance
  let quitting = false
  let quitStartedAt = 0
  // A5: istanza singola — un secondo avvio porta in primo piano la finestra
  const gotTheLock = app.requestSingleInstanceLock()
  lifecycle.line(gotTheLock ? 'lock' : 'lock-denied')
  if (!gotTheLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      // U6: se QUESTA copia sta uscendo, il nuovo avvio arriverebbe a un
      // processo morente (il caso della beta.15: nessuna finestra finché non
      // si rifà ⌘Q) → si riparte: la copia nuova mostrerà la finestra
      lifecycle.line('second-instance', { quitting })
      if (secondInstanceWhileQuitting(quitting) === 'relaunch') {
        lifecycle.line('relaunch-on-quit')
        app.relaunch()
        return
      }
      // W1 (fase avvio-finestra): SOLO la principale — si ricrea se chiusa e
      // non si toccano le altre finestre (PiP, aggiornamento, offscreen)
      showMainWindow()
    })

    // fase rilascio (A1): il client del daemon lancia process.execPath con
    // --homun-daemon; qui sta il contesto (impacchettata? versione?) che la
    // build pubblica non può ricavare altrimenti
    setDaemonSpawnContext({ isPackaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion(), buildId: APP_BUILD_ID })

    // il preload è CommonJS (A5): sandbox:true non carica preload ESM
    const preloadPath = join(__dirname, '../preload/index.cjs')
    const preload = existsSync(preloadPath) ? preloadPath : join(__dirname, '../preload/index.js')

    // W1 (fase avvio-finestra): la principale vive nel manager — UNA porta
    // sola (showMainWindow: crea se manca, restore+show+focus altrimenti) e
    // getMainWindow che torna SOLO lei, mai la PiP né le altre finestre
    const mainWindows = createMainWindowManager<BrowserWindow>(createWindow)
    // P1 (fase primo-avvio): il registro di ogni finestra principale (chiave:
    // la finestra) — il primo paint di una finestra arriva al SUO registro
    const windowWatchers = new Map<BrowserWindow, WindowWatch>()
    // P1: i deps veri del registro della finestra — l'app, lo schermo di
    // Electron e i timer del main
    const toDisplay = (d: { id: number; workArea: Rect }): DisplayLike => ({ id: d.id, workArea: d.workArea })
    const windowWatchDeps: WatchDeps = {
      appHidden: () => app.isHidden(),
      displays: () => screen.getAllDisplays().map(toDisplay),
      displayMatching: (b) => toDisplay(screen.getDisplayMatching(b)),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    }
    // U6 (fase mcp-ui): la PiP del turno (chiusa esplicitamente all'uscita)
    let pip: PipManager | null = null

    function getMainWindow(): BrowserWindow | undefined {
      return mainWindows.getMainWindow()
    }

    function showMainWindow(): BrowserWindow {
      const current = getMainWindow()
      // già visibile → show() NON emette l'evento «show» (che scrive la riga e
      // mette in corsa la fotografia): la riga la scrive da qui il registro
      // della finestra (U6: la principale mostrata; P1: fotografia a 5 s)
      const alreadyVisible = current !== undefined && current.isVisible()
      const win = mainWindows.showMainWindow()
      if (alreadyVisible) windowWatchers.get(win)?.shown({ pid: process.pid })
      return win
    }

    function openAgent(agentId: string): void {
      const win = showMainWindow()
      win.webContents.send('sandbot:event', { type: 'open-agent', agentId })
    }

    // SV4 (fase schermo-vivo): l'adattatore Electron della PiP — la logica
    // (bounds, sempre-sopra, sostituzione, Esc) sta nel PipManager puro di
    // pip.ts, qui solo la finestra vera con la SICUREZZA della principale
    
/**
 * D6 (fase deleghe, SOLO TEST): openExternal FINTO — con la variabile
 * SANDBOT_TEST_OPEN_EXTERNAL_LOG il click su un link http(s) di un documento
 * REGISTRA l'URL su quel file invece di aprire il browser dell'utente (come
 * SANDBOT_TEST_OPEN per il comando `open` del daemon). La sonda lo legge e
 * verifica la CHIAMATA, mai una finestra vera.
 */
function openExternalMaybeFake(url: string): void {
  const log = process.env.SANDBOT_TEST_OPEN_EXTERNAL_LOG
  if (log) {
    try {
      appendFileSync(log, JSON.stringify({ url, at: Date.now() }) + '\n')
      return
    } catch { /* si ricade sul vero */ }
  }
  void shell.openExternal(url)
}

function createPipHandle(options: Record<string, unknown>, url: string): PipWindowHandle {
      const win = new BrowserWindow(options as ConstructorParameters<typeof BrowserWindow>[0])
      const appOrigin = process.env.ELECTRON_RENDERER_URL
        ? new URL(process.env.ELECTRON_RENDERER_URL).origin + '/'
        : 'homun://app/'
      const isAppNavigation = (u: string): boolean => {
        if (u.startsWith(appOrigin)) return true
        try {
          return new URL(u).href === new URL(appOrigin).href
        } catch {
          return false
        }
      }
      // niente finestre/popup; i link http(s) al browser esterno dopo il controllo dello schema
      win.webContents.setWindowOpenHandler(({ url: u }) => {
        if (canOpenExternally(u)) openExternalMaybeFake(u)
        return { action: 'deny' }
      })
      // la navigazione resta nell'origine dell'app (la rotta è #/pip/<bot>);
      // D6 (fase deleghe): e DENTRO l'origine solo la RADICE — l'app è una
      // SPA, nessun contenuto può ricaricarla o svuotarla
      win.webContents.on('will-navigate', (event, u) => {
        if (!isAppNavigation(u) || isSpaNavigationBlocked(u, appOrigin)) event.preventDefault()
      })
      win.webContents.on('will-redirect', (event, u) => {
        if (!isAppNavigation(u) || isSpaNavigationBlocked(u, appOrigin)) event.preventDefault()
      })
      win.webContents.on('will-attach-webview', (event) => event.preventDefault())
      void win.loadURL(url)
      return {
        on: (event, cb) => { win.on(event as 'closed', cb) },
        close: () => { win.close() },
        getBounds: () => win.getBounds(),
        setAlwaysOnTop: (flag, level) => { win.setAlwaysOnTop(flag, level as 'floating') },
        isAlwaysOnTop: () => win.isAlwaysOnTop(),
        setAspectRatio: (aspect) => { win.setAspectRatio(aspect) },
        setMinimumSize: (w, h) => { win.setMinimumSize(w, h) },
        setMaximumSize: (w, h) => { win.setMaximumSize(w, h) },
        webContents: {
          on: (event, cb) => {
            win.webContents.on(event, (_e, input) => cb(input))
          }
        }
      }
    }

    function createWindow(): BrowserWindow {
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
      // P1 (fase primo-avvio): la finestra entra nel registro del ciclo di
      // vita — caricamento della pagina, primo paint, fotografia dopo ogni show
      const watch = watchWindow(win, lifecycle, windowWatchDeps)
      windowWatchers.set(win, watch)
      // W1: la chiusura si comunica al manager (che dimentica SOLO la principale)
      // U6: la riga del registro del ciclo di vita; P1: la finestra ESCE dal registro
      win.on('closed', () => {
        mainWindows.forget(win)
        windowWatchers.delete(win)
        watch.dispose()
        lifecycle.line('window-closed')
      })
      // U6: la finestra principale creata; la riga di ogni mostra (il primo
      // show e i successivi restore/activate) la scrive il registro della finestra
      lifecycle.line('window-created')

      // A5: niente finestre/popup dal renderer; i link http(s) al browser
      // esterno SOLO dopo il controllo dello schema (mai file:, javascript:,
      // schemi personalizzati)
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (canOpenExternally(url)) openExternalMaybeFake(url)
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
      // D6 (fase deleghe): anche DENTRO l'origine dell'app solo la RADICE
      // passa — l'app è una SPA (verificato: il routing è tutto a hash #/…)
      // e nessun contenuto di un documento può ricaricare o svuotare la
      // finestra ([x](y.md) → homun://app/y.md era «Not found» bianco)
      win.webContents.on('will-navigate', (event, url) => {
        if (!isAppNavigation(url) || isSpaNavigationBlocked(url, appOrigin)) event.preventDefault()
      })
      win.webContents.on('will-redirect', (event, url) => {
        if (!isAppNavigation(url) || isSpaNavigationBlocked(url, appOrigin)) event.preventDefault()
      })
      // A5: nessun <webview>
      win.webContents.on('will-attach-webview', (event) => event.preventDefault())

      if (process.env.ELECTRON_RENDERER_URL) {
        void win.loadURL(process.env.ELECTRON_RENDERER_URL)
      } else {
        void win.loadURL('homun://app/')
      }
      return win
    }

    app.whenReady().then(async () => {
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

      // A5: la pagina dal protocollo dell'app, non da file://.
      // fase chat-limiti (CL3): /media/ serve le immagini mostrate in chat
      // dal tool show_images (cartella chat-images dei dati dell'app, nomi
      // dall'hash — il renderer non contatta mai il sito remoto)
      protocol.handle('homun', createRendererHandler(join(__dirname, '../renderer'), realFs, { dir: join(dataDir(), 'chat-images') }))

      // fase rilascio (A3): pulizia del vecchio LaunchAgent di SandBot, solo
      // quel file esatto (bootout/unload + unlink), best-effort
      void cleanupLegacyLaunchAgent(process.getuid?.()).catch(() => undefined)

      // client del daemon: lo avvia se non attivo, inoltra RPC/host API/eventi
      // P1: ogni connessione al daemon finisce nel registro del ciclo di vita
      const client = new DaemonClient({ log: lifecycle })
      // W2 (fase avvio-finestra): lo stato del caricamento (boot:status /
      // boot:retry, canali LOCALI di registerIpc): la riga «Aggiorno il
      // motore…» quando il daemon si fa sostituire per versione, e «Riprova»
      // che rifà la connessione riavviando il daemon se non c'è
      const boot = new BootStatusTracker(client)
      setDaemonRestartListener((reason) => boot.handleRestart(reason))
      client.registerHost('host.screen.scaleFactor', () => screen.getPrimaryDisplay().scaleFactor || 1)
      // K1.7 (fase rilascio — correzioni): le API ASINCRONE di safeStorage
      // (Electron 45 depreca le sincrone e avvisa nel log)
      client.registerHost('host.safeStorage.encrypt', async ([plain]) =>
        (await safeStorage.encryptStringAsync(String(plain))).toString('base64'))
      client.registerHost('host.safeStorage.decrypt', async ([b64]) =>
        await safeStorage.decryptStringAsync(Buffer.from(String(b64), 'base64')))
      // fase 5: apre il browser di sistema per l'autorizzazione OAuth dei connettori.
      // fase Composio OAuth (sonda): con SANDBOT_TEST_FAKE_BROWSER=1 (valido
      // SOLO insieme a SANDBOT_TEST_USER_DATA) l'URL si segue con fetch fino
      // al callback di loopback — il «browser finto» della sonda, mai il
      // browser vero dell'utente per un login su 127.0.0.1
      client.registerHost('host.openExternal', async ([url]) => {
        let current = String(url)
        if (!canOpenExternally(current)) throw new Error('URL non apribile')
        if (process.env.SANDBOT_TEST_FAKE_BROWSER === '1' && process.env.SANDBOT_TEST_USER_DATA) {
          for (let hop = 0; hop < 5; hop++) {
            const res = await fetch(current, { redirect: 'manual' })
            const location = res.headers.get('location')
            if (!location) return
            if (!canOpenExternally(location)) throw new Error('redirect non apribile')
            current = location
          }
          return
        }
        return shell.openExternal(current)
      })
      // SV4 (fase schermo-vivo): il gestore della PiP — una sola per volta,
      // misure ricordate in ui.pip.bounds (setting del daemon), evento `pip`
      // a tutte le finestre, «Riporta in Homun» ricrea la principale se chiusa
      // U6 (fase mcp-ui): il gestore vive qui ma il RIFERIMENTO è fuori, così
      // before-quit (registrato fuori dal whenReady) può chiuderlo
      pip = new PipManager({
        preloadPath: () => preload,
        createWindow: createPipHandle,
        urlFor: (agentId) =>
          process.env.ELECTRON_RENDERER_URL
            ? process.env.ELECTRON_RENDERER_URL + '#/pip/' + agentId
            : 'homun://app/#/pip/' + agentId,
        displays: () => screen.getAllDisplays().map((d) => ({ workArea: d.workArea })),
        homunBounds: () => {
          const b = getMainWindow()?.getBounds()
          return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
        },
        getSetting: (key, fallback) =>
          client.call('settings:get', [key, fallback]) as Promise<unknown> as Promise<typeof fallback>,
        setSetting: (key, value) => client.call('settings:set', [key, value]) as Promise<void>,
        emit: (e) => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sandbot:event', e)
        },
        focusMain: (agentId) => {
          // W1: anche «Riporta in Homun» dalla PiP passa dalla porta unica
          const win = showMainWindow()
          win.webContents.send('sandbot:event', { type: 'open-computer', agentId })
        },
        // U3: la principale non si nasconde MAI staccando — la sonda lo legge
        // da pip:state (una finestra visibile che NON sia la PiP stessa)
        mainVisible: () => {
          const wins = BrowserWindow.getAllWindows()
          return wins.length === 0 ? true : wins.some((w) => w.isVisible() && !w.webContents.getURL().includes('/pip/'))
        }
      })
      // W1 (fase avvio-finestra): le finestre per IPC (dialoghi, notifiche,
      // broadcast eventi) con la PRINCIPALE PER PRIMA — prima il ripiego
      // getAllWindows()[0] poteva dare la PiP o una finestra dell'aggiornamento
      const windowsForIpc = (): BrowserWindow[] => {
        const main = getMainWindow()
        const all = BrowserWindow.getAllWindows()
        return main ? [main, ...all.filter((w) => w !== main)] : all
      }
      registerIpc(client, windowsForIpc, pip, boot, {
        // P1: il primo paint di una finestra va al SUO registro (renderer-ready)
        firstPaint: (win) => windowWatchers.get(win)?.firstPaint()
      })
      // A8: prima di installare un aggiornamento il daemon si ferma BENE.
      // RV1 (fase beta.2): lo STESSO meccanismo dello spostamento in
      // Applicazioni (stopRunningDaemon: la RPC daemon:restart di A2 senza
      // passare dal client, che assicura la connessione e spawnerebbe) e poi
      // l'attesa dell'uscita come sempre
      setUpdaterDaemonStopper(async () => {
        try {
          await stopRunningDaemon()
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

      // OA1 (fase onboarding-a): il main NON crea più «Bot» al primo avvio —
      // il bot principale lo crea SOLO il daemon, dentro l'onboarding
      // (single-flight + adozione del «Bot» vuoto delle beta). Qui si crea la
      // finestra e basta: la UI resta in caricamento finché il daemon non
      // dice lo stato dell'onboarding.
      createWindow()
      // W1: il tray riceve la PORTA UNICA (crea la principale se manca)
      createTray(showMainWindow)
      refreshTray()

      // B1 (fase beta.4): il gancio di prova delle sonde — con
      // SANDBOT_TEST_USER_DATA + SANDBOT_TEST_UPDATE_NOTES la finestra
      // dell'offerta si apre con la versione finta e quelle note, SENZA
      // controllare GitHub (fuori dalle prove la variabile è ignorata)
      openTestUpdateWindowIfRequested()

      // deep link sandbot://agent/<id>. Fase primo-avvio: mai nelle prove con
      // l'app impacchettata (la copia di prova non prende il posto di quella vera)
      if (registersProtocolClient(process.env)) app.setAsDefaultProtocolClient('sandbot')
      app.on('open-url', (_e, url) => {
        const m = url.match(/^sandbot:\/\/agent\/([A-Za-z0-9_-]+)$/)
        if (m) openAgent(m[1])
        else showMainWindow()
      })

      // W1: dal Dock la principale torna SEMPRE — anche se esistono altre
      // finestre (PiP, aggiornamento, offscreen) che prima tenevano il conteggio
      app.on('activate', () => {
        showMainWindow()
      })

      // RV1 (fase beta.2): l'app va in Applicazioni PRIMA di avviare il daemon
      // — da fuori (o dalla copia translocata in sola lettura) Squirrel.Mac
      // non può sostituirla e il daemon staccherebbe da quel percorso. Le
      // condizioni dell'updater si decidono UNA volta (A8/K6) e si riusano
      // sotto, mai ricalcolate: test env, --dir e dev restano fuori da qui.
      const updaterEnabled = shouldAutoCheckUpdates(app.isPackaged, process.env, hasUpdateConfig())
      if (appLocationAction({
        isPackaged: app.isPackaged,
        platform: process.platform,
        inAppsFolder: app.isInApplicationsFolder(),
        updaterEnabled,
        execPath: process.execPath
      }) === 'ask-move') {
        const outcome = await proposeMoveToApplications()
        if (outcome === 'moved') {
          // Electron ha già riavviato dalla nuova posizione: questa istanza
          // sta uscendo, l'avvio non prosegue (niente daemon da qui)
          return
        }
        // «Non ora» (o spostamento non riuscito): si parte normalmente, ma
        // gli aggiornamenti restano spenti per QUESTA sessione e le
        // Impostazioni mostrano il motivo col bottone che ripropone
        setAppNeedsMove(true)
      }

      // A8: l'aggiornamento si controlla solo nell'app impacchettata e mai
      // quando ci sono variabili SANDBOT_TEST_* (le prove non toccano la rete).
      // K6: e mai quando manca app-update.yml (build --dir): niente ENOENT nel log.
      // RP3 (fase rilascio di prova): il canale (updates.channel) decide
      // allowPrerelease PRIMA del primo controllo del feed.
      // RV1: e mai finché l'app resta fuori da Applicazioni («Non ora»)
      if (updaterEnabled && !appNeedsMove()) {
        initUpdater(() =>
          client
            .call('settings:get', [UPDATE_CHANNEL_SETTING, 'stable'])
            .then((v) => parseUpdateChannel(v), () => 'stable')
        )
      }
    })

    app.on('window-all-closed', () => {
      // il daemon resta attivo: chiudere la finestra non ferma i bot (§6.2)
      if (process.platform !== 'darwin') app.quit()
    })

    // U6 (fase mcp-ui): uscita VELOCE e osservabile. Il flag d'uscita serve a
    // second-instance (un nuovo avvio mentre QUESTA copia sta uscendo →
    // relaunch, così l'utente vede comunque la finestra). Niente attese
    // inutili: il tray si DISTRUGGE, la PiP si chiude, le finestre nascoste
    // e offscreen chiudono con l'app; NESSUNA attesa sul daemon, che resta
    // acceso per scelta. La durata (before-quit → quit) finisce nel registro.
    app.on('before-quit', () => {
      quitting = true
      quitStartedAt = Date.now()
      lifecycle.line('before-quit', { windows: BrowserWindow.getAllWindows().length })
      try {
        destroyTray()
      } catch {
        // già distrutto
      }
      try {
        pip?.close()
      } catch {
        // già chiusa
      }
    })
    app.on('will-quit', () => {
      lifecycle.line('will-quit')
    })
    app.on('quit', (_e, _code) => {
      lifecycle.line('quit', { 'exit-ms': quitStartedAt ? Date.now() - quitStartedAt : undefined })
    })
  }
}
