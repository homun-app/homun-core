// Test del runner dei job: la mappa job → runTurn con la ripresa R1 — al
// primo tentativo l'id dell'entry che apre il turno finisce nel payload
// (payload.entryId); ai tentativi successivi torna indietro come `resume`,
// così il turno riprende dal transcript invece di riscrivere il messaggio.
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL, enqueueJob, getJobById } from '../../main/store/jobs'
import { SUBAGENTS_DDL } from '../../main/store/subagents'
// fase 16c (C5): lo storico delle esecuzioni delle routine
import { ROUTINE_RUNS_DDL } from '../../main/store/routine-runs'
import { makeJobRunner } from '../run-job'
import type { RunTurnOptions } from '../../main/agent/loop'
import type { SandbotEvent } from '../../shared/types'

const emit = (_e: SandbotEvent): void => undefined

interface Seen { agentId: string; text: string; images?: string[]; opts: RunTurnOptions }

/** runTurn finto: registra la chiamata e, al primo tentativo (niente resume), registra l'entry. */
function fakeTurn(log: Seen[]) {
  return async (agentId: string, text: string, _emit: typeof emit, images?: string[], opts: RunTurnOptions = {}): Promise<void> => {
    log.push({ agentId, text, images, opts })
    if (!opts.resume) opts.onTurnEntry?.(42)
  }
}

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(JOBS_DDL)
  db.exec(ROUTINE_RUNS_DDL)
  // fase 8: il runner legge titolo e ORIGINE del task (correzione B1) dalla
  // propria connessione
  db.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, agent_id TEXT, title TEXT, status TEXT DEFAULT 'working', created_at INTEGER, updated_at INTEGER, summary TEXT, untrusted INTEGER DEFAULT 0, automatic INTEGER DEFAULT 0)")
  // fase 18b (H7): il runner legge il modello PROPRIo della routine alla
  // ESECUZIONE (colonne provider_id/model/thinking)
  db.exec(`CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, title TEXT NOT NULL,
    prompt TEXT NOT NULL, schedule TEXT NOT NULL, enabled INTEGER DEFAULT 1,
    last_run INTEGER, created_at INTEGER, description TEXT DEFAULT '',
    timezone TEXT DEFAULT '', provenance TEXT DEFAULT 'user', trigger_json TEXT,
    paused_for_away INTEGER DEFAULT 0, last_poll INTEGER,
    provider_id TEXT, model TEXT, thinking TEXT
  )`)
})

describe('makeJobRunner: user-message', () => {
  it('primo tentativo: onTurnEntry salva payload.entryId nel job', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'ciao' }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.agentId).toBe('a1')
    expect(log[0]!.text).toBe('ciao')
    expect(log[0]!.opts.source).toBe('user')
    expect(log[0]!.opts.resume).toBeUndefined()
    expect(getJobById(db, job.id)!.payload).toEqual({ text: 'ciao', entryId: 42 })
  })

  it('retry (payload.entryId presente): passa resume al turno', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'ciao', entryId: 7 }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.resume).toEqual({ entryId: 7 })
    expect(getJobById(db, job.id)!.payload).toEqual({ text: 'ciao', entryId: 7 })
  })

  it('le immagini viaggiano fino a runTurn', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'user-message', payload: { text: 'guarda', images: ['AAAA'] }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.images).toEqual(['AAAA'])
  })

  // fase 7: i payload speciali del sistema mappano sulle opzioni del turno
  it('kickstart TEMPLATE_IMPORT: initiator ed extraMeta (templateName) arrivano a runTurn', async () => {
    const job = enqueueJob(db, {
      agentId: 'a1', kind: 'user-message',
      payload: { text: 'configurati', initiator: 'TEMPLATE_IMPORT', extraMeta: { templateName: 'Gestore della posta in arrivo' } },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.initiator).toBe('TEMPLATE_IMPORT')
    expect(log[0]!.opts.extraMeta).toEqual({ templateName: 'Gestore della posta in arrivo' })
    expect(log[0]!.opts.agentMessage).toBeUndefined()
  })

  it('messaggio di un altro bot (initiator AGENT): fromAgentId/fromAgentName/hop diventano opts.agentMessage', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'user-message',
      payload: { text: '<messaggio_da_agente nome="X">ciao</messaggio_da_agente>', initiator: 'AGENT', fromAgentId: 'a1', fromAgentName: 'Bot', toAgentId: 'a2', hop: 2 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.initiator).toBe('AGENT')
    expect(log[0]!.opts.agentMessage).toEqual({ fromAgentId: 'a1', fromAgentName: 'Bot', hop: 2 })
  })

  // correzione A3: l'automaticità della catena viaggia nel payload e sopravvive alla ripresa
  it('payload automatic (catena partita da un turno automatico) → opts.automatic, anche in ripresa', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'user-message',
      payload: {
        text: '<messaggio_da_agente nome="Bot">ciao</messaggio_da_agente>', initiator: 'AGENT',
        fromAgentId: 'a1', fromAgentName: 'Bot', toAgentId: 'a2', hop: 1, automatic: true, entryId: 9
      },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.automatic).toBe(true)
    expect(log[0]!.opts.resume).toEqual({ entryId: 9 })
    expect(log[0]!.opts.agentMessage).toEqual({ fromAgentId: 'a1', fromAgentName: 'Bot', hop: 1 })
  })

  it('senza payload automatic la catena resta immediata (nessuna opts.automatic)', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'user-message',
      payload: { text: 'ciao', initiator: 'AGENT', fromAgentId: 'a1', fromAgentName: 'Bot', toAgentId: 'a2', hop: 1 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.automatic).toBeUndefined()
  })
})

describe('makeJobRunner: task-run (fase 8, §3bis L7)', () => {
  it('il brief apre il turno con l\'identità del task (id per update_task), taskId e respondedTo passati', async () => {
    db.prepare("INSERT INTO tasks(id, agent_id, title) VALUES(7, 'a3', 'Verifica controlli')").run()
    const job = enqueueJob(db, {
      agentId: 'a3', kind: 'task-run',
      payload: { taskId: 7, brief: 'fai la verifica', respondedTo: 55 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    // il modello del task sa chi è e come chiudersi (contesto separato)
    expect(log[0]!.text).toBe('[task no. 7 "Verifica controlli" — to close it: update_task with id 7]\nfai la verifica')
    expect(log[0]!.opts).toMatchObject({ source: 'user', taskId: 7, respondedTo: 55 })
    // niente origine sulla riga: nessun flag (turno utente ordinario)
    expect(log[0]!.opts.untrusted).toBeUndefined()
    expect(log[0]!.opts.automatic).toBeUndefined()
  })

  it('correzione B1: origine del task (untrusted/automatic) propagata a OGNI turno, continuazioni incluse', async () => {
    // task nato da un turno AGENT (untrusted) e da una routine (automatic)
    db.prepare("INSERT INTO tasks(id, agent_id, title, untrusted, automatic) VALUES(8, 'a3', 'Analisi posta', 1, 1)").run()
    for (const payload of [{ taskId: 8, brief: 'analizza' }, { taskId: 8, brief: 'si, procedi', respondedTo: 12 }]) {
      const job = enqueueJob(db, { agentId: 'a3', kind: 'task-run', payload, runAt: 0, now: 0 })
      const log: Seen[] = []
      await makeJobRunner(db, fakeTurn(log))(job, emit)
      expect(log[0]!.opts).toMatchObject({ taskId: 8, untrusted: true, automatic: true, source: 'user' })
    }
  })

  it('correzione B1: il TASK_DONE eredita origine e automaticità dal payload del job', async () => {
    const job = enqueueJob(db, {
      agentId: 'a3', kind: 'user-message',
      payload: {
        text: '<task_done title="X" id="8" esito="done">ok</task_done>',
        initiator: 'TASK_DONE',
        automatic: true,
        untrusted: true,
        entryId: 4
      },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts).toMatchObject({ initiator: 'TASK_DONE', automatic: true, untrusted: true })
  })

  it('task senza riga (eliminato): il prefisso resta senza titolo', async () => {
    const job = enqueueJob(db, {
      agentId: 'a3', kind: 'task-run',
      payload: { taskId: 99, brief: 'b' },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.text).toBe('[task no. 99 — to close it: update_task with id 99]\nb')
  })
})

describe('makeJobRunner: routine-run', () => {
  it('prompt della routine con source/title, ripresa inclusa', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'routine-run',
      payload: { routineId: 3, title: 'Backup', prompt: 'fai il backup', entryId: 9 },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.text).toBe('[recurring routine: Backup] fai il backup')
    expect(log[0]!.opts.source).toBe('routine')
    expect(log[0]!.opts.title).toBe('Backup')
    // M2 (fase 0.3.1001): il turno di routine porta initiator 'ROUTINE' — in
    // chat è una riga di sistema, mai un fumetto dell'utente
    expect(log[0]!.opts.initiator).toBe('ROUTINE')
    expect(log[0]!.opts.resume).toEqual({ entryId: 9 })
    // fase 17c (C2): l'apertura della routine a schedule ha la sua bolla UI;
    // M2: meta.routineTitle per la riga «⏱ Routine «Backup»»
    expect(log[0]!.opts.extraMeta).toEqual({
      ui: { id: 'open.routine', values: { title: 'Backup', prompt: 'fai il backup' } },
      routineTitle: 'Backup'
    })
  })

  // fase 17c correzioni (D1): l'apertura con evento ha la bolla UI open.triggerEvent
  it('apertura con evento (payload nuovo): meta.ui open.triggerEvent con kind e item; externalEvent', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'routine-run',
      payload: {
        routineId: 5, title: 'Posta', prompt: 'controlla la posta',
        event: { source: 'connector_poll', kind: 'newEmail', item: 'Fattura', title: 'New email: Fattura', data: { id: 'm1' }, at: 1 }
      },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    // il modello legge il blocco <evento> con il titolo inglese
    expect(log[0]!.text).toContain('[routine "Posta": New email: Fattura]')
    expect(log[0]!.text).toContain('<evento>')
    expect(log[0]!.opts.externalEvent).toBe(true)
    // la bolla UI dice cosa è arrivato: il blocco grezzo NON è la bolla
    expect(log[0]!.opts.extraMeta).toEqual({
      ui: { id: 'open.triggerEvent', values: { title: 'Posta', kind: 'newEmail', item: 'Fattura', withItem: 'yes' } },
      routineTitle: 'Posta'
    })
  })

  it('apertura con evento senza item: withItem no', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'routine-run',
      payload: {
        routineId: 6, title: 'Rientri', prompt: 'riassumi',
        event: { source: 'presence_return', kind: 'presenceReturn', title: 'The user just came back to the computer', at: 2 }
      },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.extraMeta).toEqual({
      ui: { id: 'open.triggerEvent', values: { title: 'Rientri', kind: 'presenceReturn', withItem: 'no' } },
      routineTitle: 'Rientri'
    })
  })

  // job già in coda col payload vecchio (17b): niente meta.ui, content com'è
  it('apertura con evento SENZA kind (payload vecchio): nessun meta.ui, il content grezzo resta la bolla', async () => {
    const job = enqueueJob(db, {
      agentId: 'a2', kind: 'routine-run',
      payload: {
        routineId: 7, title: 'Vecchia', prompt: 'p',
        event: { source: 'webhook', title: 'Webhook ricevuto', data: { a: 1 }, at: 3 }
      },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.text).toContain('[routine "Vecchia": Webhook ricevuto]')
    expect(log[0]!.opts.externalEvent).toBe(true)
    // niente meta.ui (payload vecchio), ma M2 porta comunque initiator e titolo
    expect(log[0]!.opts.initiator).toBe('ROUTINE')
    expect(log[0]!.opts.extraMeta).toEqual({ routineTitle: 'Vecchia' })
  })
})

// ---- fase 12 (punti 3-4): il job subagent-run apre il turno del FIGLIO ----

describe('makeJobRunner: subagent-run', () => {
  beforeEach(() => {
    db.exec('CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT "", provider_id TEXT, model TEXT, status TEXT DEFAULT "offline", unread INTEGER DEFAULT 0, created_at INTEGER, parent_id TEXT)')
    // il DDL VERO dello store (correzione J2: la colonna del sigillo compresa)
    db.exec(SUBAGENTS_DDL)
    db.prepare('INSERT INTO agents(id, name) VALUES(?, ?)').run('agent_p', 'Padre')
    db.prepare(`INSERT INTO subagents(id, parent_id, batch_id, title, brief, status, created_at, deadline_at)
      VALUES('sub_k1', 'agent_p', 'b1', 'Ricerca', 'il brief', 'queued', 1, 999)`).run()
  })

  it('primo job: apre col BRIEF (blocco <brief>), segna running/started_at e passa subagent/untrusted/automatic', async () => {
    const job = enqueueJob(db, { agentId: 'sub_k1', kind: 'subagent-run', payload: { subagentId: 'sub_k1', first: true }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.agentId).toBe('sub_k1')
    expect(log[0]!.text).toContain('<brief titolo="Ricerca">')
    expect(log[0]!.text).toContain('il brief')
    expect(log[0]!.text).toContain('wake_parent')
    expect(log[0]!.opts.source).toBe('user')
    expect(log[0]!.opts.subagent).toEqual({ id: 'sub_k1', parentId: 'agent_p' })
    expect(log[0]!.opts.onTurnEntry).toBeTruthy()
    // riga → running con started_at
    const row = db.prepare('SELECT status, started_at FROM subagents WHERE id = ?').get('sub_k1') as { status: string; started_at: number }
    expect(row.status).toBe('running')
    expect(row.started_at).not.toBeNull()
    // R1: l'entry del turno finisce nel payload
    expect(getJobById(db, job.id)!.payload).toMatchObject({ subagentId: 'sub_k1', entryId: 42 })
  })

  it('eredità: untrusted/automatic della riga arrivano al turno del figlio', async () => {
    db.prepare("UPDATE subagents SET status = 'queued', untrusted = 1, automatic = 1 WHERE id = 'sub_k1'").run()
    const job = enqueueJob(db, { agentId: 'sub_k1', kind: 'subagent-run', payload: { subagentId: 'sub_k1', first: true }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.untrusted).toBe(true)
    expect(log[0]!.opts.automatic).toBe(true)
  })

  it('messaggio del padre: blocco <messaggio_dal_padre> col nome del padre', async () => {
    const job = enqueueJob(db, { agentId: 'sub_k1', kind: 'subagent-run', payload: { subagentId: 'sub_k1', message: 'aggiungi i prezzi' }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.text).toContain('<messaggio_dal_padre nome="Padre">')
    expect(log[0]!.text).toContain('aggiungi i prezzi')
  })

  it('figlio già TERMINALE (stop/scadenza prima del job): non parte', async () => {
    db.prepare("UPDATE subagents SET status = 'stopped' WHERE id = 'sub_k1'").run()
    const job = enqueueJob(db, { agentId: 'sub_k1', kind: 'subagent-run', payload: { subagentId: 'sub_k1', first: true }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log).toHaveLength(0)
  })

  it('ripresa R1: payload.entryId → resume, senza riscrivere il brief', async () => {
    const job = enqueueJob(db, { agentId: 'sub_k1', kind: 'subagent-run', payload: { subagentId: 'sub_k1', first: true, entryId: 7 }, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.resume).toEqual({ entryId: 7 })
    expect(log[0]!.text).toContain('<brief')
  })

  it('user-message con contaminated (risveglio SUBAGENTS_DONE): il turno del padre PARTE contaminato', async () => {
    const job = enqueueJob(db, {
      agentId: 'agent_p', kind: 'user-message',
      payload: { text: '<risultati_sottoagenti>…', initiator: 'SUBAGENTS_DONE', contaminated: true },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.contaminated).toBe(true)
    expect(log[0]!.opts.initiator).toBe('SUBAGENTS_DONE')
  })

  it('task-run (risveglio nel task): brief = risultati, bandiere del payload rispettate', async () => {
    db.prepare("INSERT INTO tasks(id, agent_id, title) VALUES(3, 'agent_p', 'Confronto')").run()
    const job = enqueueJob(db, {
      agentId: 'agent_p', kind: 'task-run',
      payload: { taskId: 3, brief: '<risultati_sottoagenti>…', contaminated: true, automatic: true },
      runAt: 0, now: 0
    })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.taskId).toBe(3)
    expect(log[0]!.text).toContain('[task no. 3 "Confronto"')
    expect(log[0]!.opts.contaminated).toBe(true)
    expect(log[0]!.opts.automatic).toBe(true)
  })
})

describe('makeJobRunner: routine-run con modello proprio (fase 18b, H7)', () => {
  const routineJob = (routineId: number) =>
    enqueueJob(db, { agentId: 'a2', kind: 'routine-run', payload: { routineId, title: 'T', prompt: 'p' }, runAt: 0, now: 0 })

  it('la riga con provider_id+model passa la route a runTurn (ALL\'ESECUZIONE, non all\'accodamento)', async () => {
    const r = db.prepare('INSERT INTO routines(agent_id, title, prompt, schedule, created_at, provider_id, model, thinking) VALUES(?,?,?,?,?,?,?,?)')
      .run('a2', 'T', 'p', '', 1, 'prov2', 'm-routine', 'high')
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(routineJob(Number(r.lastInsertRowid)), emit)
    expect(log[0]!.opts.route).toEqual({ providerId: 'prov2', model: 'm-routine', thinking: 'high' })
  })

  it('riga senza modello proprio: NESSUNA route (quella del bot)', async () => {
    const r = db.prepare('INSERT INTO routines(agent_id, title, prompt, schedule, created_at) VALUES(?,?,?,?,?)')
      .run('a2', 'T', 'p', '', 1)
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(routineJob(Number(r.lastInsertRowid)), emit)
    expect(log[0]!.opts.route).toBeUndefined()
  })

  it('il modello si legge alla ESECUZIONE: la riga cambia tra accodamento e giro del job', async () => {
    const r = db.prepare('INSERT INTO routines(agent_id, title, prompt, schedule, created_at) VALUES(?,?,?,?,?)')
      .run('a2', 'T', 'p', '', 1)
    const id = Number(r.lastInsertRowid)
    const job = routineJob(id)
    // DOPO l'accodamento la routine riceve un modello proprio
    db.prepare('UPDATE routines SET provider_id = ?, model = ? WHERE id = ?').run('prov9', 'm-tardi', id)
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log[0]!.opts.route).toEqual({ providerId: 'prov9', model: 'm-tardi' })
  })
})

// fase memoria-engramma (M1): embedPending in fondo alla coda — il job
// memory-embed NON apre un turno (niente runTurn) e non cade nel ramo delle
// routine: incorpora le note pendenti, solo se il modello c'è
describe('makeJobRunner: memory-embed', () => {
  it('non chiama runTurn e non apre una riga di routine', async () => {
    const job = enqueueJob(db, { agentId: 'a1', kind: 'memory-embed', payload: {}, runAt: 0, now: 0 })
    const log: Seen[] = []
    await makeJobRunner(db, fakeTurn(log))(job, emit)
    expect(log).toEqual([])
    const runs = db.prepare('SELECT COUNT(*) AS n FROM routine_runs').get() as { n: number }
    expect(runs.n).toBe(0)
  })
})

// fase memoria-engramma (M5): l'indicizzazione della storia è un job della
// coda (asincrona, dopo il turno) e l'indicizzazione iniziale delle
// conversazioni esistenti dice il suo avanzamento all'interfaccia
describe('makeJobRunner: memory-index-story e memory-story-backfill', () => {
  it('memory-index-story indicizza il messaggio nella cella storia, senza aprire turni', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'sandbot-runjob-story-'))
    const e = await import('../../main/memory/engine')
    await e.openMemoryEngine({ dataDir: dir })
    try {
      const job = enqueueJob(db, { agentId: 'a1', kind: 'memory-index-story', payload: { entryId: 9, kind: 'user', text: 'la cena è alle otto', createdAt: 1730000000000 }, runAt: 0, now: 0 })
      const log: Seen[] = []
      await makeJobRunner(db, fakeTurn(log))(job, emit)
      expect(log).toEqual([])
      const { searchHistory } = await import('../../main/memory/history-store')
      expect((await searchHistory('cena otto')).length).toBe(1)
    } finally {
      await e.closeMemoryEngine()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('memory-story-backfill emette l\'avanzamento (evento memory, fase story-backfill)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'sandbot-runjob-backfill-'))
    const store = await import('../../main/store/db')
    store.setDataDir(dir)
    const e = await import('../../main/memory/engine')
    await e.openMemoryEngine({ dataDir: dir })
    try {
      const a = store.createAgent('Storico')
      store.appendEntry({ agentId: a.id, kind: 'message', role: 'user', content: 'messaggio vecchio da indicizzare' })
      const events: Array<{ type: string; phase?: string; done?: number; total?: number }> = []
      const job = enqueueJob(db, { agentId: a.id, kind: 'memory-story-backfill', payload: {}, runAt: 0, now: 0 })
      await makeJobRunner(db, fakeTurn([]))(job, (ev) => { events.push(ev as never) })
      const progress = events.filter((ev) => ev.type === 'memory' && ev.phase === 'story-backfill')
      expect(progress.at(-1)).toMatchObject({ done: 1, total: 1 })
      expect(store.getSetting<number | null>('memory.storyBackfilledAt', null)).not.toBeNull()
    } finally {
      await e.closeMemoryEngine()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('makeJobRunner: memory-forget-agent', () => {
  it('purga cella memorie e note di storia del bot eliminato', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'sandbot-runjob-forget-'))
    const e = await import('../../main/memory/engine')
    await e.openMemoryEngine({ dataDir: dir })
    try {
      const { writeMemoryNote } = await import('../../main/memory/memory-store')
      const { indexStoryNote, searchHistory } = await import('../../main/memory/history-store')
      await writeMemoryNote('agent_g1', { content: 'privata del bot eliminato', tier: 'core', source: 's', userTurn: true })
      await indexStoryNote('agent_g1', 5, 'user', 'conversazione da dimenticare', 1730000000000)
      const job = enqueueJob(db, { agentId: 'agent_g1', kind: 'memory-forget-agent', payload: {}, runAt: 0, now: 0 })
      await makeJobRunner(db, fakeTurn([]))(job, emit)
      expect((await searchHistory('dimenticare'))).toEqual([])
      expect(await (await e.botCell('agent_g1')).list({ limit: 100 })).toEqual([])
    } finally {
      await e.closeMemoryEngine()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
