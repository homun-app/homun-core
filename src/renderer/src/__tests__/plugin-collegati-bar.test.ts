// fase linguaggio-ritocchi (R3): la barra di Plugin › Collegati — le strade in
// UNA pillola-menu («Strada: tutte ▾») e «Da sistemare» la pillola-interruttore
// col conteggio. Prima erano sei pillole di fila e a 1280 la barra non ci
// stava (le prende il controllo «niente tagliato» della galleria).
// Il render è statico (niente jsdom nel repo): nessun test CLICCA le pillole —
// non c'è un DOM interattivo in cui cliccare — quindi qui si prova ciò che il
// render dice: che la barra PASSA le cinque voci al menu (il portale è reso
// passante dal mock, come in ui-filter-chips.test.ts) e il conteggio
// all'interruttore. La scelta si prova sulle funzioni pure (connectedTable,
// plugins-view.test.ts).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { stubApiMethod } from './render-helper-install'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ui/dropdown-menu', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  const pass = (tag: string) => ({ children, className, ...rest }: { children?: unknown; className?: string } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, className, ...rest }, children as never)
  return { ...m, DropdownMenu: pass('dropdown-menu'), DropdownMenuContent: pass('dropdown-menu-content'), DropdownMenuTrigger: pass('dropdown-menu-trigger'), DropdownMenuItem: pass('dropdown-menu-item') }
})

const pulito = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** La pagina Plugin su un segmento, coi dati di plugin-page.test.ts: Notion (diretto), Trello (Composio) e Mattermost (server manuale ROTTO: «da sistemare»). */
const renderSegmento = async (seg: 'connected' | 'all'): Promise<HtmlNode> => {
  const { PluginPanel } = await import('../components/PluginPanel')
  const { useStore } = await import('../store')
  stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
  stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
  stubApiMethod('mcpList', () => [])
  setStoreStateForRender(useStore, {
    pluginOpen: true,
    connectors: [{
      id: 'notion', name: 'Notion', logo: 'notion.svg', mcpUrl: 'https://mcp.notion.com/mcp',
      clientRegistration: 'dynamic', docsUrl: '', notes: '',
      state: { status: 'connected', disabledTools: [], instructions: '' }, tools: []
    }],
    composio: null,
    composioGateway: { active: true, connected: [{ slug: 'trello', name: 'Trello', status: 'ACTIVE', accountId: 'x', accounts: [{ accountId: 'a1', alias: 'fabio', email: 'fabio@studio.example', status: 'ACTIVE' }] }], pending: null },
    agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
  })
  const out = renderHtml(createElement(PluginPanel, {
    initial: {
      installed: { servers: [{ id: 'srv-mm', name: 'Mattermost', transport: 'stdio', command: 'npx', args: ['@donach/mattermost-mcp'], enabled: true, enabledFor: ['*'], stateStatus: 'error', serverSlug: 'mattermost' }], plugins: [] },
      usage: [], perms: null, skills: [], seg
    }
  } as never))
  // lo store del file è condiviso: si ripulisce per i test dopo
  setStoreStateForRender(useStore, { connectors: [], composio: null, composioGateway: null })
  return parseHtml(out)
}

const gruppiFiltri = (root: HtmlNode): HtmlNode[] => findAll(root, (n) => n.attrs['data-testid'] === 'plugin-connected-filters')

describe('R3: la barra di Plugin › Collegati — una pillola-menu e un interruttore', () => {
  it('il gruppo dei filtri (testid invariato) sta nella BARRA con la pillola-menu «Strada: tutte» e le cinque voci nel menu', async () => {
    const root = await renderSegmento('connected')
    const gruppi = gruppiFiltri(root)
    expect(gruppi).toHaveLength(1)
    const gruppo = gruppi[0]!
    expect(gruppo.attrs.role).toBe('group')
    expect(gruppo.attrs['aria-label']).toBe('Filtra per strada')
    // e sta nella barra degli strumenti, fuori dal segmento (il corpo ha la sola tabella)
    const inBarra = findAll(root, (n) => n.attrs['data-page-shell'] === 'toolbar').filter((b) => findAll(b, (n) => n.attrs['data-testid'] === 'plugin-connected-filters').length > 0)
    expect(inBarra).toHaveLength(1)
    const trigger = findAll(gruppo, (n) => (n.attrs['data-mock'] ?? '') === 'dropdown-menu-trigger')
    expect(trigger.map((t) => pulito(textOf(t)))).toEqual(['Strada: tutte'])
    const voci = findAll(gruppo, (n) => (n.attrs['data-mock'] ?? '') === 'dropdown-menu-item').map((v) => pulito(textOf(v)))
    expect(voci).toEqual(['tutte', 'MCP diretto', 'Composio', 'Sul Mac', 'Nel computer isolato'])
  }, 20_000)

  it('«Da sistemare» è la pillola-interruttore col CONTEGGIO («Da sistemare · 1»), e le pillole-strada di fila non ci sono più', async () => {
    const root = await renderSegmento('connected')
    const gruppo = gruppiFiltri(root)[0]!
    // nel gruppo: la pillola-menu (il trigger, reso passante dal mock) e UN solo bottone, l'interruttore
    expect(findAll(gruppo, (n) => (n.attrs['data-mock'] ?? '') === 'dropdown-menu-trigger')).toHaveLength(1)
    const bottoni = findAll(gruppo, (n) => n.tag === 'button')
    expect(bottoni, 'nel gruppo un solo bottone: le sei pillole di fila non ci sono più').toHaveLength(1)
    const interruttori = bottoni.filter((b) => b.attrs['aria-pressed'] !== undefined)
    expect(interruttori.map((b) => [pulito(textOf(b)), b.attrs['aria-pressed']])).toEqual([['Da sistemare · 1', 'false']])
    // la fila di prima: «Tutte le strade» · «MCP diretto» · «Composio» · «Sul Mac» · «Nel computer isolato» come pillole
    const nomi = bottoni.map((b) => pulito(textOf(b)))
    for (const vecchia of ['Tutte le strade', 'MCP diretto', 'Composio', 'Sul Mac', 'Nel computer isolato']) expect(nomi).not.toContain(vecchia)
  }, 20_000)

  it('sugli altri segmenti il gruppo non c\'è (la barra ha le schede e la ricerca)', async () => {
    const root = await renderSegmento('all')
    expect(gruppiFiltri(root)).toHaveLength(0)
  }, 20_000)
})
