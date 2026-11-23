// P1 (fase primo-avvio): le guardie del CABLAGGIO delle righe nuove. Le
// funzioni pure (window-lifecycle, lifecycle-log, log-timestamp, il client)
// si provano nei loro test con finti; qui si controlla che il main le
// colleghi DAVVERO nei punti giusti, leggendo i sorgenti come testo (come
// quit-wiring e no-main-create-agent): la finestra osservata dal registro, il
// primo paint che arriva dal renderer fino al registro, il client che scrive
// le connessioni, gli orari nel daemon.log PRIMA della prima riga del daemon.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const INDEX = read('../index.ts')
const IPC = read('../ipc.ts')
const PRELOAD = read('../../preload/index.ts')
const TYPES = read('../../shared/types.ts')
const DAEMON_ENTRY = read('../../daemon/index.ts')

describe('P1: la finestra principale è osservata dal registro (createWindow)', () => {
  const createWindow = INDEX.slice(INDEX.indexOf('function createWindow(): BrowserWindow {'), INDEX.indexOf("app.whenReady().then(async () => {"))

  it('appena nata la finestra entra nel registro del ciclo di vita (watchWindow), prima di caricare la pagina', () => {
    expect(createWindow).toMatch(/const watch = watchWindow\(win, lifecycle, windowWatchDeps\)/)
    expect(createWindow).toMatch(/windowWatchers\.set\(win, watch\)/)
    expect(createWindow.indexOf('watchWindow(win'), 'PRIMA del loadURL').toBeLessThan(createWindow.indexOf('win.loadURL('))
  })

  it('alla chiusura la finestra ESCE dal registro (niente righe né timer di una finestra morta)', () => {
    const closed = /win\.on\('closed'[\s\S]*?\n      \}\)/.exec(createWindow)?.[0] ?? ''
    expect(closed).toContain('mainWindows.forget(win)')
    expect(closed).toContain('windowWatchers.delete(win)')
    expect(closed).toContain('watch.dispose()')
    expect(closed).toContain("lifecycle.line('window-closed')")
  })

  it('ogni mostra vera scrive window-shown dall\'evento show della finestra (window-lifecycle.ts)', () => {
    const watch = read('../window-lifecycle.ts')
    expect(watch).toContain("win.on('show'")
    expect(watch).toMatch(/line\('window-shown', fields\)/)
  })

  it('la porta unica scrive la riga SOLO quando show() non emette l\'evento (finestra già visibile): mai due righe per una mostra', () => {
    const show = /function showMainWindow\(\): BrowserWindow \{[\s\S]*?\n    \}/.exec(INDEX)?.[0] ?? ''
    expect(show).toContain('mainWindows.showMainWindow()')
    expect(show).toMatch(/const alreadyVisible = .*\.isVisible\(\)/)
    expect(show).toMatch(/if \(alreadyVisible\) windowWatchers\.get\(win\)\?\.shown\(\{ pid: process\.pid \}\)/)
    expect(show, 'la riga diretta è sostituita dal registro della finestra').not.toContain("lifecycle.line('window-shown'")
  })

  it('i deps veri: app.isHidden(), lo schermo di Electron (display e quella che contiene), i timer del main', () => {
    expect(INDEX).toMatch(/appHidden: \(\) => app\.isHidden\(\)/)
    expect(INDEX).toMatch(/displays: \(\) => screen\.getAllDisplays\(\)/)
    expect(INDEX).toMatch(/displayMatching: .*screen\.getDisplayMatching\(/)
  })
})

describe('P1: il primo paint dal renderer arriva al registro', () => {
  it('il preload espone firstPaint → l\'IPC locale app:first-paint (non un\'RPC al daemon)', () => {
    expect(PRELOAD).toContain("firstPaint: () => ipcRenderer.invoke('app:first-paint')")
    expect(TYPES).toMatch(/firstPaint\(\): Promise<\{ ok: true \}>/)
  })

  it('il main gestisce app:first-paint e lo porta alla finestra che l\'ha mandato (event.sender)', () => {
    expect(IPC).toContain("ipcMain.handle('app:first-paint'")
    const handler = /ipcMain\.handle\('app:first-paint'[\s\S]*?\n  \}\)/.exec(IPC)?.[0] ?? ''
    expect(handler).toContain('BrowserWindow.fromWebContents(e.sender)')
    expect(handler).toContain('firstPaint(win)')
  })

  it('index.ts dà a registerIpc la porta del registro: dalla finestra al SUO firstPaint', () => {
    const call = /registerIpc\(client, windowsForIpc, pip, boot, \{[\s\S]*?\}\)/.exec(INDEX)?.[0] ?? ''
    expect(call).toMatch(/firstPaint: \(win\) => windowWatchers\.get\(win\)\?\.firstPaint\(\)/)
  })
})

describe('P1: le connessioni al daemon e gli orari nel daemon.log', () => {
  it('il client della UI scrive nel registro del ciclo di vita (log: il registro, per le righe e i ms dall\'avvio)', () => {
    expect(INDEX).toMatch(/new DaemonClient\(\{ log: lifecycle \}\)/)
  })

  it('in modalità daemon gli orari si installano PRIMA della riga di boot (nessuna riga [sandbotd] senza orario)', () => {
    const daemon = INDEX.slice(INDEX.indexOf('if (isDaemonMode(process.argv)) {'), INDEX.indexOf('} else {', INDEX.indexOf('if (isDaemonMode(process.argv)) {')))
    expect(daemon).toContain('installDaemonLogTimestamps()')
    expect(daemon.indexOf('installDaemonLogTimestamps()')).toBeLessThan(daemon.indexOf("daemonLog.line('boot'"))
  })

  it('anche l\'entry Node del daemon (sviluppo e sonde storiche) mette gli orari prima di partire', () => {
    const at = DAEMON_ENTRY.indexOf('installDaemonLogTimestamps()')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(DAEMON_ENTRY.indexOf('runDaemonRuntime({'))
  })
})
