// GC6.1 (fase guida-correzioni): lo store del renderer REAGISCE all'evento
// 'models' del daemon ricaricando provider e modello principale — prima li
// leggeva solo in init(): la guida scriveva models.main e il pannello del bot
// restava su «Modello: Nessun modello ›» finché non ricaricavi la finestra.
import './render-helper-install'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { callsOf, stubApiMethod } from './render-helper-install'
import type { ProviderPublic, MainModel, SandbotEvent } from '../../../shared/types'

const PROVIDERS: ProviderPublic[] = [
  { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', enabled: true, apiKey: '', hasKey: false }
]
const MAIN: MainModel = { providerId: 'ollama', model: 'glm-5.3-flash:cloud', thinking: null }

describe('GC6.1: lo store si aggiorna quando models.main o i provider cambiano', () => {
  beforeEach(async () => {
    // l'avvio su una finestra VECCHIA: nessun provider, nessun modello
    stubApiMethod('listAgents', () => [])
    stubApiMethod('listProviders', () => [])
    stubApiMethod('getPermissions', () => ({}))
    stubApiMethod('settingsGet', (...args: unknown[]) => args[1])
    const { useStore } = await import('../store')
    await useStore.getState().init()
  })

  it("l'evento models ricarica provider e modello principale SENZA ricaricare la finestra", async () => {
    const { useStore } = await import('../store')
    expect(useStore.getState().providers).toEqual([])
    expect(useStore.getState().mainModel).toBeNull()
    // il daemon ora li ha (la guida ha scritto models.main): emette 'models'
    stubApiMethod('listProviders', () => PROVIDERS)
    stubApiMethod('settingsGet', (key: unknown, fallback: unknown) => (key === 'models.main' ? MAIN : fallback))
    const onEvent = callsOf('onEvent')[0]!.args[0] as (e: SandbotEvent) => void
    onEvent({ type: 'models' })
    // gli aggiornamenti partono SUBITO (promise microtask): si aspettano con
    // waitFor, non con un tempo fisso
    await vi.waitFor(() => {
      expect(useStore.getState().providers).toEqual(PROVIDERS)
      expect(useStore.getState().mainModel).toEqual(MAIN)
    }, { timeout: 2000, interval: 5 })
  })
})
