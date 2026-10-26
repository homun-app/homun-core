// Test della pulizia alla cancellazione di un agente (fase 7, residuo 0c):
// oltre a righe agents/entries e directory su disco (fase 5), vanno via anche
// le righe outbox trattenute e i setting trigger.seen.<id> delle sue routine
// (con le routine stesse: un poll di un agente morto continuerebbe a girare).
// Store reale su directory temporanea.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setDataDir, db, createAgent, deleteAgent, listAgents, listRoutines,
  createRoutine, getSetting, setSetting, holdOutboxEntry, heldOutboxForAgent,
  appendEntry
} from '../db'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-delagent-'))
  setDataDir(dir)
  db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('deleteAgent: pulizia outbox e trigger.seen (residuo 0c)', () => {
  it('rimuove righe outbox, setting trigger.seen e routine dell\'agente', () => {
    const a = createAgent('Pulito', '')
    const other = createAgent('Altro', '')
    // routine con set dei visti (trigger connector_poll) per entrambi
    const r1 = createRoutine(a.id, 'Poll', 'p', '', { trigger: { type: 'connector_poll', connectorId: 'x', tool: 't', intervalMin: 5, idField: 'items[].id' } })
    const r2 = createRoutine(other.id, 'Poll altro', 'p', '', { trigger: { type: 'connector_poll', connectorId: 'x', tool: 't', intervalMin: 5, idField: 'items[].id' } })
    setSetting(`trigger.seen.${r1.id}`, { ids: ['a'], primed: true })
    setSetting(`trigger.seen.${r2.id}`, { ids: ['b'], primed: true })
    // un messaggio trattenuto in outbox per ciascuno
    const e1 = appendEntry({ agentId: a.id, kind: 'send-message', role: 'assistant', content: 'x' })
    const e2 = appendEntry({ agentId: other.id, kind: 'send-message', role: 'assistant', content: 'y' })
    holdOutboxEntry(e1.id, a.id, e1.createdAt)
    holdOutboxEntry(e2.id, other.id, e2.createdAt)

    deleteAgent(a.id)

    expect(listAgents().map((x) => x.id)).toEqual([other.id])
    // le routine dell'agente muoiono con lui, quelle dell'altro restano
    expect(listRoutines().map((r) => r.id)).toEqual([r2.id])
    // setting trigger.seen: via quello della routine cancellata, resta l'altro
    expect(getSetting(`trigger.seen.${r1.id}`, null)).toBeNull()
    expect(getSetting(`trigger.seen.${r2.id}`, null)).toEqual({ ids: ['b'], primed: true })
    // righe outbox dell'agente rimosse, l'altra resta
    expect(heldOutboxForAgent(a.id)).toEqual([])
    expect(heldOutboxForAgent(other.id).map((o) => o.entry_id)).toEqual([e2.id])
    // directory dati dell'agente rimossa
    expect(existsSync(join(dir, 'agents', a.id))).toBe(false)
  })

  it('cancellare un agente inesistente non tocca nulla', () => {
    expect(() => deleteAgent('agent_manca')).not.toThrow()
    expect(listAgents()).toHaveLength(1)
  })
})
