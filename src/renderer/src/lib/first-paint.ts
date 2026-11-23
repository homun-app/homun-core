// P1 (fase primo-avvio): il PRIMO SEGNALE dal renderer. Quando Homun si apre
// e «non si vede niente» il registro deve dire se React ha montato qualcosa:
// il renderer lo dice al main (IPC app:first-paint) nel primo
// requestAnimationFrame DOPO il mount — così renderer-ready significa che la
// pagina è viva E che il suo frame è passato. PURA: il frame si inietta nei
// test (nel repo non c'è un DOM).
//
// P3.4: una pagina NASCOSTA (finestra coperta dalle altre, mai mostrata) non
// riceve frame: il segnale non partirebbe mai, e il registro — e il cane da
// guardia del renderer — non saprebbero se React ha montato. Dalla riproduzione
// di P2: coperta al 100% → visibilityState «hidden», nessun renderer-ready per
// secondi. Se dopo FIRST_PAINT_HIDDEN_FALLBACK_MS il frame non è arrivato e la
// pagina è nascosta, il segnale parte lo stesso (onHiddenFallback).

/** Quanto si aspetta il frame quando la pagina è nascosta. */
export const FIRST_PAINT_HIDDEN_FALLBACK_MS = 2_000

export interface HiddenFallback {
  /** la pagina è nascosta? (default: document.visibilityState === 'hidden') */
  isHidden?(): boolean
  /** quanto aspettare il frame prima di segnalare lo stesso */
  timeoutMs?: number
  /** il segnale senza frame (default: lo stesso del frame) */
  onFallback?(): void
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

/**
 * Manda `signal` nel primo frame dopo il mount, una volta sola. Torna la
 * pulizia (il componente smontato prima del frame non manda niente). Se il
 * ponte verso il main manca o rifiuta, il render non si rompe. Con
 * `hidden`, a pagina nascosta il segnale parte dopo il ripiego anche senza frame.
 */
export function signalFirstPaintAfterFrame(
  signal: () => void,
  requestFrame: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
  hidden?: HiddenFallback
): () => void {
  let id: number | null = null
  let timer: unknown = null
  let done = false
  const clearTimer = (): void => {
    if (timer !== null) (hidden?.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout)))(timer)
    timer = null
  }
  const finish = (send: () => void): void => {
    done = true
    clearTimer()
    try {
      send()
    } catch {
      // window.sandbot non c'è (o il canale è chiuso): il registro resta senza
      // renderer-ready, che è esattamente ciò che è successo
    }
  }
  if (hidden) {
    const setTimer = hidden.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    timer = setTimer(() => {
      timer = null
      if (done || !(hidden.isHidden?.() ?? true)) return
      if (id !== null) cancelFrame(id)
      id = null
      finish(hidden.onFallback ?? signal)
    }, hidden.timeoutMs ?? FIRST_PAINT_HIDDEN_FALLBACK_MS)
  }
  id = requestFrame(() => {
    id = null
    finish(signal)
  })
  return () => {
    if (done) return
    done = true
    if (id !== null) cancelFrame(id)
    clearTimer()
  }
}
