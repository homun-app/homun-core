// Fase 18a (E2): l'adattatore @earendil-works/pi-ai dietro llmStream. Questo è
// l'UNICO file del repo che importa la libreria (lo verifica un test): se
// cambia o va via, si torna indietro sostituendo un solo file. Il CONTRATTO
// (LlmStream, LlmChunk, ChatMessage, ToolDef in llm.ts) e il loop con tutte
// le sue protezioni (recupero, scadenza, riserva, cicli, gate) NON cambiano.
//
// Regole dell'adattatore:
// - la chiave è SEMPRE esplicita a ogni richiesta (apiKey), MAI da ambiente:
//   la Models collection nasce con CredentialStore in memoria VUOTO e un
//   AuthContext che non legge né env né file;
// - l'identità del client è solo "Homun": niente piattaforma/architettura
//   nello User-Agent, niente header di attribuzione;
// - MAI il provider `zai` di pi-ai (punta al GLM Coding Plan, vietato ai tool
//   di terzi): z.ai passa da un provider openai-completions sull'API a
//   consumo https://api.z.ai/api/paas/v4;
// - niente chiavi in log, trace o errori: traceLlmCall resta solo numeri.
import {
  createModels,
  createProvider,
  fauxProvider,
  InMemoryCredentialStore,
  type Api,
  type AuthContext,
  type AssistantMessage,
  type Context,
  type FauxProviderHandle,
  type Message,
  type Model,
  type Models,
  type Provider,
  type SimpleStreamOptions,
  type Tool as PiTool
} from '@earendil-works/pi-ai'
// solo le sette factory dei kind col catalogo, MAI providers/all
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { groqProvider } from '@earendil-works/pi-ai/providers/groq'
// le implementazioni API per i provider personalizzati (stessa api del
// provider di riferimento quando l'utente cambia baseUrl)
import { stream as ocStream, streamSimple as ocStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as orStream, streamSimple as orStreamSimple } from '@earendil-works/pi-ai/api/openai-responses'
import { stream as amStream, streamSimple as amStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { stream as mcStream, streamSimple as mcStreamSimple } from '@earendil-works/pi-ai/api/mistral-conversations'
import type { ProviderConfig, ProviderKind } from '../../shared/types'
import type { ChatMessage, LlmChunk, LlmStream, StreamOptions, ToolDef, ToolCall } from './llm'
import { traceLlmCall } from './llm'
import { KNOWN_BASE_URLS } from './providers'

/** L'endpoint a consumo di z.ai (MAI /api/coding/paas/v4: è il Coding Plan). */
export const ZAI_CONSUMPTION_BASE_URL = 'https://api.z.ai/api/paas/v4'

/** I kind che parlano solo in locale (nessuna chiave, costo nullo). */
const LOCAL_KINDS: ReadonlySet<ProviderKind> = new Set(['ollama', 'lmstudio', 'openai-compatible', 'custom'])

/** I kind col catalogo pi-ai: factory + ricerca del modello per id. */
const CATALOG_FACTORIES: Partial<Record<ProviderKind, () => Provider>> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  mistral: mistralProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  deepseek: deepseekProvider,
  groq: groqProvider
}

/** L'api dei modelli sintetici di ogni kind (quella del provider di riferimento). */
const KIND_APIS: Record<ProviderKind, string> = {
  openai: 'openai-responses',
  xai: 'openai-responses',
  anthropic: 'anthropic-messages',
  mistral: 'mistral-conversations',
  openrouter: 'openai-completions',
  deepseek: 'openai-completions',
  groq: 'openai-completions',
  zai: 'openai-completions',
  ollama: 'openai-completions',
  lmstudio: 'openai-completions',
  'openai-compatible': 'openai-completions',
  custom: 'openai-completions'
}

/**
 * E2.1: il base URL dei provider OpenAI-compatible — la regola di oggi
 * (appende '/v1') ma SOLO se l'URL non finisce già con /v<n> o /api/paas/v4:
 * il bug per cui z.ai finiva su api.z.ai/v1 si chiude qui.
 */
export function openAiCompatBase(p: Pick<ProviderConfig, 'baseUrl'>): string {
  const base = p.baseUrl.trim().replace(/\/+$/, '')
  if (/\/v\d+$/.test(base) || /\/api\/paas\/v4$/.test(base)) return base
  return base + '/v1'
}

/** Il baseUrl di un kind col catalogo: quello dell'utente, con z.ai corretto in lettura. */
function normalizedBaseUrl(p: ProviderConfig): string {
  const base = p.baseUrl.trim().replace(/\/+$/, '')
  // correzione in LETTURA dei provider zai salvati con l'url vecchio
  // (https://api.z.ai o https://api.z.ai/v1): il dato nel database non si migra
  if (p.kind === 'zai') return ZAI_CONSUMPTION_BASE_URL
  // i server OpenAI-compatible locali prendono la regola /v1 di openAiCompatBase
  if (p.kind === 'ollama' || p.kind === 'lmstudio' || p.kind === 'openai-compatible' || p.kind === 'custom') {
    return openAiCompatBase({ baseUrl: base })
  }
  return base
}

/** La stessa api del provider di riferimento, per il provider personalizzato. */
function apiOf(kind: ProviderKind): Record<string, unknown> {
  const oc = { stream: ocStream, streamSimple: ocStreamSimple }
  switch (kind) {
    case 'openai':
    case 'xai':
      return { 'openai-responses': { stream: orStream, streamSimple: orStreamSimple } }
    case 'anthropic':
      return { 'anthropic-messages': { stream: amStream, streamSimple: amStreamSimple } }
    case 'mistral':
      return { 'mistral-conversations': { stream: mcStream, streamSimple: mcStreamSimple } }
    case 'openrouter':
      return { 'openai-completions': oc, 'anthropic-messages': { stream: amStream, streamSimple: amStreamSimple } }
    default:
      // deepseek, groq e tutto ciò che è OpenAI-compatible (ollama, lmstudio,
      // openai-compatible, custom, zai)
      return { 'openai-completions': oc }
  }
}

/** L'auth dei provider dell'adattatore: la chiave arriva SOLO dalla richiesta. */
function perRequestAuth(p: ProviderConfig) {
  return {
    apiKey: {
      name: `${p.name} API key`,
      resolve: async ({ credential }: { credential?: { key?: string } }) =>
        credential?.key
          ? { auth: { apiKey: credential.key }, source: 'request' }
          : { auth: {}, source: 'keyless' }
    }
  }
}

/** Il AuthContext che NON legge niente: né variabili d'ambiente né file. */
const noEnvAuthContext: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false
}

/** Una voce della cache delle Models collection (una per configurazione). */
interface PiCacheEntry {
  models: Models
  /** l'id del provider registrato nella collection (è sempre p.id) */
  providerId: string
  /** l'api dei modelli sintetici di questa configurazione */
  api: string
  /** il baseUrl dei modelli sintetici */
  baseUrl: string
  /** gli id che vengono dal catalogo pi-ai (costo e finestra veri) */
  catalogIds: ReadonlySet<string>
  /** provider tutto locale (ollama, lmstudio…): costo zero → costUsd null */
  local: boolean
}

const modelsCache = new Map<string, PiCacheEntry>()

/**
 * L'id del provider FINTO di test: una configurazione con questo id registra
 * il fauxProvider di pi-ai invece di un provider vero — llmStream gira tutto
 * (conversione, eventi, usage) SENZA rete, la risposta la scrive il test con
 * fauxTestHandle().setResponses(…). Serve ai test della 18a (E4/E6); in
 * produzione nessuna configurazione ha questo id.
 */
export const FAUX_TEST_PROVIDER_ID = 'faux-test'
const fauxHandles = new Map<string, FauxProviderHandle>()

/** L'handle del provider finto (per scrivere le risposte nei test). */
export function fauxTestHandle(id: string = FAUX_TEST_PROVIDER_ID): FauxProviderHandle | undefined {
  return fauxHandles.get(id)
}

/**
 * Il modello sintetico per un id assente dal catalogo (modello nuovo o locale).
 * G1: `input: ['text', 'image']` — con capacità SCONOSCIUTE le immagini si
 * mandano come prima della 18a e decide il server: con `['text']` pi-ai
 * (downgradeUnsupportedImages) le sostituiva tutte col segnaposto
 * "(image omitted…)" sugli ollama/lmstudio/custom/zai e su ogni id fuori
 * catalogo, e gli screenshot del computer use e le immagini dell'utente
 * sparivano. Il flag visione VERO (che spegne o accende) arriva col catalogo
 * della 18b; i modelli DEL catalogo pi-ai restano come sono.
 */
function syntheticModel(e: PiCacheEntry, modelId: string, compat?: Record<string, unknown>): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: e.api,
    provider: e.providerId,
    baseUrl: e.baseUrl,
    input: ['text', 'image'],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(compat ? { compat } : {})
  } as unknown as Model<Api>
}

/**
 * E2.1: la Models collection di una configurazione, costruita UNA volta e
 * cachata per p.id + p.baseUrl + p.kind (la chiave API resta fuori). Un solo
 * provider registrato, con l'id della configurazione: i modelli del catalogo
 * pi-ai (quando il kind ne ha uno e l'baseUrl è quello noto) vengono
 * ribattezzati su questo id, così getModel(p.id, id) li trova con costo e
 * finestra veri; con un baseUrl personalizzato si clonano sull'URL dell'utente.
 */
export function piCacheEntryFor(p: ProviderConfig): PiCacheEntry {
  const key = `${p.id}|${p.baseUrl}|${p.kind}`
  const cached = modelsCache.get(key)
  if (cached) return cached

  // il provider FINTO dei test: nessuna rete, le risposte le scrive il test
  if (p.id === FAUX_TEST_PROVIDER_ID) {
    const faux = fauxProvider()
    const models = createModels({
      credentials: new InMemoryCredentialStore(),
      authContext: noEnvAuthContext,
      identity: { userAgent: { custom: 'Homun' }, attribution: null }
    })
    models.setProvider(faux.provider)
    fauxHandles.set(p.id, faux)
    const entry: PiCacheEntry = {
      models,
      providerId: faux.provider.id,
      api: faux.api,
      baseUrl: faux.models[0]!.baseUrl,
      catalogIds: new Set(faux.models.map((m) => m.id)),
      local: false
    }
    modelsCache.set(key, entry)
    return entry
  }

  const baseUrl = normalizedBaseUrl(p)
  const known = KNOWN_BASE_URLS[p.kind]?.replace(/\/+$/, '')
  const catalogFactory = CATALOG_FACTORIES[p.kind]
  // il catalogo pi-ai per i sette kind che lo hanno (MAI per zai); con un
  // baseUrl personalizzato i modelli si clonano sull'URL dell'utente
  const useCatalog = !!catalogFactory && p.kind !== 'zai'

  const catalogIds = new Set<string>()
  const modelsList: Model<Api>[] = []
  if (useCatalog) {
    // baseUrl personalizzato (kind col catalogo ma URL diverso dal noto): i
    // modelli puntano all'URL dell'utente; col noto restano sul baseUrl del
    // catalogo (es. groq …/openai/v1), che è quello giusto
    const custom = known !== undefined && baseUrl !== known
    for (const m of catalogFactory!().getModels()) {
      if (m.type && m.type !== 'chat') continue
      catalogIds.add(m.id)
      modelsList.push({ ...m, provider: p.id, ...(custom ? { baseUrl } : {}) } as unknown as Model<Api>)
    }
  }

  const provider = createProvider({
    id: p.id,
    name: p.name,
    baseUrl,
    auth: perRequestAuth(p),
    models: modelsList as never,
    api: apiOf(p.kind) as never
  })
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    authContext: noEnvAuthContext,
    // E2.2: l'identità del client — solo il nome, niente piattaforma né
    // architettura, niente header di attribuzione
    identity: { userAgent: { custom: 'Homun' }, attribution: null }
  })
  models.setProvider(provider)

  const entry: PiCacheEntry = {
    models,
    providerId: p.id,
    api: KIND_APIS[p.kind],
    baseUrl,
    catalogIds,
    local: LOCAL_KINDS.has(p.kind)
  }
  modelsCache.set(key, entry)
  return entry
}

/** E2.1: il modello pi-ai di una configurazione (catalogo, o sintetico). */
export function piModelFor(p: ProviderConfig, modelId: string): Model<Api> {
  const e = piCacheEntryFor(p)
  const fromCatalog = e.models.getModel(e.providerId, modelId)
  if (fromCatalog) return fromCatalog
  return syntheticModel(e, modelId, e.local ? localCompatOf(p) : zaiCompatOf(p))
}

function localCompatOf(p: ProviderConfig): Record<string, unknown> | undefined {
  return p.kind === 'ollama' || p.kind === 'lmstudio' || p.kind === 'openai-compatible' || p.kind === 'custom'
    ? { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false }
    : undefined
}

function zaiCompatOf(p: ProviderConfig): Record<string, unknown> | undefined {
  return p.kind === 'zai' ? { thinkingFormat: 'zai' } : undefined
}

/** Il modello viene dal catalogo pi-ai (costo e finestra veri)? */
export function fromCatalog(p: ProviderConfig, modelId: string): boolean {
  return piCacheEntryFor(p).catalogIds.has(modelId)
}

/**
 * E2.1: le capacità del modello per la pagina Uso e costi della 18b — qui
 * solo lette. cost null = sconosciuto (modello fuori catalogo) o locale.
 * G1: vision null = sconosciuta (modello sintetico): il sintetico dice
 * `input: ['text', 'image']` solo per mandare le immagini al server, NON
 * perché sappiamo che il modello ci vede — il flag vero arriva col catalogo.
 */
export function modelCapabilities(
  p: ProviderConfig,
  modelId: string
): {
  contextWindow: number
  vision: boolean | null
  reasoning: boolean
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  fromCatalog: boolean
} {
  const catalog = fromCatalog(p, modelId)
  const m = piModelFor(p, modelId)
  const zero = m.cost.input === 0 && m.cost.output === 0 && m.cost.cacheRead === 0 && m.cost.cacheWrite === 0
  const local = LOCAL_KINDS.has(p.kind)
  return {
    contextWindow: m.contextWindow,
    vision: !catalog ? null : m.input.includes('image'),
    reasoning: m.reasoning,
    cost: !catalog || (zero && local) ? null : { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite },
    fromCatalog: catalog
  }
}

// ---- E2.3: da ChatMessage[] a Context pi-ai ----

/**
 * G2: il tipo MIME VERO di un'immagine base64, letto dai primi byte. ipc.ts
 * accetta png, jpg, jpeg, webp e gif e manda i byte grezzi in base64, ma
 * tutto veniva etichettato image/png (faceva così anche il vecchio
 * adattatore): le API che controllano il tipo (Anthropic in particolare)
 * rifiutano un JPEG dichiarato PNG con un 400. Decodifica SOLO i primi 16
 * caratteri base64 (12 byte: bastano per tutte le firme), mai tutta
 * l'immagine; una firma sconosciuta resta image/png (come è sempre stato).
 */
export function imageMimeOf(base64: string): string {
  const head = Buffer.from(base64.slice(0, 16), 'base64')
  const is = (offset: number, sig: number[]): boolean => sig.every((b, i) => head[offset + i] === b)
  if (is(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (is(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (is(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  // RIFF????WEBP: 4 byte di dimensione saltati tra i due pezzi della firma
  if (is(0, [0x52, 0x49, 0x46, 0x46]) && is(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return 'image/png'
}

/** JSON.parse con fallback {} (come safeParse di sempre: argomento rotto → {}). */
function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const zeroUsage = (): AssistantMessage['usage'] => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

/**
 * La conversione dei messaggi (pura, testabile): i system diventano
 * systemPrompt (uniti in ordine con una riga vuota), gli assistant portano
 * testo e tool call (api/provider/model del modello CORRENTE: lo storico non
 * ha firme di thinking), i tool result ritrovano il nome del tool dalla
 * chiamata che li ha generati.
 */
export function toPiContext(
  messages: ChatMessage[],
  tools: ToolDef[],
  current?: { api: string; provider: string; model: string }
): Context {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const piMessages: Message[] = []
  // l'ultima chiamata per id: serve il toolName del toolResult
  const lastCallById = new Map<string, ToolCall>()
  const now = Date.now()
  for (const m of messages) {
    if (m.role === 'system') continue // viaggia nel systemPrompt
    if (m.role === 'user') {
      const content = m.images?.length
        ? [
            { type: 'text' as const, text: m.content },
            // G2: il MIME vero letto dalla firma, non sempre image/png
            ...m.images.map((data) => ({ type: 'image' as const, data, mimeType: imageMimeOf(data) }))
          ]
        : m.content
      piMessages.push({ role: 'user', content, timestamp: now })
      continue
    }
    if (m.role === 'assistant') {
      const content: AssistantMessage['content'] = []
      if (m.content.trim()) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        lastCallById.set(tc.id, tc)
        content.push({ type: 'toolCall', id: tc.id, name: tc.name, arguments: safeParse(tc.arguments) as never })
      }
      piMessages.push({
        role: 'assistant',
        content,
        api: (current?.api ?? 'openai-completions') as never,
        provider: current?.provider ?? 'unknown',
        model: current?.model ?? 'unknown',
        usage: zeroUsage(),
        stopReason: m.toolCalls?.length ? 'toolUse' : 'stop',
        timestamp: now
      })
      continue
    }
    // role 'tool': il result della chiamata (il nome dalla tool call, se c'è)
    const call = m.toolCallId ? lastCallById.get(m.toolCallId) : undefined
    piMessages.push({
      role: 'toolResult',
      toolCallId: m.toolCallId ?? '',
      toolName: call?.name ?? 'unknown',
      content: [{ type: 'text', text: m.content }],
      isError: false,
      timestamp: now
    })
  }
  return {
    ...(system.length ? { systemPrompt: system.join('\n\n') } : {}),
    messages: piMessages,
    ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as PiTool['parameters'] })) } : {})
  }
}

// ---- E2.4/E2.5: dagli eventi pi-ai a LlmChunk ----

/**
 * L'errore del provider con lo stato HTTP che NON si perde: pi-ai non lancia,
 * mette tutto in errorMessage ("<status>: <body>" o il messaggio dell'SDK,
 * es. "429 Rate limit…"). Il messaggio resta COM'È (le regex di rete di
 * fallbackEligible continuano a funzionare); lo status si ricava con
 * /^(\d{3})\b/ o /\((\d{3})\)/.
 */
export class LlmProviderError extends Error {
  status?: number
  constructor(message: string) {
    super(message)
    this.name = 'LlmProviderError'
    const lead = /^(\d{3})\b/.exec(message)
    const paren = /\((\d{3})\)/.exec(message)
    const status = lead?.[1] ?? paren?.[1]
    if (status) this.status = Number(status)
  }
}

/**
 * L'abort di metà stream: lo stesso errore che lanciano oggi gli SDK
 * (name 'APIUserAbortError', "Request was aborted.") — il loop lo riconosce
 * dal segnale, il nome serve ai test e alla simmetria col passato.
 */
export class PiUserAbortError extends Error {
  constructor() {
    super('Request was aborted.')
    this.name = 'APIUserAbortError'
  }
}

/** stopReason pi-ai → finishReason del contratto (i valori di sempre). */
function finishReasonOf(reason: string): string {
  if (reason === 'toolUse') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

/** Il costo in dollari del chunk finale (null se fuori catalogo o locale a costo zero). */
function costUsdOf(u: AssistantMessage['usage'], fromCatalog: boolean, local: boolean): number | null {
  if (!fromCatalog) return null
  if (u.cost.total === 0 && local) return null
  return u.cost.total
}

/** Che cosa sa lo stream del modello che sta chiamando (per costUsd e trace). */
export interface PiStreamMeta {
  fromCatalog: boolean
  local: boolean
}

/**
 * Il cuore dello stream (E2.4): consuma gli eventi pi-ai e li ributta come
 * LlmChunk dello stesso contratto di sempre. Testabile col faux provider con
 * una Models collection qualsiasi.
 */
export function streamPi(
  models: Models,
  model: Model<Api>,
  meta: PiStreamMeta,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  opts: StreamOptions & { apiKey?: string } = {}
): LlmStream {
  const context = toPiContext(messages, tools, { api: model.api, provider: model.provider, model: model.id })
  // E2.2/E2.5: chiave esplicita, 2 retry come l'SDK openai di oggi,
  // temperatura (E2.6) quando c'è
  const piOpts: SimpleStreamOptions = {
    signal,
    apiKey: opts.apiKey,
    maxRetries: 2,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})
  }
  const eventStream = models.streamSimple(model, context, piOpts)

  async function* iterate(): AsyncIterable<LlmChunk> {
    // accumulo dei tool call in ordine di contentIndex: escono TUTTI alla fine
    const toolCallsByIndex = new Map<number, ToolCall>()
    let contentLen = 0
    let reasoningLen = 0
    let usage: { input: number; output: number } | null = null
    let finish = 'stop'
    for await (const ev of eventStream) {
      if (ev.type === 'text_delta') {
        contentLen += ev.delta.length
        yield { textDelta: ev.delta }
      } else if (ev.type === 'thinking_delta') {
        reasoningLen += ev.delta.length
        yield { reasoningDelta: ev.delta }
      } else if (ev.type === 'toolcall_end') {
        toolCallsByIndex.set(ev.contentIndex, {
          id: ev.toolCall.id,
          name: ev.toolCall.name,
          arguments: JSON.stringify(ev.toolCall.arguments)
        })
      } else if (ev.type === 'done') {
        finish = finishReasonOf(ev.reason)
        const u = ev.message.usage
        usage = { input: u.input, output: u.output }
        const ordered = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
        const chunk: LlmChunk = {
          ...(ordered.length ? { toolCalls: ordered } : {}),
          finishReason: finish,
          usage: {
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            costUsd: costUsdOf(u, meta.fromCatalog, meta.local)
          }
        }
        traceLlmCall({
          at: new Date().toISOString(), model: model.id, finishReason: finish,
          contentLength: contentLen, reasoningLength: reasoningLen,
          toolCalls: ordered.length, usage
        })
        yield chunk
      } else if (ev.type === 'error') {
        if (ev.reason === 'aborted') throw new PiUserAbortError()
        throw new LlmProviderError(ev.error.errorMessage ?? 'provider error')
      }
    }
  }

  const iterable = iterate()
  return {
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
    async drain() {
      let text = ''
      let toolCalls: ToolCall[] = []
      let finishReason = 'stop'
      let usage: LlmChunk['usage']
      for await (const ch of iterable) {
        if (ch.textDelta) text += ch.textDelta
        if (ch.toolCalls) toolCalls = ch.toolCalls
        if (ch.finishReason) finishReason = ch.finishReason
        if (ch.usage) usage = ch.usage
      }
      return { text, toolCalls, finishReason, ...(usage ? { usage } : {}) }
    }
  }
}

/** Lo stream di llmStream: risolve configurazione e modello e chiama il cuore. */
export function piLlmStream(
  p: ProviderConfig,
  modelId: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  opts: StreamOptions = {}
): LlmStream {
  const entry = piCacheEntryFor(p)
  const model = piModelFor(p, modelId)
  return streamPi(entry.models, model, { fromCatalog: entry.catalogIds.has(modelId), local: entry.local }, messages, tools, signal, {
    ...opts,
    // E2.2: chiave sempre esplicita; i locali senza chiave mandano
    // 'not-needed' (come l'adattatore di sempre), i provider col catalogo
    // con chiave vuota falliscono con un errore chiaro, non con un 401 opaco
    apiKey: entry.local ? p.apiKey || 'not-needed' : p.apiKey
  })
}
