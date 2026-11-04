#!/usr/bin/env node
// Sonda Electron della fase IMPOSTAZIONI (I1–I8): l'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, con DUE provider FINTI su
// 127.0.0.1 — un Ollama finto (/api/tags + /api/show, «Sul tuo Mac») e un
// provider con chiave (elenco /v1/models in stile OpenAI). NESSUNA chiamata a
// Ollama vero, a ollama.com o a modelli cloud: la sonda NON lancia la
// scansione del Mac (che toccherebbe 127.0.0.1:11434/1234) e i provider si
// collegano SOLO via RPC con baseUrl esplicito sul server finto.
//
// Copre, con CATTURE in docs/catture/impostazioni/:
//   I1  il popover del ModelSelect aperto (chiaro e scuro), la ricerca e i
//       provider da collegare con «Collega»;
//   I2  la pagina Modelli a tre gruppi: riserva aggiunta e SPOSTATA, provider
//       aperto SUL POSTO, «+ Aggiungi provider» con elenco e collegamento
//       RIUSCITO al server finto;
//   I4  i tre modi delle Approvazioni: Automatico con regole, la CONFERMA di
//       «Non chiedere», le regole per strumento sotto Avanzate;
//   I5  OGNI sezione a 1440 e 900, chiaro e scuro (una in inglese); la
//       colonna navigata da tastiera (anello visibile) e all'apertura col
//       mouse (nessun anello);
//   I6  il ModelSelect nel pannello del bot: «Come gli altri» → modello di un
//       altro provider → di nuovo «Come gli altri» (null/null nel db);
//   I8  una FIXTURE coi setting della 0.3.1001 (providers.modelDefaults,
//       autoReview.enabled, catena vuota, models.main su Ollama) aperta dopo
//       un RIAVVIO: riserva visibile, revisore visibile, modo Automatico,
//       nessuna regola persa.
//
// A FINE SONDA si chiude ANCHE il daemon di sviluppo: il pid sta in
// daemon.lock dentro la cartella dati temporanea (mai il Portachiavi vero,
// mai la cartella dati vera: env SANDBOT_TEST_*), niente Docker, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const TMP = mkdtempSync(TMP_BASE + 'sandbot-fase-impostazioni-')
const DATA = join(TMP, 'data')
const FIXTURE = join(TMP, 'fixture')
const SHOTS = join(ROOT, 'docs', 'catture', 'impostazioni')
mkdirSync(DATA, { recursive: true })
mkdirSync(FIXTURE, { recursive: true })
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

// ---- i provider FINTI (tutti su 127.0.0.1, un solo server, due prefissi) ----
// Ollama finto: GET /api/tags, POST /api/show (capability + thinking).
// OpenAI finto: GET /v1/models (Bearer), POST /v1/chat/completions (SSE, mai usato).
const OLLAMA_MODELS = [
  { name: 'kimi-f3-finto', digest: 'sha256:kimi' },
  { name: 'gemma3-finta', digest: 'sha256:gemma' },
  { name: 'minitrue-finto', digest: 'sha256:mini' }
]
let fakePort = 0
const fake = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // — Ollama finto —
  if (req.method === 'GET' && url.pathname === '/api/tags') return json(200, { models: OLLAMA_MODELS })
  if (req.method === 'POST' && url.pathname === '/api/show') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const name = (JSON.parse(body || '{}').model ?? '').replace(':latest', '')
      if (name === 'kimi-f3-finto') {
        // vede, usa i tool e ha livelli di ragionamento (per il «⋯» di I1.4)
        return json(200, { capabilities: ['vision', 'tools'], thinking: { values: ['low', 'medium', 'high'], default: 'medium' } })
      }
      if (name === 'gemma3-finta') return json(200, { capabilities: ['vision'] })
      if (name === 'minitrue-finto') return json(200, {})
      return json(404, { error: 'model not found' })
    })
    return
  }
  // — LM Studio finto: un elenco SUO (niente ambiguità col provider con chiave)
  if (req.method === 'GET' && url.pathname === '/lmstudio/v1/models') {
    return json(200, { data: [{ id: 'lmstudio-finto', display_name: 'LM Finto 8B' }] })
  }
  // — provider con chiave (stile OpenAI) —
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    // con chiave SBAGLIATA 401 (per la prova della chiave); senza chiave si
    // risponde (LM Studio finto non ne ha)
    const auth = req.headers.authorization ?? ''
    if (auth && !auth.includes('chiave-finta')) return json(401, { error: { message: 'Incorrect API key provided' } })
    return json(200, { data: [
      { id: 'gpt-finto', display_name: 'GPT Finto' },
      { id: 'gpt-mini-finto', display_name: 'GPT Mini Finto' }
    ] })
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      chunk({ content: 'ok' })
      chunk({}, 'stop')
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
fakePort = fake.address().port
const OLLAMA_BASE = `http://127.0.0.1:${fakePort}`
const OPENAI_BASE = `http://127.0.0.1:${fakePort}/v1`

/** Pre-semina i provider FINTI nel DB prima del lancio.
 *
 * Il daemon fa autodiscovery silenziosa delle porte locali a ogni boot
 * (runtime.ts): se su questo Mac girasse un Ollama o LM Studio VERI, il
 * provider vero entrerebbe nello store e le pagine lo userebbero (test,
 * elenchi, catture) — chiamate a Ollama vero, vietate. Pre-creando i due id
 * ('ollama', 'lmstudio') puntati al server FINTO, la discovery non unisce
 * niente: le uniche richieste sono verso 127.0.0.1:<porta finta>.
 */
const seedFakeProviders = (dataDir) => {
  mkdirSync(join(dataDir, 'data'), { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'data', 'sandbot.db'))
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const providers = [
    { id: 'ollama', name: 'Ollama (finto)', kind: 'ollama', baseUrl: OLLAMA_BASE, apiKey: '', enabled: true, discovered: true },
    { id: 'lmstudio', name: 'LM Studio (finto)', kind: 'lmstudio', baseUrl: OLLAMA_BASE + '/lmstudio', apiKey: '', enabled: true, discovered: true }
  ]
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('providers', JSON.stringify(providers))
  db.close()
}

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

/** Lancia l'app su una cartella dati (env -i + SANDBOT_TEST_*: mai i dati veri). */
const launchApp = (dataDir, debugPort) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: dataDir,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let appLog = ''
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  return { app, getLog: () => appLog, stop: () => { try { app.kill('SIGTERM') } catch { /* già via */ } } }
}

/** Il pid del daemon di QUESA cartella dati (daemon.lock), se già scritto. */
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
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
}

// ---- CDP ----
const httpJson = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json()))
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
async function connectPage(debugPort) {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await httpJson(debugPort, '/json/list')
      const target = list.find((t) => t.type === 'page')
      if (target) return await openCdp(target.webSocketDebuggerUrl)
    } catch { /* il debugger non è ancora su */ }
    await sleep(200)
  }
  throw new Error('nessuna pagina CDP')
}

/** Il contesto di una corsa dell'app: pagina CDP + helper DOM/RPC. */
async function run(debugPort, dataDir) {
  const page = await connectPage(debugPort)
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
  const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await pageEval(`return !!(${exprTrue})`)) return true
      if (Date.now() > deadline) return false
      await sleep(step)
    }
  }
  const setWindowWidth = async (width, height = 900) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
    await sleep(700)
    const w = await pageEval('return window.innerWidth')
    if (w !== width) throw new Error(`viewport emulato non applicato: ${w} ≠ ${width}`)
  }
  const shot = (name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
    log('cattura', name)
  })
  return { page, pageEval, rpc, waitDom, setWindowWidth, shot, dataDir }
}

// ---- helper DOM (valutati nel renderer) ----
/** Il clic VERO: pointerdown/click — i trigger Radix (menu) aprono su pointerdown. */
const pointerClick = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  if (!el) throw new Error('non trovato (pointerClick)')
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
  el.click()
  return 'cliccato'
`)
/** Apre le Impostazioni e aspetta che siano STABILI: dopo un cambio di
 *  larghezza la chiusura del dialogo arriva RITARDATA (il windowWidth dell'app
 *  è debounced), quindi si riapre, si attende e si verifica che la colonna
 *  sia ancora lì; altrimenti si riprova (max 3). */
/** Apre le Impostazioni DAL MENU della barra (via «mouse»: pointerdown sugli
 *  elementi, nessun tasto della tastiera) — così il :focus-visible non scatta
 *  e le catture della matrice restano pulite come per un utente col mouse. */
const openSettingsViaMenu = async (r) => {
  await pointerClick(r.pageEval, `[...document.querySelectorAll('aside button[aria-haspopup="menu"]')].pop()`)
  if (!(await r.waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.textContent.trim() === 'Impostazioni')`, 5000))) return false
  await clickText(r.pageEval, 'Impostazioni', '[role="menuitem"]', true)
  return r.waitDom(`!!document.querySelector('[role="dialog"] nav button')`, 6000)
}

const ensureSettings = async (r) => {
  const NAV = `!!document.querySelector('[role="dialog"] nav button')`
  for (let attempt = 0; attempt < 3; attempt++) {
    // prima la via del «mouse» (menu della barra); se non riesce, il ⌘, —
    // il blur di gotoSection mantiene le catture pulite in ogni caso
    if (!(await openSettingsViaMenu(r))) {
      if (!(await openSettings(r))) continue
    }
    await sleep(1600)
    if (await r.waitDom(NAV, 1000)) return true
  }
  return false
}

const clickText = (pageEval, text, selector = 'button', exact = false) => pageEval(`
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
  const want = ${JSON.stringify(text)}
  const el = els.find((x) => {
    const t = x.textContent.trim()
    return (${exact ? 't === want' : 't.includes(want)'}) && x.offsetParent !== null
  })
  if (!el) throw new Error('non trovato: ' + want)
  el.click()
  return 'cliccato: ' + want
`)
/** Scrive in un input/textarea con l'evento input di React (settando il valore nativo). */
const setInput = (pageEval, selector, value, index = 0) => pageEval(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => x.offsetParent !== null)[${index}]
  if (!el) throw new Error('campo non trovato: ' + ${JSON.stringify(selector)})
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'scritto'
`)
/** Apre le Impostazioni con ⌘, — input TRUSTED del CDP (il tasto vero) — e
 *  aspetta la COLONNA delle sezioni (non basta [role=dialog]: all'avvio può
 *  esserci un dialogo transitorio; se il ⌘, arriva prima del montaggio si
 *  riprova una volta). */
const openSettings = async (r) => {
  const NAV = `!!document.querySelector('[role="dialog"] nav button')`
  for (let attempt = 0; attempt < 2; attempt++) {
    await r.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
    await r.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
    if (await r.waitDom(NAV, 4000)) return true
  }
  return false
}
/** Cambio di larghezza + riapertura STABILE delle Impostazioni: dopo un
 *  resize la chiusura del dialogo può arrivare con ritardo (il layout
 *  rimonta il pannello del bot e i layer si sistemano), quindi si aspetta
 *  che tutto si assesti, si chiude quel che c'è con Esc e si riapre. */
const resizeAndReopen = async (r, width) => {
  await r.setWindowWidth(width)
  await sleep(2500)
  await r.pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await sleep(600)
  if (!(await ensureSettings(r))) throw new Error(`le Impostazioni non si aprono a ${width}`)
}

/** Porta in vista un elemento prima della cattura: il dialogo scorre e il
 *  dettaglio del provider (o l'Avanzate in fondo) resterebbe sotto il bordo. */
const scrollIntoView = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  el?.scrollIntoView({ block: 'center' })
  return el ? 'scrolled' : 'null'
`)

/** Il tema scuro si accende solo per la cattura (come la sonda grafica). */
const setDark = async (pageEval, dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(250)
}
/** Ricarica la pagina e aspetta il NUOVO contesto (marcatore d'epoca: il
 *  window.__sondaEpoch del vecchio contesto sparisce col reload) — senza
 *  questo, waitDom passa sulla pagina VECCHIA ancora viva durante la navigazione. */
const reloadApp = async (r) => {
  try { await r.pageEval('window.__sondaEpoch = 1; location.reload(); return "reloading"') } catch { /* il contesto muore col reload */ }
  const fresh = await r.waitDom(
    'typeof window.__sondaEpoch === "undefined" && typeof window.sandbot !== "undefined" && !!document.querySelector("form textarea")',
    40_000
  )
  if (!fresh) throw new Error('la pagina non si è ricaricata (contesto nuovo non visto)')
  await sleep(1500)
}

/** La sezione delle Impostazioni per nome (bottone della colonna sinistra).
 *  AUTO-CORREGGENTE: se il dialogo si è chiuso (dopo un resize la chiusura
 *  può arrivare in ritardo, quando ensureSettings ha già controllato), si
 *  riapre e si riprova — finché la colonna c'è e la voce si clicca. */
const gotoSection = async (r, name) => {
  const pageEval = r.pageEval
  for (let attempt = 0; attempt < 3; attempt++) {
    const texts = await pageEval(`return [...document.querySelectorAll('[role="dialog"] nav button')].map((b) => b.textContent.trim())`)
    const want = [name, ...(name === 'Modelli' ? ['Models'] : name === 'General' ? ['Generali'] : [])].find((n) => texts.includes(n))
    if (!want) {
      if (attempt === 2) {
        const info = await pageEval(`return (() => {
          const ds = [...document.querySelectorAll('[role="dialog"]')]
          return ds.map((d) => ({ title: d.querySelector('h1,h2,strong')?.textContent?.trim().slice(0, 40) ?? '', text: d.textContent.trim().slice(0, 80) }))
        })()`)
        throw new Error(`sezione non trovata: ${name} — colonna: ${JSON.stringify(texts)} — dialoghi: ${JSON.stringify(info)}`)
      }
      if (!(await ensureSettings(r))) throw new Error(`le Impostazioni non si riaprono per la sezione ${name}`)
      continue
    }
    await clickText(pageEval, want, '[role="dialog"] nav button')
    await pageEval(`document.activeElement?.blur?.(); return 'blur'`)
    await sleep(500)
    return
  }
}

try {
  // i provider finti entrano nel DB PRIMA del primo avvio (vedi seedFakeProviders)
  seedFakeProviders(DATA)
  seedFakeProviders(FIXTURE)

  // ============================ la corsa principale ============================
  const DEBUG_PORT = 9341
  const main = launchApp(DATA, DEBUG_PORT)
  let r
  try {
    log('avvio app sulla cartella dati temporanea…')
    r = await run(DEBUG_PORT, DATA)
    if (!(await r.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile dopo 40s')
    }

    // ---- setup: DUE provider finti (uno «Sul tuo Mac», uno con chiave) ----
    log('provider finti: Ollama e LM Studio pre-semenati nel DB (la autodiscovery del boot non tocca i servizi veri), OpenAI con chiave via RPC')
    await r.rpc(`saveProvider(${JSON.stringify({ id: 'openai-finto', name: 'OpenAI (finto)', kind: 'openai', baseUrl: OPENAI_BASE, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
    // il modello principale è il kimi finto; catena vuota (la pagina la mostra VUOTA)
    await r.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'ollama', model: 'kimi-f3-finto', thinking: null })})`)
    await r.rpc(`settingsSet(${JSON.stringify('models.fallbackChain')}, ${JSON.stringify([])})`)
    await r.rpc(`settingsSet(${JSON.stringify('autoReview')}, ${JSON.stringify({ enabled: false, allowRules: [], blockRules: [], providerId: null, model: null })})`)
    await r.rpc(`settingsSet(${JSON.stringify('approvals.mode')}, ${JSON.stringify('ask')})`)
    await r.rpc(`settingsSet(${JSON.stringify('approvals.modeSet')}, true)`)
    await r.rpc(`settingsSet(${JSON.stringify('models.fallbackMaterialized')}, true)`)
    await r.rpc(`settingsSet(${JSON.stringify('autoReview.materialized')}, true)`)
    // un bot esiste già (onboarding): segue il principale
    const agents0 = await r.rpc('listAgents()')
    check('setup un bot presente', Array.isArray(agents0) && agents0.length > 0)
    await r.page.send('Page.reload')
    await r.waitDom(`typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 30_000)
    await r.setWindowWidth(1440)

    // i due provider finti rispondono davvero (listModels vero del daemon)
    const ollamaList = await r.rpc(`listModels(${JSON.stringify('ollama')})`)
    const openaiList = await r.rpc(`listModels(${JSON.stringify('openai-finto')})`)
    check('setup Ollama finto: 3 modelli da /api/tags', Array.isArray(ollamaList) && ollamaList.length === 3, `avuti ${ollamaList?.length}`)
    check("setup provider con chiave: i modelli del server finto sono nell'elenco (catalogo compreso)",
      Array.isArray(openaiList) && openaiList.some((m) => m.id === 'gpt-finto') && openaiList.some((m) => m.id === 'gpt-mini-finto'),
      `avuti ${openaiList?.length} (catalogo + vivo)`)

    // ============================ I5 · apertura e matrice ============================
    // all'apertura col MOUSE (menu della barra in basso): NESSUN anello su «Generali»
    await pointerClick(r.pageEval, `[...document.querySelectorAll('aside button[aria-haspopup="menu"]')].pop()`)
    check('I5 il menu della barra si apre', await r.waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.textContent.trim() === 'Impostazioni')`, 6000))
    await clickText(r.pageEval, 'Impostazioni', '[role="menuitem"]')
    check('I5 le Impostazioni si aprono (dialogo)', await r.waitDom(`!!document.querySelector('[role="dialog"]')`, 10_000))
    await sleep(600)
    const ringAtOpen = await r.pageEval(`return (() => {
      const first = document.querySelector('[role="dialog"] nav button')
      if (!first) return null
      return { active: document.activeElement === first, focusVisible: first.matches(':focus-visible') }
    })()`)
    check('I5a apertura col mouse: il fuoco NON è sul primo bottone della colonna (niente anello)',
      ringAtOpen?.active === false, JSON.stringify(ringAtOpen))
    await r.shot('i5-apertura-mouse.png')
    await r.pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await sleep(500)

    // all'apertura con la TASTIERA (⌘,) + Tab: l'anello del primo bottone SI VEDE
    await openSettings(r)
    await r.waitDom(`!!document.querySelector('[role="dialog"]')`)
    await sleep(600)
    // Tab TRUSTED: il fuoco passa dal titolo al primo bottone della colonna
    await r.page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await r.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await sleep(500)
    const ringKb = await r.pageEval(`return (() => {
      const first = document.querySelector('[role="dialog"] nav button')
      return { active: first && document.activeElement === first, focusVisible: first?.matches(':focus-visible') }
    })()`)
    check('I5b navigazione da tastiera: anello VISIBILE sul bottone della colonna',
      ringKb?.active === true && ringKb?.focusVisible === true, JSON.stringify(ringKb))
    await r.shot('i5-tastiera-anello.png')

    // la matrice: OGNI sezione a 1440 e 900, chiaro e scuro. NOTA: il dialogo
    // delle Impostazioni si CHIUDE al cambio di larghezza della finestra (il
    // pannello del bot passa da docked a overlay e i layer si sistemano): si
    // riapre dopo ogni resize, prima delle catture di quel giro
    const SEZIONI = ['Generali', 'Modelli', 'App e skill', 'Approvazioni', 'Cassaforte', 'Routine', 'Uso e costi']
    for (const width of [1440, 900]) {
      for (const dark of [false, true]) {
        await setDark(r.pageEval, dark)
        await resizeAndReopen(r, width)
        for (const nome of SEZIONI) {
          await gotoSection(r, nome)
          await sleep(450)
          await r.shot(`sezione-${nome.toLowerCase().replace(/ /g, '-')}-${width}-${dark ? 'scuro' : 'chiaro'}.png`)
        }
      }
      await setDark(r.pageEval, false)
    }

    // ============================ I1 · il popover del ModelSelect ============================
    await resizeAndReopen(r, 1440)
    await gotoSection(r, 'Modelli')
    await sleep(600) // i modelli dei due provider finti caricano
    // il controllo chiuso mostra il modello e il provider, senza dimensioni
    const closed = await r.pageEval(`return (() => {
      const combo = document.querySelector('[role="dialog"] button[role="combobox"]')
      return combo ? combo.textContent.trim() : null
    })()`)
    check('I1a la riga chiusa mostra modello e provider (niente dimensioni né «vede · ragiona»)',
      !!closed && closed.includes('kimi-f3-finto') && closed.includes('Ollama') && !closed.includes('vede') && !closed.includes('ragiona') && !/\(\d/.test(closed),
      JSON.stringify(closed))
    // apertura popover: ricerca in cima col fuoco
    await r.pageEval(`document.querySelector('[role="dialog"] button[role="combobox"]')?.click()`)
    check('I1b il popover si apre con la ricerca (fuoco automatico)',
      await r.waitDom(`!![...document.querySelectorAll('[role="dialog"] input')].find((i) => i.placeholder.includes('Cerca un modello'))`, 6000))
    const popover = await r.pageEval(`return (() => {
      const input = [...document.querySelectorAll('input')].find((i) => i.placeholder.includes('Cerca un modello'))
      const list = input?.closest('div[class*="rounded-2xl"]')
      if (!list) return null
      return {
        focus: document.activeElement === input,
        gruppi: [...list.querySelectorAll('p')].map((p) => p.textContent.trim()).filter(Boolean),
        voci: [...list.querySelectorAll('[role="option"]')].length,
        collega: [...list.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Collega').length
      }
    })()`)
    check('I1c i modelli sono raggruppati per provider (titoletti = nome del provider)',
      popover?.gruppi?.includes('Ollama (finto)') && popover?.voci >= 3, JSON.stringify(popover?.gruppi))
    check('I1d sotto il separatore i provider da collegare con «Collega»',
      (popover?.collega ?? 0) >= 5, `voci Collega: ${popover?.collega}`)
    await r.shot('i1-popover-chiaro.png')
    // la ricerca filtra
    await setInput(r.pageEval, '[role="dialog"] input[placeholder*="Cerca un modello"]', 'gemma')
    await sleep(300)
    const filtered = await r.pageEval(`return [...document.querySelectorAll('[role="dialog"] [role="option"]')].map((o) => o.textContent.trim())`)
    check('I1e la ricerca filtra (gemma → solo gemma3-finta)', filtered.length === 1 && filtered[0]?.includes('gemma3-finta'), JSON.stringify(filtered))
    await setInput(r.pageEval, '[role="dialog"] input[placeholder*="Cerca un modello"]', '')
    await sleep(300)
    await setDark(r.pageEval, true)
    await r.shot('i1-popover-scuro.png')
    await setDark(r.pageEval, false)
    // il popover si chiude con Esc
    await r.pageEval(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await sleep(400)

    // ============================ I2 · riserve, provider sul posto, collegamento ============================
    await gotoSection(r, 'Modelli')
    await sleep(500)
    await clickText(r.pageEval, 'Aggiungi riserva', 'button', true)
    await sleep(400)
    await clickText(r.pageEval, 'Aggiungi riserva', 'button', true)
    await sleep(400)
    check('I2a due righe riserva aggiunte (2. e 3. sotto il principale)',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"] [role="combobox"]')].length >= 3`, 10_000))
    // la prima riserva: gemma3-finta; la seconda: un modello dell'ALTRO provider
    const combos = () => r.pageEval(`return [...document.querySelectorAll('[role="dialog"] button[role="combobox"]')]`)
    const openComboAt = async (i) => {
      await r.pageEval(`[...document.querySelectorAll('[role="dialog"] button[role="combobox"]')][${i}]?.click()`)
      await sleep(400)
    }
    const chooseOption = async (name) => {
      check(`I2 scelta ${name}`, await r.waitDom(
        `[...document.querySelectorAll('[role="dialog"] [role="option"]')].some((o) => o.textContent.includes(${JSON.stringify(name)}))`, 6000))
      await clickText(r.pageEval, name, '[role="dialog"] [role="option"]')
      await sleep(450)
    }
    await openComboAt(1)
    await chooseOption('gemma3-finta')
    await openComboAt(2)
    await chooseOption('GPT Mini Finto')
    // sposta la SECONDA riserva in alto (⋯ → Sposta su)
    await pointerClick(r.pageEval, `[...document.querySelectorAll('[role="dialog"] [aria-label="Altre azioni"]')][1]`)
    await sleep(500)
    await clickText(r.pageEval, 'Sposta su', '[role="menu"] [role="menuitem"]', true)
    await sleep(500)
    const chainAfter = await r.rpc(`settingsGet(${JSON.stringify('models.fallbackChain')}, [])`)
    check('I2b la riserva SPOSTATA si salva (GPT Mini Finto passa PRIMA di gemma3)',
      Array.isArray(chainAfter) && chainAfter.length === 2 && chainAfter[0]?.model === 'gpt-mini-finto' && chainAfter[1]?.model === 'gemma3-finta',
      JSON.stringify(chainAfter))
    await r.shot('i2-riserve.png')

    // il provider si apre SUL POSTO (riga → dettaglio con nome, chiave, prova, modelli).
    // la riga è un bottone che NON è il combobox di una riserva (anche lei porta il nome)
    await r.pageEval(`
      const row = [...document.querySelectorAll('[role="dialog"] button:not([role="combobox"])')]
        .find((b) => b.textContent.includes('OpenAI (finto)') && b.offsetParent !== null)
      if (!row) throw new Error('riga del provider non trovata')
      row.click()
      return 'aperto'
    `)
    check('I2c il provider si apre sul posto (nome, chiave ••••, prova automatica)',
      await r.waitDom(`!![...document.querySelectorAll('[role="dialog"] input[placeholder="Nome"]')].length && [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('••••'))`, 8000))
    check('I2d la prova automatica trova i modelli del server finto',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('2 modelli disponibili'))`, 15_000))
    await scrollIntoView(r.pageEval, `document.querySelector('[role="dialog"] input[placeholder="Nome"]')`)
    await sleep(400)
    await r.shot('i2-provider-aperto.png')
    await clickText(r.pageEval, 'Salva', '[role="dialog"] button', true)
    await sleep(600)

    // «+ Aggiungi provider»: elenco con ricerca, poi collegamento RIUSCITO
    await clickText(r.pageEval, 'Aggiungi provider', 'button', true)
    check('I2e il foglio di collegamento apre l\'elenco dei tipi (con ricerca)',
      await r.waitDom(`!!document.querySelector('input[placeholder*="Cerca (Ollama"]') && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Anthropic'))`, 8000))
    await r.shot('i2-aggiungi-provider.png')
    // la cattura di fondo prova che l'elenco arriva fino a «Un altro server»
    await r.pageEval(`
      const group = [...document.querySelectorAll('p')].find((x) => x.textContent.trim() === 'Un altro server')
      group?.scrollIntoView({ block: 'center' })
      return group ? 'fondo' : 'niente'
    `)
    await sleep(300)
    await r.shot('i2-aggiungi-provider-fondo.png')
    await clickText(r.pageEval, 'Mistral', 'div button')
    await sleep(400)
    // Avanzate → baseUrl del server finto; chiave finta; la prova parte da sola
    await clickText(r.pageEval, 'Avanzate', 'button')
    await sleep(300)
    await setInput(r.pageEval, 'input[placeholder="Base URL"]', OPENAI_BASE)
    await sleep(250)
    await setInput(r.pageEval, 'input#sandbot-addprovider-key', 'chiave-finta-di-prova')
    check('I2f la prova della chiave contro il server finto passa',
      await r.waitDom(`[...document.querySelectorAll('p')].some((p) => p.textContent.includes('2 modelli disponibili'))`, 15_000))
    await r.shot('i2-collega-mistral.png')
    await clickText(r.pageEval, 'Collega Mistral', 'button')
    await sleep(900)
    const providersNow = await r.rpc('listProviders()')
    check('I2g Mistral (finto) collegato: il conteggio dei provider cresce di uno',
      Array.isArray(providersNow) && providersNow.length === 4 && providersNow.some((p) => p.kind === 'mistral'),
      `provider: ${providersNow?.map((p) => p.kind).join(', ')}`)
    await scrollIntoView(r.pageEval, `[...document.querySelectorAll('[role="dialog"] button:not([role="combobox"])')].find((b) => b.textContent.includes('Mistral'))`)
    await sleep(400)
    await r.shot('i2-collegato.png')

    // ============================ I4 · i tre modi ============================
    await gotoSection(r, 'Approvazioni')
    await sleep(500)
    check('I4a la pagina ha il titolo e le tre pillole (Chiedi · Automatico · Non chiedere)',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"] h2')].some((h) => h.textContent.trim() === 'Approvazioni') &&
        [...document.querySelectorAll('[role="radiogroup"] button')].length === 3`, 8000))
    await r.shot('i4-modalita-chiedi.png')
    // Automatico: riga del modello + liste di regole
    await clickText(r.pageEval, 'Automatico', '[role="radiogroup"] button')
    await sleep(500)
    await setInput(r.pageEval, 'input[placeholder*="es. comandi ls"]', 'le letture della home del bot')
    await clickText(r.pageEval, 'Aggiungi', '[role="dialog"] button')
    await sleep(400)
    check('I4b Automatico mostra la riga del modello delle approvazioni e le regole',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('Modello delle approvazioni')) &&
        [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('Continua da solo quando'))`, 8000))
    await r.shot('i4-modalita-automatico.png')
    // I2.2: su Automatico senza revisore, la riga del revisore in Modelli lo
    // dice in ARANCIONE (con il link alle Approvazioni)
    await gotoSection(r, 'Modelli')
    await sleep(500)
    check('I2h su Automatico senza revisore, Modelli mostra l\'avviso arancione',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"] p')].some((p) => getComputedStyle(p).color.includes('rgb(180, 83, 9') || getComputedStyle(p).color.includes('rgb(217, 119, 6') || p.className.includes('amber'))`, 6000))
    await r.shot('i2-revisore-mancante.png')
    await gotoSection(r, 'Approvazioni')
    await sleep(500)
    // Non chiedere: la CONFERMA con Annulla / Non chiedere più
    await clickText(r.pageEval, 'Non chiedere', '[role="radiogroup"] button')
    check('I4c la conferma di «Non chiedere» dice le due differenze (blocchi e bozze)',
      await r.waitDom(`[...document.querySelectorAll('p')].some((p) => p.textContent.includes('le azioni bloccate restano bloccate') && p.textContent.includes('bozze'))`, 6000))
    await r.shot('i4-conferma-non-chiedere.png')
    await clickText(r.pageEval, 'Annulla', 'button')
    await sleep(400)
    const modeAfterCancel = await r.rpc(`settingsGet(${JSON.stringify('approvals.mode')}, ${JSON.stringify('ask')})`)
    check('I4d Annulla NON cambia il modo', modeAfterCancel === 'ask' || modeAfterCancel === 'auto', JSON.stringify(modeAfterCancel))
    // le regole per strumento sotto «Avanzate», con i nomi umani
    await clickText(r.pageEval, 'Regole per strumento', 'button')
    await sleep(500)
    check('I4e le regole per strumento mostrano il nome UMANO (Comandi) e il tecnico piccolo sotto (run-command)',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('Comandi') && d.textContent.includes('run-command'))`, 8000))
    check('I4f message_user è tra le regole di default (Progressi in chat)',
      await r.waitDom(`[...document.querySelectorAll('[role="dialog"] code')].some((c) => c.textContent.includes('message_user'))`, 6000))
    await scrollIntoView(r.pageEval, `[...document.querySelectorAll('[role="dialog"] code')].find((c) => c.textContent.includes('message_user'))`)
    await sleep(400)
    await r.shot('i4-avanzate-regole.png')

    // ============================ I6 · il modello nel pannello del bot ============================
    await r.pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await sleep(600)
    await r.setWindowWidth(1440)
    await sleep(2500)
    // l'Esc della sonda può aver chiuso anche il pannello (a 900 era overlay):
    // se serve si RIAPRE col bottone PanelRight, come nella sonda grafica
    const panelRight = await r.pageEval(`return [...document.querySelectorAll('button')].filter((b) => b.querySelector('svg.lucide-panel-right')).length`)
    if (panelRight > 0) {
      await pointerClick(r.pageEval, `[...document.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-panel-right'))`)
      await sleep(700)
    }
    // il pannello del bot: scheda Avanzate → ModelSelect con «Come gli altri»
    await clickText(r.pageEval, 'Avanzate', 'button')
    check('I6a il pannello del bot ha un solo ModelSelect con «Come gli altri»',
      await r.waitDom(`[...document.querySelectorAll('button[role="combobox"]')].some((b) => b.textContent.includes('Come gli altri'))`, 8000))
    await r.shot('i6-pannello-come-altri.png')
    // un modello di un ALTRO provider
    await r.pageEval(`[...document.querySelectorAll('button[role="combobox"]')].find((b) => b.textContent.includes('Come gli altri'))?.click()`)
    await sleep(400)
    await clickText(r.pageEval, 'GPT Finto', '[role="option"]')
    await sleep(500)
    const agentOwn = (await r.rpc('listAgents()'))[0]
    check('I6b la scelta di un modello proprio si salva (provider + modello del bot)',
      agentOwn?.providerId === 'openai-finto' && agentOwn?.model === 'gpt-finto', JSON.stringify({ p: agentOwn?.providerId, m: agentOwn?.model }))
    await r.shot('i6-pannello-modello-proprio.png')
    // di nuovo «Come gli altri» → null/null nel db
    await r.pageEval(`[...document.querySelectorAll('button[role="combobox"]')].find((b) => b.offsetParent !== null)?.click()`)
    await sleep(400)
    await clickText(r.pageEval, 'Come gli altri', '[role="option"]')
    await sleep(500)
    const agentFollow = (await r.rpc('listAgents()'))[0]
    check('I6c «Come gli altri» di nuovo → null/null nel db', agentFollow?.providerId === null && agentFollow?.model === null,
      JSON.stringify({ p: agentFollow?.providerId, m: agentFollow?.model }))

    // una in inglese (Generali, 1440, chiaro): la lingua dell'interfaccia —
    // per ULTIMA, così non serve tornare all'italiano
    await r.rpc(`settingsSet(${JSON.stringify('ui.language')}, ${JSON.stringify('en')})`)
    await reloadApp(r)
    await resizeAndReopen(r, 1440)
    await gotoSection(r, 'General')
    await sleep(400)
    await r.shot('i5-inglese-generale.png')

    // la corsa principale finisce: app e daemon chiusi (la fixture è un'altra corsa)
    main.stop()
    await sleep(800)
    await stopDaemon(DATA)
  } catch (e) {
    failures++
    console.error('\n[sonda] ERRORE (corsa principale):', e.message ?? e)
    try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
    console.error(main.getLog().slice(-1200))
    main.stop()
    await sleep(800)
    await stopDaemon(DATA)
  }

  // ============================ I8 · la fixture della 0.3.1001 ============================
  const FIX_PORT = 9342
  const fx = launchApp(FIXTURE, FIX_PORT)
  try {
    log('seconda corsa: cartella FIXTURE coi setting di una 0.3.1001…')
    let f = await run(FIX_PORT, FIXTURE)
    if (!(await f.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile (fixture)')
    }
    // il provider di allora: l'Ollama FINTO pre-semenato (id 'ollama'), con i
    // modelDefaults di OGGI
    // i setting COME LI AVEVA una 0.3.1001: main sull'Ollama, catena VUOTA,
    // revisore mai scelto, auto-review ACCESA con regole, override vuoto
    await f.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'ollama', model: 'kimi-f3-finto', thinking: null })})`)
    await f.rpc(`settingsSet(${JSON.stringify('models.fallbackChain')}, ${JSON.stringify([])})`)
    await f.rpc(`settingsSet(${JSON.stringify('providers.modelDefaults')}, ${JSON.stringify({})})`)
    await f.rpc(`settingsSet(${JSON.stringify('autoReview')}, ${JSON.stringify({ enabled: true, allowRules: ['le letture della home del bot'], blockRules: [], providerId: null, model: null })})`)
    // i flag della migrazione si azzerano: la fixture «non l'ha mai vista»
    // (approvals.mode = '' simula l'assenza del setting, che la RPC non sa cancellare)
    await f.rpc(`settingsSet(${JSON.stringify('models.fallbackMaterialized')}, false)`)
    await f.rpc(`settingsSet(${JSON.stringify('autoReview.materialized')}, false)`)
    await f.rpc(`settingsSet(${JSON.stringify('approvals.modeSet')}, false)`)
    await f.rpc(`settingsSet(${JSON.stringify('approvals.mode')}, ${JSON.stringify('')})`)
    // RI AVVIO: la migrazione gira al primo avvio del daemon
    log('riavvio sulla fixture per far girare le migrazioni…')
    fx.stop()
    await sleep(800)
    await stopDaemon(FIXTURE)
    const fx2app = launchApp(FIXTURE, FIX_PORT)
    try {
      await sleep(1500)
      const f2 = await run(FIX_PORT, FIXTURE)
      if (!(await f2.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.settingsGet`, 40_000))) {
        throw new Error('window.sandbot non disponibile (fixture, secondo avvio)')
      }
      const chain = await f2.rpc(`settingsGet(${JSON.stringify('models.fallbackChain')}, [])`)
      const review = await f2.rpc(`settingsGet(${JSON.stringify('autoReview')}, null)`)
      const mode = await f2.rpc(`settingsGet(${JSON.stringify('approvals.mode')}, null)`)
      check('I8a la riserva implicita è VISIBILE: prima voce della catena (glm-5.3:cloud)',
        Array.isArray(chain) && chain.length === 1 && chain[0]?.providerId === 'ollama' && chain[0]?.model === 'glm-5.3:cloud',
        JSON.stringify(chain))
      check('I8b il revisore è VISIBILE (autoReview con provider e modello del tipo)',
        review?.providerId === 'ollama' && review?.model === 'glm-5.3-flash:cloud', JSON.stringify(review))
      check('I8c il modo nasce Automatico (autoReview.enabled era true)', mode === 'auto', JSON.stringify(mode))
      check('I8d NESSUNA regola persa', review?.allowRules?.[0] === 'le letture della home del bot', JSON.stringify(review?.allowRules))
      // le pagine della fixture, come le vede chi apre la cartella di ieri
      await f2.setWindowWidth(1440)
      if (!(await ensureSettings(f2))) throw new Error('le Impostazioni non si aprono (fixture)')
      await gotoSection(f2, 'Modelli')
      await sleep(900)
      await f2.shot('i8-fixture-modelli.png')
      await gotoSection(f2, 'Approvazioni')
      await sleep(500)
      check('I8e la pagina Approvazioni della fixture mostra Automatico ATTIVO',
        await f2.waitDom(`[...document.querySelectorAll('[role="radiogroup"] button')].some((b) => b.getAttribute('aria-checked') === 'true' && b.textContent.includes('Automatico'))`, 8000))
      await f2.shot('i8-fixture-approvazioni.png')
    } finally {
      fx2app.stop()
      await sleep(800)
      await stopDaemon(FIXTURE)
    }
  } catch (e) {
    failures++
    console.error('\n[sonda] ERRORE (fixture):', e.message ?? e)
    try { console.error('--- daemon.log ---\n' + readFileSync(join(FIXTURE, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
    fx.stop()
    await sleep(800)
    await stopDaemon(FIXTURE)
  }
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { fake.closeAllConnections?.(); fake.close() } catch { /* già chiusa */ }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid(DATA) ?? daemonPid(FIXTURE)
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
