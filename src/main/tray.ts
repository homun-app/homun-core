// Tray menubar — lista bot con unread e stato, come il tray dell'originale.
import { Tray, Menu, app, BrowserWindow, nativeImage } from 'electron'
import { listAgents } from './store/db'
import { mainStrings } from './i18n'
import { TRAY_TEMPLATE_16_PNG_BASE64, TRAY_TEMPLATE_32_PNG_BASE64 } from './tray-icon.generated'
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
  // B2 (fase beta10-correzioni): l'icona del tray è la STESSA forma dell'app
  // (variante B: quadrato arrotondato pieno, due occhi buco) in versione
  // template monocroma — 16 px + la @2x da 32, come vuole macOS. I PNG escono
  // da scripts/genera-icone.mjs partendo da build/icon.svg.
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_TEMPLATE_16_PNG_BASE64, 'base64'))
  img.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(TRAY_TEMPLATE_32_PNG_BASE64, 'base64')
  })
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
