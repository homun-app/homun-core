#!/usr/bin/env node
// P2 (fase primo-avvio): RIPRODUZIONE del difetto «Homun si apre e non si
// vede niente» con l'app IMPACCHETTATA (--dir, non firmata) e SOLO
// SANDBOT_TEST_USER_DATA in una temporanea. Mai /Applications/Homun.app, mai
// i dati veri, mai osascript: le finestre si guardano dal di fuori con
// window-list (Swift, sola lettura).
//
//   node scripts/fase-primo-avvio-p2-riproduzione.mjs --app=<temporanea>/Homun.app [--avvii=3] [--timeline] [--daemon-sotto]
//
// Le ipotesi della spec (--ipotesi, la modalità di default), ognuna con
// `avvii` avvii a freddo (processo UI non vivo, stessa cartella dati riusata
// come per l'utente):
//   H1a  il daemon della corsa prima è ancora VIVO (il primo avvio del giorno);
//   H1b  c'è un daemon.json di un'ALTRA build, con il suo processo vivo;
//   H1c  cartella «calda», dopo un avvio riuscito, con il daemon fermo;
//   H3   l'app parte mentre un'altra ha il fuoco: dall'eseguibile (mai
//        attivata da LaunchServices), con `open` (il Finder) e con
//        `open -g` (in background); poi il clic sul Dock, vero (`open`
//        all'app che gira) e dal gancio di prova;
//   H2   il renderer arriva al primo paint? (did-finish-load → renderer-ready)
//   H4  quello che si trova leggendo le righe (quante finestre nascono dopo
//        un activate, chi tiene i file LOCK del profilo).
// Le due prove mirate che le righe di sopra hanno chiesto:
//   --timeline       avvio per avvio (con `open`, come dal Dock) la linea del
//                    tempo di fuoco, visibilità e copertura della finestra,
//                    col daemon GIA VIVO e col daemon che PARTE durante
//                    l'avvio: è il daemon che si porta via l'attivazione?
//   --daemon-sotto   l'UI è davanti e ha il fuoco, col daemon vivo; il daemon
//                    viene fermato e la UI lo fa ripartire: la finestra perde
//                    il fuoco o finisce dietro proprio quando parte il daemon?
// A ogni avvio stampa le righe di P1 del registro della temporanea, la
// fotografia della finestra e quello che dice il sistema (layer, alpha,
// onscreen, ordine z). Non corregge niente: guarda.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  TMP_BASE, sleep, resolveTestApp, compileWindowList, windowList, onScreenWindow, coveredByWindowsInFront,
  writeFakeContainer, appEnv, launchExecutable, launchWithOpen, reopenWithOpen, findAppProcesses, appActivation,
  pidAlive, waitPidGone, waitFor, readMainLog, uiBootSince, lastUiBoot, msOf, openCdp, mainTarget, pageEval,
  startFakeProvider, closeGuide
} from './lib/primo-avvio.mjs'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const argv = process.argv.slice(2)
const AVVII = Number(argv.find((a) => a.startsWith('--avvii='))?.slice('--avvii='.length) ?? 3)
const IPOTESI = argv.includes('--ipotesi') || (!argv.includes('--timeline') && !argv.includes('--daemon-sotto'))
const TIMELINE = argv.includes('--timeline')
// --timeline-exec: la linea del tempo con l'avvio dall'eseguibile (mai attivato da LaunchServices)
const TIMELINE_EXEC = argv.includes('--timeline-exec')
const DAEMON_SOTTO = argv.includes('--daemon-sotto')
const { app, exe } = resolveTestApp(argv)
const PREFIX = 'sandbot-fase-primo-avvio-p2'
// lo strumento di lettura (window-list) viene compilato nella cartella di
// lavoro; la cancellazione sta nel finally, così un errore in qualunque punto
// non lascia cartelle in giro
const WORK = mkdtempSync(join(TMP_BASE, `${PREFIX}-lavoro-`))
const DATA = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
const REAL_DATA = realpathSync(DATA) // lsof stampa i percorsi risolti (/private/var/…)
const WIN = join(WORK, 'window-list')
const FAKE_CONTAINER = writeFakeContainer(DATA)
const ENV = appEnv(DATA, FAKE_CONTAINER)
const PORT = 9497
const log = (...a) => console.log('[P2]', ...a)

// ---- pulizia in ogni caso ----
const cleanup = async () => {
  for (const p of findAppProcesses(DATA, exe)) {
    try { process.kill(p.pid, 'SIGTERM') } catch { /* già via */ }
    await waitPidGone(p.pid, 8_000)
    if (pidAlive(p.pid)) { try { process.kill(p.pid, 'SIGKILL') } catch { /* già via */ } }
  }
  await stopProbeDaemons(PREFIX, { log })
  try { fakeOld?.kill('SIGKILL') } catch { /* già via */ }
  for (let i = 0; i < 40 && findAppProcesses(DATA, exe).length > 0; i++) await sleep(200)
  for (const dir of [DATA, WORK]) {
    for (let i = 0; i < 3 && existsSync(dir); i++) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* si ritenta */ }
      if (existsSync(dir)) await sleep(500)
    }
  }
  await provider.close().catch(() => undefined)
  const left = [DATA, WORK].filter(existsSync)
  log('pulizia:', left.length ? `ERRORE cartelle rimaste: ${left.join(', ')}` : 'cartelle temporanee cancellate', `· processi dell'app di prova rimasti: ${findAppProcesses(DATA, exe).length}`)
}
process.on('SIGINT', () => { void cleanup().then(() => process.exit(130)) })
process.on('SIGTERM', () => { void cleanup().then(() => process.exit(143)) })

// ---- il modello FINTO (serve solo a chiudere la guida nel setup) ----
const provider = await startFakeProvider()

// ---- il finto daemon VECCHIO (H1b): riga di comando con --homun-daemon,
// porta CHIUSA, dopo 5 s cambia il custode di daemon.json ----
const FAKE_OLD = join(DATA, 'finto-daemon-vecchio.cjs')
writeFileSync(FAKE_OLD, [
  '// daemon VECCHIO finto della riproduzione (mai un server vero)',
  'const fs = require("node:fs")',
  'const file = process.argv[2]',
  'setTimeout(() => {',
  '  const info = JSON.parse(fs.readFileSync(file, "utf8"))',
  '  info.pid = 999999999',
  '  fs.writeFileSync(file, JSON.stringify(info, null, 2))',
  '}, 5000)',
  'setInterval(() => {}, 10000)'
].join('\n'))
let fakeOld = null
const plantOtherBuildDaemon = () => {
  const dir = join(DATA, 'data')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'daemon.json')
  fakeOld = spawn(process.execPath, [FAKE_OLD, file, '--homun-daemon'], { stdio: 'ignore' })
  writeFileSync(file, JSON.stringify({ pid: fakeOld.pid, port: 65533, token: 'finto-vecchio', startedAt: Date.now() - 5_000, version: '0.3.1000-finta', build: 'finta-vecchia' }, null, 2) + '\n', { mode: 0o600 })
  return fakeOld.pid
}

// ---- CDP ----

// ---- cosa dice il sistema della finestra del processo UI ----
const systemView = (uiPid) => {
  const mine = windowList(WIN, uiPid)
  const { win, inside } = onScreenWindow(mine)
  const covered = win ? coveredByWindowsInFront(windowList(WIN, 0), win, mine.screens) : 0
  return {
    aSchermo: win !== null && inside >= 0.5,
    davanti: win !== null && covered < 0.1,
    layer: win?.layer ?? null,
    alpha: win?.alpha ?? null,
    onscreen: win?.onscreen ?? null,
    z: win?.z ?? null,
    bounds: win ? `${win.x},${win.y},${win.w}x${win.h}` : null,
    inside,
    covered,
    finestre: (mine.windows ?? []).map((w) => `#${w.number} layer=${w.layer} alpha=${w.alpha} onscreen=${w.onscreen} ${Math.round(w.w)}x${Math.round(w.h)}`)
  }
}

/** Quale processo dell'app di prova (solo QUELLA copia: stesso bundle dell'app vera) macOS considera attivo. */
const activationView = (uiPid) => {
  const a = appActivation(WIN)
  // bundleURL è il percorso RISOLTO (/private/var/…): si confronta con quello
  const mine = a.apps.filter((x) => x.url.startsWith(realpathSync(app)) && !x.terminated)
  const active = mine.find((x) => x.active)
  const front = mine.some((x) => x.pid === a.frontmostPid)
  return {
    att: active ? (active.pid === uiPid ? 'UI' : 'DAEMON') : '-',
    front: front ? 'prova' : 'altra',
    pol: mine.map((x) => `${x.pid === uiPid ? 'UI' : 'D'}:${x.policy}${x.active ? '*' : ''}`).join(' ')
  }
}

/** I file della cartella dati aperti dai processi dell'app (lsof, raggruppati per processo). */
const openFilesOf = () => {
  const procs = findAppProcesses(DATA, exe)
  if (procs.length === 0) return {}
  const out = spawnSync('/usr/sbin/lsof', ['-p', procs.map((p) => p.pid).join(','), '-F', 'pn'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const byPid = {}
  let pid = null
  for (const line of String(out.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      byPid[pid] = []
    } else if (line.startsWith('n') && pid !== null) {
      const p = line.slice(1)
      if (p.startsWith(REAL_DATA)) byPid[pid].push(p.slice(REAL_DATA.length + 1))
    }
  }
  return byPid
}

/** Chi tiene i file LOCK del profilo Chromium nella temporanea (lsof, percorsi risolti). */
const lockHolders = () => {
  const locks = ['Local Storage/leveldb/LOCK', 'Session Storage/leveldb/LOCK', 'LOCK', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']
    .map((f) => join(REAL_DATA, f))
    .filter((p) => existsSync(p))
  if (locks.length === 0) return { locks: [], holders: [] }
  const out = spawnSync('/usr/sbin/lsof', ['-F', 'pn', ...locks], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const holders = []
  let pid = null
  for (const line of String(out.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== null) holders.push({ pid, file: line.slice(1).slice(REAL_DATA.length + 1) })
  }
  return { locks: locks.map((p) => p.slice(REAL_DATA.length + 1)), holders }
}

const snapshots = (boot) => boot.lines.filter((l) => l.event === 'window-snapshot').map((l) => l.f)
const countOf = (boot, event) => (boot ? boot.lines.filter((l) => l.event === event).length : 0)
const daemonBootMsOf = (boot) => {
  const at = boot?.lines.find((l) => l.event === 'boot' && l.f.mode === 'daemon')?.at
  return at === undefined ? null : at - boot.bootAt
}

/** Lancia l'app (dall'eseguibile o con open) e torna il pid della UI. */
async function launch(style) {
  if (style === 'exec') return launchExecutable(exe, ENV, { debugPort: PORT })
  launchWithOpen(app, exe, ENV, { debugPort: PORT, background: style === 'open-g' })
  const pid = await waitFor(() => findAppProcesses(DATA, exe).find((p) => p.main && !p.daemon)?.pid ?? null, 20_000)
  if (!pid) throw new Error(`l'app partita con open (${style}) non si trova (pid)`)
  return { pid, exited: waitFor(() => (pidAlive(pid) ? null : 0), 10 * 60_000, 200), output: () => '', kill: () => undefined, viaOpen: true }
}

/** Esce come ⌘Q (app.quit() vera dal renderer), altrimenti SIGTERM; aspetta l'uscita VERA. */
async function quit(run, cdp) {
  if (cdp) await pageEval(cdp, 'return await window.sandbot.testEmitQuit()', 4_000).catch(() => undefined)
  if (pidAlive(run.pid)) { try { process.kill(run.pid, 'SIGTERM') } catch { /* già via */ } }
  if (!(await waitPidGone(run.pid, 12_000))) { try { process.kill(run.pid, 'SIGKILL') } catch { /* già via */ } }
  await Promise.race([run.exited, sleep(3_000)])
  cdp?.sock?.close?.()
}

/** UN avvio a freddo: lancia, aspetta la fotografia di P1 (o il timeout), guarda, prova il Dock, esce. */
async function coldStart(label, { style = 'exec', dock = true } = {}) {
  const before = readMainLog(DATA).chars
  const t0 = Date.now()
  const run = await launch(style)
  const uiPid = run.pid
  // la fotografia di P1 arriva 5 s dopo window-shown: le do' fino a 30 s
  await waitFor(() => {
    const b = uiBootSince(readMainLog(DATA).text, before)
    return b && msOf(b, 'window-snapshot') !== null ? b : null
  }, 30_000)
  const waited = Date.now() - t0
  const b = uiBootSince(readMainLog(DATA).text, before)

  let cdp = null
  const target = await mainTarget(PORT).catch(() => null)
  if (target) cdp = await openCdp(target.webSocketDebuggerUrl).catch(() => null)
  const visibility = cdp ? await pageEval(cdp, 'return document.visibilityState').catch(() => 'niente') : 'niente'

  const sistema = systemView(uiPid)
  const files = openFilesOf()
  const daemonsBeforeDock = findAppProcesses(DATA, exe).filter((p) => p.daemon).length

  // ---- il clic sul Dock ----
  let dockResult = null
  if (dock) {
    const createdBefore = countOf(b, 'window-created')
    if (style === 'exec') {
      // il Dock delle sonde: il gancio di prova emette l'activate VERO del processo
      if (cdp) await pageEval(cdp, 'return await window.sandbot.testEmitActivate()').catch(() => undefined)
    } else {
      // il Dock VERO: `open` all'app che gira la riattiva (reopen) — attivazione di sistema compresa
      reopenWithOpen(app)
    }
    await sleep(2_500)
    dockResult = { createdBefore, createdAfter: countOf(uiBootSince(readMainLog(DATA).text, before), 'window-created') }
  }
  const dopoDock = systemView(uiPid)

  await quit(run, cdp)
  // il registro dell'avvio, RILETTO dopo l'uscita: dentro anche il Dock e l'uscita
  const full = uiBootSince(readMainLog(DATA).text, before)

  const ms = (e) => msOf(full, e)
  const s = full ? snapshots(full).at(-1) ?? null : null
  return {
    label,
    style,
    uiPid,
    waited,
    ms: {
      'ready-to-show': ms('ready-to-show'),
      'window-shown': ms('window-shown'),
      'did-start-loading': ms('did-start-loading'),
      'dom-ready': ms('dom-ready'),
      'did-finish-load': ms('did-finish-load'),
      'renderer-ready': ms('renderer-ready'),
      'daemon-connected': ms('daemon-connected')
    },
    rendererPronto: ms('renderer-ready') !== null && ms('renderer-ready') <= 10_000,
    falliti: full ? full.lines.filter((l) => ['did-fail-load', 'render-process-gone', 'unresponsive', 'daemon-connect-failed'].includes(l.event)).map((l) => l.raw.slice(24)) : [],
    snapshot: s,
    visibility,
    sistema,
    dopoDock,
    dock: dockResult,
    files,
    daemonsBeforeDock,
    daemonBootMs: daemonBootMsOf(full),
    raw: full ? full.lines.map((l) => l.raw) : [],
    output: run.output().slice(-600)
  }
}

const fmtMs = (v) => (v === null ? '—' : `${v}`)
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`)
const print = (r) => {
  log('')
  log(`▶ ${r.label}  [${r.style}]  UI pid ${r.uiPid}`)
  log(`   daemon: ${r.daemonBootMs === null ? 'NON partito in questo avvio (era già vivo)' : `boot del daemon a +${r.daemonBootMs} ms dalla UI`} · daemon vivi prima del clic ${r.daemonsBeforeDock}`)
  log(`   registro: ready-to-show ${fmtMs(r.ms['ready-to-show'])} ms · window-shown ${fmtMs(r.ms['window-shown'])} · did-start-loading ${fmtMs(r.ms['did-start-loading'])} · dom-ready ${fmtMs(r.ms['dom-ready'])} · did-finish-load ${fmtMs(r.ms['did-finish-load'])} · renderer-ready ${fmtMs(r.ms['renderer-ready'])} · daemon-connected ${fmtMs(r.ms['daemon-connected'])}`)
  log(`   fotografia P1 (5 s dopo il show): ${r.snapshot ? `visible=${r.snapshot.visible} minimized=${r.snapshot.minimized} focused=${r.snapshot.focused} fullscreen=${r.snapshot.fullscreen} bounds=${r.snapshot.bounds} display=${r.snapshot.display} inside=${r.snapshot.inside} displays=${r.snapshot.displays} app-hidden=${r.snapshot['app-hidden']} loading=${r.snapshot.loading} renderer-ready=${r.snapshot['renderer-ready']}` : 'NESSUNA (la finestra non si è mai mostrata)'}`)
  log(`   sistema (window-list): a schermo=${r.sistema?.aSchermo ? 'SÌ' : 'NO'} layer=${r.sistema?.layer} alpha=${r.sistema?.alpha} onscreen=${r.sistema?.onscreen} z=${r.sistema?.z} bounds=${r.sistema?.bounds} dentro-schermo=${pct(r.sistema?.inside)} coperta=${pct(r.sistema?.covered)}  visibilityState=${r.visibility}`)
  log(`   finestre del processo: ${r.sistema?.finestre.length ?? 0} → ${r.sistema?.finestre.join(' | ') || 'nessuna'}`)
  log(`   clic sul Dock: finestre create prima ${r.dock?.createdBefore} → dopo ${r.dock?.createdAfter}; dopo il clic: a schermo=${r.dopoDock?.aSchermo ? 'SÌ' : 'NO'} z=${r.dopoDock?.z} coperta=${pct(r.dopoDock?.covered)} finestre=${r.dopoDock?.finestre.length}`)
  if (r.falliti.length) log(`   righe di errore: ${r.falliti.join(' ;; ')}`)
  log('   righe del registro (questo avvio, main.log della temporanea):')
  for (const raw of r.raw) log('     ' + raw)
}

// ---- il setup: la prima volta la guida si chiude (provider finto, un bot) ----
async function setup() {
  const run = launchExecutable(exe, ENV, { debugPort: PORT })
  const target = await waitFor(() => mainTarget(PORT), 40_000)
  if (!target) throw new Error('nessuna pagina principale nel setup: ' + run.output().slice(-800))
  const cdp = await openCdp(target.webSocketDebuggerUrl)
  const chiusa = await closeGuide(cdp, provider.port)
  await quit(run, cdp)
  log('setup fatto:', chiusa ? 'guida chiusa, un bot, cartella dati pronta' : 'ATTENZIONE: la guida non risulta chiusa')
}

const stopDaemons = async () => {
  await stopProbeDaemons(PREFIX, { log })
  for (let i = 0; i < 40 && findProbeDaemons(PREFIX).length > 0; i++) await sleep(200)
}
const ensureDaemonAlive = async () => {
  if (findProbeDaemons(PREFIX).length > 0) return
  // un avvio che scalda il daemon (non si conta), poi l'UI esce e il daemon resta
  const r = await launch('exec')
  await waitFor(() => findProbeDaemons(PREFIX).length > 0, 20_000)
  await sleep(1_500)
  await quit(r, null)
}

// ---- --timeline: la linea del tempo del fuoco, avvio per avvio ----
async function timeline(label, style) {
  const before = readMainLog(DATA).chars
  const t0 = Date.now()
  const run = await launch(style)
  const samples = []
  let cdp = null
  const deadline = t0 + 7_000
  while (Date.now() < deadline) {
    if (!cdp) {
      const target = await mainTarget(PORT).catch(() => null)
      if (target) cdp = await openCdp(target.webSocketDebuggerUrl).catch(() => null)
    }
    const focus = cdp ? await pageEval(cdp, 'return [document.hasFocus(), document.visibilityState]', 2_000).catch(() => null) : null
    const sv = systemView(run.pid)
    const daemons = findProbeDaemons(PREFIX).length
    const ac = activationView(run.pid)
    samples.push({ t: Date.now() - t0, focus: focus ? (focus[0] ? 'F' : '-') : '?', vis: focus ? String(focus[1]).slice(0, 3) : '---', z: sv.z, cov: Math.round(sv.covered * 100), on: sv.onscreen === true ? 1 : 0, d: daemons, att: ac.att, front: ac.front, pol: ac.pol })
    await sleep(250)
  }
  // l'uscita della UI: che ne resta del daemon (policy, attivo) e chi è in primo piano
  await quit(run, null)
  const dopoUscita = []
  for (let i = 0; i < 4; i++) {
    await sleep(300)
    const a = appActivation(WIN)
    const mine = a.apps.filter((x) => x.url.startsWith(realpathSync(app)) && !x.terminated)
    dopoUscita.push(mine.map((x) => `${x.pid === run.pid ? 'UI' : 'D'}:${x.policy}${x.active ? '*' : ''}`).join(' ') + ` in-primo-piano=${mine.some((x) => x.pid === a.frontmostPid) ? 'prova' : 'altra'}`)
  }
  cdp?.sock?.close?.()
  const full = uiBootSince(readMainLog(DATA).text, before)
  const result = { label, style, daemonBootMs: daemonBootMsOf(full), rendererReady: msOf(full, 'renderer-ready'), samples, dopoUscita, raw: full.lines.map((l) => l.raw) }
  log('')
  log(`▶ ${label} [${style}] UI pid ${run.pid} · daemon: ${result.daemonBootMs === null ? 'già vivo' : `boot a +${result.daemonBootMs} ms`} · renderer-ready ${fmtMs(result.rendererReady)} ms`)
  for (const s of samples) log(`     t=${String(s.t).padStart(4)} ms  fuoco=${s.focus} vis=${s.vis} z=${s.z} coperta=${s.cov}% a-schermo=${s.on} daemon=${s.d} attivo=${s.att} in-primo-piano=${s.front} processi=[${s.pol}]`)
  log(`     DOPO L'USCITA della UI (ogni 300 ms): ${dopoUscita.join(' | ')}`)
  return result
}

// ---- --daemon-sotto: l'UI è davanti con il fuoco, il daemon riparte sotto ----
async function daemonSotto(n, tot) {
  const before = readMainLog(DATA).chars
  const run = await launch('open')
  await sleep(3_500)
  let cdp = null
  const target = await mainTarget(PORT).catch(() => null)
  if (target) cdp = await openCdp(target.webSocketDebuggerUrl).catch(() => null)
  // la UI davanti e col fuoco: il Dock vero
  reopenWithOpen(app)
  await sleep(2_000)
  const samples = []
  const snap = async (tag) => {
    const focus = cdp ? await pageEval(cdp, 'return [document.hasFocus(), document.visibilityState]', 2_000).catch(() => null) : null
    const sv = systemView(run.pid)
    const ac = activationView(run.pid)
    samples.push({ tag, t: Date.now(), focus: focus ? (focus[0] ? 'F' : '-') : '?', vis: focus ? String(focus[1]).slice(0, 3) : '---', z: sv.z, cov: Math.round(sv.covered * 100), d: findProbeDaemons(PREFIX).length, att: ac.att, front: ac.front, pol: ac.pol })
  }
  for (let i = 0; i < 4; i++) { await snap('prima'); await sleep(400) }
  // il daemon si ferma e la UI lo fa ripartire (riconnessione → ensureDaemonRunning)
  await stopDaemons()
  const tStop = Date.now()
  for (let i = 0; i < 12; i++) { await snap('dopo'); await sleep(300) }
  // poi il clic sul Dock VERO (`open` all'app che gira), come fa chi non vede niente
  reopenWithOpen(app)
  const tDock = Date.now()
  for (let i = 0; i < 12; i++) { await snap('dock'); await sleep(300) }
  // e il Dock delle sonde (l'activate emesso nel processo, senza il sistema)
  if (cdp) await pageEval(cdp, 'return await window.sandbot.testEmitActivate()').catch(() => undefined)
  const tEmit = Date.now()
  for (let i = 0; i < 8; i++) { await snap('emit'); await sleep(300) }
  cdp?.sock?.close?.()
  await quit(run, cdp)
  const full = uiBootSince(readMainLog(DATA).text, before)
  log('')
  log('')
  log(`▶ daemon-sotto ${n}/${tot} [open] UI pid ${run.pid}`)
  let last = 'prima'
  for (const s of samples) {
    const base = s.tag === 'prima' ? tStop : s.tag === 'dopo' ? tStop : s.tag === 'dock' ? tDock : tEmit
    if (s.tag !== last) { log(`     ---- ${s.tag === 'dock' ? 'clic sul Dock VERO (open all\'app che gira)' : s.tag === 'emit' ? 'activate emesso nel processo (gancio di prova)' : '----'} ----`); last = s.tag }
    log(`     ${s.tag.padEnd(5)} t=${String(s.t - base).padStart(6)} ms  fuoco=${s.focus} vis=${s.vis} z=${s.z} coperta=${s.cov}% daemon=${s.d} attivo=${s.att} in-primo-piano=${s.front} processi=[${s.pol}]`)
  }
  return { samples, raw: full.lines.map((l) => l.raw) }
}

const results = []
let errore = null
try {
  compileWindowList(WORK)
  if (!(await new Promise((res) => {
    const s = createServer()
    s.once('error', () => res(false))
    s.listen(PORT, '127.0.0.1', () => s.close(() => res(true)))
  }))) throw new Error(`la porta ${PORT} è occupata`)
  await setup()
  await stopDaemons()

  if (IPOTESI) {
    // ============ H1c: cartella calda, daemon FERMO ============
    for (let i = 1; i <= AVVII; i++) {
      const r = await coldStart(`H1c cartella calda · daemon fermo · avvio ${i}/${AVVII}`)
      results.push(r)
      print(r)
      await stopDaemons()
    }

    // ============ H1a: il daemon della corsa prima ancora VIVO ============
    for (let i = 0; i <= AVVII; i++) {
      const r = await coldStart(`H1a daemon della corsa prima VIVO · avvio ${i}/${AVVII}${i === 0 ? ' (scalda il daemon: non conta)' : ''}`)
      results.push(r)
      print(r)
      if (i === 1) {
        // chi tiene i file del profilo: lsof sui LOCK della TEMPORANEA (H1)
        const { locks, holders } = lockHolders()
        log(`   file LOCK presenti nella temporanea: ${locks.join(' | ') || 'nessuno'}`)
        log(`   chi li tiene (lsof, UI e daemon vivi): ${holders.length ? holders.map((h) => `pid ${h.pid} → ${h.file}`).join(' | ') : 'NESSUNO li tiene aperti'}`)
        for (const p of findAppProcesses(DATA, exe)) log(`   pid ${p.pid} (${p.daemon ? 'daemon' : 'UI'}): file aperti sotto la cartella dati: ${JSON.stringify((r.files[p.pid] ?? []).slice(0, 40))}`)
        log(`   cartella dati (voci di primo livello): ${readdirSync(DATA).join(', ')}`)
      }
      // il daemon resta VIVO: è il caso del primo avvio del giorno
    }

    // ============ H1b: daemon.json di un'ALTRA build ============
    for (let i = 1; i <= AVVII; i++) {
      await stopDaemons()
      try { fakeOld?.kill('SIGKILL') } catch { /* già via */ }
      plantOtherBuildDaemon()
      const r = await coldStart(`H1b daemon.json di un'altra build (processo vivo) · avvio ${i}/${AVVII}`)
      results.push(r)
      print(r)
      try { fakeOld?.kill('SIGKILL') } catch { /* già via */ }
    }
    await stopDaemons()

    // ============ H3: l'app parte mentre un'altra ha il fuoco ============
    for (const [style, nome] of [['open', 'H3 lanciata dal Finder (open)'], ['open-g', 'H3 lanciata in background (open -g), mai attivata']]) {
      for (let i = 1; i <= AVVII; i++) {
        await stopDaemons()
        const r = await coldStart(`${nome} · avvio ${i}/${AVVII}`, { style })
        results.push(r)
        print(r)
      }
    }
  }

  if (TIMELINE) {
    for (const [caso, prepara] of [
      ['E-A daemon GIÀ VIVO (non parte durante l\'avvio)', ensureDaemonAlive],
      ['E-B daemon FERMO (parte durante l\'avvio)', stopDaemons]
    ]) {
      for (let i = 1; i <= AVVII; i++) {
        await prepara()
        results.push(await timeline(`${caso} · avvio ${i}/${AVVII}`, TIMELINE_EXEC ? 'exec' : 'open'))
      }
    }
  }

  if (DAEMON_SOTTO) {
    for (let i = 1; i <= AVVII; i++) {
      await ensureDaemonAlive()
      results.push(await daemonSotto(i, AVVII))
    }
  }

  // ---- il quadro ----
  if (IPOTESI) {
    log('')
    log('================ RIEPILOGO ================')
    for (const r of results.filter((x) => x.sistema)) {
      const snapBad = r.snapshot ? !(r.snapshot.visible === 'true' && r.snapshot.minimized === 'false' && r.snapshot['app-hidden'] === 'false' && r.snapshot.inside === 'true') : true
      // «non si vede niente» dal punto di vista di chi guarda: la finestra non è a schermo,
      // o è coperta dalle finestre che le stanno davanti, o il renderer non è mai arrivato al paint
      const siVede = r.sistema.aSchermo && r.sistema.davanti
      const riprodotto = !siVede || !r.rendererPronto || snapBad
      log(`${riprodotto ? ' RIPRODOTTO ' : '   ok      '} ${r.label.padEnd(72)} a-schermo=${r.sistema.aSchermo ? 'si' : 'NO'} davanti=${r.sistema.davanti ? 'si' : 'NO'} renderer-ready=${fmtMs(r.ms['renderer-ready'])} visibile=${r.snapshot?.visible ?? '—'} focused=${r.snapshot?.focused ?? '—'} app-hidden=${r.snapshot?.['app-hidden'] ?? '—'} z=${r.sistema.z} coperta=${pct(r.sistema.covered)} finestre-dopo-dock=${r.dopoDock?.finestre.length ?? '—'} created=${r.dock ? `${r.dock.createdBefore}→${r.dock.createdAfter}` : '—'} daemon=+${r.daemonBootMs ?? 'già vivo'}`)
    }
  }
} catch (e) {
  errore = e
  log('ERRORE della riproduzione:', e?.stack ?? e)
} finally {
  await cleanup()
}
process.exit(errore ? 1 : 0)
