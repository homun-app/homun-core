// Test delle CARD e dell'INSTALLAZIONE (fase 13, punti 2, 4 e 7): il bot
// propone (card in codice), l'installazione parte SOLO dalla funzione del
// click. Tutto con deps INIETTABILI: registro dalla fixture REALE, marketplace
// con repo git locale (file:// solo col flag di test), toolsOfServer finto.
// Nessun Docker, nessuna rete.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from './fixtures/registry-notion.json'
import { parseRegistryResponse } from '../registry'
import type { RegistryEntry } from '../registry'
import {
  buildMcpServerCard, installMcpServer, buildPluginCard, installPlugin, uninstallPlugin,
  addGateway, installedPlugins, pluginBoxDir, serverInstalledMessage, parseMcpServerId,
  GATEWAY_PRESETS, GATEWAY_WARNING, PROPOSAL_RESULT, THIRD_PARTY_SERVER_WARNING, HOST_MODE_DISABLED,
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
  it('i testi della specifica: proposta, avviso terzi, host, gateway', () => {
    expect(PROPOSAL_RESULT).toContain('proposta mostrata all\'utente')
    expect(THIRD_PARTY_SERVER_WARNING).toContain('Server pubblicato da terzi')
    expect(HOST_MODE_DISABLED).toBe('si installa solo nel computer dei bot (modalità docker)')
    expect(GATEWAY_WARNING).toBe('Un gateway custodisce l\'accesso a tutte le app che colleghi lì: è un servizio di terzi')
  })
})

// ---- buildMcpServerCard (punto 2) ----

describe('buildMcpServerCard (pura a deps iniettati)', () => {
  it('remoto senza header: card remoto OAuth con host, fiducia dominio verificato, NESSUN avviso terzi', async () => {
    const r = await buildMcpServerCard('registry:com.notion/mcp', 'per leggere le pagine', makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.name).toBe('mcp')
    expect(r.card.trust).toBe('dominio verificato (notion.com)')
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
    expect(r.card.trust).toBe('dominio verificato (smithery.ai)')
    expect(r.card.thirdPartyWarning).toBeUndefined()
  })

  it('account GitHub e non verificati: AVVISO terzi in card', async () => {
    const gh = makeDeps({ findRegistryEntry: async () => ({ server: { name: 'io.github.pincopallino/mcp', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } }) })
    const r1 = await buildMcpServerCard('registry:io.github.pincopallino/mcp', '', gh)
    expect(r1.ok && r1.card.thirdPartyWarning).toBe(true)
    const nv = makeDeps({ findRegistryEntry: async () => ({ server: { name: 'nudo/mcp', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } }) })
    const r2 = await buildMcpServerCard('registry:nudo/mcp', '', nv)
    expect(r2.ok && r2.card.trust).toBe('non verificato')
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
    expect(r.card.disabledReason).toBe(HOST_MODE_DISABLED)
  })

  it('pypi/oci: NESSUNA card, il tool risponde "non installabile qui: tipo <registryType>"', async () => {
    const deps = makeDeps({
      findRegistryEntry: async () => ({ server: { name: 'x/y', packages: [{ registryType: 'pypi', identifier: 'y', transport: { type: 'stdio' } }] } })
    })
    const r = await buildMcpServerCard('registry:x/y', '', deps)
    expect(r).toEqual({ ok: false, error: 'non installabile qui: tipo pypi' })
  })

  it('url:https://… proposto dall\'utente in chat: card non verificata, remoto OAuth', async () => {
    const r = await buildMcpServerCard('url:https://mcp.example.com/mcp', 'il server che hai citato', makeDeps())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.trust).toBe('non verificato')
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
    if (r.ok) expect(r.message).toBe('Server mcp aggiunto: 3 strumenti (lettura: 2, scrittura: 1)')
    // il server è registrato col source registry e abilitato SOLO per chi l'ha proposto
    const cfg = deps.listServers()[0]!
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
    if (r.ok) expect(r.message).toContain('serve la chiave')
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
      command: 'npx',
      args: ['-y', '@foreverworks/mcp-notion@0.1.0'],
      envKeys: ['NOTION_TOKENS_DIR']
    })
    expect(cfg.needsAuth).toEqual({ kind: 'env', keys: ['NOTION_TOKENS_DIR'] })
  })

  it('regola 3 con env compilata: il server parte e l\'esito conta gli strumenti', async () => {
    const deps = makeDeps({ toolsOfServer: async () => [{ name: 'a', annotations: { readOnlyHint: true } }] })
    // il valore della env è già nello store cifrato (modulo Impostazioni)
    await deps.store.write('registry-notion', 'env', { NOTION_TOKENS_DIR: '/box/home/agent_alice/tokens' })
    const card = await buildMcpServerCard('registry:com.foreverworks/notion', '', deps)
    if (!card.ok) throw new Error('card')
    const r = await installMcpServer(card.card, 'agent_alice', deps)
    expect(r).toEqual({ ok: true, message: 'Server notion aggiunto: 1 strumenti (lettura: 1, scrittura: 0)' })
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
    expect(serverInstalledMessage('x', [{ annotations: { readOnlyHint: true } }, {}, {}])).toBe('Server x aggiunto: 3 strumenti (lettura: 1, scrittura: 2)')
  })
})

// ---- plugin: card + installazione + disinstallazione (punto 4) ----

describe('plugin: card, installazione, disinstallazione', () => {
  let REPO: string
  let sha: string
  let settings: Map<string, unknown>
  let deps: InstallDeps

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

  it('sorgente npm/archive/command: NESSUNA card, "sorgente <tipo> non supportata"', async () => {
    const d = { ...deps, marketplaces: { ...deps.marketplaces, findPlugin: async () => ({ reg: { name: 'm', source: 'x', kind: 'git' as const, official: false, addedAt: 1 }, plugin: { name: 'p', source: { kind: 'command' as const, command: 'evil' } } }) } }
    const r = await buildPluginCard('plugin:p@m', '', d)
    expect(r).toEqual({ ok: false, error: 'sorgente command non supportata' })
  })

  it('la card elenca skill, server, impostazioni, lo sha12 e l\'hook fra i NON importati', async () => {
    const r = await buildPluginCard('plugin:demo-plugin@mp-di-test', 'per le sue skill', deps, { allowFileUrlsForTests: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.card.name).toBe('demo-plugin')
    expect(r.card.marketplace).toBe('mp-di-test')
    expect(r.card.sha12).toBe(sha.slice(0, 12))
    expect(r.card.skills).toEqual(['demo-plugin--helper'])
    expect(r.card.servers).toEqual([{ name: 'demo', runtimeLabel: 'remoto (mcp.demo.example)' }])
    expect(r.card.settings).toEqual([{ key: 'TOKEN', description: 'chiave', sensitive: true }])
    expect(r.card.ignored).toContain('hooks')
  })

  it('installazione: cartella in <dataDir>/plugins, server http registrato con userConfig da compilare, record nel registro', async () => {
    const card = await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps, { allowFileUrlsForTests: true })
    if (!card.ok) throw new Error('card')
    const r = await installPlugin(card.card, 'agent_alice', deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f, { allowFileUrlsForTests: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.message).toContain('Plugin demo-plugin installato: 1 skill, 1 server')
    const dir = join(DATA, 'plugins', 'mp-di-test', 'demo-plugin', sha.slice(0, 12))
    expect(existsSync(join(dir, 'skills', 'helper', 'SKILL.md'))).toBe(true)
    // il server MCP del plugin: http con header userConfig, needsAuth finché la chiave non c'è
    const cfg = deps.listServers().find((s) => s.source?.kind === 'plugin')
    expect(cfg?.url).toBe('https://mcp.demo.example/mcp')
    expect(cfg?.needsAuth).toEqual({ kind: 'settings', keys: ['TOKEN'] })
    expect(cfg?.enabledFor).toEqual(['agent_alice'])
    const rec = installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })[0]!
    expect(rec.name).toBe('demo-plugin')
    expect(rec.skills[0]?.name).toBe('demo-plugin--helper')
    expect(pluginBoxDir(rec.marketplace, rec.name, rec.sha12)).toBe(`/box/plugins/mp-di-test/demo-plugin/${sha.slice(0, 12)}`)
    // il FILE SENTINELLA dell'hook non esiste: il codice di terzi non è MAI girato
    expect(existsSync('/tmp/sandbot-plugin-hook-sentinel')).toBe(false)
  })

  it('disinstallazione: cartella, server e record; i dati utente non si toccano', async () => {
    const card = await buildPluginCard('plugin:demo-plugin@mp-di-test', '', deps, { allowFileUrlsForTests: true })
    if (!card.ok) throw new Error('card')
    await installPlugin(card.card, 'agent_alice', deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f, { allowFileUrlsForTests: true })
    const rec = installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })[0] as InstalledPlugin
    expect(deps.listServers().length).toBe(1)
    await uninstallPlugin(rec, deps, (k, v) => settings.set(k, v), (k, f) => (settings.get(k) as never) ?? f)
    expect(existsSync(join(DATA, 'plugins', 'mp-di-test', 'demo-plugin', sha.slice(0, 12)))).toBe(false)
    expect(deps.listServers().length).toBe(0)
    expect(installedPlugins({ getSetting: (k, f) => (settings.get(k) as never) ?? f })).toEqual([])
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
