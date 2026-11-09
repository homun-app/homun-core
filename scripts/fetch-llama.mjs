// Fase locale (L2.1): il bundle di llama.cpp per il modello integrato.
// Scarica l'asset UFFICIALE fissato in scripts/llama-pin.json (release
// ggml-org/llama.cpp b12061, NON Homebrew: il binario di Homebrew dipende da
// /opt/homebrew/opt/...), verifica sha256 e dimensione, e estrae in
// vendor/llama/ SOLO `llama-server` e le dylib che gli servono (chiusura di
// `otool -L` su @loader_path/@executable_path). Aggiunge la licenza MIT a
// THIRD_PARTY_NOTICES.md.
//
// Si lancia a mano (`node scripts/fetch-llama.mjs`) o in `predist`.
// vendor/llama/ è GITIGNORED come vendor/engramma: nel repo restano solo il
// pin e questo script. Il bundle viaggia nell'app con l'extraResources
// esistente (vendor → Resources/vendor).
//
// Il CUORE (fetchLlamaBundle) ha fetch e otool INIETTABILI: i test lo
// provano con un tar finto in mkdtemp, senza rete.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PIN_FILE = join(repoRoot, 'scripts', 'llama-pin.json')

/** sha256 esadecimale di un buffer. */
const sha256Buf = (buf) => createHash('sha256').update(buf).digest('hex')

/** Il comando `tar` di sistema (vincolo: niente nuove dipendenze). */
const tarExtract = (tarPath, destDir) => {
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'pipe' })
  if (r.status !== 0) throw new Error(`estrazione di ${tarPath} fallita: ${r.stderr}`)
}

/** otool -L di produzione. */
const otoolProd = (file) => {
  const r = spawnSync('otool', ['-L', file], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : ''
}

/**
 * Il cuore (iniettabile nei test): download → verifica → estrazione selettiva.
 * - dimensione ≠ pin.size → errore che la nomina;
 * - sha256 ≠ pin.sha256 → errore che lo nomina, niente estrazione;
 * - estrazione SOLO di llama-server + le dylib della chiusura di otool -L
 *   (path relativi @loader_path/@executable_path), README e tool che non
 *   servono restano fuori;
 * - llama-server copiato ESEGUIBILE (0o755).
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
    // chiusura delle dipendenze: llama-server + le dylib @loader_path
    const needed = ['llama-server']
    const done = new Set()
    while (needed.length) {
      const f = needed.pop()
      if (!f || done.has(f)) continue
      done.add(f)
      const path = join(extracted, f)
      if (!existsSync(path)) throw new Error(`${pin.asset} non contiene ${f}`)
      for (const m of otool(path).matchAll(/@(?:loader|executable)_path\/([^\s(]+)/g)) {
        if (existsSync(join(extracted, m[1]))) needed.push(m[1])
      }
    }
    mkdirSync(targetDir, { recursive: true })
    let bytes = 0
    const files = [...done]
    for (const f of files) {
      copyFileSync(join(extracted, f), join(targetDir, f))
      bytes += statSync(join(targetDir, f)).size
    }
    chmodSync(join(targetDir, 'llama-server'), 0o755)
    return { files: files.sort(), bytes }
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
