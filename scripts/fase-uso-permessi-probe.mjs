#!/usr/bin/env node
// Sonda della fase uso-permessi (P3 + P4) — dal vivo con la UI come le altre
// sonde: app VERA (out/, serve `npm run build` prima) su dati temporanei,
// modello FINTO openai-compatible su 127.0.0.1 (sceneggiato per turno) e il
// SITO FINTO servito DAVVERO su 127.0.0.1 (pagine che il finto browser MCP
// legge via HTTP: navigazione vera su loopback, mai rete fuori da 127.0.0.1).
//
//   P3  «Consenti sempre su 127.0.0.1» — il sito finto ha la home, le offerte
//       (col loro «Conferma acquisto») e i link che navigano. Il bot apre due
//       pagine (il turno è CONTAMINATO dal contenuto letto) e poi clicca un
//       ref SCADUTO (refMissing): la card offre «Consenti sempre su
//       127.0.0.1»; dopo il clic il grant resta (grantsList), un SECONDO
//       click col ref scaduto NON chiede più, mentre «Conferma acquisto»
//       (commit) chiede come prima — e il rifiuto ferma il clic.
//   P4  l'aiutante col compito d'acquisto si ferma sulla card del «Conferma
//       acquisto»: la card «Aiutante» nel padre mostra «aspetta te» con la
//       frase e «Decidi», il segno della barra segna aspetta-te, «Decidi»
//       apre il centro SU quella richiesta e da lì si rifiuta; l'aiutante
//       consegna e il padre riferisce. Di passaggio: il pannello dell'aiutante
//       mostra il compito come card «Compito affidato da <bot>» (P5), niente
//       XML del brief.
// Catture CDP in docs/catture/fase-uso-permessi/. A fine sonda si chiude
// ANCHE il daemon (pid in daemon.lock) e la cartella temporanea si rimuove.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = process.env.SANDBOT_PROBE_ROOT ?? resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-uso-permessi-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-uso-permessi')
mkdirSync(DATA, { recursive: true })

const log = (...a) => console.log('[sonda uso-permessi]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok: !!ok, note: String(note ?? '') })
  if (!ok) failures++
  log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}

// ---- il SITO FINTO su 127.0.0.1: la prima riga è il titolo, le altre le
// righe dello snapshot; `- link "Nome" [ref=eN] -> /percorso` naviga ----
const siteServer = createServer((req, res) => {
  const path = String((req.url ?? '/').split('?')[0])
  const page =
    path === '/' ? [
      'Biglietti del weekend',
      '- heading "Biglietti del weekend" [ref=e1]',
      '- link "Offerte del weekend" [ref=e2] -> /offerte',
      '- link "Assistenza" [ref=e7]'
    ].join('\n')
      : path === '/offerte' ? [
        'Offerte',
        '- heading "Offerte del weekend" [ref=e1]',
        '- link "Torna alla home" [ref=e2] -> /',
        '- button "Conferma acquisto" [ref=e8]'
      ].join('\n')
        : null
  if (page === null) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(page)
})
await new Promise((r) => siteServer.listen(0, '127.0.0.1', r))
const sitePort = siteServer.address().port
const HOME = `http://127.0.0.1:${sitePort}/`
const OFFERTE = `http://127.0.0.1:${sitePort}/offerte`

// ---- il «modello»: server OpenAI-compatible FINTO (risponde da copione) —
// ogni risposta è marcata per TURNO (un marker nel messaggio utente); il
// FIGLIO si riconosce dal tool wake_parent (come la sonda aiutanti) ----
const chatRequests = []
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const pushTool = (steps, name, args) => steps.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (steps, text) => steps.push({ text })

// turno 1 (P3): apre home e offerte, poi il ref SCADUTO (card), poi il
// SECONDO ref scaduto (grant), poi il commit (card), poi chiude
const T1 = []
pushTool(T1, 'browser_open', { url: HOME })        // attiva il gruppo browser
pushTool(T1, 'browser_open', { url: HOME })        // esegue (nav 1: ref e2)
pushTool(T1, 'browser_open', { url: OFFERTE })     // esegue (nav 2: ref f1e…)
pushTool(T1, 'browser_click', { ref: 'e7' })       // ref SCADUTO (della home) → card (P3)
pushTool(T1, 'browser_click', { ref: 'e5' })       // altro ref scaduto → NESSUNA card (grant)
pushTool(T1, 'browser_click', { ref: 'f1e8' })     // «Conferma acquisto» → card (commit)
pushText(T1, 'Mi fermo qui: l\'acquisto richiede la tua conferma.')

// turno 2 (P4): il padre lancia l'aiutante dell'acquisto
const T2 = []
pushTool(T2, 'spawn_subagent', {
  title: 'Acquisto del biglietto',
  brief: `Obiettivo: aprire la pagina delle offerte del sito di prova (${OFFERTE}) e premere il bottone «Conferma acquisto», fermandosi lì. Confini: nessun altro sito, nessun pagamento vero, nessun file. Risultato: una riga che dice se il clic è stato approvato o rifiutato dall'utente.`
})
pushText(T2, 'Ho lanciato l\'aiutante per l\'acquisto: ti dico com\'è andata.')
pushText(T2, 'L\'aiutante ha finito: il clic è stato rifiutato, nessun acquisto fatto.')

// il FIGLIO: apre le offerte e preme «Conferma acquisto» (card), poi consegna
const CHILD = []
pushTool(CHILD, 'browser_open', { url: OFFERTE })  // attiva il gruppo browser
pushTool(CHILD, 'browser_open', { url: OFFERTE })  // esegue
pushTool(CHILD, 'browser_click', { ref: 'e8' })    // «Conferma acquisto» → card
pushTool(CHILD, 'wake_parent', { summary: 'Il clic «Conferma acquisto» è stato rifiutato dall\'utente.' })
pushText(CHILD, 'Fatto.')

const WAKE = [undefined] // segnaposto: la risposta si aggiunge sotto
const turns = new Map([
  ['compra-biglietti', T1],
  ['lancia-aiutante', T2],
  // il risveglio SUBAGENTS_DONE: l'ultimo messaggio utente è il blocco
  // <risultati_sottoagenti> col summary del figlio
  ['rifiutato dall\'utente.', WAKE]
])
WAKE.pop()
WAKE.push({ text: 'L\'aiutante ha finito: il clic è stato rifiutato, nessun acquisto fatto.' })
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    chatRequests.push(parsed)
    const tools = Array.isArray(parsed.tools) ? parsed.tools.map((t) => t?.function?.name ?? '') : []
    const isChild = tools.includes('wake_parent')
    let steps = null
    if (isChild) steps = CHILD
    else {
      // il marker si cerca nell'ULTIMO messaggio utente (la storia porta
      // ancora i marker dei turni passati)
      const at = body.lastIndexOf('"role":"user"')
      const lastUser = at >= 0 ? body.slice(at, at + 400) : ''
      for (const [marker, list] of turns) if (lastUser.includes(marker)) { steps = list; break }
    }
    const next = (steps ?? []).shift() ?? { text: 'ok' }
    log(`modello: ${isChild ? 'FIGLIO' : 'PADRE'} → ${next.text ? 'testo' : next.toolCalls[0].name}`)
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
const DEBUG_PORT = 9361 + (Number(process.env.SANDBOT_PROBE_RUN ?? '0') % 20)
let appLog = ''
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
    SANDBOT_TEST_FAKE_BROWSER_MCP: join(ROOT, 'scripts', 'fake-browser-mcp.mjs')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
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
process.on('SIGINT', () => { void stopAppAndWait(); process.exit(130) })
process.on('SIGTERM', () => { void stopAppAndWait(); process.exit(143) })

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
    if (await pageEval(`return !!(${exprTrue})`).catch(() => false)) return true
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
const setViewport = async (width, height = 860) => {
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
/** click UI su un bottone/testo (attese dei click UI ≤ 5 s, come da regole) */
const clickText = async (text, { timeoutMs = 5_000 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const nodes = [...document.querySelectorAll('button, [role="menuitem"], [role="button"], a')]
      const t = ${JSON.stringify(text)}
      const b = nodes.find((x) => x.textContent.trim().includes(t) || (x.getAttribute('aria-label') ?? '').includes(t))
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
const approvalsOf = async (agentId) => (await entriesOf(agentId)).filter((e) => e.kind === 'approval')

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
    throw new Error('window.sandbot non disponibile: ' + appLog.slice(-800))
  }
  await setViewport(1280)
  mkdirSync(SHOTS, { recursive: true })

  // ---- la GUIDA del primo avvio (come la sonda aiutanti): al passo Permessi
  // si sceglie «Chiedimi prima» ----
  const click = (testid) => pageEval(`
    const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
    el.click()
    return 'cliccato'
  `)
  if (await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 20_000)) {
    for (let i = 0; i < 12 && !(await waitDom(`!!document.querySelector('form textarea')`, 2500)); i++) {
      if (await pageEval(`return !!document.querySelector('[data-testid="guide-approvals-ask"]')`).catch(() => false)) {
        await click('guide-approvals-ask')
        await sleep(400)
      }
      const hasSkip = await pageEval(`return !!document.querySelector('[data-testid="guide-skip"]')`).catch(() => false)
      const hasCont = await pageEval(`return !document.querySelector('[data-testid="guide-continue"]')?.disabled`).catch(() => false)
      if (hasSkip) await click('guide-skip')
      else if (hasCont) await click('guide-continue')
      else await sleep(600)
    }
  }
  check('setup: la chat si apre (guida percorsa o già fatta)', await waitDom(`!!document.querySelector('form textarea')`, 25_000))

  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await rpc('boxModeSet("host")')

  // =========== P3: «Consenti sempre su 127.0.0.1» ===========
  // l'utente incolla i DUE indirizzi (T5: la pagina profonda si apre perché
  // è nel messaggio) e il marker del turno
  await uiSend(`compra-biglietti: guarda ${HOME} e le offerte ${OFFERTE}, poi prova ad acquistare.`)

  // DEBUG: i tool-result del padre (per capire se il browser MCP parte)
  // la card del ref SCADUTO: approval browser_click pending
  const firstCard = await waitDom(`!!document.querySelector('[data-testid="card-approvazione"]')`, 90_000)
  check('P3: la card del ref scaduto compare (sito interattivo)', firstCard)
  // il menu offre «Consenti sempre su 127.0.0.1» (dominio registrabile
  // dell'IP): il menu di Radix si apre col pointerdown, non col solo click
  const menuOpened = await pageEval(`
    const b = document.querySelector('[data-testid="approval-altre-opzioni"]')
    if (!b) return false
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }))
    b.click()
    return true
  `).catch(() => false)
  const itemSeen = menuOpened && await waitDom(`!!document.querySelector('[data-testid="approval-site-always"]')`, 5_000)
  if (!itemSeen) {
    log('DEBUG trigger presenti:', await pageEval(`return document.querySelectorAll('[data-testid="approval-altre-opzioni"]').length`).catch(() => 'ERR'))
    log('DEBUG card html:', String(await pageEval(`return (document.querySelector('[data-testid="card-approvazione"]') ?? document.body).outerHTML.slice(0, 1500)`).catch((e) => 'ERR ' + e.message)).replace(/\n/g, ' '))
    log('DEBUG menuitems:', await pageEval(`return [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent.trim()).join(' | ')`).catch(() => 'ERR'))
  }
  const itemText = itemSeen ? await pageEval(`return document.querySelector('[data-testid="approval-site-always"]').textContent`) : ''
  check('P3: la card offre «Consenti sempre su 127.0.0.1»', itemSeen && String(itemText).includes('127.0.0.1'),
    `voce: «${String(itemText).trim()}»`)
  await shot('p3-card-consenti-sempre-sito.png')
  const clicked = itemSeen && await pageEval(`
    const b = document.querySelector('[data-testid="approval-site-always"]')
    if (!b) return false
    b.click()
    return true
  `).catch(() => false)
  // il grant è salvato (site:127.0.0.1, del tool virtuale browser-site)
  const grants = clicked ? await rpc('grantsList()').catch(() => []) : []
  check('P3: il clic salva il grant site:127.0.0.1 (browser-site)', clicked &&
    (Array.isArray(grants) ? grants : []).some((g) => g.tool === 'browser-site' && g.target === 'site:127.0.0.1'),
    JSON.stringify((Array.isArray(grants) ? grants : []).map((g) => `${g.tool}:${g.target}`)))

  // il SECONDO ref scaduto NON chiede (grant attivo, turno contaminato dalle
  // pagine lette) — e il modello prosegue fino al click di CONFERMA
  const commitCard = await waitDom(
    `(await window.sandbot.getEntries(${JSON.stringify(bot.id)})).filter((e) => e.kind === 'approval' && e.meta?.status === 'pending' && e.meta?.browserAsk?.kind === 'commit').length > 0`,
    90_000, 400)
  const t1Approvals = await approvalsOf(bot.id)
  check('P3: col grant attivo il secondo ref scaduto NON chiede (una sola card prima del commit)', commitCard && t1Approvals.filter((e) => e.meta?.browserAsk?.kind === 'refMissing' && e.meta?.status === 'allowed').length === 1,
    `card viste: ${t1Approvals.map((e) => `${e.meta?.browserAsk?.kind ?? '?'}:${e.meta?.status}`).join(', ')}`)
  // il click «Conferma acquisto» chiede SEMPRE (commit: mai coperto dal grant)
  check('P3: «Conferma acquisto» chiede comunque (commit)', commitCard)
  await shot('p3-card-conferma-acquisto.png')
  // rifiuto: il clic NON parte e il turno chiude col testo finale
  const denied = await clickText('Rifiuta')
  const t1Closed = await waitDom(
    `(await window.sandbot.getEntries(${JSON.stringify(bot.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('richiede la tua conferma'))`,
    60_000, 400)
  const commitEntry = (await approvalsOf(bot.id)).find((e) => e.meta?.browserAsk?.kind === 'commit')
  check('P3: il rifiuto ferma il «Conferma acquisto» e il turno chiude', denied && t1Closed && commitEntry?.meta?.status === 'denied')

  // =========== P4: l'aiutante che aspetta te ===========
  await uiSend('lancia-aiutante: fai provare l\'acquisto all\'aiutante.')
  const aiutanteCard = await waitDom(`!!document.querySelector('[data-testid="card-aiutante"]')`, 40_000)
  check('P4: la card «Aiutante» compare nella chat del padre', aiutanteCard)

  // il figlio si ferma sulla card del «Conferma acquisto»
  const childId = await (async () => {
    for (let i = 0; i < 80; i++) {
      const subs = await subagentsOf(bot.id)
      const open = subs.find((s) => s.status === 'queued' || s.status === 'running')
      if (open) {
        const es = await entriesOf(open.id)
        if (es.some((e) => e.kind === 'approval' && e.meta?.status === 'pending' && e.meta?.browserAsk?.kind === 'commit')) return open.id
      }
      await sleep(400)
    }
    return null
  })()
  check('P4: l\'aiutante si ferma sulla card del «Conferma acquisto»', childId !== null)

  // la card del padre mostra «aspetta te», la FRASE della richiesta e «Decidi»
  const waitingBlock = await waitDom(`!!document.querySelector('[data-testid="card-aiutante-aspetta-te"]')`, 10_000)
  const waitingText = waitingBlock ? await pageEval(`return document.querySelector('[data-testid="card-aiutante-aspetta-te"]').textContent`) : ''
  check('P4: la card dell\'aiutante mostra «aspetta te» con la frase della richiesta', waitingBlock && waitingText.includes('aspetta te') && waitingText.includes('Conferma acquisto'),
    `testo: «${String(waitingText).trim().slice(0, 120)}»`)
  const decidiThere = await waitDom(`!!document.querySelector('[data-testid="aiutante-decidi"]')`, 5_000)
  check('P4: il bottone «Decidi» è nella card', decidiThere)
  // il segno della barra: la riga del bot PRINCIPALE porta lo stato nel
  // suggerimento della riga (il segno disegnato sta nella rotaia stretta)
  const railWaiting = await waitDom(`[...document.querySelectorAll('aside button[title]')].some((b) => (b.getAttribute('title') ?? '').includes('aspetta te'))`, 5_000)
  check('P4: il segno della barra segna «aspetta te» sulla riga del bot', railWaiting)
  await shot('p4-card-aiutante-aspetta-te.png')

  // «Decidi» apre il centro «Da approvare» SU quella richiesta
  const opened = decidiThere && await pageEval(`
    const b = document.querySelector('[data-testid="aiutante-decidi"]')
    if (!b) return false
    b.click()
    return true
  `)
  const centerThere = opened && await waitDom(`!!document.querySelector('[data-testid="approvals-center-card"]')`, 8_000)
  const centerText = centerThere ? await pageEval(`return document.querySelector('[data-testid="approvals-center-card"]').textContent`) : ''
  check('P4: «Decidi» apre il centro «Da approvare» sulla richiesta dell\'aiutante', centerThere && centerText.includes('Conferma acquisto'),
    `testo centro: «${String(centerText).trim().slice(0, 100)}»`)
  await shot('p4-centro-decidi.png')

  // dal centro si RIFIUTA: l'aiutante riparte, consegna e il padre riferisce
  const deniedFromCenter = centerThere && await (async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await pageEval(`
        const cards = [...document.querySelectorAll('[data-testid="approvals-center-card"]')]
        const c = cards.find((x) => x.textContent.includes('Conferma acquisto'))
        if (!c) return false
        const b = c.querySelector('[data-testid="approval-deny"]')
        if (!b) return false
        b.click()
        return true
      `).catch(() => false)
      if (ok) return true
      await sleep(800)
    }
    return false
  })()
  const childDone = await (async () => {
    for (let i = 0; i < 80; i++) {
      const subs = await subagentsOf(bot.id)
      const me = subs.find((s) => s.id === childId)
      if (me && me.status === 'done') return true
      if (me && ['failed', 'stopped', 'expired', 'stopped-loop'].includes(me.status)) return me.status
      await sleep(400)
    }
    return false
  })()
  check('P4: il rifiuto dal centro sblocca l\'aiutante, che consegna', deniedFromCenter && childDone === true, `esito: ${childDone}`)
  const parentFinal = await waitDom(
    `(await window.sandbot.getEntries(${JSON.stringify(bot.id)})).some((e) => e.kind === 'send-message' && String(e.content).includes('L\\'aiutante ha finito'))`,
    90_000, 400)
  check('P4: il padre riferisce la consegna dell\'aiutante', parentFinal)

  // di passaggio (P5): il pannello dell'aiutante mostra il compito come card
  // «Compito affidato da <bot>», MAI il <brief> grezzo
  const openedPanel = await clickText('Apri')
  const briefCard = openedPanel && await waitDom(`!!document.querySelector('[data-testid="card-compito-affidato"]')`, 8_000)
  const briefText = briefCard ? await pageEval(`return document.querySelector('[data-testid="card-compito-affidato"]').textContent`) : ''
  check('P5 (di passaggio): il pannello dell\'aiutante mostra «Compito affidato da ' + bot.name + '», niente XML', briefCard && briefText.includes('Compito affidato da') && !briefText.includes('<brief'),
    `testo: «${String(briefText).trim().slice(0, 100)}»`)
  await shot('p5-card-compito-affidato.png')

  log(`richieste al modello: ${chatRequests.length}`)
} catch (e) {
  check('la sonda completa il giro senza errori', false, String(e?.message ?? e))
} finally {
  await stopAppAndWait()
  await stopDaemon()
  providerServer.close()
  siteServer.close()
  await sleep(300)
  rmSync(TMP, { recursive: true, force: true })
}

const tot = checks.length
const ok = tot - failures
console.log(`\n[sonda uso-permessi] ${ok}/${tot} check verdi`)
if (failures > 0) {
  console.log('[sonda uso-permessi] FAIL')
  process.exit(1)
}
console.log('[sonda uso-permessi] OK')
