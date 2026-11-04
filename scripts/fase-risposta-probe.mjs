#!/usr/bin/env node
// Sonda Electron della fase «risposta» (R1–R9). L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, con l'isolamento di sempre:
// NESSUNA RETE VERA, tutto su 127.0.0.1 — il «modello» è un server
// OpenAI-compatible FINTO che registra le richieste e risponde da copione.
// Copre:
//   T1: un turno normale «recall_memory → risposta» fa DUE chiamate al
//       modello (prima: tre — send_to_user più la chiamata di controllo) e
//       consegna UNA send-message meta.final senza chiamata di controllo
//       dopo la risposta; fuori dai gruppi si offre message_user e NON
//       send_to_user (R1/R2);
//   T2: la risposta arriva in DIRETTA: catture a metà stream (bolla parziale)
//       e a fine stream (una sola bolla, stesso testo) in chiaro e scuro (R6);
//   T3: il testo scritto prima di una chiamata di strumento diventa la RIGA
//       DI LAVORO della mascotte, mai un messaggio (R3);
//   T4: una routine zitta risponde NO_RESPONSE: nessuna send-message né
//       outbox; una routine con novità consegna dall'outbox (meta.held,
//       finestra di consegna) (R1/R4);
//   T5: un turno privato con risposta vuota ha UN recupero SENZA strumenti e
//       il suo testo è la risposta finale (R5);
//   TR: la traccia (SANDBOT_LLM_TRACE=1) conta le chiamate per turno e
//       scripts/riassunto-trace.mjs la riassume (output salvato).
// Con --baseline (sull'app del commit di base fase-velocita, via
// SANDBOT_PROBE_ROOT): il turno normale del protocollo VECCHIO e i NUMERI in
// JSON col riassunto della traccia — la misura «prima» del REPORT.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// SANDBOT_PROBE_ROOT = la RADICE dell'app da lanciare (default: questa repo;
// per la misura «prima» il worktree del commit base fase-velocita)
const ROOT = process.env.SANDBOT_PROBE_ROOT ?? resolve(import.meta.dirname, '..')
const BASELINE = process.argv.includes('--baseline')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-risposta-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-risposta')
mkdirSync(DATA, { recursive: true })

const log = (...a) => console.log('[sonda]', ...a)
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- il «modello»: server OpenAI-compatible FINTO (registra e risponde) ----
// gli item dello script: { text } | { toolCalls } | { slow: [chunk…] } —
// slow manda la risposta a PEZZI con pause (per la diretta di T2/T3)
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => script.push({ text })
const pushSlow = (chunks, ms = 800) => script.push({ slow: chunks, slowMs: ms })
const chatRequests = []
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const sseOk = (res, next) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunkOf({ role: 'assistant', content: '' }))
  if (next.reasoning) res.write(chunkOf({ content: null, reasoning_content: next.reasoning }))
  if (next.text) res.write(chunkOf({ content: next.text }))
  for (const [i, tc] of (next.toolCalls ?? []).entries()) {
    res.write(chunkOf({ tool_calls: [{ index: i, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }))
  }
  res.write(chunkOf({}, next.toolCalls ? 'tool_calls' : 'stop'))
  res.write('data: [DONE]\n\n')
  res.end()
}
// la risposta LENTA: pezzi con pause, per catturare la bolla a metà stream
const sseSlow = async (res, next) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(chunkOf({ role: 'assistant', content: '' }))
  for (const piece of next.slow) {
    res.write(chunkOf({ content: piece }))
    await new Promise((r) => setTimeout(r, next.slowMs))
  }
  res.write(chunkOf({}, 'stop'))
  res.write('data: [DONE]\n\n')
  res.end()
}
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    chatRequests.push(JSON.parse(body))
    const next = script.shift() ?? { text: 'ok' }
    if (next.slow) return void sseSlow(res, next)
    sseOk(res, next)
  })
}
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) return chatOf(req, res)
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = BASELINE ? 9347 : 9346
let appLog = ''
const launchApp = () => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
      SANDBOT_LLM_TRACE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
const app = launchApp()
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
const daemonPid = () => {
  try {
    const v = JSON.parse(readFileSync(join(DATA, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
const stopDaemon = async () => {
  const pid = daemonPid()
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
}

// ---- CDP: pagina del renderer (come la sonda di fase-velocita) ----
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
const waitDom = async (exprTrue, timeoutMs = 30_000, step = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pageEval(`return !!(${exprTrue})`)) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
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
const setWindowWidth = async (width, height = 820) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const setDark = async (dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(350)
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
/** gli strumenti offerti al modello nell'ULTIMA richiesta al provider finto */
const offeredToolsOf = (request) => (request?.tools ?? []).map((t) => t?.function?.name ?? t?.name)
const waitForText = async (text, ms = 40_000) =>
  waitDom(`[...document.querySelectorAll('div,p')].some((d) => d.textContent.trim() === ${JSON.stringify(text)})`, ms)
const entriesOf = (agentId) => pageEval(`return await window.sandbot.getEntries(${JSON.stringify(agentId)})`)
const tracePath = () => join(DATA, 'data', 'llm-trace.jsonl')
/** le chiamate per turno dalla traccia (turnId → quante righe) */
const callsPerTurn = () => {
  const counts = new Map()
  if (!existsSync(tracePath())) return counts
  for (const line of readFileSync(tracePath(), 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line)
      const k = r.turnId ?? null
      counts.set(k, (counts.get(k) ?? 0) + 1)
    } catch { /* riga rotta */ }
  }
  return counts
}
/** il testo compattato delle bolle del bot in chat (class max-w-[75%]) */
const botBubbleTexts = () => pageEval(`
  return [...document.querySelectorAll('div')]
    .filter((d) => (d.getAttribute('class') ?? '').includes('max-w-[75%]'))
    .map((d) => d.textContent.trim().replace(/\\s+/g, ' '))
`)

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- setup: provider finto + il bot principale ----
  log('configuro provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await page.send('Page.reload')
  check('setup compositore pronto', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await setWindowWidth(1440)

  // ============ T1: il turno normale — DUE chiamate, UNA risposta final ============
  const RISPOSTA = BASELINE
    ? 'Turno normale misurato.'
    : 'Ecco: preferisci le risposte brevi e dirette. Due chiamate, una risposta.'
  if (BASELINE) {
    // protocollo VECCHIO: il modello chiama send_to_user e il loop fa la
    // chiamata di controllo dopo la consegna
    pushTool('recall_memory', { query: 'preferenze' })
    pushTool('send_to_user', { text: RISPOSTA })
    pushText('.')
  } else {
    pushTool('recall_memory', { query: 'preferenze' })
    pushText(RISPOSTA)
  }
  const beforeCalls = chatRequests.length
  await uiSend('Un giro normale, grazie.')
  await waitForText(RISPOSTA)
  await sleep(800)
  const lastTurnCalls = [...callsPerTurn().entries()].filter(([k]) => k !== null).at(-1)?.[1] ?? 0
  if (BASELINE) {
    // misura PRIMA (build del commit base): i numeri in JSON e il riassunto
    // della traccia PRIMA del protocollo nuovo (per il REPORT)
    writeFileSync(join(TMP, 'baseline.json'), JSON.stringify({ turnCalls: lastTurnCalls, note: 'protocollo vecchio: send_to_user + chiamata di controllo' }, null, 2))
    console.log('[baseline] chiamate per turno (prima): ' + lastTurnCalls)
    if (existsSync(tracePath())) {
      const summaryBefore = execFileSync(process.execPath, [join(ROOT, 'scripts', 'riassunto-trace.mjs'), tracePath()], { encoding: 'utf8' })
      console.log('[baseline] riassunto della traccia PRIMA:\n' + summaryBefore)
    }
  } else {
    check('T1 il turno «recall → risposta» fa DUE chiamate (prima: tre)', lastTurnCalls === 2, `chiamate per turno: ${lastTurnCalls}`)
    const entries = await entriesOf(bot.id)
    const finals = entries.filter((e) => e.kind === 'send-message' && e.meta?.final === true)
    check('T1 UNA sola send-message con meta.final e senza meta.call',
      finals.length === 1 && finals[0].meta.call === undefined && finals[0].content === RISPOSTA,
      JSON.stringify({ finals: finals.length, text: finals[0]?.content?.slice(0, 40) }))
    const offered = offeredToolsOf(chatRequests.at(-1))
    check('T1/R2 fuori dai gruppi si offre message_user e NON send_to_user',
      offered.includes('message_user') && !offered.includes('send_to_user'),
      offered.filter((n) => ['message_user', 'send_to_user', 'ask_user'].includes(n)).join(', '))
    check('T1 nessuna chiamata dopo la risposta (niente controllo)', chatRequests.length - beforeCalls === 2, `richieste: ${chatRequests.length - beforeCalls}`)
  }

  if (!BASELINE) {
    mkdirSync(SHOTS, { recursive: true })
    for (const f of readdirSync(SHOTS)) rmSync(join(SHOTS, f))

    // ============ T2: la risposta in DIRETTA (a pezzi, con pause) ============
    const PEZZI = ['La risposta ', 'arriva mentre ', 'il modello ', 'la scrive: ', 'bolla parziale visibile.']
    const INTERA = PEZZI.join('')
    pushSlow(PEZZI, 900)
    await uiSend('Rispondimi piano.')
    // a metà stream: la bolla mostra i primi pezzi (il markdown toglie gli
    // spazi finali: si confronta il testo compattato), il completo NON c'è
    const parzialePresente = await waitDom(
      `[...document.querySelectorAll('div,p')].some((d) => { const t = d.textContent.trim().replace(/\\s+/g, ' '); return t.startsWith(${JSON.stringify((PEZZI[0] + PEZZI[1]).trim())}) && t !== ${JSON.stringify(INTERA)} })`,
      20_000
    )
    check('T2 la bolla compare durante lo stream (testo parziale)', parzialePresente === true)
    await sleep(600)
    const testiMetà = await botBubbleTexts()
    check('T2 a metà stream la bolla è PARZIALE (il testo completo non c\'è ancora)',
      testiMetà.some((t) => t.startsWith((PEZZI[0] + PEZZI[1]).trim())) && !testiMetà.includes(INTERA),
      testiMetà.filter((t) => t.startsWith('La risposta')).join(' § ').slice(0, 60))
    await shot('risposta-diretta-mezzo-1440-chiaro.png')
    await setDark(true)
    await shot('risposta-diretta-mezzo-1440-scuro.png')
    await setDark(false)
    // a fine stream: UNA sola bolla col testo intero (la diretta si è chiusa
    // e la entry promossa la sostituisce: si aspetta che il DOM si assesti)
    await waitForText(INTERA, 20_000)
    let bolle = 0
    for (let i = 0; i < 12 && bolle === 0; i++) {
      bolle = (await botBubbleTexts()).filter((t) => t === INTERA).length
      if (bolle === 0) await sleep(400)
    }
    check('T2 a fine stream UNA SOLA bolla col testo intero (niente doppione)', bolle === 1, `bolle: ${bolle}`)
    let entryT2
    for (let i = 0; i < 16; i++) {
      entryT2 = (await entriesOf(bot.id)).findLast((e) => e.kind === 'send-message')
      if (entryT2?.content === INTERA) break
      await sleep(400)
    }
    check('T2 la entry finale esiste con meta.final', entryT2?.content === INTERA && entryT2?.meta?.final === true,
      JSON.stringify({ c: entryT2?.content?.slice(0, 30), final: entryT2?.meta?.final }))
    await shot('risposta-diretta-fine-1440-chiaro.png')
    await setDark(true)
    await shot('risposta-diretta-fine-1440-scuro.png')
    await setDark(false)

    // ============ T3: la riga di lavoro dal testo a metà turno ============
    const LAV = 'Sto cercando le preferenze nel catalogo dei ricordi'
    const FIN3 = 'Trovato: risposte brevi.'
    script.push({ text: LAV, toolCalls: [{ name: 'recall_memory', arguments: { query: 'preferenze' } }] })
    pushSlow(['Trovato: ', 'risposte brevi.'], 900)
    await uiSend('Le mie preferenze?')
    // durante il SECONDO stream: la riga di lavoro mostra il testo della
    // CHIAMATA CON STRUMENTI (R3) mentre la bolla trasmette la risposta (R6)
    await waitDom(
      `[...document.querySelectorAll('div,p')].some((d) => { const t = d.textContent.trim().replace(/\\s+/g, ' '); return t.startsWith('Trovato:') && t !== ${JSON.stringify(FIN3)} })`,
      20_000
    )
    const riga = await pageEval(`return [...document.querySelectorAll('span')].some((s) => s.textContent.trim() === ${JSON.stringify(LAV)})`)
    check('T3 la riga di lavoro mostra il testo scritto prima dello strumento', riga === true)
    await shot('riga-di-lavoro-1440-chiaro.png')
    await setDark(true)
    await shot('riga-di-lavoro-1440-scuro.png')
    await setDark(false)
    // a fine turno: il testo a metà turno NON è mai diventato un messaggio.
    // Si aspetta la ENTRY finale (il DOM può mostrarla prima, via diretta)
    const finaleT3 = async () => {
      const es = await entriesOf(bot.id)
      const u = es.findIndex((x) => x.content === 'Le mie preferenze?')
      return u >= 0 && es.slice(u).some((e) => e.kind === 'send-message' && e.content === FIN3)
    }
    let attesaFinale = 0
    while (!(await finaleT3()) && attesaFinale < 30_000) {
      await sleep(500)
      attesaFinale += 500
    }
    const entries3 = await entriesOf(bot.id)
    const sends3 = entries3.filter((e) => e.kind === 'send-message' && e.id > (entries3.find((x) => x.content === 'Le mie preferenze?')?.id ?? 0))
    check('T3 il testo a metà turno NON è un messaggio: solo la risposta finale è una send',
      sends3.length === 1 && sends3[0].content === FIN3 && !entries3.some((e) => e.kind === 'send-message' && e.content === LAV),
      sends3.map((s) => s.content.slice(0, 30)).join(' | '))

    // ============ T4: routine — silenzio NO_RESPONSE e novità in outbox ============
    log('creo le routine (silenzio + novità), scattano al prossimo tick/minuto…')
    // le risposte delle routine entrano in coda PRIMA che il tick le faccia
    // partire: prima quella zitta, poi quella con la novità
    pushText('NO_RESPONSE')
    pushText('Novità: la scadenza del fornitore è domattina.')
    await rpc(`createRoutine(${JSON.stringify(bot.id)}, ${JSON.stringify('Controllo silenzioso')}, ${JSON.stringify('Controlla se c\'è qualcosa da segnalare. Se non c\'è niente, resta in silenzio.')}, ${JSON.stringify('* * * * *')})`)
    await rpc(`createRoutine(${JSON.stringify(bot.id)}, ${JSON.stringify('Controllo con novità')}, ${JSON.stringify('Controlla le scadenze del fornitore e segnala le urgenze.')}, ${JSON.stringify('* * * * *')})`)
    // il tick del daemon è ogni 30s: entro ~130s entrambe le routine girano
    const deadline = Date.now() + 130_000
    let silenceOk = false
    let heldOk = false
    while (Date.now() < deadline && !(silenceOk && heldOk)) {
      await sleep(2_000)
      const es = await entriesOf(bot.id)
      const openings = es.filter((e) => e.kind === 'message' && e.meta?.initiator === 'ROUTINE')
      if (openings.length >= 2) {
        const routineSends = es.filter((e) => e.kind === 'send-message' && e.id > openings[0].id)
        // la zitta: NESSUNA send tra le due aperture; la novità: una held
        if (!routineSends.some((s) => s.id > openings[0].id && s.id < openings[1].id)) silenceOk = true
        if (routineSends.find((s) => s.meta?.held === true && String(s.content).includes('Novità'))) heldOk = true
      }
    }
    check('T4 routine zitta con NO_RESPONSE: nessun messaggio, nessuna send', silenceOk)
    check('T4 routine con novità: testo finale consegnato dall\'outbox (meta.held)', heldOk)

    // ============ T5: il recupero del turno privato senza risposta ============
    pushText('')
    pushText('Ecco la risposta dopo il recupero.')
    const before5 = chatRequests.length
    await uiSend('Una senza risposta, poi il recupero.')
    await waitForText('Ecco la risposta dopo il recupero.', 30_000)
    await sleep(500)
    const calls5 = chatRequests.length - before5
    const toolsRecovery = offeredToolsOf(chatRequests.at(-1))
    check('T5 risposta vuota → UNA chiamata di recupero SENZA strumenti', calls5 === 2 && toolsRecovery.length === 0,
      `chiamate: ${calls5}, strumenti offerti al recupero: ${toolsRecovery.length}`)
    const entries5 = await entriesOf(bot.id)
    const last5 = entries5.filter((e) => e.kind === 'send-message').at(-1)
    check('T5 il testo del recupero è la risposta finale', last5?.content === 'Ecco la risposta dopo il recupero.' && last5?.meta?.final === true)
    await shot('recupero-risposta-1440-chiaro.png')
    await setDark(true)
    await shot('recupero-risposta-1440-scuro.png')
    await setDark(false)

    // ============ TR: il riassunto della traccia ============
    check('TR la traccia esiste (SANDBOT_LLM_TRACE=1)', existsSync(tracePath()))
    const summary = execFileSync(process.execPath, [join(ROOT, 'scripts', 'riassunto-trace.mjs'), tracePath()], { encoding: 'utf8' })
    writeFileSync(join(SHOTS, 'riassunto-trace.txt'), summary)
    log('riassunto della traccia:\n' + summary)
    check('TR riassunto-trace.mjs riassume i turni della sonda',
      summary.includes('turno') && summary.includes('chiamate') && summary.includes('token in'))
    const counts = [...callsPerTurn().entries()].map(([k, n]) => `${k === null ? '(fuori)' : k.slice(0, 8)}:${n}`).join(' ')
    log('chiamate per turno: ' + counts)

    // ---- K1: due PNG con NOMI diversi non possono avere lo stesso hash ----
    const byHash = new Map()
    const dup = []
    for (const name of readdirSync(SHOTS).filter((n) => n.endsWith('.png')).sort()) {
      const h = createHash('sha256').update(readFileSync(join(SHOTS, name))).digest('hex')
      if (byHash.has(h)) dup.push(`${name} ≡ ${byHash.get(h)}`)
      else byHash.set(h, name)
    }
    check('K1 nessuna cattura duplicata (stesso hash con nomi diversi)', dup.length === 0, dup.join('; '))
  }
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  console.error(appLog.slice(-1500))
} finally {
  console.log(`\n${failures === 0 ? (BASELINE ? 'BASELINE OK' : 'TUTTI I CONTROLLI OK') : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  if (!BASELINE) console.log(`catture in ${SHOTS}`)
  // il log del daemon SEMPRE: la prima cosa da guardare quando un check fallisce
  try { console.log('--- daemon.log (coda) ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-4000)) } catch { /* niente log */ }
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // Vincoli (fase): a fine sonda si chiude ANCHE il daemon di sviluppo
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid()
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
