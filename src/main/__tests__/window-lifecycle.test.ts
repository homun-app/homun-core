// P1 (fase primo-avvio): il registro della FINESTRA — prima di correggere il
// difetto («si apre Homun e non si vede niente») il registro deve raccontare
// cosa è successo alla prima finestra. Qui la parte PURA: una BrowserWindow
// FINTA (eventi del renderer e della finestra), un registro finto e i deps
// iniettati (schermo, app, timer): niente Electron, niente processo.
// Ogni riga nuova esiste, esce dal punto giusto e porta solo flag, numeri e
// misure — mai dati dell'utente (dell'URL resta SOLO l'origine dell'app).
import { describe, expect, it } from 'vitest'
import {
  watchWindow,
  describeWindow,
  urlOriginForLog,
  WINDOW_SNAPSHOT_DELAY_MS,
  type Rect,
  type WatchDeps,
  type WatchedWindow
} from '../window-lifecycle'
import type { LifecycleLine } from '../lifecycle-log'

// ---- i finti ----

type Listener = (...args: unknown[]) => void

class FakeContents {
  private readonly listeners = new Map<string, Listener[]>()
  loading = false
  on(event: string, cb: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb])
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args)
  }
  isLoading(): boolean {
    return this.loading
  }
}

class FakeWindow implements WatchedWindow {
  private readonly listeners = new Map<string, Listener[]>()
  readonly webContents = new FakeContents()
  visible = true
  minimized = false
  focused = false
  fullscreen = false
  bounds: Rect = { x: 120, y: 63, width: 1200, height: 800 }
  on(event: string, cb: Listener): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb])
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args)
  }
  isVisible(): boolean { return this.visible }
  isMinimized(): boolean { return this.minimized }
  isFocused(): boolean { return this.focused }
  isFullScreen(): boolean { return this.fullscreen }
  getBounds(): Rect { return { ...this.bounds } }
}

/** Il registro finto: una riga «evento k=v …» per chiamata; il tempo lo muove il test. */
function fakeLog() {
  const lines: string[] = []
  let now = 0
  const log: LifecycleLine = {
    line: (event, fields = {}) => {
      const kv = Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ')}`)
        .join(' ')
      lines.push([event, kv].filter(Boolean).join(' '))
    },
    sinceBoot: () => now
  }
  return { lines, log, advance: (ms: number) => { now += ms } }
}

const MAIN_DISPLAY = { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 894 } as Rect }
const SECOND_DISPLAY = { id: 2, workArea: { x: 1512, y: 0, width: 1920, height: 1080 } as Rect }

/** I deps finti: schermo, app e timer manovrabili (nessun timer vero). */
function fakeDeps(opts: { displays?: Array<{ id: number; workArea: Rect }>; appHidden?: boolean; failDisplays?: boolean } = {}) {
  const displays = opts.displays ?? [MAIN_DISPLAY]
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let nextId = 1
  const deps: WatchDeps = {
    appHidden: () => opts.appHidden ?? false,
    displays: () => {
      if (opts.failDisplays) throw new Error('screen non disponibile')
      return displays
    },
    displayMatching: (b) => displays.find((d) => {
      const w = d.workArea
      return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
    }) ?? displays[0]!,
    setTimeout: (fn, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id)
      if (i !== -1) timers.splice(i, 1)
    }
  }
  return {
    deps,
    advance: (ms: number) => {
      now += ms
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now && timers.includes(t)) {
          timers.splice(timers.indexOf(t), 1)
          t.fn()
        }
      }
    },
    pending: () => timers.length
  }
}

const SNAPSHOT_OK =
  'window-snapshot ms=5300 visible=true minimized=false focused=false fullscreen=false ' +
  'bounds=120,63,1200x800 display=1 work-area=0,25,1512x894 displays=1 inside=true ' +
  'app-hidden=false loading=false renderer-ready=false'

// ---- le parti pure ----

describe('P1: urlOriginForLog — dell\'URL resta solo l\'origine dell\'app', () => {
  it('dell\'origine dell\'app resta homun://app/ (mai percorso, query o frammento)', () => {
    expect(urlOriginForLog('homun://app/')).toBe('homun://app/')
    expect(urlOriginForLog('homun://app/assets/index-C3f2b1.js?v=9f21#frag')).toBe('homun://app/')
  })

  it('qualsiasi altra cosa diventa «other»: niente host, percorsi o token nel registro', () => {
    expect(urlOriginForLog('https://utente.example/via/di/casa?token=segreto')).toBe('other')
    expect(urlOriginForLog('file:///Users/test/Documenti/x.html')).toBe('other')
    expect(urlOriginForLog('homun://altro/x')).toBe('other')
    expect(urlOriginForLog('non è un url')).toBe('other')
  })

  it('il dev server locale (127.0.0.1 / localhost) tiene la sua origine: non ha dati dell\'utente', () => {
    expect(urlOriginForLog('http://127.0.0.1:5173/src/main.tsx')).toBe('http://127.0.0.1:5173/')
    expect(urlOriginForLog('http://localhost:5173/')).toBe('http://localhost:5173/')
  })
})

describe('P1: describeWindow — la fotografia della finestra (pura)', () => {
  it('un solo elenco chiave=valore: flag, bounds, display che la contiene, numero di display, app, caricamento, renderer pronto', () => {
    const win = new FakeWindow()
    win.webContents.loading = true
    const fields = describeWindow(win, { rendererReady: true }, fakeDeps().deps)
    expect(fields).toEqual({
      visible: true,
      minimized: false,
      focused: false,
      fullscreen: false,
      bounds: '120,63,1200x800',
      display: 1,
      'work-area': '0,25,1512x894',
      displays: 1,
      inside: true,
      'app-hidden': false,
      loading: true,
      'renderer-ready': true
    })
  })

  it('i flag vengono dalla finestra e dall\'app: minimizzata, a tutto schermo, con l\'app nascosta', () => {
    const win = new FakeWindow()
    win.minimized = true
    win.focused = true
    win.fullscreen = true
    const f = describeWindow(win, { rendererReady: false }, fakeDeps({ appHidden: true }).deps)
    expect(f.minimized).toBe(true)
    expect(f.focused).toBe(true)
    expect(f.fullscreen).toBe(true)
    expect(f['app-hidden']).toBe(true)
  })

  it('il display che la contiene è quello indicato dallo schermo; con due display si dice quanti sono', () => {
    const win = new FakeWindow()
    win.bounds = { x: 1600, y: 100, width: 800, height: 600 }
    const f = describeWindow(win, { rendererReady: false }, fakeDeps({ displays: [MAIN_DISPLAY, SECOND_DISPLAY] }).deps)
    expect(f.display).toBe(2)
    expect(f['work-area']).toBe('1512,0,1920x1080')
    expect(f.displays).toBe(2)
    expect(f.inside).toBe(true)
  })

  it('fuori dalla workArea di ogni display: inside=false (resta il display più vicino)', () => {
    const win = new FakeWindow()
    win.bounds = { x: -3000, y: -2000, width: 1200, height: 800 }
    const f = describeWindow(win, { rendererReady: false }, fakeDeps().deps)
    expect(f.inside).toBe(false)
    expect(f.display).toBe(1)
  })

  it('i bounds non intersecano nemmeno per un pixel: dentro il margine del Dock (workArea, non bounds)', () => {
    const win = new FakeWindow()
    win.bounds = { x: 0, y: 0, width: 400, height: 20 } // tutta nella barra dei menu (sopra la workArea)
    const f = describeWindow(win, { rendererReady: false }, fakeDeps().deps)
    expect(f.inside).toBe(false)
  })
})

// ---- il registro della finestra ----

describe('P1: watchWindow — le righe del renderer e della finestra, con i ms dall\'avvio', () => {
  it('did-start-loading, dom-ready e did-finish-load: una riga ciascuno con i ms dal boot', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    watchWindow(win, l.log, fakeDeps().deps)
    l.advance(120)
    win.webContents.emit('did-start-loading')
    l.advance(220)
    win.webContents.emit('dom-ready')
    l.advance(70)
    win.webContents.emit('did-finish-load')
    expect(l.lines).toEqual(['did-start-loading ms=120', 'dom-ready ms=340', 'did-finish-load ms=410'])
  })

  it('did-fail-load: codice, descrizione, se è il frame principale e SOLO l\'origine (mai l\'URL intero)', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    watchWindow(win, l.log, fakeDeps().deps)
    l.advance(250)
    win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'homun://app/assets/index-C3f2b1.js', true)
    l.advance(100)
    win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://sito.example/pagina?token=segreto', false)
    expect(l.lines).toEqual([
      'did-fail-load ms=250 code=-105 desc=ERR_NAME_NOT_RESOLVED main=true origin=homun://app/',
      'did-fail-load ms=350 code=-3 desc=ERR_ABORTED main=false origin=other'
    ])
    expect(l.lines.join('\n')).not.toMatch(/assets|token|sito\.example/)
  })

  it('render-process-gone con il motivo (e il codice d\'uscita)', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    watchWindow(win, l.log, fakeDeps().deps)
    l.advance(900)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 })
    expect(l.lines).toEqual(['render-process-gone ms=900 reason=crashed exit=11'])
  })

  it('unresponsive e responsive', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    watchWindow(win, l.log, fakeDeps().deps)
    l.advance(5000)
    win.webContents.emit('unresponsive')
    l.advance(2000)
    win.webContents.emit('responsive')
    expect(l.lines).toEqual(['unresponsive ms=5000', 'responsive ms=7000'])
  })

  it('ready-to-show con i ms', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    watchWindow(win, l.log, fakeDeps().deps)
    l.advance(300)
    win.emit('ready-to-show')
    expect(l.lines).toEqual(['ready-to-show ms=300'])
  })
})

describe('P1: watchWindow — la fotografia 5 s dopo ogni window-shown', () => {
  it('shown() scrive window-shown e, 5 s dopo, UNA riga sola con la fotografia', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps()
    win.webContents.loading = true
    const watch = watchWindow(win, l.log, d.deps)
    l.advance(300)
    watch.shown({ pid: 4242 })
    expect(l.lines).toEqual(['window-shown ms=300 pid=4242'])
    expect(d.pending(), 'la fotografia è in attesa').toBe(1)
    l.advance(WINDOW_SNAPSHOT_DELAY_MS - 1)
    d.advance(WINDOW_SNAPSHOT_DELAY_MS - 1)
    expect(l.lines, 'a 4999 ms ancora niente').toHaveLength(1)
    l.advance(1)
    d.advance(1)
    expect(l.lines).toHaveLength(2)
    expect(l.lines[1]).toBe(SNAPSHOT_OK.replace('loading=false', 'loading=true'))
    expect(d.pending(), 'il timer è scaduto: niente resta appeso').toBe(0)
  })

  it('la fotografia racconta la finestra com\'è: app nascosta e renderer che ha già segnalato', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps({ appHidden: true })
    const watch = watchWindow(win, l.log, d.deps)
    l.advance(200)
    watch.firstPaint()
    watch.shown()
    l.advance(WINDOW_SNAPSHOT_DELAY_MS)
    d.advance(WINDOW_SNAPSHOT_DELAY_MS)
    expect(l.lines).toEqual([
      'renderer-ready ms=200',
      'window-shown ms=200',
      'window-snapshot ms=5200 visible=true minimized=false focused=false fullscreen=false bounds=120,63,1200x800 display=1 work-area=0,25,1512x894 displays=1 inside=true app-hidden=true loading=false renderer-ready=true'
    ])
  })

  it('lo stato si legge AL momento della fotografia, non quando si mostra', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps()
    const watch = watchWindow(win, l.log, d.deps)
    watch.shown()
    l.advance(1000)
    d.advance(1000)
    win.minimized = true
    win.visible = false
    watch.firstPaint()
    l.advance(4000)
    d.advance(4000)
    expect(l.lines.at(-1)).toBe(
      'window-snapshot ms=5000 visible=false minimized=true focused=false fullscreen=false bounds=120,63,1200x800 display=1 work-area=0,25,1512x894 displays=1 inside=true app-hidden=false loading=false renderer-ready=true'
    )
  })

  it('un\'altra window-shown prima dei 5 s RIMPIAZZA la fotografia (una pendente per finestra, non una per riga)', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps()
    const watch = watchWindow(win, l.log, d.deps)
    watch.shown()
    l.advance(2000)
    d.advance(2000)
    watch.shown()
    expect(d.pending()).toBe(1)
    l.advance(2999)
    d.advance(2999)
    expect(l.lines.filter((x) => x.startsWith('window-snapshot'))).toEqual([])
    l.advance(2001)
    d.advance(2001)
    expect(l.lines.filter((x) => x.startsWith('window-snapshot'))).toEqual(['window-snapshot ms=7000 visible=true minimized=false focused=false fullscreen=false bounds=120,63,1200x800 display=1 work-area=0,25,1512x894 displays=1 inside=true app-hidden=false loading=false renderer-ready=false'])
  })

  it('ogni mostra VERA della finestra (evento show) scrive window-shown e programma la fotografia', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps()
    watchWindow(win, l.log, d.deps)
    l.advance(80)
    win.emit('show')
    expect(l.lines).toEqual(['window-shown ms=80'])
    expect(d.pending()).toBe(1)
    l.advance(200)
    d.advance(200)
    win.emit('show') // il sistema la mostra di nuovo (per esempio dopo un minimize)
    expect(l.lines).toEqual(['window-shown ms=80', 'window-shown ms=280'])
    expect(d.pending(), 'una fotografia pendente per finestra, mai una per riga').toBe(1)
    l.advance(WINDOW_SNAPSHOT_DELAY_MS)
    d.advance(WINDOW_SNAPSHOT_DELAY_MS)
    expect(l.lines.filter((x) => x.startsWith('window-snapshot'))).toEqual(['window-snapshot ms=5280 visible=true minimized=false focused=false fullscreen=false bounds=120,63,1200x800 display=1 work-area=0,25,1512x894 displays=1 inside=true app-hidden=false loading=false renderer-ready=false'])
  })

  it('shown() quando show() non emette l\'evento (finestra già visibile): la riga coi campi dati e la fotografia', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps()
    const watch = watchWindow(win, l.log, d.deps)
    l.advance(700)
    watch.shown({ pid: 72678 })
    expect(l.lines).toEqual(['window-shown ms=700 pid=72678'])
    expect(d.pending()).toBe(1)
    l.advance(WINDOW_SNAPSHOT_DELAY_MS)
    d.advance(WINDOW_SNAPSHOT_DELAY_MS)
    expect(l.lines).toHaveLength(2)
    expect(l.lines[1]!.startsWith('window-snapshot ms=5700 ')).toBe(true)
  })

  it('se lo schermo non risponde la fotografia esce lo stesso (con error=1), mai un\'eccezione nel main', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps({ failDisplays: true })
    const watch = watchWindow(win, l.log, d.deps)
    watch.shown()
    l.advance(WINDOW_SNAPSHOT_DELAY_MS)
    expect(() => d.advance(WINDOW_SNAPSHOT_DELAY_MS)).not.toThrow()
    expect(l.lines[1]).toBe('window-snapshot ms=5000 error=1')
  })

  it('dispose() (finestra chiusa): niente timer appesi e niente altre righe', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const d = fakeDeps()
    const watch = watchWindow(win, l.log, d.deps)
    watch.shown()
    expect(d.pending()).toBe(1)
    watch.dispose()
    expect(d.pending()).toBe(0)
    l.advance(WINDOW_SNAPSHOT_DELAY_MS)
    d.advance(WINDOW_SNAPSHOT_DELAY_MS)
    win.emit('ready-to-show')
    win.webContents.emit('dom-ready')
    watch.firstPaint()
    watch.shown()
    expect(l.lines).toEqual(['window-shown ms=0'])
  })
})

describe('P3.4: watchWindow — gli eventi del renderer arrivano al cane da guardia (hooks)', () => {
  it('did-finish-load, did-fail-load (col «è il frame principale») e render-process-gone', () => {
    const win = new FakeWindow()
    const seen: string[] = []
    watchWindow(win, fakeLog().log, fakeDeps().deps, {
      didFinishLoad: () => { seen.push('finish') },
      didFailLoad: (main) => { seen.push(`fail:${main}`) },
      renderProcessGone: () => { seen.push('gone') }
    })
    win.webContents.emit('did-start-loading')
    win.webContents.emit('did-finish-load')
    win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'homun://app/', false)
    win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'homun://app/', true)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(seen).toEqual(['finish', 'fail:false', 'fail:true', 'gone'])
  })

  it('dopo dispose() (finestra chiusa) gli hooks non scattano più: una finestra morta non fa ricaricare niente', () => {
    const win = new FakeWindow()
    const seen: string[] = []
    const watch = watchWindow(win, fakeLog().log, fakeDeps().deps, {
      didFinishLoad: () => { seen.push('finish') },
      didFailLoad: () => { seen.push('fail') },
      renderProcessGone: () => { seen.push('gone') }
    })
    watch.dispose()
    win.webContents.emit('did-finish-load')
    win.webContents.emit('did-fail-load', {}, -105, 'x', 'homun://app/', true)
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(seen).toEqual([])
  })

  it('firstPaint(false): renderer-ready con frame=0 — React ha montato, ma la pagina era nascosta (nessun frame)', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const watch = watchWindow(win, l.log, fakeDeps().deps)
    watch.firstPaint(false)
    expect(l.lines).toEqual(['renderer-ready ms=0 frame=0'])
    expect(watch.rendererReady()).toBe(true)
  })
})

describe('P1: watchWindow — il primo segnale dal renderer', () => {
  it('firstPaint() scrive renderer-ready ms=… UNA volta sola per finestra', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const watch = watchWindow(win, l.log, fakeDeps().deps)
    expect(watch.rendererReady(), 'prima del segnale: mai pronto').toBe(false)
    l.advance(480)
    watch.firstPaint()
    watch.firstPaint() // (StrictMode in sviluppo manda due segnali)
    l.advance(50)
    watch.firstPaint()
    expect(l.lines).toEqual(['renderer-ready ms=480'])
    expect(watch.rendererReady()).toBe(true)
  })

  it('renderer-ready sopravvive a un reload della pagina (il renderer HA segnalato, una volta)', () => {
    const win = new FakeWindow()
    const l = fakeLog()
    const watch = watchWindow(win, l.log, fakeDeps().deps)
    watch.firstPaint()
    l.advance(10)
    win.webContents.emit('did-start-loading')
    expect(watch.rendererReady()).toBe(true)
  })

  it('un\'altra finestra ha il SUO stato: il paint di una non segna l\'altra', () => {
    const a = new FakeWindow()
    const b = new FakeWindow()
    const l = fakeLog()
    const wa = watchWindow(a, l.log, fakeDeps().deps)
    const wb = watchWindow(b, l.log, fakeDeps().deps)
    wa.firstPaint()
    expect(wa.rendererReady()).toBe(true)
    expect(wb.rendererReady()).toBe(false)
  })
})
