// Fase rilascio (A6): le chiavi master (vault, connettori, provider) vivono
// cifrate con safeStorage in <data>/keys.json (0600, atomica) e la migrazione
// dal Portachiavi vecchio è idempotente e SENZA PERDITE: si cancella la voce
// vecchia solo dopo la verifica della rilettura. Mai il Portachiavi vero né
// safeStorage vero: runner `security` finto e backend finto.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const { setDataDir, dataDir, db } = await import('../../main/store/db')
const { getMasterKey, saveMasterKey, setMasterKeyStorage, safeStorageBackendForEnv, MASTER_KEY_SERVICES } = await import('../master-keys')
const { writeKeychainKey, VAULT_SERVICE, CONNECTORS_SERVICE, PROVIDERS_SERVICE } = await import('../keychain')
import type { SafeStorageLike } from '../../main/vault'
import type { SecurityRunner } from '../keychain'

// cartelle temporanee SOLO con mkdtemp nella directory fissata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

/** Keychain finto in memoria: find/add/delete-generic-password. */
function fakeKeychain() {
  const store = new Map<string, string>()
  const deleted: string[] = []
  const run: SecurityRunner = async (args, input) => {
    if (args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1] ?? ''
      const v = store.get(svc)
      return v ? { out: v + '\n', err: '', code: 0 } : { out: '', err: 'not found', code: 1 }
    }
    if (args[0] === 'delete-generic-password') {
      const svc = args[args.indexOf('-s') + 1] ?? ''
      if (!store.has(svc)) return { out: '', err: 'not found', code: 1 }
      store.delete(svc)
      deleted.push(svc)
      return { out: '', err: '', code: 0 }
    }
    if (args[0] === '-i') {
      for (const line of String(input ?? '').split('\n')) {
        const m = /^add-generic-password -a \S+ -s (\S+) -w (\S+)/.exec(line.trim())
        if (m) store.set(m[1]!, m[2]!)
      }
      return { out: '', err: '', code: 0 }
    }
    return { out: '', err: 'unsupported', code: 1 }
  }
  return { run, has: (svc: string) => store.has(svc), deleted }
}

/** safeStorage finto: AES-256-GCM con chiave di sessione del test. */
function fakeSafeStorage(opts: { failEncrypt?: boolean } = {}): SafeStorageLike {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => !opts.failEncrypt,
    encryptString: async (plain) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), ct])
    },
    decryptString: async (raw) => {
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
      d.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
    }
  }
}

let kc: ReturnType<typeof fakeKeychain>
const warnings: string[] = []
const dir = mkdtempSync(join(TMP_BASE, 'sandbot-a6-'))
const keysPath = () => join(dir, 'keys.json')

beforeAll(() => {
  setDataDir(dir)
  dataDir()
  db()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  kc = fakeKeychain()
  warnings.length = 0
  setMasterKeyStorage(fakeSafeStorage())
  try {
    rmSync(keysPath(), { force: true })
  } catch {
    // non esiste
  }
  db().exec('DELETE FROM settings')
})

describe('fase rilascio (A6): prima generazione', () => {
  it('la chiave nasce in keys.json cifrata, con permessi 600 e version 1', async () => {
    const key = await getMasterKey(VAULT_SERVICE, { run: kc.run, dir })
    expect(key).toHaveLength(32)
    expect(existsSync(keysPath())).toBe(true)
    const parsed = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, unknown>
    expect(parsed.version).toBe(1)
    expect(typeof parsed[VAULT_SERVICE]).toBe('string')
    expect(parsed[VAULT_SERVICE]).not.toContain(key.toString('base64')) // cifrata davvero
    expect(statSync(keysPath()).mode & 0o777).toBe(0o600)
  })

  it('la STESSA chiave si rilegge alla chiamata dopo (idempotente)', async () => {
    const first = await getMasterKey(CONNECTORS_SERVICE, { run: kc.run, dir })
    const second = await getMasterKey(CONNECTORS_SERVICE, { run: kc.run, dir })
    expect(second.equals(first)).toBe(true)
  })

  it('i servizi stanno in campi SEPARATI con i nomi di oggi', async () => {
    for (const svc of MASTER_KEY_SERVICES) await getMasterKey(svc, { run: kc.run, dir })
    const parsed = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['sandbot-connectors-key', 'sandbot-providers-key', 'sandbot-vault-key', 'version'].sort())
  })

  it('il Portachiavi NON viene toccato quando keys.json basta', async () => {
    await getMasterKey(VAULT_SERVICE, { run: kc.run, dir })
    expect(kc.has(VAULT_SERVICE)).toBe(false)
  })
})

describe('fase rilascio (A6): migrazione dal Portachiavi vecchio', () => {
  it('completa: legge, cifra, scrive, RILEGGE, solo allora cancella la voce vecchia', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(VAULT_SERVICE, oldKey, kc.run)
    const key = await getMasterKey(VAULT_SERVICE, { run: kc.run, dir })
    expect(key.equals(oldKey)).toBe(true)
    expect(kc.deleted).toEqual([VAULT_SERVICE]) // cancellata SOLO quella voce
    const reread = await getMasterKey(VAULT_SERVICE, { run: kc.run, dir })
    expect(reread.equals(oldKey)).toBe(true) // e la chiave si rilegge da keys.json
  })

  it('ripresa dopo un errore a metà (scritto ma NON verificato → niente cancellazione)', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(CONNECTORS_SERVICE, oldKey, kc.run)
    // un backend che cifra bene ma NON decifra: la rilettura di verifica fallisce
    const broken = fakeSafeStorage()
    const origDecrypt = broken.decryptString.bind(broken)
    broken.decryptString = async (raw) => {
      // decifra bene SOLO il contenuto appena scritto la prima volta; dalla
      // rilettura di verifica in poi fallisce (keychain cambiato a metà)
      void origDecrypt
      throw new Error('keychain changed')
    }
    setMasterKeyStorage(broken)
    const key = await getMasterKey(CONNECTORS_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) })
    expect(key.equals(oldKey)).toBe(true) // la chiave NON si perde: si continua col Portachiavi
    expect(kc.deleted).toEqual([]) // la voce vecchia RESTA
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('safeStorage non disponibile → NULLA cambia (via del Portachiavi di prima)', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(PROVIDERS_SERVICE, oldKey, kc.run)
    setMasterKeyStorage(fakeSafeStorage({ failEncrypt: true }))
    const key = await getMasterKey(PROVIDERS_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) })
    expect(key.equals(oldKey)).toBe(true)
    expect(kc.has(PROVIDERS_SERVICE)).toBe(true)
    expect(existsSync(keysPath())).toBe(false)
  })

  it('nessun segreto nei log/avvisi', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(VAULT_SERVICE, oldKey, kc.run)
    await getMasterKey(VAULT_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) })
    const b64 = oldKey.toString('base64')
    for (const w of warnings) {
      expect(w).not.toContain(b64)
      expect(w).not.toContain(oldKey.toString('hex'))
    }
  })
})

describe('fase rilascio (A6): il finto di test via env', () => {
  it('SANDBOT_TEST_FAKE_SAFESTORAGE sostituisce il backend REALE con uno a chiave fissa', async () => {
    const fake = safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'fake-ss') })
    expect(fake).not.toBeNull()
    expect(fake!.isEncryptionAvailable()).toBe(true)
    const sealed = await fake!.encryptString('prova')
    expect(await fake!.decryptString(sealed)).toBe('prova')
  })

  it('senza la variabile passa il backend dato (anche null)', () => {
    expect(safeStorageBackendForEnv(null, {})).toBeNull()
    const real = { isEncryptionAvailable: () => true, encryptString: async (p: string) => Buffer.from(p), decryptString: async (b: Buffer) => b.toString() }
    expect(safeStorageBackendForEnv(real as SafeStorageLike, {})).toBe(real)
  })

  it('round-trip del finto STABILE fra due backend (stessa chiave fissa)', async () => {
    const a = safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'a') })!
    const b = safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'b') })!
    expect(await b.decryptString(await a.encryptString('x'))).toBe('x')
  })
})

describe('fase rilascio (A6): saveMasterKey (migrazione del setting legacy del vault)', () => {
  it('una chiave esistente finisce in keys.json verificata', async () => {
    const key = randomBytes(32)
    expect(await saveMasterKey(VAULT_SERVICE, key, { run: kc.run, dir })).toBe(true)
    const reread = await getMasterKey(VAULT_SERVICE, { run: kc.run, dir })
    expect(reread.equals(key)).toBe(true)
  })

  it('chiave di lunghezza sbagliata rifiutata', async () => {
    expect(await saveMasterKey(VAULT_SERVICE, Buffer.alloc(8), { run: kc.run, dir })).toBe(false)
  })
})
