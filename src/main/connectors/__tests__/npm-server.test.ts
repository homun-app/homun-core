// E4 (fase mcp-env): il bot propone un server MCP npm, l'utente conferma e
// il server gira NEL COMPUTER ISOLATO (box), MAI sul Mac — versione FISSATA
// (se il bot non la dà, il daemon risolve l'ultima stabile UNA volta), card
// con autore, data di pubblicazione, download settimanali, fiducia «non
// verificato», l'host che potrà raggiungere e il modulo delle variabili; si
// installa SOLO al clic. Qui card e installazione con deps finti (nessuna
// rete) e le regole del prompt per il bot.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { join } from 'node:path'
import { buildMcpServerCard, installMcpServer, parseMcpServerId, serverIdFor, type InstallDeps } from '../install'
import type { McpServerConfig } from '../../mcp'
import { connectorsSection } from '../../agent/prompts'
import { toolDefs } from '../../agent/tools'

let DATA: string
beforeAll(() => { DATA = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-npm-server-test-')) })
afterAll(() => { rmSync(DATA, { recursive: true, force: true }) })

const NPM_INFO = {
  name: '@donach/mattermost-mcp', version: '2.3.4', author: 'Donach',
  maintainers: ['donach'], publishedAt: '2026-11-02T10:00:00.000Z', weeklyDownloads: 42017
}

function makeDeps(over: Partial<InstallDeps> = {}): InstallDeps {
  const servers: McpServerConfig[] = []
  return {
    store: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async () => undefined,
      removeAll: async () => undefined
    },
    marketplaces: { findPlugin: async () => null, cloneOf: () => null, list: () => [] },
    findRegistryEntry: async () => null,
    findNpmPackage: async (name: string, version?: string) => ({ ...NPM_INFO, name, version: version ?? NPM_INFO.version }),
    listServers: () => servers,
    saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) },
    toolsOfServer: async () => [{ name: 'send_message' }],
    openExternal: async () => undefined,
    hasUi: () => true,
    dockerMode: () => true,
    npmEgressGuaranteed: () => true,
    dataDir: () => DATA,
    onChange: () => undefined,
    ...over
  }
}

const ENV = [{ name: 'MATTERMOST_URL', secret: false, description: 'Mattermost base URL' }, { name: 'MATTERMOST_TOKEN', secret: true, description: 'Access token' }]

describe('E4: parseMcpServerId conosce npm:', () => {
  it('npm:<pacchetto>[@<versione>]', () => {
    expect(parseMcpServerId('npm:@donach/mattermost-mcp')).toEqual({ kind: 'npm', name: '@donach/mattermost-mcp' })
    expect(parseMcpServerId('npm:@donach/mattermost-mcp@1.2.3')).toEqual({ kind: 'npm', name: '@donach/mattermost-mcp', version: '1.2.3' })
  })
})

describe('E4: la card del server npm (versione FISSATA, metadati dal registro, non verificato)', () => {
  it('senza versione nel pid → il daemon la FISSA all\'ultima stabile (mai latest)', async () => {
    const r = await buildMcpServerCard('npm:@donach/mattermost-mcp', 'per Mattermost', makeDeps(), ENV, ['mattermost.competitoor.com'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card).toMatchObject({
      type: 'mcp-server',
      id: 'npm:@donach/mattermost-mcp@2.3.4',
      technicalName: '@donach/mattermost-mcp',
      publisher: 'Donach',
      trustKind: 'unverified',
      runtime: { kind: 'box-npm', command: 'npx', args: ['--yes', '@donach/mattermost-mcp@2.3.4'] },
      needs: { kind: 'env', vars: ENV.map(({ name, description }) => ({ name, required: true, description })) },
      allowHosts: ['mattermost.competitoor.com'],
      npmMeta: { version: '2.3.4', author: 'Donach', publishedAt: '2026-11-02T10:00:00.000Z', weeklyDownloads: 42017 },
      thirdPartyWarning: true
    })
  })

  it('con la versione nel pid → QUELLA versione', async () => {
    const r = await buildMcpServerCard('npm:@donach/mattermost-mcp@1.0.0', '', makeDeps(), [], [])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.card.runtime).toEqual({ kind: 'box-npm', command: 'npx', args: ['--yes', '@donach/mattermost-mcp@1.0.0'] })
  })

  it('pacchetto introvabile → NESSUNA card, l\'errore torna al modello', async () => {
    const r = await buildMcpServerCard('npm:pacchetto-che-non-esiste', '', makeDeps({
      findNpmPackage: async () => { throw new Error('npm registry: package not found') }
    }), [], [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/npm registry/)
  })
})

describe('E4: installMcpServer per npm: — NEL BOX, egress con allowlist, MAI sul Mac', () => {
  const card = async () => {
    const r = await buildMcpServerCard('npm:@donach/mattermost-mcp', 'per Mattermost', makeDeps(), ENV, ['mattermost.competitoor.com'])
    return (r as { card: import('../../../shared/types').SendMessagePayload & { allowHosts?: string[] } }).card
  }

  it('il click crea il server: box npx@versione-fissata, envKeys, egress.allowHosts, source npm', async () => {
    const deps = makeDeps()
    const r = await installMcpServer((await card()) as never, 'agent_1', deps)
    expect(r.ok).toBe(true)
    const cfg = deps.listServers()[0]!
    expect(cfg.transport).toBe('stdio')
    expect(cfg.box).toMatchObject({ command: 'npx', args: ['--yes', '@donach/mattermost-mcp@2.3.4'], envKeys: ['MATTERMOST_URL', 'MATTERMOST_TOKEN'] })
    expect(cfg.egress).toEqual({ allowHosts: ['mattermost.competitoor.com'] })
    expect(cfg.source).toMatchObject({ kind: 'npm', package: '@donach/mattermost-mcp', version: '2.3.4' })
    expect(cfg.trustKind).toBe('unverified')
    expect(cfg.enabledFor).toEqual(['agent_1'])
  })

  it('in modalità host (niente box) l\'installazione RIFIUTA: niente ripiego sul Mac', async () => {
    const r = await installMcpServer((await card()) as never, 'agent_1', makeDeps({ dockerMode: () => false }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/bots' computer/)
  })

  it('un AGGIORNAMENTO DI VERSIONE è un server DIVERSO (nuova card, nuova conferma)', () => {
    const v1 = serverIdFor({ kind: 'npm', name: '@donach/mattermost-mcp', version: '2.3.4' })
    const v2 = serverIdFor({ kind: 'npm', name: '@donach/mattermost-mcp', version: '2.4.0' })
    expect(v1).not.toBe(v2)
  })
})

describe('E4: il tool del bot e le regole del prompt', () => {
  it('add_mcp_server accetta npm:<pacchetto>@<versione> con env e allowHosts', () => {
    const d = toolDefs.find((t) => t.name === 'add_mcp_server')!
    expect(JSON.stringify(d.parameters)).toContain('npm:')
    expect(JSON.stringify(d.parameters)).toContain('allowHosts')
    expect(JSON.stringify(d.parameters)).toContain('env')
    expect(d.description).toMatch(/npm:/)
  })

  it('il prompt: registro MCP PRIMA, poi il pacchetto npm noto con VERSIONE, mai installazioni da run-command', () => {
    const s = connectorsSection()
    expect(s).toMatch(/npm:/)
    expect(s).toMatch(/version/)
  })

  it('la strada dell\'IMPORT resta la prima, se l\'utente usa Cursor/Claude/Zcode (P7: PRIMA dell\'npm, nel testo della regola)', () => {
    const s = connectorsSection()
    expect(s.indexOf('Cursor, Claude or ZCode')).toBeGreaterThanOrEqual(0)
    expect(s).toMatch(/run-command/)
    // P7 (fase uso-permessi): l'ordine della regola è import PRIMA, npm POI
    const rule = s.split('\n').find((l) => l.includes('FIRST offer the import from Cursor')) ?? ''
    expect(rule).not.toBe('')
    expect(rule.indexOf('Cursor')).toBeLessThan(rule.indexOf('npm:'))
  })
})
