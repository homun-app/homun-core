// Registry provider + autodiscovery locale (Ollama :11434, LM Studio :1234).
// Tutti i provider non-Anthropic parlano OpenAI-compatible: un solo codice.
import { listProviders, saveProviders } from '../store/db'
// fase 17c (C3): gli errori del check dei tool si mostrano in impostazioni e
// onboarding — testo del catalogo UI
import { uiText } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { ProviderConfig, ProviderKind, ModelInfo } from '../../shared/types'

export const KNOWN_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  mistral: 'https://api.mistral.ai',
  openrouter: 'https://openrouter.ai/api',
  // fase 18a (E2.1): l'API a CONSUMO, mai /api/coding/paas/v4 (GLM Coding
  // Plan: i termini di z.ai lo vietano agli strumenti di terzi). I provider
  // salvati con l'url vecchio si correggono in lettura in llm-pi.ts
  zai: 'https://api.z.ai/api/paas/v4',
  xai: 'https://api.x.ai',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai'
}

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

/** Lista modelli di un provider: /api/tags per Ollama, /v1/models per gli altri. */
export async function listProviderModels(p: ProviderConfig): Promise<ModelInfo[]> {
  const base = p.baseUrl.replace(/\/$/, '')
  if (p.kind === 'ollama') {
    const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = (await r.json()) as { models?: Array<{ name: string; details?: { parameter_size?: string } }> }
    return (j.models ?? []).map((m) => ({ id: m.name, label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name }))
  }
  const r = await fetch(base + '/v1/models', {
    headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
    signal: AbortSignal.timeout(8000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = (await r.json()) as { data?: Array<{ id: string }> }
  return (j.data ?? []).map((m) => ({ id: m.id }))
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
 */
export async function modelSupportsTools(
  p: ProviderConfig,
  model: string
): Promise<{ ok: boolean; checked: boolean; error?: string }> {
  const base = p.baseUrl.replace(/\/$/, '')
  if (p.kind !== 'ollama') return { ok: true, checked: false }
  try {
    const r = await fetch(base + '/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(8000)
    })
    if (!r.ok) return { ok: false, checked: true, error: uiText(UI.providersCannotVerify, { model, provider: p.name, error: `HTTP ${r.status}` }) }
    const j = (await r.json()) as { capabilities?: string[] }
    if (!(j.capabilities ?? []).includes('tools')) {
      return { ok: false, checked: true, error: uiText(UI.providersNoTools, { model }) }
    }
    return { ok: true, checked: true }
  } catch (e) {
    return { ok: false, checked: true, error: uiText(UI.providersCannotVerify, { model, provider: p.name, error: e instanceof Error ? e.message : String(e) }) }
  }
}

export function getProvider(id: string): ProviderConfig | undefined {
  return listProviders().find((p) => p.id === id)
}
