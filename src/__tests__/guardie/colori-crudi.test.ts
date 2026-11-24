// F3 (fase fondamenta): GUARDIA — nessun COLORE scritto a mano nei .tsx del
// renderer: i colori stanno in styles.css (i token); un colore crudo nei
// componenti (#157A6E, rgb(…), oklch(…)) non segue il tema e sfugge alla
// design-guard (che guarda le classi, non i valori). Vista ROSSA prima:
// la mascotte della splash (App.tsx) e i fallback di xterm (ComputerTerminal).
import { describe, it, expect } from 'vitest'
import { leggiSorgenti } from './sorgenti'

const file = leggiSorgenti('src/renderer/src', ['.tsx'], { escludi: ['__tests__'] })

/** I colori crudi: hex, rgb/rgba, oklch (i token var(--…) sono quello che DEVE esserci). */
const CRUDO = /#[0-9a-fA-F]{3,8}\b|\brgb\(|\brgba\(|\boklch\(/g

/** Le eccezioni, ognuna col motivo. */
const ECCEZIONI: ReadonlyArray<{ file: string; perché: string }> = [
  {
    file: 'src/renderer/src/App.tsx',
    perché: 'la mascotte della boot-splash è un SVG con i SUOI colori fisici (i verdi e i bianchi del disegno): non sono colori dell\'interfaccia e non seguono il tema per definizione'
  },
  {
    file: 'src/renderer/src/components/ComputerTerminal.tsx',
    perché: 'i fallback dei temi di xterm (v(\'--card\', \'#fff\')): xterm chiede letterali CSS — il token viene risolto per primo, il letterale è l\'ultimo ripiego quando il token non è ancora in pagina'
  }
]

describe('nessun colore crudo nei .tsx del renderer', () => {
  it('nessun #hex, rgb(, oklch( fuori dalle eccezioni', () => {
    const violazioni: string[] = []
    for (const { rel, testo } of file) {
      if (ECCEZIONI.some((e) => e.file === rel)) continue
      for (const m of testo.matchAll(CRUDO)) violazioni.push(`${rel}: ${m[0]}`)
    }
    expect(violazioni).toEqual([])
  })
})
