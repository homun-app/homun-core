// Credential vault — AES-256-GCM con lo stesso envelope "sealed" dell'originale
// (sandVault: iv||authTag||ciphertext).
//
// Fase 6 (residuo 0b): la chiave master vive nel Keychain macOS con lo stesso
// meccanismo dei connettori (src/daemon/keychain.ts: comandi `security -i` da
// stdin, mai nell'argv di un processo), in una voce SEPARATA
// (sandbot-vault-key). Le routine girano a finestra chiusa e un comando con
// {{secret:NOME}} non deve più fallire perché safeStorage senza UI è bloccato.
// Migrazione automatica: se esiste ancora la chiave cifrata con safeStorage
// (setting vault.masterKeySafe, fasi 1–5), la UI appena aperta la decifra via
// HostBridge, il daemon la porta nel Keychain e rimuove il setting.
// Nessuna chiave in chiaro su disco, mai nell'argv di un processo.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { getSetting, setSetting, deleteSetting } from './store/db'
import { getKeychainKey, readKeychainKey, writeKeychainKey, VAULT_SERVICE, type SecurityRunner } from '../daemon/keychain'

/** Subset di electron.safeStorage che serve al vault (encrypt/decrypt possono essere async nel daemon: passano dall'RPC). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer | Promise<Buffer>
  decryptString(encrypted: Buffer): string | Promise<string>
}

export const VAULT_LOCKED_MSG = 'Vault bloccato: safeStorage non disponibile (apri la finestra di SandBot per usare le credenziali)'

let storage: SafeStorageLike | null = null
/** Runner `security` del Keychain, iniettabile per i test. */
let keychainRun: SecurityRunner | undefined

/** Registra il backend safeStorage (main Electron o proxy RPC del daemon); null lo rimuove. */
export function setSafeStorage(s: SafeStorageLike | null): void {
  storage = s
}

/** Registra il runner `security` del Keychain (test); senza si usa quello reale. */
export function setVaultKeychainRunner(run: SecurityRunner | undefined): void {
  keychainRun = run
}

function safe(): SafeStorageLike {
  if (!storage || !storage.isEncryptionAvailable()) throw new Error(VAULT_LOCKED_MSG)
  return storage
}

/** base64(safeStorage.encryptString(base64(chiave))) — chiave delle fasi 1–5, da migrare. */
const KEY_SETTING = 'vault.masterKeySafe'

interface Sealed {
  sandVault: 1
  data: string // base64(iv(12) || authTag(16) || ciphertext)
}

interface StoredSecret {
  name: string
  sealed: Sealed
  createdAt: number
}

/**
 * Migrazione della chiave safeStorage → Keychain: possibile solo con la UI
 * aperta (la decifratura passa dall'HostBridge). True se la chiave ora sta
 * nel Keychain (c'era già o la migrazione è riuscita).
 */
export async function migrateVaultKeyToKeychain(): Promise<boolean> {
  if (await readKeychainKey(VAULT_SERVICE, keychainRun)) return true
  const enc = getSetting<string | null>(KEY_SETTING, null)
  if (!enc) return false
  try {
    const key = Buffer.from(await safe().decryptString(Buffer.from(enc, 'base64')), 'base64')
    if (key.length !== 32) return false
    if (!(await writeKeychainKey(VAULT_SERVICE, key, keychainRun))) return false
    deleteSetting(KEY_SETTING)
    return true
  } catch {
    // safeStorage non disponibile (finestra chiusa): la migrazione si riprova
    // alla prossima apertura; nel frattempo il vault resta bloccato come prima
    return false
  }
}

async function getMasterKey(): Promise<Buffer> {
  // 1. chiave già nel Keychain
  const inKeychain = await readKeychainKey(VAULT_SERVICE, keychainRun)
  if (inKeychain) return inKeychain
  // 2. chiave legacy cifrata con safeStorage (fasi 1–5): si DEVE riutilizzare
  //    quella — generarne una nuova renderebbe i segreti esistenti
  //    indecifrabili. Serve la UI (decifratura via HostBridge); appena
  //    riesce, la chiave passa nel Keychain e il setting viene rimosso
  const enc = getSetting<string | null>(KEY_SETTING, null)
  if (enc) {
    const key = Buffer.from(await safe().decryptString(Buffer.from(enc, 'base64')), 'base64')
    if (await writeKeychainKey(VAULT_SERVICE, key, keychainRun)) deleteSetting(KEY_SETTING)
    return key
  }
  // 3. prima generazione: chiave nuova nel Keychain (funziona anche senza UI)
  try {
    return await getKeychainKey(VAULT_SERVICE, keychainRun)
  } catch {
    throw new Error('Vault bloccato: Keychain non disponibile (impossibile conservare la chiave master)')
  }
}

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { sandVault: 1, data: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64') }
}

function unseal(key: Buffer, s: Sealed): string {
  const raw = Buffer.from(s.data, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ct = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

function secrets(): StoredSecret[] {
  return getSetting<StoredSecret[]>('vault.secrets', [])
}

export async function storeSecret(name: string, value: string): Promise<void> {
  const key = await getMasterKey()
  const list = secrets().filter((s) => s.name !== name)
  list.push({ name, sealed: seal(key, value), createdAt: Date.now() })
  setSetting('vault.secrets', list)
}

export async function revealSecret(name: string): Promise<string> {
  const s = secrets().find((x) => x.name === name)
  if (!s) throw new Error(`credenziale "${name}" non presente nel vault`)
  const key = await getMasterKey()
  return unseal(key, s.sealed)
}

export function listSecretNames(): string[] {
  return secrets().map((s) => s.name)
}

export function deleteSecret(name: string): void {
  setSetting('vault.secrets', secrets().filter((s) => s.name !== name))
}
