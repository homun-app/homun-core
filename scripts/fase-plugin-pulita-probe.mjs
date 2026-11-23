#!/usr/bin/env node
// Sonda della fase plugin-pulita (PP1–PP4): la pagina «Plugin» VERA su out/,
// dati temporanei, HOME finta (le skill delle altre app), 12 plugin FINTI con
// un server MCP da 24 strumenti (scripts/fake-plugin-pulita-mcp.mjs) e un
// server MCP http FINTO su 127.0.0.1 che accetta un solo token. Controlli:
// PP1 lo scorrimento della lista, della scheda e delle viste interne a
// 1200×800 e a 900×600 (misurato: scrollHeight, scrollTop dopo la rotella di
// CDP, i rettangoli); PP2 «Cambia token» con il test che passa da solo, la
// Cassaforte «Dei plugin» con «Apri nella scheda»; PP3 la voce «App e skill»
// sparita e setSettingsTab('app') che apre la pagina; PP4 un solo segnale di
// stato per riga, logo da 32, «Solo <bot>», righe a filo, schede come testo,
// la scheda con il menu ⋯ e i bot uno per riga. Catture solo via CDP in
// docs/catture/fase-plugin-pulita/ (chiaro e scuro).
//
//   node scripts/fase-plugin-pulita-probe.mjs [--run 1|2|3] [--app <cartella>] [--prima]
//
// --app: l'app da avviare (package.json + out/; default: questo repo). Le
//        catture «prima» vengono dal build di bb84b6b4, salvato in una
//        temporanea: STESSA sonda, stessi dati, stesse misure.
// --prima: le catture si chiamano prima-*.png. Sulla base le verifiche nuove
//        sono ROSSE (è la sonda vista rossa prima): l'uscita resta 1.
// Due cose dell'ambiente, gestite qui perché la misura sia vera: (1) sotto i
// 1000 px di larghezza il pannello del bot è un FOGLIO SOVRAPPOSTO col velo
// sopra tutta l'area centrale — la sonda lo chiude (la ✕) come farebbe chi
// vuole leggere la pagina; (2) con la finestra coperta da un'altra app
// Chromium la considera nascosta e la rotella di CDP non viene mai consegnata:
// l'app della sonda parte con gli interruttori di Chromium che lo impediscono
// (valgono uguale per la base e per il build della fase).
// Nessuna rete fuori da 127.0.0.1, nessun Docker, mai i file VERI delle altre
// app (solo la HOME finta). I token di prova nascono a ogni corsa e non si
// stampano MAI: la sonda cerca i loro valori nei file della temporanea.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'

const ROOT = join(import.meta.dirname, '..')
const argValue = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined)
const APP_DIR = resolve(argValue('--app') ?? ROOT)
const PRIMA = process.argv.includes('--prima')
const PREFIX = 'sandbot-fase-plugin-pulita'
const TMP = mkdtempSync(`/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/${PREFIX}-`)
const DATA = join(TMP, 'data')
const FAKE_HOME = join(TMP, 'home')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-plugin-pulita')
mkdirSync(SHOTS, { recursive: true })
mkdirSync(DATA, { recursive: true })
mkdirSync(FAKE_HOME, { recursive: true })
const shotName = (name) => `${PRIMA ? 'prima-' : ''}${name}.png`

const results = []
const T0 = Date.now()
const log = (...a) => console.log('[fase-plugin-pulita]', `+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 260) })
  log(ok ? 'OK ' : 'KO ', name, ok ? '' : '— ' + detail)
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + what)), ms))])

/** L'impronta del build che si avvia (per il REPORT: quali file, quale hash). */
const buildFingerprint = () => {
  const files = ['out/main/index.js', 'out/main/daemon.js', 'out/preload/index.cjs', 'out/renderer/index.html']
  const h = createHash('sha256')
  for (const f of files) {
    const p = join(APP_DIR, f)
    h.update(f).update(existsSync(p) ? readFileSync(p) : 'MANCANTE')
  }
  return h.digest('hex').slice(0, 16)
}
log('app:', APP_DIR, PRIMA ? '(PRIMA: catture con prefisso)' : '', 'build:', buildFingerprint())

// ---- la HOME finta con le skill delle altre app (MAI i file veri): 12, per far scorrere «Importa skill» ----
const skillDir = (app, name, description) => {
  const dir = join(FAKE_HOME, `.${app}`, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nLe istruzioni della skill ${name}.\n`)
}
for (let i = 1; i <= 12; i++) {
  const n = String(i).padStart(2, '0')
  skillDir(i % 3 === 0 ? 'claude' : i % 3 === 1 ? 'zcode' : 'cursor', `skill-${n}`, `Skill finta ${n} della sonda`)
}

// ---- il provider finto (una parola a botta: qui non si prova nessun turno) ----
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const provider = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      void body
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunkOf({ role: 'assistant', content: '' }))
      res.write(chunkOf({ content: 'Ok.' }))
      res.write(chunkOf({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise((r) => provider.listen(0, '127.0.0.1', r))
const providerPort = provider.address().port

// ---- il server MCP http FINTO: accetta SOLO il token buono (i valori nascono qui, non si stampano MAI) ----
const TOKEN_BUONO = `sonda-token-A-${randomBytes(12).toString('hex')}`
const TOKEN_SBAGLIATO = `sonda-token-B-${randomBytes(12).toString('hex')}`
const tokenLog = [] // { at, ok } — at = ms dell'arrivo, ok = col token buono
let tokenSavedAt = Infinity
const mcpHttp = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const authorized = req.headers.authorization === `Bearer ${TOKEN_BUONO}`
  if (!authorized) {
    tokenLog.push({ at: Date.now(), ok: false })
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    tokenLog.push({ at: Date.now(), ok: true })
    let msg = {}
    try { msg = JSON.parse(body) } catch { /* non JSON: 400 */ }
    if (req.headers['content-type']?.includes('application/json') && msg.method === undefined) {
      res.writeHead(400)
      res.end()
      return
    }
    if (msg.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    const result = msg.method === 'initialize'
      ? { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'token-finto', version: '1.0.0' } }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'chiama', description: 'Un solo strumento del server col token', inputSchema: { type: 'object', properties: {} } }] }
        : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  })
})
await new Promise((r) => mcpHttp.listen(0, '127.0.0.1', r))
const mcpHttpPort = mcpHttp.address().port

// ---- l'app Electron VERA (out/ dell'app scelta) ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9571 + (Number(process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : '0') % 20)
let appLog = ''
let app = null
const startApp = () => {
  appLog = ''
  // la finestra della sonda COPERTA (chi lavora al Mac la tiene dietro un'altra
  // app): Chromium la considera nascosta, smette di produrre frame e la rotella
  // di CDP non viene mai consegnata — la sonda restava appesa. Questi tre
  // interruttori di Chromium dicono solo questo: una finestra coperta non
  // diventa «invisibile» per il renderer. Non cambiano né il layout né lo
  // scorrimento; valgono uguale per la base e per il build della fase.
  const CHROMIUM_COVERED = ['--disable-features=MacWebContentsOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
  const p = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it', ...CHROMIUM_COVERED], {
    cwd: APP_DIR,
    env: {
      HOME: FAKE_HOME,
      PATH: process.env.PATH,
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  p.stdout.on('data', (d) => { appLog += d.toString() })
  p.stderr.on('data', (d) => { appLog += d.toString() })
  app = p
  return p
}
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const waitPidGone = async (pid, capMs = 15_000) => {
  const deadline = Date.now() + capMs
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false
    await sleep(200)
  }
  return true
}
/** La fine corsa dai segnali: la stessa pulizia (app, daemon della sonda, temporanea) — un'interruzione non lascia nulla. */
const cleanupFromSignal = async (code) => {
  stopApp()
  try {
    if (Number.isInteger(app?.pid)) await waitPidGone(app.pid, 8_000)
    const { stopProbeDaemons } = await import('./lib/probe-daemons.mjs')
    await stopProbeDaemons(PREFIX, { log: () => undefined }).catch(() => undefined)
    rmSync(TMP, { recursive: true, force: true })
  } catch { /* meglio possibile */ }
  process.exit(code)
}
process.on('SIGINT', () => { void cleanupFromSignal(130) })
process.on('SIGTERM', () => { void cleanupFromSignal(143) })

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
    // ogni comando ha un tetto (una finestra coperta può non rispondere MAI: la sonda fallisce, non resta appesa)
    send: (method, params = {}, capMs = 20_000) => withTimeout(new Promise((res, rej) => {
      const mid = ++id
      waits.set(mid, { res, rej })
      sock.send(JSON.stringify({ id: mid, method, params }))
    }), capMs, method)
  }
}
const waitForPage = async (urlIncludes, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const list = await httpJson('/json/list')
      const target = list.find((t) => t.type === 'page' && (t.url ?? '').includes(urlIncludes) && !(t.url ?? '').includes('/pip/'))
      if (target) return { cdp: await openCdp(target.webSocketDebuggerUrl), url: target.url }
    } catch { /* il debugger non è ancora su */ }
    if (Date.now() > deadline) return null
    await sleep(200)
  }
}
const pageEval = async (cdp, expr) => {
  const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: `((async () => { ${expr} })())`, awaitPromise: true, returnByValue: true }), 30_000, 'Runtime.evaluate')
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = async (cdp, callExpr) => {
  for (let i = 0; i < 8; i++) {
    try {
      return await pageEval(cdp, `if (!window.sandbot) throw new Error('preload non pronto'); return await window.sandbot.${callExpr}`)
    } catch (e) {
      if (i === 7) throw e
      await sleep(700)
    }
  }
}
const waitDom = async (cdp, exprTrue, timeoutMs = 8_000, step = 200) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await pageEval(cdp, `return !!(${exprTrue})`) === true) return true
    } catch { /* si riprova */ }
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
/** Aspetta che una valutazione torni un valore non nullo (il valore, o null a fine tempo). */
const waitValue = async (cdp, expr, timeoutMs = 8_000, step = 250) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await pageEval(cdp, `return (${expr})`)
      if (v !== null && v !== undefined && v !== false) return v
    } catch { /* si riprova */ }
    if (Date.now() > deadline) return null
    await sleep(step)
  }
}
/** Il clic di un elemento per testid: lo porta al centro e clicca (per le MISURE non si usa: sposta lo scroll). */
const clickTestid = async (cdp, testid, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(cdp, `
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
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
/** Il clic per testo (dentro un contenitore), senza spostare lo scroll. */
const clickText = async (cdp, text, { scope = 'document', timeoutMs = 5_000, exact = true } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(cdp, `
      const nodes = [...(${scope}).querySelectorAll('button, [role="tab"], [role="menuitem"], [role="button"]')]
      const t = ${JSON.stringify(text)}
      const b = nodes.find((x) => ${exact ? '(x.textContent ?? "").trim() === t' : '(x.textContent ?? "").includes(t)'})
      if (!b) return false
      b.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}
const setViewport = async (cdp, width, height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(800)
  // il mouse virtuale se ne va dall'elenco: dopo la rotella restava su una
  // riga e nelle catture si vedeva l'hover di una riga per niente
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }).catch(() => undefined)
  await sleep(150)
}
const setDark = async (cdp, dark) => {
  await pageEval(cdp, `document.documentElement.classList.${dark ? 'add' : 'remove'}('dark'); return true`)
  await sleep(300)
}
const settle = async (cdp) => {
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pageEval(cdp, `await Promise.race([new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) }), new Promise((resolve) => setTimeout(resolve, 1500))])`)
  await sleep(350)
}
const shot = async (cdp, name) => {
  await settle(cdp)
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, shotName(name)), Buffer.from(r.data, 'base64'))
  log('cattura', shotName(name))
}
/** Il clic su una scheda interna della scheda del plugin (per testo: il nome resta lo stesso prima e dopo). */
const cardTab = (cdp, label) => pageEval(cdp, `
  const btn = [...document.querySelectorAll('[data-testid="plugin-card-tabs"] button')].find((b) => (b.textContent ?? '').trim() === ${JSON.stringify(label)})
  btn?.click(); return !!btn
`)
/** La scheda interna ATTIVA (aria-selected nelle schede nuove; nelle vecchie la pillola piena). */
const activeCardTab = (cdp) => pageEval(cdp, `
  const tabs = [...document.querySelectorAll('[data-testid="plugin-card-tabs"] button')]
  const active = tabs.find((b) => b.getAttribute('aria-selected') === 'true') ?? tabs.find((b) => b.className.includes('bg-foreground'))
  return active ? (active.textContent ?? '').trim() : null
`)

// ---- le misure dello scorrimento ----
/** Il corpo di una vista: quello dell'invaso (data-plugin-shell); sulla base il primo overflow-y-auto, oppure l'involucro `min-h-0 flex-1` delle viste che non avevano NESSUNO scorrimento. */
const BODY_OF = (rootSel) => `(() => { const r = document.querySelector(${JSON.stringify(rootSel)}); return r ? (r.querySelector('[data-plugin-shell="body"]') ?? r.querySelector('.overflow-y-auto.scroll-thin') ?? r.querySelector('.min-h-0.flex-1')) : null })()`
/** L'espressione (nel renderer) della misura del corpo di una vista. */
const MEASURE_JS = (rootSel) => `(() => {
  const body = ${BODY_OF(rootSel)}
  if (!body) return null
  const r = body.getBoundingClientRect()
  return { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollTop: body.scrollTop, hasShell: !!body.closest('[data-plugin-shell="root"]'), top: Math.round(r.top), bottom: Math.round(r.bottom), innerHeight: window.innerHeight, innerWidth: window.innerWidth }
})()`
const measure = (cdp, rootSel) => pageEval(cdp, `return ${MEASURE_JS(rootSel)}`)
const rectOf = (cdp, rootSel, elExpr) => pageEval(cdp, `
  const body = ${BODY_OF(rootSel)}
  const el = ${elExpr}
  if (!body || !el) return null
  const r = el.getBoundingClientRect()
  const b = body.getBoundingClientRect()
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), bodyTop: Math.round(b.top), bodyBottom: Math.round(b.bottom), bodyHeight: body.clientHeight, maxScroll: body.scrollHeight - body.clientHeight, innerHeight: window.innerHeight }
`)
/**
 * Il FONDO dell'elemento sta nel corpo visibile e dentro la finestra (un
 * pixel di tolleranza) — è quello che la spec chiede («il fondo è
 * raggiungibile»). Se l'elemento ci starebbe intero anche a fine corsa
 * (la sua altezza più la corsa dello scroll non superano il corpo) si
 * chiede anche che il bordo superiore resti dentro; se è più alto, in fondo
 * alla corsa il suo bordo superiore esce ed è giusto così.
 */
const onScreen = (r) => r !== null && r.height > 0 && r.bottom <= r.bodyBottom + 1 && r.bottom <= r.innerHeight + 1 && (r.height + r.maxScroll > r.bodyHeight + 1 || r.top >= r.bodyTop - 1)
/** La rotella VERA (CDP) sul corpo che scorre. */
/** Il punto dove la rotella cade: il centro del corpo che scorre. */
const wheelPoint = async (cdp, rootSel) => {
  const m = await measure(cdp, rootSel)
  if (!m) return null
  return { x: Math.round(m.innerWidth / 2), y: Math.max(40, Math.round(Math.min(m.top + m.clientHeight / 2, m.innerHeight - 40))), m }
}
/** Cosa c'è sotto un punto (se la rotella non muove nulla: è caduto su qualcos'altro?). */
const hitAt = (cdp, x, y) => pageEval(cdp, `
  const describe = (e) => {
    const r = e.getBoundingClientRect()
    return e.tagName.toLowerCase() + (e.dataset.testid ? '[' + e.dataset.testid + ']' : '') + (e.id ? '#' + e.id : '') + '{' + [...e.classList].slice(0, 3).join('.') + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + '}'
  }
  // tutto ciò che è impilato sotto il punto, dal primo in su (se il corpo che scorre non c'è, qualcosa lo copre)
  const stack = document.elementsFromPoint(${x}, ${y}).slice(0, 6).map(describe)
  return stack.join(' < ') || 'null'
`).catch((e) => 'errore: ' + e.message)
const wheel = async (cdp, rootSel, deltaY = 400) => {
  const point = await wheelPoint(cdp, rootSel)
  if (!point) return null
  const { x, y } = point
  // la finestra davanti (coperta, Chromium non consegna gli eventi di input); un secondo tentativo se non risponde
  for (let attempt = 0; ; attempt++) {
    try {
      await cdp.send('Page.bringToFront', {}, 8_000).catch(() => undefined)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 8_000)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, 8_000)
      break
    } catch (e) {
      if (attempt > 0) {
        const vis = await pageEval(cdp, `return { vis: document.visibilityState, focus: document.hasFocus() }`).catch(() => null)
        throw new Error(`la rotella non è stata consegnata (${JSON.stringify(vis)}): ${e.message}`)
      }
      await sleep(700)
    }
  }
  await sleep(250)
  return measure(cdp, rootSel)
}
/** Tutto in fondo con la rotella, un colpo dopo l'altro (tetto: 80 colpi). */
const wheelToBottom = async (cdp, rootSel) => {
  let m = await measure(cdp, rootSel)
  let still = 0
  for (let i = 0; i < 80 && m.scrollTop + m.clientHeight < m.scrollHeight - 1; i++) {
    const before = m.scrollTop
    m = await wheel(cdp, rootSel, 600)
    // tre colpi di fila senza che si muova nulla: la rotella non arriva al corpo, non si insiste
    still = m && m.scrollTop === before ? still + 1 : 0
    if (still >= 3) break
  }
  await sleep(250)
  return measure(cdp, rootSel)
}
const resetScroll = (cdp, rootSel) => pageEval(cdp, `const b = ${BODY_OF(rootSel)}; if (b) b.scrollTop = 0; return true`)
const fmt = (m) => (m ? `scroll ${m.scrollTop}+${m.clientHeight}/${m.scrollHeight} corpo ${m.top}–${m.bottom} finestra ${m.innerHeight} [shell: ${m.hasShell}]` : 'nessun corpo')

/**
 * PP1 per una vista a una data larghezza: il corpo ha più contenuto che
 * spazio; dopo UN colpo di rotella scrollTop > 0; `lastExpr` (l'ultimo
 * elemento da raggiungere) sta nel corpo visibile quando si è in fondo.
 */
/**
 * PP1 per una vista a una data larghezza. `requireOverflow` (lista e scheda):
 * il corpo DEVE avere più contenuto che spazio, e dopo UN colpo di rotella
 * scrollTop > 0. Sempre: `lastExpr` (l'ultimo elemento da raggiungere) sta
 * nel corpo visibile quando si è in fondo con la rotella. Le viste interne
 * chiedono solo il fondo: se il contenuto entra, non c'è scorrimento da
 * misurare.
 */
const scrollChecks = async (cdp, what, rootSel, lastExpr, lastLabel, { requireOverflow = true } = {}) => {
  const tag = `${what} ${await pageEval(cdp, 'return window.innerWidth + "×" + window.innerHeight')}`
  await resetScroll(cdp, rootSel)
  await sleep(200)
  const m0 = await measure(cdp, rootSel)
  if (m0 === null) {
    for (const problema of ['il corpo che scorre c\'è', `in fondo ${lastLabel} sta dentro la finestra`]) check(`${tag}: ${problema}`, false, 'nessun corpo che scorre nella vista')
    return { m0: null, m1: null, m2: null, r: null }
  }
  // il corpo SCORRE dentro se ha più contenuto che spazio; è TAGLIATO se sporge dalla finestra (il vizio di prima: cresceva col contenuto e il fondo restava sotto il bordo)
  const overflows = m0.scrollHeight > m0.clientHeight
  const clipped = m0.bottom > m0.innerHeight + 1 || m0.top < 0
  if (requireOverflow) check(`${tag}: il corpo ha più contenuto che spazio (scrollHeight > clientHeight) e sta nella finestra`, overflows && !clipped, fmt(m0))
  if (overflows && !clipped) {
    await wheel(cdp, rootSel, 400)
    const m1 = await waitValue(cdp, `(() => { const m = (${MEASURE_JS(rootSel)}); return m && m.scrollTop > 0 ? m : null })()`, 1_500, 100)
    const point = await wheelPoint(cdp, rootSel)
    check(`${tag}: dopo la rotella scrollTop > 0`, m1 !== null && m1.scrollTop > 0, `${fmt(m1 ?? await measure(cdp, rootSel))} · rotella a ${point?.x},${point?.y} su: ${m1 ? '' : (point ? await hitAt(cdp, point.x, point.y) : '')}`)
  } else {
    check(`${tag}: il contenuto sta tutto dentro la finestra (nessuno scorrimento da misurare)`, !clipped, fmt(m0))
  }
  const m2 = await wheelToBottom(cdp, rootSel)
  const r = await rectOf(cdp, rootSel, lastExpr)
  check(`${tag}: in fondo ${lastLabel} sta dentro la finestra e dentro il corpo (bottom ≤ innerHeight)`, onScreen(r), `${lastLabel} ${r ? `${r.top}–${r.bottom}` : 'non trovato'} · corpo ${m2 ? `${m2.top}–${m2.bottom}` : '-'} · ${fmt(m2)}`)
  await resetScroll(cdp, rootSel)
  return { m0, m1: m0, m2, r }
}
const trySection = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    log('ERRORE nella sezione', name, '—', e.message)
    results.push({ name: `${name}: la sezione è arrivata in fondo senza errori`, ok: false, detail: e.message })
  }
}

/** Si torna alla LISTA della pagina da qualunque stato: scheda chiusa, vista interna chiusa; se la pagina era chiusa la apre. */
/** Il velo del foglio sovrapposto del pannello del bot (sotto i 1000 px copre anche la pagina Plugin). */
const VEIL = `document.querySelector('[class*="bg-foreground/25"][aria-hidden="true"]')`
const PANEL_COVERING = `!!${VEIL} || !!document.querySelector('button[aria-label="Chiudi il pannello"]')`
/**
 * Il pannello del bot è aperto di default; sotto i 1000 px di larghezza
 * diventa un FOGLIO SOVRAPPOSTO col velo sopra tutta l'area centrale, pagina
 * Plugin compresa: la rotella cadrebbe sul velo. Lo si chiude come farebbe
 * l'utente (la ✕), una volta per tutta: la pagina resta scoperta a ogni
 * larghezza.
 */
const closeRightPanel = async (cdp) => {
  const clicked = await pageEval(cdp, `const b = document.querySelector('button[aria-label="Chiudi il pannello"]'); if (!b) return false; b.click(); return true`)
  await sleep(400)
  return clicked && !(await pageEval(cdp, `return ${PANEL_COVERING}`))
}

const backToList = async (cdp) => {
  for (let i = 0; i < 4; i++) {
    const state = await pageEval(cdp, `
      if (document.querySelector('[role="dialog"]')) return 'dialogo'
      if (document.querySelector('[data-testid="plugin-card"]')) return 'scheda'
      const back = document.querySelector('[data-testid="plugin-page"] button[aria-label*="Torna"]')
      if (back && document.querySelector('[data-testid="plugin-yours"]') === null) return 'vista'
      if (document.querySelector('[data-testid="plugin-yours"]')) return 'lista'
      return 'chiusa'
    `).catch(() => 'chiusa')
    if (state === 'lista') return true
    if (state === 'dialogo') await pageEval(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    else if (state === 'scheda') await pageEval(cdp, `document.querySelector('[data-testid="plugin-card"] button[aria-label*="Torna"]')?.click(); return true`)
    else if (state === 'vista') await pageEval(cdp, `document.querySelector('[data-testid="plugin-page"] button[aria-label*="Torna"]')?.click(); return true`)
    else if (!(await clickTestid(cdp, 'sidebar-plugin'))) return false
    await sleep(500)
  }
  return waitDom(cdp, AT_LIST, 5_000)
}

// ---- i dati della sonda ----
const FAKE_MCP = join(ROOT, 'scripts', 'fake-plugin-pulita-mcp.mjs')
const N_PLUGIN = 12
const pluginCfg = (i) => ({ id: `srv-plugin-${String(i).padStart(2, '0')}`, name: `plugin-${String(i).padStart(2, '0')}`, transport: 'stdio', command: process.execPath, args: [FAKE_MCP], enabled: true, enabledFor: ['*'] })
const LIST_ROW_LAST = `document.querySelector('#plugin-advanced')`
/** La lista della pagina, a qualunque segmento (i segmenti stanno solo lì; «I tuoi» solo in «Tutto»). */
const AT_LIST = `document.querySelector('[data-testid="plugin-segments"]')`
const backToListFrom = async (cdp, w, h) => {
  const ok = await pageEval(cdp, `document.querySelector('[data-testid="plugin-page"] button[aria-label*="Torna"]')?.click(); return true`) && await waitDom(cdp, AT_LIST, 5_000)
  check(`${w}×${h}: si torna ai plugin`, ok)
}

let cdp = null
try {
  // difensiva: un residuo di una corsa precedente sulla STESSA porta va via
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', `remote-debugging-port=${DEBUG_PORT}`], { encoding: 'utf8' })
    for (const pid of (out.stdout ?? '').split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
    }
  } catch { /* pgrep vuoto */ }
  await sleep(500)
  startApp()
  const main = await waitForPage('', 30_000)
  if (!main) throw new Error('nessuna pagina: ' + appLog.slice(-600))
  cdp = main.cdp
  log('pagina:', main.url)

  // ---- setup: provider finto, guida chiusa, tre bot, i server ----
  await rpc(cdp, `saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  await rpc(cdp, `settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpc(cdp, `settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(cdp, `onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(cdp, `document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(cdp, `document.querySelector('aside')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))
  const bots = []
  for (const name of ['Competitoor', 'Ricerche', 'Scrittura', 'Prezzi', 'Bozze']) {
    const bot = await rpc(cdp, `createAgent(${JSON.stringify(name)}, ${JSON.stringify('bot della sonda')})`)
    await rpc(cdp, `updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    bots.push(bot)
  }
  // i 12 plugin FINTI (24 strumenti ciascuno), uno ROTTO e uno SPENTO dall'utente
  for (let i = 1; i <= N_PLUGIN; i++) await rpc(cdp, `mcpSave(${JSON.stringify(pluginCfg(i))})`)
  await rpc(cdp, `mcpSave(${JSON.stringify({ id: 'srv-rotto', name: 'rotto', transport: 'stdio', command: '/non/esiste/prog', args: [], enabled: true, enabledFor: ['*'] })})`)
  await rpc(cdp, `mcpSave(${JSON.stringify({ id: 'srv-spento', name: 'spento', transport: 'stdio', command: process.execPath, args: [FAKE_MCP], enabled: false, disabledReason: 'user', enabledFor: ['*'] })})`)
  // il server col TOKEN, registrato con quello SBAGLIATO
  await rpc(cdp, `mcpSave(${JSON.stringify({ id: 'srv-token', name: 'token', transport: 'http', url: `http://127.0.0.1:${mcpHttpPort}/mcp`, enabled: true, enabledFor: ['*'] })}, ${JSON.stringify({ bearerToken: TOKEN_SBAGLIATO })})`)
  const demoTest = await rpc(cdp, `mcpTest('srv-plugin-01')`)
  check('setup: il server MCP finto è collegato (24 strumenti, nessuna rete)', demoTest?.ok === true && (demoTest.tools ?? []).length === 24, JSON.stringify(demoTest)?.slice(0, 120))
  const tokenTest = await rpc(cdp, `mcpTest('srv-token')`)
  check('setup: col token sbagliato il server http finto non si collega (401)', tokenTest?.ok === false, JSON.stringify(tokenTest)?.slice(0, 120))
  const rottoTest = await rpc(cdp, `mcpTest('srv-rotto')`)
  check('setup: il server ROTTO non parte', rottoTest?.ok === false, JSON.stringify(rottoTest)?.slice(0, 100))
  await cdp.send('Page.reload')
  if (!(await waitDom(cdp, `document.querySelector('aside')`, 25_000))) throw new Error('la pagina non è tornata dopo il reload: ' + appLog.slice(-500))

  // ---- la pagina ----
  check('la voce «Plugin» apre la pagina', await clickTestid(cdp, 'sidebar-plugin') && await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]')`, 5_000))
  check('«I tuoi» elenca i 12 plugin, il rotto e lo spento (15 righe col server del token)',
    await waitDom(cdp, `document.querySelectorAll('[data-testid^="plugin-row-"]').length >= 15`, 15_000),
    await pageEval(cdp, `return document.querySelectorAll('[data-testid^="plugin-row-"]').length + ' righe'`))
  check('il pannello del bot si chiude (la ✕): sotto i 1000 px sarebbe un foglio sovrapposto sopra la pagina', await closeRightPanel(cdp))
  await settle(cdp)

  // ============================ PP1 + catture: la lista ============================
  const PAGE = '[data-testid="plugin-page"]'
  for (const [w, h] of [[1200, 800], [900, 600]]) {
    await trySection(`lista ${w}×${h}`, async () => {
      await setViewport(cdp, w, h)
      check(`lista ${w}×${h}: nessun foglio copre la pagina (il pannello del bot è chiuso)`, !(await pageEval(cdp, `return ${PANEL_COVERING}`)))
      await resetScroll(cdp, PAGE)
      const nome = w === 1200 ? '1-lista-1200x800' : '4-lista-900x600'
      await shot(cdp, `${nome}-chiaro`)
      if (w === 1200) {
        await setDark(cdp, true)
        await shot(cdp, `${nome}-scuro`)
        await setDark(cdp, false)
      }
      const s = await scrollChecks(cdp, 'PP1 la lista', PAGE, LIST_ROW_LAST, '«Per sviluppatori» (#plugin-advanced)')
      // «Per sviluppatori» chiuso di default: la riga c'è, il contenuto no
      const dev = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-developers-toggle"]') ? 'chiuso' : (document.querySelector('[data-testid="plugin-advanced"]') ? 'aperto' : 'assente')`)
      check(`lista ${w}×${h}: «Per sviluppatori» in fondo, chiuso di default`, dev === 'chiuso', dev)
      void s
    })
  }

  // ============================ PP1 + catture: la scheda ============================
  await trySection('la scheda', async () => {
    await setViewport(cdp, 1200, 800)
    check('si torna alla lista', await backToList(cdp))
    await resetScroll(cdp, PAGE)
    check('PP1: il clic sulla riga del server da 24 strumenti apre la scheda', await clickTestid(cdp, 'plugin-row-server:srv-plugin-01', 8_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-card"] [data-testid="plugin-permissions"]')?.textContent?.includes('azione_24')`, 10_000))
    const CARD = '[data-testid="plugin-card"]'
    // ---- PP4: la scheda dal vivo ----
    const head = await waitValue(cdp, `(() => { const h = document.querySelector('[data-testid="plugin-card-head"]'); return h ? { text: (h.textContent ?? '').trim(), toggle: h.querySelector('[data-testid="plugin-card-active"]')?.getAttribute('aria-label') ?? null, switches: h.querySelectorAll('[role="switch"]').length } : null })()`, 5_000)
    check('PP4: la testata non ha parole di stato quando tutto va (niente «attivo», niente «Attivo» accanto all\'interruttore)', head !== null && !/attivo/i.test(head.text) && head.switches === 1 && head.toggle === 'Attivo', JSON.stringify(head))
    check('PP4: la testata ha la riga grigia «Server MCP · sul Mac»', head !== null && head.text.includes('Server MCP · sul Mac'), JSON.stringify(head?.text))
    const menu = await pageEval(cdp, `const m = document.querySelector('[data-testid="plugin-card-menu"]'); return m ? [...m.querySelectorAll('[role="menuitem"]')].map((i) => (i.textContent ?? '').trim()) : null`)
    check('PP4: il menu ⋯ della testata c\'è, con «Prova la connessione» e «Rimuovi»', Array.isArray(menu) && menu.includes('Prova la connessione') && menu.includes('Rimuovi') && menu.length === 2, JSON.stringify(menu))
    const tabsLive = await pageEval(cdp, `const l = document.querySelector('[data-testid="plugin-card-tabs"]'); return l ? { role: l.getAttribute('role'), tabs: [...l.querySelectorAll('[role="tab"]')].map((b) => ({ t: (b.textContent ?? '').trim(), sel: b.getAttribute('aria-selected'), full: (b.className ?? '').includes('bg-foreground') })) } : null`)
    check('PP4: le schede interne sono testo (tablist, aria-selected, nessuna pillola nera)', tabsLive?.role === 'tablist' && tabsLive.tabs.length === 3 && tabsLive.tabs.filter((x) => x.sel === 'true').length === 1 && tabsLive.tabs.every((x) => !x.full), JSON.stringify(tabsLive))
    const overviewLive = await pageEval(cdp, `const o = document.querySelector('[data-testid="plugin-overview"]'); return o ? { text: (o.textContent ?? ''), boxes: o.querySelectorAll('[class*="bg-muted/"]').length, labels: [...o.querySelectorAll('p.text-muted-foreground')].map((p) => (p.textContent ?? '').trim()).slice(0, 4) } : null`)
    check('PP4: la Panoramica ha i gruppi Provenienza e Sicurezza (senza riquadri; «Dati» solo se c\'è un fatto)', overviewLive !== null && overviewLive.labels.includes('Provenienza') && overviewLive.labels.includes('Sicurezza') && overviewLive.boxes === 0 && !overviewLive.labels.includes('Dati'), JSON.stringify(overviewLive))
    await cardTab(cdp, 'Autorizzazioni')
    const permsLive = await pageEval(cdp, `const g = document.querySelector('[data-testid="plugin-group-read"]'); return g ? { head: (g.querySelector('[data-testid="plugin-group-head-read"] h3')?.textContent ?? '').trim(), rows: g.querySelectorAll('[data-testid^="plugin-tool-"]:not([data-testid^="plugin-tool-select-"])').length, withBg: [...g.querySelectorAll('[data-testid^="plugin-tool-"]:not([data-testid^="plugin-tool-select-"])')].filter((r) => [...r.classList].some((c) => /^bg-(muted|card)/.test(c))).length, divide: [...g.querySelectorAll('.divide-y')].length } : null`)
    check('PP4: Autorizzazioni a filo: intestazione «Sola lettura · 12», 12 azioni senza fondo, separate da un filetto', permsLive !== null && permsLive.head === 'Sola lettura · 12' && permsLive.rows === 12 && permsLive.withBg === 0 && permsLive.divide >= 1, JSON.stringify(permsLive))
    await cardTab(cdp, 'Account e bot')
    const botsLive = await pageEval(cdp, `const b = document.querySelector('[data-testid="plugin-card-bots"]'); return b ? { rows: [...b.children].map((r) => (r.textContent ?? '').trim()), switches: b.querySelectorAll('[role="switch"]').length, account: (document.querySelector('[data-testid="plugin-account-rows"]')?.textContent ?? '').includes('nessun account') } : null`)
    check('PP4: «Bot che lo usano» a filo: «Tutti i bot» e un bot per riga, ognuno col suo interruttore', // (tra i bot c'è anche quello principale dell'app: «Bot»)
    botsLive !== null && botsLive.rows[0] === 'Tutti i bot' && bots.every((x) => botsLive.rows.includes(x.name)) && botsLive.rows.length === new Set(botsLive.rows).size && botsLive.switches === botsLive.rows.length && botsLive.account, JSON.stringify(botsLive))
    // le tre schede, chiare e scure, in cima
    for (const [label, nome] of [['Panoramica', '2-scheda-panoramica-1200x800'], ['Autorizzazioni', '2-scheda-autorizzazioni-1200x800'], ['Account e bot', '2-scheda-account-1200x800']]) {
      check(`la scheda ha la scheda interna «${label}»`, (await cardTab(cdp, label)) && (await activeCardTab(cdp)) === label, String(await activeCardTab(cdp)))
      await resetScroll(cdp, CARD)
      await sleep(250)
      await shot(cdp, `${nome}-chiaro`)
      await setDark(cdp, true)
      await shot(cdp, `${nome}-scuro`)
      await setDark(cdp, false)
    }
    // le misure alle due larghezze
    for (const [w, h] of [[1200, 800], [900, 600]]) {
      await setViewport(cdp, w, h)
      await cardTab(cdp, 'Autorizzazioni')
      await sleep(200)
      await scrollChecks(cdp, 'PP1 la scheda · Autorizzazioni', CARD, `[...document.querySelectorAll('[data-testid="plugin-card"] [data-testid^="plugin-tool-"]')].at(-1)`, 'l\'ultima azione')
      await cardTab(cdp, 'Account e bot')
      await sleep(200)
      await scrollChecks(cdp, 'PP1 la scheda · Account e bot', CARD, `[...document.querySelectorAll('[data-testid="plugin-card"] [data-testid="plugin-accounts"] button')].find((b) => /^(Rimuovi|Scollega)( davvero)?$/.test((b.textContent ?? '').trim()))`, '«Rimuovi»', { requireOverflow: false })
    }
    await setViewport(cdp, 1200, 800)
    // si chiude con la freccia indietro
    check('la scheda si chiude e si torna alla lista', await pageEval(cdp, `document.querySelector('[data-testid="plugin-card"] button[aria-label*="Torna"]')?.click(); return true`) && await waitDom(cdp, `!document.querySelector('[data-testid="plugin-card"]')`, 5_000))
  })

  // ============================ PP1: le viste mcp, skill-import, skill-new ============================
  await trySection('le viste interne', async () => {
    check('si torna alla lista', await backToList(cdp))
    for (const [w, h] of [[1200, 800], [900, 600]]) {
      await setViewport(cdp, w, h)
      // mcp: l'elenco dei server (i 15 registrati) e in fondo «+ Aggiungi server MCP»
      check(`mcp ${w}×${h}: Aggiungi › Server MCP personalizzato apre la vista`, await clickTestid(cdp, 'plugin-add') && await clickTestid(cdp, 'plugin-add-mcp') && await waitDom(cdp, `document.querySelectorAll('[data-testid="mcp-server-row"]').length >= 15`, 10_000))
      await scrollChecks(cdp, 'PP1 la vista mcp', PAGE, `document.querySelector('[data-testid="mcp-import-button"]')`, '«Importa da altre app» (il fondo della vista)', { requireOverflow: false })
      await backToListFrom(cdp, w, h)
      // skill-import: le 12 skill della HOME finta, in fondo la barra con «Importa»
      check(`skill-import ${w}×${h}: Aggiungi › Importa skill apre la vista`, await clickTestid(cdp, 'plugin-add') && await clickTestid(cdp, 'plugin-add-skill-import') && await waitDom(cdp, `document.querySelectorAll('[data-testid="plugin-skill-import-row"]').length >= 12`, 15_000))
      await scrollChecks(cdp, 'PP1 la vista skill-import', PAGE, `document.querySelector('[data-testid="plugin-skill-import"] > :last-child')`, 'la barra «Importa»', { requireOverflow: false })
      await backToListFrom(cdp, w, h)
      // skill-new: l'editor, in fondo i suoi pulsanti
      check(`skill-new ${w}×${h}: Aggiungi › Crea una skill apre la vista`, await clickTestid(cdp, 'plugin-add') && await clickText(cdp, 'Crea una skill', { scope: 'document.querySelector(\'[data-testid="plugin-add-menu"]\')' }) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"] form, [data-testid="plugin-page"] textarea')`, 8_000))
      await scrollChecks(cdp, 'PP1 la vista skill-new', PAGE, `(() => { const b = ${BODY_OF(PAGE)}; return b ? b.lastElementChild : null })()`, 'l\'ultimo elemento dell\'editor', { requireOverflow: false })
      await backToListFrom(cdp, w, h)
    }
    await setViewport(cdp, 1200, 800)
  })

  // ============================ PP2: il token si cambia dove vive il server ============================
  await trySection('il token', async () => {
    check('si torna alla lista', await backToList(cdp))
    await resetScroll(cdp, PAGE)
    // PP4: un solo segnale di stato per riga
    const rowSpento = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-spento"]')?.textContent ?? ''`)
    check('PP4: il server spento dall\'utente dice «spento»', /spento/.test(rowSpento), rowSpento.slice(0, 100))
    const rowRotto = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-rotto"]')?.textContent ?? ''`)
    check('PP4: il server rotto dice «non parte» con «Vedi perché»', /non parte/.test(rowRotto) && /Vedi perché/.test(rowRotto), rowRotto.slice(0, 100))
    const rowOk = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-plugin-01"]')?.textContent ?? ''`)
    check('PP4: la riga di un server che funziona non ha parole di stato (niente «attivo») e non dice «Tutti i bot»', !/attivo|active/.test(rowOk) && !/Tutti i bot/.test(rowOk), rowOk.slice(0, 140))
    check('PP4: la riga dice «Server MCP · sul Mac» (la riga grigia resta)', /Server MCP · sul Mac/.test(rowOk), rowOk.slice(0, 140))
    const logo = await pageEval(cdp, `const img = document.querySelector('[data-testid="plugin-row-server:srv-plugin-01"] img, [data-testid="plugin-row-server:srv-plugin-01"] span'); const r = img?.getBoundingClientRect(); return r ? Math.round(r.width) : null`)
    check('PP4: il logo della riga è da 32px', logo === 32, `largo ${logo}px`)
    const rowBots = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-spento"]')?.textContent ?? ''`)
    check('PP4: la riga non elenca i bot quando valgono per tutti', !rowBots.includes(bots[0]?.name ?? 'Competitoor'), rowBots.slice(0, 120))
    // la riga di un server SOLO per un bot dice «Solo <bot>»: lo si fa dalla
    // scheda (Account e bot), come l'utente — spento «Tutti i bot», acceso UN bot
    const soloBot = bots[1]?.name ?? 'Ricerche'
    check('PP4: la scheda di un secondo server si apre dalla riga', await clickTestid(cdp, 'plugin-row-server:srv-plugin-02', 8_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-card"] [data-testid="plugin-accounts"]')`, 8_000))
    await cardTab(cdp, 'Account e bot')
    await sleep(200)
    const botSwitch = (name) => `[...document.querySelectorAll('[data-testid="plugin-accounts"] [role="switch"]')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(name)})`
    await pageEval(cdp, `${botSwitch('Tutti i bot')}?.click(); return true`)
    const singleOn = await waitDom(cdp, `(() => { const b = ${botSwitch(soloBot)}; return !!b && !b.disabled && b.getAttribute('aria-checked') === 'false' })()`, 8_000)
    check('PP4: spento «Tutti i bot», il singolo bot è cliccabile', singleOn)
    await pageEval(cdp, `${botSwitch(soloBot)}?.click(); return true`)
    const onlyOne = await withTimeout((async () => {
      for (let i = 0; i < 20; i++) {
        const r = await rpc(cdp, `connectorsInstalled()`)
        const e = (r.servers ?? []).find((s) => s.id === 'srv-plugin-02')?.enabledFor
        if (Array.isArray(e) && e.length === 1 && e[0] === (bots[1]?.id ?? '')) return e
        await sleep(300)
      }
      return null
    })(), 10_000, 'un bot solo')
    check('PP4: enabledFor del server è quel bot solo', onlyOne !== null, JSON.stringify(onlyOne))
    check('PP4: la scheda si chiude', await pageEval(cdp, `document.querySelector('[data-testid="plugin-card"] button[aria-label*="Torna"]')?.click(); return true`) && await waitDom(cdp, `!document.querySelector('[data-testid="plugin-card"]')`, 5_000))
    let lastSolo = '(riga assente)'
    const solo = await withTimeout((async () => {
      for (let i = 0; i < 20; i++) {
        const t = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-plugin-02"]')?.textContent ?? '(riga assente)'`)
        lastSolo = t
        if (/Solo /.test(t)) return t
        await sleep(300)
      }
      return ''
    })(), 10_000, 'riga «Solo»')
    check('PP4: la riga con accesso ristretto dice «Solo <bot>»', /Solo /.test(solo), (solo || lastSolo).slice(0, 140))

    // PP2: il flusso del token
    const rowBefore = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-token"]')?.textContent ?? ''`)
    check('PP2: registrato col token sbagliato, la riga del server dice che non va («non parte»)', /non parte|accesso scaduto/.test(rowBefore), rowBefore.slice(0, 120))
    const badBefore = tokenLog.filter((t) => !t.ok).length
    check('PP2: il server finto ha rifiutato il token sbagliato (401)', badBefore >= 1, `${badBefore} richieste rifiutate`)
    check('PP2: il clic sulla riga apre la scheda', await clickTestid(cdp, 'plugin-row-server:srv-token', 8_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-card"] [data-testid="plugin-accounts"]')`, 8_000))
    check('PP2: la scheda «Account e bot» si apre', (await cardTab(cdp, 'Account e bot')) && (await activeCardTab(cdp)) === 'Account e bot', String(await activeCardTab(cdp)))
    const hasChange = await clickTestid(cdp, 'plugin-token-change', 5_000)
    check('PP2: la riga Account ha «Cambia token»', hasChange)
    if (!hasChange) return
    const field = await waitValue(cdp, `(() => { const i = document.querySelector('[data-testid="plugin-token-input"]'); return i ? { type: i.type, placeholder: i.placeholder, value: i.value } : null })()`, 5_000)
    check('PP2: «Cambia token» apre un campo password col testo «Nuovo token — sostituisce quello salvato»', field !== null && field.type === 'password' && /Nuovo token/.test(field.placeholder) && /sostituisce quello salvato/.test(field.placeholder), JSON.stringify(field))
    if (!field) return
    // il valore si scrive come farebbe la tastiera (il setter nativo + input: React lo vede)
    const written = await pageEval(cdp, `
      const el = document.querySelector('[data-testid="plugin-token-input"]')
      if (!el) return false
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(TOKEN_BUONO)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
    check('PP2: il nuovo token si scrive nel campo', written === true)
    check('PP2: «Salva» c\'è', await waitDom(cdp, `document.querySelector('[data-testid="plugin-token-save"]')`, 3_000))
    tokenSavedAt = Date.now()
    check('PP2: «Salva» si clicca', await clickTestid(cdp, 'plugin-token-save', 5_000))
    // l'esito del test parte da solo: la riga lo dice («collegato» o il motivo)
    const outcome = await waitValue(cdp, `(() => { const r = document.querySelector('[data-testid="plugin-secret-result"]'); return r ? (r.textContent ?? '').trim() : null })()`, 20_000, 300)
    check('PP2: dopo «Salva» il test parte da solo e la riga dice «collegato»', outcome !== null && /collegato/.test(outcome), String(outcome))
    const left = await pageEval(cdp, `const i = document.querySelector('[data-testid="plugin-token-input"]'); return i ? i.value : ''`)
    check('PP2: il valore non resta nel campo dopo il salvataggio', left === '', left === '' ? 'il campo è chiuso (o vuoto)' : 'il campo contiene ancora ' + left.length + ' caratteri')
    const inDom = await pageEval(cdp, `return document.body.innerHTML.includes(${JSON.stringify(TOKEN_BUONO)})`)
    check('PP2: il valore non resta nel DOM della finestra dopo il salvataggio', inDom === false, inDom ? 'il valore è ancora nel DOM' : 'assente dal DOM')
    const goodAfter = tokenLog.filter((t) => t.ok && t.at >= tokenSavedAt).length
    const badAfter = tokenLog.filter((t) => !t.ok && t.at >= tokenSavedAt).length
    check('PP2: il server finto ha ricevuto il token buono (e più quello sbagliato)', goodAfter >= 1 && badAfter === 0, `${goodAfter} col buono, ${badAfter} col vecchio`)
    const installed = await rpc(cdp, `connectorsInstalled()`)
    const srv = (installed.servers ?? []).find((s) => s.id === 'srv-token')
    check('PP2: la config dice auth bearer e lo stato dell\'ultima prova non è più errore', srv?.auth?.kind === 'bearer' && srv?.stateStatus !== 'error', JSON.stringify({ auth: srv?.auth?.kind, stateStatus: srv?.stateStatus, enabled: srv?.enabled }))
    check('PP2: la scheda si chiude', await pageEval(cdp, `document.querySelector('[data-testid="plugin-card"] button[aria-label*="Torna"]')?.click(); return true`) && await waitDom(cdp, `!document.querySelector('[data-testid="plugin-card"]')`, 5_000))
    const rowAfter = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-token"]')?.textContent ?? ''`)
    check('PP2: la riga del server non dice più che non va', !/non parte|accesso scaduto/.test(rowAfter), rowAfter.slice(0, 120))
  })

  // ============================ PP2: Cassaforte › Dei plugin ============================
  const openSettings = async () => {
    await pageEval(cdp, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await clickTestid(cdp, 'account-menu-trigger')
    await waitDom(cdp, `[role="menuitem"]`, 5_000)
    await pageEval(cdp, `
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === 'Impostazioni')
      item?.click(); return true
    `)
    return waitDom(cdp, `document.querySelector('[role="dialog"] nav button')`, 5_000)
  }
  await trySection('la Cassaforte', async () => {
    check('si torna alla lista', await backToList(cdp))
    check('le Impostazioni si aprono', await openSettings())
    // PP3: la colonna delle sezioni — niente «App e skill»
    const sezioni = await pageEval(cdp, `return [...document.querySelectorAll('[role="dialog"] nav button')].map((b) => (b.textContent ?? '').trim())`)
    check('PP3: la colonna delle Impostazioni NON ha «App e skill»', Array.isArray(sezioni) && sezioni.length > 0 && !sezioni.includes('App e skill'), JSON.stringify(sezioni))
    check('PP3: le sezioni sono Generali · Modelli · Approvazioni · Cassaforte · Routine · Uso e costi', JSON.stringify(sezioni) === JSON.stringify(['Generali', 'Modelli', 'Approvazioni', 'Cassaforte', 'Routine', 'Uso e costi']), JSON.stringify(sezioni))
    check('Cassaforte: la sezione si apre', await clickText(cdp, 'Cassaforte', { scope: 'document.querySelector(\'[role="dialog"] nav\')' }) && await waitDom(cdp, `document.querySelector('[role="dialog"]')?.textContent?.includes('Concessioni')`, 5_000))
    check('PP2: la Cassaforte ha la scheda «Dei plugin»', await clickText(cdp, 'Dei plugin', { scope: 'document.querySelector(\'[role="dialog"]\')' }) && await waitDom(cdp, `document.querySelector('[data-testid="vault-plugins"]')`, 5_000))
    // le righe: nome e tipo letti separatamente (il logo di ripiego porta l'iniziale del nome)
    let lastRows = null
    const listed = await withTimeout((async () => {
      for (let i = 0; i < 20; i++) {
        const rows = await pageEval(cdp, `return [...document.querySelectorAll('[data-testid="vault-plugins"] [data-testid^="vault-plugin-row-"]')].map((r) => ({ name: r.querySelector('[data-testid^="vault-plugin-name-"]')?.textContent?.trim() ?? '', type: r.querySelector('[data-testid^="vault-plugin-type-"]')?.textContent?.trim() ?? '', text: (r.textContent ?? '').trim() }))`)
        lastRows = rows
        if (rows.some((r) => r.name === 'token')) return rows
        await sleep(300)
      }
      return null
    })(), 10_000, 'righe Dei plugin')
    log('righe «Dei plugin»:', JSON.stringify(lastRows))
    check('PP2: «Dei plugin» elenca il server col segreto (nome «token», tipo «token») — e solo lui: gli altri plugin non hanno segreti', listed !== null && listed.length === 1 && listed[0].name === 'token' && listed[0].type === 'token', JSON.stringify(listed))
    check('PP2: «Dei plugin» non mostra mai un valore (né il token né «Bearer »)', listed !== null && !listed.some((r) => r.text.includes('Bearer ') || r.text.includes('sonda-token')), JSON.stringify(listed))
    if (listed !== null) {
      await shot(cdp, '3-cassaforte-dei-plugin-1200x800-chiaro')
      await setDark(cdp, true)
      await shot(cdp, '3-cassaforte-dei-plugin-1200x800-scuro')
      await setDark(cdp, false)
    }
    check('PP2: la riga del server ha «Apri nella scheda ›»', await clickTestid(cdp, 'vault-plugin-open-srv-token', 5_000))
    check('PP2: «Apri nella scheda» chiude le Impostazioni', await waitDom(cdp, `!document.querySelector('[role="dialog"]')`, 5_000))
    check('PP2: «Apri nella scheda» apre la pagina Plugin con la scheda del server', await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]') && document.querySelector('[data-testid="plugin-card"]')?.textContent?.includes('token')`, 5_000))
    check('PP2: la scheda si apre su «Account e bot»', (await activeCardTab(cdp)) === 'Account e bot', String(await activeCardTab(cdp)))
  })

  // ============================ PP3: setSettingsTab('app') apre la pagina Plugin ============================
  await trySection('setSettingsTab', async () => {
    await pageEval(cdp, `document.querySelector('[data-testid="plugin-card"] button[aria-label*="Torna"]')?.click(); return true`)
    await waitDom(cdp, `!document.querySelector('[data-testid="plugin-card"]')`, 5_000)
    // la pagina si chiude (si torna alla chat): il rimando deve RIAPRIRLA
    await backToList(cdp)
    await pageEval(cdp, `document.querySelector('[data-testid="plugin-page"] button[aria-label*="Torna alla chat"]')?.click(); return true`)
    const closed = await waitDom(cdp, `!document.querySelector('[data-testid="plugin-page"]')`, 5_000)
    check('la pagina Plugin si chiude prima del rimando (si torna alla chat)', closed)
    check('le Impostazioni si aprono (col plugin chiuso)', await openSettings())
    // il chiamante di sempre chiede la scheda 'app': si arriva all'azione dello
    // store DALLE REGHE DI REACT (la catena degli hook del componente delle
    // Impostazioni), come farebbe un componente che fa useStore(s => s.setSettingsTab)
    const called = await pageEval(cdp, `
      const el = document.querySelector('[role="dialog"] nav button')
      if (!el) return 'nessun elemento nel dialogo'
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
      let fiber = key ? el[key] : null
      while (fiber) {
        let hook = fiber.memoizedState
        let n = 0
        while (hook && typeof hook === 'object' && 'memoizedState' in hook && n++ < 200) {
          const v = hook.memoizedState
          if (typeof v === 'function' && v.name === 'setSettingsTab') { v('app'); return 'chiamata' }
          hook = hook.next
        }
        fiber = fiber.return
      }
      return 'azione setSettingsTab non trovata negli hook'
    `)
    check('PP3: setSettingsTab(\'app\') viene chiamata dal vivo', called === 'chiamata', String(called))
    check('PP3: setSettingsTab(\'app\') apre la pagina Plugin', closed && await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]')`, 5_000))
    check('PP3: setSettingsTab(\'app\') chiude le Impostazioni', await waitDom(cdp, `!document.querySelector('[role="dialog"]')`, 5_000))
  })

  // ---- pulizia ----
  stopApp()
  if (Number.isInteger(app?.pid)) await waitPidGone(app.pid)
  const { stopProbeDaemons } = await import('./lib/probe-daemons.mjs')
  const { cleanupProbeRun, countProbeDirs } = await import('./lib/probe-rm.mjs')
  await stopProbeDaemons(PREFIX, { log: () => undefined }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log: () => undefined, capMs: 20_000 }).catch((e) => log('pulizia:', e.message))
  // i valori dei token NON compaiono in NESSUN file della temporanea (log, database, cache)
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p); continue }
      if (st.size > 300 * 1024 * 1024) continue
      let text = ''
      try { text = readFileSync(p).toString('latin1') } catch { continue }
      if (text.includes(TOKEN_BUONO) || text.includes(TOKEN_SBAGLIATO)) hits.push(`${p.slice(TMP.length + 1)} (${text.includes(TOKEN_BUONO) ? 'token buono' : 'token sbagliato'})`)
    }
  }
  walk(TMP)
  check('PP2: i valori dei token di prova non compaiono in nessun file della temporanea (log, database, cache)', hits.length === 0, `${hits.length} file: ${hits.slice(0, 5).join(', ')}`)
  await stopProbeDaemons(PREFIX, { log: () => undefined }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [TMP], log: () => undefined, capMs: 20_000 }).catch((e) => log('pulizia:', e.message))
  const left = countProbeDirs(PREFIX, [TMP])
  check('pulizia: 0 cartelle sandbot-fase-plugin-pulita-* rimaste', left === 0, `rimaste ${left}`)
  const daemons = await import('./lib/probe-daemons.mjs').then((m) => m.findProbeDaemons(PREFIX))
  check('pulizia: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  // i server MCP finti avviati dal daemon escono da soli quando il padre muore: lo si CONTA
  await sleep(800)
  const fakes = spawnSync('/usr/bin/pgrep', ['-f', 'fake-plugin-pulita-mcp.mjs'], { encoding: 'utf8' })
  const fakePids = (fakes.stdout ?? '').split('\n').filter(Boolean).map(Number)
  check('pulizia: 0 server MCP finti rimasti', fakePids.length === 0, `pid ${fakePids.join(', ')}`)
} catch (e) {
  log('FATAL:', e.message)
  log(appLog.slice(-1200))
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: e.message })
  stopApp()
  try {
    const { stopProbeDaemons } = await import('./lib/probe-daemons.mjs')
    const { cleanupProbeRun } = await import('./lib/probe-rm.mjs')
    await stopProbeDaemons(PREFIX, { log: () => undefined }).catch(() => undefined)
    await cleanupProbeRun({ pids: Number.isInteger(app?.pid) ? [app.pid] : [], prefix: PREFIX, dirs: [TMP], log: () => undefined, capMs: 20_000 }).catch(() => undefined)
  } catch { /* già in corsa */ }
}
try { cdp?.sock.close() } catch { /* già chiusa */ }
provider.close()
mcpHttp.close()

const ok = results.filter((r) => r.ok).length
log(`CORSA fase-plugin-pulita${PRIMA ? ' (PRIMA)' : ''}: ${ok}/${results.length} controlli OK`)
if (results.some((r) => !r.ok)) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
