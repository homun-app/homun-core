// Fase 18b (H5.2): le regole degli URL/Header dell'ELENCO VIVO dei modelli, in
// un modulo PURO senza pi-ai e senza store — lo importano sia providers.ts
// (l'elenco vivo) sia llm-pi.ts (openAiCompatBase e la correzione zai): la
// regola vive in UN solo posto, senza duplicazioni e senza cicli.
//
// Qui vive anche la cache in memoria delle capability Ollama (chiave
// providerId + nome + digest, da /api/tags + /api/show): la riempie
// providers.ts quando elenca i modelli o controlla i tool, la legge
// llm-pi.ts per modelCapabilities (H1.2) — un modello aggiornato (digest
// nuovo) rilegge le capability invece di usare quelle vecchie.
// Fase velocità (S2): in cache con le caps c'è anche `thinking: { values,
// default }` di /api/show, sempre per providerId+nome+digest.
import type { ProviderConfig, ProviderKind, ThinkingSetting } from '../../shared/types'

/** L'endpoint a consumo di z.ai (MAI /api/coding/paas/v4: è il Coding Plan). */
export const ZAI_CONSUMPTION_BASE_URL = 'https://api.z.ai/api/paas/v4'

/**
 * I base URL noti dei kind (fase 18a E2.1): l'API a CONSUMO di z.ai, mai
 * /api/coding/paas/v4 (GLM Coding Plan: i termini di z.ai lo vietano agli
 * strumenti di terzi). Spostati qui dalla 18b: li legge anche l'adattatore,
 * e così llm-pi.ts non dipende più da providers.ts.
 */
export const KNOWN_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  mistral: 'https://api.mistral.ai',
  openrouter: 'https://openrouter.ai/api',
  zai: ZAI_CONSUMPTION_BASE_URL,
  xai: 'https://api.x.ai',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai'
}

/** I kind che parlano solo in locale (nessuna chiave, costo nullo). Fase
 * locale (L3): anche homun-local, il modello integrato gestito dal daemon. */
export const LOCAL_KINDS: ReadonlySet<ProviderKind> = new Set(['ollama', 'lmstudio', 'homun-local', 'openai-compatible', 'custom'])

/** Il provider è tutto locale (ollama, lmstudio, homun-local, openai-compatible, custom)? */
export function isLocalKind(kind: string): boolean {
  return LOCAL_KINDS.has(kind as ProviderKind)
}

/**
 * Fase 18a (E2.1): il base URL dei provider OpenAI-compatible — la regola di
 * oggi (appende '/v1') ma SOLO se l'URL non finisce già con /v<n> o /api/paas/v4.
 * (Funzione SPOSTATA qui dalla 18b: la usano l'adattatore e l'elenco vivo.)
 */
export function openAiCompatBase(p: Pick<ProviderConfig, 'baseUrl'>): string {
  const base = (typeof p.baseUrl === 'string' ? p.baseUrl : '').trim().replace(/\/+$/, '')
  if (/\/v\d+$/.test(base) || /\/api\/paas\/v4$/.test(base)) return base
  return base + '/v1'
}

/** Il baseUrl letto con la correzione zai (l'API a consumo, MAI il Coding Plan). */
export function liveModelsBase(p: Pick<ProviderConfig, 'baseUrl' | 'kind'>): string {
  const base = (typeof p.baseUrl === 'string' ? p.baseUrl : '').trim().replace(/\/+$/, '')
  // correzione in LETTURA dei provider zai salvati con l'url vecchio
  if (p.kind === 'zai') return ZAI_CONSUMPTION_BASE_URL
  return base
}

/**
 * L'URL dell'elenco vivo dei modelli di un provider (H5.2):
 * - ollama: /api/tags (le capability arrivano da /api/show, a parte);
 * - anthropic: /v1/models con x-api-key e anthropic-version;
 * - zai: l'API a consumo /models con Bearer (MAI /coding/);
 * - tutti gli altri: {base OpenAI-compatible}/models con Bearer se c'è la chiave.
 */
export function liveModelsUrl(p: Pick<ProviderConfig, 'baseUrl' | 'kind'>): string {
  const base = liveModelsBase(p)
  if (p.kind === 'ollama') return base + '/api/tags'
  if (p.kind === 'anthropic') return base + '/v1/models'
  if (p.kind === 'zai') return base + '/models'
  return openAiCompatBase({ baseUrl: base }) + '/models'
}

/** Gli header dell'elenco vivo: anthropic usa x-api-key + anthropic-version, gli altri Bearer. */
export function liveModelsHeaders(p: Pick<ProviderConfig, 'kind' | 'apiKey'>): Record<string, string> {
  if (p.kind === 'anthropic') {
    return { 'x-api-key': p.apiKey ?? '', 'anthropic-version': '2023-06-01' }
  }
  return p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}
}

// ---- cache delle capability Ollama (providerId + nome + digest) ----

/**
 * Fase velocità (S2): le informazioni di ragionamento di /api/show
 * (`thinking: { values, default }`). `values` può contenere booleani
 * (acceso/spento) o nomi decisi dal modello («low», «medium», «high»…);
 * `default` è il livello predefinito del modello (messo in cache, la regola
 * del «Predefinito» del bot resta quella decisa in S2.4).
 */
export interface OllamaThinkingInfo {
  values: Array<string | boolean>
  default?: string | boolean
}

/** Una voce della cache: caps + thinking (thinking undefined = non ancora letta). */
interface OllamaCapEntry {
  caps: string[]
  /** null = letto, il modello non dichiara thinking; undefined = non letto */
  thinking?: OllamaThinkingInfo | null
}

const capByDigest = new Map<string, OllamaCapEntry>()
/** il digest ATTUALE di un modello (aggiunto da /api/tags quando si elenca) */
const digestOf = new Map<string, string>()

const modelKey = (providerId: string, model: string): string => `${providerId}|${model}`

/** Le capability lette da /api/show per QUEL digest (null = mai lette). */
export function ollamaCapabilities(providerId: string, model: string, digest?: string): string[] | null {
  const d = digest ?? digestOf.get(modelKey(providerId, model))
  if (!d) return null
  return capByDigest.get(`${modelKey(providerId, model)}|${d}`)?.caps ?? null
}

/**
 * Fase velocità (S2): le informazioni di ragionamento di /api/show per quel
 * digest. null = lette, il modello non le dichiara; undefined = mai lette
 * (una cache vecchia senza thinking resta valida per le caps e si rilegge
 * alla prossima occasione).
 */
export function ollamaThinkingInfo(providerId: string, model: string, digest?: string): OllamaThinkingInfo | null | undefined {
  const d = digest ?? digestOf.get(modelKey(providerId, model))
  if (!d) return undefined
  return capByDigest.get(`${modelKey(providerId, model)}|${d}`)?.thinking
}

/** Memorizza le capability di un modello col suo digest (un modello aggiornato rilegge). */
export function setOllamaCapabilities(
  providerId: string,
  model: string,
  digest: string | undefined,
  capabilities: string[],
  thinking?: OllamaThinkingInfo | null
): void {
  const key = modelKey(providerId, model)
  // senza digest (es. /api/show di modelSupportsTools) si aggiorna la voce del
  // digest attuale; se il modello non è mai passato da /api/tags si cachea
  // sotto un chiave senza digest: meglio fresco che niente
  const d = digest ?? digestOf.get(key) ?? 'no-digest'
  digestOf.set(key, d)
  // thinking assente (chiamata pre-S2 o writer che non lo conosce): la voce
  // resta caps-only e readOllamaCapabilities la rilegge alla prossima occasione
  capByDigest.set(`${key}|${d}`, { caps: capabilities, ...(thinking !== undefined ? { thinking } : {}) })
}

/** Svuota la cache (solo i test). */
export function resetOllamaCapabilities(): void {
  capByDigest.clear()
  digestOf.clear()
}

/**
 * Fase velocità (S2): il parse della risposta di /api/show (puro) — caps e
 * thinking insieme, così tutte le strade che leggono /api/show (elenco vivo,
 * check dei tool, turno) riempiono la STESSA cache con la STESSA forma.
 */
export function parseOllamaShow(j: unknown): { caps: string[]; thinking: OllamaThinkingInfo | null } {
  const o = (j ?? {}) as { capabilities?: unknown; thinking?: { values?: unknown; default?: unknown } }
  const caps = Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === 'string') : []
  const t = o.thinking
  if (!t || typeof t !== 'object' || !Array.isArray(t.values)) return { caps, thinking: null }
  const values = t.values.filter((v): v is string | boolean => typeof v === 'string' || typeof v === 'boolean')
  const def = t.default
  return {
    caps,
    thinking: { values, ...(typeof def === 'string' || typeof def === 'boolean' ? { default: def } : {}) }
  }
}

/** Il risultato di una lettura /api/show: caps null = non lette (errore/scadenza). */
export interface OllamaShowResult {
  caps: string[] | null
  /** fase velocità (S2): null = non letto o assente nella risposta */
  thinking?: OllamaThinkingInfo | null
  error?: string
}

/**
 * Fase 18b (K3): UNA lettura delle capability di UN modello Ollama via
 * POST /api/show, che riempie la STESSA cache dell'elenco vivo e del check
 * dei tool (providerId+nome+digest). Se la voce c'è già, NESSUNA chiamata.
 * Timeout breve di default (1500 ms) per i chiamanti del turno: se la lettura
 * fallisce o scade, caps resta null e le capability restano sconosciute.
 * Fase velocità (S2): legge anche `thinking: { values, default }`; una voce
 * cache vecchia senza thinking resta valida per le caps e si rilegge qui.
 */
export async function readOllamaCapabilities(
  p: Pick<ProviderConfig, 'id' | 'baseUrl'>,
  model: string,
  timeoutMs = 1500
): Promise<OllamaShowResult> {
  const key = modelKey(p.id, model)
  const d = digestOf.get(key)
  const cached = d ? capByDigest.get(`${key}|${d}`) : undefined
  if (cached && cached.thinking !== undefined) return { caps: cached.caps, thinking: cached.thinking }
  const base = (typeof p.baseUrl === 'string' ? p.baseUrl : '').replace(/\/+$/, '')
  try {
    const r = await fetch(base + '/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!r.ok) return { caps: cached?.caps ?? null, thinking: null, error: `HTTP ${r.status}` }
    const { caps, thinking } = parseOllamaShow(await r.json())
    setOllamaCapabilities(p.id, model, undefined, caps, thinking)
    return { caps, thinking }
  } catch (e) {
    return { caps: cached?.caps ?? null, thinking: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---- fase velocità (S2): da thinking.values ai livelli offerti nella UI ----

/** I nomi che coincidono con un ThinkingSetting, nell'ordine del selettore. */
const THINKING_LEVEL_NAMES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Fase velocità (S2), pura: da `thinking: { values }` di /api/show ai livelli
 * offerti nella UI (i quattro casi della documentazione di Ollama letta il
 * 2026-11-04):
 * - `values` con nomi: i nomi che coincidono con un ThinkingSetting, più
 *   `off` se `values` contiene `false` o `"none"`; `reasoning: true`;
 * - `values` solo booleani `[true, false]`: `['off', 'high']` (come zai:
 *   acceso/spento);
 * - `[false]`: nessun livello, `reasoning: false` (il modello non ragiona);
 * - oggetto assente (info null/undefined): come oggi, nessun livello.
 */
export function ollamaThinkingLevels(info: OllamaThinkingInfo | null | undefined): { levels: ThinkingSetting[]; reasoning: boolean } {
  if (!info) return { levels: [], reasoning: false }
  const names = THINKING_LEVEL_NAMES.filter((l) => info.values.includes(l))
  const hasOff = info.values.includes(false) || info.values.includes('none')
  if (names.length > 0) {
    return { levels: [...(hasOff ? (['off'] as const) : []), ...names], reasoning: true }
  }
  // solo booleani: [true, false] → spento/acceso come zai; [false] → non ragiona
  const hasTrue = info.values.includes(true)
  if (hasTrue && hasOff) return { levels: ['off', 'high'], reasoning: true }
  if (hasTrue) return { levels: ['high'], reasoning: true }
  return { levels: [], reasoning: false }
}
