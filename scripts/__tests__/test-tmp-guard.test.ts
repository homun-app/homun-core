// Fase ci-beta5 (CB1): NESSUN test scrive il percorso temporaneo del Mac di
// sviluppo. Le mkdtemp dei test passano da TEST_TMP_BASE (src/test-tmp.ts):
// dove quel percorso non esiste — la CI di GitHub — la base cade sulla
// cartella temporanea del sistema. Un percorso letterale nei test rompe i
// file su ogni altra macchina (ENOENT: due file non partivano affatto nella
// CI della beta.5). La guardia scorre tutti i *.test.ts sotto src/ e
// scripts/__tests__/ e fallisce se nel CODICE c'è il percorso letterale (i
// commenti non contano); l'unica eccezione ammessa è src/test-tmp.ts, dove
// quel percorso VIVE di proposito. Il percorso vietato si scrive a PEZZI
// anche qui, o la guardia troverebbe se stessa.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..')
/** il percorso vietato, costruito a pezzi: mai letterale in un file di test */
const FORBIDDEN = ['/var', 'folders'].join('/') + '/'
/** l'unica eccezione ammessa (dove il percorso di sviluppo vive di proposito) */
const ALLOWED = new Set([join('src', 'test-tmp.ts')])

/** Tutti i file *.test.ts sotto una cartella, ricorsivo. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue
      testFiles(p, out)
    } else if (name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

/**
 * Il CODICE senza commenti: // e slash-stella fuori dalle stringhe (dentro le
 * stringhe il percorso vietato si nasconde benissimo). I commenti non
 * contano: la regola è sul codice.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: '"' | "'" | '`' | null = null
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += n ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

describe('ci-beta5 (CB1): nessun test scrive il percorso temporaneo di sviluppo', () => {
  it('nessun *.test.ts sotto src/ e scripts/__tests__/ ha il percorso letterale nel codice (unica eccezione src/test-tmp.ts)', () => {
    const offenders: string[] = []
    for (const root of [join(REPO, 'src'), join(REPO, 'scripts', '__tests__')]) {
      for (const f of testFiles(root)) {
        const rel = relative(REPO, f)
        if (ALLOWED.has(rel)) continue
        if (stripComments(readFileSync(f, 'utf8')).includes(FORBIDDEN)) offenders.push(rel)
      }
    }
    expect(offenders, `percorso letterale nel codice di: ${offenders.join(', ')}`).toEqual([])
  })

  it('l\'eccezione ammessa esiste ed è SOLO quella: src/test-tmp.ts', () => {
    // la guardia sopra salta src/test-tmp.ts dal controllo sul CODICE; qui si
    // verifica che il file esista davvero (un\'eccezione fantasma coprirebbe
    // tutto) e che non cresca oltre quella singola voce
    expect([...ALLOWED]).toEqual([join('src', 'test-tmp.ts')])
    expect(statSync(join(REPO, 'src', 'test-tmp.ts')).isFile()).toBe(true)
  })
})
