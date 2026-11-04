#!/usr/bin/env node
// Fase impostazioni (I2.4): aggiorna i loghi dei PROVIDER DI MODELLI curati
// nel repo (src/renderer/src/assets/provider-logos). Uno file per KIND
// (ollama.svg, anthropic.svg, …): la UI li prende con import.meta.glob e
// finché uno manca mostra l'iniziale. Lo lanciamo NOI a mano dal Mac —
// l'app non scarica mai niente da sola.
//
// Fonte: i loghi pubblici di Composio, https://logos.composio.dev/api/<slug>
// (niente chiave). Per ogni kind si prova una LISTA di slug candidati e vince
// il primo che risponde 200 con un tipo noto; gli SVG passano dalla stessa
// sanitizeSvg di aggiorna-catalogo-composio.mjs (niente <script>, attributi
// on*, href esterni né <foreignObject>).
//
// Opzioni: --dry-run (non scrive nulla, stampa solo cosa troverebbe) ·
// --out <dir> (cartella d'uscita per la prova, default
// src/renderer/src/assets/provider-logos).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'src/renderer/src/assets/provider-logos')
const LOGO_CDN = 'https://logos.composio.dev/api/'
const LOGO_MAX_BYTES = 200 * 1024
const LOGO_TYPES = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/webp': 'webp' }

// kind → slug candidati su logos.composio.dev (vince il primo che risponde)
const KINDS = [
  { kind: 'ollama', slugs: ['ollama'] },
  { kind: 'lmstudio', slugs: ['lm_studio', 'lmstudio', 'lm-studio'] }, // nessuno esiste (2026-11-04): iniziale
  { kind: 'anthropic', slugs: ['anthropic', 'claude'] },
  { kind: 'openai', slugs: ['openai'] },
  { kind: 'mistral', slugs: ['mistral_ai', 'mistral'] },
  { kind: 'zai', slugs: ['z_ai', 'zai', 'z-ai', 'zhipu'] }, // nessuno esiste (2026-11-04): iniziale
  { kind: 'openrouter', slugs: ['openrouter'] },
  { kind: 'xai', slugs: ['xai', 'grok'] },
  { kind: 'deepseek', slugs: ['deepseek'] },
  { kind: 'groq', slugs: ['groq', 'groqcloud'] }
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const outDirIdx = args.indexOf('--out')
const outDir = outDirIdx >= 0 && args[outDirIdx + 1] ? args[outDirIdx + 1] : OUT_DIR

const log = (...a) => console.log('[loghi-provider]', ...a)

/** Ripulisce un SVG: niente <script>, attributi on*, href esterni né <foreignObject>. */
export function sanitizeSvg(svg) {
  return svg
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/>/gi, '')
    .replace(/\s+(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (whole, value) => {
      const v = value.replace(/^["']|["']$/g, '').trim()
      // si tengono SOLO i riferimenti interni (#id) e i relativi: mai http(s), // o data:
      return /^(#|\.{0,2}\/(?!\/))/.test(v) ? whole : ''
    })
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

/** Il primo logo che risponde tra gli slug candidati (o null). */
async function downloadFirst(slugs) {
  for (const slug of slugs) {
    const res = await fetch(`${LOGO_CDN}${encodeURIComponent(slug)}`, { redirect: 'follow' }).catch(() => null)
    if (!res || !res.ok) continue
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ext = LOGO_TYPES[type]
    if (!ext) continue
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > LOGO_MAX_BYTES) continue
    // logos.composio.dev risponde 200 ANCHE agli slug sconosciuti, con un
    // segnaposto grigio a griglia: non è un logo, si prova lo slug dopo
    if (ext === 'svg' && /composio-fallback-grid/.test(buf.toString('utf8'))) continue
    const bytes = ext === 'svg' ? Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8') : buf
    if (bytes.byteLength === 0) continue
    return { slug, ext, bytes }
  }
  return null
}

try {
  if (!dryRun) mkdirSync(outDir, { recursive: true })
  let ok = 0
  const missing = []
  for (const { kind, slugs } of KINDS) {
    const logo = await downloadFirst(slugs)
    const file = `${kind}.${logo?.ext ?? 'svg'}`
    if (!logo) {
      missing.push(kind)
      log(`${kind}: NESSUNO slug ha risposto (${slugs.join(', ')}): resta l'iniziale`)
      continue
    }
    const path = join(outDir, file)
    try {
      if (existsSync(path) && readFileSync(path).equals(logo.bytes)) {
        log(`${kind}: ${logo.slug} già aggiornato (${file})`)
        ok++
        continue
      }
    } catch { /* si riscrive */ }
    if (dryRun) {
      log(`${kind}: ${logo.slug} → ${file} (dry-run: nulla scritto)`)
    } else {
      writeFileSync(path, logo.bytes)
      log(`${kind}: ${logo.slug} → ${file}`)
    }
    ok++
  }
  log(`loghi: ${ok}/${KINDS.length}${missing.length ? ` · senza logo: ${missing.join(', ')} (per loro vale l'iniziale)` : ''}${dryRun ? ' (dry-run)' : ''}`)
  process.exit(0)
} catch (e) {
  console.error(`[loghi-provider] ${e.message ?? e}`)
  process.exit(1)
}
