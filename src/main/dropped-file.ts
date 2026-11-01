// Fase 19b (correzioni U1): la validazione del main per il path del file
// TRASCINATO. Il confine vero è il preload (che accetta solo un oggetto File
// del drop e calcola il path con webUtils, senza far passare stringhe); qui
// c'è il controllo in più del main, in difesa in profondità: assoluto, senza
// byte nulli e file REGOLARE (lstat, non stat: un symlink nel Desktop non
// deve poter puntare a ~/.ssh).
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** L'errore quando il path non è quello di un file trascinato valido. */
export const NOT_A_DROPPED_FILE = 'not a dropped file'

/**
 * Valida il macPath di files:import-dropped PRIMA di chiamare files:import.
 * Non è un dialog: il path arriva dal drop via preload. Rigetta tutto ciò
 * che non è un file regolare raggiunto senza symlink; ritorna il path.
 */
export async function assertDroppedMacPath(macPath: unknown): Promise<string> {
  if (typeof macPath !== 'string' || !isAbsolute(macPath) || macPath.includes('\0')) {
    throw new Error(NOT_A_DROPPED_FILE)
  }
  // lstat NON segue i symlink: un link viene visto per quello che è
  const st = await lstat(macPath)
  if (!st.isFile()) throw new Error(NOT_A_DROPPED_FILE)
  return macPath
}
