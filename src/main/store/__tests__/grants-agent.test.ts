// U7 (fase prima-release): le approvazioni salvate valgono per IL BOT —
// niente doppioni, concessione con ambito chiaro e minimo. Migrazione su DB
// VECCHIO (i doppioni veri del database dell'utente, agent_id NULL), indice
// UNICO, addGrant idempotente con ON CONFLICT (le a tempo si ALLUNGANO).
// Il gate (bot A vs bot B, figlio/padre) sta in permissions.test.ts col
// mock di store/db. Mai il DB vero.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-grants-agent-'))
/** fissi per il file: niente drift di Date.now tra costruzione e asserzioni */
const SOON = Date.now() + 60_000

/** Il DB VECCHIO di prima della fase, coi DOPPIONI veri dell'utente (curl ×3, grep ×2, head, una a tempo ×2) — costruito con una connessione GREZZA, PRIMA che il singleton apra e migri. */
function buildOldDb(): void {
  mkdirSync(TMP, { recursive: true })
  const raw = new DatabaseSync(join(TMP, 'sandbot.db'))
  raw.exec(`
    CREATE TABLE grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at INTEGER,
      scope TEXT
    );
  `)
  raw.exec('ALTER TABLE grants ADD COLUMN expires_at INTEGER')
  const ins = raw.prepare('INSERT INTO grants(tool, target, created_at, scope, expires_at) VALUES(?,?,?,?,?)')
  ins.run('run-command', 'curl', 100, null, null)
  ins.run('run-command', 'curl', 200, null, null)
  ins.run('run-command', 'curl', 300, null, null)
  ins.run('run-command', 'grep', 100, null, null)
  ins.run('run-command', 'grep', 150, null, null)
  ins.run('run-command', 'head', 100, null, null)
  ins.run('use-app', 'app:Posta', 100, null, SOON)
  ins.run('use-app', 'app:Posta', 900, null, SOON + 8_000)
  raw.close()
}

describe('U7: migrazione delle grants — agent_id, deduplica, indice UNICO', () => {
  it('su un DB vecchio coi doppioni: UNA riga per chiave, resta la più vecchia, agent_id NULL (valgono per tutti)', async () => {
    buildOldDb()
    const { setDataDir, listGrants } = await import('../db')
    setDataDir(TMP)
    const grants = listGrants() // la prima apertura fa girare la migrazione
    const curls = grants.filter((g) => g.target === 'curl')
    expect(curls).toHaveLength(1)
    expect(curls[0]!.createdAt).toBe(100) // la più vecchia
    expect(curls[0]!.agentId).toBe(null) // le righe di oggi: «tutti i bot»
    expect(grants.filter((g) => g.target === 'grep')).toHaveLength(1)
    expect(grants.filter((g) => g.target === 'head')).toHaveLength(1)
  })

  it('le doppioni A TEMPO: resta la più vecchia con la scadenza più LONTANA', async () => {
    const { listGrants } = await import('../db')
    const posta = listGrants().find((g) => g.target === 'app:Posta')!
    expect(posta.createdAt).toBe(100)
    expect(posta.expiresAt).toBe(SOON + 8_000)
  })

  it("l'indice UNICO c'è: una INSERT grezza duplicata viene rifiutata", async () => {
    const { db, listGrants } = await import('../db')
    const before = listGrants().length
    expect(() => {
      db().prepare("INSERT INTO grants(tool, target, created_at, scope, expires_at, agent_id) VALUES('run-command','curl',999,NULL,NULL,NULL)").run()
    }).toThrow()
    expect(listGrants().length).toBe(before)
  })

  it('addGrant due volte = UNA riga; le a tempo si ALLUNGANO (vince la più lontana); bot diversi hanno le loro', async () => {
    const { addGrant, listGrants } = await import('../db')
    addGrant('run-command', 'sort', undefined, undefined, 'bot-a')
    addGrant('run-command', 'sort', undefined, undefined, 'bot-a')
    expect(listGrants().filter((g) => g.target === 'sort')).toHaveLength(1)

    const base = SOON + 120_000
    addGrant('use-app', 'app:Calendario', undefined, base, 'bot-a')
    addGrant('use-app', 'app:Calendario', undefined, base + 4_000, 'bot-a') // più lontana: si allunga
    expect(listGrants().find((g) => g.target === 'app:Calendario')!.expiresAt).toBe(base + 4_000)
    addGrant('use-app', 'app:Calendario', undefined, base + 8_000, 'bot-a') // ancora più lontana
    expect(listGrants().find((g) => g.target === 'app:Calendario')!.expiresAt).toBe(base + 8_000)
    addGrant('use-app', 'app:Calendario', undefined, base + 2_000, 'bot-a') // più VICINA di così: NON accorcia
    expect(listGrants().find((g) => g.target === 'app:Calendario')!.expiresAt).toBe(base + 8_000)

    addGrant('run-command', 'tail', undefined, undefined, 'bot-a')
    addGrant('run-command', 'tail', undefined, undefined, 'bot-b')
    const tails = listGrants().filter((g) => g.target === 'tail')
    expect(tails).toHaveLength(2)
    expect(new Set(tails.map((r) => r.agentId))).toEqual(new Set(['bot-a', 'bot-b']))
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})
