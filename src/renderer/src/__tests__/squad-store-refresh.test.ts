// C3 (fase squadra-correzioni): il refresh della squadra è COALESCENTE —
// 50 eventi groups/agents in 100 ms producono UNA chiamata per tipo di RPC
// (niente RPC per ogni singolo evento che martella il daemon) e NESSUN set
// quando il dato tornato è identico (React non ri-renderizza la timeline a
// vuoto). L'evento che porta un dato NUOVO aggiorna lo store una volta sola.
import './render-helper-install'
import { describe, expect, it, beforeEach } from 'vitest'
import { callsOf, stubApiMethod } from './render-helper-install'
import type { Agent, GroupInfo, GroupMessageInfo, SandbotEvent } from '../../../shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const AGENTS: Agent[] = [
  { id: 'a1', name: 'Treni', createdAt: 1 } as unknown as Agent,
  { id: 'a2', name: 'Turismo', createdAt: 2 } as unknown as Agent
]
const GROUPS: GroupInfo[] = [
  { id: 7, name: 'Weekend Torino', description: '', createdAt: 3 } as unknown as GroupInfo
]
const MSGS: GroupMessageInfo[] = [
  { id: 1, groupId: 7, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'ciao', createdAt: 10 } as unknown as GroupMessageInfo
]
const CARDS = [
  { id: 1, agentId: 'a1', agentName: 'Treni', approvalId: 'ap1', tool: 'write-file', phrase: 'scrive', status: 'allowed', pending: false, fixed: false, when: 12 }
]
const OVERVIEW = {
  members: [{ agentId: 'a1', name: 'Treni', state: 'lavora' as const, role: '', coordinator: false, pagesRead: 1, filesWritten: 0, subagents: 0 }],
  produced: []
}
const PENDING = { pending: [], activity: [], reviewerPassed: [] }

describe('C3: il refresh della squadra coalesce gli eventi', () => {
  beforeEach(async () => {
    stubApiMethod('listAgents', () => AGENTS)
    stubApiMethod('listProviders', () => [])
    stubApiMethod('getPermissions', () => ({}))
    stubApiMethod('settingsGet', (...args: unknown[]) => args[1])
    stubApiMethod('getEntries', () => [])
    stubApiMethod('onboardingState', () => ({ needed: false, state: null, sequence: ['welcome', 'model', 'approvals', 'chat'], modelReady: true, guideOpen: false }))
    stubApiMethod('listGroups', () => GROUPS)
    stubApiMethod('groupMessages', () => MSGS)
    stubApiMethod('groupApprovalCards', () => CARDS)
    stubApiMethod('groupOverview', () => OVERVIEW)
    stubApiMethod('groupPendingApprovals', () => PENDING)
    const { useStore } = await import('../store')
    await useStore.getState().init()
  })

  it('50 eventi groups/agents in 100 ms → UNA chiamata per tipo di RPC e NESSUN set a dato identico', async () => {
    const { useStore } = await import('../store')
    // la squadra è aperta: openGroup carica subito e il suo refresh coalescente
    // (debounce) si esaurisce PRIMA della tempesta, così il conteggio è pulito
    useStore.getState().openGroup(7)
    await sleep(500)
    const onEvent = callsOf('onEvent')[0]!.args[0] as (e: SandbotEvent) => void
    const before = {
      groups: callsOf('listGroups').length,
      msgs: callsOf('groupMessages').length,
      cards: callsOf('groupApprovalCards').length,
      overview: callsOf('groupOverview').length,
      pending: callsOf('groupPendingApprovals').length,
      agents: callsOf('listAgents').length
    }
    let sets = 0
    const unsub = useStore.subscribe(() => { sets++ })
    try {
      // la tempesta: 25 + 25 eventi in ~100 ms (3–4 bot che lavorano)
      for (let i = 0; i < 25; i++) onEvent({ type: 'groups' })
      for (let i = 0; i < 25; i++) onEvent({ type: 'agents' })
      await sleep(100)
      // il debounce trailing scade ed è passata UNA passata sola
      await sleep(600)
      expect(callsOf('listGroups').length - before.groups).toBe(1)
      expect(callsOf('groupMessages').length - before.msgs).toBe(1)
      expect(callsOf('groupApprovalCards').length - before.cards).toBe(1)
      expect(callsOf('groupOverview').length - before.overview).toBe(1)
      expect(callsOf('groupPendingApprovals').length - before.pending).toBe(1)
      expect(callsOf('listAgents').length - before.agents).toBe(1)
      // il dato è IDENTICO: nessun set, la timeline non si ri-renderizza
      expect(sets).toBe(0)
      expect(useStore.getState().groupMessages).toEqual(MSGS)
    } finally {
      unsub()
    }
  })

  it('quando il dato CAMBIA, la passata aggiorna lo store UNA volta sola', async () => {
    const { useStore } = await import('../store')
    useStore.getState().openGroup(7)
    await sleep(500)
    const onEvent = callsOf('onEvent')[0]!.args[0] as (e: SandbotEvent) => void
    const before = callsOf('groupMessages').length
    const NEW_MSGS = [...MSGS, { id: 2, groupId: 7, authorKind: 'relay', authorId: 'a1', authorName: 'Treni', text: 'pronto', createdAt: 20 } as unknown as GroupMessageInfo]
    stubApiMethod('groupMessages', () => NEW_MSGS)
    let sets = 0
    const unsub = useStore.subscribe(() => { sets++ })
    try {
      onEvent({ type: 'groups' })
      onEvent({ type: 'agents' })
      onEvent({ type: 'groups' })
      await sleep(700)
      expect(callsOf('groupMessages').length - before).toBe(1)
      expect(useStore.getState().groupMessages).toEqual(NEW_MSGS)
      expect(sets).toBeGreaterThan(0)
    } finally {
      unsub()
    }
  })
})
