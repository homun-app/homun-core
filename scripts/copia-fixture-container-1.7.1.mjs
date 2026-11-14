#!/usr/bin/env node
// Fase box-apple-cli-vera (BAV1): copia le uscite VERE della CLI `container`
// 1.7.1 (cartella delle prove dal vivo) nelle fixture dei test, BYTE PER
// BYTE. L'unica cosa che cambia è la RADICE dei percorsi dell'utente vero:
// /Users/fabio/ → /Users/test/ (l'appRoot neutro di OBV1 — mai la home vera
// nei file del repo). Nessun'altra sostituzione: se una fixture cambia per
// mano d'altro, il test byte-per-byte la ferma.
//
//   node scripts/copia-fixture-container-1.7.1.mjs [src] [dst]
//
//   src  default /Users/fabio/SandBot/prompts/fixtures/container-1.7.1
//   dst  default src/main/sandbox/__tests__/fixtures/container-1.7.1 (repo)
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = resolve(process.argv[2] ?? '/Users/fabio/SandBot/prompts/fixtures/container-1.7.1')
const DST = resolve(process.argv[3] ?? join(ROOT, 'src', 'main', 'sandbox', '__tests__', 'fixtures', 'container-1.7.1'))

/** La radice dell'utente vero → la radice NEUTRA dei test (solo questa). */
const replaceRoot = (s) => s.split('/Users/fabio/').join('/Users/test/')

const files = readdirSync(SRC).filter((f) => f.endsWith('.txt')).sort()
if (!files.length) {
  console.error(`nessuna fixture .txt in ${SRC}`)
  process.exit(1)
}
mkdirSync(DST, { recursive: true })
let bytes = 0
for (const f of files) {
  const content = replaceRoot(readFileSync(join(SRC, f), 'utf8'))
  writeFileSync(join(DST, f), content)
  bytes += Buffer.byteLength(content)
  console.log(`${f} (${Buffer.byteLength(content)} byte)`)
}
console.log(`${files.length} fixture copiate in ${DST} (${bytes} byte, radice /Users/fabio/ → /Users/test/)`)
