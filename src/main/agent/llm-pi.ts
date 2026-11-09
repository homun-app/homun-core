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
  getSupportedThinkingLevels,
  clampThinkingLevel,
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
// fase velocità (S1): l'hash corto del sessionId per la traccia (mai l'id vero)
import { createHash } from 'node:crypto'
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
import type { ModelCapabilities, ModelInfo, ModelPriceMap, ProviderConfig, ProviderKind, ThinkingSetting } from '../../shared/types'
import type { ChatMessage, LlmChunk, LlmStream, StreamOptions, ToolDef, ToolCall } from './llm'
import { traceLlmCall } from './llm'
// fase 18b (H5.2): le regole degli URL vivi vivono nel modulo PURO live-models,
// condiviso con providers.ts (nessun ciclo, nessuna duplicazione); da qui
// arrivano anche i base URL noti, così questo file non dipende da providers.ts
// fase velocità (S2): ollamaThinkingLevels/ollamaThinkingInfo leggono la
// parte `thinking` di /api/show dalla STESSA cache delle capability.
import { ZAI_CONSUMPTION_BASE_URL, KNOWN_BASE_URLS, LOCAL_KINDS, openAiCompatBase, ollamaCapabilities, ollamaThinkingInfo, ollamaThinkingLevels } from './live-models'
import { fallbackEligible } from './model-fallback'

// re-esportati per i test e i chiamanti (la regola è una sola, in live-models)
export { ZAI_CONSUMPTION_BASE_URL, openAiCompatBase }

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
  // fase locale (L3): llama-server parla OpenAI-compatible (/v1/…)
  'homun-local': 'openai-completions',
  'openai-compatible': 'openai-completions',
  custom: 'openai-completions'
}

/** Il baseUrl di un kind col catalogo: quello dell'utente, con z.ai corretto in lettura. */
function normalizedBaseUrl(p: ProviderConfig): string {
  const base = (typeof p.baseUrl === 'string' ? p.baseUrl : '').trim().replace(/\/+$/, '')
  // correzione in LETTURA dei provider zai salvati con l'url vecchio
  // (https://api.z.ai o https://api.z.ai/v1): il dato nel database non si migra
  if (p.kind === 'zai') return ZAI_CONSUMPTION_BASE_URL
  // i server OpenAI-compatible locali prendono la regola /v1 di openAiCompatBase
  // (fase locale L3: anche homun-local — llama-server serve /v1/chat/completions)
  if (p.kind === 'ollama' || p.kind === 'lmstudio' || p.kind === 'homun-local' || p.kind === 'openai-compatible' || p.kind === 'custom') {
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
  /** i modelli del catalogo ribattezzati su questa configurazione (H5.1) */
  catalogModels: Model<Api>[]
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
 * Fase velocità (S2): un sintetico Ollama che ragiona dichiara
 * `reasoning: true` e una thinkingLevelMap che mappa `off` → `"none"` ed
 * esclude i livelli non offerti — così il clamp di pi-ai sale al primo
 * livello offerto e `off` parte davvero come `reasoning_effort: "none"`
 * (openai-completions legge thinkingLevelMap.off quando l'opzione reasoning
 * non c'è: su Ollama l'omissione varrebbe «predefinito del modello», non
 * «spento»).
 */
function syntheticModel(
  e: PiCacheEntry,
  modelId: string,
  compat?: Record<string, unknown>,
  ollama?: { levels: ThinkingSetting[] }
): Model<Api> {
  const thinkingLevelMap = ollama
    ? {
        off: ollama.levels.includes('off') ? 'none' : null,
        // i livelli non offerti: null (pi-ai li esclude e il clamp sale);
        // xhigh/max offerti vanno NOMINATI: pi-ai li considera supportati
        // solo con un valore esplicito nella mappa, altrimenti «max»
        // scenderebbe a high sul filo
        ...Object.fromEntries(
          (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)
            .filter((l) => !ollama.levels.includes(l))
            .map((l) => [l, null])
        ),
        ...Object.fromEntries(
          (['xhigh', 'max'] as const).filter((l) => ollama.levels.includes(l)).map((l) => [l, l])
        )
      }
    : undefined
  return {
    id: modelId,
    name: modelId,
    api: e.api,
    provider: e.providerId,
    baseUrl: e.baseUrl,
    input: ['text', 'image'],
    reasoning: !!ollama,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(compat ? { compat } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {})
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
      catalogModels: [...faux.models],
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
    catalogModels: modelsList,
    local: LOCAL_KINDS.has(p.kind)
  }
  modelsCache.set(key, entry)
  return entry
}

/**
 * Fase velocità (S2): i livelli di ragionamento offerti da un sintetico
 * Ollama secondo la cache di /api/show (null se il modello non ragiona o le
 * informazioni non sono ancora lette). Pura rispetto alla cache.
 */
export function ollamaOfferedLevels(p: ProviderConfig, modelId: string): ThinkingSetting[] | null {
  if (p.kind !== 'ollama') return null
  const { levels } = ollamaThinkingLevels(ollamaThinkingInfo(p.id, modelId))
  return levels.length ? levels : null
}

/** E2.1: il modello pi-ai di una configurazione (catalogo, o sintetico). */
export function piModelFor(p: ProviderConfig, modelId: string): Model<Api> {
  const e = piCacheEntryFor(p)
  const fromCatalog = e.models.getModel(e.providerId, modelId)
  if (fromCatalog) return fromCatalog
  // fase velocità (S2): il sintetico Ollama che ragiona porta compat e
  // thinkingLevelMap (niente invece se /api/show non ha dichiarato thinking)
  const ollama = ollamaOfferedLevels(p, modelId)
  return syntheticModel(e, modelId, e.local ? localCompatOf(p, !!ollama) : zaiCompatOf(p), ollama ? { levels: ollama } : undefined)
}

/**
 * Il compat dei sintetici locali. Fase velocità (S2): un Ollama che ragiona
 * a livelli accende `supportsReasoningEffort` con `thinkingFormat: 'openai'`
 * (stessa idea di Rakazo, pi-openai-compatible-provider.ts): reasoning_effort
 * parte col valore del livello e «spento» si dice con "none".
 */
function localCompatOf(p: ProviderConfig, ollamaThinking: boolean): Record<string, unknown> | undefined {
  if (p.kind !== 'ollama' && p.kind !== 'lmstudio' && p.kind !== 'homun-local' && p.kind !== 'openai-compatible' && p.kind !== 'custom') return undefined
  if (p.kind === 'ollama' && ollamaThinking) {
    return { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: 'openai', supportsStore: false }
  }
  return { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false }
}

function zaiCompatOf(p: ProviderConfig): Record<string, unknown> | undefined {
  return p.kind === 'zai' ? { thinkingFormat: 'zai' } : undefined
}

/** Il modello viene dal catalogo pi-ai (costo e finestra veri)? */
export function fromCatalog(p: ProviderConfig, modelId: string): boolean {
  return piCacheEntryFor(p).catalogIds.has(modelId)
}

/**
 * Le capacità del modello, come le vede la 18b (H1.2). Il tipo vive in
 * shared/types.ts (K3: lo restituisce l'RPC models:capabilities); qui si
 * re-esporta per i chiamanti e i test storici.
 */
export type { ModelCapabilities }

/**
 * K1: i livelli di ragionamento OFFERTI per un modello di catalogo. Su
 * `anthropic-messages` non si offrono mai `xhigh` e `max` (come fa Rakazo con
 * compatibleThinkingLevels): in pi-ai 1.4.0 il percorso a BUDGET di quell'api
 * si ferma a `high` — DEFAULT_THINKING_BUDGETS è {minimal:1024, low:2048,
 * medium:8192, high:16384} e clampReasoning xhigh/max→high (dist/api/
 * simple-options.js) — quindi i due livelli in più non cambierebbero nulla.
 * Vale anche per i modelli adaptivi (compat.forceAdaptiveThinking, che in
 * catalogo sono opus-4-6+, sonnet-4-6+, fable, haiku-5-5): il loro
 * thinkingLevelMap mappa xhigh/max a effort nativi, ma la UI li offre lo
 * stesso clamped: chi li ha salvati continua a funzionare (clampThinkingLevel
 * li tiene se il modello li sa esprimere), semplicemente non si scelgono più.
 */
function offeredThinkingLevels(m: Model<Api>): ThinkingSetting[] {
  const levels = getSupportedThinkingLevels(m) as ThinkingSetting[]
  return m.api === 'anthropic-messages'
    ? levels.filter((l) => l !== 'xhigh' && l !== 'max')
    : levels
}

/**
 * Fase 18a (E2.1) → 18b (H1.2): le capacità del modello. Le fonti, in ordine:
 * 1. catalogo pi-ai (vision da input, thinkingLevels da
 *    getSupportedThinkingLevels, tools: true, costo del catalogo);
 * 2. cache delle capability Ollama (H5.2) per i provider ollama;
 * 3. zai sintetico: thinkingLevels ['off','high'] (spento/acceso);
 * 4. tutto il resto: sconosciuto (null/null/[]).
 * Il prezzo personalizzato (H1.3) vale quando il modello NON è nel catalogo e
 * il provider NON è locale; il prezzo del catalogo vince sempre.
 * K1: per anthropic-messages i livelli offerti tolgono xhigh/max.
 */
export function modelCapabilities(p: ProviderConfig, modelId: string, prices?: ModelPriceMap): ModelCapabilities {
  const entry = piCacheEntryFor(p)
  const catalog = entry.catalogIds.has(modelId)
  const local = entry.local
  const custom = !catalog && !local ? prices?.[p.id]?.[modelId] : undefined

  if (catalog) {
    const m = piModelFor(p, modelId)
    const zero = m.cost.input === 0 && m.cost.output === 0 && m.cost.cacheRead === 0 && m.cost.cacheWrite === 0
    // il costo nullo di un locale resta nullo; il catalogo vince sul custom
    const cost = zero && local ? null : { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite }
    return {
      contextWindow: m.contextWindow,
      vision: m.input.includes('image'),
      reasoning: m.reasoning,
      tools: true,
      // un modello non-reasoning non è controllabile da noi: 'off' è il suo
      // comportamento di sempre, non una scelta (getSupportedThinkingLevels
      // restituirebbe ['off'], che dice nulla)
      thinkingLevels: m.reasoning ? offeredThinkingLevels(m) : [],
      cost,
      costSource: cost ? 'catalog' : null,
      fromCatalog: true
    }
  }

  // ollama: le capability vere dalla cache di /api/show (H5.2), se già lette.
  // Fase velocità (S2): anche il ragionamento, dal campo thinking di /api/show
  // (livelli offerti + reasoning true/false; niente come oggi se non letto)
  if (p.kind === 'ollama') {
    const caps = ollamaCapabilities(p.id, modelId)
    const t = ollamaThinkingLevels(ollamaThinkingInfo(p.id, modelId))
    return {
      contextWindow: 128_000,
      vision: caps ? caps.includes('vision') : null,
      reasoning: t.reasoning,
      tools: caps ? caps.includes('tools') : null,
      thinkingLevels: t.levels,
      cost: null,
      costSource: null,
      fromCatalog: false
    }
  }

  // zai sintetico: ragionamento SPENTO/ACCESO (H3), il resto sconosciuto
  if (p.kind === 'zai') {
    return {
      contextWindow: 128_000,
      vision: null,
      reasoning: true,
      tools: null,
      thinkingLevels: ['off', 'high'],
      cost: custom
        ? { input: custom.input, output: custom.output, cacheRead: custom.cacheRead ?? 0, cacheWrite: custom.cacheWrite ?? 0 }
        : null,
      costSource: custom ? 'custom' : null,
      fromCatalog: false
    }
  }

  // gli altri sintetici (modello nuovo non ancora a catalogo, lmstudio,
  // custom…): tutto sconosciuto; il prezzo personalizzato se c'è (H1.3)
  return {
    contextWindow: 128_000,
    vision: null,
    reasoning: false,
    tools: null,
    thinkingLevels: [],
    cost: custom
      ? { input: custom.input, output: custom.output, cacheRead: custom.cacheRead ?? 0, cacheWrite: custom.cacheWrite ?? 0 }
      : null,
    costSource: custom ? 'custom' : null,
    fromCatalog: false
  }
}

/**
 * Fase 18b (K7): i SOLI dati noti che servono a routeIncompatibility (modulo
 * PURO model-fallback.ts, che non importa pi-ai) per giudicare se una rotta
 * può servire il turno. `maxTokens` si legge dal modello pi-ai vero: del
 * catalogo è il valore della scheda, dei sintetici il valore di comodo — ma
 * sui sintetici la regola del contesto NON vale (fromCatalog false), quindi
 * resta il dato vero quando serve.
 */
export function routeModelCaps(
  p: ProviderConfig,
  modelId: string
): { fromCatalog: boolean; contextWindow: number; vision: boolean | null; maxTokens: number | undefined } {
  const caps = modelCapabilities(p, modelId)
  return {
    fromCatalog: caps.fromCatalog,
    contextWindow: caps.contextWindow,
    vision: caps.vision,
    maxTokens: caps.fromCatalog ? piModelFor(p, modelId).maxTokens : undefined
  }
}

/**
 * Fase 18b (H5.1): le voci del catalogo pi-ai per un provider, come ModelInfo
 * (source 'catalog'). Per i kind senza catalogo (ollama, zai, custom…) è [] —
 * l'elenco di models:list è l'UNIONE con il vivo, che vive nell'RPC.
 */
export function catalogModelInfos(p: ProviderConfig, prices?: ModelPriceMap): ModelInfo[] {
  // i modelli non-chat sono già esclusi alla costruzione della cache (E2.1)
  return piCacheEntryFor(p).catalogModels
    .map((m): ModelInfo => {
      const caps = modelCapabilities(p, m.id, prices)
      return {
        id: m.id,
        ...(m.name && m.name !== m.id ? { label: m.name } : {}),
        source: 'catalog',
        ...(caps.fromCatalog ? { contextWindow: m.contextWindow } : {}),
        vision: caps.vision,
        tools: caps.tools,
        thinkingLevels: caps.thinkingLevels,
        cost: caps.cost,
        costSource: caps.costSource,
        local: LOCAL_KINDS.has(p.kind)
      }
    })
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

/** Il costo in dollari del chunk finale (null se sconosciuto o locale). */
function costUsdOf(
  u: AssistantMessage['usage'],
  meta: PiStreamMeta
): number | null {
  // il prezzo del catalogo vince sempre; il custom vale solo fuori catalogo
  // e su provider non locali (H1.3); senza nessuno dei due resta null
  if (meta.fromCatalog) {
    if (u.cost.total === 0 && meta.local) return null
    return u.cost.total
  }
  if (meta.local || !meta.customPrice) return null
  const p = meta.customPrice
  return (u.input * p.input + u.output * p.output + u.cacheRead * (p.cacheRead ?? 0) + u.cacheWrite * (p.cacheWrite ?? 0)) / 1e6
}

/** Che cosa sa lo stream del modello che sta chiamando (per costUsd e trace). */
export interface PiStreamMeta {
  fromCatalog: boolean
  local: boolean
  /** fase 18b (H1.3): il prezzo personalizzato $/1M (solo fuori catalogo, non locale) */
  customPrice?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /**
   * Fase velocità (S2): i livelli di ragionamento offerti da /api/show per un
   * sintetico Ollama (assente per tutto il resto): decide la mappa
   * off → "none" e il predefinito medium di S2.4.
   */
  ollamaOffered?: ThinkingSetting[] | null
}

/**
 * H1.1: le api di pi-ai che NON fanno retry di trasporto proprie (maxRetries
 * ignorato). Verificato leggendo dist/api/*.js della 1.4.0: openai-completions,
 * openai-responses e anthropic-messages passano options.maxRetries all'SDK
 * (FetchHttpClient maxRetries); mistral-conversations usa fetch DIRETTO senza
 * alcun retry. Se pi-ai aggiunge i retry a mistral, questa lista si svuota.
 */
const NO_SELF_RETRY_APIS = new Set(['mistral-conversations'])

/** Il retry di H1.1 vale solo prima del primo evento di contenuto e per 429/5xx/rete. */
function retryEligibleError(e: LlmProviderError): boolean {
  // stessa regex di fallbackEligible (rete/scadenza/5xx) più il 429
  return e.status === 429 || fallbackEligible(e)
}

/** Il backoff di H1.1, interrompibile dal segnale del turno. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PiUserAbortError())
      return
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new PiUserAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Il risultato di thinkingModelOf: modello, opzione reasoning e cosa va sul filo. */
interface ThinkingChoice {
  model: Model<Api>
  reasoning?: SimpleStreamOptions['reasoning']
  /**
   * Fase velocità (S1/S2): il valore di reasoning_effort partito sul filo
   * (per la traccia): il livello, "none" per «spento» su Ollama, null se
   * nessuna opzione di ragionamento è partita.
   */
  reasoningWire: string | null
}

/**
 * H3: il modello e le opzioni reasoning per il livello scelto dal bot.
 * 'default' o assente → il comportamento della 18a ESATTO (nessuna opzione
 * reasoning, modello invariato). Sui sintetici non-zai non-ollama il livello
 * si ignora (modello che non dichiara reasoning).
 * K1: 'off' NON si passa MAI a pi-ai come stringa — nel contratto di
 * streamSimple «spento» si dice OMITTENDO reasoning: openai-responses,
 * openai-completions e mistral-conversations convertono a mano 'off' in
 * undefined, ma anthropic-messages con QUALUNQUE stringa accende il
 * ragionamento (e manderebbe max_tokens null: errore 400 a ogni turno).
 * Quindi 'off' → { model } senza reasoning, identico a «Predefinito» sul filo.
 * Fase velocità (S2) — Ollama che ragiona (ollamaOffered non vuoto): qui
 * l'omissione NON è neutra (varrebbe «predefinito del modello»), quindi
 * «spento» viaggia come reasoning_effort "none" tramite la thinkingLevelMap
 * del sintetico (off → "none": openai-completions la legge quando l'opzione
 * reasoning non c'è). «Predefinito» manda medium se è tra i livelli offerti,
 * altrimenti il livello più basso con nome (glm-5.3: low invece del suo max);
 * per i modelli solo acceso/spento «Predefinito» non manda niente.
 */
/** I livelli con nome, dal più basso al più alto (per il «Predefinito» Ollama). */
const OLLAMA_NAMED_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function thinkingModelOf(
  model: Model<Api>,
  thinking: ThinkingSetting | undefined,
  zai: boolean,
  ollamaOffered?: ThinkingSetting[] | null
): ThinkingChoice {
  // il livello CONCRETTO scelto dal bot ('default'/assente non è un livello)
  const requested = thinking && thinking !== 'default' ? thinking : undefined
  // il sintetico Ollama con livelli: il clamp sale al primo livello offerto
  // (la thinkingLevelMap del sintetico esclude quelli che /api/show non dà)
  if (ollamaOffered?.length) {
    if (!requested) {
      const named = OLLAMA_NAMED_LEVELS.filter((l) => ollamaOffered.includes(l))
      // «Predefinito»: medium se c'è; altrimenti il livello PIÙ BASSO con
      // nome — mai il predefinito del modello, che per glm-5.3 è max (misura
      // vera 2026-11-04: a max chiamate da 8–15 s, a low nessuna sopra 4 s).
      // Un modello solo acceso/spento (unico livello: high) resta senza opzione.
      const pick = named.includes('medium') ? 'medium' : named.length === 1 && named[0] === 'high' ? undefined : named[0]
      return pick
        ? { model, reasoning: pick, reasoningWire: pick }
        : // NESSUNA opzione sul filo. La mappa del sintetico va tolta:
          // openai-completions leggerebbe thinkingLevelMap.off ("none")
          // anche senza opzione reasoning
          { model: { ...model, thinkingLevelMap: undefined }, reasoningWire: null }
    }
    const level = clampThinkingLevel(model, requested)
    return level === 'off'
      ? { model, reasoningWire: 'none' }
      : { model, reasoning: level, reasoningWire: level }
  }
  if (!requested) return { model, reasoningWire: null }
  if (zai) {
    // zai sintetico: il modello dichiara reasoning e il compat thinkingFormat
    // 'zai' manda "thinking":{"type":"enabled"|"disabled"} — 'off' si dice
    // SENZA l'opzione reasoning (pi-ai riceve reasoningEffort undefined e
    // manda disabled), gli altri livelli con reasoning 'high' (→ enabled)
    const clone = { ...model, reasoning: true } as unknown as Model<Api>
    return requested === 'off'
      ? { model: clone, reasoningWire: null }
      : { model: clone, reasoning: 'high', reasoningWire: 'high' }
  }
  if (model.reasoning) {
    // catalogo: clampThinkingLevel porta il livello a quelli che il modello
    // sa esprimere (per un modello senza 'off' il livello si ALZA al primo
    // supportato, come sempre)
    const level = clampThinkingLevel(model, requested)
    return level === 'off'
      ? { model, reasoningWire: null }
      : { model, reasoning: level, reasoningWire: level }
  }
  return { model, reasoningWire: null }
}

/**
 * Il cuore dello stream (E2.4): consuma gli eventi pi-ai e li ributta come
 * LlmChunk dello stesso contratto di sempre. Testabile col faux provider con
 * una Models collection qualsiasi.
 * Fase 18b: retry di trasporto prima del primo evento per le api senza retry
 * propri (H1.1) e costo dai prezzi personalizzati (H1.3).
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
  const zai = (model as unknown as { compat?: { thinkingFormat?: string } }).compat?.thinkingFormat === 'zai'
  const chosen = thinkingModelOf(model, opts.thinking, zai && !meta.fromCatalog, meta.ollamaOffered)
  const streamModel = chosen.model
  const context = toPiContext(messages, tools, { api: streamModel.api, provider: streamModel.provider, model: streamModel.id })
  // K6: il CHIAMANTE decide i retry dell'SDK — il loop passa 0 quando dopo
  // l'anello attivo c'è ancora una riserva utilizzabile (il passaggio d'anello
  // sostituisce il retry); assente = 2, come sempre. NON è un campo del body:
  // opzione dell'SDK, il body resta identico byte per byte.
  const sdkMaxRetries = opts.maxRetries ?? 2
  // E2.2/E2.5: chiave esplicita, temperatura (E2.6) quando c'è, ragionamento
  // (H3) quando è scelto. Fase velocità (S4): sessionId stabile per
  // conversazione (affinità/cache del provider); cacheRetention NON si tocca
  // (pi-ai ha già «short» come predefinito)
  const baseOpts: SimpleStreamOptions = {
    signal,
    apiKey: opts.apiKey,
    maxRetries: sdkMaxRetries,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(chosen.reasoning !== undefined ? { reasoning: chosen.reasoning } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {})
  }
  // fase velocità (S1): i numeri della chiamata per la traccia — SOLO numeri
  // e nomi, mai il contenuto (le lunghezze sono dei JSON serializzati)
  const systemBytes = messages.filter((m) => m.role === 'system').reduce((n, m) => n + m.content.length, 0)
  const messagesBytes = JSON.stringify(messages.filter((m) => m.role !== 'system')).length
  const toolsBytes = JSON.stringify(tools).length
  const sessionHash = opts.sessionId ? createHash('sha256').update(opts.sessionId).digest('hex').slice(0, 8) : null

  async function* iterate(): AsyncIterable<LlmChunk> {
    // H1.1: riprova (max 2, backoff 500/1000 ms) SOLO per le api senza retry
    // propri in pi-ai, SOLO prima di qualsiasi evento di contenuto e SOLO su
    // 429/5xx/rete. Dopo il primo evento NON si ritenta mai: il loop ha già
    // mostrato del testo.
    // K6: col maxRetries a 0 (riserve disponibili) niente retry neanche qui —
    // la stessa regola del loop: il passaggio d'anello sostituisce il retry.
    const selfRetry = !NO_SELF_RETRY_APIS.has(streamModel.api)
    const backoffs = sdkMaxRetries > 0 ? [500, 1000] : []
    for (let attempt = 0; ; attempt++) {
      // fase velocità (S1): i tempi si misurano dall'invio di QUESTO tentativo
      const sentAt = Date.now()
      const eventStream = models.streamSimple(streamModel, context, baseOpts)
      // accumulo dei tool call in ordine di contentIndex: escono TUTTI alla fine
      const toolCallsByIndex = new Map<number, ToolCall>()
      let contentLen = 0
      let reasoningLen = 0
      let usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null = null
      let finish = 'stop'
      let sawContent = false
      let firstTokenMs: number | null = null
      let firstTokenWasReasoning = false
      let retry: { ms: number } | null = null
      for await (const ev of eventStream) {
        if (ev.type === 'text_delta') {
          sawContent = true
          if (firstTokenMs === null) firstTokenMs = Date.now() - sentAt
          contentLen += ev.delta.length
          yield { textDelta: ev.delta }
        } else if (ev.type === 'thinking_delta') {
          sawContent = true
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - sentAt
            firstTokenWasReasoning = true
          }
          reasoningLen += ev.delta.length
          yield { reasoningDelta: ev.delta }
        } else if (ev.type.startsWith('toolcall_')) {
          sawContent = true
          if (ev.type === 'toolcall_end') {
            toolCallsByIndex.set(ev.contentIndex, {
              id: ev.toolCall.id,
              name: ev.toolCall.name,
              arguments: JSON.stringify(ev.toolCall.arguments)
            })
          }
        } else if (ev.type === 'done') {
          finish = finishReasonOf(ev.reason)
          const u = ev.message.usage
          usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }
          const ordered = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
          const chunk: LlmChunk = {
            ...(ordered.length ? { toolCalls: ordered } : {}),
            finishReason: finish,
            usage: {
              input: u.input,
              output: u.output,
              cacheRead: u.cacheRead,
              cacheWrite: u.cacheWrite,
              costUsd: costUsdOf(u, meta)
            }
          }
          traceLlmCall({
            at: new Date().toISOString(), model: streamModel.id, finishReason: finish,
            contentLength: contentLen, reasoningLength: reasoningLen,
            toolCalls: ordered.length, usage,
            // fase velocità (S1): dove siamo nel turno e cosa è partito
            turnId: opts.trace?.turnId ?? null,
            callIndex: opts.trace?.callIndex ?? null,
            firstTokenMs,
            totalMs: Date.now() - sentAt,
            ...(firstTokenWasReasoning ? { reasoningFirstMs: firstTokenMs } : {}),
            toolsCount: tools.length,
            toolsBytes,
            systemBytes,
            messagesBytes,
            thinkingSent: chosen.reasoningWire,
            sessionHash
          })
          yield chunk
        } else if (ev.type === 'error') {
          if (ev.reason === 'aborted') throw new PiUserAbortError()
          const err = new LlmProviderError(ev.error.errorMessage ?? 'provider error')
          const canRetry = !selfRetry && !sawContent && attempt < backoffs.length && retryEligibleError(err)
          if (canRetry) retry = { ms: backoffs[attempt]! }
          else throw err
        }
      }
      if (!retry) return
      await abortableSleep(retry.ms, signal)
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
  const fromCatalog = entry.catalogIds.has(modelId)
  // H1.3: il prezzo personalizzato vale SOLO fuori catalogo e SOLO su provider
  // non locali — il chiamante passa il setting intero (providers.modelPrices)
  // e l'adattatore risolve la coppia provider+modello della CHIAMATA (così la
  // riserva che cambia modello rilegge il prezzo giusto)
  const customPrice = !fromCatalog && !entry.local ? opts.modelPrices?.[p.id]?.[modelId] : undefined
  // fase velocità (S2): i livelli offerti da /api/show per il sintetico Ollama
  const ollamaOffered = !fromCatalog && p.kind === 'ollama' ? ollamaOfferedLevels(p, modelId) : null
  return streamPi(entry.models, model, { fromCatalog, local: entry.local, ...(customPrice ? { customPrice } : {}), ...(ollamaOffered ? { ollamaOffered } : {}) }, messages, tools, signal, {
    ...opts,
    // E2.2: chiave sempre esplicita; i locali senza chiave mandano
    // 'not-needed' (come l'adattatore di sempre), i provider col catalogo
    // con chiave vuota falliscono con un errore chiaro, non con un 401 opaco
    apiKey: entry.local ? p.apiKey || 'not-needed' : p.apiKey
  })
}
