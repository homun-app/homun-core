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
    show: () => { w.calls.push('show'); w.visible = true },
    focus: () => { calls.push('focus') },
    // P3.5: il manager la usa (Electron: isVisible). Finché non lo si dice è
    // visibile (come le finestre finte di W1); show() la rende visibile.
    visible: undefined as boolean | undefined,
    isVisible: () => w.visible !== false
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
    // (P3.6: in modalità daemon c\'è un altro gestore activate — si guarda la UI)
    const UI = MAIN_INDEX.slice(MAIN_INDEX.indexOf('// ---- modalità UI ----'))
    const activate = /app\.on\('activate'[\s\S]*?\n\s*\}\)/.exec(UI)?.[0] ?? ''
    expect(activate, 'activate senza il vecchio «solo se non ci sono finestre»').toContain('showMainWindow')
    expect(activate).not.toContain('length === 0')
    const openUrl = /app\.on\('open-url'[\s\S]*?\n\s*\}\)/.exec(UI)?.[0] ?? ''
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

// P3.5 (fase primo-avvio): l'activate del Dock RIPARA. Dalla riproduzione di
// P2: (1) la prima finestra nasceva FUORI dal manager, e ogni activate (il
// clic sul Dock) ne creava una SECONDA — 16 avvii su 16, before-quit
// windows=2; (2) alla finestra che c'è già si faceva show() e focus() e
// basta: se era invisibile, fuori schermo, o dietro le altre app, restava lì.
describe('P3.5: showMainWindow ripara la principale che non si vede', () => {
  const rig = (opts: { minimized?: boolean; visible?: boolean } = {}) => {
    let created: FakeWindow | null = null
    const front: string[] = []
    const before: string[] = []
    const m = createMainWindowManager<FakeWindow>(() => (created = fakeWindow('main', opts) as FakeWindow), {
      beforeShow: (w) => { before.push(w.name) },
      bringToFront: (w) => { front.push(w.name); w.focus() }
    })
    m.showMainWindow() // la prima creazione
    created!.calls.length = 0
    front.length = 0
    before.length = 0
    return { m, win: created!, front, before }
  }

  it('principale INVISIBILE (nascosta) → la MOSTRA e la porta davanti, senza ricrearla', () => {
    const { m, win, front } = rig()
    win.visible = false
    const via = m.showMainWindow()
    expect(via, 'la stessa finestra, non una nuova').toBe(win)
    expect(win.calls).toEqual(['show', 'focus'])
    expect(front, 'portata davanti (su macOS: app.focus({ steal: true }))').toEqual(['main'])
  })

  it('principale FUORI SCHERMO → prima si riporta (beforeShow), poi si mostra e va davanti', () => {
    const { m, win, before, front } = rig()
    m.showMainWindow()
    expect(before, 'beforeShow PRIMA di tutto: il deps vero la ricentra su uno schermo').toEqual(['main'])
    expect(front).toEqual(['main'])
    expect(win.calls[0], 'show viene dopo beforeShow').toBe('show')
  })

  it('principale visibile → nessuna ricreazione, portata davanti (il clic sul Dock quando è dietro le altre app)', () => {
    const { m, win, front } = rig()
    m.showMainWindow()
    expect(m.getMainWindow()).toBe(win)
    expect(front).toEqual(['main'])
  })

  it('finestra NUOVA che nasce NASCOSTA (show: false, P3.2): il manager NON la mostra e NON le dà il focus — la mostra la politica di mostra, che la porta davanti', () => {
    let created: FakeWindow | null = null
    const front: string[] = []
    const m = createMainWindowManager<FakeWindow>(() => {
      created = fakeWindow('nuova') as FakeWindow
      created.visible = false
      return created
    }, { bringToFront: (w) => { front.push(w.name) } })
    const win = m.showMainWindow()
    expect(win).toBe(created)
    expect(win.calls, 'nessun focus su una finestra nascosta: la mostrerebbe prima del tempo').toEqual([])
    expect(front).toEqual([])
    expect(m.getMainWindow(), 'ed è REGISTRATA: il prossimo activate la riusa, non ne crea un\'altra').toBe(win)
    // la politica l\'ha mostrata: ora il clic sul Dock la porta davanti
    win.visible = true
    m.showMainWindow()
    expect(front).toEqual(['nuova'])
  })

  it('senza isVisible (finestra finta di prima) e senza deps il manager si comporta com\'era (W1)', () => {
    const w = fakeWindow('main-vis') as FakeWindow
    ;(w as unknown as { isVisible?: unknown }).isVisible = undefined
    const m = createMainWindowManager<FakeWindow>(() => w)
    m.showMainWindow()
    expect(w.calls).toEqual(['focus'])
    w.calls.length = 0
    m.showMainWindow()
    expect(w.calls).toEqual(['show', 'focus'])
  })
})

describe('P3.5: il cablaggio — la prima finestra nasce dalla porta unica', () => {
  it('la PRIMA finestra nasce da showMainWindow (nel manager), non da createWindow diretto: l\'activate la riusa', () => {
    // sul CODICE, senza i commenti (che raccontano com'era prima)
    expect(MAIN_INDEX.replace(/\/\/.*$/gm, ''), 'nessuna chiamata diretta a createWindow() nel main').not.toMatch(/(?<!function )\bcreateWindow\(\)/)
    const ready = MAIN_INDEX.slice(MAIN_INDEX.indexOf('app.whenReady().then(async () => {'))
    expect(ready).toMatch(/showMainWindow\(\)\s*\n\s*\/\/ W1: il tray riceve la PORTA UNICA/)
  })

  it('il manager riceve i deps veri: prima del show i bounds dentro uno schermo, e il porta-davanti', () => {
    expect(MAIN_INDEX).toMatch(/createMainWindowManager<BrowserWindow>\(createWindow, \{\s*\n\s*beforeShow: ensureOnScreen,\s*\n\s*bringToFront: \(win\) => bringWindowToFront\(win, app, process\.platform\)\s*\n\s*\}\)/)
  })
})
