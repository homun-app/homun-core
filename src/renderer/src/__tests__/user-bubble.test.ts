// Fase 0.3.1001 grafica (G1): la bolla dei messaggi dell'utente è NEUTRA.
// Colore fisso della chat per ogni bot, in chiaro e in scuro — mai il colore
// del bot (che resta all'identità: mascotte, pillola in alto, avatar).
// Senza DOM (niente jsdom), come le altre guardie del renderer: si legge il
// sorgente di styles.css e dei componenti, e il contrasto si calcola DAI
// VALORI OKLCH dei token (stessa matematica di WCAG 2.1: oklch → oklab →
// linear sRGB → luminanza relativa).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = fileURLToPath(new URL('../styles.css', import.meta.url))
const CHAT = fileURLToPath(new URL('../components/Chat.tsx', import.meta.url))
const TEAM = fileURLToPath(new URL('../components/TeamChat.tsx', import.meta.url))

/** Estrae un blocco `selettore { … }` da styles.css (il primo che matcha). */
function cssBlock(selector: string): string {
  const src = readFileSync(CSS, 'utf8')
  const start = src.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`blocco ${selector} non trovato in styles.css`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

/** Il valore di una variabile CSS oklch dentro un blocco (es. --bubble-user). */
function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)
  if (!m) throw new Error(`--${name} non trovato nel blocco`)
  return m[1]!.trim()
}

/** oklch(L C H) → [r, g, b] LINEARI 0–1 (oklch → oklab → LMS → linear sRGB). */
function oklchToLinearRgb(value: string): [number, number, number] {
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(value)
  if (!m) throw new Error(`non è un oklch numerico: ${value}`)
  const [L, C, H] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const rad = (H * Math.PI) / 180
  const a = C * Math.cos(rad)
  const b = C * Math.sin(rad)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const mm = m_ ** 3
  const s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s
  ]
}

/** Luminanza relativa WCAG (sRGB lineari) e rapporto di contrasto 4,5:1. */
function contrastRatio(fg: string, bg: string): number {
  const lum = (v: string) => {
    const [r, g, b] = oklchToLinearRgb(v)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [y1, y2] = [lum(fg), lum(bg)].sort((x, w) => w - x)
  return (y1 + 0.05) / (y2 + 0.05)
}

describe('G1: la bolla utente è neutra (token in chiaro e in scuro)', () => {
  const light = cssBlock(':root')
  const dark = cssBlock('.dark')

  it('i token --bubble-user / --bubble-user-foreground esistono in entrambi i temi', () => {
    for (const block of [light, dark]) {
      expect(token(block, 'bubble-user')).toMatch(/^oklch\(/)
      expect(token(block, 'bubble-user-foreground')).toMatch(/^oklch\(/)
    }
  })

  it('il valore iniziale è quello di --primary / --primary-foreground (entrambi i temi)', () => {
    for (const block of [light, dark]) {
      expect(token(block, 'bubble-user')).toBe(token(block, 'primary'))
      expect(token(block, 'bubble-user-foreground')).toBe(token(block, 'primary-foreground'))
    }
  })

  it('contrasto testo/sfondo ≥ 4,5:1 in chiaro e in scuro', () => {
    const lightRatio = contrastRatio(token(light, 'bubble-user-foreground'), token(light, 'bubble-user'))
    const darkRatio = contrastRatio(token(dark, 'bubble-user-foreground'), token(dark, 'bubble-user'))
    expect(lightRatio).toBeGreaterThanOrEqual(4.5)
    expect(darkRatio).toBeGreaterThanOrEqual(4.5)
  })
})

describe('G1: i componenti usano i token, non il colore del bot', () => {
  it('la bolla utente di Chat.tsx usa --bubble-user e non --bot-*', () => {
    const src = readFileSync(CHAT, 'utf8')
    // la classe della bolla: il div col commento «bolla utente a destra»
    const m = /bolla utente a destra[\s\S]{0,400}?<div className="([^"]*bg-\[var\(--bubble-user\)\][^"]*)"/.exec(src)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('text-[var(--bubble-user-foreground)]')
  })

  it('la bolla utente di TeamChat.tsx usa gli stessi token', () => {
    const src = readFileSync(TEAM, 'utf8')
    const m = /className="([^"]*bg-\[var\(--bubble-user\)\][^"]*)"/.exec(src)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('text-[var(--bubble-user-foreground)]')
  })

  it('nessun --bot-* rimane nei sorgenti delle due chat per le bolle utente', () => {
    const chat = readFileSync(CHAT, 'utf8')
    const team = readFileSync(TEAM, 'utf8')
    // Chat.tsx non ha più alcun var(--bot- (prima ce l'aveva per la bolla)
    expect(chat).not.toContain('var(--bot-')
    // TeamChat.tsx lo conserva SOLO per l'identità: la pillola @menzione
    // (colore del bot menzionato + --bot-ink per il testo su di essa) e il
    // nome/riepilogo del bot — 3 occorrenze, nessuna per l'utente
    const botUses = team.split('var(--bot-').length - 1
    expect(botUses).toBe(3)
  })
})
