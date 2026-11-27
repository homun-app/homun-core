#!/usr/bin/env node
// Fase design (DS5): gli EXPORT NON USATI del prodotto. «tsc + grep», senza
// pacchetti nuovi: TypeScript (quello del repo) emette i .d.ts di OGNI file
// del prodotto — da lì i nomi esportati, letti come li scrive il compilatore —
// e i sorgenti si leggono con espressioni regolari per gli import (statici,
// di tipo, dinamici, ri-esportazioni). Per OGNI export di un file del
// prodotto dice chi lo usa:
//   USATO        — lo importa almeno un file del prodotto
//   SOLO TEST    — lo importano solo i test
//   SOLO EVAL    — lo importa solo eval/ (fuori dal prodotto impacchettato)
//   SOLO LOCALE  — lo usa solo il suo file (la parola `export` non serve)
//   INUTILIZZATO — nessuno lo importa e nel suo file compare solo alla dichiarazione
// e in più i FILE che il prodotto non importa mai (gli entry point a parte).
//
//   node scripts/esporta-inutilizzati.mjs [--json] [--out=<cartella>]
//
// --out: dove scrivere i .d.ts (default: una mkdtemp nella base temporanea
//        condivisa degli script — scripts/lib/base-temporanea.mjs, la regola
//        della suite: la cartella del Mac se c'è, altrimenti quella di
//        sistema —, cancellata alla fine). Uscita 0 sempre: è
//        un censimento, non un test. Non tocca nulla: legge i sorgenti e
//        scrive solo nella cartella dei .d.ts.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { baseTemporanea } from './lib/base-temporanea.mjs'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const EVAL = join(ROOT, 'eval')

/** Gli entry point: da loro parte l'esecuzione, nessuno li importa. */
export const ENTRY_POINTS = ['src/renderer/src/main.tsx', 'src/main/index.ts', 'src/daemon/index.ts', 'src/preload/index.ts']

export const STATUSES = ['INUTILIZZATO', 'SOLO LOCALE', 'SOLO TEST', 'SOLO EVAL']
/** I file che nessun sorgente importa PERCHÉ li carica la configurazione di vitest (setupFiles, globalSetup). */
export const LOADED_BY_CONFIG = ['src/test-setup.ts', 'src/test-tmp-guard.ts']

// ---- lettura dei file ----

/** Tutti i file .ts/.tsx/.mts di una cartella (senza .d.ts e node_modules), in ordine. */
export function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') sourceFiles(p, out)
    } else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

export const rel = (p) => relative(ROOT, p)
export const isTestFile = (p) => /(^|\/)__tests__\//.test(p) || /\.test\.(ts|tsx|mts)$/.test(p)

// ---- gli export, dai .d.ts ----

/** I nomi esportati da un .d.ts, come li scrive tsc. */
export function exportsOfDts(text) {
  const names = new Set()
  // un identificatore JavaScript: lettere non ASCII comprese (più, à…)
  const decl = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)/gmu
  for (const m of text.matchAll(decl)) names.add(m[1])
  if (/^export\s+default\b/m.test(text)) names.add('default')
  // export { a, b as c, type D } — valgono i NOMI esposti (quelli dopo «as»)
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const spec = part.trim().replace(/^type\s+/, '')
      if (!spec) continue
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(spec)
      names.add(as ? as[1] : spec)
    }
  }
  return [...names].filter((n) => n && !['from', 'type', 'as'].includes(n))
}

// ---- gli import, dai sorgenti ----

/** Risolve uno specifier relativo ('./x', '../y/z') al file del prodotto (null se non è relativo o non c'è). */
export function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, 'index.ts'), join(base, 'index.tsx'), base]) {
    if (/\.(ts|tsx|mts)$/.test(cand) && existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/** I nomi di una lista fra graffe: `a, b as c, type D, e: string`. */
const namesOfList = (list) => {
  const out = []
  for (const part of list.split(',')) {
    const spec = part.trim().replace(/^type\s+/, '').replace(/:.*$/, '')
    if (!spec) continue
    // `a as b` in un import prende DAL MODULO «a» (b è il nome locale): conta «a»; in una destructuring `a: b` conta «a»
    const as = /\bas\s+/.exec(spec)
    out.push(as ? spec.split(/\s+as\s+/)[0] : spec)
  }
  return out
}

/**
 * Gli import di un sorgente: per OGNI modulo importato i nomi presi
 * ('default', i named, '*' per namespace, stella e modulo intero).
 * PURA rispetto al testo e al percorso del file.
 */
export function importsOf(text, fromFile) {
  const out = []
  const push = (spec, named, kind) => {
    out.push({ spec, target: resolveRelative(fromFile, spec), named: named.filter(Boolean), kind })
  }
  // import x, { a, b as c, type D } from '…' · import type { … } from '…'
  for (const m of text.matchAll(/\bimport\s+(type\s+)?([\w$]+)?\s*(?:,\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const named = []
    if (m[2]) named.push('default')
    if (m[3]) named.push(...namesOfList(m[3]))
    push(m[4], m[1] === 'type' ? named : named, 'import')
  }
  // import * as ns from '…'
  for (const m of text.matchAll(/\bimport\s*\*\s*as\s+[\w$]+\s+from\s*["']([^"']+)["']/g)) push(m[1], ['*'], 'namespace')
  // import '…' (solo effetto)
  for (const m of text.matchAll(/\bimport\s*["']([^"']+)["']/g)) push(m[1], [], 'side-effect')
  // export { a } from '…' · export * from '…'
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) push(m[2], namesOfList(m[1]), 're-export')
  for (const m of text.matchAll(/\bexport\s*\*\s*from\s*["']([^"']+)["']/g)) push(m[1], ['*'], 're-export-star')
  // import dinamici: const { a, b } = await import('…') prende quei nomi; const m = await import('…') prende il modulo intero
  // dentro le graffe ci stanno solo nomi (su più righe, ma NIENTE altre graffe): con [^}]* la ricerca
  // partiva da una graffa APERTA molto prima (il corpo della funzione) e i nomi letti erano
  // spazzatura — l'export risultava «inutilizzato» mentre era usato
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)/g)) push(m[2], namesOfList(m[1]), 'dynamic')
  // il modulo intero (const m = await import(…)): la forma con la destructuring ({ a } = await import(…)) è già contata sopra
  for (const m of text.matchAll(/=\s*(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const prima = text.slice(0, m.index).trimEnd()
    if (prima.endsWith('}')) continue
    // il modulo preso per intero, poi letto per proprietà (m.exportName): contano come presi i nomi
    // che in QUESTO file compaiono dopo un punto — cautelativo (può lasciare un inutilizzato non visto, mai il contrario)
    const letti = [...new Set([...text.matchAll(/\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))]
    push(m[1], ['*', ...letti], 'dynamic')
  }
  return out
}

// ---- il censimento ----

/**
 * PURA: incrocia export e import. `files` = [{ path, text, dts, test?, eval? }]
 * di OGNI sorgente (test ed eval flaggati; dts = testo della dichiarazione
 * o null). Torna le righe del censimento, i file mai importati e i moduli
 * presi per intero (namespace o stella: di loro non si dice nulla).
 */
export function census(files) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const exported = new Map(files.map((f) => [f.path, f.dts ? exportsOfDts(f.dts) : []]))
  /** chi prende che nome da che modulo: target → nome → insieme di kind */
  const used = new Map()
  const note = (target, name, kind) => {
    if (!used.has(target)) used.set(target, new Map())
    const m = used.get(target)
    if (!m.has(name)) m.set(name, new Set())
    m.get(name).add(kind)
  }
  const starTargets = new Set()
  const importersOf = new Map()
  for (const f of files) {
    const kind = f.test ? 'test' : f.eval ? 'eval' : 'prod'
    for (const imp of importsOf(f.text, f.path)) {
      if (!imp.target) continue
      if (!importersOf.has(imp.target)) importersOf.set(imp.target, new Set())
      importersOf.get(imp.target).add(f.path)
      for (const n of imp.named) {
        note(imp.target, n, kind)
        if (n === '*') {
          // il modulo intero: ogni suo export conta come preso
          starTargets.add(imp.target)
          for (const name of exported.get(imp.target) ?? []) note(imp.target, name, kind)
        }
      }
    }
  }
  const localUses = (text, name) => (text.match(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) ?? []).length
  const rows = []
  for (const [path, names] of exported) {
    const f = byPath.get(path)
    if (!f || f.test || f.eval) continue
    for (const name of names) {
      if (name === 'default') continue
      const kinds = used.get(path)?.get(name) ?? new Set()
      const local = localUses(f.text, name)
      const status = kinds.has('prod')
        ? 'USATO'
        : kinds.has('test')
          ? 'SOLO TEST'
          : kinds.has('eval')
            ? 'SOLO EVAL'
            : local <= 1
              ? 'INUTILIZZATO'
              : 'SOLO LOCALE'
      rows.push({ file: rel(path), name, status, localUses: local })
    }
  }
  const neverImported = files
    .filter((f) => !f.test && !f.eval && !importersOf.has(f.path) && !ENTRY_POINTS.includes(rel(f.path)) && !LOADED_BY_CONFIG.includes(rel(f.path)))
    .map((f) => rel(f.path))
  return { rows, neverImported, starTargets: [...starTargets].map(rel) }
}

/** La riga del .d.ts di un sorgente dentro la cartella delle dichiarazioni. */
const dtsPathOf = (outDir, sourcePath) => join(outDir, rel(sourcePath).replace(/\.(ts|tsx|mts)$/, '.d.ts'))

// ---- CLI ----

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json')
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
  const ownTmp = outArg === undefined
  const outDir = outArg ?? mkdtempSync(`${baseTemporanea()}/sandbot-esporta-inutilizzati-`)
  const t0 = Date.now()
  const cleanup = () => {
    if (ownTmp) rmSync(outDir, { recursive: true, force: true })
  }
  try {
    mkdirSync(outDir, { recursive: true })
    // le dichiarazioni di OGNI file: il tsconfig del repo, solo .d.ts
    const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['--project', join(ROOT, 'tsconfig.json'), '--declaration', '--emitDeclarationOnly', '--noEmit', 'false', '--outDir', outDir], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0 && !existsSync(dtsPathOf(outDir, join(SRC, 'shared', 'avatar.ts')))) {
      console.error('tsc (dichiarazioni) fallito:\n' + String(r.stderr ?? '').slice(0, 2000))
      return 1
    }
    const dtsOf = (p) => {
      const d = dtsPathOf(outDir, p)
      return existsSync(d) ? readFileSync(d, 'utf8') : null
    }
    const files = [
      ...sourceFiles(SRC).map((p) => ({ path: p, text: readFileSync(p, 'utf8'), dts: dtsOf(p), test: isTestFile(rel(p)) })),
      ...sourceFiles(EVAL).map((p) => ({ path: p, text: readFileSync(p, 'utf8'), dts: null, eval: true }))
    ]
    const { rows, neverImported, starTargets } = census(files)
    const unused = rows.filter((x) => x.status !== 'USATO')
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, unused.filter((x) => x.status === s).length]))
    const summary = { exports: rows.length, notUsed: unused.length, byStatus, neverImported: neverImported.length, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) }
    if (json) {
      console.log(JSON.stringify({ summary, rows: unused, neverImported, starTargets }, null, 2))
      return 0
    }
    for (const status of STATUSES) {
      const perFile = new Map()
      for (const x of unused.filter((y) => y.status === status)) {
        if (!perFile.has(x.file)) perFile.set(x.file, [])
        perFile.get(x.file).push(x.name)
      }
      for (const [file, names] of [...perFile.entries()].sort()) console.log(`${status}\t${file}\t${names.join(', ')}`)
    }
    for (const f of neverImported) console.log(`FILE MAI IMPORTATO\t${f}`)
    console.log(`\n${summary.exports} export del prodotto · ${summary.notUsed} fuori dal prodotto: ${STATUSES.map((s) => `${s} ${byStatus[s]}`).join(' · ')} · file mai importati: ${neverImported.length} · moduli presi per intero: ${starTargets.length} · ${summary.seconds} s`)
    return 0
  } finally {
    cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  // exitCode e non process.exit(): il processo esce da solo quando lo stdout ha scritto tutto (exit tagliava l'output lungo su una pipe)
  process.exitCode = main()
}
