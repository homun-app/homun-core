#!/usr/bin/env node
// Sonda Electron della fase app — Composio (A1–A9). L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, provider FINTO
// openai-compatible su 127.0.0.1 e client Composio FINTO da file
// (SANDBOT_TEST_FAKE_COMPOSIO, valido solo insieme alle altre SANDBOT_TEST_*:
// mai una chiamata vera a Composio, mai il Portachiavi/safeStorage veri,
// niente Docker). Copre:
//   A1: la finestra «App» senza la parola «MCP» nella vista principale e col
//       foglio «Per sviluppatori» raggiungibile dal link in fondo;
//   A2: le tre schermate dell'attivazione (cos'è → chiave → prova) e
//       «Composio attivo» col finto;
//   A3: la lista unica con Gmail UNA volta sola (la curata vince) e le app
//       del catalogo finto dopo le curate;
//   A4: Collega su un'app finta (Slack): foglio d'attesa del login, poi la
//       riga passa in «Collegate»;
//   A5/A6: un turno col provider finto che chiama
//       composio__slack__SLACK_SEND_MESSAGE → BOZZA → Invia → UNA execute
//       sul finto (letta dal log <file>.calls.log); una LETTURA che passa
//       senza card; una SCRITTTURA che produce la card d'approvazione.
// RITOCCHI (R1–R4):
//   R1: la notice della MIGRAZIONE dei box (info, grigia) e quella di un
//       INVIO FALLITO (error, rossa) con colori calcolati DIVERSI — la
//       migrazione si provoca riavviando l'app con SANDBOT_TEST_LEGACY_BOX_ROOT
//       puntato a una cartella DENTRO il temporaneo (mai la home vera);
//   R2: dopo un invio RIUSCITO nessuna notice nuova e l'esito nei
//       «Dettagli» della card; l'invio FALLITO (server MCP «spalto» su stdio
//       che muore alla chiamata) fa UNA notice senza nomi tecnici;
//   R3: nella card d'approvazione visibile nessun composio__/mcp__ (il nome
//       tecnico vive nei «Dettagli tecnici» chiusi);
//   R4: il titolo «Slack · Crea promemoria» in italiano e «Slack · Create
//       reminder» in inglese (cambio lingua a caldo + ricarica).
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-app-composio-')
const DATA = join(TMP, 'data')
// ritocchi (R1–R4): le catture della fase corrente
const RITOCCHI = join(ROOT, 'docs', 'catture', 'app-composio-ritocchi')
mkdirSync(RITOCCHI, { recursive: true })

// ---- il server MCP FINTO «spalto» (R2/R1): risponde a initialize e
// tools/list, poi alla PRIMA tools/call MUORE — così l'invio della bozza
// fallisce con un errore vero (throw) e la notice esce ROSSA. Solo stdio,
// nessuna rete.
const SPALTO = join(TMP, 'spalto-server.mjs')
writeFileSync(SPALTO, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg = null
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'spalto', version: '1' } } })
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'send_message',
      description: 'Invia un messaggio (finto della sonda, muore alla chiamata)',
      inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] }
    }] } })
  } else if (msg.method === 'tools/call') {
    // qui MUORE: la pipe si spezza e la chiamata del daemon fallisce
    process.exit(1)
  }
})
`)
const SHOTS = join(ROOT, 'docs', 'catture', 'app-composio')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

// ---- il client Composio FINTO (file JSON letto dal daemon via env) ----
// GMAIL c'è APPOSTA: la curata vince e la riga deve restare UNA (A3).
// SLACK ha l'invio (bozza), la lettura (senza card) e la scrittura (card).
const FAKE_COMPOSIO = join(TMP, 'composio-finto.json')
const CALLS_LOG = `${FAKE_COMPOSIO}.calls.log`
writeFileSync(FAKE_COMPOSIO, JSON.stringify({
  autoLoginMs: 900,
  toolkits: [
    { slug: 'SLACK', name: 'Slack', description: 'Canali e messaggi del team', category: 'Chat' },
    { slug: 'GMAIL', name: 'Gmail', description: 'Posta in arrivo e bozze', category: 'Mail' },
    { slug: 'WEATHER', name: 'Weather', description: 'Meteo della tua città', category: 'Tools', noAuth: true },
    { slug: 'OLDCRM', name: 'Old CRM', description: 'Contatti del vecchio CRM', category: 'CRM', developerConfig: true },
    { slug: 'HUBSPOT', name: 'HubSpot', description: 'Contatti e pipeline', category: 'CRM' }
  ],
  tools: {
    SLACK: [
      { slug: 'SLACK_SEND_MESSAGE', name: 'Send message', description: 'Send a message to a channel', version: '20260101_00', inputParameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
      { slug: 'SLACK_LIST_CHANNELS', name: 'List channels', description: 'List the channels of the workspace', version: '20260101_00', inputParameters: { type: 'object', properties: {} } },
      { slug: 'SLACK_CREATE_REMINDER', name: 'Create reminder', description: 'Create a reminder in a channel', version: '20260101_00', inputParameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } }
    ],
    WEATHER: [
      { slug: 'WEATHER_GET_TODAY', name: 'Get today', description: 'Today weather', version: '20260101_00', inputParameters: { type: 'object', properties: {} } }
    ]
  }
}, null, 2))

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
// Le risposte sono uno script in coda: prima la chiamata allo strumento
// Composio, poi la risposta finale all'utente.
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
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
providerPort = providerServer.address().port

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
// Vincoli: env -i HOME/PATH + SANDBOT_TEST_USER_DATA/FAKE_KEYCHAIN/
// FAKE_SAFESTORAGE + SANDBOT_TEST_FAKE_COMPOSIO (il client Composio finto).
// R1 (ritocchi): launchApp riavvia l'app col MEDESIMO env (+extra, es.
// SANDBOT_TEST_LEGACY_BOX_ROOT dentro il temporaneo) per provare la notice
// della migrazione dei box.
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9339
let appLog = ''
let app = null
const launchApp = (extraEnv = {}) => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
      SANDBOT_TEST_FAKE_COMPOSIO: FAKE_COMPOSIO,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
app = launchApp()
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
/** Aspetta che il processo esca davvero (SIGTERM → exit). */
const waitAppExit = async (proc, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(proc.pid, 0); await sleep(250) } catch { return true }
  }
  try { proc.kill('SIGKILL') } catch { /* già via */ }
  return false
}

/** Il pid del daemon di QUESTA cartella dati (daemon.lock), se già scritto. */
const daemonPid = () => {
  try {
    const v = JSON.parse(readFileSync(join(DATA, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
/** A fine sonda si chiude ANCHE il daemon di sviluppo (Vincoli della fase). */
const stopDaemon = async () => {
  const pid = daemonPid()
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
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
/** La pagina del renderer via CDP (riusata anche dopo il riavvio R1). */
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
let page = await waitForPage()
log('CDP collegato al renderer')

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
/** Le catture dei RITOCCHI finiscono nella loro cartella. */
const shotR = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(RITOCCHI, name), Buffer.from(r.data, 'base64'))
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
const clickByLabel = (label) => pageEval(`
  const b = [...document.querySelectorAll('button')]
    .find((x) => (x.getAttribute('aria-label') === ${JSON.stringify(label)} || x.title === ${JSON.stringify(label)}) && x.offsetParent !== null)
  if (!b) throw new Error('bottone non trovato: ' + ${JSON.stringify(label)})
  b.click()
  return 'cliccato'
`)
const clickByText = (text, scope = 'button') => pageEval(`
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
    .filter((x) => x.offsetParent !== null)
    .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
  if (!b) throw new Error('nessun bottone col testo: ' + ${JSON.stringify(text)})
  b.click()
  return 'cliccato'
`)
const clickTestid = (testid) => pageEval(`
  const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
  const b = el.matches('button') ? el : el.querySelector('button')
  ;(b ?? el).click()
  return 'cliccato'
`)
/** clicca, dentro l'elemento testid, l'ULTIMO bottone che contiene il testo
 *  (il foglio di attivazione impila i passi: l'Avanti buono è l'ultimo) */
const clickInTestid = (testid, text) => pageEval(`
  const root = [...document.querySelectorAll('[data-testid=' + ${JSON.stringify(testid)} + ']')].find((x) => x.offsetParent !== null)
  if (!root) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
  const all = [...root.querySelectorAll('button')].filter((x) => x.offsetParent !== null && x.textContent.includes(${JSON.stringify(text)}))
  const b = all[all.length - 1]
  if (!b) throw new Error('bottone non trovato dentro ${testid}: ' + ${JSON.stringify(text)})
  b.click()
  return 'cliccato'
`)
const clickSidebar = (name) => pageEval(`
  const sidebar = document.querySelector('aside')
  const b = sidebar && [...sidebar.querySelectorAll('button')]
    .find((x) => x.textContent.trim().startsWith(${JSON.stringify(name)}) && x.offsetParent !== null && !x.getAttribute('aria-expanded'))
  if (!b) throw new Error('riga della barra non trovata: ' + ${JSON.stringify(name)})
  b.click()
  return 'selezionato'
`)
/** il dialogo della finestra App: a 900 px anche il pannello del bot è un
 *  overlay role=dialog — si riconosce la finestra App dalla sua sezione */
const APP_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes('Tutte le app'))`
const setDark = async (dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(350)
}
/** le 4 varianti di viewport/tema per le catture */
const VARIANTS = [
  [1440, false, '1440-chiaro'],
  [1440, true, '1440-scuro'],
  [900, false, '900-chiaro'],
  [900, true, '900-scuro']
]

/** le execute registrate dal finto su file (una riga JSON per chiamata) */
const fakeCalls = () => {
  try {
    return readFileSync(CALLS_LOG, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
/** aspetta che il log del finto raggiunga N righe */
const waitFakeCalls = async (n, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fakeCalls().length >= n) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- configurazione: provider finto + il bot principale ----
  log('configuro provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await page.send('Page.reload')
  check('setup compositore pronto', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await setWindowWidth(1440)

  // ============ A1: la finestra «App» senza «MCP» ============
  await clickByLabel('App')
  check('A1a la finestra App si apre', await waitDom(`!!document.querySelector('[data-testid="developers-link"]')`, 10_000))
  const mainText = await pageEval(`return document.querySelector('[role="dialog"]').textContent`)
  check('A1b la parola «MCP» NON compare nella vista principale', !mainText.includes('MCP'), `presente: ${mainText.match(/MCP/g)?.length ?? 0} volte`)
  check('A1c le sezioni sono Collegate / Tutte le app / Skill dei bot',
    mainText.includes('Collegate') && mainText.includes('Tutte le app') && mainText.includes('Skill dei bot'))
  // il foglio sviluppatori si raggiunge dal link piccolo in fondo
  await clickTestid('developers-link')
  check('A1d il foglio «Per sviluppatori» si apre (lì «MCP» c\'è e va bene)',
    await waitDom(`!!document.querySelector('[data-testid="developers-sheet"]')`, 8_000))
  const devText = await pageEval(`return document.querySelector('[data-testid="developers-sheet"]').textContent`)
  check('A1e il foglio ha server personalizzati, gateway, plugin e registro',
    devText.includes('Server MCP personalizzato') && devText.includes('gateway') && devText.includes('marketplace') && devText.includes('registro'))
  await pageEval(`document.querySelector('[data-testid="developers-sheet"]').parentElement.click()`)
  await sleep(400)

  // ============ A2: le tre schermate dell'attivazione ============
  check('A2a la card «Più di mille app con Composio» è in cima a Tutte le app',
    await waitDom(`!!document.querySelector('[data-testid="composio-card"]')`, 8_000))
  // cattura: la vista principale PRIMA dell'attivazione (col foglio chiuso)
  await clickTestid('composio-card') // il bottone Attiva sta dentro la card
  check('A2b il foglio di attivazione si apre', await waitDom(`!!document.querySelector('[data-testid="composio-activation"]')`, 8_000))
  const step1 = await pageEval(`return document.querySelector('[data-testid="composio-activation"]').textContent`)
  check('A2c passo 1: cos\'è (servizio di terzi + piano gratuito) e «Apri Composio»',
    step1.includes('servizio di terzi') && step1.includes('piano gratuito') && step1.includes('Apri Composio'))
  // catture passo 1 (1440/900 × chiaro/scuro)
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`attivazione-1-${tag}.png`)
  }
  await setDark(false)
  await clickInTestid('composio-activation', 'Avanti')
  await sleep(300)
  const step2 = await pageEval(`return document.querySelector('[data-testid="composio-activation"]').textContent`)
  check('A2d passo 2: incolla la chiave, con «Dove la trovo?» e il campo password',
    step2.includes('Incolla la chiave') && step2.includes('Dove la trovo') && !!await pageEval(`return !!document.querySelector('[data-testid="composio-activation"] input[type="password"]')`))
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`attivazione-2-${tag}.png`)
  }
  await setDark(false)
  await pageEval(`
    const input = document.querySelector('[data-testid="composio-activation"] input[type="password"]')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, 'ak_finta_sonda_000111')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'chiave incollata'
  `)
  await clickInTestid('composio-activation', 'Avanti')
  await sleep(300)
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`attivazione-3-${tag}.png`)
  }
  await setDark(false)
  await clickInTestid('composio-activation', 'Prova la chiave')
  check('A2e passo 3: la prova riesce col finto → «Composio attivo»',
    await waitDom(`!!document.querySelector('[data-testid="composio-active"]')`, 15_000))
  // la chiave NON torna mai: lo status porta solo hint
  const status = await rpc('composioStatus()')
  check('A2f lo status porta hasKey e le ultime 4 (…0111), mai la chiave',
    status.hasKey === true && status.keyHint === '…0111' && !JSON.stringify(status).includes('ak_finta_sonda_000111'),
    JSON.stringify({ hasKey: status.hasKey, keyHint: status.keyHint }))
  await clickInTestid('composio-activation', 'Fatto')
  await sleep(500)

  // ============ A3: la lista unica ============
  check('A3a le app del catalogo finto arrivano dopo le curate',
    await waitDom(`!!document.querySelector('[data-testid="composio-row-slack"]')`, 15_000))
  // a 900 px (ultime catture) il pannello del bot è un overlay role=dialog:
  // si torna a 1440 e si prende il dialogo GIUSTO (quello con «Tutte le app»)
  await setWindowWidth(1440)
  const gmailRows = await pageEval(`
    const dialog = ${APP_DIALOG}
    if (!dialog) return -1
    // i NOMI delle righe sono span col testo esatto: Gmail deve comparire UNA
    // volta sola in tutto il dialog (curata sì, toolkit Composio no)
    return [...dialog.querySelectorAll('span, button, p')]
      .filter((d) => d.offsetParent !== null && d.textContent.trim() === 'Gmail').length
  `)
  check('A3b Gmail compare UNA volta sola (la curata vince sul toolkit Composio)', gmailRows === 1,
    gmailRows === 1 ? 'righe Gmail: 1' : `righe Gmail: ${gmailRows} — dialog: ${String(await pageEval(`return (${APP_DIALOG})?.textContent.slice(0, 300)`)).slice(0, 300)}`)
  const hubspot = await pageEval(`return !!document.querySelector('[data-testid="composio-row-hubspot"]')`)
  check('A3c le altre app Composio ci sono (HubSpot)', hubspot)
  const oldCrmTitle = await pageEval(`
    const row = document.querySelector('[data-testid="composio-row-oldcrm"] button')
    return row ? row.title : ''
  `)
  check('A3d il toolkit «da sviluppatore» ha la riga chiara nel titolo del bottone',
    oldCrmTitle.includes('configurata dallo sviluppatore'), oldCrmTitle.slice(0, 60))

  // ============ A4: Collega su un'app finta (Slack, OAuth con redirect) ============
  await clickTestid('composio-row-slack')
  check('A4a il dettaglio dell\'app si apre dal bottone della riga',
    await waitDom(`!!document.querySelector('[data-testid="composio-app-sheet"]')`, 8_000))
  await clickInTestid('composio-app-sheet', 'Collega')
  check('A4b il foglio d\'attesa del login compare (con la provenienza, A7)',
    await waitDom(`!!document.querySelector('[data-testid="composio-waiting"]')`, 8_000),
    `foglio dettaglio dopo il clic: ${String(await pageEval(`return document.querySelector('[data-testid="composio-app-sheet"]')?.textContent.slice(0, 200)`)).slice(0, 200)}`)
  const waitingText = await pageEval(`return document.querySelector('[data-testid="composio-waiting"]').textContent`)
  check('A4c il foglio d\'attesa dice «In attesa del login nel browser…» con Annulla',
    waitingText.includes('In attesa del login nel browser') && waitingText.includes('Annulla'))
  // il login finto completa da solo (autoLoginMs): la riga passa in Collegate
  check('A4d il collegamento completa e Slack va in «Collegate»',
    await waitDom(`!![...((${APP_DIALOG})?.querySelectorAll('button') ?? [])].some((b) => b.textContent.includes('Slack') && b.textContent.includes('Collegata'))`, 20_000))
  const status2 = await rpc('composioStatus()')
  const slackApp = (status2.connected ?? []).find((a) => a.slug === 'slack')
  check('A4e lo status ha Slack ACTIVE con le azioni caricate', slackApp?.status === 'ACTIVE' && (slackApp?.toolsCount ?? 0) >= 3, JSON.stringify(slackApp))

  // ---- catture: vista principale (collegata) e dettaglio di un'app Composio ----
  // riapre la finestra se il dialog è stato chiuso dai fogli
  if (!(await pageEval(`return !!(${APP_DIALOG})`))) {
    await clickByLabel('App')
    await waitDom(`!!document.querySelector('[data-testid="developers-link"]')`, 8_000)
  }
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`app-${tag}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)
  // il dettaglio di Slack dalla riga di «Collegate»
  await pageEval(`
    const dialog = ${APP_DIALOG}
    const row = [...((dialog ?? document).querySelectorAll('button'))]
      .find((b) => b.textContent.includes('Slack') && b.textContent.includes('Collegata'))
    if (!row) throw new Error('riga Slack in Collegate non trovata')
    row.click()
    return 'dettaglio'
  `)
  check('A4f il dettaglio dell\'app Composio si apre (provenienza + per bot + Scollega)',
    await waitDom(`!![...document.querySelectorAll('[data-testid="composio-app-sheet"] div')].some((d) => d.offsetParent !== null && d.textContent.includes('per bot:'))`, 8_000))
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`dettaglio-${tag}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)
  await pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await sleep(400)
  // chiude anche la finestra App: il turno si svolge in chat
  await pageEval(`
    const dialog = ${APP_DIALOG}
    const x = [...((dialog ?? document).querySelectorAll('button'))].find((b) => b.getAttribute('aria-label') === 'Chiudi')
    x?.click()
    return 'chiusa'
  `)
  await sleep(500)

  // ============ A5/A6: il turno col provider finto ============
  // dopo i cicli 900/1440 la barra laterale può restare in modalità rail:
  // si ricarica la pagina (stato pulito, stessi dati) e si torna al bot
  await page.send('Page.reload')
  check('setup chat pronta dopo il reload', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await clickSidebar(bot.name ?? 'Bot')
  await sleep(400)

  // --- l'invio: chiamata diretta a composio__slack__SLACK_SEND_MESSAGE → BOZZA ---
  pushTool('composio__slack__SLACK_SEND_MESSAGE', { channel: '#sonda', text: 'ciao dalla sonda' })
  pushText('Bozza pronta: controllala tu.')
  await uiSend('Manda un messaggio su Slack.')
  check('A5a la chiamata diretta all\'invio diventa BOZZA (card Invia/Scarta)',
    await waitDom(`!![...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Invia')`, 30_000))
  check('A5b nessuna execute sul finto PRIMA del click su Invia', fakeCalls().length === 0)
  const noticesOf = async () => (await rpc(`getEntries(${JSON.stringify(bot.id)})`)).filter((e) => e.kind === 'notice')
  const noticesBeforeSend = (await noticesOf()).length
  await clickByText('Invia')
  check('A5c dopo «Invia» c\'è UNA execute sul finto, con la versione dello schema',
    (await waitFakeCalls(1)) && !!fakeCalls()[0] && fakeCalls()[0].includes('SLACK_SEND_MESSAGE') && fakeCalls()[0].includes('20260101_00'))
  await sleep(1_500)
  const calls1 = fakeCalls()
  check('A5d il log del finto ha ESATTAMENTE una riga (una execute sola)',
    calls1.length === 1, `righe: ${calls1.length}`)
  check('A5e gli argomenti sono quelli della bozza', calls1[0]?.includes('#sonda') && calls1[0]?.includes('ciao dalla sonda'))

  // ============ R2 (ritocchi): invio riuscito → NESSUNA notice, esito nei Dettagli ============
  const noticesAfterSend = await noticesOf()
  check('R2a invio riuscito: NESSUNA notice nuova (la card è l\'unica conferma)',
    noticesAfterSend.length === noticesBeforeSend,
    `notice dopo: ${noticesAfterSend.length} (prima ${noticesBeforeSend}) — ultime: ${noticesAfterSend.slice(-2).map((n) => n.content.slice(0, 60)).join(' | ')}`)
  const sentEntry = (await rpc(`getEntries(${JSON.stringify(bot.id)})`)).findLast((e) => e.meta?.message?.type === 'draft')
  check('R2b l\'esito è nel meta.sendResult della card (non in chat)',
    sentEntry?.meta?.status === 'sent' && typeof sentEntry?.meta?.sendResult === 'string' && sentEntry.meta.sendResult.includes('"ok":true'),
    JSON.stringify({ status: sentEntry?.meta?.status, sendResult: sentEntry?.meta?.sendResult?.slice(0, 60) }))
  // la riga «✓ Inviata a …» si riapre in sola lettura: DENTRO, il «Dettagli» CHIUSO
  check('R2c la bozza inviata diventa la riga «Inviata a …»',
    await waitDom(`[...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.includes('Inviata a'))`, 10_000))
  await pageEval(`
    const row = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.includes('Inviata a'))
    if (!row) throw new Error('riga della bozza inviata non trovata')
    row.click()
    return 'card riaperta in sola lettura'
  `)
  await sleep(350)
  const draftDetails = await pageEval(`
    const d = document.querySelector('[data-testid="draft-details"]')
    return d ? { closed: !d.open, text: d.textContent } : null
  `)
  check('R2d la card riaprata ha il «Dettagli» CHIUSO col nome tecnico e l\'esito',
    !!draftDetails && draftDetails.closed &&
    draftDetails.text.includes('composio__slack__SLACK_SEND_MESSAGE') && draftDetails.text.includes('"ok":true'),
    JSON.stringify(draftDetails)?.slice(0, 120))
  // si APRE il Dettagli per le catture: l'esito in monospazio, mai JSON in chat
  await pageEval(`document.querySelector('[data-testid="draft-details"] summary').click(); return 'dettagli aperti'`)
  await sleep(300)
  const dettagliVisible = await pageEval(`return document.querySelector('[data-testid="draft-details"]').innerText`)
  check('R2e i Dettagli aperti mostrano l\'esito dell\'invio', dettagliVisible.includes('"ok":true') && dettagliVisible.includes('SLACK_SEND_MESSAGE'))
  // catture: bozza inviata con dettagli aperti (1440/900 × chiaro/scuro)
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shotR(`bozza-dettagli-${tag}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)

  // --- la lettura: SLACK_LIST_CHANNELS passa SENZA card ---
  pushTool('composio__slack__SLACK_LIST_CHANNELS', {})
  pushText('Fatto.')
  await uiSend('Elencami i canali.')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.includes('Fatto.'))`, 30_000).catch(() => undefined)
  await sleep(2_500)
  const calls2 = fakeCalls()
  check('A6a la lettura è passata SENZA card (nessuna approval in sospeso)',
    !(await rpc('getEntries(' + JSON.stringify(bot.id) + ')').then((entries) => entries.some((e) => e.kind === 'approval' && e.meta?.status === 'pending'))))
  check('A6b la lettura è arrivata al finto (seconda riga nel log)', calls2.length === 2 && calls2[1]?.includes('SLACK_LIST_CHANNELS'), `righe: ${calls2.length}`)

  // --- la scrittura: SLACK_CREATE_REMINDER → CARD d'approvazione ---
  pushTool('composio__slack__SLACK_CREATE_REMINDER', { channel: '#sonda', text: 'ricordati la sonda' })
  pushText('aspetto il consenso')
  await uiSend('Crea un promemoria su Slack.')
  check('A6c la scrittura produce la CARD d\'approvazione (con la riga «tramite Composio»)',
    await waitDom(`!![...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('tramite Composio'))`, 30_000))
  const cardText = await pageEval(`
    const card = [...document.querySelectorAll('div')].find((d) => d.offsetParent !== null && d.textContent.includes('tramite Composio'))
    return card ? card.textContent : ''
  `)
  check('A6d la card mostra «Slack · Crea promemoria» (nome umano, R4) e gli argomenti',
    cardText.includes('Slack · Crea promemoria') && cardText.includes('#sonda'), cardText.slice(0, 80))
  check('A6e la card non ha eseguito nulla (il log è fermo a 2)', fakeCalls().length === 2, `righe: ${fakeCalls().length}`)

  // ============ R3 (ritocchi): la card visibile senza riga tecnica ============
  // innerText NON include il contenuto dei <details> CHIUSI: è ciò che l'utente
  // VEDE. La card si riconosce dal suo guscio (rounded-18) che CONTIENE i
  // «Dettagli tecnici» — non dai testi, che cambiano con la lingua
  const cardVisible = await pageEval(`
    const card = document.querySelector('[data-testid="approval-tech-details"]')?.closest('.rounded-\\\\[18px\\\\]')
    return card ? card.innerText : ''
  `)
  check('R3a nel VISIBLE della card non compare né composio__ né mcp__',
    !/composio__|mcp__/.test(cardVisible), cardVisible.slice(0, 140))
  check('R3b il motivo è la frase umana «Vuole fare questa azione su Slack.»',
    cardVisible.includes('Vuole fare questa azione su Slack.'), cardVisible.slice(0, 140))
  const techDetails = await pageEval(`
    const d = document.querySelector('[data-testid="approval-tech-details"]')
    return d ? { closed: !d.open, text: d.textContent } : null
  `)
  check('R3c il nome tecnico sta nei «Dettagli tecnici» CHIUSI (con toolkit e versione)',
    !!techDetails && techDetails.closed &&
    techDetails.text.includes('composio__slack__SLACK_CREATE_REMINDER') &&
    techDetails.text.includes('Composio · Slack · versione 20260101_00'),
    JSON.stringify(techDetails)?.slice(0, 140))

  // ============ R4 (ritocchi): il titolo cambia con la lingua della UI ============
  await rpc(`settingsSet('ui.language', 'en')`)
  await page.send('Page.reload')
  check('R4a ricarica in inglese', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await sleep(1_200)
  const cardEn = await pageEval(`
    const card = document.querySelector('[data-testid="approval-tech-details"]')?.closest('.rounded-\\\\[18px\\\\]')
    return card ? card.innerText : ''
  `)
  check('R4b in inglese il titolo è «Slack · Create reminder» (nome originale di Composio)',
    cardEn.includes('Slack · Create reminder') && !cardEn.includes('Crea promemoria'), cardEn.slice(0, 80))
  await rpc(`settingsSet('ui.language', 'it')`)
  await page.send('Page.reload')
  check('R4c ricarica in italiano', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await sleep(1_200)
  const cardIt = await pageEval(`
    const card = document.querySelector('[data-testid="approval-tech-details"]')?.closest('.rounded-\\\\[18px\\\\]')
    return card ? card.innerText : ''
  `)
  check('R4d di nuovo in italiano il titolo è «Slack · Crea promemoria»',
    cardIt.includes('Slack · Crea promemoria') && !cardIt.includes('Create reminder'), cardIt.slice(0, 80))

  // catture (ritocchi): la card d'approvazione (1440/900 × chiaro/scuro)
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shotR(`card-${tag}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)
  await clickByText('Rifiuta')
  await sleep(1_500)
  const calls3 = fakeCalls()
  check('A6f rifiutata: NESSUNA execute per il promemoria (il log resta a 2)', calls3.length === 2, `righe: ${calls3.length}`)

  // ============ R2/R1 (ritocchi): l'invio FALLITO — UNA notice error, umana ============
  // il server «spalto» risponde a initialize/tools/list e MUORE alla chiamata:
  // l'execute del daemon fallisce con un errore VERO (throw) e l'invio della
  // bozza produce la notice rossa senza nomi tecnici
  log('collego il server MCP «spalto» (muore alla chiamata)…')
  await rpc(`mcpSave(${JSON.stringify({
    id: 'srv-spalto', name: 'spalto', transport: 'stdio',
    command: process.execPath, args: [SPALTO],
    enabled: true, enabledFor: ['*']
  })})`)
  const spaltoTest = await rpc(`mcpTest('srv-spalto')`)
  check('R2f setup server MCP «spalto» collegato (tools list, muore alla chiamata)',
    spaltoTest?.ok === true && (spaltoTest.tools ?? []).some((t) => t.includes('send_message')), JSON.stringify(spaltoTest))
  pushTool('mcp__spalto__send_message', { to: 'capo@spalto.prova', subject: 'Errore voluto', body: 'questa partenza non arriva' })
  pushText('bozza pronta, ma il server è giù')
  await uiSend('Manda il messaggio che fallirà.')
  check('R2g la chiamata all\'invio giù diventa BOZZA (card Invia/Scarta)',
    await waitDom(`!![...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Invia')`, 30_000))
  const noticesBeforeFail = (await noticesOf()).length
  await clickByText('Invia')
  check('R2h l\'invio fallito produce la notice «Invio non riuscito»',
    await waitDom(`[...document.querySelectorAll('p')].some((p) => p.offsetParent !== null && p.innerText.includes('Invio non riuscito'))`, 20_000))
  await sleep(800)
  const failNotices = (await noticesOf()).filter((e) => e.kind === 'notice' && e.content.includes('Invio non riuscito'))
  check('R2i la notice d\'errore è UNA, senza composio__/mcp__ nel testo',
    failNotices.length === 1 && !/composio__|mcp__/.test(failNotices[0]?.content ?? ''),
    `${failNotices.length} — ${failNotices[0]?.content?.slice(0, 90)}`)
  const errEntry = (await rpc(`getEntries(${JSON.stringify(bot.id)})`)).findLast((e) => e.meta?.message?.type === 'draft')
  check('R2l la card della bozza fallita passa a stato error',
    errEntry?.meta?.status === 'error', JSON.stringify({ status: errEntry?.meta?.status }))
  const errDetails = await pageEval(`
    const d = [...document.querySelectorAll('[data-testid="draft-details"]')].filter((x) => x.offsetParent !== null).pop()
    return d ? d.textContent : ''
  `)
  check('R2m il nome tecnico del tool sta nei Dettagli della card d\'errore',
    errDetails.includes('mcp__spalto__send_message'), errDetails.slice(0, 120))

  // ---- Scollega: la riga torna in «Tutte le app» ----
  await rpc('composioDisconnect(' + JSON.stringify('slack') + ')')
  await sleep(600)
  const status3 = await rpc('composioStatus()')
  check('A4g Scollega: Slack non è più in «Collegate»', !(status3.connected ?? []).some((a) => a.slug === 'slack'))

  // ============ R1 (ritocchi): la notice della MIGRAZIONE dei box, grigia ============
  // La migrazione gira all'avvio del daemon una volta sola (marker nel box):
  // per provare la notice si RIAVVIA l'app col MEDESIMO env più
  // SANDBOT_TEST_LEGACY_BOX_ROOT puntato a una cartella DENTRO il temporaneo
  // (mai la home vera), dopo aver tolto il marker scritto al primo avvio (la
  // cartella dati è tutta della sonda) e messo un vecchio box da copiare.
  log('riavvio dell\'app per la notice di migrazione dei box…')
  stopApp()
  await waitAppExit(app)
  await stopDaemon()
  const migrationMarker = join(DATA, 'data', 'box', '.migrated-v1')
  try { rmSync(migrationMarker) } catch { /* nessun marker: la migrazione riparte comunque */ }
  const legacyRoot = join(TMP, 'legacy-home')
  mkdirSync(join(legacyRoot, bot.id, 'box'), { recursive: true })
  writeFileSync(join(legacyRoot, bot.id, 'box', 'vecchio-file.txt'), 'dato del vecchio box')
  app = launchApp({ SANDBOT_TEST_LEGACY_BOX_ROOT: legacyRoot })
  page = await waitForPage()
  log('CDP riagganciato al renderer')
  check('R1a dopo il riavvio il renderer è su', await waitDom(`!!document.querySelector('form textarea')`, 30_000))
  // la notice va al bot PRINCIPALE: se la chat è su un altro bot, si apre il suo
  const mainId = await rpc(`settingsGet('mainAgentId')`).catch(() => null)
  const agents2 = await rpc('listAgents()')
  const mainAgent = agents2.find((a) => a.id === mainId) ?? agents2[0]
  if (mainAgent && mainAgent.id !== bot.id) {
    await clickSidebar(mainAgent.name ?? 'Bot')
    await sleep(700)
  }
  const MIGRATION_TEXT = 'Il computer dei bot ora è UNO solo'
  const migrationEntries = (await rpc(`getEntries(${JSON.stringify(mainAgent?.id ?? bot.id)})`))
    .filter((e) => e.kind === 'notice' && e?.meta?.ui?.id === 'notice.boxMigrated')
  check('R1b la notice della migrazione compare nel transcript del bot principale',
    migrationEntries.length === 1,
    `notice di migrazione: ${migrationEntries.length} — ${migrationEntries[0]?.content?.slice(0, 80)}`)
  check('R1b2 la notice della migrazione è VISIBILE in chat',
    await waitDom(`[...document.querySelectorAll('p')].some((p) => p.offsetParent !== null && p.innerText.includes(${JSON.stringify(MIGRATION_TEXT)}))`, 15_000))
  // i COLORI CALCOLATI: la notice di migrazione (info) grigia come le righe di
  // sistema, quella d'invio fallito (error) rossa come text-destructive
  const noticeColors = await pageEval(`
    const probe = (cls) => {
      const p = document.createElement('p')
      p.className = cls
      document.body.appendChild(p)
      const c = getComputedStyle(p).color
      p.remove()
      return c
    }
    const find = (text) => [...document.querySelectorAll('p')].find((p) => p.offsetParent !== null && p.innerText.includes(text))
    return {
      info: (() => { const el = find(${JSON.stringify(MIGRATION_TEXT)}); return el ? getComputedStyle(el).color : null })(),
      error: (() => { const el = find('Invio non riuscito'); return el ? getComputedStyle(el).color : null })(),
      mutedRef: probe('text-muted-foreground'),
      errorRef: probe('text-destructive/90')
    }
  `)
  check('R1c la notice di migrazione è GRIGIA (info): il colore calcolato è quello di text-muted-foreground',
    !!noticeColors.info && noticeColors.info === noticeColors.mutedRef, JSON.stringify(noticeColors))
  check('R1d la notice d\'invio fallito è ROSSA (error): il colore calcolato è quello di text-destructive',
    !!noticeColors.error && noticeColors.error === noticeColors.errorRef, JSON.stringify(noticeColors))
  check('R1e i due colori calcolati sono DIVERSI (info grigio ≠ error rosso)',
    noticeColors.info !== noticeColors.error, JSON.stringify(noticeColors))
  // catture (ritocchi): notice info (migrazione) ed error (invio fallito)
  for (const [text, name] of [[MIGRATION_TEXT, 'notice-info'], ['Invio non riuscito', 'notice-error']]) {
    for (const [w, dark, tag] of VARIANTS) {
      await setWindowWidth(w)
      await setDark(dark)
      await pageEval(`[...document.querySelectorAll('p')].find((p) => p.offsetParent !== null && p.innerText.includes(${JSON.stringify(text)}))?.scrollIntoView({ block: 'center' })`)
      await sleep(250)
      await shotR(`${name}-${tag}.png`)
    }
    await setDark(false)
    await setWindowWidth(1440)
  }
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  console.error(appLog.slice(-1200))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS} e ${RITOCCHI}`)
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // Vincoli (fase app): a fine sonda si chiude ANCHE il daemon di sviluppo
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid()
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
