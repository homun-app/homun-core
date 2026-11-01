// Registry provider + autodiscovery locale (Ollama :11434, LM Studio :1234).
// Tutti i provider non-Anthropic parlano OpenAI-compatible: un solo codice.
// Fase 18b (H5.2): l'elenco vivo dei modelli — l'URL e gli header li calcola
// live-models (modulo puro condiviso con l'adattatore); questo file NON
// importa pi-ai. Le capability Ollama (/api/show) si cachano per
// providerId + nome + digest: un modello aggiornato rilegge.
import { listProviders, saveProviders } from '../store/db'
// fase 17c (C3): gli errori del check dei tool si mostrano in impostazioni e
// onboarding — testo del catalogo UI
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { ProviderConfig, ProviderKind, ModelInfo } from '../../shared/types'
import { liveModelsUrl, liveModelsHeaders, ollamaCapabilities, setOllamaCapabilities, readOllamaCapabilities, isLocalKind, KNOWN_BASE_URLS } from './live-models'

// fase 18b (H5.2): i base URL noti vivono nel modulo puro live-models (li
// legge anche l'adattatore); re-esportati per i chiamanti storici
export { KNOWN_BASE_URLS }

/** Scanner dei servizi LLM locali in ascolto. */
export async function discoverProviders(): Promise<ProviderConfig[]> {
  const found: ProviderConfig[] = []
  const probes: Array<{ kind: ProviderKind; name: string; url: string }> = [
    { kind: 'ollama', name: 'Ollama (locale)', url: KNOWN_BASE_URLS.ollama! },
    { kind: 'lmstudio', name: 'LM Studio (locale)', url: KNOWN_BASE_URLS.lmstudio! }
  ]
  await Promise.all(
    probes.map(async (p) => {
      try {
        const ctl = await fetch(p.url.replace(/\/$/, '') + (p.kind === 'ollama' ? '/api/tags' : '/v1/models'), {
          signal: AbortSignal.timeout(1500)
        })
        if (ctl.ok) {
          found.push({
            id: p.kind, name: p.name, kind: p.kind, baseUrl: p.url, apiKey: '',
            enabled: true, discovered: true
          })
        }
      } catch {
        // servizio non attivo: normale
      }
    })
  )
  const existing = listProviders()
  const merged = [...existing]
  for (const f of found) {
    if (!merged.some((m) => m.id === f.id)) merged.push(f)
  }
  saveProviders(merged)
  return merged
}

/** Una voce dell'elenco vivo: capacità SCONOSCIUTE tranne quelle cachate (Ollama). */
function liveInfo(p: ProviderConfig, id: string, label?: string): ModelInfo {
  const caps = p.kind === 'ollama' ? ollamaCapabilities(p.id, id) : null
  return {
    id,
    ...(label && label !== id ? { label } : {}),
    source: 'live',
    vision: caps ? caps.includes('vision') : null,
    tools: caps ? caps.includes('tools') : null,
    thinkingLevels: [],
    cost: null,
    costSource: null,
    local: isLocalKind(p.kind)
  }
}

/** Massimo 4 /api/show in parallelo (H5.2). */
async function eachWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Fase 18b (H5.2): l'elenco VIVO dei modelli di un provider, corretto per kind:
 * - ollama: GET /api/tags, poi POST /api/show per le capability (max 4 in
 *   parallelo, cache per providerId+nome+digest: un modello aggiornato rilegge);
 * - anthropic: GET /v1/models con x-api-key e anthropic-version: 2023-06-01
 *   (il vecchio Bearer su …/v1/models era rotto);
 * - zai: GET https://api.z.ai/api/paas/v4/models con Bearer (MAI /coding/);
 * - tutti gli altri: GET {base OpenAI-compatible}/models con Bearer se c'è la chiave.
 * L'unione col catalogo pi-ai vive nell'RPC models:list (H5.1).
 */
export async function listProviderModels(p: ProviderConfig): Promise<ModelInfo[]> {
  if (p.kind === 'ollama') {
    const base = p.baseUrl.replace(/\/+$/, '')
    const r = await fetch(liveModelsUrl(p), { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = (await r.json()) as { models?: Array<{ name: string; digest?: string; details?: { parameter_size?: string } }> }
    const list = j.models ?? []
    // le capability mancanti si leggono da /api/show (al massimo 4 in parallelo)
    const missing = list.filter((m) => !ollamaCapabilities(p.id, m.name, m.digest))
    await eachWithConcurrency(missing, 4, async (m) => {
      try {
        const sr = await fetch(base + '/api/show', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.name }),
          signal: AbortSignal.timeout(8000)
        })
        if (!sr.ok) return
        const sj = (await sr.json()) as { capabilities?: string[] }
        setOllamaCapabilities(p.id, m.name, m.digest, sj.capabilities ?? [])
      } catch {
        // capabilities non leggibili: vision/tools restano sconosciuti (null)
      }
    })
    return list.map((m) => liveInfo(p, m.name, m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name))
  }
  const r = await fetch(liveModelsUrl(p), {
    headers: liveModelsHeaders(p),
    signal: AbortSignal.timeout(8000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = (await r.json()) as { data?: Array<{ id: string; display_name?: string }> }
  return (j.data ?? []).map((m) => liveInfo(p, m.id, m.display_name))
}

export async function testProvider(p: ProviderConfig): Promise<{ ok: boolean; error?: string; models?: ModelInfo[] }> {
  try {
    const models = await listProviderModels(p)
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Fase 9 (punto 1): il modello supporta i tool? Serve PRIMA di assegnarlo a un
 * agente (un modello senza tool non può chiamare send_to_user: muto). Ollama
 * espone le capability in /api/show; gli altri provider non le espongono in
 * modo standard e non vengono controllati (checked: false).
 * Fase 18b (H5.2): usa la STESSA cache di /api/show dell'elenco vivo — se le
 * capability sono già state lette (elenco, check precedente) non si rifà la
 * chiamata. K3: la lettura passa dall'helper CONDIVISO readOllamaCapabilities
 * (stessa cache di models:capabilities e del loop), qui con timeout lungo.
 */
export async function modelSupportsTools(
  p: ProviderConfig,
  model: string
): Promise<{ ok: boolean; checked: boolean; error?: string }> {
  if (p.kind !== 'ollama') return { ok: true, checked: false }
  const { caps, error } = await readOllamaCapabilities(p, model, 8000)
  if (!caps) return { ok: false, checked: true, error: uiText(UI.providersCannotVerify, { model, provider: p.name, error: error ?? 'unknown' }) }
  if (!caps.includes('tools')) return { ok: false, checked: true, error: uiText(UI.providersNoTools, { model }) }
  return { ok: true, checked: true }
}

export function getProvider(id: string): ProviderConfig | undefined {
  return listProviders().find((p) => p.id === id)
}
