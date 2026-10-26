// Lock e informazione del daemon, nella directory dati:
// - daemon.lock: un solo daemon per directory dati (pid + verifica che il
//   processo sia vivo, per lock stanti dopo un crash);
// - daemon.json: pid, porta, token, startedAt con permessi 0600 — lo stesso
//   schema di ~/.grokbot/local-exec-daemon.json dell'originale.
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

export interface DaemonInfo {
  pid: number
  port: number
  token: string
  startedAt: number
}

/** true se il processo esiste (signal 0); false se morto o pid invalido. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // esiste ma di un altro utente
  }
}

const LOCK = 'daemon.lock'
const INFO = 'daemon.json'

/**
 * Acquisisce il lock della directory dati: fallisce se un daemon vivo lo
 * tiene già. Un lock con pid morto (crash) viene sovrascritto.
 */
export function acquireDaemonLock(dataDir: string): { ok: boolean; pid?: number } {
  const lockPath = join(dataDir, LOCK)
  if (existsSync(lockPath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(lockPath, 'utf8')).pid)
      if (pidAlive(pid) && pid !== process.pid) return { ok: false, pid }
    } catch {
      // lock illeggibile: lo sovrascriviamo
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o644 })
  return { ok: true }
}

export function releaseDaemonLock(dataDir: string): void {
  try {
    unlinkSync(join(dataDir, LOCK))
  } catch {
    // già rimosso
  }
}

/** Scrive daemon.json con permessi 0600 (il token non deve essere leggibile ad altri utenti). */
export function writeDaemonInfo(dataDir: string, info: DaemonInfo): void {
  const p = join(dataDir, INFO)
  writeFileSync(p, JSON.stringify(info, null, 2))
  chmodSync(p, 0o600)
}

export function readDaemonInfo(dataDir: string): DaemonInfo | null {
  const p = join(dataDir, INFO)
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Partial<DaemonInfo>
    if (typeof v.pid !== 'number' || typeof v.port !== 'number' || typeof v.token !== 'string') return null
    return { pid: v.pid, port: v.port, token: v.token, startedAt: v.startedAt ?? 0 }
  } catch {
    return null
  }
}

export function removeDaemonInfo(dataDir: string): void {
  try {
    unlinkSync(join(dataDir, INFO))
  } catch {
    // non esiste
  }
}
