// T1 (fase prima-release): il controllo di fine corsa sulle temporanee, come
// «0 daemon dopo ogni corsa» ma per i FILE. Registrato in vitest.config.ts
// come globalSetup (non tocca setupFiles): all'avvio fotografa le voci
// `sandbot-*` di TEST_TMP_BASE e di realpath(tmpdir()) — la stessa cartella,
// dopo il realpath, si conta una volta — e nel teardown confronta. Le
// `sandbot-fase-*` sono le sonde, che puliscono da sole e possono girare in
// un altro terminale: escluse. Se resta anche una cartella nuova, la corsa
// FALLISCE con quante, per prefisso, i primi 5 nomi e la regola del progetto.
import { readdirSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { TEST_TMP_BASE } from './test-tmp'

export const RULE = 'ogni cartella temporanea si cancella a fine test o a fine corsa'

/** C1 (fase ci-temporanei): il prefisso della radice che possiede la corsa. */
export const RUN_ROOT_PREFIX = 'sandbot-vitest-run-'

/** C1: cancella la radice — il teardown la chiama PRIMA del controllo. */
export const wipeRunRoot = (root: string): void => rmSync(root, { recursive: true, force: true })

const isSandbotName = (name: string): boolean => name.startsWith('sandbot-')
const isProbeName = (name: string): boolean => name.startsWith('sandbot-fase-')

/** PURE: le cartelle da guardare, una volta sola ciascuna (realpath già fatto). */
export const uniqueDirs = (dirs: readonly string[]): string[] => [...new Set(dirs)]

/** PURE: le voci nuove rimaste — non quelle delle sonde, non le non-sandbot. */
export const newLeftovers = (start: readonly string[], end: readonly string[]): string[] => {
  const seen = new Set(start)
  return end.filter((e) => {
    const name = basename(e)
    return isSandbotName(name) && !isProbeName(name) && !seen.has(e)
  })
}

/** PURE: il prefisso di un nome = tutto fino all'ultimo trattino (dopo c'è il suffisso casuale di mkdtemp). */
export const prefixOf = (name: string): string => {
  const i = name.lastIndexOf('-')
  return i === -1 ? name : name.slice(0, i + 1)
}

/** PURE: quante per prefisso, nell'ordine in cui compaiono la prima volta. */
export const countByPrefix = (paths: readonly string[]): Array<[string, number]> => {
  const counts = new Map<string, number>()
  for (const e of paths) {
    const pfx = prefixOf(basename(e))
    counts.set(pfx, (counts.get(pfx) ?? 0) + 1)
  }
  return [...counts.entries()]
}

/** PURE: il messaggio dell'errore di fine corsa. */
export const guardMessage = (left: readonly string[]): string => {
  const perPrefix = countByPrefix(left).map(([pfx, n]) => `${pfx} ×${n}`).join(', ')
  const names = left.slice(0, 5).map((e) => `  ${e}`).join('\n')
  return (
    `test-tmp-guard: ${left.length} cartelle sandbot- nuove rimaste a fine corsa — la regola del progetto: ${RULE}.\n` +
    `Per prefisso: ${perPrefix}\n` +
    `Prime ${Math.min(5, left.length)}:\n${names}`
  )
}

const real = (dir: string): string => {
  try {
    return realpathSync(dir)
  } catch {
    return dir // una cartella sparita non può contenere nuovi resti
  }
}

const scan = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter(isSandbotName).map((n) => join(dir, n))
  } catch {
    return []
  }
}

/** Il globalSetup: fotografa all'avvio, fallisce la corsa nel teardown se restano cartelle. */
export default function testTmpGuard(): () => void {
  const dirs = uniqueDirs([real(TEST_TMP_BASE), real(tmpdir())])
  const start = dirs.flatMap(scan)
  // C1 (fase ci-temporanei): UNA radice per corsa, la creano e la cancellano
  // i globalSetup — chi possiede la corsa intera, non gli hook dei file: nei
  // file saltati per intero (describe.skipIf, il runner senza modelli locali)
  // vitest non gira né afterAll né exit, e le cartelle DATI dei file finiscono
  // DENTRO questa radice: spariscono col teardown comunque. Nasce DOPO la
  // foto: se il teardown la dimenticasse, il controllo la segnala. Arriva ai
  // worker con l'env — verificato dal vivo su vitest 5.0.5: process.env
  // impostato qui è ereditato dai fork (provide/inject invece crasha lo
  // startup all'import di provide da 'vitest' nel globalSetup).
  const runRoot = mkdtempSync(join(TEST_TMP_BASE, RUN_ROOT_PREFIX))
  process.env.SANDBOT_VITEST_RUN_ROOT = runRoot
  return () => {
    wipeRunRoot(runRoot) // PRIMA del controllo: la radice non conta come rimasta
    const left = newLeftovers(start, dirs.flatMap(scan))
    if (left.length > 0) throw new Error(guardMessage(left))
  }
}
