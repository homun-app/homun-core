#!/usr/bin/env node
// Sonda della fase beta12-correzioni — le CATTURE richieste e i loro
// controlli, dal vivo con la UI come le altre sonde: app VERA (out/, serve
// `npm run build` prima) su dati temporanei, modello FINTO openai-compatible
// su 127.0.0.1 (qui non serve nemmeno girare un turno), CLI `container`
// FINTA, Portachiavi/SafeStorage FINTI, un server MCP «ufficio» FINTO per
// la finestra di M2. MAI il container vero, mai download, rete solo su
// 127.0.0.1.
//
//   M1  il composer NON si deforma: a una riga la pillola (rounded-full),
//       con 40 righe incollate il form passa a rounded-3xl, la barra di
//       scorrimento sta dentro il margine interno e i bottoni restano in
//       basso (items-end). Tornando a una riga la pillola torna.
//   M2  la voce «Server MCP» nel menu dell'account apre la finestra sua:
//       titolo, spiegazione semplice (Cursor o Claude), l'elenco dei server
//       collegati, il form di aggiunta (stdio e http col bearer cifrato) e
//       in fondo «Gateway, plugin e registro» che apre «Per sviluppatori»,
//       che rimanda indietro senza più il form. Esc chiude la finestra.
//
// Catture CDP in docs/catture/fase-beta12/: 1-composer-40-righe.png e
// 2-finestra-server-mcp.png. Ogni attesa che riguarda il prodotto è un
// check; attese dei click UI ≤ 5 s. Pulizia K4: 0 cartelle
// sandbot-fase-beta12-*, 0 daemon della sonda, 0 llama-server della corsa rimasti vivi.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { leggiTentativiLocali, messaggioTentativiLocali, fotografaLlamaServerDellaCorsa, llamaServerDellaCorsa, messaggioLlamaServer } from './lib/sonda.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-beta12'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-beta12')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log('[sonda beta12]', ...a)
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

// ---- il modello FINTO (qui serve solo per la configurazione, nessun turno) ----
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
const DEBUG_PORT = 9491
let appLog = ''
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
    SANDBOT_TEST_FAKE_BROWSER_MCP: join(ROOT, 'scripts', 'fake-browser-mcp.mjs'),
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
      await sleep(2500)
    }
  }
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = async (callExpr) => {
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try {
      return await pageEval(`return await window.sandbot.${callExpr}`)
    } catch (e) {
      lastErr = e
      await sleep(1500)
    }
  }
  throw lastErr
}
const waitDom = async (exprTrue, timeoutMs = 5_000, step = 200) => {
  const deadline = Date.now() + timeoutMs
  const fast = async () => {
    try {
      return await withTimeout(page.send('Runtime.evaluate', {
        expression: `((async () => { return !!(${exprTrue}) })())`,
        awaitPromise: true,
        returnByValue: true
      }), 8_000, 'fast eval').then((r) => {
        if (r.exceptionDetails) return null
        return r?.result?.value === true
      })
    } catch {
      return null // occupata: si riprova
    }
  }
  for (;;) {
    const v = await fast()
    if (v === true) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
const setViewport = async (width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const settle = async () => {
  await page.send('Page.bringToFront').catch(() => undefined)
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pageEval(`await Promise.race([new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) }), new Promise((resolve) => setTimeout(resolve, 1500))])`)
  await sleep(350)
}
const shot = async (name) => {
  await settle()
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
const clickTestid = async (testid, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      // il clic VERO: i trigger Radix (menu) aprono su pointerdown
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
      el.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}
/** scrive nel textarea col setter NATIVO (come un incolla vero) e scollega l'evento */
const pasteInComposer = async (text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.scrollTop = ta.scrollHeight
  return true
`)

try {
  await setViewport(1280, 800)

  // ---- setup: provider finto, guida chiusa, il bot principale ----
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(`document.querySelector('form textarea')`, 15_000)) break
  }
  if (!(await waitDom(`document.querySelector('form textarea')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))

  // =========== M1: il composer non si deforma con un testo lungo ===========

  // a UNA riga: la pillola di oggi
  await sleep(400)
  const pill = await pageEval(`
    const form = document.querySelector('form textarea').closest('form')
    return { cls: form.className, ta: document.querySelector('form textarea').className }
  `)
  check('M1: a una riga il composer resta la pillola (rounded-full)', String(pill.cls).includes('rounded-full') && !String(pill.cls).includes('rounded-3xl'), String(pill.cls).slice(0, 120))

  // 40 righe incollate
  const righe40 = Array.from({ length: 40 }, (_, i) => `Riga ${i + 1} del testo lungo incollato nel composer, per provare che la pillola non si deforma.`).join('\n')
  if (!(await pasteInComposer(righe40))) throw new Error('impossibile scrivere nel composer')
  const diventatoRiquadro = await waitDom(`(() => { const f = document.querySelector('form textarea').closest('form'); return f && f.className.includes('rounded-3xl') && !f.className.includes('rounded-full') })()`, 5_000)
  check('M1: con 40 righe il form passa a rounded-3xl (angoli 24 px, non più pillola)', diventatoRiquadro)
  const misura = await pageEval(`
    const ta = document.querySelector('form textarea')
    const form = ta.closest('form')
    const taRect = ta.getBoundingClientRect()
    const formRect = form.getBoundingClientRect()
    const pr = parseFloat(getComputedStyle(ta).paddingRight)
    // i bottoni (graffetta, Ragiona, Invia) restano allineati in basso
    const btns = [...form.querySelectorAll('button')].map((b) => b.getBoundingClientRect().bottom)
    const bottomAligned = btns.length > 0 && btns.every((bt) => Math.abs(bt - Math.max(...btns)) < 2)
    return {
      scroll: ta.scrollHeight > ta.clientHeight,
      pr,
      h: taRect.height,
      bottomAligned,
      itemsEnd: form.className.includes('items-end')
    }
  `)
  check('M1: la barra di scorrimento c\'è (scrollHeight > clientHeight, il campo cresce e poi scorre dentro)',
    misura.scroll === true, JSON.stringify(misura))
  check('M1: la barra di scorrimento sta dentro il margine interno (padding-right ≥ 20 px dal bordo)', misura.pr >= 20, `pr ${misura.pr} px`)
  check('M1: graffetta, Ragiona e Invia restano allineati in basso (items-end)', misura.bottomAligned === true && misura.itemsEnd === true)
  await shot('1-composer-40-righe.png')

  // tornando a una riga la pillola torna (transizione ≤ 150 ms: si aspetta il doppio)
  if (!(await pasteInComposer(''))) throw new Error('impossibile svuotare il composer')
  await sleep(400)
  const tornaPill = await waitDom(`(() => { const f = document.querySelector('form textarea').closest('form'); return f && f.className.includes('rounded-full') && !f.className.includes('rounded-3xl') })()`, 5_000)
  check('M1: svuotando, il composer torna la pillola', tornaPill)

  // =========== M2: la finestra «Server MCP» ===========

  // un server MCP «ufficio» FINTO (stdio, locale): la finestra lo mostra in elenco
  const mcpCallsFile = join(DATA, 'ufficio-calls.jsonl')
  const serverCfg = { id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts', 'fake-ufficio-mcp.mjs'), mcpCallsFile], enabled: true, enabledFor: ['*'] }
  await rpc(`mcpSave(${JSON.stringify(serverCfg)})`)
  const mcpOk = await rpc(`mcpTest('srv-ufficio')`)
  check('setup: il server MCP «ufficio» è collegato (finestra con un elenco vero)', mcpOk?.ok === true && (mcpOk.tools ?? []).some((t) => t.includes('send_email')), JSON.stringify(mcpOk)?.slice(0, 120))

  // la voce nel menu dell'account apre la finestra
  const apertoMenu = await clickTestid('account-menu-trigger')
  const voceOk = apertoMenu !== false && await waitDom(`document.querySelector('[data-testid="menu-mcp"]')`, 5_000)
  check('M2: la voce «Server MCP» c\'è nel menu dell\'account', voceOk)
  const cliccata = await clickTestid('menu-mcp')
  const finestra = cliccata !== false && await waitDom(`document.querySelector('[data-testid="mcp-window"]')`, 5_000)
  check('M2: la voce apre la finestra «Server MCP»', finestra)
  const win = await pageEval(`
    const w = document.querySelector('[data-testid="mcp-window"]')
    const testo = w ? w.textContent : ''
    return {
      titolo: testo.includes('Server MCP'),
      cursor: testo.includes('Cursor o Claude'),
      elenco: testo.includes('ufficio'),
      aggiungi: testo.includes('+ Aggiungi server MCP'),
      rimando: testo.includes('Gateway, plugin e registro'),
      bots: testo.includes('tutti i bot')
    }
  `)
  check('M2: titolo, spiegazione semplice (Cursor o Claude), il server collegato in elenco e il bottone di aggiunta',
    win.titolo && win.cursor && win.elenco && win.aggiungi, JSON.stringify(win))
  check('M2: la mezza riga «usato da tutti i bot» (il dato enabledFor esiste già)', win.bots === true)
  await shot('2-finestra-server-mcp.png')

  // il form di aggiunta: stdio e http col bearer CIFrato, come oggi
  const aggiunto = await pageEval(`
    const w = document.querySelector('[data-testid="mcp-window"]')
    const btn = w && [...w.querySelectorAll('button')].find((b) => b.textContent.includes('+ Aggiungi server MCP'))
    if (!btn) return false
    btn.click()
    return true
  `)
  const formOk = aggiunto === true && await waitDom(`(() => { const w = document.querySelector('[data-testid="mcp-window"]'); const s = w && w.querySelector('select'); return s && [...s.options].some((o) => o.textContent.includes('stdio (comando locale)')) })()`, 5_000)
  check('M2: «+ Aggiungi server MCP» apre il form di oggi con stdio', formOk)
  const bearer = await pageEval(`
    const w = document.querySelector('[data-testid="mcp-window"]')
    const s = w && w.querySelector('select')
    if (!s) return { http: false, bearer: false }
    s.value = [...s.options].find((o) => o.value === 'http')?.value ?? 'http'
    s.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    const pw = w.querySelector('input[type="password"]')
    return { http: !!w.querySelector('input[placeholder*="URL"]'), bearer: !!pw && (pw.placeholder ?? '').includes('salvato cifrato') }
  `)
  check('M2: il form http con il bearer CIFrato (input password, «salvato cifrato»)', bearer.http === true && bearer.bearer === true, JSON.stringify(bearer))
  await pageEval(`
    const w = document.querySelector('[data-testid="mcp-window"]')
    const annulla = w && [...w.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Annulla')
    if (annulla) annulla.click()
    return true
  `)

  // in fondo «Gateway, plugin e registro» apre «Per sviluppatori» col rimando
  const rimando = await pageEval(`
    const w = document.querySelector('[data-testid="mcp-window"]')
    const btn = w && [...w.querySelectorAll('button')].find((b) => b.textContent.includes('Gateway, plugin e registro'))
    if (!btn) return false
    btn.click()
    return true
  `)
  const sviluppatori = rimando === true && await waitDom(`document.querySelector('[data-testid="developers-sheet"]')`, 5_000)
  check('M2: «Gateway, plugin e registro» apre «Per sviluppatori»', sviluppatori)
  const rimandoIndietro = await pageEval(`
    const d = document.querySelector('[data-testid="developers-sheet"]')
    const testo = d ? d.textContent : ''
    const btn = d && d.querySelector('[data-testid="developers-open-mcp"]')
    return {
      riga: testo.includes('aggiunti a mano stanno nella finestra'),
      bottone: !!btn,
      form: [...(d?.querySelectorAll('input') ?? [])].some((i) => (i.placeholder ?? '').includes('Comando (es.'))
    }
  `)
  check('M2: «Per sviluppatori» NON ha più il form: una riga che rimanda alla finestra', rimandoIndietro.riga === true && rimandoIndietro.bottone === true && rimandoIndietro.form === false, JSON.stringify(rimandoIndietro))
  // il rimando RIAPRE la finestra «Server MCP»
  const riaperta = await pageEval(`
    const btn = document.querySelector('[data-testid="developers-open-mcp"]')
    if (!btn) return false
    btn.click()
    return true
  `)
  const finestra2 = riaperta === true && await waitDom(`document.querySelector('[data-testid="mcp-window"]')`, 5_000)
  const sheetChiuso = await waitDom(`!document.querySelector('[data-testid="developers-sheet"]')`, 5_000)
  check('M2: il rimando di «Per sviluppatori» riapre la finestra «Server MCP» (e chiude il foglio)', finestra2 === true && sheetChiuso === true)

  // Esc chiude la finestra (come SkillsWindow)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', keyCode: 27, windowsVirtualKeyCode: 27 })
  const chiusa = await waitDom(`!document.querySelector('[data-testid="mcp-window"]')`, 5_000)
  check('M2: Esc chiude la finestra «Server MCP»', chiusa === true)

  // ---- pulizia K4 (come le altre sonde) ----
  // I2 (fase isolamento-locale): la FOTOGRAFIA dei llama-server discendenti dell'app e del daemon si scatta PRIMA di spegnerli
  const fotografiaLlama = fotografaLlamaServerDellaCorsa({ prefix: PREFIX, radice: DATA, home: null, pidApp: app.pid })
  stopApp()
  await sleep(1_500)
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', `fase-beta12-correzioni-probe|${join(ROOT, 'node_modules', 'electron')}`], { encoding: 'utf8' })
    const apps = String(out.stdout ?? '').trim()
    for (const pidStr of apps.split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid && pid !== app.pid) {
        try { process.kill(pid, 'SIGKILL'); log('app residua chiusa:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  // il server MCP ufficio della finestra: si chiude anche lui
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', 'fake-ufficio-mcp'], { encoding: 'utf8' })
    for (const pidStr of String(out.stdout ?? '').trim().split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL'); log('server ufficio chiuso:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  await stopProbeDaemons(PREFIX, { log }).catch((e) => log('stopProbeDaemons:', e.message))
  // I1 (fase isolamento-locale): il REGISTRO delle connessioni verso i servizi LLM locali veri del Mac
  // (lo scrive l'app in prova) si legge PRIMA che la cartella dati sparisca: una connessione = corsa ROSSA
  const tentativiLocali = leggiTentativiLocali(DATA)
  check('I1: 0 connessioni verso i servizi LLM locali veri (il registro è vuoto)', tentativiLocali.length === 0, messaggioTentativiLocali(tentativiLocali))
  await cleanupProbeRun({ pids: [app.pid], prefix: PREFIX, dirs: [DATA], log, capMs: 20_000 }).catch((e) => log('cleanupProbeRun:', e.message))
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
  let left = countProbeDirs(PREFIX, [DATA])
  if (left > 0) {
    await sleep(1500)
    await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
    left = countProbeDirs(PREFIX, [DATA])
  }
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  check('pulizia K4: 0 cartelle sandbot-fase-beta12-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  // I2: si contano solo i llama-server della corsa (catena dei padri, oppure radice o HOME finta negli argomenti)
  const llamas = llamaServerDellaCorsa({ prefix: PREFIX, radice: DATA, home: null, fotografia: fotografiaLlama })
  check('pulizia K4: 0 llama-server della corsa rimasti vivi', llamas.length === 0, messaggioLlamaServer(llamas) || 'nessuno')
  await new Promise((r) => providerServer.close(r))
} catch (e) {
  log('ERRORE della sonda:', e?.stack ?? e)
  log('log app (coda):', appLog.slice(-1200))
  failed++
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: String(e?.message ?? e) })
  // pulizia d'emergenza comunque: 0 processi, 0 cartelle
  stopApp()
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: app.pid ? [app.pid] : [], prefix: PREFIX, dirs: [DATA], log, capMs: 15_000 }).catch(() => undefined)
  await new Promise((r) => providerServer.close(r)).catch(() => undefined)
}

log(`CORSA beta12: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
