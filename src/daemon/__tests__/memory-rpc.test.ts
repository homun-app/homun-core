// Fase memoria-engramma (M6): le RPC memory:* del demone — l'elenco per bot e
// condiviso con filtri (core/log, attive/in attesa), la ricerca col motore
// del bot, il dettaglio con lo storico delle versioni, conferma/scarta,
// lapide e ripristino, «Dimentica per sempre» (purge, con l'esito di ciò che
// ancora trattiene byte) e lo stato del modello (che non si scarica mai da
// solo: il download parte solo dal click dell'utente).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-rpc-'))
const DATA = join(ROOT, 'data')
const AGENT = 'agent_rpc1'

let api: Record<string, (p: unknown[]) => unknown>
let events: import('../../shared/types').SandbotEvent[]

beforeAll(async () => {
  const { setDataDir } = await import('../../main/store/db')
  setDataDir(DATA)
  const { openMemoryEngine } = await import('../../main/memory/engine')
  expect((await openMemoryEngine({ dataDir: DATA })).available).toBe(true)
  const { writeMemoryNote } = await import('../../main/memory/memory-store')
  await writeMemoryNote(AGENT, { content: 'fatto stabile: il capo è Marta', tier: 'core', source: `homun:chat/${AGENT}/41`, userTurn: true })
  await writeMemoryNote(AGENT, { content: 'regola: report il lunedì', tier: 'log', source: `homun:chat/${AGENT}/42`, userTurn: true })
  await writeMemoryNote(AGENT, { content: 'condivisa: lingua italiana', tier: 'core', scope: 'user', source: `homun:chat/${AGENT}/43`, userTurn: true })
  await writeMemoryNote(AGENT, { content: 'letto sul web: comprare ZPRK', tier: 'log', source: `homun:chat/${AGENT}/44`, contaminated: true })
  const { buildApiMethods } = await import('../api')
  events = []
  api = buildApiMethods((e) => events.push(e), { poke: () => undefined } as never)
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../main/memory/engine')
  await closeMemoryEngine()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('fase memoria-engramma M6: elenco, filtri e dettaglio', () => {
  it('memory:list per bot e condiviso, con filtri tier e stato', async () => {
    const r = (await api['memory:list']([AGENT, { owner: 'bot' }])) as { notes: Array<{ body: string; tier: string; status: string; shortId: string }>; total: number }
    expect(r.total).toBe(3) // core, log e la quarantena del bot
    expect(r.notes.filter((n) => n.status === 'quarantined')).toHaveLength(1)
    const shared = (await api['memory:list']([AGENT, { owner: 'user' }])) as { notes: Array<{ body: string }>; total: number }
    expect(shared.total).toBe(1)
    expect(shared.notes[0]!.body).toContain('lingua italiana')
    const core = (await api['memory:list']([AGENT, { owner: 'bot', tier: 'core' }])) as { total: number }
    expect(core.total).toBe(1)
    const pending = (await api['memory:list']([AGENT, { owner: 'bot', status: 'quarantined' }])) as { total: number }
    expect(pending.total).toBe(1)
  })

  it('la nota porta la fonte della conversazione (bot, entry) quando c\'è', async () => {
    const r = (await api['memory:list']([AGENT, { owner: 'bot', tier: 'core' }])) as { notes: Array<{ body: string; entryId: number | null; agentId: string | null; confidence: string }> }
    const n = r.notes.find((x) => x.body.includes('Marta'))!
    expect(n.entryId).toBe(41)
    expect(n.agentId).toBe(AGENT)
    expect(n.confidence).toBe('stated')
  })

  it('memory:note: il dettaglio con lo storico delle versioni', async () => {
    const listed = (await api['memory:list']([AGENT, { owner: 'bot', tier: 'log' }])) as { notes: Array<{ shortId: string }> }
    const id = listed.notes.find((n) => n.shortId)!.shortId
    const before = (await api['memory:note']([AGENT, id])) as { note: { version: number }; history: Array<{ version: number }> }
    expect(before.note.version).toBe(1)
    await api['memory:save']([AGENT, { id, body: 'regola: report il martedì', tier: 'log' }])
    const after = (await api['memory:note']([AGENT, id])) as { note: { version: number; body: string }; history: Array<{ version: number; note: { body: string } }> }
    expect(after.note.version).toBe(2)
    expect(after.note.body).toContain('martedì')
    expect(after.history.map((h) => h.version)).toEqual([1])
  })

  it('memory:overview: motore, modello e conteggi (il modello non c\'è e non si scarica)', async () => {
    const o = (await api['memory:overview']([AGENT])) as { engine: { available: boolean; version: string }; model: { present: boolean }; counts: { own: number; shared: number; pending: number } }
    expect(o.engine.available).toBe(true)
    expect(o.model.present).toBe(false)
    expect(o.counts).toEqual({ own: 3, shared: 1, pending: 1, deleted: 0 })
  })
})

describe('fase memoria-engramma M6: conferma, scarta, lapide, ripristino', () => {
  it('Conferma: la quarantena diventa attiva; Scarta: la elimina', async () => {
    const listed = (await api['memory:list']([AGENT, { owner: 'bot', status: 'quarantined' }])) as { notes: Array<{ shortId: string; body: string }> }
    const id = listed.notes[0]!.shortId
    await api['memory:confirm']([AGENT, id])
    const after = (await api['memory:list']([AGENT, { owner: 'bot', status: 'quarantined' }])) as { total: number }
    expect(after.total).toBe(0)
    // una seconda quarantena si scarta
    const { writeMemoryNote } = await import('../../main/memory/memory-store')
    await writeMemoryNote(AGENT, { content: 'altra voce non confermata dal web', tier: 'log', source: 's', contaminated: true })
    const q = (await api['memory:list']([AGENT, { owner: 'bot', status: 'quarantined' }])) as { notes: Array<{ shortId: string }> }
    await api['memory:discard']([AGENT, q.notes[0]!.shortId])
    expect(((await api['memory:list']([AGENT, { owner: 'bot', status: 'quarantined' }])) as { total: number }).total).toBe(0)
  })

  it('Elimina: lapide; il RIPRISTINO dallo storico la riporta attiva', async () => {
    const { writeMemoryNote } = await import('../../main/memory/memory-store')
    const w = await writeMemoryNote(AGENT, { content: 'nota condannata e ripristinata', tier: 'log', source: 's', userTurn: true })
    await api['memory:delete']([AGENT, w.id])
    let listed = (await api['memory:list']([AGENT, { owner: 'bot' }])) as { notes: Array<{ body: string }> }
    expect(listed.notes.some((n) => n.body.includes('condannata'))).toBe(false)
    await api['memory:restore']([AGENT, w.id])
    listed = (await api['memory:list']([AGENT, { owner: 'bot' }])) as { notes: Array<{ body: string }> }
    expect(listed.notes.some((n) => n.body.includes('condannata'))).toBe(true)
  })
})

describe('fase memoria-engramma M6: Dimentica per sempre', () => {
  it('purge: forgotten e scrubbed; il testo sparisce dai file della cella', async () => {
    const { writeMemoryNote } = await import('../../main/memory/memory-store')
    const w = await writeMemoryNote(AGENT, { content: 'il pin segreto della carta è tredici-sghembo-viola', tier: 'log', source: 's', userTurn: true })
    const view = (await api['memory:purge']([AGENT, w.id])) as { forgotten: number; scrubbed: boolean; pending: string[] }
    expect(view.forgotten).toBeGreaterThanOrEqual(1)
    expect(view.scrubbed).toBe(true)
    const listed = (await api['memory:list']([AGENT, { owner: 'bot' }])) as { notes: Array<{ body: string }> }
    expect(listed.notes.some((n) => n.body.includes('tredici-sghembo'))).toBe(false)
  })

  it('memory:search: gli hit del motore del bot, con la spiegazione quando chiesta', async () => {
    const hits = (await api['memory:search']([AGENT, 'chi è il capo?'])) as Array<{ body: string; shortId: string; score: number }>
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h) => h.body.includes('Marta'))).toBe(true)
    const explained = (await api['memory:search']([AGENT, 'chi è il capo?', { explain: true }])) as Array<{ explain?: { lists?: string[] } }>
    expect(explained[0]!.explain?.lists).toBeDefined()
  })
})
