// Fase 9 (punto 1) — test puri della decisione della RISERVA:
// 5xx/timeout/scadenza sì, 4xx mai, una sola volta per turno.
// Fase 18b (H2): la riserva è una CATENA — test di routeChain e nextRoute.
// Fase 18b (K7): routeIncompatibility — quando un anello NON può servire il turno.
import { describe, expect, it } from 'vitest'
import { fallbackEligible, shouldUseFallback, routeChain, nextRoute, routeIncompatibility, type Route, type NextRouteState } from '../model-fallback'
import type { ModelDefaultsMap } from '../model-defaults'

const httpError = (status: number): Error => {
  const e = new Error(`HTTP ${status}`)
  ;(e as Error & { status?: number }).status = status
  return e
}
const deadline = (): Error => {
  // fase 17c correzioni (D2): il messaggio di StreamDeadlineError è inglese
  const e = new Error('no token within 150 s')
  e.name = 'StreamDeadlineError'
  return e
}
const state = (patch: Partial<Parameters<typeof shouldUseFallback>[1]> = {}) => ({
  fallbackModel: 'riserva',
  model: 'principale',
  fallbackUsed: false,
  aborted: false,
  ...patch
})

describe('fallbackEligible', () => {
  it('5xx → sì (502, 500, 503)', () => {
    expect(fallbackEligible(httpError(500))).toBe(true)
    expect(fallbackEligible(httpError(502))).toBe(true)
    expect(fallbackEligible(httpError(503))).toBe(true)
  })

  it('4xx → MAI (richiesta sbagliata: la riserva farebbe lo stesso errore)', () => {
    expect(fallbackEligible(httpError(400))).toBe(false)
    expect(fallbackEligible(httpError(401))).toBe(false)
    expect(fallbackEligible(httpError(404))).toBe(false)
    expect(fallbackEligible(httpError(429))).toBe(false)
  })

  it('scadenza dello stream (fase 8) → sì', () => {
    expect(fallbackEligible(deadline())).toBe(true)
  })

  it('timeout e errori di rete del provider → sì (il principale non risponde)', () => {
    expect(fallbackEligible(new Error('Request timed out'))).toBe(true)
    expect(fallbackEligible(new Error('fetch failed'))).toBe(true)
    expect(fallbackEligible(new Error('ECONNREFUSED 127.0.0.1:11434'))).toBe(true)
    expect(fallbackEligible(new Error('socket hang up'))).toBe(true)
  })

  it('altri errori senza status → no (non si sa cosa sia: si chiude e basta)', () => {
    expect(fallbackEligible(new Error('invalid JSON response'))).toBe(false)
    expect(fallbackEligible('una stringa')).toBe(false)
  })
})

describe('shouldUseFallback', () => {
  it('decisione completa: 5xx con riserva disponibile → una riprova', () => {
    expect(shouldUseFallback(httpError(502), state())).toBe(true)
  })

  it('UNA volta sola per turno; senza riserva configurata mai; riserva uguale al principale mai', () => {
    expect(shouldUseFallback(httpError(502), state({ fallbackUsed: true }))).toBe(false)
    expect(shouldUseFallback(httpError(502), state({ fallbackModel: null }))).toBe(false)
    expect(shouldUseFallback(httpError(502), state({ fallbackModel: 'principale' }))).toBe(false)
  })

  it('turno interrotto dall\'utente → mai riserva', () => {
    expect(shouldUseFallback(httpError(502), state({ aborted: true }))).toBe(false)
  })

  it('4xx con tutto il resto a posto → no', () => {
    expect(shouldUseFallback(httpError(400), state())).toBe(false)
  })
})

// ---- fase 18b (H2.1): routeChain — la catena effettiva del turno ----

const chainDeps = (providers: Array<{ id: string; kind: string; enabled: boolean }>, modelDefaults: ModelDefaultsMap = {}, chain: Route[] = []) =>
  ({ providers, modelDefaults, chain })
const pA = { id: 'pa', kind: 'groq', enabled: true }
const pB = { id: 'pb', kind: 'openai', enabled: true }
const pOff = { id: 'poff', kind: 'ollama', enabled: false }

describe('routeChain (H2.1)', () => {
  it('catena vuota e senza fallbackModel = [primary]: il comportamento di oggi', () => {
    expect(routeChain({ providerId: 'pa', model: 'm1' }, chainDeps([pA]))).toEqual([{ providerId: 'pa', model: 'm1' }])
  })

  it('fallbackModel del provider di primary è il PRIMO anello dopo il primario', () => {
    const out = routeChain(
      { providerId: 'pa', model: 'm1' },
      chainDeps([pA, pB], { pa: { fallbackModel: 'm-stessa' } }, [{ providerId: 'pb', model: 'x' }])
    )
    expect(out).toEqual([
      { providerId: 'pa', model: 'm1' },
      { providerId: 'pa', model: 'm-stessa' },
      { providerId: 'pb', model: 'x' }
    ])
  })

  it('i DOPPIONI (stesso providerId + model) si tolgono — vince la prima posizione', () => {
    const out = routeChain(
      { providerId: 'pa', model: 'm1' },
      chainDeps([pA, pB], { pa: { fallbackModel: 'x' } }, [
        { providerId: 'pa', model: 'x' },
        { providerId: 'pb', model: 'x' },
        { providerId: 'pb', model: 'x' }
      ])
    )
    expect(out).toEqual([
      { providerId: 'pa', model: 'm1' },
      { providerId: 'pa', model: 'x' },
      { providerId: 'pb', model: 'x' }
    ])
  })

  it('le voci con provider inesistente o DISABILITATO si tolgono; primary resta SEMPRE primo', () => {
    const out = routeChain(
      { providerId: 'pa', model: 'm1' },
      chainDeps([pA, pOff], {}, [
        { providerId: 'poff', model: 'y' },
        { providerId: 'manca', model: 'z' }
      ])
    )
    expect(out).toEqual([{ providerId: 'pa', model: 'm1' }])
  })

  it('K4: al massimo le PRIME 4 voci VALIDE della catena configurata (primario e riserva dello stesso provider NON contano)', () => {
    const pC = { id: 'pc', kind: 'zai', enabled: true }
    const out = routeChain(
      { providerId: 'pa', model: 'm1' },
      chainDeps([pA, pB, pC, pOff], { pa: { fallbackModel: 'm-stessa' } }, [
        { providerId: 'poff', model: 'no' },   // non valida: NON consuma il tetto
        { providerId: 'manca', model: 'no' },  // non valida: NON consuma il tetto
        { providerId: 'pb', model: 'c1' },
        { providerId: 'pc', model: 'c2' },
        { providerId: 'pa', model: 'c3' },
        { providerId: 'pb', model: 'c4' },
        { providerId: 'pb', model: 'c5' }      // oltre il tetto: ignorata
      ])
    )
    expect(out).toEqual([
      { providerId: 'pa', model: 'm1' },       // primario: fuori dal tetto
      { providerId: 'pa', model: 'm-stessa' }, // riserva stesso provider: fuori dal tetto
      { providerId: 'pb', model: 'c1' },
      { providerId: 'pc', model: 'c2' },
      { providerId: 'pa', model: 'c3' },
      { providerId: 'pb', model: 'c4' }
    ])
  })
})

// ---- fase 18b (H2.2): nextRoute — quando si passa all'anello successivo ----

const chain4: Route[] = [
  { providerId: 'pa', model: 'm1' },
  { providerId: 'pa', model: 'm2' },   // stesso provider del primario
  { providerId: 'pb', model: 'm3' },   // ALTRO provider
  { providerId: 'pc', model: 'm4' }    // terzo provider
]
const providers4 = [pA, pB, { id: 'pc', kind: 'zai', enabled: true }]

const next = (err: unknown, patch: Partial<NextRouteState> = {}): number | null =>
  nextRoute(err, {
    chain: chain4,
    current: 0,
    switches: 0,
    cooled: () => false,
    aborted: false,
    ...patch
  })

describe('nextRoute (H2.2) — tutte le righe della tabella', () => {
  it('turno interrotto dall\'utente → MAI', () => {
    expect(next(httpError(502), { aborted: true })).toBeNull()
    expect(next(rateLimit(), { aborted: true })).toBeNull()
  })

  it('StreamDeadlineError / 5xx / rete → il primo anello successivo non raffreddato (stesso provider compreso)', () => {
    expect(next(deadline())).toBe(1)
    expect(next(httpError(503))).toBe(1)
    expect(next(new Error('fetch failed: connect ECONNREFUSED'))).toBe(1)
  })

  it('429 o limite d\'uso → si SALTA lo stesso provider: il primo anello di un ALTRO provider', () => {
    expect(next(rateLimit())).toBe(2)
    // "usage limit" nel messaggio, senza status: stesso verdetto
    expect(next(new Error('429 Too Many Requests: usage limit reached'))).toBe(2)
  })

  it('altri 4xx → MAI (la richiesta è sbagliata: fallirebbe uguale altrove)', () => {
    expect(next(httpError(400))).toBeNull()
    expect(next(httpError(401))).toBeNull()
    expect(next(httpError(404))).toBeNull()
  })

  it('il primo anello successivo RAFFREDDATO si salta', () => {
    expect(next(httpError(503), { cooled: (r) => r.model === 'm2' })).toBe(2)
    // col 429 il filtro provider resta: m3 è il primo di altro provider non raffreddato
    expect(next(rateLimit(), { cooled: (r) => r.model === 'm3' })).toBe(3)
  })

  it('tutti i successivi raffreddati → null (il turno chiude con l\'errore)', () => {
    expect(next(httpError(503), { cooled: () => true })).toBeNull()
  })

  it('tetto di 3 passaggi per turno', () => {
    expect(next(httpError(503), { current: 1, switches: 2 })).toBe(2)
    expect(next(httpError(503), { current: 1, switches: 3 })).toBeNull()
    expect(next(httpError(503), { current: 2, switches: 3 })).toBeNull()
  })

  it('nessun anello dopo il corrente → null', () => {
    expect(next(httpError(503), { current: 3 })).toBeNull()
  })

  it('il caso di oggi: catena [primario, riserva stesso provider] — il 429 NON passa alla riserva', () => {
    const chain2: Route[] = [
      { providerId: 'pa', model: 'm1' },
      { providerId: 'pa', model: 'm-riserva' }
    ]
    expect(nextRoute(httpError(503), { chain: chain2, current: 0, switches: 0, cooled: () => false, aborted: false })).toBe(1)
    expect(nextRoute(rateLimit(), { chain: chain2, current: 0, switches: 0, cooled: () => false, aborted: false })).toBeNull()
  })

  it('K7: un anello INCOMPATIBILE in mezzo si salta (come un raffreddato); se lo sono TUTTI → null', () => {
    // il PRIMO anello successivo (m2) non può servire il turno: si passa a m3
    const incompatible = (r: Route): string | null => (r.model === 'm2' ? 'context window too small' : null)
    expect(next(httpError(503), { incompatible })).toBe(2)
    // stesso anello dopo un primo passaggio: m3 è il primo buono
    expect(next(httpError(503), { current: 1, incompatible: (r) => (r.model === 'm3' ? 'no images' : null) })).toBe(3)
    // tutti i successivi incompatibili → il turno chiude con l'errore originale
    expect(next(httpError(503), { incompatible: () => 'no' })).toBeNull()
    // col 429 il filtro provider resta E l'incompatibile si salta: m2 è dello
    // stesso provider (saltato comunque), m3 incompatibile → m4
    expect(next(rateLimit(), { incompatible: (r) => (r.model === 'm3' ? 'no images' : null) })).toBe(3)
  })
})

// ---- fase 18b (K7): routeIncompatibility — può l'anello servire il turno? ----

describe('routeIncompatibility (K7)', () => {
  const caps = (patch: Partial<Parameters<typeof routeIncompatibility>[0]> = {}) => ({
    fromCatalog: true,
    contextWindow: 128_000,
    vision: true,
    maxTokens: 8192,
    ...patch
  })

  it('contesto che NON ci sta (catalogo): finestra <= stima + riserva d\'uscita + margine', () => {
    // 8192 di finestra, 8192 di riserva d'uscita (min(maxTokens, 8192)): non c'è
    // MAI stanza per l'ingresso — gpt-4 del catalogo openai è così
    expect(routeIncompatibility(caps({ contextWindow: 8192, maxTokens: 8192 }), { inputTokens: 10, needsImages: false })).toMatch(/context window 8192 too small/)
    // margine = max(256, 10% della stima): 128k non basta per ~120k token
    expect(routeIncompatibility(caps(), { inputTokens: 120_000, needsImages: false })).toMatch(/too small/)
    // con la riserva d'uscita minore la stessa stima ci sta
    expect(routeIncompatibility(caps({ maxTokens: 4096 }), { inputTokens: 100_000, needsImages: false })).toBeNull()
  })

  it('stesso caso su un SINTETICO: NON si scarta (il 128k è un valore di comodo, non un dato)', () => {
    expect(routeIncompatibility(caps({ fromCatalog: false, contextWindow: 128_000 }), { inputTokens: 500_000, needsImages: false })).toBeNull()
  })

  it('immagini: vision FALSA → incompatibile; vision NULL → si prova (decide il server)', () => {
    expect(routeIncompatibility(caps({ vision: false }), { inputTokens: 10, needsImages: true })).toMatch(/cannot see the images/)
    expect(routeIncompatibility(caps({ vision: null }), { inputTokens: 10, needsImages: true })).toBeNull()
    // il turno NON ha immagini: la visione falsa non scarta nulla
    expect(routeIncompatibility(caps({ vision: false }), { inputTokens: 10, needsImages: false })).toBeNull()
  })

  it('il ragionamento NON scarta mai (il livello si clampa per chiamata, come in Rakazo)', () => {
    // la funzione non riceve nemmeno il livello: non esiste una regola che lo usi
    expect(routeIncompatibility(caps({ vision: true }), { inputTokens: 10, needsImages: false })).toBeNull()
  })
})

/** L'errore del limite d'uso come arriva dai provider (status 429). */
function rateLimit(): Error {
  const e = new Error('429 Rate limit exceeded: usage limit reached')
  ;(e as Error & { status?: number }).status = 429
  return e
}
