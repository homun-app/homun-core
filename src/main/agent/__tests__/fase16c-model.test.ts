// Fase 16c (C3.3): resolveAgentModel, newAgentModel e assignFirstMainModel —
// «Come gli altri». Moduli PURI, nessuno store, nessuna rete.
// Fase impostazioni (I3): assignFirstMainModel scrive anche la RISERVA del
// tipo (prima voce di models.fallbackChain) e il REVISORE del tipo in
// autoReview — le dipendenze new (getChain/setChain/getReviewer/setReviewer)
// si iniettano anche qui.
import { describe, expect, it } from 'vitest'
import { resolveAgentModel, newAgentModel, assignFirstMainModel } from '../model-defaults'
import type { AutoReviewSettings, FallbackRoute, MainModel } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'

const main: MainModel = { providerId: 'p_main', model: 'glm-5.1', thinking: 'medium' }

/** Le dipendenze di sempre + quelle nuove di I3, con memoria dei valori scritti. */
function deps(
  over: Partial<Parameters<typeof assignFirstMainModel>[0]> = {},
  initial: { chain?: FallbackRoute[]; reviewer?: AutoReviewSettings } = {}
): {
  chain: FallbackRoute[]
  reviewer: AutoReviewSettings
  d: Parameters<typeof assignFirstMainModel>[0]
} {
  let chain: FallbackRoute[] = initial.chain ? [...initial.chain] : []
  let reviewer: AutoReviewSettings = initial.reviewer ?? { ...DEFAULT_AUTO_REVIEW }
  const d = {
    getMain: () => null,
    setMain: () => undefined,
    savedProvider: () => null,
    getOverrides: () => ({}),
    supportsTools: async () => ({ ok: true, checked: true }),
    getChain: () => chain,
    setChain: (c: FallbackRoute[]) => { chain = c },
    getReviewer: () => reviewer,
    setReviewer: (cfg: AutoReviewSettings) => { reviewer = cfg },
    ...over
  }
  return { get chain() { return chain }, get reviewer() { return reviewer }, d }
}

describe('resolveAgentModel (C3.3)', () => {
  it('il bot con provider E modello propri usa quelli (nessuna migrazione)', () => {
    const r = resolveAgentModel({ providerId: 'p1', model: 'kimi', thinking: 'high' }, main)
    expect(r).toEqual({ providerId: 'p1', model: 'kimi', thinking: 'high', followsMain: false })
  })

  it('bot null/null e models.main impostato → il principale; thinking del bot se c\'è, altrimenti quello del principale', () => {
    expect(resolveAgentModel({ providerId: null, model: null, thinking: null }, main))
      .toEqual({ providerId: 'p_main', model: 'glm-5.1', thinking: 'medium', followsMain: true })
    // il thinking del bot vince («default» NON vince: vale quello del principale)
    expect(resolveAgentModel({ providerId: null, model: null, thinking: 'low' }, main)?.thinking).toBe('low')
    expect(resolveAgentModel({ providerId: null, model: null, thinking: 'default' }, main)?.thinking).toBe('medium')
    // principale senza thinking → null
    expect(resolveAgentModel({ providerId: null, model: null }, { providerId: 'p', model: 'm', thinking: null })?.thinking).toBeNull()
  })

  it('bot null/null senza models.main → null (l\'avviso configureProviderFirst)', () => {
    expect(resolveAgentModel({ providerId: null, model: null }, null)).toBeNull()
    expect(resolveAgentModel({ providerId: null, model: null }, undefined)).toBeNull()
  })

  it('mezze configurazioni non risolvono sul principale: o tutto suo o niente', () => {
    expect(resolveAgentModel({ providerId: 'p1', model: null }, main)).toBeNull()
    expect(resolveAgentModel({ providerId: null, model: 'kimi' }, main)).toBeNull()
  })
})

describe('newAgentModel (C3.3/C7): il bot nuovo nasce «Come gli altri»?', () => {
  it('con models.main segue il principale; senza, il turno di oggi (assignDefaultModel)', () => {
    expect(newAgentModel(main)).toBe('follows-main')
    expect(newAgentModel(null)).toBe('assign-default')
    expect(newAgentModel({ providerId: 'p', model: '', thinking: null })).toBe('assign-default')
  })
})

describe('assignFirstMainModel (C3.3): il primo provider diventa il principale', () => {
  // kind ollama: MODEL_DEFAULTS_BY_KIND ha default (kimi-k3:cloud), riserva
  // (glm-5.3:cloud) e revisore (glm-5.3-flash:cloud)
  const savedProvider = { id: 'p1', name: 'Ollama', kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabled: true }

  it('senza models.main, il default del provider salvato diventa il principale (tools verificati)', async () => {
    let set: MainModel | null | undefined
    const s = deps({
      setMain: (m) => { set = m },
      savedProvider: () => savedProvider
    })
    await assignFirstMainModel(s.d)
    expect(set).toEqual({ providerId: 'p1', model: 'kimi-k3:cloud', thinking: null })
  })

  it('I3.1: insieme al principale si scrive la RISERVA del tipo come prima voce della catena', async () => {
    const s = deps({ savedProvider: () => savedProvider })
    await assignFirstMainModel(s.d)
    expect(s.chain).toEqual([{ providerId: 'p1', model: 'glm-5.3:cloud' }])
  })

  it('I3.1: la riserva non si duplica se è già in catena (e la catena esistente resta)', async () => {
    const existing: FallbackRoute[] = [{ providerId: 'p2', model: 'm-b' }, { providerId: 'p1', model: 'glm-5.3:cloud' }]
    const s = deps({ savedProvider: () => savedProvider }, { chain: existing })
    await assignFirstMainModel(s.d)
    expect(s.chain).toEqual(existing)
    // catena con ALTRE voci: la riserva del tipo va in TESTA
    const s2 = deps({ savedProvider: () => savedProvider }, { chain: [{ providerId: 'p2', model: 'm-b' }] })
    await assignFirstMainModel(s2.d)
    expect(s2.chain).toEqual([{ providerId: 'p1', model: 'glm-5.3:cloud' }, { providerId: 'p2', model: 'm-b' }])
  })

  it('I3.2: il REVISORE del tipo si scrive in autoReview solo se l’utente non ne ha scelto uno', async () => {
    const s = deps({ savedProvider: () => savedProvider })
    await assignFirstMainModel(s.d)
    expect(s.reviewer).toEqual({ ...DEFAULT_AUTO_REVIEW, providerId: 'p1', model: 'glm-5.3-flash:cloud' })
    // già scelto: non si tocca
    const chosen: AutoReviewSettings = { ...DEFAULT_AUTO_REVIEW, providerId: 'p9', model: 'mio-revisore' }
    const s2 = deps({ savedProvider: () => savedProvider }, { reviewer: chosen })
    await assignFirstMainModel(s2.d)
    expect(s2.reviewer).toEqual(chosen)
  })

  it('senza default di kind (provider non-ollama) niente catena né revisore impliciti', async () => {
    let set: MainModel | null = null
    const s = deps({
      setMain: (m) => { set = m },
      savedProvider: () => ({ ...savedProvider, kind: 'openai' as const })
    })
    await assignFirstMainModel(s.d)
    expect(set).toBeNull()
    expect(s.chain).toEqual([])
    expect(s.reviewer).toEqual(DEFAULT_AUTO_REVIEW)
  })

  it('models.main GIÀ impostato: non si tocca (nemmeno si chiama supportsTools)', async () => {
    let called = false
    await assignFirstMainModel(deps({
      getMain: () => main,
      setMain: () => { throw new Error('non doveva') },
      savedProvider: () => savedProvider,
      supportsTools: async () => { called = true; return { ok: true, checked: false } }
    }).d)
    expect(called).toBe(false)
  })

  it('default che non supporta i tool o provider disattivato: models.main resta vuoto', async () => {
    let set: MainModel | null = null
    const s1 = deps({
      setMain: (m) => { set = m },
      savedProvider: () => ({ ...savedProvider, enabled: false })
    })
    await assignFirstMainModel(s1.d)
    expect(set).toBeNull()
    const s2 = deps({
      setMain: (m) => { set = m },
      savedProvider: () => savedProvider,
      supportsTools: async () => ({ ok: false, checked: true, error: 'no tools' })
    })
    await assignFirstMainModel(s2.d)
    expect(set).toBeNull()
  })
})
