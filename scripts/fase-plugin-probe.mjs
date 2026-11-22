#!/usr/bin/env node
// Sonda della fase plugin (tavole 8, 9, 10): la pagina «Plugin» VERA su out/,
// dati temporanei, HOME finta (le skill delle altre app), un server MCP FINTO
// con le annotazioni giuste (scripts/fake-plugin-mcp.mjs) e uno ROTTO per
// «Da sistemare». Controlli: la voce Plugin nella barra; «I tuoi» con la riga
// grigia; il filtro Connettori/Skill; la scheda con Autorizzazioni che cambia
// una regola e la regola che vale; Account e bot con l'interruttore;
// Collegati con «Da sistemare»; Aggiungi › Importa skill; i rimandi vecchi
// che aprono la pagina; V5: il clic sull'interruttore Attivo della riga; V6:
// la scheda offer_enable_plugin in chat, il clic su Attiva e la RIPRESA col
// modello finto. Catture CDP delle tavole in
// docs/catture/fase-plugin/. Nessuna rete fuori da 127.0.0.1, nessun Docker,
// mai i file VERI delle altre app (solo la HOME finta). Verde in 3 corse:
// node scripts/fase-plugin-probe.mjs --run 1|2|3
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'

const ROOT = join(import.meta.dirname, '..')
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-plugin-')
const DATA = join(TMP, 'data')
const FAKE_HOME = join(TMP, 'home')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-plugin')
mkdirSync(SHOTS, { recursive: true })
mkdirSync(DATA, { recursive: true })
mkdirSync(FAKE_HOME, { recursive: true })

const results = []
const log = (...a) => console.log('[fase-plugin]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 220) })
  log(ok ? 'OK ' : 'KO ', name, ok ? '' : '— ' + detail)
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + what)), ms))])

// ---- la HOME finta con le skill delle altre app (MAI i file veri) ----
const skillDir = (app, name, description, valid = true) => {
  const dir = join(FAKE_HOME, `.${app}`, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), valid
    ? `---\nname: ${name}\ndescription: ${description}\n---\n\nLe istruzioni della skill ${name}.\n`
    : `---\nname: ${name}\ndescription: \n---\n\nRotto.\n`)
}
skillDir('claude', 'lavoro', 'Riassume le email di lavoro')
skillDir('zcode', 'lavoro', 'Riassume le email di lavoro') // doppione esatto
skillDir('cursor', 'prezzi', 'Confronta i prezzi tra i siti')
skillDir('codex', 'rotta', '', false) // non valida: si dichiara

// ---- il provider finto: SSE SCRIPTATO (V6: la scheda, il clic, la ripresa) ----
// turni: (1) il modello chiama offer_enable_plugin; (2) chiude il turno con
// una parola all'utente; (3) il turno di RIPRESA dopo il clic su Attiva
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
// il provider risponde GUARDANDO la richiesta (il turno di presentazione del
// bot e le altre chiamate non consumano la sceneggiatura): se l'ultimo
// messaggio utente è la richiesta dell'utente con orion spento e il tool
// c'è → la chiamata a offer_enable_plugin; se è la nota di RIPRESA → la
// parola finale; altrimenti una parola corta.
const modelCounts = { offer: 0, resume: 0, find: 0, other: 0 }
const chatRequests = []
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    chatRequests.push(parsed)
    const tools = Array.isArray(parsed.tools) ? parsed.tools.map((t) => t?.function?.name ?? '') : []
    const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')
    const content = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '')
    let next
    if (content.includes('orion moon ma è spento') && modelCounts.offer === 0 && tools.includes('find_tools') && !tools.includes('offer_enable_plugin')) {
      // i connettori sono DIFFERITI dietro find_tools: prima il gruppo
      modelCounts.find++
      next = { toolCalls: [{ name: 'find_tools', arguments: { group: 'connectors' } }] }
    } else if (content.includes('orion moon ma è spento') && modelCounts.offer === 0 && tools.includes('offer_enable_plugin')) {
      modelCounts.offer++
      next = { toolCalls: [{ name: 'offer_enable_plugin', arguments: { plugin_id: 'srv-orion', reason: 'orion-moon è spento ma serve per la richiesta dell\'utente' } }] }
    } else if (content.includes('orion moon ma è spento') && modelCounts.offer > 0) {
      next = { text: 'Orion Moon è spento: ti ho messo in chat la richiesta di accenderlo — quando clicchi Attiva riparto da solo.' }
    } else if (content.includes('The user turned on')) {
      modelCounts.resume++
      next = { text: 'Ripreso: orion-moon è acceso e i suoi strumenti sono nel mio turno.' }
    } else {
      modelCounts.other++
      next = { text: 'Ok.' }
    }
    log('modello:', next.text ? 'testo' : next.toolCalls[0].name)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunkOf({ role: 'assistant', content: '' }))
    if (next.text) res.write(chunkOf({ content: next.text }))
    for (const [i, tc] of (next.toolCalls ?? []).entries()) {
      res.write(chunkOf({ tool_calls: [{ index: i, id: `call_plugin_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }))
    }
    res.write(chunkOf({}, next.toolCalls ? 'tool_calls' : 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
}
const provider = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) return chatOf(req, res)
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise((r) => provider.listen(0, '127.0.0.1', r))
const providerPort = provider.address().port

// ---- l'app Electron VERA (out/) ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9541 + (Number(process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : '0') % 20)
let appLog = ''
let app = null
const startApp = () => {
  appLog = ''
  const p = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
    cwd: ROOT,
    env: {
      HOME: FAKE_HOME,
      PATH: process.env.PATH,
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  p.stdout.on('data', (d) => { appLog += d.toString() })
  p.stderr.on('data', (d) => { appLog += d.toString() })
  app = p
  return p
}
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
const waitPidGone = async (pid, capMs = 15_000) => {
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  const deadline = Date.now() + capMs
  while (alive()) {
    if (Date.now() > deadline) return false
    await sleep(200)
  }
  return true
}
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
    sock,
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id
      waits.set(mid, { res, rej })
      sock.send(JSON.stringify({ id: mid, method, params }))
    })
  }
}
const waitForPage = async (urlIncludes, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const list = await httpJson('/json/list')
      const target = list.find((t) => t.type === 'page' && (t.url ?? '').includes(urlIncludes) && !(t.url ?? '').includes('/pip/'))
      if (target) return { cdp: await openCdp(target.webSocketDebuggerUrl), url: target.url }
    } catch { /* il debugger non è ancora su */ }
    if (Date.now() > deadline) return null
    await sleep(200)
  }
}
const pageEval = async (cdp, expr) => {
  const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: `((async () => { ${expr} })())`, awaitPromise: true, returnByValue: true }), 30_000, 'Runtime.evaluate')
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = async (cdp, callExpr) => {
  for (let i = 0; i < 8; i++) {
    try {
      return await pageEval(cdp, `if (!window.sandbot) throw new Error('preload non pronto'); return await window.sandbot.${callExpr}`)
    } catch (e) {
      if (i === 7) throw e
      await sleep(700)
    }
  }
}
const waitDom = async (cdp, exprTrue, timeoutMs = 8_000, step = 200) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await pageEval(cdp, `return !!(${exprTrue})`) === true) return true
    } catch { /* si riprova */ }
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
const clickTestid = async (cdp, testid, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(cdp, `
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
      el.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}
/** Il valore di un <select> cambia come farebbe l'utente (React lo vede). */
const setSelect = async (cdp, testid, value) => pageEval(cdp, `
  const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!el) return false
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('change', { bubbles: true })
  )
  return true
`)
const settle = async (cdp) => {
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pageEval(cdp, `await Promise.race([new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) }), new Promise((resolve) => setTimeout(resolve, 1500))])`)
  await sleep(350)
}
const shot = async (cdp, name) => {
  await settle(cdp)
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}

try {
  // difensiva: un residuo di una corsa precedente sulla STESSA porta va via
  // (solo processi del repo con il flag della sonda)
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', `remote-debugging-port=${DEBUG_PORT}`], { encoding: 'utf8' })
    for (const pid of (out.stdout ?? '').split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
    }
  } catch { /* pgrep vuoto */ }
  await sleep(500)
  startApp()
  const main = await waitForPage('', 30_000)
  if (!main) throw new Error('nessuna pagina: ' + appLog.slice(-600))
  const cdp = main.cdp
  log('pagina:', main.url)

  // ---- setup: provider finto, guida chiusa, un bot, i server MCP ----
  await rpc(cdp, `saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  await rpc(cdp, `settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpc(cdp, `settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(cdp, `onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(cdp, `document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(cdp, `document.querySelector('aside')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))
  const bot = await rpc(cdp, `createAgent(${JSON.stringify('Competitoor')}, ${JSON.stringify('tiene d\'occhio i prezzi')})`)
  await rpc(cdp, `updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)

  // il server MCP FINTO con le annotazioni (Sola lettura / Scrittura / Altro
  // / insieme fisso) e uno ROTTO per «Da sistemare»
  const demoCfg = { id: 'srv-plugin', name: 'ufficio-plugin', transport: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts', 'fake-plugin-mcp.mjs')], enabled: true, enabledFor: ['*'] }
  await rpc(cdp, `mcpSave(${JSON.stringify(demoCfg)})`)
  const demoTest = await rpc(cdp, `mcpTest('srv-plugin')`)
  check('setup: il server MCP finto è collegato (5 strumenti, nessuna rete)', demoTest?.ok === true && (demoTest.tools ?? []).length === 5, JSON.stringify(demoTest)?.slice(0, 140))
  const rottoCfg = { id: 'srv-rotto', name: 'rotto', transport: 'stdio', command: '/non/esiste/prog', args: [], enabled: true, enabledFor: ['*'] }
  await rpc(cdp, `mcpSave(${JSON.stringify(rottoCfg)})`)
  const rottoTest = await rpc(cdp, `mcpTest('srv-rotto')`)
  check('setup: il server ROTTO non parte (per «Da sistemare»)', rottoTest?.ok === false, JSON.stringify(rottoTest)?.slice(0, 100))
  await cdp.send('Page.reload')
  if (!(await waitDom(cdp, `document.querySelector('aside')`, 25_000))) throw new Error('la pagina non è tornata dopo il reload: ' + appLog.slice(-500))

  // ---- 1. la voce «Plugin» nella barra apre la pagina (tavola 8) ----
  check('PL1: la voce «Plugin» c\'è nella barra e apre la pagina', await clickTestid(cdp, 'sidebar-plugin') && await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]')`, 5_000))
  check('PL1: titolo, frase e ricerca', await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]')?.textContent?.includes('Plugin')`) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-search"]')`, 5_000))
  const segOk = await waitDom(cdp, `document.querySelector('[data-testid="plugin-segments"]')?.textContent?.includes('Connettori')`) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-segments"]')?.textContent?.includes('Collegati · ')`)
  check('PL1: i segmenti Tutto · Connettori · Skill · Collegati · N', segOk)

  // il menù Aggiungi con le SEI voci
  check('PL1: il bottone Aggiungi apre il menù', await clickTestid(cdp, 'plugin-add') && await waitDom(cdp, `document.querySelector('[data-testid="plugin-add-menu"]') && !document.querySelector('[data-testid="plugin-add-menu"]').className.includes('hidden')`, 5_000))
  const menuText = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-add-menu"]')?.textContent ?? ''`)
  const seiVoci = ['Importa da altre app', 'Server MCP personalizzato', 'Importa skill', 'Crea una skill', 'Crea con il bot', 'Aggiungi un marketplace'].every((v) => menuText.includes(v))
  check('PL1: il menù Aggiungi ha le SEI voci', seiVoci, menuText.slice(0, 120))

  // il menù dell'account NON ha più le tre voci vecchie
  await clickTestid(cdp, 'plugin-add') // chiude
  await clickTestid(cdp, 'account-menu-trigger')
  await waitDom(cdp, `[role="menuitem"]`, 5_000)
  const menuItems = await pageEval(cdp, `return [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim())`)
  check('PL1: il menu dell\'account non ha più Collega app / Skill / Server MCP', !menuItems.some((t) => /Collega app|^Skill$|Server MCP/.test(t)), JSON.stringify(menuItems))
  await pageEval(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  // ---- 2. «I tuoi» con la riga grigia (tavola 8) ----
  check('PL1: «I tuoi» elenca il server MCP con la riga grigia «Server MCP · sul Mac»', await waitDom(cdp, `document.querySelector('[data-testid="plugin-row-server:srv-plugin"]')`, 12_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-gray-server:srv-plugin"]')?.textContent === 'Server MCP · sul Mac'`, 12_000))
  await waitDom(cdp, `document.querySelector('[data-testid="plugin-row-server:srv-rotto"]')`, 12_000)
  const brokenLabel = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-row-server:srv-rotto"]')?.textContent ?? ''`)
  check('PL1: il server rotto dice «non parte · Vedi perché»', brokenLabel.includes('non parte') && brokenLabel.includes('Vedi perché'), brokenLabel.slice(0, 100))

  await shot(cdp, '1-pagina-plugin.png')
  // A4: «Per sviluppatori» in fondo CHIUSO di default — una riga che si apre
  const devClosed = await waitDom(cdp, `document.querySelector('[data-testid="plugin-developers-toggle"]')`, 5_000) && !(await pageEval(cdp, `return document.querySelector('[data-testid="plugin-advanced"]')?.textContent ?? ''`)).includes('Chiave')
  check('A4: «Per sviluppatori» chiuso di default (la riga c\'è, il contenuto no)', devClosed)

  // ---- 3. i filtri Connettori / Skill ----
  const segButtons = await pageEval(cdp, `return [...document.querySelectorAll('[data-testid="plugin-segments"] button')].map((b) => b.textContent.trim())`)
  const btnConnettori = segButtons.find((t) => t === 'Connettori')
  const btnSkill = segButtons.find((t) => t === 'Skill')
  check('PL1: i bottoni dei segmenti', Boolean(btnConnettori && btnSkill), JSON.stringify(segButtons))
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-segments"] button')].find((b) => b.textContent.trim() === 'Connettori')
    btn?.click(); return true
  `)
  check('PL1: il filtro Connettori mostra il catalogo', await waitDom(cdp, `document.querySelector('[data-testid="plugin-connectors"]')`, 5_000))
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-segments"] button')].find((b) => b.textContent.trim() === 'Skill')
    btn?.click(); return true
  `)
  check('PL5: il filtro Skill mostra le righe e il catalogo Sfoglia', await waitDom(cdp, `document.querySelector('[data-testid="plugin-skills"]')`, 5_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-skills-catalog"]')`, 5_000))
  // torna a Tutto per la scheda
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-segments"] button')].find((b) => b.textContent.trim() === 'Tutto')
    btn?.click(); return true
  `)
  await waitDom(cdp, `document.querySelector('[data-testid="plugin-yours"]')`, 5_000)

  // ---- 4. la scheda del plugin: Autorizzazioni che scrive una regola VERA (tavola 9) ----
  check('PL2: il clic sulla riga apre la scheda', await clickTestid(cdp, 'plugin-row-server:srv-plugin', 8_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-card"]')`, 8_000))
  const tabsOk = await waitDom(cdp, `document.querySelector('[data-testid="plugin-card-tabs"]')?.textContent?.includes('Panoramica')`) && await pageEval(cdp, `return document.querySelector('[data-testid="plugin-card-tabs"]')?.textContent ?? ''`).then((t) => t.includes('Autorizzazioni') && t.includes('Account e bot'))
  check('PL2: le schede interne Panoramica · Autorizzazioni · Account e bot', tabsOk)
  // la Panoramica: la strada
  check('PL2: la Panoramica mostra la Strada (sul Mac, il comando)', await waitDom(cdp, `document.querySelector('[data-testid="plugin-overview"]')?.textContent?.includes('Strada')`) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-overview"]')?.textContent?.includes('node')`))
  // la tab Autorizzazioni
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-card-tabs"] button')].find((b) => b.textContent.trim() === 'Autorizzazioni')
    btn?.click(); return true
  `)
  // A4 (fase approvazioni-chiare): l'invio send_email dell'insieme fisso sta
  // nel gruppo SCRITTURA col lucchetto (prima in «Altro»)
  check('PL2: la divisione Sola lettura · 2, Scrittura · 2 (col fisso send_email) e Altro · 1', await waitDom(cdp, `document.querySelector('[data-testid="plugin-permissions"]')?.textContent?.includes('Sola lettura · 2')`, 5_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-permissions"]')?.textContent?.includes('Scrittura · 2')`) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-permissions"]')?.textContent?.includes('Altro · 1')`))
  // A4: le descrizioni senza il prefisso interno [MCP:<nome>]
  const permText = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-permissions"]')?.textContent ?? ''`)
  check('A4: nessun prefisso [MCP:…] nelle descrizioni degli strumenti', !permText.includes('[MCP:'), permText.slice(0, 80))
  const lockOk = await waitDom(cdp, `document.querySelector('[data-testid="plugin-tool-send_email"] svg')`, 5_000)
  const sendOptions = await pageEval(cdp, `return [...(document.querySelector('[data-testid="plugin-tool-send_email"] select')?.options ?? [])].map((o) => o.textContent.trim())`)
  check('PL2: l\'invio è dell\'insieme fisso: lucchetto e NESSUN «Consenti sempre»', lockOk && !sendOptions.includes('Consenti sempre'), JSON.stringify(sendOptions))
  // cambia la regola di search → la regola VERA nelle permissions
  const beforePerms = await rpc(cdp, `getPermissions()`)
  const hadRule = (beforePerms.rules ?? []).some((r) => r.tool === 'mcp__ufficio-plugin__search')
  check('PL2: prima della scelta non c\'è la regola specifica', !hadRule, JSON.stringify((beforePerms.rules ?? []).filter((r) => r.tool.includes('ufficio-plugin'))))
  check('PL2: il selettore cambia a «Consenti sempre»', await setSelect(cdp, 'plugin-tool-select-search', 'always_allow'))
  const afterPerms = await withTimeout((async () => {
    for (let i = 0; i < 20; i++) {
      const p = await rpc(cdp, `getPermissions()`)
      if ((p.rules ?? []).some((r) => r.tool === 'mcp__ufficio-plugin__search' && r.mode === 'always_allow')) return p
      await sleep(300)
    }
    return null
  })(), 8_000, 'regola scritta')
  check('PL2: la regola per strumento è SCRITTA (permissions, mcp__ufficio-plugin__search → always_allow)', afterPerms !== null, JSON.stringify((afterPerms?.rules ?? []).filter((r) => r.tool.includes('ufficio-plugin'))))

  await shot(cdp, '2-scheda-autorizzazioni.png')

  // ---- 5. Account e bot con l'interruttore (enabledFor) ----
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-card-tabs"] button')].find((b) => b.textContent.trim() === 'Account e bot')
    btn?.click(); return true
  `)
  check('PL2: la scheda Account e bot mostra i bot', await waitDom(cdp, `document.querySelector('[data-testid="plugin-accounts"]')?.textContent?.includes('Competitoor')`, 5_000))
  const beforeServers = await rpc(cdp, `connectorsInstalled()`)
  const beforeEnabled = (beforeServers.servers ?? []).find((s) => s.id === 'srv-plugin')?.enabledFor ?? null
  check('PL2: prima dell\'interruttore il server vale per tutti', Array.isArray(beforeEnabled) && beforeEnabled.includes('*'), JSON.stringify(beforeEnabled))
  // da «Tutti i bot» il singolo è DISATTIVATO (come i fogli di oggi): prima
  // si spegne «Tutti i bot», poi si accende il bot scelto
  await pageEval(cdp, `
    const all = [...document.querySelectorAll('[data-testid="plugin-accounts"] [role="switch"]')].find((b) => b.getAttribute('aria-label') === 'Tutti i bot')
    all?.click(); return true
  `)
  const allOff = await withTimeout((async () => {
    for (let i = 0; i < 20; i++) {
      const r = await rpc(cdp, `connectorsInstalled()`)
      const e = (r.servers ?? []).find((s) => s.id === 'srv-plugin')?.enabledFor
      if (Array.isArray(e) && !e.includes('*')) return r
      await sleep(300)
    }
    return null
  })(), 8_000, 'tutti-i-bot spento')
  // il click vale quando l'interruttore del bot si è ATTIVATO (la UI ha
  // recepito il cambio: da «tutti» i singoli sono spenti ma cliccabili)
  check('PL2: spento «Tutti i bot», il singolo bot è cliccabile', await waitDom(cdp, `(() => { const b = [...document.querySelectorAll('[data-testid="plugin-accounts"] [role="switch"]')].find((x) => x.getAttribute('aria-label') === 'Competitoor'); return !!b && !b.disabled && b.getAttribute('aria-checked') === 'false' })()`, 8_000))
  await pageEval(cdp, `
    const row = [...document.querySelectorAll('[data-testid="plugin-accounts"] [role="switch"]')].find((b) => b.getAttribute('aria-label') === 'Competitoor')
    row?.click(); return true
  `)
  const afterServers = await withTimeout((async () => {
    for (let i = 0; i < 20; i++) {
      const r = await rpc(cdp, `connectorsInstalled()`)
      const e = (r.servers ?? []).find((s) => s.id === 'srv-plugin')?.enabledFor
      if (Array.isArray(e) && e.length === 1 && e[0] === bot.id) return r
      await sleep(300)
    }
    return null
  })(), 8_000, 'enabledFor cambiato')
  const afterEnabled = afterServers ? (afterServers.servers ?? []).find((s) => s.id === 'srv-plugin')?.enabledFor : null
  check('PL2: l\'interruttore per bot cambia enabledFor (solo il bot scelto)', afterServers !== null && Array.isArray(afterEnabled) && afterEnabled.join(',') === bot.id, JSON.stringify(afterEnabled))
  // chiudi la scheda
  await pageEval(cdp, `document.querySelector('[data-testid="plugin-card"] button[aria-label*="Torna"]')?.click(); return true`)

  // ---- 6. Collegati con «Da sistemare» (tavola 10) ----
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-segments"] button')].find((b) => b.textContent.includes('Collegati'))
    btn?.click(); return true
  `)
  check('PL3: la TABELLA Collegati con le sue colonne', await waitDom(cdp, `document.querySelector('[data-testid="plugin-connected-table"]')`, 5_000) && await waitDom(cdp, `document.querySelector('[data-testid="plugin-connected-table"] thead')?.textContent?.includes('Ultimo uso')`))
  check('PL3: «Da sistemare · 1» (il server rotto)', await waitDom(cdp, `document.querySelector('[data-testid="plugin-connected-filters"]')?.textContent?.includes('Da sistemare · 1')`, 5_000))
  const rowRotto = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-connected-row-server:srv-rotto"]')?.textContent ?? ''`)
  check('PL3: la riga del rotto dice «non parte» con il suo comando', rowRotto.includes('non parte') && rowRotto.includes('/non/esiste/prog'), rowRotto.slice(0, 120))
  // il filtro «Da sistemare» lascia SOLO il rotto
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-connected-filters"] button')].find((b) => b.textContent.includes('Da sistemare'))
    btn?.click(); return true
  `)
  const onlyBroken = await pageEval(cdp, `return [...document.querySelectorAll('[data-testid^="plugin-connected-row-"]')].map((r) => r.getAttribute('data-testid'))`)
  check('PL3: il filtro «Da sistemare» lascia solo il rotto', Array.isArray(onlyBroken) && onlyBroken.length === 1 && onlyBroken[0] === 'plugin-connected-row-server:srv-rotto', JSON.stringify(onlyBroken))

  await shot(cdp, '3-collegati.png')

  // ---- 7. Aggiungi › Importa skill (le cartelle della HOME finta) ----
  await clickTestid(cdp, 'plugin-add')
  check('PL6: Aggiungi › Importa skill apre il foglio e avvia la scansione', await clickTestid(cdp, 'plugin-add-skill-import') && await waitDom(cdp, `document.querySelector('[data-testid="plugin-skill-import"]')`, 5_000))
  const importText = await withTimeout((async () => {
    for (let i = 0; i < 20; i++) {
      const t = await pageEval(cdp, `return document.querySelector('[data-testid="plugin-skill-import"]')?.textContent ?? ''`)
      if (t.includes('lavoro') || t.includes('Nessuna skill')) return t
      await sleep(300)
    }
    return ''
  })(), 8_000, 'scansione skill')
  check('PL6: la scansione trova le skill della HOME finta (lavoro, prezzi; rotta non valida)', importText.includes('lavoro') && importText.includes('prezzi') && importText.includes('rotta'), importText.slice(0, 140))
  check('PL6: il doppione è UNITO (lavoro: claude, zcode) e «già presente» non c\'è prima dell\'import', importText.includes('claude, zcode'), importText.slice(0, 200))
  // spunta lavoro e importa (COPIA)
  await pageEval(cdp, `
    const row = [...document.querySelectorAll('[data-testid="plugin-skill-import-row"]')].find((r) => r.textContent.includes('lavoro'))
    const cb = row?.querySelector('input[type="checkbox"]')
    if (cb) { cb.click() }
    return !!cb
  `)
  check('PL6: il bottone Importa applica la copia e torna alle skill', await clickTestid(cdp, 'plugin-skill-import-apply') && await waitDom(cdp, `document.querySelector('[data-testid="plugin-skills"]')`, 5_000))
  const skillRow = await withTimeout((async () => {
    for (let i = 0; i < 20; i++) {
      const t = await pageEval(cdp, `return [...document.querySelectorAll('[data-testid^="plugin-row-skill:"]')].map((r) => r.textContent).join('\\n')`)
      if (t.includes('importata da')) return t
      await sleep(300)
    }
    return ''
  })(), 8_000, 'skill importata')
  check('PL6: la skill importata è in pagina con la riga grigia «Skill · importata da Claude Code»', skillRow.includes('importata da Claude Code'), skillRow.slice(0, 140))

  // ---- 8. i rimandi vecchi aprono la pagina: Impostazioni › App e skill ----
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('[data-testid="plugin-segments"] button')].find((b) => b.textContent.trim() === 'Tutto')
    btn?.click(); return true
  `)
  await pageEval(cdp, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await clickTestid(cdp, 'account-menu-trigger')
  await waitDom(cdp, `[role="menuitem"]`, 5_000)
  await pageEval(cdp, `
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === 'Impostazioni')
    item?.click(); return true
  `)
  await waitDom(cdp, `document.querySelector('[role="dialog"]')`, 5_000)
  // la scheda App e skill delle Impostazioni
  const opened = await pageEval(cdp, `
    const tab = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="tab"]')].find((b) => /App e skill/.test(b.textContent ?? ''))
    tab?.click(); return !!tab
  `)
  check('PL7: Impostazioni ha la scheda App e skill', opened)
  check('PL7: il rimando apre la pagina Plugin (una casa sola)', await clickTestid(cdp, 'settings-open-plugin') && await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]')`, 5_000))

  // ---- 9. V5: l'interruttore Attivo della riga (clic vero sul DOM vivo) ----
  await waitDom(cdp, `document.querySelector('[data-testid="plugin-active-server:srv-plugin"]')`, 8_000)
  const switchState = () => pageEval(cdp, `return document.querySelector('[data-testid="plugin-active-server:srv-plugin"]')?.getAttribute('aria-checked')`)
  check('V5: l\'interruttore Attivo c\'è nella riga ed è ACCESO', (await switchState()) === 'true')
  await clickTestid(cdp, 'plugin-active-server:srv-plugin')
  const offNow = await withTimeout((async () => {
    for (let i = 0; i < 20; i++) {
      const r = await rpc(cdp, `connectorsInstalled()`)
      const sv = (r.servers ?? []).find((x) => x.id === 'srv-plugin')
      if (sv && sv.enabled === false && sv.disabledReason === 'user') return sv
      await sleep(300)
    }
    return null
  })(), 8_000, 'interruttore spento')
  check('V5: il clic SPEGNE: enabled false e disabledReason \'user\' (la parola dell\'utente)', offNow !== null, JSON.stringify(offNow)?.slice(0, 120))
  await clickTestid(cdp, 'plugin-active-server:srv-plugin')
  const onAgain = await withTimeout((async () => {
    for (let i = 0; i < 25; i++) {
      const r = await rpc(cdp, `connectorsInstalled()`)
      const sv = (r.servers ?? []).find((x) => x.id === 'srv-plugin')
      if (sv && sv.enabled === true) return sv
      await sleep(300)
    }
    return null
  })(), 10_000, 'interruttore riacceso')
  check('V5: il clic RIACCENDE (e il test U5 parte da mcp:save: il finto risponde)', onAgain !== null && (await switchState()) === 'true', JSON.stringify(onAgain)?.slice(0, 120))

  // ---- 10. V6: la scheda offer_enable_plugin, il clic e la RIPRESA ----
  // un secondo server MCP FINTO ma SPENTO (l\'utente l\'aveva spento): il
  // blocco «Collegamenti ora» lo dice al bot, che propone la scheda
  const orionCfg = { id: 'srv-orion', name: 'orion-moon', transport: 'stdio', command: process.execPath, args: [join(ROOT, 'scripts', 'fake-plugin-mcp.mjs')], enabled: false, disabledReason: 'user', enabledFor: ['*'] }
  await rpc(cdp, `mcpSave(${JSON.stringify(orionCfg)})`)
  // la chat del bot: il primo agente della barra laterale
  await pageEval(cdp, `
    const btn = [...document.querySelectorAll('aside button, aside [role="button"]')].find((b) => (b.textContent ?? '').trim().startsWith('Competitoor'))
    btn?.click(); return !!btn
  `)
  if (!(await waitDom(cdp, `document.querySelector('form textarea')`, 8_000))) throw new Error('la chat non si è aperta: ' + appLog.slice(-400))
  const userMsg = 'vedo che c\'è orion moon ma è spento: vuoi accenderlo? mi serve per la mia richiesta'
  await pageEval(cdp, `
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(userMsg).replace(/`/g, '\\`')})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return true
  `)
  const cardCame = await waitDom(cdp, `document.querySelector('[data-testid="enable-plugin-card"]')`, 25_000)
  check('V6: la scheda compare in chat (logo, nome, riga grigia PL1, frase del bot, Attiva / Non ora)', cardCame)
  if (cardCame) {
    const cardText = await pageEval(cdp, `return document.querySelector('[data-testid="enable-plugin-card"]')?.textContent ?? ''`)
    check('V6: la scheda dice chi è (orion-moon), la riga grigia e la frase del bot', cardText.includes('orion-moon') && cardText.includes('Server MCP ·') && cardText.includes('spento ma serve'), cardText.slice(0, 160))
    await shot(cdp, '4-scheda-attiva-plugin.png')
    // il clic su Attiva: accende, testa e la RIPRESA arriva (turno nuovo col modello finto)
    await clickTestid(cdp, 'enable-plugin-activate')
    const activated = await waitDom(cdp, `document.querySelector('[data-testid="enable-plugin-active"]')`, 25_000)
    const activeText = activated ? await pageEval(cdp, `return document.querySelector('[data-testid="enable-plugin-active"]')?.textContent ?? ''`) : ''
    check('V6: «Attiva» accende e testa: la scheda dice «Attivo · 5 strumenti»', activated && /5/.test(activeText), activeText)
    const orionAfter = await withTimeout((async () => {
      for (let i = 0; i < 20; i++) {
        const r = await rpc(cdp, `connectorsInstalled()`)
        const sv = (r.servers ?? []).find((x) => x.id === 'srv-orion')
        if (sv && sv.enabled === true) return sv
        await sleep(300)
      }
      return null
    })(), 8_000, 'orion riacceso')
    check('V6: orion-moon è ACCESO (enabled true, senza motivo: l\'ha deciso il clic)', orionAfter !== null && orionAfter.disabledReason === undefined, JSON.stringify(orionAfter)?.slice(0, 120))
    const resumed = await waitDom(cdp, `document.body.textContent.includes('Ripreso: orion-moon è acceso')`, 25_000)
    const resumeRow = await waitDom(cdp, `document.body.textContent.includes('Plugin attivato')`, 10_000)
    check('V6: la RIPRESA arriva: il turno nuovo (riga «Plugin attivato») e la risposta del modello', resumed && resumeRow)
    // una ripresa sola: UNA chiamata offer, UNA ripresa, nessuna catena
    check('V6: il modello ha fatto UNA offerta e UNA ripresa (nessuna catena automatica)', modelCounts.offer === 1 && modelCounts.resume === 1, JSON.stringify(modelCounts))
  }

  // ---- pulizia ----
  stopApp()
  if (Number.isInteger(app?.pid)) await waitPidGone(app.pid)
  const { stopProbeDaemons } = await import('./lib/probe-daemons.mjs')
  const { cleanupProbeRun, countProbeDirs } = await import('./lib/probe-rm.mjs')
  await stopProbeDaemons('sandbot-fase-plugin', { log: () => undefined }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: 'sandbot-fase-plugin', dirs: [TMP], log: () => undefined, capMs: 20_000 }).catch((e) => log('pulizia:', e.message))
  await stopProbeDaemons('sandbot-fase-plugin', { log: () => undefined }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: 'sandbot-fase-plugin', dirs: [], log: () => undefined, capMs: 10_000 }).catch(() => undefined)
  const left = countProbeDirs('sandbot-fase-plugin', [TMP])
  check('pulizia: 0 cartelle sandbot-fase-plugin-* rimaste', left === 0, `rimaste ${left}`)
  const daemons = await import('./lib/probe-daemons.mjs').then((m) => m.findProbeDaemons('sandbot-fase-plugin'))
  check('pulizia: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  provider.close()
} catch (e) {
  log('FATAL:', e.message)
  log(appLog.slice(-1200))
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: e.message })
  stopApp()
  try {
    const { stopProbeDaemons } = await import('./lib/probe-daemons.mjs')
    const { cleanupProbeRun } = await import('./lib/probe-rm.mjs')
    await stopProbeDaemons('sandbot-fase-plugin', { log: () => undefined }).catch(() => undefined)
    await cleanupProbeRun({ pids: [], prefix: 'sandbot-fase-plugin', dirs: [TMP], log: () => undefined }).catch(() => undefined)
  } catch { /* già in corsa */ }
  provider.close()
}

const ok = results.filter((r) => r.ok).length
log(`CORSA fase-plugin: ${ok}/${results.length} controlli OK`)
if (results.some((r) => !r.ok)) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
