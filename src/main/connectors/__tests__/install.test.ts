// Test delle CARD e dell'INSTALLAZIONE (fase 13, punti 2, 4 e 7): il bot
// propone (card in codice), l'installazione parte SOLO dalla funzione del
// click. Tutto con deps INIETTABILI: registro dalla fixture REALE, marketplace
// con repo git locale (file:// solo col flag di test), toolsOfServer finto.
// Nessun Docker, nessuna rete.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SendMessagePayload } from '../../../shared/types'
import fixture from './fixtures/registry-notion.json'
import { parseRegistryResponse } from '../registry'
import type { RegistryEntry } from '../registry'
import {
  buildMcpServerCard, installMcpServer, buildPluginCard, installPlugin, uninstallPlugin,
  addGateway, installedPlugins, pluginBoxDir, serverInstalledMessage, parseMcpServerId,
  serverIdFor, serverSlotError, resolvePluginServerPlaceholders, unresolvedUserConfigKeys,
  reconnectServer, discardPluginProposal, PENDING_PLUGIN_TTL_MS, SECRET_KIND,
  GATEWAY_PRESETS, GATEWAY_WARNING_UI, PROPOSAL_RESULT, HOST_MODE_DISABLED, HOST_MODE_DISABLED_REASON,
  type InstallDeps, type InstalledPlugin
} from '../install'
import type { McpServerConfig } from '../../mcp'
import type { ConnectorsSecretStore } from '../sealed-store'

// uno store cifrato FINTO in memoria
const fakeStore = (saved: Map<string, Map<string, unknown>>): ConnectorsSecretStore => ({
  read: async <T>(id: string, key: string) => (saved.get(id)?.get(key) as T | undefined) ?? undefined,
  write: async (id: string, key: string, value: unknown) => {
    if (!saved.has(id)) saved.set(id, new Map())
    saved.get(id)!.set(key, value)
  },
  remove: async (id: string, keys: string[]) => {
    for (const k of keys) saved.get(id)?.delete(k)
  },
  removeAll: async (id: string) => { saved.delete(id) }
})

const REGISTRY: RegistryEntry[] = parseRegistryResponse(fixture)

function makeDeps(over: Partial<InstallDeps> = {}): InstallDeps {
  const saved = new Map<string, Map<string, unknown>>()
  const servers: McpServerConfig[] = []
  const settings = new Map<string, unknown>()
  return {
    store: fakeStore(saved),
    marketplaces: {
      findPlugin: async (id: string) => null,
      cloneOf: () => null,
      list: () => []
    },
    findRegistryEntry: async (name: string) => REGISTRY.find((e) => e.server.name === name) ?? null,
    listServers: () => servers,
    saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) },
    toolsOfServer: async () => [],
    openExternal: async () => undefined,
    hasUi: () => true,
    dockerMode: () => true,
    dataDir: () => DATA,
    onChange: () => undefined,
    ...over
  }
}

let DATA: string
beforeAll(() => {
  DATA = mkdtempSync(join(tmpdir(), 'sandbot-install-test-'))
})
afterAll(() => {
  rmSync(DATA, { recursive: true, force: true })
})

// ---- parseMcpServerId / testi fissi ----

describe('parseMcpServerId e i testi fissi delle card', () => {
  it('registry:<nome> e url:https://…; l\'url deve essere https', () => {
    expect(parseMcpServerId('registry:com.notion/mcp')).toEqual({ kind: 'registry', name: 'com.notion/mcp' })
    expect(parseMcpServerId('url:https://mcp.example.com/mcp')).toEqual({ kind: 'url', url: 'https://mcp.example.com/mcp' })
    expect(parseMcpServerId('url:http://mcp.example.com')).toMatchObject({ error: expect.any(String) })
    expect(parseMcpServerId('notion')).toMatchObject({ error: expect.any(String) })
  })
  it('i testi della specifica: proposta, host, gateway, avviso terzi (id del catalogo UI, fase 17c)', () => {
    expect(PROPOSAL_RESULT).toContain('proposal shown to the user')
    // fase 17c (C3): l'avviso terzi vive nel catalogo UI (install.thirdParty);
    // il gateway è l'id install.gatewayWarning
    expect(HOST_MODE_DISABLED).toBe('it installs only in the bots\' computer (docker mode)')
    expect(HOST_MODE_DISABLED_REASON).toBe('host-mode')
    expect(GATEWAY_WARNING_UI.id).toBe('install.gatewayWarning')
  })
})

// ---- buildMcpServerCard (punto 2) ----

describe('buildMcpServerCard (pura a deps iniettati)', () => {
  it('remoto senza header: card remoto OAuth con host, fiducia dominio verificato, NESSUN avviso terzi, NOME COMPLETO (L2)', async () => {
    const r = await buildMcpServerCard('registry:com.notion/mcp', 'per leggere le pagine', makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.name).toBe('com.notion/mcp')
    expect(r.card.trust).toBe('verified domain (notion.com)')
    expect(r.card.runtime).toEqual({ kind: 'remote', host: 'mcp.notion.com' })
    expect(r.card.needs).toEqual({ kind: 'oauth' })
    expect(r.card.thirdPartyWarning).toBeUndefined()
    expect(r.card.reason).toBe('per leggere le pagine')
  })

  it('remoto con header isSecret: card "serve una chiave" (ai.smithery è dominio verificato: nessun avviso terzi)', async () => {
    const r = await buildMcpServerCard('registry:ai.smithery/smithery-notion', '', makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.needs).toEqual({ kind: 'key', header: 'Authorization' })
    expect(r.card.trust).toBe('verified domain (smithery.ai)')
    expect(r.card.thirdPartyWarning).toBeUndefined()
  })

  it('account GitHub e non verificati: AVVISO terzi in card', async () => {
    const gh = makeDeps({ findRegistryEntry: async () => ({ server: { name: 'io.github.pincopallino/mcp', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } }) })
    const r1 = await buildMcpServerCard('registry:io.github.pincopallino/mcp', '', gh)
    expect(r1.ok && r1.card.thirdPartyWarning).toBe(true)
    const nv = makeDeps({ findRegistryEntry: async () => ({ server: { name: 'nudo/mcp', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } }) })
    const r2 = await buildMcpServerCard('registry:nudo/mcp', '', nv)
    expect(r2.ok && r2.card.trust).toBe('unverified')
    expect(r2.ok && r2.card.thirdPartyWarning).toBe(true)
  })

  it('npm stdio: card col comando npx -y <identifier>@<version> FISSATO e le env var richieste', async () => {
    const r = await buildMcpServerCard('registry:com.foreverworks/notion', '', makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.runtime).toEqual({ kind: 'box-npm', command: 'npx -y @foreverworks/mcp-notion@0.1.0' })
    expect(r.card.needs).toEqual({ kind: 'env', vars: [{ name: 'NOTION_TOKENS_DIR', required: true, description: 'A folder holding one file per workspace…' }] })
  })

  it('npm stdio in modalità HOST: bottone disattivato col testo della specifica', async () => {
    const r = await buildMcpServerCard('registry:com.foreverworks/notion', '', makeDeps({ dockerMode: () => false }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.disabledReason).toBe(HOST_MODE_DISABLED_REASON)
  })

  it('pypi/oci: NESSUNA card, il tool risponde "non installabile qui: tipo <registryType>"', async () => {
    const deps = makeDeps({
      findRegistryEntry: async () => ({ server: { name: 'x/y', packages: [{ registryType: 'pypi', identifier: 'y', transport: { type: 'stdio' } }] } })
    })
    const r = await buildMcpServerCard('registry:x/y', '', deps)
    expect(r).toEqual({ ok: false, error: 'not installable here: type pypi' })
  })

  it('url:https://… proposto dall\'utente in chat: card non verificata, remoto OAuth', async () => {
    const r = await buildMcpServerCard('url:https://mcp.example.com/mcp', 'il server che hai citato', makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.trust).toBe('unverified')
    expect(r.card.thirdPartyWarning).toBe(true)
    expect(r.card.runtime).toEqual({ kind: 'remote', host: 'mcp.example.com' })
  })

  it('voce inesistente: errore, nessuna card', async () => {
    const r = await buildMcpServerCard('registry:non/esiste', '', makeDeps())
    expect(r.ok).toBe(false)
  })
})

// ---- installMcpServer (le regole 1-3 del punto 2) ----

describe('installMcpServer (regole 1-3)', () => {
  it('regola 1: remoto senza header si connette; esito "Server X aggiunto: N strumenti (lettura: a, scrittura: b)"', async () => {
    const deps = makeDeps({
      toolsOfServer: async () => [
        { name: 't1', annotations: { readOnlyHint: true } },
        { name: 't2', annotations: { readOnlyHint: true } },
        { name: 't3' }
      ]
    })
    const card = (await buildMcpServerCard('registry:com.notion/mcp', '', deps))
    expect(card.ok).toBe(true)
    if (!card.ok) return
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message).toBe('Server com.notion/mcp added: 3 tools (read: 2, write: 1)')
    // il server è registrato col source registry e abilitato SOLO per chi l'ha proposto
    const cfg = deps.listServers()[0]!
    expect(cfg.id).toBe(serverIdFor({ kind: 'registry', name: 'com.notion/mcp' }))
    expect(cfg.name).toBe('com.notion/mcp') // L2: nome COMPLETO, non l'ultimo segmento
    expect(cfg.source).toEqual({ kind: 'registry', name: 'com.notion/mcp', version: '1.0.1' })
    expect(cfg.enabledFor).toEqual(['agent_alice'])
    expect(cfg.catalogId).toBeUndefined() // niente auto-consenso readOnlyHint (governance punto 2)
  })

  it('regola 1 (401): senza UI l\'OAuth non parte, l\'esito lo dice', async () => {
    const deps = makeDeps({ toolsOfServer: async () => { throw new Error('401 Unauthorized') }, hasUi: () => false })
    const card = await buildMcpServerCard('registry:com.notion/mcp', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('OAuth')
  })

  it('regola 2: remoto con header isSecret → stato needs_auth e "serve la chiave: l\'utente la inserisce nelle Impostazioni"', async () => {
    const deps = makeDeps({ toolsOfServer: async () => { throw new Error('401') } })
    const card = await buildMcpServerCard('registry:ai.smithery/smithery-notion', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.message).toContain('the key is needed')
    expect(deps.listServers()[0]!.needsAuth).toEqual({ kind: 'key', keys: ['Authorization'] })
  })

  it('regola 3: npm stdio si registra nel BOX (docker exec); le env obbligatorie mancanti → needs_auth env', async () => {
    const deps = makeDeps({ toolsOfServer: async () => [{ name: 'search' }] })
    const card = await buildMcpServerCard('registry:com.foreverworks/notion', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.message).toContain('NOTION_TOKENS_DIR')
    const cfg = deps.listServers()[0]!
    expect(cfg.transport).toBe('stdio')
    expect(cfg.box).toEqual({
      workdir: '/box/home/agent_alice',
      home: '/box/home/agent_alice',
      command: 'npx',
      args: ['-y', '@foreverworks/mcp-notion@0.1.0'],
      envKeys: ['NOTION_TOKENS_DIR']
    })
    expect(cfg.needsAuth).toEqual({ kind: 'env', keys: ['NOTION_TOKENS_DIR'] })
  })

  it('regola 3 con env compilata: il server parte e l\'esito conta gli strumenti', async () => {
    const deps = makeDeps({ toolsOfServer: async () => [{ name: 'a', annotations: { readOnlyHint: true } }] })
    // il valore della env è già nello store cifrato (modulo Impostazioni),
    // sotto l'id NUOVO del server e col kind 'env' di SECRET_KIND
    const id = serverIdFor({ kind: 'registry', name: 'com.foreverworks/notion' })
    await deps.store.write(id, 'env', { NOTION_TOKENS_DIR: '/box/home/agent_alice/tokens' })
    const card = await buildMcpServerCard('registry:com.foreverworks/notion', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r).toEqual({ ok: true, message: 'Server com.foreverworks/notion added: 1 tools (read: 1, write: 0)' })
    expect(deps.listServers()[0]!.needsAuth).toBeUndefined()
  })

  it('regola 3 in modalità host: rifiuto col testo della specifica', async () => {
    const deps = makeDeps({ dockerMode: () => false })
    const card = await buildMcpServerCard('registry:com.foreverworks/notion', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r).toEqual({ ok: false, error: HOST_MODE_DISABLED })
  })

  it('serverInstalledMessage conta lettura/scrittura dalle annotazioni', () => {
    expect(serverInstalledMessage('x', [{ annotations: { readOnlyHint: true } }, {}, {}])).toBe('Server x added: 3 tools (read: 1, write: 2)')
  })
})

// ---- plugin: card + installazione + disinstallazione (punto 4) ----

describe('plugin: card, installazione, disinstallazione', () => {
  let REPO: string
  let sha: string
  let settings: Map<string, unknown>
  let deps: InstallDeps
  let STG: string

  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), 'sandbot-plugin-repo-'))
    const run = (cmd: string): string => execSync(cmd, { cwd: REPO }).toString()
    mkdirSync(join(REPO, 'skills', 'helper'), { recursive: true })
    writeFileSync(join(REPO, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: una skill di aiuto\n---\nIstruzioni della skill.')
    mkdirSync(join(REPO, 'hooks'), { recursive: true })
    // l'hook di fixture SCRIVEREBBE un file sentinella: non deve mai girare
    writeFileSync(join(REPO, 'hooks', 'hook.sh'), '#!/bin/sh\necho pwned > /tmp/sandbot-plugin-hook-sentinel\n')
    mkdirSync(join(REPO, '.claude-plugin'), { recursive: true })
    writeFileSync(join(REPO, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo-plugin',
      mcpServers: { demo: { url: 'https://mcp.demo.example/mcp', headers: { Authorization: 'Bearer ${user_config.TOKEN}' } } },
      userConfig: { TOKEN: { description: 'chiave', sensitive: true } }
    }))
    run('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init')
    sha = run('git rev-parse HEAD').trim()
  })
  afterAll(() => {
    rmSync(REPO, { recursive: true, force: true })
  })
  beforeEach(() => {
    settings = new Map()
    STG = mkdtempSync(join(tmpdir(), 'sandbot-install-stg-'))
    const saved = new Map<string, Map<string, unknown>>()
    const servers: McpServerConfig[] = []
    deps = {
      store: fakeStore(saved),
      marketplaces: {
        findPlugin: async (id) => id === 'plugin:demo-plugin@mp-di-test'
          ? { reg: { name: 'mp-di-test', source: REPO, kind: 'git' as const, official: false, addedAt: 1 }, plugin: { name: 'demo-plugin', source: { kind: 'url' as const, url: `file://${REPO}`, sha } } }
          : null,
        cloneOf: () => null,
        list: () => [{ name: 'mp-di-test', source: REPO, kind: 'git' as const, official: false, addedAt: 1 }]
      },
      findRegistryEntry: async () => null,
      listServers: () => servers,
      saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) },
      toolsOfServer: async () => [],
      openExternal: async () => undefined,
      hasUi: () => true,
      dockerMode: () => false, // test senza docker: la copia nel box si salta
      dataDir: () => DATA,
      onChange: () => undefined
    }
  })
  afterEach(() => {
    // L7: le cartelle di staging dei test vivono QUI, non in $TMPDIR
    rmSync(STG, { recursive: true, force: true })
  })
  // lo staging dei test: mkdtemp iniettato dentro la cartella dedicata
  const cloneDeps = (STGdir: string): { allowFileUrlsForTests: boolean; mkdtemp: (prefix: string) => string } => ({
    allowFileUrlsForTests: true,
    mkdtemp: (prefix) => {
      const d = join(STGdir, prefix + Math.random().toString(36).slice(2, 8))
      mkdirSync(d, { recursive: true })
      return d
    }
  })

  it('sorgente npm/archive/command: NESSUNA card, "sorgente <tipo> non supportata"', async () => {
    const d = { ...deps, marketplaces: { ...deps.marketplaces, findPlugin: async () => ({ reg: { name: 'm', source: 'x', kind: 'git' as const, official: false, addedAt: 1 }, plugin: { name: 'p', source: { kind: 'command' as const, command: 'evil' } } }) } }
    const r = await buildPluginCard('plugin:p@m', '', d)
    expect(r).toEqual({ ok: false, error: 'source command not supported' })
  })

  it('la card elenca skill, server, impostazioni, lo sha12 e l\'hook fra i NON importati', async () => {
    const r = await buildPluginCard('plugin:demo-plugin@mp-di-test', 'per le sue skill', deps, cloneDeps(STG))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.name).toBe('demo-plugin')
    expect(r.card.marketplace).toBe('mp-di-test')
    expect(r.card.sha12).toBe(sha.slice(0, 12))
    expect(r.card.skills).toEqual(['demo-plugin--helper'])
    expect(r.card.servers).toEqual([{ name: 'demo', runtimeKind: 'remote', runtimeDetail: 'mcp.demo.example' }])
    expect(r.card.settings).toEqual([{ key: 'TOKEN', description: 'chiave', sensitive: true }])
    expect(r.card.ignored).toContain('hooks')
  })

  it('installazione: cartella in <dataDir>/plugins, server http con pluginSpec (template NON sostituiti), record nel registro', async () => {
    const card = await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps, cloneDeps(STG))
    if (!card.ok) throw new Error('card')
    const r = await installPlugin(card.card, 'agent_alice', deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f, cloneDeps(STG))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message).toContain('Plugin demo-plugin installed: 1 skill, 1 server')
    const dir = join(DATA, 'plugins', 'mp-di-test', 'demo-plugin', sha.slice(0, 12))
    expect(existsSync(join(dir, 'skills', 'helper', 'SKILL.md'))).toBe(true)
    // il server MCP del plugin: id con hash (L2), template CONSERVATI (L1),
    // needsAuth finché la chiave non c'è
    const cfg = deps.listServers().find((s) => s.source?.kind === 'plugin')
    const expectedId = serverIdFor({ kind: 'plugin', marketplace: 'mp-di-test', plugin: 'demo-plugin', server: 'demo' })
    expect(cfg?.id).toBe(expectedId)
    expect(cfg?.url).toBe('https://mcp.demo.example/mcp')
    expect(cfg?.pluginSpec).toEqual({ url: 'https://mcp.demo.example/mcp', headers: { Authorization: 'Bearer ${user_config.TOKEN}' } })
    expect(cfg?.needsAuth).toEqual({ kind: 'settings', keys: ['TOKEN'] })
    expect(cfg?.enabledFor).toEqual(['agent_alice'])
    const rec = installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })[0]!
    expect(rec.name).toBe('demo-plugin')
    expect(rec.skills[0]?.name).toBe('demo-plugin--helper')
    expect(rec.servers).toEqual([expectedId])
    expect(pluginBoxDir(rec.marketplace, rec.name, rec.sha12)).toBe(`/plugins/mp-di-test/demo-plugin/${sha.slice(0, 12)}`)
    // il FILE SENTINELLA dell'hook non esiste: il codice di terzi non è MAI girato
    expect(existsSync('/tmp/sandbot-plugin-hook-sentinel')).toBe(false)
  })

  it('disinstallazione: cartella, server, record e SEGRETI di ogni server (L2); i dati utente non si toccano', async () => {
    const card = await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps, cloneDeps(STG))
    if (!card.ok) throw new Error('card')
    await installPlugin(card.card, 'agent_alice', deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f, cloneDeps(STG))
    const rec = installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })[0] as InstalledPlugin
    // l'utente ha salvato la chiave del server del plugin nello store cifrato
    await deps.store.write(rec.servers[0]!, 'userConfig', { TOKEN: 'segreto-finto' })
    expect(deps.listServers().length).toBe(1)
    await uninstallPlugin(rec, deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f)
    expect(existsSync(join(DATA, 'plugins', 'mp-di-test', 'demo-plugin', sha.slice(0, 12)))).toBe(false)
    expect(deps.listServers().length).toBe(0)
    expect(installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })).toEqual([])
    // L2: lo store del server del plugin è VUOTO (prima removeAll('plugin-<nome>')
    // non era l'id di nessun server e la chiave restava)
    expect(await deps.store.read(rec.servers[0]!, 'userConfig')).toBeUndefined()
  })

  it('L6: sha12 della card diverso dallo staging → NESSUNA installazione, staging cancellato', async () => {
    const card = await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps, cloneDeps(STG))
    if (!card.ok) throw new Error('card')
    // la card mostra uno sha12 DIVERSO (proposta costruita prima di un push nel repo)
    const r = await installPlugin({ ...card.card, sha12: '000000000000' }, 'agent_alice', deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f, cloneDeps(STG))
    expect(r).toEqual({
      ok: false,
      error: 'the plugin changed after the proposal (was 000000000000, now ' + card.card.sha12 + '): ask for a new proposal'
    })
    expect(deps.listServers().length).toBe(0)
    expect(installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })).toEqual([])
  })

  it('L6 (percorso ricostruito): senza proposta pendente il ri-download porta uno sha diverso → NESSUNA installazione', async () => {
    // proposta mai fatta in QUESTO processo (daemon riavviato): si costruisce
    // la card "vecchia" a mano con uno sha12 che non è quello del repo
    const staleCard = { type: 'plugin', id: 'plugin:demo-plugin@mp-di-test', name: 'demo-plugin', marketplace: 'mp-di-test', trust: 'marketplace aggiunto da te', sha12: '999999999999', skills: [], servers: [], settings: [], ignored: [] } as unknown as Extract<SendMessagePayload, { type: 'plugin' }>
    const r = await installPlugin(staleCard, 'agent_alice', deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f, cloneDeps(STG))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('the plugin changed after the proposal')
    expect(deps.listServers().length).toBe(0)
    expect(installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })).toEqual([])
  })

  it('L7: il "No" cancella lo staging della proposta', async () => {
    const card = await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps, cloneDeps(STG))
    if (!card.ok) throw new Error('card')
    const stagedRoot = join(STG, 'sandbot-plugin-')
    // la proposta tiene uno staging vivo da qualche parte nella cartella dedicata
    const before = readdirSync(STG).filter((d) => d.startsWith('sandbot-plugin-'))
    expect(before.length).toBeGreaterThan(0)
    discardPluginProposal('plugin:demo-plugin@mp-di-test')
    const after = readdirSync(STG).filter((d) => d.startsWith('sandbot-plugin-'))
    expect(after).toEqual([])
    expect(existsSync(stagedRoot)).toBe(false)
    // e il plugin NON risulta installato
    expect(installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })).toEqual([])
  })

  it('L7: le proposte più vecchie di 30 minuti si cancellano alla card successiva', async () => {
    let now = 1_000_000
    const deps2 = { ...deps, now: () => now }
    await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps2, cloneDeps(STG))
    expect(readdirSync(STG).filter((d) => d.startsWith('sandbot-plugin-')).length).toBe(1)
    // passano più di 30 minuti: la proposta vecchia si cancella
    now += PENDING_PLUGIN_TTL_MS + 1
    await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps2, cloneDeps(STG))
    // resta solo lo staging della proposta NUOVA
    expect(readdirSync(STG).filter((d) => d.startsWith('sandbot-plugin-')).length).toBe(1)
  })
})

// ---- gateway (punto 7) ----

describe('gateway (punto 7)', () => {
  it('i preset sono DATI: Composio x-api-key, Zapier URL, Pipedream Bearer; aiuto senza chiamate API', () => {
    const ids = GATEWAY_PRESETS.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['composio', 'zapier', 'pipedream']))
    const composio = GATEWAY_PRESETS.find((p) => p.id === 'composio')!
    expect(composio.headerName).toBe('x-api-key')
    expect(composio.help).toContain('sessione Tool Router')
  })

  it('addGateway: https obbligatorio, token CIFRATO nello store, source gateway, abilitato a tutti', async () => {
    const deps = makeDeps()
    const cfg = await addGateway({ name: 'Composio', url: 'https://mcp.composio.example/mcp', auth: 'headers', preset: 'composio', headers: { 'x-api-key': 'chiave-finta' } }, deps)
    expect(cfg.source).toEqual({ kind: 'gateway', preset: 'composio' })
    expect(cfg.enabledFor).toEqual(['*'])
    expect(cfg.trustLabel).toBeUndefined()
    expect(await deps.store.read(cfg.id, 'staticHeaders')).toEqual({ 'x-api-key': 'chiave-finta' })
    await expect(addGateway({ name: 'x', url: 'http://nothttps.example', auth: 'bearer' }, deps)).rejects.toThrow('https')
  })
})

// ---- L2: id unici e deterministici (le voci VERE del registro) ----

/** Le due voci vere citate dalla correzione L2: entrambe finiscono in /mcp con lo stesso header segreto. */
const AETHERYA = { server: { name: 'ai.aetherya/mcp', remotes: [{ type: 'streamable-http', url: 'https://mcp.aetherya.ai/mcp', headers: [{ name: 'Authorization', isSecret: true, isRequired: true }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }
const AI_ADVISORS = { server: { name: 'ai.ai-advisors/mcp', remotes: [{ type: 'streamable-http', url: 'https://app.ai-advisors.ai/api/mcp', headers: [{ name: 'Authorization', isSecret: true, isRequired: true }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }

describe('L2: serverIdFor e le collisioni', () => {
  it('id = prefisso + nome sanificato (max 40) + 8 hex di sha256 della chiave esatta', () => {
    const id = serverIdFor({ kind: 'registry', name: 'com.notion/mcp' })
    expect(id).toMatch(/^registry-com-notion-mcp-[0-9a-f]{8}$/)
    // chiave esatta diversa → id diverso, anche col nome che finisce uguale
    expect(serverIdFor({ kind: 'registry', name: 'ai.aetherya/mcp' })).not.toBe(serverIdFor({ kind: 'registry', name: 'ai.ai-advisors/mcp' }))
    // due URL sullo stesso host non collidono
    expect(serverIdFor({ kind: 'url', url: 'https://x.example/a' })).not.toBe(serverIdFor({ kind: 'url', url: 'https://x.example/b' }))
    // lo stesso plugin in due marketplace non collide
    expect(serverIdFor({ kind: 'plugin', marketplace: 'mp1', plugin: 'demo', server: 's' })).not.toBe(serverIdFor({ kind: 'plugin', marketplace: 'mp2', plugin: 'demo', server: 's' }))
    // il nome lungo si tronca a 40 caratteri (prima dell'hash)
    const lungo = serverIdFor({ kind: 'registry', name: 'com.questsrestudio/' + 'x'.repeat(80) })
    expect(lungo.split('-').slice(0, -1).join('-').length).toBeLessThanOrEqual('registry-'.length + 41)
  })

  it('le due voci VERE coesistono: il secondo resta in needsAuth anche se il primo ha la chiave', async () => {
    const entries = parseRegistryResponse({ servers: [AETHERYA, AI_ADVISORS] })
    const deps = makeDeps({
      findRegistryEntry: async (name) => entries.find((e) => e.server.name === name) ?? null,
      toolsOfServer: async () => { throw new Error('401') }
    })
    // 1. si installa ai.aetherya/mcp e l'utente salva la chiave
    const card1 = await buildMcpServerCard('registry:ai.aetherya/mcp', '', deps)
    if (!card1.ok) throw new Error('card1')
    const r1 = await installMcpServer(card1.card, 'agent_alice', deps)
    expect(r1.ok).toBe(true)
    const cfg1 = deps.listServers()[0]!
    await deps.store.write(cfg1.id, 'staticHeaders', { Authorization: 'CHIAVE-DI-A' })
    // 2. si installa ai.ai-advisors/mcp: PRIMA si sostituiva il primo server
    //    (stesso id registry-mcp) e il secondo riusava la chiave di A
    const card2 = await buildMcpServerCard('registry:ai.ai-advisors/mcp', '', deps)
    if (!card2.ok) throw new Error('card2')
    const r2 = await installMcpServer(card2.card, 'agent_alice', deps)
    expect(r2.ok).toBe(true)
    // ENTRAMBI i server presenti, con id DIVERSI
    const ids = deps.listServers().map((s) => s.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    const cfg2 = deps.listServers().find((s) => s.source?.kind === 'registry' && s.source.name === 'ai.ai-advisors/mcp')!
    // il SECONDO chiede la SUA chiave (nessuna eredità dal primo)
    expect(cfg2.needsAuth).toEqual({ kind: 'key', keys: ['Authorization'] })
    expect(await deps.store.read(cfg2.id, 'staticHeaders')).toBeUndefined()
    expect(cfg2.url).toBe('https://app.ai-advisors.ai/api/mcp')
  })

  it('mai sostituire in silenzio: stesso id da fonte DIVERSA è un errore (cintura di sicurezza)', () => {
    const registryCfg = { id: 'x', name: 'x', transport: 'http' as const, url: 'u', enabled: true, source: { kind: 'registry' as const, name: 'n' } }
    const gatewayCfg = { id: 'x', name: 'x', transport: 'http' as const, url: 'u', enabled: true, source: { kind: 'gateway' as const } }
    expect(serverSlotError([registryCfg], gatewayCfg)).toContain('a server with this id already exists')
    // stessa fonte: è un aggiornamento, nessun errore
    expect(serverSlotError([registryCfg], { ...registryCfg, url: 'nuova' })).toBeNull()
    expect(serverSlotError([], registryCfg)).toBeNull()
  })

  it('serverSlotError blocca l\'installazione del registry quando l\'id esiste già da un\'altra fonte', async () => {
    const entries = parseRegistryResponse({ servers: [AETHERYA] })
    const deps = makeDeps({ findRegistryEntry: async () => entries[0] ?? null })
    // un gateway occupa GIÀ l'id che il registro genererebbe (forzato a mano)
    const taken = serverIdFor({ kind: 'registry', name: 'ai.aetherya/mcp' })
    deps.saveServers([{ id: taken, name: 'gw', transport: 'http', url: 'https://g.example', enabled: true, source: { kind: 'gateway' } }])
    const card = await buildMcpServerCard('registry:ai.aetherya/mcp', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('a server with this id already exists')
    // il gateway è INTATTO
    expect(deps.listServers()).toHaveLength(1)
    expect(deps.listServers()[0]!.source?.kind).toBe('gateway')
  })
})

// ---- L5: la copia del plugin nel box (runner docker finto) ----

describe('L5: copia del plugin nel box — sequenza, esiti, ripristino', () => {
  let REPO: string
  let sha: string
  let settings: Map<string, unknown>
  let STG: string

  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), 'sandbot-plugin-repo-'))
    const run = (cmd: string): string => execSync(cmd, { cwd: REPO }).toString()
    // plugin con UN SERVER STDIO + una skill
    mkdirSync(join(REPO, 'skills', 'helper'), { recursive: true })
    writeFileSync(join(REPO, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: una skill\n---\nCorpo.')
    mkdirSync(join(REPO, '.claude-plugin'), { recursive: true })
    writeFileSync(join(REPO, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'box-plugin',
      mcpServers: { runner: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/run.js'], env: { API_KEY: '${user_config.API_KEY}', LIT: 'fisso' } } },
      userConfig: { API_KEY: { sensitive: true } }
    }))
    run('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init')
    sha = run('git rev-parse HEAD').trim()
  })
  afterAll(() => rmSync(REPO, { recursive: true, force: true }))
  beforeEach(() => {
    settings = new Map()
    STG = mkdtempSync(join(tmpdir(), 'sandbot-install-stg-'))
  })
  afterEach(() => rmSync(STG, { recursive: true, force: true }))
  const cloneDeps = (): { allowFileUrlsForTests: boolean; mkdtemp: (prefix: string) => string } => ({
    allowFileUrlsForTests: true,
    mkdtemp: (prefix) => {
      const d = join(STG, prefix + Math.random().toString(36).slice(2, 8))
      mkdirSync(d, { recursive: true })
      return d
    }
  })
  const makeDockerDeps = (runDocker: InstallDeps['runDocker']): InstallDeps => {
    const saved = new Map<string, Map<string, unknown>>()
    const servers: McpServerConfig[] = []
    return {
      store: fakeStore(saved),
      marketplaces: {
        findPlugin: async (id) => id === 'plugin:box-plugin@mp-box'
          ? { reg: { name: 'mp-box', source: REPO, kind: 'git' as const, official: false, addedAt: 1 }, plugin: { name: 'box-plugin', source: { kind: 'url' as const, url: `file://${REPO}`, sha } } }
          : null,
        cloneOf: () => null,
        list: () => []
      },
      findRegistryEntry: async () => null,
      listServers: () => servers,
      saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) },
      toolsOfServer: async () => [],
      openExternal: async () => undefined,
      hasUi: () => true,
      dockerMode: () => true,
      dataDir: () => DATA,
      runDocker,
      onChange: () => undefined
    }
  }
  const set = (k: string, v: unknown) => settings.set(k, v)
  const get = <T,>(k: string, f: T): T => (settings.get(k) as T | undefined) ?? f

  it('M4: sequenza volume-create → create dell\'usa-e-getta → mkdir del padre → cp → chown → chmod → rm dell\'usa-e-getta, OGNI passo controllato', async () => {
    const calls: string[][] = []
    const deps = makeDockerDeps(async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: '', stderr: '' }
    })
    const card = await buildPluginCard('plugin:box-plugin@mp-box', '', deps, cloneDeps())
    if (!card.ok) throw new Error('card')
    const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
    expect(r.ok).toBe(true)
    const { boxImage } = await import('../../sandbox')
    const img = boxImage()
    const sha12 = sha.slice(0, 12)
    // M4: il volume dedicato si crea PRIMA del create che lo monta
    expect(calls[0]).toEqual(['volume', 'create', 'sandbot-plugins'])
    // l'usa-e-getta della copia: volume montato rw in /p (solo qui e nei one-shot)
    const createHelper = calls.find((a) => a[0] === 'create')!
    expect(createHelper.slice(0, 3)).toEqual(['create', '--name', createHelper[2]!])
    expect(createHelper[2]).toMatch(/^sandbot-plugin-copy-[0-9a-f]{8}$/)
    expect(createHelper).toEqual(['create', '--name', createHelper[2]!, '-v', 'sandbot-plugins:/p', img, 'true'])
    // mkdir del padre COME ROOT prima del cp (docker cp non crea le intermedie)
    expect(calls.find((a) => a.includes('mkdir') && a.includes('-p'))).toEqual(
      ['run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', img, 'mkdir', '-p', '--', '/p/mp-box/box-plugin']
    )
    const cp = calls.find((a) => a[0] === 'cp')!
    expect(cp).toEqual(['cp', join(DATA, 'plugins', 'mp-box', 'box-plugin', sha12), `${createHelper[2]}:/p/mp-box/box-plugin/${sha12}`])
    expect(calls.find((a) => a.includes('chown'))).toEqual(
      ['run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', img, 'chown', '-R', '0:0', '--', `/p/mp-box/box-plugin/${sha12}`]
    )
    expect(calls.find((a) => a.includes('chmod'))).toEqual(
      ['run', '--rm', '-u', '0', '-v', 'sandbot-plugins:/p', img, 'chmod', '-R', 'a+rX,a-w', '--', `/p/mp-box/box-plugin/${sha12}`]
    )
    // l'usa-e-getta si rimuove SEMPRE, e per ultimo
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', createHelper[2]!])
    // il server stdio del plugin conserva i template env (L1) e la home del bot
    const cfg = deps.listServers()[0]!
    expect(cfg.transport).toBe('stdio')
    expect(cfg.box?.workdir).toBe(`/plugins/mp-box/box-plugin/${sha12}`) // M4: workdir nel volume dedicato
    expect(cfg.box?.home).toBe('/box/home/agent_alice')
    expect(cfg.pluginSpec?.env).toEqual({ API_KEY: '${user_config.API_KEY}', LIT: 'fisso' })
    expect(cfg.needsAuth).toEqual({ kind: 'settings', keys: ['API_KEY'] })
  })

  it('M4: cp fallito → rm dell\'usa-e-getta comunque, NESSUN server registrato, cartella Mac rimossa, errore chiaro', async () => {
    const calls: string[][] = []
    const deps = makeDockerDeps(async (argv) => {
      calls.push(argv)
      if (argv[0] === 'cp') return { code: 1, stdout: '', stderr: 'Error response from daemon: Could not find the file /p/mp-box/mkt/demo' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const card = await buildPluginCard('plugin:box-plugin@mp-box', '', deps, cloneDeps())
    if (!card.ok) throw new Error('card')
    const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('copy of the plugin into the plugins volume failed')
    // l'usa-e-getta è stato rimosso comunque (il finally scatta anche sull'errore)
    const helper = calls.find((a) => a[0] === 'create')![2]!
    expect(calls.some((a) => a[0] === 'rm' && a.includes(helper))).toBe(true)
    // e la copia parziale nel volume è stata buttata via (rm one-shot del path)
    expect(calls.some((a) => a.includes('rm') && a.includes('-rf') && a.some((x) => typeof x === 'string' && x.startsWith('/p/')))).toBe(true)
    expect(deps.listServers()).toEqual([])
    expect(installedPlugins({ getSetting: get })).toEqual([])
    expect(existsSync(join(DATA, 'plugins', 'mp-box', 'box-plugin', sha.slice(0, 12)))).toBe(false)
  })

  it('plugin a SOLE skill con cp fallito → installato lo stesso, e il messaggio lo dice', async () => {
    const skillOnly = mkdtempSync(join(tmpdir(), 'sandbot-plugin-repo-'))
    try {
      const run = (cmd: string): string => execSync(cmd, { cwd: skillOnly }).toString()
      mkdirSync(join(skillOnly, 'skills', 'helper'), { recursive: true })
      writeFileSync(join(skillOnly, 'skills', 'helper', 'SKILL.md'), '---\nname: helper\ndescription: una skill\n---\nCorpo.')
      mkdirSync(join(skillOnly, '.claude-plugin'), { recursive: true })
      writeFileSync(join(skillOnly, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'skill-plugin' }))
      run('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init')
      const skillSha = run('git rev-parse HEAD').trim()
      const deps = makeDockerDeps(async (argv) => {
        if (argv[0] === 'cp') return { code: 1, stdout: '', stderr: 'no space left on device' }
        return { code: 0, stdout: '', stderr: '' }
      })
      deps.marketplaces.findPlugin = async (id) => id === 'plugin:skill-plugin@mp-box'
        ? { reg: { name: 'mp-box', source: skillOnly, kind: 'git' as const, official: false, addedAt: 1 }, plugin: { name: 'skill-plugin', source: { kind: 'url' as const, url: `file://${skillOnly}`, sha: skillSha } } }
        : null
      const card = await buildPluginCard('plugin:skill-plugin@mp-box', '', deps, cloneDeps())
      if (!card.ok) throw new Error('card')
      const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.message).toContain('1 skill')
        expect(r.message).toContain('copy into the box failed')
      }
      expect(installedPlugins({ getSetting: get })).toHaveLength(1)
      expect(deps.listServers()).toEqual([])
    } finally {
      rmSync(skillOnly, { recursive: true, force: true })
    }
  })
})

// ---- M1+M2+M3: i .mcp.json PIATTI dei plugin ufficiali (contenuti VERI, pubblici) ----

describe('M1/M2/M3: linear, github, terraform — i .mcp.json veri del marketplace ufficiale', () => {
  // contenuti copiati dai repository pubblici dei plugin ufficiali (fase 13
  // correzioni 2): linear e github usano la mappa PIATTA, context7 mcpServers
  const LINEAR_MCP = '{ "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } }'
  const GITHUB_MCP = '{ "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",\n' +
    '    "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } } }'
  const TERRAFORM_MCP = '{ "terraform": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "TFE_TOKEN=${TFE_TOKEN}",\n' +
    '        "hashicorp/terraform-mcp-server:0.4.0"] } }'
  const CONTEXT7_MCP = '{ "mcpServers": { "context7": { "type": "http", "url": "https://mcp.context7.com/mcp?client=claude-code-plugin" } } }'

  let STG: string
  let settings: Map<string, unknown>
  let opened: number
  beforeEach(() => {
    settings = new Map()
    STG = mkdtempSync(join(tmpdir(), 'sandbot-install-stg-'))
    opened = 0
  })
  afterEach(() => rmSync(STG, { recursive: true, force: true }))
  const cloneDeps = (): { allowFileUrlsForTests: boolean; mkdtemp: (prefix: string) => string } => ({
    allowFileUrlsForTests: true,
    mkdtemp: (prefix) => {
      const d = join(STG, prefix + Math.random().toString(36).slice(2, 8))
      mkdirSync(d, { recursive: true })
      return d
    }
  })
  /** Un repo git locale col .mcp.json VOLUTO: un plugin ufficiale in miniatura. */
  const repoWith = (mcpJson: string): { repo: string; sha: string } => {
    const repo = mkdtempSync(join(tmpdir(), 'sandbot-plugin-repo-'))
    writeFileSync(join(repo, '.mcp.json'), mcpJson)
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: repo })
    return { repo, sha: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim() }
  }
  const depsOf = (repo: string, sha: string): InstallDeps => {
    const saved = new Map<string, Map<string, unknown>>()
    const servers: McpServerConfig[] = []
    return {
      store: fakeStore(saved),
      marketplaces: {
        findPlugin: async () => ({ reg: { name: 'claude-plugins-official', source: repo, kind: 'git' as const, official: true, addedAt: 1 }, plugin: { name: 'probe', source: { kind: 'url' as const, url: `file://${repo}`, sha } } }),
        cloneOf: () => null,
        list: () => []
      },
      findRegistryEntry: async () => null,
      listServers: () => servers,
      saveServers: (s: McpServerConfig[]) => { servers.length = 0; servers.push(...s) },
      toolsOfServer: async () => [],
      openExternal: async () => { opened++ },
      hasUi: () => true,
      dockerMode: () => false, // plugin http-only: nessuna copia nel box
      dataDir: () => DATA,
      onChange: () => undefined
    }
  }
  const set = (k: string, v: unknown) => settings.set(k, v)
  const get = <T,>(k: string, f: T): T => (settings.get(k) as T | undefined) ?? f

  it('M1: linear (mappa PIATTA) — la card mostra 1 server; M2: installato in needs_auth, NESSUN browser, il messaggio lo dice', async () => {
    const { repo, sha } = repoWith(LINEAR_MCP)
    try {
      const deps = depsOf(repo, sha)
      const card = await buildPluginCard('plugin:probe@claude-plugins-official', '', deps, cloneDeps())
      expect(card.ok).toBe(true)
      if (!card.ok) return
      expect(card.card.servers).toEqual([{ name: 'linear', runtimeKind: 'remote', runtimeDetail: 'mcp.linear.app' }])
      const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.message).toContain('to authorize: linear (Settings → Installed → Connect)')
      const cfg = deps.listServers()[0]!
      expect(cfg.transport).toBe('http')
      expect(cfg.url).toBe('https://mcp.linear.app/mcp')
      expect(cfg.auth).toEqual({ kind: 'oauth' }) // server http senza header → OAuth
      expect(cfg.pluginSpec).toEqual({ url: 'https://mcp.linear.app/mcp' })
      // M2: stato connettore needs_auth (lo vedono la scheda Installati e
      // skippedByConnectorState) e il browser NON si apre all'installazione
      expect((get<Record<string, { status?: string }>>('connectors.state', {})[cfg.id])?.status).toBe('needs_auth')
      expect(opened).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('M3: github — ${GITHUB_PERSONAL_ACCESS_TOKEN} negli header è "da configurare" in card, needsAuth settings e kind della UI', async () => {
    const { repo, sha } = repoWith(GITHUB_MCP)
    try {
      const deps = depsOf(repo, sha)
      const card = await buildPluginCard('plugin:probe@claude-plugins-official', '', deps, cloneDeps())
      expect(card.ok).toBe(true)
      if (!card.ok) return
      // il VAR usato negli header è in card anche se il manifest NON lo dichiara
      expect(card.card.settings).toContainEqual({ key: 'GITHUB_PERSONAL_ACCESS_TOKEN' })
      const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.message).toContain('to configure: GITHUB_PERSONAL_ACCESS_TOKEN')
      const cfg = deps.listServers()[0]!
      expect(cfg.auth).toEqual({ kind: 'headers' })
      expect(cfg.pluginSpec).toEqual({
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' }
      })
      expect(cfg.needsAuth).toEqual({ kind: 'settings', keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'] })
      // il valore si salva col kind della UI (SECRET_KIND_FOR_NEEDS.settings →
      // userConfig): è lo store che il resolver legge alla connessione
      await deps.store.write(cfg.id, SECRET_KIND.userConfig, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-finta' })
      expect(await deps.store.read(cfg.id, SECRET_KIND.userConfig)).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-finta' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('M3: terraform — ${TFE_TOKEN} in args: server NON registrato, la card e il messaggio dicono perché', async () => {
    const { repo, sha } = repoWith(TERRAFORM_MCP)
    try {
      const deps = depsOf(repo, sha)
      const card = await buildPluginCard('plugin:probe@claude-plugins-official', '', deps, cloneDeps())
      expect(card.ok).toBe(true)
      if (!card.ok) return
      expect(card.card.servers).toEqual([{ name: 'terraform', runtimeKind: 'unsupported', runtimeDetail: 'TFE_TOKEN' }])
      const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.message).toContain('servers not installed (value in argv): terraform (TFE_TOKEN)')
      expect(deps.listServers()).toEqual([])
      // il plugin resta installato (le sue skill, il suo record) senza il server
      expect(installedPlugins({ getSetting: get })[0]!.servers).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('M1: context7 (mappa mcpServers) — 1 server http dal file vero', async () => {
    const { repo, sha } = repoWith(CONTEXT7_MCP)
    try {
      const deps = depsOf(repo, sha)
      const card = await buildPluginCard('plugin:probe@claude-plugins-official', '', deps, cloneDeps())
      expect(card.ok).toBe(true)
      if (!card.ok) return
      expect(card.card.servers).toEqual([{ name: 'context7', runtimeKind: 'remote', runtimeDetail: 'mcp.context7.com' }])
      const r = await installPlugin(card.card, 'agent_alice', deps, set, get, cloneDeps())
      expect(r.ok).toBe(true)
      const cfg = deps.listServers()[0]!
      expect(cfg.url).toBe('https://mcp.context7.com/mcp?client=claude-code-plugin')
      expect(cfg.auth).toEqual({ kind: 'oauth' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ---- L1: funzioni pure dei segreti e riconnessione ----

describe('L1: SECRET_KIND, sostituzioni e unresolved', () => {
  it('SECRET_KIND: un solo nome per ogni tipo di segreto (UI, RPC, store)', () => {
    expect(SECRET_KIND).toEqual({ headers: 'staticHeaders', env: 'env', userConfig: 'userConfig', bearer: 'bearer' })
  })

  it('resolvePluginServerPlaceholders: ${user_config.KEY} negli header e in env, valore letterale e ${CLAUDE_PLUGIN_ROOT}', () => {
    const out = resolvePluginServerPlaceholders(
      {
        name: 's', from: 'test',
        url: 'https://api.example/${user_config.API_KEY}',
        headers: { 'x-api-key': '${user_config.API_KEY}' },
        env: { KEY: '${user_config.API_KEY}', LIT: 'fisso', ROOT: '${CLAUDE_PLUGIN_ROOT}/data' }
      },
      { API_KEY: 'chiave-finta' },
      '/box/plugins/mp/demo/abc123'
    )
    expect(out.url).toBe('https://api.example/chiave-finta')
    expect(out.headers).toEqual({ 'x-api-key': 'chiave-finta' })
    expect(out.env).toEqual({ KEY: 'chiave-finta', LIT: 'fisso', ROOT: '/box/plugins/mp/demo/abc123/data' })
  })

  it('unresolvedUserConfigKeys: i placeholder rimasti (valore mai salvato) si elencano', () => {
    expect(unresolvedUserConfigKeys({ url: 'https://x/${user_config.A}', headers: { h: 'Bearer ${user_config.B}' }, env: { e: '${user_config.B}' } }).sort()).toEqual(['A', 'B'])
    expect(unresolvedUserConfigKeys({ headers: { h: 'ok' }, env: {} })).toEqual([])
  })

  it('reconnectServer: rifà authorizeWithLoopback per il server non del catalogo e pulisce needs_auth', async () => {
    const authorizedUrls: string[] = []
    const deps = makeDeps({
      toolsOfServer: async () => [{ name: 't', annotations: { readOnlyHint: true } }],
      // il flusso OAuth è iniettato: qui conta CHI lo chiama e con quale URL
      authorize: async (serverUrl) => { authorizedUrls.push(serverUrl) }
    })
    // un server del registro in stato needs_auth (OAuth scaduto)
    const cfg: McpServerConfig = {
      id: serverIdFor({ kind: 'registry', name: 'com.linear/linear' }), name: 'com.linear/linear',
      transport: 'http', url: 'http://127.0.0.1:9/mcp', enabled: true, auth: { kind: 'oauth' },
      enabledFor: ['agent_alice'], source: { kind: 'registry', name: 'com.linear/linear' }
    }
    deps.saveServers([cfg])
    const settings = new Map<string, unknown>([['connectors.state', { [cfg.id]: { status: 'needs_auth', error: 'Sessione scaduta' } }]])
    const get = <T,>(k: string, f: T): T => (settings.has(k) ? settings.get(k) as T : f)
    const set = (k: string, v: unknown) => settings.set(k, v)
    const r = await reconnectServer(cfg.id, deps, get, set)
    expect(authorizedUrls).toEqual([cfg.url])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.message).toContain('Server com.linear/linear added: 1 tools')
    // lo stato torna connected (la card "Riconnetti" sparirà)
    expect((settings.get('connectors.state') as Record<string, { status: string }>)[cfg.id]!.status).toBe('connected')
    // i rifiuti: server del catalogo, senza OAuth, inesistente
    expect((await reconnectServer('non-esiste', deps, get, set)).ok).toBe(false)
    deps.saveServers([{ ...cfg, catalogId: 'notion' }])
    expect((await reconnectServer(cfg.id, deps, get, set)).ok).toBe(false)
    deps.saveServers([{ ...cfg, auth: { kind: 'headers' } }])
    expect((await reconnectServer(cfg.id, deps, get, set)).ok).toBe(false)
  })
})
