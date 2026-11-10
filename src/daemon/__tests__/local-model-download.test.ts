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
      // la connessione si CHIUDE a metà: al client resta la risposta troncata
      res.write(slice.slice(0, 20_000), () => { setTimeout(() => res.destroy(), 10) })
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
  lm.setLocalModelCatalogForTest(ENTRY)
  lm.setLocalModelEligibilityFactsForTest(null)
  lm.resetLocalModelDownloadForTest()
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
    // il download è partito (attivo): stato downloading
    await new Promise((r) => setTimeout(r, 150))
    const attivo = await statusOf()
    expect(attivo.state).toBe('downloading')
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
    await new Promise((r) => setTimeout(r, 150))
    lm.cancelLocalModelDownload()
    await expect(p).rejects.toThrow(/annull|cancel|abort/i)
    expect(existsSync(partPath())).toBe(true)
    mode = 'full'
    seenRanges.length = 0
    await lm.restartLocalModelDownload({ fetch: fakeFetch as unknown as typeof fetch, url: `${base}/${ENTRY.file}`, entry: ENTRY })
    // si aspetta che il download ricominciato ARRIVI in fondo (il .part non c'è già più)
    for (let i = 0; i < 100 && !existsSync(finalPath()); i++) await new Promise((r) => setTimeout(r, 20))
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
    // stato (prima: .catch(() => undefined), spariva tutto)
    vi.stubGlobal('fetch', fakeFetch)
    lm.setLocalModelEligibilityFactsForTest({ arch: 'arm64', ramGb: 24, freeDiskBytes: 500 * 1024 ** 3 })
    const r = (await api['local-model:install']!([])) as { started: boolean; error?: string }
    expect(r.started).toBe(true)
    expect(r.error).toBeUndefined()
    await new Promise((res) => setTimeout(res, 200))
    const st = await statusOf()
    expect(st.state).toBe('error')
    expect(st.error ?? '').toMatch(/non è riuscito/i)
  })
})
