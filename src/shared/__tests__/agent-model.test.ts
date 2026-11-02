// Fase 16c correzioni (R3/R4): i test di resolveAgentModel, il punto UNICO
// che decide quale modello esegue un bot (chat, squadre, routine, renderer).
// La regola «provider, modello e credenziale vincono insieme» è quella di
// Rakazo selectConfiguredModel: il modello proprio vale solo se il suo
// provider è ancora collegato e attivo.
import { describe, expect, it } from 'vitest'
import { resolveAgentModel } from '../agent-model'

const MAIN = { providerId: 'mainprov', model: 'modello-a', thinking: null }
const ACTIVE = [{ id: 'mainprov', enabled: true }, { id: 'prov', enabled: true }]

describe('R3 — resolveAgentModel (puro, un solo punto)', () => {
  it('modello proprio su provider attivo → il suo (followsMain false)', () => {
    const r = resolveAgentModel({ providerId: 'prov', model: 'm1', thinking: 'high' }, MAIN, ACTIVE)
    expect(r).toEqual({ providerId: 'prov', model: 'm1', thinking: 'high', followsMain: false })
  })

  it('null/null con models.main → il principale («Come gli altri»)', () => {
    const r = resolveAgentModel({ providerId: null, model: null, thinking: null }, MAIN, ACTIVE)
    expect(r).toEqual({ providerId: 'mainprov', model: 'modello-a', thinking: null, followsMain: true })
  })

  it('null/null senza elenco provider (chiamante che non lo sa): come prima', () => {
    const r = resolveAgentModel({ providerId: null, model: null }, MAIN)
    expect(r).toMatchObject({ providerId: 'mainprov', model: 'modello-a', followsMain: true })
    // e un modello proprio resta il suo anche senza elenco
    expect(resolveAgentModel({ providerId: 'prov', model: 'm1' }, MAIN)).toMatchObject({ providerId: 'prov', followsMain: false })
  })

  it('thinking: il bot che segue il principale usa il SUO se esplicito, altrimenti quello del principale', () => {
    expect(resolveAgentModel({ providerId: null, model: null, thinking: 'high' },
      { providerId: 'mainprov', model: 'modello-a', thinking: 'low' }, ACTIVE)?.thinking).toBe('high')
    expect(resolveAgentModel({ providerId: null, model: null, thinking: 'default' },
      { providerId: 'mainprov', model: 'modello-a', thinking: 'low' }, ACTIVE)?.thinking).toBe('low')
    expect(resolveAgentModel({ providerId: null, model: null, thinking: null },
      { providerId: 'mainprov', model: 'modello-a', thinking: null }, ACTIVE)?.thinking).toBeNull()
  })

  it('R3.6 — provider del bot RIMOSSO o DISATTIVATO + main → il principale con ownModelMissing', () => {
    const r = resolveAgentModel({ providerId: 'andato', model: 'suo' }, MAIN, ACTIVE)
    expect(r).toMatchObject({ providerId: 'mainprov', model: 'modello-a', followsMain: true, ownModelMissing: true })
    // disattivato: stessa regola
    const disabled = resolveAgentModel({ providerId: 'spento', model: 'suo' }, MAIN,
      [{ id: 'mainprov', enabled: true }, { id: 'spento', enabled: false }])
    expect(disabled).toMatchObject({ followsMain: true, ownModelMissing: true })
    // il provider torna → il modello proprio RIAPARE (nessuna migrazione)
    const back = resolveAgentModel({ providerId: 'andato', model: 'suo' }, MAIN,
      [{ id: 'mainprov', enabled: true }, { id: 'andato', enabled: true }])
    expect(back).toEqual({ providerId: 'andato', model: 'suo', thinking: null, followsMain: false })
  })

  it('R3.6 — provider del bot sparito SENZA main → null (notice di configurazione)', () => {
    expect(resolveAgentModel({ providerId: 'andato', model: 'suo' }, null, ACTIVE)).toBeNull()
  })

  it('bot mezza configurazione (provider senza modello) e nessun main → null', () => {
    expect(resolveAgentModel({ providerId: 'prov', model: null }, null, ACTIVE)).toBeNull()
    expect(resolveAgentModel({ providerId: null, model: 'x' }, null, ACTIVE)).toBeNull()
  })

  it('null/null senza models.main → null («Configura prima un provider…»)', () => {
    expect(resolveAgentModel({ providerId: null, model: null }, null, ACTIVE)).toBeNull()
    expect(resolveAgentModel({ providerId: null, model: null }, { providerId: 'x', model: '', thinking: null }, ACTIVE)).toBeNull()
  })
})
