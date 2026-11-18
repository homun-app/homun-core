// SV4 (fase schermo-vivo) — la finestra PiP: una BrowserWindow del MAIN,
// sempre sopra (floating, tutti gli spazi), rapporto 16:10, minimo 240 e
// massimo 960, sicurezza UGUALE alla finestra principale, una sola per volta,
// misure ricordate in ui.pip.bounds e riportate dentro gli schermi. Qui si
// testano le parti PURE (opzioni, bounds) e il manager con la finestra FINTA
// (tutte le dipendenze iniettate: nessuna importazione di Electron).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  pipWindowOptions,
  defaultPipBounds,
  pipBoundsWithin,
  PipManager,
  PIP_MIN_WIDTH,
  PIP_MAX_WIDTH,
  PIP_ASPECT,
  type PipRect,
  type PipWindowHandle
} from '../pip'

const WORK: PipRect = { x: 0, y: 0, width: 1000, height: 800 }
const DISPLAYS = [{ workArea: WORK }]

// ---- le parti pure ----

describe('SV4: le opzioni della finestra PiP (sicurezza come la principale)', () => {
  it('senza cornice, angoli arrotondati, ombra, rapportata 16:10, minimo 240 e massimo 960', () => {
    const o = pipWindowOptions('/path/preload.cjs', { x: 10, y: 20, width: 360, height: 225 })
    expect(o.frame).toBe(false)
    expect(o.roundedCorners).toBe(true)
    expect(o.hasShadow).toBe(true)
    expect(o.resizable).toBe(true)
    expect(o.useContentSize).toBe(true)
    expect(o.minWidth).toBe(PIP_MIN_WIDTH)
    expect(o.maxWidth).toBe(PIP_MAX_WIDTH)
    expect(PIP_ASPECT).toBeCloseTo(1.6, 5)
    expect(o.x).toBe(10)
    expect(o.y).toBe(20)
    expect(o.width).toBe(360)
    expect(o.height).toBe(225)
  })

  it('sicurezza UGUALE alla finestra principale: stesso preload, isolation, niente node, sandbox, niente webview', () => {
    const o = pipWindowOptions('/path/preload.cjs', { x: 0, y: 0, width: 360, height: 225 })
    const wp = o.webPreferences as Record<string, unknown>
    expect(wp.preload).toBe('/path/preload.cjs')
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.sandbox).toBe(true)
    expect(wp.webviewTag).toBe(false)
  })
})

describe('SV4: i bounds della PiP', () => {
  it('la PRIMA volta: in basso a destra dello schermo dove sta Homun', () => {
    const b = defaultPipBounds(WORK)
    expect(b.width).toBe(360)
    expect(b.height).toBe(225) // 16:10
    // in basso a destra, con un margine
    expect(b.x + b.width).toBeLessThanOrEqual(WORK.x + WORK.width)
    expect(b.y + b.height).toBeLessThanOrEqual(WORK.y + WORK.height)
    expect(WORK.x + WORK.width - (b.x + b.width)).toBeLessThanOrEqual(24)
    expect(WORK.y + WORK.height - (b.y + b.height)).toBeLessThanOrEqual(24)
  })

  it('le misure SALVATE dentro gli schermi si usano come sono', () => {
    const saved: PipRect = { x: 100, y: 120, width: 480, height: 300 }
    expect(pipBoundsWithin(saved, DISPLAYS)).toEqual(saved)
  })

  it('le misure salvate FUORI dagli schermi attuali si riportano DENTRO', () => {
    // staccato su uno schermo che non c'è più: torna in basso a destra
    const fuori: PipRect = { x: 4000, y: 3000, width: 480, height: 300 }
    const b = pipBoundsWithin(fuori, DISPLAYS)
    const d = defaultPipBounds(WORK)
    expect(b).toEqual(d)
  })

  it('le misure salvate troppo grandi si riportano al massimo', () => {
    const grande: PipRect = { x: 0, y: 0, width: 2000, height: 1250 }
    const b = pipBoundsWithin(grande, DISPLAYS)
    expect(b.width).toBeLessThanOrEqual(PIP_MAX_WIDTH)
    expect(b.height).toBeLessThanOrEqual(PIP_MAX_WIDTH / PIP_ASPECT)
    // e resta dentro lo schermo
    expect(b.x + b.width).toBeLessThanOrEqual(WORK.width)
    expect(b.y + b.height).toBeLessThanOrEqual(WORK.height)
  })
})

// ---- il manager con la finestra FINTA ----

/** La finestra finta: registra TUTTE le chiamate di setup e gli eventi. */
class FakePipWindow implements PipWindowHandle {
  static created: FakePipWindow[] = []
  calls: Array<[string, ...unknown[]]> = []
  listeners: Record<string, Array<() => void>> = {}
  settings: Array<[string, unknown]> = []
  closed = false
  bounds: PipRect
  beforeInput: ((input: { type: string; key: string }) => void) | null = null
  constructor(
    public options: Record<string, unknown>,
    public url: string,
    bounds: PipRect
  ) {
    this.bounds = { ...bounds }
    FakePipWindow.created.push(this)
  }
  on(event: 'closed' | 'resize' | 'move', cb: () => void): void {
    ;(this.listeners[event] ??= []).push(cb)
  }
  emit(event: string): void {
    for (const cb of this.listeners[event] ?? []) cb()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('closed')
  }
  getBounds(): PipRect {
    return { ...this.bounds }
  }
  setAlwaysOnTop(flag: boolean, level: string): void { this.calls.push(['setAlwaysOnTop', flag, level]) }
  isAlwaysOnTop(): boolean { return true }
  setVisibleOnAllWorkspaces(flag: boolean, opts: { visibleOnFullScreen: boolean }): void {
    this.calls.push(['setVisibleOnAllWorkspaces', flag, opts])
  }
  setAspectRatio(aspect: number): void { this.calls.push(['setAspectRatio', aspect]) }
  setMinimumSize(w: number, h: number): void { this.calls.push(['setMinimumSize', w, h]) }
  setMaximumSize(w: number, h: number): void { this.calls.push(['setMaximumSize', w, h]) }
  readonly webContents = {
    on: (event: 'before-input-event', cb: (input: { type: string; key: string }) => void): void => {
      if (event === 'before-input-event') this.beforeInput = cb
    }
  }
}

interface ManagerCtx {
  manager: PipManager
  windows: () => FakePipWindow[]
  emitted: Array<{ type: 'pip'; agentId: string | null }>
  settingsWritten: Array<[string, unknown]>
  focusedMain: string[]
}

function makeManager(over: { saved?: PipRect | null; mainVisible?: boolean } = {}): ManagerCtx {
  FakePipWindow.created = []
  const emitted: Array<{ type: 'pip'; agentId: string | null }> = []
  const settingsWritten: Array<[string, unknown]> = []
  const focusedMain: string[] = []
  const manager = new PipManager({
    preloadPath: () => '/path/preload.cjs',
    createWindow: (options, url) => {
      const b = { x: options.x as number, y: options.y as number, width: options.width as number, height: options.height as number }
      return new FakePipWindow(options, url, b)
    },
    urlFor: (agentId) => `homun://app/#/pip/${agentId}`,
    displays: () => DISPLAYS,
    homunBounds: () => WORK,
    getSetting: async <T,>(_key: string, fallback: T) => (over.saved ?? fallback) as T,
    setSetting: async (key: string, value: unknown) => { settingsWritten.push([key, value]) },
    emit: (e) => { emitted.push(e) },
    focusMain: (agentId: string) => { focusedMain.push(agentId) },
    mainVisible: () => over.mainVisible ?? true
  })
  return { manager, windows: () => FakePipWindow.created, emitted, settingsWritten, focusedMain }
}

describe('SV4: il manager della PiP (finestra finta)', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('open: finestra SEMPRE SOPRA (floating), MAI setVisibleOnAllWorkspaces (U3: trasformava il processo in UIElementApplication e Homun spariva), rapporto 16:10, rotta #/pip/<bot>', async () => {
    const ctx = makeManager()
    await ctx.manager.open('bot-a')
    const win = ctx.windows()[0]!
    expect(win.url).toBe('homun://app/#/pip/bot-a')
    expect(win.calls).toContainEqual(['setAlwaysOnTop', true, 'floating'])
    expect(win.calls.filter((c) => c[0] === 'setVisibleOnAllWorkspaces'), 'mai setVisibleOnAllWorkspaces, con o senza visibleOnFullScreen').toEqual([])
    expect(win.calls).toContainEqual(['setAspectRatio', PIP_ASPECT])
    expect(win.calls).toContainEqual(['setMinimumSize', PIP_MIN_WIDTH, PIP_MIN_WIDTH / PIP_ASPECT])
    expect(win.calls).toContainEqual(['setMaximumSize', PIP_MAX_WIDTH, PIP_MAX_WIDTH / PIP_ASPECT])
    expect(ctx.emitted).toEqual([{ type: 'pip', agentId: 'bot-a' }])
  })

  it('UNA sola PiP per volta: staccarne un ALTRO bot sostituisce la prima', async () => {
    const ctx = makeManager()
    await ctx.manager.open('bot-a')
    await ctx.manager.open('bot-b')
    expect(ctx.windows()).toHaveLength(2)
    expect(ctx.windows()[0]!.closed).toBe(true)
    expect(ctx.windows()[1]!.closed).toBe(false)
    expect(ctx.windows()[1]!.url).toBe('homun://app/#/pip/bot-b')
    expect(ctx.emitted).toEqual([
      { type: 'pip', agentId: 'bot-a' },
      { type: 'pip', agentId: 'bot-b' }
    ])
  })

  it('riaprire lo STESSO bot NON crea una seconda finestra', async () => {
    const ctx = makeManager()
    await ctx.manager.open('bot-a')
    await ctx.manager.open('bot-a')
    expect(ctx.windows()).toHaveLength(1)
  })

  it('le misure si ricordano in ui.pip.bounds (al movimento e alla chiusura)', async () => {
    const ctx = makeManager({ saved: { x: 5, y: 6, width: 400, height: 250 } })
    await ctx.manager.open('bot-a')
    const win = ctx.windows()[0]!
    // le misure salvate DENTRO gli schermi si usano
    expect(win.options.x).toBe(5)
    expect(win.options.width).toBe(400)
    // la finestra si sposta: il bounds nuovo si salva (il debounce è un timer
    // VERO del prodotto, 250 ms: si aspetta l'EFFETTO — la scritture del
    // setting — non un tempo fisso sopra il debounce)
    win.bounds = { x: 40, y: 50, width: 520, height: 325 }
    win.emit('resize')
    win.emit('move')
    const boundsWritten = () => ctx.settingsWritten.filter(([k]) => k === 'ui.pip.bounds').map(([, v]) => v as PipRect)
    await vi.waitFor(() => expect(boundsWritten().at(-1)).toEqual({ x: 40, y: 50, width: 520, height: 325 }), { timeout: 2000, interval: 10 })
    ctx.manager.close()
    const saved = ctx.settingsWritten.filter(([k]) => k === 'ui.pip.bounds').map(([, v]) => v as PipRect)
    expect(saved[saved.length - 1]).toEqual({ x: 40, y: 50, width: 520, height: 325 })
    expect(ctx.emitted[ctx.emitted.length - 1]).toEqual({ type: 'pip', agentId: null })
  })

  it('Esc chiude la PiP (quando ha il focus, come arriva a before-input-event)', async () => {
    const ctx = makeManager()
    await ctx.manager.open('bot-a')
    const win = ctx.windows()[0]!
    win.beforeInput!({ type: 'keyDown', key: 'Escape' })
    expect(win.closed).toBe(true)
    expect(ctx.emitted[ctx.emitted.length - 1]).toEqual({ type: 'pip', agentId: null })
  })

  it('state() dice aperto, bot, alwaysOnTop letto dalla finestra e mainVisible (U3: la principale non si nasconde MAI)', async () => {
    const ctx = makeManager()
    expect(ctx.manager.state()).toEqual({ open: false, agentId: null, alwaysOnTop: false, mainVisible: true })
    await ctx.manager.open('bot-a')
    expect(ctx.manager.state()).toEqual({ open: true, agentId: 'bot-a', alwaysOnTop: true, mainVisible: true })
    // e se la principale fosse nascosta, la sonda lo vede dallo stato
    const hidden = makeManager({ mainVisible: false })
    await hidden.manager.open('bot-b')
    expect(hidden.manager.state().mainVisible).toBe(false)
  })

  it('«Riporta in Homun» (focusMain) è UN gesto: CHIUDE la PiP e porta Homun sul bot giusto', async () => {
    const ctx = makeManager()
    await ctx.manager.open('bot-a')
    ctx.manager.focusMain('bot-a')
    expect(ctx.focusedMain).toEqual(['bot-a'])
    expect(ctx.windows()[0]!.closed, 'la PiP si chiude nello stesso gesto').toBe(true)
    expect(ctx.emitted[ctx.emitted.length - 1]).toEqual({ type: 'pip', agentId: null })
  })
})

describe("U3: l'adattatore vero non tocca MAI la visibilità dell'app (guarda sul codice)", () => {
  it("né pip.ts né l'adattatore di index.ts chiamano setVisibleOnAllWorkspaces, dock.hide o setActivationPolicy", async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const pip = readFileSync(fileURLToPath(new URL('../pip.ts', import.meta.url)), 'utf8')
    const index = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    // le CHIAMATE, non le parole nei commenti: è la chiamata che trasforma
    // il processo (UIElementApplication) e fa sparire Homun
    for (const src of [pip, index]) {
      expect(src).not.toContain('.setVisibleOnAllWorkspaces(')
      expect(src).not.toContain('.dock.hide(')
    }
    // setActivationPolicy compare SOLO nella modalità daemon (processo senza
    // finestre, legittimamente accessory): il percorso GUI non la chiama mai
    const daemonStart = index.indexOf('if (isDaemonMode(process.argv))')
    const gui = daemonStart < 0 ? index : index.slice(0, daemonStart) + index.slice(index.indexOf('app.whenReady()', daemonStart))
    expect(gui).not.toContain('.setActivationPolicy(')
    // la principale non viene nascosta da nessuna parte del main
    expect(index).not.toContain('.hide()')
  })
})
