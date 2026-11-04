// Fase velocità — test di S1 (traccia: SOLO numeri e nomi), S2 (il
// ragionamento di Ollama letto da /api/show e mandato sul filo come
// reasoning_effort) e S4 (la chiave di sessione stabile). Il filo si prova
// con un server OpenAI-compatible FINTO su 127.0.0.1: nessun Ollama vero,
// nessun modello cloud.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  InMemoryCredentialStore,
  createModels,
  type FauxProviderHandle,
  type Models
} from '@earendil-works/pi-ai'
import type { ProviderConfig } from '../../../shared/types'
import type { ChatMessage } from '../llm'
import { TEST_TMP_BASE } from '../../../test-tmp'
// fase 17c: la lingua dell'interfaccia dei test è l'italiano
import { setSetting, setDataDir, dataDir } from '../../store/db'
setSetting('ui.activeLanguage', 'it')
import { streamPi, piLlmStream, modelCapabilities, piModelFor, ollamaOfferedLevels, type PiStreamMeta } from '../llm-pi'
import { resetOllamaCapabilities, setOllamaCapabilities, ollamaCapabilities, ollamaThinkingLevels, ollamaThinkingInfo, readOllamaCapabilities, parseOllamaShow } from '../live-models'

function fauxModels(handle: FauxProviderHandle): Models {
  const models = createModels({ credentials: new InMemoryCredentialStore() })
  models.setProvider(handle.provider)
  return models
}
const META: PiStreamMeta = { fromCatalog: true, local: false }
const drain = async (s: AsyncIterable<{ textDelta?: string }>): Promise<string> => {
  let acc = ''
  for await (const ch of s) if (ch.textDelta) acc += ch.textDelta
  return acc
}

// ---- S1: la traccia di ogni chiamata ----

describe('S1: la traccia (SANDBOT_LLM_TRACE=1) porta i numeri di OGNI chiamata', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-trace-'))
    setDataDir(dir)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(() => { delete process.env.SANDBOT_LLM_TRACE })
  beforeEach(() => { try { rmSync(join(dataDir(), 'llm-trace.jsonl')) } catch { /* non c'è */ } })

  const traceLines = (): Array<Record<string, unknown>> =>
    readFileSync(join(dataDir(), 'llm-trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

  it('turnId/callIndex, tempi, byte, thinkingSent e usage con cache; MAI contenuti', async () => {
    process.env.SANDBOT_LLM_TRACE = '1'
    const handle = fauxProvider({ tokensPerSecond: 2000 })
    // prima il ragionamento, poi il testo: reasoningFirstMs c'è
    handle.setResponses([fauxAssistantMessage([fauxThinking('penso un attimo'), fauxText('risposta')])])
    const models = fauxModels(handle)
    const tools = [{ name: 'run-command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }]
    const messages = [
      { role: 'system', content: 'sei un bot di test' },
      { role: 'user', content: 'ciao' }
    ]
    const text = await drain(streamPi(models, handle.getModel() as never, META, messages as never, tools as never, new AbortController().signal, {
      trace: { turnId: 't-1', callIndex: 0 },
      sessionId: 'agent_x:agent_x',
      thinking: 'off'
    }))
    expect(text).toBe('risposta')
    const rec = traceLines().at(-1)!
    // il turno e l'indice della chiamata
    expect(rec.turnId).toBe('t-1')
    expect(rec.callIndex).toBe(0)
    // i tempi: dal primo token alla fine tutto positivo e coerente
    expect(rec.firstTokenMs).toEqual(expect.any(Number))
    expect(rec.totalMs as number).toBeGreaterThanOrEqual(rec.firstTokenMs as number)
    expect(rec.reasoningFirstMs).toEqual(rec.firstTokenMs) // il primo chunk era ragionamento
    expect(rec.reasoningChars).toBeUndefined() // c'è reasoningLength, non il duplicato
    expect(rec.reasoningLength).toBe('penso un attimo'.length)
    // gli strumenti e i byte sul filo (solo numeri, mai schemi)
    expect(rec.toolsCount).toBe(1)
    expect(rec.toolsBytes).toEqual(JSON.stringify(tools).length)
    expect(rec.systemBytes).toBe('sei un bot di test'.length)
    expect(rec.messagesBytes).toEqual(JSON.stringify(messages.filter((m) => m.role !== 'system')).length)
    // cosa è partito per il ragionamento e l'hash corto della sessione
    expect(rec.thinkingSent).toBeNull() // modello faux non-ollama: 'off' = nessuna opzione
    expect(rec.sessionHash).toEqual(expect.any(String))
    expect((rec.sessionHash as string).length).toBe(8)
    expect(JSON.stringify(rec)).not.toContain('sei un bot di test')
    expect(JSON.stringify(rec)).not.toContain('risposta')
    expect(JSON.stringify(rec)).not.toContain('agent_x')
  })

  it('senza opzioni di traccia (compaction, revisore): turnId e callIndex nulli', async () => {
    process.env.SANDBOT_LLM_TRACE = '1'
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage('fuori turno')])
    await drain(streamPi(fauxModels(handle), handle.getModel() as never, META, [{ role: 'user', content: 'x' }], [], new AbortController().signal))
    const rec = traceLines().at(-1)!
    expect(rec.turnId).toBeNull()
    expect(rec.callIndex).toBeNull()
    expect(rec.sessionHash).toBeNull()
  })

  it('la traccia resta spenta senza SANDBOT_LLM_TRACE=1', async () => {
    delete process.env.SANDBOT_LLM_TRACE
    const handle = fauxProvider()
    handle.setResponses([fauxAssistantMessage('niente traccia')])
    await drain(streamPi(fauxModels(handle), handle.getModel() as never, META, [{ role: 'user', content: 'x' }], [], new AbortController().signal))
    expect(existsSync(join(dataDir(), 'llm-trace.jsonl'))).toBe(false)
  })
})

// ---- S2: il ragionamento di Ollama letto da /api/show ----

describe('S2: ollamaThinkingLevels — i quattro casi della documentazione', () => {
  it('values con nomi: i nomi che coincidono, più off se c\'è false o "none"', () => {
    expect(ollamaThinkingLevels({ values: ['low', 'medium', 'high', false], default: 'high' }))
      .toEqual({ levels: ['off', 'low', 'medium', 'high'], reasoning: true })
    // senza false: niente off
    expect(ollamaThinkingLevels({ values: ['low', 'high'] }))
      .toEqual({ levels: ['low', 'high'], reasoning: true })
    // "none" vale come spento
    expect(ollamaThinkingLevels({ values: ['medium', 'none'] }))
      .toEqual({ levels: ['off', 'medium'], reasoning: true })
  })
  it('values solo booleani [true, false]: spento/acceso come zai', () => {
    expect(ollamaThinkingLevels({ values: [true, false] }))
      .toEqual({ levels: ['off', 'high'], reasoning: true })
  })
  it('[false]: il modello non ragiona', () => {
    expect(ollamaThinkingLevels({ values: [false] }))
      .toEqual({ levels: [], reasoning: false })
  })
  it('oggetto assente: come oggi, nessun livello', () => {
    expect(ollamaThinkingLevels(null)).toEqual({ levels: [], reasoning: false })
    expect(ollamaThinkingLevels(undefined)).toEqual({ levels: [], reasoning: false })
  })
})

describe('S2: parseOllamaShow e la cache (thinking insieme alle caps)', () => {
  beforeEach(() => resetOllamaCapabilities())
  it('parse: caps stringhe, thinking con values puliti e default', () => {
    const { caps, thinking } = parseOllamaShow({ capabilities: ['tools', 'vision'], thinking: { values: ['low', 'medium', false, 42], default: 'medium' } })
    expect(caps).toEqual(['tools', 'vision'])
    expect(thinking).toEqual({ values: ['low', 'medium', false], default: 'medium' })
    // thinking malformato o assente → null (le caps restano)
    expect(parseOllamaShow({ capabilities: ['tools'] }).thinking).toBeNull()
    expect(parseOllamaShow({ capabilities: ['tools'], thinking: { values: 'nope' } }).thinking).toBeNull()
  })
  it('readOllamaCapabilities legge anche thinking; una cache vecchia senza thinking si rilegge', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      return new Response(JSON.stringify({ capabilities: ['tools'], thinking: { values: ['low', 'medium', 'high', false], default: 'high' } }), { status: 200 })
    }))
    const p = { id: 'ollama-r', baseUrl: 'http://127.0.0.1:1' }
    const r1 = await readOllamaCapabilities(p, 'kimi')
    expect(calls).toBe(1)
    expect(r1.thinking).toEqual({ values: ['low', 'medium', 'high', false], default: 'high' })
    // in cache: NESSUNA nuova chiamata
    await readOllamaCapabilities(p, 'kimi')
    expect(calls).toBe(1)
    expect(ollamaThinkingInfo('ollama-r', 'kimi')).toEqual({ values: ['low', 'medium', 'high', false], default: 'high' })
    // una voce cache VECCHIA senza thinking (scritta da codice pre-S2) resta
    // valida per le caps ma si rilegge per il thinking
    setOllamaCapabilities('ollama-old', 'm', undefined, ['tools'])
    expect(ollamaCapabilities('ollama-old', 'm')).toEqual(['tools'])
    expect(ollamaThinkingInfo('ollama-old', 'm')).toBeUndefined()
    calls = 0
    const r2 = await readOllamaCapabilities({ id: 'ollama-old', baseUrl: 'http://127.0.0.1:1' }, 'm')
    expect(calls).toBe(1) // rilettura per il thinking
    expect(r2.thinking).toEqual({ values: ['low', 'medium', 'high', false], default: 'high' })
    vi.unstubAllGlobals()
  })
})

describe('S2: modelCapabilities e il sintetico Ollama che ragiona', () => {
  beforeEach(() => resetOllamaCapabilities())
  const ollama = (id: string): ProviderConfig => ({ id, name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:1', apiKey: '', enabled: true })

  it('con thinking in cache: reasoning true e i livelli offerti; [false]: reasoning false; assente: come oggi', () => {
    setOllamaCapabilities('c1', 'kimi', undefined, ['tools', 'vision'], { values: ['low', 'medium', 'high', false], default: 'high' })
    const caps = modelCapabilities(ollama('c1'), 'kimi')
    expect(caps.reasoning).toBe(true)
    expect(caps.thinkingLevels).toEqual(['off', 'low', 'medium', 'high'])
    expect(caps.tools).toBe(true)
    expect(caps.vision).toBe(true)

    setOllamaCapabilities('c2', 'plain', undefined, ['tools'], { values: [false] })
    const noThink = modelCapabilities(ollama('c2'), 'plain')
    expect(noThink.reasoning).toBe(false)
    expect(noThink.thinkingLevels).toEqual([])

    // mai letto /api/show: come oggi (nessun livello, nessuna opzione)
    const unknown = modelCapabilities(ollama('c3'), 'mai-letto')
    expect(unknown.reasoning).toBe(false)
    expect(unknown.thinkingLevels).toEqual([])
  })

  it('il sintetico porta reasoning, thinkingLevelMap off→"none" e compat openai + supportsReasoningEffort', () => {
    setOllamaCapabilities('c4', 'kimi', undefined, ['tools'], { values: ['low', 'medium', 'high', false], default: 'high' })
    const m = piModelFor(ollama('c4'), 'kimi') as unknown as {
      reasoning: boolean
      compat: Record<string, unknown>
      thinkingLevelMap: Record<string, string | null>
    }
    expect(m.reasoning).toBe(true)
    expect(m.compat).toMatchObject({ supportsReasoningEffort: true, thinkingFormat: 'openai', supportsDeveloperRole: false, supportsStore: false })
    expect(m.thinkingLevelMap.off).toBe('none')
    // i livelli NON offerti sono esclusi (il clamp sale al primo offerto)
    expect(m.thinkingLevelMap.minimal).toBeNull()
    expect(m.thinkingLevelMap.xhigh).toBeNull()
    expect(ollamaOfferedLevels(ollama('c4'), 'kimi')).toEqual(['off', 'low', 'medium', 'high'])
    // senza thinking: il compat di sempre (niente reasoning_effort)
    const plain = piModelFor(ollama('c5'), 'plain') as unknown as { reasoning: boolean; compat: Record<string, unknown>; thinkingLevelMap?: unknown }
    setOllamaCapabilities('c5', 'plain', undefined, ['tools'])
    const plainModel = piModelFor(ollama('c5'), 'plain') as unknown as { reasoning: boolean; compat: Record<string, unknown>; thinkingLevelMap?: unknown }
    expect(plainModel.reasoning).toBe(false)
    expect(plainModel.compat).toMatchObject({ supportsReasoningEffort: false })
    expect(plainModel.thinkingLevelMap).toBeUndefined()
    void plain
  })
})

// ---- S2 sul filo: reasoning_effort vero nel body verso il server finto ----

describe('S2 sul filo: reasoning_effort verso /v1/chat/completions (server finto su 127.0.0.1)', () => {
  let server: Server
  let port: number
  const bodies: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        bodies.push(raw ? JSON.parse(raw) : {})
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
  beforeEach(() => {
    bodies.length = 0
    resetOllamaCapabilities()
  })

  it('off → "none" (NON omissione), medium → "medium", «Predefinito» → "medium"', async () => {
    setOllamaCapabilities('wire', 'kimi', undefined, ['tools'], { values: ['low', 'medium', 'high', false], default: 'high' })
    const p: ProviderConfig = { id: 'wire', name: 'Ollama', kind: 'ollama', baseUrl: `http://127.0.0.1:${port}`, apiKey: '', enabled: true }
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
    // «Spento»: reasoning_effort "none" — l'omissione varrebbe il PREDEFINITO
    // del modello, non spento (questo è il cuore di S2)
    await drain(piLlmStream(p, 'kimi', msgs, [], new AbortController().signal, { thinking: 'off' }))
    expect(bodies.at(-1)!.reasoning_effort).toBe('none')
    // un livello: il valore del livello
    await drain(piLlmStream(p, 'kimi', msgs, [], new AbortController().signal, { thinking: 'medium' }))
    expect(bodies.at(-1)!.reasoning_effort).toBe('medium')
    // livello chiesto ma non offerto: sale al primo offerto («come pi-ai»)
    await drain(piLlmStream(p, 'kimi', msgs, [], new AbortController().signal, { thinking: 'minimal' }))
    expect(bodies.at(-1)!.reasoning_effort).toBe('low')
    // «Predefinito» con medium tra i values → medium (comportamento NUOVO)
    await drain(piLlmStream(p, 'kimi', msgs, [], new AbortController().signal, { thinking: 'default' }))
    expect(bodies.at(-1)!.reasoning_effort).toBe('medium')
  })

  it('modello solo acceso/spento: «Predefinito» NON manda niente; «Spento» manda "none"', async () => {
    setOllamaCapabilities('wire2', 'onoff', undefined, ['tools'], { values: [true, false] })
    const p: ProviderConfig = { id: 'wire2', name: 'Ollama', kind: 'ollama', baseUrl: `http://127.0.0.1:${port}`, apiKey: '', enabled: true }
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
    await drain(piLlmStream(p, 'onoff', msgs, [], new AbortController().signal, { thinking: 'default' }))
    expect('reasoning_effort' in bodies.at(-1)!).toBe(false)
    await drain(piLlmStream(p, 'onoff', msgs, [], new AbortController().signal, { thinking: 'high' }))
    expect(bodies.at(-1)!.reasoning_effort).toBe('high')
    await drain(piLlmStream(p, 'onoff', msgs, [], new AbortController().signal, { thinking: 'off' }))
    expect(bodies.at(-1)!.reasoning_effort).toBe('none')
  })

  it('modello senza informazioni di thinking (mai letto /api/show): nessuna opzione, come oggi', async () => {
    const p: ProviderConfig = { id: 'wire3', name: 'Ollama', kind: 'ollama', baseUrl: `http://127.0.0.1:${port}`, apiKey: '', enabled: true }
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }]
    await drain(piLlmStream(p, 'sconosciuto', msgs, [], new AbortController().signal, { thinking: 'high' }))
    expect('reasoning_effort' in bodies.at(-1)!).toBe(false)
  })
})

// ---- S4: la chiave di sessione (pura) ----

describe('S4: sessionKeyOf — stabile per conversazione, diversa tra conversazioni', () => {
  it('chat del bot, turno di gruppo, figlio', async () => {
    const { sessionKeyOf } = await import('../loop')
    expect(sessionKeyOf({ agentId: 'agent_a' })).toBe('agent_a:agent_a')
    expect(sessionKeyOf({ agentId: 'agent_a', groupTurn: { groupId: 3 } })).toBe('group:3:agent_a')
    expect(sessionKeyOf({ agentId: 'agent_a', groupTurn: { groupId: 3 } })).not.toBe(sessionKeyOf({ agentId: 'agent_b', groupTurn: { groupId: 3 } }))
    expect(sessionKeyOf({ agentId: 'sub_1', subagent: { id: 'sub_1', parentId: 'agent_a' } })).toBe('agent_a:sub_1')
    expect(sessionKeyOf({ agentId: 'sub_1', subagent: { id: 'sub_1', parentId: 'agent_a' } }))
      .not.toBe(sessionKeyOf({ agentId: 'sub_2', subagent: { id: 'sub_2', parentId: 'agent_a' } }))
  })
})
