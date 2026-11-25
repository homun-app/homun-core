// C4 (fase linguaggio): LE REGOLE SECHE — a zero da subito. Il tetto copre
// la conversione graduale; queste invece valono ORA, perché la pagina che le
// rompe non ha scuse:
//   1. la ricerca è UNA e SearchField: nessun campo di ricerca scritto a mano
//      fuori da components/ui/;
//   2. niente FilterPill, e nelle pagine di elenco niente <select> né
//      Button shape="pill" usati come FILTRO (le scelte d'impostazione
//      restano Select/Segmento; i filtri sono FilterChips);
//   3. PageShell accetta solo wide | reading: nessuna width="page" (il tipo
//      la vieta) e nessuna larghezza che DIPENDE dalla scheda;
//   4. al massimo UN UnderlineTabs per pagina (le «strade» interne sono
//      pillole nella barra);
//   5. nessun file di components/ col nome di una finestra che non esiste
//      (*Window.tsx non montato);
//   6. nessun componente INUTILIZZATO (la logica del censimento di
//      scripts/esporta-inutilizzati.mjs).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { leggiSorgenti } from './sorgenti'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RADICE } from './sorgenti'

/** Le pagine di elenco del modello ListPage (dove i filtri stanno nella barra). */
const PAGINE_ELENCO = [
  'src/renderer/src/components/PluginPanel.tsx',
  'src/renderer/src/components/LibraryPanel.tsx',
  'src/renderer/src/components/ActivityPanel.tsx',
  'src/renderer/src/components/ApprovalsCenter.tsx',
  'src/renderer/src/components/ApprovalsQueue.tsx'
]

const renderer = leggiSorgenti('src/renderer/src', ['.tsx', '.ts'], { escludi: ['components/ui/', '__tests__/', 'galleria/'] })
const di = (rel: string): string => renderer.find((f) => f.rel === rel)?.testo ?? ''

describe('C4 regola 1: la ricerca è UNA, ed è SearchField', () => {
  it('nessun campo di ricerca scritto a mano fuori da components/ui/ (il segnaposto o il nome accessibile lo tradiscono)', () => {
    const vietati: string[] = []
    for (const f of renderer) {
      if (f.rel.includes('search-field')) continue
      // un <input> col segnaposto o aria-label di ricerca, scritto a mano
      for (const m of f.testo.matchAll(/<input\b[^>]*placeholder=\{?t?`?[^}\n]*(?:erca|icerca|search)/gi)) {
        vietati.push(`${f.rel}: ${m[0]!.slice(0, 90)}`)
      }
    }
    expect(vietati).toEqual([])
  })

  it('chi cerca, chiede SearchField: nelle pagine di elenco nessun <input> di ricerca (c\'è il pezzo del catalogo)', () => {
    const problemi: string[] = []
    for (const p of PAGINE_ELENCO) {
      const src = di(p)
      // se la pagina cerca (placeholder di ricerca), lo fa con SearchField
      if (/<input\b[^>]*placeholder=[^\n]*(?:erca|icerca)/i.test(src) && !/SearchField/.test(src)) {
        problemi.push(`${p}: cerca con un campo scritto a mano`)
      }
    }
    expect(problemi).toEqual([])
  })
})

describe('C4 regola 2: i filtri sono FilterChips (niente FilterPill, niente select né pillole-bot tone in barra)', () => {
  it('NESSUN FilterPill nel renderer: il pezzo è via, il catalogo ha FilterChips', () => {
    for (const f of renderer) {
      expect(f.testo, f.rel).not.toMatch(/\bFilterPill\b/)
    }
  })

/** Il blocco toolbar={…} di un file (fino alla graffa che chiude): lì stanno i filtri della barra. */
const bloccoToolbar = (src: string): string => {
  const i = src.indexOf('toolbar={')
  if (i < 0) return ''
  let profondità = 0
  for (let j = i + 'toolbar='.length; j < src.length; j++) {
    if (src[j] === '{') profondità++
    if (src[j] === '}') {
      profondità--
      if (profondità === 0) return src.slice(i, j)
    }
  }
  return src.slice(i)
}

  it('nella BARRA delle pagine di elenco nessun <select> e nessun Button shape="pill" (i filtri sono FilterChips)', () => {
    const problemi: string[] = []
    for (const p of PAGINE_ELENCO) {
      const barra = bloccoToolbar(di(p))
      if (/<select\b/.test(barra)) problemi.push(`${p}: <select> nella barra (filtro? diventa FilterChipsMenu)`)
      if (/shape="pill"/.test(barra)) problemi.push(`${p}: Button shape="pill" nella barra (filtro? diventa FilterChips)`)
    }
    expect(problemi).toEqual([])
  })
})

describe('C4 regola 3: la larghezza è UNA e non dipende dalla scheda', () => {
  it('nessuna width="page" (la larghezza non esiste più) e nessuna width calcolata sulla scheda', () => {
    const problemi: string[] = []
    for (const f of renderer) {
      if (/width="page"/.test(f.testo)) problemi.push(`${f.rel}: width="page" (esiste solo wide | reading)`)
      // width={cond ? … : …} SUL GUSCIO: la larghezza che CAMBIA con la scheda
      if (/<(?:PageShell|PageColumn|ListPage|DetailPage|DocumentPage)\b[\s\S]{0,400}?width=\{[^}"'`]*\?/g.test(f.testo)) {
        problemi.push(`${f.rel}: width dinamica sul guscio (la larghezza non dipende dalla scheda)`)
      }
    }
    expect(problemi).toEqual([])
  })
})

describe('C4 regola 4: al massimo UN UnderlineTabs per pagina', () => {
  it('nessun file fuori da ui/ monta Due UnderlineTabs (le strade interne sono pillole)', () => {
    const problemi: string[] = []
    for (const f of renderer) {
      const n = (f.testo.match(/<UnderlineTabs/g) ?? []).length
      if (n > 1) problemi.push(`${f.rel}: ${n} UnderlineTabs (una fila sola: le strade interne sono pillole nella barra)`)
    }
    expect(problemi).toEqual([])
  })
})

describe('C4 regola 6: nessun componente INUTILIZZATO (la logica del censimento)', () => {
  it('il censimento di esporta-inutilizzati non trova COMPONENTI inutilizzati (nome maiuscolo, nessuno li importa)', () => {
    const r = spawnSync('node', [join(RADICE, 'scripts', 'esporta-inutilizzati.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: RADICE })
    expect(r.status, r.stderr?.slice(0, 500) ?? 'il censimento').toBe(0)
    const censimento = JSON.parse(r.stdout) as { rows: Array<{ file: string; name: string; status: string }> }
    const morti = censimento.rows
      .filter((x) => x.status === 'INUTILIZZATO' && /^[A-Z]/.test(x.name))
      .map((x) => `${x.file}: ${x.name}`)
    expect(morti, 'componenti che nessuno importa (via, o esportali per il prodotto)').toEqual([])
  }, 120_000)
})

describe('C4 regola 5: nessun file col nome di una finestra che non esiste', () => {
  it('components/ non ha *Window.tsx (le finestre sono pagine da PL7; chi resta è un pezzo con il suo nome)', () => {
    const finestre: string[] = []
    const scandi = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome)
        const st = statSync(p)
        if (st.isDirectory()) { scandi(p); continue }
        if (/Window\.tsx$/.test(nome)) finestre.push(p.slice(RADICE.length + 1))
      }
    }
    scandi(join(RADICE, 'src/renderer/src/components'))
    expect(finestre).toEqual([])
  })
})
