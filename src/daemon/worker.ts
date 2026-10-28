// Worker della coda durevole: recupera i lease scaduti, prende in lease i job
// dovuti (al più UN job attivo per agente), li esegue e rinnova il lease a
// ogni passo del loop dell'agente (heartbeat sugli eventi, con fallback a
// timer). I fallimenti ripartono in coda con backoff esponenziale, massimo 5
// tentativi. Tutto il ritmo passa da deps.now(): nei test il tempo è finto.
import type { DatabaseSync } from 'node:sqlite'
import {
  recoverExpiredLeases, claimDueJobs, renewLease, completeJob, failJob, type Job
} from '../main/store/jobs'
import { getSetting } from '../main/store/db'
import { DEFAULT_SUBAGENT_CONCURRENCY } from '../main/store/subagents'
import type { SandbotEvent } from '../shared/types'

const DEFAULT_LEASE_MS = 2 * 60_000
const DEFAULT_TICK_MS = 1000
/** Rinnovo del lease: a ogni evento dell'agente, comunque non più spesso di così. */
const HEARTBEAT_MIN_INTERVAL_MS = 10_000
/** Fallback se il turno non emette nulla (modello silenzioso, attesa lunga). */
const HEARTBEAT_FALLBACK_MS = 30_000

type Emitter = (e: SandbotEvent) => void

export interface WorkerDeps {
  now(): number
  /** Esegue un job (user-message/routine-run); emit è già cablato al heartbeat. */
  runJob(job: Job, emit: Emitter): Promise<void>
  onError?(job: Job, err: unknown, outcome: 'retry' | 'failed'): void
  /**
   * Fase 12 (punto 4): il tetto dei subagent-run in lease contemporaneamente
   * (default: setting subagents.maxConcurrent, 3). Iniettabile nei test.
   */
  maxSubagentLeases?(): number
}

export class JobWorker {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private readonly inflight = new Map<number, Promise<void>>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: WorkerDeps,
    private readonly emit: Emitter,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    /** in test: 0 disattiva il throttle del heartbeat */
    private readonly heartbeatMinMs = HEARTBEAT_MIN_INTERVAL_MS
  ) {}

  start(intervalMs = DEFAULT_TICK_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.timer.unref()
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Tick immediato (dopo un enqueue, per far partire il job subito). */
  poke(): void {
    this.tick()
  }

  /** Un tick: recovery dei lease scaduti + claim ed esecuzione dei job dovuti. */
  tick(): void {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.deps.now()
      recoverExpiredLeases(this.db, now)
      const cap = this.deps.maxSubagentLeases?.() ?? getSetting<number>('subagents.maxConcurrent', DEFAULT_SUBAGENT_CONCURRENCY)
      for (const job of claimDueJobs(this.db, now, this.leaseMs, 5, cap)) {
        // fire-and-forget: più agenti in parallelo, uno per agente
        const p = this.runOne(job).finally(() => this.inflight.delete(job.id))
        this.inflight.set(job.id, p)
      }
    } finally {
      this.ticking = false
    }
  }

  /** Attende che i job in volo finiscano (test/chiusura pulita). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()])
  }

  private async runOne(job: Job): Promise<void> {
    // heartbeat: rinnova il lease a ogni evento del turno (throttled) e
    // comunque ogni 30s finché il job è in volo
    let lastBeat = this.deps.now()
    const beat = () => {
      const now = this.deps.now()
      if (now - lastBeat < this.heartbeatMinMs) return
      lastBeat = now
      renewLease(this.db, job.id, now, this.leaseMs)
    }
    const fallback = setInterval(() => {
      const now = this.deps.now()
      renewLease(this.db, job.id, now, this.leaseMs)
      lastBeat = now
    }, HEARTBEAT_FALLBACK_MS)
    fallback.unref()
    const emitWithBeat = (e: SandbotEvent) => {
      beat()
      this.emit(e)
    }
    try {
      await this.deps.runJob(job, emitWithBeat)
      completeJob(this.db, job.id)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const outcome = failJob(this.db, job, this.deps.now(), error)
      this.deps.onError?.(job, e, outcome)
    } finally {
      clearInterval(fallback)
    }
  }
}
