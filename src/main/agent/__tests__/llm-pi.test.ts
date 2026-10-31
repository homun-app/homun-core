// Fase 18a (E6): i test dell'adattatore @earendil-works/pi-ai dietro llmStream.
// Tutto gira col provider FINTO di pi-ai (fauxProvider): nessuna rete, nessun
// modello vero. Gli unici socket aperti sono su 127.0.0.1 (il server HTTP finto
// del test della chiave). Le chiavi sono FINTIE (sk-test-…).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxProviderHandle,
  type Models
} from '@earendil-works/pi-ai'
import type { ProviderConfig } from '../../../shared/types'
import { streamPi, toPiContext, openAiCompatBase, ZAI_CONSUMPTION_BASE_URL, piModelFor, piCacheEntryFor, modelCapabilities, FAUX_TEST_PROVIDER_ID, fauxTestHandle, LlmProviderError, PiUserAbortError, type PiStreamMeta } from '../llm-pi'
import { llmStream } from '../llm'
import { fallbackEligible } from '../model-fallback'
import { stopReasonOfError } from '../loop-guard'

/** Una Models collection col solo provider faux (come farebbe il core). */
function fauxModels(handle: FauxProviderHandle): Models {
  const models = createModels({ credentials: new InMemoryCredentialStore() })
  models.setProvider(handle.provider)
  return models
}

const CATALOG_META: PiStreamMeta = { fromCatalog: true, local: false }
const drain = async (s: AsyncIterable<{ textDelta?: string }>): Promise<string> => {
  let acc = ''
  for await (const ch of s) if (ch.textDelta) acc += ch.textDelta
  return acc
}

describe('fase 18a (E6): streaming di testo — i chunk escono uno per uno', () => {
  it('il testo arriva in chunk incrementali e l\'ultimo porta finishReason', async () => {
    const handle = fauxProvider({ tokensPerSecond: 2000 })
    handle.setResponses([fauxAssistantMessage('una risposta abbastanza lunga da essere spezzata in piu pezzi')])
    const models = fauxModels(handle)
    const chunks: string[] = []
    let final: { finishReason?: string } | undefined
    for await (const ch of streamPi(models, handle.getModel() as never, CATALOG_META, [{ role: 'user', content: 'x' }], [], new AbortController().signal)) {
      if (ch.textDelta) chunks.push(ch.textDelta)
      if (ch.finishReason) final = ch
    }
    expect(chunks.length).toBeGreaterThan(1) // spezzata, non un blocco unico
    expect(chunks.join('')).toBe('una risposta abbastanza lunga da essere spezzata in piu pezzi')
    expect(final?.finishReason).toBe('stop')
  })
})

describe('fase 18a (E6): il thinking diventa reasoningDelta', () => {
  it('i thinking block escono come reasoningDelta, il testo come textDelta', async () => {
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage([fauxThinking('primo il ragionamento'), fauxText('la risposta')])])
    const models = fauxModels(handle)
    let reasoning = ''
    let text = ''
    for await (const ch of streamPi(models, handle.getModel() as never, CATALOG_META, [{ role: 'user', content: 'x' }], [], new AbortController().signal)) {
      if (ch.reasoningDelta) reasoning += ch.reasoningDelta
      if (ch.textDelta) text += ch.textDelta
    }
    expect(reasoning).toBe('primo il ragionamento')
    expect(text).toBe('la risposta')
  })
})

describe('fase 18a (E6): le tool call escono TUTTE alla fine, in ordine, con arguments JSON', () => {
  it('due tool call: un solo chunk finale con toolCalls ordinati per contentIndex', async () => {
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage([
      fauxToolCall('run-command', { command: 'ls' }, { id: 'call_a' }),
      fauxText('pensiero intermedio'),
      fauxToolCall('read-file', { path: '/x' }, { id: 'call_b' })
    ], { stopReason: 'toolUse' })])
    const models = fauxModels(handle)
    const withCalls: unknown[] = []
    let finalFinish = ''
    for await (const ch of streamPi(models, handle.getModel() as never, CATALOG_META, [{ role: 'user', content: 'x' }], [], new AbortController().signal)) {
      if (ch.toolCalls) withCalls.push(ch.toolCalls)
      if (ch.finishReason) finalFinish = ch.finishReason
    }
    expect(withCalls).toHaveLength(1) // solo alla fine, come oggi
    expect(withCalls[0]).toEqual([
      { id: 'call_a', name: 'run-command', arguments: '{"command":"ls"}' },
      { id: 'call_b', name: 'read-file', arguments: '{"path":"/x"}' }
    ])
    // toolUse → 'tool_calls', il valore di sempre del loop
    expect(finalFinish).toBe('tool_calls')
  })
})

describe('fase 18a (E6): usage e costUsd nel chunk finale', () => {
  it('usage con token contati dal faux; costUsd 0 (catalogo, non locale)', async () => {
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage('risposta con qualche token')])
    const models = fauxModels(handle)
    let usage: { input: number; output: number; costUsd: number | null } | undefined
    for await (const ch of streamPi(models, handle.getModel() as never, CATALOG_META, [{ role: 'user', content: 'domanda con qualche token' }], [], new AbortController().signal)) {
      if (ch.usage) usage = ch.usage
    }
    expect(usage).toBeTruthy()
    expect(usage!.input).toBeGreaterThan(0)
    expect(usage!.output).toBeGreaterThan(0)
    expect(usage!.costUsd).toBe(0) // dal "catalogo" faux, costo zero, non locale
  })

  it('costUsd null fuori catalogo (modello sintetico) e per locale a costo zero', async () => {
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage('x'), fauxAssistantMessage('x')])
    const models = fauxModels(handle)
    const it1 = streamPi(models, handle.getModel() as never, { fromCatalog: false, local: false }, [{ role: 'user', content: 'x' }], [], new AbortController().signal)
    const it2 = streamPi(models, handle.getModel() as never, { fromCatalog: true, local: true }, [{ role: 'user', content: 'x' }], [], new AbortController().signal)
    let u1: { costUsd: number | null } | undefined
    let u2: { costUsd: number | null } | undefined
    for await (const ch of it1) if (ch.usage) u1 = ch.usage
    for await (const ch of it2) if (ch.usage) u2 = ch.usage
    expect(u1!.costUsd).toBeNull()
    expect(u2!.costUsd).toBeNull()
  })
})

describe('fase 18a (E6): abort a metà stream — lo stesso errore di oggi', () => {
  it('signal abortito tra due delta → APIUserAbortError ("Request was aborted.")', async () => {
    const handle = fauxProvider({ tokensPerSecond: 30 }) // chunk lenti
    handle.setResponses([fauxAssistantMessage('testo lunghissimo che esce pian piano per lasciare il tempo di abortire a metà')])
    const models = fauxModels(handle)
    const controller = new AbortController()
    const stream = streamPi(models, handle.getModel() as never, CATALOG_META, [{ role: 'user', content: 'x' }], [], controller.signal)
    let sawChunk = false
    await expect((async () => {
      for await (const ch of stream) {
        if (ch.textDelta && !sawChunk) {
          sawChunk = true
          controller.abort()
        }
      }
    })()).rejects.toSatisfy((e: unknown) => e instanceof PiUserAbortError && e.name === 'APIUserAbortError' && e.message === 'Request was aborted.')
    expect(sawChunk).toBe(true)
  })
})

describe('fase 18a (E2.5): lo stato HTTP non si perde (fallback e limite d\'uso)', () => {
  const errOf = async (errorMessage: string, stopReason: 'error' = 'error'): Promise<unknown> => {
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage([], { stopReason, errorMessage })])
    const models = fauxModels(handle)
    const stream = streamPi(models, handle.getModel() as never, CATALOG_META, [{ role: 'user', content: 'x' }], [], new AbortController().signal)
    try {
      for await (const _ of stream) void _ // eslint-disable-line @typescript-eslint/no-unused-vars
      return new Error('nessun errore')
    } catch (e) {
      return e
    }
  }

  it('503 → LlmProviderError con status 503 → fallbackEligible true', async () => {
    const e = await errOf('503 Service Unavailable: upstream overloaded') as LlmProviderError
    expect(e).toBeInstanceOf(LlmProviderError)
    expect(e.status).toBe(503)
    expect(fallbackEligible(e)).toBe(true)
  })

  it('429 → stopReasonOfError rate-limit (il gruppo si sospende)', async () => {
    const e = await errOf('429 Rate limit exceeded: too many requests') as LlmProviderError
    expect(e.status).toBe(429)
    expect(stopReasonOfError(e)).toBe('rate-limit')
    expect(fallbackEligible(e)).toBe(false) // 4xx: mai riserva
  })

  it('400 → nessuna riserva (richiesta sbagliata)', async () => {
    const e = await errOf('400 Bad Request: invalid model') as LlmProviderError
    expect(e.status).toBe(400)
    expect(fallbackEligible(e)).toBe(false)
  })

  it('ECONNREFUSED senza stato → riserva (il messaggio resta com\'è)', async () => {
    const e = await errOf('fetch failed: connect ECONNREFUSED 127.0.0.1:11434') as LlmProviderError
    expect(e.status).toBeUndefined()
    expect(e.message).toContain('ECONNREFUSED')
    expect(fallbackEligible(e)).toBe(true)
  })

  it('lo status si legge anche nella forma "(503)" dei prefissi dei provider', () => {
    expect(new LlmProviderError('Anthropic (503): overloaded').status).toBe(503)
  })
})

describe('fase 18a (E2.1): zai MAI su /coding/ e i base URL dei compatibili', () => {
  const zai = (baseUrl: string): ProviderConfig =>
    ({ id: 'z1', name: 'Z.ai', kind: 'zai', baseUrl, apiKey: 'sk-test-zai', enabled: true })

  it('zai finisce sempre sull\'API a consumo, qualunque url salvato', () => {
    for (const base of ['https://api.z.ai', 'https://api.z.ai/v1', 'https://api.z.ai/api/paas/v4', 'https://api.z.ai/api/coding/paas/v4']) {
      const m = piModelFor(zai(base), 'glm-5.3')
      expect(m.baseUrl).toBe(ZAI_CONSUMPTION_BASE_URL)
      expect(m.baseUrl).not.toContain('/coding/')
    }
  })

  it('ollama/custom: /v1 si appende SOLO se non c\'è già un /v<n> o /api/paas/v4', () => {
    expect(openAiCompatBase({ baseUrl: 'http://localhost:11434' })).toBe('http://localhost:11434/v1')
    expect(openAiCompatBase({ baseUrl: 'http://localhost:11434/' })).toBe('http://localhost:11434/v1')
    expect(openAiCompatBase({ baseUrl: 'http://127.0.0.1:9999/v1' })).toBe('http://127.0.0.1:9999/v1')
    expect(openAiCompatBase({ baseUrl: 'http://127.0.0.1:9999/v2' })).toBe('http://127.0.0.1:9999/v2')
    expect(openAiCompatBase({ baseUrl: 'https://api.z.ai/api/paas/v4' })).toBe('https://api.z.ai/api/paas/v4')
    // lo stesso vale per il modello sintetico di un provider custom/ollama
    const ollama: ProviderConfig = { id: 'o1', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', enabled: true }
    expect(piModelFor(ollama, 'kimi-k3:cloud').baseUrl).toBe('http://localhost:11434/v1')
    const custom: ProviderConfig = { id: 'c1', name: 'Custom', kind: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', enabled: true }
    expect(piModelFor(custom, 'm').baseUrl).toBe('http://127.0.0.1:8080/v1')
  })

  it('il provider openai con url noto resta sul baseUrl del catalogo (es. groq …/openai/v1)', () => {
    const groq: ProviderConfig = { id: 'g1', name: 'Groq', kind: 'groq', baseUrl: 'https://api.groq.com/openai', apiKey: 'sk-test-groq', enabled: true }
    const entry = piCacheEntryFor(groq)
    const someId = [...entry.catalogIds][0]!
    expect(piModelFor(groq, someId).baseUrl).toBe('https://api.groq.com/openai/v1')
  })

  it('le capacità del modello: catalogo (groq) e sintetico (ollama)', () => {
    const groq: ProviderConfig = { id: 'g2', name: 'Groq', kind: 'groq', baseUrl: 'https://api.groq.com/openai', apiKey: 'sk-test-groq', enabled: true }
    const entry = piCacheEntryFor(groq)
    const someId = [...entry.catalogIds][0]!
    const caps = modelCapabilities(groq, someId)
    expect(caps.fromCatalog).toBe(true)
    expect(caps.contextWindow).toBeGreaterThan(0)
    expect(caps.cost).toBeTruthy()
    const ollama: ProviderConfig = { id: 'o2', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', enabled: true }
    const local = modelCapabilities(ollama, 'kimi-k3:cloud')
    expect(local.fromCatalog).toBe(false)
    expect(local.cost).toBeNull() // locale: costo sconosciuto
    expect(local.contextWindow).toBe(128_000)
  })
})

describe('fase 18a (E2.3): la conversione dei messaggi (qui i casi del file)', () => {
  it('system multipli, immagini e toolResult con toolName', () => {
    const c = toPiContext([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'guarda', images: ['QUJD'] },
      { role: 'assistant', content: '', toolCalls: [{ id: 't9', name: 'run-command', arguments: '{"command":"ls"}' }] },
      { role: 'tool', toolCallId: 't9', content: 'ok' },
      { role: 'tool', toolCallId: 'ghost', content: 'orfano' }
    ], [], { api: 'openai-completions', provider: 'p', model: 'm' })
    expect(c.systemPrompt).toBe('A\n\nB')
    const u = c.messages[0] as unknown as { content: unknown[] }
    expect(u.content).toEqual([
      { type: 'text', text: 'guarda' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' }
    ])
    const r = c.messages[2] as unknown as { toolName: string }
    const orphan = c.messages[3] as unknown as { toolName: string }
    expect(r.toolName).toBe('run-command')
    expect(orphan.toolName).toBe('unknown')
  })
})

describe('fase 18a (E2.2): le variabili d\'ambiente NON si usano mai', () => {
  let server: Server
  let port: number
  const seen: Array<{ auth: string | undefined; userAgent: string | undefined; body?: unknown }> = []

  // un server HTTP FINTO su 127.0.0.1: guarda gli header (e il body) della
  // richiesta e risponde in SSE come /v1/chat/completions. Verifica che la
  // chiave esplicita arriva come Bearer e che quella d'ambiente NON esce mai
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, userAgent: req.headers['user-agent'], body: raw ? JSON.parse(raw) : undefined })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }),
        '',
        'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        '',
        'data: [DONE]',
        ''
      ].join('\n'))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('la chiave esplicita diventa Bearer; quella in OPENAI_API_KEY non esce mai', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-env'
    try {
      // provider openai SENZA chiave: la richiesta fallisce prima della rete,
      // e né l'errore né la variabile d'ambiente compaiono da nessuna parte
      const keyless: ProviderConfig = { id: 'nokey', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', enabled: true }
      let keylessError = ''
      try {
        await drain(llmStream(keyless, 'gpt-5.2', [{ role: 'user', content: 'x' }], [], new AbortController().signal))
      } catch (e) {
        keylessError = e instanceof Error ? e.message : String(e)
      }
      expect(keylessError).toBeTruthy()
      expect(keylessError).not.toContain('sk-test-env')

      // provider custom con chiave ESPPLICITA verso il server finto: Bearer giusto
      seen.length = 0
      const explicit: ProviderConfig = { id: 'explicit', name: 'Locale', kind: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-explicit', enabled: true }
      const text = await drain(llmStream(explicit, 'fake-local-model', [{ role: 'user', content: 'x' }], [], new AbortController().signal))
      expect(text).toBe('ok')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.auth).toBe('Bearer sk-test-explicit')

      // lo stesso provider SENZA chiave: 'not-needed' (come l'adattatore di
      // sempre), MAI la variabile d'ambiente
      seen.length = 0
      const keylessLocal: ProviderConfig = { id: 'keyless-local', name: 'Locale', kind: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', enabled: true }
      await drain(llmStream(keylessLocal, 'fake-local-model', [{ role: 'user', content: 'x' }], [], new AbortController().signal))
      expect(seen[0]!.auth).toBe('Bearer not-needed')
      expect(seen[0]!.auth).not.toContain('sk-test-env')
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })

  it('lo User-Agent è solo "Homun": niente piattaforma né architettura', async () => {
    seen.length = 0
    const local: ProviderConfig = { id: 'ua', name: 'Locale', kind: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-ua', enabled: true }
    await drain(llmStream(local, 'fake-local-model', [{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(seen[0]!.userAgent).toBe('Homun')
  })

  it('E2.6: la temperatura passa quando c\'è (auto-review a 0), assente altrimenti', async () => {
    seen.length = 0
    const local: ProviderConfig = { id: 'temp', name: 'Locale', kind: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test-temp', enabled: true }
    const tools = [{ name: 'run-command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]
    await drain(llmStream(local, 'fake-local-model', [{ role: 'user', content: 'x' }], tools, new AbortController().signal, { temperature: 0 }))
    await drain(llmStream(local, 'fake-local-model', [{ role: 'user', content: 'x' }], tools, new AbortController().signal))
    const withTemp = seen[0]!.body as Record<string, unknown>
    const noTemp = seen[1]!.body as Record<string, unknown>
    expect(withTemp.temperature).toBe(0)
    expect('temperature' in noTemp).toBe(false)
    // e lo schema del tool arriva intatto nel payload (E2.3: TypeBox è JSON Schema)
    expect(withTemp.tools).toEqual([{
      type: 'function',
      function: { name: 'run-command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
    }])
  })
})

describe('fase 18a (E2): llm-pi.ts è l\'unico file che importa pi-ai', () => {
  it('nessun altro sorgente in src/ (fuori dai test) importa @earendil-works/pi-ai', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { relative } = await import('node:path')
    const root = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/\/$/, '')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const f of readdirSync(dir)) {
        if (f === '__tests__' || f === 'node_modules' || f === 'out' || f === 'dist' || f === 'locales') continue
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
      }
      return out
    }
    const offenders = walk(join(root, 'src'))
      // solo gli IMPORT (il nome tra apici), non i commenti che lo citano
      .map((p) => /['"]@earendil-works\/pi-ai/.test(readFileSync(p, 'utf8')) ? p : null)
      .filter((p): p is string => p !== null)
      .map((p) => relative(root, p))
    expect(offenders).toEqual(['src/main/agent/llm-pi.ts'])
  })
})

describe('fase 18a (E4): uso registrato (model_usage) — un turno VERO col faux', () => {
  let dir: string
  const store = {} as {
    setDataDir: (d: string) => void
    db: () => import('node:sqlite').DatabaseSync
    saveProviders: (ps: ProviderConfig[]) => void
    createAgent: (name: string) => { id: string }
    updateAgent: (id: string, patch: Record<string, unknown>) => void
    recordModelUsage: (r: import('../../store/db').ModelUsageRecord) => void
    modelUsageSummary: (fromMs?: number, toMs?: number) => import('../../store/db').ModelUsageSummaryRow[]
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sandbot-usage-'))
    const mod = await import('../../store/db')
    Object.assign(store, mod)
    store.setDataDir(dir)
    store.db()
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => store.db().exec('DELETE FROM model_usage'))

  it('un turno col provider faux registra una riga con i token del faux (source turn)', async () => {
    const fauxConfig: ProviderConfig = { id: FAUX_TEST_PROVIDER_ID, name: 'Faux', kind: 'custom', baseUrl: 'http://127.0.0.1:0', apiKey: '', enabled: true }
    store.saveProviders([fauxConfig])
    // registra (e cachea) la collection faux PRIMA di scrivere le risposte
    piCacheEntryFor(fauxConfig)
    const handle = fauxTestHandle()
    expect(handle).toBeTruthy()
    handle!.setResponses([fauxAssistantMessage([fauxToolCall('send_to_user', { text: 'pronta' }, { id: 's1' })], { stopReason: 'toolUse' })])
    const agent = store.createAgent('Usage')
    store.updateAgent(agent.id, { providerId: FAUX_TEST_PROVIDER_ID, model: 'faux-1' })
    const { runTurn } = await import('../loop')
    const events: unknown[] = []
    await runTurn(agent.id, 'prepara la giornata di test', (e) => events.push(e))
    const rows = store.db().prepare('SELECT * FROM model_usage').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent_id: agent.id,
      provider_id: FAUX_TEST_PROVIDER_ID,
      provider_kind: 'custom',
      model: 'faux-1',
      source: 'turn'
    })
    expect(rows[0]!.input as number).toBeGreaterThan(0)
    expect(rows[0]!.output as number).toBeGreaterThan(0)
  })

  it('usage:summary aggrega per provider_kind+model; il costo null resta null', () => {
    const t0 = 1_000_000
    store.recordModelUsage({ at: t0, agentId: 'a', providerId: 'p1', providerKind: 'groq', model: 'llama', source: 'turn', input: 10, output: 5, cacheRead: 2, costUsd: 0.01 })
    store.recordModelUsage({ at: t0 + 1, agentId: 'a', providerId: 'p1', providerKind: 'groq', model: 'llama', source: 'review', input: 1, output: 2, costUsd: 0.02 })
    store.recordModelUsage({ at: t0 + 2, agentId: 'a', providerId: 'o1', providerKind: 'ollama', model: 'kimi', source: 'turn', input: 7, output: 3, costUsd: null })
    const rows = store.modelUsageSummary()
    expect(rows).toHaveLength(2)
    const llama = rows.find((r) => r.model === 'llama')!
    expect(llama).toMatchObject({ providerKind: 'groq', calls: 2, input: 11, output: 7, cacheRead: 2, costUsd: 0.03 })
    // il modello locale non ha costo: null finché TUTTE le righe sono null
    const kimi = rows.find((r) => r.model === 'kimi')!
    expect(kimi.costUsd).toBeNull()
    // finestra [fromMs, toMs]: fuori non si vede
    store.recordModelUsage({ at: t0 + 5_000, agentId: 'a', providerId: 'p2', providerKind: 'openai', model: 'gpt-x', source: 'quick-ask', input: 1, output: 1, costUsd: 1 })
    expect(store.modelUsageSummary(t0 + 100).map((r) => r.model)).toEqual(['gpt-x'])
    expect(store.modelUsageSummary(undefined, t0 + 3).map((r) => r.model)).toEqual(['llama', 'kimi'])
  })

  it('senza usage non si registra niente (riga mai scritta a metà)', () => {
    // il contratto: se il chunk finale non porta usage, il chiamante non chiama
    store.recordModelUsage({ agentId: 'a', providerId: 'p', providerKind: 'custom', model: 'm', source: 'turn', input: 1, output: 1, costUsd: null })
    expect((store.db().prepare('SELECT COUNT(*) AS n FROM model_usage').get() as { n: number }).n).toBe(1)
    expect(store.modelUsageSummary()[0]!.costUsd).toBeNull()
  })
})
