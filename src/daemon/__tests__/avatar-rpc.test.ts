// Test della colonna agents.avatar (fase 16, U2): migrazione di un database
// nato prima della fase, validazione dell'RPC agents:update (famiglia tra le
// 5, colore c1–c7, null = predefinito) ed evento 'agents' dopo il salvataggio.
// Store reale su directory temporanea, come in fase8-rpc.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { setDataDir, db, createAgent, getAgent } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent } from '../../shared/types'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbot-avatar-test-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('fase 16 (U2): migrazione della colonna avatar', () => {
  it('un DB di fase 15 (senza avatar) si apre, la colonna si aggiunge e le righe restano', () => {
    // il database com'era alla fase 15: tabella agents SENZA la colonna avatar
    const old = new DatabaseSync(join(dir, 'sandbot.db'))
    old.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        provider_id TEXT, model TEXT, status TEXT DEFAULT 'offline',
        unread INTEGER DEFAULT 0, created_at INTEGER, created_by TEXT,
        section TEXT DEFAULT '', parent_id TEXT
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    old.prepare('INSERT INTO agents(id, name, created_at) VALUES(?,?,?)').run('agent_vecchio', 'Vecchio', 1)
    old.close()
    // la PRIMA open() del processo trova la tabella vecchia e la migra (ALTER)
    setDataDir(dir)
    const cols = db().prepare("SELECT name FROM pragma_table_info('agents')").all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('avatar')
    // la riga di prima della migrazione ha avatar NULL (= predefinito) e resta leggibile
    expect(getAgent('agent_vecchio')?.name).toBe('Vecchio')
    expect(getAgent('agent_vecchio')?.avatar).toBeNull()
  })
})

describe('fase 16 (U2): agents:update con avatar', () => {
  beforeEach(() => {
    events = []
    db().prepare('DELETE FROM agents').run()
  })

  it('salva un avatar valido e lo ritorna; emette agents', async () => {
    const a = createAgent('Nanna')
    await api['agents:update']([a.id, { avatar: { family: 'h-robo', color: 'c3' } }])
    expect(getAgent(a.id)?.avatar).toEqual({ family: 'h-robo', color: 'c3' })
    expect(events.some((e) => e.type === 'agents')).toBe(true)
  })

  it('null torna al predefinito', async () => {
    const a = createAgent('Pino')
    await api['agents:update']([a.id, { avatar: { family: 'pixel', color: 'c6' } }])
    await api['agents:update']([a.id, { avatar: null }])
    expect(getAgent(a.id)?.avatar).toBeNull()
  })

  it('famiglia fuori dalle 5 → errore, niente salvataggio', async () => {
    const a = createAgent('Gino')
    await expect(
      api['agents:update']([a.id, { avatar: { family: 'orb', color: 'c1' } }])
    ).rejects.toThrow(/avatar non valido: famiglia/)
    expect(getAgent(a.id)?.avatar).toBeNull()
  })

  it('colore fuori c1–c7 → errore, niente salvataggio', async () => {
    const a = createAgent('Dina')
    await expect(
      api['agents:update']([a.id, { avatar: { family: 'jelly', color: 'c9' } }])
    ).rejects.toThrow(/avatar non valido: colore/)
    expect(getAgent(a.id)?.avatar).toBeNull()
  })
})
