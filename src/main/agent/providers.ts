// Registry provider + autodiscovery locale (Ollama :11434, LM Studio :1234).
// Tutti i provider non-Anthropic parlano OpenAI-compatible: un solo codice.
// Fase 18b (H5.2): l'elenco vivo dei modelli — l'URL e gli header li calcola
// live-models (modulo puro condiviso con l'adattatore); questo file NON
// importa pi-ai. Le capability Ollama (/api/show) si cachano per
// providerId + nome + digest: un modello aggiornato rilegge.
//
// Fase 16c (C1): le chiavi API vivono CIFRATE a riposo. Il setting
// 'providers' contiene SOLO l'envelope `apiKeySealed` (chiave AES-256 nella
// voce Keychain PROPRIA `sandbot-providers-key`); il chiaro sta SOLO in
// memoria nel daemon (`plainKeys`), da dove lo legge getProvider() per llm,
// test e catalogo. Verso il renderer si usa publicProviders(): mai la chiave.
import { getSetting, setSetting } from '../store/db'
// fase 17c (C3): gli errori del check dei tool si mostrano in impostazioni e
// onboarding — testo del catalogo UI
import { uiText, uiError } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { ProviderConfig, ProviderKind, ProviderPublic, ProviderSaveInput, ModelInfo, SealedKey, MainModel } from '../../shared/types'
export type { ProviderSaveInput } from '../../shared/types'
import { liveModelsUrl, liveModelsHeaders, ollamaCapabilities, setOllamaCapabilities, readOllamaCapabilities, isLocalKind, KNOWN_BASE_URLS } from './live-models'
import { sealProviderKey, openProviderKey, keyHintOf, isSealedKey, type ProviderKeyDeps } from './provider-keys'
import { getProvidersKey, type SecurityRunner } from '../../daemon/keychain'
import { isMasterKeyUnavailableError } from '../../daemon/master-keys'

// fase 18b (H5.2): i base URL noti vivono nel modulo puro live-models (li
// legge anche l'adattatore); re-esportati per i chiamanti storici
export { KNOWN_BASE_URLS }

/**
 * La forma a RIPOSO nel setting 'providers': niente `apiKey` in chiaro (dopo
 * la migrazione resta solo `apiKeySealed`; se il Portachiavi non risponde il
 * chiaro sopravvive fino al prossimo avvio, non si perde mai una chiave).
 */
export type StoredProvider = Omit<ProviderConfig, 'apiKey'> & {
  apiKey?: string
  apiKeySealed?: SealedKey
}

export function storedProviders(): StoredProvider[] {
  return getSetting<StoredProvider[]>('providers', [])
}

function saveStoredProviders(list: StoredProvider[]): void {
  setSetting('providers', list)
}

/** Le chiavi in chiaro del daemon: SOLO in memoria, mai nel database. */
const plainKeys = new Map<string, string>()

/** Il runner `security` dei test (il daemon usa quello dell'ambiente). */
let keychainRunner: SecurityRunner | undefined
export function setProviderKeychainRunner(run: SecurityRunner | undefined): void {
  keychainRunner = run
}

function keyDeps(): ProviderKeyDeps {
  return { getKey: () => getProvidersKey(keychainRunner) }
}

/**
 * La vista del daemon: il chiaro torna DENTRO il daemon (llm, test, catalogo).
 * Se una chiave non è ancora in memoria (boot senza migrazione) resta '': le
 * chiamate falliscono con l'errore del provider, mai un crash.
 */
export function listProviders(): ProviderConfig[] {
  return storedProviders().map((p) => ({ ...p, apiKey: plainKeys.get(p.id) ?? p.apiKey ?? '' }))
}

export function getProvider(id: string): ProviderConfig | undefined {
  return listProviders().find((p) => p.id === id)
}

/**
 * Fase 16c (C1): la vista del RENDERER — `apiKey` sempre vuota, `hasKey` e
 * `keyHint` (ultimi 4 caratteri) al posto. Nessuna RPC restituisce di più.
 */
export function publicProviders(): ProviderPublic[] {
  return storedProviders().map((p) => {
    const plain = plainKeys.get(p.id) ?? p.apiKey ?? ''
    const hasKey = isSealedKey(p.apiKeySealed) || plain.length > 0
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      ...(p.discovered ? { discovered: true } : {}),
      apiKey: '' as const,
      hasKey,
      ...(plain ? { keyHint: keyHintOf(plain) } : {})
    }
  })
}

/**
 * Fase 16c (C1), migrazione all'avvio, IDEMPOTENTE: le chiavi in chiaro si
 * cifrano e il chiaro si toglie; le sigillate si aprono in memoria. Se il
 * Portachiavi non risponde, il chiaro RESTA (avviso SENZA la chiave) e si
 * riprova al prossimo avvio: non si perde mai una chiave.
 * Fase 16c correzioni (R2.1): torna `changed` — ha cifrato qualcosa? Allora
 * il boot fa checkpoint+VACUUM (vacuumAfterKeyMigration).
 */
export async function migrateProviderKeys(): Promise<boolean> {
  const list = storedProviders()
  let changed = false
  for (const p of list) {
    if (p.apiKey && p.apiKey.trim()) {
      try {
        const key = p.apiKey.trim()
        const sealed = await sealProviderKey(keyDeps(), key)
        p.apiKeySealed = sealed
        delete p.apiKey
        plainKeys.set(p.id, key)
        changed = true
      } catch {
        console.warn(`[providers] chiave API di "${p.name}" non cifrata: Portachiavi non disponibile, riprovo al prossimo avvio`)
      }
    } else if (isSealedKey(p.apiKeySealed)) {
      try {
        plainKeys.set(p.id, await openProviderKey(keyDeps(), p.apiKeySealed))
      } catch (e) {
        console.error(`[providers] chiave di "${p.name}" non leggibile dal Portachiavi: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  if (changed) saveStoredProviders(list)
  return changed
}

/**
 * Fase 16c correzioni (R2.1): dopo una migrazione che ha cifrato chiavi, i
 * byte del chiaro restano nel WAL (le pagine vecchie) e nello spazio libero
 * del file principale finché non vengono sovrascritte. Checkpoint TRUNCATE +
 * VACUUM, UNA volta sola (setting 'providers.migrationVacuumed'); il VACUUM
 * riscrive il file e toglie anche i resti nelle pagine libere. Se fallisce
 * (database occupato) si logga SENZA dati e si riprova al prossimo avvio:
 * il flag resta spento finché la pulizia non è riuscita.
 */
export function vacuumAfterKeyMigration(db: { exec(sql: string): unknown }, changed: boolean): void {
  if (getSetting<boolean>('providers.migrationVacuumed', false)) return
  // niente di cambiato e nessuna chiave sigillata nella memoria: non c'è mai
  // stato un chiaro da ripulire (il flag scatta solo quando serve davvero)
  if (!changed && !storedProviders().some((p) => isSealedKey(p.apiKeySealed))) return
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    setSetting('providers.migrationVacuumed', true)
  } catch (e) {
    console.error(`[providers] pulizia del database dopo la migrazione rimandata al prossimo avvio: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Fase 16c (C1): il salvataggio — `apiKey` vuota o assente CONSERVA la chiave
 * esistente; una chiave nuova la sostituisce; `clearKey: true` la toglie. Se
 * il Portachiavi non risponde mentre si dovrebbe cifrare, si lanciano le
 * vecchie testo/errore del catalogo e la chiave VECCHIA resta al suo posto.
 */
export async function saveProvider(input: ProviderSaveInput): Promise<void> {
  const list = storedProviders()
  const idx = list.findIndex((p) => p.id === input.id)
  const prev = idx >= 0 ? list[idx]! : undefined
  const next: StoredProvider = {
    id: input.id,
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
    enabled: input.enabled,
    ...(input.discovered ? { discovered: true } : {}),
    ...(prev?.apiKeySealed ? { apiKeySealed: prev.apiKeySealed } : {}),
    // fase 16c correzioni (R2.2): il chiaro NON ancora migrato (Portachiavi
    // giù all'avvio) resta nel setting — senza questa riga modificare nome o
    // URL senza ridigitare la chiave la cancellava dal disco: persa per sempre
    ...(prev?.apiKey ? { apiKey: prev.apiKey } : {})
  }
  const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (input.clearKey === true) {
    delete next.apiKeySealed
    delete next.apiKey
    plainKeys.delete(input.id)
  } else if (newKey) {
    try {
      next.apiKeySealed = await sealProviderKey(keyDeps(), newKey)
      // la chiave nuova è sigillata: il chiaro (eventuale) del precedente si toglie
      delete next.apiKey
      plainKeys.set(input.id, newKey)
    } catch (e) {
      // K1.8 (fase rilascio — correzioni): MasterKeyUnavailableError porta il
      // testo del catalogo così com'è (arriva dove arrivano gli errori dei
      // provider); per il resto il Portachiavi non risponde e la chiave VECCHIA
      // resta al suo posto
      if (isMasterKeyUnavailableError(e)) throw e
      throw uiError(UI.rpcKeychainUnavailable)
    }
  } else if (prev?.apiKey) {
    // chiaro non ancora migrato (Portachiavi giù): il daemon lo continua a usare
    plainKeys.set(input.id, prev.apiKey)
  }
  if (idx >= 0) list[idx] = next
  else list.push(next)
  saveStoredProviders(list)
}

/** Fase 16c (C3.3): togliere il provider del modello principale lo azzera. */
export function deleteProvider(id: string): void {
  saveStoredProviders(storedProviders().filter((p) => p.id !== id))
  plainKeys.delete(id)
  if (getSetting<MainModel | null>('models.main', null)?.providerId === id) {
    setSetting('models.main', null)
  }
}

/** Scanner dei servizi LLM locali in ascolto. */
export async function discoverProviders(): Promise<ProviderPublic[]> {
  const found: Array<{ kind: ProviderKind; name: string; url: string }> = []
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
        if (ctl.ok) found.push(p)
      } catch {
        // servizio non attivo: normale
      }
    })
  )
  const existing = storedProviders()
  const merged = [...existing]
  for (const f of found) {
    if (!merged.some((m) => m.id === f.kind)) {
      merged.push({ id: f.kind, name: f.name, kind: f.kind, baseUrl: f.url, enabled: true, discovered: true })
    }
  }
  saveStoredProviders(merged)
  return publicProviders()
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
 * Fase 16c (C3.4): la prova di una configurazione NON salvata — la stessa
 * logica di testProvider. L'errore torna come CODICE leggibile
 * ('invalid-key' | 'unreachable' | 'error'), mai un testo che possa portare
 * la chiave: qualunque messaggio interno viene ripulito.
 */
export function probeProviderError(err: unknown, apiKey = ''): string {
  const status = (err as { status?: unknown }).status
  const msg = err instanceof Error ? err.message : String(err)
  if (typeof status === 'number' && (status === 401 || status === 403)) return 'invalid-key'
  if (/\b401\b|\b403\b/.test(msg)) return 'invalid-key'
  const unreachable = (typeof status === 'number' && status >= 500) ||
    /timeout|timed out|etimedout|econnreset|econnrefused|fetch failed|network|terminated|HTTP 5\d\d/i.test(msg)
  if (unreachable) return 'unreachable'
  // difesa in profondità: qualunque dettaglio porta SOLO lo status, mai testo
  void apiKey
  return 'error'
}

export async function probeProvider(config: { kind: ProviderKind; baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const probe: ProviderConfig = {
    id: '__probe__',
    name: 'probe',
    kind: config.kind,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey ?? '',
    enabled: true
  }
  try {
    const models = await listProviderModels(probe)
    return { ok: true, models: models.map((m) => m.id) }
  } catch (e) {
    return { ok: false, error: probeProviderError(e) }
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
