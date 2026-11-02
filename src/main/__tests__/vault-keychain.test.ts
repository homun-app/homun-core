// Test del vault con la chiave master (fase 6 → fase rilascio A6 + K1): la
// chiave vive in keys.json cifrata con safeStorage; il daemon usa le
// credenziali anche a finestra chiusa. Runner `security` finto in memoria
// (serve solo alla migrazione dalla voce vecchia). Store reale su directory
// temporanea, safeStorage finta per la migrazione.
// FASE RILASCIO — CORREZIONI (K1): senza backend registrato il vault resta
// BLOCCATO (errore di programmazione: solo il daemon tocca le chiavi) e dopo
// la 0.3 nessuna chiave master nasce più nel Portachiavi.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv } from 'node:crypto'

// cartelle temporanee SOLO con mkdtemp nella directory fissata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

const { setDataDir, dataDir, db, getSetting, setSetting } = await import('../store/db')
const vault = await import('../vault')
const { VAULT_SERVICE, CONNECTORS_SERVICE } = await import('../../daemon/keychain')
// fase rilascio (A6): le chiavi master vivono in keys.json cifrate con
// safeStorage — il backend del test si registra qui
const masterKeys = await import('../../daemon/master-keys')
import type { SecurityRunner } from '../../daemon/keychain'

/**
 * Runner `security` finto: un Keychain in memoria per servizio. Registra ogni
 * chiamata {args, input} così i test possono verificare che il VALORE della
 * chiave non passi mai dagli argv (solo da stdin, nei comandi `security -i`).
 */
function fakeKeychain(opts: { failWrites?: boolean } = {}) {
  const store = new Map<string, string>()
  const calls: Array<{ args: string[]; input?: string }> = []
  const run: SecurityRunner = async (args, input) => {
    calls.push({ args, input })
    if (args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1]
      const v = store.get(svc!)
      return v ? { out: v + '\n', err: '', code: 0 } : { out: '', err: 'not found', code: 1 }
    }
    if (args[0] === '-i') {
      if (opts.failWrites) return { out: '', err: 'keychain non disponibile', code: 1 }
      const line = String(input ?? '').split('\n')[0] ?? ''
      const svc = line.split(' -s ')[1]?.split(' ')[0]
      const val = line.split(' -w ')[1]?.split(' ')[0]
      if (svc && val) {
        store.set(svc, val)
        return { out: '', err: '', code: 0 }
      }
      return { out: '', err: 'comando non riconosciuto', code: 1 }
    }
    return { out: '', err: 'operazione non supportata', code: 1 }
  }
  return {
    run,
    calls,
    has: (svc: string) => store.has(svc),
    value: (svc: string) => store.get(svc),
    set: (svc: string, v: string) => store.set(svc, v)
  }
}

/** safeStorage finta: "cifra" con un prefisso, disponibile solo su richiesta. */
function fakeSafeStorage(available: () => boolean) {
  return {
    isEncryptionAvailable: available,
    encryptString: async (plain: string) => Buffer.from('FAKE:' + plain),
    decryptString: async (enc: Buffer) => enc.toString().replace(/^FAKE:/, '')
  }
}

/** Predisponde la chiave legacy nei settings, cifrata con la safeStorage finta (formato delle fasi 1–5). */
async function seedLegacyKey(): Promise<string> {
  const legacy = Buffer.from('a'.repeat(32), 'utf8').toString('base64')
  const fake = fakeSafeStorage(() => true)
  vault.setSafeStorage(fake)
  masterKeys.setMasterKeyStorage(fake)
  setSetting('vault.masterKeySafe', Buffer.from('FAKE:' + legacy).toString('base64'))
  return legacy
}

let kc: ReturnType<typeof fakeKeychain>

beforeAll(() => {
  const dir = mkdtempSync(join(TMP_BASE, 'sandbot-vault-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

beforeEach(() => {
  kc = fakeKeychain()
  vault.setVaultKeychainRunner(kc.run)
  vault.setSafeStorage(null)
  masterKeys.setMasterKeyStorage(null)
  db().exec('DELETE FROM settings')
  // keys.json nuovo a ogni test (i segreti cifrano con chiavi fresche)
  try {
    require('node:fs').rmSync(join(dataDir(), 'keys.json'), { force: true })
  } catch {
    // non esiste
  }
})

/** Il backend dei test: safeStorage finta REGISTRATA (come fa il daemon). */
function registerStorage() {
  const fake = fakeSafeStorage(() => true)
  masterKeys.setMasterKeyStorage(fake)
  vault.setSafeStorage(fake)
}

describe('chiave master senza UI (fase rilascio — correzioni K1)', () => {
  it('senza backend registrato il vault resta BLOCCATO e non si scrive nulla (solo il daemon tocca le chiavi)', async () => {
    await expect(vault.storeSecret('API_KEY', 'valore-segreto')).rejects.toThrow('Vault locked')
    expect(getSetting<Array<unknown>>('vault.secrets', [])).toEqual([])
    expect(existsSync(join(dataDir(), 'keys.json'))).toBe(false) // nessuna generazione
    expect(kc.calls).toHaveLength(0) // il Portachiavi non viene toccato
  })

  it('storeSecret col backend del daemon: la chiave nasce in keys.json e il segreto si rilegge', async () => {
    registerStorage()
    await vault.storeSecret('API_KEY', 'valore-segreto')
    expect(kc.has(VAULT_SERVICE)).toBe(false) // NIENTE più voce nel Keychain
    const parsed = JSON.parse(readFileSync(join(dataDir(), 'keys.json'), 'utf8')) as Record<string, unknown>
    expect(typeof parsed[VAULT_SERVICE]).toBe('string')
    expect(await vault.revealSecret('API_KEY')).toBe('valore-segreto')
  })

  it('vault e connettori hanno chiavi SEPARATE (campi distinti di keys.json)', async () => {
    registerStorage()
    await vault.storeSecret('API_KEY', 'v')
    const { getConnectorsKey } = await import('../../daemon/keychain')
    await getConnectorsKey(kc.run)
    const parsed = JSON.parse(readFileSync(join(dataDir(), 'keys.json'), 'utf8')) as Record<string, string>
    expect(parsed[VAULT_SERVICE]).not.toBe(parsed[CONNECTORS_SERVICE])
    // il runner `security` vede SOLO letture della voce vecchia (find), mai scritture
    for (const c of kc.calls) expect(c.args[0]).toBe('find-generic-password')
  })

  it('Keychain non disponibile e nessuna chiave legacy → vault bloccato, nessun segreto scritto', async () => {
    vault.setVaultKeychainRunner(fakeKeychain({ failWrites: true }).run)
    await expect(vault.storeSecret('API_KEY', 'v')).rejects.toThrow('Vault locked')
    expect(getSetting('vault.masterKeySafe', null)).toBeNull()
    expect(getSetting<Array<unknown>>('vault.secrets', [])).toEqual([])
  })
})

describe('migrazione dalla chiave safeStorage (fasi 1–5) — fase rilascio A6: verso keys.json', () => {
  it('con la UI aperta la chiave legacy passa in keys.json e il setting viene rimosso', async () => {
    const legacy = await seedLegacyKey()
    expect(await vault.migrateVaultKeyToKeychain()).toBe(true)
    // la chiave si rilegge da keys.json via master-keys (safeStorage finto)
    const key = await masterKeys.getMasterKey(VAULT_SERVICE, { run: kc.run })
    expect(key.equals(Buffer.from(legacy, 'base64'))).toBe(true)
    expect(getSetting('vault.masterKeySafe', null)).toBeNull()
  })

  it('i segreti cifrati con la chiave legacy restano leggibili DOPO la migrazione, senza safeStorage', async () => {
    // segreto scritto nelle fasi 1–5 con la chiave legacy (stessa envelope del vault)
    const legacy = Buffer.from('a'.repeat(32), 'utf8')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', legacy, iv)
    const ct = Buffer.concat([cipher.update('valore-vecchio', 'utf8'), cipher.final()])
    const sealed = {
      sandVault: 1 as const,
      data: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    }
    setSetting('vault.secrets', [{ name: 'VECCHIA', sealed, createdAt: 1 }])
    await seedLegacyKey()
    // migrazione (UI aperta); poi la chiave si legge da keys.json, come fa il
    // daemon (fase rilascio A1: Electron anche senza finestra → safeStorage c'è)
    expect(await vault.migrateVaultKeyToKeychain()).toBe(true)
    expect(await vault.revealSecret('VECCHIA')).toBe('valore-vecchio')
  })

  it('senza UI la migrazione non avviene (il setting resta) e il vault resta bloccato', async () => {
    await seedLegacyKey()
    vault.setSafeStorage(null) // finestra chiusa
    expect(await vault.migrateVaultKeyToKeychain()).toBe(false)
    expect(getSetting('vault.masterKeySafe', null)).not.toBeNull()
    await expect(vault.storeSecret('X', 'v')).rejects.toThrow('Vault locked')
  })

  it('al primo uso con UI la migrazione avviene anche passando da storeSecret', async () => {
    await seedLegacyKey()
    await vault.storeSecret('NUOVA', 'v2') // getMasterKey migra da solo
    expect(getSetting('vault.masterKeySafe', null)).toBeNull()
    // la chiave STA in keys.json (A6), non nel Keychain
    const key = await masterKeys.getMasterKey(VAULT_SERVICE, { run: kc.run })
    expect(key.equals(Buffer.from('a'.repeat(32), 'utf8'))).toBe(true)
  })
})
