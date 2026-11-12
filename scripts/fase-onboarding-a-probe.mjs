#!/usr/bin/env node
// Sonda Electron della fase «onboarding-a» (OA): la guida «Prepariamo Homun»
// e tutto ciò che le gira intorno, DALLA FINESTRA con clic veri via CDP.
// L'app VERA (build di sviluppo in out/) su cartelle dati TEMPORANEE vuote,
// Portachiavi finto, provider FINTO openai-compatible su 127.0.0.1. NESSUNA
// RETE VERA, niente Composio, nessuna app collegata davvero. Copre:
//   OA1: nessun «Bot» prima del daemon (la finestra CARICA), un solo bot
//        principale con mainAgentId;
//   OA2/OA3: welcome → cambio lingua (testi in inglese e ritorno in
//        italiano) → model (il salvataggio del provider col modello chiude
//        il passo DA SOLO) → approvals («Chiedi prima») → chat; il riavvio
//        dell'app A METÀ GUIDA riporta allo STESSO passo;
//   OA4: la card del focus → la scelta → le card app delle app NON collegate
//        (zero chiamate al modello: zero token), la chiusura senza scelta;
//   OA5: «Salta per ora» sul modello → messaggio scritto che RESTA con la
//        riga «Per risponderti mi serve un modello» → salvataggio del
//        provider → il messaggio parte UNA volta sola;
//   l'adozione: dati di una «beta 4» simulata (un «Bot» vuoto senza
//        mainAgentId) → la guida parte col bot ADOTTATO; dati con messaggi
//        → NESSUNA guida.
// Catture in docs/catture/onboarding-a/. A FINE SONDA si chiude ANCHE il
// daemon di sviluppo (pid in daemon.lock dentro la cartella dati), la
// cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

// ---- il provider FINTO (openai-compatible, SSE su 127.0.0.1) ----
const chatRequests = []
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
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
const callsWith = (text) => chatRequests.filter((c) => JSON.stringify(c).includes(text)).length

// ---- l'app Electron (build di sviluppo) ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9357
let appLog = ''
let app = null
const launchApp = (dataDir) => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: dataDir,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
      SANDBOT_TEST_FAKE_BROWSER: '1'
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
const setSelectValue = (testid, value) => pageEval(`
  const sel = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!sel) throw new Error('select non trovata: ' + ${JSON.stringify(testid)})
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  set.call(sel, ${JSON.stringify(value)})
  sel.dispatchEvent(new Event('change', { bubbles: true }))
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
const startApp = async (dataDir) => {
  mkdirSync(dataDir, { recursive: true })
  app = launchApp(dataDir)
  page = await waitForPage()
  // OA1: il caricamento del primo avvio dura dal mount di React alla risposta
  // del daemon — si polla FITTO (60 ms) da SUBITO, prima ancora che window.sandbot
  // esista, perché la finestra può essere brevissima su una macchina veloce
  const splashSeenHere = await waitDom(`!!document.querySelector('[data-testid="boot-splash"]')`, 8_000, 60)
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }
  await setWindowWidth(1440)
  return splashSeenHere
}

/** salva il provider FINTO e sceglie il modello principale (come fa la UI) */
const saveFintoProvider = async () => {
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  await rpc(`settingsSet('models.main', ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
}

// ---- il percorso della guida fino alla chat (usato da più fasi) ----
const runGuideToChat = async ({ modelAction, approvals = 'ask' }) => {
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 30_000))) throw new Error('la guida non è al benvenuto')
  await clickTestid('guide-continue') // Iniziamo
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000))) throw new Error('la guida non è al passo model')
  if (modelAction === 'skip') {
    await clickTestid('guide-skip')
  } else if (modelAction === 'save') {
    await saveFintoProvider()
    await rpc(`settingsSet('models.main', ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  }
  if (!(await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 20_000))) throw new Error('la guida non è arrivata alle autorizzazioni')
  await clickTestid(`guide-approvals-${approvals}`)
  return waitDom(`!!document.querySelector('form textarea')`, 20_000) // la chat
}

const guideStep = () => pageEval(`return document.querySelector('[data-testid^="guide-step-"]')?.getAttribute('data-testid') ?? null`)

// il testo visibile della vista corrente (guida o chat)
const visibleText = () => pageEval(`return document.body.innerText`)

try {
  // ================= FASE 1: dati vuoti — la guida vera e propria =================
  const DATA1 = join(TMP, 'uno')
  log('FASE 1: primo avvio su dati vuoti…')
  const splashSeen = await startApp(DATA1)
  check('OA1a la finestra carica finché il daemon non dice lo stato (boot splash)', splashSeen, splashSeen ? '' : 'lo splash non è stato visto (daemon già pronto?)')
  if (splashSeen) {
    // durante il caricamento il main NON ha creato nessun «Bot» per conto suo:
    // nella corsa di una volta il bot compariva SENZA mainAgentId (creato dal
    // main prima che il daemon decidesse) — ora o non c'è ancora, o c'è GIÀ
    // col mainAgentId scritto (lo crea solo il daemon, nella transazione)
    const early = await rpc('listAgents()').catch(() => [])
    const earlyMain = await rpc(`settingsGet('mainAgentId', null)`).catch(() => null)
    check("OA1b nessun «Bot» orfano: durante il caricamento o non c'è bot, o c'è già col mainAgentId",
      Array.isArray(early) && (early.length === 0 || earlyMain === early[0].id),
      `agenti: ${early?.length}, mainAgentId: ${earlyMain}`)
  }
  // OA1: la guida appare e c'è UN solo bot principale
  check('OA1c la guida «Prepariamo Homun» appare al primo avvio', await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000))
  const agents1 = await rpc('listAgents()')
  const main1 = await rpc(`settingsGet('mainAgentId', null)`)
  check('OA1d UN solo bot, ed è il principale (mainAgentId)', agents1.length === 1 && main1 === agents1[0].id, `${agents1.length} agenti, main=${main1}`)

  // OA2: la guida si vede; OA3 welcome
  await shot('guida-benvenuto-1440-chiaro.png')

  // OA3: la lingua cambia SUBITO i testi (en, poi di nuovo it)
  await setSelectValue('guide-language-select', 'en')
  check('OA3a la lingua inglese cambia subito i testi della guida',
    await waitDom(`document.querySelector('[data-testid="guide-step-welcome"]')?.innerText.includes("Let's set up Homun")`, 8_000),
    await pageEval(`return document.querySelector('[data-testid="guide-step-welcome"]')?.innerText.split('\\n')[0] ?? ''`))
  await setSelectValue('guide-language-select', 'it')
  check('OA3b e tornare all\'italiano ririscrive i testi',
    await waitDom(`document.querySelector('[data-testid="guide-step-welcome"]')?.innerText.includes('Prepariamo Homun')`, 8_000))

  // OA3: il passo model con le strade di oggi
  await clickTestid('guide-continue')
  check('OA3c il passo modello mostra le strade (cloud consigliato, Integrato sul Mac idoneo)',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]') && !!document.querySelector('[data-testid="guide-road-cloud"]') && !!document.querySelector('[data-testid="guide-road-local"]')`, 10_000))
  await shot('guida-modello-1440-chiaro.png')
  await dark(true)
  await shot('guida-modello-1440-scuro.png')
  await dark(false)

  // OA3: il salvataggio del provider col modello chiude il passo DA SOLO
  const llmBefore = chatRequests.length
  await saveFintoProvider()
  check('OA3d il passo modello si chiude DA SOLO al salvataggio del provider col modello',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 15_000))

  // OA3: autorizzazioni — «Automatico» acceso col modello, si sceglie «Chiedi prima»
  const autoEnabled = await pageEval(`return !document.querySelector('[data-testid="guide-approvals-auto"]')?.disabled`)
  check('OA3e «Automatico» è disponibile col modello', autoEnabled === true)
  await shot('guida-autorizzazioni-1440-chiaro.png')
  await clickTestid('guide-approvals-ask')
  check('OA3f la scelta «Chiedi prima» chiude la guida ed entra in chat', await waitDom(`!!document.querySelector('form textarea')`, 15_000))
  const mode = await rpc(`settingsGet('approvals.mode', null)`)
  const modeSet = await rpc(`settingsGet('approvals.modeSet', false)`)
  check('OA3g approvals.mode=ask e modeSet scritti', mode === 'ask' && modeSet === true, `mode=${mode} modeSet=${modeSet}`)

  // OA4: la card del focus, deterministica e senza token
  check('OA4a il bot principale apre col saluto e la card «Su cosa vuoi che ti aiuti per primo?»',
    await waitDom(`!!document.querySelector('[data-testid="widget-option-posta"]')`, 15_000) &&
    (await visibleText()).includes('Su cosa vuoi che ti aiuti per primo?'))
  await shot('chat-card-focus-1440-chiaro.png')
  await dark(true)
  await shot('chat-card-focus-1440-scuro.png')
  await dark(false)
  check('OA4b la guida NON ha speso token: nessuna chiamata al modello', chatRequests.length === llmBefore, `chiamate: ${chatRequests.length - llmBefore}`)
  // la scelta: le card app delle app NON collegate (gmail e gcalendar, non collegate qui)
  await clickTestid('widget-option-posta')
  check('OA4c la scelta deterministica: la frase fissa «Va bene: Posta e calendario»',
    await waitDom(`document.body.innerText.includes('Va bene: Posta e calendario')`, 15_000))
  const textAfterChoice = await visibleText()
  check('OA4d le card app del focus (Gmail e Google Calendar) sono offerte da COLLEGARE',
    textAfterChoice.includes('Gmail') && textAfterChoice.includes('Google Calendar') && !textAfterChoice.includes('Connessa') && textAfterChoice.includes('Connetti'),
    'card app presenti col bottone Connetti, mai «Connessa»')
  await shot('chat-card-app-1440-chiaro.png')
  const botAfter = (await rpc('listAgents()'))[0]
  check('OA4e il bot NON è stato rinominato e la descrizione ha la riga del focus',
    botAfter.name === 'Bot' && (botAfter.description ?? '').includes('Focus iniziale:'), `${botAfter.name}: ${botAfter.description?.slice(0, 60)}`)
  check('OA4f la scelta del focus NON ha speso token', chatRequests.length === llmBefore)
  await stopEverything(DATA1)

  // ================= FASE 2: salta il modello, il messaggio resta in attesa =================
  const DATA2 = join(TMP, 'due')
  log('FASE 2: modello saltato, messaggio in attesa…')
  await startApp(DATA2)
  check('OA5a la guida riparte su dati nuovi', await runGuideToChat({ modelAction: 'skip' }) === true)
  // la card del focus si può CHIUDERE senza scegliere
  check('OA5b la card del focus si chiude senza scegliere («Chiudi»)',
    await waitDom(`!!document.querySelector('[data-testid="focus-dismiss"]')`, 10_000) && (await clickTestid('focus-dismiss'), true) &&
      await waitDom(`!document.querySelector('[data-testid="focus-dismiss"]')`, 10_000))
  // il messaggio senza modello resta, con la riga e il bottone
  const held = 'senza modello, mi senti?'
  await uiSend(held)
  check('OA5c il messaggio RESTA in chat come messaggio dell\'utente',
    await waitDom(`document.body.innerText.includes(${JSON.stringify(held)})`, 15_000))
  check('OA5d sotto compare la riga «Per risponderti mi serve un modello» col bottone',
    await waitDom(`!!document.querySelector('[data-testid="need-model-choose"]') && document.body.innerText.includes('Per risponderti mi serve un modello')`, 15_000))
  await shot('chat-messaggio-in-attesa-1440-chiaro.png')
  check('OA5e il messaggio in attesa NON ha chiamato il modello', callsWith(held) === 0)
  // il modello arriva: il messaggio parte UNA volta
  await saveFintoProvider()
  check('OA5f col modello salvato il messaggio parte e arriva la risposta',
    await waitDom(`document.body.innerText.includes('Ecco fatto: sono qui.')`, 40_000))
  await sleep(2_500) // eventuale seconda corsa (che NON deve esserci)
  check('OA5g il messaggio è partito UNA volta sola', callsWith(held) === 1, `chiamate col messaggio: ${callsWith(held)}`)
  await stopEverything(DATA2)

  // ================= FASE 3: riavvio a metà guida → stesso passo =================
  const DATA3 = join(TMP, 'tre')
  log('FASE 3: riavvio a metà guida…')
  await startApp(DATA3)
  check('OA2a la guida riparte (dati tre)', await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 25_000))
  await clickTestid('guide-continue')
  check('OA2b la guida è al passo model', await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000))
  await stopEverything(DATA3)
  // riavvio COMPLETO (app E daemon) sulla stessa cartella: stesso passo
  await startApp(DATA3)
  check('OA2c riavvio a metà guida: la finestra riporta allo STESSO passo (model)',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 30_000), `step: ${await guideStep()}`)
  await stopEverything(DATA3)

  // ================= FASE 4: l'adozione della beta 4, e chi ha già scritto =================
  log('FASE 4: adozione del «Bot» della beta 4…')
  // simula la beta 4: un «Bot» VUOTO, niente mainAgentId, niente onboarding
  const db3 = new DatabaseSync(join(DATA3, 'data', 'sandbot.db'))
  db3.prepare("DELETE FROM settings WHERE key IN ('mainAgentId', 'onboarding.state', 'onboarding.done')").run()
  db3.prepare('DELETE FROM entries').run()
  const betaRow = db3.prepare("SELECT id FROM agents WHERE name = 'Bot'").get()
  db3.close()
  await startApp(DATA3)
  check('OA1e il «Bot» vuoto della beta viene ADOZZATO: la guida parte con LUI',
    await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 30_000))
  const agentsAdopt = await rpc('listAgents()')
  const mainAdopt = await rpc(`settingsGet('mainAgentId', null)`)
  check('OA1f adottato: UN solo bot, STESSO id, mainAgentId suo',
    agentsAdopt.length === 1 && betaRow && agentsAdopt[0].id === betaRow.id && mainAdopt === betaRow.id,
    `${agentsAdopt.length} agenti, id=${agentsAdopt[0]?.id}, atteso=${betaRow?.id}`)
  await stopEverything(DATA3)

  // ...e chi ha GIA' scritto in chat non vede nessuna guida
  const db4 = new DatabaseSync(join(DATA3, 'data', 'sandbot.db'))
  db4.prepare("INSERT INTO entries(agent_id, kind, role, content, meta, created_at) VALUES(?, 'message', 'user', 'ciao dalla beta', NULL, ?)")
    .run(betaRow.id, Date.now())
  db4.close()
  await startApp(DATA3)
  await sleep(2_500) // il tempo di dire onboarding:state
  const guideAfterMessages = await pageEval(`return !!document.querySelector('[data-testid^="guide-step-"]')`)
  const doneAfterMessages = await rpc(`settingsGet('onboarding.done', false)`)
  check('OA1g chi ha già messaggi NON rifa la guida (e onboarding.done si scrive da solo)',
    guideAfterMessages === false && doneAfterMessages === true, `guida=${guideAfterMessages} done=${doneAfterMessages}`)
  await shot('chat-chi-ha-gia-scritto-1440-chiaro.png')
  await stopEverything(DATA3)

  // ---- pulizia finale: 0 daemon e 0 llama-server ----
  const leftDaemons = findProbeDaemons('sandbot-fase-onboarding-a')
  check('PULIZIA nessun daemon della sonda vivo', leftDaemons.length === 0, leftDaemons.map((d) => d.pid).join(','))
  const llama = await import('node:child_process').then((c) => c.spawnSync('/usr/bin/pgrep', ['-fl', 'llama-server'], { encoding: 'utf8' }))
  const llamaMine = (llama.stdout ?? '').split('\n').filter((l) => l.includes(TMP))
  check('PULIZIA nessun llama-server della sonda vivo', llamaMine.length === 0, llamaMine.join(' | ') || 'nessuno')
} finally {
  try { app?.kill('SIGKILL') } catch { /* già via */ }
  await stopProbeDaemons('sandbot-fase-onboarding-a').catch(() => undefined)
  rmSync(TMP, { recursive: true, force: true })
}

const ok = checks.filter((c) => c.ok).length
console.log(`\n[sonda] ${ok}/${checks.length} controlli superati${failures ? ` — ${failures} FALLITI` : ''}`)
for (const c of checks.filter((x) => !x.ok)) console.log(`  KO ${c.id} ${c.note}`)
process.exit(failures ? 1 : 0)
