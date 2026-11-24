// Fase design (DS1): i TOKEN del sistema, in styles.css. «Un sistema di
// regole piccolo, scritto in un posto solo»: questo test guarda il POSTO
// (il blocco @theme) e, con il CSS compilato da Tailwind, che ogni token
// generi davvero la sua utility con il valore deciso. Valori decisi in DS1:
//   tipografia  — sei dimensioni, ognuna con la sua interlinea:
//                 caption 12/16 · small 13/18 · body 14/20 · reading 16/26 · title 20/28 · page 28/34;
//                 Figtree per tutto, Bricolage Grotesque (font-display) per i titoli;
//   spaziatura  — la scala di Tailwind; con un NOME: margine della pagina (32, 24 stretta),
//                 tra sezioni 32, titolo→contenuto 12, tra blocchi 16, riga 52 (40 solo testo),
//                 respiro della riga 12, icona→testo 12, controlli 36 e 32,
//                 la riga in cima a ogni colonna 52;
//   raggi       — tre: control 8, surface 14, full;
//   larghezze   — reading 720, page 880, wide 1120.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compileRenderer, CSS_PATH, deadClasses } from './tailwind-compile'

const CSS = readFileSync(CSS_PATH, 'utf8')

/** Le sei dimensioni di testo: nome → [dimensione, interlinea]. */
export const TEXT_SIZES: Readonly<Record<string, [number, number]>> = {
  caption: [12, 16],
  small: [13, 18],
  body: [14, 20],
  reading: [16, 26],
  title: [20, 28],
  page: [28, 34]
}
/** Le distanze con un nome (px). */
export const NAMED_SPACING: Readonly<Record<string, number>> = {
  'page-margin': 32,
  'page-margin-narrow': 24,
  section: 32,
  'section-head': 12,
  block: 16,
  row: 52,
  'row-text': 40,
  'row-pad': 12,
  'row-gap': 12,
  control: 36,
  'control-sm': 32,
  'col-head': 52
}
/** I tre raggi (px). */
export const RADII: Readonly<Record<string, number>> = { control: 8, surface: 14 }
/** Le larghezze del contenuto (px). */
export const WIDTHS: Readonly<Record<string, number>> = { reading: 720, page: 880, wide: 1120 }

/** Il valore di una variabile del tema nel CSS compilato (`--nome: valore;`). */
const themeValue = (css: string, name: string): string | null => {
  const m = new RegExp(`--${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(css)
  return m ? m[1]!.trim() : null
}

describe('DS1: i token di tipografia', () => {
  it('sei dimensioni con la loro interlinea, nel @theme di styles.css', () => {
    for (const [name, [size, line]] of Object.entries(TEXT_SIZES)) {
      expect(CSS, `--text-${name}`).toMatch(new RegExp(`--text-${name}:\\s*${size}px;`))
      expect(CSS, `--text-${name}--line-height`).toMatch(new RegExp(`--text-${name}--line-height:\\s*${line}px;`))
    }
    // nessuna SETTIMA dimensione di testo nel tema
    const declared = [...CSS.matchAll(/--text-([a-z]+):/g)].map((m) => m[1])
    expect([...new Set(declared)].sort()).toEqual(Object.keys(TEXT_SIZES).sort())
  })

  it('compilate: ogni dimensione è una utility con la sua interlinea', async () => {
    const css = await compileRenderer(Object.keys(TEXT_SIZES).map((n) => `text-${n}`))
    for (const [name, [size, line]] of Object.entries(TEXT_SIZES)) {
      expect(themeValue(css, `text-${name}`)).toBe(`${size}px`)
      expect(themeValue(css, `text-${name}--line-height`)).toBe(`${line}px`)
      expect(css).toMatch(new RegExp(`\\.text-${name}\\s*\\{[^}]*font-size:\\s*var\\(--text-${name}\\)`))
      expect(css).toMatch(new RegExp(`\\.text-${name}\\s*\\{[^}]*line-height:\\s*var\\(--tw-leading,\\s*var\\(--text-${name}--line-height\\)\\)`))
    }
  })

  it('il default dell’interfaccia è text-body: 14/20 sul body (senza toccare la radice, che porta la scala dei 4 px)', () => {
    expect(CSS).toMatch(/@layer base\s*\{[\s\S]*?\bbody\s*\{[^}]*font-size:\s*var\(--text-body\);[^}]*line-height:\s*var\(--text-body--line-height\);/)
    // la radice resta a 16 px: la spaziatura di Tailwind è in rem
    expect(CSS).not.toMatch(/(:root|html)\s*\{[^}]*font-size:/)
  })

  it('Figtree per tutto, Bricolage Grotesque come font-display', () => {
    expect(CSS).toMatch(/--font-sans:\s*"Figtree Variable"/)
    expect(CSS).toMatch(/--font-display:\s*"Bricolage Grotesque Variable"/)
  })

  it('le taglie di Tailwind NON sono nel tema (text-xs, text-sm… non hanno più una dimensione propria)', () => {
    for (const size of ['xs', 'sm', 'base', 'lg', 'xl', '2xl']) {
      expect(CSS, `--text-${size}`).not.toMatch(new RegExp(`--text-${size}:`))
    }
  })
})

describe('DS1: le distanze con un nome', () => {
  it('i valori decisi, nel @theme static come variabili di spaziatura (valgono per ogni utility: p-, gap-, h-…)', async () => {
    const css = await compileRenderer(['p-section', 'gap-block', 'h-control', 'min-h-row'])
    for (const [name, px] of Object.entries(NAMED_SPACING)) {
      expect(CSS, `--spacing-${name}`).toMatch(new RegExp(`--spacing-${name}:\\s*${px}px;`))
      expect(themeValue(css, `spacing-${name}`), `compilata --spacing-${name}`).toBe(`${px}px`)
    }
    expect(css).toMatch(/\.p-section\s*\{[^}]*padding:\s*var\(--spacing-section\)/)
    expect(css).toMatch(/\.h-control\s*\{[^}]*height:\s*var\(--spacing-control\)/)
    expect(css).toMatch(/\.min-h-row\s*\{[^}]*min-height:\s*var\(--spacing-row\)/)
  })

  it('la scala di Tailwind resta quella (multipli di 4 px)', () => {
    expect(CSS).not.toMatch(/--spacing:\s/)
  })
})

describe('DS1: i raggi', () => {
  it('tre: control 8, surface 14, full — e le utility compilate', async () => {
    const css = await compileRenderer(['rounded-control', 'rounded-surface', 'rounded-full'])
    for (const [name, px] of Object.entries(RADII)) {
      expect(CSS, `--radius-${name}`).toMatch(new RegExp(`--radius-${name}:\\s*${px}px;`))
      expect(themeValue(css, `radius-${name}`), `compilata --radius-${name}`).toBe(`${px}px`)
      expect(css).toMatch(new RegExp(`\\.rounded-${name}\\s*\\{[^}]*border-radius:\\s*var\\(--radius-${name}\\)`))
    }
    expect(css).toMatch(/\.rounded-full\s*\{[^}]*border-radius:/)
  })
})

describe('DS1: le larghezze del contenuto', () => {
  it('reading 720, page 880, wide 1120 — come variabili e come max-w-', async () => {
    const css = await compileRenderer(['max-w-reading', 'max-w-page', 'max-w-wide'])
    for (const [name, px] of Object.entries(WIDTHS)) {
      expect(CSS, `--w-${name}`).toMatch(new RegExp(`--w-${name}:\\s*${px}px;`))
      expect(themeValue(css, `w-${name}`), `compilata --w-${name}`).toBe(`${px}px`)
      expect(css).toMatch(new RegExp(`\\.max-w-${name}\\s*\\{[^}]*max-width:\\s*var\\(--container-${name}\\)`))
      expect(themeValue(css, `container-${name}`)).toBe(`var(--w-${name})`)
    }
  })
})

/** Le classi di fabbrica che il sistema NON usa (DS6): nel CSS compilato non generano più nessuna regola. */
export const FACTORY_CLASSES = [
  // le taglie di testo di Tailwind
  'text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl', 'text-3xl',
  // i raggi di fabbrica
  'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-2xl', 'rounded-3xl', 'rounded-4xl',
  // i pesi fuori da 400, 500, 600
  'font-thin', 'font-light', 'font-bold', 'font-extrabold', 'font-black',
  // le interlinee con nome e le spaziature delle lettere
  'leading-tight', 'leading-snug', 'leading-relaxed', 'leading-loose', 'tracking-tight', 'tracking-wide', 'tracking-normal'
]

describe('DS6: le misure di fabbrica sono fuori dal tema', () => {
  it('chi scrivesse una taglia, un raggio, un peso, un’interlinea o una spaziatura delle lettere di fabbrica non ottiene nulla', async () => {
    const css = await compileRenderer(FACTORY_CLASSES)
    // il sorgente le dichiara tutte morte: `initial` a ognuna delle cinque famiglie
    expect(CSS).toMatch(/@theme\s*\{[^}]*--text-\*:\s*initial;[^}]*--radius-\*:\s*initial;[^}]*--font-weight-\*:\s*initial;[^}]*--leading-\*:\s*initial;[^}]*--tracking-\*:\s*initial;/)
    // e il CSS compilato non ha nessuna regola per loro
    expect(deadClasses(css, FACTORY_CLASSES).sort()).toEqual([...FACTORY_CLASSES].sort())
  })
  it('restano le sei dimensioni, i tre raggi, i tre pesi, i caratteri — e nessun quarto peso', async () => {
    const vive = [...Object.keys(TEXT_SIZES).map((n) => `text-${n}`), 'rounded-control', 'rounded-surface', 'rounded-full', 'font-normal', 'font-medium', 'font-semibold', 'font-display', 'font-sans', 'font-mono']
    const css = await compileRenderer(vive)
    expect(deadClasses(css, vive)).toEqual([])
    for (const [name, value] of [['normal', 400], ['medium', 500], ['semibold', 600]] as const) {
      expect(themeValue(css, `font-weight-${name}`), `peso ${name}`).toBe(String(value))
    }
    const nomiDi = (variabile: string): string[] => [...new Set([...css.matchAll(new RegExp(`${variabile}-([a-z]+):`, 'g'))].map((m) => String(m[1])))].sort()
    expect(nomiDi('--font-weight')).toEqual(['medium', 'normal', 'semibold'])
    expect(nomiDi('--radius')).toEqual(['control', 'surface'])
  })
})
