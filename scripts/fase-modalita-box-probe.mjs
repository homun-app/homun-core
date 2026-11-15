#!/usr/bin/env node
// Sonda Electron della fase modalita-box (MB5). L'app VERA (build di
// sviluppo in out/) su una cartella dati che parte da ZERO, guidata via CDP
// con CLIC VERI. La sonda NON semina MAI sandbox.mode — né env, né
// setSetting, né una riga del DB (lo prova la guardia
// scripts/__tests__/modalita-box-probe-guard.test.ts): è la prova che la
// scelta la registra l'APP. Il percorso:
//   - la GUIDA dal primo avvio: passo Tu → passo Modello col provider FINTO
//     openai-compatible su 127.0.0.1 (prova della chiave vera contro il
//     server finto) → passo Computer → «Prepara il computer» → la
//     preparazione fino a `ready` con la CLI finta (pacchetto finto servito
//     dalla sonda su 127.0.0.1, pkgutil/spctl/open FINTI, l'open finto
//     «installa» la CLI finta nel PATH di prova) → Permessi → Pronto → chat;
//   - il comando del bot: un run-command a copione dal provider finto →
//     l'argv deve arrivare alla CLI finta come `exec … sandbot-box …` e
//     NESSUNO spawn sul Mac (l'esito del comando non è il Darwin del Mac);
//   - la card «Computer»: «Acceso / esegue un comando…» durante, «In
//     attesa» dopo, MAI «Non in uso».
// Nel DB si semina SOLO sandbox.engine = apple-container (come
// fase-onboarding-a: il selettore automatico, su un Mac dove Docker
// risponde, guarderebbe quello — e sondare Docker vero qui è vietato).
// Nessun motore vero, nessun `container` vero (solo la CLI finta), nessun
// download vero, nessuna rete fuori da 127.0.0.1, mai l'app o il daemon sui
// dati veri dell'utente. A fine sonda: app E daemon chiusi davvero, la
// cartella dati rimossa, nessun push.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const PREFIX = 'sandbot-fase-modalita-box-'
const TMP = mkdtempSync(`/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/${PREFIX}`)
const SHOTS = join(ROOT, 'docs', 'catture', 'modalita-box')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log('[sonda]', ...a)
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Il log degli argv ricevuti dalla CLI finta (una riga JSON per chiamata). */
const readCliLog = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv)
  } catch {
    return []
  }
}

// ---- il provider FINTO (openai-compatible su 127.0.0.1): /models per la
// prova della chiave della guida, chat/completions con risposte A COPIONE
// (i tool call del comando e la risposta finale che RITARDA, per leggere la
// card col turno APERTO — come la fase computer-card) ----
const GOOD_KEY = 'chiave-finta-di-prova'
const chatRequests = []
const replies = []
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const auth = req.headers.authorization ?? ''
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    if (auth !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      chatRequests.push(JSON.parse(body))
      const next = replies.shift() ?? { text: 'ok' }
      // CC (fase computer-card): una risposta può RITARDARE — il turno del
      // bot resta APERTO mentre il tool gira e la card si legge DURANTE
      if (next.delayMs) await sleep(next.delayMs)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'openai.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      if (next.text) chunk({ content: next.text })
      for (const [i, tc] of (next.toolCalls ?? []).entries()) {
        chunk({ tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })
      }
      chunk({}, next.toolCalls ? 'tool_calls' : 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port
const PROVIDER_BASE = `http://127.0.0.1:${providerPort}/v1`

// ---- il PACCHETTO FINTO, servito su 127.0.0.1 dalla sonda (come
// fase-onboarding-a): byte FISSI, sha256 e dimensione passati al daemon con
// gli override SANDBOT_TEST_PKG_*; il download DURA, così dalla finestra si
// VEDREBBE l'avanzamento (qui basta che giri) ----
const PKG_BYTES = Buffer.alloc(3_000_000)
for (let i = 0; i < PKG_BYTES.length; i++) PKG_BYTES[i] = (i * 7 + 13) % 251
const PKG_SHA = createHash('sha256').update(PKG_BYTES).digest('hex')
const serveSlow = (res, from, to, total) => {
  res.writeHead(res.statusCode === 206 ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(to - from + 1),
    ...(res.statusCode === 206 ? { 'content-range': `bytes ${from}-${to}/${total}` } : {})
  })
  void (async () => {
    for (let at = from; at <= to; at += 60_000) {
      res.write(PKG_BYTES.subarray(at, Math.min(at + 60_000, to + 1)))
      await new Promise((r) => setTimeout(r, 30))
    }
    res.end()
  })()
}
const pkgServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.endsWith('/finto.pkg')) { res.writeHead(404).end(); return }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const from = Number(range[1])
    const to = range[2] ? Math.min(Number(range[2]), PKG_BYTES.length - 1) : PKG_BYTES.length - 1
    res.statusCode = 206
    serveSlow(res, from, to, PKG_BYTES.length)
    return
  }
  res.statusCode = 200
  serveSlow(res, 0, PKG_BYTES.length - 1, PKG_BYTES.length)
})
await new Promise((r) => pkgServer.listen(0, '127.0.0.1', r))
const pkgPort = pkgServer.address().port

// ---- i comandi FINTI come wrapper eseguibili (il PATH del daemon è
// minimo, senza node): gli .mjs veri stanno in scripts/, il wrapper invoca
// il node ESPPLICITO ----
const wrap = (dir, name, script) => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'scripts', script)}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}
// la cartella del PATH di prova: VUOTA finché l'open finto non «installa»
const OB_BIN = join(TMP, 'bin-di-prova')
mkdirSync(OB_BIN, { recursive: true })
const OB_CLI_SRC = wrap(TMP, 'cli-container-finta', 'fake-container.mjs')
const FAKE_PKGUTIL = wrap(TMP, 'pkgutil-finto', 'fake-pkgutil.mjs')
const FAKE_SPCTL = wrap(TMP, 'spctl-finto', 'fake-spctl.mjs')
const FAKE_OPEN = wrap(TMP, 'open-finto', 'fake-open.mjs')

// la cartella dati che parte da ZERO: si semina SOLO il motore (vedi testa)
const dataDir = join(TMP, 'dati')
mkdirSync(join(dataDir, 'data'), { recursive: true })
{
  const db = new DatabaseSync(join(dataDir, 'data', 'sandbot.db'))
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('sandbox.engine', '"apple-container"')
  db.close()
}
const cliLogFile = join(TMP, 'cli-finta.jsonl')
const openLog = join(TMP, 'open-finto.jsonl')
const appRoot = join(TMP, 'approot-cli-finta')

/** La riga sandbox.mode LETTA dal DB della cartella dati (solo LETTA, mai scritta). */
const leggiModalita = () => {
  try {
    const db = new DatabaseSync(join(dataDir, 'data', 'sandbot.db'), { readOnly: true })
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('sandbox.mode')
    db.close()
    return row ? String(JSON.parse(row.value)) : null
  } catch {
    return null
  }
}

// ---- l'app Electron (build di sviluppo) ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9377
let app = null
let appLog = ''
const launchApp = () => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: `${OB_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SANDBOT_TEST_USER_DATA: dataDir,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
      // la macchina FINTA che regge Apple container (macOS 26, arm64)
      SANDBOT_TEST_FAKE_PLATFORM: 'darwin',
      SANDBOT_TEST_FAKE_ARCH: 'arm64',
      SANDBOT_TEST_FAKE_MACOS_MAJOR: '26',
      // prima dell'«installazione» finta il percorso NON esiste → ENOENT
      // (mai la CLI vera di /usr/local/bin, `container` è installato su
      // questo Mac e qui non si chiama MAI); dopo, è il wrapper della finta
      HOMUN_CONTAINER_PATH: join(OB_BIN, 'container'),
      // la macchina finta dopo l'«installazione» è ACCESA ma SENZA kernel:
      // lo mette `kernel set` col consenso del passo Computer
      SANDBOT_TEST_CONTAINER_MODE: 'kernel-missing',
      SANDBOT_TEST_CONTAINER_LOG: cliLogFile,
      SANDBOT_TEST_CONTAINER_APP_ROOT: appRoot,
      // il pacchetto finto e gli strumenti finti della preparazione
      SANDBOT_TEST_PKG_URL: `http://127.0.0.1:${pkgPort}/finto.pkg`,
      SANDBOT_TEST_PKG_SHA256: PKG_SHA,
      SANDBOT_TEST_PKG_SIZE: String(PKG_BYTES.length),
      SANDBOT_TEST_PKGUTIL: FAKE_PKGUTIL,
      SANDBOT_TEST_SPCTL: FAKE_SPCTL,
      SANDBOT_TEST_OPEN: FAKE_OPEN,
      SANDBOT_TEST_OPEN_DELAY_MS: '800',
      SANDBOT_TEST_OPEN_CLI_SRC: OB_CLI_SRC,
      SANDBOT_TEST_OPEN_INSTALL_DIR: OB_BIN,
      SANDBOT_TEST_OPEN_LOG: openLog
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}

/** Chiude l'app E l'aspetta davvero: SIGTERM, 3 s, poi SIGKILL. */
const stopAppHard = async (proc) => {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise((r) => proc.once('exit', r))
  try { proc.kill('SIGTERM') } catch { return }
  const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* già via */ } }, 3_000)
  await Promise.race([gone, sleep(5_000)])
  clearTimeout(killer)
}

/** Le app residue delle corse precedenti (env della sonda + porta di debug): si chiudono PRIMA di partire. */
const stopProbeApps = async () => {
  const out = spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const pids = (out.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes(`--remote-debugging-port=${DEBUG_PORT}`) && line.includes(PREFIX) && !line.includes('--homun-daemon'))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  if (!pids.length) return 0
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* già via */ } }
  await sleep(2500)
  for (const pid of pids) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* già via */ }
  }
  return pids.length
}

// ---- CDP: la pagina del renderer ----
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
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id
      waits.set(mid, { res, rej })
      sock.send(JSON.stringify({ id: mid, method, params }))
    }),
    close: () => { try { sock.close() } catch { /* già via */ } }
  }
}
const waitForPage = async () => {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await httpJson('/json/list')
      const target = list.find((t) => t.type === 'page')
      if (target) return await openCdp(target.webSocketDebuggerUrl)
    } catch { /* il debugger non è ancora su */ }
    await sleep(200)
  }
  throw new Error('nessuna pagina CDP: log app:\n' + appLog.slice(-1500))
}
let page = null
const pageEval = async (expr) => {
  const r = await page.send('Runtime.evaluate', {
    expression: `((async () => { ${expr} })())`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
const waitDom = async (exprTrue, timeoutMs = 30_000, step = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pageEval(`return !!(${exprTrue})`).catch(() => false)) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
const clickTestid = (testid) => pageEval(`
  const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
  el.scrollIntoView({ block: 'center' })
  const b = el.matches('button') ? el : el.querySelector('button')
  ;(b ?? el).click()
  return 'cliccato'
`)
/** scrive in un input della guida col setter nativo (il valore VERO, l'evento VERO) */
const setInputValue = (testid, value) => pageEval(`
  const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!el) throw new Error('input non trovato: ' + ${JSON.stringify(testid)})
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'scritto'
`)
const shot = async (name) => {
  await sleep(500)
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
/** Il testo della card «Computer»: stato, riga sotto, tutto il testo. */
const cardFacts = () => pageEval(`return (() => {
  const card = document.querySelector('[data-testid="bot-computer-card"]')
  if (!card) return null
  const status = card.querySelector('[data-testid="bot-computer-status"]')
  const line = card.querySelector('[data-testid="bot-computer-line"]')
  return { all: card.textContent.trim(), status: status ? status.textContent.trim() : '', line: line ? line.textContent.trim() : '' }
})()`)
const waitCard = async (pred, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const f = await cardFacts().catch(() => null)
    if (f && pred(f)) return f
    if (Date.now() > deadline) return null
    await sleep(300)
  }
}
/** MANDA un messaggio in chat (setter nativo + Enter, come le sonde di prima). */
const sendChat = (userText) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(userText)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 120))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'inviato'
`)
const visibleText = () => pageEval('return document.body.innerText')

// ---- il giro ----
const SEGNAPOSTO = 'mb5-segnaposto-4242'
try {
  await stopProbeApps()
  log('avvio l’app su una cartella dati VUOTA (nessuna riga della modalità)…')
  check('MB5-0 la cartella dati parte SENZA nessuna riga sandbox.mode', leggiModalita() === null, `letto: ${JSON.stringify(leggiModalita())}`)
  app = launchApp()
  page = await waitForPage()
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) throw new Error('window.sandbot non disponibile')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, mobile: false, deviceScaleFactor: 2 })
  await sleep(500)

  // ---- la GUIDA dal primo avvio, con clic veri ----
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000))) throw new Error('la guida non appare al primo avvio')
  // passo Tu: nome e faccia
  await setInputValue('guide-name-input', 'Bot')
  await clickTestid('guide-family-jelly')
  await clickTestid('guide-color-c3')
  await clickTestid('guide-continue')
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 15_000))) throw new Error('il passo Modello non arriva')
  // passo Modello: il provider FINTO openai-compatible, con la prova della chiave
  await clickTestid('guide-provider-others')
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-other-openai-compatible"]')`, 10_000))) throw new Error('l\'elenco Altri… non si apre')
  await clickTestid('guide-other-openai-compatible')
  await setInputValue('guide-baseurl-input', PROVIDER_BASE)
  await setInputValue('guide-key-input', GOOD_KEY)
  await clickTestid('guide-key-probe')
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-probe-ok"]')`, 20_000))) throw new Error('la prova della chiave non passa')
  await clickTestid('guide-continue') // il modello consigliato (finto) è già scelto
  check('MB5-1 la guida: modello finto configurato → il passo Computer arriva', await waitDom(`!!document.querySelector('[data-testid="guide-step-computer"]')`, 15_000))

  // passo Computer: il consenso in parole, poi «Prepara il computer»
  check('MB5-2 il consenso del passo Computer in parole (con i GB calcolati)',
    (await visibleText()).includes('Il computer del bot')
    && (await visibleText()).includes('170 MB')
    && (await visibleText()).match(/circa \d+ GB/) !== null)
  await shot('mb5-guida-computer-prima.png')
  await clickTestid('guide-computer-prepare')
  check('MB5-3 «Prepara» → il download parte (riga in corso)',
    await waitDom(`document.querySelector('[data-testid="box-setup-row-download"]')?.getAttribute('data-status') === 'running'`, 20_000))
  await shot('mb5-guida-computer-durante.png')
  // verifica OK → attesa dell'Installer: l'open FINTO «installa»
  if (!(await waitDom(`!!document.querySelector('[data-testid="box-setup-open-installer"]')`, 40_000))) throw new Error('l\'attesa dell\'Installer non arriva')
  await clickTestid('box-setup-open-installer')
  check('MB5-4 la preparazione arriva a READY (la finestra è felice: «Ho il mio computer!»)',
    await waitDom(`document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') === 'happy'`, 90_000)
    && (await visibleText()).includes('Ho il mio computer!'),
    `phase: ${JSON.stringify(await rpc('boxSetupState()').then((r) => r?.phase ?? null).catch(() => null))}`)
  await shot('mb5-guida-computer-pronto.png')
  // LA SCELTA REGISTRATA DALL'APP: nessuna semina, la riga dev'esserci
  check('MB5-5 la GUIDA ha registrato la scelta: sandbox.mode = \'box\' scritto DALL\'APP nel DB vuoto',
    leggiModalita() === 'box', `letto: ${JSON.stringify(leggiModalita())}`)
  // fine della guida: Permessi → Pronto → chat. Si sceglie «Chiedi prima»:
  // il comando del bot arriverà col la sua card d'approvazione e la sonda la
  // CONSENTE col clic — il flusso vero dell'utente (dalla prova della beta.5:
  // «curl e grep approvati in chat» — e poi eseguiti SUL MAC, il difetto)
  await clickTestid('guide-continue')
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 10_000))) throw new Error('il passo Permessi non arriva')
  await clickTestid('guide-approvals-ask')
  await waitDom(`!document.querySelector('[data-testid="guide-continue"]')?.disabled`, 10_000)
  await clickTestid('guide-continue') // → Pronto
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-ready"]')`, 10_000))) throw new Error('il passo Pronto non arriva')
  check('MB5-6 il riepilogo «Pronto» dice «Computer: pronto»',
    ((await pageEval(`return (() => { const row = [...document.querySelectorAll('[data-testid^="guide-summary-"]')].find((n) => n.innerText.includes('Computer')); return row ? row.innerText : null })()`)) ?? '').includes('pronto'))
  await clickTestid('guide-continue') // «Apri la chat»
  if (!(await waitDom(`!!document.querySelector('form textarea')`, 20_000))) throw new Error('la chat non arriva')
  await shot('mb5-chat-dopo-guida.png')

  // la card DOPO la guida: il computer del bot È in uso — MAI «Non in uso»
  {
    const f = await waitCard((x) => x.status.includes('Spento') || x.status.includes('In attesa') || x.status.includes('In preparazione'), 15_000)
    check('MB5-7 la card «Computer» dopo la guida NON dice «Non in uso» (dice «Spento»: c\'è, è spento)',
      !!f && !f.status.includes('Non in uso'), JSON.stringify(f ?? (await cardFacts().catch(() => null))))
  }

  // ---- il comando del bot: la prova del NOVE ----
  replies.push({ toolCalls: [{ name: 'run-command', arguments: { command: `echo ${SEGNAPOSTO} && uname -s` } }] })
  replies.push({ text: 'Fatto il comando.', delayMs: 6_000 })
  const chatFrom = chatRequests.length
  await sendChat(`Esegui echo ${SEGNAPOSTO}`)
  // la card d'approvazione del comando («Chiedi prima»): si CONSENTE col
  // clic vero, come l'utente — poi il comando gira (nel box, o SUL MAC
  // com'era il difetto della beta.5)
  {
    let consentito = false
    for (let i = 0; i < 40 && !consentito; i++) {
      consentito = await pageEval(`
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Consenti')
        if (!btn) return false
        btn.click()
        return true
      `).catch(() => false)
      if (!consentito) await sleep(500)
    }
    if (!consentito) throw new Error('la card d\'approvazione del comando non arriva (o il bottone Consenti non si trova)')
    log('card d\'approvazione: Consentito col clic')
  }
  {
    const f = await waitCard((x) => x.status.includes('Acceso'))
    check('MB5-8 durante il comando la card dice «Acceso» con la riga «esegue un comando…» (MAI «Non in uso»)',
      !!f && f.line === 'esegue un comando…' && !f.all.includes('Non in uso'), JSON.stringify(f))
  }
  await shot('mb5-comando-in-corso.png')
  // la risposta finale chiude il turno
  {
    const seen = await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Fatto il comando.')`, 60_000)
    if (!seen) {
      const chatText = await visibleText().catch(() => '(illeggibile)')
      const approvals = await rpc("settingsGet('approvals.mode', null)").catch(() => null)
      throw new Error(`la risposta del bot non è arrivata — richieste: ${chatRequests.length}; approvals.mode: ${JSON.stringify(approvals)}; coda chat:\n${chatText.slice(-1200)}\n--- log app:\n${appLog.slice(-1200)}`)
    }
    await sleep(600)
  }
  {
    const f = await waitCard((x) => x.status.includes('In attesa') && x.line === '')
    check('MB5-9 a fine comando la card dice «In attesa» (senza riga), MAI «Non in uso»',
      !!f && !f.all.includes('Non in uso'), JSON.stringify(f))
  }
  await shot('mb5-comando-finito.png')

  // l'argv alla CLI finta: exec … sandbot-box … sh -c <il comando>
  const argvs = readCliLog(cliLogFile)
  const execDelBot = argvs.filter((a) => a[0] === 'exec' && a.includes('sandbot-box') && a.some((x) => typeof x === 'string' && x.includes(SEGNAPOSTO)))
  check('MB5-10 il comando del bot GIRA NEL BOX: exec … sandbot-box … sh -c alla CLI finta',
    execDelBot.length > 0, `exec con il segnaposto: ${execDelBot.length}; ultimi argv: ${JSON.stringify(argvs.slice(-3).map((a) => a.slice(0, 6)))}`)
  // NESSUNO spawn sul Mac: l'esito del comando torna al modello come risultato
  // del tool — sul Mac `uname -s` dice Darwin, la CLI finta non lo dice
  const toolTexts = chatRequests
    .slice(chatFrom)
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content)))
    .join('\n---\n')
  check('MB5-11 NESSUNO spawn sul Mac: l\'esito del comando NON è il Darwin del Mac',
    !toolTexts.includes('Darwin'), toolTexts.slice(0, 160))
  // e la scelta è ancora lì, scritta dall'app
  check('MB5-12 la scelta resta nel DB dopo il comando: sandbox.mode = \'box\' (nessuna semina della sonda)',
    leggiModalita() === 'box', `letto: ${JSON.stringify(leggiModalita())}`)
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(dataDir, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { await stopAppHard(app) } catch { /* già via */ }
  await sleep(1000)
  // 0 app e 0 daemon a fine sonda (le app vive RESPAWNNANO i daemon: prima loro)
  await stopProbeApps()
  const { found, closed, left } = await stopProbeDaemons(PREFIX)
  console.log(`daemon di sviluppo: ${found} trovati, ${closed} chiusi, ${left} rimasti`)
  if (left > 0) {
    failures++
    console.error('daemon rimasti:\n' + findProbeDaemons(PREFIX).map((d) => d.line).join('\n'))
  }
  try { page?.close() } catch { /* già via */ }
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  try { pkgServer.close() } catch { /* già chiusa */ }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  process.exit(failures ? 1 : 0)
}
