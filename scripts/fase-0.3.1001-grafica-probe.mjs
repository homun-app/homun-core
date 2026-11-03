#!/usr/bin/env node
// Sonda Electron della fase 0.3.1001 — GRAFICA (G1–G3): l'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, provider FINTO
// openai-compatible su 127.0.0.1. Come la sonda M1–M10 non apre un suo
// WebSocket: usa il bridge del renderer (window.sandbot) via CDP. Copre:
//   G1: due bot di colori DIVERSI (arancione c1 e blu-violetto c4) → la bolla
//       dei messaggi dell'utente ha lo STESSO colore calcolato, in chiaro e
//       in scuro (token --bubble-user, mai --bot-*);
//   G2: a pannello aperto (docked e overlay) il bottone PanelRight NON c'è
//       nel DOM, a pannello chiuso c'è; chiusura con ✕ o Esc → il focus
//       torna al bottone ricomparso; apertura → focus al primo controllo;
//   G3: la pillola del bot è un bottone che apre/chiude il pannello; 40 px a
//       sinistra della pillola è ancora la fascia drag-region (si trascina
//       la finestra); lo stesso nella chat di gruppo (pillola della squadra).
// A FINE SONDA si chiude ANCHE il daemon di sviluppo: il pid sta in
// daemon.lock dentro la cartella dati temporanea (mai il Portachiavi vero,
// mai la cartella dati vera: env SANDBOT_TEST_*), niente Docker, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-0.3.1001-grafica-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', '0.3.1001-grafica')
mkdirSync(DATA, { recursive: true })
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

// ---- il provider FINTO (openai-compatible, SSE su 127.0.0.1) ----
// Le risposte sono uno script in coda (qui bastano brevi conferme).
const script = []
const pushText = (text) => script.push({ text })
let providerPort = 0
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const next = script.shift() ?? { text: 'ok' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      if (next.text) chunk({ content: next.text })
      chunk({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
providerPort = providerServer.address().port

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
// Vincoli: env -i HOME/PATH + SANDBOT_TEST_USER_DATA/FAKE_KEYCHAIN/FAKE_SAFESTORAGE
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9338
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => { try { app.kill('SIGTERM') } catch { /* già via */ } }

/** Il pid del daemon di QUESA cartella dati (daemon.lock), se già scritto. */
const daemonPid = () => {
  try {
    const v = JSON.parse(readFileSync(join(DATA, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
/** A fine sonda chiude ANCHE il daemon di sviluppo (Vincoli, fase 0.3.1001). */
const stopDaemon = async () => {
  const pid = daemonPid()
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
}

// ---- CDP: pagina del renderer + finestra (bounds) ----
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
let page = null
for (let i = 0; i < 150; i++) {
  try {
    const list = await httpJson('/json/list')
    const target = list.find((t) => t.type === 'page')
    if (target) {
      page = await openCdp(target.webSocketDebuggerUrl)
      break
    }
  } catch { /* il debugger non è ancora su */ }
  await sleep(200)
}
if (!page) throw new Error('nessuna pagina CDP: log app:\n' + appLog.slice(-1500))
log('CDP collegato al renderer')

/** Valuta un'espressione (async) nel renderer e ne torna il valore JSON. */
const pageEval = async (expr) => {
  const r = await page.send('Runtime.evaluate', {
    expression: `((async () => { ${expr} })())`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
/** Chiamata RPC attraverso il bridge VERO del renderer (window.sandbot). */
const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
/**
 * Larghezza «della finestra» per il layout: si emula il VIEWPORT della pagina
 * (il layout reagisce a window.innerWidth, che l'emulazione riporta davvero).
 */
const setWindowWidth = async (width, height = 800) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
  const w = await pageEval('return window.innerWidth')
  if (w !== width) throw new Error(`viewport emulato non applicato: ${w} ≠ ${width}`)
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
const waitDom = async (exprTrue, timeoutMs = 30_000, step = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pageEval(`return !!(${exprTrue})`)) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}

/** Scrive nel compositore e preme Invio (il messaggio parte dall'UI). */
const uiSend = (text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 120))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'inviato'
`)

// ---- helper DOM dei controlli G2/G3 (valutati nel renderer) ----
// Il bottone PanelRight: l'unico con l'icona lucide-panel-right dentro
const PANEL_RIGHT = `(() => [...document.querySelectorAll('button')].filter((b) => b.querySelector('svg.lucide-panel-right')))()`
// La pillola: il bottone con aria-expanded nella fascia alta (bot o squadra)
const pillByLabel = (label) => `
  return (() => {
    const b = [...document.querySelectorAll('button[aria-expanded]')]
      .find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)} && x.offsetParent !== null)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { expanded: b.getAttribute('aria-expanded'), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), h: Math.round(r.height) }
  })()`
const clickPill = (label) => pageEval(`
  const b = [...document.querySelectorAll('button[aria-expanded]')]
    .find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)} && x.offsetParent !== null)
  if (!b) throw new Error('pillola non trovata: ' + ${JSON.stringify(label)})
  b.click()
  return 'cliccata'
`)
const clickByLabel = (label) => pageEval(`
  const b = [...document.querySelectorAll('button')]
    .find((x) => (x.getAttribute('aria-label') === ${JSON.stringify(label)} || x.title === ${JSON.stringify(label)}) && x.offsetParent !== null)
  if (!b) throw new Error('bottone non trovato: ' + ${JSON.stringify(label)})
  b.click()
  return 'cliccato'
`)
/** Clicca il bottone PanelRight (quello con l'icona lucide-panel-right):
 *  dopo G3 anche la pillola porta lo stesso aria-label, vanno distinti. */
const clickPanelRight = () => pageEval(`
  const b = [...document.querySelectorAll('button')].find((x) => x.querySelector('svg.lucide-panel-right') && x.offsetParent !== null)
  if (!b) throw new Error('bottone PanelRight non trovato')
  b.click()
  return 'cliccato'
`)
/** Clicca la riga di un bot (o squadra) nella barra a sinistra. */
const clickSidebar = (name) => pageEval(`
  const sidebar = document.querySelector('aside')
  const b = sidebar && [...sidebar.querySelectorAll('button')]
    .find((x) => x.textContent.trim().startsWith(${JSON.stringify(name)}) && x.offsetParent !== null && !x.getAttribute('aria-expanded'))
  if (!b) throw new Error('riga della barra non trovata: ' + ${JSON.stringify(name)})
  b.click()
  return 'selezionato'
`)
/** Il colore CALCOLATO dell'ultima bolla utente visibile (bg + testo). */
const lastUserBubbleColors = () => pageEval(`
  return (() => {
    const bubbles = [...document.querySelectorAll('div')].filter((d) => String(d.className).includes('bg-[var(--bubble-user)]'))
    const last = bubbles[bubbles.length - 1]
    if (!last) return null
    const cs = getComputedStyle(last)
    return { bg: cs.backgroundColor, fg: cs.color, text: last.textContent.slice(0, 40) }
  })()
`)
/** Porta il pannello del bot a CHIUSO (✕ se aperto docked/overlay, pillola altrimenti). */
const ensurePanelClosed = () => pageEval(`
  const pr = [...document.querySelectorAll('button')].filter((b) => b.querySelector('svg.lucide-panel-right'))
  if (pr.length > 0) return 'già chiuso'
  const x = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Chiudi il pannello' && b.offsetParent !== null)
  const pill = [...document.querySelectorAll('button[aria-expanded]')]
    .find((b) => b.getAttribute('aria-label')?.startsWith('Nascondi il pannello del bot') && b.offsetParent !== null)
  ;(x ?? pill)?.click()
  return 'chiuso'
`)

try {
  // il preload espone window.sandbot appena la pagina è pronta
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- configurazione: provider finto + DUE bot di colori diversi ----
  log('configuro provider finto e i due bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const orange = agents0[0]
  if (!orange) throw new Error('nessun bot (onboarding?)')
  // il principale è arancione c1 (forzato per determinismo); il secondo bot
  // nasce blu-violetto c4 — due colori DIVERSI per G1
  await rpc(`updateAgent(${JSON.stringify(orange.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto', avatar: { family: 'h-creature', color: 'c1' } })})`)
  const violet = await rpc(`createAgent(${JSON.stringify('Viola')}, ${JSON.stringify('Bot di prova blu-violetto per G1.')})`)
  await rpc(`updateAgent(${JSON.stringify(violet.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto', avatar: { family: 'jelly', color: 'c4' } })})`)
  log('bot ok, ricarico la UI…')
  await page.send('Page.reload')
  check('setup compositore pronto', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await setWindowWidth(1440)

  // ============ G2 — a pannello aperto resta solo la ✕ ============
  // all'avvio il pannello è APERTO (default ui.rightPanel=true): a 1440 è docked
  await sleep(600)
  let nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  const hasClose = await pageEval(`return !![...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Chiudi il pannello' && b.offsetParent !== null)`)
  check('G2a a pannello APERTO (docked) il bottone PanelRight NON c\'è nel DOM, la ✕ sì',
    nPanelRight === 0 && hasClose === true, `panelRight=${nPanelRight} chiudi=${hasClose}`)

  // chiusura con la ✕ → il bottone ricompare e PRENDE il focus
  await clickByLabel('Chiudi il pannello')
  await sleep(500)
  const focusAfterX = await pageEval(`return (() => { const a = document.activeElement; return a ? { label: a.getAttribute('aria-label'), icon: !!a.querySelector('svg.lucide-panel-right') } : null })()`)
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  check('G2b chiusura con la ✕ → PanelRight ricompare ed è FOCUSED',
    nPanelRight === 1 && focusAfterX?.icon === true && focusAfterX?.label === 'Mostra il pannello del bot',
    `panelRight=${nPanelRight} focus=${JSON.stringify(focusAfterX)}`)

  // apertura con il bottone → il focus va al primo controllo del pannello (✕)
  await clickPanelRight()
  await sleep(500)
  const focusAfterOpen = await pageEval(`return (() => { const a = document.activeElement; return a ? a.getAttribute('aria-label') : null })()`)
  check('G2c apertura (docked) → focus al primo controllo del pannello (la ✕)',
    focusAfterOpen === 'Chiudi il pannello', `focus=${focusAfterOpen}`)

  // chiusura con la pillola? No: G3. Qui Esc in OVERLAY: a 900 il pannello galleggia
  await setWindowWidth(900)
  const isOverlay = await pageEval(`return !!document.querySelector('[aria-modal="true"]')`)
  check('G2d a 900 il pannello aperto è OVERLAY (foglio col velo)', isOverlay === true)
  await pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await sleep(600)
  const focusAfterEsc = await pageEval(`return (() => { const a = document.activeElement; return a ? { label: a.getAttribute('aria-label'), icon: !!a.querySelector('svg.lucide-panel-right') } : null })()`)
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  const overlayGone = await pageEval(`return !document.querySelector('[aria-modal="true"]')`)
  check('G2e dopo Esc l\'overlay è chiuso e il focus è sul bottone PanelRight',
    overlayGone === true && nPanelRight === 1 && focusAfterEsc?.icon === true && focusAfterEsc?.label === 'Mostra il pannello del bot',
    `overlayGone=${overlayGone} panelRight=${nPanelRight} focus=${JSON.stringify(focusAfterEsc)}`)

  // ============ G3 — la pillola del bot apre/chiude il pannello ============
  await setWindowWidth(1440)
  await sleep(400)
  // pannello CHIUSO: clic sulla pillola → APERTO
  await clickPill('Mostra il pannello del bot')
  await sleep(500)
  let pill = await pageEval(pillByLabel('Nascondi il pannello del bot'))
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  check('G3a clic sulla pillola → pannello APERTO (aria-expanded, PanelRight via)',
    pill?.expanded === 'true' && nPanelRight === 0, `pill=${JSON.stringify(pill)} panelRight=${nPanelRight}`)
  // secondo clic → CHIUSO
  await clickPill('Nascondi il pannello del bot')
  await sleep(500)
  pill = await pageEval(pillByLabel('Mostra il pannello del bot'))
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  check('G3b secondo clic sulla pillola → pannello CHIUSO (PanelRight torna)',
    pill?.expanded === 'false' && nPanelRight === 1, `pill=${JSON.stringify(pill)} panelRight=${nPanelRight}`)
  // 40 px a SINISTRA della pillola: fascia drag-region, non un bottone
  pill = await pageEval(pillByLabel('Mostra il pannello del bot'))
  const leftOfPill = await pageEval(`
    return (() => {
      const p = ${JSON.stringify(pill)}
      const x = Math.max(1, p.left - 40)
      const y = p.top + p.h / 2
      const el = document.elementFromPoint(x, y)
      if (!el) return { tag: null }
      return { tag: el.tagName, cls: String(el.className).slice(0, 50), inDrag: !!el.closest('.drag-region'), isButtonOrIn: !!el.closest('button') }
    })()
  `)
  check('G3c 40 px a sinistra della pillola è la fascia drag-region (non un bottone)',
    leftOfPill?.inDrag === true && leftOfPill?.isButtonOrIn === false, JSON.stringify(leftOfPill))
  // e la pillola stessa riceve i clic (niente pointer-events:none)
  const pillHit = await pageEval(`
    return (() => {
      const p = ${JSON.stringify(pill)}
      const el = document.elementFromPoint((p.left + p.right) / 2, p.top + p.h / 2)
      return el ? !!el.closest('button[aria-expanded]') : false
    })()
  `)
  check('G3d il centro della pillola è un bottone cliccabile (hit-test)', pillHit === true)

  // ---- G3 nella chat di gruppo: la pillola della squadra fa lo stesso ----
  const group = await rpc(`groupCreate(${JSON.stringify('Squadra Prova')}, ${JSON.stringify([orange.id, violet.id])}, ${JSON.stringify(orange.id)}, ${JSON.stringify('sonda G3')})`)
  check('setup squadra creata coi due bot', !!group?.id, `id=${group?.id}`)
  await sleep(800)
  await clickSidebar('Squadra Prova')
  check('G3e la vista squadra è aperta (pillola dei membri presente)',
    await waitDom(`!![...document.querySelectorAll('button[aria-expanded]')].find((b) => b.getAttribute('aria-label') === 'Mostra il pannello dei membri')`, 10_000))
  await sleep(400)
  // il pannello era chiuso: PanelRight presente → clic pillola squadra → APERTO
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  await clickPill('Mostra il pannello dei membri')
  await sleep(500)
  let teamPill = await pageEval(pillByLabel('Nascondi il pannello dei membri'))
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  check('G3f squadra: clic pillola → pannello membri APERTO (PanelRight via)',
    teamPill?.expanded === 'true' && nPanelRight === 0, `pill=${JSON.stringify(teamPill)} panelRight=${nPanelRight}`)
  await clickPill('Nascondi il pannello dei membri')
  await sleep(500)
  teamPill = await pageEval(pillByLabel('Mostra il pannello dei membri'))
  nPanelRight = await pageEval(`return ${PANEL_RIGHT}.length`)
  check('G3g squadra: secondo clic → pannello CHIUSO',
    teamPill?.expanded === 'false' && nPanelRight === 1, `pill=${JSON.stringify(teamPill)} panelRight=${nPanelRight}`)
  teamPill = await pageEval(pillByLabel('Mostra il pannello dei membri'))
  const leftOfTeamPill = await pageEval(`
    return (() => {
      const p = ${JSON.stringify(teamPill)}
      const el = document.elementFromPoint(Math.max(1, p.left - 40), p.top + p.h / 2)
      if (!el) return { tag: null }
      return { inDrag: !!el.closest('.drag-region'), isButtonOrIn: !!el.closest('button') }
    })()
  `)
  check('G3h squadra: 40 px a sinistra della pillola è fascia drag-region',
    leftOfTeamPill?.inDrag === true && leftOfTeamPill?.isButtonOrIn === false, JSON.stringify(leftOfTeamPill))

  // ============ G1 — due bot di colori diversi, UN colore di bolla ============
  await clickSidebar(orange.name ?? 'Bot')
  await sleep(500)
  pushText('Pronta la bolla arancione… anzi, neutra.')
  await uiSend('Messaggio del bot arancione per la bolla.')
  check('G1a bolla utente visibile nella chat del bot arancione',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => String(d.className).includes('bg-[var(--bubble-user)]') && d.textContent.includes('bot arancione'))`, 15_000))
  const orangeLight = await lastUserBubbleColors()
  await clickSidebar('Viola')
  await sleep(500)
  pushText('Anche qui, stessa bolla.')
  await uiSend('Messaggio del bot blu-violetto per la bolla.')
  check('G1b bolla utente visibile nella chat del bot blu-violetto',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => String(d.className).includes('bg-[var(--bubble-user)]') && d.textContent.includes('blu-violetto'))`, 15_000))
  const violetLight = await lastUserBubbleColors()
  check('G1c CHIARO: due bot di colori diversi → STESSO colore calcolato della bolla',
    !!orangeLight && !!violetLight && orangeLight.bg === violetLight.bg && orangeLight.fg === violetLight.fg,
    `arancione=${orangeLight?.bg}/${orangeLight?.fg} viola=${violetLight?.bg}/${violetLight?.fg}`)
  check('G1d CHIARO: la bolla è il token neutro --bubble-user, NON l\'arancione del bot',
    orangeLight?.bg === 'oklch(0.208 0.042 265.755)' && orangeLight?.fg === 'oklch(0.984 0.003 247.858)',
    JSON.stringify(orangeLight))
  // tema SCURO: la classe .dark cambia i token → le due chat restano UGUALI
  await pageEval(`document.documentElement.classList.add('dark')`)
  await sleep(300)
  const violetDark = await lastUserBubbleColors()
  await clickSidebar(orange.name ?? 'Bot')
  await sleep(500)
  const orangeDark = await lastUserBubbleColors()
  check('G1e SCURO: due bot di colori diversi → STESSO colore calcolato della bolla',
    !!orangeDark && !!violetDark && orangeDark.bg === violetDark.bg && orangeDark.fg === violetDark.fg,
    `arancione=${orangeDark?.bg}/${orangeDark?.fg} viola=${violetDark?.bg}/${violetDark?.fg}`)
  check('G1f SCURO: la bolla è il token neutro del tema',
    orangeDark?.bg === 'oklch(0.929 0.013 255.508)' && orangeDark?.fg === 'oklch(0.208 0.042 265.755)', JSON.stringify(orangeDark))
  await pageEval(`document.documentElement.classList.remove('dark')`)
  await sleep(300)

  // ============ catture: 1440/900 × chiaro/scuro × aperto/chiuso ============
  // (il bot in chat è quello ARANCIONE, richiesto dalla fase)
  for (const width of [1440, 900]) {
    await setWindowWidth(width)
    for (const dark of [false, true]) {
      if (dark) await pageEval(`document.documentElement.classList.add('dark')`)
      for (const opened of [true, false]) {
        // stato noto: prima si CHIUDE (✕ o pillola), poi si riapre se serve
        await ensurePanelClosed()
        await sleep(400)
        if (opened) { await clickPill('Mostra il pannello del bot'); await sleep(500) }
        await shot(`g-${width}-${dark ? 'scuro' : 'chiaro'}-${opened ? 'aperto' : 'chiuso'}.png`)
      }
      if (dark) await pageEval(`document.documentElement.classList.remove('dark')`)
    }
  }
  // fine: il pannello resta come l'ultima cattura (chiuso) — indifferente, la
  // cartella dati è temporanea e verrà rimossa
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  console.error(appLog.slice(-1200))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // Vincoli (fase 0.3.1001 grafica): a fine sonda si chiude ANCHE il daemon
  // di sviluppo lanciato dall'app su questa cartella temporanea
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid()
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
