// OB5 (fase onboarding-b): togliere lo strumento di Apple — l'unica eccezione
// alla regola «mai privilegi d'amministratore»: la disinstallazione non ha
// un'interfaccia di Apple, quindi si usa osascript … with administrator
// privileges, ma SOLO per UN comando FISSO e VERIFICATO (la stringa è una
// COSTANTE, mai composta con dati), e SOLO se lo script di disinstallazione
// di Apple esiste, è di root:wheel e NON è scrivibile da gruppo o altri: la
// password del Mac non si dà mai a un file che chiunque può riscrivere.
// La guardia è PURA: il test la prova su tutti i casi; l'argv di osascript
// sta qui, fisso.

import { lstatSync } from 'node:fs'

/** Lo script di disinstallazione del pacchetto di Apple (tiene i dati con -d). */
export const UNINSTALL_CONTAINER_SCRIPT = '/usr/local/bin/uninstall-container.sh'

/**
 * Il comando UNICO e FISSO: mai interpolato, mai composto con dati — una
 * costante letterale che finisce nel test apple-uninstall.test.ts.
 */
export const UNINSTALL_OSASCRIPT_ARGV = ['-e', 'do shell script "/usr/local/bin/uninstall-container.sh -d" with administrator privileges'] as const

/** I fatti di un file che la guardia guarda (tutti iniettabili nei test). */
export interface UninstallScriptStat {
  exists: boolean
  /** il proprietario: root è 0 */
  uid: number
  /** il gruppo: wheel è 0 */
  gid: number
  /** i permessi (bit mode di stat) */
  mode: number
}

/**
 * La guardia (PURa): lo script c'è, è di root:wheel e non è scrivibile da
 * gruppo o altri? reason dice perché NO — l'errore in parole lo sceglie la
 * RPC. null = non c'è lo stat (il file non si può nemmeno guardare).
 */
export function uninstallScriptGuardOk(stat: UninstallScriptStat | null): { ok: boolean; reason: 'missing' | 'not-root' | 'writable' | null } {
  if (!stat || !stat.exists) return { ok: false, reason: 'missing' }
  if (stat.uid !== 0 || stat.gid !== 0) return { ok: false, reason: 'not-root' }
  // group-write (0o020) o other-write (0o002): chiunque potrebbe riscrivere
  // lo script che girerebbe come root
  if ((stat.mode & 0o022) !== 0) return { ok: false, reason: 'writable' }
  return { ok: true, reason: null }
}

// ---- lo stat del file (produzione: lstat; test: sonda sostituibile) ----

let statProbe: ((path: string) => UninstallScriptStat | null) | null = null

/** Solo per i test: sostituisce (o ripristina) la lettura dello stat. */
export function setUninstallStatProbeForTests(p: ((path: string) => UninstallScriptStat | null) | null): void {
  statProbe = p
}

/** Lo stat dello script di disinstallazione (null = non esiste / non leggibile). */
export function uninstallScriptStat(path: string = UNINSTALL_CONTAINER_SCRIPT): UninstallScriptStat | null {
  if (statProbe) return statProbe(path)
  try {
    const st = lstatSync(path)
    return { exists: true, uid: st.uid, gid: st.gid, mode: st.mode }
  } catch {
    return null
  }
}
