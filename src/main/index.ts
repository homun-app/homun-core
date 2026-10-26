import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { createAgent, listAgents } from './store/db'
import { createTray, refreshTray } from './tray'

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

// autodiscovery dei provider locali (Ollama/LM Studio) silenziosa al boot
async function autoDiscover(): Promise<void> {
  const p = await import('./agent/providers')
  await p.discoverProviders().catch(() => undefined)
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
  registerIpc()
  void autoDiscover()
  if (listAgents().length === 0) {
    // primo avvio: agente principale, come il "Bot principale" dell'originale
    createAgent('Bot', 'Il mio assistente personale sempre attivo.')
  }
  createWindow()
  createTray(getMainWindow)

  // deep link sandbot://agent/<id>
  app.setAsDefaultProtocolClient('sandbot')
  app.on('open-url', (_e, url) => {
    const m = url.match(/^sandbot:\/\/agent\/([A-Za-z0-9_-]+)$/)
    if (m) openAgent(m[1])
    else { getMainWindow()?.show(); getMainWindow()?.focus() }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
