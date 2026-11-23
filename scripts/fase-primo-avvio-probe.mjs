#!/usr/bin/env node
// Sonda della fase primo-avvio — «Homun si apre al primo clic», con l'app
// IMPACCHETTATA (--dir, non firmata) su dati TEMPORANEI (SANDBOT_TEST_USER_DATA
// in una mkdtemp della fase: mai /Applications/Homun.app, mai i dati veri),
// modello FINTO solo per chiudere la guida, CLI `container` FINTA,
// Portachiavi e SafeStorage FINTI. Rete solo su 127.0.0.1, nessun download.
//
//   node scripts/fase-primo-avvio-probe.mjs --app=<temporanea>/Homun.app
//
// 10 avvii a freddo DI FILA sulla stessa cartella dati (il processo UI esce
// come ⌘Q e si rilancia), in tre condizioni:
//   1. normale — il daemon è fermo (come dopo un riavvio): parte con la UI;
//   2. col daemon della corsa prima ANCORA VIVO (il primo avvio del giorno);
//   3. con un daemon.json STANTIO di un'altra build (pid morto, altra
//      versione e build: è quello che resta dopo un aggiornamento interrotto).
// A ogni avvio TRE verifiche; l'avvio è VERDE se lo sono tutte e tre (30 avvii,
// verde = 30/30):
//   A. la finestra è a schermo E visibile DAL PUNTO DI VISTA DEL SISTEMA
//      (window-list: CGWindowListCopyWindowInfo, sola lettura — mai osascript):
//      layer 0, alpha > 0, onscreen, dentro un display;
//   B. arriva renderer-ready entro 10 s — col frame passato (non «frame=0»
//      della pagina nascosta);
//   C. nel main.log della temporanea ci sono le righe di P1: caricamento
//      della pagina, ready-to-show, window-shown, renderer-ready, la
//      fotografia a 5 s, le connessioni al daemon; e nessuna riga d'errore.
// Cattura CDP della prima finestra in docs/catture/fase-primo-avvio/.
// Pulizia K4: a fine corsa 0 cartelle sandbot-fase-primo-avvio-* e 0 processi
// dell'app di prova (la corsa è ROSSA se resta qualcosa).
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  TMP_BASE, sleep, resolveTestApp, compileWindowList, windowList, onScreenWindow,
  writeFakeContainer, appEnv, launchExecutable, findAppProcesses,
  pidAlive, waitPidGone, waitFor, readMainLog, uiBootSince, msOf,
  openCdp, mainTarget, pageEval, startFakeProvider, chatIsUp, closeGuide
} from './lib/primo-avvio.mjs'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const { app, exe } = resolveTestApp()
const PREFIX = 'sandbot-fase-primo-avvio'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-primo-avvio')
mkdirSync(SHOTS, { recursive: true })
const AVVII = 10
const PORT = 9496
// lo strumento di lettura (window-list) si compila nella cartella di lavoro;
// la cancellazione sta nel finally
const WORK = mkdtempSync(join(TMP_BASE, `${PREFIX}-lavoro-`))
const WIN = join(WORK, 'window-list')
const DATA = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
const FAKE_CONTAINER = writeFakeContainer(DATA)
const ENV = appEnv(DATA, FAKE_CONTAINER)

const log = (...a) => console.log('[sonda primo-avvio]', ...a)
let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  if (!ok) failed++
  log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- pulizia (nel finally, in ogni caso) ----
let leftovers = false
const cleanup = async () => {
  for (const p of findAppProcesses(DATA, exe)) {
    try { process.kill(p.pid, 'SIGTERM') } catch { /* già via */ }
    await waitPidGone(p.pid, 8_000)
    if (pidAlive(p.pid)) { try { process.kill(p.pid, 'SIGKILL') } catch { /* già via */ } }
  }
  await stopProbeDaemons(PREFIX, { log })
  for (let i = 0; i < 40 && findAppProcesses(DATA, exe).length > 0; i++) await sleep(200)
  for (const dir of [DATA, WORK]) {
    for (let i = 0; i < 3 && existsSync(dir); i++) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* si ritenta */ }
      if (existsSync(dir)) await sleep(500)
    }
  }
  await provider.close().catch(() => undefined)
  const left = [DATA, WORK].filter(existsSync)
  const procs = findAppProcesses(DATA, exe).length
  leftovers = left.length > 0 || procs > 0
  log('pulizia K4:', leftovers ? 'ERRORE — qualcosa resta' : 'cartelle temporanee cancellate', `· cartelle rimaste ${left.length}${left.length ? ` (${left.join(', ')})` : ''} · processi dell'app di prova rimasti ${procs}`)
}
process.on('SIGINT', () => { void cleanup().then(() => process.exit(130)) })
process.on('SIGTERM', () => { void cleanup().then(() => process.exit(143)) })

const provider = await startFakeProvider()

const stopDaemons = async () => {
  await stopProbeDaemons(PREFIX, { log })
  for (let i = 0; i < 40 && findProbeDaemons(PREFIX).length > 0; i++) await sleep(200)
}
/** Un daemon.json stantio di un'ALTRA build: pid morto, altra versione e build. */
const plantStaleDaemonJson = async () => {
  await stopDaemons()
  mkdirSync(join(DATA, 'data'), { recursive: true })
  writeFileSync(
    join(DATA, 'data', 'daemon.json'),
    JSON.stringify({ pid: 999_999_999, port: 65533, token: 'stantio', startedAt: Date.now() - 3_600_000, version: '0.3.1000-altra', build: 'altra-build' }, null, 2) + '\n',
    { mode: 0o600 }
  )
}
const daemonAlive = () => findProbeDaemons(PREFIX).length > 0

/** Esce come ⌘Q (app.quit() vera dal renderer), altrimenti SIGTERM; aspetta l'uscita VERA. */
async function quit(run, cdp) {
  if (cdp) await pageEval(cdp, 'return await window.sandbot.testEmitQuit()', 4_000).catch(() => undefined)
  if (pidAlive(run.pid)) { try { process.kill(run.pid, 'SIGTERM') } catch { /* già via */ } }
  if (!(await waitPidGone(run.pid, 12_000))) { try { process.kill(run.pid, 'SIGKILL') } catch { /* già via */ } }
  await Promise.race([run.exited, sleep(3_000)])
  cdp?.sock?.close?.()
}

/** La finestra dell'avvio come la vede il SISTEMA (window-list): quella «normale» a schermo. */
const systemWindow = (uiPid) => onScreenWindow(windowList(WIN, uiPid))

/** UN avvio a freddo: lancia, guarda dal di fuori, legge il registro, esce come ⌘Q. */
async function coldStart(condizione, n, { cattura = false } = {}) {
  const before = readMainLog(DATA).chars
  const t0 = Date.now()
  const run = launchExecutable(exe, ENV, { debugPort: PORT })
  const bootNow = () => uiBootSince(readMainLog(DATA).text, before)
  // A: appena il registro dice window-shown, la finestra deve esser ANCHE per il sistema
  const sulSistema = await waitFor(() => {
    if (msOf(bootNow(), 'window-shown') === null) return null
    const o = systemWindow(run.pid)
    return o.win ? { ...o, ms: Date.now() - t0 } : null
  }, 15_000)
  // B: renderer-ready (le do' fino a 12 s, per poter dire quanto ha aspettato)
  const conReady = await waitFor(() => (msOf(bootNow(), 'renderer-ready') !== null ? bootNow() : null), 12_000)
  // C: la fotografia di P1 arriva 5 s dopo il show
  const conFoto = await waitFor(() => (msOf(bootNow(), 'window-snapshot') !== null ? bootNow() : null), 25_000)

  // la cattura CDP della PRIMA finestra: solo se la chat è davvero a schermo
  let catturato = false
  if (cattura) {
    const target = await mainTarget(PORT).catch(() => null)
    const cdp = target ? await openCdp(target.webSocketDebuggerUrl).catch(() => null) : null
    if (cdp && (await chatIsUp(cdp).catch(() => false))) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
      if (shot?.data) {
        writeFileSync(join(SHOTS, '1-primo-avvio-finestra.png'), Buffer.from(shot.data, 'base64'))
        catturato = true
        log('cattura 1-primo-avvio-finestra.png')
      }
    }
    await quit(run, cdp)
  } else {
    await quit(run, null)
  }
  const full = uiBootSince(readMainLog(DATA).text, before)
  return { sistema: sulSistema, readyBoot: conReady, boot: full, catturato }
}

/** Le righe di P1 di UN avvio: ci sono tutte, con i campi della fotografia? */
const righeP1 = (boot) => {
  if (!boot) return { ok: false, perche: ['nessun avvio nel registro'] }
  const eventi = boot.lines.map((l) => l.event)
  const mancano = ['boot', 'lock', 'daemon-connect-start', 'window-created', 'did-start-loading', 'dom-ready', 'did-finish-load', 'ready-to-show', 'window-shown', 'renderer-ready', 'window-snapshot']
    .filter((e) => !eventi.includes(e))
  if (!eventi.includes('daemon-connected') && !eventi.includes('daemon-connect-failed')) mancano.push('daemon-connected|daemon-connect-failed')
  const foto = boot.lines.find((l) => l.event === 'window-snapshot')?.f ?? {}
  for (const [k, v] of Object.entries({ visible: 'true', minimized: 'false', 'app-hidden': 'false', inside: 'true', 'renderer-ready': 'true' })) {
    if (foto[k] !== v) mancano.push(`fotografia ${k}=${foto[k] ?? '—'} (atteso ${v})`)
  }
  for (const k of ['ms', 'bounds', 'display', 'work-area', 'displays', 'focused', 'fullscreen', 'loading']) {
    if (foto[k] === undefined) mancano.push(`fotografia senza ${k}`)
  }
  const errori = boot.lines.filter((l) => ['did-fail-load', 'render-process-gone', 'unresponsive'].includes(l.event)).map((l) => l.raw.slice(24))
  return { ok: mancano.length === 0 && errori.length === 0, perche: [...mancano.map((m) => `manca ${m}`), ...errori.map((e) => `errore: ${e}`)] }
}

const condizioni = [
  { nome: 'normale (daemon fermo, come dopo un riavvio)', prima: stopDaemons },
  { nome: 'col daemon della corsa prima ancora VIVO', prima: async () => { if (!daemonAlive()) log('ATTENZIONE: il daemon non era vivo prima dell\'avvio') } },
  { nome: 'con un daemon.json stantio di un\'altra build', prima: plantStaleDaemonJson }
]

let errore = null
try {
  compileWindowList(WORK)
  if (!(await new Promise((res) => {
    const s = createServer()
    s.once('error', () => res(false))
    s.listen(PORT, '127.0.0.1', () => s.close(() => res(true)))
  }))) throw new Error(`la porta ${PORT} è occupata`)
  // il setup (non si conta): la prima volta la guida si chiude — provider finto, un bot
  {
    const run = launchExecutable(exe, ENV, { debugPort: PORT })
    const target = await waitFor(() => mainTarget(PORT), 40_000)
    if (!target) throw new Error('nessuna pagina principale nel setup: ' + run.output().slice(-800))
    const cdp = await openCdp(target.webSocketDebuggerUrl)
    const chiusa = await closeGuide(cdp, provider.port)
    await quit(run, cdp)
    if (!chiusa) throw new Error('la guida del primo avvio non si è chiusa nel setup')
    log('setup fatto: guida chiusa, un bot, cartella dati pronta')
  }

  let primo = true
  let catturaFatta = false
  for (const cond of condizioni) {
    for (let n = 1; n <= AVVII; n++) {
      await cond.prima()
      const daemonPrima = daemonAlive()
      const r = await coldStart(cond.nome, n, { cattura: primo })
      const etichetta = `${cond.nome} · avvio ${n}/${AVVII}`
      log(`${etichetta} · daemon ${daemonPrima ? 'VIVO' : 'fermo'} prima dell'avvio · window-shown ${msOf(r.boot, 'window-shown') ?? '—'} ms · ready-to-show ${msOf(r.boot, 'ready-to-show') ?? '—'} ms · renderer-ready ${msOf(r.boot, 'renderer-ready') ?? '—'} ms · ${r.boot?.lines.find((l) => l.event === 'boot' && l.f.mode === 'daemon') ? `daemon partito a +${r.boot.lines.find((l) => l.event === 'boot' && l.f.mode === 'daemon').at - r.boot.bootAt} ms` : 'daemon già vivo'}`)
      if (n === 1 && r.boot) {
        // dal vivo, le righe del registro di questo avvio (il primo della condizione)
        for (const l of r.boot.lines) log('     ' + l.raw)
      }
      const s = r.sistema
      const w = s?.win
      const readyMs = msOf(r.readyBoot, 'renderer-ready')
      const rigaReady = r.readyBoot?.lines.find((l) => l.event === 'renderer-ready')
      const p1 = righeP1(r.boot)
      const verifiche = [
        {
          nome: 'A: la finestra è a schermo E visibile per il sistema (layer 0, alpha > 0, onscreen, dentro un display)',
          ok: !!w && w.layer === 0 && w.alpha > 0 && w.onscreen === true && s.inside >= 0.5,
          dettaglio: s ? `layer=${w.layer} alpha=${w.alpha} onscreen=${w.onscreen} bounds=${w.x},${w.y},${w.w}x${w.h} dentro-schermo=${Math.round(s.inside * 100)}%, vista dal sistema a ${s.ms} ms` : 'mai vista dal sistema entro 15 s'
        },
        {
          nome: 'B: renderer-ready entro 10 s, col frame passato',
          ok: readyMs !== null && readyMs <= 10_000 && !/\bframe=0\b/.test(rigaReady?.raw ?? ''),
          dettaglio: readyMs === null ? 'nessun renderer-ready entro 12 s' : rigaReady.raw.slice(24)
        },
        {
          nome: 'C: le righe di P1 nel main.log della temporanea, e nessuna riga d\'errore',
          ok: p1.ok,
          dettaglio: p1.ok ? `${r.boot.lines.length} righe` : p1.perche.join('; ')
        }
      ]
      // UN esito per avvio (la spec: 30 avvii, verde = 30/30); le verifiche che falliscono si dicono una per una
      check(`${etichetta} · finestra a schermo per il sistema, renderer-ready, righe di P1`, verifiche.every((v) => v.ok),
        verifiche.map((v) => `${v.ok ? 'ok' : 'KO'} ${v.nome} [${v.dettaglio}]`).join(' · '))
      for (const v of verifiche) if (!v.ok) log(`   KO ${v.nome} — ${v.dettaglio}`)

      if (primo) {
        primo = false
        catturaFatta = r.catturato
      }
    }
  }
  if (!catturaFatta) {
    errore = new Error('la cattura CDP della prima finestra non è stata fatta')
  }
} catch (e) {
  errore = e
  log('ERRORE della sonda:', e?.stack ?? e)
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: String(e?.message ?? e) })
  failed++
} finally {
  await cleanup()
}

const ok = results.filter((r) => r.ok).length
log(`CORSA primo-avvio: ${ok}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
if (leftovers) process.exit(1)
