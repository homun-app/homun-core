// PP4 (fase plugin-pulita): la scheda del plugin — meno muro, come la lista.
// Testata: indietro · logo 40 · nome + riga grigia (tipo · strada) · a destra
// l'interruttore SENZA etichetta e un menu ⋯ (Prova la connessione, Ricollega
// se OAuth, Rimuovi/Scollega con conferma); lo stato in parole solo quando non
// va. Schede interne come testo (UnderlineTabs). Panoramica senza riquadri, a
// due colonne quando c'è spazio (etichetta grigia a sinistra: Provenienza /
// Sicurezza / Dati, valore a destra). Autorizzazioni a filo: intestazione di
// gruppo con il selettore, azioni come FlatRow. «Bot che lo usano» come
// FlatList: «Tutti i bot» e un bot per riga. La scheda non usa più
// SettingsGroup / SettingsRow (restano quelli delle Impostazioni).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { stubApiMethod, callsOf } from './render-helper-install'
import type { McpServerInfo, PermissionsConfig } from '../../../shared/types'

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

const CARD_SRC = readFileSync(fileURLToPath(new URL('../components/PluginCard.tsx', import.meta.url)), 'utf8')
const ROWS_SRC = readFileSync(fileURLToPath(new URL('../components/plugin/ServerSecretRows.tsx', import.meta.url)), 'utf8')

const { PluginCard } = await import('../components/PluginCard')
const { cardGrayLineOf } = await import('../lib/plugins-view')
const { useStore } = await import('../store')

const SERVER: McpServerInfo = {
  id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: 'node', args: ['ufficio-mcp.mjs'],
  enabled: true, enabledFor: ['*'], source: { kind: 'registry', name: 'ufficio' }
}
const HTTP: McpServerInfo = { id: 'srv-http', name: 'ufficio', transport: 'http', url: 'https://mcp.ufficio.example/mcp', enabled: true, enabledFor: ['*'] }
const TOOLS = [
  { name: 'search_emails', description: 'Cerca nella posta', annotations: { readOnlyHint: true } },
  { name: 'read_email', description: 'Legge un messaggio', annotations: { readOnlyHint: true } },
  { name: 'create_draft', description: 'Prepara una bozza' },
  { name: 'send_email', description: 'Invia un messaggio' },
  { name: 'delete_email', description: 'Cestina', annotations: { destructiveHint: true } }
]
const PERMS: PermissionsConfig = { default: 'needs_approval', rules: [{ tool: 'mcp__*', pattern: '*', mode: 'needs_approval' }] }

beforeEach(() => {
  capture.els.length = 0
  stubApiMethod('getPermissions', () => PERMS)
  stubApiMethod('setPermissions', () => undefined)
  stubApiMethod('connectorsSetEnabledFor', () => ({ ok: true }))
  stubApiMethod('mcpDelete', () => undefined)
  stubApiMethod('mcpTest', () => ({ ok: true, tools: ['mcp__ufficio__search_emails', 'mcp__ufficio__read_email'] }))
  setStoreStateForRender(useStore, {
    agents: [
      { id: 'a-1', name: 'Competitoor', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 },
      { id: 'a-2', name: 'Ricerche', description: '', providerId: null, model: null, status: 'idle', unread: 0, createdAt: 1 }
    ],
    connectors: [], composio: null, composioGateway: null
  })
})

const has = (node: HtmlNode, cls: string): boolean => (node.attrs.class ?? '').split(/\s+/).includes(cls)
const bgTokens = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((c) => c.startsWith('bg-') && !c.startsWith('hover:'))
const byId = (root: HtmlNode, id: string) => findAll(root, (n) => n.attrs['data-testid'] === id)
const el = (id: string) => capture.els.find((e) => e.props['data-testid'] === id)
/** Quante chiamate a un metodo dell'api da qui in poi (il registro dell'api finta dura per tutto il file). */
const counter = (method: string): (() => unknown[][]) => {
  const from = callsOf(method).length
  return () => callsOf(method).slice(from).map((c) => c.args)
}
/** La scheda di un server, con i dati iniziali dei test (senza effect). */
const render = (server: McpServerInfo = SERVER, initial: Record<string, unknown> = {}, handlers: Record<string, unknown> = {}): HtmlNode => {
  capture.els.length = 0
  return parseHtml(renderHtml(createElement(PluginCard, {
    server,
    initial: { tools: TOOLS, permissions: PERMS, ...initial },
    onClose: () => undefined,
    onChanged: () => undefined,
    ...handlers
  } as never)))
}

describe('PP4: la scheda — testata', () => {
  it("indietro · logo 40 · nome + riga grigia «Server MCP · registro MCP · ufficio» · a destra l'interruttore SENZA etichetta e il menu ⋯", () => {
    const root = render()
    const head = byId(root, 'plugin-card-head')[0]!
    const texts = findAll(head, () => true).map((n) => textOf(n)).join(' ')
    expect(texts).toContain('ufficio')
    expect(texts).toContain('Server MCP · registro MCP · ufficio')
    // l'interruttore: nessuna parola «Attivo» accanto (l'aria-label sì)
    expect(texts).not.toContain('Attivo')
    expect(el('plugin-card-active')!.props['aria-label']).toBe('Attivo')
    expect(byId(root, 'plugin-card-menu-trigger')).toHaveLength(1)
    expect(byId(root, 'plugin-card-menu')).toHaveLength(1)
    // il logo è da 40px
    expect(CARD_SRC).toContain('className="size-10 shrink-0 rounded-[11px] object-cover dark:bg-white"')
  })

  it("lo stato in parole SOLO quando non va: quando va bene nessuna parola; rotto la parola rossa col perché; spento «spento»", () => {
    expect(byId(render(), 'plugin-card-state')).toHaveLength(0)
    const rotto = render({ ...SERVER, stateStatus: 'error', stateError: 'spawn node ENOENT' })
    const stato = byId(rotto, 'plugin-card-state')[0]!
    expect(has(stato, 'text-destructive')).toBe(true)
    expect(textOf(stato)).toBe('non parte')
    expect(textOf(byId(rotto, 'plugin-card-why')[0]!)).toBe('spawn node ENOENT')
    const spento = render({ ...SERVER, enabled: false, disabledReason: 'user' })
    expect(textOf(byId(spento, 'plugin-card-state')[0]!)).toBe('spento')
    // e per lo spento dall'utente l'interruttore resta (spentO)
    expect(el('plugin-card-active')!.props['aria-checked']).toBe(false)
  })

  it("spento da Homun: «Riaccendi» AL POSTO dell'interruttore, e accende (mcpSave enabled true senza motivo)", () => {
    const root = render({ ...SERVER, enabled: false, firstOkAt: 1 })
    expect(byId(root, 'plugin-card-active')).toHaveLength(0)
    expect(textOf(byId(root, 'plugin-card-state')[0]!)).toBe('spento da Homun: non rispondeva')
    ;(el('plugin-card-reenable')!.props.onClick as () => void)()
    const saved = callsOf('mcpSave').slice(-1)[0]!.args[0] as { enabled: boolean; disabledReason?: string }
    expect(saved.enabled).toBe(true)
    expect(saved.disabledReason).toBeUndefined()
  })

  it("la riga grigia della scheda (funzione pura): server «tipo · strada · origine», connettore «diretto» o «tramite Composio»", () => {
    expect(cardGrayLineOf({ server: SERVER }, 'it')).toBe('Server MCP · registro MCP · ufficio')
    expect(cardGrayLineOf({ server: { id: 'x', name: 'x' } }, 'it')).toBe('Server MCP · sul Mac')
    expect(cardGrayLineOf({ server: { id: 'x', name: 'x' } }, 'en')).toBe('MCP server · on your Mac')
    expect(cardGrayLineOf({ app: { name: 'Notion', via: 'direct' } }, 'it')).toBe('Connettore · MCP diretto di Notion')
    expect(cardGrayLineOf({ app: { name: 'Notion', via: 'composio' } }, 'en')).toBe('Connector · via Composio')
  })
})

describe('PP4: le schede interne sono testo', () => {
  it("un tablist: Panoramica · Autorizzazioni · Account e bot, aria-selected sull'attiva, nessuna pillola nera", () => {
    const root = render()
    const list = byId(root, 'plugin-card-tabs')[0]!
    expect(list.attrs.role).toBe('tablist')
    const tabs = findAll(list, (n) => n.attrs.role === 'tab')
    expect(tabs.map((x) => textOf(x))).toEqual(['Panoramica', 'Autorizzazioni', 'Account e bot'])
    expect(tabs.map((x) => x.attrs['aria-selected'])).toEqual(['true', 'false', 'false'])
    for (const x of tabs) expect(bgTokens(x)).toEqual([])
    expect(CARD_SRC).toMatch(/<UnderlineTabs<PluginCardTab>/)
  })
})

describe('PP4: Panoramica a due colonne, senza riquadri', () => {
  const groupLabels = (overview: HtmlNode): string[] =>
    findAll(overview, (n) => n.tag === 'p' && has(n, 'text-muted-foreground') && ['Provenienza', 'Sicurezza', 'Dati'].includes(textOf(n))).map((g) => textOf(g))
  const groupRows = (overview: HtmlNode): HtmlNode[] =>
    findAll(overview, (n) => n.tag === 'p' && has(n, 'text-muted-foreground') && ['Provenienza', 'Sicurezza', 'Dati'].includes(textOf(n))).map((g) => g.parent!)

  it('il contenitore è @container con la soglia a 560px: una colonna di default (etichetta sopra), due sopra 560px (etichetta a sinistra, valore a destra); filetto tra i gruppi', () => {
    const root = render(HTTP)
    const overview = byId(root, 'plugin-overview')[0]!
    expect(has(overview, '@container')).toBe(true)
    expect(groupLabels(overview)).toEqual(['Provenienza', 'Sicurezza', 'Dati'])
    for (const row of groupRows(overview)) {
      expect(has(row, 'grid')).toBe(true)
      expect(has(row, 'grid-cols-1')).toBe(true)
      expect((row.attrs.class ?? '')).toContain('@[560px]:grid-cols-')
      expect(has(row, 'border-t')).toBe(true)
    }
  })

  it('niente riquadri bg-muted/50 nella scheda; i valori dicono dove gira e dove vanno i dati', () => {
    const root = render(HTTP)
    // i riempimenti tenui dei riquadri di prima (bg-muted/50…): restano la piastrella del logo (bg-muted pieno) e il fondo dell'interruttore spento
    expect(findAll(root, (n) => bgTokens(n).some((c) => /^bg-muted\/\d+$/.test(c)))).toHaveLength(0)
    const texts = textOf(byId(root, 'plugin-overview')[0]!)
    expect(texts).toContain('gira sul tuo Mac')
    expect(texts).toContain('i dati vanno a mcp.ufficio.example')
    expect(texts).toContain('i segreti stanno cifrati sul tuo Mac')
    expect(texts).toContain('https://mcp.ufficio.example/mcp')
  })

  it("un server a comando senza indirizzo non mostra il gruppo «Dati» (mai dati inventati); il comando resta, la descrizione non si inventa", () => {
    const root = render()
    const overview = byId(root, 'plugin-overview')[0]!
    expect(groupLabels(overview)).toEqual(['Provenienza', 'Sicurezza'])
    expect(textOf(overview)).toContain('node ufficio-mcp.mjs')
    expect(byId(root, 'plugin-overview-description')).toHaveLength(0)
  })
})

describe('PP4: Autorizzazioni a filo', () => {
  it("per gruppo: una riga d'intestazione (nome · N, il selettore a destra) e le azioni come FlatRow — nessun fondo per riga; la frase F8 in fondo", () => {
    const root = render()
    const perms = byId(root, 'plugin-permissions')[0]!
    const read = byId(root, 'plugin-group-read')[0]!
    const head = byId(read, 'plugin-group-head-read')[0]!
    expect(textOf(findAll(head, (n) => n.tag === 'h3')[0]!)).toBe('Sola lettura · 2')
    expect(findAll(head, (n) => n.tag === 'select')).toHaveLength(1)
    const tools = findAll(read, (n) => (n.attrs['data-testid'] ?? '').startsWith('plugin-tool-') && !(n.attrs['data-testid'] ?? '').startsWith('plugin-tool-select-'))
    expect(tools.map((t) => t.attrs['data-testid'])).toEqual(['plugin-tool-search_emails', 'plugin-tool-read_email'])
    for (const tool of tools) {
      expect(has(tool, 'py-3')).toBe(true)
      expect(bgTokens(tool)).toEqual([])
      expect(findAll(tool, (n) => n.tag === 'select')).toHaveLength(1)
    }
    // i filetti: intestazione e azioni stanno in un FlatList
    expect(findAll(read, (n) => has(n, 'divide-y')).length).toBeGreaterThanOrEqual(1)
    expect(textOf(perms)).toMatch(/Dopo che un bot ha letto contenuti non fidati, le azioni di scrittura tornano a chiedere anche se le hai consentite\.$/)
  })
})

describe('PP4: Account e bot a filo', () => {
  it("«Bot che lo usano» è un FlatList: prima «Tutti i bot» con l'interruttore, poi UN BOT PER RIGA (nome a sinistra, interruttore a destra)", () => {
    const root = render()
    const accounts = byId(root, 'plugin-accounts')[0]!
    const list = byId(root, 'plugin-card-bots')[0]!
    expect(has(list, 'divide-y')).toBe(true)
    const rows = list.children
    expect(rows.map((r) => textOf(r))).toEqual(['Tutti i bot', 'Competitoor', 'Ricerche'])
    for (const r of rows) expect(findAll(r, (n) => n.attrs.role === 'switch')).toHaveLength(1)
    expect(textOf(accounts)).toContain('Account')
    expect(textOf(accounts)).toContain('nessun account')
  })

  it("l'interruttore di un bot scrive enabledFor: da «tutti», spegnerne uno lascia TUTTI GLI ALTRI", async () => {
    render()
    const switches = capture.els.filter((e) => e.type === 'button' && e.props.role === 'switch')
    const competitoor = switches.find((e) => e.props['aria-label'] === 'Competitoor')!
    ;(competitoor.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(callsOf('connectorsSetEnabledFor').slice(-1)[0]!.args).toEqual(['server', 'srv-ufficio', ['a-2']])
  })

  it("Rimuovi in fondo come testo rosso: chiede conferma, poi «Rimuovi davvero» chiama la RPC giusta, aggiorna e chiude", async () => {
    const deletes = counter('mcpDelete')
    const uninstalls = counter('connectorsUninstallServer')
    const root = render()
    const rimuovi = byId(root, 'plugin-card-remove-bottom')[0]!
    expect(textOf(rimuovi)).toBe('Rimuovi')
    expect(has(rimuovi, 'text-destructive')).toBe(true)
    ;(el('plugin-card-remove-bottom')!.props.onClick as () => void)()
    expect(deletes()).toHaveLength(0)
    expect(uninstalls()).toHaveLength(0)
    // con la conferma aperta (stato iniziale, per il render senza re-render) il bottone dice «Rimuovi davvero»
    const onChanged = vi.fn()
    const onClose = vi.fn()
    const open = render(SERVER, { confirmRemove: true }, { onClose, onChanged })
    expect(textOf(byId(open, 'plugin-card-remove-bottom')[0]!)).toBe('Rimuovi davvero')
    ;(el('plugin-card-remove-bottom')!.props.onClick as () => Promise<void>)()
    await new Promise((r) => setTimeout(r, 0))
    // questo server viene dal registro: la strada giusta è la disinstallazione (i segreti seguono il server)
    expect(uninstalls()).toEqual([['srv-ufficio']])
    expect(onChanged).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('PP4: il menu ⋯ della testata', () => {
  const items = (root: HtmlNode): string[] => findAll(byId(root, 'plugin-card-menu')[0]!, (n) => n.attrs.role === 'menuitem').map((i) => textOf(i))

  it('per un server: Prova la connessione e Rimuovi (rosso); Ricollega solo se OAuth; il menu sta sempre nel DOM', () => {
    expect(items(render())).toEqual(['Prova la connessione', 'Rimuovi'])
    expect(items(render({ ...HTTP, auth: { kind: 'oauth' } }))).toEqual(['Prova la connessione', 'Ricollega', 'Rimuovi'])
    const red = findAll(byId(render(), 'plugin-card-menu')[0]!, (n) => n.attrs.role === 'menuitem' && has(n, 'text-destructive')).map((i) => textOf(i))
    expect(red).toEqual(['Rimuovi'])
    expect(CARD_SRC).toContain('data-testid="plugin-card-menu"')
  })

  it('«Prova la connessione» chiama mcpTest sul server', async () => {
    render()
    ;(el('plugin-card-test')!.props.onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(callsOf('mcpTest').slice(-1)[0]!.args).toEqual(['srv-ufficio'])
  })

  it("«Rimuovi» del menu chiede conferma: «Rimuovi davvero» chiama la RPC e chiude; «Annulla» ritira la domanda", async () => {
    const deletes = counter('mcpDelete')
    const uninstalls = counter('connectorsUninstallServer')
    render()
    ;(el('plugin-card-remove')!.props.onClick as () => void)()
    expect(deletes()).toHaveLength(0)
    expect(uninstalls()).toHaveLength(0)
    const onChanged = vi.fn()
    const onClose = vi.fn()
    render(SERVER, { confirmRemove: true }, { onClose, onChanged })
    ;(el('plugin-card-remove-confirm')!.props.onClick as () => Promise<void>)()
    await new Promise((r) => setTimeout(r, 0))
    expect(uninstalls()).toEqual([['srv-ufficio']])
    expect(onClose).toHaveBeenCalled()
    expect(el('plugin-card-remove-cancel')).toBeTruthy()
    // un server MANUALE (senza origine) si toglie con mcpDelete
    capture.els.length = 0
    const manuale: McpServerInfo = { id: 'srv-manuale', name: 'manuale', transport: 'stdio', command: 'node', enabled: true }
    render(manuale, { confirmRemove: true }, { onClose, onChanged })
    ;(el('plugin-card-remove-confirm')!.props.onClick as () => Promise<void>)()
    await new Promise((r) => setTimeout(r, 0))
    expect(deletes()).toEqual([['srv-manuale']])
  })
})

describe('PP4: la scheda non usa più SettingsGroup / SettingsRow', () => {
  it('né PluginCard né le sue righe del segreto li importano; quelli delle Impostazioni non sono cambiati', () => {
    for (const src of [CARD_SRC, ROWS_SRC]) {
      expect(src).not.toMatch(/import \{ SettingsGroup \}/)
      expect(src).not.toMatch(/import \{ SettingsRow \}/)
      expect(src).not.toMatch(/<SettingsGroup\b|<SettingsRow\b/)
    }
    expect(ROWS_SRC).toMatch(/<FlatRow\b/)
    const row = readFileSync(fileURLToPath(new URL('../components/settings/SettingsRow.tsx', import.meta.url)), 'utf8')
    expect(row).toContain('@[420px]:flex-row')
  })
})
