// OBV4 (fase onboarding-b-dal-vivo): il modello integrato scaricato dalla
// guida DIVENTA il modello principale. Dal vivo l'utente ha scelto
// «Integrato», ha scaricato Qwen3.5-4B (2,5 GB), il provider homun-local è
// nato — ma models.main è rimasto VUOTO: il passo Modello non si chiudeva
// («Continua» non faceva nulla, «Salta per ora» non c'era: vicolo cieco).
// Qui: l'assegnazione è PURA (l'id dal catalogo, mai scritto a mano), la fa
// chi sa che il modello è pronto (fine download, riparazione dello status,
// RPC della Continua), e un models.main già scelto NON si tocca.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { SandbotEvent, MainModel, OnboardingStatus } from '../../shared/types'
import { setDataDir, dataDir, db, setSetting } from '../../main/store/db'
import { buildApiMethods } from '../api'
import type { JobWorker } from '../worker'
import type { LocalCatalogEntry } from '../../main/agent/local-catalog'
import { TEST_TMP_BASE } from '../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'

const events: SandbotEvent[] = []
const emit: (e: SandbotEvent) => void = (e) => events.push(e)

/** la facciata onboarding che CONTA le chiusure del passo model */
let closed = 0
const onboardingFacade = {
  start: async () => undefined,
  status: (): OnboardingStatus => ({ needed: false, state: null, sequence: ['welcome', 'model', 'approvals', 'chat'], modelReady: false, guideOpen: false }),
  advance: (): false => false,
  reopen: (): false => false,
  providerPaths: async (): Promise<[]> => [],
  modelBecameReady: () => { closed++; return false },
  answerFocus: async () => false,
  dismissFocus: () => undefined
}
// costruito DOPO il reset dei listener quando serve il percorso del download
const buildTestApi = (): Record<string, (p: unknown[]) => unknown> =>
  buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker, undefined, undefined, { onboarding: onboardingFacade })
const api: Record<string, (p: unknown[]) => unknown> = buildTestApi()

const lm = await import('../local-model')
const catalog = await import('../../main/agent/local-catalog')

let dir: string
const modelsDir = (): string => join(dir, 'models')

beforeEach(() => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-obv4-main-'))
  setDataDir(dir)
  dataDir()
  db()
  setSetting('ui.activeLanguage', 'it')
  setSetting('models.main', null) // OBV4: si parte SEMPRE senza modello principale
  mkdirSync(modelsDir(), { recursive: true })
  events.length = 0
  closed = 0
  lm.setLocalModelCatalogForTest(null) // il catalogo VERO: id qwen3.5-4b
  lm.setLocalModelEligibilityFactsForTest(null)
  lm.resetLocalModelDownloadForTest()
  lm.resetLocalModelReadyForTest()
})
afterEach(async () => {
  lm.resetLocalModelDownloadForTest()
  lm.setLocalModelCatalogForTest(null)
  lm.setLocalModelEligibilityFactsForTest(null)
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** il GGUF finto «arrivato in fondo»: basta che ESISTA (nessun download qui) */
const placeGguf = (entry: LocalCatalogEntry = catalog.LOCAL_MODEL_CATALOG[0]): string => {
  const p = join(modelsDir(), entry.file)
  writeFileSync(p, Buffer.from('GGUF finto del test OBV4'))
  return p
}

describe('OBV4: localModelMain (pura) — l\'id dal catalogo, mai scritto a mano', () => {
  it('models.main VUOTO → il modello del provider homun-local, con l\'id del catalogo', () => {
    const main = lm.localModelMain(null)
    expect(main).toEqual({ providerId: 'homun-local', model: 'qwen3.5-4b', thinking: null })
    expect(main?.model).toBe(catalog.LOCAL_MODEL_CATALOG[0]!.id) // letto, non scritto
  })

  it('models.main GIÀ SCELTO dall\'utente → NULL: non si tocca', () => {
    const chosen: MainModel = { providerId: 'provina', model: 'un-modello', thinking: null }
    expect(lm.localModelMain(chosen)).toBeNull()
    // e con una voce di catalogo diversa l'id arriva comunque dal catalogo
    const entry: LocalCatalogEntry = { id: 'test-0.5b', label: 'T', repo: 'r/r', revision: 'a'.repeat(40), file: 'f.gguf', sizeBytes: 1, sha256: '0'.repeat(64), license: 'apache-2.0', minRamGb: 16, ramUseGb: 4 }
    expect(lm.localModelMain(null, entry)?.model).toBe('test-0.5b')
  })
})

describe('OBD4b: local-model:ensure-main guarda lo stato DAVVERO (la protezione non sta solo nella UI)', () => {
  it('modello NON installato → models.main INVARIATO, nessuna scrittura e passo NON chiuso', async () => {
    // NESSUN GGUF su disco e nessun download in corso: la Continua del
    // pannello Integrato non deve scrivere NIENTE (prima creava il provider
    // e assegnava models.main col modello che non c'è)
    const main = (await api['local-model:ensure-main']!([])) as MainModel | null
    expect(main).toBeNull() // torna il models.main di adesso: null
    const after = (await api['settings:get']!(['models.main', null])) as MainModel | null
    expect(after).toBeNull() // e NON è stato scritto
    expect(closed).toBe(0) // modelBecameReady MAI: il passo non si chiude
    expect(events.some((e) => e.type === 'models')).toBe(false)
  })

  it('un models.main già scelto, modello non installato → resta QUELLO, passo non chiuso', async () => {
    const chosen: MainModel = { providerId: 'provina', model: 'un-modello', thinking: null }
    setSetting('models.main', chosen)
    const main = (await api['local-model:ensure-main']!([])) as MainModel | null
    expect(main).toEqual(chosen)
    expect(closed).toBe(0)
  })
})

describe('OBV4: chi sa che il modello è pronto scrive models.main', () => {
  it('la RIPARAZIONE dello status (il modello c\'è già su disco): provider creato E models.main assegnato, evento models', async () => {
    placeGguf()
    const st = (await api['local-model:status']!([])) as { state: string }
    expect(st.state === 'ready' || st.state === 'running').toBe(true)
    const main = await api['settings:get']!(['models.main', null])
    expect(main).toEqual({ providerId: 'homun-local', model: 'qwen3.5-4b', thinking: null })
    expect(events.some((e) => e.type === 'models')).toBe(true) // la finestra si aggiorna (GC6.1)
  })

  it('la RPC della Continua (local-model:ensure-main): scrive models.main se manca e CHIUDE il passo', async () => {
    placeGguf()
    const main = (await api['local-model:ensure-main']!([])) as MainModel | null
    expect(main).toEqual({ providerId: 'homun-local', model: 'qwen3.5-4b', thinking: null })
    expect(closed).toBeGreaterThan(0) // modelBecameReady: il passo si chiude
  })

  it('un models.main GIÀ SCELTO: la RPC non lo tocca (e il passo non si chiude da lì)', async () => {
    placeGguf()
    const chosen: MainModel = { providerId: 'provina', model: 'un-modello', thinking: null }
    setSetting('models.main', chosen)
    const main = (await api['local-model:ensure-main']!([])) as MainModel | null
    expect(main).toEqual(chosen)
  })

  it('la FINE DEL DOWNLOAD: il listener LD1 crea il provider E assegna models.main — il passo si chiude da solo', async () => {
    // il download vero non si fa qui (niente rete): un GGUF di catalogo FINTO
    // arriva in fondo da un server su 127.0.0.1, come local-model-download
    const bytes = Buffer.alloc(4_096, 1)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const ENTRY: LocalCatalogEntry = {
      id: 'test-0.5b', label: 'Test 0.5B (Q4_K_M)',
      repo: 'test-community/test-gguf', revision: 'a'.repeat(40),
      file: 'test-0.5b-Q4_K_M.gguf', sizeBytes: bytes.length, sha256: sha,
      license: 'apache-2.0', minRamGb: 16, ramUseGb: 4.5
    }
    lm.setLocalModelCatalogForTest(ENTRY)
    let server: Server | null = null
    server = createServer((req, res) => { res.statusCode = 200; res.setHeader('content-length', String(bytes.length)); res.end(bytes) })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
    try {
      lm.setLocalModelEligibilityFactsForTest({ arch: 'arm64', ramGb: 24, freeDiskBytes: 500 * 1024 ** 3 })
      // il fetch globale rimappato sul server finto: il catalogo di test
      // punta a huggingface, la rete vera è vietata
      const realFetch = fetch
      vi.stubGlobal('fetch', ((u: string | URL, init?: RequestInit): Promise<Response> => {
        const url = String(u).replace('https://huggingface.co', base)
        if (!url.startsWith('http://127.0.0.1:')) throw new Error(`RETE VIETATA nel test: ${url}`)
        return realFetch(url, init) as unknown as Promise<Response>
      }) as unknown as typeof fetch)
      // l'api si costruisce QUI: il beforeEach ha azzerato i listener LD1
      // registrati dal demone, e questa api li registra di nuovo
      const apiLd = buildTestApi()
      const r = (await apiLd['local-model:install']!([])) as { started: boolean }
      expect(r.started).toBe(true)
      // si aspetta che il file arrivi in fondo E che il listener abbia fatto
      // il lavoro (provider + models.main + chiusura del passo)
      const deadline = Date.now() + 20_000
      let main: MainModel | null = null
      while (Date.now() < deadline) {
        main = (await apiLd['settings:get']!(['models.main', null])) as MainModel | null
        if (main) break
        await new Promise((resolve2) => setTimeout(resolve2, 50))
      }
      expect(main).toEqual({ providerId: 'homun-local', model: 'test-0.5b', thinking: null })
      expect(closed).toBeGreaterThan(0)
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })
})
