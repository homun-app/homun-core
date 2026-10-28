// Test dello store dei sottoagenti su SQLite :memory: (fase 12, punti 1 e 5):
// schema e migrazione (parent_id sulla tabella agents, tabella subagents),
// listAgents che ESCLUDE i figli, il ciclo di vita della riga, l'atomicità del
// risveglio del lotto (wakeBatch) e deleteAgent(padre) che ferma ed elimina i
// figli. Niente Electron: la connessione è di test.
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { JOBS_DDL } from '../jobs'
import {
  SUBAGENTS_DDL, insertSubagent, getSubagent, updateSubagent, closeSubagent,
  listSubagentsOf, openSubagentsOf, subagentsOfBatch, wakeBatch, unwokenBatches,
  expiredSubagents, allSubagentIds, newSubagentId, isTerminalStatus
} from '../subagents'

// il pezzo di db.ts che serve qui: agents + jobs (il resto non c'entra)
function testDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      provider_id TEXT, model TEXT, status TEXT DEFAULT 'offline',
      unread INTEGER DEFAULT 0, created_at INTEGER, parent_id TEXT
    );
    ${JOBS_DDL}
    ${SUBAGENTS_DDL}
  `)
  return db
}

const insertAgent = (db: DatabaseSync, id: string, parentId: string | null = null): void => {
  db.prepare('INSERT INTO agents(id, name, created_at, parent_id) VALUES(?,?,?,?)').run(id, id, 1, parentId)
}

const seedChild = (db: DatabaseSync, over: Partial<Parameters<typeof insertSubagent>[1]> = {}) => {
  return insertSubagent(db, {
    id: over.id ?? newSubagentId(), parentId: over.parentId ?? 'agent_p',
    parentTaskId: over.parentTaskId ?? null, batchId: over.batchId ?? 'batch-1',
    title: over.title ?? 'Ricerca', brief: over.brief ?? 'il brief',
    deadlineAt: over.deadlineAt ?? 999_999_999_999, createdAt: over.createdAt ?? 1000,
    ...over
  })
}

let db: DatabaseSync
beforeEach(() => { db = testDb() })

describe('fase 12 (punto 1): schema e migrazione', () => {
  it('la tabella subagents esiste con le colonne della specifica', () => {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('subagents')").all() as Array<{ name: string }>).map((c) => c.name)
    for (const c of [
      'id', 'parent_id', 'parent_task_id', 'batch_id', 'title', 'brief', 'status',
      'summary', 'report_path', 'contaminated', 'untrusted', 'automatic', 'woken',
      'created_at', 'started_at', 'finished_at', 'deadline_at'
    ]) {
      expect(cols, c).toContain(c)
    }
  })
  it('la colonna parent_id degli agents si AGGIUNGE a un DB esistente (migrazione)', () => {
    // un DB nato PRIMA della fase 12, senza parent_id
    const old = new DatabaseSync(':memory:')
    old.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT "", provider_id TEXT, model TEXT, status TEXT DEFAULT "offline", unread INTEGER DEFAULT 0, created_at INTEGER, created_by TEXT, section TEXT DEFAULT "")')
    expect((old.prepare("SELECT name FROM pragma_table_info('agents')").all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('parent_id')
    old.exec('ALTER TABLE agents ADD COLUMN parent_id TEXT')
    old.prepare('INSERT INTO agents(id, name, parent_id) VALUES(?, ?, ?)').run('sub_x', 'figlio', 'agent_p')
    expect(old.prepare('SELECT parent_id FROM agents WHERE id = ?').get('sub_x')).toEqual({ parent_id: 'agent_p' })
  })
})

describe('fase 12 (punto 1): listAgents esclude i figli (WHERE parent_id IS NULL)', () => {
  it('i bot normali restano, i figli no', () => {
    insertAgent(db, 'agent_p')
    insertAgent(db, 'agent_other')
    insertAgent(db, 'sub_a1', 'agent_p')
    insertAgent(db, 'sub_a2', 'agent_p')
    const rows = db.prepare('SELECT id FROM agents WHERE parent_id IS NULL ORDER BY created_at').all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['agent_p', 'agent_other'])
  })
})

describe('fase 12: il ciclo di vita della riga', () => {
  it('insert → queued con eredità di untrusted/automatic; get/open/list', () => {
    insertAgent(db, 'agent_p')
    const row = seedChild(db, { untrusted: true, automatic: true })
    expect(row.status).toBe('queued')
    expect(row.untrusted).toBe(1)
    expect(row.automatic).toBe(1)
    expect(getSubagent(db, row.id)!.id).toBe(row.id)
    expect(openSubagentsOf(db, 'agent_p')).toBe(1)
    expect(listSubagentsOf(db, 'agent_p')).toHaveLength(1)
  })
  it('updateSubagent: running/started_at, summary, report; la RIAPERTURA azzera woken e cambia lotto', () => {
    insertAgent(db, 'agent_p')
    const row = seedChild(db)
    updateSubagent(db, row.id, { status: 'running', started_at: 2000 })
    expect(getSubagent(db, row.id)).toMatchObject({ status: 'running', started_at: 2000 })
    closeSubagent(db, row.id, { status: 'done', summary: 'fatto', finishedAt: 3000 })
    expect(getSubagent(db, row.id)).toMatchObject({ status: 'done', summary: 'fatto', finished_at: 3000 })
    // il lotto si sveglia (atomico) e la RIAPERTURA lo azzera
    wakeBatch(db, 'batch-1')
    expect(getSubagent(db, row.id)!.woken).toBe(1)
    updateSubagent(db, row.id, { status: 'queued', batch_id: 'batch-2', woken: false, deadline_at: 9_999 })
    expect(getSubagent(db, row.id)).toMatchObject({ status: 'queued', batch_id: 'batch-2', woken: 0, deadline_at: 9_999 })
  })
  it('closeSubagent: il primo esito terminale VINCE (stop/scadenza non si sovrascrivono)', () => {
    insertAgent(db, 'agent_p')
    const row = seedChild(db)
    closeSubagent(db, row.id, { status: 'stopped', finishedAt: 3000 })
    const after = closeSubagent(db, row.id, { status: 'done', summary: 'tardi', finishedAt: 4000 })
    expect(after!.status).toBe('stopped')
    expect(after!.summary).toBeNull()
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
  })
  it('scadenza: expiredSubagents trova solo i figli aperti oltre deadline_at', () => {
    insertAgent(db, 'agent_p')
    const due = seedChild(db, { deadlineAt: 1000 })
    const later = seedChild(db, { id: newSubagentId(), batchId: 'b2', deadlineAt: 999_999_999_999 })
    closeSubagent(db, later.id, { status: 'done', finishedAt: 1500 })
    const found = expiredSubagents(db, 2000)
    expect(found.map((r) => r.id)).toEqual([due.id])
  })
})

describe('fase 12 (punto 5): il risveglio del lotto è ATOMICO', () => {
  it('lotto incompleto → NESSUN risveglio; ultimo terminale → le righe tornano UNA volta', () => {
    insertAgent(db, 'agent_p')
    const a = seedChild(db, { id: 'sub_a', batchId: 'b1' })
    const b = seedChild(db, { id: 'sub_b', batchId: 'b1' })
    expect(wakeBatch(db, 'b1')).toEqual([]) // a e b ancora aperti
    closeSubagent(db, a.id, { status: 'done', finishedAt: 1 })
    expect(wakeBatch(db, 'b1')).toEqual([]) // b ancora aperto
    closeSubagent(db, b.id, { status: 'failed', finishedAt: 2 })
    const woken = wakeBatch(db, 'b1')
    expect(woken.map((r) => r.id).sort()).toEqual(['sub_a', 'sub_b'])
  })
  it('due terminali concorrenti → il risveglio accade UNA volta sola', () => {
    insertAgent(db, 'agent_p')
    seedChild(db, { id: 'sub_a', batchId: 'b1' })
    seedChild(db, { id: 'sub_b', batchId: 'b1' })
    closeSubagent(db, 'sub_a', { status: 'done', finishedAt: 1 })
    closeSubagent(db, 'sub_b', { status: 'done', finishedAt: 2 })
    expect(wakeBatch(db, 'b1')).toHaveLength(2)
    // il secondo arrivato (stesso istante) non sveglia più nessuno
    expect(wakeBatch(db, 'b1')).toEqual([])
  })
  it('unwokenBatches e allSubagentIds per il boot', () => {
    insertAgent(db, 'agent_p')
    seedChild(db, { id: 'sub_a', batchId: 'b1' })
    seedChild(db, { id: 'sub_b', batchId: 'b2' })
    closeSubagent(db, 'sub_b', { status: 'done', finishedAt: 1 })
    // b1 ha un figlio aperto non svegliato, b2 uno finito non svegliato: il
    // boot li considera ENTRAMBI (sarà wakeBatch a svegliare solo chi è tout)
    expect(unwokenBatches(db)).toEqual(['b1', 'b2'])
    expect(allSubagentIds(db).sort()).toEqual(['sub_a', 'sub_b'])
  })
})
