// Test PURI del registro MCP e della ricerca unificata (fase 13, punto 1):
// fixture con le risposte REALI catturate dal revisore (curl su
// registry.modelcontextprotocol.io, API v0.1). Niente rete, niente Electron.
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/registry-notion.json'
import mattermost from './fixtures/registry-mattermost.json'
import { loadCatalog } from '../index'
import {
  parseRegistryResponse, registryEnvVars, registryRuntime, registrySearchUrl, registrySiteUrl, registryTrust,
  registryTitle, titleFromName, registryIconDataUrl,
  fetchRegistryEntries, clearRegistryCache, type RegistryFetchDeps
} from '../registry'
import {
  formatConnectorLine, formatSearchResults, mergeConnectorResults, SEARCH_MAX_ROWS,
  type MergeInput
} from '../search'

describe('registryTrust — lo spazio dei nomi del registro (puro)', () => {
  it('nomi a DNS inverso = dominio verificato (etichette invertite)', () => {
    expect(registryTrust('com.notion/mcp')).toEqual({ kind: 'verified-domain', domain: 'notion.com', label: 'verified domain (notion.com)' })
    const domainOf = (name: string): string => {
      const t = registryTrust(name)
      return t.kind === 'verified-domain' ? t.domain : '(non dominio)'
    }
    expect(domainOf('com.microsoft/microsoft-learn-mcp')).toBe('microsoft.com')
    expect(domainOf('com.foreverworks/notion')).toBe('foreverworks.com')
    expect(domainOf('ai.smithery/smithery-notion')).toBe('smithery.ai')
  })
  it('io.github.<utente> = solo l\'account GitHub verificato', () => {
    expect(registryTrust('io.github.roman-right/mcp-example')).toEqual({
      kind: 'github-account', user: 'roman-right', label: 'GitHub account (roman-right)'
    })
  })
  it('tutto il resto è non verificato (namespace corto, nomi nudi, etichette sporche)', () => {
    expect(registryTrust('notion/mcp').kind).toBe('unverified')
    expect(registryTrust('notion').kind).toBe('unverified')
    expect(registryTrust('com..notion/mcp').kind).toBe('unverified')
    expect(registryTrust('com.no_tion/mcp').kind).toBe('unverified')
  })
})

describe('parseRegistryResponse — fixture REALE (3 voci notion)', () => {
  it('tiene le 3 voci isLatest+active', () => {
    const entries = parseRegistryResponse(fixture)
    expect(entries.map((e) => e.server.name)).toEqual([
      'com.notion/mcp', 'ai.smithery/smithery-notion', 'com.foreverworks/notion'
    ])
  })
  it('scarta le voci non latest o non active', () => {
    const withOld = parseRegistryResponse({
      servers: [
        ...fixture.servers,
        { server: { name: 'x/old' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: false } } },
        { server: { name: 'x/deleted' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted', isLatest: true } } },
        { server: { name: 'x/nometa' } }
      ]
    })
    expect(withOld.map((e) => e.server.name)).not.toContain('x/old')
    expect(withOld.map((e) => e.server.name)).not.toContain('x/deleted')
    expect(withOld.map((e) => e.server.name)).not.toContain('x/nometa')
  })
  it('input malformato → array vuoto', () => {
    expect(parseRegistryResponse(null)).toEqual([])
    expect(parseRegistryResponse({})).toEqual([])
    expect(parseRegistryResponse({ servers: 'no' })).toEqual([])
  })

  it('com.notion/mcp: remoto streamable-http, senza repository utile', () => {
    const e = parseRegistryResponse(fixture)[0]!
    const rt = registryRuntime(e)!
    expect(rt).toEqual({ kind: 'remote', url: 'https://mcp.notion.com/mcp' })
    expect(registrySiteUrl(e)).toBeNull()
  })
  it('ai.smithery: remoto con header Authorization isSecret E isRequired → auth headers, template e variabili (M1)', () => {
    const e = parseRegistryResponse(fixture)[1]!
    expect(registryRuntime(e)).toEqual({
      kind: 'remote',
      url: 'https://server.smithery.ai/@smithery/notion/mcp',
      urlTemplate: 'https://server.smithery.ai/@smithery/notion/mcp',
      headers: [{
        name: 'Authorization',
        valueTemplate: 'Bearer {smithery_api_key}',
        isRequired: true,
        isSecret: true,
        description: 'Bearer token for Smithery authentication',
        varNames: ['smithery_api_key'],
        variables: [{ name: 'smithery_api_key', isSecret: true }]
      }],
      auth: 'headers',
      secretHeader: 'Authorization'
    })
  })
  it('com.foreverworks: pacchetto npm stdio → nel box, con env var obbligatoria', () => {
    const e = parseRegistryResponse(fixture)[2]!
    expect(registryRuntime(e)).toEqual({ kind: 'box-npm', identifier: '@foreverworks/mcp-notion', version: '0.1.0' })
    expect(registryEnvVars(e)).toEqual([
      { name: 'NOTION_TOKENS_DIR', required: true, description: 'A folder holding one file per workspace…' }
    ])
  })
  it('pypi/oci/altro → non installabile col suo registryType', () => {
    expect(registryRuntime({ server: { name: 'x/y', packages: [{ registryType: 'pypi', identifier: 'y', transport: { type: 'stdio' } }] } }))
      .toEqual({ kind: 'not-installable', registryType: 'pypi' })
    expect(registryRuntime({ server: { name: 'x/y', packages: [{ registryType: 'oci' }] } }))
      .toEqual({ kind: 'not-installable', registryType: 'oci' })
  })
  it('L8: pacchetto npm SENZA versione → not-installable "version not declared" (mai latest)', () => {
    expect(registryRuntime({ server: { name: 'x/y', packages: [{ registryType: 'npm', identifier: 'qualcosa', transport: { type: 'stdio' } }] } }))
      .toEqual({ kind: 'not-installable', registryType: 'npm', reason: 'version not declared' })
  })
  it('l\'URL di ricerca v0.1: search + version=latest + limit', () => {
    expect(registrySearchUrl('notion', 3)).toBe(
      'https://registry.modelcontextprotocol.io/v0.1/servers?search=notion&version=latest&limit=3'
    )
  })
})

// ---- fase mcp-setup (M1/M2): la voce VERA di Mattermost (2026-11-04) ----

describe('mcp-setup: la voce vera di Mattermost legge TUTTO il remoto (M1)', () => {
  const e = parseRegistryResponse(mattermost)[0]!
  it('registryRuntime: variabile obbligatoria mattermost_host, auth oauth, header Authorization facoltativo col template', () => {
    const rt = registryRuntime(e)! as Extract<ReturnType<typeof registryRuntime>, { kind: 'remote' }>
    expect(rt.urlTemplate).toBe('https://{mattermost_host}/plugins/mattermost-ai/mcp-server/mcp')
    expect(rt.urlVariables).toEqual([
      {
        name: 'mattermost_host',
        description: 'Hostname of your own Mattermost server (add a port or subpath if your Site URL has one), for example chat.example.com. Requires the Mattermost Agents plugin with its HTTP MCP server enabled.',
        isRequired: true,
        placeholder: 'chat.example.com'
      }
    ])
    // M1.2: l'header c'è ma è FACOLTATIVO → OAuth di default, l'header è l'alternativa
    expect(rt.auth).toBe('oauth')
    expect(rt.headers).toEqual([
      {
        name: 'Authorization',
        valueTemplate: 'Bearer {personal_access_token}',
        isSecret: true,
        description: 'Optional. OAuth 2.0 with dynamic client registration is the default and needs no header. To use a Mattermost Personal Access Token instead, set this to Bearer followed by the token.',
        varNames: ['personal_access_token'],
        variables: [
          {
            name: 'personal_access_token',
            description: 'Mattermost Personal Access Token (User Settings > Security > Personal Access Tokens).',
            isSecret: true
          }
        ]
      }
    ])
    // compatibilità: il secretHeader di ieri resta (il token c'è, come campo facoltativo)
    expect(rt.secretHeader).toBe('Authorization')
  })
  it('la risoluzione: completa, col buco, coi valori da ripulire (M1.3)', async () => {
    const { fillTemplate, missingTemplateVars } = await import('../../../shared/registry-vars')
    const t = (registryRuntime(e) as { urlTemplate?: string })!.urlTemplate!
    // completa
    expect(fillTemplate(t, { mattermost_host: 'chat.example.com' })).toBe('https://chat.example.com/plugins/mattermost-ai/mcp-server/mcp')
    // col buco: la graffa resta e missingTemplateVars la vede
    expect(fillTemplate(t, {})).toBe(t)
    expect(missingTemplateVars(fillTemplate(t, {}))).toEqual(['mattermost_host'])
    // valore da ripulire: lo schema incollato via
    expect(fillTemplate(t, { mattermost_host: 'https://chat.example.com/' })).toContain('https://https://')
    // (per questo il modulo ripulisce PRIMA: cleanHostValue toglie schema e barra)
  })
  it('una voce con header isRequired: true dà auth headers (M1.2)', () => {
    const withRequired = parseRegistryResponse({
      servers: [{ server: { name: 'x/y', remotes: [{ url: 'https://x.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer {k}', isRequired: true, isSecret: true }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } }] as never
    })[0]!
    const rt = registryRuntime(withRequired) as { auth?: string }
    expect(rt.auth).toBe('headers')
  })
  it('M2: il titolo — server.title vince; senza, dal segmento finale del nome', () => {
    expect(registryTitle(e)).toBe('Mattermost')
    expect(titleFromName('io.github.mattermost/mattermost-plugin-agents')).toBe('Mattermost Plugin Agents')
    // il segmento finale «mcp» dice nulla: si prende il nome del progetto prima
    expect(titleFromName('com.notion/mcp')).toBe('Notion')
    expect(titleFromName('ai.smithery/smithery-notion')).toBe('Smithery Notion')
    expect(registryTitle({ server: { name: 'io.github.roman-right/mcp-example' } })).toBe('Mcp Example')
  })
  it('M2: la icona — solo un data: del registro, NESSUNA fetch nuova', () => {
    expect(registryIconDataUrl(e)).toBeNull()
    expect(registryIconDataUrl({ server: { name: 'x', icons: [{ src: 'https://logo.example/x.png' }] } })).toBeNull()
    expect(registryIconDataUrl({ server: { name: 'x', icons: [{ src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }] } })).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  })
})

// ---- L8: fetchRegistryEntries — registro giù vs zero risultati, e la cache ----

// l'esito ok del fetch SSRF (WebFetchOutcome completo, iniettabile)
const okFetchOutcome = (body: unknown): { ok: true; text: string; contentType: string; finalUrl: string; downloadedBytes: number } =>
  ({ ok: true, text: typeof body === 'string' ? body : JSON.stringify(body), contentType: 'application/json', finalUrl: 'https://registry.example/', downloadedBytes: 1 })

describe('L8: fetchRegistryEntries — null solo per errore (non in cache), [] per zero risultati (in cache)', () => {
  const fixtureAsEntry = parseRegistryResponse(fixture)[0]!

  it('zero risultati: [] (NON la riga "registro non raggiungibile"), e la SECONDA chiamata è in cache', async () => {
    clearRegistryCache()
    let calls = 0
    const deps: RegistryFetchDeps = { fetchOutcome: async () => { calls++; return okFetchOutcome({ servers: [] }) } }
    await expect(fetchRegistryEntries('zzz-inesistente', 8, deps)).resolves.toEqual([])
    // zero risultati va in cache: la seconda chiamata non rifà il fetch
    await expect(fetchRegistryEntries('zzz-inesistente', 8, deps)).resolves.toEqual([])
    expect(calls).toBe(1)
  })

  it('errore di rete o JSON: null, NON in cache — la seconda chiamata ci RIPROVA', async () => {
    clearRegistryCache()
    let calls = 0
    const deps: RegistryFetchDeps = { fetchOutcome: async () => { calls++; throw new Error('rete giù') } }
    await expect(fetchRegistryEntries('notion', 8, deps)).resolves.toBeNull()
    await expect(fetchRegistryEntries('notion', 8, deps)).resolves.toBeNull()
    expect(calls).toBe(2) // PRIMA della correzione la seconda chiamata restituiva [] dalla cache
  })

  it('risposta non JSON: null', async () => {
    clearRegistryCache()
    const deps: RegistryFetchDeps = { fetchOutcome: async () => okFetchOutcome('<html>non json</html>') }
    await expect(fetchRegistryEntries('notion', 8, deps)).resolves.toBeNull()
  })

  it('voci valide: in cache 10 minuti (il tempo non passa → stesso risultato)', async () => {
    clearRegistryCache()
    let t = 1_000
    let calls = 0
    const deps: RegistryFetchDeps = {
      fetchOutcome: async () => { calls++; return okFetchOutcome({ servers: [fixtureAsEntry] }) },
      now: () => t
    }
    const first = await fetchRegistryEntries('notion', 8, deps)
    expect(first).toHaveLength(1)
    t += 5 * 60_000 // 5 minuti: dentro la cache
    await expect(fetchRegistryEntries('notion', 8, deps)).resolves.toBe(first)
    expect(calls).toBe(1)
  })
})

// ---- mergeConnectorResults / formatConnectorLine ----

const CATALOG = loadCatalog()
const catalogInput = (ids: string[]): MergeInput['catalog'] =>
  CATALOG.filter((e) => ids.includes(e.id)).map((entry) => ({ entry, state: undefined }))

const input = (over: Partial<MergeInput> = {}): MergeInput => ({
  catalog: catalogInput(['notion', 'linear']),
  plugins: [
    {
      marketplace: 'claude-plugins-official', official: true,
      plugin: {
        name: 'notion',
        description: 'Notion plugin with skills and an MCP server',
        source: { kind: 'url', url: 'https://github.com/makenotion/claude-code-notion-plugin.git', sha: '9847f2aa12345678901234567890123456789012' }
      }
    }
  ],
  registry: parseRegistryResponse(fixture),
  ...over
})

describe('mergeConnectorResults (puro)', () => {
  it('con "notion" com.notion/mcp va deduplicato sulla voce catalog:notion (stesso mcpUrl)', () => {
    const { rows } = mergeConnectorResults(input(), 'notion')
    expect(rows.some((r) => r.id === 'registry:com.notion/mcp')).toBe(false)
    expect(rows.some((r) => r.id === 'catalog:notion')).toBe(true)
  })

  it('fonte → fiducia → nome: il catalogo prima dei plugin, il registro dopo', () => {
    const { rows } = mergeConnectorResults(input(), 'notion')
    const ids = rows.map((r) => r.id)
    expect(ids.indexOf('catalog:notion')).toBeLessThan(ids.indexOf('plugin:notion@claude-plugins-official'))
    // nel registro: la voce npm a dominio verificato prima di quella a chiave
    expect(ids.indexOf('registry:com.foreverworks/notion')).toBeLessThan(ids.indexOf('registry:ai.smithery/smithery-notion'))
  })

  it('le righe portano fonte, fiducia e come gira', () => {
    const { rows } = mergeConnectorResults(input(), 'notion')
    const catalog = rows.find((r) => r.id === 'catalog:notion')!
    expect(catalog.trust).toBe('verified')
    expect(catalog.runtimeLabel).toBe('remote (OAuth)')
    const smithery = rows.find((r) => r.id === 'registry:ai.smithery/smithery-notion')!
    expect(smithery.trust).toBe('verified domain (smithery.ai)')
    expect(smithery.runtimeLabel).toBe('remote (needs a key)')
    const npm = rows.find((r) => r.id === 'registry:com.foreverworks/notion')!
    expect(npm.runtimeLabel).toBe('in the box (npm)')
    const plugin = rows.find((r) => r.id === 'plugin:notion@claude-plugins-official')!
    expect(plugin.trust).toBe('official marketplace')
  })

  it('tetto di 8 righe in totale', () => {
    const many = parseRegistryResponse({
      servers: Array.from({ length: 20 }, (_, i) => ({
        server: { name: `com.x${i}/notion-${i}`, description: 'd' },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } }
      }))
    })
    const { rows } = mergeConnectorResults({ ...input(), registry: many }, 'notion')
    expect(rows.length).toBe(SEARCH_MAX_ROWS)
    // catalogo e plugin prima: le prime 3 righe sono le fonti fidate
    expect(rows.slice(0, 2).every((r) => r.source === 'catalog' || r.source === 'plugin')).toBe(true)
  })

  it('registry null → riga "registro pubblico non raggiungibile", le altre fonti rispondono', () => {
    const out = mergeConnectorResults({ ...input(), registry: null }, 'notion')
    expect(out.registryDown).toBe(true)
    expect(formatSearchResults(out)).toContain('public registry unreachable')
    expect(formatSearchResults(out)).toContain('catalog:notion')
  })

  it('lo stato del catalogo finisce nella riga (connesso)', () => {
    const { rows } = mergeConnectorResults(
      { ...input(), catalog: [{ entry: CATALOG.find((e) => e.id === 'notion')!, state: { status: 'connected', disabledTools: [], instructions: '' } }] },
      'notion'
    )
    expect(rows.find((r) => r.id === 'catalog:notion')?.status).toBe('connected')
  })
})

describe('formatConnectorLine (puro)', () => {
  it('id, nome, fonte, fiducia, come gira, stato e descrizione troncata a 160', () => {
    const { rows } = mergeConnectorResults(input(), 'smithery')
    const line = formatConnectorLine(rows.find((r) => r.id === 'registry:ai.smithery/smithery-notion')!)
    expect(line).toContain('registry:ai.smithery/smithery-notion')
    expect(line).toContain('MCP registry')
    expect(line).toContain('verified domain (smithery.ai)')
    expect(line).toContain('remote (needs a key)')
    // la descrizione della fixture resta COM'È (già corta), mai oltre 160
    const desc = line.slice(line.lastIndexOf(': ') + 2)
    expect(desc.length).toBeLessThanOrEqual(160)
  })
  it('la descrizione lunga viene troncata a 160 caratteri', () => {
    const row = {
      id: 'registry:x/y', name: 'y', source: 'registry' as const, sourceLabel: 'MCP registry',
      trust: 'non verificato', trustKind: 'unverified' as const, runtime: 'remote-oauth' as const,
      runtimeLabel: 'remote (OAuth)', description: 'a'.repeat(400)
    }
    const line = formatConnectorLine(row)
    expect(line.slice(line.lastIndexOf(': ') + 2).length).toBe(160)
  })
})
