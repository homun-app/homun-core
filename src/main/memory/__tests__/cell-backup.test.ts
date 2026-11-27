// Fase memoria-engramma v0.6.19 (E1): la copia delle celle PRIMA della prima
// apertura col motore nuovo — src/main/memory/cell-backup.ts e il suo posto
// in openMemoryEngine (engine.ts).
//
// Il motore nuovo migra le celle dallo schema 12 al 24 (senza ritorno) e lo
// fa PIGRAMENTE: Engine.open non le tocca, migra engine.cell() di quella
// cella. Homun non può stare nel mezzo: allora, prima di Engine.open, guarda
// lo schema delle celle LEGGENDOLE DA SOLO — sqlite in sola lettura, mai il
// motore, che aprendole le migrerebbe — e se c'è una cella più vecchia ne
// copia l'intera cartella in memory-backup-schema<N>-<data>/ accanto a
// memory/. Una volta sola: finché le celle a quello schema restano com'erano
// la copia c'è già e non si rifà; se una cambia, la copia è vecchia e se ne
// fa un'altra. Senza spazio non migra: la memoria risulta non disponibile col
// motivo «space» e il resto di Homun funziona.
//
// Le celle vecchie sono la cella d'oro v0.4.3 (fixtures/engramma-v0.4.3:
// scritta dal .node b27b0b07 della v0.4.3, due note come le scrive
// memory-store.ts): i test girano anche dove il binario vecchio non c'è. I
// casi «dopo un crash» si costruiscono qui: un processo viene ucciso mentre
// scrive, e resta il WAL senza checkpoint.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import { setDiskSpaceProbeForTests } from '../../sandbox/disk-space'
/** Tappa 3 (correzione di E1): lo spazio che serve per copiare e migrare — DUE volte la cartella più 256 MB (cell-backup.ts: BACKUP_MARGIN_BYTES). */
const servePer = (cartella: number): number => 2 * cartella + 256_000_000

const ROOT = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-mem-backup-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** La cella d'oro: la cartella è già nella forma di <dataDir>/memory (cells/…). */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'engramma-v0.4.3')
/** La cella dentro la cartella dati. */
const CELL = join('memory', 'cells', 'utente.sqlite')
/** La stessa cella dentro una copia: la copia È la cartella memory (cells/… direttamente), si rimette a posto con un solo comando. */
const COPIA_CELL = join('cells', 'utente.sqlite')
/** L'hash della cella d'oro: la prova che nessun test l'ha aperta al suo posto. */
const GOLDEN_SHA = 'fd015fa704a7dc440aef577159240be6bba11460a615a06d584392ae4aa1e521'
/** Le due note della cella d'oro, come le rilegge il motore. */
const GOLDEN_BODIES = [
  'Le riunioni del lunedì si preparano il venerdì pomeriggio.',
  'Per i report si usa il template «Riepilogo settimanale».'
]
const VENDOR = join(import.meta.dirname, '..', '..', '..', '..', 'vendor', 'engramma')

const eng = () => import('../engine')
const cb = () => import('../cell-backup')

/** Lo schema che il motore di oggi sostiene (buildInfo): quello a cui migra. */
const ENGINE_SCHEMA: number = (await (await eng()).engrammaModule())!.buildInfo!().schema

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
/** I nomi dei file di una cartella, in ordine. */
const nomi = (dir: string): string[] => readdirSync(dir).sort()
/** I file di una cartella col loro hash: com'erano, byte per byte. */
const impronta = (dir: string): string[] => nomi(dir).map((n) => (statSync(join(dir, n)).isFile() ? `${n} ${sha(join(dir, n))}` : `${n}/`))
/** Una cartella dati con le celle v0.4.3 della cella d'oro. */
const celleVecchie = (nome: string): string => {
  const dir = join(ROOT, nome)
  cpSync(FIXTURE, join(dir, 'memory'), { recursive: true })
  return dir
}
/** La cartella di servizio di readCellSchema (il caso col WAL senza -shm) nasce qui: mai nella temporanea di sistema. */
const scratchQui = (prefisso: string): string => mkdtempSync(join(ROOT, prefisso))

afterEach(async () => {
  setDiskSpaceProbeForTests(null)
  await (await eng()).closeMemoryEngine()
})

/**
 * Una cella con la tabella meta scritta SOLO nel WAL, com'è dopo un crash:
 * il processo che la scrive viene ucciso prima di ogni checkpoint (niente
 * motore: sqlite nudo, la forma della tabella meta di Engramma).
 */
function cellaCrashata(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cella.sqlite')
  const r = spawnSync(process.execPath, [
    '--no-warnings', '-e',
    `const { DatabaseSync } = require('node:sqlite');` +
      `const db = new DatabaseSync(process.argv[1]);` +
      `db.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version','12')");` +
      `process.kill(process.pid, 'SIGKILL')`,
    file
  ], { encoding: 'utf8' })
  expect(r.signal, 'il processo che scrive la cella muore ammazzato: nessun checkpoint').toBe('SIGKILL')
  expect(statSync(file + '-wal').size, 'il WAL resta pieno').toBeGreaterThan(0)
  return file
}

describe('E1: lo schema di una cella si legge senza aprirla col motore', () => {
  it('la cella d’oro è una cella v0.4.3 com’è uscita dal motore vecchio: hash fissato, schema 12, pulita', async () => {
    const file = join(FIXTURE, 'cells', 'utente.sqlite')
    expect(sha(file)).toBe(GOLDEN_SHA)
    expect(nomi(join(FIXTURE, 'cells'))).toEqual(['utente.sqlite'])
    expect((await cb()).readCellSchema(file, { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
  })

  it('Engramma salva la versione in meta.schema_version: 12 per la cella v0.4.3, lo schema del motore per una cella di oggi', async () => {
    const m = await cb()
    const e = await eng()
    const dir = join(ROOT, 'schema-di-oggi')
    expect((await e.openMemoryEngine({ dataDir: dir })).available).toBe(true)
    await (await e.userCell(null)).put({ body: 'nota di oggi', source: 's', confidence: 'stated' })
    await e.closeMemoryEngine()
    expect(m.readCellSchema(join(dir, CELL), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: ENGINE_SCHEMA })
    expect(ENGINE_SCHEMA).toBeGreaterThan(12)
  })

  it('leggere non apre la cella col motore: il file resta identico e non nasce né -wal né -shm', async () => {
    const file = join(celleVecchie('lettura-pulita'), CELL)
    const prima = impronta(join(file, '..'))
    expect((await cb()).readCellSchema(file, { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
    expect(impronta(join(file, '..'))).toEqual(prima)
    expect(nomi(join(file, '..'))).toEqual(['utente.sqlite'])
  })

  it('una cella col contenuto solo nel WAL (crash) si legge dallo stato VERO, anche se il file principale da solo non lo ha, senza che un byte cambi', async () => {
    const file = cellaCrashata(join(ROOT, 'crash-con-shm'))
    const prima = impronta(join(file, '..'))
    expect(prima.map((r) => r.split(' ')[0]).sort()).toEqual(['cella.sqlite', 'cella.sqlite-shm', 'cella.sqlite-wal'])
    // il controllo non è vuoto: il file principale da solo non conosce la tabella, è il WAL che la tiene
    const { DatabaseSync } = await import('node:sqlite')
    const ro = new DatabaseSync(`file:${file}?mode=ro&immutable=1`, { readOnly: true })
    expect(() => ro.prepare("SELECT value FROM meta WHERE key='schema_version'")).toThrow(/no such table/)
    ro.close()
    expect((await cb()).readCellSchema(file, { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
    expect(impronta(join(file, '..'))).toEqual(prima)
  })

  it('col WAL pieno ma senza -shm la lettura passa da una copia di servizio: gli originali restano identici, non nasce lo -shm e la copia sparisce', async () => {
    const crashata = cellaCrashata(join(ROOT, 'crash-senza-shm-fonte'))
    const dir = join(ROOT, 'crash-senza-shm')
    mkdirSync(dir, { recursive: true })
    cpSync(crashata, join(dir, 'cella.sqlite'))
    cpSync(crashata + '-wal', join(dir, 'cella.sqlite-wal'))
    const prima = impronta(dir)
    expect(nomi(dir)).toEqual(['cella.sqlite', 'cella.sqlite-wal'])
    const scratch = join(ROOT, 'scratch-di-servizio')
    mkdirSync(scratch)
    const primaCopie = nomi(scratch)
    expect((await cb()).readCellSchema(join(dir, 'cella.sqlite'), { mkdtemp: (prefisso) => mkdtempSync(join(scratch, prefisso)) })).toEqual({ ok: true, schema: 12 })
    expect(impronta(dir)).toEqual(prima)
    expect(nomi(scratch)).toEqual(primaCopie)
  })

  it('celle lasciate da un crash VERO del motore: lette dallo stato vero, senza che un file nasca o cambi', async () => {
    const root = join(ROOT, 'crash-del-motore')
    const r = spawnSync(process.execPath, [
      '--no-warnings', '-e',
      `const { createRequire } = require('node:module');` +
        `const m = createRequire(process.argv[1])(${JSON.stringify(join(VENDOR, 'index.js'))});` +
        `(async () => {` +
        `const engine = await m.Engine.open({ root: process.argv[2], modelDir: process.argv[2] + '-models', embedder: 'none', actor: 'homun' });` +
        `const c = await engine.cell('bot-x', { actor: 'homun:bot-x' });` +
        `for (let i = 0; i < 3; i++) await c.put({ body: 'nota prima del crash ' + i, source: 'test', confidence: 'stated' });` +
        `process.kill(process.pid, 'SIGKILL')` +
        `})()`,
      join(ROOT, 'crash-del-motore-padro') + '/', root
    ], { encoding: 'utf8' })
    expect(r.signal).toBe('SIGKILL')
    const dir = join(root, 'cells')
    expect(nomi(dir)).toEqual(['bot-x.sqlite', 'bot-x.sqlite-shm', 'bot-x.sqlite-wal'])
    const prima = impronta(dir)
    expect((await cb()).readCellSchema(join(dir, 'bot-x.sqlite'), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: ENGINE_SCHEMA })
    expect(impronta(dir)).toEqual(prima)
  })

  it('un file .sqlite senza la tabella meta non è una cella da migrare (schema null); uno che non si lascia leggere è un ERRORE, mai uno schema inventato', async () => {
    const dir = join(ROOT, 'non-celle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'vuota.sqlite'), '')
    writeFileSync(join(dir, 'rifiuti.sqlite'), 'non è un database')
    const m = await cb()
    expect(m.readCellSchema(join(dir, 'vuota.sqlite'), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: null })
    expect(m.readCellSchema(join(dir, 'rifiuti.sqlite'), { mkdtemp: scratchQui })).toEqual({ ok: false, error: expect.stringMatching(/database/i) })
    expect(nomi(dir)).toEqual(['rifiuti.sqlite', 'vuota.sqlite'])
  })

  it('un percorso con spazi e lettere accentate si legge uguale (la URI di sqlite si codifica)', async () => {
    const dir = join(ROOT, 'cartella con spazi è strana#1')
    cpSync(FIXTURE, join(dir, 'memory'), { recursive: true })
    expect((await cb()).readCellSchema(join(dir, CELL), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
  })
})

describe('E1: la copia delle celle prima della prima apertura col motore nuovo', () => {
  const GIORNO = new Date('2026-11-27T10:30:00Z')
  const COPIA = 'memory-backup-schema12-2026-11-27'

  it('la prima apertura copia PRIMA le celle in memory-backup-schema12-<data> accanto a memory/, poi apre e la cella migra', async () => {
    const e = await eng()
    const m = await cb()
    const dir = celleVecchie('prima-apertura')
    const st = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
    expect(st.available).toBe(true)
    expect(st.backup).toEqual({ dir: join(dir, COPIA), fromSchema: 12, toSchema: ENGINE_SCHEMA, files: 1 })
    // la copia è lo stato di PRIMA della migrazione: la cella d'oro byte per byte (la cella viva migra solo quando si apre: qui è ancora com'era)
    expect(nomi(join(dir, COPIA))).toEqual(['cells'])
    expect(sha(join(dir, COPIA, COPIA_CELL))).toBe(GOLDEN_SHA)
    expect(sha(join(dir, CELL))).toBe(GOLDEN_SHA)
    // il motore è aperto e Homun rilegge le stesse note: aprendola, la cella migra
    const note = await (await e.userCell(null)).list({ limit: 10 })
    expect(note.map((n) => n.body).sort()).toEqual(GOLDEN_BODIES)
    expect(sha(join(dir, CELL))).not.toBe(GOLDEN_SHA)
    expect(m.readCellSchema(join(dir, CELL), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: ENGINE_SCHEMA })
    expect(nomi(dir)).toEqual(['memory', COPIA])
  })

  it('una seconda apertura non rifà il backup', async () => {
    const e = await eng()
    const dir = celleVecchie('seconda-apertura')
    const st1 = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
    expect(st1.backup?.dir).toBe(join(dir, COPIA))
    await e.closeMemoryEngine()
    // la cella resta a schema 12 finché nessuno la apre (migrazione pigra): la copia c'è già
    expect((await cb()).readCellSchema(join(dir, CELL), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
    const prima = impronta(dir)
    const st2 = await e.openMemoryEngine({ dataDir: dir, now: new Date('2026-11-28T09:00:00Z') })
    expect(st2.available).toBe(true)
    expect(st2.backup).toBeUndefined()
    expect(impronta(dir)).toEqual(prima)
  })

  it('la copia non si rifà finché le celle a quello schema restano com’erano; se una cambia (il motore vecchio ha scritto dopo), se ne fa una nuova accanto', async () => {
    const m = await cb()
    const dir = celleVecchie('celle-cambiate')
    const run = () => m.backupCellsBeforeMigration({ dataDir: dir, engineSchema: ENGINE_SCHEMA, now: GIORNO })
    expect(await run()).toMatchObject({ kind: 'done', dir: join(dir, COPIA) })
    expect(await run()).toMatchObject({ kind: 'skipped', dir: join(dir, COPIA) })
    // dopo una migrazione rimasta a metà l'utente è tornato alla versione precedente, che ha scritto nella cella
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, CELL))
    db.exec("INSERT INTO meta(key, value) VALUES('prova', 'scritta dopo la prima copia')")
    db.close()
    const dopo = sha(join(dir, CELL))
    expect(dopo).not.toBe(GOLDEN_SHA)
    expect(await run()).toMatchObject({ kind: 'done', dir: join(dir, COPIA + '-2') })
    // la prima copia resta com'era (non si tocca), la seconda ha la cella cambiata
    expect(sha(join(dir, COPIA, COPIA_CELL))).toBe(GOLDEN_SHA)
    expect(sha(join(dir, COPIA + '-2', COPIA_CELL))).toBe(dopo)
    expect(await run()).toMatchObject({ kind: 'skipped', dir: join(dir, COPIA + '-2') })
  })

  it('celle già allo schema del motore, o nessuna cella: nessuna copia', async () => {
    const e = await eng()
    const m = await cb()
    const dir = join(ROOT, 'nessuna-copia')
    expect(await m.backupCellsBeforeMigration({ dataDir: dir, engineSchema: ENGINE_SCHEMA, now: GIORNO })).toEqual({ kind: 'none' })
    expect((await e.openMemoryEngine({ dataDir: dir, now: GIORNO })).backup).toBeUndefined()
    await (await e.userCell(null)).put({ body: 'nota di oggi', source: 's', confidence: 'stated' })
    await e.closeMemoryEngine()
    expect(await m.backupCellsBeforeMigration({ dataDir: dir, engineSchema: ENGINE_SCHEMA, now: GIORNO })).toEqual({ kind: 'none' })
    expect((await e.openMemoryEngine({ dataDir: dir, now: GIORNO })).backup).toBeUndefined()
    expect(nomi(dir)).toEqual(['memory'])
  })

  it('il log del demone dice dov’è la copia (percorsi e numeri, mai contenuti) — e il demone lo scrive all’avvio', async () => {
    const m = await cb()
    expect(m.backupLogLine({ dir: '/dati/memory-backup-schema12-2026-11-27', fromSchema: 12, toSchema: ENGINE_SCHEMA, files: 3 })).toBe(
      `[sandbotd] memoria: copia delle celle prima dell’aggiornamento del motore (schema 12 → ${ENGINE_SCHEMA}, 3 file) in /dati/memory-backup-schema12-2026-11-27`
    )
    const runtime = readFileSync(join(import.meta.dirname, '..', '..', '..', 'daemon', 'runtime.ts'), 'utf8')
    expect(runtime).toContain('console.log(backupLogLine(st.backup))')
  })

  it('la mezza copia di una corsa morta non vale come copia fatta: al boot dopo sparisce e la copia si fa per bene', async () => {
    const m = await cb()
    const dir = celleVecchie('mezza-copia')
    const mezza = join(dir, '.memory-backup-in-corso-999999')
    mkdirSync(join(mezza, 'cells'), { recursive: true })
    writeFileSync(join(mezza, 'cells', 'utente.sqlite'), 'rottame')
    expect(await m.backupCellsBeforeMigration({ dataDir: dir, engineSchema: ENGINE_SCHEMA, now: GIORNO })).toMatchObject({ kind: 'done', dir: join(dir, COPIA) })
    expect(nomi(dir)).toEqual(['memory', COPIA])
    expect(sha(join(dir, COPIA, COPIA_CELL))).toBe(GOLDEN_SHA)
  })

  it('senza spazio per la copia (il doppio della cartella più il margine fisso) il motore NON si apre: motivo space, celle intatte, nessuna copia; il resto di Homun risponde', async () => {
    const e = await eng()
    const m = await cb()
    const dir = celleVecchie('senza-spazio')
    const cella = join(dir, CELL)
    const prima = impronta(dir)
    const manca = 1 // un byte sotto: il doppio della cartella più il margine, meno uno
    setDiskSpaceProbeForTests(() => servePer(statSync(cella).size) - manca)
    const st = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
    expect(st.available).toBe(false)
    expect(st.reason).toBe('space')
    expect(st.neededBytes).toBe(manca)
    expect(st.error).toMatch(/disk space/i)
    // niente è successo: la cella è com'era (schema 12), non c'è copia né mezza copia
    expect(impronta(dir)).toEqual(prima)
    expect(m.readCellSchema(cella, { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
    // il resto di Homun funziona: lo stato dice il motivo (e quanto serve), le chiamate rispondono con l'errore chiaro
    expect(await e.memoryEngineStatus()).toMatchObject({ available: false, reason: 'space', neededBytes: manca })
    await expect(e.memoryEngine()).rejects.toMatchObject({ code: 'MEMORY_UNAVAILABLE', reason: 'space' })
    // l'overview risponde anche lei (il motivo e quanto serve): con la memoria chiusa non legge nessuna impostazione, il resto è quello che c'è
    const rpc = await import('../memory-rpc')
    const comeDaImpostazioni = <T>(_key: string, dflt: T): T => dflt
    expect((await rpc.memoryOverview('bot-x', comeDaImpostazioni)).engine).toMatchObject({ available: false, reason: 'space', neededBytes: manca })
    // tornato lo spazio, al boot dopo la copia si fa e la memoria torna
    setDiskSpaceProbeForTests(() => servePer(statSync(cella).size))
    const st2 = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
    expect(st2.available).toBe(true)
    expect(st2.backup?.dir).toBe(join(dir, COPIA))
  })

  it('tappa 3 (correzione di E1): con 1 GB libero e una memoria di 10 MB la memoria si aggiorna e torna — il margine non è più quello delle build della box (5 GB)', async () => {
    const e = await eng()
    // una memoria di circa 10 MB: la cella d'oro e altre 41 celle come lei (col tempo le celle della storia diventano grandi)
    const dir = celleVecchie('un-gb-libero')
    for (let i = 2; i <= 42; i++) cpSync(join(FIXTURE, 'cells', 'utente.sqlite'), join(dir, 'memory', 'cells', `storia-bot${i}.sqlite`))
    const cartella = (await cb()).dirBytes(join(dir, 'memory'))
    expect(cartella).toBeGreaterThan(9_900_000)
    expect(cartella).toBeLessThan(10_100_000)
    // con il margine di prima (la cartella più 5 GB) 1 GB non bastava: l'utente restava senza memoria
    expect(cartella + 5_000_000_000).toBeGreaterThan(1_000_000_000)
    setDiskSpaceProbeForTests(() => 1_000_000_000)
    const st = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
    expect(st.available).toBe(true)
    expect(st.backup).toMatchObject({ dir: join(dir, COPIA), fromSchema: 12, toSchema: ENGINE_SCHEMA, files: 42 })
    expect(nomi(dir)).toEqual(['memory', COPIA])
    expect((await (await e.userCell(null)).list({ limit: 10 })).map((n) => n.body).sort()).toEqual(GOLDEN_BODIES)
  })

  it('tappa 3: servono il doppio della cartella più 256 MB — un byte sotto non migra (manca 1 byte), uno in più sì', async () => {
    const e = await eng()
    const dir = celleVecchie('confine')
    const cella = join(dir, CELL)
    const serve = servePer(statSync(cella).size)
    expect(statSync(cella).size).toBeLessThan(1_000_000) // una memoria piccola: il margine fisso è quasi tutto ciò che serve
    setDiskSpaceProbeForTests(() => serve - 1)
    expect(await e.openMemoryEngine({ dataDir: dir, now: GIORNO })).toMatchObject({ available: false, reason: 'space', neededBytes: 1 })
    expect(nomi(dir)).toEqual(['memory'])
    setDiskSpaceProbeForTests(() => serve)
    expect((await e.openMemoryEngine({ dataDir: dir, now: GIORNO })).available).toBe(true)
    expect(nomi(dir)).toEqual(['memory', COPIA])
  })

  it('tappa 3: la regola sta in una funzione sola (BACKUP_MARGIN_BYTES è 256 MB, il resto viene dalla cartella)', async () => {
    const m = await cb()
    expect(m.BACKUP_MARGIN_BYTES).toBe(256_000_000)
    expect(m.bytesNeededForBackup(10_000_000)).toBe(276_000_000)
    expect(m.bytesNeededForBackup(0)).toBe(256_000_000)
    // il margine delle build della box non c'entra più con la memoria: 5 GB restano di disk-space.ts
    expect((await import('../../sandbox/disk-space')).DISK_MARGIN_BYTES).toBe(5_000_000_000)
    expect(m.bytesNeededForBackup(10_000_000)).toBeLessThan((await import('../../sandbox/disk-space')).DISK_MARGIN_BYTES)
  })

  it('se la copia non viene verificata la memoria non si apre, e non resta una mezza copia', async () => {
    const e = await eng()
    const dir = celleVecchie('copia-rovinata')
    const prima = impronta(dir)
    // una copia che non ha copiato bene (il verificatore lo deve vedere): qui si inietta una che scrive un file sbagliato
    const r = await (await cb()).backupCellsBeforeMigration({
      dataDir: dir, engineSchema: ENGINE_SCHEMA, now: GIORNO,
      copy: (_da, a) => { mkdirSync(join(a, 'cells'), { recursive: true }); writeFileSync(join(a, 'cells', 'utente.sqlite'), 'rottame') }
    })
    expect(r.kind).toBe('failed')
    expect(impronta(dir)).toEqual(prima)
    const st = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
    expect(st.available).toBe(true) // la copia vera, al boot, prende il posto di quella rovinata
    expect(sha(join(dir, COPIA, COPIA_CELL))).toBe(GOLDEN_SHA)
  })

  it.skipIf(process.getuid?.() === 0)('una cartella dati in sola lettura: la copia non si fa e il motore non si apre (motivo open, il perché nel dettaglio)', async () => {
    const e = await eng()
    const dir = celleVecchie('sola-lettura')
    chmodSync(dir, 0o500)
    try {
      const st = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
      expect(st.available).toBe(false)
      expect(st.reason).toBe('open')
      expect(st.error).toMatch(/cop|copy/i)
      expect(nomi(dir)).toEqual(['memory'])
      expect((await cb()).readCellSchema(join(dir, CELL), { mkdtemp: scratchQui })).toEqual({ ok: true, schema: 12 })
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)('una cella che non si lascia leggere ferma tutto: nessuna copia, nessuna apertura (mai migrare alla cieca)', async () => {
    const e = await eng()
    const dir = celleVecchie('cella-illeggibile')
    const cella = join(dir, CELL)
    chmodSync(cella, 0o000)
    try {
      const st = await e.openMemoryEngine({ dataDir: dir, now: GIORNO })
      expect(st.available).toBe(false)
      expect(st.reason).toBe('open')
      expect(st.error).toMatch(/schema/i)
      expect(nomi(dir)).toEqual(['memory'])
    } finally {
      chmodSync(cella, 0o644)
    }
    expect(sha(cella)).toBe(GOLDEN_SHA)
  })
})
