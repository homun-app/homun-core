// Copia i wasm di tree-sitter (core web-tree-sitter + grammatica bash) in
// vendor/. Così dev e test li trovano in <root>/vendor, ed electron-builder
// li include nella build tramite extraResources (→ Resources/vendor).
// Lo script è idempotente e gira su predev/pretest/prebuild.
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const vendor = join(root, 'vendor')
const sources = [
  ['web-tree-sitter', 'web-tree-sitter.wasm'],
  ['tree-sitter-bash', 'tree-sitter-bash.wasm']
]

mkdirSync(vendor, { recursive: true })
for (const [pkg, file] of sources) {
  copyFileSync(join(root, 'node_modules', pkg, file), join(vendor, file))
}
console.log(`[prepare-wasm] copiati in ${vendor}: ${sources.map(([, f]) => f).join(', ')}`)
