// OB5 (fase onboarding-b) + OBR2 (fase onboarding-b-rafforzamenti): togliere
// lo strumento di Apple — l'unica eccezione alla regola «mai privilegi
// d'amministratore»: la disinstallazione non ha un'interfaccia di Apple,
// quindi si usa osascript … with administrator privileges, ma SOLO per UN
// comando FISSO e VERIFICATO (la stringa è una COSTANTE, mai composta con
// dati), e SOLO se la guardia passa. OBR2: lo script deve essere un FILE
// REGOLARE (lstat NON segue i symlink: un collegamento di root a un file
// scrivibile dall'utente superava la guardia) di root:wheel e senza
// scrittura per gruppo o altri, E le cartelle /usr/local/bin e /usr/local
// devono essere di root e non scrivibili da gruppo o altri (altrimenti lo
// script si può sostituire fra il controllo e l'esecuzione). Il comando
// manuale «sudo … -d» è TESTO da copiare per l'utente, MAI eseguito.

import { lstatSync } from 'node:fs'

/** Lo script di disinstallazione del pacchetto di Apple (tiene i dati con -d). */
export const UNINSTALL_CONTAINER_SCRIPT = '/usr/local/bin/uninstall-container.sh'

/** OBR2: le due cartelle che devono essere di root e non scrivibili. */
export const UNINSTALL_SCRIPT_DIR = '/usr/local/bin'
export const UNINSTALL_SCRIPT_PARENT_DIR = '/usr/local'

/**
 * Il comando UNICO e FISSO: mai interpolato, mai composto con dati — una
 * costante letterale che finisce nel test apple-uninstall.test.ts.
 */
export const UNINSTALL_OSASCRIPT_ARGV = ['-e', 'do shell script "/usr/local/bin/uninstall-container.sh -d" with administrator privileges'] as const

/**
 * OBR2: il comando di Apple che l'utente può copiare nel Terminale quando la
 * guardia rifiuta (testo del messaggio, MAI eseguito da Homun).
 */
export const UNINSTALL_MANUAL_COMMAND = 'sudo /usr/local/bin/uninstall-container.sh -d'

/** I fatti di un percorso che la guardia guarda (tutti iniettabili nei test). */
export interface UninstallScriptStat {
  exists: boolean
  /** file regolare? (così come lstat NON segue i symlink) */
  isFile: boolean
  /** cartella vera? (un symlink a una cartella non lo è) */
  isDirectory: boolean
  /** il proprietario: root è 0 */
  uid: number
  /** il gruppo: wheel è 0 */
  gid: number
  /** i permessi (bit mode di stat) */
  mode: number
}

/** I fatti completi: lo script e le due cartelle che lo contengono. */
export interface UninstallGuardFacts {
  script: UninstallScriptStat | null
  /** /usr/local/bin */
  dir: UninstallScriptStat | null
  /** /usr/local */
  parentDir: UninstallScriptStat | null
}

/**
 * La guardia (PURa): tutte e tre le condizioni della spec, o niente
 * osascript. reason dice perché NO — l'errore in parole lo sceglie la RPC.
 */
export function uninstallScriptGuardOk(facts: UninstallGuardFacts): { ok: boolean; reason: 'missing' | 'not-regular' | 'not-root' | 'writable' | null } {
  // 1. lo script: un FILE REGOLARE (lstat: un symlink non lo è — i permessi
  // di un symlink sono lrwxr-xr-x e superavano la guardia), di root:wheel e
  // senza scrittura per gruppo o altri
  const script = facts.script
  if (!script || !script.exists) return { ok: false, reason: 'missing' }
  if (!script.isFile) return { ok: false, reason: 'not-regular' }
  if (script.uid !== 0 || script.gid !== 0) return { ok: false, reason: 'not-root' }
  // group-write (0o020) o other-write (0o002): chiunque potrebbe riscrivere
  // lo script che girerebbe come root
  if ((script.mode & 0o022) !== 0) return { ok: false, reason: 'writable' }
  // 2. e 3. le cartelle che lo contengono: di root e non scrivibili da
  // gruppo o altri (se no lo script si sostituisce FRA il controllo e
  // l'esecuzione), e cartelle VERE (un symlink a una cartella scrivibile
  // dall'utente passerebbe i permessi del collegamento, non della cartella)
  for (const dir of [facts.dir, facts.parentDir]) {
    if (!dir || !dir.exists) return { ok: false, reason: 'missing' }
    if (!dir.isDirectory) return { ok: false, reason: 'not-regular' }
    if (dir.uid !== 0) return { ok: false, reason: 'not-root' }
    if ((dir.mode & 0o022) !== 0) return { ok: false, reason: 'writable' }
  }
  return { ok: true, reason: null }
}

// ---- lo stat dei percorsi (produzione: lstat; test: sonda sostituibile) ----

let statProbe: ((path: string) => UninstallScriptStat | null) | null = null

/** Solo per i test: sostituisce (o ripristina) la lettura dello stat. */
export function setUninstallStatProbeForTests(p: ((path: string) => UninstallScriptStat | null) | null): void {
  statProbe = p
}

/** Lo stat di un percorso (null = non esiste / non leggibile). */
export function uninstallScriptStat(path: string): UninstallScriptStat | null {
  if (statProbe) return statProbe(path)
  try {
    const st = lstatSync(path) // lstat: NON segue i symlink
    return { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), uid: st.uid, gid: st.gid, mode: st.mode }
  } catch {
    return null
  }
}

/** I fatti completi della guardia: script, /usr/local/bin e /usr/local. */
export function uninstallGuardFacts(): UninstallGuardFacts {
  return {
    script: uninstallScriptStat(UNINSTALL_CONTAINER_SCRIPT),
    dir: uninstallScriptStat(UNINSTALL_SCRIPT_DIR),
    parentDir: uninstallScriptStat(UNINSTALL_SCRIPT_PARENT_DIR)
  }
}
