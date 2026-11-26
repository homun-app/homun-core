// Fase locale correzioni (LC2): il download interrotto non resta «in corso»
// per sempre. Il percorso del DEMONE (startLocalModelDownload e la RPC
// local-model:status) con un server FINTO su 127.0.0.1 che chiude la
// connessione a metà: deve dare paused (Annulla) / error (rete rotta) e poi
// Riprendi fino a ready. E la RPC local-model:install ricontrolla l'idoneità
// LATO DEMONE (unsupported / no-space) prima di partire.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SandbotEvent, LocalModelStatusRpc } from '../../shared/types'
import { setDataDir, dataDir, db, setSetting } from '../../main/store/db'
import { buildApiMethods } from '../api'
import type { JobWorker } from '../worker'
import type { LocalCatalogEntry } from '../../main/agent/local-catalog'
import { TEST_TMP_BASE } from '../../test-tmp'

const TMP_ROOT = TEST_TMP_BASE + '/'

const events: SandbotEvent[] = []
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

// il "GGUF" finto del catalogo di test (come local-model.test.ts della main)
const GGUF = Buffer.from('GGUF finto per il test del download del demone\n' + 'q5kA'.repeat(12_000))
const GGUF_SHA = createHash('sha256').update(GGUF).digest('hex')
const ENTRY: LocalCatalogEntry = {
  id: 'test-0.5b', label: 'Test 0.5B (Q4_K_M)',
  repo: 'test-community/test-gguf', revision: 'a'.repeat(40),
  file: 'test-0.5b-Q4_K_M.gguf', sizeBytes: GGUF.length, sha256: GGUF_SHA,
  license: 'apache-2.0', minRamGb: 16, ramUseGb: 4.5
}

/** le modalità del server: pieno (con Range), troncato a metà, fermo (mai fine) */
type Mode = 'full' | 'cut' | 'stall'
let mode: Mode = 'full'
const seenRanges: string[] = []
let server: Server | null = null
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    seenRanges.push(String(req.headers.range ?? ''))
    const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
    const from = range ? Number(range[1]) : 0
    const slice = GGUF.slice(from)
    res.statusCode = range ? 206 : 200
    res.setHeader('content-range', `bytes ${from}-${GGUF.length - 1}/${GGUF.length}`)
    res.setHeader('content-length', String(slice.length))
    if (mode === 'cut') {
      // la connessione si CHIUDE a metà: al client resta la risposta troncata.
      // LD5: la chiusura aspetta che i byte scritti SIANO ARRIVATI sul .part
      // (poll sul file) — prima distruggeva 10 ms dopo il write e sotto carico
      // il client non aveva ancora scritto niente (.part a 0 byte)
      const target = from + Math.min(slice.length, 20_000)
      res.write(slice.slice(0, 20_000), () => {
        void (async () => {
          // come RU2 nel test dell'agente: si aspetta il file con waitFor
          // (mai un orologio fisso); in ogni caso la risposta si chiude
          try {
            await vi.waitFor(() => {
              if (!existsSync(partPath()) || statSync(partPath()).size < target) throw new Error('i byte non sono ancora sul .part')
            }, { timeout: 5000, interval: 10 })
          } finally {
            res.destroy()
          }
        })()
      })
      return
    }
    if (mode === 'stall') {
      // qualche byte, poi MAI la fine: l'unico modo di uscire è l'annullamento
      res.write(slice.slice(0, 10_000))
      return
    }
    res.end(slice)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
afterAll(async () => {
  // le risposte «stall» non finiscono mai: si chiudono i socket a forza,
  // altrimenti server.close() resta appeso per l'hook timeout
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

/** il fetch del test: SOLO il server finto su 127.0.0.1, mai la rete vera */
const fakeFetch = vi.fn(async (u: string | URL, init?: RequestInit): Promise<Response> => {
  const url = String(u)
  if (!url.startsWith('http://127.0.0.1:')) throw new Error(`RETE VIETATA nel test: ${url}`)
  return await fetch(url, init) as unknown as Response
})

const lm = await import('../local-model')

let dir: string
const modelsDir = (): string => join(dataDir(), 'models')
const partPath = (): string => join(modelsDir(), ENTRY.file + '.part')
const finalPath = (): string => join(modelsDir(), ENTRY.file)

beforeEach(async () => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-lc2-download-'))
  setDataDir(dir)
  dataDir()
  db()
  // la lingua dell'interfaccia dei test è l'italiano (i testi del demone che
  // asseriamo sono in italiano)
  setSetting('ui.activeLanguage', 'it')
  mkdirSync(modelsDir(), { recursive: true })
  mode = 'full'
  seenRanges.length = 0
  events.length = 0
  lm.setLocalModelCatalogForTest(ENTRY)
  // fase design (verifica della suite): l'idoneità della macchina VERACE anche qui —
  // con null questi test RPC restavano verdi o rossi secondo i GB liberi del momento
  // (il demone nega il download del modello integrato sotto i 2 GB liberi, e questo
  // Mac oggi ne ha 1,7). I test che provano i rifiuti d'idoneità fissano i FATTI
  // loro, sotto, e non passano da qui.
  lm.setLocalModelEligibilityFactsForTest({ arch: 'arm64', ramGb: 24, freeDiskBytes: 500 * 1024 ** 3 })
  lm.resetLocalModelDownloadForTest()
  // LD1: niente listener residui dai test precedenti (ogni test registra il suo)
  lm.resetLocalModelReadyForTest()
})
afterEach(async () => {
  lm.resetLocalModelDownloadForTest()
  lm.setLocalModelCatalogForTest(null)
  lm.setLocalModelEligibilityFactsForTest(null)
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** lo stato della RPC, con i deps del test (fetch finto, entry finta) */
const statusOf = async (): Promise<LocalModelStatusRpc> =>
  (await api['local-model:status']!([])) as LocalModelStatusRpc

/** attende che una condizione diventi vera (attesa sullo STATO, mai su un tempo fisso) */
const waitFor = async (cond: () => boolean | Promise<boolean>, what: string, attempts = 500): Promise<void> => {
  // la condizione falsa si tramuta in ERRORE: la waitFor di vitest con una
  // callback async risolve alla prima risoluzione, qualunque sia il valore —
  // solo il throw la tiene in attesa
  await vi.waitFor(async () => {
    if (!(await cond())) throw new Error(`attesa fallita: ${what}`)
  }, { timeout: attempts * 20, interval: 20 })
}

describe('fase locale correzioni 2 (LD1): la fine del download aggancia il provider UNA volta per tutte', () => {
  it('Ricomincia fino a ready: il provider esiste, agents emesso, onboarding ripreso', async () => {
    // l'onboarding finto della RPC (conta le riprese)
    let closed = 0
    const apiLd = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker, undefined, undefined, {
      onboarding: {
        // OA1–OA4 (fase onboarding-a): la facciata nuova della guida
        start: async () => undefined,
        status: () => ({ needed: false, state: null, sequence: ['welcome', 'model', 'approvals', 'chat'], modelReady: false, guideOpen: false }),
        advance: () => false,
        reopen: () => false,
        providerPaths: async () => [],
        modelBecameReady: () => { closed++; return false },
        answerFocus: async () => false,
        dismissFocus: () => undefined
      }
    })
    // il catalogo REALE punta a huggingface: il fetch globale è rimappato sul
    // server finto (il dominio è solo un nome, la rete è sempre 127.0.0.1).
    // Il fetch VERO si cattura PRIMA dello stub, sennò lo stub richiama se stesso
    const realFetch = fetch
    vi.stubGlobal('fetch', ((u: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(u).replace('https://huggingface.co', base)
      if (!url.startsWith('http://127.0.0.1:')) throw new Error(`RETE VIETATA nel test: ${url}`)
      return realFetch(url, init) as unknown as Promise<Response>
    }) as unknown as typeof fetch)
    // il primo tentativo si interrompe a metà (rete rotta) → error
    mode = 'cut'
    expect(await apiLd['local-model:install']!([])).toEqual({ started: true })
    await waitFor(async () => (await statusOf()).state === 'error', 'il download interrotto non è arrivato a error')
    expect(existsSync(partPath())).toBe(true)
    // «Ricomincia» (RPC): cancella il .part, riparte da zero e ARRIVA in fondo
    mode = 'full'
    expect(await apiLd['local-model:restart']!([])).toEqual({ started: true })
    // si aspetta la fine SUL DISCO (non con lo status: la riparazione di LD1
    // su status creerebbe il provider e maschererebbe l'aggancio che si prova)
    await waitFor(() => existsSync(finalPath()), 'il download ricominciato non è arrivato in fondo', 200)
    // e l'aggancio della fine download ha fatto IL LAVORO (attesa sull'evento)
    await waitFor(() => events.some((e) => e.type === 'agents'), 'nessun evento agents dalla fine del download', 150)
    const { publicProviders } = await import('../../main/agent/providers')
    const prov = publicProviders().find((p) => p.id === 'homun-local')
    expect(prov?.name).toBe('Integrato (sul tuo Mac)') // il nome dal catalogo it
    expect(closed).toBeGreaterThan(0) // il passo model della guida ha sentito il modello pronto
  })

  it('modello ready su disco SENZA provider: status lo crea e lo emette UNA volta sola', async () => {
    // si parte DAVVERO senza provider (la connessione settings può essere
    // quella del test precedente: il provider lì si toglie a mano)
    const { deleteProvider, publicProviders } = await import('../../main/agent/providers')
    deleteProvider('homun-local')
    writeFileSync(finalPath(), GGUF) // il GGUF già arrivato in fondo
    const before = events.filter((e) => e.type === 'agents').length
    const st1 = await statusOf()
    expect(st1.state === 'ready' || st1.state === 'running').toBe(true)
    expect(publicProviders().some((p) => p.id === 'homun-local')).toBe(true)
    expect(events.filter((e) => e.type === 'agents').length).toBe(before + 1)
    // la seconda lettura NON ricrea (nessun secondo evento agents)
    await statusOf()
    expect(events.filter((e) => e.type === 'agents').length).toBe(before + 1)
  })
})

describe('fase locale correzioni (LC2): rete rotta a metà → error, poi Riprendi fino a ready', () => {
  it('il download parte downloading, la connessione si chiude a metà → error col messaggio e col .part', async () => {
    mode = 'cut'
    const p = lm.startLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    // finché è attivo lo stato è downloading (il .part cresce)
    await expect(p).rejects.toThrow()
    expect(existsSync(partPath())).toBe(true)
    expect(statSync(partPath()).size).toBe(20_000)
    const st = await statusOf()
    expect(st.state).toBe('error')
    expect(st.error ?? '').toMatch(/non è riuscito/i)
    expect(st.progress).toEqual({ bytes: 20_000, total: ENTRY.sizeBytes })
  })

  it('Riprendi (Range) dopo l\'errore: il secondo tentativo riparte DAL BYTE del .part e arriva ready', async () => {
    mode = 'cut'
    await expect(lm.startLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })).rejects.toThrow()
    mode = 'full'
    await lm.startLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    expect(seenRanges.at(-1)).toBe('bytes=20000-')
    const st = await statusOf()
    expect(st.state === 'ready' || st.state === 'running').toBe(true)
    expect(existsSync(partPath())).toBe(false)
    expect(statSync(finalPath()).size).toBe(GGUF.length)
    expect(createHash('sha256').update(readFileSync(finalPath())).digest('hex')).toBe(GGUF_SHA)
  })
})

describe('fase locale correzioni (LC2): Annulla → paused (NON error), Riprendi e Ricomincia', () => {
  it('l\'annullamento lascia paused col .part: nessun messaggio d\'errore', async () => {
    mode = 'stall'
    const p = lm.startLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    // il download è partito (attivo): si aspetta lo STATO, non un tempo fisso
    await waitFor(async () => (await statusOf()).state === 'downloading', 'il download non è mai diventato attivo')
    expect(lm.cancelLocalModelDownload()).toBe(true)
    await expect(p).rejects.toThrow(/annull|cancel|abort/i)
    const st = await statusOf()
    expect(st.state).toBe('paused')
    expect(st.error).toBeUndefined()
    expect(st.progress).toEqual({ bytes: 10_000, total: ENTRY.sizeBytes })
  })

  it('Ricomincia: il .part si cancella e il download riparte DA ZERO (nessun Range)', async () => {
    mode = 'stall'
    const p = lm.startLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    await waitFor(async () => (await statusOf()).state === 'downloading', 'il download non è mai diventato attivo')
    lm.cancelLocalModelDownload()
    await expect(p).rejects.toThrow(/annull|cancel|abort/i)
    expect(existsSync(partPath())).toBe(true)
    mode = 'full'
    seenRanges.length = 0
    await lm.restartLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    // si aspetta che il download ricominciato ARRIVI in fondo (il .part non c'è già più)
    await waitFor(() => existsSync(finalPath()), 'il download ricominciato non è arrivato in fondo')
    expect(seenRanges.at(-1)).toBe('') // nessun Range: da zero
    expect(await statusOf()).toMatchObject({ state: expect.stringMatching(/ready|running/) })
  })

  it('dopo un «riavvio del demone» (stato dimenticato) il .part resta → paused, non downloading', async () => {
    writeFileSync(partPath(), GGUF.slice(0, 5_000))
    const st = await statusOf()
    expect(st.state).toBe('paused')
    expect(st.progress).toEqual({ bytes: 5_000, total: ENTRY.sizeBytes })
  })
})

describe('fase locale correzioni 2 (LD2): l\'annullamento si riconosce dal SEGNALE, non dal testo', () => {
  it('un errore di rete con «aborted» nel testo e NESSUN Annulla → error col messaggio (non paused)', async () => {
    // undici, timeout: testi di rete che contengono «aborted» senza che
    // l'utente abbia annullato — l'unica fonte di verità è il segnale
    const badFetch = vi.fn(async () => {
      throw new Error('network request aborted by the remote peer')
    })
    await expect(lm.startLocalModelDownload({ fetch: badFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY }))
      .rejects.toThrow(/aborted/)
    const st = await statusOf()
    expect(st.state).toBe('error')
    expect(st.error ?? '').toMatch(/non è riuscito: network request aborted by the remote peer/i)
  })

  it('l\'Annulla VERO (segnale) resta paused senza messaggio, anche se il testo non dice niente', async () => {
    // un fetch che rifiuta con un testo qualunque DOPO l'annullamento: conta
    // il segnale, non la parola nel messaggio
    const pending: { reject?: (e: Error) => void } = {}
    const slowFetch = vi.fn(() => new Promise<Response>((_, rej) => { pending.reject = rej }))
    const p = lm.startLocalModelDownload({ fetch: slowFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    await waitFor(() => pending.reject !== undefined, 'il fetch non è partito')
    writeFileSync(partPath(), GGUF.slice(0, 4_000)) // c'è un .part dal turno prima
    lm.cancelLocalModelDownload()
    pending.reject?.(new Error('socket hang up'))
    await expect(p).rejects.toThrow(/socket hang up/)
    const st = await statusOf()
    expect(st.state).toBe('paused') // annullato, NON error
    expect(st.error).toBeUndefined()
  })
})

describe('fase locale correzioni (LC2): local-model:install ricontrolla l\'idoneità LATO DEMONE', () => {
  it('architettura non arm64 → NEGA la partenza con errore chiaro, started:false', async () => {
    lm.setLocalModelEligibilityFactsForTest({ arch: 'x64', ramGb: 64, freeDiskBytes: 500 * 1024 ** 3 })
    const r = (await api['local-model:install']!([])) as { started: boolean; error?: string }
    expect(r.started).toBe(false)
    expect(r.error ?? '').toMatch(/non è disponibile|Apple Silicon/i)
    expect(existsSync(partPath())).toBe(false) // NON è partito niente
  })

  it('disco insufficiente → NEGA con i GB che servono e quelli liberi', async () => {
    lm.setLocalModelEligibilityFactsForTest({ arch: 'arm64', ramGb: 24, freeDiskBytes: 1024 ** 3 })
    const r = (await api['local-model:install']!([])) as { started: boolean; error?: string }
    expect(r.started).toBe(false)
    expect(r.error ?? '').toMatch(/spazio|GB/i)
  })

  it('macchina idonea → started:true; e l\'errore del download NON si inghiotte più: stato error', async () => {
    // il catalogo REALE punta a huggingface: il fetch globale è stubbato e
    // RIFIUTA qualsiasi URL fuori da 127.0.0.1 (nessuna rete vera) — così il
    // download parte davvero e fallisce subito, e l'errore deve FINIRE nello
    // stato (prima: .catch(() => undefined), spariva tutto). LD5: si aspetta
    // lo STATO error, non 200 ms fisse
    vi.stubGlobal('fetch', fakeFetch)
    lm.setLocalModelEligibilityFactsForTest({ arch: 'arm64', ramGb: 24, freeDiskBytes: 500 * 1024 ** 3 })
    const r = (await api['local-model:install']!([])) as { started: boolean; error?: string }
    expect(r.started).toBe(true)
    expect(r.error).toBeUndefined()
    await waitFor(async () => (await statusOf()).state === 'error', 'l\'errore del download non è finito nello stato')
    const st = await statusOf()
    expect(st.state).toBe('error')
    expect(st.error ?? '').toMatch(/non è riuscito/i)
  })
})

describe('fase locale correzioni 2 (LD5): il «cut» del server aspetta il .part, mai un tempo fisso', () => {
  it('client LENTO (risposta ritirata tardi, come sotto carico): la chiusura arriva solo DOPO che i 20_000 byte sono sul .part', async () => {
    // il fetch ritarda la CONSEGNA della risposta al download (100 ms): il
    // server ha già scritto e chiuso, il client non ha ancora letto niente —
    // così la corsa «il server distrugge il socket prima che il client abbia
    // scritto il .part» si vede DETERMINISTICA, senza il carico della suite
    const slowFetch = async (u: string | URL, init?: RequestInit): Promise<Response> => {
      const res = await (fakeFetch as unknown as typeof fetch)(u, init)
      await new Promise((r) => setTimeout(r, 100))
      return res
    }
    mode = 'cut'
    await expect(lm.startLocalModelDownload({ fetch: slowFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })).rejects.toThrow()
    // il .part ha TUTTI i byte scritti dal server prima della chiusura
    // (prima della correzione: destroy 10 ms dopo il write → .part a 0 byte)
    expect(statSync(partPath()).size).toBe(20_000)
    const st = await statusOf()
    expect(st.state).toBe('error')
    expect(st.progress).toEqual({ bytes: 20_000, total: ENTRY.sizeBytes })
  })
})

describe('fase isolamento-suite (S2): l\'annullamento mentre il .part si apre non lascia errori in giro', () => {
  it('l\'abort arriva un giro di loop dopo la risposta (il download è fermo su open del .part): nessuna eccezione non catturata, rifiuta «cancelled», resta paused', async () => {
    mode = 'stall'
    // Il completamento di open() arriva dal threadpool, sempre in un giro di
    // loop successivo alla risposta: un annullamento partito un giro dopo la
    // risposta cade lì, mentre nessuno sta ancora leggendo il corpo. Sulla
    // base il corpo nasceva PRIMA di quell'attesa: l'abort lo faceva fallire
    // con «error» SENZA ascoltatore — in Node un'eccezione non catturata
    // (nella suite faceva uscire `npm test` con 1, a test tutti verdi).
    const fetchPoiAnnulla = vi.fn(async (u: string | URL, init?: RequestInit): Promise<Response> => {
      const res = await fakeFetch(u, init)
      setImmediate(() => { lm.cancelLocalModelDownload() })
      return res
    })
    const nonCatturate: unknown[] = []
    // se l'errore dell'abort parte senza ascoltatore, finisce qui invece che nel processo
    process.setUncaughtExceptionCaptureCallback((e) => { nonCatturate.push(e) })
    try {
      const p = lm.startLocalModelDownload({ fetch: fetchPoiAnnulla as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
      // si lasciano passare il giro dell'annullamento e l'apertura del file
      for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r))
      expect(nonCatturate).toEqual([]) // ROSSO sulla base: DOMException [AbortError]: This operation was aborted
      await expect(p).rejects.toThrow(/download cancelled/)
      expect(lm.localModelDownloading()).toBe(false)
      const st = await statusOf()
      expect(st.state).toBe('paused')
      expect(st.error).toBeUndefined()
      expect(st.progress).toEqual({ bytes: 0, total: ENTRY.sizeBytes })
    } finally {
      process.setUncaughtExceptionCaptureCallback(null)
    }
  })
})
