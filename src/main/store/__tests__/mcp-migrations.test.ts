// Test della migrazione dei server del registro (fase mcp-setup, M7): un
// server salvato dalle versioni di prima con l'URL coi segnaposto LETTERALI
// (il Mattermost della prova dell'utente) diventa urlTemplate con needsAuth
// 'setup'. Il core è PURO; il runner è idempotente per FLAG.
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../../mcp'
import { migrateRegistryServerTemplates } from '../mcp-migrations'

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
