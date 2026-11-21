// U6 (fase mcp-ui): il registro del ciclo di vita del main — sempre attivo e
// leggero, in ~/Library/Logs/Homun/main.log (ruota oltre ~1 MB). Nelle prove
// (SANDBOT_TEST_USER_DATA) la cartella si sposta nella temporanea dei dati:
// MAI una riga nel ~/Library/Logs/Homun vero fuori dall'app impacchettata.
// Righe con orario per: avvio (pid, versione), lock ottenuto o no,
// second-instance (e se l'app sta uscendo), finestra principale creata,
// mostrata e chiusa, before-quit, will-quit, quit e durata dell'uscita.
// MAI dati dell'utente: solo pid, flag, conteggi e durate. Un errore del fs
// NON si propaga mai (il registro non deve fermare l'app).
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Oltre questa dimensione il registro ruota (main.log → main.log.1). */
export const LIFECYCLE_LOG_MAX_BYTES = 1_000_000

/** Le dipendenze del fs (iniettabili nei test). */
export interface LifecycleLogDeps {
  appendFileSync(path: string, data: string): void
  mkdirSync(dir: string, options: { recursive: true }): void
  existsSync(path: string): boolean
  statSync(path: string): { size: number }
  renameSync(from: string, to: string): void
  rmSync(path: string): void
  now(): number
}

const realDeps: LifecycleLogDeps = {
  appendFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
  rmSync,
  now: () => Date.now()
}

/**
 * La cartella del registro: il getPath('logs') dell'app (~/Library/Logs/Homun
 * nel pacchetto vero); con SANDBOT_TEST_USER_DATA (le prove e le sonde) la
 * cartella temporanea dei DATI, mai il registro vero dell'utente.
 */
export function mainLogDir(getLogsPath: () => string, env: NodeJS.ProcessEnv = process.env): string {
  const test = env.SANDBOT_TEST_USER_DATA
  return test ? join(test, 'Logs') : getLogsPath()
}

/**
 * Il registro del ciclo di vita: line(evento, campi) scrive una riga
 * «<ISO> <evento> k=v …». I campi undefined NON si scrivono; gli spazi nei
 * valori si appiattiscono (una riga = un evento). La rotazione avviene una
 * volta per processo (oltre ~1 MB il vecchio main.log diventa main.log.1,
 * quello che era .1 si toglie) così le righe dell'avvio corrente non si
 * perdono mai in mezzo a un file ruotato a metà.
 */
export function createLifecycleLog(
  dir: string,
  deps: Partial<LifecycleLogDeps> = {}
): { line(event: string, fields?: Record<string, string | number | boolean | undefined>): void } {
  const d: LifecycleLogDeps = { ...realDeps, ...deps }
  let rotated = false
  return {
    line(event, fields = {}) {
      try {
        d.mkdirSync(dir, { recursive: true })
        const file = join(dir, 'main.log')
        if (!rotated && d.existsSync(file) && d.statSync(file).size > LIFECYCLE_LOG_MAX_BYTES) {
          rotated = true
          const old = `${file}.1`
          try {
            if (d.existsSync(old)) d.rmSync(old)
          } catch {
            // il .1 vecchio resta: si ruota lo stesso
          }
          try {
            d.renameSync(file, old)
          } catch {
            // il file resta com'è: si appende comunque
          }
        }
        const iso = new Date(d.now()).toISOString()
        const kv = Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ')}`)
          .join(' ')
        d.appendFileSync(file, `${iso} ${event}${kv ? ` ${kv}` : ''}\n`)
      } catch {
        // mai: il registro non ferma l'app
      }
    }
  }
}
