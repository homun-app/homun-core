// Test della migrazione dei server del registro (fase mcp-setup, M7): un
// server salvato dalle versioni di prima con l'URL coi segnaposto LETTERALI
// (il Mattermost della prova dell'utente) diventa urlTemplate con needsAuth
// 'setup'. Il core è PURO; il runner è idempotente per FLAG.
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../../mcp'
import { toolSlugOf } from '../../mcp/slug'
import { MCP_TOOLSLUG_FLAG, migrateRegistryServerTemplates, migrateToolSlugs } from '../mcp-migrations'

/** Il server come lo salvava il codice di prima della fase (la prova dell'utente). */
const MATTERMOST_DI_IFRI: McpServerConfig = {
  id: 'registry-io-github-mattermost-mattermost-plugin-a-7134f7f8',
  name: 'io.github.mattermost/mattermost-plugin-agents',
  transport: 'http',
  url: 'https://{mattermost_host}/plugins/mattermost-ai/mcp-server/mcp',
  enabled: true,
  auth: { kind: 'headers' },
  enabledFor: ['*'],
  source: { kind: 'registry', name: 'io.github.mattermost/mattermost-plugin-agents', version: '2.12.0' },
  needsAuth: { kind: 'key', keys: ['Authorization'] }
}

describe('M7: migrateRegistryServerTemplates (puro)', () => {
  it('l\'URL con le graffe diventa urlTemplate + needsAuth setup; il vecchio needsAuth key si porta dietro', () => {
    const { servers, changed } = migrateRegistryServerTemplates([MATTERMOST_DI_IFRI])
    expect(changed).toBe(true)
    const s = servers[0]!
    expect(s.url).toBeUndefined() // mai un URL con le graffe
    expect(s.urlTemplate).toBe('https://{mattermost_host}/plugins/mattermost-ai/mcp-server/mcp')
    expect(s.needsAuth).toEqual({ kind: 'setup', keys: ['mattermost_host', 'Authorization'] })
    // auth: headers NON cambia da solo: l'utente aveva scelto il token (M7.2)
    expect(s.auth).toEqual({ kind: 'headers' })
    // il resto resta al suo posto
    expect(s.id).toBe(MATTERMOST_DI_IFRI.id)
    expect(s.source).toEqual(MATTERMOST_DI_IFRI.source)
  })
  it('i server SENZA graffe non si toccano (url, manuale, gateway, plugin)', () => {
    const clean: McpServerConfig[] = [
      { ...MATTERMOST_DI_IFRI, id: 'altro', url: 'https://mcp.example.com/mcp' },
      { id: 'manuale', name: 'manuale', transport: 'stdio', command: 'x', enabled: true },
      { id: 'gw', name: 'gw', transport: 'http', url: 'https://gw.example', enabled: true, source: { kind: 'gateway' } }
    ]
    expect(migrateRegistryServerTemplates(clean)).toEqual({ servers: clean, changed: false })
  })
  it('idempotente: senza graffe non c\'è niente da fare al secondo giro', () => {
    const first = migrateRegistryServerTemplates([MATTERMOST_DI_IFRI])
    const second = migrateRegistryServerTemplates(first.servers)
    expect(second.changed).toBe(false)
    expect(second.servers).toEqual(first.servers)
  })
})

// ---- R1: il congelamento dei toolSlug (prima di qualsiasi rinomina) ----

describe('R1: migrateToolSlugs (core puro)', () => {
  it('ogni server SENZA toolSlug riceve lo slug del nome di OGGI, NON tagliato: i nomi degli strumenti NON cambiano (anche il Mattermost lungo della prova)', () => {
    const { servers, changed, duplicates } = migrateToolSlugs([MATTERMOST_DI_IFRI])
    expect(changed).toBe(true)
    expect(duplicates).toEqual([])
    const s = servers[0]!
    // lo slug di oggi resta COME È (44 caratteri): il taglio a 24 vale solo per i server NUOVI
    expect(s.toolSlug).toBe('io-github-mattermost-mattermost-plugin-agents')
    expect(toolSlugOf(s)).toBe('io-github-mattermost-mattermost-plugin-agents')
  })

  it('due server che oggi hanno lo STESSO slug: il secondo riceve -2 (e il terzo -3); chi viene prima non cambia', () => {
    const due: McpServerConfig[] = [
      { id: 'a', name: 'Notion', transport: 'http', url: 'https://a.example/mcp', enabled: true },
      { id: 'b', name: 'notion', transport: 'http', url: 'https://b.example/mcp', enabled: true },
      { id: 'c', name: 'NOTION', transport: 'http', url: 'https://c.example/mcp', enabled: true }
    ]
    const { servers, duplicates } = migrateToolSlugs(due)
    expect(servers.map((s) => s.toolSlug)).toEqual(['notion', 'notion-2', 'notion-3'])
    expect(duplicates).toEqual([
      { id: 'b', name: 'notion', from: 'notion', to: 'notion-2' },
      { id: 'c', name: 'NOTION', from: 'notion', to: 'notion-3' }
    ])
  })

  it('i server del CATALOGO non si toccano (il loro slug non cambia: fallback sul nome) però CONTANO per i successivi', () => {
    const catalogo: McpServerConfig = {
      id: 'notion', name: 'Notion', transport: 'http', url: 'https://api.notion.com/mcp', enabled: true, catalogId: 'notion'
    }
    const registro: McpServerConfig = {
      id: 'registry-com-notion-mcp-1a2b3c4d', name: 'Notion', transport: 'http', url: 'https://mcp.notion.com/mcp', enabled: true,
      source: { kind: 'registry', name: 'com.notion/mcp' }
    }
    const { servers, duplicates } = migrateToolSlugs([catalogo, registro])
    expect(servers[0]).toEqual(catalogo) // identico, nemmeno il campo
    expect(servers[1]!.toolSlug).toBe('notion-2')
    expect(duplicates.map((d) => d.to)).toEqual(['notion-2'])
  })

  it('verifica: il catalogo vince anche quando nella lista viene DOPO il server del registro (l\'ordine non conta)', () => {
    const registro: McpServerConfig = { id: 'r', name: 'Notion', transport: 'http', url: 'https://r.example/mcp', enabled: true, source: { kind: 'registry', name: 'com.notion/mcp' } }
    const catalogo: McpServerConfig = { id: 'notion', name: 'Notion', transport: 'http', url: 'https://api.notion.com/mcp', enabled: true, catalogId: 'notion' }
    const { servers } = migrateToolSlugs([registro, catalogo])
    expect(servers[0]!.toolSlug).toBe('notion-2')
    expect(servers[1]).toEqual(catalogo)
  })

  it('un server che HA GIÀ toolSlug non si tocca (installato col codice nuovo)', () => {
    const gia: McpServerConfig = { id: 'x', name: 'Qualunque', transport: 'http', enabled: true, toolSlug: 'congelato' }
    expect(migrateToolSlugs([gia]).servers[0]).toBe(gia)
  })

  it('idempotente: al secondo giro non cambia niente (i toolSlug già assegnati restano, il flag blocca il runner)', () => {
    const due: McpServerConfig[] = [
      { id: 'a', name: 'Notion', transport: 'http', enabled: true },
      { id: 'b', name: 'Notion', transport: 'http', enabled: true }
    ]
    const first = migrateToolSlugs(due)
    const second = migrateToolSlugs(first.servers)
    expect(second.changed).toBe(false)
    expect(second.servers).toEqual(first.servers)
    expect(second.duplicates).toEqual([])
    // il runner: il flag è il setting che marca il congelamento fatto
    expect(MCP_TOOLSLUG_FLAG).toBe('mcp.toolSlugsMigrated')
  })
})
