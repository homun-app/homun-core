// W1 (fase avvio-finestra): riaprire dal Dock o rilanciare l'app deve mostrare
// SEMPRE la finestra principale. Prima il main la ricreava solo se
// BrowserWindow.getAllWindows().length === 0 — ma la PiP, le finestre
// dell'aggiornamento e quella offscreen di ipc.ts:423 tengono il conto > 0, e
// second-instance faceva show() di TUTTE (PiP nascosta compresa) senza ricreare
// la principale. Qui: UNA funzione sola (showMainWindow del manager puro di
// main-window.ts), il wiring di index.ts come guardia sul sorgente (come
// no-main-create-agent), il tray che riceve la STESSA porta.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMainWindowManager, type MainWindowLike } from '../main-window'

const MAIN_INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
const TRAY_SRC = readFileSync(fileURLToPath(new URL('../tray.ts', import.meta.url)), 'utf8')

/** Un BrowserWindow FINTO (per activate/second-instance) che registra tutto. */
function fakeWindow(name: string, opts: { minimized?: boolean } = {}) {
  const calls: string[] = []
  const w = {
    name,
    destroyed: false,
    minimized: opts.minimized ?? false,
    calls,
    isDestroyed: () => w.destroyed,
    isMinimized: () => w.minimized,
    restore: () => { w.minimized = false; calls.push('restore') },
    show: () => { calls.push('show') },
    focus: () => { calls.push('focus') }
  }
  return w
}
type FakeWindow = ReturnType<typeof fakeWindow> & MainWindowLike

describe('W1: showMainWindow() — una funzione sola, sul main con BrowserWindow finto', () => {
  it('principale chiusa (con una PiP viva altrove) → showMainWindow la CREA e la porta in primo piano', () => {
    const pip = fakeWindow('pip') as FakeWindow // viva, ma IL MANAGER NON LA VEDE
    const created: FakeWindow[] = []
    const m = createMainWindowManager<FakeWindow>(() => {
      const w = fakeWindow('main-' + created.length) as FakeWindow
      created.push(w)
      return w
    })
    const first = m.showMainWindow()
    m.forget(first) // l'utente chiude la principale (la PiP resta viva)
    expect(m.getMainWindow(), 'la principale chiusa non si trova più').toBeUndefined()
    const second = m.showMainWindow() // activate / second-instance
    expect(created, 'la principale è stata ricreata').toHaveLength(2)
    expect(second).toBe(created[1])
    expect(second.calls, 'la finestra NUOVA viene a fuoco (nuova = già visibile)').toEqual(['focus'])
    expect(m.getMainWindow()).toBe(second)
    expect(pip.calls, 'la PiP non viene toccata da showMainWindow').toEqual([])
  })

  it('principale chiusa → second-instance crea la principale: il gestore passa SOLO da showMainWindow', () => {
    const src = MAIN_INDEX
    const handler = /app\.on\('second-instance'[\s\S]*?\n\s*\}\)/.exec(src)?.[0] ?? ''
    expect(handler, 'il gestore second-instance esiste').toContain('showMainWindow')
    expect(handler, 'second-instance non mostra più le altre finestre (PiP, aggiornamento, offscreen)')
      .not.toContain('getAllWindows')
  })

  it('principale minimizzata → restore() + show() + focus(), in quest\'ordine (senza ricreare)', () => {
    let created: FakeWindow | null = null
    const m = createMainWindowManager<FakeWindow>(() => (created = fakeWindow('main') as FakeWindow))
    m.showMainWindow() // prima creazione (la finestra nasce visibile)
    const win = created!
    win.minimized = true // l'utente l'ha minimizzata
    win.calls.length = 0
    const viaActivate = m.showMainWindow()
    expect(viaActivate, 'la finestra minimizzata si RIUSA, non si ricrea').toBe(win)
    expect(win.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('principale visibile → show() + focus() SENZA restore()', () => {
    const w = fakeWindow('main-vis') as FakeWindow
    const m = createMainWindowManager<FakeWindow>(() => w)
    m.showMainWindow() // prima creazione (la finestra nasce visibile)
    w.calls.length = 0
    m.showMainWindow() // activate/second-instance con la finestra già visibile
    expect(w.calls).toEqual(['show', 'focus'])
  })

  it('principale DISTRUTTA → getMainWindow() undefined e showMainWindow ricrea', () => {
    const created: FakeWindow[] = []
    const m = createMainWindowManager<FakeWindow>(() => {
      const w = fakeWindow('main-' + created.length) as FakeWindow
      created.push(w)
      return w
    })
    const first = m.showMainWindow()
    first.destroyed = true
    expect(m.getMainWindow(), 'una finestra distrutta non è più la principale').toBeUndefined()
    expect(m.showMainWindow()).toBe(created[1])
  })

  it('getMainWindow() non torna MAI la PiP: niente ripiego su getAllWindows', () => {
    const fn = /function getMainWindow\(\): BrowserWindow \| undefined \{[\s\S]*?\n    \}/.exec(MAIN_INDEX)?.[0] ?? ''
    expect(fn, 'getMainWindow esiste nel main').toContain('mainWindows.getMainWindow()')
    expect(fn, 'il corpo di getMainWindow non guarda MAI le altre finestre').not.toContain('getAllWindows')
  })

  it('activate, open-url senza agente e openAgent passano da showMainWindow', () => {
    const activate = /app\.on\('activate'[\s\S]*?\n\s*\}\)/.exec(MAIN_INDEX)?.[0] ?? ''
    expect(activate, 'activate senza il vecchio «solo se non ci sono finestre»').toContain('showMainWindow')
    expect(activate).not.toContain('length === 0')
    const openUrl = /app\.on\('open-url'[\s\S]*?\n\s*\}\)/.exec(MAIN_INDEX)?.[0] ?? ''
    expect(openUrl, 'open-url senza agente → showMainWindow').toMatch(/else\s*\{?\s*showMainWindow\(\)/)
    const openAgent = /function openAgent[\s\S]*?\n    \}/.exec(MAIN_INDEX)?.[0] ?? ''
    expect(openAgent, 'openAgent mostra la finestra PRIMA di mandare l\'evento').toContain('showMainWindow')
  })

  it('il tray «Apri Homun» (e il clic su un bot) usa la STESSA porta: crea se manca', () => {
    expect(TRAY_SRC, 'createTray riceve la funzione che mostra (e ricrea) la principale').toMatch(/createTray\(openMain/)
    expect(TRAY_SRC, 'il clic su un bot passa dalla stessa porta').toMatch(/const win = openMain\(\)/)
    expect(MAIN_INDEX, 'il main passa showMainWindow al tray').toMatch(/createTray\(showMainWindow\)/)
    expect(TRAY_SRC, 'via il vecchio w?.show() del tray').not.toMatch(/w\?\.show\(\)/)
  })
})
