// Fase 10 (punto 7) — test del runner dei job group-turn: apertura del turno
// (solo messaggi dopo il cursore, tag neutralizzato, windingDown), esiti
// SENT/PASS/TIMEOUT/SKIPPED/ERROR, cursore avanzato a fine turno, scadenza dei
// 5 minuti e ripresa dopo un crash (payload.entryId → resume). Store reale su
// directory temporanea, runTurn e orologio finti.
// Correzioni fase 10: C2 — il turno di chiusura del coordinatore accodato
// quando la catena si spegne/si chiude; C5 — stopReason: rate-limit/model-error
// → ERROR, sul rate limit cursore fermo, coda annullata e UNA riga di sistema.
// Correzioni 2: D1 — la profondità della finestra conta SOLO la catena del
// turno, senza i post del membro (le catene vecchie non trascinano windingDown
// né depth); D3 — l'attesa del coordinatore conta da inizio catena.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setDataDir, db, createAgent, updateAgent, appendEntry } from '../../main/store/db'
import { enqueueJob, getJobById, listJobs } from '../../main/store/jobs'
import {
  createGroup, addGroupMessage, groupMessages, getGroupCursor, groupTurnByNonce, setGroupCursor,
  addGroupMember, scheduleTurnsForMessage
} from '../../main/store/groups'
import { runGroupTurnJob, GROUP_TURN_TIMEOUT_MS, type GroupRunnerDeps } from '../group-runner'
import { closingTurnNonce, GROUP_RATE_LIMIT_TEXT, GROUP_CLOSING_LINE } from '../../main/agent/group-turns'
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

// ---- correzioni fase 10 ----

/**
 * runTurn finto che scrive nel transcript del membro COME il loop reale
 * (apertura → onTurnEntry, poi il copione) così il runner trova entry e
 * turnEnd con meta.stopReason.
 */
function scriptedDeps(
  seen: Seen[],
  script: {
    post?: string; send?: string; stopReason?: 'model-error' | 'rate-limit'
    /** correzione E2: la consegna scritta come testo libero (turno FINISHED senza post) */
    freeText?: string
    /** correzione E2: pass esplicito (silenzio scelto) */
    passed?: boolean
    /** correzione E2: turno FINISHED senza testo libero (risposta vuota) */
    finished?: boolean
  } = {}
): GroupRunnerDeps {
  return {
    runTurn: async (agentId, text, _e, _i, opts = {}) => {
      seen.push({ agentId, text, opts })
      const open = appendEntry({ agentId, kind: 'message', role: 'user', content: text })
      opts.onTurnEntry?.(open.id)
      const gt = opts.groupTurn as { groupId: number; readMaxDepth: number; rootId: number | null } | undefined
      if (script.post !== undefined && gt) {
        addGroupMessage({
          groupId: gt.groupId, authorKind: 'agent', authorId: agentId, authorName: 'Bot',
          text: script.post, depth: gt.readMaxDepth + 1, rootId: gt.rootId
        })
      }
      if (script.send !== undefined) {
        appendEntry({ agentId, kind: 'send-message', role: 'assistant', content: script.send, meta: { message: { type: 'text', text: script.send } } })
      }
      if (script.freeText !== undefined) {
        appendEntry({ agentId, kind: 'thinking', role: 'assistant', content: script.freeText })
      }
      if (script.passed) {
        appendEntry({ agentId, kind: 'tool-call', role: 'assistant', content: 'pass', meta: { id: 'p1', name: 'pass', arguments: '{}' } })
      }
      if (script.stopReason) {
        appendEntry({ agentId, kind: 'event', role: 'system', content: 'Turno interrotto', meta: { turnEnd: 'STOPPED', stopReason: script.stopReason } })
      } else if (script.freeText !== undefined || script.passed || script.finished) {
        appendEntry({ agentId, kind: 'event', role: 'system', content: 'Turno completato', meta: { turnEnd: 'FINISHED' } })
      }
    },
    interrupt: () => undefined,
    now: () => Date.now(),
    armTimeout: () => () => undefined
  }
}

/** Il job di chiusura accodato dal runner per QUESTA catena (payload.closing, nonce close<root>). */
function closingJob(g: { id: number }, coordId: string, rootId: number): Job | undefined {
  return listJobs(db()).find(
    (j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.nonce === closingTurnNonce(g.id, coordId, rootId)
  )
}

describe('correzione C2: il turno di chiusura del coordinatore', () => {
  it('la catena si SPEGNE (nessun turno in coda) con post di bot nuovi → UN turno di chiusura', async () => {
    const { bot, coord, g, u1 } = fixture()
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { post: 'CONSEGNA: menu pronto.' }), jobFor(bot.id, g, u1.id), emit)
    const job = closingJob(g, coord.id, u1.id)
    expect(job).toBeTruthy()
    expect(job!.agent_id).toBe(coord.id)
    expect((job!.payload as { rootId: number }).rootId).toBe(u1.id)
    // un solo job di chiusura per catena in questo gruppo
    expect(listJobs(db()).filter((j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.groupId === g.id)).toHaveLength(1)
    // il nonce è registrato: un'altra fine turno non lo riaccoda (niente doppioni)
    const seen2: Seen[] = []
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'grazie', depth: 0 })
    await runGroupTurnJob(db(), scriptedDeps(seen2, { post: 'nulla di nuovo' }), jobFor(bot.id, g, u2.id), emit)
    expect(listJobs(db()).filter((j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.nonce === closingTurnNonce(g.id, coord.id, u1.id))).toHaveLength(1)
  })

  it('la catena si CHIUDE a depth 6 (post a profondità massima) → il turno di chiusura parte comunque', async () => {
    const { bot, coord, g, u1 } = fixture()
    // il membro legge fino a depth 5 e pubblica il post che CHIUDE la catena (6)
    for (let d = 1; d <= 5; d++) {
      addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: `passaggio ${d}`, depth: d, rootId: u1.id })
    }
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { post: 'consegna finale' }), jobFor(bot.id, g, u1.id), emit)
    expect(closingJob(g, coord.id, u1.id)).toBeTruthy()
    // il post è finito a depth 6
    expect(groupMessages(g.id).findLast((m) => m.author_kind === 'agent' && m.author_id === bot.id)!.depth).toBe(6)
  })

  it('coordinatore in attesa (widget) o senza consegne nuove → NESSUN turno di chiusura', async () => {
    // niente consegne nuove: il membro tace → nessun post di bot nella catena
    const { bot, g, u1 } = fixture()
    await runGroupTurnJob(db(), scriptedDeps([]), jobFor(bot.id, g, u1.id), emit)
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.groupId === g.id)).toBe(false)

    // il coordinatore ha un widget senza risposta: lo riprende l'utente
    const f2 = fixture()
    appendEntry({
      agentId: f2.coord.id, kind: 'send-message', role: 'assistant', content: 'che budget?',
      meta: { message: { type: 'widget', prompt: 'che budget?', options: [] } }
    })
    await runGroupTurnJob(db(), scriptedDeps([], { post: 'consegna comunque' }), jobFor(f2.bot.id, f2.g, f2.u1.id), emit)
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.groupId === f2.g.id)).toBe(false)
  })

  it('gruppo SENZA coordinatore → nessun turno di chiusura (resta tutto com\'è)', async () => {
    const bot = createAgent('Solo', 'fa tutto lui')
    updateAgent(bot.id, { providerId: 'prov', model: 'm1' })
    const g = createGroup('Senza coord', 'd', bot.id, [bot.id], null)
    const u1 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'voi due', depth: 0 })
    await runGroupTurnJob(db(), scriptedDeps([], { post: 'consegna' }), jobFor(bot.id, g, u1.id), emit)
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.groupId === g.id)).toBe(false)
  })

  it('il turno di chiusura: apertura con chiusura="true" e la riga del riepilogo; SENT se scrive all\'utente, PASS altrimenti', async () => {
    const { bot, coord, g, u1 } = fixture()
    // il membro consegna e il runner accoda la chiusura
    await runGroupTurnJob(db(), scriptedDeps([], { post: 'CONSEGNA: tutto pronto.' }), jobFor(bot.id, g, u1.id), emit)
    const job = closingJob(g, coord.id, u1.id)!
    // lo esegue il coordinatore e scrive il riepilogo all'utente
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { send: 'RIEPILOGO: menu, spesa e scaletta.' }), job, emit)
    expect(seen[0]!.text).toContain('chiusura="true"')
    expect(seen[0]!.text).toContain(GROUP_CLOSING_LINE)
    expect(seen[0]!.opts.groupTurn).toMatchObject({ groupId: g.id, rootId: u1.id, closing: true })
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('SENT')
    // cursore del coordinatore avanzato
    expect(getGroupCursor(g.id, coord.id)).toBeGreaterThan(0)

    // senza riepilogo: PASS
    const f2 = fixture()
    await runGroupTurnJob(db(), scriptedDeps([], { post: 'CONSEGNA' }), jobFor(f2.bot.id, f2.g, f2.u1.id), emit)
    const job2 = closingJob(f2.g, f2.coord.id, f2.u1.id)!
    await runGroupTurnJob(db(), scriptedDeps([]), job2, emit)
    expect(groupTurnByNonce((job2.payload as { nonce: string }).nonce)!.outcome).toBe('PASS')
  })

  it('il turno di chiusura parte ANCHE a finestra vuota (il coordinatore ha già letto tutto: è il passo del riepilogo)', async () => {
    const { bot, coord, g, u1 } = fixture()
    await runGroupTurnJob(db(), scriptedDeps([], { post: 'CONSEGNA' }), jobFor(bot.id, g, u1.id), emit)
    const job = closingJob(g, coord.id, u1.id)!
    // il coordinatore ha già letto TUTTO (cursore a fine catena): niente SKIPPED
    setGroupCursor(g.id, coord.id, u1.id)
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { send: 'RIEPILOGO: tutto arrivato.' }), job, emit)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.text).toContain(GROUP_CLOSING_LINE)
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('SENT')
  })

  it('readWindow: la catena è quella dell\'ULTIMO messaggio letto (parità di depth inclusa), la profondità resta il massimo', async () => {
    const { bot, coord, g, u1 } = fixture()
    // catena vecchia (root u1) a depth 1, poi una catena NUOVA dell'utente e
    // il post del coordinatore: stessa depth massima, root diversa
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: 'vecchia catena', depth: 1, rootId: u1.id })
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'nuova richiesta', depth: 0 })
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: 'risposta nuova', depth: 1, rootId: u2.id })
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { post: 'consegna nella catena nuova' }), jobFor(bot.id, g, u2.id), emit)
    // il post del membro eredita la root dell'ULTIMO messaggio (catena nuova)
    expect(groupMessages(g.id).findLast((m) => m.author_id === bot.id)!.root_id).toBe(u2.id)
    expect(seen[0]!.opts.groupTurn?.rootId).toBe(u2.id)
    expect(seen[0]!.opts.groupTurn?.readMaxDepth).toBe(1)
  })
})

describe('correzione C5: errori del modello nei turni di gruppo', () => {
  it('model-error → ERROR (non più CANCELLED)', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    await runGroupTurnJob(db(), scriptedDeps([], { stopReason: 'model-error' }), job, emit)
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('ERROR')
  })

  it('loop/interrupt (STOPPED senza stopReason di modello) restano CANCELLED', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    const d: GroupRunnerDeps = {
      ...scriptedDeps([]),
      runTurn: async (agentId, text, _e, _i, opts = {}) => {
        const open = appendEntry({ agentId, kind: 'message', role: 'user', content: text })
        opts.onTurnEntry?.(open.id)
        appendEntry({ agentId, kind: 'event', role: 'system', content: 'Turno interrotto', meta: { turnEnd: 'STOPPED' } })
      }
    }
    await runGroupTurnJob(db(), d, job, emit)
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('CANCELLED')
  })

  it('rate-limit simulato (429): ERROR, cursore FERMO, coda del gruppo annullata (SKIPPED col motivo), UNA riga di sistema, niente chiusura', async () => {
    const { bot, coord, g, u1 } = fixture()
    // altri due turni del gruppo ancora in coda (coordinatore e un secondo messaggio)
    const j2 = jobFor(coord.id, g, u1.id)
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'altro messaggio', depth: 0 })
    const j3 = jobFor(bot.id, g, u2.id)
    const job = jobFor(bot.id, g, u1.id)
    await runGroupTurnJob(db(), scriptedDeps([], { stopReason: 'rate-limit' }), job, emit)
    // esito ERROR nel registro
    expect(groupTurnByNonce((job.payload as { nonce: string }).nonce)!.outcome).toBe('ERROR')
    // il cursore NON avanza: i messaggi restano da leggere
    expect(getGroupCursor(g.id, bot.id)).toBe(0)
    // i job group-turn del gruppo ancora in coda sono annullati e registrati SKIPPED col motivo
    const remaining = listJobs(db()).filter((j) => j.kind === 'group-turn' && j.payload.groupId === g.id && j.id !== job.id)
    expect(remaining).toHaveLength(0)
    for (const j of [j2, j3]) {
      const row = groupTurnByNonce((j.payload as { nonce: string }).nonce)
      expect(row!.outcome).toBe('SKIPPED')
      expect(row!.reason).toContain('rate limit')
    }
    // UNA riga di sistema nel gruppo (e una sola anche a un secondo 429)
    const lines = () => groupMessages(g.id).filter((m) => m.author_kind === 'system' && m.text === GROUP_RATE_LIMIT_TEXT)
    expect(lines()).toHaveLength(1)
    const u3 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'riprova', depth: 0 })
    await runGroupTurnJob(db(), scriptedDeps([], { stopReason: 'rate-limit' }), jobFor(bot.id, g, u3.id), emit)
    expect(lines()).toHaveLength(1)
    // niente turno di chiusura: il giro è sospeso, non finito
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && j.payload.closing === true && j.payload.groupId === g.id)).toBe(false)
  })
})

describe('correzione D1: la profondità conta SOLO la catena del turno', () => {
  it("il post del turno precedente non apre col windingDown: la risposta alla richiesta NUOVA esce a depth 1", async () => {
    const { coord, g, u1 } = fixture()
    // il post del TURNO PRECEDENTE del coordinatore resta oltre il suo cursore
    // (il cursore avanza all'ultimo letto all'APERTURA): depth 4, catena vecchia
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: 'passaggio 4 (catena vecchia)', depth: 4, rootId: u1.id })
    setGroupCursor(g.id, coord.id, u1.id)
    // la richiesta nuova dell'utente: catena NUOVA (depth 0) con @menzione
    const u7 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: "@Coordinatore aggiungi un'opzione vegetariana", depth: 0 })
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { post: 'chiamo lo chef' }), jobFor(coord.id, g, u7.id), emit)
    // catena del turno = quella dell'ULTIMO messaggio (la nuova), depth 0;
    // residuo 0b: la @menzione nella finestra porta called=true
    expect(seen[0]!.opts.groupTurn).toEqual({ groupId: g.id, readMaxDepth: 0, rootId: u7.id, called: true })
    // nessun windingDown: è la prima risposta a una richiesta nuova
    expect(seen[0]!.text).not.toContain('Il giro sta CHIUDENDO')
    // il post esce a depth 1 nella catena nuova (prima: 5, con windingDown)
    const post = groupMessages(g.id).findLast((m) => m.author_kind === 'agent' && m.author_id === coord.id && m.id > u7.id)!
    expect(post.depth).toBe(1)
    expect(post.root_id).toBe(u7.id)
  })

  it('una vecchia catena a depth 6 nella finestra + messaggio nuovo: la catena NUOVA parte da 0 e i menzionati ricevono il turno', async () => {
    const { bot, coord, g, u1 } = fixture()
    // un terzo membro da menzionare nella risposta dello specialista
    const chef = createAgent('Chef Menu', 'Il menu')
    updateAgent(chef.id, { providerId: 'prov', model: 'm1' })
    addGroupMember(g.id, chef.id)
    // catena VECCHIA finita a depth 6, ancora oltre il cursore dello specialista
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: coord.id, authorName: 'Coordinatore', text: 'fine del giro (depth 6)', depth: 6, rootId: u1.id })
    // la richiesta nuova dell'utente allo specialista
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: "@Cercatore Cena un'alternativa?", depth: 0 })
    const seen: Seen[] = []
    await runGroupTurnJob(db(), scriptedDeps(seen, { post: '@Chef Menu aggiorniamo il menu' }), jobFor(bot.id, g, u2.id), emit)
    expect(seen[0]!.opts.groupTurn).toEqual({ groupId: g.id, readMaxDepth: 0, rootId: u2.id, called: true })
    // il post esce a depth 1 (prima: 7 → planGroupTurns chiudeva SUBITO la catena)
    const post = groupMessages(g.id).findLast((m) => m.author_kind === 'agent' && m.author_id === bot.id)!
    expect(post.depth).toBe(1)
    expect(post.root_id).toBe(u2.id)
    // il post genera i turni (come fa l'intercettazione del loop): lo
    // specialista MENZIONATO riceve il turno, la catena nuova non si chiude
    scheduleTurnsForMessage(post, emit)
    expect(listJobs(db()).some((j) => j.kind === 'group-turn' && j.payload.nonce === `g${g.id}:${chef.id}:msg${post.id}`)).toBe(true)
    expect(groupMessages(g.id).filter((m) => m.author_kind === 'system' && m.id > u2.id)).toHaveLength(0)
  })

  it('i post del MEMBRO nella finestra non alzano la depth', async () => {
    const { bot, g } = fixture()
    // cursore fermo: nella finestra c'è anche un post del membro stesso a
    // depth 3 della catena corrente (letto, ma non conta per la profondità)
    const u2 = addGroupMessage({ groupId: g.id, authorKind: 'user', authorId: null, authorName: 'Fabio', text: 'e la spesa?', depth: 0 })
    addGroupMessage({ groupId: g.id, authorKind: 'agent', authorId: bot.id, authorName: 'Cercatore Cena', text: 'già risposto (depth 3)', depth: 3, rootId: u2.id })
    const seen: Seen[] = []
    await runGroupTurnJob(db(), deps(seen), jobFor(bot.id, g, u2.id), emit)
    // il post del membro non conta: la depth letta è quella dell'utente (0)
    expect(seen[0]!.opts.groupTurn).toEqual({ groupId: g.id, readMaxDepth: 0, rootId: u2.id })
  })
})

describe('correzione D3: attesa del coordinatore limitata alla catena', () => {
  it("un widget nato PRIMA della catena non blocca il turno di chiusura", async () => {
    const { bot, coord, g, u1 } = fixture()
    // un widget del coordinatore di settimane fa, mai risposto: senza D3 la
    // sua presenza bloccava per sempre OGNI turno di chiusura
    const oldWidget = appendEntry({
      agentId: coord.id, kind: 'send-message', role: 'assistant', content: 'che budget?',
      meta: { message: { type: 'widget', prompt: 'che budget?', options: [] } }
    })
    db().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(u1.created_at - 7 * 24 * 3_600_000, oldWidget.id)
    await runGroupTurnJob(db(), scriptedDeps([], { post: 'CONSEGNA: menu pronto.' }), jobFor(bot.id, g, u1.id), emit)
    // l'attesa è VECCHIA (prima dell'inizio della catena): la chiusura parte
    expect(closingJob(g, coord.id, u1.id)).toBeTruthy()
  })
})

describe('correzione E2: il motivo del PASS senza pass esplicito nel registro', () => {
  it('testo libero non pubblicato → PASS con reason "testo non pubblicato" (si distingue dal silenzio scelto)', async () => {
    const { bot, g, u1 } = fixture()
    const job = jobFor(bot.id, g, u1.id)
    await runGroupTurnJob(db(), scriptedDeps([], { freeText: '@Coordinatore cena ecco la scaletta v2 completa' }), job, emit)
    const row = groupTurnByNonce((job.payload as { nonce: string }).nonce)!
    expect(row.outcome).toBe('PASS')
    expect(row.reason).toBe('testo non pubblicato')
  })

  it('pass esplicito o FINISHED senza testo libero → PASS senza motivo, come prima', async () => {
    const a = fixture()
    const j1 = jobFor(a.bot.id, a.g, a.u1.id)
    await runGroupTurnJob(db(), scriptedDeps([], { passed: true }), j1, emit)
    const r1 = groupTurnByNonce((j1.payload as { nonce: string }).nonce)!
    expect(r1.outcome).toBe('PASS')
    expect(r1.reason).toBeFalsy()

    const b = fixture()
    const j2 = jobFor(b.bot.id, b.g, b.u1.id)
    await runGroupTurnJob(db(), scriptedDeps([], { finished: true }), j2, emit)
    const r2 = groupTurnByNonce((j2.payload as { nonce: string }).nonce)!
    expect(r2.outcome).toBe('PASS')
    expect(r2.reason).toBeFalsy()
  })
})
