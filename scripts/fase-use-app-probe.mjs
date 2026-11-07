#!/usr/bin/env node
// Sonda Electron della fase USE-APP (U7): l'app VERA (build di sviluppo in
// out/) su cartella dati TEMPORANEA, provider FINTO su 127.0.0.1 e — la
// novità della fase — il DESKTOP FINTO di computer use
// (SANDBOT_TEST_FAKE_COMPUTERUSE=1, valido SOLO insieme a
// SANDBOT_TEST_USER_DATA): NESSUN tasto e NESSUN clic arriva al Mac dove
// gira la sonda. Il desktop finto vive nel processo del daemon e si guida
// da fuori scrivendo <userData>/fake-computeruse.json; le azioni che
// riceve finiscono in <userData>/fake-computeruse-log.jsonl.
//
// Ripete il turno del 6/11 (analisi/turno-sora-2026-11-06.md):
//   1. open_url → card «Aprire sora.chatgpt.com nel tuo browser» → il
//      desktop finto registra l'apertura di https://sora.chatgpt.com/
//      (R3: l'URL arriva a `open` NORMALIZZATO, u.href);
//   2. type {app: Safari} dopo un «Consenti», col desktop che ha HOMUN
//      davanti → Homun riattiva Safari e il testo va a Safari; la riga
//      decisa dice «Consentito una volta · Safari» (R6, controllo DOM);
//   3. type SENZA app → errore e niente digitato;
//   4. type {app: Homun} → rifiutato prima ancora della card;
//   5. Accessibilità negata dal finto → risultato unico, notice col bottone
//      «Apri Accessibilità», terzo tentativo rifiutato senza eseguire;
//   6. «Consenti per 10 minuti a Safari» → le azioni su Safari passano
//      senza card, quelle su Mail chiedono la card; riga decisa
//      «Consentito per 10 minuti · Safari» (R6);
//   7. R1: Slack con a-capo IN MEZZO nel testo → card SEMPRE, anche col
//      permesso a 10 minuti per Slack appena concesso;
//   8. R2: il desktop finto cambia l'app davanti fra il controllo e il tasto
//      → non eseguita («the app in front changed to Mail…»), niente digitato;
//   9. R3: open_url con app "Terminal" → rifiutata (solo browser), niente aperto;
//  10. la pagina Approvazioni mostra il permesso per app con la scadenza.
//
// TRE corse; a fine corsa si chiude OGNI daemon (pid da daemon.lock, poi il
// controllo dall'AMBIENTE dei processi) PRIMA di cancellare le cartelle
// temporanee. Niente Docker, nessun push, mai il Portachiavi vero. I menu
// Radix si chiudono con Escape.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const SHOTS = join(ROOT, 'docs', 'catture', 'use-app')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log('[sonda]', ...a)
let failures = 0
let runFailures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) {
    failures++
    runFailures++
  }
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- il provider FINTO (openai-compatible, SSE su 127.0.0.1) ----
// la coda delle risposte: ogni chiamata del turno consuma la voce successiva
const queue = []
const pushTool = (name, args) => queue.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => queue.push({ text })
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const next = queue.shift() ?? { text: 'ok' }
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
const providerPort = providerServer.address().port

// ---- il desktop finto: controllo e registro, entrambi nella cartella dati ----
const controlFile = (userData) => join(userData, 'fake-computeruse.json')
const logFile = (userData) => join(userData, 'fake-computeruse-log.jsonl')
/** Guida il desktop finto del daemon scrivendo il file di controllo: ogni
 *  chiamata è uno SCENARIO NUOVO (il token fa sì che frontmost si applichi
 *  subito, ma l'attivazione `open -a X` possa poi vincere). */
let scenarioSeq = 0
const setDesktop = (userData, state) => {
  writeFileSync(controlFile(userData), JSON.stringify({ scenario: ++scenarioSeq, ...state }))
}
/** Le azioni registrate dal desktop finto finora. */
const desktopLog = (userData) => {
  try {
    return readFileSync(logFile(userData), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const launchApp = (userData, debugPort) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: userData,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(userData, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(userData, 'safestorage-finta.json'),
      // il desktop finto della fase: NESSUN use-app vero, mai lo schermo del Mac
      SANDBOT_TEST_FAKE_COMPUTERUSE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let appLog = ''
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  return { app, getLog: () => appLog, stop: () => { try { app.kill('SIGTERM') } catch { /* già via */ } } }
}

const daemonPid = (userData) => {
  try {
    const v = JSON.parse(readFileSync(join(userData, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
const stopDaemon = async (userData) => {
  const pid = daemonPid(userData)
  if (!pid) return true
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return true }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
  for (let i = 0; i < 15; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return true }
  }
  return false
}

// ---- CDP ----
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
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      const target = list.find((t) => t.type === 'page')
      if (target) return await openCdp(target.webSocketDebuggerUrl)
    } catch { /* il debugger non è ancora su */ }
    await sleep(200)
  }
  throw new Error('nessuna pagina CDP')
}

const waitDom = (pageEval, exprTrue, timeoutMs = 30_000, step = 250) => {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    for (;;) {
      if (await pageEval(`return !!(${exprTrue})`)) return true
      if (Date.now() > deadline) return false
      await sleep(step)
    }
  })()
}

/** Il clic VERO: pointerdown/click (i trigger Radix aprono su pointerdown). */
const pointerClick = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  if (!el) throw new Error('non trovato (pointerClick)')
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
  el.click()
  return 'cliccato'
`)
const clickText = (pageEval, text, selector = 'button', exact = false) => pageEval(`
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
  const want = ${JSON.stringify(text)}
  const match = (x) => (${exact ? 'x.textContent.trim() === want' : 'x.textContent.trim().includes(want)'})
  // prima i VISIBLE (offsetParent), poi — come la sonda impostazioni — anche
  // gli altri: durante le animazioni Radix il filtro ammazza i clic giusti
  const el = els.find((x) => match(x) && x.offsetParent !== null) ?? els.filter(match).pop()
  if (!el) throw new Error('non trovato: ' + want)
  el.click()
  return 'cliccato: ' + want
`)
const uiSend = (pageEval, text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 150))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'inviato'
`)
/** U7: i menu Radix si chiudono con ESCAPE (un click sul body non basta). */
const closeRadixMenus = (pageEval) => pageEval(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 250))
  return 'Escape'
`)

/** UNA corsa completa della sonda (dati freschi, porta di debug propria). */
async function oneRun(runNo) {
  const userData = mkdtempSync(TMP_BASE + `sandbot-use-app-probe-${runNo}-`)
  const debugPort = 9310 + runNo
  runFailures = 0
  log(`corsa ${runNo}: dati ${userData}`)
  // stato iniziale del desktop finto: Safari davanti, tutto permesso
  setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: false })

  const app = launchApp(userData, debugPort)
  let okRun = true
  try {
    // ---- connessione alla pagina + provider + bot ----
    let page
    for (let i = 0; i < 150; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
        const target = list.find((t) => t.type === 'page')
        if (target) { page = await openCdp(target.webSocketDebuggerUrl); break }
      } catch { /* retry */ }
      await sleep(200)
    }
    if (!page) throw new Error('nessuna pagina CDP')
    const pageEval = async (expr) => {
      const r = await page.send('Runtime.evaluate', {
        expression: `((async () => { ${expr} })())`,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300))
      return r?.result?.value
    }
    const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
    const shot = (name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
      writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
      log('cattura', name)
    })
    const setWindowWidth = async (width, height = 900) => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
      await sleep(700)
    }
    // le entry del transcript (i result dei tool e le approval)
    let lastEntryId = 0
    const newEntries = async (agentId) => {
      const es = await rpc(`getEntries(${JSON.stringify(agentId)}, ${lastEntryId})`)
      for (const e of es) lastEntryId = Math.max(lastEntryId, e.id)
      return es
    }

    await waitDom(pageEval, `typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 40_000)
    await setWindowWidth(1440)
    await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
    const agents0 = await rpc('listAgents()')
    const bot = agents0.find((a) => a.name === 'Alfa') ?? agents0[0]
    if (!bot) throw new Error('nessun bot (onboarding?)')
    await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
    await page.send('Page.reload')
    await waitDom(pageEval, `typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 30_000)
    await setWindowWidth(1440)
    // permessi di default dell'app (screenshot libero, il resto chiede)
    const defaultPermissions = {
      default: 'needs_approval',
      rules: [
        { tool: 'send_to_user', pattern: '*', mode: 'always_allow' },
        { tool: 'use-app', pattern: 'screenshot', mode: 'always_allow' },
        { tool: 'use-app', pattern: '*', mode: 'needs_approval' }
      ]
    }
    await rpc(`settingsSet('permissions', ${JSON.stringify(defaultPermissions)})`)

    /** Click su «Consenti» con RIPROVA: il primo click può arrivare mentre
     *  la card sta ancora montando nel DOM; si riprova finché la card non si
     *  risolve (scompare il bottone) e il turno finisce. */
    const clickApprovalAndEndTurn = async (buttonText = 'Consenti', timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs
      const all = []
      while (Date.now() < deadline) {
        // match ESATTO: «✓Consentito una volta…» della riga decisa contiene
        // «Consenti» e ruberebbe il clic
        try { await clickText(pageEval, buttonText, 'button', true) } catch { /* nessun bottone: già risolta o non montata */ }
        await sleep(800)
        const seen = await newEntries(bot.id)
        all.push(...seen)
        const stillPending = await pageEval(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(buttonText)})`)
        if (!stillPending && seen.some((e) => e.kind === 'event' && e.meta?.turnEnd)) return all
        if (!stillPending) {
          // la card è risolta: aspetta solo la fine del turno
          const rest = await awaitTurnEnd(Math.max(3000, deadline - Date.now()))
          return [...all, ...rest]
        }
      }
      dumpTurn(all, `click ${buttonText} (TIMEOUT, card ancora pendente)`)
      return all
    }

    /** Il raccordo di debug: le entry del turno in forma breve. */
    const dumpTurn = (es, label) => {
      log(`turno «${label}» →`, JSON.stringify(es.map((e) => ({
        k: e.kind,
        c: String(e.content ?? '').slice(0, 90),
        st: e.meta?.status,
        cap: e.meta?.accessibilityCap === true,
        end: e.meta?.turnEnd,
        ui: e.meta?.ui?.id
      }))))
    }

    /** Manda il messaggio e aspetta che il turno si assesti: o una CARD in
     *  attesa (da cliccare) o la FINE del turno (event con meta.turnEnd).
     *  Le entry si ACCUMULANO fra le letture: newEntries torna solo le nuove
     *  dall'ultima chiamata e l'ultima lettura può contenere sola la coda del
     *  turno (il result di un tool restava nel batch precedente). */
    const sendAndAwaitSettled = async (label, { timeoutMs = 40_000 } = {}) => {
      await uiSend(pageEval, label)
      const deadline = Date.now() + timeoutMs
      const all = []
      while (Date.now() < deadline) {
        const seen = await newEntries(bot.id)
        all.push(...seen)
        if (seen.some((e) => e.kind === 'event' && e.meta?.turnEnd)) { dumpTurn(all, label); return { entries: all, ended: true } }
        if (seen.some((e) => e.kind === 'approval' && e.meta?.status === 'pending')) { dumpTurn(all, label); return { entries: all, ended: false } }
        await sleep(300)
      }
      dumpTurn(all, label + ' (TIMEOUT)')
      return { entries: all, ended: false }
    }
    /** Dopo il click sulla card: aspetta la FINE del turno. */
    const awaitTurnEnd = async (timeoutMs = 40_000) => {
      const deadline = Date.now() + timeoutMs
      const all = []
      while (Date.now() < deadline) {
        const seen = await newEntries(bot.id)
        all.push(...seen)
        if (seen.some((e) => e.kind === 'event' && e.meta?.turnEnd)) return all
        await sleep(300)
      }
      dumpTurn(all, 'attesa fine (TIMEOUT)')
      return all
    }

    // ============ 1. open_url: la card con l'host, il desktop registra ============
    setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: false })
    pushTool('use-app', { action: 'open_url', url: 'https://sora.chatgpt.com' })
    pushText('Ho aperto sora.chatgpt.com nel tuo browser.')
    const before1 = desktopLog(userData).length
    const t1 = await sendAndAwaitSettled(`apri sora ${runNo}`)
    // la card è comparsa e aspetta
    const card1 = t1.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    check(`1a corsa${runNo}: la card di open_url compare`, !!card1)
    // l'host in evidenza nel titolo della card (DOM: «Aprire sora.chatgpt.com nel tuo browser», host in grassetto)
    const hostInCard = await waitDom(pageEval,
      `[...document.querySelectorAll('p')].some((p) => p.offsetParent !== null && p.textContent.includes('Aprire') && p.textContent.includes('sora.chatgpt.com') && p.textContent.includes('nel tuo browser') && !!p.querySelector('b'))`,
      8000)
    check(`1b corsa${runNo}: la card dice «Aprire sora.chatgpt.com nel tuo browser» con l'host in evidenza`, hostInCard)
    await shot(`corsa${runNo}-1-card-open-url.png`)
    const es1 = await clickApprovalAndEndTurn('Consenti')
    const res1 = es1.filter((e) => e.kind === 'tool-result' && e.meta?.callId).at(-1)
    let openedOk = false
    for (let i = 0; i < 40 && !openedOk; i++) {
      const ops = desktopLog(userData).slice(before1)
      openedOk = ops.some((o) => o.op === 'open_url' && o.url === 'https://sora.chatgpt.com/' && !o.app)
      if (!openedOk) await sleep(250)
    }
    check(`1c corsa${runNo}: il desktop finto registra l'apertura di https://sora.chatgpt.com/ (R3: href normalizzato)`, openedOk)
    check(`1d corsa${runNo}: il result dice «Opened https://sora.chatgpt.com/ in the default browser»`,
      !!res1 && res1.content === 'Opened https://sora.chatgpt.com/ in the default browser',
      res1?.content)

    // ============ 2. type {app: Safari} con HOMUN davanti dopo il Consenti ============
    setDesktop(userData, { frontmost: 'Homun', activates: true, denyAccessibility: false })
    pushTool('use-app', { action: 'type', app: 'Safari', text: 'https://sora.chatgpt.com' })
    pushText('Digitato in Safari.')
    const before2 = desktopLog(userData).length
    const t2 = await sendAndAwaitSettled(`scrivi l'url ${runNo}`)
    const card2 = t2.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    check(`2a corsa${runNo}: la card di type su Safari compare (chiave per app)`, !!card2)
    await shot(`corsa${runNo}-2-card-safari.png`)
    await clickApprovalAndEndTurn('Consenti')
    let safariTyped = false
    let safariOps = []
    for (let i = 0; i < 40 && !safariTyped; i++) {
      safariOps = desktopLog(userData).slice(before2)
      const open = safariOps.findIndex((o) => o.op === 'open' && o.args?.[0] === '-a' && o.args?.[1] === 'Safari')
      const type = safariOps.findIndex((o) => o.op === 'type' && o.text === 'https://sora.chatgpt.com' && o.into === 'Safari')
      safariTyped = open >= 0 && type > open
      if (!safariTyped) await sleep(250)
    }
    check(`2b corsa${runNo}: Homun riattiva Safari (open -a Safari) e POI il testo va a Safari`, safariTyped,
      JSON.stringify(safariOps.slice(0, 4)))
    // R6: la riga decisa dice l'APP, non «Computer e schermo» (controllo DOM)
    const rowOnce = await waitDom(pageEval,
      `[...document.querySelectorAll('span')].some((s) => s.offsetParent !== null && s.textContent.trim() === 'Consentito una volta · Safari')`,
      8000)
    check(`2c corsa${runNo}: la riga decisa dice «Consentito una volta · Safari»`, rowOnce)

    // ============ 3. type senza app: errore, niente digitato ============
    // permessi: use-app sempre consentito, così si vede l'ERRORE del tool (non una card)
    await rpc(`settingsSet('permissions', ${JSON.stringify({ ...defaultPermissions, rules: [...defaultPermissions.rules.slice(0, 2), { tool: 'use-app', pattern: '*', mode: 'always_allow' }] })})`)
    setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: false })
    pushTool('use-app', { action: 'type', text: 'questo non deve finire da nessuna parte' })
    pushText('Manca l\'app.')
    const before3 = desktopLog(userData).length
    const t3 = await sendAndAwaitSettled(`senza app ${runNo}`)
    const res3 = t3.entries.find((e) => e.kind === 'tool-result' && e.content?.includes('`app` is required'))
    check(`3a corsa${runNo}: type senza app → errore «app is required»`, !!res3, res3?.content?.slice(0, 60))
    await sleep(800)
    const typed3 = desktopLog(userData).slice(before3).some((o) => o.op === 'type')
    check(`3b corsa${runNo}: niente è stato digitato`, !typed3)

    // ============ 4. type {app: Homun}: rifiutato prima della card ============
    pushTool('use-app', { action: 'key', app: 'Homun', key: 'cmd+a' })
    pushText('Rifiutato.')
    const before4 = desktopLog(userData).length
    const t4 = await sendAndAwaitSettled(`in homun ${runNo}`)
    const res4 = t4.entries.find((e) => e.kind === 'tool-result' && e.content === 'Homun never types or clicks into its own window.')
    check(`4a corsa${runNo}: type {app: Homun} → «Homun never types or clicks into its own window.»`, !!res4)
    const approval4 = t4.entries.find((e) => e.kind === 'approval')
    check(`4b corsa${runNo}: nessuna card per l'azione dentro Homun`, !approval4)
    const ops4 = desktopLog(userData).slice(before4)
    check(`4c corsa${runNo}: il desktop finto non ha ricevuto niente`, !ops4.some((o) => o.op === 'type' || o.op === 'key' || o.op === 'open'))

    // ============ 5. Accessibilità negata: risultato unico, notice, tetto di due ============
    setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: true })
    pushTool('use-app', { action: 'click', app: 'Safari', x: 100, y: 100 })
    pushTool('use-app', { action: 'type', app: 'Safari', text: 'x' })
    pushTool('use-app', { action: 'key', app: 'Safari', key: 'Return' })
    pushText('Mi fermo e te lo dico.')
    const before5 = desktopLog(userData).length
    const t5 = await sendAndAwaitSettled(`accessibilita ${runNo}`, { timeoutMs: 60_000 })
    const ACCESS_TEXT = 'Homun needs the macOS Accessibility permission for clicks and typing. Tell the user to enable Homun in System Settings → Privacy & Security → Accessibility, then try again. Do not retry before the user confirms.'
    const accResults = t5.entries.filter((e) => e.kind === 'tool-result' && e.content === ACCESS_TEXT)
    check(`5a corsa${runNo}: i due errori di Accessibilità danno il risultato UNICO`, accResults.length >= 2, `(${accResults.length})`)
    const capped = t5.entries.filter((e) => e.kind === 'tool-result' && e.meta?.accessibilityCap === true)
    check(`5b corsa${runNo}: il TERZO tentativo è rifiutato senza eseguire (accessibilityCap)`, capped.length === 1, `(${capped.length})`)
    await sleep(800)
    const osa5 = desktopLog(userData).slice(before5).filter((o) => o.op === 'osascript').length
    check(`5c corsa${runNo}: il desktop finto ha visto DUE osascript, non tre`, osa5 === 2, `(${osa5})`)
    const notice5 = t5.entries.find((e) => e.kind === 'notice' && e.meta?.ui?.id === 'notice.computerAccessibility')
    check(`5d corsa${runNo}: UNA notice di Accessibilità in chat`, !!notice5)
    const button5 = await waitDom(pageEval, `[...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Apri Accessibilità')`, 8000)
    check(`5e corsa${runNo}: la notice ha il bottone «Apri Accessibilità»`, button5)
    await shot(`corsa${runNo}-5-notice-accessibilita.png`)

    // ============ 6. «Consenti per 10 minuti a Safari»: una card, poi via libera ============
    setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: false })
    await rpc(`settingsSet('permissions', ${JSON.stringify(defaultPermissions)})`)
    pushTool('use-app', { action: 'type', app: 'Safari', text: 'prima digitazione' })
    pushText('Ok.')
    const t6 = await sendAndAwaitSettled(`dieci minuti ${runNo}`)
    const card6 = t6.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    check(`6a corsa${runNo}: la card di Safari compare`, !!card6)
    // il menu «Altre opzioni ▾» offre «Consenti per 10 minuti a Safari»
    await waitDom(pageEval, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Altre opzioni'))`, 10_000)
    await pointerClick(pageEval, `[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('Altre opzioni')).pop()`)
    const menuItem = await waitDom(pageEval, `[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.offsetParent !== null && m.textContent.trim() === 'Consenti per 10 minuti a Safari')`, 8000)
    check(`6b corsa${runNo}: il menu offre «Consenti per 10 minuti a Safari»`, menuItem)
    await shot(`corsa${runNo}-6-menu-10-minuti.png`)
    // il menu item è un [role=menuitem]: click secco + attesa robusta
    let menuClicked = false
    for (let i = 0; i < 5 && !menuClicked; i++) {
      try { await clickText(pageEval, 'Consenti per 10 minuti a Safari', '[role="menuitem"]', true); menuClicked = true } catch { await sleep(500) }
    }
    // la voce di menu HA GIÀ risolto la card (minutes10): si aspetta che il
    // bottone sparisca PRIMA di chiamare l'helper, altrimenti il suo click su
    // «Consenti» risolve di nuovo e sovrascrive la modalità («una volta»)
    await waitDom(pageEval, `![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`, 8000)
    await clickApprovalAndEndTurn('Consenti')
    await closeRadixMenus(pageEval)
    // R6: la riga decisa dei 10 minuti dice «· Safari»
    const row10 = await waitDom(pageEval,
      `[...document.querySelectorAll('span')].some((s) => s.offsetParent !== null && s.textContent.trim() === 'Consentito per 10 minuti · Safari')`,
      8000)
    let row10note = ''
    if (!row10) {
      row10note = String(await pageEval(`return [...document.querySelectorAll('span')].filter((s) => s.offsetParent !== null && /Consentito|Rifiutato/.test(s.textContent)).map((s) => s.textContent.trim()).slice(0, 8).join(' | ')`) ?? '')
    }
    check(`6b2 corsa${runNo}: la riga decisa dice «Consentito per 10 minuti · Safari»`, row10, row10note.slice(0, 200))
    // la seconda azione su Safari NON chiede la card
    pushTool('use-app', { action: 'type', app: 'Safari', text: 'seconda digitazione' })
    pushText('Ok di nuovo.')
    const t6b = await sendAndAwaitSettled(`ancora safari ${runNo}`)
    const approval6b = t6b.entries.find((e) => e.kind === 'approval')
    const typed6b = desktopLog(userData).some((o) => o.op === 'type' && o.text === 'seconda digitazione' && o.into === 'Safari')
    check(`6c corsa${runNo}: l'azione successiva su Safari passa SENZA card`, !approval6b && typed6b, approval6b ? 'card comparsa' : 'ok')
    // quella su MAIL chiede
    pushTool('use-app', { action: 'type', app: 'Mail', text: 'posta' })
    pushText('Ok mail.')
    const t6c = await sendAndAwaitSettled(`mail ${runNo}`)
    const card6c = t6c.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    check(`6d corsa${runNo}: l'azione su MAIL chiede la card (il permesso è per app)`, !!card6c)
    if (card6c) {
      await shot(`corsa${runNo}-6-card-mail.png`)
      await clickApprovalAndEndTurn('Rifiuta')
    }

    // ============ 7. R1: Slack con a-capo IN MEZZO chiede SEMPRE, permesso 10 minuti compreso ============
    setDesktop(userData, { frontmost: 'Slack', activates: true, denyAccessibility: false })
    // prima il permesso a 10 minuti per Slack, come per Safari al punto 6
    pushTool('use-app', { action: 'type', app: 'Slack', text: 'salve' })
    pushText('Ok slack.')
    const t7 = await sendAndAwaitSettled(`slack permesso ${runNo}`)
    const card7 = t7.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    check(`7a corsa${runNo}: la card di Slack compare`, !!card7)
    await waitDom(pageEval, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Altre opzioni'))`, 10_000)
    await pointerClick(pageEval, `[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('Altre opzioni')).pop()`)
    const menuItem7 = await waitDom(pageEval, `[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.offsetParent !== null && m.textContent.trim() === 'Consenti per 10 minuti a Slack')`, 8000)
    check(`7b corsa${runNo}: il menu offre «Consenti per 10 minuti a Slack»`, menuItem7)
    for (let i = 0; i < 5; i++) {
      try { await clickText(pageEval, 'Consenti per 10 minuti a Slack', '[role="menuitem"]', true); break } catch { await sleep(500) }
    }
    // come al punto 6: la voce di menu ha già risolto la card
    await waitDom(pageEval, `![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Consenti')`, 8000)
    await clickApprovalAndEndTurn('Consenti')
    await closeRadixMenus(pageEval)
    // ORA il testo con l'a-capo IN MEZZO: un invio che spedirebbe «prima riga»
    pushTool('use-app', { action: 'type', app: 'Slack', text: 'prima riga\nseconda riga' })
    pushText('Chiedo.')
    const before7 = desktopLog(userData).length
    const t7b = await sendAndAwaitSettled(`slack a-capo ${runNo}`)
    const card7b = t7b.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    check(`7c corsa${runNo}: l'a-capo IN MEZZO chiede la card NONOSTANTE il permesso a 10 minuti`, !!card7b)
    check(`7d corsa${runNo}: la card è quella dell'invio in chat (approval.useAppSend)`, card7b?.meta?.ui?.id === 'approval.useAppSend', card7b?.meta?.ui?.id)
    await shot(`corsa${runNo}-7-card-slack-acapo.png`)
    if (card7b) await clickApprovalAndEndTurn('Rifiuta')
    await sleep(800)
    const typed7 = desktopLog(userData).slice(before7).some((o) => o.op === 'type')
    check(`7e corsa${runNo}: rifiutata → niente digitato nel desktop finto`, !typed7)

    // ============ 8. R2: l'app davanti cambia fra il controllo e il tasto → NON eseguita ============
    // il permesso a 10 minuti di Safari (punto 6) è ancora attivo: l'azione
    // parte senza card, e la guardia nello script la ferma sul nascere
    setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: false, frontChangesTo: 'Mail' })
    pushTool('use-app', { action: 'type', app: 'Safari', text: 'questo non deve essere digitato' })
    pushText('Fermato.')
    const before8 = desktopLog(userData).length
    const t8 = await sendAndAwaitSettled(`cambio fronte ${runNo}`)
    const res8 = t8.entries.find((e) => e.kind === 'tool-result' && e.content?.includes('the app in front changed to Mail'))
    check(`8a corsa${runNo}: il risultato è «Not executed: the app in front changed to Mail just before the action. Nothing was typed.»`,
      !!res8 && res8.content === 'Not executed: the app in front changed to Mail just before the action. Nothing was typed.',
      res8?.content)
    await sleep(800)
    const typed8 = desktopLog(userData).slice(before8).some((o) => o.op === 'type')
    check(`8b corsa${runNo}: niente è stato digitato (la guardia ha fermato il tasto)`, !typed8)

    // ============ 9. R3: open_url con app "Terminal" → rifiutata, solo browser ============
    setDesktop(userData, { frontmost: 'Safari', activates: true, denyAccessibility: false })
    pushTool('use-app', { action: 'open_url', url: 'https://sora.chatgpt.com', app: 'Terminal' })
    pushText('Rifiutato.')
    const before9 = desktopLog(userData).length
    const t9 = await sendAndAwaitSettled(`terminal url ${runNo}`)
    // la card dell'host c'è (il permesso è per host), l'AZIONE invece è rifiutata
    const card9 = t9.entries.find((e) => e.kind === 'approval' && e.meta?.status === 'pending')
    let es9 = t9.entries
    if (card9) es9 = [...es9, ...(await clickApprovalAndEndTurn('Consenti'))]
    const res9 = es9.filter((e) => e.kind === 'tool-result' && e.meta?.callId).at(-1)
    check(`9a corsa${runNo}: open_url con app "Terminal" → «must be a web browser»`,
      !!res9 && res9.content === '`app` for open_url must be a web browser (e.g. Safari, Google Chrome). Omit it to use the default browser.',
      res9?.content)
    const opened9 = desktopLog(userData).slice(before9).filter((o) => o.op === 'open_url' || o.op === 'open')
    check(`9b corsa${runNo}: nessun open con Terminal è partito`, opened9.length === 0, JSON.stringify(opened9.slice(0, 2)))

    // ============ 10. la pagina Approvazioni mostra il permesso per app con la scadenza ============
    await pointerClick(pageEval, `[...document.querySelectorAll('aside button[aria-haspopup="menu"]')].pop()`)
    const menuOk = await waitDom(pageEval, `[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.textContent.trim() === 'Impostazioni')`, 6000)
    if (menuOk) await clickText(pageEval, 'Impostazioni', '[role="menuitem"]', true)
    const navOk = await waitDom(pageEval, `!!document.querySelector('[role="dialog"] nav button')`, 8000)
    check(`10a corsa${runNo}: le Impostazioni si aprono`, navOk)
    await clickText(pageEval, 'Approvazioni', '[role="dialog"] nav button', false)
    const grantShown = await waitDom(pageEval,
      `[...document.querySelectorAll('[role="dialog"] div, [role="dialog"] span')].some((d) => d.offsetParent !== null && d.textContent.includes('Usare Safari'))`,
      10_000)
    check(`10b corsa${runNo}: «Consensi salvati» mostra «Usare Safari»`, grantShown)
    const expiryShown = await waitDom(pageEval,
      `[...document.querySelectorAll('[role="dialog"] span')].some((d) => d.offsetParent !== null && /Scade:/.test(d.textContent))`,
      6000)
    check(`10c corsa${runNo}: il consenso mostra la SCADENZA («Scade: …»)`, expiryShown)
    await shot(`corsa${runNo}-10-approvazioni.png`)
    // chiusura dialog e menu con Escape (regola della fase)
    await pageEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return 'chiuso'`)
    await sleep(500)
    await closeRadixMenus(pageEval)
  } catch (e) {
    okRun = false
    check(`corsa${runNo}: ERRORE`, false, String(e?.message ?? e).slice(0, 300))
  } finally {
    // diagnostica: le ultime righe del log del daemon (se esiste)
    try {
      const dlog = readFileSync(join(userData, 'data', 'daemon.log'), 'utf8')
      log(`--- daemon.log (ultime 30 righe) corsa ${runNo} ---`)
      log(dlog.split('\n').slice(-30).join('\n'))
    } catch { /* niente log */ }
    try {
      log(`--- log app (ultime 10 righe) corsa ${runNo} ---`)
      log(appLog.slice(-3000))
    } catch { /* niente */ }
    // ---- chiusura: PRIMA il daemon, POI la app, POI le cartelle ----
    const dOk = await stopDaemon(userData)
    app.stop()
    await sleep(1200)
    // rete di sicurezza della sonda: ogni daemon rimasto va via
    await stopProbeDaemons('sandbot-use-app-probe', { log })
    const left = findProbeDaemons('sandbot-use-app-probe')
    check(`corsa${runNo}: 0 daemon rimasti`, left.length === 0, left.map((d) => d.pid).join(','))
    if (dOk && left.length === 0) rmSync(userData, { recursive: true, force: true })
    else okRun = false
  }
  return okRun && runFailures === 0
}

// ---- TRE corse (default; PROBE_RUNS=1 per il debug) ----
const RUNS = Number(process.env.PROBE_RUNS ?? 3)
let allOk = true
for (const runNo of Array.from({ length: RUNS }, (_, i) => i + 1)) {
  queue.length = 0
  const ok = await oneRun(runNo)
  allOk = allOk && ok
}
await new Promise((r) => providerServer.close(() => r()))
log(allOk ? 'TUTTE LE CORSE VERDI' : `CORSE CON ERRORI (${failures} controlli falliti)`)
process.exit(allOk ? 0 : 1)
