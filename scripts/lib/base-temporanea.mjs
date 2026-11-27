// P1 (fase ci-percorso-temporanei): la base delle mkdtemp degli SCRIPT, con
// la regola di src/test-tmp.ts — lì la usa la suite, qui gli script che i
// test lanciano da riga di comando (esporta-inutilizzati.mjs). Il percorso
// della temporanea del Mac di sviluppo sta fisso nel repo, ma vale solo dove
// quella cartella c'è: sul runner di GitHub non c'è, e la CI della beta.21 è
// caduta lì (ENOENT su mkdtemp). La regola:
//   SANDBOT_TEST_TMP_BASE se c'è — e DEVE essere una cartella che esiste: un
//   valore rotto si rifiuta SUBITO con un errore chiaro, cadere in silenzio
//   sulla base di sviluppo maschererebbe una corsa mal configurata;
//   altrimenti la cartella del Mac, se esiste;
//   altrimenti la temporanea di sistema, risolta.
// La regola resta scritta anche in src/test-tmp.ts (la suite lo carica
// com'è): scripts/__tests__/base-temporanea.test.ts controlla che le due
// diano lo stesso risultato.
//
// SANDBOT_TEST_DEV_TMP è una variabile SOLO-TEST: fa le veci della cartella
// del Mac, così un test può fingere di essere sul runner puntandola su un
// percorso che non c'è. Fuori dai test nessuno la imposta.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** La temporanea del Mac di sviluppo (regola del progetto: i comandi si lanciano con questa, mai con quella dell'ambiente). */
export const DEV_TMP = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** La base delle mkdtemp per l'ambiente dato (quello del processo, se non si dice). */
export function baseTemporanea(env = process.env) {
  const override = env.SANDBOT_TEST_TMP_BASE
  if (override !== undefined && !isDirectory(override)) {
    throw new Error(`SANDBOT_TEST_TMP_BASE deve essere una cartella esistente: ${override}`)
  }
  const delMac = env.SANDBOT_TEST_DEV_TMP ?? DEV_TMP
  return override !== undefined ? override : existsSync(delMac) ? delMac : realpathSync(tmpdir())
}
