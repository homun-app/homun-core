// Fase locale (L3.4): il download del modello integrato — con un server FINTO
// su 127.0.0.1 (nessuna rete vera): ripresa con Range, sha256 sbagliato →
// .part cancellato, annullamento che lascia il .part riprendibile. E la
// rimozione (L3.5). Il catalogo del test è un GGUF FINTO di poche decine di KB.
// Fase CI test ermetici (RU2): l'annullamento si prova in modo DETERMINISTICO
// — dentro onProgress alla prima chiamata con byte > 0, MAI con un timer che
// gareggia contro l'I/O; e il «cut» del server chiude solo dopo che i byte
// sono arrivati sul .part (poll sul file).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, createReadStream, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LocalCatalogEntry } from '../local-catalog'

const ROOT = mkdtempSync(join(tmpdir(), 'sandbot-local-model-'))
const MODELS_DIR = join(ROOT, 'models')
mkdirSync(MODELS_DIR, { recursive: true })

// il "GGUF" finto: deterministico, ~48 KB
const GGUF = Buffer.from('GGUF finto per il test del modello integrato\n' + 'q5kA'.repeat(12_000))
const GGUF_SHA = createHash('sha256').update(GGUF).digest('hex')
const ENTRY: LocalCatalogEntry = {
  id: 'test-0.5b', label: 'Test 0.5B (Q4_K_M)',
  repo: 'test-community/test-gguf', revision: 'a'.repeat(40),
  file: 'test-0.5b-Q4_K_M.gguf', sizeBytes: GGUF.length, sha256: GGUF_SHA,
  license: 'apache-2.0', minRamGb: 16, ramUseGb: 4.5
}

const seenRanges: string[] = []
let abortAfterBytes = -1 // il server chiude la connessione dopo N byte (download interrotto)
let serveWrongBytes = false
// RU2: la modalità «firstPiece» serve SOLO il primo pezzo e poi mai la fine:
// il download può solo annullarsi. firstPieceDelayMs ritarda la SCRITTURA del
// primo pezzo (e con lui le intestazioni, che partono insieme): serve per
// provare l'annullamento quando il primo pezzo arriva in RITARDO.
let firstPiece = -1
let firstPieceDelayMs = 0
let server: Server | null = null
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (!url.startsWith(`/${ENTRY.repo}/resolve/`)) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    seenRanges.push(String(req.headers.range ?? ''))
    const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
    const from = range ? Number(range[1]) : 0
    const body = serveWrongBytes ? Buffer.concat([GGUF.slice(0, from), Buffer.from('X'.repeat(GGUF.length - from))]) : GGUF
    const slice = body.slice(from)
    res.statusCode = range ? 206 : 200
    res.setHeader('content-range', `bytes ${from}-${body.length - 1}/${body.length}`)
    res.setHeader('content-length', String(slice.length))
    if (abortAfterBytes > 0 && slice.length > abortAfterBytes) {
      // interruzione a metà: i primi byte vengono consegnati, POI il socket si
      // distrugge — al client resta la risposta troncata e il .part con i byte
      // ricevuti. RU2: la chiusura aspetta che i byte siano ARRIVATI sul .part
      // (poll sul file, come LD5 nel test del demone) — il destroy a orologio
      // (10 ms) sotto carico vinceva la lettura del client e il .part nasceva
      // a 0 byte: corsa contro I/O vero, non un difetto del download
      const target = from + Math.min(slice.length, abortAfterBytes)
      res.write(slice.slice(0, abortAfterBytes), () => {
        void (async () => {
          for (let i = 0; i < 500; i++) {
            try {
              if (existsSync(join(MODELS_DIR, ENTRY.file + '.part')) &&
                  statSync(join(MODELS_DIR, ENTRY.file + '.part')).size >= target) break
            } catch { /* il .part compare e cresce: si riprova */ }
            await new Promise((r) => setTimeout(r, 10))
          }
          res.destroy()
        })()
      })
      return
    }
    if (firstPiece > 0) {
      // RU2: il primo pezzo (e poi MAI la fine). Dopo il primo pezzo non si
      // scrive più niente: il client che annulla chiude la connessione senza
      // che il server scriva su un socket morto.
      const send = (): void => { if (!res.destroyed && res.writable) res.write(slice.slice(0, firstPiece)) }
      if (firstPieceDelayMs > 0) setTimeout(send, firstPieceDelayMs)
      else send()
      return
    }
    res.end(slice)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})

afterAll(async () => {
  // le risposte «firstPiece» non finiscono mai: si chiudono i socket a forza,
  // altrimenti server.close() resta appeso per l'hook timeout
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  rmSync(ROOT, { recursive: true, force: true })
})

const { downloadLocalModel, localModelStatus, removeLocalModel } = await import('../local-model')

/** i deps del test: fetch verso il server finto, modelli in MODELS_DIR */
const depsOf = (onProgress?: (p: { bytes: number; total: number }) => void) => ({
  fetch: ((u: string, init?: RequestInit) => fetch(u, init)) as unknown as typeof fetch,
  url: `${base}/${ENTRY.repo}/resolve/${ENTRY.revision}/${ENTRY.file}`,
  modelsDir: () => MODELS_DIR,
  onProgress
})

describe('fase locale (L3.4): download con server finto su 127.0.0.1', () => {
  it('download intero: verifica hash e dimensione, il .part diventa il file finale', async () => {
    const done = downloadLocalModel({ ...depsOf(), entry: ENTRY })
    const r = await done
    expect(r.path).toBe(join(MODELS_DIR, ENTRY.file))
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(true)
    expect(existsSync(join(MODELS_DIR, ENTRY.file + '.part'))).toBe(false)
    expect(statSync(r.path).size).toBe(GGUF.length)
    expect(createHash('sha256').update(readFileSync(r.path)).digest('hex')).toBe(GGUF_SHA)
  })

  it('ripresa con Range: il secondo tentativo riparte DAL BYTE del .part', async () => {
    seenRanges.length = 0
    abortAfterBytes = 20_000 // il server interrompe a metà
    const ac = new AbortController()
    // il primo tentativo si interrompe (socket distrutto) e lascia il .part
    await expect(downloadLocalModel({ ...depsOf(), entry: ENTRY, signal: ac.signal })).rejects.toThrow()
    abortAfterBytes = -1
    const part = join(MODELS_DIR, ENTRY.file + '.part')
    expect(existsSync(part)).toBe(true)
    const partSize = statSync(part).size
    expect(partSize).toBe(20_000)
    // il secondo tentativo riprende: Range dal byte del .part
    await downloadLocalModel({ ...depsOf(), entry: ENTRY })
    expect(seenRanges.at(-1)).toBe(`bytes=${partSize}-`)
    expect(statSync(join(MODELS_DIR, ENTRY.file)).size).toBe(GGUF.length)
    expect(existsSync(part)).toBe(false)
  })

  it('sha256 SBAGLIATO: il .part si CANCELLA e l\'errore lo dice', async () => {
    serveWrongBytes = true
    // il server serve byte sbagliati SOLO dopo il byte 0: download da zero
    rmSync(join(MODELS_DIR, ENTRY.file), { force: true })
    await expect(downloadLocalModel({ ...depsOf(), entry: ENTRY })).rejects.toThrow(/sha256|hash/i)
    serveWrongBytes = false
    expect(existsSync(join(MODELS_DIR, ENTRY.file + '.part'))).toBe(false)
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(false)
  })

  /** il download annullato DENTRO onProgress, alla prima chiamata con byte > 0 */
  const abortAtFirstPiece = async (): Promise<{ partSize: number; bytesWhenAborted: number }> => {
    rmSync(join(MODELS_DIR, ENTRY.file), { force: true })
    rmSync(join(MODELS_DIR, ENTRY.file + '.part'), { force: true })
    firstPiece = 10_000
    const ac = new AbortController()
    let bytesWhenAborted = -1
    const p = downloadLocalModel({
      ...depsOf((pr) => {
        // RU2: NIENTE orologio. Si annulla DOPO il primo pezzo, alla prima
        // chiamata di progresso con byte > 0: quando arriva il pezzo, arriva
        // l'annullamento — prima della fine, perché il pezzo non è tutto il file
        if (pr.bytes > 0 && bytesWhenAborted < 0) {
          bytesWhenAborted = pr.bytes
          ac.abort()
        }
      }),
      entry: ENTRY, signal: ac.signal
    })
    await expect(p).rejects.toThrow(/abort|annull|cancel/i)
    firstPiece = -1
    firstPieceDelayMs = 0
    const partSize = statSync(join(MODELS_DIR, ENTRY.file + '.part')).size
    return { partSize, bytesWhenAborted }
  }

  it('annullamento: il .part resta (si può riprendere), nessun file finale', async () => {
    const { partSize, bytesWhenAborted } = await abortAtFirstPiece()
    expect(bytesWhenAborted).toBeGreaterThan(0)
    // il download si è FERMATO a metà: il .part c'è, con più di 0 byte e
    // MENO del file intero, e i byte annunciati dal progresso sono SUL DISCO
    expect(partSize).toBe(bytesWhenAborted)
    expect(partSize).toBeGreaterThan(0)
    expect(partSize).toBeLessThan(GGUF.length)
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(false)
    // e si riprende fino in fondo
    await downloadLocalModel({ ...depsOf(), entry: ENTRY })
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(true)
  })

  it('annullamento col primo pezzo in RITARDO (5 ms): si aspetta il pezzo, non l\'orologio', async () => {
    // la corsa vista in CI: l'annullamento a orologio (5 ms) arrivava prima
    // del primo pezzo e il .part non nasceva. Qui il primo pezzo è in RITARDO
    // FORZATO di 5 ms e l'annullamento avviene comunque DENTRO onProgress al
    // primo pezzo: qualunque sia il ritardo, il .part resta riprendibile.
    firstPieceDelayMs = 5
    const { partSize, bytesWhenAborted } = await abortAtFirstPiece()
    expect(bytesWhenAborted).toBeGreaterThan(0)
    expect(partSize).toBe(bytesWhenAborted)
    expect(partSize).toBeGreaterThan(0)
    expect(partSize).toBeLessThan(GGUF.length)
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(false)
    // e si riprende fino in fondo
    await downloadLocalModel({ ...depsOf(), entry: ENTRY })
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(true)
  })

  it('progresso: onProgress riceve i byte crescenti e il totale', async () => {
    rmSync(join(MODELS_DIR, ENTRY.file), { force: true })
    const events: Array<{ bytes: number; total: number }> = []
    await downloadLocalModel({ ...depsOf(), entry: ENTRY, onProgress: (p) => events.push({ ...p }) })
    expect(events.length).toBeGreaterThan(0)
    expect(events.at(-1)!.total).toBe(GGUF.length)
    expect(events.at(-1)!.bytes).toBe(GGUF.length)
    // i byte crescono (mai all'indietro); il primo evento può già essere tutto
    // il file se il server lo manda in un chunk solo
    for (let i = 1; i < events.length; i++) expect(events[i]!.bytes).toBeGreaterThanOrEqual(events[i - 1]!.bytes)
  })
})

// fase locale correzioni (LC2): il .part da solo NON basta più a dire
// «downloading» — dopo un Annulla, un errore di rete o un riavvio del demone
// la scheda deve distinguere downloading (attivo) / paused (.part fermo) /
// error (ultimo tentativo fallito). Il tipo produce anche error, prima mai.
describe('fase locale correzioni (LC2): downloading/paused/error dal .part', () => {
  const PART = join(MODELS_DIR, ENTRY.file + '.part')

  it('il .part SENZA download attivo e SENZA errore → paused con byte e totale', () => {
    rmSync(join(MODELS_DIR, ENTRY.file), { force: true })
    writeFileSync(PART, GGUF.slice(0, 12_345))
    const st = localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY })
    expect(st).toEqual({ state: 'paused', bytes: 12_345, total: ENTRY.sizeBytes })
  })

  it('il .part CON download attivo → downloading (come oggi il progresso)', () => {
    const st = localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY, downloading: true })
    expect(st).toEqual({ state: 'downloading', bytes: 12_345, total: ENTRY.sizeBytes })
  })

  it('il .part con l\'errore dell\'ultimo tentativo → error col messaggio E i byte', () => {
    const st = localModelStatus({
      modelsDir: MODELS_DIR, entry: ENTRY,
      lastError: 'Il download del modello integrato non è riuscito: fetch failed'
    })
    expect(st).toEqual({
      state: 'error', error: 'Il download del modello integrato non è riuscito: fetch failed',
      bytes: 12_345, total: ENTRY.sizeBytes
    })
  })

  it('errore SENZA .part (per esempio dimensione sbagliata, .part cancellato) → error con bytes 0', () => {
    rmSync(PART, { force: true })
    const st = localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY, lastError: 'wrong size' })
    expect(st).toEqual({ state: 'error', error: 'wrong size', bytes: 0, total: ENTRY.sizeBytes })
  })

  it('niente .part e nessun errore → not-installed (dopo un riavvio del demone resta solo il disco)', () => {
    const st = localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY })
    expect(st.state).toBe('not-installed')
  })
})

describe('fase locale (L3.4/L3.5): stato e rimozione', () => {
  it('localModelStatus: not-installed → ready col file installato', async () => {
    rmSync(join(MODELS_DIR, ENTRY.file), { force: true })
    rmSync(join(MODELS_DIR, ENTRY.file + '.part'), { force: true })
    let st = localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY })
    expect(st.state).toBe('not-installed')
    await downloadLocalModel({ ...depsOf(), entry: ENTRY })
    st = localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY })
    expect(st.state).toBe('ready')
    if (st.state === 'ready') {
      expect(st.entry.sizeBytes).toBe(ENTRY.sizeBytes)
      expect(st.sizeBytes).toBe(ENTRY.sizeBytes)
    }
  })

  it('removeLocalModel: cancella il file e dice i GB liberati', async () => {
    const freed = await removeLocalModel({ modelsDir: MODELS_DIR, entry: ENTRY, stopServer: async () => undefined })
    expect(freed.freedBytes).toBe(GGUF.length) // il GGUF finto intero
    expect(existsSync(join(MODELS_DIR, ENTRY.file))).toBe(false)
    expect(localModelStatus({ modelsDir: MODELS_DIR, entry: ENTRY }).state).toBe('not-installed')
  })
})
