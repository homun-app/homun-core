// T1 (fase prima-release): il controllo di fine corsa sulle temporanee, come
// «0 daemon dopo ogni corsa» ma per i FILE. Registrato in vitest.config.ts
// come globalSetup (non tocca setupFiles): all'avvio fotografa le voci
// `sandbot-*` di TEST_TMP_BASE e di realpath(tmpdir()) — la stessa cartella,
// dopo il realpath, si conta una volta — e nel teardown confronta. Le
// `sandbot-fase-*` sono le sonde, che puliscono da sole e possono girare in
// un altro terminale: escluse. Se resta anche una cartella nuova, la corsa
// FALLISCE con quante, per prefisso, i primi 5 nomi e la regola del progetto.
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { TEST_TMP_BASE } from './test-tmp'

export const RULE = 'ogni cartella temporanea si cancella a fine test o a fine corsa'

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
  return () => {
    const left = newLeftovers(start, dirs.flatMap(scan))
    if (left.length > 0) throw new Error(guardMessage(left))
  }
}
