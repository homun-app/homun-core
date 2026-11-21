#!/usr/bin/env node
// Sonda della fase barra-sobria — la barra laterale per molti progetti
// (tavola 6), provata DAL VIVO con la UI, come le altre sonde: app VERA
// (out/, serve `npm run build` prima) su dati temporanei, modello FINTO
// openai-compatible scriptabile su 127.0.0.1 (con richieste «sospese» che
// tengono i bot al lavoro), CLI `container` FINTA, Portachiavi/SafeStorage
// FINTI, server MCP «ufficio» FINTO per le bozze. MAI il container vero,
// mai download, rete solo su 127.0.0.1.
//
// Scenario (spec): 3 squadre e 14 bot — uno aspetta te (bozza email), uno
// lavora (richiesta sospesa), una squadra ha finito (turno completato:
// il segno «finito» vive 1,5 s e lo cattura un MutationObserver), gli
// altri fermi.
//
// Controlli: l'ordine (le voci fisse; prima chi aspetta te, poi ultima
// attività); «Mostra tutti (14)» che espande; la squadra che aspetta te
// aperta da sola e le altre chiuse; i segni di stato con i loro aria-label;
// l'anteprima nel suggerimento al passaggio del mouse; la rotaia (cerchi
// con l'iniziale, robottini, mini-segni); la misura dei long task con 30
// righe animate (nessuno oltre 50 ms).
//
// Catture CDP della barra larga e della rotaia in docs/catture/fase-barra/.
// VERDE in TRE corse di fila: node scripts/fase-barra-probe.mjs --run 1|2|3.
// Attese dei click UI ≤ 5 s; ogni attesa che riguarda il prodotto è un check.
// Pulizia K4: 0 cartelle sandbot-fase-barra-*, 0 daemon della sonda,
// 0 llama-server nati con la corsa.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const runArg = process.argv.find((a) => /^--?run/.test(a))
const run = runArg ? (Number(runArg.split('=')[1] ?? process.argv[process.argv.indexOf(runArg) + 1]) || 1) : 1
const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-barra'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-barra')
mkdirSync(SHOTS, { recursive: true })

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

// ---- il modello FINTO: risposte a pattern sul body. `when` come nelle
// altre sonde; kind 'hold' = la risposta NON arriva mai (il bot resta al
// lavoro: è così che la sonda mette in moto tante righe animate) ----
const script = []
/** le risposte «lente» tenute aperte: si chiudono PRIMA della pulizia,
 *  sennò il daemon resta appeso ai turni vivi e non muore in tempo */
const heldRes = new Set()
const matches = (body, tools, when) =>
  typeof when === 'function' ? !!when(body, tools)
  : when == null ? true
  : Array.isArray(when) ? when.every((w) => body.includes(w))
  : body.includes(when)
const sayText = (text, when = null) => script.push({ kind: 'text', text, when })
const callTool = (name, args, when = null) => script.push({ kind: 'tool', name, args, when })
const hold = (when = null) => script.push({ kind: 'hold', when })
const served = []
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
      const tools = [...body.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1])
      const idx = script.findIndex((x) => matches(body, tools, x.when))
      const next = idx >= 0 ? script.splice(idx, 1)[0] : { kind: 'text', text: 'ok' }
      const who = /You are (@?[\wÀ-ÿ']+)/.exec(body)?.[1] ?? '?'
      served.push(next.kind === 'hold' ? `hold:${who}` : next.kind === 'tool' ? next.name : `text:${who}`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (next.kind === 'hold') {
        // STREAM LENTO: un delta ogni 2 s, mai [DONE] — la richiesta non
        // finisce e il bot resta al lavoro (speaking → «lavora» in barra).
        // Un socket appeso VUOTO verrebbe ri-tentato dal daemon e poi chiuso
        res.write(sse({ role: 'assistant', content: 'Sto lavorando… ' }, null))
        heldRes.add(res)
        const iv = setInterval(() => {
          try { res.write(sse({ content: '· ' }, null)) } catch { clearInterval(iv) }
        }, 2_000)
        req.on('close', () => { clearInterval(iv); heldRes.delete(res) })
        return
      }
      if (next.kind === 'tool') {
        res.write(sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_finto', type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null))
        res.write(sse({}, 'tool_calls'))
      } else {
        res.write(sse({ role: 'assistant', content: next.text }, null))
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
const DEBUG_PORT = 9481 + run
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
    HOMUN_CONTAINER_PATH: FAKE_CONTAINER
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
// i llama-server GIÀ in corsa (per esempio l'Ollama dell'utente) non sono
// della sonda — il controllo di pulizia conta solo quelli NASCITI dopo
const llamaBaseline = (() => {
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-x', 'llama-server'], { encoding: 'utf8' })
    return new Set(String(out.stdout ?? '').trim().split('\n').filter(Boolean))
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
log('CDP collegato al renderer')
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
const waitDom = async (exprTrue, timeoutMs = 5_000, step = 200) => {
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
const clickTestid = async (testid, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}
const clickText = async (text, { exact = false, timeoutMs = 5_000 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const nodes = [...document.querySelectorAll('aside button')]
      const t = ${JSON.stringify(text)}
      const el = nodes.find((b) => ${exact ? 'b.textContent.trim() === t' : 'b.textContent.includes(t)'})
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
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
/** apre i membri di una squadra dalla chevron (la strada di prodotto) */
const openTeamMembers = async (teamName, memberName) => {
  const ok = await pageEval(`
    const btns = [...document.querySelectorAll('aside button[aria-label]')]
    const b = btns.find((x) => (x.getAttribute('aria-label') ?? '').includes(${JSON.stringify(`Apri i membri di ${teamName}`)}))
    if (!b) return false
    b.click()
    return true
  `).catch(() => false)
  return ok === true && await waitDom(`[...document.querySelectorAll('aside button')].some((x) => x.textContent.trim().startsWith(${JSON.stringify(memberName)}))`, 5_000)
}
/** richiude i membri (l'utente può: la scelta si ricorda) */
const closeTeamMembers = async (teamName) => {
  return await pageEval(`
    const btns = [...document.querySelectorAll('aside button[aria-label]')]
    const b = btns.find((x) => (x.getAttribute('aria-label') ?? '').includes(${JSON.stringify(`Chiudi i membri di ${teamName}`)}))
    if (!b) return false
    b.click()
    return true
  `).catch(() => false)
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

try {
  await setViewport(1280, 800)

  // ---- setup: provider finto, guida chiusa, i bot, le squadre, l'MCP ufficio ----
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  // la guida del primo avvio si chiude senza passare dai passi (come la
  // sonda squadra: più giri di advance finché l'aside non c'è)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(`document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(`document.querySelector('aside')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))

  // i bot: il principale, le tre squadre, i 14 singoli
  const mkAgent = async (name, role = '') => {
    const a = await rpc(`createAgent(${JSON.stringify(name)}, ${JSON.stringify(role)})`)
    await rpc(`updateAgent(${JSON.stringify(a.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    return a
  }
  // il principale esiste GIÀ (lo crea la guida del primo avvio): si usa
  // quello — crearne un altro metterebbe un 15° bot tra i singoli
  const agenti0 = await rpc('listAgents()')
  let principale = agenti0[0] ?? null
  if (!principale) principale = await mkAgent('Bot', 'il tuo punto di contatto')
  else await rpc(`updateAgent(${JSON.stringify(principale.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  const capo = await mkAgent('Capo', 'coordinatore del weekend')
  const treni = await mkAgent('Treni', 'orari e biglietti')
  const turismo = await mkAgent('Turismo', 'musei e itinerari')
  const solleciti = await mkAgent('Solleciti', 'coordina le fatture')
  const archivio = await mkAgent('Archivio', 'cerca nelle fatture')
  const permesso = await mkAgent('Permesso', 'sportello permessi')
  const NOMI_LIBERI = ['Ricerche', 'Competitoor', 'Newsletter', 'Analisi prezzi', 'Bilanci', 'Preventivi', 'Contratti', 'Fatturazione', 'Magazzino', 'Logistica', 'Acquisti', 'Vendite', 'Report', 'Budget']
  const liberi = []
  for (const nome of NOMI_LIBERI) liberi.push(await mkAgent(nome, ''))
  const gWeekend = await rpc(`groupCreate(${JSON.stringify('Weekend Torino')}, ${JSON.stringify([capo.id, treni.id, turismo.id])}, ${JSON.stringify(capo.id)}, ${JSON.stringify('Guida per un weekend a Torino')})`)
  const gFatture = await rpc(`groupCreate(${JSON.stringify('Fatture marzo')}, ${JSON.stringify([solleciti.id, archivio.id])}, ${JSON.stringify(solleciti.id)}, ${JSON.stringify('Le fatture di marzo')})`)
  await rpc(`groupCreate(${JSON.stringify('Gara Lecco')}, ${JSON.stringify([permesso.id])}, ${JSON.stringify(permesso.id)}, ${JSON.stringify('Sportello permessi')})`)

  // il server MCP «ufficio» FINTO: le bozze dell'invio (mai rete vera)
  const mcpCallsFile = join(DATA, 'ufficio-calls.jsonl')
  const serverCfg = { id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts', 'fake-ufficio-mcp.mjs'), mcpCallsFile], enabled: true, enabledFor: ['*'] }
  await rpc(`mcpSave(${JSON.stringify(serverCfg)})`)
  const mcpOk = await rpc(`mcpTest('srv-ufficio')`)
  check('setup: il server MCP «ufficio» è collegato (bozze senza rete)', mcpOk?.ok === true && (mcpOk.tools ?? []).some((t) => t.includes('send_email')), JSON.stringify(mcpOk)?.slice(0, 120))
  // dopo il collegamento si ricarica la pagina perché i tool siano offerti al modello
  await page.send('Page.reload')
  if (!(await waitDom(`document.querySelector('aside')`, 25_000))) throw new Error('la pagina non è tornata dopo il reload: ' + appLog.slice(-500))

  // ---- lo script del modello ----
  // i tre bot «recenti» rispondono subito (dànno lastAt diversi ai fermi).
  // I pattern chiedono ANCHE il marcatore del messaggio: i turni d'intro
  // della creazione (che portano solo «You are …») prendono l'«ok» di default
  sayText('Fatto, report pronto.', ['You are Newsletter', 'newsletter:'])
  sayText('Analisi pronta.', ['You are Analisi prezzi', 'analisi:'])
  sayText('Bilancio pronto.', ['You are Bilanci', 'bilanci:'])
  // Treni completa il turno: la squadra ha finito (segno «finito» per 1,5 s)
  sayText('Guida pronta.', ['You are Treni', 'turno-finito'])
  // le due attese: il clic su un sito interattivo METTE IN PAUSA il turno
  // (le bozze email non fermano il bot: la riga resterebbe «ferma»)
  const TA = ['You are Archivio', 'bozza-archivio']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, TA)
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, TA)
  callTool('browser_type', { ref: 'e4', text: 'Rossi Srl', submit: true }, TA)
  const TC = ['You are Competitoor', 'concorsi']
  callTool('browser', { action: 'open', url: 'https://spa.example/gara' }, TC)
  callTool('browser', { action: 'open', url: 'https://spa.example/gara' }, TC)
  callTool('browser_type', { ref: 'e4', text: 'Domanda gara', submit: true }, TC)
  // Ricerche lavora per sempre: la sua richiesta non riceve mai risposta
  hold(['You are Ricerche', 'ricerche:'])

  // l'osservatore del «finito»: il segno vive 1,5 s, lo si deve vedere PASSARE
  await pageEval(`
    window.__finitoSeen = false
    const look = () => {
      if (document.querySelector('[data-state="finito"]')) window.__finitoSeen = true
    }
    look()
    window.__finitoMo = new MutationObserver(look)
    window.__finitoMo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-label'] })
    return true
  `)

  // ---- i turni (i fermi prima, le attese per ultime: nulla resta in coda).
  // Treni e Archivio stanno in squadre CHIUSE (il nuovo default): si aprono
  // i membri dalla chevron — la strada di prodotto — prima di selezionarli ----
  if (!(await openTeamMembers('Weekend Torino', 'Treni'))) throw new Error('apertura membri di Weekend Torino non riuscita')
  if (!(await selectBot('Treni'))) throw new Error('selezione di Treni non riuscita')
  await sendMessage('turno-finito: prepara la guida')
  await sleep(400)
  await closeTeamMembers('Weekend Torino')
  if (!(await openTeamMembers('Fatture marzo', 'Archivio'))) throw new Error('apertura membri di Fatture marzo non riuscita')
  // i 14 singoli superano il taglio a 4: si ESPANDE la sezione prima dei
  // turni (il controllo del taglio la richiuderà e riaprirà da sola)
  const expandForTurns = await clickText('Mostra tutti (14)')
  if (!expandForTurns) throw new Error('espansione «Mostra tutti (14)» non riuscita prima dei turni')
  for (const [bot, msg] of [
    [liberi[2], 'newsletter: riepiloga la settimana'],
    [liberi[3], 'analisi: confronta i prezzi'],
    [liberi[4], 'bilanci: chiudi il mese'],
    [archivio, 'bozza-archivio: manda il sollecito di Rossi Srl'],
    [liberi[1], 'concorsi: prepara la domanda per la gara']
  ]) {
    if (!(await selectBot(bot.name))) throw new Error(`selezione di ${bot.name} non riuscita`)
    await sendMessage(msg)
    await sleep(400)
  }
  // Ricerche lavora (richiesta sospesa) — si seleziona per ultimo tra i vivi
  if (!(await selectBot('Ricerche'))) throw new Error('selezione di Ricerche non riuscita')
  await sendMessage('ricerche: cerca tutto sulle fiere e dimmi quando hai finito')
  await sleep(1_500)

  // =========== 1. l'ordine: le voci fisse della tavola 6 ===========
  const fixedOrder = await pageEval(`
    const texts = [...document.querySelectorAll('aside button')].map((b) => b.textContent.trim())
    const idx = (t) => texts.findIndex((x) => x.includes(t))
    return { nuovo: idx('Nuovo'), bot: idx('la tua chat'), appr: idx('Da approvare'), plugin: texts.findIndex((x) => x === 'Plugin'), att: texts.findIndex((x) => x === 'Attività'), lib: texts.findIndex((x) => x === 'Libreria') }
  `)
  // PL1 (fase plugin): «Plugin» tra «Da approvare» e «Attività»
  check('l\'ordine delle fisse: Nuovo, Bot (la tua chat), Da approvare, Plugin, Attività, Libreria',
    fixedOrder.nuovo >= 0 && fixedOrder.bot > fixedOrder.nuovo && fixedOrder.appr > fixedOrder.bot && fixedOrder.plugin > fixedOrder.appr && fixedOrder.att > fixedOrder.plugin && fixedOrder.lib > fixedOrder.att,
    JSON.stringify(fixedOrder))

  // =========== 2. la mascotte SOLO sul principale; le squadre col robottino 16 ===========
  const mascots = await pageEval(`
    // solo le VISIBILI DENTRO IL NAV: la guida parcheggia la sua mascotte
    // (110 px) nel DOM dell'aside anche dopo l'arrivo
    const svgs = [...document.querySelectorAll('aside nav svg.bot-svg')].filter((s) => s.getBoundingClientRect().width > 0)
    return svgs.map((s) => s.getAttribute('width'))
  `)
  check('mascotte solo sul principale (22) e robottini delle squadre (16)',
    mascots.filter((w) => w === '22').length === 1 && mascots.filter((w) => w === '16').length === 3 && mascots.length === 4,
    JSON.stringify(mascots))

  // =========== 3. l'anteprima nel SUGGERIMENTO, non sotto il nome ===========
  const preview = await pageEval(`
    const rows = [...document.querySelectorAll('aside button')]
    const row = rows.find((b) => b.textContent.trim().startsWith('Analisi prezzi'))
    if (!row) return null
    const rect = row.getBoundingClientRect()
    return { testo: row.textContent.trim(), title: row.title ?? '', x: rect.x, y: rect.y }
  `)
  // il passaggio del mouse: il title è il suggerimento che appare
  if (preview) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: preview.x + 60, y: preview.y + 10 })
  }
  check('l\'anteprima vive nel suggerimento (title), non sotto il nome',
    !!preview && preview.testo.startsWith('Analisi prezzi') && !preview.testo.includes('Analisi pronta') && preview.title.includes('Analisi pronta'),
    JSON.stringify(preview)?.slice(0, 160))

  // =========== 4. l'ordine delle righe: prima chi aspetta te ===========
  const botOrder = await pageEval(`
    const names = ['Competitoor', 'Newsletter', 'Analisi prezzi', 'Bilanci', 'Ricerche']
    const rows = [...document.querySelectorAll('aside button')]
    return names.map((n) => rows.findIndex((b) => b.textContent.trim().startsWith(n)))
  `)
  // Competitoor (aspetta te, creato per SECONDO) sta sopra i più recenti:
  // l'attesa batte l'ultima attività
  check('prima chi aspetta te: Competitoor sopra i bot più recenti',
    botOrder[0] >= 0 && botOrder.slice(1).every((i) => i < 0 || botOrder[0] < i),
    JSON.stringify(botOrder))

  // =========== 5. «Mostra tutti (14)» che espande (e «Meno» che richiude) ===========
  // la sezione è GIÀ espansa per i turni: si richiude con «Meno» e si riapre
  const righeBotExpr = `return [...document.querySelectorAll('aside nav button')].filter((b) => /Newsletter|Analisi prezzi|Bilanci|Ricerche|Preventivi|Contratti|Fatturazione|Magazzino|Logistica|Acquisti|Vendite|Report|Budget|^Competitoor/.test(b.textContent.trim())).map((b) => b.textContent.trim())`
  const chiusa = await clickText('Meno')
  const primaTesti = chiusa ? await pageEval(righeBotExpr) : []
  const visibiliPrima = primaTesti.length
  const mostra14 = await waitDom(`[...document.querySelectorAll('aside button')].some((b) => b.textContent.includes('Mostra tutti (14)'))`, 5_000)
  const espansa = mostra14 && await clickText('Mostra tutti (14)')
  const dopoTesti = espansa ? await pageEval(righeBotExpr) : []
  const visibiliDopo = dopoTesti.length
  check('«Mostra tutti (14)» espande la sezione: da 4 a 14 righe',
    chiusa && visibiliPrima === 4 && visibiliDopo === 14,
    `prima ${visibiliPrima} (${JSON.stringify(primaTesti).slice(0, 200)}), dopo ${visibiliDopo}`)

  // =========== 6. la squadra che aspetta te si apre DA SOLA; le altre chiuse ===========
  const apertura = await pageEval(`
    const rows = [...document.querySelectorAll('aside button')].map((b) => b.textContent.trim())
    return { archivio: rows.some((t) => t.startsWith('Archivio')), treni: rows.some((t) => t.startsWith('Treni')), turismo: rows.some((t) => t.startsWith('Turismo')), permesso: rows.some((t) => t.startsWith('Permesso')) }
  `)
  check('Fatture marzo (aspetta te) aperta da sola: Archivio rientrato visibile', apertura.archivio === true, JSON.stringify(apertura))
  check('Weekend Torino e Gara Lecco chiuse: i membri non si vedono', apertura.treni === false && apertura.turismo === false && apertura.permesso === false, JSON.stringify(apertura))

  // =========== 7. i segni di stato con i loro aria-label ===========
  const segni = await pageEval(`
    const row = (name) => [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith(name))
    const signOf = (name) => row(name)?.querySelector('.side-sign')?.getAttribute('aria-label') ?? null
    const robotOf = (name) => [...document.querySelectorAll('aside .side-robot')].find((r) => r.closest('button')?.textContent.includes(name))?.getAttribute('aria-label') ?? null
    return { competitoor: signOf('Competitoor'), ricerche: signOf('Ricerche'), archivio: signOf('Archivio'), fatture: robotOf('Fatture marzo') }
  `)
  check('i segni con aria-label: aspetta te (Competitoor e Archivio), lavora (Ricerche)',
    segni.competitoor === 'aspetta te' && segni.ricerche === 'lavora' && segni.archivio === 'aspetta te',
    JSON.stringify(segni))
  check('il robottino della squadra che aspetta te ha aria-label «aspetta te»', segni.fatture === 'aspetta te', JSON.stringify(segni))

  // =========== 8. la squadra ha finito: il segno «finito» è PASSATO (1,5 s) ===========
  const finito = await pageEval(`return window.__finitoSeen === true`)
  check('la squadra ha finito: il segno «finito» è comparso (catturato dall\'osservatore)', finito, String(finito))

  // =========== 9. il tempo per i fermi, a destra ===========
  const tempo = await pageEval(`
    const row = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith('Report'))
    return row ? row.textContent.trim() : null
  `)
  check('il bot fermo mostra il tempo a destra (m/h/g/adesso)', !!tempo && /m$|h$|g$|adesso$/.test(tempo), String(tempo))

  // =========== 10. il numero arancio SOLO per chi aspetta te ===========
  const conteggi = await pageEval(`
    const row = (name) => [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith(name))
    return { fatture: row('Fatture marzo')?.textContent.trim() ?? '', weekend: row('Weekend Torino')?.textContent.trim() ?? '', gara: row('Gara Lecco')?.textContent.trim() ?? '' }
  `)
  // il testo della riga concatena senza spazi («Fatture marzo1adesso»): si
  // tolgono i tempi e si guardano le CIFRE rimaste (il contatore arancio)
  const cifre = (t) => (t.replace(/adesso/g, '').match(/\d+/g) ?? [])
  check('il numero arancio solo se aspetta te: Fatture marzo 1, le altre senza',
    JSON.stringify(cifre(conteggi.fatture)) === '["1"]' && cifre(conteggi.weekend).length === 0 && cifre(conteggi.gara).length === 0,
    JSON.stringify(conteggi))

  // =========== 11. cattura della barra larga ===========
  await shot('1-barra-larga.png')

  // =========== 12. la rotaia ===========
  const railOn = await clickTestid('sidebar-toggle')
  const rail = railOn ? await pageEval(`
    const cerchi = [...document.querySelectorAll('aside [data-testid="rail-bot-circle"]')]
    const iniziali = cerchi.map((c) => c.textContent.trim())
    const labels = [...document.querySelectorAll('aside button')].map((b) => b.getAttribute('aria-label') ?? '').filter(Boolean)
    const segni = [...document.querySelectorAll('aside [data-testid="rail-state-sign"]')].map((s) => s.getAttribute('aria-label'))
    return { iniziali, nomi: labels.some((l) => l.startsWith('Ricerche,')), segni }
  `) : null
  check('la rotaia: i bot come cerchio 22 col colore e l\'iniziale (R di Ricerche)',
    !!rail && rail.iniziali.includes('R') && rail.iniziali.length >= 14, JSON.stringify(rail?.iniziali)?.slice(0, 120))
  check('i suggerimenti della rotaia col nome (aria-label «Ricerche, …»)', !!rail && rail.nomi === true)
  check('la rotaia porta i mini-segni con aria-label', !!rail && rail.segni.includes('aspetta te') && rail.segni.includes('lavora'), JSON.stringify(rail?.segni))
  await shot('2-rotaia.png')
  // si torna alla barra larga per la misura (e si ASPETTA che ci sia)
  const backFull = await clickTestid('sidebar-toggle')
  const wideBack = backFull !== false && await waitDom(`document.querySelector('aside nav') !== null`, 5_000)
  check('dalla rotaia si torna alla barra larga (il bottone accanto ai semafori)', wideBack === true)
  await sleep(500)

  // =========== 13. la misura dei long task con 30 righe animate ===========
  // altri 17 bot al lavoro (richieste sospese) + i fermi: 30+ righe animate
  const carichi = []
  for (let i = 1; i <= 17; i++) {
    const c = await mkAgent(`Carico ${String(i).padStart(2, '0')}`, '')
    carichi.push(c)
    hold([`You are Carico ${String(i).padStart(2, '0')}`, 'lavora:'])
  }
  // i fermi restanti vanno al lavoro anche loro
  for (const nome of ['Preventivi', 'Contratti', 'Fatturazione', 'Magazzino', 'Logistica', 'Acquisti', 'Vendite', 'Report', 'Budget']) {
    hold([`You are ${nome}`, 'lavora:'])
  }
  for (const bot of [...carichi, ...liberi.slice(5).map((l) => l)]) {
    if (!(await selectBot(bot.name))) throw new Error(`selezione di ${bot.name} non riuscita (carico)`)
    await sendMessage('lavora: prenditi tutto il tempo che serve')
    await sleep(250)
  }
  // il movimento RIDOTTO va tolto: la misura vuole le animazioni ATTIVE
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  const animazione = await waitDom(`document.querySelectorAll('aside .side-sign').length + document.querySelectorAll('aside .side-robot--lavora, aside .side-robot--aspetta-te').length >= 30`, 60_000, 500)
  const animate = await pageEval(`return document.querySelectorAll('aside .side-sign').length + document.querySelectorAll('aside .side-robot--lavora, aside .side-robot--aspetta-te').length`).catch(() => 0)
  if (!animazione) {
    const stat = await pageEval(`return (await window.sandbot.listAgents()).map((a) => a.name + ':' + a.status).join(', ')`).catch(() => '?')
    log('DIAGNOSTICA righe animate:', animate, 'stati:', String(stat).slice(0, 400))
  }
  await pageEval(`
    window.__long = []
    window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration) })
    window.__po.observe({ entryTypes: ['longtask'] })
    return true
  `)
  await sleep(2_500)
  const long = await pageEval(`return window.__long`)
  const maxLong = Array.isArray(long) && long.length > 0 ? Math.max(...long) : 0
  check(`30 righe animate (${animate}): nessun long task oltre 50 ms`, animazione && animate >= 30 && maxLong <= 50, `righe animate ${animate}, long task ${JSON.stringify(long)}, max ${maxLong} ms`)

  // ---- pulizia K4 (come le altre sonde) ----
  // PRIMA si chiudono gli stream lenti: il daemon deve poter finire i turni
  for (const r of heldRes) { try { r.destroy() } catch { /* già via */ } }
  heldRes.clear()
  stopApp()
  await sleep(1_500)
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', `fase-barra-probe|${join(ROOT, 'node_modules', 'electron')}`], { encoding: 'utf8' })
    const apps = String(out.stdout ?? '').trim()
    for (const pidStr of apps.split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid && pid !== app.pid) {
        try { process.kill(pid, 'SIGKILL'); log('app residua chiusa:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  // i browser MCP finti dei due clic in pausa: si chiudono anche loro
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', 'fake-browser-mcp'], { encoding: 'utf8' })
    for (const pidStr of String(out.stdout ?? '').trim().split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL'); log('browser finto chiuso:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  await stopProbeDaemons(PREFIX, { log }).catch((e) => log('stopProbeDaemons:', e.message))
  await cleanupProbeRun({ pids: [app.pid], prefix: PREFIX, dirs: [DATA], log, capMs: 20_000 }).catch((e) => log('cleanupProbeRun:', e.message))
  // seconda passata: un daemon lento a morire tiene la cartella
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
  let left = countProbeDirs(PREFIX, [DATA])
  if (left > 0) {
    await sleep(1500)
    await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
    left = countProbeDirs(PREFIX, [DATA])
  }
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  check('pulizia K4: 0 cartelle sandbot-fase-barra-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  const llamas = (await import('node:child_process').then((c) => c.execSync('pgrep -x llama-server || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean))).filter((pid) => !llamaBaseline.has(pid))
  check('pulizia K4: 0 llama-server nati con la corsa', llamas.length === 0, `baseline ${llamaBaseline.size}, nuovi ${llamas.length}`)
  if (failed > 0) log('risposte servite (diagnostica):', JSON.stringify(served))
  await new Promise((r) => providerServer.close(r))
} catch (e) {
  log('ERRORE della sonda:', e?.stack ?? e)
  log('log app (coda):', appLog.slice(-1200))
  failed++
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: String(e?.message ?? e) })
  // pulizia d'emergenza comunque: 0 processi, 0 cartelle
  for (const r of heldRes) { try { r.destroy() } catch { /* già via */ } }
  heldRes.clear()
  stopApp()
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: app.pid ? [app.pid] : [], prefix: PREFIX, dirs: [DATA], log, capMs: 15_000 }).catch(() => undefined)
  await new Promise((r) => providerServer.close(r)).catch(() => undefined)
}

log(`CORSA r${run}: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
