// Tray menubar — lista bot con unread e stato, come il tray dell'originale.
import { Tray, Menu, app, BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { listAgents } from './store/db'
import { mainStrings } from './i18n'
import type { AgentStatus } from '../shared/types'

const statusGlyph: Record<AgentStatus, string> = {
  offline: '○',
  idle: '●',
  thinking: '◐',
  running: '◑',
  'paused-for-approval': '⚠'
}

let tray: Tray | null = null
let getWindow: () => BrowserWindow | undefined = () => undefined

function icon(): Electron.NativeImage {
  // icona minimale 16x16 disegnata a runtime (nessuna risorsa da embeddere)
  const img = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmklEQVR4nKWTwQ3DIAxFn9k/pM5QhWi' +
      'dITN0A5jZwdKFlFBCQkrpaP/8SccHOpN7nZk3b+oBIBJAIAmBQEwmzQQ2msaYSa2U0rhBRBdIk6Zp' +
      'SssGWmeMMeustFoBoChKAZqmnWarRSIi2gOstcbK6QNTNB3HcbRNK5xtWyedgU2n0wCoC0LUdZ2Q' +
      'Pj0kSRL0+wOSSqUih8NhBEHwn4TNZvOfO1nvP4aNCwAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  img.setTemplateImage(true)
  return img
}

export function refreshTray(): void {
  if (!tray) return
  const agents = listAgents()
  const items = agents.map((a) => ({
    label: `${a.unread > 0 ? '● ' : ''}${a.name} ${statusGlyph[a.status] ?? ''}`.trim(),
    click: () => {
      const win = getWindow()
      if (win) {
        win.show()
        win.focus()
        win.webContents.send('sandbot:event', { type: 'open-agent', agentId: a.id })
      }
    }
  }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...items,
      { type: 'separator' as const },
      // fase 17a: i testi del tray nella lingua attiva del main
      { label: mainStrings().tray.open, click: () => { const w = getWindow(); w?.show(); w?.focus() } },
      { label: mainStrings().tray.quit, click: () => app.quit() }
    ])
  )
  tray.setToolTip(mainStrings().tooltip)
}

export function createTray(getMainWindow: () => BrowserWindow | undefined): void {
  getWindow = getMainWindow
  tray = new Tray(icon())
  tray.setToolTip('Homun')
  refreshTray()
}
