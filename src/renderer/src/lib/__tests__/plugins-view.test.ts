// Fase plugin (PL1): il modello puro della pagina «Plugin» — le righe di
// «I tuoi» con la riga grigia «tipo · strada · origine» e lo stato con
// l'azione. Funzioni pure: connettori del catalogo, server MCP installati,
// plugin, skill; la ricerca filtra; lo stato è onesto (non parte, accesso
// scaduto, da completare). I test usano le stesse forme di apps-view.
import { describe, expect, it } from 'vitest'
import type { CatalogRowView } from '../apps-view'
import {
  yourPlugins, grayLineOf, stateLabelOf, stradaOfServer, pluginStateOfServer,
  connectedTable, daSistemareCount, usagePrefixOf, useOfRow, permCountsOf,
  type YourPluginRow
} from '../plugins-view'

/** Una riga del catalogo come arriva da appsCatalogModel (solo i campi usati). */
function appRow(over: Partial<CatalogRowView['app']> & { id: string; name: string; via?: 'direct' | 'composio' }): CatalogRowView {
  return {
    app: {
      id: over.id,
      name: over.name,
      description: null,
      tagline: null,
      category: 'productivity',
      logo: null,
      via: over.via ?? 'composio',
      featured: false,
      rank: 0,
      ...(over.composioSlug !== undefined ? { composioSlug: over.composioSlug } : {}),
      ...(over.directId !== undefined ? { directId: over.directId } : {})
    },
    tagline: null,
    connected: 'connected'
  }
}

const AGENTS = [{ id: 'a-1', name: 'Competitoor' }, { id: 'a-2', name: 'Ricerche' }]

describe('PL1: yourPlugins — le righe di «I tuoi»', () => {
  it('connettore diretto del catalogo: «Connettore · MCP diretto di Notion», attivo, verificato', () => {
    const rows = yourPlugins({
      connectedApps: [appRow({ id: 'notion', name: 'Notion', via: 'direct', directId: 'notion' })],
      composio: null, composioGateway: null, installed: null, skills: null,
      agents: AGENTS, query: ''
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('connector')
    expect(rows[0]!.open).toEqual({ kind: 'app', appId: 'notion' })
    expect(rows[0]!.state).toBe('active')
    expect(rows[0]!.verified).toBe(true)
    expect(grayLineOf(rows[0]!, 'it')).toBe('Connettore · MCP diretto di Notion')
    expect(grayLineOf(rows[0]!, 'en')).toBe('Connector · direct MCP from Notion')
  })

  it('connettore Composio: «Connettore · tramite Composio», NON verificato', () => {
    const rows = yourPlugins({
      connectedApps: [appRow({ id: 'trello', name: 'Trello', via: 'composio', composioSlug: 'trello' })],
      composio: null, composioGateway: null, installed: null, skills: null,
      agents: AGENTS, query: ''
    })
    expect(rows[0]!.gray.strada).toBe('composio')
    expect(rows[0]!.verified).toBe(false)
    expect(grayLineOf(rows[0]!, 'it')).toBe('Connettore · tramite Composio')
  })

  it('server MCP manuale: «Server MCP · sul Mac»; registro: «Server MCP · registro MCP · <nome>»', () => {
    const rows = yourPlugins({
      connectedApps: [],
      composio: null, composioGateway: null,
      installed: {
        servers: [
          { id: 'srv-1', name: 'Mattermost', enabledFor: ['a-1'] },
          { id: 'srv-2', name: 'orion-moon', enabledFor: ['*'], source: { kind: 'registry', name: 'orion-moon' } }
        ],
        plugins: []
      },
      skills: null, agents: AGENTS, query: ''
    })
    const mm = rows.find((r) => r.name === 'Mattermost')!
    expect(mm.kind).toBe('server')
    expect(mm.gray.strada).toBe('mac')
    expect(grayLineOf(mm, 'it')).toBe('Server MCP · sul Mac')
    expect(mm.bots).toEqual({ all: false, names: ['Competitoor'], extra: 0 })
    const om = rows.find((r) => r.name === 'orion-moon')!
    expect(om.gray.strada).toBe('registry')
    expect(grayLineOf(om, 'it')).toBe('Server MCP · registro MCP · orion-moon')
    expect(om.open).toEqual({ kind: 'server', serverId: 'srv-2' })
  })

  it('server npm nel computer isolato: strada «nel computer isolato»', () => {
    expect(stradaOfServer({ id: 'x', name: 'pdf-tools', source: { kind: 'npm', package: '@acme/pdf-mcp', version: '2.1.0' } })).toBe('box-npm')
  })

  it('lo stato onesto del server: non parte (errore), accesso scaduto, da completare, attivo', () => {
    expect(pluginStateOfServer({ id: 'a', name: 'a', stateStatus: 'error' })).toBe('broken')
    expect(pluginStateOfServer({ id: 'b', name: 'b', needsReauth: true })).toBe('expired')
    expect(pluginStateOfServer({ id: 'c', name: 'c', stateStatus: 'needs_auth' })).toBe('expired')
    expect(pluginStateOfServer({ id: 'd', name: 'd', needsAuth: { kind: 'env', keys: ['K'] } })).toBe('setup')
    expect(pluginStateOfServer({ id: 'e', name: 'e' })).toBe('active')
    expect(stateLabelOf('broken', 'it')).toEqual({ label: 'non parte', action: 'why' })
    expect(stateLabelOf('expired', 'en')).toEqual({ label: 'access expired', action: 'reconnect' })
  })

  it('plugin: «Plugin · da plugin · <marketplace>»; skill: «Skill · Homun» (o l\'origine vera)', () => {
    const rows = yourPlugins({
      connectedApps: [], composio: null, composioGateway: null,
      installed: { servers: [], plugins: [{ name: 'rag-docs', marketplace: 'anthropics/claude-plugins-official', skills: [{ name: 'rag' }], servers: [] }] },
      skills: [
        { name: 'fatture', folder: 'fatture', description: 'Legge le fatture', enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, files: [], valid: true, issues: [] },
        { name: 'rotture', folder: 'rotture', description: '', enabledFor: [], source: 'github', createdAt: 1, updatedAt: 1, files: [], valid: false, issues: [{ english: 'x', uiId: 'skill.noFrontmatter' }] }
      ],
      agents: AGENTS, query: ''
    })
    const plug = rows.find((r) => r.kind === 'plugin')!
    expect(grayLineOf(plug, 'it')).toBe('Plugin · da plugin · anthropics/claude-plugins-official')
    const ok = rows.find((r) => r.name === 'fatture')! as YourPluginRow
    expect(ok.state).toBe('active')
    expect(ok.open).toEqual({ kind: 'skill', folder: 'fatture' })
    expect(grayLineOf(ok, 'it')).toBe('Skill · Homun')
    const bad = rows.find((r) => r.name === 'rotture')!
    expect(bad.state).toBe('invalid')
    // la skill da GitHub dice la sua origine
    expect(grayLineOf(bad, 'it')).toBe('Skill · GitHub')
  })

  it('la ricerca filtra le righe (nome e descrizione della skill)', () => {
    const rows = yourPlugins({
      connectedApps: [appRow({ id: 'notion', name: 'Notion', via: 'direct', directId: 'notion' })],
      composio: null, composioGateway: null, installed: null,
      skills: [{ name: 'fatture', folder: 'fatture', description: 'XML FatturaPA', enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, files: [], valid: true, issues: [] }],
      agents: AGENTS, query: 'fatture'
    })
    expect(rows.map((r) => r.name)).toEqual(['fatture'])
  })
})

// ---- PL3 (fase plugin): la tabella «Collegati» ----

function serverRow(over: Partial<YourPluginRow>): YourPluginRow {
  return {
    key: 'server:x', kind: 'server', name: 'ufficio', logo: null,
    gray: { type: 'server', strada: 'mac' }, state: 'active', verified: false,
    bots: { all: true, names: [], extra: 0 }, open: { kind: 'server', serverId: 'x' },
    ...over
  }
}

describe('PL3: la tabella Collegati — righe, uso e permessi', () => {
  const usage = [
    { tool: 'mcp__ufficio__search', last: 900, week: 4 },
    { tool: 'mcp__ufficio__send', last: 700, week: 2 },
    { tool: 'composio__trello__TRELLO_CREATE_CARD', last: 500, week: 9 },
    { tool: 'skill:fatture', last: 300, week: 1 }
  ]
  const perms = {
    default: 'needs_approval' as const,
    rules: [
      { tool: 'mcp__ufficio__search', pattern: '*', mode: 'always_allow' as const },
      { tool: 'mcp__ufficio__send', pattern: '*', mode: 'blocked' as const },
      { tool: 'mcp__ufficio__read', pattern: '*', mode: 'needs_approval' as const },
      { tool: 'run-command', pattern: 'git *', mode: 'always_allow' as const }
    ]
  }

  it('l\'uso arriva dall\'INDICE per prefisso (ultimo = MAX, settimana = somma)', () => {
    expect(usagePrefixOf(serverRow({ serverSlug: 'ufficio' }))).toBe('mcp__ufficio__')
    expect(useOfRow(usage, 'mcp__ufficio__')).toEqual({ last: 900, week: 6 })
    expect(useOfRow(usage, 'skill:fatture')).toEqual({ last: 300, week: 1 })
    expect(useOfRow(usage, 'mcp__nessuno__')).toBeNull()
  })

  it('i permessi in breve contano le REGOLE SPECIFICHE del plugin (6 sempre · 8 chiedi · 1 blocca)', () => {
    expect(permCountsOf(perms, 'mcp__ufficio__')).toEqual({ always: 1, ask: 1, blocked: 1 })
    expect(permCountsOf(perms, 'mcp__altro__')).toBeNull()
    expect(permCountsOf(null, 'mcp__ufficio__')).toBeNull()
  })

  it('righe per Composio, server manuale, npm nel box e skill, con il conteggio o il comando onesti', () => {
    const rows = connectedTable({
      rows: [
        serverRow({ key: 'server:mm', name: 'Mattermost', serverSlug: 'mattermost', countLabel: 'npx @donach/mattermost-mcp', state: 'broken' }),
        serverRow({ key: 'server:pdf', name: 'pdf-tools', gray: { type: 'server', strada: 'box-npm' }, serverSlug: 'pdf-tools' }),
        { key: 'app:trello', kind: 'connector', name: 'Trello', logo: null, gray: { type: 'connector', strada: 'composio' }, state: 'active', verified: false, bots: { all: false, names: ['Competitoor'], extra: 0 }, open: { kind: 'app', appId: 'trello' }, composioSlug: 'trello' },
        { key: 'skill:fatture', kind: 'skill', name: 'fatture', logo: null, gray: { type: 'skill', strada: 'skill' }, state: 'active', verified: false, bots: { all: true, names: [], extra: 0 }, open: { kind: 'skill', folder: 'fatture' } }
      ],
      usage, perms, filter: 'all', onlyDaSistemare: false
    })
    expect(rows).toHaveLength(4)
    const mm = rows.find((r) => r.row.name === 'Mattermost')!
    expect(mm.countLabel).toBe('npx @donach/mattermost-mcp')
    expect(mm.daSistemare).toBe(true)
    const trello = rows.find((r) => r.row.name === 'Trello')!
    expect(trello.usage).toEqual({ last: 500, week: 9 })
    expect(trello.perms).toBeNull()
    const skill = rows.find((r) => r.row.kind === 'skill')!
    expect(skill.countLabel).toBe('/fatture')
    expect(skill.usage).toEqual({ last: 300, week: 1 })
  })

  it('«Da sistemare» conta e filtra i rotti e gli scaduti', () => {
    const rows: YourPluginRow[] = [
      serverRow({ key: 'a', state: 'broken' }),
      serverRow({ key: 'b', state: 'expired' }),
      serverRow({ key: 'c', state: 'active' })
    ]
    expect(daSistemareCount(rows)).toBe(2)
    const filtered = connectedTable({ rows, usage: [], perms: null, filter: 'all', onlyDaSistemare: true })
    expect(filtered.map((r) => r.row.key)).toEqual(['a', 'b'])
  })

  it('il filtro per strada: MCP diretto/registro, Composio, sul Mac, nel computer isolato', () => {
    const rows: YourPluginRow[] = [
      serverRow({ key: 's1', gray: { type: 'server', strada: 'registry' } }),
      serverRow({ key: 's2', gray: { type: 'server', strada: 'mac' } }),
      serverRow({ key: 's3', gray: { type: 'server', strada: 'box-npm' } }),
      { key: 'app:t', kind: 'connector', name: 'T', logo: null, gray: { type: 'connector', strada: 'composio' }, state: 'active', verified: false, bots: { all: true, names: [], extra: 0 }, open: { kind: 'app', appId: 't' } }
    ]
    expect(connectedTable({ rows, usage: [], perms: null, filter: 'mac', onlyDaSistemare: false }).map((r) => r.row.key)).toEqual(['s2'])
    expect(connectedTable({ rows, usage: [], perms: null, filter: 'box', onlyDaSistemare: false }).map((r) => r.row.key)).toEqual(['s3'])
    expect(connectedTable({ rows, usage: [], perms: null, filter: 'composio', onlyDaSistemare: false }).map((r) => r.row.key)).toEqual(['app:t'])
    expect(connectedTable({ rows, usage: [], perms: null, filter: 'direct', onlyDaSistemare: false }).map((r) => r.row.key)).toEqual(['s1'])
  })
})

// ---- PL5 (fase plugin): le skill dei plugin in pagina come le altre ----
describe('PL5: una skill della libreria e una da plugin, con la riga grigia giusta', () => {
  it('la skill del plugin: «Skill · da plugin · <plugin>», attiva, apre la scheda', () => {
    const rows = yourPlugins({
      connectedApps: [], composio: null, composioGateway: null, installed: null,
      skills: [{ name: 'fatture', folder: 'fatture', description: 'Fatture', enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, files: [], valid: true, issues: [] }],
      pluginSkills: [{ plugin: 'rag-docs', skills: [{ name: 'rag', description: 'Ricerca nei documenti' }] }],
      agents: AGENTS, query: ''
    })
    const plug = rows.find((r) => r.key === 'pluginskill:rag-docs/rag')!
    expect(plug.kind).toBe('skill')
    expect(plug.state).toBe('active')
    expect(plug.open).toEqual({ kind: 'skill', folder: 'rag' })
    expect(grayLineOf(plug, 'it')).toBe('Skill · da plugin · rag-docs')
    const lib = rows.find((r) => r.name === 'fatture')!
    expect(grayLineOf(lib, 'it')).toBe('Skill · Homun')
  })

  it('la ricerca trova anche le skill dei plugin (nome e descrizione)', () => {
    const rows = yourPlugins({
      connectedApps: [], composio: null, composioGateway: null, installed: null, skills: null,
      pluginSkills: [{ plugin: 'rag-docs', skills: [{ name: 'rag', description: 'Ricerca nei documenti' }] }],
      agents: AGENTS, query: 'documenti'
    })
    expect(rows.map((r) => r.name)).toEqual(['rag'])
  })
})

// ---- PL6 (fase plugin): la skill importata da un'altra app ----
describe('PL6: la riga grigia della skill importata da un\'altra app', () => {
  it('«Skill · importata da Cursor» (copia o collegamento che sia)', () => {
    const rows = yourPlugins({
      connectedApps: [], composio: null, composioGateway: null, installed: null,
      skills: [
        { name: 'prezzi', folder: 'prezzi', description: 'Confronta i prezzi', enabledFor: ['*'], source: 'app' as never, importedFromApp: 'Cursor', createdAt: 1, updatedAt: 1, files: [], valid: true, issues: [] },
        { name: 'lavoro', folder: 'lavoro', description: '', enabledFor: ['*'], source: 'app' as never, importedFromApp: 'ZCode', linkedPath: '/orig', createdAt: 1, updatedAt: 1, files: [], valid: true, issues: [] }
      ],
      agents: AGENTS, query: ''
    })
    expect(grayLineOf(rows.find((r) => r.name === 'prezzi')!, 'it')).toBe('Skill · importata da Cursor')
    expect(grayLineOf(rows.find((r) => r.name === 'lavoro')!, 'en')).toBe('Skill · imported from ZCode')
  })
})

// ---- V4 (fase stato-vivo): il server spento dice CHI l'ha spento ----

describe('V4: server spento — «spento da Homun» con Riaccendi, lo user-off è solo spento', () => {
  const offServer = (over: Record<string, unknown> = {}) => ({
    id: 'srv-orion', name: 'orion-moon', enabled: false, ...over
  }) as never
  const rowsOf = (servers: unknown[]): YourPluginRow[] => yourPlugins({
    connectedApps: [], composio: null, composioGateway: null,
    installed: { servers: servers as never, plugins: [] }, skills: null,
    agents: AGENTS, query: ''
  })

  it('spento SENZA motivo (il caso P7/orion-moon) e con never-connected: stato off-homun, etichetta onesta con azione reenable', () => {
    expect(pluginStateOfServer(offServer())).toBe('off-homun')
    expect(pluginStateOfServer(offServer({ disabledReason: 'never-connected' }))).toBe('off-homun')
    expect(pluginStateOfServer(offServer({ disabledReason: 'add-failed' }))).toBe('off-homun')
    const it = stateLabelOf('off-homun', 'it')
    expect(it.label).toBe('spento da Homun: non rispondeva')
    expect(it.action).toBe('reenable')
    const en = stateLabelOf('off-homun', 'en')
    expect(en.label).toBe('switched off by Homun: it was not responding')
    expect(en.action).toBe('reenable')
  })

  it("spento dall'UTENTE (disabledReason 'user'): «spento», nessuna azione", () => {
    expect(pluginStateOfServer(offServer({ disabledReason: 'user' }))).toBe('off-user')
    const it = stateLabelOf('off-user', 'it')
    expect(it.label).toBe('spento')
    expect(it.action).toBeNull()
    const en = stateLabelOf('off-user', 'en')
    expect(en.label).toBe('switched off')
    expect(en.action).toBeNull()
  })

  it('«Da sistemare» conta l\'homun-off ma NON lo user-off (l\'ha deciso l\'utente)', () => {
    const rows = rowsOf([
      offServer({ id: 'homun', name: 'a' }),
      offServer({ id: 'user', name: 'b', disabledReason: 'user' })
    ])
    expect(daSistemareCount(rows)).toBe(1)
    const table = connectedTable({ rows, usage: [], perms: null, filter: 'all', onlyDaSistemare: true })
    expect(table).toHaveLength(1)
    expect(table[0]!.row.state).toBe('off-homun')
  })

  it('il server ACCESO resta attivo anche se gli arrivano campi di stato: il confine è enabled', () => {
    expect(pluginStateOfServer({ id: 'x', name: 'x', enabled: true, stateStatus: 'error' } as never)).toBe('broken')
    expect(pluginStateOfServer({ id: 'y', name: 'y', enabled: true } as never)).toBe('active')
  })
})

// ---- V5 (fase stato-vivo): la skill spenta in pagina ----

describe('V5: la skill SPENTA (enabled false) — visibile ma non da sistemare', () => {
  it('la riga dice «spento» (off-user: l\'ha deciso l\'utente), resta in Collegati e FUORI da «Da sistemare»', () => {
    const rows = yourPlugins({
      connectedApps: [], composio: null, composioGateway: null,
      installed: null,
      skills: [
        { name: 'spenta', folder: 'spenta', description: 'd', enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, files: [], valid: true, enabled: false, issues: [] },
        { name: 'accesa', folder: 'accesa', description: 'd', enabledFor: ['*'], source: 'user', createdAt: 1, updatedAt: 1, files: [], valid: true, issues: [] }
      ] as never,
      agents: AGENTS, query: ''
    })
    const off = rows.find((r) => r.name === 'spenta')!
    expect(off.state).toBe('off-user')
    expect(stateLabelOf(off.state, 'it').label).toBe('spento')
    expect(rows.find((r) => r.name === 'accesa')!.state).toBe('active')
    expect(daSistemareCount(rows)).toBe(0)
    const table = connectedTable({ rows, usage: [], perms: null, filter: 'all', onlyDaSistemare: false })
    expect(table.map((t) => t.row.name)).toContain('spenta')
  })
})
