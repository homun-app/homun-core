// Fase 18b (H2.3): il raffreddamento degli anelli della catena delle riserve
// (H2) — in memoria nel processo del daemon, NIENTE database: dopo un
// riavvio si riparte da zero, ed è voluto (un riavvio è già passato del
// tempo). L'anello che ha appena fallito con un 429/limite d'uso resta in
// pausa 10 minuti; con 5xx/rete/scadenza dello stream 60 secondi. Una
// chiamata riuscita toglie il raffreddamento (markHealthy).
import type { FallbackRoute } from '../../shared/types'

/** 429 o limite d'uso (stesso account, quota condivisa): pausa lunga. */
export const COOLDOWN_RATE_LIMIT_MS = 10 * 60_000
/** 5xx, errore di rete o scadenza dello stream: pausa breve. */
export const COOLDOWN_SERVER_MS = 60_000

/** Il motivo del raffreddamento decide la durata. */
export type CooldownReason = 'rate-limit' | 'server'

const cooled = new Map<string, { until: number }>()

const keyOf = (route: FallbackRoute): string => `${route.providerId}|${route.model}`

/** Raffredda un anello fino a now + durata (il motivo decide quale). */
export function coolDown(route: FallbackRoute, reason: CooldownReason, now: number): number {
  const until = now + (reason === 'rate-limit' ? COOLDOWN_RATE_LIMIT_MS : COOLDOWN_SERVER_MS)
  cooled.set(keyOf(route), { until })
  return until
}

/** L'anello è in raffreddamento adesso? */
export function isCooled(route: FallbackRoute, now: number): boolean {
  return cooledUntil(route, now) !== null
}

/** L'istante di fine del raffreddamento (null = non raffreddato o già finito). */
export function cooledUntil(route: FallbackRoute, now: number): number | null {
  const e = cooled.get(keyOf(route))
  if (!e) return null
  if (e.until <= now) {
    cooled.delete(keyOf(route))
    return null
  }
  return e.until
}

/** Una chiamata riuscita toglie il raffreddamento dell'anello. */
export function markHealthy(route: FallbackRoute): void {
  cooled.delete(keyOf(route))
}

/** Svuota lo stato (solo i test). */
export function resetRouteHealth(): void {
  cooled.clear()
}
