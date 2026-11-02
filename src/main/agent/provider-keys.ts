// Fase 16c (C1): le chiavi API dei provider CIFRATE a riposo. Stesso schema
// dei connettori e del vault: una chiave AES-256 in una voce del Keychain
// PROPRIA (`sandbot-providers-key`, separata dalle altre), il dato cifrato
// nell'envelope "sealed" (iv||authTag||ciphertext) dentro il setting
// 'providers'; il chiaro vive SOLO in memoria nel daemon. Il modulo è puro
// (dipendenze iniettate), il Keychain non si tocca qui.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

/** Envelope cifrato di una chiave API (stesso formato di sealed-store/vault). */
export interface SealedKey {
  sandVault: 1
  data: string // base64(iv(12) || authTag(16) || ciphertext)
}

/** Dipendenze per cifrare/decifrare (nei test: chiave fissa; nel daemon: Keychain). */
export interface ProviderKeyDeps {
  getKey(): Promise<Buffer>
}

export function isSealedKey(v: unknown): v is SealedKey {
  return !!v && typeof v === 'object' && (v as { sandVault?: unknown }).sandVault === 1 &&
    typeof (v as { data?: unknown }).data === 'string' && (v as { data: string }).data.length > 0
}

export async function sealProviderKey(deps: ProviderKeyDeps, plaintext: string): Promise<SealedKey> {
  const key = await deps.getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { sandVault: 1, data: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64') }
}

export async function openProviderKey(deps: ProviderKeyDeps, sealed: SealedKey): Promise<string> {
  const key = await deps.getKey()
  const raw = Buffer.from(sealed.data, 'base64')
  if (raw.length <= 28) throw new Error('sealed key troppo corta')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

/** Gli ultimi 4 caratteri della chiave, per il suggerimento «…a1b2» in UI. */
export function keyHintOf(key: string): string {
  return '…' + key.slice(-4)
}
