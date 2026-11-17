#!/usr/bin/env node
// U8 (fase prima-release): Cassaforte e routine provate DAL VIVO, come le
// userà l'utente — app VERA (out/, serve `npm run build` prima) su dati
// temporanei, modello FINTO (openai-compatible scriptabile su 127.0.0.1),
// Portachiavi FINTO (SANDBOT_TEST_FAKE_KEYCHAIN/SAFESTORAGE: MAI il vero),
// CLI `container` FINTA (HOMUN_CONTAINER_PATH) e SHELL FINTA per i comandi
// in host (il valore dei segreti entra solo nell'env del processo finto).
// Flussi CON LA UI via CDP (clic e tastiera, non solo RPC):
//   Cassaforte — login (aggiungi/sostituisci/elimina, password mai visibile),
//   segreti ({{secret:API_KEY}} nei comandi: card, consenso, valore MAI in
//   transcript/entry/log/DB — grep dei dati temporanei alla fine), contatti,
//   concessioni («Sempre per questo sito» + revoca);
//   Routine — creata dal BOT dalla chat (card «routine creata»), elenco col
//   prossimo orario, scatto DA SOLO (every 1 minute), pausa/riprendi/elimina,
//   modifica di una ATTIVA che chiede la card;
//   più i controlli U2 (bottone della barra: un clic stringe e uno allarga),
//   U3 (Stacca → la principale resta visibile, barra della PiP sempre
//   visibile, «Riporta in Homun») e U9 (finestra a 600 px, «Prendi il
//   controllo», «Ho finito» dentro la vista).
// Catture CDP in docs/catture/prima-release/ (guida e Impostazioni › Modelli
// nei due temi incluse). Rete solo su 127.0.0.1. VERDE in TRE corse di fila:
// node scripts/fase-prima-release-probe.mjs --run 1|2|3
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
// K4: la pulizia vera di fine corsa (attesa dei pid, controllo delle cartelle)
import { cleanupProbeRun } from './lib/probe-rm.mjs'

// il figlio del server RFB si guarda SUBITO: niente cartelle né server nel figlio

const run = Number(new URLSearchParams(process.argv.slice(2).join('&')).get('run') ?? 1)
const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-prima-release'
const SHOTS = join(ROOT, 'docs', 'catture', 'prima-release')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log(`[sonda r${run}]`, ...a)
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

// ---- la SHELL FINTA (host finto): logga comando e env, risponde "ok-host" ----
const DATA = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
const SHELL_LOG = join(DATA, 'host-commands.log')
const FAKE_SHELL = join(DATA, 'fake-shell.sh')
writeFileSync(FAKE_SHELL, [
  '#!/bin/sh',
  '# host FINTO della sonda: logga il comando ricevuto e l\'env dei segreti',
  '{ echo "=== CMD: $*"; env | grep -E "^SANDBOT_SECRET" || echo "(nessun segreto in env)"; } >> "$0.log" 2>&1',
  'echo "ok-host"',
  'exit 0'
].join('\n').replace('$0.log', JSON.stringify(SHELL_LOG)))
chmodSync(FAKE_SHELL, 0o755)

// ---- la CLI `container` FINTA (mai quella vera) ----
const FAKE_CONTAINER = join(DATA, 'fake-container.sh')
writeFileSync(FAKE_CONTAINER, [
  '#!/bin/sh',
  '# CLI container FINTA della sonda: niente docker, niente container vero',
  'if [ "$1" = "--version" ]; then echo "container 1.7.1-finta"; exit 0; fi',
  'echo "[]" ; exit 0'
].join('\n'))
chmodSync(FAKE_CONTAINER, 0o755)

// ---- il server RFB FINTO (il desktop del bot, per U3/U9): un fotogramma ----
const SOCK = join(DATA, 'sock')
mkdirSync(SOCK)
const rfbChildMain = (sockPath) => {
  // handshake RFB 003.008 COME LO PARLA noVNC (la causa di K3 era qui): RFB 3.8
  // vuole il passo dei TIPI DI SICUREZZA — [1, 1] (un tipo: None), la scelta
  // del client, POI il SecurityResult. Il vecchio server saltava il passo e
  // rispondeva [0,0,0,0] subito dopo la versione: noVNC leggeva il primo 0
  // come «zero tipi» e aspettava per sempre i 4 byte della «reason» → la vista
  // della scheda Schermo non si collegava MAI («La connessione allo schermo si
  // è chiusa», niente «Prendi il controllo»). Il SetPixelFormat (tipo 6) è 20
  // byte FISSI: leggerlo come 8+n col n preso dai byte del pixel format lo
  // bloccava su 537 MB e il fotogramma non partiva mai. Un client che sparisce
  // (il ponte SIGKILLato dal daemon) non uccide il server: l'errore del socket
  // si ingoia (x11vnc sopravvive ai client morti).
  const W = 1280, H = 800
  const createServer = createNetServer
  const server = createServer((sock) => {
    sock.write(Buffer.from('RFB 003.008\n'))
    sock.on('error', () => { /* un client morto non uccide il desktop finto */ })
    let buf = Buffer.alloc(0)
    let stage = 'version'
    let lastFrame = 0
    let frameTimer = null
    // un rettangolo PICCOLO (320×200), come la sonda schermo-vivo: un
    // fotogramma intero 1280×800 (4 MB) a ogni richiesta soffocherebbe il
    // renderer principale (l'anteprima lo riceve a raffica)
    const sendFullFrame = () => {
      const w = 320, h = 200
      const b = Buffer.alloc(w * h * 4)
      for (let i = 0; i < b.length; i += 4) { b[i] = 28; b[i + 1] = 24; b[i + 2] = 24; b[i + 3] = 255 }
      const head = Buffer.alloc(16)
      head[0] = 0; head[1] = 0; head.writeUInt16BE(1, 2)
      head.writeUInt16BE(Math.round((W - w) / 2), 4); head.writeUInt16BE(Math.round((H - h) / 2), 6)
      head.writeUInt16BE(w, 8); head.writeUInt16BE(h, 10)
      head.writeInt32BE(0, 12) // RAW
      sock.write(Buffer.concat([head, b]))
    }
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (stage === 'version') {
          const i = buf.indexOf(0x0a)
          if (i < 0) return
          buf = buf.subarray(i + 1)
          stage = 'types'
          sock.write(Buffer.from([1, 1])) // RFB 3.8: UN tipo di sicurezza: None
          continue
        }
        if (stage === 'types') {
          if (buf.length < 1) return
          buf = buf.subarray(1) // la scelta del client (1 = None)
          stage = 'client-init'
          sock.write(Buffer.from([0, 0, 0, 0])) // SecurityResult: OK (nessuna sicurezza)
          continue
        }
        if (stage === 'client-init') {
          if (buf.length < 1) return
          buf = buf.subarray(1) // ClientInit (shared) — ignorato
          stage = 'ready'
          const init = Buffer.alloc(24 + 5)
          init.writeUInt16BE(W, 0)
          init.writeUInt16BE(H, 2)
          init[4] = 32
          init[5] = 24
          init[6] = 0 // little-endian
          init[7] = 1 // true colour
          init.writeUInt16BE(255, 8)
          init.writeUInt16BE(255, 10)
          init.writeUInt16BE(255, 12)
          init[14] = 16
          init[15] = 8
          init.writeUInt32BE(5, 20)
          init.write('sonda', 24, 'latin1')
          sock.write(init)
          // NESSUN frame non richiesto dopo il ServerInit: solo su
          // FramebufferUpdateRequest esplicito del client
          continue
        }
        // 'ready': i messaggi del client si LEGGONO e si ignorano (parser
        // uguale alla sonda schermo-vivo); al FramebufferUpdateRequest (3)
        // si risponde con un fotogramma intero
        if (buf.length < 1) return
        const type = buf[0]
        if (type === 2) {
          if (buf.length < 4) return
          const n = buf.readUInt16BE(2)
          if (buf.length < 4 + n * 4) return
          buf = buf.subarray(4 + n * 4)
          continue
        }
        if (type === 6) {
          // SetPixelFormat: [6][pad3][16 byte di formato][pad3] = 20 byte FISSI
          // (K3: leggerlo come 8+n col n dai byte del formato lo bloccava su
          // 537 MB e il fotogramma non partiva MAI)
          if (buf.length < 20) return
          buf = buf.subarray(20)
          continue
        }
        if (type === 3) {
          if (buf.length < 10) return
          buf = buf.subarray(10)
          // UN SOLO fotogramma per connessione (schermo statico): noVNC
          // richiede a raffica e il renderer principale si soffocherebbe
          if (!lastFrame) {
            lastFrame = 1
            sendFullFrame()
          }
          continue
        }
        const len = { 0: 20, 4: 8, 5: 6 }[type]
        if (len === undefined) {
          buf = buf.subarray(1)
          continue
        }
        if (buf.length < len) return
        buf = buf.subarray(len)
      }
    })
  })
  server.listen(sockPath)
}
if (process.argv.includes('--rfb-server')) {
  // K4: il figlio esegue la TESTA dello script prima di arrivare qui e crea
  // la sua cartella dati come il padre (erano le «2 cartelle da 8 KB» che le
  // corse in errore lasciavano): la butta SUBITO, il figlio non tiene niente
  rmSync(DATA, { recursive: true, force: true })
  rfbChildMain(process.argv[process.argv.indexOf('--rfb-server') + 1])
  await new Promise(() => undefined) // il figlio resta vivo: mai il codice della sonda
}

// i socket esistono come FILE muti (il daemon li vede, nessuno ascolta):
// il server RFB VERO parte solo per la finestra U3→U9 (startRfb) — vivo a
// lungo, il renderer principale finisce per congelarsi
writeFileSync(join(SOCK, 'vnc-view.sock'), '')
writeFileSync(join(SOCK, 'vnc-control.sock'), '')
let rfbView = null
let rfbControl = null
const startRfb = () => {
  rmSync(join(SOCK, 'vnc-view.sock'), { force: true })
  rmSync(join(SOCK, 'vnc-control.sock'), { force: true })
  rfbView = spawn(process.execPath, [new URL(import.meta.url).pathname, '--rfb-server', join(SOCK, 'vnc-view.sock')], { stdio: 'ignore' })
  rfbControl = spawn(process.execPath, [new URL(import.meta.url).pathname, '--rfb-server', join(SOCK, 'vnc-control.sock')], { stdio: 'ignore' })
  // K3: se un server RFB finto ESCE, le connessioni dopo cadono per colpa sua —
  // un indizio che il prodotto non c'entra (il file socket resterebbe, nessuno
  // ascolta più: i ponti muoiono subito)
  rfbView.on('exit', (code, signal) => log('ATTENZIONE: il server RFB finto VIEW è uscito', { code: String(code), signal: String(signal) }))
  rfbControl.on('exit', (code, signal) => log('ATTENZIONE: il server RFB finto CONTROL è uscito', { code: String(code), signal: String(signal) }))
}
const stopRfb = () => {
  rfbView?.kill('SIGTERM')
  rfbControl?.kill('SIGTERM')
  rfbView = rfbControl = null
}

// ---- il modello FINTO (scriptabile): ogni /chat/completions consuma la ----
// ---- prossima risposta della coda (vuota → testo "ok")                  ----
/** le risposte del modello finto scattano quando il body della richiesta contiene `when` */
const script = []
const chatRequests = []
const sse = (delta, finish) => `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const sayText = (text, when = null) => script.push({ kind: 'text', text, when })
const callTool = (name, args, when = null) => script.push({ kind: 'tool', name, args, when })
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
      chatRequests.push({ body, url: req.url })
      // la prima risposta il cui `when` calza (o senza when: la prima in coda);
      // default: la routine Zampillo risponde col suo marker (per lo scatto da sola)
      let idx = script.findIndex((x) => !x.when || body.includes(x.when))
      if (idx < 0) idx = script.length // niente: si usa il default
      const next = idx < script.length ? script.splice(idx, 1)[0] : (body.includes('parola gentile')
        ? { kind: 'text', text: 'zampillo-scattata: una parola gentile' }
        : { kind: 'text', text: 'ok' })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (next.kind === 'tool') {
        res.write(sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_finto', type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null))
        res.write(sse({}, 'tool_calls'))
      } else {
        res.write(sse({ role: 'assistant', content: next.text }, null))
        res.write(sse({}, 'stop'))
      }
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
const DEBUG_PORT = 9374 + run
let appLog = ''
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    // il PATH VERO: il daemon spawna `node` per il finto MCP del browser
    PATH: process.env.PATH,
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
    SANDBOT_TEST_FAKE_BROWSER_MCP: join(ROOT, 'scripts', 'fake-browser-mcp.mjs'),
    SANDBOT_TEST_FAKE_SCREEN_SOCKET: SOCK,
    // K3: la traccia di sola prova del ponte /screen (apertura, modalità, chi
    // chiude e quando) — la sonda la stampa a un KO
    SANDBOT_TEST_SCREEN_TRACE: join(DATA, 'screen-trace.jsonl'),
    // host FINTO: i comandi dei bot girano nella shell che logga, mai sul Mac
    SHELL: FAKE_SHELL,
    // CLI container FINTA: vince su PATH e sul fallback
    HOMUN_CONTAINER_PATH: FAKE_CONTAINER
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
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
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id
      waits.set(mid, { res, rej })
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
  }
}
const waitForPage = async (urlIncludes) => {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await httpJson('/json/list')
      const target = list.find((t) => t.type === 'page' && (t.url ?? '').includes(urlIncludes))
      if (target) return { cdp: await openCdp(target.webSocketDebuggerUrl), url: target.url }
    } catch { /* il debugger non è ancora su */ }
    await sleep(200)
  }
  throw new Error(`nessuna pagina CDP per ${urlIncludes}: log app:\n` + appLog.slice(-1500))
}
const main = await waitForPage('')
const page = main.cdp
log('CDP collegato al renderer')
const pageEval = async (expr) => {
  let r
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      r = await withTimeout(page.send('Runtime.evaluate', {
        expression: `((async () => { ${expr} })())`,
        awaitPromise: true,
        returnByValue: true
      }), 35_000, 'Runtime.evaluate')
      break
    } catch (e) {
      if (attempt === 3) throw e
      await sleep(2500) // pagina occupata (un turno che gira): si riprova
    }
  }
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await pageEval(`return !!(${exprTrue})`)) return true
    } catch { /* pagina occupata: si continua */ }
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
const setViewport = async (width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const settle = async () => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pageEval(`await new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) })`)
  await sleep(350)
}
const shot = async (name) => {
  await settle()
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
/** ⌘, apre le Impostazioni (lo standard macOS che il renderer ascolta), Esc chiude. */
const pressKeys = (opts) => pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(opts)})); return true`)
const openSettings = () => pressKeys({ key: ',', code: 'Comma', metaKey: true, bubbles: true })
const pressEscape = () => pressKeys({ key: 'Escape', code: 'Escape', bubbles: true })
const dumpButtons = () => pageEval(`return {
  dialog: !!document.querySelector('[role="dialog"]'),
  aside: !!document.querySelector('aside'),
  buttons: [...document.querySelectorAll('button')].slice(0, 40).map((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()).slice(0, 32))
}`).catch(() => null)
/** chiude il dialog aperto col bottone «Chiudi» (l'Esc sintetico non basta). */
const closeDialog = async () => {
  for (let i = 0; i < 6; i++) {
    if (!(await pageEval('return !!document.querySelector(\"[role=dialog]\")'))) return true
    await clickText('Chiudi', { exact: true })
    await sleep(700)
  }
  return !(await pageEval('return !!document.querySelector(\"[role=dialog]\")'))
}
/** il foglio del bot si RIAPRE fresco: la sezione Routine si carica al mount (dopo una creazione la lista chiusa resta stantia). */
const reopenBotSheet = async () => {
  for (let i = 0; i < 5 && await pageEval('return !!document.querySelector(\"[role=dialog]\")'); i++) {
    await clickText('Chiudi', { exact: true })
    await sleep(600)
  }
  await clickText('Impostazioni del bot', { exact: true })
  await sleep(900)
}
const clickTestid = (testid) => pageEval(`
  const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!el) return false
  el.scrollIntoView({ block: 'center' })
  const b = el.matches('button, [role="button"]') ? el : el.querySelector('button')
  ;(b ?? el).click()
  return true
`)
/** il clic su un bottone/voce col TESTO esatto o contenuto (aspetta che ci sia). */
const clickText = async (text, { scope = 'document', exact = false, timeoutMs = 15_000 } = {}) => {
  const deadline = Date.now() + timeoutMs
  const expr = `
    const root = ${scope}
    const nodes = [...root.querySelectorAll('button, [role="menuitem"], [role="button"], a')]
    const t = ${JSON.stringify(text)}
    const b = nodes.find((x) => ${exact ? `x.textContent.trim() === t || x.getAttribute('aria-label') === t` : `x.textContent.trim().includes(t) || (x.getAttribute('aria-label') ?? '').includes(t)`})
    if (!b) return false
    b.scrollIntoView({ block: 'center' })
    b.click()
    return true
  `
  while (Date.now() < deadline) {
    if (await pageEval(expr).catch(() => false)) return true
    await sleep(250)
  }
  return false
}
/** il valore di un input cercato per placeholder (il modulo dei form del vault). */
const fillByPlaceholder = async (placeholder, value) => pageEval(`
  const el = [...document.querySelectorAll('input')].find((x) => x.placeholder.includes(${JSON.stringify(placeholder)}))
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
`)
/** manda un messaggio in chat col compositore VERO. */
const sendMessage = async (text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const form = ta.closest('form')
  form.requestSubmit()
  return true
`)

try {
  // ---- attesa del renderer e configurazione (provider FINTO senza chiave: U6) ----
  if (!(await waitDom(`typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile: ' + appLog.slice(-800))
  await setViewport(1280, 860)
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  const agents = await rpc('listAgents()')
  const bot = agents.find((a) => a.id) ?? agents[0]
  if (!bot) throw new Error('nessun bot dopo il setup: ' + appLog.slice(-800))
  log('bot del test:', bot.id, bot.name)
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  // la GUIDA del primo avvio si chiude (passi skippati: il modello è già il
  // finto) — poi l'app vera con la barra e la chat. DUE passate: la prima
  // può arrivare prima che lo stato dell'onboarding sia pronto.
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(`document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(`document.querySelector('aside')`, 1_000))) {
    throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))
  }

  // da qui il computer dei bot è «box» (la scheda Schermo del pannello
  // esiste solo così, BX1) — i socket finti e il browser finto fanno il resto
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('box')})`).catch(() => undefined)

  // per il SEGRETO si torna in host (il comando deve girare sul Mac, nella
  // shell che logga), poi si tornerà box per routine/concessioni/PiP
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)

  // =========== U2: il bottone della barra, un clic stringe e uno allarga ===========
  {
    await waitDom(`document.querySelector('[data-testid="sidebar-toggle"]')`)
    const widthOf = async () => pageEval(`return document.querySelector('aside')?.getBoundingClientRect().width ?? 0`)
    const full = await widthOf()
    check('U2: il bottone della barra c\'è e la barra è LARGA', full > 200, `larghezza ${full}`)
    check('U2: un clic STRINGE la barra', await clickTestid('sidebar-toggle') && await waitDom(`(document.querySelector('aside')?.getBoundingClientRect().width ?? 0) < 100`, 5000))
    const rail = await widthOf()
    check('U2: il bottone resta LÌ anche da stretta (stessa posizione)', await waitDom(`document.querySelector('[data-testid="sidebar-toggle"]')`, 3000), `rotaia ${rail}`)
    check('U2: un clic ALLARGA la barra', await clickTestid('sidebar-toggle') && await waitDom(`(document.querySelector('aside')?.getBoundingClientRect().width ?? 0) > 200`, 5000))
  }

  // =========== Cassaforte: la UI (Impostazioni › Cassaforte) ===========
  // SANDBOT_PROBE_FAST=1 (solo per indagare K3): salta Cassaforte, segreto,
  // routine e concessioni e va dritto a U3+U9+K3 — la corsa COMPLETA resta
  // quella senza la variabile
  const FAST = process.env.SANDBOT_PROBE_FAST === '1'
  // il valore segreto e il log dell'env del turno di prova (servono ANCHE al
  // controllo finale: stanno nello scope del try, fuori dal blocco NON-FAST)
  const SECRET_VALUE = 'sk-valore-segreto-7f3d9a'
  const SECRET_ENV_LOG = join(DATA, 'secret-in-command.log')
  if (!FAST) {
  check('Cassaforte: le Impostazioni si aprono (⌘, come il Mac)', await openSettings() && await waitDom(`[role="dialog"]`, 10_000))
  check('Cassaforte: la scheda si apre', await clickText('Cassaforte', { scope: 'document', exact: true }))
  await waitDom(`document.body.textContent.includes('Aggiungi login')`)

  // — Login: aggiungi (etichetta, origini, utente, password), la password non si vede —
  check('Login: «+ Aggiungi login» apre il modulo', await clickText('+ Aggiungi login'))
  await fillByPlaceholder('Etichetta', 'Portale ASPI')
  await fillByPlaceholder('Origini', 'https://aspi.example')
  await fillByPlaceholder('Nome utente', 'utente-prova')
  await fillByPlaceholder('Password', SECRET_VALUE)
  check('Login: «Salva» crea il login (la PASSWORD mai visibile nel DOM)', await clickText('Salva', { exact: true }) &&
    (await rpc('vaultItems()')).some((i) => i.kind === 'login' && String(i.label).includes('Portale ASPI')) &&
    !(await pageEval(`return document.body.textContent.includes(${JSON.stringify(SECRET_VALUE)})`)))

  // — sostituisci la password, poi elimina —
  {
    await waitDom(`document.body.textContent.includes('Portale ASPI')`, 8000)
    check('Login: «sostituisci» riapre il modulo', await clickText('sostituisci', { exact: true }))
    await fillByPlaceholder('Nome utente', 'utente-prova-2')
    await fillByPlaceholder('Password', 'sk-seconda-9e8d7c')
    await clickText('Salva', { exact: true })
    await sleep(600)
    check("Login: «elimina» li toglie dall'elenco (il «sostituisci» crea la nuova accanto alla vecchia)", await (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!(await rpc('vaultItems()')).some((x) => x.kind === 'login' && String(x.label).includes('Portale ASPI'))) return true
        await clickText('elimina', { exact: true })
        await sleep(1500)
      }
      return !(await rpc('vaultItems()')).some((x) => x.kind === 'login' && String(x.label).includes('Portale ASPI'))
    })())
  }

  // — Segreti (SOTTO-SCHEDA): aggiungi API_KEY —
  check('Segreti: la sotto-scheda si apre', await clickText('Segreti', { exact: true }) &&
    await waitDom(`document.body.textContent.includes('secret:')`, 8000))
  await fillByPlaceholder('Nome (es. API_KEY)', 'API_KEY')
  await fillByPlaceholder('Valore (sostituisce)', SECRET_VALUE)
  check('Segreti: «Salva» mette API_KEY nel vault', await clickText('Salva', { exact: true }) &&
    (await rpc('vaultItems()')).some((i) => i.kind === 'secret' && i.name === 'API_KEY'))

  // — Contatti (SOTTO-SCHEDA): aggiungi, modifica, elimina —
  check('Contatti: la sotto-scheda si apre', await clickText('Contatti', { exact: true }) && await sleep(400) === undefined)
  check('Contatti: «+ Aggiungi contatto» apre il modulo', await clickText('+ Aggiungi contatto'))
  await fillByPlaceholder('Nome', 'Bianchi Rossi')
  await fillByPlaceholder('Email', 'bianchi@example.com')
  check('Contatti: «Salva» crea il contatto', await clickText('Salva', { exact: true }) &&
    (await rpc('vaultItems()')).some((i) => i.kind === 'contact'))
  {
    check('Contatti: «modifica» riapre i campi', await clickText('modifica', { exact: true }))
    await fillByPlaceholder('Nome', 'Bianchi Rossi Sr.')
    await clickText('Salva', { exact: true })
    await sleep(600)
    let contactsGone = false
    for (let attempt = 0; attempt < 4 && !contactsGone; attempt++) {
      contactsGone = !(await rpc('vaultItems()')).some((x) => x.kind === 'contact')
      if (!contactsGone) { await clickText('elimina', { exact: true }); await sleep(1500) }
    }
    check("Contatti: «elimina» li toglie tutti", contactsGone)
  }

  // =========== il bot usa il segreto: card, consenso, valore SOLO nell'env ===========
  await pressEscape()
  await sleep(700)
  await waitDom(`document.querySelector('form textarea')`)
  callTool('run-command', { command: `echo "{{secret:API_KEY}}" > ${JSON.stringify(SECRET_ENV_LOG)} ; echo finto-ok-host` }, 'apri il portale')
  sayText('Fatto: la pagina del portale risponde.', 'apri il portale')
  check('Segreto: il messaggio parte dalla UI', await sendMessage('apri il portale con la mia chiave'))
  // la card dei comandi CON SEGRETO chiede sempre
  check('Segreto: la card di approvazione compare (i comandi con un segreto chiedono SEMPRE)', await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`, 30_000))
  check('Segreto: «Consenti» manda il comando (host finto)', await clickText('Consenti', { exact: true }))
  // il comando gira col valore sostituito: nell'ENV della shell finta, mai nel comando
  await sleep(2500)
  let envLog = ''
  for (let i = 0; i < 30; i++) {
    try { envLog = readFileSync(SECRET_ENV_LOG, 'utf8'); break } catch { await sleep(500) }
  }
  check("Segreto: il comando è GIRATO (host) col valore nell'ENV del processo", envLog.trim() === SECRET_VALUE,
    envLog ? envLog.slice(0, 120) : 'nessun log: il comando non è girato')
  check('Segreto: il VALORE non compare nel DOM', !(await pageEval(`return document.body.textContent.includes(${JSON.stringify(SECRET_VALUE)})`)))
  check('Segreto: il turno finisce e la risposta compare', await waitDom(`document.body.textContent.includes('Fatto')`, 30_000))
  {
    const entries2 = await rpc(`getEntries(${JSON.stringify(bot.id)})`).catch(() => [])
    const toolResults = (entries2 ?? []).filter((e) => e.kind === 'tool-result').slice(-2)
  }

  // da qui in poi il computer dei bot è «box»: la scheda Schermo del
  // pannello esiste solo così (BX1) e i socket finti fanno il resto — i
  // comandi col segreto sono già girati in host
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('box')})`).catch(() => undefined)

  // =========== Routine: creata dal BOT, elenco, scatto da sola, pausa/elimina ===========
  // le Impostazioni si chiudono DAVVERO (un dialog aperto rubava i clic sul pannello)
  await closeDialog()
  await clickText('Mostra il pannello del bot')
  await sleep(600)
  const routineTabOk = await clickText('Impostazioni del bot', { exact: true }) &&
    await waitDom(`document.body.textContent.includes('Nessuna routine.') || document.body.textContent.includes('prossima')`, 8000)
  check('Routine: la sezione Routine del pannello si apre (foglio del bot)', routineTabOk)
  const createZampillo = { target: 'routine', action: 'create', name: 'Zampillo', prompt: "Di' una parola gentile a chi legge.", schedule: '* * * * *', activate: true }
  callTool('update_state', createZampillo, 'creami una routine')
  callTool('update_state', createZampillo, 'creami una routine')
  sayText('Fatto: la routine Zampillo gira ogni minuto.', 'creami una routine')
  check('Routine: la richiesta della chat parte', await sendMessage('creami una routine che ogni minuto dice una parola gentile'))
  const routineCardCame = await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`, 30_000)
  check('Routine: la CARD di update_state compare (sempre chiesta, mai «Consenti sempre»)', routineCardCame)
  const noAlways = await pageEval(`return ![...document.querySelectorAll('button, [role="menuitem"]')].some((b) => b.textContent.includes('Consenti sempre'))`)
  check('Routine: la card NON offre «Consenti sempre» (update_state non si concede per sempre)', noAlways)
  check("Routine: «Consenti» crea la routine (card «routine creata» + RPC)", await clickText('Consenti', { exact: true }) && await (async () => {
    for (let i = 0; i < 25; i++) {
      const rs = await rpc(`listRoutines(${JSON.stringify(bot.id)})`).catch(() => [])
      if ((rs ?? []).some((r) => r.title === 'Zampillo')) return true
      await sleep(500)
    }
    return false
  })())
  const sheetHasProssima = () => waitDom(`(() => { const sh = document.querySelector('[data-testid="bot-sheet-routines"]'); return !!sh && sh.textContent.includes('prossima') })()`, 10_000)
  await reopenBotSheet()
  const elencoOk = await sheetHasProssima()
  check("Routine: la routine è nell'elenco del pannello col PROSSIMO orario", elencoOk)
  await shot('routine-creata.png')

  // — scatta DA SOLA (every 1 minute: il pianificatore non scende sotto il minuto) —
  log('aspetto lo scatto da sola (every 1 minute: ~75 s)...')
  const countMarker = () => pageEval(`return document.body.textContent.split('zampillo-scattata').length - 1`)
  const lastRunOf = async () => {
    const rs = (await rpc(`listRoutines(${JSON.stringify(bot.id)})`).catch(() => [])) ?? []
    return Number(rs.find((r) => r.title === 'Zampillo')?.last_run ?? 0)
  }
  const lastRunBefore = await lastRunOf()
  let fired = false
  for (let i = 0; i < 95 && !fired; i++) {
    await sleep(1000)
    const now = await lastRunOf()
    fired = now > lastRunBefore ||
      (await pageEval(`return (document.body.textContent.split('zampillo-scattata').length - 1) > 0`).catch(() => false))
  }
  log('marker dopo l attesa:', await pageEval("return document.body.textContent.split('zampillo-scattata').length - 1").catch(() => -1))
  log('stato routine:', JSON.stringify(await rpc(`listRoutines(${JSON.stringify(bot.id)})`).catch(() => null)))
  let runsAfterFire = []
  try { runsAfterFire = await rpc(`(typeof window.sandbot.listRoutineRuns === 'function' ? await window.sandbot.listRoutineRuns(${JSON.stringify(bot.id)}) : [])`) } catch { /* RPC assente: si guarda la chat */ }
  const runsTotal = await rpc(`activityList(${JSON.stringify(bot.id)}, 50)`).then((a) => (a ?? []).filter((x) => String(x?.kind ?? x?.type ?? '').includes('routine') || String(x?.title ?? '').includes('Zampillo')).length).catch(() => 0)
  check('Routine: SCATTA DA SOLA allo scadere (ogni minuto: atteso e scritto)', fired || runsTotal > 0, fired ? 'visto nella chat' : `${runsTotal} run in attività`)

  // — la MODIFICA di una routine ATTIVA chiede la card (serve l'id) —
  let zampillo = null
  for (let i = 0; i < 24 && !zampillo; i++) {
    zampillo = ((await rpc(`listRoutines(${JSON.stringify(bot.id)})`).catch(() => [])) ?? []).find((r) => r.title === 'Zampillo') ?? null
    if (!zampillo) await sleep(500)
  }
  const updateZampillo = { target: 'routine', action: 'update', id: zampillo?.id ?? 0, name: 'Zampillo', prompt: 'Di due parole gentili a chi legge.', schedule: '* * * * *' }
  callTool('update_state', updateZampillo, 'cambia la routine')
  callTool('update_state', updateZampillo, 'cambia la routine')
  sayText('Fatto: ora dice due parole.', 'cambia la routine')
  await sendMessage('cambia la routine: due parole gentili')
  check('Routine: la modifica di una ATTIVA chiede la card', await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`, 30_000))
  await clickText('Consenti', { exact: true })
  await sleep(1500)

  // — pausa (non scatta più), riprendi, elimina —
  await reopenBotSheet()
  check('Routine: «metti in pausa» (non scatta più)', await clickText('metti in pausa', { exact: true }) &&
    await waitDom(`document.body.textContent.includes('in pausa')`, 8_000))
  const beforePause = await countMarker()
  const pausedAt = Date.now()
  await sleep(75_000)
  const afterPause = await countMarker()
  check('Routine: in PAUSA non scatta (un minuto intero senza run)', afterPause === beforePause, `${Math.round((Date.now() - pausedAt) / 1000)} s in pausa, marker ${beforePause}→${afterPause}`)
  check('Routine: «riprendi» la riattiva', await clickText('riprendi', { exact: true }) &&
    await waitDom(`document.body.textContent.includes('prossima')`, 8_000))
  // elimina: le Impostazioni › Routine — si ripuliscono le card pendenti, si
  // chiude quel che c'è aperto, si aprono le Impostazioni e si clicca la loro voce Routine
  for (let i = 0; i < 3 && await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`); i++) {
    await clickText('Consenti', { exact: true })
    await sleep(1200)
  }
  await closeDialog()
  await openSettings()
  await waitDom(`document.body.textContent.includes('Generali')`, 8000)
  await clickText('Routine', { exact: true, scope: 'document.querySelector(\"[role=dialog]\") || document' })
  const eliminaOk = await waitDom(`document.body.textContent.includes('Zampillo')`, 8000) && await clickText('elimina', { exact: true }) && await (async () => {
    for (let i = 0; i < 20; i++) {
      const rs = (await rpc(`listRoutines(${JSON.stringify(bot.id)})`).catch(() => null)) ?? []
      if (!rs.some((r) => r.title === 'Zampillo')) return true
      await sleep(400)
    }
    return false
  })()
  check('Routine: «elimina» la toglie (nessun turno dopo)', eliminaOk)
  await pressEscape()

  // =========== Concessioni: «Sempre per questo sito» del fill, e revoca ===========
  // un login da compilare + la richiesta del bot di fare il fill
  await openSettings()
  await waitDom(`[role="dialog"]`)
  await clickText('Cassaforte', { exact: true })
  await waitDom(`document.body.textContent.includes('Aggiungi login')`)
  await clickText('+ Aggiungi login')
  await fillByPlaceholder('Etichetta', 'Portale Posta')
  await fillByPlaceholder('Origini', 'https://spa.example')
  await fillByPlaceholder('Nome utente', 'utente-posta')
  await fillByPlaceholder('Password', 'pwd-posta-4e5f6g')
  await clickText('Salva', { exact: true })
  await closeDialog()
  const postaLogin = ((await rpc('vaultItems()')) ?? []).find((x) => x.kind === 'login' && String(x.label).includes('Portale Posta'))
  const fillPosta = { id: String(postaLogin?.id ?? postaLogin?.key ?? 'Portale Posta'), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }
  // il fill esige una PAGINA APERTA sull'origine del login: prima si naviga
  // (il browser è una facciata A GRUPPO: attivazione POI esecuzione)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, 'accedi al portale')
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, 'accedi al portale')
  callTool('fill_credential', fillPosta, 'accedi al portale')
  callTool('fill_credential', fillPosta, 'accedi al portale')
  sayText('Ho compilato il login del portale.', 'accedi al portale')
  // pulizia: nessuna card pendente dal turno prima (i loro Consenti confonderebbero)
  for (let i = 0; i < 3 && await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`); i++) {
    await clickText('Consenti', { exact: true })
    await sleep(1200)
  }
  await sendMessage('accedi al portale della posta per me')
  await waitDom(`document.body.textContent.includes('spa.example') || document.body.textContent.includes('Portale Posta')`, 30_000, 500)
  const fillCardOk = await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`, 30_000)
  check('Concessioni: la card del fill compare', fillCardOk)
  await clickText('Altre opzioni', { exact: false })
  await sleep(600)
  const sempreOk = await waitDom(`[...document.querySelectorAll('button, [role="menuitem"]')].some((b) => b.textContent.includes('Sempre per questo sito'))`, 10_000)
  check('Concessioni: «Sempre per questo sito» compare nel menu della card', sempreOk)
  await clickText('Sempre per questo sito')
  await sleep(2000)
  await openSettings()
  await waitDom(`[role="dialog"]`)
  await clickText('Cassaforte', { exact: true })
  check('Concessioni: la sotto-scheda si apre', await clickText('Concessioni', { exact: true }))
  check('Concessioni: la concessione compare nella Cassaforte', (await rpc('fillGrants()')).length > 0)
  check('Concessioni: «revoca» la toglie', await clickText('revoca', { exact: true }) && await (async () => {
    for (let i = 0; i < 20; i++) {
      if ((await rpc('fillGrants()')).length === 0) return true
      await sleep(400)
    }
    return false
  })())
  await shot('cassaforte.png')
  } // fine del blocco NON-FAST (Cassaforte+segreto+routine+concessioni)
  // in FAST il computer dei bot torna «box» QUI (il ritorno a box della
  // sezione segreto/routine sta nel blocco saltato): senza box la scheda
  // Schermo non esiste (BX1)
  if (FAST) await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('box')})`).catch(() => undefined)


  // =========== U3: la PiP — Homun resta visibile, barra sempre visibile, Riporta ===========
  startRfb() // il server RFB, per la finestra PiP + scheda Computer (U3→U9)
  try {
    // la scheda Computer del pannello: dialog chiuso e pannello aperto
    await closeDialog()
    await clickText('Mostra il pannello del bot')
    await sleep(500)
    await clickText('Stacca', { exact: true })
    await sleep(800)
    const detachOk = true // «Stacca» della card Computer: pipOpen già chiamato
    check('U3: «Stacca» apre la PiP', detachOk)
    const pipPage = await waitForPage('#/pip/')
    const pipState1 = await rpc('pipState()')
    check('U3: dopo «Stacca» la finestra PRINCIPALE è ancora visibile (pip:state.mainVisible)', pipState1?.mainVisible === true && pipState1?.open === true, JSON.stringify(pipState1))
    // la barra della PiP è visibile SENZA hover
    const barVisible = await (async () => {
      const r = await withTimeout(pipPage.cdp.send('Runtime.evaluate', {
        expression: `(() => { const b = document.querySelector('[data-testid="pip-bar"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(b).display, opacity: getComputedStyle(b).opacity } })()`,
        returnByValue: true
      }), 15_000, 'pip bar')
      return r?.result?.value
    })()
    check('U3: la barra della PiP è SEMPRE visibile (senza hover)', barVisible && barVisible.h >= 20 && Number(barVisible.opacity) === 1, JSON.stringify(barVisible))
    await sleep(3000)
    const pipConnect = await (async () => {
      const r = await withTimeout(pipPage.cdp.send('Runtime.evaluate', {
        expression: `(() => ({ canvas: !!document.querySelector('canvas'), testo: document.body.textContent.slice(0, 80) }))()`,
        returnByValue: true
      }), 10_000, 'pip canvas').catch(() => null)
      return r?.result?.value
    })()
    // «Riporta in Homun» chiude la PiP e la scheda Computer mostra lo schermo
    const back = await (async () => {
      const r = await withTimeout(pipPage.cdp.send('Runtime.evaluate', {
        expression: `(() => { const b = document.querySelector('[data-testid="pip-bring-back"]'); if (!b) return false; b.click(); return true })()`,
        returnByValue: true
      }), 15_000, 'pip bring back')
      return r?.result?.value
    })()
    check('U3: «Riporta in Homun» si clicca', back === true)
    await sleep(1500)
    const pipState2 = await rpc('pipState()')
    check('U3: la PiP è CHIUSA e la principale resta visibile', pipState2?.open === false && pipState2?.mainVisible === true, JSON.stringify(pipState2))
    // montaggio DETERMINISTICO della scheda Computer: foglio → card → chiudi
    await closeDialog()
    await clickText('Mostra il pannello del bot').catch(() => undefined)
    await sleep(400)
    await clickText('Impostazioni del bot', { exact: true })
    await sleep(400)
    await clickTestid('bot-computer-card')
    await sleep(500)
    await clickText('Chiudi', { exact: true }).catch(() => undefined)
    await sleep(500)
    await clickText('Schermo', { exact: true }).catch(() => undefined)
    await sleep(600)
    check('U3: la scheda Computer mostra DI NUOVO la sezione Schermo (niente posto-PiP)', await waitDom(`!document.body.textContent.includes('finestra a parte') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Stacca')`, 10_000))
    await shot('computer-riportata.png')
  } catch (e3) {
    check('U3: il blocco della PiP gira senza eccezioni', false, String(e3?.message ?? e3).slice(0, 200))
  }

  // =========== U9: finestra a 600 px — «Ho finito» dentro la vista ===========
  // Dopo «Riporta in Homun» la scheda Computer è montata col suo BotScreen
  // (SV5 riapre la vista da sola): è il posto dove «Prendi il controllo»
  // esiste. Finestra a 600 px e «Ho finito» deve stare DENTRO la vista.
  try {
    // la scheda Schermo interna, poi «Apri» se lo schermo non è partito
    await clickText('Schermo', { exact: true }).catch(() => undefined)
    for (let i = 0; i < (process.env.SANDBOT_PROBE_FAST === '1' ? 3 : 25); i++) {
      if (await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Prendi il controllo' || b.textContent.trim() === 'Ferma e prendi il controllo')`).catch(() => false)) break
      await clickText('Apri', { exact: true }).catch(() => undefined)
      await clickText('Riprova', { exact: true }).catch(() => undefined)
      await sleep(1200)
    }
    const prendiOk = await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Prendi il controllo' || b.textContent.trim() === 'Ferma e prendi il controllo')`, 15_000)
    await setViewport(1280, 600)
    check("U9: «Prendi il controllo» c'è dopo il ritorno dalla PiP", prendiOk)
    if (await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Ferma e prendi il controllo')`).catch(() => false)) {
      await clickText('Ferma e prendi il controllo', { exact: true })
      await sleep(1500)
    }
    await clickText('Prendi il controllo', { exact: true })
    const inView = await waitDom(`(() => { const b = document.querySelector('[data-testid="bot-screen-done"]'); if (!b) return false; const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })()`, 20_000, 500)
    const rect = await pageEval(`return (() => { const b = document.querySelector('[data-testid="bot-screen-done"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight } })()`)
    check('U9: a 600 px «Ho finito» è DENTRO la vista (getBoundingClientRect)', inView, JSON.stringify(rect))
    await shot('ho-finito-600px.png')
    await setViewport(1280, 860)

    // =========== K3: «Stacca → Riporta in Homun → Prendi il controllo» × 20 ===========
    // Il difetto intermittente visto nella verifica (la scheda Schermo che
    // dice «La connessione allo schermo si è chiusa» senza «Prendi il
    // controllo»): qui la sequenza si ripete 20 volte DI FILA nella stessa
    // corsa, si contano le cadute e a ogni caduta si stampa la TRACCIA di
    // sola prova del ponte (SANDBOT_TEST_SCREEN_TRACE): apertura, modalità
    // (view/peek/noLaunch/control), CHI chiude e quando.
    // SANDBOT_PROBE_FORCE_KO=1 (di sola prova, per K4): fa fallire un
    // controllo e INTERROMPE la corsa qui — app, RFB e schermo tutti APERTI,
    // come la corsa rossa della verifica: la pulizia deve comunque lasciare
    // 0 cartelle.
    if (process.env.SANDBOT_PROBE_FORCE_KO === '1') {
      check('KO forzato di sola prova (SANDBOT_PROBE_FORCE_KO=1): questa corsa deve comunque lasciare 0 cartelle', false, 'il KO è voluto')
      throw new Error('KO forzato di sola prova: ci si ferma qui con tutto APERTO, la pulizia parte lo stesso')
    }
    const K3_ROUNDS = Number(process.env.SANDBOT_PROBE_K3_ROUNDS ?? 20)
    const traceFile = join(DATA, 'screen-trace.jsonl')
    const readTrace = () => {
      try { return readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
    }
    const printTrace = (since = 0) => {
      for (const l of readTrace().filter((l) => Number(l.t ?? 0) >= since)) log('traccia schermo:', JSON.stringify(l))
    }
    /** il canarino del server RFB finto: handshake GREZZO dal processo della
     *  sonda (versione → tipi di sicurezza [1,1] → scelta → SecurityResult →
     *  ServerInit) — dice se il VERO colpevole è il server finto quando le
     *  viste dell'app cadono. */
    const rfbCanary = async (sockName) => {
      const { connect } = await import('node:net')
      return await new Promise((resolve) => {
        const t0 = Date.now()
        let stage = 1
        const done = (r) => { try { sock.destroy() } catch { /* via */ }; resolve(r) }
        const timer = setTimeout(() => done(`timeout-${stage} (${Date.now() - t0} ms)`), 2500)
        const sock = connect(join(SOCK, sockName), () => {})
        sock.on('data', (d) => {
          if (stage === 1 && d.includes(0x0a)) {
            stage = 2
            sock.write('RFB 003.008\n') // la versione del client
            return
          }
          if (stage === 2 && d.length >= 2 && d[0] === 1) {
            stage = 3
            sock.write(Buffer.from([1])) // scelgo None
            return
          }
          if (stage === 3 && d.length >= 2) {
            sock.write(Buffer.from([1])) // ClientInit
            stage = 4
            return
          }
          if (stage === 4 && d.length >= 24) {
            clearTimeout(timer)
            done(`ok (${Date.now() - t0} ms)`)
          }
        })
        sock.on('error', (e) => { clearTimeout(timer); done(`errore ${e.code}`) })
      })
    }
    const printAppLog = () => {
      log('--- ultime 60 righe del log app/daemon alla caduta: ---')
      for (const line of appLog.split('\n').slice(-60)) log('app:', line.slice(0, 220))
    }
    const prendiVisible = () => pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Prendi il controllo' || b.textContent.trim() === 'Ferma e prendi il controllo')`).catch(() => false)
    /** la finestra PiP di QUESTO giro: il target #/pip/ del BOT corrente (una
     *  finestra in chiusura può restare in lista un attimo e rubare il posto:
     *  ci si vincola all'id del bot e si RITROVA a ogni tentativo del clic). */
    const waitForPip = async (timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const list = await httpJson('/json/list')
          const t = list.find((x) => x.type === 'page' && (x.url ?? '').includes(`#/pip/${bot.id}`))
          if (t) return { cdp: await openCdp(t.webSocketDebuggerUrl), url: t.url }
        } catch { /* il debugger non è ancora su */ }
        await sleep(200)
      }
      return null
    }
    log('canarino RFB all\'inizio dei giri: view =', await rfbCanary('vnc-view.sock'), ' control =', await rfbCanary('vnc-control.sock'))
    const falls = []
    for (let round = 1; round <= K3_ROUNDS; round++) {
      const startedAt = Date.now()
      let why = ''
      // recupero da uno stato rotto di un giro precedente (Riprova/Apri non
      // fanno niente se non ci sono); una PiP rimasta APERTA da una caduta si
      // chiude qui (chiamata di igiene, il giro la riaprirà col gesto vero);
      // un CONTROLLO rimasto attivo (il blocco U9 lo lascia: la PiP allora si
      // autochiude e il giro cadrebbe) si chiude col suo «Ho finito»
      if (((await rpc('pipState()').catch(() => null))?.open) === true) {
        await rpc('pipClose()').catch(() => undefined)
        for (let i = 0; i < 20 && ((await rpc('pipState()').catch(() => null))?.open) === true; i++) await sleep(250)
      }
      if (await pageEval(`return !!document.querySelector('[data-testid="bot-screen-done"]')`).catch(() => false)) {
        await clickText('Ho finito', { exact: true, timeoutMs: 4000 }).catch(() => undefined)
        await sleep(900)
      }
      await clickText('Riprova', { exact: true, timeoutMs: 1200 }).catch(() => undefined)
      await clickText('Apri', { exact: true, timeoutMs: 1200 }).catch(() => undefined)
      // se la scheda Computer non c'è (pannello chiuso o altra vista), si
      // rimonta DETERMINISTICAMENTE: pannello → card Computer → scheda Schermo
      if (!(await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Stacca')`).catch(() => false))) {
        await pressEscape().catch(() => undefined)
        await closeDialog().catch(() => undefined)
        await clickText('Mostra il pannello del bot', { timeoutMs: 3000 }).catch(() => undefined)
        await sleep(300)
        await clickTestid('bot-computer-card').catch(() => undefined)
        await sleep(400)
        await clickText('Schermo', { exact: true, timeoutMs: 3000 }).catch(() => undefined)
        await sleep(400)
      }
      let ok = true
      // — Stacca: la PiP si apre, la vista grande si scollega —
      const detached = await clickText('Stacca', { exact: true, timeoutMs: 8000 })
      let pipPage = null
      if (detached) pipPage = await waitForPip()
      if (!detached || !pipPage) {
        ok = false
        why = detached ? 'la finestra PiP non è comparsa' : '«Stacca» non c\'è'
      }
      // — Riporta in Homun: il bottone della barra della PiP (si aspetta che il
      //   bottone ESISTA nella finestra, poi si clicca) —
      if (ok) {
        // il clic può perdere la sua RISPOSTA: la finestra si chiude SUBITO
        // dopo («Riporta in Homun» è un gesto solo) e il socket CDP muore con
        // lei — la evaluate non torna e sembrerebbe un clic mancato. La VERITÀ
        // è lo stato della PiP, che si rilegge dopo OGNI tentativo (e il
        // target si RITROVA: una finestra appena nata o morente non è affare
        // del giro)
        let closed = false
        for (let i = 0; i < 24 && !closed; i++) {
          const fresh = await waitForPip(1_500)
          if (fresh) pipPage = fresh
          await withTimeout(pipPage.cdp.send('Runtime.evaluate', {
            expression: `(() => { const b = document.querySelector('[data-testid="pip-bring-back"]'); if (!b) return false; b.click(); return true })()`,
            returnByValue: true
          }), 6_000, 'pip bring back').catch(() => undefined)
          for (let j = 0; j < 10 && !closed; j++) {
            closed = ((await rpc('pipState()').catch(() => null))?.open) === false
            if (!closed) await sleep(250)
          }
        }
        if (!closed) {
          ok = false
          why = 'la PiP non risulta chiusa dopo «Riporta in Homun»'
          // che cosa c'era davvero nella finestra PiP? (diagnosi della caduta)
          await withTimeout(pipPage.cdp.send('Runtime.evaluate', {
            expression: `JSON.stringify({ url: location.hash, testid: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).slice(0, 6), testo: document.body.textContent.trim().slice(0, 90) })`,
            returnByValue: true
          }), 5_000, 'pip diag').then((r) => { if (r?.result?.value) log('giro ' + round + ' — finestra PiP:', r.result.value) }).catch(() => undefined)
        }
      }
      // — Prendi il controllo: DEVE comparire nella finestra principale —
      if (ok && !(await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Prendi il controllo' || b.textContent.trim() === 'Ferma e prendi il controllo')`, 20_000, 400))) {
        ok = false
        why = '«Prendi il controllo» non è comparso dopo il ritorno dalla PiP'
      }
      // — controllo preso, poi «Ho finito» per tornare in vista —
      if (ok) {
        if (await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Ferma e prendi il controllo')`).catch(() => false)) {
          await clickText('Ferma e prendi il controllo', { exact: true })
        } else {
          await clickText('Prendi il controllo', { exact: true })
        }
        if (!(await waitDom(`!!document.querySelector('[data-testid="bot-screen-done"]')`, 20_000, 400))) {
          ok = false
          why = 'il controllo non è arrivato («Ho finito» non c\'è)'
        } else {
          await clickText('Ho finito', { exact: true })
          if (!(await waitDom(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Prendi il controllo' || b.textContent.trim() === 'Ferma e prendi il controllo')`, 20_000, 400))) {
            ok = false
            why = 'non è tornato in vista dopo «Ho finito»'
          }
        }
      }
      if (!ok) {
        falls.push(round)
        log(`giro ${round}/${K3_ROUNDS}: CADUTO — ${why} — canarino view: ${await rfbCanary('vnc-view.sock')}`)
        printTrace(startedAt - 2000)
        if (falls.length === 1) printAppLog()
      } else {
        log(`giro ${round}/${K3_ROUNDS}: verde`)
      }
    }
    check(`K3: ${K3_ROUNDS} giri di fila «Stacca → Riporta in Homun → Prendi il controllo» senza cadute`, falls.length === 0,
      falls.length ? `caduti i giri ${falls.join(', ')} (${falls.length}/${K3_ROUNDS})` : `${K3_ROUNDS}/${K3_ROUNDS} verdi`)
    if (falls.length) printTrace()
    // l'errore visibile all'utente non dev'essere in nessun giro
    check('K3: mai «La connessione allo schermo si è chiusa» in vista', !(await pageEval(`return document.body.textContent.includes('La connessione allo schermo si è chiusa')`).catch(() => false)))
  } catch (e9) {
    check('U9: il blocco del controllo gira senza eccezioni', false, String(e9?.message ?? e9).slice(0, 200))
  } finally {
    stopRfb()
  }

  // =========== catture: Impostazioni › Modelli e guida, nei DUE temi ===========
  {
    const themeOf = () => pageEval(`return document.documentElement.classList.contains('dark')`)
    await clickTestid('account-menu-trigger')
    await clickText('Impostazioni', { exact: true })
    await waitDom(`[role="dialog"]`)
    await clickText('Modelli', { exact: true })
    await waitDom(`document.body.textContent.includes('Modelli')`, 8000)
    await sleep(800)
    await shot('modelli-chiaro.png')
    // tema scuro dal menu account (voce Tema › Scuro)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await sleep(900)
    check('Tema: il tema SCURO è attivo per la cattura', (await themeOf()) === true)
    await clickTestid('account-menu-trigger')
    await clickText('Impostazioni', { exact: true })
    await waitDom(`[role="dialog"]`)
    await clickText('Modelli', { exact: true })
    await sleep(900)
    await shot('modelli-scuro.png')
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }



  // =========== il VALORE non è da nessuna parte (transcript, entry, log, DB) ===========
  if (!FAST) {
    // nel renderer (transcript vivo)
    const inDom = await pageEval(`return document.body.textContent.includes(${JSON.stringify(SECRET_VALUE)})`)
    // nei file dei dati temporanei (DB, WAL, log del daemon) e nel log dell'app
    const files = []
    const walk = (d) => {
      let names = []
      try { names = readdirSync(d) } catch { return }
      for (const name of names) {
        const p = join(d, name)
        let st = null
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(DATA)
    const offenders = []
    for (const f of files) {
      if (f === SHELL_LOG || f === SECRET_ENV_LOG) continue // l'host finto è l'unico posto dove il valore ESISTE
      try {
        if (readFileSync(f).includes(SECRET_VALUE)) offenders.push(f)
      } catch { /* binario illeggibile */ }
    }
    if (appLog.includes(SECRET_VALUE)) offenders.push('(log app)')
    check('Segreto: il valore NON compare in NESSUN file dei dati (DB, WAL, log) né nel log del daemon', offenders.length === 0, offenders.join(', ').slice(0, 200))
    check('Segreto: il valore NON compare nel transcript (DOM vivo)', !inDom)
  }
} catch (e) {
  check('la sonda è arrivata in fondo senza eccezioni', false, String(e?.message ?? e).slice(0, 300))
} finally {
  // ---- chiusura (K4): PRIMA si aspetta che i processi escano DAVVERO (pid ----
  // ---- assenti, col tetto), POI rmSync, e si CONTROLLA che la cartella non  ----
  // ---- esista più (un secondo tentativo, poi l'errore chiaro) — la pausa    ----
  // ---- fissa di 1,2 s lasciava cartelle quando qualcosa riscriveva dopo     ----
  stopApp()
  rfbView?.kill('SIGTERM')
  rfbControl?.kill('SIGTERM')
  providerServer.close()
  const { left, countBefore, countAfter } = await cleanupProbeRun({
    pids: [app?.pid, rfbView?.pid, rfbControl?.pid],
    prefix: PREFIX,
    dirs: [DATA],
    log
  })
  check(`K4: pulizia vera — cartelle ${PREFIX}-*: ${countBefore} prima, ${countAfter} dopo (0 rimaste)`, left.length === 0, left.join(', '))
}

log(`esito corsa ${run}: ${results.length - failed}/${results.length} controlli verdi`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log(`  KO ${r.name} — ${r.detail}`)
  process.exit(1)
}
process.exit(0)
