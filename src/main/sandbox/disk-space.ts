// Fase box-container (BX3): lo spazio su disco del computer dei bot, PURE
// dove può: il parse del df del motore (formato `system df --format json`:
// voci Images/Containers/Local Volumes/Build Cache con Size e Reclaimable in
// byte umani — decimali, come li stampa docker), il MARGINE dei 5 GB prima
// di ogni build o download, le RIGHE che la UI mostra (quanto occupa ogni
// cosa e l'azione) e la lettura dei byte liberi del disco dati.
//
// Le azioni vere (stop del box, image rm, volume rm, prune sicura) sono argv
// del MOTORE attivo (engine.ts): df/pruneSafe/removeImage/removeVolumes.
import { statfsSync } from 'node:fs'

/** I byte umani del df («1.18GB», «315MB», «12kB», «0B») → byte (decimali). */
export function parseHumanBytes(s: string): number | null {
  const m = /^\s*([\d.]+)\s*(B|kB|KB|MB|GB|TB)?\s*$/i.exec(s ?? '')
  if (!m) return null
  const n = Number.parseFloat(m[1]!)
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? 'B').toUpperCase()
  const mult = unit === 'B' ? 1 : unit === 'KB' ? 1_000 : unit === 'MB' ? 1_000_000 : unit === 'GB' ? 1_000_000_000 : 1_000_000_000_000
  return Math.round(n * mult)
}

/** Il df del motore: le voci che servono alle righe di «Spazio su disco». */
export interface EngineDf {
  imagesBytes: number
  imagesReclaimableBytes: number
  containersBytes: number
  containersReclaimableBytes: number
  volumesBytes: number
  volumesReclaimableBytes: number
  buildCacheBytes: number
  buildCacheReclaimableBytes: number
}

type RawDf = Array<{ Type?: string; Size?: string | number; Reclaimable?: string | number }>

/**
 * Il parse dell'output di `system df --format json` (PURO). Accetta l'array
 * di voci di docker; il formato esatto della CLI di Apple è tra le cose «da
 * verificare dal vivo» (stessa forma: voci col Type e Size/Reclaimable).
 * Output non JSON o senza voci riconoscibili → null: le righe restano senza
 * dimensione, mai numeri inventati.
 */
export function parseDfJson(stdout: string): EngineDf | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const entries: RawDf = Array.isArray(parsed) ? (parsed as RawDf) : typeof parsed === 'object' && parsed !== null ? [parsed as RawDf[0]] : []
  const bytes = (v: string | number | undefined): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') return parseHumanBytes(v) ?? 0
    return 0
  }
  const out: EngineDf = {
    imagesBytes: 0, imagesReclaimableBytes: 0,
    containersBytes: 0, containersReclaimableBytes: 0,
    volumesBytes: 0, volumesReclaimableBytes: 0,
    buildCacheBytes: 0, buildCacheReclaimableBytes: 0
  }
  let seen = 0
  for (const e of entries) {
    const t = String(e?.Type ?? '').toLowerCase()
    if (t.includes('image')) { out.imagesBytes = bytes(e.Size); out.imagesReclaimableBytes = bytes(e.Reclaimable); seen++ }
    else if (t.includes('container')) { out.containersBytes = bytes(e.Size); out.containersReclaimableBytes = bytes(e.Reclaimable); seen++ }
    else if (t.includes('volume')) { out.volumesBytes = bytes(e.Size); out.volumesReclaimableBytes = bytes(e.Reclaimable); seen++ }
    else if (t.includes('build')) { out.buildCacheBytes = bytes(e.Size); out.buildCacheReclaimableBytes = bytes(e.Reclaimable); seen++ }
  }
  return seen > 0 ? out : null
}

/** Lo spazio RECUPERABILE: immagini vecchie + cache di build + container fermi. */
export function reclaimableBytes(df: EngineDf): number {
  return df.imagesReclaimableBytes + df.buildCacheReclaimableBytes + df.containersReclaimableBytes
}

/** Il margine di spazio libero che resta SEMPRE libero: 5 GB. */
export const DISK_MARGIN_BYTES = 5_000_000_000

/**
 * Prima di ogni build o download (PURa): servono la dimensione stimata PIÙ
 * 5 GB di margine. Libero ignoto → non si parte per ottimismo.
 */
export function enoughDiskSpace(
  freeBytes: number | null,
  estimatedBytes: number,
  marginBytes: number = DISK_MARGIN_BYTES
): { ok: boolean; missingBytes: number } {
  if (freeBytes === null || !Number.isFinite(freeBytes)) return { ok: false, missingBytes: estimatedBytes + marginBytes }
  const need = estimatedBytes + marginBytes
  return freeBytes >= need ? { ok: true, missingBytes: 0 } : { ok: false, missingBytes: need - freeBytes }
}

/** Una riga di «Spazio su disco»: la dimensione e l'azione (id per la UI). */
export interface DiskSpaceRow {
  id: 'box-image' | 'box-files' | 'reclaimable' | 'model' | 'memory-model'
  /** byte, o null quando la fonte non c'è (nessun motore, nessun modello). */
  bytes: number | null
  /** l'azione tocca dati che non si recuperano da soli: la UI chiede conferma. */
  destructive: boolean
}

/**
 * Le righe di «Spazio su disco» (PURa): immagine del box (dimensione del
 * NOSTRO tag), file dei bot (i volumi del df), spazio recuperabile (cache di
 * build + immagini vecchie + container fermi), modello locale e modello
 * della memoria (dimensioni su disco).
 */
export function diskSpaceRows(input: {
  df: EngineDf | null
  boxImageBytes: number | null
  modelBytes: number | null
  memoryModelBytes: number | null
}): DiskSpaceRow[] {
  return [
    { id: 'box-image', bytes: input.boxImageBytes ?? input.df?.imagesBytes ?? null, destructive: true },
    { id: 'box-files', bytes: input.df?.volumesBytes ?? null, destructive: true },
    { id: 'reclaimable', bytes: input.df ? reclaimableBytes(input.df) : null, destructive: false },
    { id: 'model', bytes: input.modelBytes, destructive: true },
    { id: 'memory-model', bytes: input.memoryModelBytes, destructive: true }
  ]
}

/** I byte liberi del disco che ospita `dir` (bavail × bsize), o null. */
let diskProbeOverride: ((dir: string) => number | null) | null = null

/** Solo per i test: sostituisce (o ripristina) la sonda dello spazio libero. */
export function setDiskSpaceProbeForTests(probe: ((dir: string) => number | null) | null): void {
  diskProbeOverride = probe
}

export function freeDiskBytesOf(dir: string): number | null {
  if (diskProbeOverride) return diskProbeOverride(dir)
  try {
    const st = statfsSync(dir)
    const free = Number(st.bavail) * Number(st.bsize)
    return Number.isFinite(free) ? free : null
  } catch {
    return null
  }
}

/** La stima della dimensione della build del box (immagine ~1,2 GB + cache). */
export const BOX_BUILD_ESTIMATED_BYTES = 1_500_000_000
