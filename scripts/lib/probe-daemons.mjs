// K8 (fase skill ritocchi): l'helper CONDIVISO delle sonde per trovare e
// chiudere i daemon di sviluppo — dall'AMBIENTE dei processi, non dagli
// argomenti. Il controllo di prima filtrava le righe di `pgrep -fl` cercando
// il prefisso della cartella dati NELLA RIGA DI COMANDO, ma quella sta
// nell'env (SANDBOT_TEST_USER_DATA), non negli argv: non trovava mai niente
// e la sonda chiudeva «verde» lasciando un Electron --homun-daemon vivo con
// la cartella dati aperta (S10.2 non risolto).
//
// Su macOS `ps eww -ax -o pid=,command=` elenca ambiente e argomenti: una
// riga del daemon contiene --homun-daemon E
// SANDBOT_TEST_USER_DATA=/<prefisso della sonda>/… — solo lì si cerca.
//
// La chiusura: SIGTERM, attesa, SIGKILL, verifica che siano spariti; le
// cartelle temporanee si cancellano SOLO DOPO. I conteggi si stampano
// sempre: «0 trovati» quando la sonda ha avviato daemon è un segnale da
// indagare, non un successo.
import { spawnSync } from 'node:child_process'

/** Un daemon trovato: pid e riga intera (per il log). */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * I daemon della sonda, dall'AMBIENTE: righe con --homun-daemon E
 * SANDBOT_TEST_USER_DATA=…/<prefix>… (il prefisso è quello delle
 * mkdtemp della sonda, per esempio «sandbot-fase-skill»).
 */
export function findProbeDaemons(prefix) {
  const out = spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const re = new RegExp(`SANDBOT_TEST_USER_DATA=\\S*${prefix}`)
  return (out.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes('--homun-daemon') && re.test(line))
    .map((line) => ({ pid: Number(line.trim().split(/\s+/, 1)[0]), line }))
    .filter((d) => Number.isInteger(d.pid) && d.pid > 1 && d.pid !== process.pid)
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Chiude TUTTI i daemon della sonda (SIGTERM, poi SIGKILL) e CONTROLLA che
 * siano spariti. Torna i conteggi { found, closed, left } e li stampa:
 * found = trovati dall'ambiente, closed = effettivamente spariti.
 */
export async function stopProbeDaemons(prefix, { log = (...a) => console.log('[probe-daemons]', ...a) } = {}) {
  const found = findProbeDaemons(prefix)
  for (const d of found) {
    try { process.kill(d.pid, 'SIGTERM') } catch { /* già via */ }
  }
  // un po' di grazia: il daemon chiude le connessioni e rilascia i file
  for (let i = 0; i < 30 && found.some((d) => pidAlive(d.pid)); i++) await sleep(200)
  for (const d of found) {
    if (pidAlive(d.pid)) {
      try { process.kill(d.pid, 'SIGKILL') } catch { /* già via */ }
    }
  }
  for (let i = 0; i < 15 && found.some((d) => pidAlive(d.pid)); i++) await sleep(200)
  const left = findProbeDaemons(prefix)
  const closed = found.filter((d) => !pidAlive(d.pid)).length
  log(`${found.length} trovati, ${closed} chiusi${left.length ? `, ${left.length} RIMASTI:\n` + left.map((d) => d.line).join('\n') : ''}`)
  return { found: found.length, closed, left: left.length }
}
