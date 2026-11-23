// P1 (fase primo-avvio): il primo segnale dal renderer. Quando Homun si
// apre e «non si vede niente» il registro deve dire se React ha montato
// qualcosa: il renderer lo dice al main (IPC app:first-paint) nel primo
// requestAnimationFrame DOPO il mount. Qui la parte PURA (frame finti: niente
// DOM nel repo) e la guardia che main.tsx monti il segnale accanto alla
// finestra vera (App e la PiP).
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FIRST_PAINT_HIDDEN_FALLBACK_MS, signalFirstPaintAfterFrame } from '../lib/first-paint'

const MAIN_SRC = readFileSync(fileURLToPath(new URL('../main.tsx', import.meta.url)), 'utf8')
const SIGNAL_SRC = readFileSync(fileURLToPath(new URL('../components/FirstPaintSignal.tsx', import.meta.url)), 'utf8')

/** I frame finti: il test decide quando arriva il requestAnimationFrame (la cancellazione toglie davvero il callback). */
function fakeFrames() {
  const frames: Array<{ id: number; cb: () => void }> = []
  const cancelled: number[] = []
  let nextId = 1
  return {
    frames,
    cancelled,
    requestFrame: (cb: () => void): number => {
      frames.push({ id: nextId, cb })
      return nextId++
    },
    cancel: (id: number): void => {
      cancelled.push(id)
      const i = frames.findIndex((f) => f.id === id)
      if (i !== -1) frames.splice(i, 1)
    },
    /** arriva UN frame: i callback registrati finora vengono eseguiti e tolti */
    tick: (): void => {
      const due = frames.splice(0)
      for (const { cb } of due) cb()
    }
  }
}

describe('P1: signalFirstPaintAfterFrame — il segnale nel primo frame dopo il mount', () => {
  it('prima del frame non parte niente; al frame parte UNA volta', () => {
    const f = fakeFrames()
    const signal = vi.fn()
    signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel)
    expect(signal, 'fuori dal frame: nessun segnale').not.toHaveBeenCalled()
    expect(f.frames, 'un callback è in attesa del frame').toHaveLength(1)
    f.tick()
    expect(signal).toHaveBeenCalledTimes(1)
    f.tick()
    expect(signal, 'un segnale solo, non uno per frame').toHaveBeenCalledTimes(1)
  })

  it('il componente smontato prima del frame non manda niente (il callback si cancella)', () => {
    const f = fakeFrames()
    const signal = vi.fn()
    const cleanup = signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel)
    cleanup()
    expect(f.cancelled).toEqual([1])
    f.tick()
    expect(signal).not.toHaveBeenCalled()
  })

  it('smontato DOPO il frame: la pulizia non cancella un frame già passato', () => {
    const f = fakeFrames()
    const signal = vi.fn()
    const cleanup = signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel)
    f.tick()
    cleanup()
    expect(f.cancelled).toEqual([])
  })

  it('se il ponte verso il main manca o rifiuta, il render non si rompe', () => {
    const f = fakeFrames()
    const broken = vi.fn(() => { throw new TypeError('canale chiuso') })
    expect(() => signalFirstPaintAfterFrame(broken, f.requestFrame, f.cancel)).not.toThrow()
    expect(() => f.tick()).not.toThrow()
    expect(broken).toHaveBeenCalledTimes(1)
    expect(() => signalFirstPaintAfterFrame(() => { throw new TypeError('window.sandbot non c\'è') }, f.requestFrame, f.cancel)).not.toThrow()
    expect(() => f.tick()).not.toThrow()
  })
})

describe('P1: FirstPaintSignal — guardie sul sorgente', () => {
  it('il segnale passa dall\'IPC app:first-paint del main, non da un canale RPC del daemon', () => {
    expect(SIGNAL_SRC).toMatch(/api\.firstPaint\((true|false)\)/)
    expect(SIGNAL_SRC).toContain('signalFirstPaintAfterFrame')
    expect(SIGNAL_SRC).not.toContain('ipcRenderer')
  })

  it('main.tsx monta il segnale accanto alla finestra vera: con App E con la PiP (stessa pagina)', () => {
    const at = MAIN_SRC.indexOf('createRoot(')
    const render = MAIN_SRC.slice(at, MAIN_SRC.indexOf('\n  )', at))
    expect(render).toContain('<App />')
    expect(render).toContain('<PipView')
    expect(render).toContain('<FirstPaintSignal />')
  })
})

// ---- P3.4: a pagina nascosta (finestra coperta o mai mostrata) il frame non arriva ----

/** I timer finti del ripiego. */
function fakeTimers() {
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let now = 0
  let nextId = 1
  return {
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (id: unknown): void => {
      const i = timers.findIndex((t) => t.id === id)
      if (i !== -1) timers.splice(i, 1)
    },
    pending: () => timers.length,
    advance: (ms: number): void => {
      now += ms
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now && timers.includes(t)) {
          timers.splice(timers.indexOf(t), 1)
          t.fn()
        }
      }
    }
  }
}

describe('P3.4: a pagina nascosta il segnale parte lo stesso (il cane da guardia deve sapere se React ha montato)', () => {
  it('il frame arriva in tempo: UN segnale, col frame; nessun ripiego e nessun timer appeso', () => {
    const f = fakeFrames()
    const t = fakeTimers()
    const signal = vi.fn()
    const fallback = vi.fn()
    signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel, { isHidden: () => true, onFallback: fallback, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    t.advance(FIRST_PAINT_HIDDEN_FALLBACK_MS - 1)
    f.tick()
    expect(signal).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
    expect(t.pending(), 'il timer del ripiego è stato tolto').toBe(0)
    t.advance(60_000)
    f.tick()
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('pagina NASCOSTA e nessun frame: dopo 2 s parte il segnale di ripiego, e il frame non serve più', () => {
    const f = fakeFrames()
    const t = fakeTimers()
    const signal = vi.fn()
    const fallback = vi.fn()
    signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel, { isHidden: () => true, onFallback: fallback, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    t.advance(FIRST_PAINT_HIDDEN_FALLBACK_MS - 1)
    expect(fallback).not.toHaveBeenCalled()
    t.advance(1)
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(signal, 'il segnale «col frame» non c\'è stato: nessun frame è passato').not.toHaveBeenCalled()
    expect(f.cancelled, 'la richiesta di frame è stata tolta').toEqual([1])
    f.tick()
    expect(signal).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('pagina VISIBILE e il frame è solo in ritardo: il ripiego NON parte (il frame arriverà)', () => {
    const f = fakeFrames()
    const t = fakeTimers()
    const signal = vi.fn()
    const fallback = vi.fn()
    signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel, { isHidden: () => false, onFallback: fallback, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    t.advance(FIRST_PAINT_HIDDEN_FALLBACK_MS + 5_000)
    expect(fallback).not.toHaveBeenCalled()
    expect(f.frames, 'la richiesta di frame è ancora lì').toHaveLength(1)
    f.tick()
    expect(signal).toHaveBeenCalledTimes(1)
  })

  it('smontato prima dei 2 s: niente segnale, nessun timer appeso', () => {
    const f = fakeFrames()
    const t = fakeTimers()
    const signal = vi.fn()
    const fallback = vi.fn()
    const cleanup = signalFirstPaintAfterFrame(signal, f.requestFrame, f.cancel, { isHidden: () => true, onFallback: fallback, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout })
    cleanup()
    expect(t.pending()).toBe(0)
    t.advance(FIRST_PAINT_HIDDEN_FALLBACK_MS * 2)
    f.tick()
    expect(signal).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('FirstPaintSignal dice al main se il frame è passato (framed true) o se la pagina era nascosta (framed false)', () => {
    expect(SIGNAL_SRC).toContain('api.firstPaint(true)')
    expect(SIGNAL_SRC).toContain('api.firstPaint(false)')
    expect(SIGNAL_SRC).toContain("document.visibilityState === 'hidden'")
  })
})
