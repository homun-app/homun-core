// Fase 9 (punto 1) — capability "tools" prima di assegnare un modello:
// Ollama la espone in /api/show; gli altri provider non sono controllabili.
// Fase 18b (H5.2): l'elenco VIVO corretto per kind (url e header) e la cache
// delle capability Ollama per providerId+nome+digest.
// Il fetch è stubbato: nessuna rete.
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { modelSupportsTools, listProviderModels } from '../providers'
import { liveModelsUrl, liveModelsHeaders, resetOllamaCapabilities } from '../live-models'
// fase 17c: la lingua dell'interfaccia dei test è l'italiano (i testi erano italiani prima)
import { setSetting } from '../../store/db'
setSetting('ui.activeLanguage', 'it')

const ollama = { id: 'ollama', name: 'Ollama (locale)', kind: 'ollama' as const, baseUrl: 'http://ollama.test', apiKey: '', enabled: true }
const openai = { id: 'oa', name: 'OpenAI', kind: 'openai-compatible' as const, baseUrl: 'https://api.test', apiKey: 'k', enabled: true }

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal('fetch', vi.fn(impl))
}
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => resetOllamaCapabilities())

describe('modelSupportsTools', () => {
  it('Ollama con capabilities ["tools"] → ok', async () => {
    stubFetch(async () => new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), { status: 200 }))
    expect(await modelSupportsTools(ollama, 'kimi-k3:cloud')).toEqual({ ok: true, checked: true })
  })

  it('Ollama SENZA "tools" → non ok, errore leggibile (non si assegna)', async () => {
    stubFetch(async () => new Response(JSON.stringify({ capabilities: ['completion', 'embedding'] }), { status: 200 }))
    const r = await modelSupportsTools(ollama, 'emb-only')
    expect(r.ok).toBe(false)
    expect(r.checked).toBe(true)
    expect(r.error).toContain('non supporta i tool')
    expect(r.error).toContain('emb-only')
  })

  it('Ollama che risponde male o non raggiungibile → non ok con il perché', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }))
    expect((await modelSupportsTools(ollama, 'x')).error).toContain('HTTP 500')
    stubFetch(async () => { throw new Error('fetch failed') })
    expect((await modelSupportsTools(ollama, 'x')).error).toContain('fetch failed')
  })

  it('provider non-Ollama: nessun controllo possibile (checked false, ok true)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await modelSupportsTools(openai, 'gpt-x')).toEqual({ ok: true, checked: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('la richiesta va a /api/show con il nome del modello nel corpo', async () => {
    let body = ''
    stubFetch(async (_url, init) => {
      body = String(init?.body)
      return new Response(JSON.stringify({ capabilities: ['tools'] }), { status: 200 })
    })
    await modelSupportsTools(ollama, 'kimi-k3:cloud')
    expect(body).toContain('"model":"kimi-k3:cloud"')
  })
})

// ---- fase 18b (H5.2): l'elenco vivo, corretto per kind ----

describe('liveModelsUrl / liveModelsHeaders (H5.2)', () => {
  it('zai finisce SEMPRE sull\'API a consumo, MAI su /coding/ (anche con url vecchi salvati)', () => {
    for (const base of ['https://api.z.ai', 'https://api.z.ai/v1', 'https://api.z.ai/api/paas/v4', 'https://api.z.ai/api/coding/paas/v4']) {
      const url = liveModelsUrl({ kind: 'zai', baseUrl: base })
      expect(url).toBe('https://api.z.ai/api/paas/v4/models')
      expect(url).not.toContain('/coding/')
    }
    expect(liveModelsHeaders({ kind: 'zai', apiKey: 'sk-test-zai' })).toEqual({ Authorization: 'Bearer sk-test-zai' })
  })

  it('anthropic: /v1/models con x-api-key e anthropic-version (il vecchio Bearer era rotto, H0)', () => {
    expect(liveModelsUrl({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/' })).toBe('https://api.anthropic.com/v1/models')
    const h = liveModelsHeaders({ kind: 'anthropic', apiKey: 'sk-test-anthropic' })
    expect(h).toEqual({ 'x-api-key': 'sk-test-anthropic', 'anthropic-version': '2023-06-01' })
    expect(Object.keys(h)).not.toContain('Authorization')
  })

  it('ollama: /api/tags (le capability arrivano da /api/show, a parte)', () => {
    expect(liveModelsUrl({ kind: 'ollama', baseUrl: 'http://localhost:11434' })).toBe('http://localhost:11434/api/tags')
  })

  it('gli altri: {base OpenAI-compatible}/models con Bearer se c\'è la chiave', () => {
    expect(liveModelsUrl({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999' })).toBe('http://127.0.0.1:9999/v1/models')
    expect(liveModelsUrl({ kind: 'mistral', baseUrl: 'https://api.mistral.ai' })).toBe('https://api.mistral.ai/v1/models')
    expect(liveModelsHeaders({ kind: 'mistral', apiKey: 'sk-test' })).toEqual({ Authorization: 'Bearer sk-test' })
    expect(liveModelsHeaders({ kind: 'mistral', apiKey: '' })).toEqual({})
  })
})

describe('listProviderModels (H5.2)', () => {
  it('ollama: /api/tags poi /api/show per le capability; la cache per digest evita le riletture', async () => {
    const urls: string[] = []
    stubFetch(async (url, init) => {
      urls.push(String(url))
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({
          models: [
            { name: 'kimi-k3:cloud', digest: 'd1', details: { parameter_size: '48B' } },
            { name: 'glm-5.3:cloud', digest: 'd2' }
          ]
        }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as { model: string }
      return new Response(JSON.stringify({ capabilities: body.model === 'kimi-k3:cloud' ? ['completion', 'tools', 'vision'] : ['completion', 'tools'] }), { status: 200 })
    })
    const out = await listProviderModels(ollama)
    expect(out.map((m) => m.id)).toEqual(['kimi-k3:cloud', 'glm-5.3:cloud'])
    expect(out[0]).toMatchObject({ source: 'live', vision: true, tools: true, thinkingLevels: [], cost: null, costSource: null, local: true })
    expect(out[0]!.label).toContain('48B')
    expect(out[1]).toMatchObject({ vision: false, tools: true })
    expect(urls.filter((u) => u.endsWith('/api/show'))).toHaveLength(2)
    // seconda lettura con lo STESSO digest: la cache serve, /api/show non si rifà
    urls.length = 0
    await listProviderModels(ollama)
    expect(urls).toEqual(['http://ollama.test/api/tags'])
    // un modello AGGIORNATO (digest nuovo) rilegge le capability: ora dichiara
    // solo 'completion' → vision/tools conosciuti FALSI (non più le vecchie)
    stubFetch(async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'kimi-k3:cloud', digest: 'd1-NUOVO' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ capabilities: ['completion'] }), { status: 200 })
    })
    const updated = await listProviderModels(ollama)
    expect(updated[0]).toMatchObject({ vision: false, tools: false })
  })

  it('al massimo 4 /api/show in parallelo', async () => {
    let inFlight = 0
    let maxInFlight = 0
    stubFetch(async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({
          models: [1, 2, 3, 4, 5, 6].map((i) => ({ name: `m${i}`, digest: `d${i}` }))
        }), { status: 200 })
      }
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return new Response(JSON.stringify({ capabilities: ['tools'] }), { status: 200 })
    })
    const out = await listProviderModels(ollama)
    expect(out).toHaveLength(6)
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('anthropic: la richiesta porta x-api-key e anthropic-version (sul filo)', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null
    stubFetch(async (url, init) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }
      return new Response(JSON.stringify({ data: [{ id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }] }), { status: 200 })
    })
    const anthropic = { id: 'an', name: 'Anthropic', kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', apiKey: 'sk-test-anthropic', enabled: true }
    const out = await listProviderModels(anthropic)
    expect(seen!.url).toBe('https://api.anthropic.com/v1/models')
    expect(seen!.headers).toEqual({ 'x-api-key': 'sk-test-anthropic', 'anthropic-version': '2023-06-01' })
    expect(out[0]).toMatchObject({ id: 'claude-opus-4-7', label: 'Claude Opus 4.7', source: 'live', vision: null, tools: null, local: false })
  })

  it('modelSupportsTools usa la STESSA cache di /api/show (niente seconda chiamata)', async () => {
    let shows = 0
    stubFetch(async (url) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'kimi-k3:cloud', digest: 'd1' }] }), { status: 200 })
      }
      shows++
      return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), { status: 200 })
    })
    await listProviderModels(ollama)
    expect(shows).toBe(1)
    // dal cache: stessa risposta, NESSUN'altra chiamata a /api/show
    expect(await modelSupportsTools(ollama, 'kimi-k3:cloud')).toEqual({ ok: true, checked: true })
    expect(shows).toBe(1)
    // un modello mai elencato: /api/show si fa e finisce in cache
    expect(await modelSupportsTools(ollama, 'altro:model')).toEqual({ ok: true, checked: true })
    expect(shows).toBe(2)
    expect(await modelSupportsTools(ollama, 'altro:model')).toEqual({ ok: true, checked: true })
    expect(shows).toBe(2)
  })
})
