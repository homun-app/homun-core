// D2 (fase deleghe): la riga di stato della delega in chat — «In coda per
// Novità AI · parte alle 09:41» con Annulla, che diventa «Consegnato» quando
// il messaggio parte e SPARISCE quando il risultato arriva. Il modello è
// PURO: legge le entry del transcript (meta.delegationQueued) e lo stato dei
// job della coda.
import { describe, expect, it } from 'vitest'
import {
  collectDelegationJobs, delegationRowState, formatDelegationClock
} from '../lib/delegation-status'
import type { TranscriptEntry } from '../../../shared/types'

const send = (id: number, toAgentId: string, toAgentName: string, queued: { jobId: number; runAt: number } | null): TranscriptEntry =>
  ({
    id, agentId: 'capo', kind: 'send-message', role: 'assistant', content: 'chiedi a Novità',
    meta: { agentSend: true, toAgentId, toAgentName, ...(queued ? { delegationQueued: queued } : {}) },
    createdAt: id * 1000
  }) as never as TranscriptEntry

const agentMsg = (id: number, fromAgentId: string): TranscriptEntry =>
  ({ id, agentId: 'capo', kind: 'message', role: 'user', content: 'risposta', meta: { initiator: 'AGENT', fromAgentId }, createdAt: id * 1000 }) as never as TranscriptEntry

describe('D2: collectDelegationJobs — le deleghe in attesa dalle entry', () => {
  it('raccoglie jobId, runAt e nome dalle entry con meta.delegationQueued', () => {
    const jobs = collectDelegationJobs([
      send(1, 'agent_novita', 'Novità AI', { jobId: 42, runAt: 1_730_000_000_000 }),
      send(2, 'agent_chef', 'Chef Ricette', null) // delega normale: non conta
    ])
    expect(jobs).toEqual([{ entryId: 1, jobId: 42, runAt: 1_730_000_000_000, toAgentName: 'Novità AI' }])
  })
})

describe('D2: delegationRowState — in coda → consegnato → via col risultato', () => {
  const entry = send(1, 'agent_novita', 'Novità AI', { jobId: 42, runAt: 1_730_000_000_000 })

  it('job in coda → «in coda»', () => {
    expect(delegationRowState(entry, 'queued', [])).toBe('queued')
  })

  it('job partito (leased/done) → «consegnato»', () => {
    expect(delegationRowState(entry, 'delivered', [])).toBe('delivered')
  })

  it('il risultato arrivato (messaggio del destinatario DOPO la delega) → riga SPARITA', () => {
    expect(delegationRowState(entry, 'delivered', [agentMsg(2, 'agent_novita')])).toBeNull()
    // un messaggio di un ALTRO bot non la fa sparire
    expect(delegationRowState(entry, 'delivered', [agentMsg(2, 'agent_altro')])).toBe('delivered')
  })

  it('job annullato o mai esistito → riga via', () => {
    expect(delegationRowState(entry, 'gone', [])).toBeNull()
  })
})

describe('D2: formatDelegationClock — l\'ora breve HH:MM', () => {
  it('ore e minuti nel fuso dato (locale it: 09:41)', () => {
    // 2026-11-22 09:41 locali (Europe/Rome) — la data è scelta col fuso Rome
    const ms = Date.parse('2026-11-22T09:41:00+01:00')
    expect(formatDelegationClock(ms, 'it-IT', 'Europe/Rome')).toBe('09:41')
    expect(formatDelegationClock(ms, 'en-US', 'Europe/Rome')).toMatch(/^0?9:41/)
  })
})
