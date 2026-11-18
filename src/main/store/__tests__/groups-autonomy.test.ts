// Q1 (fase squadra): la colonna groups.autonomy — migrazione dei DB esistenti
// (tutte 'box'), default 'box' per le squadre NUOVE, lettura e scrittura.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as store from '../db'
import { createGroup, getGroup, updateGroup, groupWithMembers, migrateGroupAutonomy } from '../groups'
import { TEST_TMP_BASE } from '../../../test-tmp'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-groups-autonomy-'))
  store.setDataDir(dir)
  store.db()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Q1: migrazione di groups.autonomy', () => {
  it('un DB VECCHIO (colonna assente, righe esistenti) migra: ogni squadra esistente diventa box', () => {
    // costruisce a mano un DB vecchio SENZA la colonna autonomy, con due gruppi
    mkdirSync(join(dir, 'vecchio'), { recursive: true })
    const old = new DatabaseSync(join(dir, 'vecchio', 'sandbot.db'))
    old.exec(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_by TEXT NOT NULL,
        coordinator_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE group_members (
        group_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, agent_id)
      );
      CREATE TABLE group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        author_kind TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to INTEGER,
        root_id INTEGER,
        depth INTEGER NOT NULL DEFAULT 0,
        automatic INTEGER DEFAULT 0,
        summary INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE group_cursors (
        group_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        last_seen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, agent_id)
      );
      CREATE TABLE group_turns (
        nonce TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        source_message_id INTEGER NOT NULL,
        outcome TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        reason TEXT
      );
    `)
    const a1 = store.createAgent('Capo vecchio', '')
    const a2 = store.createAgent('Membro vecchio', '')
    const ins = old.prepare('INSERT INTO groups(name, description, created_by, coordinator_id, created_at) VALUES(?,?,?,?,?)')
    ins.run('Vecchia 1', '', a1.id, a1.id, 1)
    ins.run('Vecchia 2', '', a2.id, a2.id, 2)

    // la migrazione (idempotente) aggiunge la colonna e le righe esistenti
    // diventano 'box'; al secondo giro non cambia niente
    migrateGroupAutonomy(old)
    migrateGroupAutonomy(old)
    const rows = old.prepare('SELECT name, autonomy FROM groups ORDER BY id').all() as Array<{ name: string; autonomy: string }>
    expect(rows.map((r) => r.autonomy)).toEqual(['box', 'box'])
    old.close()
  })
})

describe('Q1: autonomy di creazione, lettura e scrittura', () => {
  it('createGroup: il default per le squadre NUOVE è box', () => {
    const a = store.createAgent('Fondatore', '')
    const g = createGroup('Nuova', 'd', a.id, [])
    expect(getGroup(g.id)!.autonomy).toBe('box')
  })

  it('updateGroup cambia autonomy nei tre valori', () => {
    const a = store.createAgent('Capo', '')
    const g = createGroup('G', 'd', a.id, [])
    updateGroup(g.id, { autonomy: 'ask' })
    expect(getGroup(g.id)!.autonomy).toBe('ask')
    updateGroup(g.id, { autonomy: 'box_review' })
    expect(getGroup(g.id)!.autonomy).toBe('box_review')
    updateGroup(g.id, { autonomy: 'box' })
    expect(getGroup(g.id)!.autonomy).toBe('box')
  })

  it('updateGroup NORMALIZZA i valori invalidi (mai crash, mai valori fantasma nel DB)', () => {
    const a = store.createAgent('Capo bis', '')
    const g = createGroup('G2', 'd', a.id, [])
    updateGroup(g.id, { autonomy: 'libera' as never })
    expect(getGroup(g.id)!.autonomy).toBe('box')
  })

  it('groupWithMembers riporta l\'autonomia alla UI', () => {
    const a = store.createAgent('Capo tris', '')
    const g = createGroup('G3', 'd', a.id, [])
    updateGroup(g.id, { autonomy: 'box_review' })
    expect(groupWithMembers(getGroup(g.id)!).autonomy).toBe('box_review')
  })
})
