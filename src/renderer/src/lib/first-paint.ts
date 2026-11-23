// P1 (fase primo-avvio): il PRIMO SEGNALE dal renderer. Quando Homun si apre
// e «non si vede niente» il registro deve dire se React ha montato qualcosa:
// il renderer lo dice al main (IPC app:first-paint) nel primo
// requestAnimationFrame DOPO il mount — così renderer-ready significa che la
// pagina è viva E che il suo frame è passato. PURA: il frame si inietta nei
// test (nel repo non c'è un DOM).
/**
 * Manda `signal` nel primo frame dopo il mount, una volta sola. Torna la
 * pulizia (il componente smontato prima del frame non manda niente). Se il
 * ponte verso il main manca o rifiuta, il render non si rompe.
 */
export function signalFirstPaintAfterFrame(
  signal: () => void,
  requestFrame: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id)
): () => void {
  let id: number | null = requestFrame(() => {
    id = null
    try {
      signal()
    } catch {
      // window.sandbot non c'è (o il canale è chiuso): il registro resta senza
      // renderer-ready, che è esattamente ciò che è successo
    }
  })
  return () => {
    if (id !== null) cancelFrame(id)
  }
}
