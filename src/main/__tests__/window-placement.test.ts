// P3.3 (fase primo-avvio): la finestra sta su uno schermo visibile. PURA.
// Se i bounds non intersecano la workArea di NESSUN display (è lo stesso
// criterio di screen.getDisplayMatching: il display che la contiene), la
// finestra si ricentra sul display principale — PRIMA di ogni show, così
// non si mostra mai dove nessuno la può vedere (per esempio uno schermo
// staccato o ancora addormentato al primo avvio del giorno).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { centerIn, centerOf, onScreenBounds } from '../window-placement'

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
const POLICY = readFileSync(fileURLToPath(new URL('../show-policy.ts', import.meta.url)), 'utf8')

const PRIMARIO = { id: 1, workArea: { x: 0, y: 30, width: 1920, height: 1050 } }
const SECONDO = { id: 2, workArea: { x: 1920, y: 278, width: 1470, height: 956 } }
const FINESTRA = { x: 360, y: 155, width: 1200, height: 800 }

describe('P3.3: onScreenBounds — dentro uno schermo si resta, fuori si ricentra', () => {
  it('dentro la workArea del display principale: i bounds NON cambiano', () => {
    const r = onScreenBounds(FINESTRA, [PRIMARIO, SECONDO], PRIMARIO.workArea)
    expect(r.changed).toBe(false)
    expect(r.bounds).toEqual(FINESTRA)
  })

  it('fuori da OGNI display (per esempio x negativo oltre lo schermo): si ricentra sul display principale', () => {
    const r = onScreenBounds({ x: -3000, y: -2000, width: 1200, height: 800 }, [PRIMARIO, SECONDO], PRIMARIO.workArea)
    expect(r.changed).toBe(true)
    expect(r.bounds).toEqual({ x: 360, y: 155, width: 1200, height: 800 }) // 30 + (1920−1200)/2, 30 + (1050−800)/2
    expect(centerOf(r.bounds)).toEqual(centerOf(PRIMARIO.workArea))
  })

  it('sul SECONDO display si resta: è a schermo anche quello', () => {
    const sulSecondo = { x: 2000, y: 400, width: 1000, height: 700 }
    expect(onScreenBounds(sulSecondo, [PRIMARIO, SECONDO], PRIMARIO.workArea)).toEqual({ bounds: sulSecondo, changed: false })
  })

  it('basta UN pixel nella workArea di un display: niente ricentratura', () => {
    const unPixel = { x: 1919, y: 100, width: 400, height: 300 }
    expect(onScreenBounds(unPixel, [PRIMARIO], PRIMARIO.workArea).changed).toBe(false)
  })

  it('la BARRA dei menu non è workArea: una finestra tutta sopra (y < 30) è fuori', () => {
    const r = onScreenBounds({ x: 0, y: 0, width: 400, height: 20 }, [PRIMARIO], PRIMARIO.workArea)
    expect(r.changed).toBe(true)
    expect(r.bounds).toEqual({ x: 760, y: 545, width: 400, height: 20 }) // 30 + (1050−20)/2
  })

  it('una finestra più larga della workArea si ricentra lo stesso (esce da entrambi i lati in modo uguale)', () => {
    const r = onScreenBounds({ x: -5000, y: -5000, width: 3000, height: 100 }, [PRIMARIO], PRIMARIO.workArea)
    expect(r.changed).toBe(true)
    expect(r.bounds.x).toBe(-540) // 0 + (1920−3000)/2
    expect(centerOf(r.bounds)).toEqual(centerOf(PRIMARIO.workArea))
  })

  it('senza display (lo schermo non risponde) non si tocca niente', () => {
    const r = onScreenBounds({ x: -3000, y: -3000, width: 1200, height: 800 }, [], PRIMARIO.workArea)
    expect(r).toEqual({ bounds: { x: -3000, y: -3000, width: 1200, height: 800 }, changed: false })
  })

  it('centerOf è il punto centrale (con la metà)', () => {
    expect(centerOf(PRIMARIO.workArea)).toEqual({ x: 960, y: 555 })
    expect(centerOf({ x: 0, y: 0, width: 3, height: 3 })).toEqual({ x: 1.5, y: 1.5 })
  })

  it('centerIn arrotonda a pixel interi', () => {
    expect(centerIn({ width: 1200, height: 800 }, { x: 0, y: 30, width: 1921, height: 1051 })).toEqual({ x: 361, y: 156, width: 1200, height: 800 })
  })
})

describe('P3.3: il cablaggio — PRIMA di ogni show la finestra torna su uno schermo', () => {
  it('la politica di mostra chiama beforeShow PRIMA di win.show() (anche nel ripiego)', () => {
    expect(POLICY).toMatch(/deps\.beforeShow\?\.\(win\)\s*\n\s*win\.show\(\)/)
  })

  it('il main porta i bounds dentro uno schermo: onScreenBounds con i display e il primario di Electron, e la riga window-recentered', () => {
    const ensure = /const ensureOnScreen = \(win: BrowserWindow\): void => \{[\s\S]*?\n    \}/.exec(INDEX)?.[0] ?? ''
    expect(ensure).toContain('onScreenBounds(')
    expect(ensure).toContain('screen.getAllDisplays()')
    expect(ensure).toContain('screen.getPrimaryDisplay()')
    expect(ensure).toContain('win.setBounds(')
    expect(ensure).toContain("lifecycle.line('window-recentered'")
    expect(INDEX).toMatch(/beforeShow: ensureOnScreen/)
  })
})
