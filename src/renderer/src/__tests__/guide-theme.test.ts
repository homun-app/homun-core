// G7 (fase guida): tema e accessibilità della guida — chiaro e scuro coi
// token esistenti. I testi (anche le righe grigie piccole) devono avere
// contrasto ≥ 4,5:1, e nel tema SCURO le schede si staccano dal fondo unico
// ANCHE per luminosità. La riga verde della guida usa un token DEDICATO
// (--guide-good): il chart-2 del tema chiaro è troppo chiaro per un testo.
// Bersagli dei clic ≥ 44 px, e mai informazione affidata solo al colore
// (aria-pressed sugli stati scelti). Stessa matematica WCAG di user-bubble.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = fileURLToPath(new URL('../styles.css', import.meta.url))
const GUIDE = fileURLToPath(new URL('../components/GuideView.tsx', import.meta.url))
const MODEL = fileURLToPath(new URL('../components/GuideModelStep.tsx', import.meta.url))
const css = readFileSync(CSS, 'utf8')
const guideSrc = readFileSync(GUIDE, 'utf8')
const modelSrc = readFileSync(MODEL, 'utf8')

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`blocco ${selector} non trovato`)
  return css.slice(start, css.indexOf('\n}', start))
}

function tokenOf(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)
  if (!m) throw new Error(`--${name} non trovato`)
  return m[1]!.trim()
}

function oklchToLinearRgb(value: string): [number, number, number] {
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(value)
  if (!m) throw new Error(`non è un oklch numerico: ${value}`)
  const [L, C, H] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3
  const mm = m_ ** 3
  const s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s
  ]
}

const lum = (v: string): number => {
  const [r, g, b] = oklchToLinearRgb(v)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(fg: string, bg: string): number {
  const [y1, y2] = [lum(fg), lum(bg)].sort((x, w) => w - x)
  return (y1 + 0.05) / (y2 + 0.05)
}

const root = cssBlock(':root')
const dark = cssBlock('.dark')

describe('G7: i testi della guida hanno contrasto ≥ 4,5:1 in chiaro e in scuro', () => {
  it('muted-foreground (le righe grigie piccole) su background e su card', () => {
    for (const [name, block] of [['chiaro', root], ['scuro', dark]] as const) {
      const bg = tokenOf(block, 'background')
      const card = tokenOf(block, 'card')
      const mute = tokenOf(block, 'muted-foreground')
      expect(contrastRatio(mute, bg), `${name}: muted-foreground su background`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(mute, card), `${name}: muted-foreground su card`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('foreground su background e su card', () => {
    for (const [name, block] of [['chiaro', root], ['scuro', dark]] as const) {
      const bg = tokenOf(block, 'background')
      const card = tokenOf(block, 'card')
      const fg = tokenOf(block, 'foreground')
      expect(contrastRatio(fg, bg), `${name}: foreground su background`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(fg, card), `${name}: foreground su card`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('la riga verde della guida (--guide-good) ha il suo contrasto, anche nel chiaro (il chart-2 no)', () => {
    // il token dedicato ESISTE nei due temi
    const goodLight = tokenOf(root, 'guide-good')
    const goodDark = tokenOf(dark, 'guide-good')
    expect(contrastRatio(goodLight, tokenOf(root, 'card'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(goodDark, tokenOf(dark, 'card'))).toBeGreaterThanOrEqual(4.5)
    // nel tema chiaro chart-2 NON basta per un testo: per questo la guida
    // usa il token dedicato
    expect(contrastRatio(tokenOf(root, 'chart-2'), tokenOf(root, 'card'))).toBeLessThan(4.5)
  })

  it('destructive (la riga dell\'errore) su card nei due temi', () => {
    expect(contrastRatio(tokenOf(root, 'destructive'), tokenOf(root, 'card'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(tokenOf(dark, 'destructive'), tokenOf(dark, 'card'))).toBeGreaterThanOrEqual(4.5)
  })

  it('nel tema SCURO le schede si staccano dal fondo unico anche per luminanza (ΔL ≥ 0,05)', () => {
    const L = (v: string) => Number(/oklch\(([\d.]+)/.exec(v)![1])
    const dCard = L(tokenOf(dark, 'card'))
    const dBg = L(tokenOf(dark, 'background'))
    expect(dCard - dBg).toBeGreaterThanOrEqual(0.05)
  })
})

describe('G7: bersagli ≥ 44 px e mai informazione solo dal colore', () => {
  it('i controlli della guida dichiarano altezza minima 44 px (h-11 / min-h-11 / min-h-[44px])', () => {
    // i tondi dei colori: bottone 44 con il cerchio visibile da 34
    expect(guideSrc).toMatch(/guide-color-[\s\S]{0,400}size-11/)
    // le piastrelle delle facce e le schede dei permessi
    expect(guideSrc).toContain('min-h-[44px]')
    // la select della lingua, i bottoni di ritorno, le pillole dei modelli
    expect(guideSrc).toMatch(/guide-language-select[\s\S]{0,300}min-h-\[44px\]|h-11/)
    expect(modelSrc).toContain('min-h-[44px]')
    // GC2: le pillole dei modelli condividono pillCls (min-h-[44px] dentro)
    expect(modelSrc).toMatch(/const pillCls = 'max-w-full min-h-\[44px\]/)
    expect(modelSrc).toMatch(/guide-model-\$\{m\}[\s\S]{0,300}\$\{pillCls\}/)
  })

  it('gli stati scelti si vedono anche senza colore: aria-pressed su facce, colori, permessi, modelli e Ollama', () => {
    expect((guideSrc.match(/aria-pressed=/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((modelSrc.match(/aria-pressed=/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('il movimento ridotto spegne anche la scena della guida (ombra compresa)', () => {
    expect(css).toMatch(/prefers-reduced-motion[\s\S]{0,400}\.guide-float, \.guide-shadow, \.guide-stepin, \.guide-bubble-pop \{ animation: none \}/)
  })
})

describe('GC4: le sbavature viste nelle catture', () => {
  const BOT = fileURLToPath(new URL('../bot/Bot.tsx', import.meta.url))
  const botSrc = readFileSync(BOT, 'utf8')

  it('GC4.1 i puntini di thinking si vedono su ENTRAMBI i temi (muted-foreground, non bot-ink)', () => {
    // nel tema scuro --bot-ink è quasi nero su fondo scuro: i puntini spariscono.
    // --muted-foreground si vede sui due temi (chiaro 0.5 / scuro 0.7)
    const extras = botSrc.slice(botSrc.indexOf('function Extras'), botSrc.indexOf('const JELLY'))
    expect(extras).toContain('var(--muted-foreground)')
    expect(extras).not.toContain('var(--bot-ink)')
  })

  it('GC4.1 l\'ombra sotto la mascotte: nel tema scuro un alone chiaro molto tenue', () => {
    // il colore dell\'ombra sta nel CSS (non più inline): la variante .dark
    // la rende un alone chiaro, perché quella scura sparisce sul fondo scuro
    expect(guideSrc).not.toContain('rgba(40,30,10')
    const darkShadow = css.indexOf('.dark .guide-shadow')
    expect(darkShadow).toBeGreaterThanOrEqual(0)
    const block = css.slice(darkShadow, css.indexOf('\n}', darkShadow))
    expect(block).toMatch(/rgba\(2\d\d,/)
  })
})
