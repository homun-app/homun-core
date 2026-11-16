#!/usr/bin/env node
// Sonda Electron della fase «schermo vivo» (SV1–SV8). L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, NESSUN container/Docker, rete
// solo su 127.0.0.1. Lo schermo è un SERVER RFB MINIMO scritto qui (handshake
// RFB 003.008, nessuna sicurezza, ServerInit 1280×800, poi FramebufferUpdate
// RAW con un riquadro colorato al centro che cambia colore ogni secondo) dietro
// il flag di test SANDBOT_TEST_FAKE_SCREEN_SOCKET; il browser acceso è quello
// finto delle sonde di fase pagine/use-app (SANDBOT_TEST_FAKE_BROWSER_MCP).
// Controlli (SV6):
//   1. con il browser SPENTO la card mostra il riquadro di oggi e NESSUNA
//      screen:open lo avvia (nessuna connessione al socket);
//   2. con il browser acceso l'anteprima entro pochi secondi ha pixel NON
//      NERI del colore del server (lettura del canvas via CDP) e la zona è
//      16:10;
//   3. il colore CAMBIA nell'anteprima quando cambia nel server;
//   4. la finestra NASCOSTA fa cadere la connessione al socket;
//   5. la connessione peek NON tiene vivo il browser (screen:status.held
//      falso);
//   6. «Stacca» apre una seconda finestra con alwaysOnTop VERO (letto dal
//      main via RPC pip:state), l'anteprima della card si scollega e la PiP
//      mostra il colore;
//   7. «Chiudi» nella PiP la chiude e l'anteprima torna;
//   8. il browser CHIUSO mostra «Ultima immagine» (il finto MCP esce quando
//      compare il file SANDBOT_TEST_FAKE_BROWSER_MCP_EXIT_FILE);
//   9. MAI più di una connessione peek per bot (picco sorvegliato).
// Misura anche i byte al secondo del ponte con lo schermo FERMO e CHE CAMBIA
// (per il REPORT di SV3). Catture CDP in docs/catture/schermo-vivo/. TRE
// corse (PROBE_RUNS=1 per il debug), 0 daemon dopo ognuna (probe-daemons).
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-schermo-vivo'
const SHOTS = join(ROOT, 'docs', 'catture', 'schermo-vivo')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log('[sonda]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Nessuna await può restare appesa per sempre: a timeout si rifiuta. */
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${what} (${ms} ms)`)), ms))])

// ---- il server RFB FINTO (il desktop del bot) ----
//
// GIRA IN UN PROCESSO FIGLIO (la sonda si ri-esegue con --rfb-server): il
// loop del figlio ha SOLO il server, così nessuna attività della sonda (CDP,
// fetch, WebSocket) può ritardare gli accept — e la connessione del ponte si
// vede sempre. Protocollo JSON a righe: il figlio emette eventi, il padre
// comanda ('stats', 'mode', 'peak-start', 'peak-stop').

/** Un framebuffer RAW BGRA (little-endian, shift r16/g8/b0, 32 bpp). */
const W = 1280
const H = 800
/** Il riquadro che cambia colore: al centro, 320×200. */
const RECT = { x: 480, y: 300, w: 320, h: 200 }
const PALETTE = [
  [255, 64, 64],
  [64, 220, 80],
  [80, 120, 255],
  [255, 220, 64],
  [255, 96, 224],
  [64, 230, 230]
]
const BACKGROUND = [24, 24, 28]

/** Il server RFB minimo: handshake 003.008 senza sicurezza, ServerInit
 * 1280×800, poi FramebufferUpdate RAW. In 'changing' il riquadro cambia
 * colore ogni secondo; in 'frozen' niente dopo il primo fotogramma. */
function rfbChildMain(sockPath) {
  const createServer = createNetServer
  const stats = { connections: 0, totalConnections: 0, bytesToClient: 0, bytesFromClient: 0 }
  const state = { mode: 'changing', colorIndex: 0 }
  let peak = 0
  let peakOn = false
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  const currentColor = () => PALETTE[state.colorIndex % PALETTE.length]
  const rectPixels = (rgb, w, h) => {
    const b = Buffer.alloc(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      b[i * 4] = rgb[2]
      b[i * 4 + 1] = rgb[1]
      b[i * 4 + 2] = rgb[0]
    }
    return b
  }
  const header = (rect) => {
    const b = Buffer.alloc(12)
    b.writeUInt16BE(rect.x, 0)
    b.writeUInt16BE(rect.y, 2)
    b.writeUInt16BE(rect.w, 4)
    b.writeUInt16BE(rect.h, 6)
    b.writeInt32BE(0, 8) // encoding 0 = RAW
    return b
  }
  const updateMessage = (rects) => {
    const head = Buffer.alloc(4)
    head[0] = 0
    head[1] = 0
    head.writeUInt16BE(rects.length, 2)
    return Buffer.concat([head, ...rects.map((r) => Buffer.concat([header(r), r.pixels]))])
  }
  const sockets = new Set()
  const server = createServer((sock) => {
    stats.connections++
    stats.totalConnections++
    if (peakOn) peak = Math.max(peak, stats.connections)
    sockets.add(sock)
    send({ t: 'conn', connections: stats.connections, total: stats.totalConnections })
    // RFB: il SERVER parla per primo — la versione parte subito, il client
    // (noVNC) risponde con la sua DOPO averla ricevuta
    sock.write(Buffer.from('RFB 003.008\n'))
    sock.on('close', () => {
      stats.connections--
      sockets.delete(sock)
      send({ t: 'close', connections: stats.connections })
    })
    sock.on('error', () => { /* la chiusura forzata va bene */ })
    const write = (b) => {
      stats.bytesToClient += b.length
      sock.write(b)
    }
    const sendFullFrame = () => {
      const bg = rectPixels(BACKGROUND, W, H)
      const { x, y, w, h } = RECT
      const colored = rectPixels(currentColor(), w, h)
      for (let r = 0; r < h; r++) colored.copy(bg, (y + r) * W * 4 + x * 4, 0, w * 4)
      write(updateMessage([{ x: 0, y: 0, w: W, h: H, pixels: bg }]))
    }
    let buf = Buffer.alloc(0)
    let stage = 'version'
    sock.on('data', (d) => {
      stats.bytesFromClient += d.length
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (stage === 'version') {
          const i = buf.indexOf(0x0a)
          if (i === -1) return
          buf = buf.subarray(i + 1)
          stage = 'types'
          write(Buffer.from([1, 1])) // un tipo di sicurezza: None
          continue
        }
        if (stage === 'types') {
          if (buf.length < 1) return
          buf = buf.subarray(1)
          stage = 'client-init'
          write(Buffer.from([0, 0, 0, 0])) // SecurityResult: OK
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
          init[16] = 0
          init.writeUInt32BE(5, 20)
          init.write('sonda', 24, 'latin1')
          write(init)
          sendFullFrame()
          continue
        }
        // 'ready': i messaggi del client si LEGGONO e si ignorano (nessun box
        // vero esiste: l'input dell'anteprima non arriva da nessuna parte)
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
          if (buf.length < 8) return
          const n = Math.max(0, buf.readInt32BE(4))
          if (buf.length < 8 + n) return
          buf = buf.subarray(8 + n)
          continue
        }
        const len = { 0: 20, 3: 10, 4: 8, 5: 6 }[type]
        if (len === undefined) {
          buf = buf.subarray(1)
          continue
        }
        if (buf.length < len) return
        buf = buf.subarray(len)
      }
    })
  })
  const ticker = setInterval(() => {
    if (state.mode !== 'changing') return
    state.colorIndex++
    for (const s of sockets) {
      const { x, y, w, h } = RECT
      const msg = updateMessage([{ x, y, w, h, pixels: rectPixels(currentColor(), w, h) }])
      stats.bytesToClient += msg.length
      s.write(msg)
    }
  }, 1_000)
  ticker.unref?.()
  // i comandi del padre, una riga JSON per volta
  let line = ''
  process.stdin.on('data', (d) => {
    line += d.toString()
    let i
    while ((i = line.indexOf('\n')) !== -1) {
      const cmd = JSON.parse(line.slice(0, i))
      line = line.slice(i + 1)
      if (cmd.c === 'stats') send({ t: 'stats', ...stats, colorIndex: state.colorIndex })
      else if (cmd.c === 'color') send({ t: 'color', color: currentColor(), colorIndex: state.colorIndex })
      else if (cmd.c === 'mode') state.mode = cmd.mode
      else if (cmd.c === 'peak-start') { peakOn = true; peak = Math.max(peak, stats.connections) }
      else if (cmd.c === 'peak-stop') send({ t: 'peak', max: peak })
    }
  })
  server.listen(sockPath, () => send({ t: 'listening', path: sockPath }))
}

/** Il lato PADRE del server RFB: un figlio per socket, stats a richiesta. */
function fakeRfbServer(sockPath) {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--rfb-server', sockPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let dead = false
  child.stderr.on('data', (d) => { dead = true; console.log('[rfb-server] errore del figlio:', d.toString().slice(0, 200)) })
  const events = []
  let waiters = []
  const pending = new Map()
  let sawListening = false
  child.stdout.on('data', (d) => {
    let s = d.toString()
    let i
    while ((i = s.indexOf('\n')) !== -1) {
      let ev
      try { ev = JSON.parse(s.slice(0, i)) } catch { s = s.slice(i + 1); continue }
      s = s.slice(i + 1)
      if (ev.t === 'listening') sawListening = true
      if (ev.t === 'stats' || ev.t === 'peak' || ev.t === 'color') {
        const w = pending.get(ev.t)
        if (w) { pending.delete(ev.t); w(ev) }
      } else events.push(ev)
      for (const fn of waiters.splice(0)) fn()
      waiters = []
    }
  })
  const send = (o) => { if (!dead) child.stdin.write(JSON.stringify(o) + '\n') }
  const ask = (t, timeoutMs = 8_000) =>
    new Promise((resolve, reject) => {
      pending.set(t, resolve)
      const tId = setTimeout(() => { pending.delete(t); reject(new Error('rfb-server muto (' + t + ')')) }, timeoutMs)
      pending.set(t, (v) => { clearTimeout(tId); resolve(v) })
      send({ c: t === 'peak' ? 'peak-stop' : t })
    })
  return {
    ready: () => new Promise((resolve, reject) => {
      // 'listening' può essere già arrivato: il flag si riempie nel data handler
      const t = setInterval(() => { if (sawListening) { clearInterval(t); resolve() } }, 50)
      setTimeout(() => { clearInterval(t); reject(new Error('rfb-server non parte su ' + sockPath)) }, 10_000).unref?.()
    }),
    stats: async () => {
      const s = await ask('stats')
      return {
        connections: s.connections,
        totalConnections: s.totalConnections,
        bytesToClient: s.bytesToClient,
        bytesFromClient: s.bytesFromClient
      }
    },
    colorIndex: async () => {
      // l'indice del colore corrente, chiesto al figlio (la tavolozza è QUI)
      const s = await ask('color')
      return s.colorIndex
    },
    setMode: (mode) => send({ c: 'mode', mode }),
    peakStart: () => send({ c: 'peak-start' }),
    peakStop: async () => (await ask('peak')).max,
    close: () => new Promise((r) => { child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); r() }, 1_500) })
  }
}

// modalità server del figlio: SOLO il server, nient'altro
if (process.argv[2] === '--rfb-server') {
  rfbChildMain(process.argv[3])
} else {
// ---- la corsa ----
// ---- la corsa ----

async function runOnce(run) {
  const TMP = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
  const DATA = join(TMP, 'data')
  mkdirSync(DATA, { recursive: true })
  const DAEMON_DATA = join(DATA, 'data') // l'app usa DATA come userData: i file del daemon stanno in DATA/data
  const SOCK = mkdtempSync(join(TMP_BASE, `${PREFIX}-sock-`))
  const EXIT_MCP = join(TMP, 'exit-mcp') // il file che spegne il finto browser
  let failures = 0
  const check = (id, ok, note = '') => {
    if (!ok) failures++
    console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
  }
  const noteBytes = []

  // i DUE socket del desktop (vista e controllo, come li aspetta il daemon)
  const rfbView = fakeRfbServer(join(SOCK, 'vnc-view.sock'))
  const rfbControl = fakeRfbServer(join(SOCK, 'vnc-control.sock'))
  await rfbView.ready()
  await rfbControl.ready()

  // ---- il provider finto (serve solo al setup del bot: qui nessun turno) ----
  const providerServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
  const providerPort = providerServer.address().port

  // ---- l'app Electron (build di sviluppo) con dati temporanei ----
  const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  const DEBUG_PORT = 9367 + run
  let appLog = ''
  // --lang=it: la lingua della UI è deterministica (a volte il sistema
  // risolve «system» in inglese e i testid dei bottoni cambiano)
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      // il PATH VERO: il daemon spawna `node` per il finto MCP del browser
      // (con il PATH spogliato spawn node ENOENT); nessuna rete comunque
      PATH: process.env.PATH,
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
      SANDBOT_TEST_FAKE_BROWSER_MCP: join(ROOT, 'scripts', 'fake-browser-mcp.mjs'),
      SANDBOT_TEST_FAKE_BROWSER_MCP_EXIT_FILE: EXIT_MCP,
      SANDBOT_TEST_FAKE_SCREEN_SOCKET: SOCK
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }

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
        const target = list.find((t) => t.type === 'page' && t.url.includes(urlIncludes))
        if (target) return { cdp: await openCdp(target.webSocketDebuggerUrl), url: target.url }
      } catch { /* il debugger non è ancora su */ }
      await sleep(200)
    }
    throw new Error(`nessuna pagina CDP per ${urlIncludes}: log app:\n` + appLog.slice(-1500))
  }
  const main = await waitForPage('') // la prima pagina: la finestra principale
  const page = main.cdp
  log(`corsa ${run}: CDP collegato al renderer`)

  const pageEvalOf = (cdp) => async (expr) => {
    const r = await withTimeout(cdp.send('Runtime.evaluate', {
      expression: `((async () => { ${expr} })())`,
      awaitPromise: true,
      returnByValue: true
    }), 20_000, 'Runtime.evaluate')
    if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
    return r?.result?.value
  }
  const pageEval = pageEvalOf(page)
  const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
  const setWindowWidth = async (width, height = 860) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
    await sleep(700)
  }
  const settleForCapture = async (cdp) => {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await pageEvalOf(cdp)(`
      await new Promise((resolve) => {
        let n = 0
        const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }
        requestAnimationFrame(step)
      })
    `)
    await sleep(400)
  }
  const shot = async (name) => {
    await settleForCapture(page)
    const r = await page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
    log('cattura', name)
  }
  const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      // una evaluate lenta o una pagina occupata non uccide l'attesa: si riprova
      try {
        if (await pageEval(`return !!(${exprTrue})`)) return true
      } catch { /* pagina occupata o in caricamento: si continua */ }
      if (Date.now() > deadline) return false
      await sleep(step)
    }
  }
  /** Il clic su un BOTTONE DEL PANNELLO col suo testo (le sotto-schede del
   * Computer non hanno testid): false se non c'è. */
  const clickPanelButton = async (label) => {
    // il bottone può non esserci ANCORA (le schede del Computer compaiono dopo
    // la lettura asincrona della modalità): si riprova per qualche secondo
    for (let i = 0; i < 20; i++) {
      const ok = await pageEval(`
        const panel = document.querySelector('[data-testid="bot-panel"]')
        const b = [...(panel?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)})
        if (!b) return false
        b.click()
        return true
      `)
      if (ok) return true
      await sleep(250)
    }
    return false
  }

  /** Il clic su un testid: FALSE se l'elemento manca (corse rosse incluse). */
  const clickTestid = (testid) => pageEval(`
    const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    // il root della card è un div role=button: si clicca QUELLO, non un
    // bottone annidato (il «Stacca» dentro la card!)
    const b = el.matches('button, [role="button"]') ? el : el.querySelector('button')
    ;(b ?? el).click()
    return true
  `)
  /** Il colore (rgb) del pixel CENTRALE del canvas noVNC dentro un contenitore. */
  const centerPixelOf = (containerExpr) => pageEval(`
    const box = ${containerExpr}
    const canvas = box?.querySelector('canvas')
    if (!canvas) return null
    const ctx = canvas.getContext('2d')
    const x = Math.floor(canvas.width / 2), y = Math.floor(canvas.height / 2)
    const d = ctx.getImageData(x, y, 1, 1).data
    return [d[0], d[1], d[2]]
  `)
  const colorNear = (pixel, rgb, tol = 64) =>
    Array.isArray(pixel) && Math.abs(pixel[0] - rgb[0]) <= tol && Math.abs(pixel[1] - rgb[1]) <= tol && Math.abs(pixel[2] - rgb[2]) <= tol
  /** Il pixel è UN colore del server (non nero, non griglia)? */
  const pixelIsServerColor = (pixel) =>
    Array.isArray(pixel) && pixel.some((v) => v > 40) && PALETTE.some((c) => colorNear(pixel, c))
  /** Il colore del server PRIMA e DOPO il campionamento (può girare tra i due). */
  /** Il colore del server adesso (tavolozza del figlio, indice chiesto). */
  const serverColor = async () => PALETTE[(await rfbView.colorIndex()) % PALETTE.length] ?? PALETTE[0]
  const samplePixelOf = async (containerExpr) => {
    const pixel = await centerPixelOf(containerExpr)
    return { pixel, match: pixelIsServerColor(pixel) }
  }
  const waitConns = async (n, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await rfbView.stats()).connections === n) return true
      await sleep(250)
    }
    return false
  }

  try {
    if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile dopo 40s')
    }

    // ---- la GUIDA del primo avvio, in fretta (come le sonde di prima) ----
    const click = (testid) => pageEval(`
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
      if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
      el.click()
      return 'cliccato'
    `)
    if (await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 20_000)) {
      for (let i = 0; i < 12 && !(await waitDom(`!!document.querySelector('form textarea')`, 2500)); i++) {
        if (await pageEval(`return !!document.querySelector('[data-testid="guide-approvals-ask"]')`)) {
          await click('guide-approvals-ask')
          await sleep(400)
        }
        const hasSkip = await pageEval(`return !!document.querySelector('[data-testid="guide-skip"]')`)
        const hasCont = await pageEval(`return !document.querySelector('[data-testid="guide-continue"]')?.disabled`)
        if (hasSkip) await click('guide-skip')
        else if (hasCont) await click('guide-continue')
        else await sleep(600)
      }
    }
    if (!(await waitDom(`!!document.querySelector('form textarea')`, 25_000))) {
      const body = await pageEval('return document.body.textContent.slice(0, 300)').catch(() => '')
      throw new Error('compositore non pronto. Body: ' + body)
    }

    // la scheda Schermo esiste solo in modalità box (sandbox.mode): si sceglie
    // con la RPC dei settings, MAI scrivendo nel DB (il controllo del pannello
    // è solo existsSync del socket docker, NESSUN comando docker parte)
    await rpc(`settingsSet('sandbox.mode', 'box')`)

    // ---- setup: provider finto (serve al bot, qui nessun turno) ----
    await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
    const agents0 = await rpc('listAgents()')
    const bot = agents0[0]
    if (!bot) throw new Error('nessun bot (onboarding?)')
    await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    await setWindowWidth(1440)
    // il pannello destro col bot attivo e la scheda Attività (la card «Computer»)
    if (!(await waitDom(`!!document.querySelector('[data-testid="bot-computer-card"]')`, 15_000))) throw new Error('card «Computer» non trovata')

    // ============ 1: browser SPENTO — il riquadro di oggi, nessun avvio ============
    {
      const status = await rpc(`screenStatus(${JSON.stringify(bot.id)})`)
      const thumb = await pageEval(`
        const t = document.querySelector('[data-testid="bot-computer-thumb"]')
        return { cera: !!t, canvas: !!t?.querySelector('canvas'), bars: t?.querySelectorAll('span span span').length ?? 0 }
      `)
      check('1a browser SPENTO: la card mostra il RIGUADRO di oggi (niente canvas)',
        status.browser === 'stopped' && thumb.cera && !thumb.canvas && thumb.bars >= 3,
        `browser=${status.browser} canvas=${thumb.canvas} bars=${thumb.bars}`)
      {
        const sv = await rfbView.stats()
        const sc = await rfbControl.stats()
        check('1b NESSUNA connessione al socket (nessuna screen:open partita)',
          sv.totalConnections === 0 && sc.totalConnections === 0,
          `vista=${sv.totalConnections} controllo=${sc.totalConnections}`)
      }
    }

    // ============ 2: il browser ACCESO — l'anteprima dal vivo, 16:10 ============
    // si accende dalla scheda Computer (screen:open NORMALE la avvia, lazy)
    await clickTestid('bot-computer-card')
    // il pannello Computer ricorda l'ULTIMA sotto-scheda: si apre quella del SCHERMO
    await clickPanelButton('Schermo')
    const panelHasScreen = await waitDom(`document.querySelector('[data-testid="bot-panel"]')?.textContent.includes('Schermo del bot')`, 20_000)
    if (!panelHasScreen) {
      const panelTxt = await pageEval(`return document.querySelector('[data-testid="bot-panel"]')?.textContent.slice(0, 300) ?? 'nessun pannello'`).catch(() => '?')
      const btns = await pageEval(`return [...document.querySelectorAll('[data-testid="bot-panel"] button')].map((b) => b.textContent.trim()).slice(0, 30)`).catch(() => [])
      check('2 la scheda Computer si apre', false, panelTxt + ' | bottoni: ' + JSON.stringify(btns))
    }
    // il browser parte (finto) e la vista GRANDE si collega
    let running = false
    for (let i = 0; i < 60 && !running; i++) {
      await sleep(500)
      running = (await rpc(`screenStatus(${JSON.stringify(bot.id)})`)).browser === 'running'
    }
    if (!running) {
      // debug: la RPC diretta dice cosa succede
      const direct = await pageEval(`return await window.sandbot.screenOpen(${JSON.stringify(bot.id)}, 'view').then((r) => 'url', (e) => 'ERRORE: ' + (e && e.message ? e.message : e))`)
      const panelTxt = await pageEval(`return document.querySelector('[data-testid="bot-panel"]')?.textContent.slice(0, 500) ?? 'nessun pannello'`).catch(() => '?')
      log('debug 2a: screenOpen diretto →', direct)
      log('debug 2a: pannello →', panelTxt)
    }
    check('2a il browser del bot si ACCENDE (finto, dalla scheda Computer)', running)
    const connsBig = await waitConns(1, 15_000)
    check('2b la vista grande è collegata al socket', connsBig, `conn=${(await rfbView.stats()).connections}`)
    // si torna alla scheda Attività: la vista grande si chiude, L'ANTEPRIMA si collega
    await clickTestid('bot-tab-activity') // la vista grande si smonta
    const t0 = Date.now()
    let canvasUp = await waitDom(`!!document.querySelector('[data-testid="bot-computer-thumb"] canvas')`, 4_000)
    if (!canvasUp) {
      // un secondo clic: a volte il primo non prende (rendering del pannello)
      await clickTestid('bot-tab-activity')
      canvasUp = await waitDom(`!!document.querySelector('[data-testid="bot-computer-thumb"] canvas')`, 6_000)
    }
    const elapsed = Date.now() - t0
    check('2c l\'anteprima ha il CANVAS entro pochi secondi dal ritorno in Attività', canvasUp, `${elapsed} ms`)
    const sample = await samplePixelOf(`document.querySelector('[data-testid="bot-computer-thumb"]')`)
    check('2d i pixel del canvas sono del COLORE del server (non neri)', sample.match, JSON.stringify(sample.pixel))
    const zone = await pageEval(`
      const t = document.querySelector('[data-testid="bot-computer-thumb"]')
      const r = t.getBoundingClientRect()
      return { w: r.width, h: r.height, ratio: r.width / r.height, style: t.getAttribute('style') ?? '' }
    `)
    check('2e la zona dell\'anteprima è 16:10 della larghezza della card',
      Math.abs(zone.ratio - 1.6) < 0.12 && /aspect-ratio:\s*16\s*\/\s*10/.test(zone.style),
      `${zone.w}×${zone.h} ratio=${zone.ratio.toFixed(2)}`)
    if (run === 1) await shot('01-card-anteprima-viva.png')

    // il picco di connessioni mentre c'è SOLO l'anteprima (controllo 9)
    rfbView.peakStart()

    // ============ 3: il colore CAMBIA ============
    {
      const first = await samplePixelOf(`document.querySelector('[data-testid="bot-computer-thumb"]')`)
      await sleep(2_600)
      const second = await samplePixelOf(`document.querySelector('[data-testid="bot-computer-thumb"]')`)
      const changed = first.pixel && second.pixel && JSON.stringify(first.pixel) !== JSON.stringify(second.pixel)
      check('3 il COLORE cambia nell\'anteprima quando cambia nel server', changed && second.match,
        `${JSON.stringify(first.pixel)} → ${JSON.stringify(second.pixel)}`)
    }

    // ============ 5: la peek NON tiene vivo il browser ============
    {
      const status = await rpc(`screenStatus(${JSON.stringify(bot.id)})`)
      check('5 la connessione peek NON tiene vivo il browser (held falso, browser acceso)',
        status.browser === 'running' && !status.held, `browser=${status.browser} held=${status.held}`)
    }

    // ============ 4: la finestra NASCOSTA scollega ============
    // Metodo (scritto nel REPORT): EMULAZIONE della visibilità dal CDP — si
    // sostituisce document.visibilityState e si spara visibilitychange, l'evento
    // VERO che ascolta l'anteprima (Page.setWebLifecycleState 'frozen' nasconde
    // sì, ma congela il JS: la disconnessione partirebbe solo allo scongelamento;
    // Browser.setWindowBounds per minimizzare NON è implementato da Electron).
    const setVis = (hidden) => pageEval(`
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => ${hidden ? "'hidden'" : "'visible'"}
      })
      document.dispatchEvent(new Event('visibilitychange'))
      return document.visibilityState
    `)
    await setVis(true)
    const connsDropped = await waitConns(0, 12_000)
    await setVis(false)
    await sleep(400)
    check('4a la finestra NASCOSTA fa cadere la connessione al socket', connsDropped,
      `conn-dopo-il-ripristino=${(await rfbView.stats()).connections}`)
    const reconnected = await waitDom(`!!document.querySelector('[data-testid="bot-computer-thumb"] canvas')`, 12_000) && await waitConns(1, 8_000)
    check('4b la finestra di nuovo visibile: l\'anteprima si RICOLLEGA', reconnected, `conn=${(await rfbView.stats()).connections}`)

    // ============ misure dei byte (SV3, per il REPORT) ============
    {
      // schermo FERMO: niente update dopo il fotogramma pieno
      rfbView.setMode('frozen')
      const b0 = (await rfbView.stats()).bytesToClient
      const in0 = (await rfbView.stats()).bytesFromClient
      await sleep(4_000)
      const stillBps = ((await rfbView.stats()).bytesToClient - b0) / 4
      const stillIn = ((await rfbView.stats()).bytesFromClient - in0) / 4
      // schermo che CAMBIA: un riquadro raw al secondo
      rfbView.setMode('changing')
      const b1 = (await rfbView.stats()).bytesToClient
      await sleep(4_000)
      const movingBps = ((await rfbView.stats()).bytesToClient - b1) / 4
      noteBytes.push(`fermo: ${Math.round(stillBps)} B/s verso il client, ${stillIn.toFixed(1)} B/s dal client; cambiando: ${Math.round(movingBps)} B/s verso il client (${(movingBps / 1024).toFixed(0)} KB/s)`)
      log(`misure corsa ${run}: ${noteBytes[noteBytes.length - 1]}`)
    }
    // il picco va fermato QUI: da adesso si riapre la scheda Computer e la
    // finestra PiP (connessioni NORMALI che possono sovrapporsi per un attimo)
    const peak = await rfbView.peakStop()
    check('9 MAI più di UNA connessione peek per bot (picco sorvegliato in Attività)', peak === 1, `picco=${peak}`)

    // ============ 6: «Stacca» — la PiP ============""ic
    // si riapre la scheda Computer e si stacca da lì (bottone «Stacca» accanto
    // ai comandi), come farebbe l'utente che guarda lo schermo
    await clickTestid('bot-computer-card')
    await clickPanelButton('Schermo')
    await waitDom(`document.querySelector('[data-testid="bot-panel"]')?.textContent.includes('Schermo del bot')`, 15_000)
    await waitConns(1, 10_000) // la vista grande si ricollega (normale, tiene vivo)
    const detachClicked = await clickTestid('bot-screen-detach')
    // la seconda finestra (rotta #/pip/<bot>) compare
    let pip = null
    for (let i = 0; i < 60 && !pip; i++) {
      const list = await httpJson('/json/list')
      const t = list.find((x) => x.type === 'page' && x.url.includes('#/pip/'))
      if (t) pip = t
      else await sleep(250)
    }
    const pipState = await pageEval('return window.sandbot.pipState ? await window.sandbot.pipState() : null')
    check('6a «Stacca» apre una SECONDA finestra (rotta #/pip/<bot>)', !!pip,
      detachClicked ? (pip?.url?.slice(0, 60) ?? 'nessuna') : 'bottone «Stacca» assente')
    check('6b la PiP è SEMPRE SOPRA (alwaysOnTop letto dal MAIN via RPC pip:state)',
      pipState.open === true && pipState.agentId === bot.id && pipState.alwaysOnTop === true,
      JSON.stringify(pipState))
    // la vista grande si è scollegata (dice che lo schermo è altrove) e la PiP
    // mostra il colore
    const bigDetached = await waitDom(`document.querySelector('[data-testid="bot-panel"]')?.textContent.includes('Lo schermo è in una finestra a parte')`, 10_000)
    const thumbCanvasGone = await pageEval(`return !document.querySelector('[data-testid="bot-computer-thumb"] canvas')`)
    const restoreThere = await pageEval(`return !!document.querySelector('[data-testid="bot-screen-restore"]')`)
    check('6c la scheda Computer dice «Lo schermo è in una finestra a parte» (con «Riporta qui»)', bigDetached && restoreThere)
    check('6d l\'ANTEPRIMA della card si è scollegata (niente canvas)', thumbCanvasGone)
    const pipCdp = pip ? await openCdp(pip.webSocketDebuggerUrl) : null
    let pipColorOk = false
    if (pipCdp) {
      const ev = pageEvalOf(pipCdp)
      for (let i = 0; i < 20 && !pipColorOk; i++) {
        await sleep(400)
        const beforeIdx = await rfbView.colorIndex()
        const px = await ev(`
          const canvas = document.querySelector('[data-testid="pip-view"] canvas')
          if (!canvas) return null
          const ctx = canvas.getContext('2d')
          const d = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
          return [d[0], d[1], d[2]]
        `)
        const afterIdx = await rfbView.colorIndex()
        pipColorOk = colorNear(px, PALETTE[beforeIdx % PALETTE.length] ?? PALETTE[0]) || colorNear(px, PALETTE[afterIdx % PALETTE.length] ?? PALETTE[0])
      }
      if (run === 1) {
        await settleForCapture(pipCdp)
        const r = await pipCdp.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(SHOTS, '02-pip.png'), Buffer.from(r.data, 'base64'))
        log('cattura 02-pip.png')
      }
    }
    check('6e la PiP mostra il COLORE del server', pipColorOk)
    check('6f UNA sola connessione al socket (quella della PiP)', await waitConns(1, 5_000), `conn=${(await rfbView.stats()).connections}`)

    // ============ 7: «Chiudi» nella PiP ============
    if (pipCdp) {
      await pageEvalOf(pipCdp)(`
        const b = document.querySelector('[data-testid="pip-close"]')
        if (b) b.click()
        return !!b
      `)
      let gone = false
      for (let i = 0; i < 40 && !gone; i++) {
        const list = await httpJson('/json/list')
        gone = !list.some((x) => x.type === 'page' && x.url.includes('#/pip/'))
        if (!gone) await sleep(250)
      }
      const st = await rpc('pipState()')
      check('7a «Chiudi» chiude la PiP', gone && st.open === false, JSON.stringify(st))
      // la scheda Computer è ancora aperta: alla chiusura della PiP la vista
      // grande torna DA SOLA (l'effetto di SV5 riapre in vista)
      const back = await waitConns(1, 15_000)
      const bigBack = await waitDom(`!document.querySelector('[data-testid="bot-panel"]')?.textContent.includes('Lo schermo è in una finestra a parte')`, 8_000)
      check('7b chiusa la PiP, la vista grande torna da sola', back && bigBack, `conn=${(await rfbView.stats()).connections}`)
      // e si torna in Attività: l'ANTEPRIMA torna (canvas + colore)
      await clickTestid('bot-tab-activity')
      const thumbBack = await waitDom(`!!document.querySelector('[data-testid="bot-computer-thumb"] canvas')`, 8_000)
      const s = await samplePixelOf(`document.querySelector('[data-testid="bot-computer-thumb"]')`)
      check('7c l\'anteprima della card TORNA (canvas col colore del server)', thumbBack && s.match, JSON.stringify(s.pixel))
    } else {
      check('7 «Chiudi» nella PiP (saltato: la PiP non si era aperta)', false)
    }
    // ============ 8: il browser CHIUSO mostra «Ultima immagine» ============
    writeFileSync(EXIT_MCP, 'ora esci') // il finto MCP esce → il browser si spegne
    let stopped = false
    for (let i = 0; i < 60 && !stopped; i++) {
      await sleep(500)
      stopped = (await rpc(`screenStatus(${JSON.stringify(bot.id)})`)).browser === 'stopped'
    }
    check('8a il browser del bot si SPEGNE (finto MCP uscito)', stopped)
    const lastShown = await waitDom(`document.querySelector('[data-testid="bot-computer-thumb"]')?.textContent.includes('Ultima immagine')`, 10_000)
    const veiled = await pageEval(`
      const t = document.querySelector('[data-testid="bot-computer-thumb"]')
      const img = t?.querySelector('img')
      return {
        img: !!img,
        velata: !!img && (img.className.includes('opacity') || img.className.includes('grayscale')),
        canvas: !!t?.querySelector('canvas'),
        bars: t?.textContent.trim().slice(0, 40),
        label: t ? t.textContent.includes('Ultima immagine') : false
      }
    `)

    check('8b «Ultima immagine» compare, VELATA, al posto del canvas', lastShown && veiled.img && veiled.velata, JSON.stringify(veiled))
    check('8c nessuna connessione rimasta al socket', await waitConns(0, 5_000), `conn=${(await rfbView.stats()).connections}`)
    if (run === 1) await shot('03-ultima-immagine.png')
    log(`misure finali corsa ${run}: ${noteBytes.join(' | ')}`)
  } finally {
    try {
      const dlog = readFileSync(join(DAEMON_DATA, 'daemon.log'), 'utf8')
      if (failures > 0) {
        log(`--- daemon.log (ultime 20 righe) corsa ${run} ---`)
        log(dlog.split('\n').slice(-20).join('\n'))
      }
    } catch { /* niente log */ }
    // ---- chiusura: PRIMA il daemon, POI l'app, POI le cartelle ----
    let dOk = true
    try {
      const lock = JSON.parse(readFileSync(join(DAEMON_DATA, 'daemon.lock'), 'utf8'))
      if (Number.isInteger(lock.pid) && lock.pid > 1 && lock.pid !== process.pid) {
        try { process.kill(lock.pid, 'SIGTERM') } catch { /* già via */ }
        for (let i = 0; i < 30; i++) {
          try { process.kill(lock.pid, 0); await sleep(200) } catch { break }
        }
      }
    } catch { /* niente lock */ }
    stopApp()
    await sleep(1_200)
    await stopProbeDaemons(PREFIX, { log })
    const left = findProbeDaemons(PREFIX)
    check(`corsa${run}: 0 daemon rimasti`, left.length === 0, left.map((d) => d.pid).join(','))
    if (left.length > 0) dOk = false
    await rfbView.close()
    await rfbControl.close()
    await new Promise((r) => providerServer.close(() => r()))
    if (dOk) {
      rmSync(TMP, { recursive: true, force: true })
      rmSync(SOCK, { recursive: true, force: true })
    }
  }
  return failures
}

// ---- TRE corse (default; PROBE_RUNS=1 per il debug) ----
const RUNS = Number(process.env.PROBE_RUNS ?? 3)
let total = 0
for (const run of Array.from({ length: RUNS }, (_, i) => i + 1)) {
  let f = 1
  try {
    f = await runOnce(run)
  } catch (e) {
    log(`corsa ${run} ERRORE: ${e.message}`)
    log(String(e && e.stack ? e.stack : '').split('\n').slice(0, 4).join(' | '))
  }
  total += f
  log(`corsa ${run}: ${f === 0 ? 'VERDE' : `${f} controlli falliti`}`)
}
log(total === 0 ? 'SONDA VERDE: tutte le corse passate' : `SONDA ROSSA: ${total} controlli falliti in totale`)
process.exit(total === 0 ? 0 : 1)
}

