// Fase memoria-engramma · correzioni (C2): la storia per bot e l'oblio per
// CELLA. La storia di un bot vive in storia-<id> (come le memorie in bot-<id>);
// un bot eliminato si dimentica con DUE dropCell (memorie e storia, lapidi
// comprese): niente più purge per nota, che si fermava a 1000 e lasciava le
// lapidi. Dopo il drop NESSUN file sotto <dataDir>/memory contiene una radice
// dei testi (la scansione di privacy.test.ts).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-mem-forget-'))
const DATA = join(ROOT, 'data')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const AGENT = 'agent_gone'
// radici distintive: cercate intere e stilate nei file grezzi della cella
const STORY_SECRET = 'sfogliascelto del tredicesimo'
const MEMORY_SECRET = 'melagranaustera di campagna'

beforeAll(async () => {
  const { setDataDir } = await import('../../store/db')
  setDataDir(DATA)
})

describe('fase memoria-engramma · correzioni C2: il bot eliminato si dimentica per cella', () => {
  // LE2: 1500 messaggi + 20 memorie scritti uno a uno e poi la scansione di
  // TUTTI i file della cella: da solo sta sotto il secondo, ma con la
  // macchina carica (load 29-54) supera i 5 s predefiniti di vitest. Le
  // attese dentro sono sull'ESITO, mai su tempi fissi; il tetto esplicito è
  // solo un limite di sicurezza, ampio e dichiarato
  it('1500 messaggi indicizzati e 20 memorie (5 a lapide): il job dell\'oblio droppa le due celle e non resta traccia nei file', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: DATA })).available).toBe(true)
    const { indexStoryNote } = await import('../history-store')
    const { writeMemoryNote } = await import('../memory-store')
    const { botCell } = e

    // 1500 messaggi di storia col tag del bot (metà utente, metà risposte)
    for (let i = 1; i <= 750; i++) {
      await indexStoryNote(AGENT, i, 'user', `messaggio ${i}: ${STORY_SECRET} giro`, 1_700_000_000_000 + i)
      await indexStoryNote(AGENT, 10_000 + i, 'assistant', `risposta ${i}: ${STORY_SECRET} resoconto`, 1_700_000_000_100 + i)
    }
    // 20 memorie, di cui 5 a LAPIDE (eliminate)
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const n = await writeMemoryNote(AGENT, { content: `memoria ${i}: ${MEMORY_SECRET} numero ${i}`, tier: i % 5 === 0 ? 'core' : 'log', source: 'test', userTurn: true })
      ids.push(n.id)
    }
    for (const id of ids.slice(0, 5)) await (await botCell(AGENT)).delete(id)

    const engine = await e.memoryEngine()
    expect(await engine.cells()).toEqual(expect.arrayContaining([`bot-${AGENT}`, `storia-${AGENT}`]))

    // il job dell'oblio, col runner VERO del demone
    const { enqueueForgetAgent } = e
    const { makeJobRunner } = await import('../../../daemon/run-job')
    const { db } = await import('../../store/db')
    const job = enqueueForgetAgent(db(), AGENT)
    await makeJobRunner(db())(job, () => undefined)

    // le due celle non ci sono più; la cella utente resta
    const cells = await engine.cells()
    expect(cells).not.toContain(`bot-${AGENT}`)
    expect(cells).not.toContain(`storia-${AGENT}`)

    // NESSUNA radice dei testi in nessun file sotto <dataDir>/memory
    // (WAL e snapshot compresi): il metodo di privacy.test.ts
    const roots = [...STORY_SECRET.split(/\s+/), ...MEMORY_SECRET.split(/\s+/)].flatMap((w) => {
      const base = w.toLowerCase().replace(/[aeio]$/, '')
      return [w.toLowerCase(), base]
    }).filter((n) => n.length >= 5)
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)])
    const files = walk(join(DATA, 'memory'))
    for (const f of files) {
      const raw = readFileSync(f)
      for (const needle of roots) {
        expect(raw.includes(Buffer.from(needle)), `${basename(f)} contiene «${needle}»`).toBe(false)
      }
    }
    await e.closeMemoryEngine()
  }, 60_000)

  it('il job dell\'oblio di un bot SENZA storia e già dimenticato finisce bene (NOT_FOUND = già dimenticata)', async () => {
    const e = await import('../engine')
    await e.closeMemoryEngine()
    expect((await e.openMemoryEngine({ dataDir: DATA })).available).toBe(true)
    const { enqueueForgetAgent } = e
    const { makeJobRunner } = await import('../../../daemon/run-job')
    const { db } = await import('../../store/db')
    // mai esistito: nessuna eccezione (NOT_FOUND vale «già dimenticata»)
    const job = enqueueForgetAgent(db(), 'mai-esistito')
    await expect(makeJobRunner(db())(job, () => undefined)).resolves.toBeUndefined()
    await e.closeMemoryEngine()
  })
})
