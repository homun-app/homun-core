// Fase 16c (C1): le chiavi API dei provider escono dal database in chiaro.
// Store reale su cartella mkdtemp del percorso ESPLICITO /var/folders/…
// (mai $TMPDIR né os.tmpdir()); Keychain FINTO di SANDBOT_TEST_FAKE_KEYCHAIN
// (mai il Portachiavi vero). Server finto su 127.0.0.1 per providers:test e
// providers:probe — controlla l'header Authorization.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { setDataDir, dataDir, db, setSetting, getSetting } from '../../main/store/db'
import {
  migrateProviderKeys, saveProvider, deleteProvider, getProvider, publicProviders,
  setProviderKeychainRunner, storedProviders, vacuumAfterKeyMigration, type StoredProvider
} from '../../main/agent/providers'
import { buildApiMethods } from '../api'
// fase rilascio — correzioni (K1): il backend safeStorage FINTO, registrato
// come fa il daemon (mai il vero)
import { setMasterKeyStorage, safeStorageBackendForEnv } from '../master-keys'
import type { JobWorker } from '../worker'
import type { SandbotEvent, ProviderProbeResult } from '../../shared/types'
import { TEST_TMP_BASE } from '../../test-tmp'

/** Il percorso esplicito richiesto dai vincoli (MAI $TMPDIR né os.tmpdir()). */
const TMP_ROOT = TEST_TMP_BASE + '/'

const events: SandbotEvent[] = []
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string
let server: Server
let port = 0

/** La chiave GIUSTA che il server finto pretende nel Bearer. */
const GOOD_KEY = 'sk-finta-chiave-abc123'

beforeAll(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-providers-keys-'))
  setDataDir(dir)
  dataDir()
  db()
  // Keychain FINTO su file (SANDBOT_TEST_FAKE_KEYCHAIN: mai il Portachiavi vero)
  process.env.SANDBOT_TEST_FAKE_KEYCHAIN = join(dir, 'fake-keychain.json')
  // safeStorage FINTA (SANDBOT_TEST_FAKE_SAFESTORAGE: mai il vero) — le chiavi
  // master nascono in <dir>/keys.json, come nel daemon (K1)
  setMasterKeyStorage(safeStorageBackendForEnv(null, { SANDBOT_TEST_FAKE_SAFESTORAGE: join(dir, 'fake-safestorage.json') }))
  // il server finto controlla l'header e risponde come OpenAI-compatible
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid api key' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterAll(() => {
  delete process.env.SANDBOT_TEST_FAKE_KEYCHAIN
  rmSync(dir, { recursive: true, force: true })
  return new Promise<void>((r) => server.close(() => r()))
})
beforeEach(() => {
  setSetting('providers', [])
  setSetting('models.main', null)
  setSetting('providers.migrationVacuumed', false)
})

/** I byte GREZZI di sandbot.db, -wal e -shm (se esistono): contengono la chiave? */
function keyInDbFiles(key: string): string[] {
  const hits: string[] = []
  for (const f of ['sandbot.db', 'sandbot.db-wal', 'sandbot.db-shm']) {
    const p = join(dir, f)
    if (existsSync(p) && readFileSync(p).toString('latin1').includes(key)) hits.push(f)
  }
  return hits
}

describe('migrazione all\'avvio (idempotente, non si perde mai una chiave)', () => {
  it('cifra il chiaro e lo toglie dal setting; rifatta non cambia nulla', async () => {
    setSetting('providers', [{
      id: 'p1', name: 'Zeta', kind: 'openai', baseUrl: 'https://api.example.com',
      apiKey: 'sk-in-chiaro-9876', enabled: true
    }])
    await migrateProviderKeys()
    const raw = storedProviders()
    expect((raw[0] as StoredProvider).apiKey).toBeUndefined()
    expect((raw[0] as StoredProvider).apiKeySealed).toBeDefined()
    expect(JSON.stringify(raw)).not.toContain('sk-in-chiaro-9876')
    // il daemon rivede il chiaro (SOLO in memoria)
    expect(getProvider('p1')?.apiKey).toBe('sk-in-chiaro-9876')
    // idempotente: il setting non cambia piú
    const before = JSON.stringify(getSetting('providers', []))
    await migrateProviderKeys()
    expect(JSON.stringify(getSetting('providers', []))).toBe(before)
    expect(getProvider('p1')?.apiKey).toBe('sk-in-chiaro-9876')
  })

  it('runner `security` giù (nessuna voce vecchia): la chiave si sigilla LO STESSO in keys.json (K1)', async () => {
    setSetting('providers', [{
      id: 'p2', name: 'Beta', kind: 'mistral', baseUrl: 'https://api.mistral.ai',
      apiKey: 'sk-chiave-che-resta-42', enabled: true
    }])
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    // runner che fallisce SEMPRE (Keychain giù): senza voce vecchia da
    // migrare, keys.json basta — il Portachiavi non serve più (fase rilascio)
    setProviderKeychainRunner(async () => ({ out: '', err: 'keychain down', code: 1 }))
    try {
      await migrateProviderKeys()
    } finally {
      setProviderKeychainRunner(undefined)
      console.warn = origWarn
    }
    const raw = storedProviders()
    expect((raw[0] as StoredProvider).apiKey).toBeUndefined()
    expect((raw[0] as StoredProvider).apiKeySealed).toBeDefined()
    // nessun avviso contiene la chiave in chiaro
    expect(warnings.join('\n')).not.toContain('sk-chiave-che-resta-42')
    // e il daemon rivede il chiaro in memoria
    expect(getProvider('p2')?.apiKey).toBe('sk-chiave-che-resta-42')
  })
})

describe('providers:list non contiene MAI la chiave', () => {
  it('apiKey sempre vuota, hasKey e keyHint (ultimi 4) al posto', async () => {
    await saveProvider({
      id: 'p3', name: 'Zeta', kind: 'openai', baseUrl: 'https://api.example.com',
      enabled: true, apiKey: 'sk-nascosta-a1b2'
    })
    const list = await (api['providers:list']!([]) as ReturnType<typeof publicProviders>)
    expect(JSON.stringify(list)).not.toContain('sk-nascosta-a1b2')
    const p = list.find((x) => x.id === 'p3')!
    expect(p.apiKey).toBe('')
    expect(p.hasKey).toBe(true)
    expect(p.keyHint).toBe('…a1b2')
  })

  it('un provider senza chiave: hasKey false, niente keyHint', async () => {
    await saveProvider({ id: 'p4', name: 'Loco', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true })
    const p = (await (api['providers:list']!([]) as ReturnType<typeof publicProviders>)).find((x) => x.id === 'p4')!
    expect(p.hasKey).toBe(false)
    expect(p.keyHint).toBeUndefined()
  })
})

describe('salvataggio (providers:save)', () => {
  it('senza apiKey la chiave esistente si CONSERVA (sigillata com\'è)', async () => {
    await saveProvider({ id: 'p5', name: 'Zeta', kind: 'openai', baseUrl: 'https://a.example.com', enabled: true, apiKey: 'sk-originale-0001' })
    await saveProvider({ id: 'p5', name: 'Zeta ridenominato', kind: 'openai', baseUrl: 'https://b.example.com', enabled: false })
    expect(getProvider('p5')?.apiKey).toBe('sk-originale-0001')
    expect(getProvider('p5')?.name).toBe('Zeta ridenominato')
    expect(JSON.stringify(storedProviders())).not.toContain('sk-originale-0001')
  })

  it('una chiave NUOVA sostituisce la vecchia; clearKey la toglie', async () => {
    await saveProvider({ id: 'p6', name: 'Zeta', kind: 'openai', baseUrl: 'https://a.example.com', enabled: true, apiKey: 'sk-vecchia-0002' })
    await saveProvider({ id: 'p6', name: 'Zeta', kind: 'openai', baseUrl: 'https://a.example.com', enabled: true, apiKey: 'sk-nuova-0003' })
    expect(getProvider('p6')?.apiKey).toBe('sk-nuova-0003')
    expect((publicProviders().find((x) => x.id === 'p6'))!.keyHint).toBe('…0003')
    await saveProvider({ id: 'p6', name: 'Zeta', kind: 'openai', baseUrl: 'https://a.example.com', enabled: true, clearKey: true })
    expect(getProvider('p6')?.apiKey).toBe('')
    expect((publicProviders().find((x) => x.id === 'p6'))!.hasKey).toBe(false)
  })

  it('eliminare il provider del models.main lo azzera (C3.3)', async () => {
    await saveProvider({ id: 'p7', name: 'Zeta', kind: 'openai', baseUrl: 'https://a.example.com', enabled: true, apiKey: 'sk-x' })
    setSetting('models.main', { providerId: 'p7', model: 'alpha', thinking: null })
    deleteProvider('p7')
    expect(getSetting('models.main', null)).toBeNull()
  })
})

describe('providers:test e providers:probe (server finto su 127.0.0.1)', () => {
  it('un provider con chiave risponde a providers:test: il server controlla l\'header', async () => {
    await saveProvider({
      id: 'p8', name: 'Finto', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true, apiKey: GOOD_KEY
    })
    const r = await (api['providers:test']!(['p8']) as Promise<{ ok: boolean; error?: string; models?: Array<{ id: string }> }>)
    expect(r.ok).toBe(true)
    expect(r.models?.map((m) => m.id)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('la chiave SBAGLIATA fallisce il test senza mai comparire nell\'errore', async () => {
    await saveProvider({
      id: 'p9', name: 'Finto', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true, apiKey: 'sk-sbagliata-zzz999'
    })
    const r = await (api['providers:test']!(['p9']) as Promise<{ ok: boolean; error?: string }>)
    expect(r.ok).toBe(false)
    expect(r.error ?? '').not.toContain('sk-sbagliata-zzz999')
  })

  it('providers:probe: chiave giusta → ok con i modelli; chiave sbagliata → errore leggibile, chiave mai nell\'errore e mai salvata', async () => {
    const ok = await (api['providers:probe']!([{ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: GOOD_KEY }]) as Promise<ProviderProbeResult>)
    expect(ok.ok).toBe(true)
    expect(ok.models).toEqual(['alpha', 'beta', 'gamma'])
    const bad = await (api['providers:probe']!([{ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-sbadata-777' }]) as Promise<ProviderProbeResult>)
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('invalid-key')
    expect(JSON.stringify(bad)).not.toContain('sk-sbadata-777')
    // la prova NON salva niente: nessun provider nuovo nel setting
    expect(storedProviders()).toEqual([])
    // servizio che non risponde → errore leggibile 'unreachable'
    const down = await (api['providers:probe']!([{ kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'qualsiasi' }]) as Promise<ProviderProbeResult>)
    expect(down.ok).toBe(false)
    expect(down.error).toBe('unreachable')
  })
})

// ---- fase 16c correzioni: R2.1 residui su disco, R2.2 chiaro conservato, R2.3 prova col providerId ----

describe('R2.1 — i byte della chiave non restano nei file di SQLite', () => {
  // DB su FILE dentro mkdtemp (mai :memory:): il test legge i byte grezzi di
  // sandbot.db, sandbot.db-wal e sandbot.db-shm
  it('dopo la migrazione + checkpoint TRUNCATE + VACUUM nessun file contiene la chiave', async () => {
    const KEY = 'sk-finta-residui-42'
    // la 16b scriveva il chiaro nel setting 'providers'
    setSetting('providers', [{
      id: 'vac', name: 'Vecchio', kind: 'openai', baseUrl: 'https://api.example.com',
      apiKey: KEY, enabled: true
    }])
    // SANITY: prima della migrazione la chiave È nei file (è il problema reale)
    expect(keyInDbFiles(KEY).length).toBeGreaterThan(0)
    // il boot del daemon: migrazione (cifra e cambia il setting)…
    const changed = await migrateProviderKeys()
    expect(changed).toBe(true)
    // …e la pulizia una volta sola
    vacuumAfterKeyMigration(db(), changed)
    expect(keyInDbFiles(KEY)).toEqual([])
    // il flag la rende idempotente: ripeterla non fa niente (e non rompe nulla)
    vacuumAfterKeyMigration(db(), true)
    expect(keyInDbFiles(KEY)).toEqual([])
    expect(getSetting<boolean>('providers.migrationVacuumed', false)).toBe(true)
    // e la chiave sigillata c'è, il chiaro no
    expect((storedProviders()[0] as StoredProvider).apiKeySealed).toBeDefined()
    expect(getProvider('vac')?.apiKey).toBe(KEY)
  })

  it('senza migrazione né chiavi sigillate non tocca il database (flag spento)', () => {
    setSetting('providers', [])
    const broken = { exec: () => { throw new Error('must not run') } }
    vacuumAfterKeyMigration(broken, false) // non lancia: non c'è niente da pulire
    expect(getSetting<boolean>('providers.migrationVacuumed', false)).toBe(false)
  })

  it('se il VACUUM fallisce si logga SENZA dati e si riprova al prossimo avvio', async () => {
    const KEY = 'sk-finta-vacuum-fail-7'
    setSetting('providers', [{
      id: 'vac2', name: 'Vecchio 2', kind: 'openai', baseUrl: 'https://api.example.com',
      apiKey: KEY, enabled: true
    }])
    await migrateProviderKeys()
    setSetting('providers.migrationVacuumed', false)
    // un DB «occupato»: il checkpoint fallisce
    const busy = {
      exec: (sql: string) => {
        if (sql.includes('checkpoint') || sql.includes('VACUUM')) throw new Error('database is locked')
        return undefined
      }
    }
    const errors: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')) }
    try {
      vacuumAfterKeyMigration(busy, true)
    } finally {
      console.error = orig
    }
    // flag NON scritto: si riprova al prossimo avvio; il log non porta dati
    expect(getSetting<boolean>('providers.migrationVacuumed', false)).toBe(false)
    expect(errors.join('\n')).not.toContain(KEY)
    // al «prossimo avvio» il DB vero risponde: la pulizia riesce
    vacuumAfterKeyMigration(db(), false)
    expect(keyInDbFiles(KEY)).toEqual([])
    expect(getSetting<boolean>('providers.migrationVacuumed', false)).toBe(true)
  })
})

describe('R2.2 — saveProvider non butta il chiaro non ancora migrato', () => {
  it('runner `security` giù: si rinomina senza chiave nuova, si riavvia e si migra — la chiave c\'è ed è sigillata (K1)', async () => {
    const KEY = 'sk-finta-sopravvive-99'
    setSetting('providers', [{
      id: 'keep', name: 'Prima', kind: 'openai', baseUrl: 'https://api.example.com',
      apiKey: KEY, enabled: true
    }])
    // avvio col runner `security` GIÙ: la migrazione riesce LO STESSO (K1:
    // keys.json è la fonte, il Portachiavi serve solo alle voci vecchie)
    setProviderKeychainRunner(async () => ({ out: '', err: 'keychain down', code: 1 }))
    expect(await migrateProviderKeys()).toBe(true)
    const sealed = (storedProviders()[0] as StoredProvider).apiKeySealed
    expect(sealed).toBeDefined()
    // l'utente modifica nome e URL SENZA ridigitare la chiave
    await saveProvider({
      id: 'keep', name: 'Dopo', kind: 'openai', baseUrl: 'https://new.example.com', enabled: true
    })
    // R2.2: la chiave sigillata sopravvive (prima il chiaro spariva: persa)
    expect((storedProviders()[0] as StoredProvider).name).toBe('Dopo')
    expect((storedProviders()[0] as StoredProvider).apiKeySealed).toStrictEqual(sealed)
    expect(getProvider('keep')?.apiKey).toBe(KEY)
    // «riavvio»: niente più chiaro da migrare, idempotente
    setProviderKeychainRunner(undefined)
    expect(await migrateProviderKeys()).toBe(false)
  })

  it('una chiave NUOVA scritta col Portachiavi giù non si salva; clearKey toglie anche il chiaro', async () => {
    const KEY = 'sk-finta-vecchia-3'
    setSetting('providers', [{
      id: 'swap', name: 'Swap', kind: 'openai', baseUrl: 'https://api.example.com',
      apiKey: KEY, enabled: true
    }])
    setProviderKeychainRunner(async () => ({ out: '', err: 'keychain down', code: 1 }))
    // il chiaro sopravvive al salvataggio senza chiave…
    await saveProvider({ id: 'swap', name: 'Swap', kind: 'openai', baseUrl: 'https://api.example.com', enabled: true })
    expect((storedProviders()[0] as StoredProvider).apiKey).toBe(KEY)
    // …clearKey lo toglie davvero
    await saveProvider({ id: 'swap', name: 'Swap', kind: 'openai', baseUrl: 'https://api.example.com', enabled: true, clearKey: true })
    const raw = storedProviders()[0] as StoredProvider
    expect(raw.apiKey).toBeUndefined()
    expect(raw.apiKeySealed).toBeUndefined()
    setProviderKeychainRunner(undefined)
  })
})

describe('R2.3 — providers:probe con { providerId } usa la chiave già salvata', () => {
  it('senza apiKey nella richiesta prova con la chiave del provider (mai in risposta)', async () => {
    await saveProvider({
      id: 'saved', name: 'Salvato', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true, apiKey: GOOD_KEY
    })
    // l'indirizzo è cambiato, la chiave NON è stata ridigitata: la prova usa
    // quella in memoria nel daemon
    const r = await (api['providers:probe']!([{ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, providerId: 'saved' }]) as Promise<ProviderProbeResult>)
    expect(r.ok).toBe(true)
    expect(r.models).toEqual(['alpha', 'beta', 'gamma'])
    expect(JSON.stringify(r)).not.toContain(GOOD_KEY)
  })

  it('l\'apiKey nella richiesta vince; un providerId senza chiave non inventa niente', async () => {
    await saveProvider({
      id: 'saved2', name: 'Salvato 2', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
      enabled: true, apiKey: GOOD_KEY
    })
    // chiave SBAGLIATA nella richiesta: vince lei (invalid-key), mai la salvata
    const wrong = await (api['providers:probe']!([{ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, providerId: 'saved2', apiKey: 'sk-sbagliata-req' }]) as Promise<ProviderProbeResult>)
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toBe('invalid-key')
    // provider senza chiave salvata e senza apiKey: il server finto risponde 401
    await saveProvider({ id: 'nokey', name: 'Senza chiave', kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true })
    const noKey = await (api['providers:probe']!([{ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, providerId: 'nokey' }]) as Promise<ProviderProbeResult>)
    expect(noKey.ok).toBe(false)
    expect(noKey.error).toBe('invalid-key')
    // un providerId che non esiste: prova senza chiave (non è un errore interno)
    const ghost = await (api['providers:probe']!([{ kind: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, providerId: 'ghost' }]) as Promise<ProviderProbeResult>)
    expect(ghost.ok).toBe(false)
    expect(ghost.error).toBe('invalid-key')
  })
})
