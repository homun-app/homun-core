// Test di scheduler (prossimo run_at → job 'routine-run') e policy di
// accodamento (notice "in coda"/"Coda piena", routine scartata se occupato)
// sullo store reale in una directory dati temporanea: senza Electron perché
// db.ts non dipende più da electron.app.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, dataDir, db, createAgent, createRoutine, listRoutines, getEntries, type Routine } from '../../main/store/db'
import { claimDueJobs, activeJobForAgent } from '../../main/store/jobs'
import { enqueueUserMessage } from '../enqueue'
import { dueRoutines, tickScheduler } from '../scheduler'
import { nextCronRun } from '../cron'
import type { SandbotEvent } from '../../shared/types'

const AGENT = 'agent_q'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-queue-test-'))
  setDataDir(dir)
  dataDir() // crea la directory
  db() // schema (incluse le tabelle jobs)
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

beforeEach(() => {
  events = []
  const d = db()
  d.exec('DELETE FROM jobs')
  d.exec('DELETE FROM entries')
  d.exec('DELETE FROM routines')
  d.exec('DELETE FROM agents')
  createAgent('TestBot', '')
})

describe('enqueueUserMessage: stessa semantica della coda della fase 1', () => {
  it('agente libero → job accodato senza notice', () => {
    const job = enqueueUserMessage(db(), AGENT, 'ciao', undefined, emit)!
    expect(job.kind).toBe('user-message')
    expect(job.status).toBe('queued')
    expect(job.payload).toEqual({ text: 'ciao' })
    // nessuna notice: il messaggio parte subito
    expect(getEntries(AGENT).filter((e) => e.kind === 'notice')).toHaveLength(0)
  })

  it('agente occupato → job in coda con notice di posizione', async () => {
    // simula il worker: prende in lease il primo job dell'agente
    const first = enqueueUserMessage(db(), AGENT, 'primo', undefined, emit)!
    const [leased] = claimDueJobs(db(), Date.now(), 120_000)
    expect(leased?.id).toBe(first.id)

    const second = enqueueUserMessage(db(), AGENT, 'secondo', undefined, emit)!
    expect(second.status).toBe('queued')
    const notices = getEntries(AGENT).filter((e) => e.kind === 'notice').map((e) => e.content)
    expect(notices).toEqual(['Agente occupato: messaggio in coda (posizione 1).'])
    expect(events.some((e) => e.type === 'entries')).toBe(true)
  })

  it('tetto 10 messaggi in coda: l\'undicesimo è scartato con notice "Coda piena" e NON accodato', () => {
    const jobCount = (): number =>
      (db().prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n
    // agente occupato dal primo job
    enqueueUserMessage(db(), AGENT, 'base', undefined, emit)
    claimDueJobs(db(), Date.now(), 120_000)
    for (let i = 1; i <= 10; i++) enqueueUserMessage(db(), AGENT, `msg${i}`, undefined, emit)
    const before = jobCount()
    const discarded = enqueueUserMessage(db(), AGENT, 'msg11', undefined, emit)
    expect(discarded).toBeNull()
    expect(jobCount()).toBe(before) // il numero di job in coda NON aumenta
    const notices = getEntries(AGENT).filter((e) => e.kind === 'notice').map((e) => e.content)
    // posizioni 1..10 + il messaggio 11 scartato
    expect(notices).toHaveLength(11)
    expect(notices[9]).toBe('Agente occupato: messaggio in coda (posizione 10).')
    expect(notices[10]).toBe('Coda piena: messaggio scartato.')
  })

  it('le immagini viaggiano nel payload solo se presenti', () => {
    const withImg = enqueueUserMessage(db(), AGENT, 'guarda', ['AAAA'], emit)!
    expect(withImg.payload).toEqual({ text: 'guarda', images: ['AAAA'] })
    const noImg = enqueueUserMessage(db(), AGENT, 'plain', undefined, emit)!
    expect(noImg.payload).toEqual({ text: 'plain' })
  })
})

describe('scheduler: routine dovute → job routine-run', () => {
  it('dueRoutines (puro): una routine è dovuta quando il prossimo run è passato', () => {
    const now = Date.now()
    const mk = (over: Partial<Routine>): Routine => ({
      id: 1, agent_id: AGENT, title: 't', prompt: 'p', schedule: '0 9 * * *', enabled: 1,
      last_run: null, created_at: now - 48 * 3600_000, ...over
    })
    expect(dueRoutines([mk({})], now)).toHaveLength(1) // mai girata, le 9 sono passate
    expect(dueRoutines([mk({ last_run: now - 60_000 })], now)).toHaveLength(0) // girata un minuto fa
    expect(dueRoutines([mk({ enabled: 0 })], now)).toHaveLength(0)
    expect(dueRoutines([mk({ schedule: 'non valida' })], now)).toHaveLength(0)
  })

  it('tickScheduler accoda il job e registra last_run; al secondo tick non ridoppia', () => {
    const r = createRoutine(AGENT, 'Backup', 'fai il backup', '0 9 * * *')
    // forza la routine come scaduta: created_at è adesso, il prossimo 9:00 è
    // nel futuro → la si simula già girata ieri
    db().prepare('UPDATE routines SET created_at = ? WHERE id = ?').run(Date.now() - 48 * 3600_000, r.id)

    const enqueued = tickScheduler(db(), emit, Date.now())
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.kind).toBe('routine-run')
    expect(enqueued[0]!.payload).toMatchObject({ routineId: r.id, title: 'Backup', prompt: 'fai il backup' })
    expect(listRoutines(AGENT)[0]!.last_run).not.toBeNull()

    // un tick subito dopo non ri-accoda: last_run è fresco
    expect(tickScheduler(db(), emit, Date.now())).toHaveLength(0)
  })

  it('routine su agente occupato: scartata con notice, nessun job', () => {
    const r = createRoutine(AGENT, 'Report', 'fai il report', '0 9 * * *')
    db().prepare('UPDATE routines SET created_at = ? WHERE id = ?').run(Date.now() - 48 * 3600_000, r.id)
    // agente occupato: job in lease
    enqueueUserMessage(db(), AGENT, 'occupante', undefined, emit)
    claimDueJobs(db(), Date.now(), 120_000)
    expect(activeJobForAgent(db(), AGENT)).not.toBeNull()

    const enqueued = tickScheduler(db(), emit, Date.now())
    expect(enqueued).toHaveLength(0)
    const notice = getEntries(AGENT).find((e) => e.kind === 'notice' && e.content.includes('Report') && e.content.includes('saltata'))
    expect(notice).toBeTruthy()
    // last_run comunque registrato (come in fase 1: fireRoutine toccava sempre)
    expect(listRoutines(AGENT)[0]!.last_run).not.toBeNull()
  })
})

describe('coerenza scheduler/cron', () => {
  it('una routine oraria viene accodata di nuovo solo dopo un\'ora', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 26, 10, 30))
    try {
      const r = createRoutine(AGENT, 'Oraria', 'check', '0 * * * *')
      // created_at adesso (10:30): prossimo run 11:00 → non dovuta
      expect(tickScheduler(db(), emit, Date.now())).toHaveLength(0)
      expect(nextCronRun('0 * * * *', Date.now())).toBeGreaterThan(Date.now())

      // ultima corsa 2 ore fa → dovuta adesso
      db().prepare('UPDATE routines SET last_run = ? WHERE id = ?').run(Date.now() - 2 * 3600_000, r.id)
      expect(tickScheduler(db(), emit, Date.now())).toHaveLength(1)
      // dopo la corsa, la prossima è tra un'ora: non dovuta
      expect(tickScheduler(db(), emit, Date.now())).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
