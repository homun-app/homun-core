// Fase design (DS5): la prova dello script che trova gli EXPORT NON USATI del
// prodotto (scripts/esporta-inutilizzati.mjs): «tsc + grep», senza pacchetti
// nuovi. Qui le funzioni PURE — i nomi letti dalle dichiarazioni, gli import
// letti dai sorgenti, l'incrocio dei due — su testi di prova; la corsa vera
// (tsc che emette i .d.ts di tutto il prodotto) sta nel REPORT.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { census, exportsOfDts, importsOf, isTestFile, sourceFiles, LOADED_BY_CONFIG, STATUSES } from '../esporta-inutilizzati.mjs'
import { TEST_TMP_BASE } from '../../src/test-tmp'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'esporta-inutilizzati.mjs')

describe('esporta-inutilizzati: gli export, dalle dichiarazioni', () => {
  it('dichiarazioni, liste di esportazione (con «as» e type), default', () => {
    const dts = [
      'export declare function più(x: number): number;',
      'export declare const A = 1;',
      'export interface Pippo {',
      '  x: number;',
      '}',
      'export type Nome = string;',
      'export declare class Ciao {',
      '}',
      'export { uno, due as tre, type Quattro };',
      'export default declare const radice: number;'
    ].join('\n')
    expect(exportsOfDts(dts).sort()).toEqual(['A', 'Ciao', 'Nome', 'Pippo', 'Quattro', 'default', 'più', 'tre', 'uno'].sort())
  })
})

describe('esporta-inutilizzati: gli import, dai sorgenti', () => {
  it('statici (default, nominati, alias, type), a stella, d’effetto, ri-esportazioni, dinamici — di un alias conta il NOME ESPORTATO', () => {
    const src = [
      "import dif, { a, b as c, type D } from './uno'",
      "import type { E } from './due'",
      "import * as ns from './tre'",
      "import './quattro'",
      "export { f, g as h } from './cinque'",
      "export * from './sei'",
      "const { i, j } = await import('./sette')",
      "const m = await import('./otto')",
      // dentro una funzione, dopo una riga con una graffa aperta: i nomi sono SOLO quelli fra le graffe della destructuring
      "async function f(x) {\n  if (!x) return null\n  const { preso, altro: alias } = await import('./nove')\n  return preso(x)\n}",
      // la destructuring su più righe (come fanno i test che prendono mezza API)
      "const {\n  unoDue,\n  tre: aliasDiTre\n} = await import('./dieci')"
    ].join('\n')
    const imp = importsOf(src, '/repo/src/x.ts')
    expect(imp.map((x) => [x.spec, x.kind, x.named])).toEqual([
      ['./uno', 'import', ['default', 'a', 'b', 'D']],
      ['./due', 'import', ['E']],
      ['./tre', 'namespace', ['*']],
      ['./quattro', 'side-effect', []],
      ['./cinque', 're-export', ['f', 'g']], // «g as h»: dal modulo «cinque» si prende g (h è il nome con cui si ri-esporta)
      ['./sei', 're-export-star', ['*']],
      ['./sette', 'dynamic', ['i', 'j']],
      // prima le destructuring (nell'ordine del testo), poi i moduli presi per intero
      ['./nove', 'dynamic', ['preso', 'altro']],
      ['./dieci', 'dynamic', ['unoDue', 'tre']],
      ['./otto', 'dynamic', ['*']]
    ])
    // i moduli di fuori (i pacchetti) non si risolvono: niente bersaglio
    expect(importsOf("import { createHash } from 'node:crypto'", '/repo/src/x.ts')[0]!.target).toBeNull()
  })
  it('un modulo relativo si risolve al file che esiste (.ts, .tsx, index)', () => {
    const dir = mkdtempSync(join(TEST_TMP_BASE, 'esporta-inutilizzati-'))
    try {
      writeFileSync(join(dir, 'a.ts'), '')
      writeFileSync(join(dir, 'b.tsx'), '')
      mkdirSync(join(dir, 'cart'))
      writeFileSync(join(dir, 'cart', 'index.ts'), '')
      expect(importsOf("import { a } from './a'", join(dir, 'x.ts'))[0]!.target).toBe(join(dir, 'a.ts'))
      expect(importsOf("import { b } from './b'", join(dir, 'x.ts'))[0]!.target).toBe(join(dir, 'b.tsx'))
      expect(importsOf("import { c } from './cart'", join(dir, 'x.ts'))[0]!.target).toBe(join(dir, 'cart', 'index.ts'))
      expect(importsOf("import { z } from './nonc'", join(dir, 'x.ts'))[0]!.target).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('esporta-inutilizzati: l’incrocio', () => {
  // i file di prova sono VEROI su disco (in una temporanea di test): la risoluzione di un modulo relativo guarda il file system
  let base = ''
  const fixture = (path: string, text: string, dts: string | null, extra: Record<string, unknown> = {}) => {
    const full = join(base, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
    return { path: full, text, dts, ...extra }
  }
  beforeEach(() => { base = mkdtempSync(join(TEST_TMP_BASE, 'esporta-inutilizzati-censimento-')) })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('USATO · SOLO TEST · SOLO EVAL · SOLO LOCALE · INUTILIZZATO; i file mai importati; l’entry point non lo è mai', () => {
    const dtsA = 'export declare const usato: number;\nexport declare const soloTest: number;\nexport declare const soloEval: number;\nexport declare const locale: number;\nexport declare const morto: number;\n'
    const { rows, neverImported } = census([
      fixture('a.ts', 'export const usato = 1\nexport const soloTest = 2\nexport const soloEval = 3\nexport const locale = 4\nexport const morto = 5\nconst uso = locale + 1\n', dtsA),
      fixture('b.ts', "import { usato } from './a'\nexport const b = usato\n", 'export declare const b: number;\n'),
      fixture('__tests__/t.test.ts', "import { soloTest } from '../a'\n", null, { test: true }),
      fixture('eval/e.ts', "import { soloEval } from '../a'\n", null, { eval: true }),
      fixture('main.tsx', "import { b } from './b'\n", null),
      fixture('orfano.ts', 'export const nessuno = 1\n', 'export declare const nessuno: number;\n')
    ])
    expect(Object.fromEntries(rows.map((r) => [r.name, r.status]))).toEqual({ usato: 'USATO', soloTest: 'SOLO TEST', soloEval: 'SOLO EVAL', locale: 'SOLO LOCALE', morto: 'INUTILIZZATO', b: 'USATO', nessuno: 'INUTILIZZATO' })
    // il main.tsx dei conti viene elencato anche lui: gli entry point VERI sono quelli del repo (src/renderer/src/main.tsx), i file di prova stanno altrove
    expect(neverImported.map((f) => f.split('/').at(-1))).toEqual(['main.tsx', 'orfano.ts'])
  })
  it('un modulo preso per intero (stella, namespace, import dinamico intero) rende usati tutti i suoi export', () => {
    const dtsA = 'export declare const x: number;\nexport declare const y: number;\n'
    const { rows, starTargets } = census([
      fixture('a.ts', 'export const x = 1\nexport const y = 2\n', dtsA),
      fixture('b.ts', "import * as a from './a'\nexport const b = a.x\n", 'export declare const b: number;\n'),
      fixture('c.ts', "const { x } = await import('./a')\nexport const c = x\n", 'export declare const c: number;\n'),
      fixture('main.tsx', "const m = await import('./b')\n", null)
    ])
    // x e y di a, b di b: usati; c di c nessuno lo importa (è usato solo nel suo file, una volta)
    expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual(['x:USATO', 'y:USATO', 'b:USATO', 'c:INUTILIZZATO'])
    // a è preso per intero dalla stella, b dall'import dinamico intero (la destructuring di c NON conta come modulo intero)
    expect(starTargets.map((f) => f.split('/').at(-1)).sort()).toEqual(['a.ts', 'b.ts'])
  })
  it('i file di test sono riconosciuti; l’elenco degli stati è quello che stampa lo script', () => {
    expect(isTestFile('src/x/__tests__/y.test.ts')).toBe(true)
    expect(isTestFile('src/x/y.ts')).toBe(false)
    expect(STATUSES).toEqual(['INUTILIZZATO', 'SOLO LOCALE', 'SOLO TEST', 'SOLO EVAL'])
    expect(sourceFiles(join(ROOT, 'scripts')).length).toBeGreaterThan(5)
    // i file che carica la configurazione di vitest esistono davvero e sono quelli del config
    expect(LOADED_BY_CONFIG.every((f) => existsSync(join(ROOT, f)))).toBe(true)
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
    for (const f of LOADED_BY_CONFIG) expect(config).toContain(`'${f}'`)
  })
  // tsc emette le dichiarazioni di tutto il prodotto: nella suite intera, con tutte le coroutine, può superare i 5 s di default
  it('da riga di comando: --json scrive il censimento (con tsc) e la temporanea delle dichiarazioni sparisce', { timeout: 120_000 }, () => {
    const outDir = mkdtempSync(join(TEST_TMP_BASE, 'esporta-inutilizzati-out-'))
    try {
      const r = spawnSync(process.execPath, [SCRIPT, '--json', `--out=${outDir}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      expect(r.status, r.stderr).toBe(0)
      const j = JSON.parse(r.stdout)
      expect(j.summary.exports).toBeGreaterThan(100)
      expect(Object.keys(j.summary.byStatus).sort()).toEqual([...STATUSES].sort())
      expect(j.rows.every((x) => STATUSES.includes(x.status))).toBe(true)
      // le dichiarazioni di OGNI file del prodotto, con la stessa struttura delle cartelle
      expect(existsSync(join(outDir, 'src', 'shared', 'avatar.d.ts'))).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
