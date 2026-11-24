// F2 (fase fondamenta): LE GUARDIE della pagina dei componenti.
//   · il MARCATORE della pagina NON entra nel build: dopo `electron-vite
//     build`, nessun file di out/ contiene la stringa «galleria-componenti».
//     Vista ROSSA prima con un import statico in App.tsx, poi verde con
//     l'import dinamico dietro SANDBOT_TEST_GALLERIA=1.
//   · ogni file di components/ui/ è importato dalla pagina dei componenti:
//     un componente NUOVO entra nella pagina con tutti i suoi stati
//     (docs/FATTO.md). Il test legge gli import del modulo della pagina.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const QUI = dirname(fileURLToPath(import.meta.url))
const RENDERER = join(QUI, '..', '..', 'renderer', 'src')
const RADICE = join(QUI, '..', '..', '..', '..')

const MARCATORE = 'galleria-componenti'

describe('la pagina dei componenti non entra nel build di produzione', () => {
  it('nessun file di out/ contiene il marcatore della pagina (dopo electron-vite build)', () => {
    const out = join(RADICE, 'out')
    const trovati: string[] = []
    const scandi = (dir: string): void => {
      let voci: string[] = []
      try { voci = readdirSync(dir, { withFileTypes: true }).map((d) => d.name) } catch { return }
      for (const nome of voci) {
        const pieno = join(dir, nome)
        try {
          if (statSync(pieno).isDirectory()) { scandi(pieno); continue }
          const testo = readFileSync(pieno, 'utf8')
          if (testo.includes(MARCATORE)) trovati.push(pieno.slice(RADICE.length + 1))
        } catch { /* binario o illeggibile: non è il marcatore */ }
      }
    }
    scandi(out)
    expect(trovati).toEqual([])
  })

  it('il modulo della pagina si carica con un import() dinamico dietro il controllo della galleria (App.tsx)', () => {
    const app = readFileSync(join(RENDERER, 'App.tsx'), 'utf8')
    expect(app).toContain('sandbotTest?.galleria')
    expect(app).toContain('__galleriaUrl')
    // l'import è DINAMICO e NON statico: App.tsx non contiene un import del modulo
    expect(app).not.toMatch(new RegExp(`from\\s+'[^']*${MARCATORE}`))
    expect(app).not.toMatch(new RegExp(`import\\s+${MARCATORE}`))
  })
})

describe('ogni componente di components/ui/ è nella pagina dei componenti', () => {
  it('il modulo della pagina importa ogni file di components/ui/', () => {
    const pagina = readFileSync(join(RENDERER, 'galleria', 'componenti.tsx'), 'utf8')
    const fileUi = readdirSync(join(RENDERER, 'components', 'ui')).filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, ''))
    const mancanti = fileUi.filter((nome) => {
      // l'import relativo: `from '../components/ui/<nome>'`
      const re = new RegExp(`from\\s+'\\.{1,2}/components/ui/${nome}'`)
      return !re.test(pagina)
    })
    expect(mancanti).toEqual([])
  })
})
