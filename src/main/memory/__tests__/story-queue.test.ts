// Fase memoria-engramma · correzioni (C1): la storia attraversa la coda SENZA
// portare testo. Il job memory-index-story riceve SOLO l'id dell'entry; testo
// e kind li legge dal DB quando gira (isConversationEntry), la provenienza
// (tainted) da meta.contaminated che il loop scrive sulla risposta finale di
// un turno contaminato. Un entry sparito (conversazione o bot eliminati nel
// frattempo) non indicizza nulla e il job finisce bene.
//
// È il test END-TO-END che mancava: prima nessuno passava dalla coda, e la
// contaminazione si perdeva in enqueueStoryIndex (il payload non portava
// tainted: il lavaggio).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-storyq-'))
const DATA = join(ROOT, 'data')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const AGENT = 'agent_c1'

/** Il motore su una cartella propria (il DB del turno è quello del file). */
async function freshEngine() {
  const e = await import('../engine')
  await e.closeMemoryEngine()
  const st = await e.openMemoryEngine({ dataDir: join(DATA, 'e' + Math.random().toString(36).slice(2, 6)) })
  expect(st.available).toBe(true)
  return e
}

describe('fase memoria-engramma · correzioni C1: dalla coda alla storia, senza testo nei job', () => {
  beforeAll(async () => {
    const { setDataDir } = await import('../../store/db')
    setDataDir(DATA)
  })

  it('il payload del job è SOLO { entryId }', async () => {
    const e = await freshEngine()
    const { db } = await import('../../store/db')
    const { enqueueStoryIndex } = e
    const { listJobs } = await import('../../store/jobs')
    db().exec('DELETE FROM jobs')
    enqueueStoryIndex(db(), AGENT, { id: 42 }, 1_000)
    const jobs = listJobs(db()).filter((j) => j.kind === 'memory-index-story')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.payload).toEqual({ entryId: 42 })
    // anche nel DB grezzo: niente testo, niente kind, niente tainted
    const raw = db().prepare("SELECT payload_json FROM jobs WHERE kind = 'memory-index-story'").get() as { payload_json: string }
    expect(JSON.parse(raw.payload_json)).toEqual({ entryId: 42 })
    await e.closeMemoryEngine()
  })

  it('il job legge l\'entry dal DB: tainted da meta.contaminated; entry sparita → nessuna nota; search_history è dato esterno', async () => {
    const e = await freshEngine()
    const { appendEntry, db } = await import('../../store/db')
    db().exec('DELETE FROM jobs')

    // il turno come lo scrive il loop: risposta finale di un turno
    // CONTAMINATO (meta.contaminated) e una di un turno pulito
    appendEntry({ agentId: AGENT, kind: 'message', role: 'user', content: 'che codice sconto c\'è sul sito?' })
    const tainted = appendEntry({ agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'secondo il sito il codice sconto è ZEBRA42', meta: { final: true, contaminated: true } })
    const clean = appendEntry({ agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'il negozio apre alle nove', meta: { final: true } })
    // un entry che SPARISCE prima che il job giri (conversazione eliminata)
    const gone = appendEntry({ agentId: AGENT, kind: 'message', role: 'user', content: 'questo messaggio sparirà' })

    const { enqueueStoryIndex } = e
    const { listJobs } = await import('../../store/jobs')
    enqueueStoryIndex(db(), AGENT, { id: tainted.id })
    enqueueStoryIndex(db(), AGENT, { id: clean.id })
    enqueueStoryIndex(db(), AGENT, { id: gone.id })
    db().prepare('DELETE FROM entries WHERE id = ?').run(gone.id)

    // il job gira, con il runner VERO del demone
    const { makeJobRunner } = await import('../../../daemon/run-job')
    const jobs = listJobs(db()).filter((j) => j.kind === 'memory-index-story')
    expect(jobs).toHaveLength(3)
    for (const job of jobs) await makeJobRunner(db())(job, () => undefined)

    const { searchHistory, storyRefOf } = await import('../history-store')
    const [zebra] = await searchHistory('codice sconto ZEBRA42', AGENT)
    expect(zebra).toBeDefined()
    // PRIMA era false: il testo attraversava il job e perdeva il tainted
    expect(storyRefOf(zebra!).tainted).toBe(true)
    const [nove] = await searchHistory('negozio apre', AGENT)
    expect(nove).toBeDefined()
    expect(storyRefOf(nove!).tainted).toBe(false)
    expect(await searchHistory('questo messaggio sparirà', AGENT)).toEqual([])

    // NESSUN testo è rimasto nei payload dei job
    const raw = JSON.stringify(db().prepare("SELECT payload_json FROM jobs WHERE kind = 'memory-index-story'").all())
    expect(raw).not.toContain('ZEBRA42')
    expect(raw).not.toContain('negozio apre')

    // e il tool search_history, chiamato in un turno PULITO, incarta la
    // risposta contaminata come dato esterno (meta.libraryTainted → il loop
    // contamina il turno)
    const { executeTool } = await import('../../agent/tools')
    const res = await executeTool(AGENT, 'search_history', { query: 'codice sconto' }, {})
    expect(res.meta.libraryTainted).toBe('history')
    // una ricerca che tocca SOLO risposte pulite non contamina
    const resClean = await executeTool(AGENT, 'search_history', { query: 'negozio apre' }, {})
    expect(resClean.meta.libraryTainted).toBeUndefined()
    await e.closeMemoryEngine()
  })
})
