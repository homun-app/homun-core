// Fase 16c correzioni (R4): il selettore resolvedModelOf dello store — Chat,
// RightPanel e Sidebar leggono tutti da qui, nessuna copia a mano della
// regola «null/null → models.main». I test shimmano window (lo store legge
// window.sandbot all'import; l'ambiente è node) e pilotano lo stato con
// useStore.setState, come farebbe il refresh iniziale.
import { describe, expect, it, beforeAll } from 'vitest'

beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = { sandbot: {} }
})

async function store() {
  const { useStore, resolvedModelOf } = await import('../../store')
  return { useStore, resolvedModelOf }
}

const AGENT = (over: Partial<import('../../../../shared/types').Agent>): import('../../../../shared/types').Agent => ({
  id: 'a1', name: 'Bea', description: '', providerId: null, model: null,
  status: 'idle', unread: 0, createdAt: 1, createdBy: null, section: null,
  parentId: null, avatar: null, thinking: 'default',
  ...over
})

describe('R4 — resolvedModelOf (il selettore unico del renderer)', () => {
  it('bot «Come gli altri» (null/null) → il modello principale', async () => {
    const { useStore, resolvedModelOf } = await store()
    useStore.setState({
      agents: [AGENT({ id: 'bea', providerId: null, model: null })],
      providers: [{ id: 'mainprov', name: 'Main', kind: 'openai', baseUrl: 'http://127.0.0.1:1', enabled: true, apiKey: '', hasKey: false }],
      mainModel: { providerId: 'mainprov', model: 'modello-a', thinking: null }
    })
    expect(resolvedModelOf('bea')).toMatchObject({ providerId: 'mainprov', model: 'modello-a', followsMain: true })
  })

  it('bot col SUO modello su provider attivo → il suo', async () => {
    const { useStore, resolvedModelOf } = await store()
    useStore.setState({
      agents: [AGENT({ id: 'carla', providerId: 'prov', model: 'm1' })],
      providers: [
        { id: 'mainprov', name: 'Main', kind: 'openai', baseUrl: 'http://127.0.0.1:1', enabled: true, apiKey: '', hasKey: false },
        { id: 'prov', name: 'P', kind: 'openai', baseUrl: 'http://127.0.0.1:2', enabled: true, apiKey: '', hasKey: false }
      ],
      mainModel: { providerId: 'mainprov', model: 'modello-a', thinking: null }
    })
    expect(resolvedModelOf('carla')).toMatchObject({ providerId: 'prov', model: 'm1', followsMain: false })
  })

  it('R3.6 dal renderer: provider proprio sparito → il principale (ownModelMissing)', async () => {
    const { useStore, resolvedModelOf } = await store()
    useStore.setState({
      agents: [AGENT({ id: 'orfano', providerId: 'andato', model: 'suo' })],
      providers: [{ id: 'mainprov', name: 'Main', kind: 'openai', baseUrl: 'http://127.0.0.1:1', enabled: true, apiKey: '', hasKey: false }],
      mainModel: { providerId: 'mainprov', model: 'modello-a', thinking: null }
    })
    expect(resolvedModelOf('orfano')).toMatchObject({ providerId: 'mainprov', model: 'modello-a', followsMain: true, ownModelMissing: true })
  })

  it('senza main e senza modello proprio → null; bot inesistente → null', async () => {
    const { useStore, resolvedModelOf } = await store()
    useStore.setState({
      agents: [AGENT({ id: 'solo', providerId: null, model: null })],
      providers: [],
      mainModel: null
    })
    expect(resolvedModelOf('solo')).toBeNull()
    expect(resolvedModelOf('fantasma')).toBeNull()
  })
})
