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

// ---- P7 (fase uso-permessi): i server http MAI CONNESSI si spengono ----
// V4 (fase stato-vivo): PRIMA TESTA — spegne solo chi NON risponde, e scrive
// disabledReason 'never-connected'

import { migrateNeverConnectedHttpServers, repairHttpOffWithFirstOk, runHttpOffFirstOkRepair, migrateHttpNeverConnectedOff, MCP_HTTP_MIGRATION_FLAG, MCP_HTTP_OFF_REPAIR_FLAG, type HttpMigrationsDeps } from '../mcp-migrations'
import { getSetting, setSetting, setDataDir } from '../db'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll } from 'vitest'
import { TEST_TMP_BASE } from '../../../test-tmp'

describe('P7/V4: migrateNeverConnectedHttpServers (puro) — spegne solo chi NON risponde', () => {
  const http = (over: Partial<McpServerConfig>): McpServerConfig => ({
    id: 'x',
    name: 'mattermost.competitoor.com',
    transport: 'http',
    url: 'https://mattermost.competitoor.com/mcp',
    enabled: true,
    auth: { kind: 'oauth' },
    ...over
  })
  it('http ABILITATO mai connesso (nessun firstOkAt) che NON risponde → SPENTO con disabledReason never-connected', () => {
    const { servers, changed } = migrateNeverConnectedHttpServers([http({ id: 'morto' })], new Set(['morto']))
    expect(changed).toBe(true)
    expect(servers[0]!.enabled).toBe(false)
    expect(servers[0]!.disabledReason).toBe('never-connected')
    // il resto resta (si riaccende quando lo si riconfigura)
    expect(servers[0]!.url).toBe('https://mattermost.competitoor.com/mcp')
  })

  it('V4: il server http mai connesso che RISPONDE non si spegne più (la migrazione prima testa)', () => {
    const vivo = http({ id: 'vivo' })
    const { servers, changed } = migrateNeverConnectedHttpServers([vivo], new Set())
    expect(changed).toBe(false)
    expect(servers[0]!.enabled).toBe(true)
  })

  it('con firstOkAt (connesso ALMENO una volta) resta ACCESSO; già spento e needsAuth non si toccano', () => {
    const ok = http({ id: 'ok', firstOkAt: 123 })
    const off = http({ id: 'off', enabled: false })
    const setup = http({ id: 'setup', needsAuth: { kind: 'setup', keys: ['url'] } })
    const { servers, changed } = migrateNeverConnectedHttpServers([ok, off, setup], new Set(['ok', 'off', 'setup']))
    expect(changed).toBe(false)
    expect(servers).toEqual([ok, off, setup])
  })

  it('gli stdio non si toccano (il confine è dei server http)', () => {
    const stdio: McpServerConfig = { id: 'npm', name: 'npm', transport: 'stdio', enabled: true, box: { workdir: '/w', home: '/h', command: 'npx', args: [] } }
    const { servers, changed } = migrateNeverConnectedHttpServers([stdio], new Set(['npm']))
    expect(changed).toBe(false)
    expect(servers[0]!.enabled).toBe(true)
  })

  it('idempotente: al secondo giro non c\'è niente da spegnere', () => {
    const first = migrateNeverConnectedHttpServers([http({ id: 'morto' })], new Set(['morto']))
    const second = migrateNeverConnectedHttpServers(first.servers, new Set(['morto']))
    expect(second.changed).toBe(false)
    expect(second.servers).toEqual(first.servers)
  })
})

// ---- V4 (fase stato-vivo): la riparazione del caso vero ----
// orion-moon (http, header, importato con la beta.15): enabled:false con
// firstOkAt del 21/11 18:46 — la migrazione P7 l'aveva spento al primo avvio
// perché OGNI server http risultava «mai connesso» (firstOkAt nasceva nella
// stessa fase), e un test successivo l'ha visto funzionare senza riaccenderlo.

describe('V4: repairHttpOffWithFirstOk (core puro) — il caso vero di orion-moon', () => {
  const orion = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    id: 'orion',
    name: 'orion-moon',
    transport: 'http',
    url: 'https://orion.example/mcp',
    enabled: false,
    auth: { kind: 'headers' },
    firstOkAt: 1732227960000,
    ...over
  })
  it('spento, firstOkAt, SENZA motivo, e il server RISPONDE → RIACCESSO', () => {
    const { servers, changed, repaired } = repairHttpOffWithFirstOk([orion()], new Set(['orion']))
    expect(changed).toBe(true)
    expect(servers[0]!.enabled).toBe(true)
    expect(repaired).toEqual([{ id: 'orion', name: 'orion-moon' }])
  })

  it('il server NON risponde → resta SPENTO', () => {
    const { servers, changed } = repairHttpOffWithFirstOk([orion()], new Set())
    expect(changed).toBe(false)
    expect(servers[0]!.enabled).toBe(false)
  })

  it("disabledReason 'user' → MAI toccato (l'ha spento l'utente)", () => {
    const user = orion({ id: 'dellutente', disabledReason: 'user' })
    const { servers, changed } = repairHttpOffWithFirstOk([user], new Set(['dellutente']))
    expect(changed).toBe(false)
    expect(servers[0]!.enabled).toBe(false)
  })

  it("disabledReason 'add-failed' (e ogni altro motivo registrato) → non toccato", () => {
    const add = orion({ id: 'add-fallita', disabledReason: 'add-failed' })
    const { changed } = repairHttpOffWithFirstOk([add], new Set(['add-fallita']))
    expect(changed).toBe(false)
  })

  it('un server SPENTO SENZA firstOkAt non è di questa riparazione (P7 lo giudica a modo suo)', () => {
    const { changed } = repairHttpOffWithFirstOk([orion({ id: 'senza-ok', firstOkAt: undefined })], new Set(['senza-ok']))
    expect(changed).toBe(false)
  })
})

describe('V4: i runner (P7 e riparazione) sui settings veri, con testServer finti', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(TEST_TMP_BASE ?? tmpdir(), 'sandbot-v4-migr-test-'))
    setDataDir(root)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const deps = (tests: Record<string, { ok: boolean }>, logs: string[]): HttpMigrationsDeps => ({
    getServers: () => getSetting<McpServerConfig[]>('mcp.servers', []),
    saveServers: (s) => setSetting('mcp.servers', s),
    getFlag: (k) => getSetting<boolean>(k, false),
    setFlag: (k) => setSetting(k, true),
    testServer: async (id) => tests[id] ?? { ok: false },
    log: (m) => logs.push(m)
  })
  const orion: McpServerConfig = {
    id: 'orion', name: 'orion-moon', transport: 'http', url: 'https://orion.example/mcp',
    enabled: false, auth: { kind: 'headers' }, firstOkAt: 1732227960000
  }

  it('la migrazione P7 con il server che RISPONDE NON lo spegne (e scrive il flag)', async () => {
    setSetting(MCP_HTTP_MIGRATION_FLAG, false)
    setSetting('mcp.servers', [{ ...orion, enabled: true, firstOkAt: undefined }])
    const logs: string[] = []
    await migrateHttpNeverConnectedOff(deps({ orion: { ok: true } }, logs))
    const after = getSetting<McpServerConfig[]>('mcp.servers', [])
    expect(after[0]!.enabled).toBe(true)
    expect(getSetting<boolean>(MCP_HTTP_MIGRATION_FLAG, false)).toBe(true)
    // con il flag già scritto non rigira nemmeno
    await migrateHttpNeverConnectedOff(deps({}, logs))
  })

  it('la riparazione del caso vero: il server finto RISPONDE → riacceso, con la riga di log', async () => {
    setSetting(MCP_HTTP_OFF_REPAIR_FLAG, false)
    setSetting('mcp.servers', [orion])
    const logs: string[] = []
    await runHttpOffFirstOkRepair(deps({ orion: { ok: true } }, logs))
    const after = getSetting<McpServerConfig[]>('mcp.servers', [])
    expect(after[0]!.enabled).toBe(true)
    expect(logs.join('\n')).toContain('orion-moon')
    expect(logs.join('\n')).toMatch(/riacceso/i)
    expect(getSetting<boolean>(MCP_HTTP_OFF_REPAIR_FLAG, false)).toBe(true)
  })

  it('la riparazione con il server che NON risponde → resta spento (flag scritto: una tantum)', async () => {
    setSetting(MCP_HTTP_OFF_REPAIR_FLAG, false)
    setSetting('mcp.servers', [orion])
    const logs: string[] = []
    await runHttpOffFirstOkRepair(deps({}, logs))
    expect(getSetting<McpServerConfig[]>('mcp.servers', [])[0]!.enabled).toBe(false)
    expect(logs).toHaveLength(0)
    expect(getSetting<boolean>(MCP_HTTP_OFF_REPAIR_FLAG, false)).toBe(true)
  })

  it("disabledReason 'user' → la riparazione NON lo riaccende (nemmeno se risponde)", async () => {
    setSetting(MCP_HTTP_OFF_REPAIR_FLAG, false)
    setSetting('mcp.servers', [{ ...orion, disabledReason: 'user' }])
    await runHttpOffFirstOkRepair(deps({ orion: { ok: true } }, []))
    expect(getSetting<McpServerConfig[]>('mcp.servers', [])[0]!.enabled).toBe(false)
  })
})
