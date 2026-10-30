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

// Fase 17b correzioni (B2): MU — lo vede il modello nei result di
// save_contact/fill_credential e può vederlo l'utente; per il modello va in
// inglese, la parte di display la sistema la 17c.
export const VAULT_LOCKED_MSG = 'Vault locked: safeStorage not available (open the Homun window to use credentials)'

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

/** Una voce del vault delle fasi 1-13: un segreto per i comandi ({{secret:NOME}}). */
interface StoredSecret {
  name: string
  sealed: Sealed
  createdAt: number
}

/**
 * Fase 14 (punto 7b): il vault ha TRE tipi. Ogni valore serve SOLO allo scopo
 * del suo tipo: la password di un login non entra in un comando e un secret
 * non entra in un campo del browser.
 * - secret: quelli di oggi, per l'env dei comandi;
 * - login: origini esatte + utente + password + TOTP facoltativo, SOLO per il
 *   fill del browser (i valori escono dal modulo solo verso fill_credential);
 * - contact: dati personali VISIBILI al modello (servono a scrivere bozze).
 * Login e contatti stanno in settings CIFRATI: nel file non ci sono valori in
 * chiaro, nemmeno username o email.
 */
export interface StoredLogin {
  id: string
  label: string
  /** origini esatte https://host[:porta], nessun carattere jolly */
  origins: string[]
  /** AES-256-GCM su {username, password, totp?} */
  sealed: Sealed
  createdAt: number
  updatedAt: number
}

export interface StoredContact {
  id: string
  /** il nome sta in chiaro: è la chiave di ricerca e non è un segreto */
  name: string
  /** AES-256-GCM su {emails, phones, address, notes} */
  sealed: Sealed
  createdAt: number
  updatedAt: number
}

/** Un login decifrato: esce da questo modulo SOLO verso il fill (7d). */
export interface VaultLogin {
  id: string
  label: string
  origins: string[]
  username: string
  password: string
  totp?: string
}

/** Un contatto decifrato (visibile al modello, per find_contacts). */
export interface VaultContact {
  id: string
  name: string
  emails: string[]
  phones: string[]
  address?: string
  notes?: string
}

/** L'origine esatta https://host[:porta] (puro, punto 7b): niente wildcard. */
export function validHttpsOrigin(origin: string): boolean {
  if (!/^https:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(origin)) return false
  if (origin.includes('*')) return false
  try {
    const u = new URL(origin)
    return u.origin === origin || `https://${u.host}` === origin
  } catch {
    return false
  }
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
    throw new Error('Vault locked: Keychain not available (cannot store the master key)')
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
  if (!s) throw new Error(`credential "${name}" not present in the vault`)
  const key = await getMasterKey()
  return unseal(key, s.sealed)
}

export function listSecretNames(): string[] {
  return secrets().map((s) => s.name)
}

export function deleteSecret(name: string): void {
  setSetting('vault.secrets', secrets().filter((s) => s.name !== name))
}

// ---- fase 14 (punto 7b): login e contatti, cifrati a riposo ----

function logins(): StoredLogin[] {
  return getSetting<StoredLogin[]>('vault.logins', [])
}

function contacts(): StoredContact[] {
  return getSetting<StoredContact[]>('vault.contacts', [])
}

function newVaultId(prefix: 'login' | 'contact'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`
}

/** Una voce del vault come la vede la UI e list-credentials (SENI valori). */
export type VaultItemInfo =
  | { kind: 'secret'; name: string; createdAt: number }
  | { kind: 'login'; id: string; label: string; origins: string[]; hasTotp: boolean; createdAt: number }
  | { kind: 'contact'; id: string; name: string; createdAt: number }

/** listVaultItems (punto 7b): tutto il vault, MAI i valori (hasTotp decifra ma esce solo il booleano). */
export async function listVaultItems(): Promise<VaultItemInfo[]> {
  const key = await getMasterKey()
  const loginInfos = logins().map((l) => {
    let hasTotp = false
    try {
      hasTotp = !!(JSON.parse(unseal(key, l.sealed)) as { totp?: string }).totp
    } catch {
      hasTotp = false
    }
    return { kind: 'login' as const, id: l.id, label: l.label, origins: [...l.origins], hasTotp, createdAt: l.createdAt }
  })
  return [
    ...secrets().map((s) => ({ kind: 'secret' as const, name: s.name, createdAt: s.createdAt })),
    ...loginInfos,
    ...contacts().map((c) => ({ kind: 'contact' as const, id: c.id, name: c.name, createdAt: c.createdAt }))
  ]
}

/**
 * saveLogin (punto 7b + P4 fase 14 correzioni): origini ESATTE
 * https://host[:porta] (niente wildcard), utente, password e TOTP facoltativo;
 * il tutto cifrato in un solo envelope. Torna l'id (label e origini si
 * possono aggiornare: stesso id).
 * P4: il segreto TOTP si accetta SOLO base32 valido (spazi e minuscole
 * ammessi) o come URI otpauth://totp/…?secret=… — si normalizza (maiuscole,
 * senza spazi né padding) e si VERIFICA con base32Decode PRIMA di cifrarlo:
 * un segreto sbagliato faceva lanciare totpCode DURANTE il fill, dopo che
 * utente e password erano già stati scritti. L'errore non contiene mai il
 * valore (va all'utente nel modulo, non al modello).
 */
export async function saveLogin(input: {
  id?: string
  label: string
  origins: string[]
  username: string
  password: string
  totp?: string
}): Promise<string> {
  const label = input.label.trim()
  if (!label) throw new Error('a label is required for the login')
  const origins = [...new Set(input.origins.map((o) => o.trim()).filter(Boolean))]
  if (!origins.length) throw new Error('at least one https://host origin is required (e.g. https://app.example.com)')
  const bad = origins.filter((o) => !validHttpsOrigin(o))
  if (bad.length) throw new Error(`invalid origins (exact https://host[:port] form required, no wildcards): ${bad.join(', ')}`)
  if (!input.username) throw new Error('the login username is required')
  if (!input.password) throw new Error('the login password is required')
  let totp: string | undefined
  if (input.totp !== undefined && input.totp.trim() !== '') {
    const { parseTotpSecret } = await import('./agent/credentials')
    const check = parseTotpSecret(input.totp)
    if (!check.ok) throw new Error(check.error)
    totp = check.secret
  }
  const key = await getMasterKey()
  const now = Date.now()
  const id = input.id ?? newVaultId('login')
  const sealed = seal(key, JSON.stringify({ username: input.username, password: input.password, ...(totp ? { totp } : {}) }))
  const list = logins().filter((l) => l.id !== id)
  list.push({ id, label, origins, sealed, createdAt: logins().find((l) => l.id === id)?.createdAt ?? now, updatedAt: now })
  setSetting('vault.logins', list)
  return id
}

/**
 * getLoginForFill (punto 7d): l'UNICA strada per cui i valori di un login
 * escono dal modulo — la chiama il daemon per compilare i campi della pagina.
 */
export async function getLoginForFill(id: string): Promise<VaultLogin> {
  const l = logins().find((x) => x.id === id)
  if (!l) throw new Error(`login "${id}" not present in the vault`)
  const key = await getMasterKey()
  const data = JSON.parse(unseal(key, l.sealed)) as { username: string; password: string; totp?: string }
  return { id: l.id, label: l.label, origins: [...l.origins], username: data.username, password: data.password, ...(data.totp ? { totp: data.totp } : {}) }
}

/** Tutti i login (senza valori, con hasTotp VERO) per la UI e list-credentials. */
export async function listLogins(): Promise<Array<{ id: string; label: string; origins: string[]; hasTotp: boolean; createdAt: number; updatedAt: number }>> {
  const key = await getMasterKey()
  return logins().map((l) => {
    let hasTotp = false
    try {
      hasTotp = !!(JSON.parse(unseal(key, l.sealed)) as { totp?: string }).totp
    } catch {
      hasTotp = false
    }
    return { id: l.id, label: l.label, origins: [...l.origins], hasTotp, createdAt: l.createdAt, updatedAt: l.updatedAt }
  })
}

/** saveContact (punto 7f): dati VISIBILI al modello ma cifrati a riposo. */
export async function saveContact(input: {
  id?: string
  name: string
  emails?: string[]
  phones?: string[]
  address?: string
  notes?: string
}): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error('the contact name is required')
  const key = await getMasterKey()
  const now = Date.now()
  const id = input.id ?? newVaultId('contact')
  const sealed = seal(key, JSON.stringify({
    emails: (input.emails ?? []).map((e) => e.trim()).filter(Boolean),
    phones: (input.phones ?? []).map((p) => p.trim()).filter(Boolean),
    ...(input.address ? { address: input.address } : {}),
    ...(input.notes ? { notes: input.notes } : {})
  }))
  const list = contacts().filter((c) => c.id !== id)
  list.push({ id, name, sealed, createdAt: contacts().find((c) => c.id === id)?.createdAt ?? now, updatedAt: now })
  setSetting('vault.contacts', list)
  return id
}

/** getContact (punto 7b): il contatto decifrato (visibile al modello). */
export async function getContact(id: string): Promise<VaultContact | null> {
  const c = contacts().find((x) => x.id === id)
  if (!c) return null
  const key = await getMasterKey()
  const data = JSON.parse(unseal(key, c.sealed)) as { emails?: string[]; phones?: string[]; address?: string; notes?: string }
  return {
    id: c.id, name: c.name,
    emails: data.emails ?? [], phones: data.phones ?? [],
    ...(data.address ? { address: data.address } : {}),
    ...(data.notes ? { notes: data.notes } : {})
  }
}

/**
 * searchContacts (punto 7f): fino a 10 risultati per query (nome, email,
 * telefono, note); i valori sono VISIBILI al modello — servono a scrivere
 * bozze, che passano comunque da draft_external.
 */
export async function searchContacts(query: string): Promise<VaultContact[]> {
  const q = query.trim().toLowerCase()
  const key = await getMasterKey()
  const out: VaultContact[] = []
  for (const c of contacts()) {
    const data = JSON.parse(unseal(key, c.sealed)) as { emails?: string[]; phones?: string[]; address?: string; notes?: string }
    const contact: VaultContact = {
      id: c.id, name: c.name, emails: data.emails ?? [], phones: data.phones ?? [],
      ...(data.address ? { address: data.address } : {}),
      ...(data.notes ? { notes: data.notes } : {})
    }
    const haystack = [contact.name, ...contact.emails, ...contact.phones, contact.address ?? '', contact.notes ?? ''].join(' ').toLowerCase()
    if (!q || haystack.includes(q)) out.push(contact)
    if (out.length >= 10) break
  }
  return out
}

/** deleteVaultItem (punto 7b): cancella secret, login o contatto (dalla UI). */
export function deleteVaultItem(kind: 'secret' | 'login' | 'contact', key: string): boolean {
  if (kind === 'secret') {
    const before = secrets().length
    setSetting('vault.secrets', secrets().filter((s) => s.name !== key))
    return secrets().length < before
  }
  if (kind === 'login') {
    const before = logins().length
    setSetting('vault.logins', logins().filter((l) => l.id !== key))
    return logins().length < before
  }
  const before = contacts().length
  setSetting('vault.contacts', contacts().filter((c) => c.id !== key))
  return contacts().length < before
}
