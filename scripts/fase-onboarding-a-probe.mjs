#!/usr/bin/env node
// Sonda Electron della fase «guida» (G8): la guida del primo avvio DALLA
// FINESTRA, con CLIC VERI via CDP. REGOLA NUOVA: la guida si attraversa SOLO
// con clic veri — MAI saveProvider/advance via RPC per i passi della guida
// (fu proprio quello a nascondere il difetto del clic che non faceva nulla).
// L'app VERA (build di sviluppo in out/) su cartelle dati TEMPORANEE vuote,
// Portachiavi finto, provider FINTO openai-compatible su 127.0.0.1 (con
// l'elenco /v1/models per la prova della chiave). NESSUNA RETE VERA.
// Copre: il percorso intero Tu → Modello (prova chiave sbagliata/giusta,
// modello consigliato) → Permessi → Pronto → «Apri la chat»; il riavvio a
// metà guida; «Salta per ora» + «Riprendi» e «Rifai da capo» da Impostazioni
// per chi ha già scritto (OAC4); il compositore con la card del focus
// aperta; la SECONDA attesa del modello (OAC2); il doppio clic sul focus
// (OAC3); le larghezze 1440/1000/820 senza scorrimento orizzontale.
// OB (fase onboarding-b): il passo COMPUTER dalla finestra, sempre con clic
// veri — macchina «supportata» (fatti finti) e container assente: il
// pacchetto FINTO è servito dalla sonda su 127.0.0.1, pkgutil/spctl/open
// FINTI (scripts/fake-*.mjs), l'open finto «installa» la CLI finta nel PATH
// di prova. Copre: il percorso intero (download, verifica, Installer,
// installazione, servizio, kernel, immagine, ready, happy, Continua,
// «Computer: pronto»), lo sha256 sbagliato (errore, NESSUN open), il
// riavvio su awaiting-installer, «Continua» durante l'immagine (la riga del
// pannello arriva a «Pronto» DOPO la guida) e la macchina non supportata
// (niente passo). Catture ob-* in docs/catture/onboarding-a/.
// Catture guida-v2-* e oac-* in docs/catture/onboarding-a/. A FINE SONDA si
// chiude ANCHE il daemon di sviluppo, la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-onboarding-a-')
const SHOTS = join(ROOT, 'docs', 'catture', 'onboarding-a')
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

// ---- il provider FINTO (openai-compatible su 127.0.0.1) ----
const GOOD_KEY = 'chiave-finta-di-prova'
const chatRequests = []
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
    res.end(JSON.stringify({ data: [{ id: 'finto' }, { id: 'finto-sciocco' }] }))
    return
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      chatRequests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      chunk({ content: 'Ecco fatto: sono qui.' })
      chunk({}, 'stop')
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
const callsWith = (text) => chatRequests.filter((c) => JSON.stringify(c).includes(text)).length

// ---- OB6: il PACCHETTO FINTO, servito su 127.0.0.1 dalla sonda ----
// byte FISSI (niente download vero): sha256 e dimensione calcolati una volta
// e passati al daemon con gli override SANDBOT_TEST_PKG_*
import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
const PKG_BYTES = Buffer.alloc(3_000_000)
for (let i = 0; i < PKG_BYTES.length; i++) PKG_BYTES[i] = (i * 7 + 13) % 251
const PKG_SHA = createHash('sha256').update(PKG_BYTES).digest('hex')
// il download DURA (30 KB ogni 50 ms ≈ 5 s): dalla finestra si deve VEDERE
// l'avanzamento, non un lampo — è la prova del passo, non una gara
const serveSlow = (res, from, to, total) => {
  res.writeHead(res.statusCode === 206 ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(to - from + 1),
    ...(res.statusCode === 206 ? { 'content-range': `bytes ${from}-${to}/${total}` } : {})
  })
  void (async () => {
    for (let at = from; at <= to; at += 30_000) {
      res.write(PKG_BYTES.subarray(at, Math.min(at + 30_000, to + 1)))
      await new Promise((r) => setTimeout(r, 50))
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

// i comandi FINTI come wrapper eseguibili (il PATH del daemon è minimo): gli
// .mjs veri stanno in scripts/, il wrapper invoca il node ESPPLICITO
const wrap = (dir, name, script) => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, 'scripts', script)}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}
// la cartella del PATH di prova: VUOTA finché l'open finto non «installa»
const OB_BIN = join(TMP, 'ob-bin')
mkdirSync(OB_BIN, { recursive: true })
const OB_CLI_SRC = wrap(TMP, 'ob-cli-container', 'fake-container.mjs')
const FAKE_PKGUTIL = wrap(TMP, 'ob-pkgutil', 'fake-pkgutil.mjs')
const FAKE_SPCTL = wrap(TMP, 'ob-spctl', 'fake-spctl.mjs')
const FAKE_OPEN = wrap(TMP, 'ob-open', 'fake-open.mjs')
const obEnv = (over = {}) => ({
  SANDBOT_TEST_FAKE_PLATFORM: 'darwin',
  SANDBOT_TEST_FAKE_ARCH: 'arm64',
  SANDBOT_TEST_FAKE_MACOS_MAJOR: '26',
  PATH: `${OB_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  // OBV5: prima dell'«installazione» finta il percorso NON esiste → ENOENT
  // (mai la CLI vera di /usr/local/bin); dopo, è il wrapper della finta.
  // L'appRoot di prova lo decide OGNI fase (freshOb): il kernel è un FILE lì
  HOMUN_CONTAINER_PATH: join(OB_BIN, 'container'),
  // OBV5: la macchina finta dopo l'installazione è ACCESA ma SENZA kernel
  // (come quella vera): il kernel lo mette `kernel set` col consenso — e
  // dopo, il FILE si vede (kernel-missing è passivo nella finta)
  SANDBOT_TEST_CONTAINER_MODE: 'kernel-missing',
  SANDBOT_TEST_PKG_URL: `http://127.0.0.1:${pkgPort}/finto.pkg`,
  SANDBOT_TEST_PKG_SHA256: PKG_SHA,
  SANDBOT_TEST_PKG_SIZE: String(PKG_BYTES.length),
  SANDBOT_TEST_PKGUTIL: FAKE_PKGUTIL,
  SANDBOT_TEST_SPCTL: FAKE_SPCTL,
  SANDBOT_TEST_OPEN: FAKE_OPEN,
  SANDBOT_TEST_OPEN_DELAY_MS: '4000',
  SANDBOT_TEST_OPEN_CLI_SRC: OB_CLI_SRC,
  SANDBOT_TEST_OPEN_INSTALL_DIR: OB_BIN,
  SANDBOT_TEST_CONTAINER_LOG: '', // lo decide ogni fase (file nel TMP)
  ...over
})

// ---- l'app Electron (build di sviluppo) ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9357
let appLog = ''
let app = null
// OB6: extraEnv porta gli override di prova di OGNI fase (fatti macchina,
// pacchetto finto, strumenti finti); le fasi 1–5 fingono una macchina NON
// supportata: il passo Computer non c'è e il percorso resta quello di oggi
const launchApp = (dataDir, extraEnv = {}) => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: dataDir,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
      SANDBOT_TEST_FAKE_BROWSER: '1',
      SANDBOT_TEST_FAKE_ARCH: 'x86_64',
      // OBV5: `container` ORA è installato sul Mac (/usr/local/bin, primo nel
      // PATH): le fasi senza OB_BIN non lo chiamano MAI — questo percorso
      // inesistente vince su PATH e sul fallback (le fasi OB lo passano sopra
      // con OB_BIN/container: prima dell'«installazione» finta → ENOENT)
      HOMUN_CONTAINER_PATH: join(TMP, 'mai', 'container'),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
const daemonPid = (dataDir) => {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
const stopDaemon = async (dataDir) => {
  const pid = daemonPid(dataDir)
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ } // come la sonda box-container: SIGTERM → 3 s → SIGKILL
}
const stopEverything = async (dataDir) => {
  stopApp()
  await sleep(600)
  await stopDaemon(dataDir)
  // rete di sicurezza: l'helper condiviso cerca dall'AMBIENTE i daemon di questa sonda
  const r = await stopProbeDaemons('sandbot-fase-onboarding-a')
  if (r.left > 0) throw new Error(`daemon rimasti vivi: ${r.left}`)
  // la porta del debugger dev'essere LIBERA prima di riavviare (il nuovo
  // processo altrimenti non fa il bind e la pagina CDP non c'è mai)
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`) } catch { return }
    await sleep(200)
  }
  throw new Error('la porta CDP non si libera')
}

// ---- CDP: pagina del renderer ----
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
const setWindowWidth = async (width, height = 900) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
  const w = await pageEval('return window.innerWidth')
  if (w !== width) throw new Error(`viewport emulato non applicato: ${w} ≠ ${width}`)
}
const shot = async (name) => {
  // GC4.5: la cattura aspetta la fine delle animazioni FINITE (le catture
  // pronto-* erano prese a metà entrata: titolo e righe sbiaditi e il
  // puntino «Permessi» ancora largo in transizione) — più un'attesa ≥ 500 ms
  // dall'ultimo cambio di passo; le animazioni infinite (galleggio, respiro)
  // non si aspettano
  await sleep(500)
  await waitDom(
    `document.getAnimations({ subtree: true }).filter((a) => { const t = a.effect?.getTiming?.(); return t && t.iterations !== Infinity && a.playState !== 'finished' }).length === 0`,
    8_000, 200
  )
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
const dark = async (on) => {
  await pageEval(`document.documentElement.classList.${on ? 'add' : 'remove'}('dark')`)
  await sleep(350)
}
/** avvia l'app su una cartella dati e aspetta la pagina (con la finestra a 1440) */
const startApp = async (dataDir, extraEnv = {}) => {
  mkdirSync(dataDir, { recursive: true })
  app = launchApp(dataDir, extraEnv)
  page = await waitForPage()
  const splashSeenHere = await waitDom(`!!document.querySelector('[data-testid="boot-splash"]')`, 8_000, 60)
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }
  await setWindowWidth(1440)
  return splashSeenHere
}

/** dai Permessi alla chat, clic per clic (con le attese tra un clic e l'altro) */
const approvalsToChat = async () => {
  await clickTestid('guide-approvals-ask')
  if (!(await waitDom(`!document.querySelector('[data-testid="guide-continue"]')?.disabled`, 10_000))) throw new Error('Continua non attivo dopo la scelta dei permessi')
  await clickTestid('guide-continue') // → Pronto
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-ready"]')`, 10_000))) throw new Error('il passo Pronto non arriva')
  await clickTestid('guide-continue') // «Apri la chat»
  if (!(await waitDom(`!!document.querySelector('form textarea')`, 20_000))) throw new Error('la chat non arriva')
}

const guideStep = () => pageEval(`return document.querySelector('[data-testid^="guide-step-"]')?.getAttribute('data-testid') ?? null`)
const visibleText = () => pageEval(`return document.body.innerText`)
const countText = async (needle) => ((await visibleText()).split(needle).length - 1)

// ---- il percorso della guida con CLIC VERI (il cuore della sonda) ----

/** il passo Tu: nome, faccia, colore (tutti clic veri) */
const tuStep = async ({ name = 'Nanna', family = 'jelly', color = 'c3' } = {}) => {
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 30_000))) throw new Error('la guida non è al passo Tu')
  await setInputValue('guide-name-input', name)
  await clickTestid(`guide-family-${family}`)
  await clickTestid(`guide-color-${color}`)
  // l'anteprima è immediata: la mascotte grande ha già la faccia scelta
  const preview = await pageEval(`return !!document.querySelector('[data-testid="guide-scene"] .bot--${family}')`)
  await clickTestid('guide-continue')
  return preview
}

/** il passo Modello dal pannello «Compatibile OpenAI» col provider finto */
const modelStepViaCompatibile = async ({ key = GOOD_KEY } = {}) => {
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-provider-others"]')`, 20_000))) throw new Error('la griglia dei provider non si vede')
  await clickTestid('guide-provider-others')
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-other-openai-compatible"]')`, 10_000))) throw new Error('l\'elenco Altri… non si apre')
  await clickTestid('guide-other-openai-compatible')
  await setInputValue('guide-baseurl-input', PROVIDER_BASE)
  await setInputValue('guide-key-input', key)
  await clickTestid('guide-key-probe')
}

try {
/** ---------------- FASE 1: il percorso intero, con clic veri ---------------- */
log('FASE 1: il percorso della guida, tutto con clic veri…')
const DATA1 = join(TMP, 'uno')
const splashSeen = await startApp(DATA1)
check('G8-1a la finestra carica finché il daemon non dice lo stato (boot splash)', splashSeen, splashSeen ? '' : 'splash non visto')
check('G8-1b la guida appare al primo avvio (passo Tu, non più «Prepariamo Homun»)',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]') && document.body.innerText.includes('Diamo una faccia al tuo bot')`, 25_000))
check('G8-1c la scena: la mascotte Bot VERA (svg) e la nuvoletta col saluto del mockup',
  await waitDom(`!!document.querySelector('[data-testid="guide-scene"] svg') && document.body.innerText.includes('Ciao! Sono il tuo nuovo bot. Come mi chiami?')`, 10_000))
check('G8-1d niente emoji nella guida (il 🧚 è stato via)', !((await visibleText()).includes('🧚')))
await shot('guida-v2-tu-1440-chiaro.png')
await dark(true)
await shot('guida-v2-tu-1440-scuro.png')
await dark(false)

// GC6.3: l'anello della faccia scelta nella prima colonna NON è mai tagliato:
// nessun antenato con overflow non visible taglia il rettangolo della scheda
// allargato dello spessore dell'anello (a 1000 la colonna dei passi riempie
// tutta la larghezza: è lì che l'anello sbordava dal contenitore che scorre)
const anelloAt = async (w) => {
  await setWindowWidth(w)
  const v = await pageEval(`return (() => {
    const el = document.querySelector('[data-testid="guide-family-h-creature"][aria-pressed="true"]')
    if (!el) return 'tile non trovata'
    const ring = 2
    const r = el.getBoundingClientRect()
    const box = { left: r.left - ring, top: r.top - ring, right: r.right + ring, bottom: r.bottom + ring }
    let n = el.parentElement
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const b = n.getBoundingClientRect()
        const clip = {
          left: b.left + (parseFloat(cs.borderLeftWidth) || 0),
          right: b.right - (parseFloat(cs.borderRightWidth) || 0),
          top: b.top + (parseFloat(cs.borderTopWidth) || 0),
          bottom: b.bottom - (parseFloat(cs.borderBottomWidth) || 0)
        }
        const side = box.left < clip.left - 0.5 ? 'left' : box.right > clip.right + 0.5 ? 'right' : box.top < clip.top - 0.5 ? 'top' : box.bottom > clip.bottom + 0.5 ? 'bottom' : null
        if (side) {
          return JSON.stringify({ side, tag: n.tagName, cls: String(n.className).slice(0, 80), box, clip: { left: clip.left, right: clip.right, top: clip.top, bottom: clip.bottom } })
        }
      }
      n = n.parentElement
    }
    return 'ok'
  })()`)
  return v
}
await setInputValue('guide-name-input', 'Nanna')
// la faccia della PRIMA colonna («Creatura»): è lì che l'anello si tagliava
await clickTestid('guide-family-h-creature')
check('GC6.3a a 1440 l\'anello della faccia scelta non è tagliato da nessun antenato', (await anelloAt(1440)) === 'ok', await anelloAt(1440))
check('GC6.3b a 1000 (colonna piena) l\'anello non è tagliato', (await anelloAt(1000)) === 'ok', await anelloAt(1000))
await setWindowWidth(1440)
await shot('gc-anello-tu-1440-chiaro.png')

const previewOk = await tuStep()
check('G8-1e l\'anteprima della faccia è immediata sulla mascotte grande', previewOk === true)
check('G8-1f «Continua» del passo Tu salva nome e avatar (agents:update, clic vero)',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 15_000))
const agents1 = await rpc('listAgents()')
check('G8-1g il bot principale ha il nome e l\'avatar scelti', agents1[0]?.name === 'Nanna' && agents1[0]?.avatar?.family === 'jelly' && agents1[0]?.avatar?.color === 'c3',
  `${agents1[0]?.name} ${JSON.stringify(agents1[0]?.avatar)}`)

// la griglia del passo Modello
check('G8-1h la griglia: Anthropic (consigliato), OpenAI, OpenRouter, Altri…, Integrato — niente Google',
  await waitDom(`!!document.querySelector('[data-testid="guide-provider-anthropic"]') && !!document.querySelector('[data-testid="guide-provider-others"]') && !!document.querySelector('[data-testid="guide-provider-local"]') && !document.body.innerText.includes('Google')`, 10_000)
  && (await visibleText()).includes('consigliato'))
await shot('guida-v2-modello-1440-chiaro.png')
await dark(true)
await shot('guida-v2-modello-1440-scuro.png')
await dark(false)

// le larghezze: mai scorrimento orizzontale, mascotte sempre visibile
for (const w of [1000, 820]) {
  await setWindowWidth(w)
  const noHScroll = await pageEval('return document.documentElement.scrollWidth <= window.innerWidth')
  const mascotVisible = await pageEval(`return !!(document.querySelector('[data-testid="guide-scene"] .bot') && document.querySelector('[data-testid="guide-scene"] .bot').getBoundingClientRect().width > 0)`)
  check(`G8-1i a ${w}px niente scorrimento orizzontale e mascotte visibile`, noHScroll === true && mascotVisible === true,
    `scrollWidth ${await pageEval('return document.documentElement.scrollWidth')} vs ${w}`)
  if (w === 1000) await shot('guida-v2-modello-1000-chiaro.png')
  if (w === 820) await shot('guida-v2-modello-820-chiaro.png')
}
await setWindowWidth(1440)

// «Altri…» → «Compatibile OpenAI»: chiave SBAGLIATA (il finto risponde 401)
await modelStepViaCompatibile({ key: 'chiave-sbagliata' })
check('G8-1l chiave sbagliata: la frase dell\'errore in parole (invalid-key)',
  await waitDom(`!!document.querySelector('[data-testid="guide-probe-error"]') && document.body.innerText.includes('Questa chiave non funziona') && document.body.innerText.includes('non autorizzata')`, 15_000),
  await pageEval(`return document.querySelector('[data-testid="guide-probe-error"]')?.innerText ?? ''`))
// GC1.4: dopo la chiave sbagliata la mascotte è in ATTESA (data-mood)
check('GC1-b chiave sbagliata: la mascotte è in attesa (data-mood="waiting")',
  await waitDom(`document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') === 'waiting'`, 10_000),
  `mood=${await pageEval(`return document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') ?? null`)}`)
await shot('oac-chiave-sbagliata-1440-chiaro.png')

// «← Altri provider»: dal pannello all'elenco Altri…, e di lì alla griglia
await clickTestid('guide-back-providers')
check("G8-1m «← Altri provider» torna all'elenco Altri… e poi alla griglia",
  await waitDom(`!!document.querySelector('[data-testid="guide-other-openai-compatible"]')`, 10_000)
  && (await clickTestid('guide-back-providers'), true)
  && await waitDom(`!!document.querySelector('[data-testid="guide-provider-others"]')`, 10_000))

// chiave GIUSTA: «Funziona», il consigliato già scelto, Continua
await modelStepViaCompatibile()
check('G8-1n chiave giusta: la riga verde «Funziona. La chiave resta nel Portachiavi del Mac.»',
  await waitDom(`!!document.querySelector('[data-testid="guide-probe-ok"]')`, 15_000))
const recommendedPressed = await pageEval(`return document.querySelector('[data-testid="guide-model-finto"]')?.getAttribute('aria-pressed')`)
check('G8-1o il modello consigliato è GIÀ scelto (il primo dell\'elenco: finto)', recommendedPressed === 'true', `aria-pressed=${recommendedPressed}`)
// GC1.4: dopo «Funziona» la mascotte è FELICE e la nuvoletta cambia frase
// SUBITO, senza aspettare il «Continua» (il modelReady del daemon arriva dopo)
check('GC1-a dopo «Funziona» la mascotte è felice (data-mood="happy") e la nuvoletta dice la frase della prova riuscita',
  await waitDom(`document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') === 'happy' && document.body.innerText.includes('Funziona! Sento già i pensieri.')`, 10_000),
  `mood=${await pageEval(`return document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') ?? null`)}`)
await shot('guida-v2-modello-pannello-1440-chiaro.png')
await clickTestid('guide-continue')
check('G8-1p «Continua» del passo Modello porta ai Permessi (salvataggio col clic, mai RPC)',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 20_000))
const main1 = await rpc(`settingsGet('models.main', null)`)
const providers1 = await rpc('listProviders()')
const saved1 = providers1.find((p) => p.kind === 'openai-compatible')
check('G8-1q models.main scritto col modello scelto e il provider salvato con la chiave nel Portachiavi',
  main1?.model === 'finto' && !!saved1 && saved1.id === main1.providerId && saved1.hasKey === true,
  `main=${JSON.stringify(main1)}`)

// Permessi → Pronto → «Apri la chat»
check('G8-1r passo Permessi: titolo del mockup e «Fai quello che ti chiedo» ATTIVO col modello',
  await waitDom(`document.body.innerText.includes('Quanto posso fare da solo?')`, 10_000)
  && (await pageEval(`return !document.querySelector('[data-testid="guide-approvals-auto"]')?.disabled`)) === true)
await shot('guida-v2-permessi-1440-chiaro.png')
await dark(true)
await shot('guida-v2-permessi-1440-scuro.png')
await dark(false)
const contDisabledBefore = await pageEval(`return document.querySelector('[data-testid="guide-continue"]')?.disabled`)
check('G8-1s «Continua» spento finché non si sceglie', contDisabledBefore === true)
await clickTestid('guide-approvals-ask')
await shot('oac-permessi-scelto-1440-chiaro.png')
await clickTestid('guide-continue')
check('G8-1t il passo Pronto (solo UI): «Tutto pronto.» col riepilogo',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-ready"]') && document.body.innerText.includes('Tutto pronto.')`, 10_000))
// GC4.3: a «Pronto» i TRE puntini sono fatti e NESSUNO è il corrente (la
// cattura vecchia li prendeva a metà transizione, col «Permessi» ancora largo)
check('GC4.3 a «Pronto» l\'avanzamento: tre puntini fatti, NESSUN corrente',
  await waitDom(`(() => { const rail = document.querySelector('[data-testid="guide-rail"]'); if (!rail) return false; const dots = [...rail.querySelectorAll('span[aria-hidden]')]; return dots.length === 3 && dots.every((d) => d.classList.contains('bg-foreground') && !d.classList.contains('w-[22px]')) })()`, 10_000),
  `rail=${await pageEval(`return document.querySelector('[data-testid="guide-rail"]')?.innerText ?? null`)}`)
await shot('guida-v2-pronto-1440-chiaro.png')
await dark(true)
await shot('guida-v2-pronto-1440-scuro.png')
await dark(false)
await clickTestid('guide-continue') // «Apri la chat»
check('G8-1u «Apri la chat» porta in chat, con la card del focus (OA4) e lo STESSO bot',
  await waitDom(`!!document.querySelector('[data-testid="widget-option-posta"]')`, 20_000)
  && (await rpc('listAgents()'))[0]?.name === 'Nanna')

// GC6.1: il modello scelto nella guida ARRIVA alla finestra SENZA ricaricare:
// il pannello del bot dice «Modello: …finto», mai «Nessun modello» (lo store
// ora ascolta l'evento models del daemon)
check('GC6.1a in chat senza ricaricare: il pannello del bot mostra il modello scelto (finto), mai «Nessun modello»',
  await waitDom(`(() => { const row = document.querySelector('[data-testid="bot-model-row"]'); return !!row && row.innerText.includes('finto') && !row.innerText.includes('Nessun modello') })()`, 10_000),
  `row=${await pageEval(`return document.querySelector('[data-testid="bot-model-row"]')?.innerText ?? null`)}`)
check('GC6.1b nemmeno la barra in basso dice «nessun modello»',
  !((await visibleText()).toLowerCase().includes('nessun modello')),
  (await visibleText()).toLowerCase().includes('nessun modello') ? 'qualcosa dice ancora «nessun modello»' : '')

// GC6.4: il saluto della card del focus usa il NOME del bot scelto nel passo Tu
check('GC6.4 il saluto dice «Ciao! Sono Nanna.», non «Sono Homun»',
  await waitDom(`document.body.innerText.includes('Ciao! Sono Nanna. Dimmi da dove partiamo.')`, 10_000))

// OAC4.1: il compositore con la card del focus APERTA diventa la risposta libera
const llmBefore = chatRequests.length
const freeText = 'vorrei partire dalla posta per favore'
await uiSend(freeText)
check('OAC4.1 il messaggio nella casella con la card APERTA è UNA chiamata col testo (risposta libera)',
  await waitDom(`document.body.innerText.includes('Ecco fatto: sono qui.')`, 40_000) && callsWith(freeText) === 1,
  `chiamate col testo: ${callsWith(freeText)}`)
await shot('oac-composer-card-aperta-1440-chiaro.png')

// OAC2/OAC4.4: la VERA doppia attesa — modello tolto → attesa (riga 1) →
// il modello torna (il messaggio riparte da solo e il bot risponde) → tolto
// di nuovo → la SECONDA attesa ha la SUA riga col bottone
const firstWait = 'prima attesa del modello'
await rpc(`settingsSet('models.main', null)`)
await uiSend(firstWait)
check('OAC4.4a tolto il modello: la PRIMA attesa ha la riga «mi serve un modello» col bottone',
  await waitDom(`!!document.querySelector('[data-testid="need-model-choose"]')`, 20_000)
  && (await countText('Per risponderti mi serve un modello')) === 1,
  `righe: ${await countText('Per risponderti mi serve un modello')}`)
await shot('oac-prima-attesa-1440-chiaro.png')
// il modello torna: il messaggio trattenuto riparte DA SOLO e il bot risponde
await rpc(`settingsSet('models.main', ${JSON.stringify(main1)})`)
check('OAC4.4b il modello torna: il messaggio della prima attesa riparte da solo (una chiamata sola)',
  await waitDom(`(document.body.innerText.match(/Ecco fatto: sono qui\./g) ?? []).length >= 2`, 40_000)
  && callsWith(firstWait) === 1,
  `chiamate: ${callsWith(firstWait)}`)
const secondWait = 'seconda attesa del modello'
await rpc(`settingsSet('models.main', null)`)
await uiSend(secondWait)
check('OAC4.4c la SECONDA attesa ha la SUA riga (due in tutto) col bottone',
  await waitDom(`(document.body.innerText.match(/Per risponderti mi serve un modello/g) ?? []).length >= 2`, 20_000)
  && await waitDom(`!!document.querySelector('[data-testid="need-model-choose"]')`, 5_000),
  `righe: ${await countText('Per risponderti mi serve un modello')}`)
await shot('oac-seconda-attesa-1440-chiaro.png')
check('OAC4.4d il messaggio della seconda attesa NON ha chiamato il modello', callsWith(secondWait) === 0)
await stopEverything(DATA1)

/** ---------------- FASE 2: riavvio a metà guida → stesso passo ---------------- */
const DATA2 = join(TMP, 'due')
log('FASE 2: riavvio a metà guida…')
await startApp(DATA2)
check('G8-2a la guida riparte (dati due)', await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000))
await tuStep({ name: 'Bot' })
await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
await stopEverything(DATA2)
await startApp(DATA2)
check('G8-2b riavvio a metà guida: la finestra riporta allo STESSO passo (model)',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 30_000), `step: ${await guideStep()}`)
await stopEverything(DATA2)

/** ---------- FASE 3: salta il modello, «Riprendi» e «Rifai da capo» (OAC4) ---------- */
const DATA3 = join(TMP, 'tre')
log('FASE 3: salta il modello, Riprendi e Rifai da capo…')
await startApp(DATA3)
await tuStep({ name: 'Bot' })
await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
await clickTestid('guide-skip')
check('G8-3a «Salta per ora» porta ai Permessi', await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 15_000))
await approvalsToChat()

// OAC4.2: «Rifai da capo» per chi ha GIÀ scritto
await uiSend('ciao, ricominciamo')
await waitDom(`document.body.innerText.includes('Ecco fatto: sono qui.')`, 40_000)
// ⌘, apre le Impostazioni (input TRUSTED del CDP)
await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
check('G8-3b le Impostazioni si aprono con ⌘,', await waitDom(`!!document.querySelector('[data-testid="settings-guide-row"]')`, 10_000))
await shot('oac-impostazioni-guida-1440-chiaro.png')
await pageEval(`
  const row = document.querySelector('[data-testid="settings-guide-row"]')
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Rifai da capo')
  if (!btn) throw new Error('bottone Rifai da capo non trovato')
  btn.click()
  return 'cliccato'
`)
check('OAC4.2 «Rifai da capo» apre la guida ANCHE per chi ha già scritto (passo Tu)',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 15_000))
// si attraversa di nuovo: qui il modello era stato SALTATO, così la guida
// riaperta rifà anche il passo Modello (si salta di nuovo, clic vero)
await clickTestid('guide-continue')
check('OAC4.2b la guida riaperta rifà il passo Modello (saltato: si rivede la griglia)',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 15_000))
await clickTestid('guide-skip')
check('OAC4.2c saltato di nuovo, si torna ai Permessi',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 15_000),
  `step: ${await guideStep()}`)
await approvalsToChat()
check('OAC4.2d di nuovo in chat: lo STESSO bot e la card del focus NON doppia',
  await waitDom(`!!document.querySelector('form textarea')`, 20_000)
  && (await countText('Su cosa vuoi che ti aiuti per primo?')) <= 1
  && ((await rpc('listAgents()'))[0]?.name === 'Bot'))
await shot('oac-rifai-da-capo-1440-chiaro.png')

// OAC4.3: «Riprendi» su un passo SALTATO (il model di FASE 3 è saltato)
await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
await waitDom(`!!document.querySelector('[data-testid="settings-guide-row"]')`, 10_000)
await pageEval(`
  const row = document.querySelector('[data-testid="settings-guide-row"]')
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Riprendi')
  if (!btn) throw new Error('bottone Riprendi non trovato')
  btn.click()
  return 'cliccato'
`)
check('OAC4.3 «Riprendi» riapre la guida SUL passo model saltato',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 15_000), `step: ${await guideStep()}`)
await shot('oac-riprendi-model-1440-chiaro.png')
await stopEverything(DATA3)

/** ---------- FASE 4: il doppio clic sul focus (OAC3/OAC4.5) ---------- */
const DATA4 = join(TMP, 'quattro')
log('FASE 4: doppio clic sul focus…')
await startApp(DATA4)
await tuStep({ name: 'Bot' })
await modelStepViaCompatibile()
await waitDom(`!!document.querySelector('[data-testid="guide-probe-ok"]')`, 15_000)
await clickTestid('guide-continue')
await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 20_000)
await approvalsToChat()
await waitDom(`!!document.querySelector('[data-testid="widget-option-posta"]')`, 20_000)
// un clic VERO sulla prima opzione, poi la SECONDA chiamata (in ritardo) via
// RPC sulla STESSA opzione: le opzioni scomparse non si possono più cliccare,
// ma una chiamata duplicata (due finestre, un clic arrivato tardi) non deve
// rifare frasi né card
await clickTestid('widget-option-posta')
await sleep(800)
const agent4 = (await rpc('listAgents()'))[0]
const entries4 = await rpc(`getEntries(${JSON.stringify(agent4.id)}, 0)`)
const focusEntry4 = entries4.find((e) => e.meta?.onboardingFocus === true)
if (!focusEntry4) throw new Error('entry del focus non trovata')
const dup = await rpc(`widgetRespond(${JSON.stringify(agent4.id)}, ${focusEntry4.id}, 'posta')`)
check('OAC4.5-pre la chiamata duplicata è rifiutata dal daemon ({ ok: false })', JSON.stringify(dup) === JSON.stringify({ ok: false }), JSON.stringify(dup))
await sleep(1_200)
check('OAC4.5 doppio clic sul focus: la frase fissa UNA volta sola',
  (await countText('Va bene: Posta e calendario')) === 1, `frasi: ${await countText('Va bene: Posta e calendario')}`)
const botAfter = (await rpc('listAgents()'))[0]
check('OAC4.5b la riga «Focus iniziale» nella descrizione UNA volta sola',
  ((botAfter.description ?? '').match(/Focus iniziale:/g) ?? []).length === 1, botAfter.description?.slice(0, 80))
await shot('oac-doppio-focus-1440-chiaro.png')
await stopEverything(DATA4)

/** ---------- FASE 5: l'adozione della beta 4, e chi ha già scritto ---------- */
log('FASE 5: adozione del «Bot» della beta 4…')
const DATA5 = join(TMP, 'cinque')
await startApp(DATA5)
await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000)
await stopEverything(DATA5)
const db5 = new DatabaseSync(join(DATA5, 'data', 'sandbot.db'))
db5.prepare("DELETE FROM settings WHERE key IN ('mainAgentId', 'onboarding.state', 'onboarding.done')").run()
db5.prepare('DELETE FROM entries').run()
const betaRow = db5.prepare("SELECT id FROM agents WHERE name = 'Bot'").get()
db5.close()
await startApp(DATA5)
check('G8-5a il «Bot» vuoto della beta viene ADOZZATO: la guida parte con LUI',
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 30_000))
const agentsAdopt = await rpc('listAgents()')
check('G8-5b adottato: UN solo bot, STESSO id, mainAgentId suo',
  agentsAdopt.length === 1 && betaRow && agentsAdopt[0].id === betaRow.id && (await rpc(`settingsGet('mainAgentId', null)`)) === betaRow.id)
await stopEverything(DATA5)

const db5b = new DatabaseSync(join(DATA5, 'data', 'sandbot.db'))
db5b.prepare("INSERT INTO entries(agent_id, kind, role, content, meta, created_at) VALUES(?, 'message', 'user', 'ciao dalla beta', NULL, ?)")
  .run(betaRow.id, Date.now())
db5b.close()
await startApp(DATA5)
await sleep(2_500)
// OAC1 (G1): lo stato a metà si RIPREnde al boot, ANCHE per chi ha messaggi
const stepAfterMessages = await guideStep()
check('G8-5c OAC1: lo stato a metà si riapre allo stesso passo anche con messaggi',
  stepAfterMessages === 'guide-step-welcome', `step: ${stepAfterMessages}`)
await stopEverything(DATA5)

// e chi ha messaggi SENZA stato di guida (la beta vera): NESSUNA guida,
// onboarding.done si scrive da solo
const db5c = new DatabaseSync(join(DATA5, 'data', 'sandbot.db'))
db5c.prepare("DELETE FROM settings WHERE key = 'onboarding.state'").run()
db5c.close()
await startApp(DATA5)
await sleep(2_500)
const guideNoState = await pageEval(`return !!document.querySelector('[data-testid^="guide-step-"]')`)
const doneNoState = await rpc(`settingsGet('onboarding.done', false)`)
check('G8-5d chi ha già messaggi e MAI guida: NESSUNA guida (e onboarding.done si scrive)',
  guideNoState === false && doneNoState === true, `guida=${guideNoState} done=${doneNoState}`)
await stopEverything(DATA5)

/** ---------------- FASE OB (OB6.2): il passo Computer, tutto con clic veri ---------------- */
// macchina «supportata» (fatti finti), container ASSENTE: il pacchetto finto
// è servito dalla sonda su 127.0.0.1, pkgutil/spctl/open FINTI. Il daemon
// scarica, verifica, apre l'Installer FINTO, installa, accende il servizio,
// mette il kernel e costruisce l'immagine FINTA.
const freshOb = () => {
  try { rmSync(join(OB_BIN, 'container')) } catch { /* già pulita */ }
  const k = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    cliLog: join(TMP, `ob-cli-${k}.jsonl`),
    openLog: join(TMP, `ob-open-${k}.jsonl`),
    // OBV5: l'appRoot di prova della CLI finta, FRESCO: il kernel è un FILE
    // lì dentro, così ogni fase parte col mondo che vuole (con o senza kernel)
    appRoot: join(TMP, `ob-approot-${k}`)
  }
}
const seedEngineApple = (dataDir) => {
  // il selettore ESPLICITO su apple-container: l'auto, su un Mac con Docker
  // che risponde, guarderebbe quello (e sondare Docker vero è vietato qui)
  const db6 = new DatabaseSync(join(dataDir, 'data', 'sandbot.db'))
  db6.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db6.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('sandbox.engine', '"apple-container"')
  db6.close()
}
const boxPhaseOf = () => rpc('boxSetupState()').then((r) => r?.phase ?? null)

log('FASE OB: il passo Computer della guida, con clic veri…')
{
  const f = freshOb()
  const DATA6 = join(TMP, 'sei')
  mkdirSync(join(DATA6, 'data'), { recursive: true })
  seedEngineApple(DATA6) // PRIMA del daemon: il motore è quello Apple (mai Docker vero)
  await startApp(DATA6, obEnv({ SANDBOT_TEST_CONTAINER_LOG: f.cliLog, SANDBOT_TEST_OPEN_LOG: f.openLog, SANDBOT_TEST_CONTAINER_APP_ROOT: f.appRoot }))
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000)
  await tuStep({ name: 'Bot' })
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
  await clickTestid('guide-skip')
  check('OB-1 il passo Computer sta fra Modello e Permessi',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-computer"]')`, 10_000), `step: ${await guideStep()}`)
  check('OB-2 il titolo, la riga del mockup e il consenso in parole (con i GB calcolati)',
    (await visibleText()).includes('Il computer del bot')
    && (await visibleText()).includes('Un computer tutto suo, dentro il tuo Mac')
    && (await visibleText()).includes('170 MB')
    && (await visibleText()).includes('kernel Linux consigliato')
    && (await visibleText()).match(/circa \d+ GB/) !== null)
  await shot('ob-computer-prima-1440-chiaro.png')
  await dark(true)
  await shot('ob-computer-prima-1440-scuro.png')
  await dark(false)

  // «Prepara il computer»: il download parte e l'avanzamento si vede
  await clickTestid('guide-computer-prepare')
  check('OB-3 l\'avanzamento del download (riga in corso, percentuale)',
    await waitDom(`document.querySelector('[data-testid="box-setup-row-download"]')?.getAttribute('data-status') === 'running'`, 15_000)
    && await waitDom(`document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') === 'listening'`, 5_000))
  await shot('ob-computer-durante-1440-chiaro.png')
  await dark(true)
  await shot('ob-computer-durante-1440-scuro.png')
  await dark(false)

  // verifica OK → awaiting-installer: la riga diventa «Apri l'installazione»
  check('OB-4 la verifica passa e si aspetta l\'utente: «Apri l\'installazione»',
    await waitDom(`!!document.querySelector('[data-testid="box-setup-open-installer"]')`, 30_000))
  check('OB-4b la nuvoletta chiede la password del Mac',
    (await visibleText()).includes('Mi serve la tua password del Mac per installare lo strumento di Apple.'))
  check('OB-4c «Continua» è SPENTO sull\'attesa (serve l\'utente) ma «Salta per ora» c\'è',
    (await pageEval(`return document.querySelector('[data-testid="guide-continue"]')?.disabled === true`))
    && !!(await pageEval(`return !!document.querySelector('[data-testid="guide-skip"]')`)))
  await shot('ob-computer-installer-1440-chiaro.png')
  await dark(true)
  await shot('ob-computer-installer-1440-scuro.png')
  await dark(false)

  // l'open FINTO «installa»: il daemon scopre la CLI e finisce da solo
  await clickTestid('box-setup-open-installer')
  const openCount = () => { try { return readFileSync(f.openLog, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }
  check('OB-5 l\'Installer finto è stato aperto: dal daemon dopo la verifica, e di nuovo dal clic dell\'utente',
    openCount() === 2, `open: ${openCount()}`)
  check('OB-6 installazione, servizio, kernel e immagine: ready',
    await waitDom(`document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') === 'happy'`, 60_000),
    `phase: ${await boxPhaseOf()}`)
  check('OB-6b la nuvoletta: «Ho il mio computer!»', (await visibleText()).includes('Ho il mio computer!'))
  // il servizio e il kernel: gli argv di oggi SULLA CLI finta
  const cliArgv = (() => { try { return readFileSync(f.cliLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv.join(' ')) } catch { return [] } })()
  check('OB-7 il servizio: system start --disable-kernel-install', cliArgv.some((a) => a === 'system start --disable-kernel-install'), cliArgv.slice(0, 8).join(' | '))
  check('OB-8 il kernel: system kernel set --recommended', cliArgv.some((a) => a === 'system kernel set --recommended'))
  check('OB-9 la build dell\'immagine è passata dalla CLI finta', cliArgv.some((a) => a === 'build sandbot-box:current .') || cliArgv.some((a) => a.startsWith('build ')))
  await shot('ob-computer-pronto-1440-chiaro.png')
  await dark(true)
  await shot('ob-computer-pronto-1440-scuro.png')
  await dark(false)

  // «Continua» a ready → Permessi → Pronto con «Computer: pronto» → chat
  await clickTestid('guide-continue')
  check('OB-10 «Continua» porta ai Permessi', await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 10_000))
  await clickTestid('guide-approvals-ask')
  await waitDom(`!document.querySelector('[data-testid="guide-continue"]')?.disabled`, 10_000)
  await clickTestid('guide-continue') // → Pronto
  await waitDom(`!!document.querySelector('[data-testid="guide-step-ready"]')`, 10_000)
  check('OB-11 «Pronto» dice «Computer: pronto»',
    ((await pageEval(`return (() => { const row = [...document.querySelectorAll('[data-testid^="guide-summary-"]')].find((n) => n.innerText.includes('Computer')); return row ? row.innerText : null })()`)) ?? '').includes('pronto'))
  await clickTestid('guide-continue') // «Apri la chat»
  await waitDom(`!!document.querySelector('form textarea')`, 20_000)
  await stopEverything(DATA6)
}

/** ---------------- FASE OB-b (OB6.3): lo sha256 SBAGLIATO → nessun open ---------------- */
log('FASE OB-b: sha256 sbagliato…')
{
  const f = freshOb()
  const DATA7 = join(TMP, 'sette')
  mkdirSync(join(DATA7, 'data'), { recursive: true })
  seedEngineApple(DATA7)
  await startApp(DATA7, obEnv({ SANDBOT_TEST_PKG_SHA256: '0'.repeat(64), SANDBOT_TEST_CONTAINER_LOG: f.cliLog, SANDBOT_TEST_OPEN_LOG: f.openLog, SANDBOT_TEST_CONTAINER_APP_ROOT: f.appRoot }))
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000)
  await tuStep({ name: 'Bot' })
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
  await clickTestid('guide-skip')
  await waitDom(`!!document.querySelector('[data-testid="guide-step-computer"]')`, 10_000)
  await clickTestid('guide-computer-prepare')
  check('OB-b1 lo sha256 sbagliato dà l\'errore in parole e il bottone Riprova',
    await waitDom(`!!document.querySelector('[data-testid="guide-computer-error"]')`, 30_000)
    && (await visibleText()).includes('Il pacchetto scaricato non è quello atteso'))
  check('OB-b2 la nuvoletta dell\'errore rimanda alla lista', (await visibleText()).includes('Qualcosa non è andato'))
  check('OB-b3 NESSUN open: il log dell\'open finto non esiste',
    !existsSync(f.openLog))
  await shot('ob-computer-errore-1440-chiaro.png')
  await dark(true)
  await shot('ob-computer-errore-1440-scuro.png')
  await dark(false)
  await stopEverything(DATA7)
}

/** ---------------- FASE OB-c (OB6.3): il riavvio su awaiting-installer riprende ---------------- */
log('FASE OB-c: riavvio sull\'attesa dell\'Installer…')
{
  const f = freshOb()
  const DATA8 = join(TMP, 'otto')
  mkdirSync(join(DATA8, 'data'), { recursive: true })
  seedEngineApple(DATA8)
  // l'open finto «installa» dopo MOLTO tempo: l'utente non ha ancora dato la
  // password quando l'app si chiude — il riavvio deve trovare l'attesa intatta
  await startApp(DATA8, obEnv({ SANDBOT_TEST_OPEN_DELAY_MS: '60000', SANDBOT_TEST_CONTAINER_LOG: f.cliLog, SANDBOT_TEST_OPEN_LOG: f.openLog, SANDBOT_TEST_CONTAINER_APP_ROOT: f.appRoot }))
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000)
  await tuStep({ name: 'Bot' })
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
  await clickTestid('guide-skip')
  await waitDom(`!!document.querySelector('[data-testid="guide-step-computer"]')`, 10_000)
  await clickTestid('guide-computer-prepare')
  await waitDom(`!!document.querySelector('[data-testid="box-setup-open-installer"]')`, 30_000)
  // il daemon apre l'Installer DA SÉ dopo la verifica: UN open (dell'utente
  // che installa, qui, non se ne fa nulla: il ritardo è lungo). Questo
  // conteggio NON deve crescere dopo il riavvio, finché non si clicca
  const opensBefore = (() => { try { return readFileSync(f.openLog, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } })()
  await stopEverything(DATA8)
  // riavvio: stesso punto (awaiting-installer), il pacchetto resta sul disco;
  // ORA la password arriva (ritardo corto) e l'installazione finisce
  await startApp(DATA8, obEnv({ SANDBOT_TEST_OPEN_DELAY_MS: '400', SANDBOT_TEST_CONTAINER_LOG: f.cliLog, SANDBOT_TEST_OPEN_LOG: f.openLog, SANDBOT_TEST_CONTAINER_APP_ROOT: f.appRoot }))
  check('OB-c1 il riavvio riporta la guida sul passo Computer',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-computer"]')`, 30_000))
  check('OB-c2 la preparazione riprende dallo STESSO punto (awaiting-installer)',
    (await boxPhaseOf()) === 'awaiting-installer', `phase: ${await boxPhaseOf()}`)
  const opensAfter = (() => { try { return readFileSync(f.openLog, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } })()
  check('OB-c3 il bottone «Apri l\'installazione» c\'è ancora e il riavvio NON ha riaperto nulla',
    await waitDom(`!!document.querySelector('[data-testid="box-setup-open-installer"]')`, 30_000)
    && opensAfter === opensBefore, `opens ${opensBefore} → ${opensAfter}`)
  await clickTestid('box-setup-open-installer')
  check('OB-c4 l\'installazione finisce e si arriva al ready',
    await waitDom(`document.querySelector('[data-testid="guide-scene"] [data-mood]')?.getAttribute('data-mood') === 'happy'`, 60_000),
    `phase: ${await boxPhaseOf()}`)
  await stopEverything(DATA8)
}

/** ---------------- FASE OB-d (OB6.3): «Continua» durante l'immagine ---------------- */
log('FASE OB-d: si prosegue mentre l\'immagine si costruisce…')
{
  const f = freshOb()
  const DATA9 = join(TMP, 'nove')
  mkdirSync(join(DATA9, 'data'), { recursive: true })
  seedEngineApple(DATA9)
  // la build finta DURA: la guida deve poter proseguire intanto
  await startApp(DATA9, obEnv({ SANDBOT_TEST_CONTAINER_BUILD_DELAY_MS: '6000', SANDBOT_TEST_CONTAINER_LOG: f.cliLog, SANDBOT_TEST_OPEN_LOG: f.openLog, SANDBOT_TEST_CONTAINER_APP_ROOT: f.appRoot }))
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000)
  await tuStep({ name: 'Bot' })
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
  await clickTestid('guide-skip')
  await waitDom(`!!document.querySelector('[data-testid="guide-step-computer"]')`, 10_000)
  await clickTestid('guide-computer-prepare')
  await waitDom(`!!document.querySelector('[data-testid="box-setup-open-installer"]')`, 30_000)
  await clickTestid('box-setup-open-installer')
  // l'immagine sta costruendo: «Continua» è ATTIVO (fase in background)
  check('OB-d1 durante la build dell\'immagine «Continua» è attivo',
    await waitDom(`document.querySelector('[data-testid="box-setup-row-image"]')?.getAttribute('data-status') === 'running'`, 30_000)
    && (await pageEval(`return document.querySelector('[data-testid="guide-continue"]')?.disabled !== true`)))
  await clickTestid('guide-continue')
  check('OB-d2 si arriva ai Permessi mentre l\'immagine costruisce', await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 10_000))
  await clickTestid('guide-approvals-ask')
  await waitDom(`!document.querySelector('[data-testid="guide-continue"]')?.disabled`, 10_000)
  await clickTestid('guide-continue') // → Pronto
  await waitDom(`!!document.querySelector('[data-testid="guide-step-ready"]')`, 10_000)
  check('OB-d3 «Pronto» dice «Computer: in preparazione»',
    ((await pageEval(`return (() => { const row = [...document.querySelectorAll('[data-testid^="guide-summary-"]')].find((n) => n.innerText.includes('Computer')); return row ? row.innerText : null })()`)) ?? '').includes('in preparazione'))
  await clickTestid('guide-continue') // «Apri la chat»
  await waitDom(`!!document.querySelector('form textarea')`, 20_000)
  // nel pannello del bot la riga discreta: «In preparazione…» poi «Pronto»
  check('OB-d4 la riga del pannello dice «In preparazione…»',
    await waitDom(`!!document.querySelector('[data-testid="bot-prep-row"]') && document.querySelector('[data-testid="bot-prep-row"]').innerText.includes('In preparazione')`, 15_000))
  check('OB-d5 a fine costruzione la riga dice «Pronto»',
    await waitDom(`document.querySelector('[data-testid="bot-prep-row"]')?.innerText.includes('Pronto')`, 60_000),
    `row: ${await pageEval(`return document.querySelector('[data-testid="bot-prep-row"]')?.innerText ?? null`)}`)
  await stopEverything(DATA9)
}

/** ---------------- FASE OB-e (OB6.3): macchina NON supportata → niente passo ---------------- */
log('FASE OB-e: macchina non supportata…')
{
  const DATA10 = join(TMP, 'dieci')
  await startApp(DATA10, {}) // arch finto x86_64: non supportata
  await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000)
  await tuStep({ name: 'Bot' })
  await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
  await clickTestid('guide-skip')
  check('OB-e1 su una macchina non supportata NON c\'è il passo Computer (si va ai Permessi)',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 10_000)
    && !(await pageEval(`return document.body.innerText.includes('Il computer del bot')`)))
  await stopEverything(DATA10)
}

// ---- pulizia finale: 0 daemon e 0 llama-server ----
const leftDaemons = findProbeDaemons('sandbot-fase-onboarding-a')
check('PULIZIA nessun daemon della sonda vivo', leftDaemons.length === 0, leftDaemons.map((d) => d.pid).join(','))
const llama = await import('node:child_process').then((c) => c.spawnSync('/usr/bin/pgrep', ['-fl', 'llama-server'], { encoding: 'utf8' }))
const llamaMine = (llama.stdout ?? '').split('\n').filter((l) => l.includes(TMP))
check('PULIZIA nessun llama-server della sonda vivo', llamaMine.length === 0, llamaMine.join(' | ') || 'nessuno')
providerServer.close()
} catch (err) {
  console.error('[sonda] ERRORE:', err)
  failures++
} finally {
  try { app?.kill('SIGKILL') } catch { /* già via */ }
  await stopProbeDaemons('sandbot-fase-onboarding-a').catch(() => undefined)
  rmSync(TMP, { recursive: true, force: true })
}

const ok = checks.filter((c) => c.ok).length
console.log(`\n[sonda] ${ok}/${checks.length} controlli superati${failures ? ` — ${failures} FALLITI` : ''}`)
for (const c of checks.filter((x) => !x.ok)) console.log(`  KO ${c.id} ${c.note}`)
process.exit(failures ? 1 : 0)
