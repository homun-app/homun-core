// P1 (fase primo-avvio): il primo segnale dal renderer. Quando Homun si
// apre e «non si vede niente» il registro deve dire se React ha montato
// qualcosa: il renderer lo dice al main (IPC app:first-paint) nel primo
// requestAnimationFrame DOPO il mount. Qui la parte PURA (frame finti: niente
// DOM nel repo) e la guardia che main.tsx monti il segnale accanto alla
// finestra vera (App e la PiP).
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { signalFirstPaintAfterFrame } from '../lib/first-paint'

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
    expect(SIGNAL_SRC).toContain('firstPaint()')
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
