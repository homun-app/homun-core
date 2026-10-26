// Test del piano di ripresa (puro): dato il transcript e l'id dell'entry che
// apre il turno, decide se il turno era già concluso, quali tool-call sono
// rimaste senza esito e quali approval vanno fatte scadere. Nessun effetto:
// chi applica il piano è runTurn.
import { describe, expect, it } from 'vitest'
import { planResume } from '../resume'
import type { TranscriptEntry } from '../../../shared/types'

const mk = (
  id: number, kind: TranscriptEntry['kind'], role: TranscriptEntry['role'],
  content: string, meta: Record<string, unknown> | null = null
): TranscriptEntry => ({ id, agentId: 'a', kind, role, content, meta, createdAt: 0 })

describe('planResume (puro)', () => {
  const user = mk(1, 'message', 'user', 'deploy')

  it('ultimo entry dopo entryId = messaggio assistant con testo → turno già concluso', () => {
    const entries = [user, mk(2, 'message', 'assistant', 'fatto')]
    const plan = planResume(entries, 1)
    expect(plan.alreadyComplete).toBe(true)
    expect(plan.interruptedToolCalls).toEqual([])
    expect(plan.pendingApprovals).toEqual([])
  })

  it('assistant vuoto (crash durante lo streaming) → NON concluso', () => {
    expect(planResume([user, mk(2, 'message', 'assistant', '')], 1).alreadyComplete).toBe(false)
  })

  it('tool-call senza tool-result → interrotta (l\'esito è andato perso col crash)', () => {
    const entries = [
      user,
      mk(2, 'message', 'assistant', ''),
      mk(3, 'tool-call', 'assistant', 'run-command', { id: 'c1', name: 'run-command', arguments: '{}' }),
      mk(4, 'tool-call', 'assistant', 'run-command', { id: 'c2', name: 'run-command', arguments: '{}' }),
      mk(5, 'tool-result', 'system', 'ok', { callId: 'c2' })
    ]
    const plan = planResume(entries, 1)
    expect(plan.alreadyComplete).toBe(false)
    expect(plan.interruptedToolCalls.map((e) => e.meta?.id)).toEqual(['c1'])
  })

  it('approval ancora pending dell\'agente → da marcare expired (anche prima di entryId)', () => {
    const stale = mk(0, 'approval', 'system', 'x', { approvalId: 'ap0', status: 'pending' })
    const entries = [
      stale, user,
      mk(2, 'message', 'assistant', ''),
      mk(3, 'approval', 'system', 'y', { approvalId: 'ap1', status: 'pending' }),
      mk(4, 'approval', 'system', 'z', { approvalId: 'ap2', status: 'allowed' })
    ]
    const plan = planResume(entries, 1)
    expect(plan.pendingApprovals.map((e) => e.meta?.approvalId)).toEqual(['ap0', 'ap1'])
  })

  it('crash prima del modello: niente dopo entryId → ripresa senza riparazioni', () => {
    const plan = planResume([user], 1)
    expect(plan.alreadyComplete).toBe(false)
    expect(plan.interruptedToolCalls).toEqual([])
    expect(plan.pendingApprovals).toEqual([])
  })

  it('le tool-call di turni precedenti (prima di entryId) non vengono riparate', () => {
    const entries = [
      mk(0, 'tool-call', 'assistant', 'run-command', { id: 'c0', name: 'run-command', arguments: '{}' }),
      user,
      mk(2, 'message', 'assistant', 'fatto')
    ]
    const plan = planResume(entries, 1)
    expect(plan.interruptedToolCalls).toEqual([])
    expect(plan.alreadyComplete).toBe(true)
  })
})
