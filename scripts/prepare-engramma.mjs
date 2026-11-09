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
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** I file del modulo che viaggiano nell'app (il .node fuori dall'asar). */
export const ENGRAMMA_FILES = ['engramma.darwin-arm64.node', 'index.js', 'index.d.ts']

/** Il lock: hash SHA256 dei file sopra, versione e tag del motore agganciato. */
export const LOCK_FILE = 'engramma.lock.json'

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

/**
 * Il cuore (iniettabile nei test): copia e verifica.
 * - sorgente con hash ≠ lock → errore NOMINANDO il file (versione non agganciata);
 * - destinazione già giusta → nessuna riscrittura (idempotente);
 * - .node assente nella sorgente → UNA `npm run build` nel crate, poi tutto
 *   come sopra.
 */
export async function prepareEngramma({ srcDir, vendorDir, run = defaultRun }) {
  const lockPath = join(vendorDir, LOCK_FILE)
  if (!existsSync(lockPath)) {
    throw new Error(`manca ${lockPath}: il lock è nel repo (vendor/engramma/${LOCK_FILE})`)
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

  // il .node manca ancora nella sorgente → lo si costruisce una volta
  if (!existsSync(join(srcDir, 'engramma.darwin-arm64.node'))) {
    if (!existsSync(join(srcDir, 'index.js'))) {
      throw new Error(`la sorgente ${srcDir} non è il crate engramma-node (manca index.js)`)
    }
    run('npm', ['run', 'build'], { cwd: srcDir })
  }

  const copied = []
  const skipped = []
  for (const f of ENGRAMMA_FILES) {
    const src = join(srcDir, f)
    if (!existsSync(src)) throw new Error(`manca ${src} (ENGRAMMA_NODE_DIR punta al crate giusto?)`)
    const expected = lock.files?.[f]
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`il lock non ha l'hash di ${f}: rigenera con --update-lock`)
    }
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
  const pkgPath = join(vendorDir, 'package.json')
  const pkg = JSON.stringify({ type: 'commonjs' }) + '\n'
  if (!existsSync(pkgPath) || readFileSync(pkgPath, 'utf8') !== pkg) writeFileSync(pkgPath, pkg)
  return { copied, skipped, tag: lock.tag }
}

// ---- CLI (solo da riga di comando: importato dai test non tocca nulla) ----
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const updateLock = process.argv.includes('--update-lock')
const srcDir = process.env.ENGRAMMA_NODE_DIR ?? join(homedir(), 'Projects', 'Bot', 'engramma', 'crates', 'engramma-node')
const vendorDir = join(repoRoot, 'vendor', 'engramma')

if (isCli && updateLock) {
  if (!existsSync(join(srcDir, 'engramma.darwin-arm64.node'))) defaultRun('npm', ['run', 'build'], { cwd: srcDir })
  const files = {}
  for (const f of ENGRAMMA_FILES) files[f] = await sha256File(join(srcDir, f))
  const old = existsSync(join(vendorDir, LOCK_FILE))
    ? JSON.parse(readFileSync(join(vendorDir, LOCK_FILE), 'utf8'))
    : {}
  const lock = { module: 'engramma-node', version: old.version ?? '0.1.0-dev', tag: old.tag ?? '(da compilare)', ...old, files }
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(join(vendorDir, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n')
  console.log(`[prepare-engramma] lock aggiornato: ${LOCK_FILE} (tag ${lock.tag}) — ricontrolla tag e version`)
} else if (isCli) {
  mkdirSync(vendorDir, { recursive: true })
  const { copied, skipped, tag } = await prepareEngramma({ srcDir, vendorDir })
  console.log(`[prepare-engramma] engramma-node @ ${tag}: copiati ${copied.length ? copied.join(', ') : '(già presenti)'}` + (skipped.length ? ` — verificati ${skipped.length}/${ENGRAMMA_FILES.length}` : ''))
}
