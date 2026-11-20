#!/usr/bin/env node
// Sonda della fase squadra — i flussi della spec provati DAL VIVO con la UI,
// come le altre sonde: app VERA (out/, serve `npm run build` prima) su dati
// temporanei, modello FINTO openai-compatible scriptabile su 127.0.0.1, CLI
// `container` FINTA, Portachiavi/SafeStorage FINTI, browser MCP FINTO. MAI il
// container vero, mai download, rete solo su 127.0.0.1.
//
// Tre bot finti in una squadra con autonomia 'box' (default):
//   1. un membro (Treni, per delega di Capo) scrive un file nel computer
//      condiviso: NESSUNA card (Q1) e il file è una card nella timeline (Q4);
//   2. Turismo (per delega) chiede di compilare un modulo con i dati della
//      Cassaforte: card nella CODA della squadra (Q2), decisa DA LÌ, e il
//      turno del bot si sblocca; «Consenti per questa missione» non c'è per
//      i dati tuoi;
//   3. Treni risponde e la RISPOSTA COLLEGATA torna a Capo (Q3), con le righe
//      relay nella timeline (Q4);
//   4. un documento si apre dalla Libreria CON LA SQUADRA APERTA (Q6), e il
//      pannello del team mostra stati, contatori e «Prodotto dalla squadra»
//      (Q5); la schermata Autonomia (Q1) si apre dal riquadro del team.
//
// Catture CDP delle tre schermate del disegno in docs/catture/fase-squadra/.
// VERDE in TRE corse di fila: node scripts/fase-squadra-probe.mjs --run 1|2|3
// Pulizia come in K4: a fine corsa 0 cartelle sandbot-fase-squadra-*, 0
// processi, 0 daemon.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const runArg = process.argv.find((a) => /^--?run/.test(a))
const run = runArg ? (Number(runArg.split('=')[1] ?? process.argv[process.argv.indexOf(runArg) + 1]) || 1) : 1
const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-squadra'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-squadra')
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

// ---- il modello FINTO: risposte a pattern sul body (quando `when` calza) ----
const script = []
// `when` può essere una stringa o UNA LISTA (tutte presenti nel body): la
// lista marca la richiesta per BOT + evento («You are Treni» + «file-treni»),
// così i marker non «filano» nella storia di un altro bot (l'eco del
// messaggio inviato contiene il testo della delega).
// `not` (fase squadra-sicurezza-2, indagine sulla corsa-1-dopo-build rossa):
// stringa o lista NESSUNA delle quali deve stare nel body. Serve ai `pass`
// dei turni di gruppo: l'apertura <turno_di_gruppo> di un turno di gruppo
// PRECEDENTE resta nella storia del bot, quindi una richiesta SUCCESSIVA di
// quel bot (la delega privata, il risveglio) contiene «You are <bot>» +
// «turno_di_gruppo» e si portava via un pass avanzato PRIMA delle voci della
// sezione 3 — il turno di Turismo finiva fuori copione e la card della
// Cassaforte non nasceva mai. I marker negativi sono le parole che stanno
// SOLO nei messaggi PRIVATI (le righe relay non entrano nei turni di gruppo:
// group-runner le filtra), quindi un turno di gruppo VERO non le contiene
// mai e lo scenario non cambia.
const matches = (body, x) =>
  (x.when == null || (Array.isArray(x.when) ? x.when.every((w) => body.includes(w)) : body.includes(x.when))) &&
  (x.not == null || (Array.isArray(x.not) ? x.not.every((w) => !body.includes(w)) : !body.includes(x.not)))
const sayText = (text, when = null) => script.push({ kind: 'text', text, when })
const callTool = (name, args, when = null) => script.push({ kind: 'tool', name, args, when })
const callTools = (calls, when = null) => script.push({ kind: 'tools', calls, when })
// il `pass` di un turno di gruppo: vale SOLO lì — le parole dei messaggi
// PRIVATI (deleghe, risposta collegata) nel body dicono che la richiesta è
// un altro turno e il pass non deve calzare
const callPass = (bot) => script.push({
  kind: 'tool', name: 'pass', args: {},
  when: [`You are ${bot}`, 'turno_di_gruppo'],
  not: ['file-treni', 'delega-treni', 'risposta=', 'delega-museo', 'modulo-museo']
})
const chatRequests = []
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
      chatRequests.push(body)
      const idx = script.findIndex((x) => matches(body, x))
      const next = idx >= 0 ? script.splice(idx, 1)[0] : { kind: 'text', text: 'ok' }
      const who = /You are (@?[\wÀ-ÿ']+)/.exec(body)?.[1] ?? '?'
      const lastUser = body.slice(Math.max(0, body.lastIndexOf('"role":"user"')), Math.max(0, body.lastIndexOf('"role":"user"')) + 220).replace(/\n/g, ' ')
      served.push({ res: next.kind === 'tool' ? next.name : next.kind === 'tools' ? next.calls.map((c) => c.name).join('+') : `text:${String(next.text).slice(0, 30)}`, who, u: lastUser.slice(0, 130) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (next.kind === 'tool') {
        res.write(sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_finto', type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null))
        res.write(sse({}, 'tool_calls'))
      } else if (next.kind === 'tools') {
        res.write(sse({ role: 'assistant', tool_calls: next.calls.map((c, i) => ({ index: i, id: `call_finto_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, null))
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
const DEBUG_PORT = 9417 + run
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
// C3: i llama-server GIÀ in corsa (per esempio l'Ollama dell'utente) non sono
// della sonda — il controllo di pulizia conta solo quelli NASCI dopo
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
/** aspetta che tutti i bot siano idle (niente turni in corso): il renderer
 * sotto carico blocca le evaluate per decine di secondi */
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
  // C3: la finestra in primo piano — coperta, Chromium sospende i rAF e il
  // settle sottile non terminerebbe (falsa lentezza, non dell'app)
  await page.send('Page.bringToFront').catch(() => undefined)
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  // C3: 2 frame OPPURE 1,5 s — la finestra coperta sospende i rAF e l'attesa
  // pura non finirebbe mai (misurerebbe l'occlusione, non l'app)
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
    await sleep(300)
  }
}

const clickText = async (text, { scope = 'document', exact = false, timeoutMs = 5_000 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const root = ${scope}
      const nodes = [...root.querySelectorAll('button, [role="menuitem"], [role="button"], a, .no-drag')]
      const t = ${JSON.stringify(text)}
      const b = nodes.find((x) => ${exact ? `x.textContent.trim() === t || x.getAttribute('aria-label') === t` : `x.textContent.trim().includes(t) || (x.getAttribute('aria-label') ?? '').includes(t)`})
      if (!b) return false
      b.scrollIntoView({ block: 'center' })
      b.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}
/** seleziona un bot nella barra laterale (la riga porta anche lo stato: match per prefisso) e aspetta il compositore privato — si RIPROVA per 5 s: è un click UI, e la riga può arrivare col refresh coalescente della squadra (C3) */
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

try {
  // ---- setup: provider finto, guida chiusa, i tre bot finti e la squadra ----
  if (!(await waitDom(`typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile: ' + appLog.slice(-800))
  await setViewport(1280, 860)
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  // il computer dei bot in HOST: writeFileInBox scrive DAVVERO nella cartella
  // box (col container finto in modalità box il «docker» finto risponderebbe
  // ok senza scrivere nulla)
  await rpc(`settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(`document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(`document.querySelector('aside')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))

  const mkBot = async (name, role) => {
    const a = await rpc(`createAgent(${JSON.stringify(name)}, ${JSON.stringify(role)})`)
    await rpc(`updateAgent(${JSON.stringify(a.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    return a
  }
  const capo = await mkBot('Capo', 'Unisce i file e controlla i conti')
  const treni = await mkBot('Treni', 'Orari e prezzi A/R per 3')
  const turismo = await mkBot('Turismo', 'Itinerari e musei')
  // coordinatore TRENI: il coordinatore NON ha una riga propria nella barra
  // laterale (sta nella riga della squadra), e la sonda seleziona i bot dalle
  // loro righe — Capo resta membro selezionabile come mittente delle deleghe
  const group = await rpc(`groupCreate(${JSON.stringify('Weekend Torino')}, ${JSON.stringify([capo.id, treni.id, turismo.id])}, ${JSON.stringify(treni.id)}, ${JSON.stringify('Guida per un weekend a Torino in treno')})`)
  check('setup: la squadra nasce con autonomia box (il default)', group.autonomy === 'box', `autonomy=${group.autonomy}`)

  // il login della Cassaforte per il modulo del museo (origine del sito finto)
  const login = await rpc(`vaultSaveLogin(${JSON.stringify({ label: 'Museo Egizio', origins: ['https://spa.example'], username: 'utente-musei', password: 'pwd-musei-8a4b2c' })})`)

  // =========== 1. la delega: Treni scrive il file nel computer (Q1+Q3+Q4) ===========
  // l'utente scrive a Capo nella chat DIRETTA; la delega tra membri apre il
  // turno di squadra di Treni (delegationSquadId)
  // la prima chiamata di un tool di gruppo non attivo ATTIVA il gruppo (non
  // esegue: la firma lo dice), la seconda esegue — come il browser della
  // sonda prima-release. Ogni risposta è marcata per BOT + evento
  const CAPO_TRENI = ['You are Capo', 'delega-treni']
  const TRENI_FILE = ['You are Treni', 'file-treni']
  callTool('send_to_agent', { agentId: treni.id, text: 'file-treni: scrivi il file /workspace/torino/01_treni.md con il treno delle 13:05 per Torino' }, CAPO_TRENI)
  callTool('send_to_agent', { agentId: treni.id, text: 'file-treni: scrivi il file /workspace/torino/01_treni.md con il treno delle 13:05 per Torino' }, CAPO_TRENI)
  // il turno di Treni (di squadra): write-file nel computer, poi testo finale
  callTool('write-file', { path: '/workspace/torino/01_treni.md', content: '# Treni\nMilano → Torino: parte alle 13:05, arrivo 15:40. Ritorno domenica 18:22.\n' }, TRENI_FILE)
  sayText('Fatto: treno delle 13:05, arrivo 15:40.', TRENI_FILE)
  // i risvegli di Capo (risposta collegata): chiude senza altri tool
  sayText('Perfetto, orari ricevuti.', ['You are Capo', 'risposta='])
  sayText('Ricevuto.', ['You are Capo', 'risposta='])

  if (!(await selectBot('Capo'))) throw new Error('selezione di Capo non riuscita')
  await sendMessage('delega-treni: chiedi a Treni di scrivere l\'orario nel file del computer')
  // il turno di Treni finisce col testo finale (la risposta collegata parte da lì)
  // il testo finale di Treni è UNIVOCO (l'intro dei bot scrive 'ok' e non conta)
  const treniDone = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(treni.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('treno delle 13:05'))`, 90_000, 500)
  check('Q1: Treni scrive il file nel computer SENZA card', treniDone &&
    !(await rpc(`getEntries(${JSON.stringify(treni.id)})`)).some((e) => e.kind === 'approval'))
  // la cartella dati dell'app è <userData>/data (SANDBOT_TEST_USER_DATA sposta
  // userData per intero): il box condiviso sta in <DATA>/data/box
  const boxFile = join(DATA, 'data', 'box', 'workspace', 'torino', '01_treni.md')
  check('Q1: il file esiste davvero nel computer condiviso', existsSync(boxFile), boxFile)
  if (!existsSync(boxFile) || treniDone === false) {
    // diagnostica minima a KO: le risposte servite e le ultime entry di Treni
    log('DEBUG risposte servite:', JSON.stringify(served))
    log('DEBUG Treni tail:', JSON.stringify((await rpc(`getEntries(${JSON.stringify(treni.id)})`)).slice(-5).map((e) => ({ k: e.kind, c: String(e.content).slice(0, 100) }))))
  }
  // la risposta collegata è tornata a Capo (Q3) e lo ha risvegliato
  const linkedSeen = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'message' && String(e.content).includes('risposta="si"') && String(e.content).includes('13:05'))`, 90_000, 500)
  check('Q3: la risposta collegata torna a CAPO (risposta="si") e lo risveglia', linkedSeen)
  const capoDone = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(capo.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('Perfetto'))`, 90_000, 500)
  check('Q3: Capo prosegue col suo turno (la sequenza del treno)', capoDone)

  // =========== 2. il documento della squadra (Q4 timeline + Q6 apertura) ===========
  // l'utente scrie nella CHAT DELLA SQUADRA con @Capo: il turno di gruppo è
  // un turno di squadra; write_document diventa card della timeline
  const TRENI_GUIDA = ['You are Treni', 'guida-definitiva']
  callTools([
    { name: 'write_document', args: { title: 'Torino weekend — guida definitiva', content: '# Torino weekend\n\n## Treno\nPartenza 13:05, arrivo 15:40.\n\n## Alloggio\nHotel Chelsea, check-in 15:00–22:00.\n' } },
    { name: 'post_to_group', args: { text: 'Guida pronta: 3 persone, 385 € su 400.' } }
  ], TRENI_GUIDA)
  callTool('pass', {}, TRENI_GUIDA)
  // il post del COORDINATORE (Treni) senza menzioni va a tutti gli altri
  // membri: i loro turni di gruppo (e i successivi) chiudono col silenzio
  // (pass) — DOPO le entry della guida, così non la intercettano
  for (const who of ['Capo', 'Turismo', 'Treni']) {
    for (let i = 0; i < 6; i++) callPass(who)
  }

  // B1 (fase beta10-correzioni): qui c'era un waitDom il cui risultato veniva
  // ignorato — «aprire la squadra ne mostra la chat» è un comportamento del
  // prodotto, diventa check
  check('Q4: aprire la squadra dalla barra ne mostra la chat (composer)', await clickText('Weekend Torino', { exact: false }) &&
    await waitDom(`document.querySelector('form textarea')`, 5_000))
  await sendMessage('@Treni guida-definitiva: scrivi la guida definitiva come documento in Libreria')
  const docDone = await waitDom(`document.body.textContent.includes('Guida pronta')`, 60_000, 500)
  check('Q4: il riepilogo del coordinatore è nella timeline', docDone)

  // la timeline: righe relay e card artifact
  const msgs = await rpc(`groupMessages(${group.id})`)
  const relays = msgs.filter((m) => m.authorKind === 'relay')
  const artifacts = msgs.filter((m) => m.authorKind === 'artifact')
  check('Q4: le righe relay dello scambio sono in timeline (andata e risposta)', relays.length >= 2, `${relays.length} relay`)
  const relayText = JSON.stringify(relays)
  check('Q4: la riga relay dice «Capo → Treni» e «Treni → Capo»', relayText.includes('Treni') && relayText.includes('Capo'), relayText.slice(0, 160))
  check('Q4: il file e il documento sono card che si aprono', artifacts.length >= 2, `${artifacts.length} artifact`)
  const artifactText = JSON.stringify(artifacts)
  check('Q4: la card del documento porta il titolo della guida', artifactText.includes('Torino weekend — guida definitiva'))

  // un relay NON ha svegliato nessuno: nessun job group-turn è mai partito
  // dalle righe di visualizzazione (le righe relay nascono DOPO l'ultimo post)
  // — lo si verifica sul registro: i turni del gruppo sono solo quelli dei
  // messaggi veri (l'utente e il post di Capo)

  // =========== 3. la coda: il modulo con i dati della Cassaforte (Q2) ===========
  const CAPO_MUSEO = ['You are Capo', 'delega-museo']
  const TURISMO_MODULO = ['You are Turismo', 'modulo-museo']
  callTool('send_to_agent', { agentId: turismo.id, text: 'modulo-museo: compila il modulo di prenotazione del museo con i miei dati della Cassaforte' }, CAPO_MUSEO)
  callTool('send_to_agent', { agentId: turismo.id, text: 'modulo-museo: compila il modulo di prenotazione del museo con i miei dati della Cassaforte' }, CAPO_MUSEO)
  // il turno di Turismo (di squadra): apre la pagina (attivazione POI
  // esecuzione della facciata browser), poi il fill (anche lui due passaggi:
  // attivazione POI esecuzione del gruppo credentials)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, TURISMO_MODULO)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, TURISMO_MODULO)
  callTool('fill_credential', { id: String(login.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, TURISMO_MODULO)
  callTool('fill_credential', { id: String(login.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, TURISMO_MODULO)
  sayText('Modulo compilato col mio login.', TURISMO_MODULO)

  if (!(await selectBot('Capo'))) throw new Error('selezione di Capo non riuscita (seconda volta)')
  await sendMessage('delega-museo: chiedi a Turismo di compilare il modulo del museo con i miei dati')
  // la card nasce nel turno di Turismo (di squadra) e va nella coda
  const queueSeen = await waitDom(`(await window.sandbot.groupPendingApprovals(${group.id})).pending.length > 0`, 60_000, 500)
  const queue = queueSeen ? await rpc(`groupPendingApprovals(${group.id})`) : { pending: [] }
  const museoCard = queue.pending.find((r) => r.tool === 'fill_credential')
  check('Q2: la card del modulo (dati della Cassaforte) compare nella CODA della squadra', !!museoCard,
    queue.pending.map((r) => `${r.agentName}:${r.tool}`).join(','))
  if (museoCard) {
    check('Q2: la categoria è «i tuoi dati» e il bot è Turismo', museoCard.category === 'dati-tuoi' && museoCard.agentName === 'Turismo',
      `${museoCard.category}/${museoCard.agentName}`)
    check('Q2: il perché è l\'insieme fisso (sempre a te)', museoCard.why === 'fisso', String(museoCard.why))
  }
  // la barra in cima alla chat di squadra: «N azioni aspettano te» + Rivedi tutte
  await waitQuiet()
  await clickText('Weekend Torino', { exact: false })
  const barSeen = await waitDom(`document.querySelector('[data-testid="team-pending-bar"]')`, 5_000)
  check('Q2: la barra in cima dice «N azioni aspettano te»', barSeen && (await pageEval(`return document.querySelector('[data-testid="team-pending-bar"]').textContent`)).includes('azioni aspettano te'))
  const queueOpened = await clickText('Rivedi tutte', { exact: true }) &&
    await waitDom(`document.querySelector('[data-testid="approvals-queue"]') !== null`, 5_000, 500)
  check('Q2: «Rivedi tutte» apre la coda', queueOpened)
  await shot('2-da-approvare.png')
  // «Consenti per questa missione» NON c'è per i dati tuoi
  const missionButtons = await pageEval(`return document.querySelectorAll('[data-testid="approval-mission"]').length`)
  check('Q2: «Consenti per questa missione» NON c\'è per i dati tuoi', missionButtons === 0, `${missionButtons} bottoni missione`)
  // si decide DALLA CODA: «Consenti una volta»
  check('Q2: si decide dalla coda con «Consenti una volta»', await clickText('Consenti una volta', { exact: true }))
  // il turno di Turismo si sblocca e finisce
  const turismoDone = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(turismo.id)})).some((e) => e.kind === 'send-message')`, 60_000, 500)
  check('Q2: decisa dalla coda, il turno del bot SI SBLOCCA', turismoDone)
  const queueEmpty = await waitDom(`(await window.sandbot.groupPendingApprovals(${group.id})).pending.length === 0`, 30_000, 500)
  check('Q2: la coda si svuota (la card si è chiusa)', queueEmpty)

  // =========== 4. il pannello del team (Q5) e la schermata Autonomia (Q1) ===========
  // B1: idem — anche «Torna alla squadra» deve riportare alla chat della
  // squadra: era un waitDom ignorato, ora è un check
  check('Q5: «Torna alla squadra» riporta alla chat della squadra (composer)', await clickText('Torna alla squadra', { exact: true }) &&
    await waitDom(`document.querySelector('form textarea')`, 5_000))
  await waitQuiet()
  // il pannello del team: il bottone PanelRight da chiuso, ALTRIMENTI la
  // pillola della squadra nella fascia alta lo apre (aria-expanded)
  let panelOk = await clickText('Mostra il pannello dei membri', { exact: false })
  if (!panelOk) {
    panelOk = await pageEval(`
      const pill = document.querySelector('button[aria-expanded="false"]')
      if (!pill) return false
      pill.click()
      return true
    `)
  }
  check('Q5: il pannello del team si apre', panelOk && await waitDom(`document.querySelector('[data-testid="team-overview"]') !== null`, 5_000, 500))
  await sleep(800)
  const overview = await rpc(`groupOverview(${group.id})`)
  const states = Object.fromEntries(overview.members.map((m) => [m.name, m.state]))
  check('Q5: gli stati del team ci sono tutti (Treni coordina, Capo e Turismo membri)', states['Treni'] === 'coordina' && states['Capo'] && states['Turismo'], JSON.stringify(states))
  const counters = overview.members.find((m) => m.name === 'Treni')
  check('Q5: i contatori di Treni (1 file scritto nel turno di squadra)', counters && counters.filesWritten === 1, JSON.stringify(counters))
  const producedTitles = overview.produced.map((p) => p.title).join(' | ')
  check('Q5: «Prodotto dalla squadra» ha la guida e il file', producedTitles.includes('Torino weekend — guida definitiva') && producedTitles.includes('01_treni.md'), producedTitles)
  await shot('1-chat-di-squadra.png')

  await waitQuiet()
  // la schermata Autonomia dal riquadro del team
  check('Q1: il riquadro Autonomia apre la schermata 3', await clickTestid('team-autonomy-open') && await waitDom(`document.querySelector('[data-testid="team-autonomy"]') !== null`, 5_000, 500))
  await sleep(600)
  const autonomyText = (await pageEval(`return document.querySelector('[data-testid="team-autonomy"]')?.textContent ?? ''`)) ?? ''
  check('Q1: le tre voci e le due colonne del disegno', autonomyText.includes('Chiede tutto') && autonomyText.includes('Libera nel computer') && autonomyText.includes('revisore') && autonomyText.includes('Questa colonna non si può svuotare'))
  await shot('3-autonomia.png')
  await clickText('Annulla', { exact: true })
  await sleep(500)

  // =========== 5. il documento si apre dalla Libreria con la squadra aperta (Q6) ===========
  await waitQuiet()
  await clickText('Libreria', { exact: true })
  const libSeen = await waitDom(`document.body.textContent.includes('Torino weekend — guida definitiva')`, 5_000, 500)
  check('Q6: la guida è nella Libreria', libSeen)
  check('Q6: il clic la apre A LATO con la squadra aperta', await clickText('Torino weekend — guida definitiva', { exact: false }) && await waitDom(`document.querySelector('[data-testid="page-view"]') !== null`, 5_000, 500))
  await shot('4-documento-aperto.png')
  // chiude la pagina e torna alla squadra
  await pageEval(`document.querySelector('[data-testid="page-view"] button')?.click(); return true`)
  await sleep(500)
} catch (e) {
  failed++
  log('DEBUG risposte servite:', JSON.stringify(served))
  log('ERRORE FATALE:', e instanceof Error ? e.message : e)
  log('--- coda log app ---\n' + appLog.slice(-3000))
  results.push({ name: 'corsa completa senza errori fatali', ok: false, detail: String(e) })
} finally {
  // ---- pulizia K4: app giù, daemon via, cartelle via, 0 processi ----
  await waitQuiet(60_000).catch(() => undefined)
  // l'app VA GIÙ davvero: un'app occupata può ignorare il SIGTERM e restare
  // a rispawnare il daemon (visto dal vivo) — TERM, grazia, poi KILL, e si
  // chiudono anche i FIGLI Electron della corsa (le porte di debug nostre)
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
  await cleanupProbeRun({ pids: [app.pid], prefix: PREFIX, dirs: [DATA], log, capMs: 20_000 }).catch((e) => log('cleanupProbeRun:', e.message))
  // seconda passata: un daemon lento a morire tiene la cartella — si
  // ripete la chiusura e la rimozione PRIMA del conteggio finale
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
  let left = countProbeDirs(PREFIX, [DATA])
  if (left > 0) {
    // un processo morente può scrivere dopo la prima pulizia: si riprova
    await sleep(1500)
    await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
    left = countProbeDirs(PREFIX, [DATA])
  }
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  if (leftDirs.length > 0) {
    for (const d of leftDirs) {
      const inside = readdirSync(join(TMP_BASE, d)).slice(0, 15)
      log('DEBUG cartella residua:', d, 'contenuto:', JSON.stringify(inside))
    }
  }
  check('pulizia K4: 0 cartelle sandbot-fase-squadra-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  const llamas = (await import('node:child_process').then((c) => c.execSync('pgrep -x llama-server || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean))).filter((pid) => !llamaBaseline.has(pid))
  check('pulizia K4: 0 llama-server nati con la corsa', llamas.length === 0, `baseline ${llamaBaseline.size}, nuovi ${llamas.length}`)
  if (failed > 0) log('risposte servite (diagnostica):', JSON.stringify(served))
  await new Promise((r) => providerServer.close(r))
}

log(`CORSA r${run}: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
