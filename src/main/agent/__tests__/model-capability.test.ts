// Fase 9 (punto 1) — capability "tools" prima di assegnare un modello:
// Ollama la espone in /api/show; gli altri provider non sono controllabili.
// Il fetch è stubbato: nessuna rete.
import { describe, expect, it, afterEach, vi } from 'vitest'
import { modelSupportsTools } from '../providers'

const ollama = { id: 'ollama', name: 'Ollama (locale)', kind: 'ollama' as const, baseUrl: 'http://ollama.test', apiKey: '', enabled: true }
const openai = { id: 'oa', name: 'OpenAI', kind: 'openai-compatible' as const, baseUrl: 'https://api.test', apiKey: 'k', enabled: true }

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): void => {
  vi.stubGlobal('fetch', vi.fn(impl))
}
afterEach(() => vi.unstubAllGlobals())

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
