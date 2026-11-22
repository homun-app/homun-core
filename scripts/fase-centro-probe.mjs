#!/usr/bin/env node
// Sonda della fase centro-autorizzazioni — i flussi della spec provati DAL
// VIVO con la UI, come le altre sonde: app VERA (out/, serve `npm run build`
// prima) su dati temporanei, modello FINTO openai-compatible scriptabile su
// 127.0.0.1, CLI `container` FINTA, Portachiavi/SafeStorage FINTI, browser
// MCP FINTO, server MCP «ufficio» FINTO per la bozza. MAI il container vero,
// mai download, rete solo su 127.0.0.1.
//
// Scenario (spec): 2 squadre e 1 bot singolo, con un sottoagente; 5 richieste
// in attesa — dati tuoi (fill della Cassaforte), invio (bozza email), sito
// interattivo ×2 (browser_type con submit), login (fill del sottoagente).
//
// Controlli: la voce «Da approvare» con 5; i gruppi giusti; i filtri; la
// decisione dal centro che sblocca il turno del bot; la card nella chat del
// bot passata a decisa; il riquadro ridotto «+N altrove» in cima (A3 fase
// approvazioni-chiare: la richiesta del bot aperto sta SOPRA il campo);
// «Rimanda»; nessun «approva tutto».
//
// fase approvazioni-chiare — ESTENSIONE: il menu «Altre scelte ▾» del centro
// (A1, le scelte del modello unico), il REGISTRO con le decisioni complete
// (A2), «Consentiti sempre» con Revoca → il gate chiede di nuovo, e la
// richiesta del bot aperto sopra il campo di scrittura (A3).
//
// Catture CDP delle tavole 4 e 5 in docs/catture/fase-centro/; quelle della
// fase approvazioni-chiare (centro col Registro, chat con la richiesta in
// basso) in docs/catture/fase-approvazioni-chiare/. VERDE in TRE corse di
// fila: node scripts/fase-centro-probe.mjs --run 1|2|3. Attese dei click UI
// ≤ 5 s (lezione di fase-squadra). Pulizia K4: 0 cartelle sandbot-fase-centro-*, 0
// daemon della sonda, 0 llama-server nati con la corsa.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const runArg = process.argv.find((a) => /^--?run/.test(a))
const run = runArg ? (Number(runArg.split('=')[1] ?? process.argv[process.argv.indexOf(runArg) + 1]) || 1) : 1
const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-centro'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-centro')
mkdirSync(SHOTS, { recursive: true })
// fase approvazioni-chiare: le catture della fase nuova
const SHOTS2 = join(ROOT, 'docs', 'catture', 'fase-approvazioni-chiare')
mkdirSync(SHOTS2, { recursive: true })
// fase ritocchi-beta18 (R1): le catture della chat con la riga compatta e il
// riquadro, e del «1 di N» con le frecce
const SHOTS3 = join(ROOT, 'docs', 'catture', 'fase-ritocchi-beta18')
mkdirSync(SHOTS3, { recursive: true })

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

// ---- il modello FINTO: risposte a pattern sul body (quando `when` calza).
// `when` può essere una stringa, UNA LISTA (tutte presenti nel body) o una
// FUNZIONE (body, tools) — il FIGLIO si riconosce dai tool (ha wake_parent,
// come la sonda aiutanti: il suo prompt non porta un nome affidabile) ----
const script = []
const matches = (body, tools, when) =>
  typeof when === 'function' ? !!when(body, tools)
  : when == null ? true
  : Array.isArray(when) ? when.every((w) => body.includes(w))
  : body.includes(when)
const sayText = (text, when = null) => script.push({ kind: 'text', text, when })
const callTool = (name, args, when = null) => script.push({ kind: 'tool', name, args, when })
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
      const tools = [...body.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1])
      const idx = script.findIndex((x) => matches(body, tools, x.when))
      const next = idx >= 0 ? script.splice(idx, 1)[0] : { kind: 'text', text: 'ok' }
      const who = /You are (@?[\wÀ-ÿ']+)/.exec(body)?.[1] ?? (tools.includes('wake_parent') ? 'FIGLIO' : '?')
      const lastUser = body.slice(Math.max(0, body.lastIndexOf('"role":"user"')), Math.max(0, body.lastIndexOf('"role":"user"')) + 220).replace(/\n/g, ' ')
      served.push({ res: next.kind === 'tool' ? next.name : `text:${String(next.text).slice(0, 30)}`, who, u: lastUser.slice(0, 130) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
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
const DEBUG_PORT = 9471 + run
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
const setViewport = async (width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const settle = async () => {
  // la finestra in primo piano — coperta, Chromium sospende i rAF e il
  // settle sottile non terminerebbe (falsa lentezza, non dell'app)
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
/** la cattura della fase approvazioni-chiare (cartella della fase) */
const shot2 = async (name) => {
  await settle()
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS2, name), Buffer.from(r.data, 'base64'))
  log('cattura (fase approvazioni-chiare)', name)
}
/** la cattura della fase ritocchi-beta18 (R1) */
const shot3 = async (name) => {
  await settle()
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS3, name), Buffer.from(r.data, 'base64'))
  log('cattura (fase ritocchi-beta18)', name)
}
/** click per testid (attesa ≤ 5 s: è un click UI, la sonda deve essere rossa se la UI rallenta) */
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
/** seleziona un bot nella barra laterale e aspetta il compositore privato.
 * La RIGA può arrivare col refresh coalescente (fino a 10 s per trovarla); la
 * REAZIONE al click — il compositore del bot — resta entro 5 s: se la UI
 * rallenta, la sonda deve essere rossa. */
/** fase barra-sobria: le squadre sono CHIUSE di default — i membri si
 *  aprono dalla chevron, la strada di prodotto, prima di selezionarli */
const openTeamMembers = async (teamName) => {
  const ok = await pageEval(`
    const btns = [...document.querySelectorAll('aside button[aria-label]')]
    const b = btns.find((x) => (x.getAttribute('aria-label') ?? '').includes(${JSON.stringify(`Apri i membri di ${teamName}`)}))
    if (!b) return false
    b.click()
    return true
  `).catch(() => false)
  return ok === true
}
const selectBot = async (name) => {
  const findDeadline = Date.now() + 10_000
  for (;;) {
    const ok = await pageEval(`
      const rows = [...document.querySelectorAll('aside button')]
      const row = rows.find((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))
      if (!row) return 'no-row'
      row.scrollIntoView({ block: 'center' })
      row.click()
      return 'clicked'
    `).catch(() => null)
    if (ok === 'clicked' && await waitDom(`document.querySelector('form textarea') && (document.querySelector('form textarea').placeholder ?? '').includes(${JSON.stringify(name)})`, 5_000)) return true
    if (Date.now() > findDeadline) {
      const asideTexts = await pageEval(`return [...document.querySelectorAll('aside button')].map((b) => b.textContent.trim().slice(0, 40)).slice(0, 20)`).catch(() => '?')
      log('selectBot DEBUG righe aside:', JSON.stringify(asideTexts), 'compositore:', await pageEval(`return document.querySelector('form textarea')?.placeholder ?? null`).catch(() => '?'))
      return false
    }
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
/** aprire un menu Radix (si apre col POINTERDOWN, non col solo click —
 *  lezione di fase uso-permessi) e aspettare le voci */
const openMenu = async (testid, timeoutMs = 5_000) => {
  const opened = await pageEval(`
    const b = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }))
    b.click()
    return true
  `).catch(() => false)
  if (!opened) return false
  return waitDom(`document.querySelectorAll('[role="menuitem"]').length > 0`, timeoutMs)
}
/** aprire il menu Radix della CARD che contiene il testo cercato */
const openMenuInCard = async (cardText, testid, timeoutMs = 5_000) => {
  const opened = await pageEval(`
    const cards = [...document.querySelectorAll('[data-testid="approvals-center-card"]')]
    const card = cards.find((c) => c.textContent.includes(${JSON.stringify(cardText)}))
    const b = card?.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }))
    b.click()
    return true
  `).catch(() => false)
  if (!opened) return false
  return waitDom(`document.querySelectorAll('[role="menuitem"]').length > 0`, timeoutMs)
}

/** cliccare la voce del menu aperto col testid cercato */
const clickMenuItem = (testid) => pageEval(`
  const b = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!b) return false
  b.click()
  return true
`).catch(() => false)

/** click su un bottone dentro la CARD che contiene il testo cercato (per decidere LA richiesta giusta) */
const clickInCard = async (cardText, testid, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const cards = [...document.querySelectorAll('[data-testid="approvals-center-card"]')]
      const card = cards.find((c) => c.textContent.includes(${JSON.stringify(cardText)}))
      if (!card) return false
      const b = card.querySelector('[data-testid=${JSON.stringify(testid)}]')
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

try {
  // ---- setup: provider finto, guida chiusa, i bot, le squadre, l'MCP ufficio ----
  if (!(await waitDom(`typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile: ' + appLog.slice(-800))
  await setViewport(1280, 860)
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
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
  // i coordinatori non hanno riga propria nella barra (stanno nella riga
  // della squadra): per selezionare TUTTI i bot che chiedono, il coordinatore
  // è un bot a parte che non chiede nulla
  const capoWt = await mkBot('Capo Torino', 'Coordina il weekend')
  const capoFm = await mkBot('Capo Fatture', 'Coordina i solleciti')
  const turismo = await mkBot('Turismo', 'Itinerari e musei')
  const alloggio = await mkBot('Alloggio', 'Hotel e disponibilità')
  const archivio = await mkBot('Archivio', 'Documenti delle fatture')
  const solleciti = await mkBot('Solleciti', 'Email di sollecito')
  const ricerche = await mkBot('Ricerche', 'Ricerche online')
  const wt = await rpc(`groupCreate(${JSON.stringify('Weekend Torino')}, ${JSON.stringify([capoWt.id, turismo.id, alloggio.id])}, ${JSON.stringify(capoWt.id)}, ${JSON.stringify('Guida del weekend')})`)
  const fm = await rpc(`groupCreate(${JSON.stringify('Fatture marzo')}, ${JSON.stringify([capoFm.id, archivio.id, solleciti.id])}, ${JSON.stringify(capoFm.id)}, ${JSON.stringify('Contabilità')})`)
  check('setup: le due squadre e il bot singolo', !!wt?.id && !!fm?.id, `${wt?.name}/${fm?.name}`)

  // i login della Cassaforte (modulo del museo e login del sottoagente)
  const museo = await rpc(`vaultSaveLogin(${JSON.stringify({ label: 'Museo Egizio', origins: ['https://spa.example'], username: 'utente-musei', password: 'pwd-musei-8a4b2c' })})`)
  const linkedin = await rpc(`vaultSaveLogin(${JSON.stringify({ label: 'LinkedIn', origins: ['https://spa.example'], username: 'utente-linkedin', password: 'pwd-linkedin-9c1d3e' })})`)

  // il server MCP «ufficio» FINTO: la bozza dell'invio (mai rete vera)
  const mcpCallsFile = join(DATA, 'ufficio-calls.jsonl')
  const serverCfg = { id: 'srv-ufficio', name: 'ufficio', transport: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts', 'fake-ufficio-mcp.mjs'), mcpCallsFile], enabled: true, enabledFor: ['*'] }
  await rpc(`mcpSave(${JSON.stringify(serverCfg)})`)
  const mcpOk = await rpc(`mcpTest('srv-ufficio')`)
  check('setup: il server MCP «ufficio» è collegato (bozze senza rete)', mcpOk?.ok === true && (mcpOk.tools ?? []).some((t) => t.includes('send_email')), JSON.stringify(mcpOk)?.slice(0, 120))
  // come la sonda 0.3.1001: dopo il collegamento si ricarica la pagina perché
  // i tool del server siano offerti al modello
  await page.send('Page.reload')
  if (!(await waitDom(`document.querySelector('aside')`, 25_000))) throw new Error('la pagina non è tornata dopo il reload: ' + appLog.slice(-500))
  // fase barra-sobria: le squadre sono chiuse di default e i turni della
  // sonda passano dai MEMBRI — si aprono dalla chevron (scelta che si ricorda)
  for (const teamName of ['Weekend Torino', 'Fatture marzo']) {
    if (!(await openTeamMembers(teamName))) throw new Error(`apertura membri di ${teamName} non riuscita`)
  }
  if (!(await waitDom(`[...document.querySelectorAll('aside button')].some((b) => b.textContent.trim().startsWith('Turismo'))`, 5_000))) throw new Error('i membri aperti non si vedono')

  // =========== lo script del modello: le 5 richieste ===========
  // 1. Turismo (Weekend Torino): fill_credential col login del museo → i tuoi dati
  const T1 = ['You are Turismo', 'modulo-museo']
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T1)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T1)
  callTool('fill_credential', { id: String(museo.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T1)
  callTool('fill_credential', { id: String(museo.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T1)
  sayText('Modulo del museo compilato col login della Cassaforte.', T1)
  // 2. Alloggio (Weekend Torino): browser_type con submit → sito interattivo
  const T2 = ['You are Alloggio', 'verifica-alloggio']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T2)
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T2)
  callTool('browser_type', { ref: 'e4', text: 'rossi@example.com', submit: true }, T2)
  // 3bis. Alloggio, SECONDA tornata (dopo la Revoca del consenso sempre: il
  // gate deve chiedere di nuovo) — riconosciuta dal messaggio nuovo
  const T2b = ['You are Alloggio', 'verifica-alloggio-2']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T2b)
  callTool('browser_type', { ref: 'e4', text: 'rossi@example.com', submit: true }, T2b)
  // 3. Archivio (Fatture marzo): browser_type con submit sulla pagina della prenota → sito interattivo
  const T3 = ['You are Archivio', 'fatture-archivio']
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T3)
  callTool('browser', { action: 'open', url: 'https://spa.example/prenota' }, T3)
  callTool('browser_type', { ref: 'e4', text: 'Rossi Srl', submit: true }, T3)
  // 4. Solleciti (Fatture marzo): email di sollecito → BOZZA (invio)
  // la bozza NON ferma il turno (si decide dopo): UNA sola chiamata basta
  const T4 = ['You are Solleciti', 'sollecito-rossi']
  callTool('mcp__ufficio__send_email', { to: 'amministrazione@rossisrl.example', subject: 'Fattura 214 scaduta il 28/02', body: 'Gentile Rossi Srl, la fattura 214 è scaduta. Cordialità.' }, T4)
  sayText('Bozza del sollecito pronta: la decidi tu.', T4)
  // 5a. Ricerche (bot singolo): il LOGIN di LinkedIn con la Cassaforte
  const T5 = ['You are Ricerche', 'login-linkedin']
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T5)
  callTool('browser', { action: 'open', url: 'https://spa.example/login' }, T5)
  callTool('fill_credential', { id: String(linkedin.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T5)
  callTool('fill_credential', { id: String(linkedin.id), origin: 'https://spa.example', username_ref: 'e8', password_ref: 'e9' }, T5)
  // 5b. Ricerche lancia anche il SOTTOAGENTE: i figli non hanno il browser (è
  // del padre), il loro run-command chiede comunque all'utente — la sua card
  // dal centro si RIFIUTA (extra: si decide anche la richiesta di un figlio)
  const T6 = ['You are Ricerche', 'compito-figlio']
  callTool('spawn_subagent', { title: 'Controllo fattura', brief: 'Obiettivo: eseguire un comando echo innocuo (compito-figlio) e riferire l\'esito. Confini: nessuna rete, non toccare file fuori dalla cartella temporanea, nessun altro strumento. Risultato: una riga con l\'output del comando.' }, T6)
  sayText('Ho lanciato l\'aiutante per il controllo: ti chiede il permesso.', T6)
  // R1 (fase ritocchi-beta18): l'AIUTANTE di Alloggio — la sua richiesta conta
  // per ALLOGGIO (bot aperto): due richieste dello stesso bot nel riquadro
  // sopra il campo → «1 di 2» con le frecce. Le sue voci stanno PRIMA di
  // quelle del figlio di T6 nell'array (findIndex FIFO) e si riconoscono
  // dal BRIEF («Controllo camera»): il figlio di T6 non le consuma e la
  // voce «Fatto.» di T6 — che quel figlio non consuma mai — non ruba il
  // turno a questo
  const CHILD2 = (body) => body.includes('Controllo camera')
  const T7 = ['You are Alloggio', 'figlio-alloggio']
  callTool('spawn_subagent', { title: 'Controllo camera', brief: 'Obiettivo: eseguire un comando echo innocuo (figlio-alloggio) e riferire l\'esito. Confini: nessuna rete, non toccare file fuori dalla cartella temporanea, nessun altro strumento. Risultato: una riga con l\'output del comando.' }, T7)
  sayText('Ho lanciato l\'aiutante: ti chiede il permesso.', T7)
  callTool('run-command', { command: 'echo controllo-camera' }, CHILD2)
  callTool('wake_parent', { summary: 'Permesso concesso: controllo eseguito.' }, CHILD2)
  sayText('Fatto.', CHILD2)
  const CHILD = (_body, tools) => tools.includes('wake_parent')
  callTool('run-command', { command: 'echo controllo-fattura' }, CHILD)
  callTool('wake_parent', { summary: 'Il comando è stato rifiutato: controllo non eseguito.' }, CHILD)
  sayText('Fatto.', CHILD)

  // ---- i turni: un messaggio privato a ogni bot (il sottoagente parte da solo).
  // Ricerche è ULTIMO: il limite di prodotto è 3 browser per computer e il
  // suo login ne apre un quarto — prima si chiudono i browser FINTI dei due
  // bot la cui card resta comunque in attesa (le card sono entry: vivono
  // anche senza browser; quei due turni non eseguiranno mai l'azione) ----
  const freeBrowserSlots = (keep) => {
    const out = spawnSync('/usr/bin/pgrep', ['-f', 'fake-browser-mcp'], { encoding: 'utf8' })
    const pids = String(out.stdout ?? '').trim().split('\n').filter(Boolean).map(Number).filter((p) => Number.isInteger(p) && p !== process.pid).sort((a, b) => a - b)
    const toKill = keep > 0 ? pids.slice(keep) : pids
    for (const pid of toKill) {
      try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
    }
    return { totale: pids.length, chiusi: toKill.length }
  }
  for (const [bot, msg] of [
    [turismo, 'modulo-museo: compila il modulo del museo (https://spa.example/login) con i miei dati della Cassaforte'],
    [alloggio, 'verifica-alloggio: scrivi la mia email nel modulo di verifica (https://spa.example/prenota) e invialo'],
    [archivio, 'fatture-archivio: scrivi il nome Rossi Srl nel modulo della pagina (https://spa.example/prenota) e invialo'],
    [solleciti, 'sollecito-rossi: manda la email di sollecito a Rossi Srl']
  ]) {
    if (!(await selectBot(bot.name))) throw new Error(`selezione di ${bot.name} non riuscita`)
    await sendMessage(msg)
    await sleep(400)
  }
  // le prime 4 richieste (3 browser + la bozza)...
  const quattro = await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('4')`, 90_000, 500)
  check('le prime 4 richieste nascono (fill, 2 siti, bozza)', quattro,
    (await pageEval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))
  // ...si libera posto per il browser del login (resta vivo quello di Turismo,
  // il primo aperto: la sua card si deciderà davvero)
  const freed = freeBrowserSlots(1)
  log('browser finti chiusi per il login (limite 3 per computer):', JSON.stringify(freed))
  await sleep(1_000)
  // prima il FIGLIO (quel turno finisce in fretta), poi il login (che mette
  // il turno in pausa sulla card: i messaggi dopo resterebbero in coda)
  for (const msg of ['compito-figlio: lancia l\'aiutante per il controllo della fattura', 'login-linkedin: accedi a LinkedIn (https://spa.example/login) col mio login della Cassaforte']) {
    if (!(await selectBot(ricerche.name))) throw new Error('selezione di Ricerche non riuscita')
    await sendMessage(msg)
    await sleep(400)
  }

  // =========== 0. la richiesta del SOTTOAGENTE si rifiuta dal centro ===========
  const six = await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('6')`, 90_000, 500)
  check('le 6 richieste ci sono tutte (5 + quella del sottoagente)', six,
    (await pageEval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))
  check('il centro si apre dalla voce della barra', await clickTestid('sidebar-approvals') &&
    await waitDom(`document.querySelector('[data-testid="approvals-center"]')`, 5_000))
  check('la richiesta del sottoagente mostra il PADRE e «tramite un sottoagente»',
    await waitDom(`[...document.querySelectorAll('[data-testid="approvals-center-card"]')].some((c) => c.textContent.includes('tramite un sottoagente') && c.textContent.includes('Ricerche'))`, 5_000))
  check('si RIFIUTA dal centro la richiesta del sottoagente', await clickInCard('tramite un sottoagente', 'approval-deny'))
  const figlioChiuso = await waitDom(`(await window.sandbot.listSubagents(${JSON.stringify(ricerche.id)})).every((s) => s.status !== 'running')`, 30_000, 500)
  check('rifiutata dal centro, il turno del sottoagente si chiude', figlioChiuso)

  // =========== 1. la voce «Da approvare» con 5 ===========
  const five = await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('5')`, 30_000, 500)
  check('la voce «Da approvare» della barra mostra 5', five,
    (await pageEval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))
  const rows = five ? await rpc(`approvalsPendingAll()`) : []
  if (!five) {
    // diagnostica: cosa è successo nei turni
    for (const [nome, id] of [['Solleciti', solleciti.id], ['Alloggio', alloggio.id], ['Ricerche', ricerche.id]]) {
      const tail = (await rpc(`getEntries(${JSON.stringify(id)})`).catch(() => [])).slice(-16).map((e) => ({ k: e.kind, st: e.meta?.status, c: String(e.content).slice(0, 80) }))
      log('DEBUG entries', nome, JSON.stringify(tail))
    }
    log('DEBUG tool-results Ricerche:', JSON.stringify((await rpc(`getEntries(${JSON.stringify(ricerche.id)})`).catch(() => [])).filter((e) => e.kind === 'tool-result').map((e) => String(e.content).slice(0, 110))))
    const subs = await rpc(`listSubagents(${JSON.stringify(ricerche.id)})`).catch(() => [])
    for (const sub of subs) {
      const tail = (await rpc(`getEntries(${JSON.stringify(sub.id)})`).catch(() => [])).slice(-6).map((e) => ({ k: e.kind, st: e.meta?.status, c: String(e.content).slice(0, 60) }))
      log('DEBUG entries FIGLIO', sub.name ?? sub.id, JSON.stringify(tail))
    }
    const mcpFile = existsSync(mcpCallsFile) ? readFileSync(mcpCallsFile, 'utf8').trim() : '(nessuna chiamata)'
    log('DEBUG chiamate MCP ufficio:', mcpFile.slice(0, 300))
  }
  check('le 5 richieste sono quelle giuste (2 squadre + 1 bot singolo)', rows.length === 5 &&
    rows.filter((r) => r.squad?.id === wt.id).length === 2 &&
    rows.filter((r) => r.squad?.id === fm.id).length === 2 &&
    rows.filter((r) => r.squad === null).length === 1 &&
    rows.filter((r) => r.category === 'dati-tuoi').length === 2 &&
    rows.filter((r) => r.category === 'invio').length === 1 &&
    rows.filter((r) => r.category === 'sito-interattivo').length === 2,
    rows.map((r) => `${r.botName}:${r.category}`).join(','))

  // =========== 6 (prima delle decisioni). il riquadro nella chat principale ===========
  // B1 (fase beta10-correzioni): «Chiudi» deve chiudere DAVVERO il centro e
  // riportare la chat. Prima qui c'era un waitDom il cui risultato veniva
  // ignorato: la beta.10 disegnava il centro per sempre e la cattura 5
  // mostrava il centro al posto della chat
  check('«Chiudi» chiude il centro e torna alla chat (composer visibile)', await clickTestid('approvals-center-close') &&
    await waitDom(`!document.querySelector('[data-testid="approvals-center"]') && !!document.querySelector('form textarea')`, 5_000))
  // B1: dal centro RIAPERTO, il clic su un bot della barra laterale porta alla
  // SUA chat: composer di quel bot e centro assente
  const botViaSidebar = await clickTestid('sidebar-approvals') &&
    await waitDom(`document.querySelector('[data-testid="approvals-center"]')`, 5_000) &&
    await selectBot('Bot') &&
    await waitDom(`!document.querySelector('[data-testid="approvals-center"]') && (document.querySelector('form textarea')?.placeholder ?? '').includes('Bot')`, 5_000)
  check('dal centro aperto, il clic su un bot della barra laterale porta alla sua chat', botViaSidebar)
  // A3 (fase approvazioni-chiare): in cima SOLO il riquadro ridotto «+N
  // altrove» — tutte le richieste sono di ALTRI bot (la chat è del bot Bot)
  const banner = await waitDom(`document.querySelector('[data-testid="approvals-banner"]')`, 10_000)
  const bannerText = banner ? await pageEval(`return document.querySelector('[data-testid="approvals-banner"]').textContent`) : ''
  check('il riquadro in cima alla chat principale è RIDOTTO: «+5 altrove»', banner && bannerText.includes('+5 altrove') && bannerText.includes('Apri'), String(bannerText).slice(0, 160))
  check('la richiesta del bot aperto NON sta nel riquadro in cima (nessun «Decidi»)', banner && (bannerText.match(/Decidi/g) ?? []).length === 0, String(bannerText).slice(0, 200))
  // B1: la cattura 5 è la CHAT col riquadro — il centro non deve esserci nel
  // DOM al momento dello shot
  check('la cattura 5 mostra la chat col riquadro: il centro NON c\'è al momento dello shot', banner && !(await pageEval(`return document.querySelector('[data-testid="approvals-center"]') !== null`).catch(() => true)))
  await shot('5-chat-principale-riquadro.png')

  // =========== 2/3. il centro: gruppi e filtri ===========
  // A3: il riquadro ridotto È il bottone («+N altrove · Apri "Da approvare"»)
  const bannerOpened = await pageEval(`
    const b = document.querySelector('[data-testid="approvals-banner"] button')
    if (!b) return false
    b.click(); return true
  `).catch(() => false)
  check('«Apri «Da approvare»» del riquadro apre il centro', bannerOpened === true &&
    await waitDom(`document.querySelector('[data-testid="approvals-center"]')`, 5_000))
  const centerText = () => pageEval(`return document.querySelector('[data-testid="approvals-center"]').textContent`)
  let text = await centerText()
  check('i gruppi giusti: Weekend Torino · 2, Fatture marzo · 2, Ricerche · 1',
    text.includes('Weekend Torino') && text.includes('team · 2') &&
    text.includes('Fatture marzo') && text.includes('bot · 1') && text.includes('Ricerche'),
    String(text).slice(0, 300))
  check('i filtri con i conteggi: Tutte · 5, I tuoi dati · 2, Invii · 1, Siti · 2',
    text.includes('Tutte · 5') && text.includes('I tuoi dati · 2') && text.includes('Invii · 1') && text.includes('Siti · 2'))
  check('la bozza ha i bottoni di oggi: Invia, Modifica, Rifiuta',
    (await pageEval(`return [...document.querySelectorAll('[data-testid="approvals-center-card"]')].filter((c) => c.textContent.includes('sollecito') || c.textContent.includes('Fattura 214')).map((c) => [...c.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|')).join(' ; ')`)).includes('Invia'))
  await shot('4-da-approvare-centro.png')
  // il filtro «Siti» lascia solo i 2 siti
  check('il filtro «Siti · 2» lascia solo i siti', await clickText('Siti · 2', { exact: true }) &&
    await waitDom(`document.querySelectorAll('[data-testid="approvals-center-card"]').length === 2`, 5_000))
  check('«Tutte · 5» torna tutto', await clickText('Tutte · 5', { exact: true }) &&
    await waitDom(`document.querySelectorAll('[data-testid="approvals-center-card"]').length === 5`, 5_000))

  // =========== A1: il menu «Altre scelte ▾» del centro — le scelte del modello unico ===========
  const menuAperto = await openMenuInCard('Alloggio', 'approval-altre-scelte')
  const menuItems = menuAperto
    ? await pageEval(`return [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim())`)
    : []
  // il submit del modulo NON offre il grant di sito (copre navigazione e clic
  // non di conferma, mai le conferme): turno, sempre a <bot> e — in squadra —
  // la missione, le STESSE scelte della chat (modello unico A1)
  check('A1: «Altre scelte ▾» nel centro apre il menu del modello unico (turno, sempre a <bot>, missione)',
    menuAperto && menuItems.some((x) => x.includes('Per questo turno')) && menuItems.some((x) => x.includes('Consenti sempre a Alloggio')) && menuItems.some((x) => x.includes('Consenti per questa missione')),
    JSON.stringify(menuItems))
  // si chiude senza decidere (il tasto Esc)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => undefined)
  await sleep(400)

  // =========== 8. «Rimanda» (solo la vista: il conteggio resta 5) ===========
  check('«Rimanda» toglie LA richiesta dalla vista', await clickInCard('Archivio', 'approval-snooze') &&
    await waitDom(`![...document.querySelectorAll('[data-testid="approvals-center-card"]')].some((c) => c.textContent.includes('Archivio'))`, 5_000))
  check('«Rimanda» è solo vista: la barra conta ancora 5', await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('5')`, 5_000))

  // =========== 4/5. la decisione dal centro sblocca il turno e chiude la card ===========
  check('si decide dal centro: «Consenti una volta» sulla card di Turismo', await clickInCard('Turismo', 'approval-allow-once'))
  const sbloccato = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(turismo.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('Modulo del museo compilato'))`, 90_000, 500)
  check('la decisione dal centro SBLLOCCA il turno del bot', sbloccato)
  const cardDecisa = await waitDom(`(await window.sandbot.getEntries(${JSON.stringify(turismo.id)})).some((e) => e.meta?.approvalId && e.meta?.status === 'allowed')`, 30_000, 500)
  check('la card nella chat del bot è passata a decisa (allowed)', cardDecisa)
  check('il conteggio della barra scende a 4', await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('4')`, 15_000, 500))

  // =========== A3: la richiesta del bot aperto sta SOPRA il campo di scrittura ===========
  if (!(await selectBot('Alloggio'))) throw new Error('selezione di Alloggio non riuscita')
  const composerBox = await waitDom(`document.querySelector('[data-testid="composer-approval"]')`, 5_000)
  const composerText = composerBox ? await pageEval(`return document.querySelector('[data-testid="composer-approval"]').textContent`) : ''
  check('A3: la richiesta di Alloggio sta nel riquadro SOPRA il campo (frase + Consenti/Rifiuta/Altre scelte)',
    composerBox && composerText.includes('Alloggio') && composerText.includes('vuole') && composerText.includes('Consenti') && composerText.includes('Rifiuta') && composerText.includes('Altre scelte'),
    String(composerText).slice(0, 160))
  // R1 (fase ritocchi-beta18): una richiesta, un posto solo — il difetto
  // della cattura 1 era DUE «Consenti» (card + riquadro) con testi diversi
  const consentiInChat = await pageEval(`return [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Consenti').length`).catch(() => -1)
  check('R1: nella chat del bot UN solo bottone «Consenti» (la card pendente è compatta)', consentiInChat === 1, `${consentiInChat} Consenti`)
  const compatta = await waitDom(`!!document.querySelector('[data-testid="approval-compact-row"]')`, 5_000)
  const compattaText = compatta ? await pageEval(`return document.querySelector('[data-testid="approval-compact-row"]').textContent`) : ''
  check('R1: la riga compatta nei messaggi («In attesa della tua scelta · qui sotto»)',
    compatta && compattaText.includes('In attesa della tua scelta') && compattaText.includes('qui sotto'), String(compattaText).slice(0, 80))
  check('R1: il riquadro NON mostra la stringa grezza dello strumento (caso browser_type con submit)',
    composerBox && !composerText.includes('browser_type') && composerText.includes('vuole usare Azioni nel browser del bot'),
    String(composerText).slice(0, 160))
  check('A3: il campo di scrittura resta usabile, con la richiesta in attesa',
    await waitDom(`!!document.querySelector('form textarea') && !!document.querySelector('[data-testid="composer-approval"]')`, 5_000))
  const bannerAltrove = await pageEval(`return document.querySelector('[data-testid="approvals-banner"]')?.textContent ?? ''`)
  // Archivio è «Rimandata» (solo vista): nel riquadro ridotto contano le
  // ALTRE visibili — Solleciti e Ricerche
  check('A3: in cima solo «+2 altrove» (le altre visibili sono di altri bot)', bannerAltrove.includes('+2 altrove') && !bannerAltrove.includes('modulo di verifica'), bannerAltrove.slice(0, 120))
  await shot2('1-chat-richiesta-sopra-il-campo.png')
  await shot3('1-chat-riga-compatta-e-riquadro.png')

  // =========== A1+A2: «Consenti sempre a Alloggio» DAL CAMPO → la grant, il registro la dice ===========
  // R1: il menu del riquadro è quello del PEZZO UNICO (approval-altre-scelte,
  // le stesse voci della card e del centro)
  const menuComposer = await openMenu('approval-altre-scelte')
  const vociComposer = menuComposer
    ? await pageEval(`return [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim())`)
    : []
  check('A1: il menu del riquadro sopra il campo offre le STESSE scelte (turno, sempre a Alloggio, missione)',
    menuComposer && vociComposer.some((x) => x.includes('Consenti sempre a Alloggio')) && vociComposer.some((x) => x.includes('Per questo turno')) && vociComposer.some((x) => x.includes('Consenti per questa missione')),
    JSON.stringify(vociComposer))
  check('A1: la scelta «sempre» dal riquadro decide (il conteggio scende a 3)', await clickMenuItem('approval-choice-always') &&
    await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('3')`, 30_000, 500))
  const grantsDopo = await rpc(`grantsList()`)
  check('A2: la grant è NATA (Consentiti sempre la conterrà)', (grantsDopo ?? []).length === 1, JSON.stringify(grantsDopo)?.slice(0, 140))

  // =========== A2: il REGISTRO nel centro ===========
  check('A2: il centro si riapre', await clickTestid('sidebar-approvals') &&
    await waitDom(`document.querySelector('[data-testid="approvals-center"]')`, 5_000))
  check('A2: le schede «Richieste | Registro»', await waitDom(`document.querySelector('[data-testid="approvals-tab-registro"]')`, 5_000))
  check('A2: «Registro di oggi» (in fondo alle richieste) apre il Registro', await clickTestid('approvals-open-registro') &&
    await waitDom(`document.querySelector('[data-testid="approvals-registro"]')`, 5_000))
  await sleep(600)
  const registroText = await pageEval(`return document.querySelector('[data-testid="approvals-registro"]')?.textContent ?? ''`)
  check('A2: le decisioni complete — chi, scelta, da dove (Rifiutato dal centro, Consentito sempre dalla chat)',
    registroText.includes('Rifiutato') && registroText.includes('dal centro') && registroText.includes('Consentito sempre') && registroText.includes('dalla chat'),
    registroText.slice(0, 260))
  // i filtri con le righe (come il centro: gli a zero restano nascosti —
  // Scadute e Passate da sole nascono quando succedono, i loro modelli sono
  // nei test)
  check('A2: i filtri del registro (Approvate · N, Rifiutate · 1)',
    registroText.includes('Approvate') && registroText.includes('Rifiutate'),
    registroText.slice(0, 160))
  // «Consentiti sempre» con Revoca
  const grantsSez = await waitDom(`document.querySelector('[data-testid="approvals-registro-grants"]')`, 5_000)
  const grantsText = grantsSez ? await pageEval(`return document.querySelector('[data-testid="approvals-registro-grants"]').textContent`) : ''
  check('A2: «Consentiti sempre» elenca la grant di Alloggio con Revoca',
    grantsSez && grantsText.includes('Alloggio') && grantsText.includes('Revoca'), grantsText.slice(0, 160))
  await shot2('2-centro-registro.png')
  check('A2: Revoca cancella la grant', await clickTestid('grant-revoke') &&
    await waitDom(`(await window.sandbot.grantsList()).length === 0`, 10_000, 500))

  // =========== A2: revocata, il GATE chiede di nuovo — con DUE richieste dello stesso bot ===========
  if (!(await selectBot('Alloggio'))) throw new Error('selezione di Alloggio non riuscita (2)')
  // R1: PRIMA l'aiutante di Alloggio (il suo turno COMPLETA e la richiesta
  // resta in attesa contando per il bot aperto), POI la verifica che si
  // blocca sul submit: due richieste dello stesso bot nel riquadro
  await sendMessage('figlio-alloggio: lancia l\'aiutante per il controllo della camera e aspetta il suo permesso')
  const figliaInAttesa = await waitDom(
    `(await window.sandbot.approvalsPendingAll()).some((r) => r.botId === ${JSON.stringify(alloggio.id)} && r.fromSubagent === true)`,
    90_000, 500)
  check('R1: la richiesta dell\'aiutante di Alloggio è in attesa (conta per il bot aperto)', figliaInAttesa)
  await sendMessage('verifica-alloggio-2: scrivi di nuovo la mia email nel modulo (https://spa.example/prenota) e invialo')
  check('A2: revocata la grant, la STESSA azione torna a chiedere (+ l\'aiutante: conteggio a 5)',
    await waitDom(`(document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? '').includes('5')`, 90_000, 500),
    (await pageEval(`return document.querySelector('[data-testid="sidebar-approvals"]')?.textContent ?? ''`).catch(() => '')))

  // =========== R1: il riquadro «1 di 2» con le frecce; decidere la prima mostra la seconda ===========
  const boxCount = await waitDom(`!!document.querySelector('[data-testid="composer-approval-count"]')`, 10_000)
  const stepText = boxCount ? await pageEval(`return document.querySelector('[data-testid="composer-approval-step"]').textContent`) : ''
  const cardText1 = boxCount ? await pageEval(`return document.querySelector('[data-testid="composer-approval-card"]').textContent`) : ''
  check('R1: due richieste dello stesso bot → «1 di 2» con le frecce, prima la più urgente (l\'aiutante, il più vecchio)',
    boxCount && stepText.includes('1 di 2') && cardText1.includes('tramite un sottoagente') && cardText1.includes('vuole eseguire un comando'),
    `${String(stepText).trim()} · ${String(cardText1).slice(0, 100)}`)
  const consentiDue = await pageEval(`return [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Consenti').length`).catch(() => -1)
  check('R1: con due richieste dello stesso bot resta UN solo «Consenti»', consentiDue === 1, `${consentiDue} Consenti`)
  const compactTwo = await pageEval(`return document.querySelectorAll('[data-testid="approval-compact-row"]').length`).catch(() => -1)
  check('R1: TUTTE le richieste del bot aperto sono righe compatte nei messaggi', compactTwo === 2, `${compactTwo} righe compatte`)
  // la freccia passa alla seconda (il submit del modulo)
  const wentNext = await clickTestid('composer-approval-next')
  const step2 = wentNext && await waitDom(
    `document.querySelector('[data-testid="composer-approval-step"]')?.textContent.includes('2 di 2') && document.querySelector('[data-testid="composer-approval-card"]').textContent.includes('Azioni nel browser del bot')`,
    5_000)
  check('R1: la freccia passa alla seconda (il submit del modulo, senza stringa grezza)', step2)
  await shot3('2-riquadro-1-di-2.png')
  // decidere la PRIMA mostra la SECONDA: si torna alla prima e si consente
  const wentPrev = await clickTestid('composer-approval-prev')
  const step1back = wentPrev && await waitDom(`document.querySelector('[data-testid="composer-approval-step"]')?.textContent.includes('1 di 2')`, 5_000)
  const decidedFirst = step1back && await clickTestid('approval-allow')
  const showsSecond = decidedFirst && await waitDom(
    `!document.querySelector('[data-testid="composer-approval-count"]') && document.querySelector('[data-testid="composer-approval-card"]') !== null && document.querySelector('[data-testid="composer-approval-card"]').textContent.includes('Azioni nel browser del bot')`,
    15_000)
  check('R1: decisa la prima, il riquadro mostra la SECONDA (niente più frecce né «di 2»)', showsSecond)

  // =========== 9. nessun «approva tutto» ===========
  const approveAll = await pageEval(`return [...document.querySelectorAll('button')].filter((b) => /approva tutto|approve all/i.test(b.textContent + ' ' + (b.getAttribute('aria-label') ?? ''))).length`)
  check('NESSUN bottone «approva tutto» nel DOM', approveAll === 0, `${approveAll} trovati`)
} catch (e) {
  failed++
  log('DEBUG risposte servite:', JSON.stringify(served))
  log('ERRORE FATALE:', e instanceof Error ? e.message : e)
  log('--- coda log app ---\n' + appLog.slice(-3000))
  results.push({ name: 'corsa completa senza errori fatali', ok: false, detail: String(e) })
} finally {
  // ---- pulizia K4: app giù, daemon via, cartelle via, 0 processi ----
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
  if (leftDirs.length > 0) {
    for (const d of leftDirs) {
      const inside = readdirSync(join(TMP_BASE, d)).slice(0, 15)
      log('DEBUG cartella residua:', d, 'contenuto:', JSON.stringify(inside))
    }
  }
  check('pulizia K4: 0 cartelle sandbot-fase-centro-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
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
