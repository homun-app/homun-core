// PL3 (fase plugin): l'INDICE dell'uso degli strumenti — la tabella
// tool_use (entry_id, tool, agent_id, at) si scrive quando un tool-call
// entra nel transcript e una SOLA query aggregata indicizzata serve la
// tabella «Collegati» (ultimo uso + conteggio della settimana): niente
// scansioni dei transcript a ogni apertura. Come gli altri store: funzioni
// SQL pure che ricevono la connessione, i test su :memory:.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  TOOL_USE_DDL, recordToolUse, toolUseSummaries, backfillToolUse, pluginUseOf, type ToolUseSummary
} from '../tool-use'

function memdb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(TOOL_USE_DDL)
  return db
}

// le voci del transcript come le scrive appendEntry (solo i campi che conta)
function entriesDdl(db: DatabaseSync): void {
  db.exec(`CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  )`)
}

describe('PL3: tool_use — registrazione e aggregazione indicizzata', () => {
  it('recordToolUse scrive (entry_id unico: un doppione non si duplica)', () => {
    const db = memdb()
    recordToolUse(db, { entryId: 10, tool: 'mcp__ufficio__search', agentId: 'a-1', at: 1000 })
    recordToolUse(db, { entryId: 10, tool: 'mcp__ufficio__search', agentId: 'a-1', at: 1000 })
    const rows = toolUseSummaries(db, 0)
    expect(rows).toEqual([{ tool: 'mcp__ufficio__search', last: 1000, week: 1 }])
  })

  it('l\'aggregazione raggruppa per strumento: ultimo uso MAX, settimana = ultimi 7 giorni', () => {
    const db = memdb()
    const now = 1_000_000
    recordToolUse(db, { entryId: 1, tool: 'mcp__ufficio__search', agentId: 'a-1', at: now - 10_000 })
    recordToolUse(db, { entryId: 2, tool: 'mcp__ufficio__search', agentId: 'a-2', at: now - 100 })
    recordToolUse(db, { entryId: 3, tool: 'mcp__ufficio__search', agentId: 'a-1', at: now - 8 * 24 * 3600 * 1000 }) // fuori settimana
    recordToolUse(db, { entryId: 4, tool: 'mcp__altro__send', agentId: 'a-1', at: now - 50 })
    const rows = toolUseSummaries(db, now - 7 * 24 * 3600 * 1000)
    const search = rows.find((r) => r.tool === 'mcp__ufficio__search')!
    expect(search.last).toBe(now - 100)
    expect(search.week).toBe(2) // i due dentro la settimana, quello vecchio no
    expect(rows.find((r) => r.tool === 'mcp__altro__send')!.week).toBe(1)
  })

  it('le skill si registrano come skill:<nome> e si aggregano uguale', () => {
    const db = memdb()
    recordToolUse(db, { entryId: 7, tool: 'skill:fatture', agentId: 'a-1', at: 500 })
    expect(toolUseSummaries(db, 0)).toEqual([{ tool: 'skill:fatture', last: 500, week: 1 }])
  })

  it('il BACKFILL copia i tool-call GIÀ REGISTRATI (una volta sola, idempotente)', () => {
    const db = memdb()
    entriesDdl(db)
    const ins = db.prepare('INSERT INTO entries (agent_id, kind, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    ins.run('a-1', 'tool-call', 'assistant', 'mcp__vecchio__search', 111)
    ins.run('a-2', 'tool-call', 'assistant', 'mcp__vecchio__send', 222)
    ins.run('a-1', 'user', 'user', 'ciao', 333) // non è un tool-call
    backfillToolUse(db)
    backfillToolUse(db) // due volte: INSERT OR IGNORE, niente doppioni
    const rows = toolUseSummaries(db, 0)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.tool === 'mcp__vecchio__search')!.last).toBe(111)
    expect(rows.find((r) => r.tool === 'mcp__vecchio__send')!.week).toBe(1)
  })

  it('PRESTAZIONI (come A1): 100 bot × 2.000 entry → l\'aggregazione sta sotto 50 ms', () => {
    const db = memdb()
    const ins = db.prepare('INSERT INTO tool_use (entry_id, tool, agent_id, at) VALUES (?, ?, ?, ?)')
    const now = 2_000_000_000_000
    let id = 0
    db.exec('BEGIN')
    for (let i = 0; i < 2000; i++) {
      const bot = `bot-${i % 100}`
      const tool = `mcp__srv${i % 40}__tool${i % 17}`
      ins.run(++id, tool, bot, now - (i % 7000) * 60_000)
    }
    db.exec('COMMIT')
    const t0 = performance.now()
    const rows: ToolUseSummary[] = toolUseSummaries(db, now - 7 * 24 * 3600 * 1000)
    const ms = performance.now() - t0
    expect(rows.length).toBeGreaterThan(0)
    // il piano usa l'INDICE sul tool (nessuna scansione dei transcript)
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT tool, MAX(at), SUM(at >= ?) FROM tool_use GROUP BY tool').all(now) as Array<{ detail: string }>
    expect(plan.some((p) => /USING (COVERING )?INDEX idx_tool_use_tool/.test(p.detail))).toBe(true)
    expect(ms).toBeLessThan(50)
  })
})

describe('PL3: pluginUseOf — l\'uso di UN plugin dal suo prefisso', () => {
  it('somma i conteggi e l\'ultimo uso di tutti gli strumenti con quel prefisso', () => {
    const rows: ToolUseSummary[] = [
      { tool: 'mcp__ufficio__search', last: 900, week: 4 },
      { tool: 'mcp__ufficio__send', last: 500, week: 2 },
      { tool: 'mcp__altro__search', last: 999, week: 8 }
    ]
    expect(pluginUseOf(rows, 'mcp__ufficio__')).toEqual({ last: 900, week: 6 })
    expect(pluginUseOf(rows, 'skill:fatture')).toBeNull()
  })
})
