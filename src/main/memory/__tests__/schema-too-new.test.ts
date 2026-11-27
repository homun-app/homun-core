// Fase memoria-engramma v0.6.19 (E3): SCHEMA_TOO_NEW — una cella aggiornata
// da un Engramma più recente del .node di Homun (per esempio la CLI o l'MCP
// di Engramma, pubbliche: apre le celle e le porta a uno schema che questo
// motore non sostiene). In Homun la memoria risulta NON disponibile col
// motivo 'schema-too-new' (il catalogo UI: «Questa memoria è stata
// aggiornata da una versione più recente di Engramma: aggiorna Homun») e la
// cella NON SI TOCCA.
//
// COME. La guardia del motore (e.code SCHEMA_TOO_NEW) scatta solo quando gli
// si CHIEDE la cella (Engine.open e cells() passano), e lì il motore ha già
// aperto il file: accanto alla cella resta un -wal vuoto (visto
// all'esplorazione: la cella .sqlite resta byte per byte uguale, il file
// no). Quindi lo schema lo legge HOMUN, senza il motore, PRIMA: all'avvio
// (openMemoryEngine, col lettore di sola lettura della copia di E1 —
// cell-backup.ts) e di nuovo in memoryCell, la sola porta per chiedere una
// cella al motore (una cella può diventare troppo nuova mentre Homun gira).
//
// Qui il modulo VERO da vendor/engramma, su cartelle temporanee. Lo schema
// si forza dove Engramma lo salva (meta.schema_version) a ENGINE_SCHEMA + 1;
// la cartella è fotografata file per file (nome e SHA256) prima e dopo.
import { afterAll, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-schema-too-new-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const eng = () => import('../engine')

/** Lo schema che il motore di oggi sostiene: una cella a schema + 1 è troppo nuova. */
const ENGINE_SCHEMA: number = (await (await eng()).engrammaModule())!.buildInfo!().schema

/** La fotografia di una cartella: ogni file (anche dentro le sottocartelle) col suo SHA256 — byte per byte, elenco compreso. */
function fotografia(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of readdirSync(dir, { recursive: true }).map(String).sort()) {
    const p = join(dir, rel)
    if (statSync(p).isFile()) out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex')
  }
  return out
}

/**
 * Lo schema di ogni cella forzato a `schema`. Con `crash` la scritta muore
 * senza chiudere il database (SIGKILL): il WAL resta pieno e lo -shm accanto,
 * com'è una cella dopo un crash di chi scriveva.
 */
function forzaSchema(memoryDir: string, schema: number, crash = false): void {
  for (const f of readdirSync(join(memoryDir, 'cells')).filter((n) => n.endsWith('.sqlite'))) {
    const file = join(memoryDir, 'cells', f)
    if (!crash) {
      const w = new DatabaseSync(file)
      w.prepare("UPDATE meta SET value = ? WHERE key='schema_version'").run(String(schema))
      w.close()
      continue
    }
    const r = spawnSync(process.execPath, ['-e',
      `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(process.argv[1]); d.prepare("UPDATE meta SET value = '${schema}' WHERE key='schema_version'").run(); process.kill(process.pid, 'SIGKILL')`,
      file])
    expect(r.signal).toBe('SIGKILL')
  }
}

async function celleDiHomun(dir: string, agentId: string): Promise<void> {
  const { writeMemoryNote } = await import('../memory-store')
  await writeMemoryNote(agentId, { content: 'Nota del bot.', tier: 'log', source: 'homun:chat/x/1', userTurn: true })
  await writeMemoryNote(agentId, { content: 'Nota condivisa.', tier: 'core', scope: 'user', source: 'homun:user', userTurn: true })
}

describe('E3: SCHEMA_TOO_NEW — una cella più nuova del motore', () => {
  const A = 'agent_stn1'
  /** la cartella dati con le celle diventate troppo nuove */
  let dir = ''

  it('all’avvio: la memoria non è disponibile (motivo schema-too-new) e la cartella resta uguale byte per byte — nessun -wal, nessuna copia', async () => {
    const e = await eng()
    const cb = await import('../cell-backup')
    dir = join(ROOT, 'avvio')
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    await celleDiHomun(dir, A)
    await e.closeMemoryEngine()
    forzaSchema(join(dir, 'memory'), ENGINE_SCHEMA + 1)
    const celle = cb.cellFilesOf(join(dir, 'memory'))
    expect(celle.length).toBeGreaterThanOrEqual(2)
    for (const c of celle) expect(cb.readCellSchema(c)).toEqual({ ok: true, schema: ENGINE_SCHEMA + 1 })

    const prima = fotografia(join(dir, 'memory'))
    const st = await e.openMemoryEngine({ dataDir: dir })
    expect(st.available).toBe(false)
    expect(st.reason).toBe('schema-too-new')
    // il testo inglese va a log e modello, e dice di cosa si tratta
    expect(st.error).toMatch(/SCHEMA_TOO_NEW/)
    expect(st.error).toMatch(new RegExp(`schema ${ENGINE_SCHEMA + 1}`))
    expect(await e.memoryEngineStatus()).toMatchObject({ available: false, reason: 'schema-too-new' })
    await expect(e.memoryEngine()).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE', reason: 'schema-too-new' })
    await expect(e.botCell(A)).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE', reason: 'schema-too-new' })

    // la cella non si tocca: stessi file, stessi byte (il motore non l'ha mai aperta)
    expect(fotografia(join(dir, 'memory'))).toEqual(prima)
    // e niente copia di E1: una cella PIÙ NUOVA non si migra
    expect(readdirSync(dir).filter((n) => n.startsWith('memory-backup'))).toEqual([])
    await e.closeMemoryEngine()
    // rimessa a posto (lo schema di oggi), si apre: la guardia non ha rotto nulla
    forzaSchema(join(dir, 'memory'), ENGINE_SCHEMA)
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    expect((await (await e.botCell(A)).list({ limit: 10 })).length).toBe(1)
    await e.closeMemoryEngine()
  })

  it('col WAL pieno (un crash di chi scriveva): stessa risposta, stessi byte — wal e shm compresi', async () => {
    const e = await eng()
    const cb = await import('../cell-backup')
    dir = join(ROOT, 'crash')
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    await celleDiHomun(dir, A)
    await e.closeMemoryEngine()
    forzaSchema(join(dir, 'memory'), ENGINE_SCHEMA + 1, true)
    for (const c of cb.cellFilesOf(join(dir, 'memory'))) expect(cb.readCellSchema(c)).toEqual({ ok: true, schema: ENGINE_SCHEMA + 1 })
    const files = Object.keys(fotografia(join(dir, 'memory')))
    expect(files.some((f) => f.endsWith('-wal') && readFileSync(join(dir, 'memory', f)).length > 0)).toBe(true)
    expect(files.some((f) => f.endsWith('-shm'))).toBe(true)

    const prima = fotografia(join(dir, 'memory'))
    const st = await e.openMemoryEngine({ dataDir: dir })
    expect(st).toMatchObject({ available: false, reason: 'schema-too-new' })
    expect(fotografia(join(dir, 'memory'))).toEqual(prima)
    await e.closeMemoryEngine()
  })

  it('mentre Homun gira (la cella diventa troppo nuova DOPO l’avvio): la prima richiesta la rifiuta senza chiederla al motore, e da lì la memoria risulta non disponibile', async () => {
    const e = await eng()
    // Homun è aperto su una cartella senza celle
    const live = join(ROOT, 'vivo')
    expect((await e.openMemoryEngine({ dataDir: live })).available).toBe(true)
    expect(await e.memoryEngineStatus()).toMatchObject({ available: true })
    // e arriva una cella troppo nuova: una cella vera (la cella d'oro v0.4.3) con lo schema forzato, solo il .sqlite
    const arrivo = join(ROOT, 'arrivo')
    mkdirSync(join(arrivo, 'cells'), { recursive: true })
    copyFileSync(join(import.meta.dirname, 'fixtures', 'engramma-v0.4.3', 'cells', 'utente.sqlite'), join(arrivo, 'cells', `bot-${A}.sqlite`))
    forzaSchema(arrivo, ENGINE_SCHEMA + 1)
    mkdirSync(join(live, 'memory', 'cells'), { recursive: true })
    copyFileSync(join(arrivo, 'cells', `bot-${A}.sqlite`), join(live, 'memory', 'cells', `bot-${A}.sqlite`))
    const prima = fotografia(join(live, 'memory'))

    await expect(e.botCell(A)).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE', reason: 'schema-too-new' })
    expect(await e.memoryEngineStatus()).toMatchObject({ available: false, reason: 'schema-too-new' })
    // la cella non si tocca: nemmeno il -wal vuoto che lascerebbe il motore
    expect(fotografia(join(live, 'memory'))).toEqual(prima)
    // e ogni richiesta successiva dice la stessa cosa
    await expect(e.botCell(A)).rejects.toMatchObject({ reason: 'schema-too-new' })
    // le celle che non sono troppo nuove restano leggibili e scrivibili: il motore non si chiude
    const altra = await e.botCell('agent_altro')
    expect((await altra.put({ body: 'nota di un altro bot', source: 's', confidence: 'stated' })).status).toBe('active')
    await e.closeMemoryEngine()
    // alla riapertura il motivo si ricalcola dal disco
    expect(await e.openMemoryEngine({ dataDir: live })).toMatchObject({ available: false, reason: 'schema-too-new' })
    await e.closeMemoryEngine()
  })

  it('la copia di E1 lo dice prima di fare qualsiasi cosa: una cella troppo nuova → nessuna copia (kind too-new); con una cella vecchia accanto vince la troppo nuova (non migra nulla)', async () => {
    const cb = await import('../cell-backup')
    const memoria = join(ROOT, 'copia', 'memory')
    // la cella d'oro v0.4.3 (schema 12, da migrare) e, accanto, la stessa resa troppo nuova
    mkdirSync(join(memoria, 'cells'), { recursive: true })
    const oro = join(import.meta.dirname, 'fixtures', 'engramma-v0.4.3', 'cells', 'utente.sqlite')
    copyFileSync(oro, join(memoria, 'cells', 'utente.sqlite'))
    copyFileSync(oro, join(memoria, 'cells', 'bot-x.sqlite'))
    forzaSchema(memoria, ENGINE_SCHEMA + 1)
    copyFileSync(oro, join(memoria, 'cells', 'utente.sqlite'))
    const prima = fotografia(memoria)
    const out = await cb.backupCellsBeforeMigration({ dataDir: join(ROOT, 'copia'), engineSchema: ENGINE_SCHEMA, now: new Date('2026-11-27T10:30:00Z') })
    expect(out.kind).toBe('too-new')
    expect(out).toMatchObject({ kind: 'too-new', schema: ENGINE_SCHEMA + 1 })
    expect(out.kind === 'too-new' && out.file).toBe(join(memoria, 'cells', 'bot-x.sqlite'))
    // niente copia, e le celle restano com'erano
    expect(readdirSync(join(ROOT, 'copia'))).toEqual(['memory'])
    expect(fotografia(memoria)).toEqual(prima)
  })

  it('la guida della memoria lo dice all’utente: una memoria più nuova di Homun non si apre e si aggiorna Homun', async () => {
    const { readFileSync } = await import('node:fs')
    const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'MEMORIA.md'), 'utf8')
    expect(doc).toContain('Una memoria più nuova di Homun non si apre')
    expect(doc).toContain('aggiorna Homun')
    expect(doc).toContain('non le tocca')
  })
})
