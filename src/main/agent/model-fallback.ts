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
 * K4: il tetto della catena CONFIGURATA (models.fallbackChain): in gira al
 * massimo il numero di voci valide che la UI stessa permette di salvare. Il
 * primario e la riserva dello stesso provider NON contano nel tetto (il tetto
 * è dell'elenco dell'utente, non della catena effettiva).
 */
export const MAX_CHAIN_ENTRIES = 4

/**
 * H2.1: la catena effettiva delle rotte di un turno — [primary, fallbackModel
 * del provider di primary (se c'è), ...chain]. Si tolgono i doppioni (stesso
 * providerId + model) e le voci il cui provider non esiste o è disabilitato.
 * Il primo elemento è SEMPRE primary. Catena vuota = [primary]: il
 * comportamento di chi non configura niente è esattamente quello di oggi.
 * K4: della catena configurata valgono al massimo le PRIME MAX_CHAIN_ENTRIES
 * voci VALIDE (le altre si ignorano, come se la UI non le avesse permesse).
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
  // K4: le prime MAX_CHAIN_ENTRIES voci VALIDE della catena configurata; le
  // voci non valide (provider inesistente/disabilitato, modello vuoto) non
  // consumano il tetto
  const capped: Route[] = []
  for (const r of (Array.isArray(deps.chain) ? deps.chain : [])) {
    if (capped.length >= MAX_CHAIN_ENTRIES) break
    if (usable(r)) capped.push(r)
  }
  const first = deps.modelDefaults[primary.providerId]?.fallbackModel
  const candidates: Route[] = [
    primary,
    ...(first && first !== primary.model ? [{ providerId: primary.providerId, model: first }] : []),
    ...capped
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

/**
 * K7: ciò che il turno CHIEDE a un anello della catena. La stima dei token è
 * quella di sempre (estimateTokensOf di memory.ts); `needsImages` vale se ci
 * sono immagini nei messaggi del turno OPPURE use-app è nei tool offerti
 * (l'unico che restituisce immagini).
 */
export interface RouteNeed {
  inputTokens: number
  needsImages: boolean
}

/**
 * K7 (pura): un anello può SERVIRE il turno? Usa SOLO dati conosciuti —
 * niente chiamate, niente stimatori nuovi. Risponde il MOTIVO inglese dello
 * scarto (finisce nel log del daemon, senza testo dei messaggi) o null.
 * 1. Contesto: solo per i modelli di CATALOGO (il 128k dei sintetici è un
 *    valore di comodo, non un dato). Incompatibile se la finestra non basta
 *    per la stima + la riserva d'uscita + un margine: riserva =
 *    min(maxTokens, 8192), margine = max(256, 10% della stima) — come in
 *    Rakazo (fallbackIncompatibility), che però non arrotonda la riserva al
 *    quarto della finestra: qui segue la spec.
 * 2. Immagini: il turno ne ha e la visione è conosciuta FALSA → chi non vede
 *    non può servire. Con vision null si prova (decide il server).
 * 3. Ragionamento: NON scarta mai — il livello si clampa per chiamata
 *    (l'adattatore lo fa già); una riserva senza ragionamento gira spenta.
 */
export function routeIncompatibility(
  caps: { fromCatalog: boolean; contextWindow: number; vision: boolean | null; maxTokens?: number },
  need: RouteNeed
): string | null {
  if (caps.fromCatalog) {
    const outputReserve = Math.min(caps.maxTokens ?? 8192, 8192)
    const margin = Math.max(256, Math.ceil(need.inputTokens * 0.1))
    if (caps.contextWindow <= need.inputTokens + outputReserve + margin) {
      return `context window ${caps.contextWindow} too small for ~${need.inputTokens} input tokens`
    }
  }
  if (need.needsImages && caps.vision === false) {
    return 'model cannot see the images this turn needs'
  }
  return null
}

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
  /**
   * K7: un anello NON può servire il turno? (routeIncompatibility). Si salta
   * come uno raffreddato, MA senza raffreddarlo: al turno dopo (o con una
   * conversazione più corta) resta utilizzabile. Il motivo, quando c'è, va
   * nel log del daemon.
   */
  incompatible?: (route: Route) => string | null
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
 *
 * K7: gli anelli INCOMPATIBILI col turno si saltano come i raffreddati (ma
 * non si raffreddano); se sono TUTTI incompatibili il turno chiude con
 * l'errore originale, come oggi senza riserve.
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
    if (s.incompatible?.(r)) continue
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
