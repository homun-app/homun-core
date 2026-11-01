// I FILE del computer del bot (fase 19b, T3): la vista dell'UTENTE sul box —
// elenco, anteprima di testi e immagini, download sul Mac e upload dal Mac.
// In Docker la radice è /box (workspace/ comune e le home dei bot); in host è
// boxRoot(). I path delle RPC sono RELATIVI alla radice, con / come
// separatore; il path vuoto è la radice; nessun '..'.
//
// Sicurezza (T6): MAI fuori dalla radice, nemmeno con i symlink — il controllo
// si fa sul PERCORSO REALE (`realpath -e --` come 1000 con argv puri in
// docker; realpath di Node in host); un symlink che esce diventa l'errore
// «path outside the bot's computer». L'upload e il download sono azioni
// dell'UTENTE (niente card di approvazione) e finiscono nel feed Attività.
//
// Letture BINARIE: in docker i byte passano come base64 (dockerBoxReadB64Argv)
// — il binario nel canale stdout di una stringa JS si corromperebbe — così
// l'UTF-8 rigoroso di files:read lavora sui byte VERI. La copia Mac → box
// usa il percorso di T0 (stdin binario, utente 1000, rename atomico, tetto
// di 100 MB per file).
import { existsSync, realpathSync } from 'node:fs'
import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { getAgent } from '../store/db'
import { boxOwnerOf, boxRoot, sandboxMode, runDockerArgv, copyBoxOntoMac, COPY_INTO_BOX_MAX_BYTES } from '../sandbox'
import {
  BOX_CONTAINER, BOX_MOUNT, boxHomePath,
  dockerRealpathArgv, dockerFindListArgv, dockerBoxReadB64Argv, dockerTestPathArgv,
  dockerStatSizeArgv, dockerWriteFileArgv
} from '../sandbox/docker-argv'
import { recordComputerAction } from './computer-activity'
import { uiError } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { FileEntry, FilesListResult, FilesReadResult, FilesImportResult } from '../../shared/types'

/** Al massimo 2000 voci in un elenco; oltre, truncated: true. */
export const FILES_LIST_MAX_ENTRIES = 2_000

/** Anteprima testo: fino a 2 MB, decodifica UTF-8 rigorosa. */
export const FILES_TEXT_MAX_BYTES = 2 * 1024 * 1024

/** Anteprima immagini: fino a 10 MB. */
export const FILES_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** Le estensioni (minuscole) che si aprono come immagine. */
export const FILES_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'
}

/** L'errore dei confini (T6): un path che esce dalla radice (inglese, nel catalogo EN). */
export const FILES_OUTSIDE_ERROR = "path outside the bot's computer"

// ---- i path RELATIVI dell'utente (PURO) ----

/**
 * Il path relativo della vista File (PURO): '' = radice, '/' separatore,
 * NESSUN '..' e nessun path assoluto (la radice è /box o boxRoot(), un path
 * che parte da / è SEMPRE un tentativo di uscirne). I segmenti vuoti e «.»
 * si normalizzano via.
 */
export function parseFilesRelPath(raw: unknown): { ok: true; rel: string } | { ok: false; error: string } {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return { ok: true, rel: '' }
  if (s.startsWith('/')) return { ok: false, error: FILES_OUTSIDE_ERROR }
  const parts: string[] = []
  for (const p of s.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..' || p.includes('\0')) return { ok: false, error: FILES_OUTSIDE_ERROR }
    parts.push(p)
  }
  return { ok: true, rel: parts.join('/') }
}

/** Il path ASSOLUTO nel box (docker: /box/…; host: <boxRoot>/…). */
function absOf(rel: string): string {
  return rel === '' ? boxAbsRoot() : `${boxAbsRoot()}/${rel}`
}

function boxAbsRoot(): string {
  return sandboxMode() === 'docker' ? BOX_MOUNT : boxRoot()
}

// ---- il PERCORSO REALE: il confine sui symlink (T6) ----

/** true se il path reale sta DENTRO la radice (il confronto è sul realpath). */
function insideRoot(real: string, rootReal: string): boolean {
  return real === rootReal || real.startsWith(rootReal + '/')
}

/**
 * Il realpath di un path del box, nei due modi. Errore «not found» se il path
 * non esiste, FILES_OUTSIDE_ERROR se il percorso reale esce dalla radice (un
 * symlink verso /etc o /browser finisce qui).
 */
async function realPathInside(rel: string): Promise<string> {
  const abs = absOf(rel)
  if (sandboxMode() === 'docker') {
    const r = await runDockerArgv(dockerRealpathArgv(BOX_CONTAINER, abs), { timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw uiError(UI.rpcFilesNotFound)
    const real = r.stdout.trim()
    if (!insideRoot(real, BOX_MOUNT)) throw uiError(UI.rpcFilesOutside)
    return real
  }
  let real: string
  try {
    real = await realpathSync(abs)
  } catch {
    throw uiError(UI.rpcFilesNotFound)
  }
  if (!insideRoot(real, await realpathSync(boxRoot()))) throw uiError(UI.rpcFilesOutside)
  return real
}

/** Il bot deve esistere (T3.1, per tutte le RPC). */
function requireAgent(agentId: string): void {
  if (!getAgent(agentId)) throw uiError(UI.rpcAgentNotFound)
}

// ---- il parse della listing di find (PURO, T7) ----

/**
 * Il parse dell'output di `find -printf '%y\t%s\t%T@\t%f\n'` (PURO): tipo,
 * dimensione, mtime (epoch, anche frazionario) e nome — che può contenere
 * TAB (si ricongiungono) ma NON a capo: una riga rotta da un nome con \n non
 * ha campi numerici validi e si SCARTA, come le righe malformate.
 */
export function parseFindListing(stdout: string): { entries: FileEntry[]; truncated: boolean } {
  const out: FileEntry[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    if (parts.length < 4) continue // riga malformata: scartata
    const [y, sizeRaw, mtimeRaw] = parts
    const name = parts.slice(3).join('\t') // il nome può contenere TAB
    if (!/^[dbcflps]$/.test(y)) continue
    if (!/^\d+$/.test(sizeRaw) || !/^\d+(\.\d+)?$/.test(mtimeRaw)) continue
    if (name === '') continue
    out.push({
      name,
      kind: y === 'd' ? 'dir' : y === 'l' ? 'link' : 'file',
      size: Number(sizeRaw),
      mtime: Math.floor(Number(mtimeRaw) * 1000)
    })
  }
  return {
    entries: out.slice(0, FILES_LIST_MAX_ENTRIES),
    truncated: out.length > FILES_LIST_MAX_ENTRIES
  }
}

/** L'ordine dell'elenco (PURO): prima le cartelle, poi per nome. */
export function sortFileEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1
    if (b.kind === 'dir' && a.kind !== 'dir') return 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

// ---- files:list (T3.1) ----

/**
 * RPC `files:list [agentId, path]`: l'elenco di una cartella del box (in
 * docker `find -mindepth 1 -maxdepth 1 -printf` COME 1000, argv puri; in
 * host readdir + lstat). I file nascosti ci sono: il filtro lo fa la UI. Col
 * path VUOTO risponde anche `home: 'home/<owner>'`, così la UI apre lì.
 */
export async function listBotFiles(agentId: string, path: unknown): Promise<FilesListResult> {
  requireAgent(agentId)
  const parsed = parseFilesRelPath(path)
  if (!parsed.ok) throw uiError(UI.rpcFilesOutside)
  const rel = parsed.rel
  const real = await realPathInside(rel)
  let listing: { entries: FileEntry[]; truncated: boolean }
  if (sandboxMode() === 'docker') {
    const r = await runDockerArgv(dockerFindListArgv(BOX_CONTAINER, real), { timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw uiError(UI.rpcFilesNotFound)
    // l'output capped (cartelle enormi) si segnala: l'elenco è monco
    const parsedListing = parseFindListing(r.stdout)
    listing = { entries: parsedListing.entries, truncated: parsedListing.truncated || r.trimmed }
  } else {
    const entries: FileEntry[] = []
    for (const e of await readdir(real, { withFileTypes: true })) {
      const st = await stat(join(real, e.name)).catch(() => null)
      entries.push({
        name: e.name,
        kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
        size: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0
      })
    }
    listing = { entries, truncated: false }
  }
  return {
    path: rel,
    entries: sortFileEntries(listing.entries),
    truncated: listing.truncated,
    ...(rel === '' ? { home: `home/${boxOwnerOf(agentId)}` } : {})
  }
}

// ---- files:read (T3.1) ----

/** La dimensione di un file del box (docker: stat -c %s argv puro; host: stat). */
async function fileSize(abs: string): Promise<number | null> {
  if (sandboxMode() === 'docker') {
    const r = await runDockerArgv(dockerStatSizeArgv(BOX_CONTAINER, abs), { timeoutMs: 15_000 })
    const n = Number(r.stdout.trim())
    return r.exitCode === 0 && Number.isFinite(n) ? n : null
  }
  return (await stat(abs).catch(() => null))?.size ?? null
}

/** I byte di un file del box (docker: base64 nel canale testuale, poi Buffer). */
async function readBytes(abs: string): Promise<Buffer | null> {
  if (sandboxMode() === 'docker') {
    const r = await runDockerArgv(dockerBoxReadB64Argv(BOX_CONTAINER, abs), { timeoutMs: 60_000 })
    if (r.exitCode !== 0) return null
    return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64')
  }
  return readFile(abs).catch(() => null)
}

/**
 * RPC `files:read [agentId, path]`: l'anteprima di un file. Testo fino a 2 MB
 * con decodifica UTF-8 RIGOROSA (fatal: true → «binary» se non è testo),
 * immagini png/jpg/jpeg/gif/webp fino a 10 MB (base64), oltre i tetti
 * `{ kind: 'too-large', size }`. La dimensione si legge PRIMA: un file
 * grosso non si legge per niente.
 */
export async function readBotFile(agentId: string, path: unknown): Promise<FilesReadResult> {
  requireAgent(agentId)
  const parsed = parseFilesRelPath(path)
  if (!parsed.ok) throw uiError(UI.rpcFilesOutside)
  const rel = parsed.rel
  const real = await realPathInside(rel)
  const size = await fileSize(real)
  if (size === null) throw uiError(UI.rpcFilesNotFound)
  const ext = extname(real).slice(1).toLowerCase()
  if (FILES_IMAGE_EXTS.has(ext)) {
    if (size > FILES_IMAGE_MAX_BYTES) return { kind: 'too-large', size }
    const bytes = await readBytes(real)
    if (bytes === null) throw uiError(UI.rpcFilesNotFound)
    return { kind: 'image', mime: IMAGE_MIME[ext]!, base64: bytes.toString('base64') }
  }
  if (size > FILES_TEXT_MAX_BYTES) return { kind: 'too-large', size }
  const bytes = await readBytes(real)
  if (bytes === null) throw uiError(UI.rpcFilesNotFound)
  try {
    return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { kind: 'binary', size }
  }
}

// ---- files:export / files:import (T3.1: li chiama SOLO il main, dopo il dialog) ----

/** Un path è un FILE (non una cartella): i download prendono solo file. */
async function isFile(real: string): Promise<boolean> {
  if (sandboxMode() === 'docker') {
    const r = await runDockerArgv(dockerTestPathArgv(BOX_CONTAINER, '-f', real), { timeoutMs: 15_000 })
    return r.exitCode === 0
  }
  return (await stat(real).catch(() => null))?.isFile() ?? false
}

/** Un path esiste già (upload: senza overwrite si chiede «Sostituire?»). */
async function pathExists(abs: string): Promise<boolean> {
  if (sandboxMode() === 'docker') {
    const r = await runDockerArgv(dockerTestPathArgv(BOX_CONTAINER, '-e', abs), { timeoutMs: 15_000 })
    return r.exitCode === 0
  }
  return existsSync(abs)
}

/**
 * RPC `files:export [agentId, path, macPath]` — la chiama il MAIN dopo la
 * finestra «Salva» del Mac, mai il renderer da solo. Copia box → Mac con la
 * copia di oggi (docker cp in uscita: sul Mac il file diventa dell'utente).
 * Solo file, non cartelle. Resta nel feed come «Hai scaricato».
 */
export async function exportBotFile(agentId: string, path: unknown, macPath: unknown): Promise<{ ok: true; bytes: number; name: string }> {
  requireAgent(agentId)
  const parsed = parseFilesRelPath(path)
  if (!parsed.ok) throw uiError(UI.rpcFilesOutside)
  if (typeof macPath !== 'string' || !macPath.trim()) throw new Error('the Mac destination is required')
  const real = await realPathInside(parsed.rel)
  if (!(await isFile(real))) throw uiError(UI.rpcFilesNotAFile)
  const size = (await fileSize(real)) ?? 0
  const name = basename(macPath)
  try {
    await copyBoxOntoMac(agentId, real, macPath)
  } catch (e) {
    recordComputerAction({ agentId, kind: 'download', actor: 'user', target: `${parsed.rel} → ${name}`, bytes: size, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
  recordComputerAction({ agentId, kind: 'download', actor: 'user', target: `${parsed.rel} → ${name}`, bytes: size })
  return { ok: true, bytes: size, name }
}

/**
 * RPC `files:import [agentId, dirPath, macPath, overwrite?]` — la chiama il
 * MAIN dopo la finestra «Apri» o il trascinamento sul pannello. Il nome di
 * destinazione è il basename del file del Mac; se esiste già e overwrite non
 * è true → `{ ok: false, reason: 'exists' }` (la UI chiede «Sostituire?»).
 * Scrittura col percorso di T0: stdin binario, utente 1000, rename atomico,
 * tetto di 100 MB per file. Nessuna card di approvazione: è l'utente che carica.
 */
export async function importMacFile(agentId: string, dirPath: unknown, macPath: unknown, overwrite?: unknown): Promise<FilesImportResult> {
  requireAgent(agentId)
  const dir = parseFilesRelPath(dirPath)
  if (!dir.ok) throw uiError(UI.rpcFilesOutside)
  if (typeof macPath !== 'string' || !macPath.trim()) throw new Error('the Mac file is required')
  const name = basename(macPath)
  if (name === '' || name === '/' || name === '.' || name === '..') throw new Error('invalid file name')
  await realPathInside(dir.rel) // la cartella di destinazione esiste ed è DENTRO
  const destRel = dir.rel === '' ? name : `${dir.rel}/${name}`
  const destAbs = absOf(destRel)
  if ((await pathExists(destAbs)) && overwrite !== true) {
    return { ok: false, reason: 'exists', name }
  }
  const size = (await stat(macPath).catch(() => null))?.size ?? null
  if (size === null) throw new Error(`File not found on the Mac: "${macPath}".`)
  if (size > COPY_INTO_BOX_MAX_BYTES) {
    throw uiError(UI.rpcFilesTooLarge, { size, limit: COPY_INTO_BOX_MAX_BYTES })
  }
  const bytes = await readFile(macPath) // i byte veri (T0): mai una stringa
  try {
    if (sandboxMode() === 'docker') {
      // T0: il file arriva come 1000 con lo script COSTANTE (temporaneo + rename)
      const r = await runDockerArgv(dockerWriteFileArgv(BOX_CONTAINER, destAbs), { timeoutMs: 120_000, input: bytes })
      if (r.exitCode !== 0) throw new Error(r.stderr || `exit ${r.exitCode}`)
    } else {
      // come writeFileInBox: atomico, temporaneo nella STESSA cartella
      const tmp = join(dirname(destAbs), `.${name}.sandbot-tmp-${randomUUID().slice(0, 8)}`)
      await writeFile(tmp, bytes)
      await rename(tmp, destAbs)
    }
  } catch (e) {
    recordComputerAction({ agentId, kind: 'upload', actor: 'user', target: destRel, bytes: size, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
  recordComputerAction({ agentId, kind: 'upload', actor: 'user', target: destRel, bytes: size })
  return { ok: true, name, bytes: size }
}
