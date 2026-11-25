#!/usr/bin/env node
// F5 (fase fondamenta): UN comando per chiudere una fase. La definizione di
// «fatto» è docs/FATTO.md (le spec la citano); qui la parte eseguibile: i
// passi 1–7, UNO alla volta (mai due insieme), ognuno con l'uscita completa
// su file e una riga in fatto-esito.md (esito · durata · percorso).
//
//   node scripts/fatto.mjs [--sonde fase-design,fase-b20-bug]
//
// Prima di tutto fotografa la cartella dei temporanei di sistema; alla fine
// confronta: ogni cartella NUOVA — di chiunque, anche degli agenti paralleli
// — è un errore. Conta anche i processi Electron e --homun-daemon DEL REPO
// per eseguibile (ps -axo pid=,comm=). Non fa commit, non tagga e non tocca
// il REPORT. Esce con 1 se un passo è rosso.
import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const USCITE = join(ROOT, 'fatto-uscite') // in .gitignore: i log restano leggibili dopo la corsa
const ESITO = join(ROOT, 'fatto-esito.md') // in .gitignore
const argv = process.argv.slice(2)
const sonde = (argv.includes('--sonde') ? argv[argv.indexOf('--sonde') + 1] : '')
  .split(',').map((s) => s.trim()).filter(Boolean)

const T0 = Date.now()
const stamp = (ms) => {
  const s = Math.round(ms / 100) / 10
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}
mkdirSync(USCITE, { recursive: true })
writeFileSync(join(USCITE, 'fotografia-iniziale.txt'), '') // riempita sotto, subito

/** Fotografia dell'elenco dei temporanei (il NOME basta: le nuove si vedono a fine corsa). */
const fotoTemporanei = (where) => {
  let names = []
  try { names = readdirSync(TMP_BASE).filter((n) => !n.startsWith('.')) } catch { /* la base non c'è */ }
  writeFileSync(join(USCITE, `fotografia-${where}.txt`), names.sort().join('\n') + '\n')
  return new Set(names)
}
const fotoPrima = fotoTemporanei('iniziale')

/** Un passo: comando (cmd, args…) e uscita in streaming sul file logFile (le sonde sono lunghe: si legge da terra). L'esito è dal CODICE di uscita: 0 = OK, tutto il resto = KO (nessun «undefined» che passa come verde). */
const esegui = (nome, cmd, args, logFile, { env } = {}) => new Promise((resolve) => {
  const t = Date.now()
  const path = join(USCITE, logFile)
  const fd = openSync(path, 'w')
  let risolto = false
  const chiudi = (oggetto) => { if (!risolto) { risolto = true; try { closeSync(fd) } catch { /* già chiuso */ } resolve(oggetto) } }
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...(env ?? {}) }, stdio: ['ignore', fd, fd] })
  child.on('close', (code) => {
    try { writeFileSync(path + '.code', String(code)) } catch { /* il file d'uscita resta quello che conta */ }
    chiudi({ nome, path, esito: code === 0 ? 'OK' : 'KO', code, ms: Date.now() - t, nota: code === 0 ? '' : `codice d'uscita ${code}` })
  })
  child.on('error', (e) => chiudi({ nome, path, esito: 'KO', code: -1, ms: Date.now() - t, nota: 'spawn: ' + e.message }))
})

// ---- i passi, uno alla volta ----
const passi = []
const aggiungi = (passo) => {
  if (passo.esito !== 'OK' && passo.esito !== 'salto') passo.esito = 'KO' // difensiva: nessun esito strano passa per verde
  passi.push(passo)
  console.log(`[fatto] ${passo.esito === 'OK' ? '✓' : passo.esito === 'salto' ? '»' : '✗'} ${passo.nome} · ${passo.esito === 'salto' ? 'salto' : stamp(passo.ms)}${passo.nota ? ` · ${passo.nota}` : ''} · ${passo.path}`)
}
const run = async () => {
  // 1. typecheck
  aggiungi(await esegui('typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit'], 'typecheck.log'))

  // 2. suite: npm test E test:ci-sim (Docker Desktop che non risponde compreso: la suite non lo dipende)
  aggiungi(await esegui('suite: npm test', 'npm', ['test'], 'suite-npm-test.log'))
  aggiungi(await esegui('suite: ci-sim', 'npm', ['run', 'test:ci-sim'], 'suite-ci-sim.log'))

  // 3. build: electron-vite build DIRETTO (l'hook prebuild scriverebbe in vendor/)
  aggiungi(await esegui('build', 'node_modules/.bin/electron-vite', ['build'], 'build.log'))

  // 4. galleria (dalla F1 in poi; prima non esiste: «salto» con nota, la corsa resta valida per misurare)
  const galleriaEsiste = spawnSync('node', ['-e', 'require("node:fs").accessSync("scripts/galleria.mjs")'], { cwd: ROOT }).status === 0
  if (galleriaEsiste) {
    aggiungi(await esegui('galleria', 'node', ['scripts/galleria.mjs'], 'galleria.log'))
  } else {
    aggiungi({ nome: 'galleria', esito: 'salto', ms: 0, path: join(USCITE, 'galleria.log'), nota: 'scripts/galleria.mjs non esiste ancora' })
    writeFileSync(join(USCITE, 'galleria.log'), 'salto: scripts/galleria.mjs non esiste ancora (fase precedente alla F1)\n')
  }

  // 5. sonde di comportamento, UNA alla volta, uscita su file
  if (sonde.length === 0) {
    aggiungi({ nome: 'sonde: nessuna sonda indicata', esito: 'OK', ms: 0, path: join(USCITE, 'sonde.log'), nota: '--sonde non usato' })
    writeFileSync(join(USCITE, 'sonde.log'), 'nessuna sonda indicata (--sonde non usato)\n')
  }
  for (const s of sonde) {
    const script = join(ROOT, 'scripts', `${s}-probe.mjs`)
    if (spawnSync('node', ['-e', 'require("node:fs").accessSync(process.argv[1])', script], { cwd: ROOT }).status !== 0) {
      aggiungi({ nome: `sonda ${s}`, esito: 'KO', ms: 0, path: join(USCITE, `sonda-${s}.log`), nota: `scripts/${s}-probe.mjs non esiste` })
      continue
    }
    aggiungi(await esegui(`sonda ${s}`, 'node', [script], `sonda-${s}.log`))
  }

  // 6. processi Electron e --homun-daemon DEL REPO, contati per eseguibile
  const t6 = Date.now()
  const comm = spawnSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout ?? ''
  const args = spawnSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout ?? ''
  const electronRe = /node_modules\/electron\/dist\/.+Electron/i
  const electronRighe = comm.split('\n').filter((l) => electronRe.test(l) && l.includes(ROOT) && !l.includes('vetrina'))
  const daemonRighe = args.split('\n').filter((l) => l.includes('--homun-daemon') && l.includes(ROOT))
  const path6 = join(USCITE, 'processi.txt')
  writeFileSync(path6, `pid,comm con Electron del repo (${ROOT}):\n${electronRighe.join('\n') || '(nessuna)'}\n\npid,args con --homun-daemon del repo:\n${daemonRighe.join('\n') || '(nessuna)'}\n`)
  aggiungi({ nome: 'processi del repo a 0', esito: electronRighe.length === 0 && daemonRighe.length === 0 ? 'OK' : 'KO', ms: Date.now() - t6, path: path6, nota: `${electronRighe.length} Electron, ${daemonRighe.length} daemon` })

  // 7. temporanei: ogni cartella NUOVA (di chiunque) rispetto alla fotografia iniziale è un errore
  const t7 = Date.now()
  const fotoDopo = fotoTemporanei('finale')
  const nuove = [...fotoDopo].filter((n) => !fotoPrima.has(n)).sort()
  const path7 = join(USCITE, 'temporanei.txt')
  writeFileSync(path7, `nuove rispetto a inizio corsa:\n${nuove.join('\n') || '(nessuna)'}\n`)
  aggiungi({ nome: 'nessuna temporanea nuova', esito: nuove.length === 0 ? 'OK' : 'KO', ms: Date.now() - t7, path: path7, nota: `${nuove.length} nuove` })

  // ---- fatto-esito.md: una riga per passo ----
  const rosso = passi.filter((p) => p.esito === 'KO')
  const righe = passi.map((p) => `| ${p.nome} | ${p.esito} | ${p.esito === 'salto' ? '—' : stamp(p.ms)} | ${p.path} |${p.nota ? ` ${p.nota}` : ''}`)
  writeFileSync(ESITO, [
    `# fatto — corsa del ${new Date().toISOString()}`,
    '',
    `Tempo totale: ${stamp(Date.now() - T0)} · esito: ${rosso.length === 0 ? 'VERDE' : 'ROSSO'}`,
    '',
    '| passo | esito | durata | uscita | nota |',
    '|---|---|---|---|---|',
    ...righe,
    ''
  ].join('\n'))
  console.log(rosso.length === 0
    ? `[fatto] VERDE in ${stamp(Date.now() - T0)} — esito in ${ESITO}`
    : `[fatto] ROSSO: ${rosso.map((r) => r.nome).join(', ')} — esito in ${ESITO}`)
  process.exit(rosso.length === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('[fatto] FATAL:', e?.stack ?? e)
  process.exit(1)
})
