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

describe('N3: il nome del pacchetto segue le regole di npm, prima di ogni fetch', () => {
  it('i nomi validi passano', () => {
    expect(parseNpmServerId('npm:@donach/mattermost-mcp')).toEqual({ kind: 'npm', name: '@donach/mattermost-mcp' })
    expect(parseNpmServerId('npm:left-pad')).toEqual({ kind: 'npm', name: 'left-pad' })
    expect(parseNpmServerId('npm:left-pad@1.3.0')).toEqual({ kind: 'npm', name: 'left-pad', version: '1.3.0' })
  })

  it('i nomi che non sono nomi npm sono RIFIUTATI (niente opzioni di npx, niente injection)', () => {
    for (const bad of ['-e', '--call=x', 'a;b', '../x', 'a b', '@x/../y', 'A', 'x#y', '.nascosto', '_privato', '-p', 'a$b', 'x\\y', 'a:b']) {
      const r = parseNpmServerId(`npm:${bad}`)
      expect('error' in r, `nome ${JSON.stringify(bad)}`).toBe(true)
    }
  })

  it('un nome troppo lungo è rifiutato (≤ 214)', () => {
    const lungo = 'a'.repeat(215)
    expect('error' in parseNpmServerId(`npm:${lungo}`)).toBe(true)
    expect('error' in parseNpmServerId(`npm:${'a'.repeat(214)}`)).toBe(false)
  })

  it('il nome invalido è rifiutato PRIMA del fetch (spia: nessuna lettura del registro)', async () => {
    const { deps, npmFetches } = makeDeps()
    const r = await buildMcpServerCard('npm:-e', '', deps, [], [])
    expect(r.ok).toBe(false)
    expect(npmFetches()).toBe(0)
  })

  it('l\'URL del registro codifica il nome intero, con la @ iniziale preservata', () => {
    expect(npmPackumentUrl('@donach/mattermost-mcp')).toBe('https://registry.npmjs.org/@donach%2Fmattermost-mcp')
    expect(npmPackumentUrl('left-pad')).toBe('https://registry.npmjs.org/left-pad')
    expect(npmDownloadsUrl('@donach/mattermost-mcp')).toBe('https://api.npmjs.org/downloads/point/last-week/@donach%2Fmattermost-mcp')
  })
})

describe('N3: il runtime box-npm della card è ARGV, mai una stringa di shell', () => {
  it('command + args separati: npx --yes <pacchetto>@<versione fissata>', async () => {
    const r = await buildMcpServerCard('npm:@donach/mattermost-mcp', '', makeDeps().deps, [], [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const runtime = r.card.runtime as { kind: string; command: string; args?: string[] }
    expect(runtime.command).toBe('npx')
    expect(runtime.args).toEqual(['--yes', '@donach/mattermost-mcp@2.3.4'])
    // MAI una stringa sola da far interpretare a una shell
    for (const a of [runtime.command, ...(runtime.args ?? [])]) expect(a).not.toMatch(/\s/)
  })

  it('il server installato riceve lo stesso ARGV nel box (command + args, niente stringa)', async () => {
    const built = await buildMcpServerCard('npm:@donach/mattermost-mcp', '', makeDeps().deps, [], ['mattermost.competitoor.com'])
    const { deps } = makeDeps()
    const r = await installMcpServer((built as unknown as { card: never }).card, 'agent_1', deps)
    expect(r.ok).toBe(true)
    const cfg = deps.listServers()[0]!
    expect(cfg.box?.command).toBe('npx')
    expect(cfg.box?.args).toEqual(['--yes', '@donach/mattermost-mcp@2.3.4'])
  })
})
