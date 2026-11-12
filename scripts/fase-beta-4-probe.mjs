#!/usr/bin/env node
// Sonda Electron della fase beta.4 (B1/B2). L'app VERA (build di sviluppo in
// out/) su cartella dati TEMPORANEA, guidata via CDP; il «modello» è un
// provider FINTO openai-compatible su 127.0.0.1 (nessuna rete vera). Copre:
//   B1: la finestra dell'aggiornamento (gancio SANDBOT_TEST_USER_DATA +
//       SANDBOT_TEST_UPDATE_NOTES, senza toccare GitHub) con la fixture VERA
//       delle note beta.3, a 1470×956 e a 1280×720:
//       — i TRE bottoni (Scarica e installa · Apri le note · Più tardi) sono
//         DENTRO la finestra visibile (getBoundingClientRect dentro innerHeight);
//       — l'area delle note SCORRE;
//       — nelle note mostrate non c'è NESSUN «<» (testo semplice, mai HTML);
//   BC1: al giro 1280×720 il clic VERO su «Scarica e installa» (gancio di
//       prova, azioni FINTE): la finestra si CHIUDE e il suo target CDP
//       sparisce dall'elenco delle pagine;
//   B2: «+» → dialogo «Nuovo» (solo nome e aspetto) → Crea → il bot si
//       presenta: col provider finto che risponde con una tool call ask_user,
//       la card della domanda compare nella chat del bot nuovo; alla risposta,
//       il bot (sempre finto) si aggiorna con update_self e la DESCRIZIONE
//       del profilo cambia.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (il controllo condiviso
// probe-daemons, dall'ambiente), la cartella viene rimossa. Mai il Portachiavi
// vero, mai la cartella dati vera (env SANDBOT_TEST_*), niente Docker, rete
// solo su 127.0.0.1, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const PREFIX = 'sandbot-fase-beta-4-'
const TMP = mkdtempSync(`/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/${PREFIX}`)
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'beta-4')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
// la fixture VERA delle note beta.3 (copiata tale e quale nei test) fa da
// corpo della release finta del gancio di prova
const NOTES_FILE = join(TMP, 'release-notes-beta3.html')
copyFileSync(join(ROOT, 'src', 'main', '__tests__', 'fixtures', 'release-notes-beta3.html'), NOTES_FILE)

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
// Le risposte sono uno script in coda: { text } | { toolCalls: [{name, arguments}] }
const script = []
const pushText = (text) => script.push({ text })
const pushTool = (name, arguments_) => script.push({ toolCalls: [{ name, arguments: arguments_ }] })
let providerPort = 0
const chatRequests = []
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      chatRequests.push(JSON.parse(body))
      const next = script.shift() ?? { text: 'ok' }
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
    return
  }
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
providerPort = providerServer.address().port

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9352
let app = null
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
      // B1: il gancio di prova — la finestra dell'offerta con la fixture beta.3
      SANDBOT_TEST_UPDATE_NOTES: NOTES_FILE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }

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
    }),
    close: () => { try { sock.close() } catch { /* già chiusa */ } }
  }
}
/** Aspetta che esista un target pagina (app o finestra offerta) e lo apre. */
async function waitForPage(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const list = await httpJson('/json/list')
      const target = list.find((t) => t.type === 'page' && predicate(t))
      if (target) return await openCdp(target.webSocketDebuggerUrl)
    } catch { /* il debugger non è ancora su */ }
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}
const pageEval = async (page, expr) => {
  const r = await page.send('Runtime.evaluate', {
    expression: `((async () => { ${expr} })())`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
/** Chiamata RPC attraverso il bridge VERO del renderer (window.sandbot). */
const rpc = (page, callExpr) => pageEval(page, `return await window.sandbot.${callExpr}`)
/** Larghezza della finestra APP emulata (il layout del renderer la vede). */
const setAppViewport = async (page, width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const shot = (page, name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
})
const waitDom = async (page, exprTrue, timeoutMs = 30_000, step = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pageEval(page, `return !!(${exprTrue})`).catch(() => false)) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}

/** B1: i controlli sulla finestra dell'offerta, a una data dimensione APP. */
async function probeUpdateWindow(appPage, width, height, tag, clickDownload = false) {
  await setAppViewport(appPage, width, height)
  // la finestra dell'offerta: la pagina data: del gancio di prova
  const offer = await waitForPage((t) => (t.url ?? '').startsWith('data:text/html'))
  if (!offer) {
    check(`B1 ${tag}: la finestra dell'offerta si apre (gancio di prova)`, false, 'nessuna pagina data: nei target')
    return
  }
  check(`B1 ${tag}: la finestra dell'offerta si apre (gancio di prova)`, true)
  await waitDom(offer, `document.getElementById('upd-notes') && document.getElementById('upd-notes').textContent.length > 100`, 15_000)
  const facts = await pageEval(offer, `return (() => {
    const inView = (id) => {
      const el = document.getElementById(id)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { id, top: Math.round(r.top), bottom: Math.round(r.bottom), innerH: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight }
    }
    const notes = document.getElementById('upd-notes')
    const cs = notes ? getComputedStyle(notes) : null
    return {
      buttons: ['upd-download', 'upd-open-notes', 'upd-later'].map(inView),
      notesLen: notes ? notes.textContent.length : 0,
      notesHasLt: notes ? notes.textContent.includes('<') : true,
      scrolls: notes ? notes.scrollHeight > notes.clientHeight : false,
      overflowY: cs ? cs.overflowY : null,
      innerW: window.innerWidth, innerH: window.innerHeight
    }
  })()`)
  const labels = { upd_download: 'Scarica e installa', upd_open_notes: 'Apri le note', upd_later: 'Più tardi' }
  for (const b of facts?.buttons ?? []) {
    check(`B1 ${tag}: bottone «${labels[b.id] ?? b.id}» DENTRO la finestra visibile`,
      b?.visible === true, `top=${b?.top} bottom=${b?.bottom} innerH=${b?.innerH}`)
  }
  check(`B1 ${tag}: l'area delle note SCORRE (contenuto più alto dell'area)`,
    facts?.scrolls === true && ['auto', 'scroll'].includes(facts?.overflowY ?? ''),
    `scrollHeight>clientHeight=${facts?.scrolls} overflow-y=${facts?.overflowY}`)
  check(`B1 ${tag}: nelle note NESSUN «<» (testo semplice, mai HTML)`,
    facts?.notesHasLt === false && (facts?.notesLen ?? 0) > 500, `caratteri=${facts?.notesLen}`)
  check(`B1 ${tag}: la finestra resta AL MASSIMO 460×520 pt`,
    (facts?.innerW ?? 9999) <= 460 && (facts?.innerH ?? 9999) <= 520, `${facts?.innerW}×${facts?.innerH}`)
  await shot(offer, `b1-finestra-aggiornamento-${tag}.png`)
  if (!clickDownload) {
    offer.close()
    return
  }
  // BC1: il clic VERO su «Scarica e installa» col gancio di prova (azioni
  // FINTE: niente download, niente browser) — la finestra si CHIUDE e il suo
  // target CDP sparisce dall'elenco delle pagine
  await pageEval(offer, `document.getElementById('upd-download').click(); return true`)
  check('BC1 clic VERO su «Scarica e installa» (gancio di prova, azioni finte)', true)
  let gone = false
  for (let i = 0; i < 40 && !gone; i++) {
    const list = await httpJson('/json/list').catch(() => [])
    gone = !list.some((t) => t.type === 'page' && (t.url ?? '').startsWith('data:text/html'))
    if (!gone) await sleep(250)
  }
  check('BC1 dopo il clic la finestra dell\'offerta SPARISCE dai target CDP', gone === true)
  try { offer.close() } catch { /* già chiusa col suo target */ }
}

try {
  // ---- giro 1: 1470×956 (finestra app ampia) ----
  app = launchApp()
  let appPage = await waitForPage((t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
  if (!appPage) throw new Error('nessuna pagina app: log:\n' + appLog.slice(-1500))
  log('CDP collegato al renderer (giro 1)')
  if (!(await waitDom(appPage, `typeof window.sandbot !== 'undefined'`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }
  await probeUpdateWindow(appPage, 1470, 956, '1470x956')
  appPage.close()
  stopApp()
  await sleep(1200)
  const d1 = await stopProbeDaemons(PREFIX)
  log(`daemon dopo il giro 1: ${d1.found} trovati, ${d1.closed} chiusi, ${d1.left} rimasti`)

  // ---- giro 2: 1280×720 (finestra app bassa): si RIAPRE l'app ----
  app = launchApp()
  appPage = await waitForPage((t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
  if (!appPage) throw new Error('nessuna pagina app (giro 2): log:\n' + appLog.slice(-1500))
  log('CDP collegato al renderer (giro 2)')
  if (!(await waitDom(appPage, `typeof window.sandbot !== 'undefined'`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s (giro 2)')
  }
  // BC1: al giro basso il clic VERO su «Scarica e installa» (azioni finte)
  await probeUpdateWindow(appPage, 1280, 720, '1280x720', true)

  // ---- B2: un solo «Nuovo», e il bot si presenta (provider finto) ----
  // configurazione: provider finto + models.main (il bot nuovo nasce «Come
  // gli altri» e la presentazione parte)
  await rpc(appPage, `saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  await rpc(appPage, `settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  const agents0 = await rpc(appPage, 'listAgents()')
  const main0 = agents0[0]
  if (!main0) throw new Error('nessun bot (onboarding?)')
  await rpc(appPage, `updateAgent(${JSON.stringify(main0.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)

  // B2a: il «+» apre SUBITO il dialogo «Nuovo», senza menu bot/squadra
  const plusClicked = await pageEval(appPage, `
    const aside = document.querySelector('aside')
    const plus = aside && [...aside.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Crea')
    if (!plus) return { ok: false, why: 'bottone + non trovato' }
    plus.click()
    await new Promise((r) => setTimeout(r, 500))
    return {
      ok: true,
      dialog: !!document.querySelector('[role="dialog"]'),
      menuItems: [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent),
      hasCosaFara: !![...document.querySelectorAll('[role="dialog"] *')].find((x) => x.textContent === 'Cosa farà?'),
      hasTemplateLink: !![...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((x) => x.textContent.includes('Parti da un modello'))
    }
  `)
  check('B2a «+» apre SUBITO il dialogo «Nuovo» (nessun menu bot/squadra)',
    plusClicked?.ok === true && plusClicked?.dialog === true && (plusClicked?.menuItems ?? []).length === 0,
    JSON.stringify(plusClicked))
  check('B2a il dialogo NON ha «Cosa farà?» e ha il link «Parti da un modello»',
    plusClicked?.hasCosaFara === false && plusClicked?.hasTemplateLink === true,
    `cosaFarà=${plusClicked?.hasCosaFara} link=${plusClicked?.hasTemplateLink}`)

  // B2b: nome «Prova» → Crea; la presentazione parte da sola e il provider
  // finto risponde con UNA tool call ask_user
  pushTool('ask_user', {
    prompt: 'Ciao! Sono Prova. Per cosa mi vuoi usare?',
    options: [
      { label: 'Le notizie del mattino', value: 'notizie' },
      { label: 'Le mie email', value: 'email' }
    ],
    allowCustom: true
  })
  const created = await pageEval(appPage, `
    const dlg = document.querySelector('[role="dialog"]')
    if (!dlg) return { ok: false, why: 'dialogo non trovato' }
    const name = dlg.querySelector('#sandbot-new-bot-name')
    if (!name) return { ok: false, why: 'campo nome non trovato' }
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(name, 'Prova')
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    // NB: «Creatura» (la famiglia) inizia per «Crea»: il bottone giusto è
    // quello che dice «Crea » con lo spazio (Crea Prova / Crea il bot)
    const crea = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Crea '))
    if (!crea) return { ok: false, why: 'bottone Crea non trovato' }
    if (crea.disabled) return { ok: false, why: 'Crea DISABILITATO col nome scritto' }
    crea.click()
    return { ok: true }
  `)
  check('B2b nome «Prova» → il bottone Crea è ATTIVO e crea', created?.ok === true, String(created?.why ?? ''))

  // la card della domanda compare nella chat del NUOVO bot
  const cardSeen = await waitDom(appPage,
    `[...document.querySelectorAll('p')].some((p) => p.textContent.includes('Per cosa mi vuoi usare?'))`, 60_000)
  check('B2b la card della domanda (ask_user) compare nella chat del nuovo bot', cardSeen === true)
  check('B2b la presentazione è partita da SOLA (una chiamata al provider finto)',
    chatRequests.length >= 1, `${chatRequests.length} chiamate`)
  const introCall = chatRequests[0]
  const introTexts = (introCall?.messages ?? []).map((m) => String(m.content ?? '')).join('\n')
  check('B2b il turno di presentazione: SOLO ask_user e update_self al modello', (() => {
    const tools = (introCall?.tools ?? []).map((t) => t.function?.name ?? t.name)
    return tools.length === 2 && tools.includes('ask_user') && tools.includes('update_self')
  })(), JSON.stringify((introCall?.tools ?? []).map((t) => t.function?.name ?? t.name)))
  const promptHidden = await pageEval(appPage, `
    return (() => {
      const texts = [...document.querySelectorAll('p, pre, summary')].map((x) => x.textContent)
      return !texts.some((x) => x.includes('You were just created'))
    })()
  `)
  check('B2b il prompt nascosto NON compare in chat (nessun «You were just created» visibile)', promptHidden === true)
  check('B2b il prompt nascosto c\'è per il MODELLO (nel turno partito)', introTexts.includes('You were just created'))
  await shot(appPage, 'b2-presentazione.png')

  // B2c: si risponde (opzione «Le notizie del mattino»); il provider finto
  // risponde con update_self che cambia la descrizione del profilo
  pushTool('update_self', { description: 'Mi sveglio alle 8 con le notizie di tecnologia.' })
  pushText('Perfetto, comincio domattina.')
  const answered = await pageEval(appPage, `
    // il bottone porta anche il quadratino della lettera: A + etichetta
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Le notizie del mattino'))
    if (!btn) return false
    btn.click()
    return true
  `)
  check('B2c risposta data alla card (clic sull\'opzione)', answered === true)

  // la riga di sistema dopo update_self + la descrizione cambiata
  const rowSeen = await waitDom(appPage,
    `[...document.querySelectorAll('p, summary, div')].some((x) => x.textContent.trim().startsWith('Ha aggiornato il suo profilo'))`, 60_000)
  check('B2c la riga di sistema «Ha aggiornato il suo profilo» compare in chat', rowSeen === true)
  let prova = null
  for (let i = 0; i < 40 && !prova; i++) {
    const agents = await rpc(appPage, 'listAgents()')
    prova = agents.find((a) => a.name === 'Prova' && a.description && a.description.includes('notizie'))
    if (!prova) await sleep(500)
  }
  check('B2c update_self ha CAMBIATO la descrizione del profilo', !!prova, prova?.description?.slice(0, 60) ?? 'descrizione invariata')
  await shot(appPage, 'b2-profilo-aggiornato.png')
  await shot(appPage, 'b2-chat-completa.png')
  appPage.close()
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  console.error(appLog.slice(-1200))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  stopApp()
  await sleep(800)
  // 0 daemon a fine sonda (il controllo condiviso, dall'ambiente)
  const { found, closed, left } = await stopProbeDaemons(PREFIX)
  console.log(`daemon di sviluppo: ${found} trovati, ${closed} chiusi, ${left} rimasti`)
  if (left > 0) {
    failures++
    console.error('daemon rimasti:\n' + findProbeDaemons(PREFIX).map((d) => d.line).join('\n'))
  }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  process.exit(failures ? 1 : 0)
}
