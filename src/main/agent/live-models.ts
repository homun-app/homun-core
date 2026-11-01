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
import type { ProviderConfig, ProviderKind } from '../../shared/types'

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

/** I kind che parlano solo in locale (nessuna chiave, costo nullo). */
export const LOCAL_KINDS: ReadonlySet<ProviderKind> = new Set(['ollama', 'lmstudio', 'openai-compatible', 'custom'])

/** Il provider è tutto locale (ollama, lmstudio, openai-compatible, custom)? */
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

const capByDigest = new Map<string, string[]>()
/** il digest ATTUALE di un modello (aggiunto da /api/tags quando si elenca) */
const digestOf = new Map<string, string>()

const modelKey = (providerId: string, model: string): string => `${providerId}|${model}`

/** Le capability lette da /api/show per QUEL digest (null = mai lette). */
export function ollamaCapabilities(providerId: string, model: string, digest?: string): string[] | null {
  const d = digest ?? digestOf.get(modelKey(providerId, model))
  if (!d) return null
  return capByDigest.get(`${modelKey(providerId, model)}|${d}`) ?? null
}

/** Memorizza le capability di un modello col suo digest (un modello aggiornato rilegge). */
export function setOllamaCapabilities(providerId: string, model: string, digest: string | undefined, capabilities: string[]): void {
  const key = modelKey(providerId, model)
  // senza digest (es. /api/show di modelSupportsTools) si aggiorna la voce del
  // digest attuale; se il modello non è mai passato da /api/tags si cachea
  // sotto un chiave senza digest: meglio fresco che niente
  const d = digest ?? digestOf.get(key) ?? 'no-digest'
  digestOf.set(key, d)
  capByDigest.set(`${key}|${d}`, capabilities)
}

/** Svuota la cache (solo i test). */
export function resetOllamaCapabilities(): void {
  capByDigest.clear()
  digestOf.clear()
}
