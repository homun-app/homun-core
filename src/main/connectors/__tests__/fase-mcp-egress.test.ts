// N1 + N3 (fase mcp-egress-sicurezza): il recinto dei server npm è un muro,
// non un consiglio. N1: con l'uscita di rete «direct» (Docker) la proposta E
// l'installazione di un server npm si RIFIUTANO con la frase in parole, prima
// ancora di leggere il registro; N3: il nome del pacchetto segue le regole di
// npm PRIMA di ogni fetch, e il runtime della card è ARGV (command + args),
// mai una stringa da far interpretare a una shell. Tutto con deps finti.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMcpServerCard, installMcpServer, type InstallDeps } from '../install'
import { parseNpmServerId, npmPackumentUrl, npmDownloadsUrl } from '../npm-registry'
import type { McpServerConfig } from '../../mcp'

let DATA: string
beforeAll(() => { DATA = mkdtempSync(join(tmpdir(), 'sandbot-fase-mcp-egress-')) })
afterAll(() => { rmSync(DATA, { recursive: true, force: true }) })

const NPM_INFO = {
  name: '@donach/mattermost-mcp', version: '2.3.4', author: 'Donach',
  maintainers: ['donach'], publishedAt: '2026-11-02T10:00:00.000Z', weeklyDownloads: 42017
}

function makeDeps(over: Partial<InstallDeps> = {}): { deps: InstallDeps; npmFetches(): number } {
  const servers: McpServerConfig[] = []
  let fetches = 0
  const deps: InstallDeps = {
    store: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async () => undefined,
      removeAll: async () => undefined
    },
    marketplaces: { findPlugin: async () => null, cloneOf: () => null, list: () => [] },
    findRegistryEntry: async () => null,
    findNpmPackage: async (name: string, version?: string) => {
      fetches++
      return { ...NPM_INFO, name, version: version ?? NPM_INFO.version }
    },
    listServers: () => servers,
    saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) },
    toolsOfServer: async () => [{ name: 'send_message' }],
    openExternal: async () => undefined,
    hasUi: () => true,
    dockerMode: () => true,
    // N1: il motore garantisce che il proxy è l'unica uscita (rete interna)
    npmEgressGuaranteed: () => true,
    dataDir: () => DATA,
    onChange: () => undefined,
    ...over
  }
  return { deps, npmFetches: () => fetches }
}

const RIFIUTO = /unverified npm servers do not start/

describe('N1: con l\'uscita «direct» (Docker) i server npm NON partono', () => {
  it('la PROPOSTA si rifiuta con la frase in parole, PRIMA di leggere il registro', async () => {
    const { deps, npmFetches } = makeDeps({ npmEgressGuaranteed: () => false })
    const r = await buildMcpServerCard('npm:@donach/mattermost-mcp', 'per Mattermost', deps, [], ['mattermost.competitoor.com'])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(RIFIUTO)
      expect(r.error).toMatch(/Docker/)
      expect(r.error).toMatch(/Apple|Cursor|Claude|Zcode/)
    }
    // niente card: nessuna promessa di recinto può comparire
    expect(npmFetches()).toBe(0)
  })

  it('l\'INSTALLAZIONE (click su una card nata col recinto, motore passato a Docker) si rifiuta e NON registra il server', async () => {
    const built = await buildMcpServerCard('npm:@donach/mattermost-mcp', 'per Mattermost', makeDeps().deps, [], ['mattermost.competitoor.com'])
    expect(built.ok).toBe(true)
    const { deps } = makeDeps({ npmEgressGuaranteed: () => false })
    const r = await installMcpServer((built as unknown as { card: never }).card, 'agent_1', deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(RIFIUTO)
    expect(deps.listServers()).toEqual([])
  })

  it('col recinto garantito (rete interna) tutto come oggi: card con allowHosts e installazione', async () => {
    const { deps } = makeDeps()
    const r = await buildMcpServerCard('npm:@donach/mattermost-mcp', 'per Mattermost', deps, [], ['mattermost.competitoor.com'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.card.allowHosts).toEqual(['mattermost.competitoor.com'])
    const inst = await installMcpServer((r as unknown as { card: never }).card, 'agent_1', makeDeps().deps)
    expect(inst.ok).toBe(true)
  })
})
