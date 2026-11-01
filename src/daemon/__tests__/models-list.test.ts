// Fase 18b (H5.1/H6.1): le RPC models:list (unione catalogo + elenco vivo) e
// usage:summary (groupBy). Store reale su cartella mkdtemp del percorso
// ESPLICITO /var/folders/… (mai $TMPDIR né os.tmpdir()); il fetch vivo è
// stubbato, il catalogo pi-ai è quello vero (nessuna rete).
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { SandbotEvent, ModelInfo, ModelCapabilities, ProviderConfig } from '../../shared/types'
import { setDataDir, dataDir, db, saveProviders, setSetting, recordModelUsage } from '../../main/store/db'
import { resetOllamaCapabilities } from '../../main/agent/live-models'
import { buildApiMethods } from '../api'
import type { JobWorker } from '../worker'

/** Il percorso esplicito richiesto dai vincoli (MAI $TMPDIR né os.tmpdir()). */
const TMP_ROOT = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'

const events: SandbotEvent[] = []
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string
let server: Server
let port = 0
let liveOk = true

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-models-list-'))
  setDataDir(dir)
  dataDir()
  db()
  server = createServer((_req, res) => {
    if (!liveOk) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3.6-27b' }, { id: 'modello-nuovo-non-ancora-a-catalogo' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => server.close(() => r()))
})
beforeEach(() => {
  liveOk = true
  db().exec('DELETE FROM model_usage')
})
afterEach(() => vi.unstubAllGlobals())

/** Un provider groq puntato al finto: il catalogo si CLONA sull'URL vivo. */
const groqAt = (base: string): ProviderConfig =>
  ({ id: 'g-live', name: 'Groq', kind: 'groq', baseUrl: base, apiKey: 'sk-test-groq', enabled: true })

describe('models:list (H5.1): unione di catalogo e elenco vivo', () => {
  it('l\'unione: voce in entrambi → both; solo vivo → live; solo catalogo → catalog', async () => {
    saveProviders([groqAt(`http://127.0.0.1:${port}/v1`)])
    const out = (await api['models:list']!(['g-live'])) as ModelInfo[]
    const both = out.find((m) => m.id === 'qwen/qwen3.6-27b')!
    expect(both).toBeTruthy()
    expect(both.source).toBe('both')
    expect(both.vision).toBe(true) // capacità del catalogo (modelCapabilities)
    expect(both.thinkingLevels).toContain('high')
    expect(both.tools).toBe(true)
    expect(both.contextWindow).toBeGreaterThan(0)
    expect(both.local).toBe(false)
    const liveOnly = out.find((m) => m.id === 'modello-nuovo-non-ancora-a-catalogo')!
    expect(liveOnly.source).toBe('live')
    expect(liveOnly.vision).toBeNull()
    // il catalogo ha molti modelli che il vivo non elenca
    expect(out.some((m) => m.source === 'catalog')).toBe(true)
    expect(out.every((m) => m.source === 'both' || m.source === 'live' || m.source === 'catalog')).toBe(true)
  })

  it('il vivo FALLISCE ma il catalogo c\'è: si restituisce il catalogo, NESSUN errore', async () => {
    saveProviders([groqAt('http://127.0.0.1:1/v1')]) // niente in ascolto
    const out = (await api['models:list']!(['g-live'])) as ModelInfo[]
    expect(out.length).toBeGreaterThan(5)
    expect(out.every((m) => m.source === 'catalog')).toBe(true)
  })

  it('kind SENZA catalogo e vivo che fallisce → uiError', async () => {
    const zai: ProviderConfig = { id: 'z-nocat', name: 'Z.ai', kind: 'zai', baseUrl: 'https://api.z.ai', apiKey: 'sk-test-zai', enabled: true }
    saveProviders([zai])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    await expect(api['models:list']!(['z-nocat'])).rejects.toThrow()
  })

  it('provider inesistente → uiError', async () => {
    await expect(api['models:list']!(['manca'])).rejects.toThrow()
  })

  it('il prezzo personalizzato compare nella voce fuori catalogo (costSource custom)', async () => {
    saveProviders([groqAt(`http://127.0.0.1:${port}/v1`)])
    setSetting('providers.modelPrices', { 'g-live': { 'modello-nuovo-non-ancora-a-catalogo': { input: 1.5, output: 3 } } })
    const out = (await api['models:list']!(['g-live'])) as ModelInfo[]
    const custom = out.find((m) => m.id === 'modello-nuovo-non-ancora-a-catalogo')!
    expect(custom.cost).toEqual({ input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 })
    expect(custom.costSource).toBe('custom')
    // le voci del catalogo restano col prezzo del catalogo
    const both = out.find((m) => m.id === 'qwen/qwen3.6-27b')!
    expect(both.costSource).toBe('catalog')
  })
})

describe('usage:summary (H6.1): la RPC con groupBy', () => {
  it('groupBy agent porta agentId e agentName (null per le chiamate senza bot)', () => {
    db().exec("INSERT INTO agents(id, name, description, status, created_at) VALUES('ag1', 'Nomedebot', '', 'idle', 1)")
    recordModelUsage({ agentId: 'ag1', providerId: 'p', providerKind: 'groq', model: 'm', source: 'turn', input: 1, output: 1, costUsd: 0.1 })
    recordModelUsage({ agentId: null, providerId: 'p', providerKind: 'groq', model: 'm', source: 'review', input: 1, output: 1, costUsd: null })
    const rows = api['usage:summary']!([undefined, undefined, 'agent']) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    const named = rows.find((r) => r.agentId === 'ag1')!
    expect(named.agentName).toBe('Nomedebot')
    expect(named.costPartial).toBe(false)
    const system = rows.find((r) => r.agentId === null)!
    expect(system.agentName).toBeNull()
  })

  it('default groupBy model; la finestra [fromMs, toMs] filtra', () => {
    recordModelUsage({ at: 100, agentId: null, providerId: 'p', providerKind: 'groq', model: 'm', source: 'turn', input: 1, output: 1, costUsd: 0.1 })
    recordModelUsage({ at: 200, agentId: null, providerId: 'p', providerKind: 'groq', model: 'altro', source: 'turn', input: 1, output: 1, costUsd: null })
    const all = api['usage:summary']!([]) as Array<Record<string, unknown>>
    expect(all.every((r) => r.model !== '' && r.agentId === null)).toBe(true)
    const windowed = api['usage:summary']!([150, undefined]) as Array<Record<string, unknown>>
    expect(windowed.map((r) => r.model)).toEqual(['altro'])
  })
})

describe('models:capabilities (K3): le capacità di UN modello, senza elenco completo', () => {
  let ollama: Server
  let oport = 0
  const showHits: string[] = []

  // un Ollama FINTO su 127.0.0.1: /api/show risponde capability SENZA vision
  beforeAll(async () => {
    ollama = createServer((req, res) => {
      showHits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }))
    })
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve))
    oport = (ollama.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((resolve) => ollama.close(() => resolve())))
  beforeEach(() => resetOllamaCapabilities())
  afterEach(() => vi.unstubAllGlobals())

  it('provider di CATALOGO: NESSUNA rete (il fetch finto fa fallire il test se viene chiamato)', async () => {
    saveProviders([groqAt('https://api.groq.com/openai')])
    const fetchFinto = vi.fn(async () => { throw new Error('rete NON attesa: models:capabilities non chiama il vivo') })
    vi.stubGlobal('fetch', fetchFinto)
    const caps = await api['models:capabilities']!(['g-live', 'llama-3.3-70b-versatile']) as ModelCapabilities
    expect(fetchFinto).not.toHaveBeenCalled()
    expect(caps.fromCatalog).toBe(true)
    expect(caps.vision).toBe(false) // il flag del catalogo, senza leggere il vivo
    expect(caps.thinkingLevels).toEqual([]) // modello non-reasoning: non controllabile
  })

  it('ollama finto: vision FALSE letta dalla /api/show; UNA sola lettura per due chiamate di fila', async () => {
    saveProviders([{ id: 'o-k3', name: 'Ollama', kind: 'ollama', baseUrl: `http://127.0.0.1:${oport}`, apiKey: '', enabled: true }])
    const c1 = await api['models:capabilities']!(['o-k3', 'kimi-k3:cloud']) as ModelCapabilities
    const c2 = await api['models:capabilities']!(['o-k3', 'kimi-k3:cloud']) as ModelCapabilities
    expect(showHits).toEqual(['/api/show']) // la cache ha evitato la seconda
    expect(c1.vision).toBe(false)
    expect(c1.tools).toBe(true)
    expect(c2.vision).toBe(false)
  })

  it('ollama SPENTO: vision null ENTRO 2 s (lettura fallita o scaduta, errori ignorati)', async () => {
    saveProviders([{ id: 'o-off', name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', apiKey: '', enabled: true }])
    const t0 = Date.now()
    const caps = await api['models:capabilities']!(['o-off', 'kimi-k3:cloud']) as ModelCapabilities
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(caps.vision).toBeNull()
    expect(caps.tools).toBeNull()
  })

  it('provider inesistente → uiError', async () => {
    await expect(api['models:capabilities']!(['manca', 'm'])).rejects.toThrow()
  })
})
