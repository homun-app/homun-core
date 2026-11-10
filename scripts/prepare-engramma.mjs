// Fase memoria-engramma (M0): il pacchetto del motore Engramma. Copia il
// modulo N-API (engramma.darwin-arm64.node, ~33 MB: motore e runtime del
// modello — il modello NON è dentro), index.js (caricatore napi-rs) e
// index.d.ts dal crate engramma-node in vendor/engramma/, e verifica lo
// SHA256 di ogni file contro vendor/engramma/engramma.lock.json, nel repo
// (versione, tag e hash): la build usa SEMPRE la versione agganciata.
//
// Come prepare-wasm.mjs: idempotente, gira su predev/pretest/prebuild
// (predist) — in dev e nei test il .node si carica da vendor/engramma,
// nell'app impacchettata da Resources/vendor/engramma (extraResources: un
// modulo nativo NON può stare nell'asar).
//
// Se il .node non c'è ancora nella sorgente, lo costruisce UNA volta con
// `npm run build` nel crate (offline: @napi-rs/cli è già nel lock del crate;
// scrive solo file ignorati da git, non modifica il repo di Engramma).
//
// ENGRAMMA_NODE_DIR sposta la sorgente (default il checkout locale).
// `node scripts/prepare-engramma.mjs --update-lock` riscrive il lock con gli
// hash correnti della sorgente (da fare a mano, SOLO a fronte di una nuova
// versione decisa del motore, aggiornando anche tag/versione).
//
// FASE RILASCIO DI PROVA (RP1): la CI non ha il crate (il repo di Engramma
// non ha remote) — quando la sorgente manca, i 3 file si scaricano dagli
// ASSET della release fissata nel lock (`release: { repo, tag }`), con lo
// stesso schema di fetch-llama: URL ricavati da repo/tag/nome file, verifica
// di sha256 E dimensione prima di toccare vendor (mai un file non verificato).
// ENGRAMMA_RELEASE_BASE sposta la base degli URL (per i test, su 127.0.0.1).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** I file del modulo che viaggiano nell'app (il .node fuori dall'asar). */
export const ENGRAMMA_FILES = ['engramma.darwin-arm64.node', 'index.js', 'index.d.ts']

/** Il lock: hash SHA256 dei file sopra, versione e tag del motore agganciato. */
export const LOCK_FILE = 'engramma.lock.json'

/** La base degli URL degli asset: github.com, o ENGRAMMA_RELEASE_BASE nei test. */
export function resolveBaseUrl(env = process.env) {
  const raw = env.ENGRAMMA_RELEASE_BASE ?? 'https://github.com'
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`ENGRAMMA_RELEASE_BASE non è un URL valido: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`ENGRAMMA_RELEASE_BASE deve essere http(s): ${raw}`)
  }
  return `${url.protocol}//${url.host}`
}

/**
 * RP1: gli URL degli asset dai dati del lock — uno per file del modulo,
 * con lo schema di fetch-llama: {base}/{repo}/releases/download/{tag}/{file}.
 */
export function releaseAssetUrls(lock, base = 'https://github.com') {
  const release = lock?.release
  if (!release || typeof release.repo !== 'string' || typeof release.tag !== 'string') {
    throw new Error(`il lock non ha "release" { repo, tag }: impossibile ricavare gli URL degli asset (${LOCK_FILE})`)
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(release.repo)) throw new Error(`release.repo inaspettato nel lock: ${release.repo}`)
  if (!/^[\w.-]+$/.test(release.tag)) throw new Error(`release.tag inaspettato nel lock: ${release.tag}`)
  const urls = {}
  for (const f of ENGRAMMA_FILES) urls[f] = `${base}/${release.repo}/releases/download/${release.tag}/${f}`
  return urls
}

/** SHA256 esadecimale di un file (stream: regge anche i 33 MB del .node). */
export async function sha256File(file) {
  const { createReadStream } = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

const defaultRun = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { ...opts, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} fallita (exit ${r.status})`)
}

/** Il fetch di produzione (come fetch-llama: redirect seguiti). */
const defaultFetch = (url) => fetch(url, { redirect: 'follow' })

/**
 * RP1: la via dell'asset — scarica i 3 file, verifica sha256 E dimensione di
 * TUTTI in una temporanea (mkdtemp) e solo alla fine li copia in vendor:
 * un fallimento non lascia NIENTE in vendor. Torna i file scaricati.
 */
async function downloadFromRelease({ lock, vendorDir, fetchImpl, baseUrl }) {
  const lockHashOf = (f) => {
    const expected = lock.files?.[f]
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`il lock non ha l'hash di ${f}: rigenera con --update-lock`)
    }
    return expected
  }
  const expectedSize = (f) => {
    const size = lock.sizes?.[f]
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
      throw new Error(`il lock non ha la dimensione di ${f}: rigenera con --update-lock`)
    }
    return size
  }
  const urls = releaseAssetUrls(lock, baseUrl ?? resolveBaseUrl())
  const work = mkdtempSync(join(tmpdir(), 'sandbot-engramma-asset-'))
  try {
    for (const f of ENGRAMMA_FILES) {
      const r = await fetchImpl(urls[f])
      if (!r.ok) throw new Error(`download di ${f} fallito da ${urls[f]} (HTTP ${r.status ?? '?'})`)
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length !== expectedSize(f)) {
        throw new Error(`${f}: dimensione sbagliata — attesi ${expectedSize(f)} byte, scaricati ${buf.length}`)
      }
      const sha = createHash('sha256').update(buf).digest('hex')
      if (sha !== lockHashOf(f)) {
        throw new Error(`${f}: sha256 sbagliato — atteso ${lockHashOf(f)}, avuto ${sha}: niente file in vendor`)
      }
      writeFileSync(join(work, f), buf)
    }
    // TUTTO verificato: adesso (e solo adesso) si tocca vendor
    const copied = []
    for (const f of ENGRAMMA_FILES) {
      copyFileSync(join(work, f), join(vendorDir, f))
      copied.push(f)
    }
    return copied
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Il cuore (iniettabile nei test): copia e verifica. Ordine (RP1):
 * - fase locale (L0) FAST PATH: se i tre file in vendor/engramma/ hanno GIÀ
 *   gli hash del lock, esce subito SENZA leggere la sorgente — la build di
 *   Homun non dipende dallo stato del repo di Engramma (mentre GLM lavora a
 *   una versione nuova lì, qui si continua a costruire col vendor giusto);
 * - sorgente locale presente → copia e verifica (come oggi: sorgente con
 *   hash ≠ lock → errore NOMINANDO il file; .node assente → UNA build nel
 *   crate, poi tutto come sopra);
 * - altrimenti (la CI): i 3 file dagli ASSET della release del lock,
 *   verificati sha256 + dimensione prima di toccare vendor.
 * - destinazione già giusta → nessuna riscrittura (idempotente).
 */
export async function prepareEngramma({ srcDir, vendorDir, run = defaultRun, fetchImpl = defaultFetch, baseUrl }) {
  const lockPath = join(vendorDir, LOCK_FILE)
  if (!existsSync(lockPath)) {
    throw new Error(`manca ${lockPath}: il lock è nel repo (vendor/engramma/${LOCK_FILE})`)
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const lockHashOf = (f) => {
    const expected = lock.files?.[f]
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`il lock non ha l'hash di ${f}: rigenera con --update-lock`)
    }
    return expected
  }

  // fase locale (L0): vendor già giusto → via, senza toccare la sorgente
  // (il package.json comune lo si assicura lo stesso: costa un existsSync)
  let vendorReady = true
  for (const f of ENGRAMMA_FILES) {
    const dst = join(vendorDir, f)
    if (!existsSync(dst) || (await sha256File(dst)) !== lockHashOf(f)) {
      vendorReady = false
      break
    }
  }
  if (vendorReady) {
    const pkgPath = join(vendorDir, 'package.json')
    const pkg = JSON.stringify({ type: 'commonjs' }) + '\n'
    if (!existsSync(pkgPath) || readFileSync(pkgPath, 'utf8') !== pkg) writeFileSync(pkgPath, pkg)
    return { copied: [], skipped: [...ENGRAMMA_FILES], tag: lock.tag, source: 'vendor' }
  }

  // il package.json comune serve a tutte le vie che scrivono in vendor
  const ensureVendorPkg = () => {
    const pkgPath = join(vendorDir, 'package.json')
    const pkg = JSON.stringify({ type: 'commonjs' }) + '\n'
    if (!existsSync(pkgPath) || readFileSync(pkgPath, 'utf8') !== pkg) writeFileSync(pkgPath, pkg)
  }

  // RP1: la sorgente si consulta SOLO se è il crate (index.js); altrimenti
  // si passa alla via dell'asset — la CI non ha il checkout di Engramma
  const sourcePresent = existsSync(join(srcDir, 'index.js'))
  if (!sourcePresent) {
    if (lock.release) {
      const copied = await downloadFromRelease({ lock, vendorDir, fetchImpl, baseUrl })
      ensureVendorPkg()
      return { copied, skipped: [], tag: lock.tag, source: 'release' }
    }
    throw new Error(
      `né la sorgente locale (${srcDir}) né una release nel lock: punta ENGRAMMA_NODE_DIR al crate ` +
      `oppure aggiungi "release" { repo, tag } a vendor/engramma/${LOCK_FILE} (RP1)`
    )
  }

  // il .node manca ancora nella sorgente → lo si costruisce una volta
  if (!existsSync(join(srcDir, 'engramma.darwin-arm64.node'))) {
    run('npm', ['run', 'build'], { cwd: srcDir })
  }

  const copied = []
  const skipped = []
  for (const f of ENGRAMMA_FILES) {
    const src = join(srcDir, f)
    if (!existsSync(src)) throw new Error(`manca ${src} (ENGRAMMA_NODE_DIR punta al crate giusto?)`)
    const expected = lockHashOf(f)
    const hash = await sha256File(src)
    if (hash !== expected) {
      throw new Error(
        `${f} nella sorgente non è la versione agganciata: hash ${hash}, il lock dice ${expected} (tag ${lock.tag}). ` +
        'Se la nuova versione è decisa: node scripts/prepare-engramma.mjs --update-lock (e aggiorna tag/versione nel lock).'
      )
    }
    const dst = join(vendorDir, f)
    if (existsSync(dst)) {
      const dstHash = await sha256File(dst)
      if (dstHash === expected && statSync(dst).size === statSync(src).size) {
        skipped.push(f)
        continue
      }
    }
    copyFileSync(src, dst)
    copied.push(f)
  }
  // index.js è CommonJS (caricatore napi-rs) ma il repo di Homun è
  // "type": "module": senza questo package.json Node lo tratterebbe come ESM
  // e il suo require('./engramma.darwin-arm64.node') non troverebbe il .node
  // («Cannot find native binding»). Nell'app impacchettata non serve (sopra
  // Resources/vendor non c'è un package.json), ma viaggia uguale: innocuo.
  ensureVendorPkg()
  return { copied, skipped, tag: lock.tag, source: 'crate' }
}

// ---- CLI (solo da riga di comando: importato dai test non tocca nulla) ----
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const updateLock = process.argv.includes('--update-lock')
const srcDir = process.env.ENGRAMMA_NODE_DIR ?? join(homedir(), 'Projects', 'Bot', 'engramma', 'crates', 'engramma-node')
const vendorDir = join(repoRoot, 'vendor', 'engramma')

if (isCli && updateLock) {
  if (!existsSync(join(srcDir, 'engramma.darwin-arm64.node'))) defaultRun('npm', ['run', 'build'], { cwd: srcDir })
  const files = {}
  const sizes = {}
  for (const f of ENGRAMMA_FILES) {
    files[f] = await sha256File(join(srcDir, f))
    sizes[f] = statSync(join(srcDir, f)).size
  }
  const old = existsSync(join(vendorDir, LOCK_FILE))
    ? JSON.parse(readFileSync(join(vendorDir, LOCK_FILE), 'utf8'))
    : {}
  const lock = { module: 'engramma-node', version: old.version ?? '0.1.0-dev', tag: old.tag ?? '(da compilare)', ...old, files, sizes }
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(join(vendorDir, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n')
  console.log(`[prepare-engramma] lock aggiornato: ${LOCK_FILE} (tag ${lock.tag}) — ricontrolla tag e version`)
} else if (isCli) {
  mkdirSync(vendorDir, { recursive: true })
  const { copied, skipped, tag, source } = await prepareEngramma({ srcDir, vendorDir })
  const via = source === 'release' ? `asset della release ${JSON.parse(readFileSync(join(vendorDir, LOCK_FILE), 'utf8')).release?.tag ?? ''}` : source === 'crate' ? 'sorgente locale' : 'vendor già pronto'
  console.log(`[prepare-engramma] engramma-node @ ${tag} (${via}): ${copied.length ? `copiati ${copied.join(', ')}` : 'già presenti'}` + (skipped.length ? ` — verificati ${skipped.length}/${ENGRAMMA_FILES.length}` : ''))
}
