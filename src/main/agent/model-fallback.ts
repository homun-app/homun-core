// Fase 9 (punto 1) → fase 18b (H2): la RISERVA è diventata una CATENA ordinata
// di anelli provider+modello (il modello dei router LLM maturi: LiteLLM,
// OpenRouter `models: [...]`). Il vecchio fallbackModel dello stesso provider
// resta il PRIMO anello dopo il primario; models.fallbackChain (H2.1) ne
// aggiunge altri, anche su provider diversi — il caso reale che la riserva
// sullo stesso account non risolve (il limite settimanale di Ollama cloud).
// Modulo PURO, testato senza rete.
//
// Nota: gli errori di rete del provider (connessione rifiutata/reset) valgono
// come "il modello principale non risponde": la riprova costa poco, ed è
// esattamente il caso in cui la riserva serve.
import type { FallbackRoute } from '../../shared/types'
import type { ModelDefaultsMap } from './model-defaults'
import { stopReasonOfError } from './loop-guard'

export type Route = FallbackRoute

export interface FallbackState {
  /** Il modello di riserva configurato per il provider (null: nessuno). */
  fallbackModel: string | null
  /** Il modello che è appena fallito. */
  model: string
  /** La riserva è già stata usata in questo turno (una volta sola). */
  fallbackUsed: boolean
  /** Il turno è stato interrotto (dall'utente): mai riserva. */
  aborted: boolean
}

/** L'errore ammette la riserva? (5xx / timeout / scadenza dello stream / rete) */
export function fallbackEligible(err: unknown): boolean {
  // fase 8: scadenza dello stream (nessun token / inattività) — name, non
  // instanceof, così i test e i bundle non dipendono dal modulo
  if (err instanceof Error && err.name === 'StreamDeadlineError') return true
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number') return status >= 500 // 4xx = richiesta sbagliata: mai
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /timeout|timed out|etimedout|econnreset|econnrefused|socket hang up|fetch failed|network error|terminated/.test(msg)
}

/**
 * H2.1: la catena effettiva delle rotte di un turno — [primary, fallbackModel
 * del provider di primary (se c'è), ...chain]. Si tolgono i doppioni (stesso
 * providerId + model) e le voci il cui provider non esiste o è disabilitato.
 * Il primo elemento è SEMPRE primary. Catena vuota = [primary]: il
 * comportamento di chi non configura niente è esattamente quello di oggi.
 */
export function routeChain(
  primary: Route,
  deps: {
    providers: Array<{ id: string; kind: string; enabled: boolean }>
    modelDefaults: ModelDefaultsMap
    chain: Route[]
  }
): Route[] {
  const byId = new Map(deps.providers.map((p) => [p.id, p]))
  const usable = (r: Route): boolean => {
    const p = byId.get(r.providerId)
    return !!p && p.enabled && typeof r.model === 'string' && r.model !== ''
  }
  const first = deps.modelDefaults[primary.providerId]?.fallbackModel
  const candidates: Route[] = [
    primary,
    ...(first && first !== primary.model ? [{ providerId: primary.providerId, model: first }] : []),
    ...(Array.isArray(deps.chain) ? deps.chain : [])
  ]
  const out: Route[] = []
  const seen = new Set<string>()
  for (const r of candidates) {
    // primary è SEMPRE primo, anche se il suo provider fosse disabilitato
    // dopo la costruzione (la catena si valuta una volta a inizio turno)
    if (r === primary || usable(r)) {
      const key = `${r.providerId}|${r.model}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

/** Al massimo 3 passaggi di anello per turno (H2.2). */
export const MAX_ROUTE_SWITCHES = 3

export interface NextRouteState {
  /** la catena effettiva (routeChain): chain[0] è il primario del turno */
  chain: Route[]
  /** l'indice dell'anello che è appena fallito */
  current: number
  /** quanti passaggi d'anello già fatti in questo turno (tetto MAX_ROUTE_SWITCHES) */
  switches: number
  /** un anello è in raffreddamento? (H2.3: si salta chi è in pausa) */
  cooled: (route: Route) => boolean
  /** il turno è stato interrotto (dall'utente): mai passare d'anello */
  aborted: boolean
}

/**
 * H2.2: QUANDO si passa all'anello successivo — restituisce l'indice
 * dell'anello da usare o null (il turno chiude con l'errore).
 *
 * | errore                                            | regola                                     |
 * |---------------------------------------------------|--------------------------------------------|
 * | turno interrotto dall'utente                      | mai                                        |
 * | scadenza dello stream, 5xx, rete                  | primo anello successivo non raffreddato    |
 * | 429 / limite d'uso (stopReasonOfError rate-limit) | primo anello successivo non raffreddato con|
 * |                                                   | providerId DIVERSO (stesso account=quota)  |
 * | altri 4xx                                         | mai (la richiesta è sbagliata)             |
 */
export function nextRoute(err: unknown, s: NextRouteState): number | null {
  if (s.aborted) return null
  if (s.switches >= MAX_ROUTE_SWITCHES) return null
  if (s.chain.length <= s.current + 1) return null
  const rateLimited = stopReasonOfError(err) === 'rate-limit'
  if (!rateLimited && !fallbackEligible(err)) return null
  const failed = s.chain[s.current]!
  for (let i = s.current + 1; i < s.chain.length; i++) {
    const r = s.chain[i]!
    if (rateLimited && r.providerId === failed.providerId) continue
    if (s.cooled(r)) continue
    return i
  }
  return null
}

/**
 * La decisione della fase 9, com'era: UNA riprova col modello di riserva
 * dello stesso provider. È il caso particolare di una catena con un solo
 * anello in più (H2.2): la scrive su nextRoute così le regole vivono in un
 * solo posto e i test della fase 9 continuano a valere.
 */
export function shouldUseFallback(err: unknown, s: FallbackState): boolean {
  if (!s.fallbackModel || s.fallbackModel === s.model) return false
  return nextRoute(err, {
    chain: [
      { providerId: 'p', model: s.model },
      { providerId: 'p', model: s.fallbackModel }
    ],
    current: 0,
    switches: s.fallbackUsed ? MAX_ROUTE_SWITCHES : 0,
    cooled: () => false,
    aborted: s.aborted
  }) !== null
}
