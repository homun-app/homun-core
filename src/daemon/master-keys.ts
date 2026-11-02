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
// FASE RILASCIO — CORREZIONI (K1): una chiave master NON si rigenera mai se
// esistono dati sigillati con lei o una sua voce illeggibile (principio di
// Rakazo secrets-guard: cambiarla rende i dati illeggibili per sempre). Quindi:
// - entry presente ma illeggibile → NESSUNA scrittura, sola lettura dal
//   Portachiavi vecchio, altrimenti MasterKeyUnavailableError;
// - generazione SOLO se mancano insieme entry, voce del Portachiavi e dati
//   sigillati (callback hasSealedData);
// - il ripiego «crea se manca» (getKeychainKey) SPARISCE da qui: dopo la 0.3
//   nessuna chiave master nasce più con `security`;
// - una promessa-lock per servizio (dentro si RILEGGE keys.json) e le
//   scritture di keys.json serializzate fra servizi: niente read-modify-write
//   concorrenti, niente chiavi doppie all'avvio;
// - dopo la cancellazione della voce vecchia si RILEGGE l'esistenza e il log
//   dice ciò che è VERO;
// - solo il daemon tocca le chiavi: senza backend registrato è un errore di
//   programmazione, mai un ripiego sul Portachiavi;
// - le API di safeStorage usate sono le ASINCRONE di Electron 45 quando ci
//   sono (le sincrone sono deprecate).
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../main/store/db'
import { readKeychainKey, deleteKeychainKey, CONNECTORS_SERVICE, VAULT_SERVICE, PROVIDERS_SERVICE } from './keychain'
import { uiError } from '../main/ui-language'
import { UI } from '../shared/ui-messages'
import type { SafeStorageLike } from '../main/vault'

/** I servizi con chiave master (le voci Keychain di oggi diventano i campi di keys.json). */
export const MASTER_KEY_SERVICES = [VAULT_SERVICE, CONNECTORS_SERVICE, PROVIDERS_SERVICE] as const
export type MasterKeyService = (typeof MASTER_KEY_SERVICES)[number]

interface KeysFile {
  version: 1
  [service: string]: string | number | undefined
}

// ---- l'errore tipizzato di K1: la chiave non c'è e non si rigenera ----

/** Perché la chiave non è recuperabile (mai generata sopra dati esistenti). */
export type MasterKeyUnavailableReason =
  | 'entry-unreadable' // entry in keys.json che non decifra (o non è 32 byte)
  | 'storage-unavailable' // safeStorage non disponibile: né leggere né creare
  | 'sealed-data' // dati sigillati nel DB e nessuna chiave recuperabile
  | 'write-failed' // generazione tentata ma keys.json non si è scritto/verificato

/**
 * K1: la chiave master di un servizio non si riesce a leggere e NON si
 * rigenera (i segreti sigillati diventerebbero illeggibili per sempre). Il
 * messaggio è il testo del catalogo UI, già nella lingua dell'interfaccia
 * (K1.8): arriva alla persona dove arrivano gli errori di connettori,
 * Cassaforte e provider.
 */
export class MasterKeyUnavailableError extends Error {
  readonly service: string
  readonly reason: MasterKeyUnavailableReason
  constructor(service: string, reason: MasterKeyUnavailableReason) {
    super(uiError(UI.rpcMasterKeyUnavailable).message)
    this.name = 'MasterKeyUnavailableError'
    this.service = service
    this.reason = reason
  }
}

/** Type guard di MasterKeyUnavailableError (i confini RPC lo lasciano passare). */
export function isMasterKeyUnavailableError(e: unknown): e is MasterKeyUnavailableError {
  return e instanceof MasterKeyUnavailableError
}

// ---- backend safeStorage iniettabile ----

let backend: SafeStorageLike | null = null

/** Registra il backend safeStorage (daemon Electron: quello vero; test: il finto); null lo rimuove. */
export function setMasterKeyStorage(s: SafeStorageLike | null): void {
  backend = s
}

/** La callback «esistono dati sigillati per questo servizio?» del daemon (K1.3). */
let sealedDataProbe: ((service: string) => boolean | Promise<boolean>) | null = null

/** Registra la sonda dei dati sigillati (il daemon la cabla a DB/settings; test: deps.hasSealedData). */
export function setMasterKeySealedDataProbe(probe: ((service: string) => boolean | Promise<boolean>) | null): void {
  sealedDataProbe = probe
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

// ---- K1.1: serializzazione — una lock per servizio, una per il file ----

/** In-flight per servizio: il primo chiamante migra/genera, gli altri ricevono lo STESSO risultato. */
const serviceLocks = new Map<string, Promise<Buffer>>()

function withServiceLock(service: string, fn: () => Promise<Buffer>): Promise<Buffer> {
  const inflight = serviceLocks.get(service)
  if (inflight) return inflight
  const p = fn().finally(() => {
    if (serviceLocks.get(service) === p) serviceLocks.delete(service)
  })
  serviceLocks.set(service, p)
  return p
}

/** Scritture di keys.json serializzate ANCHE fra servizi diversi (read-modify-write mai sovrapposti). */
let keysFileChain: Promise<unknown> = Promise.resolve()

function serializeKeysWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = keysFileChain.then(fn, fn)
  keysFileChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

// ---- cifratura delle chiavi (base64 della chiave dentro l'envelope) ----

/**
 * K1.7: Electron 45 fornisce le varianti ASINCRONE (le sincrone sono
 * deprecate e avvisano nel log); si usano quando ci sono, altrimenti quelle
 * del backend iniettato (che può già restituire Promise).
 */
interface StorageWithAsync extends SafeStorageLike {
  isAsyncEncryptionAvailable?(): Promise<boolean>
  encryptStringAsync?(plain: string): Promise<Buffer>
  decryptStringAsync?(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>
}

async function storageAvailable(storage: SafeStorageLike): Promise<boolean> {
  const asyncAvail = (storage as StorageWithAsync).isAsyncEncryptionAvailable
  if (typeof asyncAvail === 'function') return asyncAvail.call(storage)
  return storage.isEncryptionAvailable()
}

async function sealKey(storage: SafeStorageLike, key: Buffer): Promise<string> {
  const enc = (storage as StorageWithAsync).encryptStringAsync
  const sealed = typeof enc === 'function'
    ? await enc.call(storage, key.toString('base64'))
    : await storage.encryptString(key.toString('base64'))
  return sealed.toString('base64')
}

async function unsealKey(storage: SafeStorageLike, sealed: string): Promise<Buffer> {
  const dec = (storage as StorageWithAsync).decryptStringAsync
  const b64 = typeof dec === 'function'
    ? (await dec.call(storage, Buffer.from(sealed, 'base64'))).result
    : await storage.decryptString(Buffer.from(sealed, 'base64'))
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
  /** K1.3: «esistono dati sigillati per questo servizio?» (default: la sonda del daemon) */
  hasSealedData?: (service: string) => boolean | Promise<boolean>
}

/**
 * L'unica strada per una chiave master (A6 + K1): keys.json se leggibile;
 * altrimenti la voce del Portachiavi vecchio in SOLA LETTURA (migrazione
 * solo quando keys.json non ha proprio l'entry); generazione SOLO alla prima
 * occorrenza, cioè quando non c'è né entry, né voce, né dato sigillato.
 * Una chiave esistente non si sostituisce MAI: se non si riesce a leggerla
 * si lancia MasterKeyUnavailableError (il testo arriva alla UI).
 */
export async function getMasterKey(service: string, deps: MasterKeyDeps = {}): Promise<Buffer> {
  // K1.6: senza backend registrato la chiamata viene dal processo UI (o da un
  // test senza setMasterKeyStorage): errore di PROGRAMMAZIONE, nessun ripiego
  // sul Portachiavi, nessuna chiamata al runner.
  if (deps.storage === undefined && backend === null) {
    throw new Error(
      `[master-keys] getMasterKey(${service}) called without a safeStorage backend: only the daemon may touch master keys (programming error)`
    )
  }
  const storage = deps.storage !== undefined ? deps.storage : backend
  return withServiceLock(service, () => getMasterKeyLocked(service, storage, deps))
}

async function getMasterKeyLocked(service: string, storage: SafeStorageLike | null, deps: MasterKeyDeps): Promise<Buffer> {
  const dir = deps.dir ?? dataDir()
  const warn = deps.warn ?? ((m) => console.warn(m))
  const hasSealedData = deps.hasSealedData ?? sealedDataProbe ?? (() => false)
  const path = keysPath(dir)
  const available = storage !== null && (await storageAvailable(storage))
  // K1.1: dentro la lock si RILEGGE keys.json (il primo chiamante ha già scritto)
  const file = existsSync(path) ? readKeysFile(path) : null
  const entry = file && typeof file[service] === 'string' ? (file[service] as string) : null

  // 1. entry presente e leggibile → è la chiave, il Portachiavi non si tocca
  if (entry && available && storage) {
    try {
      const key = await unsealKey(storage, entry)
      if (isFreshKey(key)) return key
      warn(`[master-keys] entry ${service} in keys.json is not a 32-byte key: trying the old Keychain item (read-only)`)
    } catch {
      warn(`[master-keys] entry ${service} not decryptable in keys.json: trying the old Keychain item (read-only)`)
    }
  } else if (entry && !available) {
    warn('[master-keys] safeStorage unavailable: the keys.json entry cannot be decrypted')
  }

  // 2. la voce del Portachiavi vecchio, in SOLA LETTURA: la si usa così com'è
  //    (migrazione solo se keys.json non ha l'entry: un'entry illeggibile non
  //    si tocca MAI — scrivere sopra è l'incidente di K1)
  const old = await readKeychainKey(service, deps.run)
  if (old) {
    if (!entry && available && storage) return migrateKeychainKey(service, old, storage, path, deps, warn)
    return old // niente scritture, niente perdite: si riprova al prossimo avvio
  }

  // 3. niente entry e niente voce: o c'è qualcosa di sigillato (MAI generare:
  //    sarebbe una chiave sopra dati illeggibili per sempre), o manca lo
  //    storage (dopo la 0.3 nessuna chiave master nasce con `security`), o è
  //    davvero la prima volta
  if (await hasSealedData(service)) {
    warn(`[master-keys] sealed data exists for ${service} but no key is recoverable: refusing to generate a new master key`)
    throw new MasterKeyUnavailableError(service, entry ? 'entry-unreadable' : available ? 'sealed-data' : 'storage-unavailable')
  }
  if (entry) {
    // entry illeggibile senza voce nel Portachiavi: non si sovrascrive (Rakazo)
    warn(`[master-keys] entry ${service} unreadable and no old Keychain item: refusing to touch keys.json`)
    throw new MasterKeyUnavailableError(service, 'entry-unreadable')
  }
  if (!available || !storage) {
    warn(`[master-keys] safeStorage unavailable and no old Keychain item for ${service}: no master key can be created`)
    throw new MasterKeyUnavailableError(service, 'storage-unavailable')
  }
  return generateFreshKey(service, storage, path, warn)
}

/**
 * Migrazione della voce del Portachiavi vecchio (chiamata SOLO senza entry in
 * keys.json): cifra → scrive → RILEGGI e confronta → solo allora cancella la
 * voce; dopo la cancellazione si RILEGGE l'esistenza e il log dice il VERO
 * (K1.5). Se qualcosa fallisce resta tutto com'era e la chiave si continua a
 * leggere dal Portachiavi.
 */
async function migrateKeychainKey(
  service: string,
  old: Buffer,
  storage: SafeStorageLike,
  path: string,
  deps: MasterKeyDeps,
  warn: (msg: string) => void
): Promise<Buffer> {
  return serializeKeysWrite(async () => {
    // K1.1: rilettura dentro la serializzazione del file (un altro servizio
    // può aver scritto keys.json nel frattempo)
    const current = existsSync(path) ? readKeysFile(path) : null
    const already = current && typeof current[service] === 'string' ? (current[service] as string) : null
    if (already) {
      try {
        const key = await unsealKey(storage, already)
        if (isFreshKey(key)) return key // comparsa nel frattempo: si usa quella
      } catch {
        // si migra sotto: l'entry comparsa non decifra
      }
    }
    const next: KeysFile = { ...(current ?? { version: 1 }), [service]: await sealKey(storage, old) }
    try {
      writeKeysFileAtomic(path, next)
      const reread = readKeysFile(path)
      const back = reread && typeof reread[service] === 'string' ? await unsealKey(storage, reread[service] as string) : null
      if (!back || !back.equals(old)) {
        warn(`[master-keys] migration verify failed for ${service}: the old Keychain item stays in place`)
        return old // niente perdite: si continua col Portachiavi finché non riesce
      }
    } catch (e) {
      warn(`[master-keys] migration of ${service} deferred to the next start: ${e instanceof Error ? e.message : 'error'}`)
      return old
    }
    // K1.5: il codice d'uscita di delete non basta — si RILEGGE l'esistenza
    await deleteKeychainKey(service, deps.run)
    const still = await readKeychainKey(service, deps.run)
    if (still) warn(`[master-keys] ${service} migrated but the old Keychain item is still present: will retry at the next start`)
    else warn(`[master-keys] ${service} migrated: the old Keychain item was removed`)
    return old
  })
}

/** Prima generazione (K1.3): solo quando mancano entry, voce e dati sigillati. Scrittura VERIFICATA. */
async function generateFreshKey(service: string, storage: SafeStorageLike, path: string, warn: (msg: string) => void): Promise<Buffer> {
  return serializeKeysWrite(async () => {
    const key = randomBytes(32)
    const current = existsSync(path) ? readKeysFile(path) : null
    try {
      writeKeysFileAtomic(path, { ...(current ?? { version: 1 }), [service]: await sealKey(storage, key) })
      // la verifica evita lo stato «generata ma illeggibile»: una chiave
      // restituita e poi persa sigillerebbe dati che nessuno rilegge più
      const reread = readKeysFile(path)
      const back = reread && typeof reread[service] === 'string' ? await unsealKey(storage, reread[service] as string) : null
      if (!back || !back.equals(key)) {
        warn(`[master-keys] generated key for ${service} did not verify in keys.json: refusing to use it`)
        throw new MasterKeyUnavailableError(service, 'write-failed')
      }
      return key
    } catch (e) {
      if (isMasterKeyUnavailableError(e)) throw e
      warn(`[master-keys] could not write keys.json for ${service}: ${e instanceof Error ? e.message : 'error'}`)
      throw new MasterKeyUnavailableError(service, 'write-failed')
    }
  })
}

/**
 * Mette una chiave GIÀ ESISTENTE in keys.json (migrazione del setting legacy
 * del vault, fasi 1–5): cifra, scrive, RILEGGE e confronta. True solo se la
 * chiave ora è leggibile da keys.json.
 */
export async function saveMasterKey(service: string, key: Buffer, deps: MasterKeyDeps = {}): Promise<boolean> {
  const storage = deps.storage !== undefined ? deps.storage : backend
  if (!storage || !(await storageAvailable(storage)) || !isFreshKey(key)) return false
  const dir = deps.dir ?? dataDir()
  const path = keysPath(dir)
  // K1.1: anche questa strada scrive keys.json → serializzata con le altre
  return serializeKeysWrite(async () => {
    const file = existsSync(path) ? readKeysFile(path) : null
    // una voce che c'è già e decifra vince: un'entry LEGGIBILE non si
    // sostituisce mai con un'altra chiave (K1); si ripara solo quella
    // illeggibile, con la chiave reale che si sta salvando
    if (file && typeof file[service] === 'string') {
      try {
        return (await unsealKey(storage, file[service] as string)).equals(key)
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
  })
}
