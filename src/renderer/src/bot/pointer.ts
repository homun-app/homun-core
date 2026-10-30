// Fase 16 (U1): tracker condiviso del puntatore. In Lovable ogni mascotte con
// track aggiungeva un suo listener 'pointermove' con setState a ogni movimento:
// con decine di mascotte (sidebar, chat, pannello, card) è lavoro sprecato.
// Qui UN solo listener sulla finestra, aggiornamento coalescato con
// requestAnimationFrame e abbonati che leggono la posizione.
export interface PointerPoint {
  x: number
  y: number
}

const subs = new Set<(p: PointerPoint) => void>()
let listening = false
let raf = 0
let last: PointerPoint | null = null

function flush(): void {
  raf = 0
  if (last) for (const fn of subs) fn(last)
}

function onMove(e: PointerEvent): void {
  last = { x: e.clientX, y: e.clientY }
  if (!raf) raf = requestAnimationFrame(flush)
}

/** Abbona una mascotte alla posizione del puntatore (un frame su due al massimo). */
export function subscribePointer(fn: (p: PointerPoint) => void): () => void {
  subs.add(fn)
  if (!listening) {
    listening = true
    window.addEventListener('pointermove', onMove)
  }
  return () => {
    subs.delete(fn)
    if (subs.size === 0 && listening) {
      listening = false
      window.removeEventListener('pointermove', onMove)
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
  }
}

/**
 * Lo sguardo dalla formula di Lovable: k = min(1, d/400), x·4, y·3 — dove
 * (cx, cy) è il centro della mascotte e (px, py) il puntatore.
 */
export function gazeFrom(cx: number, cy: number, px: number, py: number): { x: number; y: number } {
  const dx = px - cx
  const dy = py - cy
  const d = Math.max(1, Math.hypot(dx, dy))
  const k = Math.min(1, d / 400)
  return { x: (dx / d) * 4 * k, y: (dy / d) * 3 * k }
}
