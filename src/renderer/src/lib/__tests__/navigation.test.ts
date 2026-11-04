// Verifica impostazioni (navigazione): da Attività o Libreria il clic su un bot
// (o su una squadra) nella barra deve riportare alla chat — prima select()
// cambiava bot ma lasciava la vista sopra, e sembrava che non succedesse nulla.
// Lo store legge window.sandbot all'import: shim minimo con le chiamate che
// select() e openGroup() fanno.
import { describe, expect, it, beforeAll } from 'vitest'

beforeAll(async () => {
  const ok = async (): Promise<unknown> => []
  ;(globalThis as { window?: unknown }).window = {
    sandbot: {
      getEntries: ok, listSubagents: ok, updateAgent: ok, presenceViewing: ok,
      outboxOpened: ok, groupMessages: ok
    }
  }
})

async function store() {
  return (await import('../../store')).useStore
}

describe('navigazione: la barra riporta alla chat', () => {
  it('Attività aperta → clic su un bot chiude Attività', async () => {
    const useStore = await store()
    useStore.setState({ activityOpen: true, openLibraryId: null })
    await useStore.getState().select('a1')
    expect(useStore.getState().activityOpen).toBe(false)
    expect(useStore.getState().activeId).toBe('a1')
  })

  it('Libreria aperta (lista o voce) → clic su un bot chiude la Libreria', async () => {
    const useStore = await store()
    for (const open of ['', 'item-1']) {
      useStore.setState({ activityOpen: false, openLibraryId: open })
      await useStore.getState().select('a2')
      expect(useStore.getState().openLibraryId).toBeNull()
    }
  })

  it('Attività o Libreria aperta → aprire una squadra le chiude; chiuderla (null) no', async () => {
    const useStore = await store()
    useStore.setState({ activityOpen: true, openLibraryId: '' })
    useStore.getState().openGroup(7)
    expect(useStore.getState()).toMatchObject({ activityOpen: false, openLibraryId: null, openGroupId: 7 })
    useStore.setState({ activityOpen: true })
    useStore.getState().openGroup(null)
    expect(useStore.getState().activityOpen).toBe(true)
  })
})
