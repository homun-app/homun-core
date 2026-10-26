// Test della compaction della history (fase 4): soglia 70% del budget,
// summary che SOSTITUISCE i turni coperti in buildMessages (coppie tool
// intatte nel suffix), fallback quando la chiamata di riassunto fallisce.
// La decisione è pura; l'orchestrazione usa store reale su dir temporanea e
// LLM finto iniettato.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptEntry } from '../../../shared/types'

const { setDataDir, dataDir, appendEntry, getEntries } = await import('../../store/db')
const { estimateHistoryTokens, planCompaction, entriesToDigest, maybeCompactHistory, DEFAULT_CONTEXT_TOKENS, COMPACT_THRESHOLD } = await import('../compaction')
const { buildMessages } = await import('../history')

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-compact-test-'))
  setDataDir(root)
  dataDir()
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const AGENT = 'agent_c'

/** Entry minima con l'id esplicito (il mock/scenario costruisce transcript sintetici). */
function e(id: number, kind: TranscriptEntry['kind'], role: TranscriptEntry['role'], content: string, meta: Record<string, unknown> = {}): TranscriptEntry {
  return { id, agentId: AGENT, kind, role, content, meta, createdAt: id }
}

/** Due turni con tool call nel primo: user → tool-call → tool-result → … → user corrente. */
function twoTurns(firstLen: number, secondLen: number): TranscriptEntry[] {
  return [
    e(1, 'message', 'user', 'primo turno ' + 'x'.repeat(firstLen)),
    e(2, 'tool-call', 'assistant', 'run-command', { id: 'c1', name: 'run-command', arguments: '{}' }),
    e(3, 'tool-result', 'system', 'ok '.repeat(10)),
    e(4, 'thinking', 'assistant', 'fatto'),
    e(5, 'message', 'user', 'secondo turno ' + 'y'.repeat(secondLen))
  ]
}

describe('stima e soglia (pure)', () => {
  it('stima caratteri/4', () => {
    expect(estimateHistoryTokens([e(1, 'message', 'user', 'a'.repeat(400))])).toBe(100)
  })

  it('sotto il 70% del budget: nessun piano', () => {
    // 40 caratteri = 10 token, ben sotto 32k
    expect(planCompaction(twoTurns(0, 0), DEFAULT_CONTEXT_TOKENS)).toBeNull()
  })

  it('sopra soglia: riassume il primo turno, coversUpTo a confine di turno (prima dell\'ultimo user)', () => {
    const entries = [
      e(1, 'message', 'user', 'primo turno'),
      e(2, 'tool-call', 'assistant', 'run-command', { id: 'c1', name: 'run-command', arguments: '{}' }),
      e(3, 'tool-result', 'system', 'ok '.repeat(10)),
      e(4, 'thinking', 'assistant', 'p'.repeat(200)), // massa del primo turno
      e(5, 'message', 'user', 'secondo turno')
    ]
    // 265 caratteri ≈ 67 token: budget 50 → soglia 35. Dopo il confine 3 il
    // resto sarebbe ancora 54 token (>35), dopo il 4 sono 4 (≤35): serve tutto
    // il primo turno nel riepilogo
    const plan = planCompaction(entries, 50)!
    expect(plan).not.toBeNull()
    expect(plan.coversUpTo).toBe(4) // fine del primo turno (entry 1-4), l'user corrente (5) mai
    expect(plan.covered.map((x) => x.id)).toEqual([1, 2, 3, 4])
  })

  it('un solo turno: niente da riassumere (null), comunque grande', () => {
    const one = [e(1, 'message', 'user', 'x'.repeat(10_000))]
    expect(planCompaction(one, 30)).toBeNull()
  })
})

describe('buildMessages con summary: i turni coperti spariscono, il suffix resta intero', () => {
  it('il summary sostituisce le entry con id <= coversUpTo; coppie tool del suffix intatte', () => {
    const entries = [
      ...twoTurns(0, 0),
      e(6, 'summary', 'system', 'Riepilogo: l\'utente ha chiesto X, deciso Y.', { coversUpTo: 4 }),
      e(7, 'message', 'user', 'e adesso?')
    ]
    const msgs = buildMessages('SEI UN BOT', entries)
    expect(msgs[0]).toEqual({ role: 'system', content: 'SEI UN BOT' })
    const bodies = msgs.map((m) => m.content)
    // il summary c'è, i turni coperti no
    expect(bodies.some((c) => c.includes('Riepilogo: l\'utente ha chiesto X'))).toBe(true)
    expect(bodies.some((c) => c.includes('primo turno'))).toBe(false)
    // il turno corrente e il messaggio precedente (id 5 > 4) restano
    expect(bodies.some((c) => c.includes('secondo turno'))).toBe(true)
    expect(bodies.some((c) => c.includes('e adesso?'))).toBe(true)
    // niente result orfano nel suffix (repairToolPairs non deve aver tolto nulla)
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    for (const t of toolMsgs) {
      const hasCall = msgs.some((m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === t.toolCallId))
      expect(hasCall).toBe(true)
    }
  })
})

describe('orchestrazione maybeCompactHistory (store reale, LLM finto)', () => {
  it('history sotto soglia: nessuna chiamata LLM, nessuna entry', async () => {
    appendEntry({ agentId: AGENT, kind: 'message', role: 'user', content: 'ciao' })
    let calls = 0
    const done = await maybeCompactHistory(AGENT, 'prov', 'm1', async () => { calls++; return 'riepilogo' }, () => undefined)
    expect(done).toBe(false)
    expect(calls).toBe(0)
    expect(getEntries(AGENT).some((x) => x.kind === 'summary')).toBe(false)
  })

  it('history sopra soglia: chiama il riassunto e appende l\'entry summary con coversUpTo', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m1': 1000 }) // soglia 700 token
    const agent = 'agent_big'
    // primo turno enorme (messaggio da 4000 caratteri = 1000 token), poi il messaggio corrente
    appendEntry({ agentId: agent, kind: 'message', role: 'user', content: 'x'.repeat(4000) })
    appendEntry({ agentId: agent, kind: 'tool-call', role: 'assistant', content: 'run-command', meta: { id: 'k1', name: 'run-command', arguments: '{}' } })
    appendEntry({ agentId: agent, kind: 'tool-result', role: 'system', content: 'output'.repeat(50) })
    const lastUser = appendEntry({ agentId: agent, kind: 'message', role: 'user', content: 'e ora?' })
    const digests: string[] = []
    const done = await maybeCompactHistory(agent, 'prov', 'm1', async (d) => {
      digests.push(d)
      return 'FATTI: … DECISIONI: …'
    }, () => undefined)
    expect(done).toBe(true)
    // il digest contiene il primo turno, non il messaggio corrente
    expect(digests[0]).toContain('x'.repeat(100))
    expect(digests[0]).not.toContain('e ora?')
    const summary = getEntries(agent).find((x) => x.kind === 'summary')!
    expect(summary.content).toBe('FATTI: … DECISIONI: …')
    expect(summary.meta?.coversUpTo).toBeLessThan(lastUser.id)
    // buildMessages ora usa il summary: il testo enorme non c'è più
    const msgs = buildMessages('S', getEntries(agent))
    expect(msgs.some((m) => m.content.includes('FATTI: … DECISIONI: …'))).toBe(true)
    expect(msgs.some((m) => m.content.includes('x'.repeat(50)))).toBe(false)
  })

  it('budget configurabile per provider/modello (contextBudgetTokens)', async () => {
    const { setSetting } = await import('../../store/db')
    const agent = 'agent_cfg'
    setSetting('contextBudgetTokens', { 'prov/m1': 1_000_000 }) // budget enorme: mai sopra soglia
    appendEntry({ agentId: agent, kind: 'message', role: 'user', content: 'x'.repeat(4000) })
    appendEntry({ agentId: agent, kind: 'message', role: 'user', content: 'secondo' })
    const done = await maybeCompactHistory(agent, 'prov', 'm1', async () => 'riepilogo', () => undefined)
    expect(done).toBe(false)
    setSetting('contextBudgetTokens', {})
  })

  it('LLM del riassunto che fallisce: NESSUNA entry summary, il turno può proseguire (fallback)', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m1': 1000 })
    const agent = 'agent_fail'
    appendEntry({ agentId: agent, kind: 'message', role: 'user', content: 'x'.repeat(4000) })
    appendEntry({ agentId: agent, kind: 'message', role: 'user', content: 'vai' })
    const done = await maybeCompactHistory(agent, 'prov', 'm1', async () => { throw new Error('boom') }, () => undefined)
    expect(done).toBe(false)
    expect(getEntries(agent).some((x) => x.kind === 'summary')).toBe(false)
    // buildMessages funziona lo stesso (taglio a confine di turno per numero)
    const msgs = buildMessages('S', getEntries(agent))
    expect(msgs.length).toBeGreaterThan(1)
    setSetting('contextBudgetTokens', {})
  })
})

describe('entriesToDigest (pure)', () => {
  it('turni in forma leggibile, notice/event esclusi, contenuti lunghi troncati', () => {
    const digest = entriesToDigest([
      e(1, 'message', 'user', 'domanda'),
      e(2, 'tool-call', 'assistant', 'run-command', { id: 'c', name: 'run-command', arguments: '{"command":"ls"}' }),
      e(3, 'tool-result', 'system', 'risultato'),
      e(4, 'send-message', 'assistant', 'BOT disse questo', { message: { type: 'text', text: 'BOT disse questo' } }),
      e(5, 'notice', 'system', 'nota interna'),
      e(6, 'event', 'system', 'Turno completato', { turnEnd: 'FINISHED' }),
      e(7, 'message', 'user', 'z'.repeat(5000))
    ])
    expect(digest).toContain('UTENTE: domanda')
    expect(digest).toContain('TOOL run-command')
    expect(digest).toContain('RISULTATO: risultato')
    expect(digest).toContain('BOT→UTENTE: BOT disse questo')
    expect(digest).not.toContain('nota interna')
    expect(digest).not.toContain('Turno completato')
    expect(digest.includes('…')).toBe(true) // troncato
  })
})
