// Credential vault — AES-256-GCM con lo stesso envelope "sealed" dell'originale
// (sand-sealedFile: iv||authTag||ciphertext). La chiave NON sta su disco col dato:
// vive nel Keychain macOS via `security`.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { execFile } from 'node:child_process'
import { getSetting, setSetting } from './store/db'

const KEYCHAIN_SERVICE = 'sandbot-vault-key'
const KEYCHAIN_ACCOUNT = 'sandbot'

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

async function getMasterKey(): Promise<Buffer> {
  const found = await sh(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'])
  if (found.code === 0 && found.out.trim()) return Buffer.from(found.out.trim(), 'base64')
  const key = randomBytes(32)
  const add = await sh(['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', key.toString('base64'), '-U'])
  if (add.code !== 0) throw new Error('Keychain non disponibile: ' + add.err.trim())
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
