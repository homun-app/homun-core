// Fase 16c (C1): le chiavi API dei provider escono dal database in chiaro.
// Store reale su cartella mkdtemp del percorso ESPLICITO /var/folders/…
// (mai $TMPDIR né os.tmpdir()); Keychain FINTO di SANDBOT_TEST_FAKE_KEYCHAIN
// (mai il Portachiavi vero). Server finto su 127.0.0.1 per providers:test e
// providers:probe — controlla l'header Authorization.
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { setDataDir, dataDir, db, setSetting, getSetting } from '../../main/store/db'
import {
  migrateProviderKeys, saveProvider, deleteProvider, getProvider, publicProviders,
  setProviderKeychainRunner, storedProviders, type StoredProvider
} from '../../main/agent/providers'
import { buildApiMethods } from '../api'
import type { JobWorker } from '../worker'
import type { SandbotEvent, ProviderProbeResult } from '../../shared/types'

/** Il percorso esplicito richiesto dai vincoli (MAI $TMPDIR né os.tmpdir()). */
const TMP_ROOT = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'

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
})

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

  it('Portachiavi che non risponde: il chiaro RESTA (avviso senza la chiave) e si riprova al prossimo avvio', async () => {
    setSetting('providers', [{
      id: 'p2', name: 'Beta', kind: 'mistral', baseUrl: 'https://api.mistral.ai',
      apiKey: 'sk-chiave-che-resta-42', enabled: true
    }])
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    // runner che fallisce SEMPRE (Keychain giù)
    setProviderKeychainRunner(async () => ({ out: '', err: 'keychain down', code: 1 }))
    try {
      await migrateProviderKeys()
    } finally {
      setProviderKeychainRunner(undefined)
      console.warn = origWarn
    }
    const raw = storedProviders()
    expect((raw[0] as StoredProvider).apiKey).toBe('sk-chiave-che-resta-42')
    expect(JSON.stringify(raw)).not.toContain('apiKeySealed')
    // l'avviso NON contiene la chiave
    expect(warnings.join('\n')).not.toContain('sk-chiave-che-resta-42')
    // al "prossimo avvio" (Keychain su) la migrazione va a buon fine
    await migrateProviderKeys()
    const raw2 = storedProviders()
    expect((raw2[0] as StoredProvider).apiKey).toBeUndefined()
    expect((raw2[0] as StoredProvider).apiKeySealed).toBeDefined()
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
