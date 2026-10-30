// Test del vault con chiave master nel Keychain (fase 6, residuo 0b): il
// daemon usa le credenziali anche a finestra chiusa. Runner `security` finto
// in memoria: la chiave non compare mai nell'argv di un processo, i comandi
// di scrittura partono da stdin (`security -i`). Store reale su directory
// temporanea, safeStorage finta per la migrazione.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createCipheriv } from 'node:crypto'

const { setDataDir, dataDir, db, getSetting, setSetting } = await import('../store/db')
const vault = await import('../vault')
const { VAULT_SERVICE, CONNECTORS_SERVICE } = await import('../../daemon/keychain')
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
  vault.setSafeStorage(fakeSafeStorage(() => true))
  setSetting('vault.masterKeySafe', Buffer.from('FAKE:' + legacy).toString('base64'))
  return legacy
}

let kc: ReturnType<typeof fakeKeychain>

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbot-vault-test-'))
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }))

beforeEach(() => {
  kc = fakeKeychain()
  vault.setVaultKeychainRunner(kc.run)
  vault.setSafeStorage(null)
  db().exec('DELETE FROM settings')
})

describe('chiave master nel Keychain (senza UI)', () => {
  it('storeSecret senza safeStorage: la chiave nasce nel Keychain e il segreto si rilegge', async () => {
    await vault.storeSecret('API_KEY', 'valore-segreto')
    expect(kc.has(VAULT_SERVICE)).toBe(true)
    expect(await vault.revealSecret('API_KEY')).toBe('valore-segreto')
  })

  it('la chiave non compare MAI negli argv del comando security (solo da stdin)', async () => {
    await vault.storeSecret('API_KEY', 'v')
    const keyB64 = kc.value(VAULT_SERVICE)!
    expect(keyB64).toMatch(/^[A-Za-z0-9+/=]{44}$/) // 32 byte in base64
    for (const c of kc.calls) {
      // il valore può stare solo nello stdin dei comandi `-i`, mai negli argv
      // (il `-w` della lettura è il flag "stampa su stdout", senza valore)
      expect(c.args.join(' ')).not.toContain(keyB64)
    }
    const write = kc.calls.find((c) => c.args[0] === '-i')
    expect(write?.input).toContain(keyB64) // da stdin, come i connettori
  })

  it('la voce del vault è SEPARATA da quella dei connettori', async () => {
    const { getConnectorsKey } = await import('../../daemon/keychain')
    await vault.storeSecret('API_KEY', 'v')
    await getConnectorsKey(kc.run)
    expect(kc.value(VAULT_SERVICE)).not.toBe(kc.value(CONNECTORS_SERVICE))
  })

  it('Keychain non disponibile e nessuna chiave legacy → vault bloccato, nessun segreto scritto', async () => {
    vault.setVaultKeychainRunner(fakeKeychain({ failWrites: true }).run)
    await expect(vault.storeSecret('API_KEY', 'v')).rejects.toThrow('Vault locked')
    expect(getSetting('vault.masterKeySafe', null)).toBeNull()
    expect(getSetting<Array<unknown>>('vault.secrets', [])).toEqual([])
  })
})

describe('migrazione dalla chiave safeStorage (fasi 1–5)', () => {
  it('con la UI aperta la chiave legacy passa nel Keychain e il setting viene rimosso', async () => {
    const legacy = await seedLegacyKey()
    expect(await vault.migrateVaultKeyToKeychain()).toBe(true)
    expect(kc.value(VAULT_SERVICE)).toBe(legacy)
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
    // migrazione (UI aperta) e poi vault senza safeStorage: la chiave sta nel Keychain
    expect(await vault.migrateVaultKeyToKeychain()).toBe(true)
    vault.setSafeStorage(null)
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
    expect(kc.value(VAULT_SERVICE)).toBeDefined()
  })
})
