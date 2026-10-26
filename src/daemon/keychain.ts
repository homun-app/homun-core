// Chiave AES-256 dei segreti dei connettori MCP (token OAuth, header statici,
// client Google). Vive nel Keychain macOS e il daemon la legge anche a
// finestra chiusa — per questo NON si usa safeStorage come per il vault: le
// routine girano senza UI e i token devono restare usabili (safeStorage senza
// finestra bloccherebbe ogni connettore).
//
// I comandi partono da stdin (`security -i`, un comando per riga): la chiave
// non compare mai nell'argv di un processo, dove sarebbe visibile a `ps`
// (stessa ragione del vault, §5.6). La lettura usa find-generic-password -w,
// che scrive il valore sullo stdout. Il runner è iniettabile per i test.
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'

const SERVICE = 'sandbot-connectors-key'
const ACCOUNT = 'sandbot'

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

async function readKey(run: SecurityRunner): Promise<Buffer | null> {
  const r = await run(['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'])
  const v = r.out.trim()
  if (r.code === 0 && v) {
    const key = Buffer.from(v, 'base64')
    if (key.length === 32) return key
  }
  return null
}

async function writeKey(run: SecurityRunner, key: Buffer): Promise<boolean> {
  // -U aggiorna la voce se esiste già; il valore base64 è sicuro in una riga
  // di comando di `security -i` (charset [A-Za-z0-9+/=], niente quoting)
  const cmd = `add-generic-password -a ${ACCOUNT} -s ${SERVICE} -w ${key.toString('base64')} -U\nquit\n`
  const r = await run(['-i'], cmd)
  return r.code === 0
}

/**
 * Chiave dei connettori: letta dal Keychain o generata alla prima occorrenza
 * (32 byte casuali). Se la scrittura fallisce perché una voce è stata creata
 * concorrentemente, rilegge: un solo processo vince la gara.
 */
export async function getConnectorsKey(run: SecurityRunner = execSecurity): Promise<Buffer> {
  const existing = await readKey(run)
  if (existing) return existing
  const key = randomBytes(32)
  if (await writeKey(run, key)) return key
  const raced = await readKey(run)
  if (raced) return raced
  throw new Error('Keychain non disponibile: impossibile conservare i token dei connettori')
}
