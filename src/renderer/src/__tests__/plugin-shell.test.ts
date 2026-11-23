// PP1 (fase plugin-pulita): la pagina Plugin scorre, e la scheda pure.
// jsdom non c'è e non fa layout: qui si verifica il CONTRATTO di PluginShell
// — il corpo che scorre (overflow-y-auto) dentro una catena di genitori flex
// che hanno tutti min-h-0 — e che lista, viste e scheda montino PluginShell
// (niente `absolute inset-0` scritto a mano in PluginPanel / PluginCard). La
// prova vera, misurata sul DOM vivo a 1200×800 e a 900×600, è la sonda
// (scripts/fase-plugin-pulita-probe.mjs).
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
const slot = (node: HtmlNode): string => `<${node.tag} data-plugin-shell="${node.attrs['data-plugin-shell'] ?? ''}">`

/**
 * PURA: i problemi del contratto di scorribilità in un HTML reso. La radice
 * (il testid) è inchiodata al contenitore (absolute inset-0); da lì fino al
 * corpo che scorre ogni nodo è flex flex-col, e tutti tranne la radice hanno
 * min-h-0 e flex-1 — senza i quali la colonna cresce quanto il contenuto e
 * l'overflow del corpo non scorre mai (la causa di PP1).
 */
export function shellProblems(html: string, testId: string): string[] {
  const tree = parseHtml(html)
  const roots = findAll(tree, (n) => n.attrs['data-testid'] === testId)
  if (roots.length !== 1) return [`${roots.length} radici con testid ${testId} (attese 1)`]
  const root = roots[0]!
  const bodies = findAll(root, (n) => n.attrs['data-plugin-shell'] === 'body')
  if (bodies.length !== 1) return [`${bodies.length} corpi data-plugin-shell="body" dentro ${testId} (attesi 1)`]
  const body = bodies[0]!
  const problems: string[] = []
  // il corpo: lo scorribile, che prende lo spazio che resta e non lo chiede
  for (const cls of ['overflow-y-auto', 'scroll-thin', 'min-h-0', 'flex-1']) if (!has(body, cls)) problems.push(`al corpo manca ${cls}`)
  // la catena dei GENITORI dal corpo alla radice (esclusa): colonne flex che
  // non crescono col contenuto
  let node: HtmlNode | null = body.parent
  while (node && node !== root) {
    for (const cls of ['flex', 'flex-col', 'min-h-0', 'flex-1']) if (!has(node, cls)) problems.push(`a ${slot(node)} manca ${cls}`)
    node = node.parent
  }
  if (node !== root) problems.push(`la catena dal corpo non arriva alla radice ${testId}`)
  for (const cls of ['flex', 'flex-col', 'absolute', 'inset-0']) if (!has(root, cls)) problems.push(`alla radice ${testId} manca ${cls}`)
  // testata e toolbar non si accartocciano mai
  for (const part of ['header', 'toolbar']) {
    for (const n of findAll(root, (x) => x.attrs['data-plugin-shell'] === part)) {
      if (!has(n, 'shrink-0')) problems.push(`${part} senza shrink-0`)
    }
  }
  return problems
}

/** Il codice di PluginPanel / PluginCard senza i commenti (che possono citare le classi). */
const code = (text: string): string => text.replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe('PP1: PluginShell — il contratto', () => {
  it('il corpo che scorre sta in una catena di genitori flex con min-h-0, fino alla radice absolute inset-0', async () => {
    const { PluginShell } = await import('../components/plugin/PluginShell')
    const html = renderHtml(createElement(PluginShell, {
      testId: 'shell-prova',
      header: createElement('h1', null, 'Titolo'),
      toolbar: createElement('input', { placeholder: 'cerca' }),
      children: createElement('p', null, 'contenuto lungo')
    }))
    expect(shellProblems(html, 'shell-prova')).toEqual([])
    const tree = parseHtml(html)
    const texts = findAll(tree, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Titolo')
    expect(texts).toContain('contenuto lungo')
  })

  it('senza toolbar vale lo stesso (le viste mcp e skill-new non ne hanno)', async () => {
    const { PluginShell } = await import('../components/plugin/PluginShell')
    const html = renderHtml(createElement(PluginShell, { testId: 'shell-prova', header: createElement('h1', null, 'Titolo'), children: 'corpo' }))
    expect(shellProblems(html, 'shell-prova')).toEqual([])
  })

  it('il contratto BLOCCA lo schema di prima: la colonna senza min-h-0 flex-1 fa crescere il corpo e non scorre', () => {
    // com'era PluginPanel a bb84b6b4: la colonna centrale cresce col contenuto
    const prima = '<div data-testid="pagina" class="no-drag absolute inset-0 z-20 flex flex-col bg-background px-8 py-6">' +
      '<div data-plugin-shell="colonna" class="mx-auto flex w-full max-w-4xl flex-col gap-3">' +
      '<div class="flex items-center gap-2">testata</div>' +
      '<div data-plugin-shell="body" class="min-h-0 flex-1 overflow-y-auto scroll-thin pb-6">corpo</div>' +
      '</div></div>'
    expect(shellProblems(prima, 'pagina')).toEqual(['a <div data-plugin-shell="colonna"> manca min-h-0', 'a <div data-plugin-shell="colonna"> manca flex-1'])
  })
})

describe('PP1: lista, viste e scheda montano PluginShell', () => {
  it('PluginPanel e PluginCard non scrivono più `absolute inset-0` a mano: lo schema vive in un pezzo solo', () => {
    expect(code(PANEL)).not.toContain('absolute inset-0')
    expect(code(CARD)).not.toContain('absolute inset-0')
    expect(PANEL).toMatch(/import \{ PluginShell \} from '\.\/plugin\/PluginShell'/)
    expect(CARD).toMatch(/import \{ PluginShell \} from '\.\/plugin\/PluginShell'/)
    // le quattro viste della pagina e la scheda
    expect((code(PANEL).match(/<PluginShell\b/g) ?? []).length).toBe(4)
    expect((code(CARD).match(/<PluginShell\b/g) ?? []).length).toBe(1)
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

  it('la lista e le tre viste interne (mcp, skill-import, skill-new) hanno il corpo che scorre nella catena giusta', async () => {
    await quiet()
    const { PluginPanel } = await import('../components/PluginPanel')
    const views: Array<Record<string, unknown>> = [
      { seg: 'all' },
      { view: 'mcp' },
      { view: 'skill-import', importRows: [{ name: 'lavoro', description: 'Riassume le email', sources: ['claude'], valid: true, existing: false, files: ['a.txt'] }] },
      { view: 'skill-new' }
    ]
    for (const initial of views) {
      const html = renderHtml(createElement(PluginPanel, { initial } as never))
      expect(shellProblems(html, 'plugin-page'), JSON.stringify(initial)).toEqual([])
    }
  })

  it('la scheda del plugin ha il corpo che scorre nella catena giusta (Rimuovi e le autorizzazioni lunghe si raggiungono)', async () => {
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
    // il corpo contiene i tre pannelli: l'ultima azione e «Rimuovi» stanno nello scorribile
    const body = findAll(root, (n) => n.attrs['data-plugin-shell'] === 'body')[0]!
    expect(findAll(body, (n) => n.attrs['data-testid'] === 'plugin-permissions')).toHaveLength(1)
    expect(findAll(body, (n) => n.attrs['data-testid'] === 'plugin-accounts')).toHaveLength(1)
    expect(textOf(body)).toContain('Rimuovi')
  })
})
