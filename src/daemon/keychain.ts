// Chiavi AES-256 nel Keychain macOS (fase 5: segreti dei connettori MCP —
// token OAuth, header statici, client Google; fase 6 residuo 0b: chiave master
// del vault; fase 16c C1: chiavi API dei provider).
//
// FASE RILASCIO (A6): le chiavi master NON nascono più qui — vivono cifrate
// con safeStorage in <data>/keys.json (src/daemon/master-keys.ts), dove
// l'accesso è legato alla firma dell'app. Questa pagina resta per due scopi:
// 1) la MIGRAZIONE legge (e poi cancella, servizio per servizio) le voci
//    vecchie create col comando `security`;
// 2) il fallback quando safeStorage non è disponibile (la chiave non si perde
//    mai: si continua a leggere dal Portachiavi come prima).
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
/** Fase 16c (C1): voce Keychain PROPRIA delle chiavi API dei provider. */
export const PROVIDERS_SERVICE = 'sandbot-providers-key'

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

/**
 * MODALITÀ TEST (verifica d'integrazione, fase 14): con
 * SANDBOT_TEST_FAKE_KEYCHAIN=<file> il runner `security` diventa un Keychain
 * FINTO su file — la probe del daemon reale non TOCCA il Keychain dell'utente
 * (né in lettura: l'ACL della voce vera potrebbe negare l'accesso a un
 * processo diverso dal daemon vero e far comparire un dialogo). Variabile
 * SANDBOT_TEST_*: in produzione non esiste.
 * Fase rilascio (A6): il finto supporta anche delete-generic-password, così
 * la migrazione delle chiavi master si prova dal vivo senza il Portachiavi
 * vero.
 */
export function securityRunnerForEnv(): SecurityRunner {
  const fakePath = process.env.SANDBOT_TEST_FAKE_KEYCHAIN
  if (!fakePath) return execSecurity
  const run: SecurityRunner = async (args, input) => {
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
    const load = (): Record<string, string> => {
      try {
        return existsSync(fakePath) ? (JSON.parse(readFileSync(fakePath, 'utf8')) as Record<string, string>) : {}
      } catch {
        return {}
      }
    }
    const map = load()
    if (args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1] ?? ''
      const v = map[svc]
      return v ? { out: v + '\n', err: '', code: 0 } : { out: '', err: 'not found', code: 1 }
    }
    if (args[0] === 'delete-generic-password') {
      const svc = args[args.indexOf('-s') + 1] ?? ''
      if (!(svc in map)) return { out: '', err: 'not found', code: 1 }
      delete map[svc]
      writeFileSync(fakePath, JSON.stringify(map))
      return { out: '', err: '', code: 0 }
    }
    if (args[0] === '-i') {
      for (const line of String(input ?? '').split('\n')) {
        const m = /^add-generic-password -a \S+ -s (\S+) -w (\S+)/.exec(line.trim())
        if (m) map[m[1]!] = m[2]!
      }
      writeFileSync(fakePath, JSON.stringify(map))
      return { out: '', err: '', code: 0 }
    }
    return { out: '', err: 'operazione non supportata dal keychain finto', code: 1 }
  }
  return run
}

/** Legge una chiave dal Keychain (nessun segreto nell'argv); null se assente. */
export async function readKeychainKey(service: string, run: SecurityRunner = securityRunnerForEnv()): Promise<Buffer | null> {
  const r = await run(['find-generic-password', '-a', ACCOUNT, '-s', service, '-w'])
  const v = r.out.trim()
  if (r.code === 0 && v) {
    const key = Buffer.from(v, 'base64')
    if (key.length === 32) return key
  }
  return null
}

/** Scrive/aggiorna una chiave nel Keychain via `security -i` (valore da stdin). */
export async function writeKeychainKey(service: string, key: Buffer, run: SecurityRunner = securityRunnerForEnv()): Promise<boolean> {
  // -U aggiorna la voce se esiste già; il valore base64 è sicuro in una riga
  // di comando di `security -i` (charset [A-Za-z0-9+/=], niente quoting)
  const cmd = `add-generic-password -a ${ACCOUNT} -s ${service} -w ${key.toString('base64')} -U\n`
  const r = await run(['-i'], cmd)
  return r.code === 0
}

/**
 * Cancella la voce del Portachiavi di UN servizio esatto (A6: la migrazione
 * la chiama solo dopo la verifica di keys.json — solo i servizi
 * sandbot-*-key, mai nient'altro).
 */
export async function deleteKeychainKey(service: string, run: SecurityRunner = securityRunnerForEnv()): Promise<boolean> {
  const r = await run(['delete-generic-password', '-a', ACCOUNT, '-s', service])
  return r.code === 0
}

/**
 * Chiave per una voce del Keychain: letta o generata alla prima occorrenza
 * (32 byte casuali). Se la scrittura fallisce perché una voce è stata creata
 * concorrentemente, rilegge: un solo processo vince la gara. (Oggi è il
 * FALLBACK di getMasterKey e la via delle generazioni PRE-migrazione.)
 */
export async function getKeychainKey(service: string, run: SecurityRunner = securityRunnerForEnv()): Promise<Buffer> {
  const existing = await readKeychainKey(service, run)
  if (existing) return existing
  const key = randomBytes(32)
  if (await writeKeychainKey(service, key, run)) return key
  const raced = await readKeychainKey(service, run)
  if (raced) return raced
  // fase 17c (C3): errore che arriva alla UI (mcp:save) — testo del catalogo
  const { uiError, UI } = await import('../main/ui-language')
  throw uiError(UI.rpcKeychainUnavailable)
}

/** Chiave dei segreti dei connettori (A6: passa da keys.json/safeStorage; Portachiavi solo fallback/migrazione). */
export function getConnectorsKey(run?: SecurityRunner): Promise<Buffer> {
  return import('./master-keys').then((m) => m.getMasterKey(CONNECTORS_SERVICE, run ? { run } : {}))
}

/** Fase 16c (C1): chiave delle chiavi API dei provider (A6: come i connettori). */
export function getProvidersKey(run?: SecurityRunner): Promise<Buffer> {
  return import('./master-keys').then((m) => m.getMasterKey(PROVIDERS_SERVICE, run ? { run } : {}))
}
