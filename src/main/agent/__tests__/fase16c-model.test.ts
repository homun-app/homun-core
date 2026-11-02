// Fase 16c (C3.3): resolveAgentModel, newAgentModel e assignFirstMainModel —
// «Come gli altri». Moduli PURI, nessuno store, nessuna rete.
import { describe, expect, it } from 'vitest'
import { resolveAgentModel, newAgentModel, assignFirstMainModel } from '../model-defaults'
import type { MainModel } from '../../../shared/types'

const main: MainModel = { providerId: 'p_main', model: 'glm-5.1', thinking: 'medium' }

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
  // kind ollama: MODEL_DEFAULTS_BY_KIND ha un default (kimi-k3:cloud)
  const savedProvider = { id: 'p1', name: 'Ollama', kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabled: true }

  it('senza models.main, il default del provider salvato diventa il principale (tools verificati)', async () => {
    let set: MainModel | null | undefined
    await assignFirstMainModel({
      getMain: () => null,
      setMain: (m) => { set = m },
      savedProvider: () => savedProvider,
      getOverrides: () => ({}),
      supportsTools: async () => ({ ok: true, checked: true })
    })
    expect(set).toEqual({ providerId: 'p1', model: 'kimi-k3:cloud', thinking: null })
  })

  it('models.main GIÀ impostato: non si tocca (nemmeno si chiama supportsTools)', async () => {
    let called = false
    await assignFirstMainModel({
      getMain: () => main,
      setMain: () => { throw new Error('non doveva') },
      savedProvider: () => savedProvider,
      getOverrides: () => ({}),
      supportsTools: async () => { called = true; return { ok: true, checked: false } }
    })
    expect(called).toBe(false)
  })

  it('default che non supporta i tool o provider disattivato: models.main resta vuoto', async () => {
    let set: MainModel | null = null
    await assignFirstMainModel({
      getMain: () => null,
      setMain: (m) => { set = m },
      savedProvider: () => ({ ...savedProvider, enabled: false }),
      getOverrides: () => ({}),
      supportsTools: async () => ({ ok: true, checked: true })
    })
    expect(set).toBeNull()
    await assignFirstMainModel({
      getMain: () => null,
      setMain: (m) => { set = m },
      savedProvider: () => savedProvider,
      getOverrides: () => ({}),
      supportsTools: async () => ({ ok: false, checked: true, error: 'no tools' })
    })
    expect(set).toBeNull()
  })
})
