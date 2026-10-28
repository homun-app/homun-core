// Scambio di file tra il Mac dell'utente e il box (fase 11, punto 4):
// copy_to_box({mac_path, box_path}) e copy_from_box({box_path, mac_path?}).
// Le copie chiedono SEMPRE la card all'utente (path, dimensione, direzione) —
// mai approvabili dall'auto-review, nemmeno con una regola; lato Mac rifiuto
// FISSO dei percorsi sensibili (~/.ssh, keychain, .aws, gcloud, .gnupg, la
// directory dati di SandBot = dove vivono i token dei connettori); limite di
// 200 MB; sul Mac non si sovrascrive mai in silenzio (nome alternativo
// "file (1).ext"); nel box valgono i soliti confini dei path.
//
// Policy PURA (macPathAllowed, nonConflictingName) ed esecuzione iniettabile:
// i test non toccano la home reale.
import { homedir } from 'node:os'
import { join, resolve, extname, dirname, basename } from 'node:path'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { sandboxMode, boxRoot, boxDir } from '../sandbox'
import { resolveBoxPath } from '../sandbox/box-paths'
import { dataDir } from '../store/db'

/** Limite di dimensione per file (punto 4). */
export const FILE_EXCHANGE_MAX_BYTES = 200 * 1024 * 1024

/** La cartella di default sul Mac per copy_from_box. */
export const MAC_DEFAULT_DIR = join('Downloads', 'SandBot')

/** Percorsi del Mac sempre RIFIUTATi (fisso, punto 4). */
export const SENSITIVE_MAC_DIRS = ['.ssh', 'Library/Keychains', '.aws', '.config/gcloud', '.gnupg']

/**
 * La policy dei path sul Mac (PURA): si rifiutano i percorsi sensibili
 * (SSH, keychain, cloud CLI, gnupg) e la directory dati di SandBot (dove
 * vivono il DB e i token cifrati dei connettori). `path` è assoloto o
 * relativo alla home.
 */
export function macPathAllowed(
  path: string,
  ctx: { home: string; dataDir: string }
): boolean {
  const abs = resolve(ctx.home, path)
  if (abs === ctx.dataDir || abs.startsWith(ctx.dataDir + '/')) return false
  for (const rel of SENSITIVE_MAC_DIRS) {
    const sens = join(ctx.home, rel)
    if (abs === sens || abs.startsWith(sens + '/')) return false
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
}

/** Valida la richiesta e calcola il piano (path, dimensione) per la card. */
export async function prepareFileExchange(
  agentId: string,
  tool: 'copy_to_box' | 'copy_from_box',
  input: Record<string, unknown>,
  deps: FileExchangeDeps = {}
): Promise<FileExchangePrecheck> {
  const home = deps.home ?? homedir()
  const size = deps.statSize ?? (async (p) => {
    try {
      return (await stat(p)).size
    } catch {
      return null
    }
  })
  if (tool === 'copy_to_box') {
    const macPath = resolve(home, String(input.mac_path ?? ''))
    const boxRaw = String(input.box_path ?? '')
    if (!String(input.mac_path ?? '').trim() || !boxRaw.trim()) {
      return { ok: false, error: 'Servono mac_path (il file sul Mac) e box_path (la destinazione nel box).' }
    }
    if (!macPathAllowed(macPath, { home, dataDir: dataDir() })) {
      return { ok: false, error: `Percorso del Mac non permesso: "${input.mac_path}" (niente cartelle sensibili né i dati di SandBot).` }
    }
    const s = await size(macPath)
    if (s === null) return { ok: false, error: `File non trovato sul Mac: "${input.mac_path}".` }
    if (s > FILE_EXCHANGE_MAX_BYTES) {
      return { ok: false, error: `File troppo grande (${s} byte, limite ${FILE_EXCHANGE_MAX_BYTES}): rifiutato.` }
    }
    const root = sandboxMode() === 'docker' ? '/box' : boxRoot()
    const home1 = sandboxMode() === 'docker' ? `/box/home/${agentId}` : boxDir(agentId)
    const resolved = resolveBoxPath(boxRaw, root, home1, sandboxMode() === 'docker' ? (p) => p : (await import('node:fs')).realpathSync)
    if (!resolved.ok) return { ok: false, error: resolved.reason! }
    return { ok: true, plan: { direction: 'to_box', macPath, boxPath: resolved.abs!, size: s } }
  }
  // copy_from_box
  const boxRaw = String(input.box_path ?? '')
  if (!boxRaw.trim()) return { ok: false, error: 'Serve box_path (il file nel box da portare sul Mac).' }
  const root = sandboxMode() === 'docker' ? '/box' : boxRoot()
  const home1 = sandboxMode() === 'docker' ? `/box/home/${agentId}` : boxDir(agentId)
  const resolved = resolveBoxPath(boxRaw, root, home1, sandboxMode() === 'docker' ? (p) => p : (await import('node:fs')).realpathSync)
  if (!resolved.ok) return { ok: false, error: resolved.reason! }
  let boxSize = 0
  try {
    // la dimensione la si legge dal box (host: stat; docker: wc -c via exec)
    if (sandboxMode() === 'host') {
      boxSize = (await stat(resolved.abs!)).size
    } else {
      const { execCommand } = await import('../sandbox')
      const r = await execCommand(agentId, `wc -c < "${resolved.abs!.replace(/"/g, '\\"')}"`, { timeoutMs: 15_000 })
      boxSize = Number(r.stdout.trim()) || 0
    }
  } catch {
    return { ok: false, error: `File non trovato nel box: "${boxRaw}".` }
  }
  if (boxSize > FILE_EXCHANGE_MAX_BYTES) {
    return { ok: false, error: `File troppo grande (${boxSize} byte, limite ${FILE_EXCHANGE_MAX_BYTES}): rifiutato.` }
  }
  const macTarget = input.mac_path !== undefined && String(input.mac_path).trim()
    ? resolve(home, String(input.mac_path))
    : join(home, MAC_DEFAULT_DIR, basename(resolved.abs!))
  if (!macPathAllowed(macTarget, { home, dataDir: dataDir() })) {
    return { ok: false, error: `Percorso del Mac non permesso: "${input.mac_path ?? macTarget}" (niente cartelle sensibili né i dati di SandBot).` }
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
    return { output: `Copiato nel box: ${plan.boxPath} (${plan.size} byte, dal Mac ${plan.macPath}).` }
  }
  // from_box: sul Mac MAI sopra un file esistente — nome alternativo
  const exists = deps.existsSync ?? existsSync
  const target = nonConflictingName(plan.macPath, exists)
  await copyBoxOntoMac(agentId, plan.boxPath, target)
  const note = target !== plan.macPath ? ` (esisteva già: scritto come "${basename(target)}")` : ''
  return { output: `Copiato sul Mac: ${target} (${plan.size} byte, dal box ${plan.boxPath})${note}.`, finalMacPath: target }
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
