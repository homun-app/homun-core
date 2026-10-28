// Confini dei path del BOX CONDIVISO (fase 11, punto 1) — funzioni PURE.
// read-file, write-file e list-directory accettano path relativi (risolti
// sulla home del bot) o assoluti DENTRO la radice del box; `/workspace/…` è
// l'alias della cartella comune in ENTRAMBE le modalità (host e docker).
// Fuori dalla radice si rifiuta, con realpath come il gate C5: ../ e i
// symlink verso l'esterno restano fuori. Tutti i bot leggono e scrivono
// tutto il box: è condiviso apposta (§3ter T8).
import { join, resolve } from 'node:path'
import { isInsideBox } from '../agent/permission-rules'

/** L'alias della cartella comune del box. */
export const WORKSPACE_ALIAS = '/workspace'

/** La cartella comune dentro la radice. */
export const WORKSPACE_DIR = 'workspace'

export interface BoxPathResolution {
  ok: boolean
  /** path assoluto DENTRO il box (host: sotto la radice reale; docker: sotto /box). */
  abs?: string
  reason?: string
}

/**
 * Risolve un path del box (puro): relativi → home del bot; `/workspace/…` →
 * cartella comune della radice; assoluti → devono già stare dentro la radice.
 * Il controllo dei confini passa da `realpathSync` iniettato (come isInsideBox
 * del gate): in modalità host è il realpath del filesystem, in docker la
 * funzione identità (solo controllo di forma: il filesystem sta nel container).
 */
export function resolveBoxPath(
  path: string,
  root: string,
  home: string,
  realpathSync: (p: string) => string
): BoxPathResolution {
  const clean = path.trim()
  if (!clean) return { ok: false, reason: 'percorso vuoto' }
  let abs: string
  if (clean === WORKSPACE_ALIAS || clean.startsWith(WORKSPACE_ALIAS + '/')) {
    abs = resolve(join(root, WORKSPACE_DIR, '.' + clean.slice(WORKSPACE_ALIAS.length)))
  } else if (clean.startsWith('/')) {
    abs = resolve(clean)
  } else {
    abs = resolve(home, clean)
  }
  if (!isInsideBox(abs, root, realpathSync)) {
    return { ok: false, reason: `il percorso "${path}" esce dal box condiviso: usa un path relativo alla tua home oppure dentro ${WORKSPACE_ALIAS}` }
  }
  return { ok: true, abs }
}
