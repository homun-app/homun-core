// Credential vault — AES-256-GCM con lo stesso envelope "sealed" dell'originale
// (sandVault: iv||authTag||ciphertext).
//
// §5.6: la chiave master vive in electron safeStorage (cifrata con la chiave di
// sistema dell'OS e salvata nei settings): non sta mai in chiaro su disco col
// dato e non passa mai dall'argv di un processo (il vecchio
// `security add-generic-password -w <chiave>` la esponeva a `ps`).
// Migrazione automatica dalla chiave Keychain pre-esistente: la si legge con
// find-generic-password (il valore esce sullo stdout del processo, non
// dall'argv), la si porta in safeStorage e la si elimina dal Keychain.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { execFile } from 'node:child_process'
import { safeStorage } from 'electron'
import { getSetting, setSetting } from './store/db'

const KEYCHAIN_SERVICE = 'sandbot-vault-key'
const KEYCHAIN_ACCOUNT = 'sandbot'
/** base64(safeStorage.encryptString(base64(chiave))) */
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

function sh(args: string[]): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile('security', args, { timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ out: String(stdout ?? ''), err: String(stderr ?? ''), code: err ? 1 : 0 })
    })
  })
}

/** Chiave legacy dal Keychain (nessun segreto nell'argv). */
async function readLegacyKeychainKey(): Promise<Buffer | null> {
  const found = await sh(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'])
  if (found.code === 0 && found.out.trim()) return Buffer.from(found.out.trim(), 'base64')
  return null
}

async function deleteLegacyKeychainKey(): Promise<void> {
  await sh(['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE])
}

/** Salva la chiave cifrata con safeStorage; false se safeStorage non è disponibile. */
function storeKeyViaSafeStorage(key: Buffer): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  setSetting(KEY_SETTING, safeStorage.encryptString(key.toString('base64')).toString('base64'))
  return true
}

async function getMasterKey(): Promise<Buffer> {
  // 1. chiave già cifrata con safeStorage (o migrata in passato)
  const enc = getSetting<string | null>(KEY_SETTING, null)
  if (enc) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Vault non leggibile: safeStorage non disponibile su questo sistema')
    }
    return Buffer.from(safeStorage.decryptString(Buffer.from(enc, 'base64')), 'base64')
  }
  // 2. migrazione dalla chiave Keychain esistente (stesso formato base64)
  const legacy = await readLegacyKeychainKey()
  if (legacy) {
    if (storeKeyViaSafeStorage(legacy)) await deleteLegacyKeychainKey()
    // se safeStorage non c'è, si continua a usare la chiave legacy letta dal Keychain
    return legacy
  }
  // 3. prima generazione
  const key = randomBytes(32)
  if (!storeKeyViaSafeStorage(key)) {
    throw new Error('Vault non disponibile: impossibile cifrare la chiave master con safeStorage')
  }
  return key
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
