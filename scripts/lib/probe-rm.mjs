// K4 (fase prima-release correzioni): la pulizia VERa delle cartelle di una
// sonda. Il finally di prima faceva `rmSync(DATA)` dopo `stopApp()` e una
// pausa FISSA di 1,2 s: se l'app o il daemon riscrivevano qualcosa dopo (i
// processi ci mettevano più della pausa a uscire), la cartella rimaneva —
// la corsa rossa della verifica ne ha lasciate due.
//
// Qui: PRIMA si aspetta che i processi che tengono aperte le cartelle (l'app
// Electron, i figli RFB, i daemon della sonda) siano USCITI davvero (pid
// assenti, con un tetto di attesa), POI rmSync; alla fine si CONTROLLA che
// ogni cartella non esista più — un secondo tentativo e poi l'errore chiaro.
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './probe-daemons.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Aspetta che un pid sia uscito DAVVERO (polling ogni `stepMs`, tetto
 * `capMs`). Torna false se il tetto scade (il chiamante lo riporta: la
 * cartella resterà e si vedrà).
 */
export async function waitForPidGone(pid, { capMs = 15_000, stepMs = 200, log = () => undefined, what = 'processo' } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return true
  const deadline = Date.now() + capMs
  while (pidAlive(pid)) {
    if (Date.now() > deadline) {
      log(`${what} pid ${pid} NON è uscito entro ${capMs} ms`)
      return false
    }
    await sleep(stepMs)
  }
  return true
}

/**
 * La fine corsa di una sonda, nell'ordine che non lascia cartelle:
 * 1. i pid indicati (app, figli RFB) sono aspettati fino all'uscita VERA;
 * 2. i daemon della sonda (prefisso delle cartelle dati) fermi e spariti
 *    (stopProbeDaemons: SIGTERM, SIGKILL, verifica);
 * 3. rmSync di ogni cartella e CONTROLLO che non esista: se esiste ancora,
 *    un secondo tentativo, e se resta l'errore chiaro nel log.
 * Torna l'elenco delle cartelle RIMASTE (vuoto = pulizia riuscita) e i
 * conteggi prima/dopo per il REPORT.
 */
export async function cleanupProbeRun({ pids = [], prefix, dirs = [], log = () => undefined, capMs = 15_000 } = {}) {
  // i conteggi di PRIMA (le cartelle col prefisso della sonda nella base)
  const countBefore = countProbeDirs(prefix, dirs)
  // 1. i pid: chi tiene aperta una cartella dev'essere uscito davvero
  for (const pid of pids) await waitForPidGone(pid, { capMs, log, what: 'figlio della sonda' })
  // 2. i daemon della sonda (SIGTERM → SIGKILL → spariti)
  if (prefix) await stopProbeDaemons(prefix, { log }).catch(() => undefined)
  // 3. cancella e CONTROLLA (un secondo tentativo se qualcosa riscrive dopo)
  const left = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try { rmSync(dir, { recursive: true, force: true }) } catch (e) { log(`rmSync ${dir}: ${e.message}`) }
    if (existsSync(dir)) {
      await sleep(400)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* di nuovo giù: lo dirà il controllo */ }
    }
    if (existsSync(dir)) {
      left.push(dir)
      log(`ERRORE DI PULIZIA: la cartella temporanea ${dir} NON si è cancellata (processi usciti, due tentativi fatti)`)
    }
  }
  const countAfter = countProbeDirs(prefix, dirs)
  log(`pulizia: cartelle ${prefix}-*: ${countBefore} prima, ${countAfter} dopo${left.length ? ' — RIMASTE: ' + left.join(', ') : ''}`)
  return { left, countBefore, countAfter }
}

/** Quante cartelle col prefisso della sonda restano nella base dei temporanei. */
export function countProbeDirs(prefix, knownDirs = []) {
  const base = knownDirs.length ? join(knownDirs[0], '..') : null
  let n = 0
  try {
    for (const name of readdirSync(base)) {
      if (name.startsWith(`${prefix}-`)) n++
    }
  } catch { /* la base non c'è: zero per definizione */ }
  return n
}
