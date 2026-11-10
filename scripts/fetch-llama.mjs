// Fase locale (L2.1): il bundle di llama.cpp per il modello integrato.
// Scarica l'asset UFFICIALE fissato in scripts/llama-pin.json (release
// ggml-org/llama.cpp b12061, NON Homebrew: il binario di Homebrew dipende da
// /opt/homebrew/opt/...), verifica sha256 e dimensione, e estrae in
// vendor/llama/ SOLO `llama-server` e le dylib che gli servono. Aggiunge la
// licenza MIT a THIRD_PARTY_NOTICES.md.
//
// Fase fetch-llama sul tarball vero (RS1): nel tarball UFFICIALE tutto sta
// in una cartella llama-<tag>/ (non alla radice), le dipendenze passano da
// @rpath/ (l'unico LC_RPATH è @loader_path) e molte dylib sono symlink
// lib*.0.dylib -> lib*.0.x.y.dylib. Quindi:
// - la radice dell'estratto è la cartella unica in cima, se c'è (RS1.1);
// - la chiusura segue @rpath/@loader_path/@executable_path, con @rpath
//   risolto sugli LC_RPATH del binario CHE CHIEDE (otool -l); una
//   dipendenza che non si risolve è un ERRORE, mai silenzio (RS1.2);
// - in vendor/ si copia il CONTENUTO (realpath) col NOME RICHIESTO: niente
//   symlink nel bundle, e la versione lunga non si copia (RS1.3);
// - dopo la copia, ogni dipendenza @… di ogni file in vendor/llama deve
//   esistere in vendor/llama: è il controllo di verify-release, coi suoi
//   stessi parser (parseLoadPaths/parseRpaths/checkVendorDeps) riusati (RS1.4).
//
// Si lancia a mano (`node scripts/fetch-llama.mjs`) o in `predist`.
// vendor/llama/ è GITIGNORED come vendor/engramma: nel repo restano solo il
// pin e questo script. Il bundle viaggia nell'app con l'extraResources
// esistente (vendor → Resources/vendor).
//
// Il CUORE (fetchLlamaBundle) ha fetch e otool INIETTABILI: i test lo
// provano con un tar finto in mkdtemp, senza rete.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// RS1: i parser otool e il controllo delle dipendenze sono quelli di
// verify-release — nessun secondo parser qui.
import { checkVendorDeps, parseLoadPaths, parseRpaths } from './verify-release.mjs'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PIN_FILE = join(repoRoot, 'scripts', 'llama-pin.json')

/** sha256 esadecimale di un buffer. */
const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex')

/** Il comando `tar` di sistema (vincolo: niente nuove dipendenze). */
const tarExtract = (tarPath, destDir) => {
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'pipe' })
  if (r.status !== 0) throw new Error(`estrazione di ${tarPath} fallita: ${r.stderr}`)
}

/** otool di produzione: `-L` (dipendenze) o `-l` (load command, per gli LC_RPATH). */
const otoolProd = (file, flag) => {
  const r = spawnSync('otool', [`-${flag}`, file], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : ''
}

/**
 * RS1.1: la radice dell'archivio estratto. Nel tarball vero TUTTO sta in
 * una cartella llama-<tag>/ (61 voci), non alla radice: se `llama-server`
 * non è in cima e in cima c'è UNA sola cartella, la radice diventa quella.
 * Se `llama-server` non c'è né alla radice né in quella cartella, l'errore
 * NOMINA i percorsi cercati (è l'errore visto in CI sul tarball vero).
 */
function archiveRoot(extracted, asset) {
  const inCima = join(extracted, 'llama-server')
  if (existsSync(inCima)) return extracted
  const cartelle = readdirSync(extracted).filter((e) => statSync(join(extracted, e)).isDirectory())
  if (cartelle.length === 1) {
    const dentro = join(extracted, cartelle[0], 'llama-server')
    if (existsSync(dentro)) return join(extracted, cartelle[0])
    throw new Error(`${asset} non contiene llama-server (cercato ${inCima} e ${dentro})`)
  }
  throw new Error(`${asset} non contiene llama-server (cercato ${inCima}${cartelle.length > 1 ? ` — in cima ${cartelle.length} cartelle: ${cartelle.join(', ')}` : ''})`)
}

/**
 * RS1.2: la chiusura transitiva a partire da `start` (nome relativo alla
 * radice dell'estratto). Le dipendenze si seguono su @rpath/,
 * @loader_path/ e @executable_path/; @rpath si risolve con gli LC_RPATH DEL
 * BINARIO CHE CHIEDE (otool -l — nel tarball vero l'unico è @loader_path,
 * quindi la cartella del binario). Non si indovina MAI: una dipendenza @…
 * che non si risolve nell'estratto è un ERRORE che nomina il file, e una
 * che si risolve FUORI dall'estratto anche. Parser di verify-release.
 */
function closureFrom({ start, root, executableDir, otool, asset }) {
  const needed = [start]
  const done = new Set()
  while (needed.length) {
    const name = needed.pop()
    if (done.has(name)) continue
    done.add(name)
    const file = join(root, name)
    if (!existsSync(file)) throw new Error(`${asset} non contiene ${name} (cercato ${file})`)
    const dir = dirname(file)
    const loads = parseLoadPaths(otool(file, 'L'))
    const rpaths = parseRpaths(otool(file, 'l'))
    // il binario vero ha LC_RPATH = @loader_path SENZA slash: nudo → la
    // cartella del binario che chiede; con slash → relativo a quella
    const rpathBase = (rp) => {
      if (rp === '@loader_path' || rp.startsWith('@loader_path/')) return join(dir, rp.slice('@loader_path'.length))
      if (rp === '@executable_path' || rp.startsWith('@executable_path/')) return join(executableDir, rp.slice('@executable_path'.length))
      return rp
    }
    for (const load of loads) {
      if (!load.startsWith('@')) continue // /usr/lib, /System: sistema (librdma weak compresa)
      let candidate = null
      if (load.startsWith('@rpath/')) {
        const rest = load.slice('@rpath/'.length)
        candidate = rpaths.map((rp) => resolve(rpathBase(rp), rest)).find((p) => existsSync(p))
        if (!candidate) {
          throw new Error(`${asset}: ${name} dipende da ${load}, che non si risolve nell'estratto (LC_RPATH di ${name}: ${rpaths.join(', ') || 'nessuno'})`)
        }
      } else if (load.startsWith('@loader_path/') || load.startsWith('@executable_path/')) {
        const rest = load.replace(/^@(?:loader|executable)_path\//, '')
        const base = load.startsWith('@loader_path/') ? dir : executableDir
        candidate = resolve(base, rest)
      } else {
        continue // altri token @: non nostri
      }
      const rel = relative(root, candidate)
      if (rel.startsWith('..')) throw new Error(`${asset}: ${name} → ${load} si risolve FUORI dall'estratto: ${candidate}`)
      if (!existsSync(candidate)) throw new Error(`${asset}: ${name} → ${load} manca nell'estratto (${candidate})`)
      needed.push(rel)
    }
  }
  return done
}

/**
 * Il cuore (iniettabile nei test): download → verifica → estrazione selettiva.
 * - dimensione ≠ pin.size → errore che la nomina;
 * - sha256 ≠ pin.sha256 → errore che lo nomina, niente estrazione;
 * - RS1.1: radice = la sola cartella in cima, se llama-server non è in cima;
 * - RS1.2: chiusura di llama-server su @rpath (LC_RPATH di chi chiede),
 *   @loader_path e @executable_path; dipendenza non risolta → ERRORE;
 * - RS1.3: si copia il CONTENUTO dei symlink col nome richiesto, senza
 *   versioni lunghe; README e tool che non servono restano fuori;
 * - llama-server copiato ESEGUIBILE (0o755);
 * - RS1.4: controllo finale — ogni dipendenza @… di ogni file copiato deve
 *   esistere in targetDir (checkVendorDeps di verify-release).
 * Torna { files, bytes } di ciò che è finito in targetDir.
 */
export async function fetchLlamaBundle({ pin, fetchImpl, otool, targetDir }) {
  const r = await fetchImpl(pin.url)
  if (!r.ok) throw new Error(`download di ${pin.asset} fallito (HTTP ${r.status ?? '?'})`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length !== pin.size) {
    throw new Error(`${pin.asset}: dimensione sbagliata — attesi ${pin.size} byte, scaricati ${buf.length}`)
  }
  const sha = sha256Buf(buf)
  if (sha !== pin.sha256) {
    throw new Error(`${pin.asset}: sha256 sbagliato — atteso ${pin.sha256}, avuto ${sha}: niente estrazione`)
  }
  // estrazione in una temporanea (mkdtemp), poi si copia SOLO ciò che serve
  const work = mkdtempSync(join(tmpdir(), 'sandbot-fetch-llama-'))
  try {
    const tarPath = join(work, pin.asset)
    writeFileSync(tarPath, buf)
    const extracted = join(work, 'x')
    mkdirSync(extracted, { recursive: true })
    tarExtract(tarPath, extracted)
    // RS1.1: nel tarball vero tutto sta in llama-<tag>/
    const root = archiveRoot(extracted, pin.asset)
    // RS1.2: chiusura transitiva (llama-server sta alla radice trovata)
    const done = closureFrom({ start: 'llama-server', root, executableDir: root, otool, asset: pin.asset })
    mkdirSync(targetDir, { recursive: true })
    let bytes = 0
    const files = [...done].sort()
    for (const f of files) {
      const dest = join(targetDir, f)
      mkdirSync(dirname(dest), { recursive: true })
      // RS1.3: CONTENUTO (realpath — le richieste lib*.0.dylib sono symlink)
      // col NOME RICHIESTO: niente symlink nel bundle, niente versioni lunghe
      copyFileSync(realpathSync(join(root, f)), dest)
      bytes += statSync(dest).size
    }
    chmodSync(join(targetDir, 'llama-server'), 0o755)
    // RS1.4: controllo finale — ogni dipendenza @… di OGNI file presente in
    // vendor/llama (non solo di quelli appena copiati) deve esistere in
    // vendor/llama. È il controllo di verify-release, riusato com'è
    // (contentsPath = vendor/llama).
    const problems = []
    for (const f of readdirSync(targetDir).sort()) {
      const file = join(targetDir, f)
      problems.push(...checkVendorDeps({
        loads: parseLoadPaths(otool(file, 'L')),
        rpaths: parseRpaths(otool(file, 'l')),
        binaryDir: dirname(file),
        contentsPath: targetDir
      }))
    }
    if (problems.length > 0) {
      throw new Error(`${pin.asset}: vendor/llama non autosufficiente dopo la copia:\n  - ${problems.join('\n  - ')}`)
    }
    return { files, bytes }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Aggiunge la sezione llama.cpp (MIT) a THIRD_PARTY_NOTICES.md se manca.
 * Torna true se ha scritto, false se c'era già.
 */
export function ensureLlamaNotice(noticesPath) {
  const cur = existsSync(noticesPath) ? readFileSync(noticesPath, 'utf8') : ''
  if (cur.includes('llama.cpp')) return false
  const section = `
## llama.cpp (b12061)

Il server del modello integrato è \`\`llama-server\`\` della release b12061 di
<https://github.com/ggml-org/llama.cpp>, licenza MIT:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions: the above copyright
> notice and this permission notice shall be included in all copies or
> substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
  writeFileSync(noticesPath, cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + section)
  return true
}

// ---- CLI (solo da riga di comando: importato dai test non tocca la rete) ----
const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isCli) {
  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'))
  const targetDir = join(repoRoot, 'vendor', 'llama')
  const url = new URL(pin.url)
  if (url.hostname !== 'github.com' && url.hostname !== 'objects.githubusercontent.com') {
    throw new Error(`URL del pin inaspettato: ${pin.url}`)
  }
  console.log(`[fetch-llama] ${pin.asset} (tag ${pin.tag}, ${pin.size} byte) → vendor/llama/`)
  const { files, bytes } = await fetchLlamaBundle({
    pin,
    fetchImpl: (u) => fetch(u, { redirect: 'follow' }),
    otool: otoolProd,
    targetDir
  })
  ensureLlamaNotice(join(repoRoot, 'THIRD_PARTY_NOTICES.md'))
  console.log(`[fetch-llama] estratti ${files.length} file (${bytes} byte): ${files.join(', ')}`)
  console.log('[fetch-llama] licenza MIT aggiunta a THIRD_PARTY_NOTICES.md')
}
