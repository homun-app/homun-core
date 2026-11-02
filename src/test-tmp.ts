// Cartella base delle mkdtemp dei test. Sul Mac di sviluppo è la T/ esplicita
// (TMPDIR può essere cambiata da altri strumenti: regola del progetto); dove
// non esiste — la CI di GitHub — si usa la cartella temporanea del sistema.
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

const DEV_TMP = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

export const TEST_TMP_BASE: string = existsSync(DEV_TMP) ? DEV_TMP : realpathSync(tmpdir())
