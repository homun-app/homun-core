// D4 (fase deleghe): la coda della memoria non cresce a vuoto. Il tick dei
// 30 s accoda memory-embed SOLO per i bot con celle davvero da incorporare
// (bandiera «sporco» scritta quando si aggiunge testo alla memoria), e i
// job FINITI (done/failed) più vecchi di 7 giorni si cancellano una volta al
// giorno, in transazione e a blocchi. Livello store: nessun motore Engramma,
// la bandiera vive nel DB.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import * as store from '../../store/db'
import { listJobs, enqueueJob, claimDueJobs, cleanupFinishedJobs, JOB_CLEANUP_AFTER_MS, JOB_CLEANUP_BATCH } from '../../store/jobs'
import { TEST_TMP_BASE } from '../../../test-tmp'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-deleghe-d4-'))
  store.setDataDir(dir)
  store.db()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  store.db().exec('DELETE FROM jobs')
  store.db().exec('DELETE FROM settings')
  store.db().exec('DELETE FROM agents')
})

const mkAgents = (n: number): string[] => {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(store.createAgent(`Bot D4 ${i}`, '').id)
  return ids
}

describe('D4: il tick accoda memory-embed solo per chi è SPORCO', () => {
  it('10 bot senza novità, 10 tick → 0 job accodati', async () => {
    const { enqueueEmbedPendingDirty } = await import('../embed-dirty')
    const ids = mkAgents(10)
    for (let tick = 0; tick < 10; tick++) enqueueEmbedPendingDirty(store.db(), ids, 1_000 + tick)
    expect(listJobs(store.db()).filter((j) => j.kind === 'memory-embed')).toHaveLength(0)
  })

  it('un bot che scrive in memoria → 1 job (coalesce sui tick), gli altri niente', async () => {
    const { enqueueEmbedPendingDirty, markEmbedDirtyFor } = await import('../embed-dirty')
    const ids = mkAgents(4)
    markEmbedDirtyFor(store.db(), ids[1]!)
    for (let tick = 0; tick < 10; tick++) enqueueEmbedPendingDirty(store.db(), ids, 10_000 + tick)
    const jobs = listJobs(store.db()).filter((j) => j.kind === 'memory-embed')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.agent_id).toBe(ids[1])
  })

  it('la bandiera si legge e si toglie: dopo clear, il tick non accoda più', async () => {
    const { enqueueEmbedPendingDirty, markEmbedDirtyFor, clearEmbedDirty, embedDirtyAgents } = await import('../embed-dirty')
    const ids = mkAgents(2)
    markEmbedDirtyFor(store.db(), ids[0]!)
    expect(embedDirtyAgents(store.db())).toEqual([ids[0]])
    clearEmbedDirty(store.db(), ids[0]!)
    expect(embedDirtyAgents(store.db())).toEqual([])
    enqueueEmbedPendingDirty(store.db(), ids, 1_000)
    expect(listJobs(store.db()).filter((j) => j.kind === 'memory-embed')).toHaveLength(0)
  })

  it('markAllEmbedDirty segna tutti (la partenza del daemon riparte da lì)', async () => {
    const { markAllEmbedDirty, embedDirtyAgents, enqueueEmbedPendingDirty } = await import('../embed-dirty')
    const ids = mkAgents(3)
    markAllEmbedDirty(store.db(), ids)
    expect(embedDirtyAgents(store.db()).sort()).toEqual([...ids].sort())
    enqueueEmbedPendingDirty(store.db(), ids, 1_000)
    expect(listJobs(store.db()).filter((j) => j.kind === 'memory-embed')).toHaveLength(3)
  })
})

describe('D4: pulizia dei job finiti (done/failed oltre 7 giorni, a blocchi)', () => {
  const NOW = 2_000_000_000_000
  const OLD = NOW - JOB_CLEANUP_AFTER_MS - 3_600_000

  it('toglie i finiti VECCHI e lascia in coda, in lease e recenti', () => {
    const a = store.createAgent('Pulizia D4a', '').id
    const oldDone = enqueueJob(store.db(), { agentId: a, kind: 'memory-embed', payload: {}, runAt: 0, now: OLD })!
    const oldFailed = enqueueJob(store.db(), { agentId: a, kind: 'user-message', payload: { text: 'x' }, runAt: 0, now: OLD })!
    store.db().prepare("UPDATE jobs SET status = 'failed', last_error = 'boom' WHERE id = ?").run(oldFailed.id)
    const queued = enqueueJob(store.db(), { agentId: a, kind: 'user-message', payload: { text: 'in coda' }, runAt: NOW + 60_000, now: OLD })!
    const leased = enqueueJob(store.db(), { agentId: a, kind: 'routine-run', payload: {}, runAt: 0, now: OLD })!
    store.db().prepare("UPDATE jobs SET status = 'leased' WHERE id = ?").run(leased.id)
    const recentDone = enqueueJob(store.db(), { agentId: a, kind: 'memory-embed', payload: {}, runAt: 0, now: NOW - 3_600_000 })!
    store.db().prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(recentDone.id)
    expect(oldDone.status).toBe('queued') // Sanity: created old but queued → resta
    store.db().prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(oldDone.id)

    const removed = cleanupFinishedJobs(store.db(), NOW)
    expect(removed).toBe(2)
    const left = listJobs(store.db()).map((j) => j.id)
    expect(left).toEqual(expect.arrayContaining([queued.id, leased.id, recentDone.id]))
    expect(left).not.toContain(oldDone.id)
    expect(left).not.toContain(oldFailed.id)
  })

  it('a BLOCCHI: 12.000 righe finite vecchie se ne vanno tutte (batch 5.000 → 3 passi)', () => {
    expect(JOB_CLEANUP_BATCH).toBe(5_000)
    const a = store.createAgent('Pulizia D4b', '').id
    const ins = store.db().prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
    for (let i = 0; i < 12_000; i++) ins.run(a, 'memory-embed', '{}', 0, i % 4 === 3 ? 'failed' : 'done', OLD)
    const removed = cleanupFinishedJobs(store.db(), NOW)
    expect(removed).toBe(12_000)
    expect(listJobs(store.db())).toHaveLength(0)
  })

  it('MISURA: la pulizia su 100.000 righe finte (il numero finisce nel REPORT)', () => {
    const a = store.createAgent('Pulizia D4c', '').id
    const ins = store.db().prepare('INSERT INTO jobs(agent_id, kind, payload_json, run_at, status, attempts, created_at) VALUES(?,?,?,?,?,0,?)')
    const t0 = Date.now()
    for (let i = 0; i < 100_000; i++) ins.run(a, 'memory-embed', '{}', 0, 'done', OLD)
    const insertMs = Date.now() - t0
    const t1 = Date.now()
    const removed = cleanupFinishedJobs(store.db(), NOW)
    const cleanupMs = Date.now() - t1
    expect(removed).toBe(100_000)
    // tetto ampio e dichiarato (la CI gira su hardware vario): il numero
    // misurato finisce nel REPORT
    console.log(`[D4 misura] 100.000 righe finte: inserimento ${insertMs} ms, pulizia ${cleanupMs} ms`)
    expect(cleanupMs).toBeLessThan(30_000)
  }, 120_000)
})
