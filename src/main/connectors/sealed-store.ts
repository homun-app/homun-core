// Persistenza CIFRATA dei segreti per server MCP (fase 5): token OAuth,
// client information, code verifier, bearer token e header statici. Ogni
// campo è un envelope AES-256-GCM (iv||authTag||ciphertext, lo stesso formato
// "sealed" del vault) cifrato con la chiave del Keychain (daemon/keychain.ts):
// nei settings non finisce MAI un valore in chiaro, e il daemon li decifra
// anche a finestra chiusa (safeStorage non basta, vedi keychain.ts).
//
// Modulo a dipendenze iniettabili (chiave, settings) per i test puri.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

/** Envelope cifrato di un campo (stesso formato del vault). */
export interface Sealed {
  sandVault: 1
  data: string // base64(iv(12) || authTag(16) || ciphertext)
}

/** Campo segreto di un server MCP, indicizzato per nome. */
type ServerSecrets = Record<string, Sealed>

export interface ConnectorsSecretStore {
  read<T>(serverId: string, field: string): Promise<T | undefined>
  write(serverId: string, field: string, value: unknown): Promise<void>
  remove(serverId: string, fields: string[]): Promise<void>
  removeAll(serverId: string): Promise<void>
}

export interface SecretStoreDeps {
  /** Chiave AES-256 (32 byte) — nel daemon viene dal Keychain macOS. */
  getKey(): Promise<Buffer>
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
}

const SETTING = 'connectors.secrets'

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { sandVault: 1, data: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64') }
}

function unseal(key: Buffer, s: Sealed): string {
  const raw = Buffer.from(s.data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

function secrets(deps: SecretStoreDeps): Record<string, ServerSecrets> {
  return deps.getSetting<Record<string, ServerSecrets>>(SETTING, {})
}

/**
 * Store cifrato per server. Ogni campo viene serializzato in JSON e cifrato
 * singolarmente: aggiornare i token non tocca il client information.
 */
export function createConnectorsSecretStore(deps: SecretStoreDeps): ConnectorsSecretStore {
  return {
    async read<T>(serverId: string, field: string): Promise<T | undefined> {
      const sealed = secrets(deps)[serverId]?.[field]
      if (!sealed || sealed.sandVault !== 1) return undefined
      return JSON.parse(unseal(await deps.getKey(), sealed)) as T
    },
    async write(serverId: string, field: string, value: unknown): Promise<void> {
      const all = secrets(deps)
      const per: ServerSecrets = { ...(all[serverId] ?? {}) }
      per[field] = seal(await deps.getKey(), JSON.stringify(value ?? null))
      deps.setSetting(SETTING, { ...all, [serverId]: per })
    },
    async remove(serverId: string, fields: string[]): Promise<void> {
      const all = secrets(deps)
      const per = { ...(all[serverId] ?? {}) }
      for (const f of fields) delete per[f]
      if (Object.keys(per).length) deps.setSetting(SETTING, { ...all, [serverId]: per })
      else {
        const rest = { ...all }
        delete rest[serverId]
        deps.setSetting(SETTING, rest)
      }
    },
    async removeAll(serverId: string): Promise<void> {
      const all = secrets(deps)
      const rest = { ...all }
      delete rest[serverId]
      deps.setSetting(SETTING, rest)
    }
  }
}
