// K2 (fase team-bot): le azioni dello store dietro il menu della barra —
// archivia/elimina/ripristina chiamano le RPC giuste, l'eliminazione accende
// l'avviso «Eliminato · Annulla» per 10 secondi (poi si spegne da sé) e
// l'Annulla RIPRISTINA; archiviare il bot attivo (o il team aperto) sposta
// la selezione. Store vero, api finta del render-helper.
import './render-helper-install'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { fakeApiCalls, callsOf, stubApiMethod } from './render-helper-install'
import type { Agent, GroupInfo } from '../../../shared/types'

const { useStore } = await import('../store')

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent => ({
  id, name, description: '', providerId: null, model: null, status: 'idle', unread: 0,
  createdAt: 1, createdBy: null, section: null, parentId: null, avatar: null, ...over
})
const group = (id: number, name: string, members: GroupInfo['members'], coordinatorId: string): GroupInfo => ({
  id, name, description: '', createdBy: 'u', coordinatorId, members, createdAt: 1, lastMessageAt: null, autonomy: 'box'
})

const seed = (): void => {
  useStore.setState({
    agents: [agent('main', 'Bot'), agent('b1', 'Ricerche'), agent('b2', 'Competitoor')],
    groups: [group(1, 'Fatture marzo', [{ agentId: 'b2', name: 'Competitoor', coordinator: true }], 'b2')],
    mainAgentId: 'main', activeId: 'b1', openGroupId: null
  })
}

describe('K2 store: archivia/elimina bot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seed()
  })
  afterEach(() => vi.useRealTimers())

  it('archiveAgent chiama la RPC e il bot attivo archiviato lascia il posto al primo bot vivo', async () => {
    stubApiMethod('listAgents', () => [agent('main', 'Bot', { name: 'Bot' })])
    await useStore.getState().archiveAgent('b1')
    expect(callsOf('archiveAgent').map((c) => c.args[0])).toEqual(['b1'])
    expect(useStore.getState().activeId).toBe('main')
  })

  it('deleteAgentWithUndo: RPC, avviso con nome per 10 s, poi via da sé', async () => {
    stubApiMethod('listAgents', () => [agent('main', 'Bot'), agent('b2', 'Competitoor', { deletedAt: 5 })])
    await useStore.getState().deleteAgentWithUndo('b1')
    expect(callsOf('deleteAgent').map((c) => c.args[0])).toEqual(['b1'])
    const undo = useStore.getState().removedUndo
    expect(undo?.kind).toBe('bot')
    expect(undo?.id).toBe('b1')
    expect(undo?.name).toBe('Ricerche')
    // a 10 secondi l'avviso non c'è più
    vi.advanceTimersByTime(10_000)
    expect(useStore.getState().removedUndo).toBeNull()
  })

  it('undoRemoved ripristina (restoreAgent) e spegne l\'avviso', async () => {
    await useStore.getState().deleteAgentWithUndo('b1')
    expect(useStore.getState().removedUndo).not.toBeNull()
    await useStore.getState().undoRemoved()
    expect(callsOf('restoreAgent').map((c) => c.args[0])).toEqual(['b1'])
    expect(useStore.getState().removedUndo).toBeNull()
  })
})

describe('K2 store: team', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    seed()
  })
  afterEach(() => vi.useRealTimers())

  it('groupArchive chiude la vista del team aperto; groupDeleteWithUndo senza casella tiene i bot', async () => {
    useStore.setState({ openGroupId: 1 })
    await useStore.getState().groupArchive(1)
    expect(callsOf('groupArchive').map((c) => c.args[0])).toEqual([1])
    expect(useStore.getState().openGroupId).toBeNull()
    await useStore.getState().groupDeleteWithUndo(1)
    const calls = callsOf('groupDelete')
    expect(calls[calls.length - 1]!.args.map(String).join(',')).toBe('1,false')
    expect(useStore.getState().removedUndo?.kind).toBe('team')
  })

  it('groupDeleteWithUndo con la casella passa alsoDeleteMembers', async () => {
    await useStore.getState().groupDeleteWithUndo(1, true)
    const calls = callsOf('groupDelete')
    expect(calls[calls.length - 1]!.args.map(String).join(',')).toBe('1,true')
  })

  it('unarchived/restore: groupUnarchive e groupRestore chiamano le RPC', async () => {
    await useStore.getState().groupUnarchive(1)
    await useStore.getState().groupRestore(1)
    expect(callsOf('groupUnarchive').length).toBe(1)
    expect(callsOf('groupRestore').length).toBe(1)
  })
})
