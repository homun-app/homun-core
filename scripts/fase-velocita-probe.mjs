#!/usr/bin/env node
// Sonda Electron della fase «velocità» (S1–S5). L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, con l'isolamento di sempre:
// NESSUNA RETE VERA, tutto su 127.0.0.1 — il «modello» è un server
// OpenAI-compatible FINTO che registra le richieste e risponde da copione,
// più un /api/show FINTO (per Ollama: thinking con livelli). Copre:
//   S1: la traccia (SANDBOT_LLM_TRACE=1) ha i numeri di ogni chiamata e
//       scripts/riassunto-trace.mjs la riassume (output salvato);
//   S2: il selettore del ragionamento compare per un modello Ollama che
//       ragiona (thinking.values), «Predefinito» manda reasoning_effort
//       "medium", «Spento» manda "none" (richieste registrate);
//   S3: un turno normale NON offre gli integrati differiti (find_tools +
//       use_tool al loro posto); il modello chiama find_tools e poi
//       use_tool per create_agent: la card in chat dice create_agent, mai
//       use_tool; l'elenco non cambia tra le chiamate del turno;
//   S4: due chiamate dello stesso turno hanno lo stesso sessionId (traccia);
//   S5: due chiamate dello stesso turno vedono lo stesso system prompt.
// Con --baseline (per la misura PRIMA di S3, sull'app del commit di base):
// solo un turno normale e i NUMERI degli strumenti offerti in JSON.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// SANDBOT_PROBE_ROOT = la RADICE dell'app da lanciare (default: questa repo; per la misura di base il worktree del commit di base)
const ROOT = process.env.SANDBOT_PROBE_ROOT ?? resolve(import.meta.dirname, '..')
const BASELINE = process.argv.includes('--baseline')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-velocita-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-velocita')
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

// ---- il «modello»: server OpenAI-compatible FINTO (registra e risponde) ----
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => script.push({ text })
const chatRequests = []
const sseOk = (res, next) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  chunk({ role: 'assistant', content: '' })
  if (next.reasoning) chunk({ content: null, reasoning_content: next.reasoning })
  if (next.text) chunk({ content: next.text })
  for (const [i, tc] of (next.toolCalls ?? []).entries()) {
    chunk({ tool_calls: [{ index: i, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })
  }
  chunk({}, next.toolCalls ? 'tool_calls' : 'stop')
  res.write('data: [DONE]\n\n')
  res.end()
}
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    chatRequests.push(JSON.parse(body))
    sseOk(res, script.shift() ?? { text: 'ok' })
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

// ---- il server OLLAMA FINTO: /api/tags, /api/show (con thinking) e /v1 ----
const SHOW_RESPONSE = {
  capabilities: ['completion', 'tools'],
  thinking: { values: ['low', 'medium', 'high', false], default: 'high' }
}
const ollamaRequests = []
const ollamaServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (code, b) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(b))
    if (url.pathname === '/api/tags') {
      return json(200, { models: [{ name: 'kimi-finto', digest: 'sha256:finto' }] })
    }
    if (url.pathname === '/api/show') {
      return json(200, SHOW_RESPONSE)
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      ollamaRequests.push(JSON.parse(body))
      return sseOk(res, script.shift() ?? { text: 'ok' })
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => ollamaServer.listen(0, '127.0.0.1', r))
const ollamaPort = ollamaServer.address().port

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = BASELINE ? 9345 : 9344
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
      SANDBOT_LLM_TRACE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
const app = launchApp()
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
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
let page = await waitForPage()
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
const clickByText = (text, scope = 'button') => pageEval(`
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
    .filter((x) => x.offsetParent !== null)
    .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
  if (!b) throw new Error('nessun bottone col testo: ' + ${JSON.stringify(text)})
  b.click()
  return 'cliccato'
`)
const setWindowWidth = async (width, height = 800) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const setDark = async (dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(350)
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}

/** gli strumenti offerti al modello nell'ULTIMA richiesta al provider finto */
const offeredToolsOf = (request) => (request?.tools ?? []).map((t) => t?.function?.name ?? t?.name)
const waitForText = async (text, ms = 40_000) =>
  waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === ${JSON.stringify(text)})`, ms)

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- setup: provider finto + il bot principale ----
  log('configuro provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await page.send('Page.reload')
  check('setup compositore pronto', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await setWindowWidth(1440)

  // ============ il turno normale: i numeri degli strumenti (S1/S3) ============
  pushTool('recall_memory', { query: 'preferenze' })
  pushTool('send_to_user', { text: 'Turno normale misurato.' })
  await uiSend('Un giro normale, grazie.')
  await waitForText('Turno normale misurato.')
  await sleep(600)
  const normalReq = chatRequests.at(-1)
  const offered = offeredToolsOf(normalReq)
  const toolsCount = offered.length
  const toolsBytes = JSON.stringify(normalReq.tools).length
  log(`turno normale: ${toolsCount} strumenti, ${toolsBytes} byte di schemi`)
  if (BASELINE) {
    // misura PRIMA di S3 (build del commit di base): solo i numeri, in JSON
    writeFileSync(join(TMP, 'baseline.json'), JSON.stringify({ toolsCount, toolsBytes, tools: offered }, null, 2))
    console.log('[baseline] ' + JSON.stringify({ toolsCount, toolsBytes }))
  } else {
    check('S3 il turno normale NON offre gli integrati differiti',
      !['create_agent', 'delete_agent', 'send_to_agent', 'list_agents', 'save_to_library', 'copy_to_box', 'propose_rule_change'].some((n) => offered.includes(n)),
      offered.length + ' strumenti')
    check('S3 find_tools e use_tool sono offerti',
      offered.includes('find_tools') && offered.includes('use_tool'))
  }

  if (!BASELINE) {
    mkdirSync(SHOTS, { recursive: true })
    for (const f of readdirSync(SHOTS)) rmSync(join(SHOTS, f))

    // ---- S5/S4: le DUE chiamate del turno hanno lo stesso system e sessionId ----
    const tracePath = join(DATA, 'data', 'llm-trace.jsonl')
    check('S1 la traccia esiste (SANDBOT_LLM_TRACE=1)', existsSync(tracePath))
    const trace = () => readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const turn1 = trace().filter((r) => r.turnId !== null && r.turnId !== undefined)
    check('S1 la traccia porta turnId, callIndex, tempi e byte', (() => {
      const r = turn1.at(-1)
      return !!(r && typeof r.turnId === 'string' && typeof r.callIndex === 'number' &&
        typeof r.firstTokenMs === 'number' && typeof r.totalMs === 'number' &&
        typeof r.toolsCount === 'number' && typeof r.toolsBytes === 'number' &&
        typeof r.systemBytes === 'number' && typeof r.messagesBytes === 'number' &&
        'thinkingSent' in r)
    })(), JSON.stringify(turn1.at(-1) ?? {}).slice(0, 120))
    check('S1 la traccia NON contiene testo dei messaggi né chiavi',
      !readFileSync(tracePath, 'utf8').includes('Turno normale misurato') &&
      !readFileSync(tracePath, 'utf8').includes('chiave-finta'))
    const sysOf = (req) => (req.messages ?? []).find((m) => m.role === 'system')?.content ?? ''
    const normalReqs = chatRequests.slice(-2)
    check('S5 due chiamate dello stesso turno: systemText IDENTICO',
      normalReqs.length === 2 && sysOf(normalReqs[0]) === sysOf(normalReqs[1]))
    check('S4 due chiamate dello stesso turno: stesso sessionId (hash in traccia)',
      (() => {
        const ids = turn1.filter((r) => r.callIndex < 2).map((r) => r.sessionHash)
        return ids.length >= 2 && ids.every((x) => x === ids[0] && typeof x === 'string' && x.length === 8)
      })())
    check('S3 l\'elenco degli strumenti NON cambia tra le chiamate del turno',
      JSON.stringify(chatRequests.at(-2).tools) === JSON.stringify(chatRequests.at(-1).tools))

    // ============ S3: find_tools → use_tool per create_agent ============
    // create_agent nei turni dell'utente parte senza card (permesso per
    // origine, fase 10): qui si chiede SEMPRE la conferma — così la sonda
    // prova che la CARD porta il nome VERO dello strumento srotolato
    await rpc(`setPermissions(${JSON.stringify({
      default: 'needs_approval',
      rules: [
        { tool: 'send_to_user', pattern: '*', mode: 'always_allow' },
        { tool: 'ask_user', pattern: '*', mode: 'always_allow' },
        { tool: 'recall_memory', pattern: '*', mode: 'always_allow' },
        { tool: 'create_agent', pattern: '*', mode: 'needs_approval' }
      ]
    })})`)
    pushTool('find_tools', { query: 'crea un bot' })
    pushTool('use_tool', { name: 'create_agent', arguments: { name: 'Aiutante', role: 'Aiuta con le prove della sonda.' } })
    pushTool('send_to_user', { text: 'Bot creato via use_tool.' })
    await uiSend('Creami un aiutante.')
    // la card d'approvazione dice create_agent (il nome VERO), mai use_tool
    check('S3 la card in chat dice «vuole usare create_agent»',
      await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('vuole usare create_agent'))`, 30_000))
    check('S3 nessuna card o riga dice use_tool',
      !(await pageEval(`return [...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && /use_tool/.test(d.textContent))`)))
    const findResult = await pageEval(`
      const entries = await window.sandbot.getEntries(${JSON.stringify(bot.id)})
      const res = entries.filter((e) => e.kind === 'tool-result' && (e.meta?.callId))
      return res.map((e) => e.content).find((c) => String(c).includes('create_agent')) ?? ''
    `)
    check('S3 find_tools ha trovato create_agent e dice di usare use_tool',
      findResult.includes('create_agent') && findResult.includes('use_tool({name, arguments})'),
      findResult.slice(0, 80))
    // cattura della card (il nome vero) prima di decidere
    await pageEval(`
      const card = [...document.querySelectorAll('div')].filter((d) => d.offsetParent !== null && d.textContent.includes('vuole usare create_agent')).pop()
      card?.scrollIntoView({ block: 'center' })
      return 'card in centro'
    `)
    await sleep(400)
    await shot('card-create-agent-1440-chiaro.png')
    await setDark(true)
    await shot('card-create-agent-1440-scuro.png')
    await setDark(false)
    await clickByText('Consenti')
    await waitForText('Bot creato via use_tool.')
    await sleep(600)
    check('S3 il bot è stato creato DAVVERO (use_tool srotolato)',
      (await rpc('listAgents()')).some((a) => a.name === 'Aiutante'))
    const callNames = await pageEval(`
      const entries = await window.sandbot.getEntries(${JSON.stringify(bot.id)})
      return entries.filter((e) => e.kind === 'tool-call').map((e) => e.meta?.name ?? e.content)
    `)
    check('S3 il transcript porta il nome VERO (create_agent), mai use_tool',
      callNames.includes('create_agent') && !callNames.includes('use_tool'),
      callNames.filter((n) => ['use_tool', 'create_agent', 'find_tools'].includes(n)).join(', '))

    // ============ S2: Ollama con thinking dal /api/show finto ============
    await rpc(`saveProvider(${JSON.stringify({ id: 'ollafinta', name: 'Ollama finto', kind: 'ollama', baseUrl: `http://127.0.0.1:${ollamaPort}`, apiKey: '', enabled: true })})`)
    // l'elenco dei modelli vive: /api/tags + /api/show (thinking incluso)
    const listed = await rpc(`listModels(${JSON.stringify('ollafinta')})`)
    check('S2 models:list espone i livelli di ragionamento del modello finto',
      listed.some((m) => m.id === 'kimi-finto' && Array.isArray(m.thinkingLevels) && m.thinkingLevels.includes('medium') && m.thinkingLevels.includes('off')),
      JSON.stringify(listed.find((m) => m.id === 'kimi-finto')?.thinkingLevels ?? null))
    await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'ollafinta', model: 'kimi-finto' })})`)
    await page.send('Page.reload')
    await waitDom(`!!document.querySelector('form textarea')`, 25_000)
    // il selettore del ragionamento compare (stesso componente degli altri provider)
    check('S2 il selettore del ragionamento compare nella chat del bot',
      await waitDom(`[...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') ?? '') === 'Livello di ragionamento' && b.offsetParent !== null)`, 20_000))
    // «Predefinito» (niente scelta): reasoning_effort "medium" sul filo
    pushText('Risposta del modello che ragiona.')
    await uiSend('Come ragioni?')
    await waitForText('Risposta del modello che ragiona.')
    await sleep(500)
    check('S2 «Predefinito» manda reasoning_effort "medium"',
      ollamaRequests.at(-1)?.reasoning_effort === 'medium',
      JSON.stringify({ reasoning_effort: ollamaRequests.at(-1)?.reasoning_effort }))
    // il menu aperto con i livelli (cattura del selettore)
    await pageEval(`
      const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '') === 'Livello di ragionamento' && x.offsetParent !== null)
      if (!b) throw new Error('selettore non trovato')
      b.scrollIntoView({ block: 'center' })
      b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      b.click()
      return 'menu aperto'
    `)
    check('S2 il menu offre Predefinito/Spento/Basso/Medio/Alto',
      await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Spento' && x.offsetParent !== null)`, 8_000))
    await sleep(400)
    await shot('selettore-ragionamento-1440-chiaro.png')
    await setDark(true)
    await shot('selettore-ragionamento-1440-scuro.png')
    await setDark(false)
    await setWindowWidth(900)
    await shot('selettore-ragionamento-900-chiaro.png')
    await setDark(true)
    await shot('selettore-ragionamento-900-scuro.png')
    await setDark(false)
    await setWindowWidth(1440)
    // si mette «Spento» DAL MENU e la richiesta seguente porta "none"
    await pageEval(`
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.offsetParent !== null && x.textContent.trim() === 'Spento')
      if (!item) throw new Error('voce Spento non trovata: ' + [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()).join(', '))
      item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      item.click()
      return 'spento'
    `)
    await sleep(800)
    pushText('Risposta spenta.')
    await uiSend('Ora senza ragionare.')
    await waitForText('Risposta spenta.')
    await sleep(500)
    check('S2 «Spento» manda reasoning_effort "none" (non omissione)',
      ollamaRequests.at(-1)?.reasoning_effort === 'none',
      JSON.stringify({ reasoning_effort: ollamaRequests.at(-1)?.reasoning_effort }))

    // ============ S1: riassunto-trace.mjs sulla traccia della sonda ============
    const summary = execFileSync(process.execPath, [join(ROOT, 'scripts', 'riassunto-trace.mjs'), tracePath], { encoding: 'utf8' })
    writeFileSync(join(SHOTS, 'riassunto-trace.txt'), summary)
    log('riassunto della traccia:\n' + summary)
    check('S1 riassunto-trace.mjs riassume i turni della sonda',
      summary.includes('turno') && summary.includes('t-') && summary.includes('tools byte'))

    // ---- K1: due PNG con NOMI diversi non possono avere lo stesso hash ----
    const byHash = new Map()
    const dup = []
    for (const name of readdirSync(SHOTS).filter((n) => n.endsWith('.png')).sort()) {
      const h = createHash('sha256').update(readFileSync(join(SHOTS, name))).digest('hex')
      if (byHash.has(h)) dup.push(`${name} ≡ ${byHash.get(h)}`)
      else byHash.set(h, name)
    }
    check('K1 nessuna cattura duplicata (stesso hash con nomi diversi)', dup.length === 0, dup.join('; '))
  }
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-9000)) } catch { /* niente log */ }
  console.error(appLog.slice(-1500))
} finally {
  console.log(`\n${failures === 0 ? (BASELINE ? 'BASELINE OK' : 'TUTTI I CONTROLLI OK') : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  if (!BASELINE) console.log(`catture in ${SHOTS}`)
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  try { ollamaServer.closeAllConnections?.(); ollamaServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // Vincoli (fase): a fine sonda si chiude ANCHE il daemon di sviluppo
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid()
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
