// Cartella base delle mkdtemp dei test. Sul Mac di sviluppo è la T/ esplicita
// (TMPDIR può essere cambiata da altri strumenti: regola del progetto); dove
// non esiste — la CI di GitHub — si usa la cartella temporanea del sistema.
// CB3 (fase ci-beta5): la variabile SOLO-TEST SANDBOT_TEST_TMP_BASE sposta la
// base su una cartella scelta da chi lancia la corsa — la simula della CI
// (npm run test:ci-sim) la punta su una mkdtemp della temporanea di sistema,
// come il runner. Il valore DEVE essere una cartella che esiste: un valore
// rotto si rifiuta SUBITO con un errore chiaro, cadere in silenzio sulla base
// di sviluppo maschererebbe una corsa mal configurata.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const DEV_TMP = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const override = process.env.SANDBOT_TEST_TMP_BASE
if (override !== undefined && !isDirectory(override)) {
  throw new Error(`SANDBOT_TEST_TMP_BASE deve essere una cartella esistente: ${override}`)
}

export const TEST_TMP_BASE: string = override !== undefined ? override : existsSync(DEV_TMP) ? DEV_TMP : realpathSync(tmpdir())
