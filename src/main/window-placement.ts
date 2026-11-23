// P3.3 (fase primo-avvio): la finestra sta su uno schermo visibile. PURA
// (nessun import di Electron: i display entrano come elenco).
//
// Prima di ogni show: se i bounds non intersecano la workArea di NESSUN
// display, la finestra si ricentra sul display principale. È lo stesso
// criterio di screen.getDisplayMatching (il display che contiene la
// finestra), qui come funzione: una finestra mostrata dove nessuno la può
// vedere — per esempio sullo schermo di una configurazione che non c'è più,
// al primo avvio del giorno — per Electron è «a schermo», per chi guarda no.
import { intersects, type DisplayLike, type Rect } from './window-lifecycle'

export interface PlacedBounds {
  bounds: Rect
  /** true solo quando i bounds sono stati cambiati (la finestra era fuori da ogni schermo) */
  changed: boolean
}

/** Il punto centrale di un rettangolo. */
export function centerOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

/** Le stesse misure, centrate nell'area (arrotondate a pixel interi). */
export function centerIn(bounds: Pick<Rect, 'width' | 'height'>, area: Rect): Rect {
  return {
    x: Math.round(area.x + (area.width - bounds.width) / 2),
    y: Math.round(area.y + (area.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height
  }
}

/**
 * I bounds se la finestra sta in uno schermo, altrimenti quelli centrati sul
 * display principale. Senza display non si tocca niente.
 */
export function onScreenBounds(bounds: Rect, displays: readonly DisplayLike[], primaryWorkArea: Rect): PlacedBounds {
  if (displays.length === 0 || displays.some((d) => intersects(bounds, d.workArea))) return { bounds, changed: false }
  return { bounds: centerIn(bounds, primaryWorkArea), changed: true }
}
