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
import { openSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
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
const rows = []
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

/** Un passo: comando già in forma [file, args…], uscita in streaming sul file (le sonde sono lunghe: si legge da terra). */
const esegui = (nome, file, args, { env } = {}) => new Promise((resolve) => {
  const t = Date.now()
  const path = join(USCITE, file)
  const fd = openSync(path, 'w')
  const child = spawn(file, args, { cwd: ROOT, env: { ...process.env, ...(env ?? {}) }, stdio: ['ignore', fd, fd] })
  child.on('close', (code) => {
    try { writeFileSync(path + '.code', String(code)) } catch { /* il file d'uscita resta quello che conta */ }
    resolve({ nome, path, code, ms: Date.now() - t })
  })
  child.on('error', (e) => resolve({ nome, path, code: -1, ms: Date.now() - t, errore: e.message }))
})

const aggiungi = (passo, esito, ms, percorso, nota = '') => {
  rows.push({ passo, esito, ms, percorso, nota })
  console.log(`[fatto] ${esito === 'OK' ? '✓' : '✗'} ${passo} · ${stamp(ms)}${nota ? ` · ${nota}` : ''} · ${percorso}`)
}

// ---- i passi, uno alla volta ----
const passi = []
const run = async () => {
  // 1. typecheck
  passi.push(await esegui('typecheck', 'typecheck.log', ['node_modules/typescript/bin/tsc', '--noEmit']))

  // 2. suite: npm test E test:ci-sim (Docker Desktop che non risponde compreso: la suite non lo dipende)
  passi.push(await esegui('suite: npm test', 'suite-npm-test.log', ['npm', 'test']))
  passi.push(await esegui('suite: ci-sim', 'suite-ci-sim.log', ['npm', 'run', 'test:ci-sim']))

  // 3. build: electron-vite build DIRETTO (l'hook prebuild scriverebbe in vendor/)
  passi.push(await esegui('build', 'build.log', ['node_modules/.bin/electron-vite', 'build']))

  // 4. galleria (dalla F1 in poi; prima non esiste: «salto» con nota, la corsa resta valida per misurare)
  const galleriaEsiste = spawnSync('node', ['-e', 'require("node:fs").accessSync("scripts/galleria.mjs")'], { cwd: ROOT }).status === 0
  if (galleriaEsiste) {
    passi.push(await esegui('galleria', 'galleria.log', ['node', 'scripts/galleria.mjs']))
  } else {
    passi.push({ nome: 'galleria', esito: 'salto', ms: 0, path: join(USCITE, 'galleria.log'), nota: 'scripts/galleria.mjs non esiste ancora' })
    writeFileSync(join(USCITE, 'galleria.log'), 'salto: scripts/galleria.mjs non esiste ancora (fase precedente alla F1)\n')
  }

  // 5. sonde di comportamento, UNA alla volta, uscita su file
  if (sonde.length === 0) {
    passi.push({ nome: 'sonde: nessuna sonda indicata', esito: 'OK', ms: 0, path: join(USCITE, 'sonde.log'), nota: '--sonde non usato' })
    writeFileSync(join(USCITE, 'sonde.log'), 'nessuna sonda indicata (--sonde non usato)\n')
  }
  for (const s of sonde) {
    const script = join(ROOT, 'scripts', `${s}-probe.mjs`)
    if (spawnSync('node', ['-e', 'require("node:fs").accessSync(process.argv[1])', script], { cwd: ROOT }).status !== 0) {
      passi.push({ nome: `sonda ${s}`, esito: 'KO', ms: 0, path: join(USCITE, `sonda-${s}.log`), nota: `scripts/${s}-probe.mjs non esiste` })
      continue
    }
    const r = await esegui(`sonda ${s}`, `sonda-${s}.log`, ['node', script])
    passi.push({ ...r, nome: `sonda ${s}` })
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
  const ok6 = electronRighe.length === 0 && daemonRighe.length === 0
  passi.push({ nome: 'processi del repo a 0', esito: ok6 ? 'OK' : 'KO', ms: Date.now() - t6, path: path6, nota: `${electronRighe.length} Electron, ${daemonRighe.length} daemon` })

  // 7. temporanei: ogni cartella NUOVA (di chiunque) rispetto alla fotografia iniziale è un errore
  const t7 = Date.now()
  const fotoDopo = fotoTemporanei('finale')
  const nuove = [...fotoDopo].filter((n) => !fotoPrima.has(n)).sort()
  const path7 = join(USCITE, 'temporanei.txt')
  writeFileSync(path7, `nuove rispetto a inizio corsa:\n${nuove.join('\n') || '(nessuna)'}\n`)
  passi.push({ nome: 'nessuna temporanea nuova', esito: nuove.length === 0 ? 'OK' : 'KO', ms: Date.now() - t7, path: path7, nota: `${nuove.length} nuove` })

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
