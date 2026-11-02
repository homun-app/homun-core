// Fase rilascio (A6): le chiavi master (vault, connettori, provider) vivono
// cifrate con safeStorage in <data>/keys.json (0600, atomica) e la migrazione
// dal Portachiavi vecchio è idempotente e SENZA PERDITE: si cancella la voce
// vecchia solo dopo la verifica della rilettura. Mai il Portachiavi vero né
// safeStorage vero: runner `security` finto e backend finto.
//
// FASE RILASCIO — CORREZIONI (K1/K2): una chiave esistente non si sostituisce
// MAI; entry illeggibile o dati sigillati senza chiave → errore tipizzato,
// keys.json identico byte per byte; lock per servizio e scritture
// serializzate; log veritieri dopo la cancellazione; solo il daemon tocca le
// chiavi (nessun backend → errore di programmazione).
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const { setDataDir, dataDir, db } = await import('../../main/store/db')
const { setSetting } = await import('../../main/store/db')
const {
  getMasterKey,
  saveMasterKey,
  setMasterKeyStorage,
  safeStorageBackendForEnv,
  MASTER_KEY_SERVICES,
  MasterKeyUnavailableError
} = await import('../master-keys')
const { writeKeychainKey, VAULT_SERVICE, CONNECTORS_SERVICE, PROVIDERS_SERVICE } = await import('../keychain')
const { daemonHasSealedData } = await import('../sealed-data')
import type { SafeStorageLike } from '../../main/vault'
import type { SecurityRunner } from '../keychain'
// il lato TIPO della classe (il valore arriva dalla destrutturazione sopra)
import type { MasterKeyUnavailableError as MasterKeyUnavailable } from '../master-keys'
import { TEST_TMP_BASE } from '../../test-tmp'

// cartelle temporanee SOLO con mkdtemp nella directory fissata
const TMP_BASE = TEST_TMP_BASE

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

// ---- fase rilascio — CORREZIONI (K1): la chiave esistente non si tocca MAI ----

/** Semi lo stato «keys.json ha già l'entry di <service> sigillata da <storage>». */
async function seedKeysEntry(service: string, storage: SafeStorageLike, key: Buffer): Promise<void> {
  const sealed = await storage.encryptString(key.toString('base64'))
  writeFileSync(keysPath(), JSON.stringify({ version: 1, [service]: sealed.toString('base64') }, null, 2) + '\n', { mode: 0o600 })
}

describe('fase rilascio — correzioni (K1): mai una chiave sopra una esistente', () => {
  it('entry che non si decifra + nessuna voce nel Portachiavi → errore, keys.json IDENTICO byte per byte', async () => {
    const seeded = randomBytes(32)
    await seedKeysEntry(VAULT_SERVICE, fakeSafeStorage(), seeded) // sigillata da ALTRO backend
    const before = readFileSync(keysPath())
    const err = await getMasterKey(VAULT_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MasterKeyUnavailableError)
    expect((err as MasterKeyUnavailable).reason).toBe('entry-unreadable')
    expect(readFileSync(keysPath()).equals(before)).toBe(true) // NESSUNA scrittura
    expect(kc.has(VAULT_SERVICE)).toBe(false) // nessuna voce creata nel finto
    // K1.8: il messaggio è il testo del catalogo (IT sorgente / EN catalogo)
    expect((err as Error).message).toContain('Homun')
    for (const w of warnings) expect(w).not.toContain(seeded.toString('base64'))
  })

  it('safeStorage non disponibile + entry presente → errore, nessuna voce creata nel Portachiavi finto', async () => {
    const seeded = randomBytes(32)
    const seeder = fakeSafeStorage()
    await seedKeysEntry(PROVIDERS_SERVICE, seeder, seeded)
    setMasterKeyStorage(fakeSafeStorage({ failEncrypt: true }))
    const err = await getMasterKey(PROVIDERS_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MasterKeyUnavailableError)
    expect(kc.has(PROVIDERS_SERVICE)).toBe(false) // niente «crea se manca»
    expect(existsSync(keysPath())).toBe(true) // il file resta com'era
  })

  it('dati sigillati presenti + nessuna chiave → errore, NESSUNA generazione', async () => {
    const err = await getMasterKey(
      CONNECTORS_SERVICE,
      { run: kc.run, dir, hasSealedData: () => true, warn: (m) => warnings.push(m) }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MasterKeyUnavailableError)
    expect((err as MasterKeyUnavailable).reason).toBe('sealed-data')
    expect(existsSync(keysPath())).toBe(false) // niente chiave nuova scritta
    expect(kc.has(CONNECTORS_SERVICE)).toBe(false)
    expect(warnings.some((w) => w.includes('refusing'))).toBe(true)
  })

  it('10 chiamate in parallelo su una migrazione → UNA sola chiave, uguale per tutti, voce cancellata UNA volta', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(VAULT_SERVICE, oldKey, kc.run)
    const keys = await Promise.all(Array.from({ length: 10 }, () => getMasterKey(VAULT_SERVICE, { run: kc.run, dir })))
    for (const k of keys) expect(k.equals(oldKey)).toBe(true)
    expect(kc.deleted.filter((s) => s === VAULT_SERVICE)).toHaveLength(1)
  })

  it('due servizi migrati in parallelo → ENTRAMBI in keys.json (scritture serializzate)', async () => {
    const vaultKey = randomBytes(32)
    const connKey = randomBytes(32)
    await writeKeychainKey(VAULT_SERVICE, vaultKey, kc.run)
    await writeKeychainKey(CONNECTORS_SERVICE, connKey, kc.run)
    const [a, b] = await Promise.all([
      getMasterKey(VAULT_SERVICE, { run: kc.run, dir }),
      getMasterKey(CONNECTORS_SERVICE, { run: kc.run, dir })
    ])
    expect(a.equals(vaultKey)).toBe(true)
    expect(b.equals(connKey)).toBe(true)
    const parsed = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, unknown>
    expect(typeof parsed[VAULT_SERVICE]).toBe('string')
    expect(typeof parsed[CONNECTORS_SERVICE]).toBe('string')
  })

  it('runner che cancella ma restituisce ≠ 0 → il log dice «rimossa» (si rilegge la verità)', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(PROVIDERS_SERVICE, oldKey, kc.run)
    // il runner finto di qui cancella DAVVERO ma riporta un codice di errore:
    // conta ciò che si rilegge, non il codice d'uscita (K1.5)
    const lyingRunner: SecurityRunner = async (args) => {
      const r = await kc.run(args)
      if (args[0] === 'delete-generic-password') return { ...r, code: 1 }
      return r
    }
    const key = await getMasterKey(PROVIDERS_SERVICE, { run: lyingRunner, dir, warn: (m) => warnings.push(m) })
    expect(key.equals(oldKey)).toBe(true)
    expect(kc.deleted).toEqual([PROVIDERS_SERVICE]) // la voce è andata davvero
    expect(warnings.some((w) => w.includes('was removed'))).toBe(true)
    expect(warnings.some((w) => w.includes('still present'))).toBe(false)
  })

  it('cancellazione che NON avviene → il log dice «ancora presente: riprovo al prossimo avvio»', async () => {
    const oldKey = randomBytes(32)
    await writeKeychainKey(PROVIDERS_SERVICE, oldKey, kc.run)
    const noDeleteRunner: SecurityRunner = async (args) => {
      if (args[0] === 'delete-generic-password') return { out: '', err: 'not found', code: 1 } // non cancella
      return kc.run(args)
    }
    const key = await getMasterKey(PROVIDERS_SERVICE, { run: noDeleteRunner, dir, warn: (m) => warnings.push(m) })
    expect(key.equals(oldKey)).toBe(true)
    expect(kc.has(PROVIDERS_SERVICE)).toBe(true) // la voce resta
    expect(warnings.some((w) => w.includes('still present'))).toBe(true)
  })

  it('nessun backend registrato → errore di PROGRAMMAZIONE, nessuna chiamata al runner', async () => {
    setMasterKeyStorage(null)
    let runnerCalls = 0
    const spyRunner: SecurityRunner = async (args) => {
      runnerCalls++
      return kc.run(args)
    }
    const err = await getMasterKey(VAULT_SERVICE, { run: spyRunner, dir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(MasterKeyUnavailableError)
    expect((err as Error).message).toContain('programming error')
    expect(runnerCalls).toBe(0) // né lettura né scrittura: il Portachiavi non si tocca
  })
})

// ---- fase rilascio — correzioni (K2): lo stato VERO dei dati dell'utente ----

describe('fase rilascio — correzioni (K2): lo stato dei dati veri (entry presente, voce assente, segreti non vuoti)', () => {
  it('il codice nuovo USA l\'entry esistente e non genera nulla', async () => {
    const realKey = randomBytes(32) // la chiave che oggi esiste solo in keys.json
    const daemonStorage = fakeSafeStorage() // il backend con cui il daemon decifra
    setMasterKeyStorage(daemonStorage)
    await seedKeysEntry(CONNECTORS_SERVICE, daemonStorage, realKey)
    setSetting('connectors.secrets', { 'srv-x': { token: { sandVault: 1, data: 'bm9uLWNvbnRh' } } })
    const before = readFileSync(keysPath())
    const key = await getMasterKey(CONNECTORS_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) })
    expect(key.equals(realKey)).toBe(true) // la chiave È quella dell'entry
    expect(readFileSync(keysPath()).equals(before)).toBe(true) // keys.json intatto
    expect(kc.deleted).toEqual([]) // niente da cancellare (voce già assente)
    expect(warnings).toHaveLength(0)
  })

  it('se la STESSA entry non si decifra, con dati sigillati → errore, mai una nuova chiave (incidente K1)', async () => {
    const realKey = randomBytes(32)
    const seeder = fakeSafeStorage() // cifra con una chiave DI CUI IL DAEMON NON DISPONE
    await seedKeysEntry(CONNECTORS_SERVICE, seeder, realKey)
    setSetting('connectors.secrets', { 'srv-x': { token: { sandVault: 1, data: 'bm9uLWNvbnRh' } } })
    const before = readFileSync(keysPath())
    const err = await getMasterKey(CONNECTORS_SERVICE, { run: kc.run, dir, warn: (m) => warnings.push(m) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MasterKeyUnavailableError)
    expect(readFileSync(keysPath()).equals(before)).toBe(true) // i dati veri non si toccano
  })
})

// ---- fase rilascio — correzioni (K1.3): la sonda dei dati sigillati del daemon ----

describe('fase rilascio — correzioni (K1.3): daemonHasSealedData guarda la forma a riposo', () => {
  it('connettore/vault/provider secondo il servizio (login e contatti contano per il vault)', () => {
    expect(daemonHasSealedData(CONNECTORS_SERVICE)).toBe(false)
    expect(daemonHasSealedData(VAULT_SERVICE)).toBe(false)
    expect(daemonHasSealedData(PROVIDERS_SERVICE)).toBe(false)

    setSetting('connectors.secrets', { srv: { token: { sandVault: 1, data: 'eA==' } } })
    expect(daemonHasSealedData(CONNECTORS_SERVICE)).toBe(true)

    setSetting('vault.secrets', [])
    setSetting('vault.logins', [{ id: 'login_1', label: 'l', origins: [], username: 'u', password: 'p', sealed: { sandVault: 1, data: 'eA==' }, createdAt: 0, updatedAt: 0 }])
    expect(daemonHasSealedData(VAULT_SERVICE)).toBe(true)
    setSetting('vault.logins', [])
    setSetting('vault.contacts', [{ id: 'contact_1', name: 'n', emails: [], phones: [], sealed: { sandVault: 1, data: 'eA==' }, createdAt: 0 }])
    expect(daemonHasSealedData(VAULT_SERVICE)).toBe(true)
    setSetting('vault.contacts', [])
    expect(daemonHasSealedData(VAULT_SERVICE)).toBe(false)

    setSetting('providers', [{ id: 'p1', name: 'P', kind: 'openai', baseUrl: 'https://127.0.0.1', enabled: true, apiKeySealed: { sandVault: 1, data: 'eA==' } }])
    expect(daemonHasSealedData(PROVIDERS_SERVICE)).toBe(true)
    setSetting('providers', [])
    expect(daemonHasSealedData(PROVIDERS_SERVICE)).toBe(false)
  })

  it('servizi sconosciuti: false (mai bloccare per sbaglio)', () => {
    expect(daemonHasSealedData('qualcosaltro')).toBe(false)
  })
})
