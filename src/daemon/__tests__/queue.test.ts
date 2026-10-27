// Test di scheduler (prossimo run_at → job 'routine-run') e policy di
// accodamento (notice "in coda"/"Coda piena", routine scartata se occupato)
// sullo store reale in una directory dati temporanea: senza Electron perché
// db.ts non dipende più da electron.app.
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, dataDir, db, createAgent, createRoutine, listRoutines, getEntries, appendEntry, type Routine } from '../../main/store/db'
import { claimDueJobs, activeJobForAgent, enqueueJob, pendingAgentPairJobs } from '../../main/store/jobs'
import { enqueueUserMessage, enqueueWidgetResponse } from '../enqueue'
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

describe('fase 3: risposta ai widget ask_user (§3bis L10)', () => {
  /** Crea una entry widget nel transcript reale e la ritorna. */
  function mkWidget(dismissOnMoveOn: boolean): ReturnType<typeof getEntries>[number] {
    return appendEntry({
      agentId: AGENT, kind: 'send-message', role: 'assistant', content: 'Sì o no?',
      meta: {
        message: {
          type: 'widget', prompt: 'Sì o no?',
          options: [{ label: 'Sì', value: 'si' }, { label: 'No', value: 'no' }],
          ...(dismissOnMoveOn ? { dismissOnMoveOn: true } : {})
        }
      }
    })
  }

  it('enqueueWidgetResponse: respondedValue sul widget, job con respondedTo e testo leggibile', () => {
    const w = mkWidget(true)
    const job = enqueueWidgetResponse(db(), AGENT, w.id, 'si', emit)!
    expect(job.kind).toBe('user-message')
    // il testo del messaggio utente è l'ETICHETTA dell'opzione, non il value
    expect(job.payload).toEqual({ text: 'Sì', respondedTo: w.id })
    // il widget salva la risposta
    expect(getEntries(AGENT).find((e) => e.id === w.id)?.meta?.respondedValue).toBe('si')
    // una seconda risposta allo stesso widget è ignorata
    expect(enqueueWidgetResponse(db(), AGENT, w.id, 'no', emit)).toBeNull()
  })

  it('un messaggio che NON risponde al widget lo marca widgetDismissed (solo con dismissOnMoveOn)', () => {
    const dismissible = mkWidget(true)
    const persistent = mkWidget(false)
    enqueueUserMessage(db(), AGENT, 'lascia stare, fai quest\'altro', undefined, emit)
    const entries = getEntries(AGENT)
    expect(entries.find((e) => e.id === dismissible.id)?.meta?.widgetDismissed).toBe(true)
    expect(entries.find((e) => e.id === persistent.id)?.meta?.widgetDismissed).toBeUndefined()
  })

  it('un messaggio CON respondedTo non scarta i widget (è la risposta, non un "vai avanti")', () => {
    const w = mkWidget(true)
    const job = enqueueWidgetResponse(db(), AGENT, w.id, ['si', 'no'], emit)! // multiSelect
    expect(job.payload.text).toBe('Sì, No')
    expect(getEntries(AGENT).find((e) => e.id === w.id)?.meta?.widgetDismissed).toBeUndefined()
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

// correzione A1: il limite orario per coppia conta anche i messaggi già in coda
describe('pendingAgentPairJobs: i send_to_agent accodati e non ancora consegnati', () => {
  const NOW = 2_000_000_000_000
  const pairJob = (from: string, to: string, over: Record<string, unknown> = {}) => ({
    initiator: 'AGENT', fromAgentId: from, fromAgentName: from, toAgentId: to, hop: 1, ...over
  })

  it('conta i job user-message della coppia (entrambe le direzioni) in coda o in lease, entro l\'ultima ora', () => {
    enqueueJob(db(), { agentId: 'b', kind: 'user-message', payload: pairJob('a', 'b'), runAt: 0, now: NOW - 60_000 })
    enqueueJob(db(), { agentId: 'a', kind: 'user-message', payload: pairJob('b', 'a'), runAt: 0, now: NOW - 120_000 })
    // coppia diversa e messaggio utente normale: non contano
    enqueueJob(db(), { agentId: 'c', kind: 'user-message', payload: pairJob('a', 'c'), runAt: 0, now: NOW - 60_000 })
    enqueueJob(db(), { agentId: 'b', kind: 'user-message', payload: { text: 'ciao' }, runAt: 0, now: NOW - 60_000 })
    expect(pendingAgentPairJobs(db(), 'a', 'b', NOW)).toBe(2)
  })

  it('i job consegnati, più vecchi di un\'ora o con entryId non contano (già entry del destinatario)', () => {
    const done = enqueueJob(db(), { agentId: 'b', kind: 'user-message', payload: pairJob('a', 'b'), runAt: 0, now: NOW - 60_000 })
    db().prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(done.id)
    // esattamente un'ora fa: fuori dalla finestra
    enqueueJob(db(), { agentId: 'b', kind: 'user-message', payload: pairJob('a', 'b'), runAt: 0, now: NOW - 3_600_000 })
    // in lease MA con entryId: il turno è già partito, il transcript lo conta
    const resumed = enqueueJob(db(), { agentId: 'b', kind: 'user-message', payload: pairJob('a', 'b', { entryId: 7 }), runAt: 0, now: NOW - 60_000 })
    db().prepare("UPDATE jobs SET status = 'leased' WHERE id = ?").run(resumed.id)
    // in lease SENZA entryId: in consegna, conta
    const leased = enqueueJob(db(), { agentId: 'b', kind: 'user-message', payload: pairJob('a', 'b'), runAt: 0, now: NOW - 60_000 })
    db().prepare("UPDATE jobs SET status = 'leased' WHERE id = ?").run(leased.id)
    expect(pendingAgentPairJobs(db(), 'a', 'b', NOW)).toBe(1)
  })
})
