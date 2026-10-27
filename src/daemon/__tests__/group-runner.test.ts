// Fase 10 (punto 7) — test del runner dei job group-turn: apertura del turno
// (solo messaggi dopo il cursore, tag neutralizzato, windingDown), esiti
// SENT/PASS/TIMEOUT/SKIPPED/ERROR, cursore avanzato a fine turno, scadenza dei
// 5 minuti e ripresa dopo un crash (payload.entryId → resume). Store reale su
// directory temporanea, runTurn e orologio finti.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, db, createAgent, updateAgent } from '../../main/store/db'
import { enqueueJob, getJobById } from '../../main/store/jobs'
import { createGroup, addGroupMessage, groupMessages, getGroupCursor, groupTurnByNonce, setGroupCursor } from '../../main/store/groups'
import { runGroupTurnJob, GROUP_TURN_TIMEOUT_MS, type GroupRunnerDeps } from '../group-runner'
import type { RunTurnOptions } from '../../main/agent/loop'
import type { Job } from '../../main/store/jobs'
import type { SandbotEvent } from '../../shared/types'

let dir: string
const emit = (_e: SandbotEvent): void => undefined

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-grouprunner-'))
  setDataDir(dir)
  db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Seen {
  agentId: string
  text: string
  opts: RunTurnOptions
}

/** Fixture: gruppo con Bot (il membro che riceve i turni) e Coordinatore. */
function fixture() {
  const bot = createAgent('Cercatore Cena', 'Trova i ristoranti')
  updateAgent(bot.id, { providerId: 'prov', model: 'm1' })
  const coord = createAgent('Coordinatore', 'Assegna i compiti')
  updateAgent(coord.id, { providerId: 'prov', model: 'm1' })
  const g = createGroup('Cena compleanno', 'Menu per 8, consegna al coordinatore', coord.id, [bot.id], coord.id)
  const u1 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'Serve il menu entro stasera', depth: 0 })
  return { bot, coord, g, u1 }
}

function deps(seen: Seen[], behavior?: (s: Seen) => void | Promise<void>): GroupRunnerDeps {
  return {
    runTurn: async (agentId, text, _emit, _images, opts = {}) => {
      const s = { agentId, text, opts }
      seen.push(s)
      await behavior?.(s)
      if (!opts.resume) opts.onTurnEntry?.(42)
    },
    interrupt: () => undefined,
    now: () => 10_000,
    armTimeout: () => () => undefined
  }
}

/** Il job reale del membro per il messaggio m (come lo accoda la colla). */
function jobFor(botId: string, g: { id: number }, messageId: number): Job {
  return enqueueJob(db(), {
    agentId: botId,
    kind: 'group-turn',
    payload: { groupId: g.id, memberId: botId, nonce: `g${g.id}:${botId}:msg${messageId}`, sourceMessageId: messageId },
    runAt: 0,
    now: 0
  })
}

describe('apertura del turno', () => {
  it('il testo al modello è il blocco evidenza con SOLI i messaggi dopo il cursore', async () => {
    const { bot, coord, g, u1 } = fixture()
    // un messaggio già letto (cursore oltre) e uno nuovo
    const b1 = addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: 'già letto', depth: 1, rootId: u1.id })
    setGroupCursor(g.id, bot.id, b1.id)
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'e la lista della spesa?', depth: 0 })
    const seen: Seen[] = []
    await runGroupTurnJob(db(), deps(seen), jobFor(bot.id, g, u2.id), emit)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.text).toContain('<turno_di_gruppo gruppo="Cena compleanno">')
    expect(seen[0]!.text).toContain('[utente] Fabio: e la lista della spesa?')
    expect(seen[0]!.text).not.toContain('già letto')
    expect(seen[0]!.text).not.toContain('Serve il menu entro stasera')
    // i pari con ruolo e coordinatore marcato, e la regola dei turni
    expect(seen[0]!.text).toContain('- Coordinatore (coordinatore): Assegna i compiti')
    expect(seen[0]!.text).toContain('Regole del turno di gruppo')
    // origine: turno non fidato (come i messaggi di altri bot), gruppo nel meta
    expect(seen[0]!.opts.untrusted).toBe(true)
    expect(seen[0]!.opts.groupTurn).toEqual({ groupId: g.id, readMaxDepth: 0, rootId: u2.id })
    expect(seen[0]!.opts.initiator).toBe('GROUP_TURN')
  })

  it('la citazione del reply_to compare; windingDown da depth ≥ 4', async () => {
    const { bot, coord, g, u1 } = fixture()
    const d4 = addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: 'quarto passaggio', depth: 4, rootId: u1.id, replyTo: u1.id })
    const seen: Seen[] = []
    await runGroupTurnJob(db(), deps(seen), jobFor(bot.id, g, d4.id), emit)
    expect(seen[0]!.text).toContain('(in risposta a Fabio: «Serve il menu entro stasera»)')
    expect(seen[0]!.text).toContain('Il giro sta CHIUDENDO')
    expect(seen[0]!.opts.groupTurn?.readMaxDepth).toBe(4)
  })
})

describe('esiti e cursore', () => {
  it('SENT: il membro scrive nel gruppo durante il turno', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    await runGroupTurnJob(db(), deps([], (s) => {
      addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: s.agentId, authorName: 'Cercatore Cena', text: 'tre opzioni trovate', depth: 1, rootId: u1.id })
    }), job, emit)
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('SENT')
    // cursore avanzato alla fine della finestra letta
    expect(getGroupCursor(g.id, bot.id)).toBe(u1.id)
  })

  it('PASS: il membro tace (nessun recupero: il silenzio è un esito)', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    await runGroupTurnJob(db(), deps([]), job, emit)
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('PASS')
  })

  it('TIMEOUT: scaduti i 5 minuti si interrompe il membro e vale TIMEOUT', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    const interrupts: string[] = []
    const d: GroupRunnerDeps = {
      ...deps([]),
      interrupt: (id) => interrupts.push(id),
      // la scadenza scatta subito
      armTimeout: (cb) => { cb(); return () => undefined }
    }
    await runGroupTurnJob(db(), d, job, emit)
    expect(interrupts).toEqual([bot.id])
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('TIMEOUT')
    expect(GROUP_TURN_TIMEOUT_MS).toBe(5 * 60_000)
  })

  it('SKIPPED: gruppo sparito, membro non più dentro, niente messaggi nuovi', async () => {
    const { bot, coord, g, u1 } = fixture()
    const gone = jobFor(bot.id, { id: 99999 }, u1.id)
    await runGroupTurnJob(db(), deps([]), gone, emit)
    expect(groupTurnByNonce((gone.payload as { nonce: string }).nonce)!.outcome).toBe('SKIPPED')

    // membro rimosso: nonce nuovo messaggio
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'altro', depth: 0 })
    const { removeGroupMember } = await import('../../main/store/groups')
    removeGroupMember(g.id, bot.id)
    const j2 = jobFor(bot.id, g, u2.id)
    await runGroupTurnJob(db(), deps([]), j2, emit)
    expect(groupTurnByNonce((j2.payload as { nonce: string }).nonce)!.outcome).toBe('SKIPPED')

    // cursore già oltre: niente di nuovo da leggere
    const c1 = createAgent('Terzo', '')
    const { addGroupMember } = await import('../../main/store/groups')
    addGroupMember(g.id, c1.id)
    setGroupCursor(g.id, c1.id, u2.id)
    const j3 = jobFor(c1.id, g, u2.id)
    await runGroupTurnJob(db(), deps([]), j3, emit)
    expect(groupTurnByNonce((j3.payload as { nonce: string }).nonce)!.outcome).toBe('SKIPPED')
    expect(coord).toBeTruthy()
  })

  it('ERROR: runTurn che lancia registra ERROR e rilancia (la coda riprova)', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    const d: GroupRunnerDeps = {
      ...deps([]),
      runTurn: async () => { throw new Error('boom') }
    }
    await expect(runGroupTurnJob(db(), d, job, emit)).rejects.toThrow('boom')
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('ERROR')
  })
})

describe('ripresa dopo un crash', () => {
  it('payload.entryId → resume al turno successivo; onTurnEntry salvato al primo', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    // primo tentativo: crash DOPO l'apertura del turno (onTurnEntry chiamato)
    const seen: Seen[] = []
    const first: GroupRunnerDeps = {
      ...deps([]),
      runTurn: async (agentId, text, _e, _i, opts = {}) => {
        seen.push({ agentId, text, opts })
        opts.onTurnEntry?.(77)
        throw new Error('crash')
      }
    }
    await expect(runGroupTurnJob(db(), first, job, emit)).rejects.toThrow('crash')
    // il payload del job ora ha entryId 77 (come il worker con la ripresa R1)
    const reloaded = getJobById(db(), job.id)!
    expect((reloaded.payload as { entryId?: number }).entryId).toBe(77)
    // secondo tentativo (coda che riprova): resume con lo stesso entryId,
    // il turno NON riscrive il messaggio di apertura
    const second: Seen[] = []
    await runGroupTurnJob(db(), deps(second), reloaded, emit)
    expect(second[0]!.opts.resume).toEqual({ entryId: 77 })
    expect(second[0]!.text).toContain('<turno_di_gruppo')
  })
})
