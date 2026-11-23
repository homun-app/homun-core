// P3.2 (fase primo-avvio): la finestra si mostra quando ha qualcosa da
// mostrare, ma non aspetta per sempre. Fino a qui nasceva GIÀ visibile (show:
// true) appena creata — con dentro solo lo sfondo #0b0d10 — e se l'app non era
// attiva in quel momento (dalla riproduzione: l'avvio senza attivazione, o il
// daemon che si porta via l'attivazione del bundle) la finestra restava dietro
// le altre app: per Electron «mostrata», per chi guarda niente. Ora: show:
// false, win.show() su ready-to-show, ripiego dopo 3 s (riga show-fallback), e
// su macOS l'app si porta davanti (app.focus({ steal: true }) e poi
// win.focus()). Tutto PURO: finestra, app e timer finti.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SHOW_FALLBACK_MS, bringWindowToFront, showWhenReady, type ShowableWindow } from '../show-policy'
import type { LifecycleLine } from '../lifecycle-log'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

// ---- i finti ----

class FakeWindow implements ShowableWindow {
  destroyed = false
  readonly calls: string[] = []
  private readonly listeners = new Map<string, Array<() => void>>()
  once(event: string, cb: () => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]) }
  on(event: string, cb: () => void): void { this.once(event, cb) }
  emit(event: string): void { for (const cb of [...(this.listeners.get(event) ?? [])]) cb() }
  show(): void { this.calls.push('show') }
  focus(): void { this.calls.push('focus') }
  isDestroyed(): boolean { return this.destroyed }
}

function fakeDeps() {
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let nextId = 1
  const front: string[] = []
  return {
    front,
    pending: () => timers.length,
    advance: (ms: number) => {
      now += ms
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now && timers.includes(t)) {
          timers.splice(timers.indexOf(t), 1)
          t.fn()
        }
      }
    },
    deps: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++
        timers.push({ at: now + ms, fn, id })
        return id
      },
      clearTimeout: (id: unknown) => {
        const i = timers.findIndex((t) => t.id === id)
        if (i !== -1) timers.splice(i, 1)
      },
      bringToFront: (win: ShowableWindow) => {
        front.push('front')
        win.focus()
      }
    }
  }
}

function fakeLog() {
  const lines: string[] = []
  let now = 0
  const log: LifecycleLine = {
    line: (event, fields = {}) => {
      lines.push([event, ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`)].join(' '))
    },
    sinceBoot: () => now
  }
  return { lines, log, advance: (ms: number) => { now += ms } }
}

describe('P3.2: showWhenReady — la finestra si mostra quando ha qualcosa da mostrare', () => {
  it('PRIMA di ready-to-show non si mostra niente; a ready-to-show win.show(), una volta sola, e la finestra va davanti', () => {
    const win = new FakeWindow()
    const d = fakeDeps()
    const l = fakeLog()
    showWhenReady(win, l.log, d.deps)
    expect(win.calls, 'appena creata: nessun show (nasce nascosta)').toEqual([])
    l.advance(400)
    win.emit('ready-to-show')
    expect(win.calls).toEqual(['show', 'focus'])
    expect(d.front, 'portata davanti SUBITO dopo lo show').toEqual(['front'])
    expect(l.lines, 'senza ripiego nessuna riga show-fallback').toEqual([])
    win.emit('ready-to-show')
    expect(win.calls, 'una volta sola').toEqual(['show', 'focus'])
  })

  it('ready-to-show non arriva: dopo 3 s la mostra comunque, con la riga show-fallback', () => {
    const win = new FakeWindow()
    const d = fakeDeps()
    const l = fakeLog()
    showWhenReady(win, l.log, d.deps)
    expect(d.pending(), 'il ripiego è armato').toBe(1)
    l.advance(SHOW_FALLBACK_MS - 1)
    d.advance(SHOW_FALLBACK_MS - 1)
    expect(win.calls).toEqual([])
    l.advance(1)
    d.advance(1)
    expect(win.calls).toEqual(['show', 'focus'])
    expect(l.lines).toEqual([`show-fallback ms=${SHOW_FALLBACK_MS}`])
    expect(d.pending()).toBe(0)
  })

  it('se ready-to-show arriva in tempo il ripiego si disarma (mai due show, mai la riga)', () => {
    const win = new FakeWindow()
    const d = fakeDeps()
    const l = fakeLog()
    showWhenReady(win, l.log, d.deps)
    l.advance(1_200)
    win.emit('ready-to-show')
    expect(d.pending(), 'il timer del ripiego è stato tolto').toBe(0)
    l.advance(SHOW_FALLBACK_MS)
    d.advance(SHOW_FALLBACK_MS)
    expect(win.calls).toEqual(['show', 'focus'])
    expect(l.lines).toEqual([])
  })

  it('la finestra chiusa prima (dispose) non si mostra più, né sul ripiego né su ready-to-show', () => {
    const win = new FakeWindow()
    const d = fakeDeps()
    const policy = showWhenReady(win, fakeLog().log, d.deps)
    policy.dispose()
    expect(d.pending()).toBe(0)
    win.emit('ready-to-show')
    d.advance(SHOW_FALLBACK_MS)
    expect(win.calls).toEqual([])
  })

  it('una finestra distrutta non si mostra (nessuna eccezione su una finestra morta)', () => {
    const win = new FakeWindow()
    const d = fakeDeps()
    showWhenReady(win, fakeLog().log, d.deps)
    win.destroyed = true
    expect(() => win.emit('ready-to-show')).not.toThrow()
    expect(win.calls).toEqual([])
  })

  it('shown(): false finché non è mostrata, true dopo (chi la crea sa se mostrarla di nuovo)', () => {
    const win = new FakeWindow()
    const policy = showWhenReady(win, fakeLog().log, fakeDeps().deps)
    expect(policy.shown()).toBe(false)
    win.emit('ready-to-show')
    expect(policy.shown()).toBe(true)
  })
})

describe('P3.2: bringWindowToFront — su macOS l’app si porta davanti, poi la finestra', () => {
  it('su macOS: app.focus({ steal: true }) PRIMA, poi win.focus()', () => {
    const order: string[] = []
    const app = { focus: (opts: unknown) => { order.push(`app.focus(${JSON.stringify(opts)})`) } }
    bringWindowToFront({ focus: () => { order.push('win.focus') } }, app, 'darwin')
    expect(order).toEqual(['app.focus({"steal":true})', 'win.focus'])
  })

  it('altrove (Windows, Linux) solo win.focus(): steal è una cosa di macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const order: string[] = []
      const app = { focus: () => { order.push('app.focus') } }
      bringWindowToFront({ focus: () => { order.push('win.focus') } }, app, platform)
      expect(order).toEqual(['win.focus'])
    }
  })
})

describe('P3.2: il cablaggio nel main (guardie sul sorgente)', () => {
  it('la finestra nasce NASCOSTA (show: false) e la mostra solo la politica di mostra', () => {
    const createWindow = INDEX.slice(INDEX.indexOf('function createWindow(): BrowserWindow {'), INDEX.indexOf('app.whenReady().then(async () => {'))
    expect(createWindow).toMatch(/show:\s*false/)
    expect(createWindow).toContain('showWhenReady(win, lifecycle, showPolicyDeps)')
    expect(createWindow, 'nessun show() diretto alla nascita').not.toMatch(/\bwin\.show\(\)/)
  })

  it('su macOS il main porta l\'app davanti: bringWindowToFront con l\'app e la piattaforma vere', () => {
    const policy = readFileSync(fileURLToPath(new URL('../show-policy.ts', import.meta.url)), 'utf8')
    expect(policy).toMatch(/if \(platform === 'darwin'\) app\.focus\(\{ steal: true \}\)\s*\n\s*win\.focus\(\)/)
    expect(INDEX).toContain('bringWindowToFront(win, app, process.platform)')
    expect(INDEX).toContain('bringToFront: (win) => bringWindowToFront(')
  })
})
