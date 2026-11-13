// OBD3 (fase onboarding-b-dettagli): il parse dell'avanzamento del build
// dell'immagine, PURO. Lo stderr di `container build --progress plain` (il
// formato #N di BuildKit, lo stesso di Docker con BuildKit) si legge RIGA
// PER RIGA mentre il build corre: il download della base (riga per riga,
// per digest), l'estrazione, i passi del Dockerfile [n/m], l'export.
//
// In USCITA mai il testo dei comandi e mai URL: solo l'attività e i numeri
// (il digest si ricorda per la somma, come CHIAVE esadecimale nuda — la
// parola «sha256» non compare mai nell'oggetto).
//
// Le unità sono quelle di BuildKit, DECIMALI: 1.05MB = 1 050 000 byte.

/** L'avanzamento del build, in parole e numeri — mai testo di comandi. */
export interface BuildProgress {
  activity: 'preparing' | 'downloading' | 'extracting' | 'running' | 'exporting'
  /** dal «[linux/arm64 2/4]» o «[2/4]» */
  step: number | null
  steps: number | null
  /** la somma dei layer della base scaricati, per digest (solo downloading) */
  bytes: number | null
  total: number | null
}

/**
 * La memoria dei digest visti (MAI in UI): l'ultima riga di OGNI layer
 * della base, così `bytes`/`total` sono la SOMMA su tutti — una base con
 * molti layer dà una percentuale vera. Le chiavi sono gli hex NUDI dei
 * digest: serializzando l'oggetto non compare mai «sha256».
 */
interface BuildProgressMemo extends BuildProgress {
  digests: Record<string, { bytes: number; total: number }>
}

/** I byte umani di BuildKit («1.05MB», «512B», «4.09MB») → byte decimali. */
function buildKitBytes(s: string): number | null {
  const m = /^([\d.]+)(B|kB|KB|MB|GB|TB)$/.exec(s)
  if (!m) return null
  const n = Number.parseFloat(m[1]!)
  if (!Number.isFinite(n)) return null
  const unit = m[2]!.toUpperCase()
  const mult = unit === 'B' ? 1 : unit === 'KB' ? 1_000 : unit === 'MB' ? 1_000_000 : unit === 'GB' ? 1_000_000_000 : 1_000_000_000_000
  return Math.round(n * mult)
}

const DOWNLOAD_RE = /(?:^|\s)sha256:([0-9a-f]{64})\s+([\d.]+\s*[BkKMG]B?)\s+\/\s+([\d.]+\s*[BkKMG]B?)(?:\s|$)/
const STEP_RE = /\[(?:[^\]\s]+\s+)?(\d+)\/(\d+)\]/
const EXTRACTING_RE = /extracting sha256:/
const EXPORTING_RE = /exporting|sending tarball/

/**
 * Il parse (PURO): una riga dello stderr del build → il prossimo stato.
 * `prev` è lo stato fin qui (null all'inizio: parte da `preparing`);
 * qualunque riga che non riconosce lascia lo stato COM'È.
 */
export function parseBuildProgress(prev: BuildProgress | null, line: string): BuildProgress {
  const memo: BuildProgressMemo = prev !== null && typeof (prev as BuildProgressMemo).digests === 'object' && (prev as BuildProgressMemo).digests !== null
    ? { ...(prev as BuildProgressMemo), digests: { ...(prev as BuildProgressMemo).digests } }
    : { activity: 'preparing', step: null, steps: null, bytes: null, total: null, digests: {} }

  // il download della base: `#4 sha256:<digest> 1.05MB / 4.09MB 0.2s`
  const dl = DOWNLOAD_RE.exec(line)
  if (dl) {
    const digest = dl[1]!
    const bytes = buildKitBytes(dl[2]!.replace(/\s+/g, ''))
    const total = buildKitBytes(dl[3]!.replace(/\s+/g, ''))
    if (bytes !== null && total !== null) {
      memo.digests[digest] = { bytes, total }
      let sumB = 0
      let sumT = 0
      for (const d of Object.values(memo.digests)) { sumB += d.bytes; sumT += d.total }
      const next: BuildProgressMemo = { activity: 'downloading', step: memo.step, steps: memo.steps, bytes: sumB, total: sumT, digests: memo.digests }
      return next
    }
  }

  // l'estrazione della base
  if (EXTRACTING_RE.test(line)) return { ...memo, activity: 'extracting' }

  // un passo del Dockerfile: `#5 [linux/arm64 1/4] RUN …` o `#5 [1/4] COPY …`
  const st = STEP_RE.exec(line)
  if (st) {
    const step = Number.parseInt(st[1]!, 10)
    const steps = Number.parseInt(st[2]!, 10)
    if (Number.isFinite(step) && Number.isFinite(steps) && step > 0 && steps > 0) {
      return { ...memo, activity: 'running', step, steps }
    }
  }

  // l'export: `exporting to oci image format`, `sending tarball`
  if (EXPORTING_RE.test(line)) return { ...memo, activity: 'exporting' }

  // qualunque altra riga (DONE, transferring, l'uscita dei comandi): nulla
  return memo
}
