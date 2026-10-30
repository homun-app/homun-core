// Main Electron: solo UI. Il runtime degli agenti (loop, coda durevole,
// scheduler, sandbox, MCP) vive nel daemon sandbotd — avviato qui sotto se
// non è già attivo e riusato se lo è (LaunchAgent o avvio precedente). La
// finestra chiusa non ferma più i bot: il main inoltra RPC ed eventi.
import { app, BrowserWindow, safeStorage, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc, emitLocal } from './ipc'
import { setDataDir, listAgents, createAgent } from './store/db'
import { createTray, refreshTray } from './tray'
import { initMainLanguage } from './i18n'
import { DaemonClient } from './daemon-client'
import { userDataDir } from './paths'

// fase 16 (U0b): la cartella dati reale dell'utente è …/Application
// Support/sandbot (minuscolo), di prima del cambio di nome visibile in
// "Homun". Va fissata PRIMA di app.whenReady() e di ogni getPath('userData'),
// altrimenti Electron ricaverebbe …/Homun e l'utente ritroverebbe l'app vuota.
app.setPath('userData', userDataDir(app.getName(), app.getPath('appData')))

// con "type": "module" electron-vite emette il preload come .mjs (ESM, richiede sandbox:false)
const preloadPath = join(__dirname, '../preload/index.mjs')
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
      sandbox: false
    }
  })
  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // fase 17a (L5): la lingua del main (tray, notifiche native) dalle
  // lingue preferite di sistema; cambierà col setting via IPC
  initMainLanguage()
  // il path dati è quello storico dell'app (userData/data): app e daemon
  // condividono lo stesso store
  setDataDir(join(app.getPath('userData'), 'data'))

  // client del daemon: lo avvia se non attivo, inoltra RPC/host API/eventi
  const client = new DaemonClient()
  client.registerHost('host.screen.scaleFactor', () => screen.getPrimaryDisplay().scaleFactor || 1)
  client.registerHost('host.safeStorage.encrypt', ([plain]) =>
    safeStorage.encryptString(String(plain)).toString('base64'))
  client.registerHost('host.safeStorage.decrypt', ([b64]) =>
    safeStorage.decryptString(Buffer.from(String(b64), 'base64')))
  // fase 5: apre il browser di sistema per l'autorizzazione OAuth dei connettori
  client.registerHost('host.openExternal', ([url]) => shell.openExternal(String(url)))
  registerIpc(client, () => BrowserWindow.getAllWindows())
  void client.start().catch((e) => console.error('[sandbot] daemon non avviabile:', e))

  if (listAgents().length === 0) {
    // primo avvio: agente principale, come il "Bot principale" dell'originale
    createAgent('Bot', 'Il mio assistente personale sempre attivo.')
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
})

app.on('window-all-closed', () => {
  // il daemon resta attivo: chiudere la finestra non ferma i bot (§6.2)
  if (process.platform !== 'darwin') app.quit()
})
