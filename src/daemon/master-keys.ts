// Chiavi master dei servizi (fase rilascio, A6): vault, connettori e
// provider. FINO alla 16c stavano nel Portachiavi via `security`: chiunque
// lanciasse `security find-generic-password -s sandbot-vault-key -w` le
// leggeva SENZA richiesta, perché l'ACL della voce elencava solo
// /usr/bin/security. Ora le chiavi vivono cifrate con safeStorage in
// <data>/keys.json (0600, scrittura atomica): il Portachiavi le protegge
// legandole alla firma dell'app («Homun Safe Storage») e un altro programma
// che le chiede fa comparire la richiesta di macOS.
//
// Con A1 il daemon è un processo Electron: safeStorage è disponibile anche
// lì dopo `ready`. Il backend qui è INIETTABILE (il daemon reale registra
// quello di Electron; SANDBOT_TEST_FAKE_SAFESTORAGE nei test, mai il vero).
//
// Migrazione, idempotente e senza perdite, per ogni servizio che esiste nel
// Portachiavi vecchio e non in keys.json: lettura col metodo di oggi →
// cifratura → scrittura → RILETTURA e confronto → solo allora cancellazione
// della voce vecchia (esattamente quel servizio). Se qualcosa fallisce
// resta tutto com'è (avviso nel log SENZA segreti) e la chiave continua a
// leggersi dal Portachiavi come prima: si riprova al prossimo avvio.
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../main/store/db'
import { getKeychainKey, readKeychainKey, deleteKeychainKey, CONNECTORS_SERVICE, VAULT_SERVICE, PROVIDERS_SERVICE } from './keychain'
import type { SafeStorageLike } from '../main/vault'

/** I servizi con chiave master (le voci Keychain di oggi diventano i campi di keys.json). */
export const MASTER_KEY_SERVICES = [VAULT_SERVICE, CONNECTORS_SERVICE, PROVIDERS_SERVICE] as const
export type MasterKeyService = (typeof MASTER_KEY_SERVICES)[number]

interface KeysFile {
  version: 1
  [service: string]: string | number | undefined
}

// ---- backend safeStorage iniettabile ----

let backend: SafeStorageLike | null = null

/** Registra il backend safeStorage (daemon Electron: quello vero; test: il finto); null lo rimuove. */
export function setMasterKeyStorage(s: SafeStorageLike | null): void {
  backend = s
}

/**
 * Backend reale di Electron se disponibile; con SANDBOT_TEST_FAKE_SAFESTORAGE
 * il FINTO (AES con chiave fissa di test) — il Portachiavi vero non si tocca
 * MAI nei test. Variabile SANDBOT_TEST_*: in produzione non esiste.
 */
export function safeStorageBackendForEnv(real: SafeStorageLike | null, env: NodeJS.ProcessEnv = process.env): SafeStorageLike | null {
  const fakePath = env.SANDBOT_TEST_FAKE_SAFESTORAGE
  if (!fakePath) return real
  const key = createHash('sha256').update('sandbot-test-safestorage').digest()
  const enc = (plain: string): Buffer => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), ct])
  }
  const dec = (raw: Buffer): string => {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => enc(plain),
    decryptString: (sealed) => dec(sealed)
  }
}

// ---- keys.json: 0600, scrittura atomica (tmp + fsync + rename) ----

function keysPath(dir = dataDir()): string {
  return join(dir, 'keys.json')
}

function readKeysFile(path: string): KeysFile | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<KeysFile>
    if (v.version !== 1) return null
    return v as KeysFile
  } catch {
    return null
  }
}

function writeKeysFileAtomic(path: string, data: KeysFile): void {
  const tmp = `${path}.tmp`
  try {
    unlinkSync(tmp) // residuo di un crash: si ricrea subito dopo
  } catch {
    // non esiste: bene
  }
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

// ---- cifratura delle chiavi (base64 della chiave dentro l'envelope) ----

async function sealKey(storage: SafeStorageLike, key: Buffer): Promise<string> {
  return (await storage.encryptString(key.toString('base64'))).toString('base64')
}

async function unsealKey(storage: SafeStorageLike, sealed: string): Promise<Buffer> {
  const b64 = await storage.decryptString(Buffer.from(sealed, 'base64'))
  return Buffer.from(b64, 'base64')
}

function isFreshKey(key: Buffer): boolean {
  return key.length === 32
}

export interface MasterKeyDeps {
  /** backend safeStorage (default: quello registrato) */
  storage?: SafeStorageLike | null
  /** runner `security` per la migrazione dal Portachiavi vecchio (test) */
  run?: import('./keychain').SecurityRunner
  /** directory dati (default dataDir()) */
  dir?: string
  /** log di avviso (default console.warn), SENZA segreti */
  warn?: (msg: string) => void
}

/**
 * L'unica strada per una chiave master (A6): keys.json se c'è; migrazione dal
 * Portachiavi vecchio se serve; generazione alla prima occorrenza. Se
 * safeStorage non c'è o qualcosa fallisce, la chiave si legge col metodo di
 * oggi (Portachiavi): non si perde mai.
 */
export async function getMasterKey(service: string, deps: MasterKeyDeps = {}): Promise<Buffer> {
  const storage = deps.storage !== undefined ? deps.storage : backend
  const dir = deps.dir ?? dataDir()
  const warn = deps.warn ?? ((m) => console.warn(m))
  const path = keysPath(dir)
  const file = existsSync(path) ? readKeysFile(path) : null

  // 1. già in keys.json
  if (file && typeof file[service] === 'string' && storage?.isEncryptionAvailable()) {
    try {
      const key = await unsealKey(storage, file[service] as string)
      if (isFreshKey(key)) return key
      warn(`[master-keys] entry ${service} unreadable in keys.json: falling back to the Keychain`)
    } catch {
      warn(`[master-keys] entry ${service} not decryptable in keys.json: falling back to the Keychain`)
    }
  }

  // 2. safeStorage disponibile → migrazione o prima generazione
  if (storage?.isEncryptionAvailable()) {
    const old = await readKeychainKey(service, deps.run)
    if (old) {
      // migrazione: cifra → scrivi → RILEGGI e confronta → solo allora cancella la voce vecchia
      const next: KeysFile = { ...(file ?? { version: 1 }), [service]: await sealKey(storage, old) }
      try {
        writeKeysFileAtomic(path, next)
        const reread = readKeysFile(path)
        const back = reread && typeof reread[service] === 'string' ? await unsealKey(storage, reread[service] as string) : null
        if (back && back.equals(old)) {
          if (await deleteKeychainKey(service, deps.run)) {
            return old
          }
          warn(`[master-keys] ${service} migrated but deleting the old Keychain item deferred to the next start`)
          return old
        }
        warn(`[master-keys] migration verify failed for ${service}: the old Keychain item stays in place`)
      } catch (e) {
        warn(`[master-keys] migration of ${service} deferred to the next start: ${e instanceof Error ? e.message : 'error'}`)
      }
      return old // niente perdite: si continua col Portachiavi finché non riesce
    }
    const key = randomBytes(32)
    const next: KeysFile = { ...(file ?? { version: 1 }), [service]: await sealKey(storage, key) }
    try {
      writeKeysFileAtomic(path, next)
      return key
    } catch (e) {
      warn(`[master-keys] could not write keys.json: ${e instanceof Error ? e.message : 'error'}`)
    }
  } else if (file && typeof file[service] === 'string') {
    warn('[master-keys] safeStorage unavailable: keys.json entries unreadable, falling back to the Keychain')
  }

  // 3. fallback: il metodo di oggi (Portachiavi via `security`)
  return getKeychainKey(service, deps.run)
}

/**
 * Mette una chiave GIÀ ESISTENTE in keys.json (migrazione del setting legacy
 * del vault, fasi 1–5): cifra, scrive, RILEGGE e confronta. True solo se la
 * chiave ora è leggibile da keys.json.
 */
export async function saveMasterKey(service: string, key: Buffer, deps: MasterKeyDeps = {}): Promise<boolean> {
  const storage = deps.storage !== undefined ? deps.storage : backend
  if (!storage?.isEncryptionAvailable() || !isFreshKey(key)) return false
  const dir = deps.dir ?? dataDir()
  const path = keysPath(dir)
  const file = existsSync(path) ? readKeysFile(path) : null
  // una voce che c'è già e decifra vince: niente sovrascritture
  if (file && typeof file[service] === 'string') {
    try {
      if ((await unsealKey(storage, file[service] as string)).equals(key)) return true
    } catch {
      // si sovrascrive sotto
    }
  }
  try {
    writeKeysFileAtomic(path, { ...(file ?? { version: 1 }), [service]: await sealKey(storage, key) })
    const reread = readKeysFile(path)
    return !!reread && typeof reread[service] === 'string' && (await unsealKey(storage, reread[service] as string)).equals(key)
  } catch {
    return false
  }
}
