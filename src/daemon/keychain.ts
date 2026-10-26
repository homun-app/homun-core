// Chiavi AES-256 nel Keychain macOS (fase 5: segreti dei connettori MCP —
// token OAuth, header statici, client Google; fase 6 residuo 0b: chiave master
// del vault). Il daemon le legge anche a finestra chiusa — per questo NON si
// usa safeStorage come faceva il vault: le routine girano senza UI e i segreti
// devono restare usabili (safeStorage senza finestra bloccherebbe tutto).
//
// I comandi partono da stdin (`security -i`, un comando per riga): la chiave
// non compare mai nell'argv di un processo, dove sarebbe visibile a `ps`
// (stessa ragione del vault, §5.6). La lettura usa find-generic-password -w,
// che scrive il valore sullo stdout. Il runner è iniettabile per i test.
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'

const ACCOUNT = 'sandbot'

/** Voce Keychain dei segreti dei connettori MCP. */
export const CONNECTORS_SERVICE = 'sandbot-connectors-key'
/** Voce Keychain della chiave master del vault (fase 6: separata dai connettori). */
export const VAULT_SERVICE = 'sandbot-vault-key'

/** Runner del comando `security` (args + stdin opzionale), iniettabile nei test. */
export type SecurityRunner = (
  args: string[],
  input?: string
) => Promise<{ out: string; err: string; code: number | null }>

/** Runner reale: spawn di `security` con l'input passato da stdin. */
export const execSecurity: SecurityRunner = (args, input) =>
  new Promise((resolve) => {
    const child = execFile('security', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ out: String(stdout ?? ''), err: String(stderr ?? ''), code: err ? 1 : 0 })
    })
    child.stdin?.end(input ?? '')
  })

/** Legge una chiave dal Keychain (nessun segreto nell'argv); null se assente. */
export async function readKeychainKey(service: string, run: SecurityRunner = execSecurity): Promise<Buffer | null> {
  const r = await run(['find-generic-password', '-a', ACCOUNT, '-s', service, '-w'])
  const v = r.out.trim()
  if (r.code === 0 && v) {
    const key = Buffer.from(v, 'base64')
    if (key.length === 32) return key
  }
  return null
}

/** Scrive/aggiorna una chiave nel Keychain via `security -i` (valore da stdin). */
export async function writeKeychainKey(service: string, key: Buffer, run: SecurityRunner = execSecurity): Promise<boolean> {
  // -U aggiorna la voce se esiste già; il valore base64 è sicuro in una riga
  // di comando di `security -i` (charset [A-Za-z0-9+/=], niente quoting)
  const cmd = `add-generic-password -a ${ACCOUNT} -s ${service} -w ${key.toString('base64')} -U\nquit\n`
  const r = await run(['-i'], cmd)
  return r.code === 0
}

/**
 * Chiave per una voce del Keychain: letta o generata alla prima occorrenza
 * (32 byte casuali). Se la scrittura fallisce perché una voce è stata creata
 * concorrentemente, rilegge: un solo processo vince la gara.
 */
export async function getKeychainKey(service: string, run: SecurityRunner = execSecurity): Promise<Buffer> {
  const existing = await readKeychainKey(service, run)
  if (existing) return existing
  const key = randomBytes(32)
  if (await writeKeychainKey(service, key, run)) return key
  const raced = await readKeychainKey(service, run)
  if (raced) return raced
  throw new Error('Keychain non disponibile: impossibile conservare la chiave')
}

/** Chiave dei segreti dei connettori (voce propria, separata dal vault). */
export function getConnectorsKey(run: SecurityRunner = execSecurity): Promise<Buffer> {
  return getKeychainKey(CONNECTORS_SERVICE, run)
}
