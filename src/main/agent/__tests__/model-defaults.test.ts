// Fase 9 (punto 1) — test puri: default dei modelli per provider (predefinito,
// riserva, revisore) e la scelta provider+defaultModel per i bot nuovi.
import { describe, expect, it } from 'vitest'
import {
  modelDefaultsFor, defaultModelFor, fallbackModelFor, autoReviewModelFor, assignDefaultModel,
  MODEL_DEFAULTS_BY_KIND, type AssignmentDeps, type ModelDefaultsMap
} from '../model-defaults'

const ollama = { id: 'ollama', kind: 'ollama' }

describe('default per kind (la scelta del revisore, non in discussione)', () => {
  it('Ollama: kimi-k3 predefinito, glm-5.3 riserva, glm-5.3-flash revisore', () => {
    expect(MODEL_DEFAULTS_BY_KIND.ollama).toEqual({
      defaultModel: 'kimi-k3:cloud',
      fallbackModel: 'glm-5.3:cloud',
      autoReviewModel: 'glm-5.3-flash:cloud'
    })
    expect(defaultModelFor(ollama)).toBe('kimi-k3:cloud')
    expect(fallbackModelFor(ollama)).toBe('glm-5.3:cloud')
    expect(autoReviewModelFor(ollama)).toBe('glm-5.3-flash:cloud')
  })

  it('provider senza default per kind → null (l\'utente configura)', () => {
    const p = { id: 'zai_x', kind: 'zai' }
    expect(defaultModelFor(p)).toBeNull()
    expect(fallbackModelFor(p)).toBeNull()
    expect(autoReviewModelFor(p)).toBeNull()
  })

  it('gli override dell\'utente vincono campo per campo, per id di provider', () => {
    const overrides: ModelDefaultsMap = { ollama: { defaultModel: 'mio-modello' } }
    expect(defaultModelFor(ollama, overrides)).toBe('mio-modello')
    // i campi non sovrascritti restano quelli del kind
    expect(fallbackModelFor(ollama, overrides)).toBe('glm-5.3:cloud')
    expect(autoReviewModelFor(ollama, overrides)).toBe('glm-5.3-flash:cloud')
    // un altro provider non è toccato
    expect(modelDefaultsFor({ id: 'altro', kind: 'ollama' }, overrides).defaultModel).toBe('kimi-k3:cloud')
  })
})

describe('assignDefaultModel: provider attivo + defaultModel per i bot nuovi', () => {
  const mk = (
    providers: Array<{ id: string; kind: string; enabled: boolean }>,
    supports: (p: { id: string }, model: string) => Promise<{ ok: boolean; checked: boolean; error?: string }>,
    overrides: ModelDefaultsMap = {}
  ): AssignmentDeps => ({
    listProviders: () => providers,
    getOverrides: () => overrides,
    supportsTools: supports
  })

  it('default con capability "tools" → assegnato', async () => {
    const a = await assignDefaultModel(mk([{ id: 'ollama', kind: 'ollama', enabled: true }], async () => ({ ok: true, checked: true })))
    expect(a).toEqual({ providerId: 'ollama', model: 'kimi-k3:cloud' })
  })

  it('senza capability "tools" → modello NON assegnato, con l\'errore leggibile', async () => {
    const a = await assignDefaultModel(mk(
      [{ id: 'ollama', kind: 'ollama', enabled: true }],
      async () => ({ ok: false, checked: true, error: 'il modello "x" non supporta i tool' })
    ))
    expect(a).toEqual({ providerId: 'ollama', model: null, warning: 'il modello "x" non supporta i tool' })
  })

  it('provider attivo senza defaultModel → modello null (mai il primo dell\'elenco)', async () => {
    const a = await assignDefaultModel(mk([{ id: 'p1', kind: 'openai', enabled: true }], async () => ({ ok: true, checked: true })))
    expect(a).toEqual({ providerId: 'p1', model: null })
  })

  it('nessun provider attivo → null; i provider disabilitati non contano', async () => {
    expect(await assignDefaultModel(mk([], async () => ({ ok: true, checked: true })))).toBeNull()
    const a = await assignDefaultModel(mk(
      [{ id: 'off', kind: 'ollama', enabled: false }, { id: 'on', kind: 'ollama', enabled: true }],
      async () => ({ ok: true, checked: true })
    ))
    expect(a?.providerId).toBe('on')
  })
})
