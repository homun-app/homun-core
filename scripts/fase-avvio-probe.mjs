#!/usr/bin/env node
// Sonda della fase avvio-finestra (W1–W3) — l'app si apre SEMPRE al primo
// clic, dal vivo con la UI come le altre sonde: app VERA (out/, serve `npm
// run build` prima) su dati temporanei, modello FINTO openai-compatible su
// 127.0.0.1, CLI `container` FINTA, Portachiavi/SafeStorage FINTI. MAI il
// container vero, mai download, rete solo su 127.0.0.1.
//
//   C1  avvio a freddo: finestra principale VISIBILE con la chat entro 10 s
//       (dallo spawn dell'app, daemon compreso).
//   C2  chiusura della principale con una PiP APERTA, poi activate (il
//       gancio di prova test:emit-activate, che emette l'activate VERO:
//       il clic sul Dock non si può simulare altrimenti) → principale di
//       nuovo visibile, la PiP resta.
//   C3  secondo avvio dello stesso eseguibile con la principale CHIUSA →
//       principale visibile di nuovo, il secondo processo ESCE, la PiP non
//       viene né mostrata né chiusa (W1).
//   C4  daemon di VERSIONE DIVERSA già acceso (finto, come nelle sonde
//       dell'aggiornamento: riga di comando con --homun-daemon, porta chiusa,
//       dopo 5 s cambia il custode di daemon.json così la UI prosegue) → lo
//       splash dice «Aggiorno il motore alla versione nuova…», poi la chat.
//   C5  (fase mcp-ui, U6) X sulla finestra → quit (SIGTERM = la STESSA
//       sequenza before-quit→will-quit→quit di ⌘Q, letta dal registro del
//       ciclo di vita) → rilancio dello stesso eseguibile DOPO 200 ms →
//       entro 10 s finestra principale VISIBILE e 1 SOLO processo UI vivo.
//       L'uscita misurata (exit-ms del registro) sta sotto 1 s; il registro
//       ha le righe attese. Chiude anche col ⌘Q VERO del gancio di prova
//       (test:emit-quit, renderer vivo).
//
// Pulizia K4: 0 cartelle sandbot-fase-avvio-*, 0 daemon della sonda,
// 0 processi del finto daemon vecchio.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = realpathSync(tmpdir())
const PREFIX = 'sandbot-fase-avvio'

const log = (...a) => console.log('[sonda avvio]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${what} (${ms} ms)`)), ms))])

let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  if (!ok) failed++
  log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- la CLI `container` FINTA (mai quella vera) ----
const DATA = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
const FAKE_CONTAINER = join(DATA, 'fake-container.sh')
writeFileSync(FAKE_CONTAINER, [
  '#!/bin/sh',
  '# CLI container FINTA della sonda: niente docker, niente container vero',
  'if [ "$1" = "--version" ]; then echo "container 1.7.1-finta"; exit 0; fi',
  'echo "[]" ; exit 0'
].join('\n'))
chmodSync(FAKE_CONTAINER, 0o755)

// ---- il modello FINTO (serve solo alla configurazione, nessun turno) ----
const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
const providerServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'finto' }] }))
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ role: 'assistant', content: 'ok' }, null))
      res.write(sse({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- l'app Electron VERA (out/) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9493
const APP_ENV = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  SANDBOT_TEST_USER_DATA: DATA,
  SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
  SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
  HOMUN_CONTAINER_PATH: FAKE_CONTAINER
}
let app = null
let appLog = ''
const startApp = () => {
  appLog = ''
  const p = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
    cwd: ROOT,
    env: APP_ENV,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  p.stdout.on('data', (d) => { appLog += d.toString() })
  p.stderr.on('data', (d) => { appLog += d.toString() })
  app = p
  return p
}
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
const waitPidGone = async (pid, capMs = 15_000) => {
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  const deadline = Date.now() + capMs
  while (alive()) {
    if (Date.now() > deadline) return false
    await sleep(200)
  }
  return true
}
/** ferma l'app E il daemon della sonda, e aspetta che siano usciti DAVVERO */
const coldStop = async () => {
  const pid = app?.pid
  stopApp()
  if (Number.isInteger(pid)) await waitPidGone(pid)
  await stopProbeDaemons(PREFIX, { log }).catch((e) => log('stopProbeDaemons:', e.message))
  for (let i = 0; i < 50 && findProbeDaemons(PREFIX).length > 0; i++) await sleep(200)
}
process.on('SIGINT', () => { stopApp(); process.exit(130) })
process.on('SIGTERM', () => { stopApp(); process.exit(143) })

// ---- CDP ----
const httpJson = async (path) => (await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`).then((r) => r.json()))
async function openCdp(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej })
  let id = 0
  const waits = new Map()
  sock.onmessage = (m) => {
    const v = JSON.parse(m.data)
    if (v.id && waits.has(v.id)) { const w = waits.get(v.id); waits.delete(v.id); v.error ? w.rej(new Error(v.error.message)) : w.res(v.result) }
  }
  return {
    sock,
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id
      waits.set(mid, { res, rej })
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
  }
}
/** la pagina PRINCIPALE (non la PiP, non le altre), o null */
const mainTarget = async () => {
  const list = await httpJson('/json/list')
  return list.find((t) => t.type === 'page' && (t.url ?? '').includes('homun://app') && !(t.url ?? '').includes('/pip/')) ?? null
}
const pipTarget = async () => {
  const list = await httpJson('/json/list')
  return list.find((t) => t.type === 'page' && (t.url ?? '').includes('/pip/')) ?? null
}
const waitForTarget = async (pick, timeoutMs = 15_000, step = 200) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const t = await pick()
      if (t) return t
    } catch { /* il debugger non è ancora su */ }
    if (Date.now() > deadline) return null
    await sleep(step)
  }
}
const pageEval = async (cdp, expr) => {
  const r = await withTimeout(cdp.send('Runtime.evaluate', {
    expression: `((async () => { ${expr} })())`,
    awaitPromise: true,
    returnByValue: true
  }), 20_000, 'Runtime.evaluate')
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300))
  return r?.result?.value
}
const waitDom = async (cdp, exprTrue, timeoutMs = 8_000, step = 200) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await pageEval(cdp, `return !!(${exprTrue})`)
      if (v === true) return true
    } catch { /* target appena nato/morto: si riprova */ }
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
/** la riga corrente del caricamento (W2), o null se lo splash non c'è più */
const splashLine = async (cdp) => {
  try {
    return await pageEval(cdp, `const el = document.querySelector('[data-testid="boot-splash-line"]'); return el ? el.textContent.trim() : null`)
  } catch { return null }
}
/** RPC con retry: window.sandbot può non essere ancora esposto dal preload */
const rpcOn = async (cdp, callExpr) => {
  let lastErr = null
  for (let i = 0; i < 10; i++) {
    try {
      return await pageEval(cdp, `if (!window.sandbot) throw new Error('preload non pronto'); return await window.sandbot.${callExpr}`)
    } catch (e) {
      lastErr = e
      await sleep(700)
    }
  }
  throw lastErr
}

// ---- il finto daemon VECCHIO (C4): riga di comando con --homun-daemon,
// porta CHIUSA (nessun ws), dopo 5 s cambia il custode di daemon.json così
// ensureDaemonRunning prosegue col daemon vero ----
const FAKE_OLD_DAEMON = join(DATA, 'finto-daemon-vecchio.cjs')
writeFileSync(FAKE_OLD_DAEMON, [
  '// daemon VECCHIO finto della sonda (mai un server vero)',
  'const fs = require("node:fs")',
  'const file = process.argv[2]',
  'const dopo = Number(process.argv[3] || 5000)',
  'setTimeout(() => {',
  '  // cambia il custode: waitDaemonPidGone vede daemon.json con ALTRO pid',
  '  const info = JSON.parse(fs.readFileSync(file, "utf8"))',
  '  info.pid = 999999999',
  '  fs.writeFileSync(file, JSON.stringify(info, null, 2))',
  '}, dopo)',
  'setInterval(() => {}, 10000)'
].join('\n'))
let fakeOldDaemon = null

try {
  // ---- setup: provider finto, guida chiusa, il bot principale (round 1) ----
  startApp()
  const setupTarget = await waitForTarget(mainTarget, 25_000)
  if (!setupTarget) throw new Error('nessuna pagina principale nel setup: ' + appLog.slice(-600))
  const setupCdp = await openCdp(setupTarget.webSocketDebuggerUrl)
  const rpcSetup = async (callExpr) => rpcOn(setupCdp, callExpr)
  await rpcSetup(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpcSetup(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpcSetup(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpcSetup(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(500)
    }
    if (await waitDom(setupCdp, `document.querySelector('form textarea')`, 15_000)) break
  }
  if (!(await waitDom(setupCdp, `document.querySelector('form textarea')`, 1_000))) throw new Error('la guida non si è chiusa nel setup: ' + appLog.slice(-600))
  const agentId = await rpcSetup(`listAgents().then((a) => a[0]?.id ?? null)`)
  if (!agentId) throw new Error('nessun bot nel setup')
  log('setup fatto, bot:', agentId)
  setupCdp.sock.close()
  await coldStop()

  // =========== C1: avvio a freddo — principale visibile con la chat entro 10 s ===========
  const t0 = Date.now()
  startApp()
  const t1 = await waitForTarget(mainTarget, 10_000)
  const t1cdp = t1 ? await openCdp(t1.webSocketDebuggerUrl).catch(() => null) : null
  const visibile = t1cdp ? await pageEval(t1cdp, 'return document.visibilityState').catch(() => 'errore') : 'niente'
  const chatOk = t1cdp === null ? false : await waitDom(t1cdp, `document.querySelector('form textarea')`, Math.max(1_000, 10_000 - (Date.now() - t0)))
  const elapsed = Date.now() - t0
  check('C1: avvio a freddo — finestra principale VISIBILE (visibilityState) e chat, tutto entro 10 s',
    visibile === 'visible' && chatOk === true && elapsed <= 10_000,
    `visibilità ${visibile}, chat ${chatOk}, ${elapsed} ms`)

  // =========== C2: principale chiusa con la PiP aperta → activate la ricrea ===========
  const pipAperta = await pageEval(t1cdp, `await window.sandbot.pipOpen(${JSON.stringify(agentId)}); return true`)
  const tPip = await waitForTarget(pipTarget, 10_000)
  check('C2: la PiP è aperta (target /pip/)', !!tPip && pipAperta === true)
  const pipCdp = tPip ? await openCdp(tPip.webSocketDebuggerUrl).catch(() => null) : null
  // chiudo la PRINCIPALE dal renderer (come il pulsante rosso)
  await pageEval(t1cdp, 'window.close(); return true').catch(() => undefined)
  t1cdp.sock?.close?.()
  let mainSparita = false
  for (let i = 0; i < 40; i++) {
    if (!(await mainTarget().catch(() => null))) { mainSparita = true; break }
    await sleep(200)
  }
  check('C2: la principale è CHIUSA (nessun target non-PiP) e la PiP resta viva', mainSparita === true && !!(await pipTarget().catch(() => null)))
  // activate: il gancio di prova emette l'activate VERO (come il clic sul Dock)
  const activate = await pageEval(pipCdp, `return await window.sandbot.testEmitActivate()`)
  const t2 = await waitForTarget(mainTarget, 10_000)
  const t2cdp = t2 ? await openCdp(t2.webSocketDebuggerUrl).catch(() => null) : null
  const t2visibile = t2cdp ? await pageEval(t2cdp, 'return document.visibilityState').catch(() => 'errore') : 'niente'
  const t2chat = t2cdp === null ? false : await waitDom(t2cdp, `document.querySelector('form textarea')`, 10_000)
  check('C2: activate (Dock) con la PiP viva → principale DI NUOVO visibile con la chat',
    activate?.ok === true && t2visibile === 'visible' && t2chat === true,
    `activate ${JSON.stringify(activate)}, visibilità ${t2visibile}, chat ${t2chat}`)

  // =========== C3: secondo avvio con la principale chiusa → principale visibile, il secondo esce ===========
  await pageEval(t2cdp, 'window.close(); return true').catch(() => undefined)
  t2cdp.sock?.close?.()
  let mainSparita2 = false
  for (let i = 0; i < 40; i++) {
    if (!(await mainTarget().catch(() => null))) { mainSparita2 = true; break }
    await sleep(200)
  }
  check('C3: la principale è di nuovo chiusa (la PiP resta)', mainSparita2 === true && !!(await pipTarget().catch(() => null)))
  const secondo = spawn(ELECTRON, ['.'], { cwd: ROOT, env: APP_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let secondoOut = ''
  secondo.stdout.on('data', (d) => { secondoOut += d.toString() })
  secondo.stderr.on('data', (d) => { secondoOut += d.toString() })
  const exitCode = await withTimeout(new Promise((res) => secondo.on('exit', (c) => res(c))), 15_000, 'uscita del secondo processo').catch(() => 'timeout')
  const t3 = await waitForTarget(mainTarget, 12_000)
  const t3cdp = t3 ? await openCdp(t3.webSocketDebuggerUrl).catch(() => null) : null
  const t3visibile = t3cdp ? await pageEval(t3cdp, 'return document.visibilityState').catch(() => 'errore') : 'niente'
  const t3chat = t3cdp === null ? false : await waitDom(t3cdp, `document.querySelector('form textarea')`, 10_000)
  const pipDopo = !!(await pipTarget().catch(() => null))
  check('C3: secondo avvio con la principale chiusa → principale VISIBILE di nuovo con la chat',
    t3visibile === 'visible' && t3chat === true, `visibilità ${t3visibile}, chat ${t3chat}`)
  check('C3: il secondo processo è uscito (code 0, niente seconda finestra)', exitCode === 0, `exit ${exitCode} ${secondoOut.slice(0, 120)}`)
  check('C3: la PiP non è stata toccata dal secondo avvio (né mostrata né chiusa)', pipDopo === true)

  // =========== C4: daemon di VERSIONE DIVERSA già acceso → testo di W2, poi la chat ===========
  t3cdp.sock?.close?.()
  await coldStop()
  const daemonJson = join(DATA, 'data', 'daemon.json')
  if (!existsSync(join(DATA, 'data'))) mkdirSync(join(DATA, 'data'), { recursive: true })
  fakeOldDaemon = spawn(process.execPath, [FAKE_OLD_DAEMON, daemonJson, '5000', '--homun-daemon'], { stdio: 'ignore' })
  writeFileSync(daemonJson, JSON.stringify({ pid: fakeOldDaemon.pid, port: 65533, token: 'finto-vecchio', startedAt: Date.now() - 5_000, version: '0.3.1000-finta', build: 'finta-vecchia' }, null, 2) + '\n', { mode: 0o600 })
  log('finto daemon vecchio partito, pid', fakeOldDaemon.pid)
  startApp()
  const t4 = await waitForTarget(mainTarget, 15_000)
  const t4cdp = t4 ? await openCdp(t4.webSocketDebuggerUrl).catch(() => null) : null
  let testoAggiornamento = false
  let viste = []
  for (let i = 0; i < 75; i++) { // fino a 15 s: il finto vecchio molla dopo ~5 s
    const line = t4cdp ? await splashLine(t4cdp) : null
    if (line) viste.push(line)
    if (line === 'Aggiorno il motore alla versione nuova…') { testoAggiornamento = true; break }
    await sleep(200)
  }
  if (viste.length > 3) viste = [viste[0], '…', viste.at(-1)]
  check('C4: con il daemon di versione diversa lo splash dice «Aggiorno il motore alla versione nuova…»',
    testoAggiornamento, `righe viste: ${JSON.stringify(viste)}`)
  const t4chat = t4cdp === null ? false : await waitDom(t4cdp, `document.querySelector('form textarea')`, 45_000)
  check('C4: poi la chat arriva (il daemon nuovo parte e si collega)', t4chat === true)
  t4cdp.sock?.close?.()
  await coldStop()

  // =========== C5 (U6, fase mcp-ui): X → quit → rilancio dopo 200 ms ===========
  // il registro del ciclo di vita sta nei dati TEMPORANEI della sonda
  const MAINLOG = join(DATA, 'Logs', 'main.log')
  startApp()
  const t5 = await waitForTarget(mainTarget, 25_000)
  const t5cdp = t5 ? await openCdp(t5.webSocketDebuggerUrl).catch(() => null) : null
  if (!t5cdp) throw new Error('C5: nessuna finestra principale: ' + appLog.slice(-400))
  await waitDom(t5cdp, `document.querySelector('form textarea')`, 20_000)
  // la X: la finestra si chiude, l'app resta (tray)
  await pageEval(t5cdp, 'window.close(); return true').catch(() => undefined)
  t5cdp.sock?.close?.()
  let c5sparita = false
  for (let i = 0; i < 50; i++) {
    if (!(await mainTarget().catch(() => null))) { c5sparita = true; break }
    await sleep(200)
  }
  const c5uiDopoX = spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const c5uiDopoXvivi = String(c5uiDopoX.stdout ?? '').split('\n')
    .filter((l) => l.includes(join(ROOT, 'node_modules', 'electron')) && !l.includes('--type=') && !l.includes('--homun-daemon') && !l.includes('finto-daemon-vecchio'))
  check('C5: la X chiude la finestra e l\'app RESTA (1 processo UI, nessuna finestra)', c5sparita === true && c5uiDopoXvivi.length === 1, `${c5uiDopoXvivi.length} processi UI`)
  // il quit: SIGTERM = la STESSA sequenza before-quit→will-quit→quit di ⌘Q
  const quitPid = app.pid
  const tQuit = Date.now()
  stopApp()
  const quitGone = await waitPidGone(quitPid, 15_000)
  const quitMs = Date.now() - tQuit
  check('C5: il quit porta il processo UI fuori in MENO di 1 s', quitGone === true && quitMs < 1000, `${quitMs} ms`)
  // il rilancio DOPO 200 ms dall'inizio del quit: la finestra torna e resta
  // UN SOLO processo UI (se il secondo arriva mentre il primo esce, il primo
  // chiama relaunch: la copia nuova mostra la finestra lo stesso — U6).
  // Si aspetta lo STATO FINALE (la catena secondo→relaunch si assesta), non
  // un pid specifico.
  const uiVivi = () => String(spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout ?? '').split('\n')
    .filter((l) => l.includes(join(ROOT, 'node_modules', 'electron')) && !l.includes('--type=') && !l.includes('--homun-daemon') && !l.includes('finto-daemon-vecchio'))
  await sleep(Math.max(0, 200 - (Date.now() - tQuit)))
  spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], { cwd: ROOT, env: APP_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  const t6 = await waitForTarget(mainTarget, 15_000)
  const t6cdp = t6 ? await openCdp(t6.webSocketDebuggerUrl).catch(() => null) : null
  const t6visibile = t6cdp ? await pageEval(t6cdp, 'return document.visibilityState').catch(() => 'errore') : 'niente'
  const t6chat = t6cdp === null ? false : await waitDom(t6cdp, `document.querySelector('form textarea')`, 10_000)
  check('C5: rilancio dopo 200 ms → finestra principale VISIBILE con la chat entro 10 s',
    t6visibile === 'visible' && t6chat === true, `visibilità ${t6visibile}, chat ${t6chat}`)
  let c5uivivi = uiVivi()
  for (let i = 0; i < 50 && c5uivivi.length !== 1; i++) { await sleep(200); c5uivivi = uiVivi() }
  check('C5: alla fine 1 SOLO processo UI vivo (il vecchio è uscito, il nuovo è l\'unico)',
    c5uivivi.length === 1, `${c5uivivi.length} processi: ${JSON.stringify(c5uivivi.map((l) => l.trim().split(/\s+/)[0]))}`)
  // il registro del ciclo di vita: le righe attese, MAI dati dell'utente
  await sleep(500)
  const c5log = existsSync(MAINLOG) ? readFileSync(MAINLOG, 'utf8') : ''
  const righeAttese = [/boot pid=\d+ version=\S+ mode=ui/, / lock\n/, /window-created/, /window-shown/, /window-closed/, /before-quit/, /will-quit/, /quit exit-ms=\d+/]
  const righeOk = righeAttese.every((re) => re.test(c5log))
  const exitMsLog = Number(/quit exit-ms=(\d+)/.exec(c5log)?.[1] ?? -1)
  check('C5: il registro del ciclo di vita (temporaneo) ha le righe attese con l\'uscita misurata',
    righeOk && exitMsLog >= 0 && exitMsLog < 1000, `exit-ms=${exitMsLog}, righe: ${c5log.split('\n').length}`)
  // il ⌘Q VERO dal renderer (gancio di prova): si aspetta che NESSUN processo
  // UI resti vivo (qualsiasi copia della catena sia sopravvissuta)
  const t7 = await waitForTarget(mainTarget, 10_000)
  const t7cdp = t7 ? await openCdp(t7.webSocketDebuggerUrl).catch(() => null) : null
  if (t7cdp) {
    await waitDom(t7cdp, `window.sandbot && document.querySelector('form textarea')`, 10_000)
    const tCmdQ = Date.now()
    // la risposta IPC può non arrivare mai (l'app esce prima di rispondere):
    // si parte dopo 2 s al massimo, poi si guarda lo STATO (i processi)
    await Promise.race([
      pageEval(t7cdp, 'return await window.sandbot.testEmitQuit()').catch(() => undefined),
      sleep(2000)
    ])
    let uiPost = uiVivi()
    for (let i = 0; i < 75 && uiPost.length !== 0; i++) { await sleep(200); uiPost = uiVivi() }
    const cmdqMs = Date.now() - tCmdQ
    const c5log2 = existsSync(MAINLOG) ? readFileSync(MAINLOG, 'utf8') : ''
    const exitMs2 = Number(/quit exit-ms=(\d+)/.exec(c5log2.slice(c5log.length))?.[1] ?? -1)
    check('C5: ⌘Q vero (gancio di prova) → nessun processo UI vivo in meno di 1 s, exit-ms nel registro',
      uiPost.length === 0 && cmdqMs < 1000 && exitMs2 >= 0 && exitMs2 < 1000, `processi ${uiPost.length}, ${cmdqMs} ms, exit-ms=${exitMs2}`)
    t7cdp.sock?.close?.()
  } else {
    check('C5: ⌘Q vero (gancio di prova) → nessun processo UI vivo in meno di 1 s', false, 'nessun target dopo il rilancio')
  }

  // ---- pulizia K4 (come le altre sonde) ----
  await coldStop()
  try { fakeOldDaemon?.kill('SIGKILL') } catch { /* già via */ }
  if (Number.isInteger(fakeOldDaemon?.pid)) await waitPidGone(fakeOldDaemon.pid, 5_000)
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', `fase-avvio-probe|${join(ROOT, 'node_modules', 'electron')}`], { encoding: 'utf8' })
    for (const pidStr of String(out.stdout ?? '').trim().split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid && pid !== app?.pid) {
        try { process.kill(pid, 'SIGKILL'); log('app residua chiusa:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [DATA], log, capMs: 20_000 }).catch((e) => log('cleanupProbeRun:', e.message))
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
  let left = countProbeDirs(PREFIX, [DATA])
  if (left > 0) {
    await sleep(1500)
    await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
    left = countProbeDirs(PREFIX, [DATA])
  }
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  check('pulizia K4: 0 cartelle sandbot-fase-avvio-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  const vecchi = spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const vecchiVivi = String(vecchi.stdout ?? '').split('\n').filter((l) => l.includes('finto-daemon-vecchio'))
  check('pulizia K4: 0 processi del finto daemon vecchio', vecchiVivi.length === 0, JSON.stringify(vecchiVivi.map((l) => l.slice(0, 80))))
  await new Promise((r) => providerServer.close(r))
} catch (e) {
  log('ERRORE della sonda:', e?.stack ?? e)
  log('log app (coda):', appLog.slice(-1200))
  failed++
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: String(e?.message ?? e) })
  // pulizia d'emergenza comunque: 0 processi, 0 cartelle
  stopApp()
  try { fakeOldDaemon?.kill('SIGKILL') } catch { /* già via */ }
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: app?.pid ? [app.pid] : [], prefix: PREFIX, dirs: [DATA], log, capMs: 15_000 }).catch(() => undefined)
  await new Promise((r) => providerServer.close(r)).catch(() => undefined)
}

log(`CORSA avvio: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
