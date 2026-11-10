// Fase memoria-engramma · correzioni (C7): l'embedding solo nella corsia
// dell'agente. Il tick dei 30 s NON incorpora più direttamente
// (embedPendingAll girava fuori dalla corsia, anche DURANTE i turni, contro
// il «mai durante un turno»): ACCODA il job memory-embed con il coalesce che
// c'è già. E il job incorpora le celle DI QUELL'AGENTE (bot-<id>, storia-<id>
// e utente), non tutte le celle a ogni giro.
//
// Il modello vero di ~/.cache/engramma/models, rispecchiato come SYMLINK
// nella modelDir temporanea (come i test JS di Engramma): niente rete, il
// modelStatus lo trova già lì.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const MODEL_SRC = join(homedir(), '.cache', 'engramma', 'models', 'granite-embedding-97m-multilingual-r2')
const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-embed-'))
const DATA = join(ROOT, 'data')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const A = 'agent_emb_a'
const B = 'agent_emb_b'

beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(DATA)
  // il modello come symlink (nessuna copia: il disco è stretto)
  mkdirSync(join(DATA, 'models'), { recursive: true })
  symlinkSync(MODEL_SRC, join(DATA, 'models', 'granite-embedding-97m-multilingual-r2'))
})

describe.skipIf(!existsSync(MODEL_SRC))('fase memoria-engramma · correzioni C7: il job incorpora le celle di quell agente', () => {
  // LD5: il test apre il motore e incorpora col modello vero (secondi, non
  // millisecondi) — il tetto predefinito di 5 s di vitest lo uccideva a caso
  // sotto carico: le attese dentro sono già sull'ESITO, il tetto è solo un
  // limite di sicurezza, ampio e dichiarato
  it('memory-embed per l agente A incorpora bot-A, storia-A e utente — NON le celle di B', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    const st = await e.openMemoryEngine({ dataDir: DATA })
    expect(st.available).toBe(true)
    expect(st.model.present).toBe(true) // il symlink vale il modello scaricato

    const { indexStoryNote } = await import('../history-store')
    const { writeMemoryNote } = await import('../memory-store')
    await writeMemoryNote(A, { content: 'memoria del bot A prima', tier: 'log', source: 's', userTurn: true })
    await writeMemoryNote(A, { content: 'memoria del bot A seconda', tier: 'log', source: 's', userTurn: true })
    await writeMemoryNote(B, { content: 'memoria del bot B prima', tier: 'log', source: 's', userTurn: true })
    await writeMemoryNote(B, { content: 'memoria del bot B seconda', tier: 'log', source: 's', userTurn: true })
    await writeMemoryNote(A, { content: 'condivisa una', tier: 'log', scope: 'user', source: 's', userTurn: true })
    await writeMemoryNote(A, { content: 'condivisa due', tier: 'log', scope: 'user', source: 's', userTurn: true })
    await indexStoryNote(A, 1, 'user', 'messaggio di storia di A uno', 1730000000000)
    await indexStoryNote(A, 2, 'user', 'messaggio di storia di A due', 1730000001000)

    // il job memory-embed dell'agente A, col runner VERO del demone
    const { db } = await import('../../store/db')
    const { enqueueEmbedPending } = e
    const { makeJobRunner } = await import('../../../daemon/run-job')
    db().exec('DELETE FROM jobs')
    enqueueEmbedPending(db(), A, 1_000)
    const { listJobs } = await import('../../store/jobs')
    const job = listJobs(db()).find((j) => j.kind === 'memory-embed' && j.agent_id === A)!
    await makeJobRunner(db())(job, () => undefined)

    // le celle di A e la condivisa: incorporate (embedPending = 0 da adesso)
    expect(await (await e.botCell(A)).embedPending()).toBe(0)
    expect(await (await e.memoryCell('storia-' + 'agent_emb_a', 'homun')).embedPending()).toBe(0)
    expect(await (await e.userCell(A)).embedPending()).toBe(0)
    // le celle di B NON toccate dal job di A: le sue due memorie aspettano
    expect(await (await e.botCell(B)).embedPending()).toBe(2)
    // e il job di B finisce il lavoro
    enqueueEmbedPending(db(), B, 2_000)
    const jobB = listJobs(db()).find((j) => j.kind === 'memory-embed' && j.agent_id === B)!
    await makeJobRunner(db())(jobB, () => undefined)
    expect(await (await e.botCell(B)).embedPending()).toBe(0)
    await e.closeMemoryEngine()
  }, 120_000)

  it('il tick non incorpora direttamente: enqueueEmbedPendingAll accoda UN job per agente (coalesce)', async () => {
    const { enqueueEmbedPendingAll } = await import('../engine')
    const { listJobs } = await import('../../store/jobs')
    const { db } = await import('../../store/db')
    db().exec('DELETE FROM jobs')
    enqueueEmbedPendingAll(db(), [A, B], 5_000)
    enqueueEmbedPendingAll(db(), [A, B], 6_000) // due tick di fila
    const jobs = listJobs(db()).filter((j) => j.kind === 'memory-embed')
    expect(jobs.map((j) => j.agent_id).sort()).toEqual([A, B])
    await (await import('../engine')).closeMemoryEngine()
  })
})
