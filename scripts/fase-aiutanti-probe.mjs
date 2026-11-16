#!/usr/bin/env node
// Sonda Electron della fase «aiutanti» (AH7, con AH1/AH2/AH3 dal vivo).
// L'app VERA (build di sviluppo in out/) su cartella dati TEMPORANEA,
// isolamento di sempre: NESSUNA RETE VERA, tutto su 127.0.0.1, modello FINTO
// a copione, NESSUN container/Docker (la modalità è HOST, scelta con la RPC
// box:mode-set — MAI una scrittura diretta nel DB).
//
// Copione: il padre lancia un aiutante; l'aiutante chiama DUE run-command
// (echo innocui nella cartella temporanea della sonda) che in modalità host
// + «Chiedi» fanno DUE card: la prima si approva dalla CHAT DEL PADRE (AH2),
// la seconda dal PANNELLO DEL FIGLIO (AH1); poi wake_parent e il figlio
// finisce done.
//
// Controlli (AH7.2):
//   - la card «Aiutante» passa a «in attesa della tua conferma» entro 2 s;
//   - la card del figlio compare nella chat del padre;
//   - il clic su «Consenti» lì fa ripartire il figlio (seconda card);
//   - la seconda card, approvata dal PANNELLO del figlio, funziona anche lei;
//   - la riga viva cambia almeno una volta e il tempo scorre;
//   - nel log del daemon non c'è nessun «non in attesa».
// Catture CDP in docs/catture/aiutanti/.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = process.env.SANDBOT_PROBE_ROOT ?? resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-aiutanti-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'aiutanti')
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

// ---- il «modello»: server OpenAI-compatible FINTO (risponde da copione) ----
// Le richieste si distinguono SENZA corsa: chi ha il tool wake_parent è il
// FIGLIO; il padre segue la sua sequenza, il figlio la sua (i passi contano).
const chatRequests = []
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const ECHO1 = 'echo aiutanti-primo'
const ECHO2 = 'echo aiutanti-secondo'
const parentSteps = []
const childSteps = []
const pushTool = (steps, name, args) => steps.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (steps, text) => steps.push({ text })
// padre: spawn → parola di attesa → (risveglio SUBAGENTS_DONE) → chiusura
pushTool(parentSteps, 'spawn_subagent', {
  title: 'Echo di prova dell’aiutante',
  brief: 'Obiettivo: eseguire due comandi echo innocui nella cartella temporanea della sonda e riferire il loro output. Confini: non usare la rete, non toccare file fuori dalla cartella temporanea, nessun altro comando oltre ai due echo richiesti. Risultato: una riga con l’output esatto dei due comandi e la conferma che entrambi sono stati approvati dall’utente.'
})
pushText(parentSteps, 'Ho lanciato l’aiutante per i due echo: ti faccio sapere quando consegna.')
pushText(parentSteps, 'L’aiutante ha finito: entrambi gli echo sono stati approvati ed eseguiti.')
// figlio: run-command #1 → run-command #2 → wake_parent → parola finale
pushTool(childSteps, 'run-command', { command: ECHO1, workingDirectory: TMP })
pushTool(childSteps, 'run-command', { command: ECHO2, workingDirectory: TMP })
pushTool(childSteps, 'wake_parent', { summary: 'Entrambi gli echo eseguiti: aiutanti-primo e aiutanti-secondo.' })
pushText(childSteps, 'Fatto.')
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    chatRequests.push(parsed)
    const tools = Array.isArray(parsed.tools) ? parsed.tools.map((t) => t?.function?.name ?? '') : []
    const isChild = tools.includes('wake_parent')
    const steps = isChild ? childSteps : parentSteps
    const next = steps.shift() ?? { text: 'ok' }
    log(`modello: richiesta ${isChild ? 'FIGLIO' : 'PADRE'} → ${next.text ? 'testo' : next.toolCalls[0].name}`)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunkOf({ role: 'assistant', content: '' }))
    if (next.text) res.write(chunkOf({ content: next.text }))
    for (const [i, tc] of (next.toolCalls ?? []).entries()) {
      res.write(chunkOf({ tool_calls: [{ index: i, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }))
    }
    res.write(chunkOf({}, next.toolCalls ? 'tool_calls' : 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
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
const DEBUG_PORT = 9349
let appLog = ''
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
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
/** chiude l'app ASPETTANDO che il processo esca davvero (SIGTERM, poi di nuovo, poi SIGKILL) */
const stopAppAndWait = async () => {
  const pid = app?.pid
  try { app?.kill('SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 15; i++) {
    try { process.kill(pid, 0) } catch { return }
    await sleep(400)
    if (i === 7) { try { app?.kill('SIGTERM') } catch { /* già via */ } }
  }
  try { app?.kill('SIGKILL') } catch { /* già via */ }
  await sleep(400)
}
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
const daemonLogText = () => {
  try { return readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8') } catch { return '' }
}

// ---- CDP: pagina del renderer (come le sonde delle fasi precedenti) ----
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
const page = await waitForPage()
// la finestra in primo piano: i timer del renderer (il tempo che scorre sulla
// card) non vengono throttlati da Chromium in una pagina non visibile
try { await page.send('Page.bringToFront') } catch { /* già in fronte */ }
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
const setWindowWidth = async (width, height = 860) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
const entriesOf = (agentId) => pageEval(`return await window.sandbot.getEntries(${JSON.stringify(agentId)})`)
const subagentsOf = async (parentId) => {
  const subs = await rpc(`listSubagents(${JSON.stringify(parentId)})`)
  return Array.isArray(subs) ? subs : []
}

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- la GUIDA del primo avvio, in fretta (come le sonde di prima):
  // al passo Permessi si sceglie «Chiedimi prima» (le card della sonda)
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
  check('setup la chat si apre (guida percorsa o già fatta)', await waitDom(`!!document.querySelector('form textarea')`, 25_000))

  // ---- setup: provider finto + il bot principale ----
  log('configuro provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await setWindowWidth(1440)
  mkdirSync(SHOTS, { recursive: true })
  for (const f of readdirSync(SHOTS)) rmSync(join(SHOTS, f))

  // ---- AH7.1: modalità HOST con la RPC delle Impostazioni (box:mode-set),
  // MAI una scrittura diretta nel DB
  await rpc('boxModeSet("host")')
  check('modalità host scelta con la RPC box:mode-set', true)

  // ============ il copione parte: il padre lancia l'aiutante ============
  await uiSend('Lancia l’aiutante per i due echo di prova.')

  // l'aiutante nasce: la card «Aiutante» compare nella chat del padre
  const aiutanteCardOk = await waitDom(`!!document.querySelector('[data-testid="card-aiutante"]')`, 40_000)
  check('la card «Aiutante» compare nella chat del padre', aiutanteCardOk)

  // il figlio si ferma sulla PRIMA card (run-command #1) — lo vediamo dal
  // transcript del figlio (funziona anche sulla base)
  const firstPending = await (async () => {
    for (let i = 0; i < 60; i++) {
      const subs = await subagentsOf(bot.id)
      const open = subs.find((s) => s.status === 'queued' || s.status === 'running')
      if (open) {
        const es = await entriesOf(open.id)
        if (es.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')) return open.id
      }
      await sleep(400)
    }
    return null
  })()
  check('il figlio si ferma sulla prima card (approval pending nel suo transcript)', firstPending !== null)
  const childId = firstPending

  // ---- AH7.2a: «in attesa della tua conferma» entro 2 s dalla pausa ----
  // (si campiona la card da quando la pausa ESISTE, non da prima)
  const waitingWithin2s = await (async () => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const txt = await pageEval(`return document.querySelector('[data-testid="card-aiutante-stato"]')?.textContent ?? ''`)
      if (txt.includes('in attesa della tua conferma')) return true
      await sleep(150)
    }
    return false
  })()
  const statoTxt = await pageEval(`return document.querySelector('[data-testid="card-aiutante-stato"]')?.textContent ?? ''`)
  check(`la card «Aiutante» dice «in attesa della tua conferma» entro 2 s`, waitingWithin2s, `testo visto: «${statoTxt.trim()}»`)
  await shot('aiutante-card-in-attesa.png')

  // ---- AH7.2b: la card del FIGLIO compare nella chat del padre ----
  const childCardInChat = await waitDom(`!!document.querySelector('[data-testid="aiutante-card-figlio"]')`, 5000)
  check('la card del figlio compare nella chat del padre', childCardInChat)
  await shot('aiutante-card-figlio-in-chat.png')

  // ---- AH3: la riga viva dell'aiutante (attività in parole) ----
  const liveText = () => pageEval(`return document.querySelector('[data-testid="aiutante-attivita"]')?.textContent ?? ''`)
  const live1 = await liveText()
  check('la riga viva dell’aiutante mostra l’attività (run-command)', live1.trim().length > 0, `riga: «${live1.trim()}»`)
  await shot('aiutante-riga-viva.png')

  // ---- AH3: il tempo scorre (l'elapsed cambia entro ~1,5 s) ----
  const tempoTick = await (async () => {
    const t1 = await pageEval(`return document.querySelector('[data-testid="aiutante-tempo"]')?.textContent ?? 'NULL'`)
    await sleep(1300)
    const t2 = await pageEval(`return document.querySelector('[data-testid="aiutante-tempo"]')?.textContent ?? 'NULL'`)
    await sleep(1300)
    const t3 = await pageEval(`return document.querySelector('[data-testid="aiutante-tempo"]')?.textContent ?? 'NULL'`)
    log('TEMPO t1=', JSON.stringify(t1), 't2=', JSON.stringify(t2), 't3=', JSON.stringify(t3))
    return t1.trim() !== '' && (t1.trim() !== t2.trim() || t2.trim() !== t3.trim())
  })()
  check('il tempo trascorso sulla card scorre', tempoTick)

  // ---- AH7.2c: il clic su «Consenti» NELLA CHAT DEL PADRE fa ripartire il
  // figlio → la SECONDA card (run-command #2) arriva
  const clickConsentiInChat = await pageEval(`
    const card = document.querySelector('[data-testid="aiutante-card-figlio"]')
    if (!card) return 'card assente'
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Consenti')
    if (!btn) return 'bottone Consenti assente'
    btn.click()
    return 'consentito'
  `)
  const secondPending = await (async () => {
    for (let i = 0; i < 50; i++) {
      const es = await entriesOf(childId)
      const pend = es.filter((e) => e.kind === 'approval' && e.meta?.status === 'pending')
      if (pend.length > 0 && es.some((e) => e.kind === 'tool-result' && String(e.content).includes('aiutanti-primo'))) return true
      await sleep(300)
    }
    return false
  })()
  check('il clic su «Consenti» nella chat del padre sblocca il figlio (seconda card)', clickConsentiInChat === 'consentito' && secondPending, `clic: ${clickConsentiInChat}`)

  // ---- AH7.2d: la SECONDA card si approva dal PANNELLO del figlio ----
  // (il pannello si apre col bottone «Apri» della card Aiutante)
  const openPanel = await pageEval(`
    const card = document.querySelector('[data-testid="card-aiutante"]')
    if (!card) return 'card assente'
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apri')
    if (!btn) return 'bottone Apri assente'
    btn.click()
    return 'aperto'
  `)
  await sleep(600)
  const panelConsenti = await pageEval(`
    const pend = [...document.querySelectorAll('[data-testid="card-approvazione"]')].filter((c) => c.querySelector('button'))
    if (pend.length === 0) return 'nessuna card pendente nel pannello'
    const btn = [...pend[pend.length - 1].querySelectorAll('button')].find((b) => b.textContent.trim() === 'Consenti')
    if (!btn) return 'bottone Consenti assente'
    btn.click()
    return 'consentito'
  `)
  check('la seconda card, approvata dal pannello del figlio, viene cliccata', openPanel === 'aperto' && panelConsenti === 'consentito', `pannello: ${openPanel}, clic: ${panelConsenti}`)

  // ---- il figlio finisce: wake_parent → done ----
  const childDone = await (async () => {
    for (let i = 0; i < 60; i++) {
      const subs = await subagentsOf(bot.id)
      const me = subs.find((s) => s.id === childId)
      if (me && me.status === 'done') return true
      if (me && ['failed', 'stopped', 'expired', 'stopped-loop'].includes(me.status)) return me.status
      await sleep(400)
    }
    return false
  })()
  check('il figlio finisce done (dopo entrambe le approvazioni)', childDone === true, `esito: ${childDone}`)

  // ---- la riga viva cambia almeno una volta (attività ≠ attività iniziale,
  // o stato finale diverso): si confronta con la prima lettura ----
  const live2 = await liveText()
  check('la riga viva cambia almeno una volta durante il giro', live2.trim() !== live1.trim(), `prima «${live1.trim()}» poi «${live2.trim()}»`)

  // ---- il padre chiude il cerchio (risveglio SUBAGENTS_DONE) ----
  const parentFinal = await (async () => {
    for (let i = 0; i < 50; i++) {
      const es = await entriesOf(bot.id)
      if (es.some((e) => e.kind === 'send-message' && String(e.content).includes('L’aiutante ha finito'))) return true
      await sleep(400)
    }
    return false
  })()
  check('il padre riferisce la consegna dell’aiutante', parentFinal)

  // ---- AH7.2f: nel log del daemon NESSUN «non in attesa» ----
  const dlog = daemonLogText()
  const stale = dlog.split('\n').filter((l) => l.includes('non in attesa'))
  check('nessun «non in attesa» nel log del daemon', stale.length === 0, stale.length ? `righe: ${stale.length} (prime 3: ${stale.slice(0, 3).join(' | ')})` : '')

  log(`richieste al modello: ${chatRequests.length}`)
} catch (e) {
  check('la sonda completa il giro senza errori', false, String(e?.message ?? e))
} finally {
  await stopAppAndWait()
  await stopDaemon()
  providerServer.close()
  await sleep(300)
  rmSync(TMP, { recursive: true, force: true })
}

const tot = checks.length
const ok = tot - failures
console.log(`\n[sonda] ${ok}/${tot} check verdi`)
if (failures > 0) {
  console.log('[sonda] FAIL')
  process.exit(1)
}
console.log('[sonda] OK')
