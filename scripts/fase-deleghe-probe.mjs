#!/usr/bin/env node
// Sonda della fase deleghe — i flussi D1–D7 provati DAL VIVO con la UI, come
// le altre sonde: app VERA (out/, serve `npm run build` prima) su dati
// temporanei, modello FINTO openai-compatible scriptabile su 127.0.0.1, CLI
// `container` FINTA, Portachiavi/SafeStorage FINTI, openExternal FINTO (log
// su file: MAI il browser dell'utente). MAI container vero, mai download,
// rete solo su 127.0.0.1.
//
//   1. D1: QUATTRO deleghe dell'utente allo stesso bot (Capo → Novità AI),
//      tutte consegnate con le loro risposte — il caso vero del 22/11 (11
//      messaggi nella coppia) non tocca più il limite orario;
//   2. D2: una ROUTINE (webhook trigger) che delega: i messaggi di CATENA
//      riempiono la coppia, il sesto si ACCODA con la riga di stato in chat
//      «In coda per Novità AI · parte alle HH:MM» e l'Annulla che TOGLIE il
//      job; il tool result dice «Queued: it will be delivered … at HH:MM»;
//   3. D3: NESSUNA ECO — il conteggio dei turni di Novità AI resta fermo
//      quando tutto è quiete (un risultato non chiede risposta) e i testi
//      del principale arrivano solo all'utente;
//   4. D5: una chat lunga scriptata (20 turni, budget piccolo) — al massimo
//      2 compattazioni (conteggio delle chiamate «Summarize…» al finto);
//   5. D6: un documento con i TRE tipi di link (lib_, https, /workspace/…):
//      nessun <a> con href relativo, il clic su lib_ apre il documento
//      giusto, il clic su https lascia la finestra sull'app (URL invariato,
//      openExternal FINTO chiamato una volta), il percorso /workspace è un
//      chip che non naviga;
//
// Catture CDP della riga di stato e del documento con i link in
// docs/catture/fase-deleghe/. VERDE in TRE corse di fila:
// node scripts/fase-deleghe-probe.mjs --run 1|2|3
// Pulizia come in K4: a fine corsa 0 cartelle sandbot-fase-deleghe-*, 0
// processi, 0 daemon.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { leggiTentativiLocali, messaggioTentativiLocali } from './lib/sonda.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const runArg = process.argv.find((a) => /^--?run/.test(a))
const run = runArg ? (Number(runArg.split('=')[1] ?? process.argv[process.argv.indexOf(runArg) + 1]) || 1) : 1
const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-deleghe'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-deleghe')
mkdirSync(SHOTS, { recursive: true })
// fase ritocchi-beta18: la copia del documento coi link per la fase nuova
const SHOTS_RITOCCHI = join(ROOT, 'docs', 'catture', 'fase-ritocchi-beta18')
mkdirSync(SHOTS_RITOCCHI, { recursive: true })

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
const OPEN_LOG = join(DATA, 'open-external-finto.log')

// ---- il modello FINTO: risposte a pattern sul body (quando `when` calza) ----
// Oltre alle voci statiche c'è `fn(body, state)`: la risposta costruita al
// volo (serve per il documento indice che linka l'id di quello nato prima).
const script = []
const state = { lastLibId: '' }
const matches = (body, x) =>
  // mai servire il copione alle chiamate di compattazione: il loro body è
  // la DIGEST della storia e contiene TUTTI i marker passati
  !body.includes('Summarize the following conversation') &&
  (x.when == null || (typeof x.when === 'function' ? x.when(body) : Array.isArray(x.when) ? x.when.every((w) => body.includes(w)) : body.includes(x.when))) &&
  (x.not == null || (Array.isArray(x.not) ? x.not.every((w) => !body.includes(w)) : !body.includes(x.not)))
/** l'ultimo messaggio utente del body (l'apertura del TURNO corrente): i
 *  marker si cercano SOLO lì — la storia contiene tutti i marker passati e
 *  un match su tutto il body ruba le risposte ai turni successivi */
const lastUserOf = (body) => {
  const i = body.lastIndexOf('"role":"user"')
  return i < 0 ? body : body.slice(i, i + 900)
}
/** marker di TURNO: `who` nel system, `mark` nell'apertura corrente */
const turn = (who, mark) => (body) => body.includes(who) && lastUserOf(body).includes(mark)
const sayText = (text, when = null) => script.push({ kind: 'text', text, when })
const callTool = (name, args, when = null) => script.push({ kind: 'tool', name, args, when })
const callFn = (fn, when = null) => script.push({ kind: 'fn', fn, when })
const chatRequests = []
const served = []
const compactionBodies = []
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
      chatRequests.push(body)
      // D5: le chiamate di COMPACTION si riconoscono dal prompt dedicato
      if (body.includes('Summarize the following conversation')) compactionBodies.push(body)
      // l'id dell'ultimo documento creato (per il link lib_… dell'indice)
      // l'id dell'ultimo documento creato: la finestra è AMPIA (la storia
      // può averlo spinto indietro di molti caratteri)
      const created = /Document [^()]{0,80}\((lib_[A-Za-z0-9]+)\) v\d+ saved to the library/.exec(body.slice(-40_000))
      if (created) state.lastLibId = created[1]
      const idx = script.findIndex((x) => matches(body, x))
      const next = idx >= 0 ? script.splice(idx, 1)[0] : { kind: 'text', text: 'ok' }
      let kind = 'text'
      let payload = null
      if (next.kind === 'tool') { kind = 'tool'; payload = next }
      else if (next.kind === 'fn') { const r = next.fn(body, state); kind = r.kind; payload = r }
      else { payload = next }
      served.push({ what: kind === 'tool' ? `tool:${payload.name}` : kind === 'fn' ? 'fn' : `text:${String(payload.text).slice(0, 28)}`, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (kind === 'tool') {
        res.write(sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_finto', type: 'function', function: { name: payload.name, arguments: JSON.stringify(payload.args) } }] }, null))
        res.write(sse({}, 'tool_calls'))
      } else {
        res.write(sse({ role: 'assistant', content: payload.text }, null))
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
const DEBUG_PORT = 9427 + run
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
    SANDBOT_TEST_OPEN_EXTERNAL_LOG: OPEN_LOG,
    HOMUN_CONTAINER_PATH: FAKE_CONTAINER
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
const llamaBaseline = (() => {
  try {
    const { execSync } = require('node:child_process')
    return new Set(execSync('pgrep -x llama-server || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean))
  } catch { return new Set() }
})()
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
const pageUrl0 = main.url
log('CDP collegato al renderer (url iniziale:', pageUrl0 + ')')
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
const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
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
const waitQuiet = async (timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const idle = await pageEval(`return (await window.sandbot.listAgents()).every((a) => a.status === 'idle' || a.status === 'offline')`).catch(() => false)
    if (idle) return true
    await sleep(500)
  }
  const statuses = await pageEval(`return (await window.sandbot.listAgents()).map((a) => a.name + ':' + a.status).join(', ')`).catch(() => '?')
  log('waitQuiet SCADUTO, stati:', statuses)
  return false
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
/**
 * R3 (fase ritocchi-beta18): la cattura FOTOGRAFA quello che dice — prima
 * dello scatto si VERIFICA (check) che la vista attesa sia a schermo; lo
 * scatto parte solo allora. Vale per OGNI cattura della sonda.
 */
const shotChecked = async (name, viewExpr, what) => {
  const ok = await waitDom(viewExpr, 10_000, 400)
  check(`R3: «${what}» a schermo PRIMA dello scatto di ${name}`, ok)
  if (ok) await shot(name)
  return ok
}
const selectBot = async (name) => {
  const deadline = Date.now() + 5_000
  for (;;) {
    const ok = await pageEval(`
      const rows = [...document.querySelectorAll('aside button')]
      const row = rows.find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))
      if (!row) return false
      row.scrollIntoView({ block: 'center' })
      row.click()
      return true
    `).catch(() => false)
    if (ok && await waitDom(`document.querySelector('form textarea') && (document.querySelector('form textarea').placeholder ?? '').includes(${JSON.stringify(name)})`, 5_000)) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}
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

/** legge daemon.json nella cartella dati (porta del server del daemon) */
const daemonPort = async () => {
  for (let i = 0; i < 40; i++) {
    for (const p of [join(DATA, 'data', 'daemon.json'), join(DATA, 'daemon.json')]) {
      try {
        const info = JSON.parse(readFileSync(p, 'utf8'))
        if (info.port) return info
      } catch { /* non ancora */ }
    }
    await sleep(500)
  }
  throw new Error('daemon.json non trovato: ' + appLog.slice(-800))
}

try {
  // ---- setup: provider finto, guida chiusa, i due bot ----
  if (!(await waitDom(`typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile: ' + appLog.slice(-800))
  await setViewport(1280, 860)
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(`document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(`document.querySelector('aside')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))

  // i bot nascono PRIMA del modello principale: senza modello utilizzabile
  // NON parte il turno di presentazione (BOT_INTRO), che altrimenti resta
  // appeso sulla sua ask_user e blocca la coda dell'agente
  const mkBot = async (name, role) => {
    const a = await rpc(`createAgent(${JSON.stringify(name)}, ${JSON.stringify(role)})`)
    return a
  }
  const capo = await mkBot('Capo', 'Coordina e riporta all\'utente')
  const novita = await mkBot('Novità AI', 'Ricerche e novità')
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpc(`updateAgent(${JSON.stringify(capo.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await rpc(`updateAgent(${JSON.stringify(novita.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  // il gruppo 'bots' attivo fin da subito (l'attivazione consumerebbe la
  // prima risposta scriptata di ogni bot)
  for (const b of [capo, novita]) {
    await pageEval(`window.sandbot.getEntries(${JSON.stringify(b.id)}); return true`).catch(() => undefined)
  }

  // =========== 1. D1: quattro deleghe dell'utente, TUTTE consegnate ===========
  // Ogni delega: l'utente scrive a Capo → Capo manda a Novità AI (turno
  // utente: NON consuma il limite orario) → Novità risponde → la risposta
  // torna a Capo che chiude con l'utente. Il caso vero del 22/11: 11 messaggi
  // nella coppia in 18 minuti e la quarta delega RIFIUTATA.
  for (let n = 1; n <= 4; n++) {
    // la PRIMA chiamata di un gruppo lo ATTIVA senza eseguire: doppia voce
    // solo per la prima delega, poi il gruppo è già attivo
    const times = n === 1 ? 2 : 1
    for (let t = 0; t < times; t++) {
      callTool('send_to_agent', { agentId: novita.id, text: `delega-${n}: cerca la novità numero ${n}` }, turn('You are Capo', `richiesta-${n}`))
    }
    sayText(`risposta-${n}: la novità è pronta.`, turn('You are Novità AI', `delega-${n}`))
    sayText(`Fatto ${n}: novità pronta.`, turn('You are Capo', `risposta-${n}`))
  }
  if (!(await selectBot('Capo'))) throw new Error('selezione di Capo non riuscita')
  for (let n = 1; n <= 4; n++) {
    await sendMessage(`richiesta-${n}: chiedi a Novità AI la novità numero ${n}`)
    // la risposta dell'utente arriva quando la risposta collegata è tornata
    if (!(await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('Fatto ${n}:'))`, 90_000, 500))) {
      log(`la delega ${n} non è tornata; risposte servite:`, JSON.stringify(served.slice(-8)))
    }
  }
  const capoEntries1 = await rpc(`getEntries(${JSON.stringify(capo.id)})`)
  const requests1 = capoEntries1.filter((e) => e.kind === 'send-message' && e.meta?.agentSend)
  const results1 = capoEntries1.filter((e) => e.kind === 'message' && e.meta?.initiator === 'AGENT' && String(e.content).includes('risposta="si"'))
  check('D1: le QUATTRO deleghe dell\'utente sono partite TUTTE (11 messaggi nella coppia, nessun rifiuto)', requests1.length === 4, `${requests1.length} deleghe`)
  check('D1: le QUATTRO risposte di Novità AI sono tornate a Capo', results1.length === 4, `${results1.length} risposte`)
  check('D1: Capo ha risposto all\'utente per tutte e quattro', capoEntries1.filter((e) => e.kind === 'send-message' && !e.meta?.agentSend && /Fatto \d:/.test(String(e.content))).length === 4)
  const novitaEntries1 = await rpc(`getEntries(${JSON.stringify(novita.id)})`)
  check('D1: il tool result dice «Message queued» (consegna immediata), mai «Too many messages»', chatRequests.every((b) => !b.includes('Too many messages')))

  // =========== 2. D2: la routine riempie la COPPIA di catena → il sesto si ACCODA ===========
  // Routine CRON ogni minuto: il suo turno NON è dell'utente e non porta
  // eventi esterni — la delega che ne nasce è di CATENA e consuma il limite
  // orario della coppia (2 messaggi a giro: richiesta + risposta). Dopo 5
  // giri la coppia è al tetto: il SESTO si accoda con runAt vero.
  const routine = await rpc(`createRoutine(${JSON.stringify(capo.id)}, ${JSON.stringify('Ronda catena')}, ${JSON.stringify('ronda-giro: manda subito a Novità AI il messaggio del giro')}, ${JSON.stringify('* * * * *')})`)
  check('D2: la routine cron nasce (ogni minuto)', !!routine?.id && routine.enabled === 1, JSON.stringify(routine?.schedule))
  // le risposte della routine: il turno è IDENTICO a ogni giro (stesso
  // prompt), quindi le voci si consumano IN ORDINE (findIndex FIFO) — e
  // dopo OGNI send serve un testo finale che CHIUDA il turno, così ogni giro
  // manda UN messaggio solo (con sei send di fila nello stesso turno le
  // richieste restano in coda e il limite non scatta mai); le risposte di
  // Novità si distinguono dal TESTO della richiesta (catena-k)
  for (let k = 1; k <= 6; k++) {
    callTool('send_to_agent', { agentId: novita.id, text: `catena-${k}: aggiornami` }, turn('You are Capo', 'ronda-giro'))
    sayText('inviato.', turn('You are Capo', 'ronda-giro'))
    sayText(`esito-${k}: tutto regolare.`, turn('You are Novità AI', `catena-${k}`))
    sayText(`regolare ${k}.`, turn('You are Capo', `esito-${k}`))
  }
  for (let k = 1; k <= 5; k++) {
    // l'esito del giro k: la richiesta consegnata a Novità E la sua risposta
    // collegata tornata a Capo (entro il minuto della routine + il giro)
    const done = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(novita.id)})).some((e) => e.kind === 'message' && String(e.content).includes('catena-${k}')) && (await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'message' && String(e.content).includes('esito-${k}'))`, 150_000, 1_000)
    if (!done) log(`il giro ${k} della routine non è arrivato a fine`)
  }
  // il SESTO giro: la coppia è piena → il messaggio si ACCODA (attesa del
  // tool result «Queued» nelle richieste arrivate al modello finto)
  const queuedSeen = await (async () => {
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      if (chatRequests.some((b) => b.includes('Queued: it will be delivered to Novità AI at ') && b.includes('(limit reached)') && b.includes('do not promise to retry yourself'))) return true
      await sleep(1_000)
    }
    return false
  })()
  // la routine si FERMA: il settimo giro non serve
  await rpc(`updateRoutine(${JSON.stringify(routine.id)}, ${JSON.stringify({ enabled: 0 })})`).catch(() => undefined)
  await waitQuiet(90_000)
  const capoEntries2 = await rpc(`getEntries(${JSON.stringify(capo.id)})`)
  const novitaEntries2 = await rpc(`getEntries(${JSON.stringify(novita.id)})`)
  const catenaDelivered = novitaEntries2.filter((e) => e.kind === 'message' && e.meta?.initiator === 'AGENT' && String(e.content).includes('catena-'))
  check('D2: i primi CINQUE giri della routine sono consegnati (catena piena: 10 messaggi)', catenaDelivered.length === 5, `${catenaDelivered.length} consegnate`)
  check('D2: il SESTO non è consegnato ORA (si è accodato, runAt futuro)', !catenaDelivered.some((e) => String(e.content).includes('catena-6')))
  check('D2: il tool result dice «Queued: it will be delivered to Novità AI at HH:MM (limit reached)»', queuedSeen)
  // la riga di stato in chat: «In coda per Novità AI · parte alle …» con Annulla
  const rowSeen = await waitDom(`document.querySelector('[data-testid="delegation-status"]')?.textContent.includes('In coda per Novità AI') && document.querySelector('[data-testid="delegation-cancel"]')`, 15_000, 500)
  check('D2: la riga di stato «In coda per Novità AI · parte alle HH:MM» con ANNULLA è in chat', rowSeen)
  if (rowSeen) {
    const rowText = await pageEval(`return document.querySelector('[data-testid="delegation-status"]').textContent`)
    check('D2: la riga porta l\'ORARIO di partenza (parte alle HH:MM)', /parte alle \d{2}:\d{2}/.test(rowText), rowText)
    // R3 (ritocchi-beta18): lo scatto SOLO se la vista attesa è a schermo
    // (la verifica è un check, non un'attesa muta)
    const shotRow = await shotChecked('1-riga-di-stato-delega.png',
      `document.querySelector('[data-testid="delegation-status"]')?.textContent.includes('In coda per Novità AI') && !!document.querySelector('[data-testid="delegation-cancel"]')`,
      'la riga di stato con Annulla')
    check('R3: la cattura della riga di stato è avvenuta a vista verificata', shotRow)
    // ANNULLA: il job esce e la riga sparisce
    await pageEval(`document.querySelector('[data-testid="delegation-cancel"]').click(); return true`)
    const rowGone = await waitDom(`!document.querySelector('[data-testid="delegation-cancel"]')`, 15_000, 500)
    check('D2: ANNULLA toglie il job e la riga sparisce', rowGone)
  }

  // =========== 3. D3: NESSUNA ECO — il conteggio dei turni resta fermo ===========
  await waitQuiet(60_000)
  const novitaTurnsBefore = (await rpc(`getEntries(${JSON.stringify(novita.id)})`)).filter((e) => e.kind === 'send-message' && !e.meta?.agentSend).length
  const capoFromNovita = (await rpc(`getEntries(${JSON.stringify(capo.id)})`)).filter((e) => e.kind === 'message' && e.meta?.initiator === 'AGENT')
  await sleep(6_000) // un risultato non risveglia risposte automatiche
  const novitaTurnsAfter = (await rpc(`getEntries(${JSON.stringify(novita.id)})`)).filter((e) => e.kind === 'send-message' && !e.meta?.agentSend).length
  check('D3: NESSUNA ECO — i turni di Novità AI restano fermi a quiete raggiunta', novitaTurnsBefore === novitaTurnsAfter, `${novitaTurnsBefore} → ${novitaTurnsAfter}`)
  check('D3: i testi del principale sono andati solo all\'UTENTE (nessun «Ricevuto» da Novità AI)', capoFromNovita.every((e) => String(e.content).includes('risposta="si"')) && !capoFromNovita.some((e) => String(e.content).includes('Ricevuto')), `${capoFromNovita.length} messaggi da Novità AI, tutti risultati`)

  // =========== 4. D5: la chat lunga — al massimo DUE compattazioni ===========
  await rpc(`settingsSet(${JSON.stringify('contextBudgetTokens')}, ${JSON.stringify({ 'finto/finto': 4_000 })})`)
  const TURNS = 20
  for (let n = 1; n <= TURNS; n++) {
    sayText(`Resoconto ${n}: fatto, tutto regolare.`, turn('You are Capo', `lungo-${n}`))
  }
  compactionBodies.length = 0
  for (let n = 1; n <= TURNS; n++) {
    await sendMessage(`lungo-${n}: continua a lavorare e riassumi`)
    if (!(await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'send-message' && !e.meta?.agentSend && String(e.content).includes('Resoconto ${n}:'))`, 60_000, 500))) {
      log(`turno lungo ${n} non completato`)
    }
  }
  await waitQuiet(60_000)
  check(`D5: chat lunga di ${TURNS} turni (budget 4k token): AL MASSIMO 2 compattazioni`, compactionBodies.length >= 1 && compactionBodies.length <= 2, `${compactionBodies.length} compattazioni`)

  // =========== 5. D6: il documento con i TRE tipi di link ===========
  // Prima la pastiera (documento B), poi l'INDICE che la linka con lib_<id>,
  // più un https e un percorso /workspace: tre modi di linkare, una finestra
  // che non si muove.
  callTool('find_tools', { group: 'documents' }, turn('You are Capo', 'doc-pastiera'))
  callTool('write_document', { title: 'Pastiera napoletana', content: '# Pastiera napoletana\n\nGrano, ricotta, cidro. Cottura 90 minuti a 160 gradi.\n' }, turn('You are Capo', 'doc-pastiera'))
  sayText('Pastiera salvata.', turn('You are Capo', 'doc-pastiera'))
  script.push({ kind: 'fn', fn: (body, st) => ({ kind: 'tool', name: 'write_document', args: {
    title: 'Ricettario — indice',
    content: [
      '# Ricettario — indice',
      '',
      '## Dolci',
      `- [Pastiera napoletana](${st.lastLibId || 'lib_manca'}) — il classico della domenica.`,
      '- Ispirazioni esterne: [raccolta napoletana](https://ricette.example/pastiera).',
      '- La ricetta completa sta in [pastiera-napoletana.md](/workspace/ricettario/pastiera-napoletana.md).',
      ''
    ].join('\n')
  } }), when: turn('You are Capo', 'doc-indice') })
  sayText('Indice pronto in Libreria.', turn('You are Capo', 'doc-indice'))
  await sendMessage('doc-pastiera: salva il documento della pastiera')
  await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'send-message' && !e.meta?.agentSend && String(e.content).includes('Pastiera salvata'))`, 60_000, 500)
  await sendMessage('doc-indice: salva l\'indice del ricettario che linka la pastiera, un sito e il file del box')
  await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('Indice pronto'))`, 60_000, 500)
  // apre l'INDICE dalla Libreria
  await waitQuiet(60_000)
  await pageEval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Libreria')?.click(); return true`)
  const libSeen = await waitDom(`document.body.textContent.includes('Ricettario — indice')`, 10_000, 400)
  check('D6: l\'indice è nella Libreria', libSeen)
  // R3 (fase ritocchi-beta18): il clic mira la RIGA della Libreria — il
  // bottone omonimo nella chat (la DocumentCard, PRIMA nel DOM) aprirebbe la
  // pagina SENZA chiudere la Libreria, che resta SOPRA a coprirla: era il
  // difetto della cattura 2 (la griglia a schermo col documento nel DOM)
  const opened = await pageEval(`
    const panel = document.querySelector('[data-testid="library-panel"]')
    const b = panel ? [...panel.querySelectorAll('button')].find((x) => x.textContent.trim().includes('Ricettario — indice')) : null
    if (!b) return false
    b.click()
    return true
  `)
  // «a pagina intera» vuol dire DAVVERO a schermo: la pagina copre il centro
  // (elementFromPoint), non solo esiste nel DOM
  const pageOpen = opened && await waitDom(
    `document.querySelector('[data-testid="page-view"]') !== null && document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-testid="page-view"]') !== null && document.body.textContent.includes('Dolci')`,
    10_000, 400)
  check('D6: il clic apre l\'indice a pagina intera (la pagina COPRE lo schermo)', pageOpen)
  if (pageOpen) {
    // NESSUN anchor con href relativo: solo http(s)/mailto possono avere href
    const badHrefs = await pageEval(`
      return [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((h) => h !== '' && !/^(https?:|mailto:)/.test(h))
    `)
    check('D6: NESSUN <a> con href relativo nel DOM', badHrefs.length === 0, JSON.stringify(badHrefs.slice(0, 3)))
    // il percorso /workspace è un chip che NON naviga
    const chipOk = await waitDom(`document.querySelector('[data-testid="doc-path"]')?.textContent.includes('/workspace/ricettario/pastiera-napoletana.md')`, 5_000, 400)
    check('D6: il link /workspace/… è un PERCORSO isolato (chip), non naviga', chipOk)
    const urlBefore = await pageEval(`return location.href`)
    await pageEval(`document.querySelector('[data-testid="doc-path"]').click(); return true`)
    await sleep(800)
    // il clic su lib_ apre il documento GIUSTO
    const libClick = await pageEval(`
      const b = document.querySelector('[data-testid="doc-link"][data-doc^="lib_"]')
      if (!b) return false
      b.click()
      return true
    `)
    const rightDoc = libClick && await waitDom(`document.querySelector('[data-testid="page-title-pill"]')?.textContent.includes('Pastiera napoletana')`, 10_000, 400)
    check('D6: il clic su lib_… apre il documento GIUSTO (Pastiera napoletana)', rightDoc)
    // torna all'indice per il link https
    await pageEval(`document.querySelector('[data-testid="page-close"]')?.click(); return true`)
    await sleep(400)
    // R3 (fase ritocchi-beta18): la RIAPERTURA dell'indice prima dello scatto
    // è un CHECK («D6: l'indice riaperto prima della cattura»), non
    // un'attesa muta — la cattura scatta SOLO a documento aperto E a schermo
    // (la pagina copre il centro), coi TRE tipi di link. Il clic mira la riga
    // della Libreria, non la DocumentCard della chat (vedi sopra)
    const reopened = await pageEval(`
      const panel = document.querySelector('[data-testid="library-panel"]')
      const b = panel ? [...panel.querySelectorAll('button')].find((x) => x.textContent.trim().includes('Ricettario — indice')) : null
      if (b) { b.click(); return true }
      return false
    `)
    const viewAperta = reopened === true && await waitDom(
      `document.querySelector('[data-testid="page-view"]') !== null && document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-testid="page-view"]') !== null && document.body.textContent.includes('Dolci')`,
      10_000, 400)
    check('D6: l\'indice riaperto prima della cattura', viewAperta, reopened === true ? 'page-view aperta' : 'bottone dell\'indice non trovato')
    // la cattura si scatta solo a documento APERTO, coi TRE tipi di link
    // (attesa verificata: i link rendono un istante dopo la vista della pagina)
    const treLink = viewAperta === true && await waitDom(
      `!!document.querySelector('[data-testid="doc-link"][data-doc^="lib_"]') && [...document.querySelectorAll('a')].some((x) => (x.getAttribute('href') ?? '').startsWith('https://')) && !!document.querySelector('[data-testid="doc-path"]')`,
      10_000, 400)
    check('D6: la cattura mostra i TRE tipi di link (lib_, https, /workspace)', treLink === true)
    if (viewAperta === true && treLink === true) {
      await settle()
      const r = await page.send('Page.captureScreenshot', { format: 'png' })
      const buf = Buffer.from(r.data, 'base64')
      writeFileSync(join(SHOTS, '2-documento-con-link.png'), buf)
      // fase ritocchi-beta18: la stessa cattura documenta anche la fase nuova
      writeFileSync(join(SHOTS_RITOCCHI, '3-documento-con-link.png'), buf)
      log('cattura 2-documento-con-link.png (+ copia in fase-ritocchi-beta18)')
    }
    const extClick = viewAperta === true ? await pageEval(`
      const a = [...document.querySelectorAll('a')].find((x) => (x.getAttribute('href') ?? '').startsWith('https://'))
      if (!a) return false
      a.click()
      return true
    `) : false
    await sleep(900)
    const urlAfter = await pageEval(`return location.href`)
    check('D6: il clic su https lascia la finestra SULL\'APP (URL invariato, nessun «Not found»)', extClick && urlAfter === urlBefore, `${urlBefore} → ${urlAfter}`)
    const openLogText = existsSync(OPEN_LOG) ? readFileSync(OPEN_LOG, 'utf8') : ''
    check('D6: openExternal FINTO chiamato UNA volta per l\'https (mai il browser vero)', openLogText.split('\n').filter((l) => l.includes('ricette.example')).length === 1, openLogText.trim().slice(0, 120))
  }
} catch (e) {
  failed++
  log('DEBUG risposte servite:', JSON.stringify(served.slice(-12)))
  log('ERRORE FATALE:', e instanceof Error ? e.message : e)
  log('--- coda log app ---\n' + appLog.slice(-3000))
  results.push({ name: 'corsa completa senza errori fatali', ok: false, detail: String(e) })
} finally {
  // ---- pulizia K4: app giù, daemon via, cartelle via, 0 processi ----
  await waitQuiet(60_000).catch(() => undefined)
  stopApp()
  try { await withTimeout(new Promise((r) => app.on('exit', r)), 8000, 'exit app') } catch {
    try { app.kill('SIGKILL') } catch { /* già via */ }
    await sleep(1000)
  }
  try {
    const { execSync } = await import('node:child_process')
    const apps = execSync(`pgrep -f "Electron .* --remote-debugging-port=${DEBUG_PORT}" || true`, { encoding: 'utf8' }).trim()
    for (const pidStr of apps.split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid && pid !== app.pid) {
        try { process.kill(pid, 'SIGKILL'); log('app residua chiusa:', pidStr) } catch { /* già via */ }
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
  const { readdirSync } = await import('node:fs')
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  check('pulizia K4: 0 cartelle sandbot-fase-deleghe-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  const llamas = (await import('node:child_process').then((c) => c.execSync('pgrep -x llama-server || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean))).filter((pid) => !llamaBaseline.has(pid))
  check('pulizia K4: 0 llama-server nati con la corsa', llamas.length === 0, `baseline ${llamaBaseline.size}, nuovi ${llamas.length}`)
  if (failed > 0) log('risposte servite (diagnostica):', JSON.stringify(served.slice(-20)))
  await new Promise((r) => providerServer.close(r))
}

log(`CORSA r${run}: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
