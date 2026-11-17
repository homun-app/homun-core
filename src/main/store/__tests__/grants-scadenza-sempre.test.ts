// K1 (fase prima-release correzioni): la scadenza NULL delle concessioni è
// «PER SEMPRE» — fondendo due righe uguali il risultato è NULL se UNA delle
// due è NULL, altrimenti la scadenza più LONTANA. Vale per addGrant (upsert
// ON CONFLICT) E per dedupeGrants (la migrazione), in TUTTI E DUE gli ordini
// (prima la permanente poi la a tempo, e viceversa). Mai il DB vero.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TEST_TMP_BASE } from '../../../test-tmp'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-grants-sempre-'))
/** fissi per il file: niente drift di Date.now tra costruzione e asserzioni */
const T_VICINA = Date.now() + 60_000
const T_LONTANA = Date.now() + 600_000

/**
 * Il DB VECCHIO di prima della fase (senza agent_id né indice UNICO, come in
 * grants-agent.test.ts) con le COPPIE di doppioni per dedupeGrants, in tutti
 * e due gli ordini: (a tempo, permanente), (permanente, a tempo),
 * (a tempo più vicina, a tempo più lontana), (lontana, vicina),
 * (permanente, permanente). L'ordine delle righe è quello di created_at.
 */
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
  // a tempo PERIMA, permanente dopo
  ins.run('run-command', 'curl', 100, null, T_VICINA)
  ins.run('run-command', 'curl', 200, null, null)
  // permanente PRIMA, a tempo dopo
  ins.run('run-command', 'wget', 100, null, null)
  ins.run('run-command', 'wget', 200, null, T_VICINA)
  // a tempo + a tempo: la più lontana vince (arrivi prima o dopo)
  ins.run('run-command', 'grep', 100, null, T_LONTANA)
  ins.run('run-command', 'grep', 200, null, T_VICINA)
  // permanente + permanente: UNA riga
  ins.run('run-command', 'head', 100, null, null)
  ins.run('run-command', 'head', 200, null, null)
  raw.close()
}

beforeAll(() => buildOldDb())

describe('K1: dedupeGrants — NULL = per sempre, negli ordini e nelle combinazioni', () => {
  it('la prima apertura migra e deduplica: UNA riga per target', async () => {
    const { setDataDir, listGrants } = await import('../db')
    setDataDir(TMP)
    const grants = listGrants() // la prima apertura fa girare la migrazione
    for (const target of ['curl', 'wget', 'grep', 'head']) {
      expect(grants.filter((g) => g.target === target)).toHaveLength(1)
    }
  })

  it('a tempo (prima) + permanente (dopo) = PERMANENTE: il «Consenti sempre» non diventa a tempo', async () => {
    const { listGrants } = await import('../db')
    expect(listGrants().find((g) => g.target === 'curl')!.expiresAt).toBe(null)
  })

  it('permanente (prima) + a tempo (dopo) = PERMANENTE: il «sempre» dell\'utente vince anche nell\'altro ordine', async () => {
    const { listGrants } = await import('../db')
    expect(listGrants().find((g) => g.target === 'wget')!.expiresAt).toBe(null)
  })

  it('a tempo + a tempo = la più LONTANA (quale che sia l\'ordine di arrivo)', async () => {
    const { listGrants } = await import('../db')
    expect(listGrants().find((g) => g.target === 'grep')!.expiresAt).toBe(T_LONTANA)
  })

  it('permanente + permanente = UNA riga per sempre', async () => {
    const { listGrants } = await import('../db')
    const heads = listGrants().filter((g) => g.target === 'head')
    expect(heads).toHaveLength(1)
    expect(heads[0]!.expiresAt).toBe(null)
  })
})

describe('K1: addGrant — l\'upsert fonde con la stessa regola', () => {
  it('permanente + a tempo = PERMANENTE (il 10 minuti non accorcia il «sempre»)', async () => {
    const { addGrant, listGrants } = await import('../db')
    addGrant('run-command', 'sort', undefined, undefined, 'bot-a') // per sempre
    addGrant('run-command', 'sort', undefined, T_VICINA, 'bot-a') // 10 minuti dopo
    expect(listGrants().find((g) => g.target === 'sort')!.expiresAt).toBe(null)
  })

  it('a tempo + permanente = PERMANENTE (il «Consenti sempre» arrivato dopo vince)', async () => {
    const { addGrant, listGrants } = await import('../db')
    addGrant('run-command', 'tail', undefined, T_VICINA, 'bot-a') // prima i 10 minuti
    addGrant('run-command', 'tail', undefined, undefined, 'bot-a') // poi «sempre»
    expect(listGrants().find((g) => g.target === 'tail')!.expiresAt).toBe(null)
  })

  it('a tempo + a tempo = la più LONTANA; la più vicina non accorcia', async () => {
    const { addGrant, listGrants } = await import('../db')
    addGrant('run-command', 'uniq', undefined, T_VICINA, 'bot-a')
    addGrant('run-command', 'uniq', undefined, T_LONTANA, 'bot-a') // più lontana: si allunga
    expect(listGrants().find((g) => g.target === 'uniq')!.expiresAt).toBe(T_LONTANA)
    addGrant('run-command', 'uniq', undefined, T_VICINA, 'bot-a') // più vicina: NON accorcia
    expect(listGrants().find((g) => g.target === 'uniq')!.expiresAt).toBe(T_LONTANA)
  })

  it('permanente + permanente = UNA riga, sempre NULL', async () => {
    const { addGrant, listGrants } = await import('../db')
    addGrant('run-command', 'sed', undefined, undefined, 'bot-a')
    addGrant('run-command', 'sed', undefined, undefined, 'bot-a')
    const rows = listGrants().filter((g) => g.target === 'sed')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.expiresAt).toBe(null)
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})
