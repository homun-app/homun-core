// Fase memoria-engramma v0.6.19 (E1): la copia delle celle PRIMA che il motore
// nuovo le apra. Il motore nuovo migra le celle (dal v0.4.3: schema 12 → 24,
// senza ritorno) e lo fa quando le APRE: Engine.open non le tocca, è
// engine.cell() a migrare quella cella. Homun non può stare in mezzo. Allora
// openMemoryEngine, prima di Engine.open, guarda lo schema delle celle e se
// c'è una cella più vecchia copia l'intera cartella memory/ in
// memory-backup-schema<N>-<data>/ accanto: i .sqlite con i loro -wal e -shm,
// a motore chiuso. Da lì si torna indietro a mano, con l'app chiusa
// (docs/MEMORIA.md).
//
// LO SCHEMA SI LEGGE SENZA IL MOTORE — aprirla la migrerebbe — con sqlite in
// sola lettura, dalla riga schema_version della tabella meta (è lì che
// Engramma la salva). La sola apertura «readOnly» NON basta: su un database in
// modalità WAL SQLite crea lo stesso -wal e -shm accanto alla cella (visto
// sul v0.4.3 pulito). Due letture, secondo lo stato della cella:
//   · senza WAL, o col WAL a zero byte (dopo un'uscita pulita il file
//     principale è completo): `immutable=1` — SQLite non apre né crea nulla;
//   · col WAL pieno (un crash: ciò che è stato scritto per ultimo sta solo
//     lì, e il file principale può essere una sola intestazione):
//     `readonly_shm=1` — legge anche dal WAL senza scrivere nello -shm. Se
//     lo -shm manca SQLite rifiuta: allora principale e WAL si copiano in una
//     cartella di servizio e si legge la copia (gli originali non si
//     aprono mai in lettura-scrittura).
// Un file senza la tabella meta non è una cella da migrare. Una cella che non
// si lascia leggere è un ERRORE: senza sapere lo schema non si migra.
//
// UNA VOLTA SOLA PER SCHEMA. La copia c'è già se una cartella con quello
// schema contiene, byte per byte, ogni file delle celle ancora da migrare
// (col suo -wal e -shm). La migrazione è pigra: dopo il primo avvio restano
// celle vecchie non toccate, e per quelle la copia vale ancora. Se una è
// cambiata (una migrazione rimasta a metà, poi la versione precedente di
// Homun che scrive) o nella copia manca, la copia è vecchia e se ne fa
// un'altra accanto: quelle fatte non si toccano mai.
//
// SENZA SPAZIO NON MIGRA: servono DUE volte la cartella più un margine fisso
// piccolo (BACKUP_MARGIN_BYTES, 256 MB) — la copia, più quello che la
// migrazione stessa scrive (WAL e tabelle nuove: circa un'altra cartella).
// Tappa 3, correzione decisa dal revisore: prima si chiedeva la cartella più
// i 5 GB delle build della box (DISK_MARGIN_BYTES), e con 3 GB liberi e una
// memoria di pochi MB l'utente restava senza memoria. La memoria risulta non
// disponibile col motivo «space» e il resto di Homun funziona.
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, createReadStream, existsSync, readdirSync, renameSync, rmSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { freeDiskBytesOf } from '../sandbox/disk-space'

/** La cartella del motore dentro la cartella dati (Engine.open la apre su <dataDir>/memory). */
export const MEMORY_DIR = 'memory'
/** Dove stanno le celle (e le istantanee): <memory>/cells/<cella>.sqlite. */
export const CELLS_DIR = 'cells'
/** Le copie si chiamano memory-backup-schema<N>-<data>: questa è la parte fissa. */
export const BACKUP_PREFIX = 'memory-backup-schema'
/** La copia mentre si fa: nascosta (il punto), mai scambiata per una fatta; se la corsa muore, al boot dopo sparisce. */
const PARTIAL_PREFIX = '.memory-backup-in-corso-'

/**
 * Il margine fisso di spazio libero sotto la copia e la migrazione (tappa 3):
 * 256 MB, MB decimale come i GB di disk-space.ts. Sta in una costante sua,
 * non in DISK_MARGIN_BYTES (i 5 GB che restano liberi prima di una build
 * della box): sono due cose.
 */
export const BACKUP_MARGIN_BYTES = 256_000_000

/**
 * Lo spazio libero che serve per aggiornare le celle in sicurezza: DUE volte
 * la dimensione di memory/ più il margine fisso. Una volta per la copia
 * (cell-backup), una per ciò che la migrazione scrive (WAL e tabelle nuove),
 * il margine per tutto il resto.
 */
export function bytesNeededForBackup(folderBytes: number): number {
  return 2 * folderBytes + BACKUP_MARGIN_BYTES
}

/** Basta lo spazio libero per la copia e la migrazione? Libero ignoto → non si parte (mai migrare a ogni costo). */
export function enoughSpaceForBackup(freeBytes: number | null, folderBytes: number): { ok: boolean; neededBytes: number; missingBytes: number } {
  const neededBytes = bytesNeededForBackup(folderBytes)
  if (freeBytes === null || !Number.isFinite(freeBytes)) return { ok: false, neededBytes, missingBytes: neededBytes }
  return freeBytes >= neededBytes ? { ok: true, neededBytes, missingBytes: 0 } : { ok: false, neededBytes, missingBytes: neededBytes - freeBytes }
}

/** Lo schema di una cella: letto (anche null: il file non ha la tabella meta, non è una cella da migrare) o non letto. */
export type CellSchemaRead = { ok: true; schema: number | null } | { ok: false; error: string }

export interface ReadSchemaOpts {
  /** Dove nasce la cartella di servizio del caso «WAL pieno senza -shm» (i test la tengono nella loro base). */
  mkdtemp?: (prefix: string) => string
}

const walOf = (file: string): string => `${file}-wal`
const shmOf = (file: string): string => `${file}-shm`

/** Il file c'è ed è più lungo di zero. */
function nonEmpty(file: string): boolean {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

/**
 * Apre una cella in sola lettura (l'URI dice come) e legge la versione dalla
 * tabella meta. null: la tabella o la riga non c'è — il file non è una cella
 * Engramma (o è appena nato). Lancia se non si apre o se la riga non è un
 * numero di schema: un errore, mai uno schema indovinato.
 */
function schemaFrom(uri: string): number | null {
  const db = new DatabaseSync(uri, { readOnly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) return null
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: unknown } | undefined
    if (row === undefined) return null
    const schema = Number(row.value)
    if (!Number.isInteger(schema) || schema < 0) throw new Error(`meta.schema_version is not a schema number: ${JSON.stringify(row.value)}`)
    return schema
  } finally {
    db.close()
  }
}

/**
 * L'URI di sqlite per un file: il percorso codificato pezzo per pezzo. Nei
 * nomi ci possono essere spazi, accenti, # e ? — e encodeURI lascerebbe # e ?
 * com'erano, dove sqlite li leggerebbe come fine del percorso.
 */
const uriOf = (file: string, query: string): string => `file:${file.split('/').map(encodeURIComponent).join('/')}?${query}`

/**
 * Il caso «WAL pieno senza -shm»: SQLite non apre il WAL senza poterne creare
 * l'indice, e l'originale non si tocca. Principale e WAL si copiano in una
 * cartella di servizio e si legge la copia, che può creare ciò che vuole.
 */
function schemaFromCopy(file: string, opts: ReadSchemaOpts): number | null {
  const mkdtemp = opts.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)))
  const work = mkdtemp('sandbot-engramma-schema-')
  try {
    const copy = join(work, 'cella.sqlite')
    copyFileSync(file, copy)
    copyFileSync(walOf(file), walOf(copy))
    return schemaFrom(uriOf(copy, 'mode=ro'))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Lo schema di una cella, letto da sqlite in sola lettura: mai col motore
 * (aprendola la migrerebbe). Non crea né -wal né -shm, e non cambia un byte
 * dei file della cella. Non lancia: `{ ok: false }` con il perché.
 */
export function readCellSchema(file: string, opts: ReadSchemaOpts = {}): CellSchemaRead {
  try {
    if (!nonEmpty(walOf(file))) return { ok: true, schema: schemaFrom(uriOf(file, 'mode=ro&immutable=1')) }
    if (existsSync(shmOf(file))) return { ok: true, schema: schemaFrom(uriOf(file, 'mode=ro&readonly_shm=1')) }
    return { ok: true, schema: schemaFromCopy(file, opts) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** I file .sqlite della cartella delle celle, in ordine di nome (celle e istantanee: tutte vengono copiate). */
export function cellFilesOf(memoryDir: string): string[] {
  const cells = join(memoryDir, CELLS_DIR)
  if (!existsSync(cells)) return []
  return readdirSync(cells, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.sqlite'))
    .map((d) => join(cells, d.name))
    .sort()
}

/** I file sotto una cartella, percorsi relativi ad essa, in ordine. */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...filesUnder(join(dir, d.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

/** Quanto occupa una cartella, file per file. */
export function dirBytes(dir: string): number {
  return filesUnder(dir).reduce((n, rel) => n + statSync(join(dir, rel)).size, 0)
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  // a stream: le celle della storia diventano grandi, e non si carica nulla in memoria
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Due file uguali, byte per byte (a stream): prima la dimensione, poi l'hash. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    if (statSync(a).size !== statSync(b).size) return false
  } catch {
    return false
  }
  return (await sha256Of(a)) === (await sha256Of(b))
}

/** Il giorno della copia nel nome, AAAA-MM-GG in UTC (come memory-legacy-<data>). */
export const dayOf = (now: Date): string => now.toISOString().slice(0, 10)

/**
 * Il nome della cartella della copia: memory-backup-schema<N>-<giorno>. Se
 * c'è già (una copia vecchia, di celle poi cambiate) si aggiunge -2, -3…:
 * quelle fatte non si sovrascrivono.
 */
export function backupDirName(schema: number, day: string, taken: (name: string) => boolean = () => false): string {
  const base = `${BACKUP_PREFIX}${schema}-${day}`
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    if (!taken(`${base}-${n}`)) return `${base}-${n}`
  }
}

/** Le copie già fatte per quello schema, dalla più nuova (per nome). */
function backupsOf(dataDir: string, schema: number): string[] {
  const prefix = `${BACKUP_PREFIX}${schema}-`
  if (!existsSync(dataDir)) return []
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
    .map((d) => join(dataDir, d.name))
    .sort()
    .reverse()
}

/**
 * La copia vale ancora: ogni file delle celle da migrare — col suo -wal e il
 * suo -shm, se ci sono — sta nella copia, byte per byte. Le celle già migrate
 * non si guardano: è giusto che differiscano dalla copia.
 */
async function backupStillValid(backupDir: string, memoryDir: string, older: readonly string[]): Promise<boolean> {
  for (const file of older) {
    for (const f of [file, walOf(file), shmOf(file)]) {
      if (!existsSync(f)) continue
      if (!(await sameFile(f, join(backupDir, relative(memoryDir, f))))) return false
    }
  }
  return true
}

export type BackupOutcome =
  /** nessuna cella più vecchia del motore: niente da copiare */
  | { kind: 'none' }
  /**
   * E3: una cella PIÙ NUOVA del motore (SCHEMA_TOO_NEW: l'ha aggiornata un
   * Engramma più recente del .node). Non si copia e non si migra nulla: la
   * memoria non si apre e la cella resta com'è.
   */
  | { kind: 'too-new'; file: string; schema: number }
  | { kind: 'done'; dir: string; fromSchema: number; files: number }
  /** la copia per quello schema c'è già e vale ancora */
  | { kind: 'skipped'; dir: string; fromSchema: number }
  /** manca lo spazio: la memoria non si apre, le celle restano com'erano */
  | { kind: 'no-space'; fromSchema: number; neededBytes: number; missingBytes: number; freeBytes: number | null }
  /** la copia non è riuscita o non si è verificata, o una cella non si è lasciata leggere: la memoria non si apre */
  | { kind: 'failed'; error: string }

/** La riga di log del demone quando la copia è fatta: dove sta, da che schema a quale, quanti file — mai contenuti. */
export function backupLogLine(info: { dir: string; fromSchema: number; toSchema: number; files: number }): string {
  return `[sandbotd] memoria: copia delle celle prima dell’aggiornamento del motore (schema ${info.fromSchema} → ${info.toSchema}, ${info.files} file) in ${info.dir}`
}

export interface BackupOpts {
  dataDir: string
  /** Lo schema delle celle che il motore sostiene (buildInfo().schema): più vecchie sono quelle da migrare. */
  engineSchema: number
  now?: Date
  /** La copia stessa (i test la rompono apposta): di default cpSync ricorsivo. */
  copy?: (from: string, to: string) => void
  mkdtemp?: (prefix: string) => string
}

/**
 * La copia delle celle prima che il motore le apra. A motore chiuso (la chiama
 * openMemoryEngine prima di Engine.open). Non lancia mai: l'esito dice cosa
 * è successo, e «too-new», «no-space» e «failed» vogliono dire NON aprire.
 * E3: prima di qualsiasi altra cosa, una cella più nuova del motore lo dice
 * qui («too-new»), anche accanto a celle vecchie: finché c'è, non si migra.
 */
export async function backupCellsBeforeMigration(opts: BackupOpts): Promise<BackupOutcome> {
  const { dataDir, engineSchema } = opts
  const memoryDir = join(dataDir, MEMORY_DIR)
  if (!existsSync(dataDir)) return { kind: 'none' }
  // la mezza copia di una corsa morta non è una copia: via, prima di guardare il resto
  for (const name of readdirSync(dataDir)) {
    if (name.startsWith(PARTIAL_PREFIX)) rmSync(join(dataDir, name), { recursive: true, force: true })
  }
  const files = cellFilesOf(memoryDir)
  if (!files.length) return { kind: 'none' }
  // le celle più vecchie del motore: lo schema lo si legge da soli, mai col motore
  const older: string[] = []
  let fromSchema = 0
  let tooNew: { file: string; schema: number } | null = null
  for (const file of files) {
    const read = readCellSchema(file, opts)
    if (!read.ok) return { kind: 'failed', error: `cannot read the schema of ${relative(dataDir, file)}: ${read.error}` }
    if (read.schema !== null && read.schema > engineSchema) {
      if (!tooNew) tooNew = { file, schema: read.schema }
      continue
    }
    if (read.schema === null || read.schema >= engineSchema) continue
    older.push(file)
    fromSchema = Math.max(fromSchema, read.schema)
  }
  if (tooNew) return { kind: 'too-new', file: tooNew.file, schema: tooNew.schema }
  if (!older.length) return { kind: 'none' }
  // una volta sola: la copia fatta per questo schema vale finché quelle celle restano com'erano
  for (const dir of backupsOf(dataDir, fromSchema)) {
    if (await backupStillValid(dir, memoryDir, older)) return { kind: 'skipped', dir, fromSchema }
  }
  // lo spazio: DUE volte la cartella più il margine fisso (bytesNeededForBackup) — la copia e la migrazione
  const bytes = dirBytes(memoryDir)
  const freeBytes = freeDiskBytesOf(dataDir)
  const space = enoughSpaceForBackup(freeBytes, bytes)
  if (!space.ok) return { kind: 'no-space', fromSchema, neededBytes: space.neededBytes, missingBytes: space.missingBytes, freeBytes }
  // la copia: prima in una cartella nascosta, verificata, e solo allora col suo nome
  const partial = join(dataDir, `${PARTIAL_PREFIX}${process.pid}`)
  try {
    ;(opts.copy ?? ((from: string, to: string) => cpSync(from, to, { recursive: true })))(memoryDir, partial)
    const copied = filesUnder(memoryDir)
    for (const rel of copied) {
      if (!(await sameFile(join(memoryDir, rel), join(partial, rel)))) throw new Error(`${rel} in the copy is not the file of the folder`)
    }
    const dir = join(dataDir, backupDirName(fromSchema, dayOf(opts.now ?? new Date()), (name) => existsSync(join(dataDir, name))))
    renameSync(partial, dir)
    return { kind: 'done', dir, fromSchema, files: copied.length }
  } catch (e) {
    rmSync(partial, { recursive: true, force: true })
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
