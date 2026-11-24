// R5 (b20-ritocchi): il colore dei PUNTINI dei bot. Il difetto visto nella
// verifica di fase-design: nella barra in tema scuro il puntino del membro
// «Scrittura» era NERO su fondo nero (il c7 della palette, pensato per le
// forme grandi della mascotte, su un pallino da 8 px sparisce). La regola
// che vale adesso, e che la sonda di fase-design misura su OGNI puntino:
// contrasto ≥ 3:1 col fondo della riga (card e muted: normale e attiva), in
// CHIARO e in SCURO. La palette dei puntini (--bot-dot-*) tiene la TINTA di
// ogni bot e cambia la LUMINOSITÀ per tema: la mascotte resta sé stessa
// (--bot-c* non si tocca: è lei), il puntino si vede.
//
// Qui si prova la MATEMATICA (oklch → sRGB → luminanza relativa → contrasto
// WCAG) sui valori dichiarati in styles.css, e che i componenti li USINO:
// il pallino della barra, il cerchio della rotaia e il disco del nome in
// squadra. Niente DOM per i colori: si leggono dal CSS, come design-tokens.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import './render-helper-install'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf, type HtmlNode } from './render-helper'
import { setStoreStateForRender } from './render-helper'

const CSS = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8')

// ---- oklch → sRGB → contrasto WCAG (la stessa matematica della sonda) ----

const oklchToSrgb = (L: number, C: number, H: number): [number, number, number] => {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const gam = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055)
  return [gam(r), gam(g), gam(bb)].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
}
const luminanza = (rgb: readonly number[]): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!
const contrasto = (x: readonly number[], y: readonly number[]): number => {
  const a = luminanza(x)
  const b = luminanza(y)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** I valori oklch di una variabile nel blocco theme dato (il primo che compare). */
const varsOf = (block: string): Record<string, [number, number, number]> => {
  const out: Record<string, [number, number, number]> = {}
  // il blocco VERO: «:root {» / «.dark {» — nei commenti se ne parlava già
  // prima, e un semplice indexOf ci finiva dentro
  const start = CSS.indexOf(block === ':root' ? ':root {' : '.dark {')
  const end = CSS.indexOf('\n}', start)
  const body = CSS.slice(start, end === -1 ? undefined : end)
  for (const m of body.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    if (!out[m[1]!]) out[m[1]!] = [Number(m[2]), Number(m[3]), Number(m[4])]
  }
  return out
}

const COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] as const

describe('R5 (b20-ritocchi): i puntini dei bot si vedono — contrasto ≥ 3:1 sul fondo della riga, in entrambi i temi', () => {
  it('la palette dei puntini c’è per tutti e sette i colori, in chiaro e in scuro', () => {
    for (const tema of [':root', '.dark'] as const) {
      const vars = varsOf(tema)
      for (const c of COLORS) expect(vars[`bot-dot-${c}`], `${tema} --bot-dot-${c}`).toBeDefined()
    }
  })

  it('ogni puntino ha contrasto ≥ 3:1 su CARD e MUTED (riga normale e attiva), in chiaro e in scuro', () => {
    for (const [tema, bgs] of [[':root', ['card', 'muted']], ['.dark', ['card', 'muted']]] as const) {
      const vars = varsOf(tema)
      for (const c of COLORS) {
        const dot = vars[`bot-dot-${c}`]
        for (const bg of bgs) {
          const ratio = contrasto(oklchToSrgb(...dot), oklchToSrgb(...vars[bg]!))
          expect(ratio, `${tema} ${c} su ${bg}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('la TINTA è quella del bot (stessa cromatità della mascotte), cambia solo la luminosità', () => {
    // la palette della mascotte (--bot-c*) sta solo in :root: il tema scuro
    // la eredita — la tinta del puntino si confronta con quella
    const base = varsOf(':root')
    for (const tema of [':root', '.dark'] as const) {
      const vars = varsOf(tema)
      for (const c of COLORS) {
        expect(vars[`bot-dot-${c}`]![1], `${tema} ${c}: la cromatità`).toBe(base[`bot-${c}`]![1])
        expect(vars[`bot-dot-${c}`]![2], `${tema} ${c}: la tinta`).toBe(base[`bot-${c}`]![2])
      }
    }
  })
})

// ---- chi li usa: il pallino della barra, il cerchio della rotaia, il disco del nome in squadra ----

const agentC7 = {
  id: 'b7', name: 'Scrittura', description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null,
  // il colore che non si vedeva: quasi nero su fondo scuro
  avatar: { family: 'h-creature', color: 'c7' }
} as never

describe('R5: i componenti usano la palette dei puntini', () => {
  it('il pallino della barra e il cerchio della rotaia: var(--bot-dot-…), mai la palette della mascotte', async () => {
    const { Sidebar } = await import('../components/Sidebar')
    const { useStore } = await import('../store')
    const layoutFull = { sidebar: 'full' as const, sidebarWidth: 264, panel: 'hidden' as const, panelWidth: 0 }
    setStoreStateForRender(useStore, {
      onboarding: { needed: false, state: null, sequence: ['chat'], modelReady: false, guideOpen: false },
      agents: [{ id: 'main', name: 'Bot', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }, agentC7],
      groups: [], mainAgentId: 'main', activeId: 'main', openGroupId: null,
      previews: {}, turnEnds: {}, lastSendAt: {}, typingAgentId: null, lastDeltaAt: {}, nowTick: 0,
      approvalsAll: [], approvalsBotCount: {}, groupPendingCount: {}, activityOpen: false, openLibraryId: null,
      approvalsOpen: false, pluginOpen: false, subagents: [], activity: {}, windowWidth: 1400,
      sidebarArchivedOpen: false, removedUndo: null
    })
    const tree = parseHtml(renderHtml(createElement(Sidebar, { layout: layoutFull })))
    const dot = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-dot-color')[0]!
    expect((dot.attrs.style ?? '').trim()).toBe('background:var(--bot-dot-c7)')

    const layoutRail = { sidebar: 'rail' as const, sidebarWidth: 76, panel: 'hidden' as const, panelWidth: 0 }
    const rail = parseHtml(renderHtml(createElement(Sidebar, { layout: layoutRail })))
    const circle = findAll(rail, (n) => n.attrs['data-testid'] === 'rail-bot-circle')
      .find((n) => textOf(n) === 'S')!
    expect(circle.attrs.style).toContain('background:var(--bot-dot-c7)')
  })

  it('il disco del nome in squadra (il membro che parla): var(--bot-dot-…)', async () => {
    const src = readFileSync(fileURLToPath(new URL('../components/TeamChat.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('background: `var(--bot-dot-${av.color})`')
    expect(src).not.toContain('background: `var(--bot-${av.color})`')
  })
})
