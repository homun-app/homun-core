// PP1 (fase plugin-pulita): la pagina Plugin scorre, e la scheda pure.
// jsdom non c'è e non fa layout: qui si verifica il CONTRATTO di scorribilità
// — il corpo che scorre (overflow-y-auto) figlio diretto della radice
// inchiodata (absolute inset-0) — e che lista, viste e scheda montino IL
// guscio (niente `absolute inset-0` scritto a mano in PluginPanel /
// PluginCard). La prova vera, misurata sul DOM vivo a 1200×800 e a 900×600, è
// la sonda (scripts/fase-plugin-pulita-probe.mjs).
//
// Fase design (DS4): il guscio è PageShell (components/ui/page-shell) —
// PluginShell non c'è più, e questo file ne tiene il posto. Cambia il
// contratto in due punti, e sono i due di DS2: il corpo che scorre è figlio
// DIRETTO della radice (prima c'era una colonna in mezzo: teneva la barra di
// scorrimento lontana dal bordo), e dentro il corpo il contenuto è centrato
// alla larghezza scelta (data-page-content: page, wide solo su «Collegati»).
// Il contratto del guscio in sé sta in ui-page-shell.test.ts: qui si guarda
// che la pagina lo usi, vista per vista.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { stubApiMethod } from './render-helper-install'
import type { McpServerInfo } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({}) as never)

const PANEL = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
const CARD = readFileSync(fileURLToPath(new URL('../components/PluginCard.tsx', import.meta.url)), 'utf8')

const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
const slot = (node: HtmlNode): string => `<${node.tag} data-page-shell="${node.attrs['data-page-shell'] ?? ''}">`
const isSlot = (name: string) => (n: HtmlNode): boolean => n.attrs['data-page-shell'] === name
const isContent = (n: HtmlNode): boolean => 'data-page-content' in n.attrs

/**
 * PURA: i problemi del contratto di scorribilità in un HTML reso. La radice
 * (il testid) è inchiodata al contenitore (absolute inset-0, colonna flex); il
 * corpo che scorre è suo FIGLIO DIRETTO — la barra di scorrimento sta sul
 * bordo dell'area — ed è lo scorribile che prende lo spazio che resta
 * (min-h-0 flex-1: senza, la colonna cresce quanto il contenuto e l'overflow
 * non scorre mai: la causa di PP1). Esattamente UNO per vista: se ce ne fossero
 * due annidati, la sonda misurerebbe il primo.
 */
export function shellProblems(html: string, testId: string): string[] {
  const tree = parseHtml(html)
  const roots = findAll(tree, (n) => n.attrs['data-testid'] === testId)
  if (roots.length !== 1) return [`${roots.length} radici con testid ${testId} (attese 1)`]
  const root = roots[0]!
  const bodies = findAll(root, isSlot('scroll'))
  if (bodies.length !== 1) return [`${bodies.length} corpi data-page-shell="scroll" dentro ${testId} (attesi 1)`]
  const body = bodies[0]!
  const problems: string[] = []
  // il corpo: lo scorribile, che prende lo spazio che resta e non lo chiede
  for (const cls of ['overflow-y-auto', 'scroll-thin', 'min-h-0', 'flex-1']) if (!has(body, cls)) problems.push(`al corpo manca ${cls}`)
  // il corpo è figlio DIRETTO della radice: nessuna colonna in mezzo
  if (body.parent !== root) problems.push(`il corpo che scorre non è figlio diretto della radice ${testId} (è dentro ${describeAncestors(body, root)})`)
  for (const cls of ['flex', 'flex-col', 'absolute', 'inset-0']) if (!has(root, cls)) problems.push(`alla radice ${testId} manca ${cls}`)
  // testata, descrizione e barra degli strumenti non si accartocciano mai
  for (const part of ['header', 'description', 'toolbar']) {
    for (const n of findAll(root, isSlot(part))) {
      if (!has(n, 'shrink-0')) problems.push(`${part} senza shrink-0`)
      if (n.parent !== root) problems.push(`${part} non è figlio diretto della radice ${testId}`)
    }
  }
  return problems
}

/** Dall'elemento alla radice (esclusa): i contenitori che ha sopra, il più vicino prima. */
function describeAncestors(node: HtmlNode, root: HtmlNode): string {
  const out: string[] = []
  for (let a = node.parent; a && a !== root; a = a.parent) out.push(`<${a.tag}${a.attrs['data-page-shell'] ? ` data-page-shell="${a.attrs['data-page-shell']}"` : ''}>`)
  return out.join(' dentro ') || 'niente'
}

/** Il codice di PluginPanel / PluginCard senza i commenti (che possono citare i pezzi). */
const code = (text: string): string => text.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe('PP1: il contratto di scorribilità', () => {
  it('il contratto BLOCCA lo schema di prima (PluginShell): il corpo dentro una colonna intermedia tiene la barra di scorrimento lontana dal bordo', () => {
    // com'era PluginShell: la radice, poi LA COLONNA centrata (mx-auto), e dentro di lei il corpo
    const prima = '<div data-testid="pagina" class="no-drag absolute inset-0 z-20 flex flex-col bg-background">' +
      '<div data-page-shell="colonna" class="mx-auto flex min-h-0 w-full flex-col gap-3">' +
      '<div data-page-shell="header" class="shrink-0"><div data-page-shell="testata">testata</div></div>' +
      '<div data-page-shell="scroll" class="min-h-0 flex-1 overflow-y-auto scroll-thin">corpo</div>' +
      '</div></div>'
    expect(shellProblems(prima, 'pagina')).toEqual(['il corpo che scorre non è figlio diretto della radice pagina (è dentro <div data-page-shell="colonna">)', 'header non è figlio diretto della radice pagina'])
  })

  it('e blocca anche il corpo che non scorre (senza overflow-y-auto) o due corpi nella stessa vista', () => {
    const senzaScroll = '<div data-testid="pagina" class="absolute inset-0 flex flex-col"><div data-page-shell="scroll" class="scroll-thin min-h-0 flex-1">corpo</div></div>'
    expect(shellProblems(senzaScroll, 'pagina')).toEqual(['al corpo manca overflow-y-auto'])
    const due = '<div data-testid="pagina" class="absolute inset-0 flex flex-col"><div data-page-shell="scroll" class="scroll-thin min-h-0 flex-1 overflow-y-auto"><div data-page-shell="scroll" class="overflow-y-auto">corpo</div></div></div>'
    expect(shellProblems(due, 'pagina')).toEqual(['2 corpi data-page-shell="scroll" dentro pagina (attesi 1)'])
  })
})

describe('PP1 → DS4: lista, viste e scheda montano PageShell', () => {
  it('PluginPanel e PluginCard non scrivono più `absolute inset-0` a mano: lo schema vive in un pezzo solo', () => {
    expect(code(PANEL)).not.toContain('absolute inset-0')
    expect(code(CARD)).not.toContain('absolute inset-0')
    expect(PANEL).toMatch(/import \{ PageShell \} from '\.\/ui\/page-shell'/)
    expect(CARD).toMatch(/import \{ PageShell \} from '\.\/ui\/page-shell'/)
    // le quattro viste della pagina e la scheda
    expect((code(PANEL).match(/<PageShell\b/g) ?? []).length).toBe(4)
    expect((code(CARD).match(/<PageShell\b/g) ?? []).length).toBe(1)
    // e la testata è quella di sistema, non una riga scritta qui
    expect(PANEL).toMatch(/import \{ PageHeader \} from '\.\/ui\/page-header'/)
    expect(CARD).toMatch(/import \{ PageHeader \} from '\.\/ui\/page-header'/)
    expect((code(PANEL).match(/<PageHeader\b/g) ?? []).length).toBe(4)
    expect((code(CARD).match(/<PageHeader\b/g) ?? []).length).toBe(1)
    // PluginShell non c'è più (DS5): nessuno lo importa (i commenti lo citano: raccontano com'era)
    expect(code(PANEL)).not.toMatch(/\bPluginShell\b/)
    expect(code(CARD)).not.toMatch(/\bPluginShell\b/)
  })

  const quiet = async (): Promise<void> => {
    const { useStore } = await import('../store')
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
    stubApiMethod('skillsCatalog', () => [])
    stubApiMethod('pluginsUsage', () => [])
    stubApiMethod('mcpList', () => [])
    stubApiMethod('getPermissions', () => ({ default: 'needs_approval', rules: [] }))
    stubApiMethod('setPermissions', () => undefined)
    setStoreStateForRender(useStore, {
      pluginOpen: true, pluginAt: null,
      connectors: [], composio: null, composioGateway: null,
      agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    })
  }

  /** Le larghezze del contenuto di una vista, nell'ordine in cui compaiono (testata, descrizione, barra, corpo). */
  const widthsOf = (root: HtmlNode, testId: string): Array<string | undefined> =>
    findAll(findAll(root, (n) => n.attrs['data-testid'] === testId)[0]!, isContent).map((n) => n.attrs.style)

  it('la lista e le tre viste interne (mcp, skill-import, skill-new) hanno il corpo che scorre figlio diretto della radice, la riga dei 52 in cima, e sono larghe quanto la pagina (wide, C2: una sola)', async () => {
    await quiet()
    const { PluginPanel } = await import('../components/PluginPanel')
    // quante colonne di contenuto ha la vista: una per ciascuno degli slot fermi (testata, descrizione, barra) più quella del corpo
    // C2/C3: la descrizione non c'è più: una colonna in meno per «all»
    const views: Array<[string, Record<string, unknown>, number]> = [
      ['all', {}, 3],
      ['mcp', { view: 'mcp' }, 2],
      ['skill-import', { view: 'skill-import', importRows: [{ name: 'lavoro', description: 'Riassume le email', sources: ['claude'], valid: true, existing: false, files: ['a.txt'] }] }, 3],
      ['skill-new', { view: 'skill-new' }, 2]
    ]
    for (const [name, initial, columns] of views) {
      const html = renderHtml(createElement(PluginPanel, { initial } as never))
      expect(shellProblems(html, 'plugin-page'), name).toEqual([])
      const root = parseHtml(html)
      const page = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-page')[0]!
      // in cima UNA riga, quella dei 52 (la fascia di trascinamento): è la testata di PageHeader
      const head = findAll(page, (n) => n.attrs['data-col-head'] !== undefined)
      expect(head, name).toHaveLength(1)
      expect(has(head[0]!, 'h-col-head'), name).toBe(true)
      expect(head[0]!.parent!.parent!.parent).toBe(page)
      // e ogni colonna del contenuto è larga quanto la pagina
      const widths = widthsOf(root, 'plugin-page')
      expect(widths, name).toHaveLength(columns)
      for (const w of widths) expect(w, name).toBe('max-width:var(--w-wide)')
    }
  })

  it('la larghezza è UNA (wide, C2) anche su «Collegati»: stesso testid, stessa testata, stessa barra — cambia solo il contenuto', async () => {
    await quiet()
    const { PluginPanel } = await import('../components/PluginPanel')
    const html = renderHtml(createElement(PluginPanel, { initial: { seg: 'connected' } } as never))
    expect(shellProblems(html, 'plugin-page')).toEqual([])
    const root = parseHtml(html)
    const widths = widthsOf(root, 'plugin-page')
    // testata · barra degli strumenti · corpo (la descrizione non c'è più, C2)
    expect(widths).toHaveLength(3)
    for (const w of widths) expect(w).toBe('max-width:var(--w-wide)')
    expect(findAll(root, (n) => n.attrs['data-testid'] === 'plugin-connected-table')).toHaveLength(1)
  })

  it('la scheda del plugin ha il corpo che scorre figlio diretto della radice (Rimuovi e le autorizzazioni lunghe si raggiungono), la riga dei 52 in cima, e sta sopra la pagina', async () => {
    await quiet()
    const { PluginCard } = await import('../components/PluginCard')
    const server: McpServerInfo = { id: 'srv-1', name: 'ufficio', transport: 'stdio', command: 'node', enabled: true, enabledFor: ['*'] }
    const html = renderHtml(createElement(PluginCard, {
      server,
      initial: { tools: Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, description: `Strumento ${i}` })), permissions: { default: 'needs_approval', rules: [] } },
      onClose: () => undefined,
      onChanged: () => undefined
    } as never))
    expect(shellProblems(html, 'plugin-card')).toEqual([])
    const root = parseHtml(html)
    const card = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-card')[0]!
    expect(has(card, 'z-30')).toBe(true)
    expect(has(card, 'z-20')).toBe(false)
    expect(findAll(card, (n) => n.attrs['data-col-head'] !== undefined)).toHaveLength(1)
    for (const w of widthsOf(root, 'plugin-card')) expect(w).toBe('max-width:var(--w-wide)')
    // il corpo contiene i tre pannelli: l'ultima azione e «Rimuovi» stanno nello scorribile
    const body = findAll(card, isSlot('scroll'))[0]!
    expect(findAll(body, (n) => n.attrs['data-testid'] === 'plugin-permissions')).toHaveLength(1)
    expect(findAll(body, (n) => n.attrs['data-testid'] === 'plugin-accounts')).toHaveLength(1)
    expect(textOf(body)).toContain('Rimuovi')
    // le schede interne stanno FERME sopra il corpo, nella barra degli strumenti
    expect(findAll(body, (n) => n.attrs['data-testid'] === 'plugin-card-tabs')).toHaveLength(0)
    expect(findAll(card, (n) => n.attrs['data-testid'] === 'plugin-card-tabs')).toHaveLength(1)
  })
})
