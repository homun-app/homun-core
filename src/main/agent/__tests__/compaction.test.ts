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

// ---- D5 (fase deleghe): compattazione INCREMENTALE con isteresi ----
// Il difetto del 22/11: 36 compattazioni, ~895k token in input (il 20% del
// giorno), 4–6 s prima di ogni risposta — getEntries passava a
// planCompaction TUTTA la storia (le entry già coperte dall'ultimo summary
// comprese), superata la soglia si restava sopra per sempre e il digest
// riassumeva da capo tutto il prefisso, riassunti vecchi inclusi.

describe('D5: sopra soglia una volta, sotto per un pezzo (isteresi 70% → 45%)', () => {
  it('una storia di 600 entry con un summary che copre le prime 550 e il resto SOTTO soglia → NESSUNA compattazione (oggi ne parte una)', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m5': 32_000 })
    const agent = 'agent_d5_stabile'
    // 550 entry coperte dal summary (testi LUNGHI: senza il summary la storia
    // sarebbe ben oltre il 70% del budget)…
    for (let i = 0; i < 550; i++) {
      appendEntry({ agentId: agent, kind: i % 2 ? 'message' : 'tool-result', role: i % 2 ? 'user' : 'system', content: 'vecchia entry '.padEnd(400, 'x') })
    }
    const all = getEntries(agent)
    const { appendEntry: _a } = await import('../../store/db')
    _a({ agentId: agent, kind: 'summary', role: 'system', content: 'Riepilogo: fatto tutto fino a qui.', meta: { coversUpTo: all[all.length - 1]!.id } })
    // …e 50 entry nuove PICCOLE: quello che il modello vede è sotto soglia
    for (let i = 0; i < 50; i++) {
      appendEntry({ agentId: agent, kind: 'message', role: i % 2 ? 'user' : 'assistant', content: 'nuova breve' })
    }
    let calls = 0
    const done = await maybeCompactHistory(agent, 'prov', 'm5', async () => { calls++; return 'nuovo riepilogo' }, () => undefined)
    expect(done).toBe(false)
    expect(calls).toBe(0)
    expect(getEntries(agent).filter((e) => e.kind === 'summary')).toHaveLength(1)
  })

  it('20 turni simulati sopra soglia: al massimo 2 compattazioni in tutto (oggi una per turno)', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m5': 4_000 }) // soglia 2800, target 1800
    const agent = 'agent_d5_turni'
    // partenza sopra soglia: turni da ~62 token (un confine utente per turno)
    for (let t = 0; t < 60; t++) {
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `turno ${t} ` + 'a'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'assistant', content: 'risposta ' + 'b'.repeat(120) })
    }
    let calls = 0
    const digests: string[] = []
    const compact = (): Promise<boolean> =>
      maybeCompactHistory(agent, 'prov', 'm5', async (d) => {
        calls++
        digests.push(d)
        return 'RIEPILOGO: i fatti principali finora.'
      }, () => undefined)
    await compact() // la prima (la storia è sopra soglia)
    expect(calls).toBe(1)
    // 20 turni simulati: ogni turno aggiunge ~62 token (due entry da 125
    // caratteri) e chiama la compattazione come farebbe il loop
    for (let t = 0; t < 20; t++) {
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `dopo ${t} ` + 'c'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'assistant', content: 'risposta ' + 'd'.repeat(120) })
      await compact()
    }
    // ISTERESI: il confine riporta il resto sotto il 45% → servono ~8 turni
    // per risedere la soglia: in 20 turni AL MASSINO 2 compattazioni
    expect(calls).toBeLessThanOrEqual(2)
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it('il digest della SECONDA compattazione contiene il riassunto precedente e SOLO le entry nuove', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m5': 2_000 })
    const agent = 'agent_d5_increm'
    for (let t = 0; t < 40; t++) {
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `prima-fase-${t} ` + 'a'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'assistant', content: 'risposta ' + 'b'.repeat(120) })
    }
    const digests: string[] = []
    const compact = (out: string) => maybeCompactHistory(agent, 'prov', 'm5', async (d) => { digests.push(d); return out }, () => undefined)
    await compact('PRIMO RIEPILOGO: fatti A.')
    const firstSummary = getEntries(agent).findLast((e) => e.kind === 'summary')!
    const covers1 = firstSummary.meta!.coversUpTo as number
    // altre entry fin sopra soglia
    for (let t = 0; t < 30; t++) {
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `seconda-fase-${t} ` + 'e'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'assistant', content: 'risposta ' + 'f'.repeat(120) })
    }
    await compact('SECONDO RIEPILOGO: fatti A e B.')
    expect(digests).toHaveLength(2)
    const second = digests[1]!
    // il riassunto precedente c'è, INTERO
    expect(second).toContain('PRIMO RIEPILOGO: fatti A.')
    // e nessuna entry GIÀ COPERTA rientra nel digest (i marker della prima
    // fase non ci sono: solo il nuovo)
    expect(second).not.toContain('prima-fase-3 ') // le prime (coperte dal primo summary) non rientrano
    expect(second).toContain('seconda-fase-0')
    const entries = getEntries(agent)
    expect(entries.filter((e) => e.kind === 'message' && e.id <= covers1).length).toBeGreaterThan(0) // sanity: nel DB restano
  })

  it('il tetto del digest (50% del budget) è rispettato, col riassunto precedente INTATTO', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m5': 2_000 }) // tetto digest: 1000 token ≈ 4000 caratteri
    const agent = 'agent_d5_cap'
    for (let t = 0; t < 60; t++) {
      appendEntry({ agentId: agent, kind: 'tool-result', role: 'system', content: 'OUTPUT LUNGHISSIMO '.repeat(120) }) // ~2,5k caratteri l'uno
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `turno ${t} ` + 'a'.repeat(80) })
    }
    let digest = ''
    await maybeCompactHistory(agent, 'prov', 'm5', async (d) => { digest = d; return 'RIEPILOGO.' }, () => undefined)
    expect(digest.length).toBeLessThanOrEqual(4_000 + 200) // il tetto (con un piccolo margine di riga)
    // la storia risale sopra soglia: la SECONDA compattazione riceve il
    // riassunto precedente INTERO nel digest (mai tagliato dal tetto)
    for (let t = 0; t < 30; t++) {
      appendEntry({ agentId: agent, kind: 'tool-result', role: 'system', content: 'OUTPUT NUOVO '.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `dopo ${t} ` + 'a'.repeat(80) })
    }
    const second = await maybeCompactHistory(agent, 'prov', 'm5', async (d) => { digest = d; return 'SECONDO.' }, () => undefined)
    expect(second).toBe(true)
    expect(digest.length).toBeLessThanOrEqual(4_000 + 200)
    // al secondo giro il riassunto precedente resta INTERO nel digest
    expect(digest).toContain('RIEPILOGO.')
  })

  it('un fallimento della compattazione scrive UNA riga di log con la categoria (mai testo del modello) e il turno prosegue', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m5': 2_000 })
    const agent = 'agent_d5_fail'
    for (let t = 0; t < 40; t++) {
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `turno ${t} ` + 'a'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'assistant', content: 'risposta ' + 'b'.repeat(120) })
    }
    const logs: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')) }
    try {
      const done = await maybeCompactHistory(agent, 'prov', 'm5', async () => { throw new Error('boom dal provider') }, () => undefined)
      expect(done).toBe(false)
    } finally {
      console.log = orig
    }
    expect(logs.some((l) => l.includes('[compaction]'))).toBe(true)
    expect(logs.some((l) => l.includes('boom dal provider'))).toBe(false)
    expect(getEntries(agent).filter((e) => e.kind === 'summary')).toHaveLength(0)
  })

  it('MISURA (REPORT): 50 turni simulati — chiamate di compattazione e token dei digest', async () => {
    const { setSetting } = await import('../../store/db')
    setSetting('contextBudgetTokens', { 'prov/m5': 2_000 })
    const agent = 'agent_d5_misura'
    let calls = 0
    let digestTokens = 0
    const compact = () => maybeCompactHistory(agent, 'prov', 'm5', async (d) => {
      calls++
      digestTokens += Math.ceil(d.length / 4)
      return 'RIEPILOGO: fatti principali.'
    }, () => undefined)
    for (let t = 0; t < 50; t++) {
      appendEntry({ agentId: agent, kind: 'message', role: 'user', content: `turno ${t} ` + 'a'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'message', role: 'assistant', content: 'risposta ' + 'b'.repeat(120) })
      appendEntry({ agentId: agent, kind: 'tool-result', role: 'system', content: 'output ' + 'o'.repeat(200) })
      await compact()
    }
    // PRIMA (stessa simulazione, codice di ieri): 38 compattazioni e 100.219
    // token di digest — una per turno, il prefisso riassunto da capo ogni
    // volta. Il confronto finisce nel REPORT.
    console.log(`[D5 misura] 50 turni simulati (budget 2k token): ${calls} compattazioni, ${digestTokens} token di digest in totale (prima: 38 / 100.219)`)
    expect(calls).toBeLessThanOrEqual(12)
  }, 60_000)
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
    // fase 18a (E0): etichette inglesi — le legge il modello, con le vecchie
    // italiane la compaction tendeva a riassumere in italiano
    expect(digest).toContain('USER: domanda')
    expect(digest).toContain('TOOL run-command')
    expect(digest).toContain('RESULT: risultato')
    expect(digest).toContain('BOT→USER: BOT disse questo')
    expect(digest).not.toContain('UTENTE')
    expect(digest).not.toContain('ASSISTENTE')
    expect(digest).not.toContain('nota interna')
    expect(digest).not.toContain('Turno completato')
    expect(digest.includes('…')).toBe(true) // troncato
  })
})
