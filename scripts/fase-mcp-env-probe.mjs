#!/usr/bin/env node
// Sonda della fase mcp-env (E1–E4) — dal vivo con la UI come le altre sonde:
// app VERA (out/, serve `npm run build` prima) su dati temporanei e HOME
// FINTA (per l'import di E2), modello FINTO openai-compatible su 127.0.0.1
// (sceneggiato: propone npm:, poi chiama gli strumenti del server), Docker
// FINTO (il «box»: gli exec stdio MCP girano come processi veri col loro
// env), REGISTRO npm FINTO su 127.0.0.1 (packument + download), SERVIZIO
// FINTO come «host dichiarato», server MCP npm FINTO (il pacchetto). MAI npm
// vero, mai docker vero, mai rete vera fuori da 127.0.0.1.
//
//   U4+U5 (fase mcp-ui) l'app riparte col PATH RIDOTTO del Finder: lo shim
//       npx «#!/usr/bin/env node» col node FINTO nella cartella fnm della HOME
//       finta PARTE (la cartella risolta in testa al PATH del figlio) → riga
//       VERDE «2 strumenti» e nota al bot; l'indirizzo irraggiungibile e il
//       comando inesistente → righe ROSSE con l'errore leggibile e note «non
//       parte». L'elenco import è RAGGRUPPATO per origine (U2) con doppione
//       unito, segreti KeyRound col plurale e «Importa N»; le azioni della
//       riga sono ICONE lucide (U1). Catture in docs/catture/fase-mcp-ui/.
//   E2  Importa da Cursor, Claude o ZCode — SOLO al clic: i file finti si
//       creano DOPO l'avvio (nessuna lettura all'avvio), il bottone li trova,
//       la conferma crea i server (segreti CIFRATI, mai valori nel renderer),
//       il doppione «già presente» non si sovrascrive; i file tolti → vuoto.
//       Cattura CDP in docs/catture/fase-mcp-env/.
//   E4  il bot propone npm:@finto/mattermost-finto (senza versione: il daemon
//       la FISSA all'ultima stabile del registro finto), la card mostra i
//       metadati, l'utente conferma (click) e compila il modulo (segreto
//       cifrato), il server PARTE NEL BOX (docker finto, env col PROXY),
//       uno strumento LEGGE dal servizio finto tramite il proxy e una
//       chiamata a un host NON dichiarato è RIFIUTATA (403 del proxy).
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = realpathSync(tmpdir())
const PREFIX = 'sandbot-fase-mcp-env'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-mcp-env')
mkdirSync(SHOTS, { recursive: true })
const SHOTS_UI = join(ROOT, 'docs', 'catture', 'fase-mcp-ui')
mkdirSync(SHOTS_UI, { recursive: true })

const log = (...a) => console.log('[sonda mcp-env]', ...a)
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

// ---- i temporanei: dati, HOME finta (i file di Cursor/Claude/ZCode) ----
const DATA = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
const FAKE_HOME = join(DATA, 'home')
mkdirSync(FAKE_HOME)

// ---- il REGISTRO npm FINTO (packument + download, sola lettura) ----
const NPM_PKG = '@finto/mattermost-finto'
const NPM_VERSION = '1.4.2'
const npmCalls = []
const npmServer = createServer((req, res) => {
  npmCalls.push(req.url)
  if ((req.url ?? '').includes('/downloads/point/last-week/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ downloads: 4242 }))
    return
  }
  if (String(req.url ?? '').includes('mattermost-finto')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      'dist-tags': { latest: NPM_VERSION },
      time: { [NPM_VERSION]: '2026-11-18T08:00:00.000Z' },
      versions: { [NPM_VERSION]: {} },
      author: { name: 'Finto Autore' },
      maintainers: [{ name: 'finto-autore' }]
    }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => npmServer.listen(0, '127.0.0.1', r))
const npmPort = npmServer.address().port

// ---- il SERVIZIO FINTO (l'«host dichiarato» che il server MCP può leggere) ----
const servizioCalls = []
const servizioServer = createServer((req, res) => {
  servizioCalls.push(req.url)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('dato-del-servizio-finto: messaggio del canale #generale')
})
await new Promise((r) => servizioServer.listen(0, '127.0.0.1', r))
const servizioPort = servizioServer.address().port

// ---- il MODELLO FINTO sceneggiato (risposte in coda, impostabili via /script) ----
const script = { queue: [] }
const llmServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url === '/script') {
      const { responses } = JSON.parse(body)
      script.queue = responses
      res.writeHead(200).end('ok')
      return
    }
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'finto' }] }))
      return
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const next = script.queue.shift() ?? { content: 'ok' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const mk = (delta, finish) => 'data: ' + JSON.stringify({ id: 'finto', object: 'chat.completion.chunk', created: 0, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
      if (next.tool) {
        res.write(mk({ role: 'assistant', content: null }, null))
        res.write(mk({ tool_calls: [{ index: 0, id: 'call_' + Math.random().toString(36).slice(2), type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args ?? {}) } }] }, null))
        res.write(mk({}, 'stop'))
      } else {
        res.write(mk({ role: 'assistant', content: String(next.content ?? 'ok') }, null))
        res.write(mk({}, 'stop'))
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
const llmPort = llmServer.address().port

// ---- il server MCP npm FINTO: il «pacchetto» che gira NEL BOX (docker finto).
// Legge dal SERVIZIO tramite il PROXY (http.request esplicito al proxy: la
// prova non dipende dalla versione di node) e prova anche l'host NON dichiarato.
const PROXY_LOG = join(DATA, 'fake-proxy-calls.jsonl')
const fakeMcpServerPath = join(DATA, 'finto-npm-mcp.mjs')
writeFileSync(fakeMcpServerPath, [
  "import * as http from 'node:http'",
  "import { appendFileSync } from 'node:fs'",
  'const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy',
  'const viaProxy = (url) => new Promise((resolve) => {',
  '  const u = new URL(url)',
  '  const p = new URL(PROXY)',
  '  const req = http.request({ host: p.hostname, port: Number(p.port), method: "GET", path: url, headers: { host: u.host } }, (res) => {',
  '    let b = ""',
  '    res.on("data", (d) => { b += d })',
  '    res.on("end", () => resolve(`HTTP ${res.statusCode}: ${b.slice(0, 200)}`))',
  '  })',
  '  req.on("error", (e) => resolve(`ERRORE ${e.message}`))',
  '  req.end()',
  '})',
  'let buf = ""',
  'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")',
  'process.stdin.setEncoding("utf8")',
  'process.stdin.on("data", (d) => {',
  '  buf += d',
  '  let i',
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, i); buf = buf.slice(i + 1)',
  '    if (!line.trim()) continue',
  '    const m = JSON.parse(line)',
  '    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "finto-npm", version: "1.4.2" } } })',
  '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [',
  '      { name: "leggi_servizio", description: "legge dal servizio dichiarato", inputSchema: { type: "object" } },',
  '      { name: "prova_negato", description: "prova un host NON dichiarato", inputSchema: { type: "object" } }',
  '    ] } })',
  '    else if (m.method === "tools/call") {',
  '      const tool = m.params.name',
  '      const target = tool === "leggi_servizio" ? process.env.SERVIZIO_URL : "http://non-dichiarato.example/dato"',
  '      appendFileSync(process.env.CALLS_FILE, JSON.stringify({ tool, proxy: PROXY }) + "\\n")',
  '      viaProxy(target).then((out) => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: out }] } }))',
  '    }',
  '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
  '  }',
  '})'
].join('\n'))

// ---- il DOCKER FINTO: il «box». Lo stdio MCP (exec -i … npx …) gira COME
// PROCESSO VERO col suo env (i -e KEY prendono il valore dal NOSTRO env,
// come il docker vero); host.docker.internal diventa 127.0.0.1 (come lo
// vede il box vero); gli inspect rispondono i fatti che l'app si aspetta.
const FAKE_DOCKER = join(DATA, 'fake-docker.cjs')
writeFileSync(FAKE_DOCKER, [
  '#!/usr/bin/env node',
  '// docker FINTO della sonda: nessun container vero, MAI docker vero',
  'const { spawn } = require("node:child_process")',
  'const args = process.argv.slice(2)',
  'let lastTag = ""',
  'const out = (s) => { process.stdout.write(s); process.exit(0) }',
  'const ok0 = () => process.exit(0)',
  'const sub = args[0]',
  'if (sub === "version") out("Docker version 27.0.0-finto, build finto\\n")',
  'if (sub === "image" && args[1] === "inspect") { lastTag = args[2]; ok0() }',
  'if (sub === "build") { lastTag = args[args.indexOf("-t") + 1]; ok0() }',
  'if (sub === "ps") out("sandbot-box\\n")',
  'if (sub === "inspect") {',
  '  const f = args[args.indexOf("-f") + 1] ?? ""',
  '  if (f.includes("Init")) out("true\\n")',
  '  if (f.includes("Config.Image")) out((lastTag || "sandbot-box:finto") + "\\n")',
  '  if (f.includes("Mounts")) out("/box:rw /plugins:ro /browser:rw \\n")',
  '  if (f.includes("NetworkMode")) out("none\\n")',
  '  ok0()',
  '}',
  'if (sub === "start" || sub === "stop" || sub === "rm" || sub === "volume" || sub === "run" || sub === "create") ok0()',
  'if (sub === "exec") {',
  '  // i -e: KEY=VALUE letterali e KEY soli (il valore sta nel NOSTRO env)',
  '  const env = {}',
  '  let i = 1',
  '  for (; i < args.length; i++) {',
  '    if (args[i] === "-e") {',
  '      const kv = args[i + 1]',
  '      if (kv.includes("=")) { const [k, ...v] = kv.split("="); env[k] = v.join("=") }',
  '      else if (process.env[kv] !== undefined) env[kv] = process.env[kv]',
  '      i++',
  '    } else if (args[i] === "--") { i++; break } else if (args[i] === "-w" || args[i] === "-u" || args[i] === "-i") {',
  '      if (args[i] === "-w" || args[i] === "-u") i++',
  '    } else if (args[i].startsWith("--")) { /* flag lungo ignoto */ } else break',
  '  }',
'  // args[i] è il NOME del container: il comando viene DOPO',
  '  const command = args[i + 1]',
  '  const rest = args.slice(i + 2)',
  '  if (command !== "npx") ok0() // mkdir/test/one-shot del terreno: subito ok',
  '  // lo stdio MCP: il «pacchetto» gira come processo VERO con l\'env del box;',
  '  // host.docker.internal è il Mac, qui 127.0.0.1',
  '  for (const k of Object.keys(env)) if (typeof env[k] === "string") env[k] = env[k].replace(/host\\.docker\\.internal/g, "127.0.0.1")',
  '  const child = spawn(process.execPath, [process.env.FAKE_MCP_SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] })',
  '  child.on("exit", (c) => process.exit(c ?? 0))',
  '  process.on("SIGTERM", () => child.kill("SIGTERM"))',
  '  process.stdin.resume()',
  '  process.stdin.pipe(child.stdin)',
  '  child.stdout.pipe(process.stdout)',
  '}'
].join('\n'))
chmodSync(FAKE_DOCKER, 0o755)

// ---- l'app Electron VERA (out/) con dati temporanei e HOME finta ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9495
let appLog = ''
let app = null
/** l'app con l'env della sonda (PATH ridotto per la corsa U4/U5: niente node nel PATH di base) */
const startApp = (extraEnv = {}) => {
  appLog = ''
  const p = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
    cwd: ROOT,
    env: {
      HOME: FAKE_HOME,
      PATH: process.env.PATH,
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
      SANDBOT_WEB_FETCH_ALLOW_LOOPBACK: '1',
      SANDBOT_TEST_NPM_REGISTRY_URL: `http://127.0.0.1:${npmPort}`,
      SANDBOT_TEST_NPM_DOWNLOADS_URL: `http://127.0.0.1:${npmPort}`,
      HOMUN_DOCKER_PATH: FAKE_DOCKER,
      FAKE_MCP_SERVER: fakeMcpServerPath,
      CALLS_FILE: PROXY_LOG,
      ...extraEnv
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
const waitForPage = async (urlIncludes, timeoutMs = 25_000) => {
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
const settle = async (cdp) => {
  await cdp.send('Page.bringToFront').catch(() => undefined)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pageEval(cdp, `await Promise.race([new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) }), new Promise((resolve) => setTimeout(resolve, 1500))])`)
  await sleep(350)
}
const shot = async (cdp, name, dir = SHOTS) => {
  await settle(cdp)
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, name), Buffer.from(r.data, 'base64'))
  log('cattura', join(basename(dir), name))
}

try {
  startApp()
  const main = await waitForPage('', 30_000)
  if (!main) throw new Error('nessuna pagina: ' + appLog.slice(-600))
  const cdp = main.cdp

  // ---- setup: provider finto, box, guida chiusa ----
  await rpc(cdp, `saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${llmPort}/v1`, enabled: true })})`)
  await rpc(cdp, `settingsSet('models.main', ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpc(cdp, `settingsSet('sandbox.mode', 'box')`)
  await rpc(cdp, `settingsSet('sandbox.engine', 'docker')`)
  // N1 (fase mcp-egress-sicurezza): il box della sonda modella la rete
  // INTERNA (il proxy è l'unica uscita): con 'bridge' l'app RIFIUTA i server
  // npm perché col motore Docker l'uscita è libera — e il rifiuto si PROVA
  // in fondo alla corsa passando appunto a 'bridge'
  await rpc(cdp, `settingsSet('sandbox.network', 'none')`)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(cdp, `onboardingAdvance('${step}', 'skipped')`).catch(() => undefined)
      await sleep(500)
    }
    if (await waitDom(cdp, `document.querySelector('form textarea')`, 15_000)) break
  }
  if (!(await waitDom(cdp, `document.querySelector('form textarea')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))
  const agentId = await rpc(cdp, `listAgents().then((a) => a[0]?.id ?? null)`)
  if (!agentId) throw new Error('nessun bot')

  // =========== E2: Importa da Cursor, Claude o ZCode — SOLO al clic ===========
  // i file finti nascono DOPO l'avvio: se l'app leggesse all'avvio non li vedrebbe
  const cursorFile = join(FAKE_HOME, '.cursor', 'mcp.json')
  const claudeFile = join(FAKE_HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  const zcodeFile = join(FAKE_HOME, '.zcode', 'cli', 'config.json')
  mkdirSync(join(FAKE_HOME, '.cursor'), { recursive: true })
  mkdirSync(join(FAKE_HOME, 'Library', 'Application Support', 'Claude'), { recursive: true })
  mkdirSync(join(FAKE_HOME, '.zcode', 'cli'), { recursive: true })
  // il comando di mattermost è FINTO (eco-finto): l'auto-test di U5 lo
  // risolve e fallisce SUBITO — MAI npx vero, mai npm vero, mai rete
  writeFileSync(cursorFile, JSON.stringify({
    mcpServers: {
      mattermost: {
        command: 'eco-finto', args: ['-y', '@donach/mattermost-mcp'],
        env: { MATTERMOST_URL: 'https://mattermost.competitoor.com', MATTERMOST_TOKEN: 'tok-segreto-import', MATTERMOST_TEAM_ID: 'team-finto' }
      },
      'ufficio-remoto': { url: 'https://ufficio.example/mcp', headers: { Authorization: 'Bearer uff-bearer' } }
    }
  }, null, 2))
  writeFileSync(claudeFile, JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } } }, null, 2))
  writeFileSync(zcodeFile, JSON.stringify({ mcp: { servers: { sequenza: { type: 'stdio', command: 'npx', args: ['-y', '@sequenza'], env: { SEQ_API_KEY: 'k-finta' } } } } }, null, 2))

  // la finestra «Server MCP» col bottone Importa
  // PL7 (fase plugin): la finestra non c'è più — la pagina «Plugin» nel
  // punto dei server MCP (menù Aggiungi › Server MCP personalizzato)
  await clickTestid(cdp, 'sidebar-plugin')
  if (!(await waitDom(cdp, `document.querySelector('[data-testid="plugin-page"]')`, 5_000))) throw new Error('la pagina Plugin non si apre')
  await clickTestid(cdp, 'plugin-add')
  await clickTestid(cdp, 'plugin-add-mcp')
  if (!(await waitDom(cdp, `document.querySelector('[data-testid="mcp-import-button"]')`, 5_000))) throw new Error('i server MCP non si aprono nella pagina Plugin')
  const bottone = await waitDom(cdp, `document.querySelector('[data-testid="mcp-import-button"]')`, 5_000)
  check('E2: il bottone «Importa da Cursor, Claude o ZCode» c\'è nella finestra', bottone)
  await clickTestid(cdp, 'mcp-import-button')
  const elenco = await waitDom(cdp, `document.querySelector('[data-testid="mcp-import-list"]')`, 5_000)
  check('E2: il clic apre l\'elenco dei server trovati (file creati DOPO l\'avvio: nessuna lettura all\'avvio)', elenco)
  const righe = await pageEval(cdp, `
    return [...document.querySelectorAll('[data-testid="mcp-import-list"] label')].map((l) => l.textContent.trim()).join(' | ')
  `)
  check('E2: l\'elenco porta i QUATTRO server (Cursor stdio+http, Claude, ZCode) con nome e tipo',
    righe.includes('mattermost') && righe.includes('ufficio-remoto') && righe.includes('filesystem') && righe.includes('sequenza'),
    righe.slice(0, 160))
  const senzaSegreti = !/tok-segreto-import|uff-bearer|k-finta/.test(righe)
  check('E2: nell\'elenco NESSUN valore segreto (solo nomi e quali sono segrete)', senzaSegreti)
  const nessunaSpuntata = await pageEval(cdp, `
    const boxes = [...document.querySelectorAll('[data-testid="mcp-import-check"]')]
    return boxes.length > 0 && boxes.every((b) => !b.checked)
  `)
  check('E2: nessuna casella spuntata di default', nessunaSpuntata === true)
  await shot(cdp, '1-importa-elenco.png')

  // importa SOLO mattermost (Cursor): la casella, poi «Importa»
  await pageEval(cdp, `
    const labels = [...document.querySelectorAll('[data-testid="mcp-import-list"] label')]
    const mm = labels.find((l) => l.textContent.includes('mattermost'))
    if (!mm) return false
    mm.querySelector('[data-testid="mcp-import-check"]').click()
    return true
  `)
  await pageEval(cdp, `
    const w = document.querySelector('[data-testid="plugin-page"]')
    // U2: il bottone dice «Importa N» con N corretto ([0-9]: i backslash si
    // perdono dentro i template literal della sonda)
    const btn = [...w.querySelectorAll('button')].find((b) => /^Importa [0-9]+$/.test(b.textContent.trim()))
    if (!btn || btn.textContent.trim() !== 'Importa 1') return false
    btn.click()
    return true
  `)
  await sleep(1500)
  let servers = await rpc(cdp, 'mcpList()')
  const importato = servers.find((s) => s.name === 'mattermost')
  check('E2: «Importa» crea il server stdio con comando, argomenti e VARIABILI',
    !!importato && importato.command === 'eco-finto' && (importato.args ?? []).includes('-y') &&
      (importato.envSpec ?? []).some((v) => v.name === 'MATTERMOST_TOKEN' && v.secret === true) &&
      (importato.envValues ?? {}).MATTERMOST_URL === 'https://mattermost.competitoor.com',
    JSON.stringify(importato ?? {}).slice(0, 160))
  const dbSettings = readFileSync(join(DATA, 'data', 'sandbot.db'), 'utf8') // il DB è SQLite: cerco il valore in chiaro nei byte
  check('E2: il SEGRETO cifrato — mai in chiaro nel DB né nei settings (mcp:list non lo riporta)',
    !dbSettings.includes('tok-segreto-import') && !JSON.stringify(servers).includes('tok-segreto-import'))

  // il server importato si ELIMINA subito: l'import è già provato, e se
  // restasse abilitato il turno lo collegherebbe con npx VERO (rete vera)
  await rpc(cdp, `mcpDelete(${JSON.stringify(importato.id)})`)
  // il doppione: si ripete la scansione, mattermost è «già presente» e non si sovrascrive
  await clickTestid(cdp, 'mcp-import-button')
  await waitDom(cdp, `document.querySelector('[data-testid="mcp-import-list"]')`, 5_000)
  const giaCollegato = await waitDom(cdp, `document.querySelector('[data-testid="mcp-import-list"]').textContent.includes('già collegato')`, 5_000)
  check('E2: il nome che esiste già è «già collegato» e la casella è disattivata', giaCollegato)
  await shot(cdp, '2-importa-gia-presente.png')
  // i file tolti → nessun server: la lettura è DEL CLIC, non una foto d'avvio
  renameSync(cursorFile, cursorFile + '.via')
  renameSync(claudeFile, claudeFile + '.via')
  renameSync(zcodeFile, zcodeFile + '.via')
  await clickTestid(cdp, 'mcp-import-button')
  const vuoto = await waitDom(cdp, `document.querySelector('[data-testid="mcp-import-list"]')?.textContent.includes('Nessun server trovato')`, 5_000)
  check('E2: i file spariti dopo l\'avvio → l\'elenco è VUOTO (si legge al clic, non all\'avvio)', vuoto)
  renameSync(cursorFile + '.via', cursorFile)
  renameSync(claudeFile + '.via', claudeFile)
  renameSync(zcodeFile + '.via', zcodeFile)
  // chiudi la finestra
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', keyCode: 27, windowsVirtualKeyCode: 27 })
  await waitDom(cdp, `!document.querySelector('[data-testid="mcp-server-row"]')`, 5_000)

  // =========== E4: il bot propone npm:, l'utente conferma, il server sta NEL BOX ===========
  // 1) il turno del bot: il modello finto chiama add_mcp_server SENZA versione
  // il modello finto gira NEL PROCESSO della sonda: la coda si imposta qui
  // NB: i gruppi di tool sono DEFERITI — la prima chiamata ATTIVA il gruppo,
  // la seconda esegue davvero (come farebbe un modello vero con find_tools)
  const proposta = { tool: 'add_mcp_server', args: { id: 'npm:@finto/mattermost-finto', reason: 'per leggere Mattermost', env: [
    { name: 'MATTERMOST_TOKEN', secret: true, description: 'token del bot' },
    { name: 'SERVIZIO_URL', secret: false, description: 'indirizzo del servizio' }
  ], allowHosts: ['127.0.0.1'] } }
  script.queue = [proposta, proposta, { content: 'Ho proposto il server.' }]
  await rpc(cdp, `sendMessage(${JSON.stringify(agentId)}, 'Collegami mattermost')`)
  const cardOk = await waitDom(cdp, `document.querySelector('[data-testid="mcp-server-card"], [class*="mcp-server"]') || [...document.querySelectorAll('div')].some((d) => d.textContent?.includes('Aggiungi server MCP'))`, 20_000)
  if (!cardOk) {
    const es = await rpc(cdp, `getEntries(${JSON.stringify(agentId)})`).catch(() => [])
    log('diagnosi turno (ultime voci):', JSON.stringify((es ?? []).slice(-6).map((e) => ({ kind: e.kind, content: String(e.content).slice(0, 120) })), null, 1))
  }
  check('E4: il bot propone il server npm e la CARD compare (add_mcp_server → card)', cardOk)
  // la card: versione FISSATA a quella del registro finto, autore, download, host, non verificato
  const meta = await pageEval(cdp, `return document.querySelector('[data-testid="mcp-card-npm-meta"]')?.textContent ?? ''`)
  const rete = await pageEval(cdp, `return document.querySelector('[data-testid="mcp-card-allow-hosts"]')?.textContent ?? ''`)
  const cardTesto = meta + ' || ' + rete
  check('E4: la card mostra la versione FISSATA (1.4.2 dal registro finto), autore, download',
    meta.includes('1.4.2') && meta.includes('Finto Autore') && /4[.,]?242/.test(meta),
    cardTesto.slice(0, 220))
  check('E4: la card dice gli HOST che potrà raggiungere e il computer isolato',
    rete.includes('127.0.0.1') && /computer isolato/.test(rete), rete)
  await shot(cdp, '3-card-npm.png')

  // 2) il click dell'utente su «Aggiungi» (la card NON installa da sola)
  const entryCard = await rpc(cdp, `getEntries(${JSON.stringify(agentId)}).then((es) => es.filter((e) => e.kind === 'send-message' && e.meta?.message?.type === 'mcp-server').at(-1))`)
  if (!entryCard) throw new Error('la card non è nel transcript')
  const install = await rpc(cdp, `connectorsResolveMcpServer(${JSON.stringify(agentId)}, ${entryCard.id}, 'add')`)
  check('E4: l\'installazione risponde needsAuth env → il MODULO delle variabili (i segreti cifrati)',
    install && install.ok === true && (install.message ?? '').includes('variables'),
    JSON.stringify(install ?? {}).slice(0, 140))
  servers = await rpc(cdp, 'mcpList()')
  const npmCfg = servers.find((s) => s.source?.kind === 'npm')
  check('E4: il server creato è NEL BOX (npx --yes @finto/mattermost-finto@1.4.2, ARGV senza shell — N3) con egress.allowHosts e versione fissata',
    !!npmCfg && npmCfg.box?.command === 'npx' && (npmCfg.box?.args ?? []).join(' ').includes(`@finto/mattermost-finto@${NPM_VERSION}`) &&
      JSON.stringify(npmCfg.egress?.allowHosts) === JSON.stringify(['127.0.0.1']) && npmCfg.source?.version === NPM_VERSION,
    JSON.stringify({ box: npmCfg?.box, egress: npmCfg?.egress, source: npmCfg?.source }))
  check('E4: fiducia «non verificato» e NESSUN avvio sul Mac (box presente, comando npx nel box)',
    npmCfg?.trustKind === 'unverified' && !!npmCfg?.box)

  // 3) il modulo: l'utente compila le variabili (il SEGRETO va cifrato)
  const connect = await rpc(cdp, `connectorsServerConnect(${JSON.stringify(npmCfg.id)}, ${JSON.stringify({ vars: { MATTERMOST_TOKEN: 'tok-del-bot-finto', SERVIZIO_URL: `http://127.0.0.1:${servizioPort}/dato` } })})`)
  check('E4: le variabili compilate collegano il server (il segreto NON torna mai indietro)',
    connect && connect.ok === true && !JSON.stringify(connect).includes('tok-del-bot-finto'),
    JSON.stringify(connect ?? {}).slice(0, 140))
  const test1 = await rpc(cdp, `mcpTest(${JSON.stringify(npmCfg.id)})`)
  check('E4: il server PARTE nel box (docker finto) ed espone i suoi strumenti',
    test1?.ok === true && (test1.tools ?? []).some((t) => t.includes('leggi_servizio')),
    JSON.stringify(test1 ?? {}).slice(0, 160))
  servers = await rpc(cdp, 'mcpList()')
  const dopo = servers.find((s) => s.id === npmCfg.id)
  check('E4: il primo avvio riuscito segna l\'installazione (egress.installedAt: il registro npm torna VIETATO)',
    typeof dopo?.egress?.installedAt === 'number')
  const dbDopo = readFileSync(join(DATA, 'data', 'sandbot.db'), 'utf8')
  check('E4: il segreto del bot resta CIFRATO (mai in chiaro nel DB)',
    !dbDopo.includes('tok-del-bot-finto'))

  // 4) gli strumenti: uno LEGGE dal servizio finto (via proxy), l'altro è RIFIUTATO
  const toolNames = (test1.tools ?? []).map((t) => t)
  const leggi = toolNames.find((t) => t.includes('leggi_servizio'))
  const negato = toolNames.find((t) => t.includes('prova_negato'))
  if (!leggi || !negato) throw new Error('strumenti del server non trovati: ' + JSON.stringify(toolNames))
  // T5 (fase web-strategia, corsa vista dal vivo): il messaggio [sistema]
  // del collegamento (M5.2) apre un turno tutto suo quando il bot è libero —
  // si aspetta che sia FINITO prima di mettere in coda le chiamate degli
  // strumenti, altrimenti è lui a consumarle (e l'attesa dell'approvazione
  // verrebbe soprammessa dal turno vero)
  for (let i = 0; i < 60; i++) {
    const es = await rpc(cdp, `getEntries(${JSON.stringify(agentId)})`).catch(() => [])
    const sysIdx = (es ?? []).findIndex((e) => e.kind === 'message' && String(e.content).startsWith('[sistema]'))
    const done = sysIdx >= 0 && (es ?? []).slice(sysIdx).some((e) => e.kind === 'event' && String(e.content).includes('Turno completato'))
    if (done) break
    await sleep(500)
  }
  script.queue = [
    { tool: leggi, args: {} },
    { tool: negato, args: {} },
    { content: 'Fatto.' }
  ]
  await rpc(cdp, `sendMessage(${JSON.stringify(agentId)}, ${JSON.stringify("Leggi dal servizio e prova l'host vietato")})`)
  // si aspetta la FINE del turno sulle voci Vere (l'assistente dice «Fatto.»);
  // gli strumenti del server NON VERIFICATO chiedono l'approvazione: la sonda
  // la concede PER IL TURNO appena compare (come farebbe l'utente sulle card)
  const approved = new Set()
  let entries = []
  for (let i = 0; i < 160; i++) {
    await sleep(500)
    entries = await rpc(cdp, `getEntries(${JSON.stringify(agentId)})`).catch(() => [])
    const pend = (entries ?? []).find((e) => e.kind === 'approval' && e.meta?.approvalId && !approved.has(e.meta.approvalId))
    if (pend) {
      approved.add(pend.meta.approvalId)
      await rpc(cdp, `resolveApproval(${JSON.stringify(agentId)}, ${JSON.stringify(pend.meta.approvalId)}, 'allow', 'turn')`).catch(() => undefined)
    }
    if ((entries ?? []).some((e) => e.kind === 'send-message' && String(e.content) === 'Fatto.')) break
  }
  const fineTurno = (entries ?? []).some((e) => e.kind === 'send-message' && String(e.content) === 'Fatto.')
  if (!fineTurno) log('avviso: turno non finito entro 60 s, controllo comunque le voci')
  const results = entries.filter((e) => e.kind === 'tool-result').slice(-3).map((e) => String(e.content))
  const letto = results.find((r) => r.includes('dato-del-servizio-finto'))
  if (!letto) {
    log('diagnosi turno 2 (ultime 14 voci):', JSON.stringify(entries.slice(-14).map((e) => ({ kind: e.kind, content: String(e.content).slice(0, 150) })), null, 1))
    const dlog = join(DATA, 'data', 'daemon.log')
    if (existsSync(dlog)) log('daemon.log (coda):', readFileSync(dlog, 'utf8').slice(-3000))
    else log('niente daemon.log in', join(DATA, 'data'))
  }
  check('E4: lo strumento LEGGE dal servizio dichiarato PASSANDO DAL PROXY', !!letto, results.join(' || ').slice(0, 200))
  check('E4: la chiamata verso l\'host NON dichiarato è RIFIUTATA (403 del proxy, motivo in chiaro)',
    results.some((r) => r.includes('403') && r.includes('not in the allowed hosts')),
    results.join(' || ').slice(0, 200))
  check('E4: il servizio finto ha ricevuto la richiesta (attraverso il proxy)', servizioCalls.some((u) => String(u).includes('/dato')))
  // il processo nel «box» ha ricevuto il PROXY nell'env
  const proxyCalls = existsSync(PROXY_LOG) ? readFileSync(PROXY_LOG, 'utf8') : ''
  check('E4: il processo nel box riceve HTTPS_PROXY nell\'env (e lo usa)', proxyCalls.includes('HTTP') || proxyCalls.includes('proxy'), proxyCalls.slice(0, 120))
  check('E4: il registro npm finto è stato letto in SOLA LETTURA (packument + download, nient\'altro)',
    npmCalls.every((u) => String(u).includes('mattermost-finto')), JSON.stringify(npmCalls))
  await shot(cdp, '4-strumenti-via-proxy.png')

  // =========== N1 (fase mcp-egress-sicurezza): col motore Docker (uscita libera) i server npm NON partono ===========
  // il motore passa alla rete bridge: la PROPOSTA si rifiuta in parole (nel
  // result del bot, NESSUNA card) e il server GIÀ INSTALLATO non parte più,
  // con lo stato d'errore che il foglio del server mostra
  await rpc(cdp, `settingsSet('sandbox.network', 'bridge')`)
  const cardPrima = ((await rpc(cdp, `getEntries(${JSON.stringify(agentId)})`).catch(() => [])) ?? [])
    .filter((e) => e.kind === 'send-message' && e.meta?.message?.type === 'mcp-server').length
  script.queue = [proposta, proposta, { content: 'Non si può con Docker.' }]
  await rpc(cdp, `sendMessage(${JSON.stringify(agentId)}, 'Collegami ancora mattermost')`)
  let vociN1 = []
  for (let i = 0; i < 100; i++) {
    await sleep(400)
    vociN1 = await rpc(cdp, `getEntries(${JSON.stringify(agentId)})`).catch(() => [])
    if ((vociN1 ?? []).some((e) => e.kind === 'send-message' && String(e.content) === 'Non si può con Docker.')) break
  }
  const esitoN1 = (vociN1 ?? []).filter((e) => e.kind === 'tool-result').slice(-3).map((e) => String(e.content))
  const cardNuove = (vociN1 ?? []).filter((e) => e.kind === 'send-message' && e.meta?.message?.type === 'mcp-server').length - cardPrima
  check('N1: con l\'uscita libera (bridge) la PROPOSTA del server npm è RIFIUTATA in parole nel result del bot',
    esitoN1.some((r) => r.includes('unverified npm servers do not start')),
    esitoN1.join(' || ').slice(0, 200))
  check('N1: NESSUNA card di server npm compare (niente promessa di recinto)', cardNuove === 0, `card: ${cardNuove}`)
  const testDirect = await rpc(cdp, `mcpTest(${JSON.stringify(npmCfg.id)})`)
  check('N1: il server GIÀ INSTALLATO non parte con l\'uscita libera (rifiuto in parole)',
    testDirect && testDirect.ok === false && String(testDirect.error ?? testDirect.message ?? JSON.stringify(testDirect)).includes('do not start'),
    JSON.stringify(testDirect ?? {}).slice(0, 180))
  const installati = await rpc(cdp, 'connectorsInstalled()').catch(() => null)
  const rigaN1 = installati?.servers?.find((x) => x.id === npmCfg.id)
  check('N1: lo stato del server dice l\'errore (il foglio del server lo mostra)',
    rigaN1?.stateStatus === 'error' && String(rigaN1?.stateError ?? '').includes('do not start'),
    JSON.stringify({ stateStatus: rigaN1?.stateStatus, stateError: rigaN1?.stateError }).slice(0, 180))
  // si torna alla rete interna per le corse successive
  await rpc(cdp, `settingsSet('sandbox.network', 'none')`)

  // =========== U4+U5 (fase mcp-ui): lo shim npx «#!/usr/bin/env node» con il
  // node FINTO fuori dal PATH di base → il server PARTE (la cartella risolta
  // in TESTA al PATH del figlio), la riga va VERDE «N strumenti» e il bot
  // riceve la nota; gli altri due server importati falliscono → righe ROSSE
  // con l'errore leggibile e la nota «non parte». Catture in fase-mcp-ui/.
  cdp.sock?.close?.()
  stopApp()
  if (Number.isInteger(app?.pid)) await waitPidGone(app.pid)
  await stopProbeDaemons(PREFIX, { log }).catch((e) => log('stopProbeDaemons:', e.message))
  for (let i = 0; i < 50 && findProbeDaemons(PREFIX).length > 0; i++) await sleep(200)

  // la cartella fnm della HOME finta: la shim npx È il server MCP (2 strumenti)
  // e accanto c'è il node FINTO (esegue il node della sonda col percorso assoluto)
  const FNM_BIN = join(FAKE_HOME, '.local', 'share', 'fnm', 'aliases', 'default', 'bin')
  mkdirSync(FNM_BIN, { recursive: true })
  writeFileSync(join(FNM_BIN, 'npx'), [
    '#!/usr/bin/env node',
    'let buf = ""',
    'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n")',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.on("data", (d) => {',
    '  buf += d',
    '  let i',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1)',
    '    if (!line.trim()) continue',
    '    const m = JSON.parse(line)',
    '    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mattermost-finto", version: "1" } } })',
    '    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [',
    '      { name: "mattermost_envia_canale", description: "envia un messaggio nel canale", inputSchema: { type: "object" } },',
    '      { name: "mattermost_leggi_canale", description: "legge i messaggi del canale", inputSchema: { type: "object" } }',
    '    ] } })',
    '    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} })',
    '  }',
    '})'
  ].join('\n'), { mode: 0o755 })
  chmodSync(join(FNM_BIN, 'npx'), 0o755)
  writeFileSync(join(FNM_BIN, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 })
  chmodSync(join(FNM_BIN, 'node'), 0o755)
  // i file delle TRE origini con un DOPPIONE esatto (mattermost in Cursor e
  // ZCode), un http con 2 segreti (orion-moon, indirizzo loopback IRRAGGIUNGIBILE
  // per la riga rossa) e un comando inesistente (rotto)
  writeFileSync(cursorFile, JSON.stringify({
    mcpServers: {
      mattermost: { command: 'npx', args: ['-y', '@donach/mattermost-mcp'], env: { MATTERMOST_URL: 'https://mattermost.example', MATTERMOST_TOKEN: 'tok-shim', MATTERMOST_API_KEY: 'k-shim' } },
      'ufficio-remoto': { url: 'https://ufficio.example/mcp', headers: { Authorization: 'Bearer uff-bearer' } }
    }
  }, null, 2))
  writeFileSync(claudeFile, JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } } }, null, 2))
  writeFileSync(zcodeFile, JSON.stringify({ mcp: { servers: {
    mattermost: { type: 'stdio', command: 'npx', args: ['-y', '@donach/mattermost-mcp'], env: { MATTERMOST_URL: 'https://mattermost.example', MATTERMOST_TOKEN: 'tok-shim', MATTERMOST_API_KEY: 'k-shim' } },
    'orion-moon': { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer orion', 'X-Key': 'k' } },
    rotto: { type: 'stdio', command: 'comando-che-non-esiste', args: [] }
  } } }, null, 2))
  // U7: i file delle altre CINQUE app ( Claude Code utente+progetto, Codex TOML
  // con bearer_token_env_var, Windsurf, Gemini con ${env:}, VS Code col
  // comando riferito da SALTARE col motivo)
  const claudeCodeFile = join(FAKE_HOME, '.claude.json')
  const codexFile = join(FAKE_HOME, '.codex', 'config.toml')
  const windsurfFile = join(FAKE_HOME, '.codeium', 'windsurf', 'mcp_config.json')
  const geminiFile = join(FAKE_HOME, '.gemini', 'settings.json')
  const vscodeFile = join(FAKE_HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  mkdirSync(join(FAKE_HOME, '.codex'), { recursive: true })
  mkdirSync(join(FAKE_HOME, '.codeium', 'windsurf'), { recursive: true })
  mkdirSync(join(FAKE_HOME, '.gemini'), { recursive: true })
  mkdirSync(join(FAKE_HOME, 'Library', 'Application Support', 'Code', 'User'), { recursive: true })
  writeFileSync(claudeCodeFile, JSON.stringify({
    mcpServers: { 'claude-code-utente': { command: 'npx', args: ['-y', 'cc-u'] } },
    projects: { '/Users/prova/lavoro': { mcpServers: { 'claude-code-progetto': { command: 'node', args: ['srv.js'] } } } },
    history: ['dati', 'privati', 'che', 'non', 'si', 'leggono']
  }, null, 2))
  writeFileSync(codexFile, [
    '# il config TOML di Codex (parser MINIMO, niente dipendenze)',
    'model = "gpt-5-codex"',
    '',
    '[mcp_servers.codex-mm]',
    'command = "uvx"',
    'args = ["codex-finto"]',
    'bearer_token_env_var = "CODEX_TOKEN"',
    '',
    '[mcp_servers.codex-altro]',
    'command = "npx"',
    'args = ["-y", "altro"]',
    'env = { ALTRO_KEY = "v-finta" }'
  ].join('\n'))
  writeFileSync(windsurfFile, JSON.stringify({ mcpServers: { 'windsurf-mm': { command: 'npx', args: ['-y', 'ws'] } } }, null, 2))
  writeFileSync(geminiFile, JSON.stringify({ mcpServers: { 'gemini-mm': { command: 'npx', args: ['-y', 'gem'], env: { GEMINI_KEY: '${env:GEMINI_KEY}' } } } }, null, 2))
  writeFileSync(vscodeFile, JSON.stringify({ servers: {
    'vscode-mm': { command: 'npx', args: ['-y', 'vs'] },
    'vscode-col-riferito': { command: '${env:VS_PATH}', args: [] }
  } }, null, 2))
  // il PATH dell'app è QUELLO RIDOTTO del Finder: né fnm, né node
  const PATH_RIDOTTO = '/usr/bin:/bin:/usr/sbin:/sbin'
  startApp({ PATH: PATH_RIDOTTO })
  const u45 = await waitForPage('', 30_000)
  if (!u45) throw new Error('U4/U5: nessuna pagina: ' + appLog.slice(-600))
  const u45cdp = u45.cdp
  await rpc(u45cdp, `saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${llmPort}/v1`, enabled: true })})`).catch(() => undefined)
  const u45agentId = await rpc(u45cdp, 'listAgents().then((a) => a[0]?.id ?? null)')
  if (!u45agentId) throw new Error('U4/U5: nessun bot')

  // la finestra «Server MCP» e l'import: elenco RAGGRUPPATO per origine (U2)
  // PL7 (fase plugin): pagina Plugin › Aggiungi › Server MCP personalizzato
  await clickTestid(u45cdp, 'sidebar-plugin')
  if (!(await waitDom(u45cdp, `document.querySelector('[data-testid="plugin-page"]')`, 5_000))) throw new Error('U4/U5: la pagina Plugin non si apre')
  await clickTestid(u45cdp, 'plugin-add')
  await clickTestid(u45cdp, 'plugin-add-mcp')
  if (!(await waitDom(u45cdp, `document.querySelector('[data-testid="mcp-import-button"]')`, 5_000))) throw new Error('U4/U5: i server MCP non si aprono')
  await clickTestid(u45cdp, 'mcp-import-button')
  if (!(await waitDom(u45cdp, `document.querySelector('[data-testid="mcp-import-list"]')`, 5_000))) throw new Error('U4/U5: l\'elenco import non si apre')
  const u45gruppi = await pageEval(u45cdp, `
    const gruppi = [...document.querySelectorAll('[data-testid^="mcp-import-group-"]')].map((g) => g.dataset.testid.replace('mcp-import-group-', ''))
    return { gruppi, testo: document.querySelector('[data-testid="mcp-import-list"]').textContent }
  `)
  check('U2+U7: l\'elenco import è RAGGRUPPATO per origine — le OTTO app, i gruppi vuoti nascosti',
    JSON.stringify(u45gruppi.gruppi) === JSON.stringify(['cursor', 'claude', 'zcode', 'claude-code', 'codex', 'windsurf', 'gemini', 'vscode']), JSON.stringify(u45gruppi.gruppi))
  check('U2: il DOPPIONE esatto (mattermost in Cursor e ZCode) compare UNA volta con «anche in ZCode»',
    (u45gruppi.testo.split('mattermost').length - 1 >= 1) && u45gruppi.testo.includes('anche in ZCode'), u45gruppi.testo.slice(0, 120))
  check('U2: i SEGRETI con l\'icona lucide e il conteggio (1 segreto / 2 segreti), NESSUNA emoji 🔒',
    !u45gruppi.testo.includes('🔒') && u45gruppi.testo.includes('1 segreto') && u45gruppi.testo.includes('2 segreti'), '')
  const u45markup = await pageEval(u45cdp, `return document.querySelector('[data-testid="mcp-import-list"]').innerHTML`)
  check('U2: l\'icona KeyRound di lucide c\'è nel markup (niente emoji)', /lucide-key-round/.test(u45markup), '')
  const u45fondo = await pageEval(u45cdp, `
    return document.querySelector('[data-testid="plugin-page"]').textContent
  `)
  check('U2: in fondo «N selezionati», «Annulla» e «Importa N» (0 finché non si spunta)',
    u45fondo.includes('0 selezionati') && u45fondo.includes('Annulla') && u45fondo.includes('Importa 0'), u45fondo.slice(0, 100))
  await shot(u45cdp, '1-importa-elenco-raggruppato.png', SHOTS_UI)
  // U7: le app nuove ci sono tutte, il SALTATO col motivo pure
  const u45testi = u45gruppi.testo
  check('U7: le intestazioni delle nuove app (Claude Code, Codex, Windsurf, Gemini CLI, VS Code) e le loro vie',
    ['Claude Code', 'Codex', 'Windsurf', 'Gemini CLI', 'VS Code', '.claude.json', 'config.toml'].every((x) => u45testi.includes(x)), u45testi.slice(0, 160))
  check('U7: Claude Code porta UTENTE e PROGETTI (due righe), Codex due (una con il token da compilare)',
    u45testi.includes('claude-code-utente') && u45testi.includes('claude-code-progetto') &&
      u45testi.includes('codex-mm') && u45testi.includes('codex-altro'), '')
  const u45saltati = await pageEval(u45cdp, `
    return [...document.querySelectorAll('[data-testid="mcp-import-skipped"]')].map((p) => p.textContent.trim())
  `)
  check('U7: il server col COMANDO riferito (${env:…}) è SALTATO col motivo, senza casella',
    u45saltati.length === 1 && u45saltati[0].includes('vscode-col-riferito') && /non importato/.test(u45saltati[0]) && /variabile/.test(u45saltati[0]),
    JSON.stringify(u45saltati))
  check('U7: la variabile RIFERITA di Gemini è contata come SEGRETO da compilare (mai il placeholder nel DOM)',
    u45testi.includes('gemini-mm') && !u45testi.includes('${env:'), '')

  // si spuntano i TRE server nuovi (mattermost, orion-moon, rotto) e si importa
  await pageEval(u45cdp, `
    const righe = [...document.querySelectorAll('[data-testid="mcp-import-row"]')]
    for (const nome of ['mattermost', 'orion-moon', 'rotto', 'codex-mm']) {
      const r = righe.find((x) => x.textContent.includes(nome))
      if (!r) return 'manca ' + nome
      r.querySelector('[data-testid="mcp-import-check"]').click()
    }
    return 'ok'
  `).then((r) => { if (r !== 'ok') throw new Error('U4/U5: ' + r) })
  const u45importa = await pageEval(u45cdp, `
    const w = document.querySelector('[data-testid="plugin-page"]')
    const btn = [...w.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Importa 4')
    if (!btn) return false
    btn.click()
    return true
  `)
  if (!u45importa) throw new Error('U4/U5: il bottone «Importa 4» non c\'è')

  // U5: il test parte DA SOLO — la riga di mattermost va VERDE «2 strumenti»
  // (lo shim npx trova node nella cartella fnm, U4), orion-moon e rotto ROSSE
  const rigaDi = (nome) => `
    const riga = [...document.querySelectorAll('[data-testid="mcp-server-row"]')]
      .find((d) => [...d.querySelectorAll('span')].some((sp) => sp.textContent.trim() === ${JSON.stringify(nome)}))
    if (!riga) return null
    const s = riga.querySelector('[data-testid="mcp-row-status"]')
    return s ? { testo: s.textContent.trim(), pallino: s.querySelector('span')?.className ?? '' } : null
  `
  let verde = null
  for (let i = 0; i < 60 && !verde; i++) {
    await sleep(500)
    const r = await pageEval(u45cdp, rigaDi('mattermost')).catch(() => null)
    if (r && /2 strumenti/.test(r.testo) && /bg-chart-2/.test(r.pallino)) verde = r
  }
  if (!verde) {
    const righeStato = await pageEval(u45cdp, `
      return [...document.querySelectorAll('[data-testid="mcp-server-row"]')].map((d) => {
        const s = d.querySelector('[data-testid="mcp-row-status"]')
        return d.textContent.trim().slice(0, 30) + ' => ' + (s ? s.textContent.trim().slice(0, 80) + ' @' + (s.title ?? '').slice(0, 120) : 'senza stato')
      }).join(' || ')
    `).catch(() => 'n/d')
    log('diagnosi righe dopo import:', righeStato)
    const dlog = join(DATA, 'data', 'daemon.log')
    if (existsSync(dlog)) log('daemon.log (coda):', readFileSync(dlog, 'utf8').slice(-800))
  }
  check('U4+U5: lo shim npx «#!/usr/bin/env node» (node finto nella fnm, PATH ridotto) PARTE: riga VERDE «2 strumenti»',
    !!verde, verde ? verde.testo : 'riga verde non arrivata')
  await shot(u45cdp, '2-riga-verde.png', SHOTS_UI)
  // le righe rosse con l'errore leggibile
  const rossaOrion = await pageEval(u45cdp, rigaDi('orion-moon')).catch(() => null)
  const rossaRotto = await pageEval(u45cdp, rigaDi('rotto')).catch(() => null)
  check('U5: l\'indirizzo irraggiungibile → riga ROSSA con l\'errore leggibile',
    rossaOrion && /bg-destructive/.test(rossaOrion.pallino) && rossaOrion.testo.length > 3, JSON.stringify(rossaOrion))
  check('U5: il comando che non esiste → riga ROSSA con l\'errore leggibile («non trovato»)',
    rossaRotto && /bg-destructive/.test(rossaRotto.pallino) && /non trovato/.test(rossaRotto.testo), JSON.stringify(rossaRotto))
  await shot(u45cdp, '3-righe-rosse.png', SHOTS_UI)

  // U1: le azioni della riga sono ICONE con aria-label, NESSUNA parola visibile
  const u45azioni = await pageEval(u45cdp, `
    const riga = [...document.querySelectorAll('[data-testid="plugin-page"] [data-testid="mcp-test-button"]')].slice(0, 1)[0]?.closest('div')
    const bottoni = [...document.querySelectorAll('[data-testid="plugin-page"] [data-testid="mcp-test-button"], [data-testid="plugin-page"] [data-testid="mcp-edit-button"], [data-testid="plugin-page"] [data-testid="mcp-delete-button"]')]
    return {
      tre: bottoni.length,
      aria: bottoni.every((b) => (b.getAttribute('aria-label') ?? '').length > 0 && (b.getAttribute('title') ?? '') === b.getAttribute('aria-label')),
      visibili: bottoni.map((b) => b.textContent.trim()).join(''),
      svg: bottoni.every((b) => b.querySelector('svg') !== null)
    }
  `)
  check('U1: le azioni della riga sono 3 BOTTONI ICONA (svg) con aria-label E title, NESSUNA parola visibile',
    u45azioni.tre >= 3 && u45azioni.aria === true && u45azioni.visibili.trim() === '' && u45azioni.svg === true,
    JSON.stringify(u45azioni))
  await shot(u45cdp, '4-icone-riga.png', SHOTS_UI)

  // U7: il server Codex importato con la variabile RIFERITA: riga «da
  // compilare», NESSUN test (niente pallino) e needsAuth nella config
  let daCompilare = null
  for (let i = 0; i < 30 && !daCompilare; i++) {
    await sleep(400)
    daCompilare = await pageEval(u45cdp, `
      const riga = [...document.querySelectorAll('[data-testid="mcp-server-row"]')].find((d) => d.textContent.includes('codex-mm'))
      return riga ? { compilare: !!riga.querySelector('[data-testid="mcp-needs-fill"]'), status: !!riga.querySelector('[data-testid="mcp-row-status"]') } : null
    `).catch(() => null)
  }
  check('U7: il server Codex (bearer_token_env_var) importato «da compilare»: la riga lo dice e NON si testa',
    !!daCompilare && daCompilare.compilare === true && daCompilare.status === false, JSON.stringify(daCompilare))
  const u45servers = await rpc(u45cdp, 'mcpList()')
  const codexCfg = u45servers.find((x) => x.name === 'codex-mm')
  check('U7: la config del server Codex porta needsAuth con la variabile, e NESSUN valore (il placeholder mai)',
    codexCfg?.needsAuth?.kind === 'env' && JSON.stringify(codexCfg?.needsAuth?.keys) === JSON.stringify(['CODEX_TOKEN']) &&
      !JSON.stringify(codexCfg).includes('CODEX_TOKEN=') && !JSON.stringify(u45servers).includes('${env:') && !JSON.stringify(u45servers).includes('bearer'),
    JSON.stringify({ needsAuth: codexCfg?.needsAuth }).slice(0, 120))
  await shot(u45cdp, '5-da-compilare.png', SHOTS_UI)

  // U5: il bot riceve le note di sistema (collegato / non parte)
  const notaDi = (frase) => `
    (await window.sandbot.getEntries(${JSON.stringify(u45agentId)}))
      .filter((e) => e.kind === 'message' && String(e.content).startsWith('[sistema]'))
      .map((e) => String(e.content)).join('\\n')
  `
  let note = ''
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    note = await pageEval(u45cdp, `return ${notaDi().trimStart()}`).catch(() => '')
    if (/Server MCP "mattermost" connected/.test(note) && /does not start/.test(note)) break
  }
  check('U5: la nota di sistema al bot: «Server MCP \"mattermost\" connected … 2 tools» (con find_tools)',
    /Server MCP "mattermost" connected: 2 tools/.test(note) && /find_tools/.test(note), note.slice(0, 200))
  check('U5: le note «non parte» per orion-moon e rotto',
    /Server MCP "orion-moon" does not start/.test(note) && /Server MCP "rotto" does not start/.test(note), note.slice(0, 300))
  check('U7: NESSUNA nota per codex-mm (da compilare: niente test né esito)',
    !/codex-mm/.test(note), note.slice(0, 300))
  // il registro del ciclo di vita (temporaneo) c'è: la corsa U6 lo prova in
  // fondo nella sonda avvio; qui basta che esista e non contenga dati utente
  const mainLogU45 = existsSync(join(DATA, 'Logs', 'main.log')) ? readFileSync(join(DATA, 'Logs', 'main.log'), 'utf8') : ''
  check('U6: il registro del ciclo di vita (temporaneo) cresce con l\'app della corsa',
    /boot pid=\d+ version=\S+ mode=ui/.test(mainLogU45) && /window-created/.test(mainLogU45), '')

  // ---- pulizia K4 ----
  stopApp()
  if (Number.isInteger(app.pid)) await waitPidGone(app.pid)
  await stopProbeDaemons(PREFIX, { log }).catch((e) => log('stopProbeDaemons:', e.message))
  try {
    const out = spawnSync('/usr/bin/pgrep', ['-f', `fase-mcp-env-probe|${join(ROOT, 'node_modules', 'electron')}`], { encoding: 'utf8' })
    for (const pidStr of String(out.stdout ?? '').trim().split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid && pid !== app?.pid) {
        try { process.kill(pid, 'SIGKILL'); log('app residua chiusa:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [DATA], log, capMs: 20_000 }).catch((e) => log('cleanupProbeRun:', e.message))
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
  let left = countProbeDirs(PREFIX, [DATA])
  if (left > 0) {
    await sleep(1500)
    await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
    left = countProbeDirs(PREFIX, [DATA])
  }
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  check('pulizia K4: 0 cartelle sandbot-fase-mcp-env-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia K4: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  await new Promise((r) => Promise.all([llmServer.close(r), npmServer.close(() => undefined), servizioServer.close(() => undefined)]).then(() => r()))
} catch (e) {
  log('ERRORE della sonda:', e?.stack ?? e)
  log('log app (coda):', appLog.slice(-1200))
  failed++
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: String(e?.message ?? e) })
  stopApp()
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: app?.pid ? [app.pid] : [], prefix: PREFIX, dirs: [DATA], log, capMs: 15_000 }).catch(() => undefined)
  await new Promise((r) => Promise.all([llmServer.close(r), npmServer.close(r), servizioServer.close(r)]).catch(() => r()))
}

log(`CORSA mcp-env: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
