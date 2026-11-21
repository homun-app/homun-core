// Fase plugin (PL1): il modello puro della pagina «Plugin» — le righe di
// «I tuoi» con la riga grigia «tipo · strada · origine» e lo stato con
// l'azione. Funzioni pure: connettori del catalogo, server MCP installati,
// plugin, skill; la ricerca filtra; lo stato è onesto (non parte, accesso
// scaduto, da completare). I test usano le stesse forme di apps-view.
import { describe, expect, it } from 'vitest'
import type { CatalogRowView } from '../apps-view'
import {
  yourPlugins, grayLineOf, stateLabelOf, stradaOfServer, pluginStateOfServer,
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
