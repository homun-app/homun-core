// Fase locale (L3.4/L3.5): download, stato e rimozione del modello integrato.
// Il download parte SOLO da un consenso esplicito (la scheda Integrato mostra
// modello, dimensione, sorgente e licenza): niente download automatici, mai
// aggiornamenti silenziosi. Va in <data>/models/<file>.part con RIpresa
// (Range), progresso via callback, annullabile; alla fine verifica sha256 e
// dimensione e RINOMINA — se l'hash non torna il .part si CANCELLA.
// La rimozione ferma il processo, cancella il file e dice i GB liberati.
//
// Tutto a dipendenze iniettabili: i test servono il GGUF da un server FINTO
// su 127.0.0.1, senza rete vera.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { LocalCatalogEntry } from './local-catalog'
import { downloadUrlOf, localModelInstalledPath } from './local-catalog'

/** Lo stato del modello integrato per la scheda delle Impostazioni. */
export type LocalModelState =
  | { state: 'not-installed' }
  | { state: 'downloading'; bytes: number; total: number }
  | { state: 'ready'; entry: LocalCatalogEntry; sizeBytes: number }
  | { state: 'error'; error: string }

/**
 * Il download con ripresa: se il .part esiste riparte col Range dal byte che
 * c'è già; 206 → si appende, 200 → si ricomincia da zero. Alla fine verifica
 * dimensione e sha256: se non tornano, il .part si CANCELLA e l'errore lo
 * dice. Annullato (signal) il .part RESTA: si riprende al tentativo dopo.
 */
export async function downloadLocalModel(opts: {
  fetch: typeof fetch
  /** l'URL da cui scaricare (default: downloadUrlOf(entry), iniettabile per i test) */
  url?: string
  modelsDir(): string
  onProgress?(p: { bytes: number; total: number }): void
  entry: LocalCatalogEntry
  signal?: AbortSignal
}): Promise<{ path: string }> {
  const { entry } = opts
  const dir = opts.modelsDir()
  mkdirSync(dir, { recursive: true })
  const finalPath = localModelInstalledPath(entry, dir)
  const partPath = finalPath + '.part'
  const url = opts.url ?? downloadUrlOf(entry)
  const have = existsSync(partPath) ? statSync(partPath).size : 0
  const headers: Record<string, string> = {}
  if (have > 0) headers.range = `bytes=${have}-`
  const res = await opts.fetch(url, { headers, signal: opts.signal })
  if (!res.ok) {
    throw new Error(`model download failed (HTTP ${res.status})`)
  }
  // 200 con Range chiesto: il server non supporta la ripresa → da zero
  const resume = res.status === 206 && have > 0
  if (!resume && existsSync(partPath)) unlinkSync(partPath)
  const totalHeader = Number(res.headers.get('content-length') ?? 0)
  const total = resume ? have + totalHeader : totalHeader
  let bytes = resume ? have : 0
  const out = createWriteStream(partPath, { flags: resume ? 'a' : 'w' })
  const body = res.body ? Readable.fromWeb(res.body as never) : Readable.from([])
  try {
    body.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      opts.onProgress?.({ bytes, total })
    })
    await pipeline(body, out)
  } catch (e) {
    // annullato o rete rotta: il .part RESTA per la ripresa
    if (e instanceof Error && /abort/i.test(e.message)) throw new Error('download cancelled')
    throw e
  }
  if (opts.signal?.aborted) throw new Error('download cancelled')
  // verifica finale: dimensione e sha256
  if (statSync(partPath).size !== entry.sizeBytes) {
    rmSync(partPath, { force: true })
    throw new Error(`${entry.file}: wrong size after the download (expected ${entry.sizeBytes} bytes, .part deleted)`)
  }
  const sha = await sha256OfFile(partPath)
  if (sha !== entry.sha256) {
    rmSync(partPath, { force: true })
    throw new Error(`${entry.file}: wrong sha256 — the downloaded file is not the pinned one, .part deleted`)
  }
  renameSync(partPath, finalPath)
  return { path: finalPath }
}

/** sha256 di un file (a stream: regge i 2,7 GB del GGUF). */
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Lo stato del modello integrato (file installato / .part / niente). */
export function localModelStatus(opts: { modelsDir: string; entry: LocalCatalogEntry }): LocalModelState {
  const finalPath = localModelInstalledPath(opts.entry, opts.modelsDir)
  const partPath = finalPath + '.part'
  if (existsSync(finalPath)) {
    return { state: 'ready', entry: opts.entry, sizeBytes: statSync(finalPath).size }
  }
  if (existsSync(partPath)) {
    return { state: 'downloading', bytes: statSync(partPath).size, total: opts.entry.sizeBytes }
  }
  return { state: 'not-installed' }
}

/**
 * La rimozione (L3.5): ferma il processo (la callback del chiamante), cancella
 * file e .part, e dice quanti GB libera. Se non c'è niente, 0.
 */
export async function removeLocalModel(opts: {
  modelsDir: string
  entry: LocalCatalogEntry
  stopServer(): Promise<unknown>
}): Promise<{ freedGb: number; freedBytes: number }> {
  await opts.stopServer()
  const finalPath = localModelInstalledPath(opts.entry, opts.modelsDir)
  let freed = 0
  for (const p of [finalPath, finalPath + '.part']) {
    if (existsSync(p)) {
      freed += statSync(p).size
      rmSync(p, { force: true })
    }
  }
  return { freedBytes: freed, freedGb: Math.round((freed / 1024 ** 3) * 100) / 100 }
}
