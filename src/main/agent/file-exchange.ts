// Scambio di file tra il Mac dell'utente e il box (fase 11, punto 4):
// copy_to_box({mac_path, box_path}) e copy_from_box({box_path, mac_path?}).
// Le copie chiedono SEMPRE la card all'utente (path, dimensione, direzione) —
// mai approvabili dall'auto-review, nemmeno con una regola; lato Mac rifiuto
// FISSO dei percorsi sensibili (~/.ssh, keychain, .aws, gcloud, .gnupg, la
// directory dati di SandBot = dove vivono i token dei connettori); limite di
// 200 MB; sul Mac non si sovrascrive mai in silenzio (nome alternativo
// "file (1).ext"); nel box valgono i soliti confini dei path.
//
// F7: i path del Mac si espandono (`~`, `~/`) e si risolvono col REALPATH
// (fs.realpathSync.native, che su macOS restituisce anche le maiuscole
// canoniche) PRIMA del controllo e prima della card — un symlink verso .ssh
// non passa e la card mostra il path reale. Il confronto dei prefissi
// sensibili è case-insensitive (APFS di default non distingue le maiuscole).
// F6: in docker la dimensione si legge con argv PURI (stat -c %s -- <path>),
// mai con una shell che interpoli il path del modello.
//
// Policy PURA (macPathAllowed, nonConflictingName, resolveMacPath) ed
// esecuzione iniettabile: i test non toccano la home reale.
import { homedir } from 'node:os'
import { join, resolve, extname, dirname, basename } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { sandboxMode, boxRoot, boxDir } from '../sandbox'
import { resolveBoxPath } from '../sandbox/box-paths'
import { dataDir } from '../store/db'

/** Limite di dimensione per file (punto 4). */
export const FILE_EXCHANGE_MAX_BYTES = 200 * 1024 * 1024

/** La cartella di default sul Mac per copy_from_box. */
export const MAC_DEFAULT_DIR = join('Downloads', 'Homun')

/** Percorsi del Mac sempre RIFIUTATi (fisso, punto 4). */
export const SENSITIVE_MAC_DIRS = ['.ssh', 'Library/Keychains', '.aws', '.config/gcloud', '.gnupg']

/** Espansione di `~` e `~/` con la home (PURO, F7): `~` scritto dal modello non deve diventare `<home>/~/…`. */
export function expandTilde(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/**
 * Il path del Mac RISOLTO (PURO con realpath iniettabile, F7): `~` espanso e
 * REALPATH del tratto esistente del filesystem — fs.realpathSync.native segue
 * i symlink e, su macOS, restituisce le maiuscole CANONICHE (`.SSH` diventa
 * `.ssh`). La coda ancora inesistente (il file nuovo di una copia) resta
 * com'è: verrà creato con quel nome.
 */
export function resolveMacPath(rawPath: string, home: string, realpath: (p: string) => string): string {
  const abs = resolve(home, expandTilde(String(rawPath), home))
  let cur = abs
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpath(cur), ...tail)
    } catch {
      // questo tratto non esiste ancora: scendi di un livello
    }
    const parent = dirname(cur)
    if (parent === cur) return abs // nemmeno la radice risolve: il path resta com'era
    tail.unshift(basename(cur))
    cur = parent
  }
}

/**
 * La policy dei path sul Mac (PURA): si rifiutano i percorsi sensibili (SSH,
 * keychain, cloud CLI, gnupg) e la directory dati di SandBot (dove vivono il
 * DB e i token cifrati dei connettori). `path` è il path REALE già risolto da
 * resolveMacPath; il confronto è case-insensitive (APFS di default).
 */
export function macPathAllowed(
  path: string,
  ctx: { home: string; dataDir: string }
): boolean {
  const p = path.toLowerCase()
  const data = ctx.dataDir.toLowerCase()
  if (p === data || p.startsWith(data + '/')) return false
  for (const rel of SENSITIVE_MAC_DIRS) {
    const sens = join(ctx.home, rel).toLowerCase()
    if (p === sens || p.startsWith(sens + '/')) return false
  }
  return true
}

/**
 * Mai sovrascrivere sul Mac in silenzio: se il nome esiste già, il prossimo
 * libero è "file (1).ext", "file (2).ext", … (PURO, esistenza iniettata).
 */
export function nonConflictingName(target: string, exists: (p: string) => boolean): string {
  if (!exists(target)) return target
  const ext = extname(target)
  const base = target.slice(0, target.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
}

// ---- il piano di una copia (prima della card) ----

export interface FileExchangePlan {
  direction: 'to_box' | 'from_box'
  /** path assoloto sul Mac */
  macPath: string
  /** path assoloto nel box (host: reale; docker: dentro /box) */
  boxPath: string
  size: number
}

export type FileExchangePrecheck =
  | { ok: true; plan: FileExchangePlan }
  | { ok: false; error: string }

export interface FileExchangeDeps {
  home?: string
  statSize?(p: string): Promise<number | null>
  /** dimensione nel box in modalità docker (F6): default stat -c %s con argv PURI; iniettabile per i test */
  dockerStatSize?(agentId: string, boxAbsPath: string): Promise<number | null>
}

/** Valida la richiesta e calcola il piano (path, dimensione) per la card. */
export async function prepareFileExchange(
  agentId: string,
  tool: 'copy_to_box' | 'copy_from_box',
  input: Record<string, unknown>,
  deps: FileExchangeDeps = {}
): Promise<FileExchangePrecheck> {
  const home = deps.home ?? homedir()
  // F7: il realpath (symlink e maiuscole canoniche) PRIMA del controllo e
  // della card; anche home e directory dati si risolvono allo stesso modo,
  // così il confronto è tra path reali
  const realHome = resolveMacPath(home, home, realpathSync.native)
  const realDataDir = resolveMacPath(dataDir(), home, realpathSync.native)
  const size = deps.statSize ?? (async (p) => {
    try {
      return (await stat(p)).size
    } catch {
      return null
    }
  })
  if (tool === 'copy_to_box') {
    const boxRaw = String(input.box_path ?? '')
    if (!String(input.mac_path ?? '').trim() || !boxRaw.trim()) {
      return { ok: false, error: 'mac_path (the file on the Mac) and box_path (the destination in the box) are required.' }
    }
    const macPath = resolveMacPath(String(input.mac_path), home, realpathSync.native)
    if (!macPathAllowed(macPath, { home: realHome, dataDir: realDataDir })) {
      return { ok: false, error: `Mac path not allowed: "${macPath}" (no sensitive folders nor Homun's data).` }
    }
    const s = await size(macPath)
    if (s === null) return { ok: false, error: `File not found on the Mac: "${input.mac_path}".` }
    if (s > FILE_EXCHANGE_MAX_BYTES) {
      return { ok: false, error: `File too large (${s} bytes, limit ${FILE_EXCHANGE_MAX_BYTES}): refused.` }
    }
    const root = sandboxMode() === 'docker' ? '/box' : boxRoot()
    const home1 = sandboxMode() === 'docker' ? `/box/home/${agentId}` : boxDir(agentId)
    const resolved = resolveBoxPath(boxRaw, root, home1, sandboxMode() === 'docker' ? (p) => p : realpathSync)
    if (!resolved.ok) return { ok: false, error: resolved.reason! }
    return { ok: true, plan: { direction: 'to_box', macPath, boxPath: resolved.abs!, size: s } }
  }
  // copy_from_box
  const boxRaw = String(input.box_path ?? '')
  if (!boxRaw.trim()) return { ok: false, error: 'box_path is required (the file in the box to bring to the Mac).' }
  const root = sandboxMode() === 'docker' ? '/box' : boxRoot()
  const home1 = sandboxMode() === 'docker' ? `/box/home/${agentId}` : boxDir(agentId)
  const resolved = resolveBoxPath(boxRaw, root, home1, sandboxMode() === 'docker' ? (p) => p : realpathSync)
  if (!resolved.ok) return { ok: false, error: resolved.reason! }
  let boxSize = 0
  try {
    // la dimensione la si legge dal box (host: stat; docker: stat -c %s via
    // ARGV PURI, F6 — il path del modello mai dentro una shell)
    if (sandboxMode() === 'host') {
      boxSize = (await stat(resolved.abs!)).size
    } else {
      const dockerStat = deps.dockerStatSize ?? (async (agent, p) => {
        const { runDockerArgv } = await import('../sandbox')
        const { dockerStatSizeArgv, BOX_CONTAINER } = await import('../sandbox/docker-argv')
        const r = await runDockerArgv(dockerStatSizeArgv(BOX_CONTAINER, p), { timeoutMs: 15_000 })
        const n = Number(r.stdout.trim())
        return r.exitCode === 0 && Number.isFinite(n) ? n : null
      })
      const s = await dockerStat(agentId, resolved.abs!)
      if (s === null) throw new Error('stat fallito')
      boxSize = s
    }
  } catch {
    return { ok: false, error: `File not found in the box: "${boxRaw}".` }
  }
  if (boxSize > FILE_EXCHANGE_MAX_BYTES) {
    return { ok: false, error: `File too large (${boxSize} bytes, limit ${FILE_EXCHANGE_MAX_BYTES}): refused.` }
  }
  const macTarget = input.mac_path !== undefined && String(input.mac_path).trim()
    ? resolveMacPath(String(input.mac_path), home, realpathSync.native)
    : resolveMacPath(join(home, MAC_DEFAULT_DIR, basename(resolved.abs!)), home, realpathSync.native)
  if (!macPathAllowed(macTarget, { home: realHome, dataDir: realDataDir })) {
    return { ok: false, error: `Mac path not allowed: "${macTarget}" (no sensitive folders nor Homun's data).` }
  }
  return { ok: true, plan: { direction: 'from_box', macPath: macTarget, boxPath: resolved.abs!, size: boxSize } }
}

/** Esegue la copia (dopo il click dell'utente). Sul Mac mai sopra una copia esistente. */
export async function runFileExchange(
  agentId: string,
  plan: FileExchangePlan,
  deps: FileExchangeDeps & { existsSync?: (p: string) => boolean } = {}
): Promise<{ output: string; finalMacPath?: string }> {
  const home = deps.home ?? homedir()
  const { copyMacIntoBox, copyBoxOntoMac } = await import('../sandbox')
  if (plan.direction === 'to_box') {
    // nel box si può sovrascrivere (i confini li ha già validati il piano)
    await copyMacIntoBox(agentId, plan.macPath, plan.boxPath)
    return { output: `Copied into the box: ${plan.boxPath} (${plan.size} bytes, from the Mac ${plan.macPath}).` }
  }
  // from_box: sul Mac MAI sopra un file esistente — nome alternativo
  const exists = deps.existsSync ?? existsSync
  const target = nonConflictingName(plan.macPath, exists)
  await copyBoxOntoMac(agentId, plan.boxPath, target)
  const note = target !== plan.macPath ? ` (already existed: written as "${basename(target)}")` : ''
  return { output: `Copied to the Mac: ${target} (${plan.size} bytes, from the box ${plan.boxPath})${note}.`, finalMacPath: target }
}

// ---- iniezione per i test del loop (nessuna home reale) ----

let fake: { prepare?: typeof prepareFileExchange; run?: typeof runFileExchange } | null = null
export function setFileExchangeForTests(f: { prepare?: typeof prepareFileExchange; run?: typeof runFileExchange } | null): void {
  fake = f
}
export function getPrepareFileExchange(): typeof prepareFileExchange {
  return fake?.prepare ?? prepareFileExchange
}
export function getRunFileExchange(): typeof runFileExchange {
  return fake?.run ?? runFileExchange
}
