// Fase design (DS4 — barra di sinistra, BotScreen): LO SCHERMO DEL BOT ai
// token di DS1. È il pannello che il DS4 della barra porta con sé (sta nella
// sua lista di file), non un dialogo: qui si cambia soltanto COME SI VEDE —
// misure, pesi, raggi, icone — con la stessa logica di sempre.
//   - la testata: «Schermo del bot» è il titolo del blocco, text-body 500
//     (prima un sopratitolo di 10 px in maiuscoletto: i maiuscoletti non
//     esistono più, e due righe grigie da 12 px una sopra l'altra non
//     avrebbero gerarchia); sotto, lo stato è un metadato: text-caption grigio;
//   - i comandi sono bottoni da 32 (h-control-sm), text-body, col raggio dei
//     controlli: «Stacca» e «Prendi il controllo» con Button (secondary), il
//     «Chiudi» un'icona lucide in un bottone tondo da 32 — prima era il
//     carattere «✕» al posto di un'icona;
//   - i campi (la nota per il bot) alti 36, text-body, px-3;
//   - nessuna misura libera: il posto dello schermo quando è nella finestra a
//     parte non scende sotto 320 px (min-h-80), prima era scritto tra quadre.
// Il render statico non apre la connessione (phase resta idle): quel che non
// si vede si legge nel sorgente, dalle stringhe dell'AST come la guardia.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { stringsOf } from './design-scan'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
// il canvas di noVNC non serve: qui si prova COME SI VEDE, non il collegamento
vi.mock('@novnc/novnc', () => ({ default: class FakeRfb {} }))

const { BotScreen } = await import('../components/BotScreen')
const { useStore } = await import('../store')

const SRC = readFileSync(fileURLToPath(new URL('../components/BotScreen.tsx', import.meta.url)), 'utf8')
const STRINGS = stringsOf(SRC)

const agent = () => ({
  id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1
})

function renderScreen(mode: 'view' | 'control', inPanel = true): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    agents: [agent()],
    activeId: 'bot-1',
    computerPanel: { open: false, tab: 'screen', mode },
    pipAgentId: null
  })
  return parseHtml(renderHtml(createElement(BotScreen, { agentId: 'bot-1', inPanel })))
}

const cls = (n: HtmlNode): string[] => (n.attrs.class ?? '').split(/\s+/).filter(Boolean)
const has = (n: HtmlNode, c: string): boolean => cls(n).includes(c)
const byId = (tree: ReturnType<typeof parseHtml>, testId: string): HtmlNode => findAll(tree, (n) => n.attrs['data-testid'] === testId)[0]!
const pWith = (tree: ReturnType<typeof parseHtml>, text: string): HtmlNode => findAll(tree, (n) => n.tag === 'p' && textOf(n).includes(text))[0]!
const svgIn = (n: HtmlNode): HtmlNode => findAll(n, (s) => s.tag === 'svg')[0]!

describe('DS4 barra: la testata dello schermo del bot', () => {
  it('«Schermo del bot» è il titolo del blocco (text-body 500, niente maiuscoletto); lo stato sotto è un metadato (text-caption grigio)', () => {
    const tree = renderScreen('view')
    const title = pWith(tree, 'Schermo del bot')
    for (const c of ['text-body', 'font-medium']) expect(has(title, c), c).toBe(true)
    expect(cls(title).filter((c) => /^(uppercase|tracking-)/.test(c)), 'nessun maiuscoletto').toEqual([])
    const state = pWith(tree, 'Vista dal vivo del computer del bot')
    for (const c of ['text-caption', 'text-muted-foreground']) expect(has(state, c), c).toBe(true)
  })

  it('«Stacca»: un bottone da 32, text-body, col raggio dei controlli e l’icona di 16 — e il testo è sempre quello', () => {
    const tree = renderScreen('view')
    const detach = byId(tree, 'bot-screen-detach')
    expect(textOf(detach)).toBe('Stacca')
    for (const c of ['h-control-sm', 'rounded-control', 'text-body', 'font-medium']) expect(has(detach, c), c).toBe(true)
    expect(has(svgIn(detach), 'size-4')).toBe(true)
    expect(detach.attrs['data-slot']).toBe('button')
  })

  it('in controllo «Ho finito» è un bottone da 32, text-body, col raggio dei controlli e il colore del bot', () => {
    const tree = renderScreen('control')
    const done = byId(tree, 'bot-screen-done')
    expect(textOf(done)).toBe('Ho finito')
    for (const c of ['h-control-sm', 'rounded-control', 'text-body', 'font-medium']) expect(has(done, c), c).toBe(true)
    expect(String(done.attrs.style ?? '')).toContain('var(--bot-')
  })

  it('fuori dal pannello «Chiudi» è un’ICONA lucide (16) in un bottone tondo da 32, non il carattere «✕»; la scheda ha il raggio delle superfici', () => {
    const tree = renderScreen('view', false)
    const close = findAll(tree, (n) => n.tag === 'button' && n.attrs.title === 'Chiudi')[0]!
    expect(textOf(close)).toBe('')
    // Button scrive il quadrato dell'icona come altezza e larghezza (h-control-sm w-control-sm)
    for (const c of ['h-control-sm', 'w-control-sm', 'rounded-full']) expect(has(close, c), c).toBe(true)
    expect(has(svgIn(close), 'size-4')).toBe(true)
    const section = findAll(tree, (n) => n.tag === 'section')[0]!
    expect(has(section, 'rounded-surface')).toBe(true)
  })
})

describe('DS4 barra: lo schermo del bot — i campi e le misure, dal sorgente', () => {
  it('la nota per il bot è un campo da 36, text-body, px-3, col raggio dei controlli', () => {
    expect(SRC).toContain('className="h-control w-full rounded-control bg-muted px-3 text-body outline-none placeholder:text-muted-foreground"')
  })

  it('il posto dello schermo (quando è nella finestra a parte) non scende sotto 320 px, senza misure tra quadre', () => {
    expect(SRC).toContain('min-h-80 flex-1 flex-col items-center justify-center gap-3 bg-black/40')
    expect(STRINGS.flatMap((s) => /[\w-]+-\[[^\]]*\]/g.exec(s) ?? []), 'nessuna classe con le quadre').toEqual([])
  })

  it('l’anello del fuoco solo da tastiera: mai la variante focus:', () => {
    expect(STRINGS.filter((s) => /(^|\s)focus:/.test(s))).toEqual([])
  })

  it('i comandi che il render statico non mostra («Prendi il controllo», «Apri», «Riprova», «Riporta qui») passano da Button: resta UN solo bottone scritto a mano, «Ho finito», e porta le classi del pezzo', () => {
    // Button non ha la variante «col colore del bot»: «Ho finito» prende le classi del pezzo (buttonVariants) e il colore in stile in linea
    expect(SRC.match(/<button\b/g) ?? [], 'un solo <button> a mano: «Ho finito»').toHaveLength(1)
    expect(SRC).toMatch(/data-testid="bot-screen-done"\s+className=\{buttonVariants\(\{[^}]*\}\)\}/)
    // Stacca · Ferma e prendi il controllo · Prendi il controllo · Chiudi · Riporta qui · Apri · Riprova
    expect(SRC.match(/<Button\b/g) ?? [], 'i comandi resi con il pezzo Button').toHaveLength(7)
  })
})
