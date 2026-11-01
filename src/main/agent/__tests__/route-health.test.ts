// Fase 18b (H2.3): il raffreddamento degli anelli della catena — durate,
// markHealthy, e il riparto da primary quando sono tutti raffreddati.
import { describe, expect, it, beforeEach } from 'vitest'
import { coolDown, isCooled, cooledUntil, markHealthy, resetRouteHealth, COOLDOWN_RATE_LIMIT_MS, COOLDOWN_SERVER_MS } from '../route-health'

const route = { providerId: 'pa', model: 'm1' }
const T0 = 1_700_000_000_000

beforeEach(() => resetRouteHealth())

describe('route-health (H2.3)', () => {
  it('429/limite d\'uso → 10 minuti; 5xx/rete/scadenza → 60 secondi', () => {
    expect(coolDown(route, 'rate-limit', T0)).toBe(T0 + COOLDOWN_RATE_LIMIT_MS)
    expect(cooledUntil(route, T0)).toBe(T0 + COOLDOWN_RATE_LIMIT_MS)
    expect(COOLDOWN_RATE_LIMIT_MS).toBe(10 * 60_000)
    coolDown(route, 'server', T0)
    expect(cooledUntil(route, T0)).toBe(T0 + COOLDOWN_SERVER_MS)
    expect(COOLDOWN_SERVER_MS).toBe(60_000)
  })

  it('isCooled vero finché la pausa non scade, falso dopo', () => {
    coolDown(route, 'server', T0)
    expect(isCooled(route, T0)).toBe(true)
    expect(isCooled(route, T0 + COOLDOWN_SERVER_MS - 1)).toBe(true)
    expect(isCooled(route, T0 + COOLDOWN_SERVER_MS)).toBe(false)
    // scaduta, la voce si è pulita: cooledUntil torna null
    expect(cooledUntil(route, T0 + COOLDOWN_SERVER_MS)).toBeNull()
  })

  it('markHealthy toglie il raffreddamento di una chiamata riuscita', () => {
    coolDown(route, 'rate-limit', T0)
    expect(isCooled(route, T0)).toBe(true)
    markHealthy(route)
    expect(isCooled(route, T0)).toBe(false)
  })

  it('le rotte sono indipendenti (providerId + model)', () => {
    coolDown(route, 'rate-limit', T0)
    expect(isCooled({ providerId: 'pa', model: 'altra' }, T0)).toBe(false)
    expect(isCooled({ providerId: 'pb', model: 'm1' }, T0)).toBe(false)
  })

  it('"tutti raffreddati → primary": chi chiama (il loop) riparte da chain[0] quando findIndex non trova niente', () => {
    // la regola H2.3 vista dal punto di vista di chi costruisce la catena:
    // ogni anello raffreddato, il findIndex del loop restituisce -1 → 0
    const chain = [
      { providerId: 'pa', model: 'm1' },
      { providerId: 'pb', model: 'm2' }
    ]
    for (const r of chain) coolDown(r, 'rate-limit', T0)
    const start = chain.findIndex((r) => !isCooled(r, T0))
    expect(start).toBe(-1)
    expect(chain[start === -1 ? 0 : start]!).toEqual(chain[0])
  })
})
