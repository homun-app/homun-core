#!/usr/bin/env node
// Sonda Electron della fase 0.3.1001: l'app VERA (build di sviluppo in out/)
// su cartella dati TEMPORANEA, provider FINTO openai-compatible su 127.0.0.1
// (le risposte del modello sono uno SCRIPT della sonda) e MCP FINTO «ufficio»
// su stdio (server manuale, fuori dal catalogo). Il daemon accetta UNA sola
// connessione UI: la sonda non apre un suo WebSocket ma usa il bridge del
// RENDERER (window.sandbot) via CDP — così quel che passa è la strada vera
// dell'app. Copre:
//   M1: il modello chiama mcp__ufficio__send_email → bozza; clic su Invia →
//       l'MCP finto riceve ESATTAMENTE una chiamata;
//   M2: LOOK_AROUND e routine come righe di sistema (mai fumetti dell'utente);
//   M3: UNA sola card → routine creata ATTIVA;
//   M5: messaggio a metà turno consegnato al turno in corso;
//   M6: catture a 915 e 1100 + elementFromPoint sul bordo destro dell'ultimo
//       messaggio (a 915 l'overlay è un foglio col velo: il clic sul velo lo
//       chiude e il testo resta integro; a 1100 rotaia+docked, niente velo);
//   M8: Revisione delle approvazioni a 1440 e 900, chiaro e scuro.
// NESSUNA cartella dati vera, NESSUN Portachiavi/safeStorage vero (env di
// test SANDBOT_TEST_*), niente Docker, niente modelli cloud, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-0.3.1001-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', '0.3.1001')
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
// Le risposte sono uno script in coda; ogni richiesta viene registrata con i
// messaggi che il modello ha visto (per M5).
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => script.push({ text })
const requests = []
let providerPort = 0
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* corpo illeggibile: registrazione vuota */ }
      requests.push({ at: Date.now(), messages: (parsed.messages ?? []).map((m) => ({ role: m.role, content: String(m.content ?? '') })) })
      const next = script.shift() ?? { text: 'ok' }
      if (next.delayMs) await sleep(next.delayMs)
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
// Vincoli: env -i HOME/PATH + SANDBOT_TEST_USER_DATA/FAKE_KEYCHAIN/FAKE_SAFESTORAGE
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9337
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

/** Il pid del daemon di QUESA cartella dati (daemon.lock), se già scritto.
 *  Correzione fase 0.3.1001 grafica (Vincoli): la sonda chiudeva l'app ma
 *  lasciava ACCESO il daemon di sviluppo sui dati temporanei. */
const daemonPid = () => {
  try {
    const v = JSON.parse(readFileSync(join(DATA, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
/** A fine sonda chiude ANCHE il daemon di sviluppo. */
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
let browser = null
for (let i = 0; i < 150; i++) {
  try {
    const list = await httpJson('/json/list')
    const target = list.find((t) => t.type === 'page')
    if (target) {
      page = await openCdp(target.webSocketDebuggerUrl)
      browser = await openCdp((await httpJson('/json/version')).webSocketDebuggerUrl)
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
  // openCdp risolve già col corpo "result" di CDP: il valore è result.value
  return r?.result?.value
}
/** Chiamata RPC attraverso il bridge VERO del renderer (window.sandbot). */
const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
const entriesMark = async (agentId) => {
  const es = await rpc(`getEntries(${JSON.stringify(agentId)}, 0)`)
  return es.length ? es[es.length - 1].id : 0
}
/**
 * Larghezza «della finestra» per il layout: Electron non espone
 * Browser.setWindowBounds sul CDP, quindi si emula il VIEWPORT della pagina
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
const waitTurnEnd = async (agentId, mark, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = await rpc(`getEntries(${JSON.stringify(agentId)}, ${mark})`)
    if (entries.findLast((e) => e.kind === 'event' && e.meta?.turnEnd)) return entries
    const pendingCard = entries.find((e) => (e.kind === 'approval' || (e.kind === 'send-message' && e.meta?.approvalId)) && e.meta?.status === 'pending')
    if (pendingCard) return entries
    if (Date.now() > deadline) throw new Error('timeout turno: log app:\n' + appLog.slice(-1500))
    await sleep(250)
  }
}

/** Scrive nel compositore e preme Invio (il messaggio parte dall'UI). */
const uiSend = (text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  // lascia a React il tempo di committare lo stato PRIMA dell'Invio
  await new Promise((r) => setTimeout(r, 120))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'inviato'
`)
/** Clic sul primo bottone col testo esatto (visibile). */
const clickButton = (label) => pageEval(`
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && x.offsetParent !== null)
  if (!b) throw new Error('bottone non trovato: ' + ${JSON.stringify(label)})
  b.click()
  return 'cliccato'
`)

const mcpCallsFile = join(TMP, 'ufficio-calls.jsonl')
const mcpCalls = async () => {
  try {
    return readFileSync(mcpCallsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  } catch { return [] }
}

try {
  // il preload espone window.sandbot appena la pagina è pronta: si aspetta
  // (il target CDP compare anche PRIMA che il bridge sia attivo)
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- configurazione dal renderer: provider finto, bot, server MCP «ufficio» ----
  log('configuro provider finto…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  log('provider ok, collego il bot attivo…')
  // l'app crea già un bot al primo avvio: è quello ATTIVO in chat — si usa lui
  const agents = await rpc('listAgents()')
  const agent = agents[0]
  if (!agent) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(agent.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  log('bot ok, collego il server MCP «ufficio»…')
  await rpc(`mcpSave(${JSON.stringify({
    id: 'srv-ufficio', name: 'ufficio', transport: 'stdio',
    command: process.execPath, args: [join(ROOT, 'scripts', 'fake-ufficio-mcp.mjs'), mcpCallsFile],
    enabled: true, enabledFor: ['*']
  })})`)
  const test = await rpc(`mcpTest('srv-ufficio')`)
  check('setup server MCP manuale «ufficio» collegato (tools list)', test?.ok === true && (test.tools ?? []).some((t) => t.includes('send_email')), JSON.stringify(test))

  // la UI ricarica lo stato appena configurato
  await page.send('Page.reload')
  check('setup compositore pronto', await waitDom(`!!document.querySelector('form textarea')`, 25_000))

  // ---- M1: chiamata DIRETTA a mcp__ufficio__send_email → bozza; Invia → UNA chiamata ----
  pushTool('mcp__ufficio__send_email', { to: 'capo@ufficio.prova', subject: 'Ordine 77', body: 'Testo della email di prova.' })
  pushTool('send_to_user', { text: 'Bozza pronta: conferma l\'invio.' })
  let mark = await entriesMark(agent.id)
  const reqM1 = requests.length
  await uiSend('Manda questa email al capo: «Ordine 77, testo della email di prova».')
  let entries = await waitTurnEnd(agent.id, mark)
  const draftEntry = entries.find((e) => e.kind === 'send-message' && e.meta?.message?.type === 'draft')
  check('M1a il modello chiama mcp__ufficio__send_email → entry bozza con via',
    !!draftEntry && draftEntry.meta.message.via?.tool === 'mcp__ufficio__send_email' && draftEntry.meta.status === 'pending',
    draftEntry ? `via=${draftEntry.meta.message.via?.tool} status=${draftEntry.meta.status}` : 'nessuna bozza')
  check('M1b l\'MCP finto NON è mai stato chiamato dal modello (zero chiamate)', (await mcpCalls()).length === 0, `chiamate=${(await mcpCalls()).length}`)
  const m1Next = requests[reqM1 + 1]
  check('M1c al modello è tornato «turned into a draft» (nella chiamata successiva)',
    !!m1Next && m1Next.messages.some((m) => m.role === 'tool' && m.content.includes('turned into a draft')),
    m1Next ? 'presente' : 'nessuna chiamata successiva')
  check('M1d la card mostra il destinatario', await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim().startsWith('A: capo@ufficio.prova'))`, 10_000))
  await clickButton('Invia')
  const sent = await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.includes('Inviata a capo@ufficio.prova'))`, 20_000)
  if (!sent) {
    const d = entries.find((e) => e.kind === 'send-message' && e.meta?.message?.type === 'draft')
    log('M1e diagnosi: stato bozza =', d?.meta?.status, '— notice:', JSON.stringify((await rpc(`getEntries(${JSON.stringify(agent.id)}, 0)`)).filter((e) => e.kind === 'notice').slice(-2).map((e) => e.content)))
  }
  const callsAfter = await mcpCalls()
  check('M1e clic su Invia → l\'MCP finto riceve ESATTAMENTE una chiamata, con gli argomenti mostrati',
    callsAfter.length === 1 && callsAfter[0].name === 'send_email' && callsAfter[0].args.to === 'capo@ufficio.prova' && callsAfter[0].args.subject === 'Ordine 77' && callsAfter[0].args.body === 'Testo della email di prova.',
    `${callsAfter.length} chiamate: ${JSON.stringify(callsAfter[0]?.args ?? {})}`)

  // ---- M2 (LOOK_AROUND): rientro simulato → riga di sistema «Al tuo rientro» ----
  // lastSeen all'INDIETRO PRIMA di qualunque segnale: il primo che arriva (anche
  // uno dell'app stessa) è un «rientro lungo»; il segnale 'typing' non passa dal
  // gate dei 30s dei segnali 'active'
  await rpc(`settingsSet('minAwayHours', 0)`)
  await rpc(`settingsSet('lookaround.lastAt', 0)`)
  await rpc(`settingsSet('presence.lastSeen', ${Date.now() - 2 * 3_600_000})`)
  pushText('Riepilogo del rientro: niente di nuovo.')
  mark = await entriesMark(agent.id)
  await rpc(`presenceSignal('typing')`) // il segnale del rientro
  entries = await waitTurnEnd(agent.id, mark, 120_000)
  const lookEntry = entries.find((e) => e.kind === 'message' && e.role === 'user' && e.meta?.initiator === 'LOOK_AROUND')
  check('M2a il giro al rientro è un\'entry utente con initiator LOOK_AROUND', !!lookEntry)
  check('M2b in chat è una RIGA DI SISTEMA «Al tuo rientro» (dettagli chiusi), non un fumetto',
    await waitDom(`[...document.querySelectorAll('summary')].some((s) => s.textContent.includes('Al tuo rientro'))`, 10_000))
  const bubbleLeak = await pageEval(`return [...document.querySelectorAll('div.max-w-\\\\[75\\\\%\\\\]')].some((d) => d.textContent.includes('look around') || d.textContent.includes('[recurring routine'))`)
  check('M2c il prompt interno NON compare come fumetto dell\'utente', bubbleLeak === false)

  // ---- M3: update_state create activate:true → UNA card → routine ATTIVA ----
  pushTool('update_state', { target: 'routine', action: 'create', name: 'Backup di prova', prompt: 'Esegui il backup di prova e riassumi.', schedule: '* * * * *', timezone: 'Europe/Rome', activate: true })
  mark = await entriesMark(agent.id)
  await uiSend('Creami la routine «Backup di prova» che gira ogni minuto e attivala subito.')
  entries = await waitTurnEnd(agent.id, mark) // si ferma sulla card
  const approval = entries.findLast((e) => e.kind === 'approval' && e.meta?.status === 'pending')
  check('M3a UNA sola card di consenso (approval.usCreateActive)',
    entries.filter((e) => e.kind === 'approval').length === 1 && approval?.meta?.ui?.id === 'approval.usCreateActive',
    approval ? `ui=${approval.meta.ui.id}` : 'nessuna card')
  check('M3b la card in UI dice che la routine nascerà attiva',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.includes('nasce attiva e partirà da sola'))`, 10_000))
  await clickButton('Consenti')
  await waitTurnEnd(agent.id, mark)
  const routines = await rpc(`listRoutines(${JSON.stringify(agent.id)})`)
  const created = routines.find((r) => r.title === 'Backup di prova')
  check('M3c approvata → routine creata ATTIVA (enabled 1, un solo consenso)', created?.enabled === 1, `enabled=${created?.enabled}`)
  const allEntries = await rpc(`getEntries(${JSON.stringify(agent.id)}, 0)`)
  const createResult = allEntries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('Backup di prova'))
  check('M3d il result del tool dice «created ACTIVE»', String(createResult?.content ?? '').includes('created ACTIVE'))

  // ---- M2 (routine): la prima esecuzione → riga «⏱ Routine «Backup di prova»» ----
  pushText('Backup di prova eseguito.')
  mark = await entriesMark(agent.id)
  const deadline = Date.now() + 150_000
  let routineEntries = []
  for (;;) {
    routineEntries = await rpc(`getEntries(${JSON.stringify(agent.id)}, ${mark})`)
    if (routineEntries.findLast((e) => e.kind === 'event' && e.meta?.turnEnd)) break
    if (Date.now() > deadline) break
    await sleep(1000)
  }
  const routineOpening = routineEntries.find((e) => e.kind === 'message' && e.role === 'user' && e.meta?.initiator === 'ROUTINE')
  check('M2d l\'apertura della routine porta initiator ROUTINE e routineTitle', !!routineOpening && routineOpening.meta.routineTitle === 'Backup di prova',
    routineOpening ? `initiator=${routineOpening.meta.initiator}` : 'nessuna apertura (scheduler?)')
  check('M2e in chat è la riga «⏱ Routine «Backup di prova»», non un fumetto',
    await waitDom(`[...document.querySelectorAll('summary')].some((s) => s.textContent.includes('Routine «Backup di prova»'))`, 10_000))
  await rpc(`updateRoutine(${created.id}, { enabled: 0 })`) // stop ai giri ogni minuto
  await sleep(500)

  // ---- M5: correzione a metà turno ----
  script.length = 0
  script.push({ delayMs: 3500, toolCalls: [{ name: 'recall_memory', arguments: { query: 'appunti' } }] })
  pushTool('send_to_user', { text: 'Fatto, col rosso.' })
  mark = await entriesMark(agent.id)
  const reqM5 = requests.length
  await uiSend('Dipingi la stanza di blu.')
  for (let i = 0; i < 100; i++) { if (requests.length > reqM5) break; await sleep(150) }
  await sleep(400) // il turno è in corso (la prima chiamata è in ritardo artificiale)
  const midMessage = 'No aspetta, usa il rosso.'
  await uiSend(midMessage)
  entries = await waitTurnEnd(agent.id, mark, 60_000)
  const midUserEntries = entries.filter((e) => e.kind === 'message' && e.role === 'user' && e.content === midMessage)
  check('M5a il messaggio a metà turno è UNA sola entry utente (consegnata al turno in corso)', midUserEntries.length === 1, `entry=${midUserEntries.length}`)
  check('M5b NESSUNA notice «in coda»', !entries.some((e) => e.kind === 'notice' && String(e.content).includes('in coda')))
  const secondCall = requests[reqM5 + 1]
  check('M5c la SECONDA chiamata al modello contiene la correzione',
    !!secondCall && secondCall.messages.some((m) => m.role === 'user' && m.content.includes(midMessage)),
    secondCall ? `messaggi=${secondCall.messages.length}` : 'nessuna seconda chiamata')
  await sleep(2500)
  const after = await rpc(`getEntries(${JSON.stringify(agent.id)}, ${mark})`)
  check('M5d la correzione non riparte come turno nuovo (nessuna seconda entry utente)',
    after.filter((e) => e.kind === 'message' && e.role === 'user' && e.content === midMessage).length === 1)

  // ---- M6: 915 e 1100, elementFromPoint + catture ----
  pushText('Ok.')
  mark = await entriesMark(agent.id)
  await uiSend('Ricontrollo il layout della finestra.')
  await waitTurnEnd(agent.id, mark)

  const measureLastUserBubble = () => pageEval(`
    return (() => {
      const bubbles = [...document.querySelectorAll('.justify-end div.max-w-\\\\[75\\\\%\\\\]')]
      const last = bubbles[bubbles.length - 1]
      if (!last) return null
      const r = last.getBoundingClientRect()
      const x = Math.max(1, Math.min(window.innerWidth - 1, r.right - 6))
      const y = r.top + r.height / 2
      const el = document.elementFromPoint(x, y)
      return { right: Math.round(r.right), point: [Math.round(x), Math.round(y)], tag: el ? el.tagName + '.' + String(el.className).slice(0, 60) : null }
    })()
  `)

  // 915: rotaia + overlay a FOGLIO (velo); il clic sul velo chiude, il testo resta integro
  await setWindowWidth(915)
  await pageEval(`return document.querySelector('button[aria-label="Mostra il pannello del bot"]')?.click() ?? 'già aperto'`)
  await sleep(700)
  const isSheet = await pageEval(`return !!document.querySelector('[aria-modal="true"]')`)
  check('M6a a 915 il pannello è un FOGLIO modale (aria-modal, velo)', isSheet === true)
  const m915 = await measureLastUserBubble()
  await shot('m6-915-overlay.png')
  // il velo (non il pannello) copre il punto: un clic lì CHIUDE il foglio
  const closedByVeil = await pageEval(`
    return (() => {
      const veil = document.querySelector('[aria-modal="true"] > div:first-child')
      if (!veil) return false
      veil.click()
      return true
    })()
  `)
  await sleep(600)
  const m915After = await measureLastUserBubble()
  await shot('m6-915-chiuso.png')
  check('M6b a 915 pannello chiuso dal velo → elementFromPoint sul bordo destro restituisce la CHAT',
    closedByVeil === true && !!m915After && String(m915After.tag).includes('max-w'),
    `prima=${m915?.tag ?? 'null'} dopo=${m915After?.tag ?? 'null'}`)

  // 1100 + Computer + barra piena → ROTAIA temporanea + DOCKED (mai overlay)
  await setWindowWidth(1100)
  await pageEval(`document.querySelector('button[aria-label="Mostra il pannello del bot"]')?.click() ?? 'già aperto'`)
  await sleep(500)
  const clickedComputer = await pageEval(`
    return (() => {
      const t = [...document.querySelectorAll('button')].find((b) => b.getAttribute('role') === 'tab' && b.textContent.trim() === 'Computer')
      if (!t) return false
      t.click()
      return true
    })()
  `)
  await sleep(900)
  const docked = await pageEval(`
    return (() => {
      const asides = [...document.querySelectorAll('aside')]
      const aside = asides[asides.length - 1] // il pannello del bot (il primo è la barra)
      if (!aside) return null
      const r = aside.getBoundingClientRect()
      return { position: getComputedStyle(aside).position, left: Math.round(r.left), width: Math.round(r.width), right: Math.round(r.right), vw: window.innerWidth }
    })()
  `)
  const m1100 = await measureLastUserBubble()
  await shot('m6-1100-computer.png')
  check('M6c a 1100 + Computer il pannello è DOCKED (non overlay) e la finestra resta 1100',
    clickedComputer === true && docked?.position !== 'absolute' && docked?.vw === 1100 && (docked?.right ?? 0) <= 1100,
    `position=${docked?.position} right=${docked?.right}`)
  check('M6d a 1100 elementFromPoint sul bordo destro dell\'ultimo messaggio restituisce la CHAT, non il pannello',
    !!m1100 && String(m1100.tag).includes('max-w'), `tag=${m1100?.tag}`)

  // ---- M8: Revisione delle approvazioni, campi della stessa altezza (1440/900 × chiaro/scuro) ----
  await pageEval(`document.querySelector('button[aria-label="Mostra il pannello del bot"]')?.click() ?? 'già chiuso'`)
  await setWindowWidth(1440)
  await pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }))`)
  await sleep(600)
  await pageEval(`
    return (() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Modelli')
      if (!b) throw new Error('tab Modelli non trovato')
      b.click()
      return true
    })()
  `)
  await sleep(400)
  const measureReviewerRow = () => pageEval(`
    return (() => {
      const label = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Revisione delle approvazioni')
      if (!label) return null
      label.scrollIntoView({ block: 'center' })
      const row = label.closest('div')
      const sel = row.querySelector('select')
      const input = row.querySelector('input[role="combobox"]')
      if (!sel || !input) return { missing: true }
      const a = sel.getBoundingClientRect(); const b = input.getBoundingClientRect()
      return { select: { h: +a.height.toFixed(1), top: +a.top.toFixed(1) }, input: { h: +b.height.toFixed(1), top: +b.top.toFixed(1) } }
    })()
  `)
  const light1440 = await measureReviewerRow()
  await shot('m8-1440-chiaro.png')
  await pageEval(`document.documentElement.classList.add('dark')`)
  await sleep(300)
  await shot('m8-1440-scuro.png')
  await pageEval(`document.documentElement.classList.remove('dark')`)
  await setWindowWidth(900)
  const light900 = await measureReviewerRow()
  await shot('m8-900-chiaro.png')
  await pageEval(`document.documentElement.classList.add('dark')`)
  await sleep(300)
  await shot('m8-900-scuro.png')
  await pageEval(`document.documentElement.classList.remove('dark')`)
  const okHeights = (r) => r && !r.missing && Math.abs(r.select.h - r.input.h) < 1 && Math.abs(r.select.top - r.input.top) < 1
  check('M8a a 1440 selettore e campo del modello: stessa altezza e stessa baseline', okHeights(light1440), JSON.stringify(light1440))
  check('M8b a 900 idem', okHeights(light900), JSON.stringify(light900))
  await pageEval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try {
    for (const a of await rpc('listAgents()')) {
      const es = await rpc(`getEntries(${JSON.stringify(a.id)}, 0)`)
      console.error(`--- ultime entry di ${a.name} ---`)
      for (const en of es.slice(-8)) console.error(`${en.kind} | ${String(en.content).slice(0, 100).replace(/\n/g, ' ')} | ${JSON.stringify(en.meta ?? {}).slice(0, 100)}`)
    }
  } catch { /* app magari morta */ }
  console.error('richieste ricevute dal provider finto:', requests.length)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  console.error(appLog.slice(-1200))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // correzione fase 0.3.1001 grafica: chiude ANCHE il daemon di sviluppo
  // lasciato acceso dalla sonda originale
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  process.exit(failures ? 1 : 0)
}
