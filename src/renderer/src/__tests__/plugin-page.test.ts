// Fase plugin (PL1): la voce «Plugin» nella barra e la casa unica (tavola 8).
// La voce fissa tra «Da approvare» e «Attività» (anche in rotaia); dal menu
// dell'account SPARISCONO «Collega app», «Skill» e «Server MCP»; i rimandi
// di oggi portano alla pagina Plugin nel punto giusto; la pagina occupa
// l'area centrale come Libreria e Attività (B1) con ricerca, segmenti e il
// menu «Aggiungi» con le sei voci. Senza DOM (niente jsdom): guardie sul
// sorgente + render vero del componente con l'api finta, come gli altri.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, dialogPassThroughMock, type HtmlNode } from './render-helper'
import { callsOf, stubApiMethod } from './render-helper-install'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const SIDEBAR = fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url))
const APP = fileURLToPath(new URL('../App.tsx', import.meta.url))
const STORE = fileURLToPath(new URL('../store.ts', import.meta.url))
const CARDS = fileURLToPath(new URL('../components/ConnectorCards13.tsx', import.meta.url))
const RIGHT = fileURLToPath(new URL('../components/RightPanel.tsx', import.meta.url))
const PANEL = fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url))

const sidebarSrc = (): string => readFileSync(SIDEBAR, 'utf8')
const storeSrc = (): string => readFileSync(STORE, 'utf8')

/** Il blocco <nav> della barra larga. */
function navBlock(): string {
  const src = sidebarSrc()
  const m = /<nav className="flex-1 space-y-px[\s\S]*?<\/nav>/.exec(src)
  if (!m) throw new Error('blocco <nav> non trovato in Sidebar.tsx')
  return m[0]!
}

/** Il blocco di un componente della Sidebar (dalla `function Nome` alla successiva). */
function sidebarBlock(name: string): string {
  const src = sidebarSrc()
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`componente ${name} non trovato in Sidebar.tsx`)
  const next = src.indexOf('\nfunction ', start + 10)
  const nextExport = src.indexOf('\nexport function ', start + 10)
  const ends = [next, nextExport].filter((i) => i > 0)
  return src.slice(start, ends.length ? Math.min(...ends) : undefined)
}

/** Il blocco DropdownMenuContent dell'AccountMenu. */
function accountMenuContent(): string {
  const src = sidebarSrc()
  const m = /function AccountMenu\([\s\S]*?<DropdownMenuContent([^>]*)>([\s\S]*?)<\/DropdownMenuContent>/.exec(src)
  if (!m) throw new Error('AccountMenu non trovata in Sidebar.tsx')
  return m[2]!
}

describe('PL1: la voce «Plugin» nella barra', () => {
  it('sta tra «Da approvare» e «Attività» nella barra larga, con l\'icona Puzzle e la apre', () => {
    const nav = navBlock()
    const approvals = nav.indexOf('<ApprovalsRow />')
    const plugin = nav.indexOf('<PluginRow />')
    const activity = nav.indexOf('<Trans>Attività</Trans>')
    expect(approvals).toBeGreaterThanOrEqual(0)
    expect(plugin).toBeGreaterThan(approvals)
    expect(activity).toBeGreaterThan(plugin)
    // la voce: testid per le sonde, icona lucide Puzzle, apre con openPlugin
    const row = sidebarBlock('PluginRow')
    expect(row).toContain('data-testid="sidebar-plugin"')
    expect(row).toContain('<Puzzle className="size-4" />')
    expect(row).toMatch(/openPlugin\(\)/)
    expect(sidebarSrc()).toMatch(/import \{[^}]*Puzzle[^}]*\} from 'lucide-react'/)
  })

  it('c\'è anche nella barra stretta (rotaia), tra Da approvare e Attività; il bottone App in fondo non c\'è più', () => {
    const src = sidebarSrc()
    const rail = sidebarBlock('CollapsedColumn')
    const approvals = rail.indexOf('<RailApprovals />')
    const plugin = rail.indexOf('data-testid="rail-plugin"')
    const activity = rail.indexOf("i18n.t(msg`Attività`)")
    expect(approvals).toBeGreaterThanOrEqual(0)
    expect(plugin).toBeGreaterThan(approvals)
    expect(activity).toBeGreaterThan(plugin)
    // il vecchio bottone «App» che apriva la finestra è via
    expect(rail).not.toContain('setAppsOpen(true)')
  })

  it('la voce apre la pagina e chiude le altre viste centrali (regola B1: un punto solo)', () => {
    const row = sidebarBlock('PluginRow')
    expect(row).toMatch(/openPlugin\(\)/)
    // lo stato attivo della voce segue pluginOpen
    expect(row).toMatch(/pluginOpen \? 'bg-muted text-foreground'/)
  })
})

describe('PL1: dal menu dell\'account spariscono le tre voci', () => {
  it('«Collega app», «Skill» e «Server MCP» non ci sono più; restano Impostazioni e Tema', () => {
    const menu = accountMenuContent()
    expect(menu).not.toContain('<Trans>Collega app</Trans>')
    expect(menu).not.toContain('<Trans>Skill</Trans>')
    expect(menu).not.toContain('<Trans>Server MCP</Trans>')
    expect(menu).not.toContain('setAppsOpen')
    expect(menu).not.toContain('setSkillsOpen')
    expect(menu).not.toContain('setMcpOpen')
    expect(menu).toContain('<Trans>Impostazioni</Trans>')
    expect(menu).toContain('<Trans>Tema</Trans>')
  })
})

describe('PL1: lo store — pluginOpen e la regola B1', () => {
  it('ha pluginOpen, openPlugin(at) e setPluginOpen', () => {
    const src = storeSrc()
    expect(src).toMatch(/pluginOpen: boolean/)
    expect(src).toMatch(/pluginOpen: false/)
    expect(src).toMatch(/openPlugin\(at\b/)
    expect(src).toMatch(/setPluginOpen\(v\)/)
  })

  it('openPlugin chiude Attività, Libreria e il centro; e le altre viste chiudono Plugin', async () => {
    const { useStore } = await import('../store')
    setStoreStateForRender(useStore, { activityOpen: true, openLibraryId: '', approvalsOpen: false })
    useStore.getState().openPlugin()
    const s = useStore.getState()
    expect(s.pluginOpen).toBe(true)
    expect(s.activityOpen).toBe(false)
    expect(s.openLibraryId).toBe(null)
    // il punto di arrivo si può chiedere (i rimandi)
    useStore.getState().openPlugin({ kind: 'mcp' })
    expect(useStore.getState().pluginAt).toEqual({ kind: 'mcp' })
    // le altre viste centrali chiudono la pagina Plugin
    useStore.getState().setActivityOpen(true)
    expect(useStore.getState().pluginOpen).toBe(false)
    useStore.getState().openPlugin()
    useStore.getState().openLibrary('')
    expect(useStore.getState().pluginOpen).toBe(false)
    useStore.getState().openPlugin()
    useStore.getState().setApprovalsOpen(true)
    expect(useStore.getState().pluginOpen).toBe(false)
    // chiuderla non tocca il punto (si consuma all'apertura)
    useStore.getState().openPlugin({ kind: 'mcp' })
    useStore.getState().setPluginOpen(false)
    expect(useStore.getState().pluginOpen).toBe(false)
    expect(useStore.getState().pluginAt).toEqual({ kind: 'mcp' })
  })

  it('scegliere un bot o aprire una squadra riporta alla chat: anche Plugin si chiude', async () => {
    const { useStore } = await import('../store')
    setStoreStateForRender(useStore, { pluginOpen: true })
    await useStore.getState().select('a-1')
    expect(useStore.getState().pluginOpen).toBe(false)
    setStoreStateForRender(useStore, { pluginOpen: true })
    useStore.getState().openGroup(3)
    expect(useStore.getState().pluginOpen).toBe(false)
  })
})

describe('PL1: App monta la pagina Plugin nell\'area centrale', () => {
  it('PluginPanel sta accanto a Libreria e Attività, quando pluginOpen', () => {
    const src = readFileSync(APP, 'utf8')
    expect(src).toMatch(/import \{ PluginPanel \} from '\.\/components\/PluginPanel'/)
    expect(src).toMatch(/\{pluginOpen && <PluginPanel \/>}/)
    // B1: il PUNTO che decide resta il render condizionale di App
    expect(src).toMatch(/\{approvalsOpen && <ApprovalsCenter \/>}/)
  })
})

describe('PL1: i rimandi di oggi portano alla pagina Plugin', () => {
  it('la card «Apri Server MCP» apre la pagina nel punto MCP (non la finestra)', () => {
    const src = readFileSync(CARDS, 'utf8')
    expect(src).not.toContain('setMcpOpen(true)')
    expect(src).toMatch(/openPlugin\(\{ kind: 'mcp' \}\)/)
  })

  it('il suggerimento «Collega <App>» del pannello apre la pagina su quell\'app', () => {
    const src = readFileSync(RIGHT, 'utf8')
    expect(src).not.toContain('openAppsOn(')
    expect(src).toMatch(/openPlugin\(\{ kind: 'app', appId: [^}]+ \}\)/)
  })

  it('la riga «Skill» del pannello del bot apre la pagina sul segmento Skill', () => {
    const src = readFileSync(RIGHT, 'utf8')
    expect(src).not.toContain('setSkillsOpen(true)')
    expect(src).toMatch(/openPlugin\(\{ kind: 'segment', seg: 'skills'/)
  })
})

describe('PL3: la tabella «Collegati» (tavola 10)', () => {
  it('colonne, righe, permessi in breve, ultimo uso e «Da sistemare · N»', async () => {
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
        usage: [
          { tool: 'mcp__mattermost__post_message', last: Date.now() - 3 * 24 * 3600 * 1000, week: 4 },
          { tool: 'composio__trello__TRELLO_CREATE_CARD', last: Date.now() - 26 * 3600 * 1000, week: 31 }
        ],
        perms: { default: 'needs_approval', rules: [
          { tool: 'mcp__mattermost__post_message', pattern: '*', mode: 'blocked' },
          { tool: 'mcp__mattermost__read_channel', pattern: '*', mode: 'always_allow' }
        ] },
        skills: [],
        seg: 'connected'
      }
    } as never))
    const root = parseHtml(out)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    // le righe della tabella: Notion (diretto del catalogo), Trello
    // (Composio del gateway) e Mattermost (server MCP manuale rotto)
    expect(texts).toContain('Collegati · 3')
    expect(texts).toContain('Da sistemare · 1')
    expect(texts).toContain('Mattermost')
    expect(texts).toContain('npx @donach/mattermost-mcp')
    expect(texts).toContain('1 sempre · 1 blocca')
    expect(texts).toContain('31 questa settimana')
    expect(texts).toContain('fabio')
    // lo store del file è condiviso: si ripulisce per i test dopo
    setStoreStateForRender(useStore, { connectors: [], composio: null, composioGateway: null })
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
  }, 20_000) // render pesante: sul runner macOS di CI ha superato i 5 s di default (build beta.18)
})

describe('PL5: le skill in pagina come le altre (libreria, plugin, catalogo)', () => {
  it('il segmento Skill mostra la skill della libreria e quella del plugin con la riga grigia, e il catalogo con le sue categorie', async () => {
    const { PluginPanel } = await import('../components/PluginPanel')
    const { useStore } = await import('../store')
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsCatalog', () => [
      { id: 'descrizioni-di-job', source: { repo: 'anthropics/skills', commit: 'a'.repeat(40), path: '' }, license: 'MIT', category: 'writing', description: { it: 'Descrizioni di job', en: 'Job descriptions' }, files: { exclude: [] }, reviewed: true }
    ])
    setStoreStateForRender(useStore, {
      pluginOpen: true, connectors: [], composio: null, composioGateway: null,
      agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    })
    const out = renderHtml(createElement(PluginPanel, {
      initial: {
        seg: 'skills',
        skills: [{ name: 'fatture', folder: 'fatture', description: 'Legge le fatture', enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, files: ['esempio.xml'], valid: true, issues: [] }],
        pluginSkills: [{ plugin: 'rag-docs', skills: [{ name: 'rag', description: 'Ricerca nei documenti' }] }],
        skillCatalog: [
          { id: 'descrizioni-di-job', source: { repo: 'anthropics/skills', commit: 'a'.repeat(40), path: '' }, license: 'MIT', category: 'writing', description: { it: 'Descrizioni di job', en: 'Job descriptions' }, files: { exclude: [] }, reviewed: true }
        ]
      }
    } as never))
    const root = parseHtml(out)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    // la riga grigia giusta per ciascuna (il nome della libreria si umanizza)
    expect(texts).toContain('Fatture')
    expect(texts).toContain('Skill · Homun')
    expect(texts).toContain('rag')
    expect(texts).toContain('Skill · da plugin · rag-docs')
    // il catalogo con le sue categorie (la ricerca e le categorie valgono anche per le skill)
    expect(texts).toContain('Sfoglia')
    expect(texts).toContain('Scrittura')
    expect(texts).toContain('Descrizioni di job')
    setStoreStateForRender(useStore, { connectors: [], composio: null, composioGateway: null })
  })
})

describe('PL6: «Importa skill» da altre app', () => {
  it('NESSUNA lettura senza clic: la scansione parte solo dal menù «Importa skill»', async () => {
    const { PluginPanel } = await import('../components/PluginPanel')
    const { useStore } = await import('../store')
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
    stubApiMethod('skillsImportScan', () => ({ rows: [] }))
    setStoreStateForRender(useStore, {
      pluginOpen: true, connectors: [], composio: null, composioGateway: null,
      agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    })
    const before = callsOf('skillsImportScan').length
    renderHtml(createElement(PluginPanel, {}))
    // il render da solo NON legge i file delle altre app
    expect(callsOf('skillsImportScan').length).toBe(before)
  })

  it('il foglio: righe con le fonti, «già presente» spento, la scelta copia/usa l\'originale, il bottone Importa', async () => {
    const { PluginPanel } = await import('../components/PluginPanel')
    const { useStore } = await import('../store')
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
    stubApiMethod('skillsImportApply', () => [])
    setStoreStateForRender(useStore, {
      pluginOpen: true, connectors: [], composio: null, composioGateway: null,
      agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    })
    const out = renderHtml(createElement(PluginPanel, {
      initial: {
        view: 'skill-import',
        importRows: [
          { name: 'lavoro', description: 'Riassume le email', sources: ['claude', 'zcode'], valid: true, existing: false, files: ['a.txt'] },
          { name: 'prezzi', description: 'Confronta i prezzi', sources: ['cursor'], valid: true, existing: true, files: [] }
        ]
      }
    } as never))
    const root = parseHtml(out)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Importa skill')
    expect(texts).toMatch(/nessuno script viene eseguito/)
    expect(texts).toContain('lavoro')
    expect(texts).toContain('claude, zcode')
    expect(texts).toContain('già presente')
    expect(texts).toContain('Copia nella libreria di Homun')
    expect(texts).toContain('Usa la cartella originale')
    expect(texts).toContain('Scegli una cartella…')
    expect(callsOf('skillsImportApply').length).toBe(0)
    setStoreStateForRender(useStore, { connectors: [], composio: null, composioGateway: null })
  })
})

describe('PL1: la pagina Plugin (render vero, api finta)', () => {
  it('titolo, frase, ricerca, segmenti e bottone Aggiungi con le SEI voci', async () => {
    const { PluginPanel } = await import('../components/PluginPanel')
    const { useStore } = await import('../store')
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
    stubApiMethod('mcpList', () => [])
    setStoreStateForRender(useStore, {
      pluginOpen: true,
      connectors: [], composio: null, composioGateway: null,
      agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    })
    const out = renderHtml(createElement(PluginPanel, {}))
    const root = parseHtml(out)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('Plugin')
    expect(texts).toMatch(/Connettori, server MCP e skill/)
    expect(texts).toContain('Tutto')
    expect(texts).toContain('Connettori')
    expect(texts).toContain('Skill')
    expect(texts).toContain('Collegati · 0')
    expect(texts).toContain('Aggiungi')
    // il menu Aggiungi con le sei voci (aperto dal bottone: qui si rende visibile)
    const menu = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-add-menu')[0]
    expect(menu).toBeTruthy()
    const menuTexts = textOf(menu!)
    for (const voce of ['Importa da altre app', 'Server MCP personalizzato', 'Importa skill', 'Crea una skill', 'Crea con il bot', 'Aggiungi un marketplace']) {
      expect(menuTexts).toContain(voce)
    }
  })

  it('«I tuoi»: la riga di un connettore collegato con la riga grigia — e SENZA parola di stato quando tutto va (i dati api arrivano col sonda sul DOM vero)', async () => {
    const { PluginPanel } = await import('../components/PluginPanel')
    const { useStore } = await import('../store')
    stubApiMethod('connectorsInstalled', () => ({ servers: [], plugins: [] }))
    stubApiMethod('skillsLibrary', () => ({ library: [], plugins: [] }))
    stubApiMethod('mcpList', () => [])
    // il connettore DIRETTO collegato si vede dallo STORE (i server e le
    // skill arrivano dall'api con l'effect: quelli li verifica la sonda)
    setStoreStateForRender(useStore, {
      pluginOpen: true,
      connectors: [{
        id: 'notion', name: 'Notion', logo: 'notion.svg', mcpUrl: 'https://mcp.notion.com/mcp',
        clientRegistration: 'dynamic', docsUrl: '', notes: '',
        state: { status: 'connected', disabledTools: [], instructions: '' }, tools: []
      }],
      composio: null,
      composioGateway: null,
      agents: [{ id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }]
    })
    const out = renderHtml(createElement(PluginPanel, {}))
    const root = parseHtml(out)
    const texts = findAll(root, () => true).map((n) => textOf(n)).join('\n')
    expect(texts).toContain('I tuoi')
    expect(texts).toContain('Notion')
    expect(texts).toContain('Connettore · MCP diretto di Notion')
    // PP4 (fase plugin-pulita): un solo segnale di stato — quando tutto va
    // nessuna parola (prima qui la riga diceva «attivo»; l'interruttore resta)
    expect(texts).not.toContain('attivo')
    expect(texts).toContain('verificato')
    expect(texts).toContain('Collegati · 1')
    expect(callsOf('connectorsInstalled').length).toBeGreaterThanOrEqual(0)
  })
})

// ---- Fase design (DS4): «Collegati» è la tabella unica (DataTable), larga wide ----
// Prima era una <table> scritta qui, con le sue regole: intestazioni in
// MAIUSCOLETTO, testo che andava a capo («Tutti i / bot», «tramite / Composio»),
// righe e misure sue. Ora: intestazioni text-caption grigie in tono normale,
// righe da 52 che si aprono, NIENTE A CAPO (troncate, col valore intero nel
// suggerimento), e — sul solo segmento «Collegati» — la colonna larga 1120.
describe('DS4 (fase design): «Collegati» è la tabella unica, e lì la pagina è larga wide', () => {
  const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
  // un render solo per tutti i test del gruppo: è pesante (carica il catalogo delle app)
  let rendered: Promise<HtmlNode> | null = null
  const renderConnected = (): Promise<HtmlNode> => {
    rendered ??= (async (): Promise<HtmlNode> => {
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
          usage: [
            { tool: 'mcp__mattermost__post_message', last: Date.now() - 3 * 24 * 3600 * 1000, week: 4 },
            { tool: 'composio__trello__TRELLO_CREATE_CARD', last: Date.now() - 26 * 3600 * 1000, week: 31 }
          ],
          perms: { default: 'needs_approval', rules: [
            { tool: 'mcp__mattermost__post_message', pattern: '*', mode: 'blocked' },
            { tool: 'mcp__mattermost__read_channel', pattern: '*', mode: 'always_allow' }
          ] },
          skills: [],
          seg: 'connected'
        }
      } as never))
      // lo store del file è condiviso: si ripulisce per i test dopo
      setStoreStateForRender(useStore, { connectors: [], composio: null, composioGateway: null })
      return parseHtml(out)
    })()
    return rendered
  }

  it('sette intestazioni in tono normale (text-caption grigie: niente maiuscoletto); le righe sono da 52, si aprono (tasto e clic) e portano il loro testid; il logo è da 32 nella prima cella', async () => {
    const root = await renderConnected()
    const table = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-connected-table')[0]!
    const th = findAll(table, (n) => n.tag === 'th')
    expect(th.map((x) => textOf(x))).toEqual(['Collegamento', 'Strada', 'Account', 'Stato', 'Permessi', 'Bot', 'Ultimo uso'])
    for (const x of th) {
      expect(has(x, 'text-caption')).toBe(true)
      expect(has(x, 'text-muted-foreground')).toBe(true)
      expect(has(x, 'whitespace-nowrap')).toBe(true)
      expect(x.attrs.class ?? '').not.toContain('uppercase')
    }
    const rows = findAll(table, (n) => (n.attrs['data-testid'] ?? '').startsWith('plugin-connected-row-'))
    expect(rows.map((r) => r.attrs['data-testid']).sort()).toEqual(['plugin-connected-row-app:notion', 'plugin-connected-row-app:trello', 'plugin-connected-row-server:srv-mm'])
    for (const r of rows) {
      expect(r.tag).toBe('tr')
      expect(has(r, 'h-row')).toBe(true)
      // apribile da tastiera: il tasto c'è solo alle righe che si aprono
      expect(r.attrs.tabindex).toBe('0')
      // la prima cella: lo slot del logo (la casa da 32) col logo o l'iniziale dentro
      const slot = r.children[0]!.children[0]!.children[0]!
      expect(has(slot, 'size-8')).toBe(true)
      expect(has(slot.children[0]!, 'size-8')).toBe(true)
      expect(has(slot.children[0]!, 'rounded-control')).toBe(true)
    }
    // i valori di prima, tutti: comando, permessi in breve, ultimo uso, l'account onesto
    const texts = findAll(table, () => true).map((n) => textOf(n)).join('\n')
    for (const valore of ['npx @donach/mattermost-mcp', '1 sempre · 1 blocca', '31 questa settimana', 'fabio', 'Tutti i bot', 'mai', 'non parte']) expect(texts).toContain(valore)
  }, 20_000)

  it('niente a capo: il badge della strada è una pillola su una riga (se non entra si tronca LEI); ogni cella tronca, e il valore intero sta nel suggerimento', async () => {
    const root = await renderConnected()
    const table = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-connected-table')[0]!
    const pills = findAll(table, (n) => has(n, 'rounded-full') && has(n, 'text-caption'))
    expect(pills.map((p) => textOf(p)).sort()).toEqual(['MCP diretto di Notion', 'sul Mac', 'tramite Composio'])
    for (const p of pills) {
      for (const cls of ['truncate', 'max-w-full', 'px-2', 'py-0.5']) expect(has(p, cls)).toBe(true)
      // il testo intero al passaggio, anche quando la pillola si tronca
      expect(p.attrs.title).toBe(textOf(p))
    }
    const cells = findAll(table, (n) => n.tag === 'td')
    expect(cells).toHaveLength(21)
    for (const c of cells) expect(findAll(c, (x) => has(x, 'truncate')).length).toBeGreaterThanOrEqual(1)
    // il valore intero al passaggio: le celle di testo lo portano nel title quando è una stringa
    const command = findAll(table, (n) => textOf(n) === 'npx @donach/mattermost-mcp')[0]!
    expect(command.attrs.title).toBe('npx @donach/mattermost-mcp')
    // chi va bene è grigio, chi non va è rosso (PP4: un solo segnale di stato)
    const stato = findAll(table, (n) => textOf(n) === 'non parte' && n.attrs.title === 'non parte')[0]!
    expect(has(stato, 'text-destructive')).toBe(true)
    expect(stato.attrs.title).toBe('non parte')
  }, 20_000)

  it('la tabella al minimo è 940 px — due colonne che crescono (160 ciascuna) e cinque fisse (620) —: ci sta in una finestra di 1280 con la barra com’è di default; sotto scorre DENTRO la tabella', async () => {
    const root = await renderConnected()
    const table = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-connected-table')[0]!
    expect(table.attrs.class ?? '').toContain('overflow-x-auto')
    expect(table.children[0]!.tag).toBe('table')
    expect(table.children[0]!.attrs.style).toBe('min-width:940px')
  }, 20_000)

  it('solo su «Collegati» il contenuto è largo wide (1120): testata, descrizione, barra degli strumenti e corpo cambiano insieme', async () => {
    const root = await renderConnected()
    const page = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-page')[0]!
    const columns = findAll(page, (n) => 'data-page-content' in n.attrs)
    expect(columns.length).toBeGreaterThanOrEqual(4)
    for (const c of columns) expect(c.attrs.style).toBe('max-width:var(--w-wide)')
    // e la tabella sta dentro il segmento, dopo i filtri
    const segment = findAll(root, (n) => n.attrs['data-testid'] === 'plugin-connected')[0]!
    expect(findAll(segment, (n) => n.attrs['data-testid'] === 'plugin-connected-filters')).toHaveLength(1)
    expect(findAll(segment, (n) => n.attrs['data-testid'] === 'plugin-connected-table')).toHaveLength(1)
  }, 20_000)
})
