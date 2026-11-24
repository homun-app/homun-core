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
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { join } from 'node:path'
import { hasLocalEmbedModel, LOCAL_EMBED_MODEL } from '../../../test-local-model'

const MODEL_SRC = LOCAL_EMBED_MODEL
const A = 'agent_emb_a'
const B = 'agent_emb_b'

describe.skipIf(!hasLocalEmbedModel())('fase memoria-engramma · correzioni C7: il job incorpora le celle di quell agente', () => {
  // C2 (fase ci-temporanei): la cartella nasce nel beforeAll del describe e
  // muore nel suo afterAll, NON più a livello di modulo: in un file saltato
  // per intero (describe.skipIf — il runner della CI senza modelli locali)
  // vitest non gira NESSUN hook, e la mkdtemp al caricamento restava sul
  // disco (la sandbot-mem-embed- ×1 della corsa rossa).
  let ROOT = ''
  let DATA = ''
  beforeAll(async () => {
    ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mem-embed-'))
    DATA = join(ROOT, 'data')
    const { setDataDir } = await import('../../store/db')
    setDataDir(DATA)
    // il modello come symlink (nessuna copia: il disco è stretto)
    mkdirSync(join(DATA, 'models'), { recursive: true })
    symlinkSync(MODEL_SRC, join(DATA, 'models', 'granite-embedding-97m-multilingual-r2'))
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

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

  // D4 (fase deleghe): la coda della memoria non cresce a vuoto — il tick
  // accoda SOLO per i bot con celle davvero da incorporare (bandiera
  // «sporco» scritta dalle scritture), e la bandiera si toglie quando il job
  // gira col modello e non resta niente
  it('D4: la SCRITTURA sporca la bandiera; il tick accoda solo per chi ha novità; finito il lavoro la bandiera si toglie', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    const DATA2 = join(ROOT, 'data-d4')
    mkdirSync(join(DATA2, 'models'), { recursive: true })
    symlinkSync(MODEL_SRC, join(DATA2, 'models', 'granite-embedding-97m-multilingual-r2'))
    const st = await e.openMemoryEngine({ dataDir: DATA2 })
    expect(st.available && st.model.present).toBe(true)
    const { db } = await import('../../store/db')
    const { listJobs } = await import('../../store/jobs')
    const { makeJobRunner } = await import('../../../daemon/run-job')
    const { enqueueEmbedPendingDirty, embedDirtyAgents } = await import('../embed-dirty')
    db().exec('DELETE FROM jobs')
    db().exec('DELETE FROM settings')
    // nessuna novità: 10 tick, 0 job
    for (let t = 0; t < 10; t++) enqueueEmbedPendingDirty(db(), [A, B], 1_000 + t)
    expect(listJobs(db()).filter((j) => j.kind === 'memory-embed')).toHaveLength(0)
    // A scrive in memoria: la bandiera si sporca, il tick accoda SOLO per A
    const { writeMemoryNote } = await import('../memory-store')
    await writeMemoryNote(A, { content: 'memoria nuova di A', tier: 'log', source: 's', userTurn: true })
    expect(embedDirtyAgents(db())).toEqual([A])
    enqueueEmbedPendingDirty(db(), [A, B], 20_000)
    const jobs = listJobs(db()).filter((j) => j.kind === 'memory-embed')
    expect(jobs.map((j) => j.agent_id)).toEqual([A])
    // il job gira: incorpora tutto, la bandiera si toglie (modello presente,
    // zero da incorporare alla prossima) e il tick dopo non accoda più
    await makeJobRunner(db())(jobs[0]!, () => undefined)
    expect(await (await e.botCell(A)).embedPending()).toBe(0)
    // la bandiera è tolta (modello presente, zero da incorporare): il tick
    // dopo NON accoda più — nessun job NUOVO oltre a quello già girato
    const idsBefore = new Set(listJobs(db()).filter((j) => j.kind === 'memory-embed').map((j) => j.id))
    enqueueEmbedPendingDirty(db(), [A, B], 30_000)
    expect(listJobs(db()).filter((j) => j.kind === 'memory-embed' && !idsBefore.has(j.id))).toHaveLength(0)
    expect(embedDirtyAgents(db())).toEqual([])
    await e.closeMemoryEngine()
  }, 120_000)
})
