#!/usr/bin/env node
// Sonda Electron della fase MCP-SETUP (M1–M8): l'app VERA (build di sviluppo
// in out/) su cartella dati TEMPORANEA, con TUTTO finto e SOLO su 127.0.0.1 —
//   • un REGISTRO finto (SANDBOT_TEST_REGISTRY_URL) che risponde con la voce
//     VERA di Mattermost (2026-11-04), l'URL puntato al server MCP finto:
//     http://{mattermost_host}/plugins/mattermost-ai/mcp-server/mcp;
//   • un SERVER MCP finto con OAuth COMPLETO: 401+PRM → metadati AS → DCR →
//     authorize → token (PKCE), più un Bearer STATICO come alternativa, e due
//     strumenti; registra OGNI Authorization che riceve;
//   • il «browser» finto (SANDBOT_TEST_FAKE_BROWSER=1) che segue i redirect
//     fino al callback di loopback: mai il browser vero;
//   • un provider finto (openai-compatible, SSE) che chiama add_mcp_server.
// I remoti http passano col flag SANDBOT_TEST_ALLOW_HTTP_REMOTES=1; NESSUNA
// chiamata al registro vero né a server veri, niente Docker.
//
// Copre, con CATTURE in docs/catture/mcp-setup/:
//   M2/M4  la card si chiama «Mattermost»: «Dove gira: sul server Mattermost
//          che indichi tu», «Accesso: con il tuo account», avviso terzi in
//          arancione tenue su una riga (chiaro e scuro);
//   M4     «Aggiungi» → la card DIVENTA il modulo («Ultimo passo: collega
//          Mattermost»), host, «Accedi con Mattermost» col browser finto,
//          «✓ collegato · 2 strumenti»;
//   M5     il bot riceve CONNECTOR_CONNECTED con i nomi mcp__mattermost__*;
//   M6     la finestra App: riga «Da completare» PRIMA e «Connessa» DOPO; il
//          foglio in chiaro e scuro a 1440 e 900;
//   M7     la FIXTURE di un server salvato dalle versioni di prima (URL con
//          {mattermost_host} letterale) aperta e mostrata dopo la migrazione;
//   M3     seconda corsa col TOKEN invece di OAuth: l'header che arriva al
//          server finto è ESATTAMENTE «Bearer <token>» (il «Bearer » lo mette
//          il template, l'utente incolla il valore soltanto).
//
// Ritocchi dopo la verifica (R1–R6):
//   R1     corsa NOTION: il server del catalogo (seedato, URL sul finto senza
//          auth) + la voce com.notion/mcp del registro finto installati
//          INSIEME → prefissi DIVERSI (mcp__notion__* / mcp__notion-2__*) e
//          callTool che instrada ciascuno sul SUO server (i due endpoint
//          rispondono ok:<endpoint>); la FIXTURE M7 si COLLEGA e dimostra che
//          la rinomina (nome tecnico → «Mattermost») NON cambia i nomi degli
//          strumenti (slug congelato, non tagliato);
//   R2     l'interruttore di «Tutti i bot» nel foglio MISURATO dal DOM (il top
//          dentro il box del nome), a 1440 e 900;
//   R3     l'etichetta vista del token e il pulsante che diventa «Collega»
//          (col campo pieno) e torna «Accedi con Mattermost» (svuotato);
//   R4     l'iniziale del foglio e il badge «Server MCP» sulla riga della
//          finestra App (mai ✦, mai «Diretta…»);
//   R5     niente «Nessuna configurazione in attesa.» nel foglio collegato e
//          il gruppo del modulo si chiama «Configurazione»;
//   R2     PROBE_ONLY=impostazioni (PROBE_TAG=prima|dopo): la cattura di
//          Impostazioni › Generali per provare che le Impostazioni RESTANO
//          COME SONO.
//
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea; mai il Portachiavi vero, mai la
// cartella dati vera: env SANDBOT_TEST_*), niente Docker, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const SHOTS = join(ROOT, 'docs', 'catture', 'mcp-setup')
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
const s256 = (verifier) => createHash('sha256').update(verifier).digest('base64url')

// ---- il TOKEN STATICO della seconda corsa (il «Bearer » lo mette il template) ----
const STATIC_TOKEN = 'tok-finto-mattermost'

// ---- la voce VERA di Mattermost (2026-11-04), URL puntato al server finto ----
const MATTERMOST_NAME = 'io.github.mattermost/mattermost-plugin-agents'
const mattermostEntry = (mcpUrlTemplate) => ({
  servers: [{
    server: {
      name: MATTERMOST_NAME,
      description: 'Official Mattermost MCP server, built into the Mattermost Agents plugin. Read, search and post.',
      title: 'Mattermost',
      repository: { url: 'https://github.com/mattermost/mattermost-plugin-agents', source: 'github' },
      version: '2.12.0',
      websiteUrl: 'https://github.com/mattermost/mattermost-plugin-agents/blob/master/docs/mcp_server.md',
      remotes: [{
        type: 'streamable-http',
        url: mcpUrlTemplate,
        headers: [{
          name: 'Authorization',
          description: 'Optional. OAuth 2.0 with dynamic client registration is the default and needs no header. To use a Mattermost Personal Access Token instead, set this to Bearer followed by the token.',
          value: 'Bearer {personal_access_token}',
          isSecret: true,
          variables: {
            personal_access_token: {
              description: 'Mattermost Personal Access Token (User Settings > Security > Personal Access Tokens).',
              isSecret: true
            }
          }
        }],
        variables: {
          mattermost_host: {
            description: 'Hostname of your own Mattermost server (add a port or subpath if your Site URL has one), for example chat.example.com. Requires the Mattermost Agents plugin with its HTTP MCP server enabled.',
            isRequired: true,
            placeholder: 'chat.example.com'
          }
        }
      }]
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } }
  }]
})

// ---- il REGISTRO FINTO (v0.1, la forma che il daemon parsa) ----
// R1: oltre a Mattermost serve anche com.notion/mcp (titolo «Notion», remote
// senza variabili): installata QUANDO c'è già il Notion del catalogo, deve
// ricevere un prefisso DIVERSO (notion-2)
let mcpTemplateUrl = ''
let mcpPort = 0
const registryServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/v0.1/servers') {
    const notionEntry = {
      server: {
        name: 'com.notion/mcp',
        description: 'Notion MCP',
        title: 'Notion',
        version: '1.0.0',
        remotes: [{ type: 'streamable-http', url: notionRegistroUrl }]
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } }
    }
    const body = JSON.stringify({ servers: [mattermostEntry(mcpTemplateUrl).servers[0], notionEntry] })
    res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => registryServer.listen(0, '127.0.0.1', r))
const registryUrl = `http://127.0.0.1:${registryServer.address().port}`

// ---- l'AS FINTO: metadati, DCR, authorize (approva subito), token (PKCE) ----
const asState = { registrations: 0, clients: new Map(), codes: new Map(), tokens: new Set() }
let asUrl = ''
const asServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return json(200, {
      issuer: asUrl,
      authorization_endpoint: `${asUrl}/oauth/authorize`,
      token_endpoint: `${asUrl}/oauth2/token`,
      registration_endpoint: `${asUrl}/oauth2/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp']
    })
  }
  if (req.method === 'POST' && url.pathname === '/oauth2/register') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      asState.registrations++
      const meta = JSON.parse(body)
      const clientId = `client_${asState.registrations}`
      asState.clients.set(clientId, meta)
      json(201, { client_id: clientId, redirect_uris: meta.redirect_uris ?? [] })
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
    const clientId = url.searchParams.get('client_id') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const challenge = url.searchParams.get('code_challenge') ?? ''
    const method = url.searchParams.get('code_challenge_method') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (!asState.clients.has(clientId)) return json(400, { error: 'unauthorized_client' })
    if (!(asState.clients.get(clientId).redirect_uris ?? []).includes(redirectUri)) return json(400, { error: 'invalid_request' })
    if (!challenge || method !== 'S256') return json(400, { error: 'invalid_request', error_description: 'pkce' })
    // il «login finto»: approva subito e torna al callback di loopback
    const code = 'code_' + randomBytes(6).toString('hex')
    asState.codes.set(code, { challenge, redirectUri })
    res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` }).end()
    return
  }
  if (req.method === 'POST' && url.pathname === '/oauth2/token') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code') {
        const issued = asState.codes.get(params.get('code') ?? '')
        if (!issued || s256(params.get('code_verifier') ?? '') !== issued.challenge) return json(400, { error: 'invalid_grant' })
        asState.codes.delete(params.get('code'))
        const access = 'ACCESS_' + randomBytes(6).toString('hex')
        asState.tokens.add(access)
        return json(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: 'REFRESH_' + randomBytes(4).toString('hex') })
      }
      json(400, { error: 'unsupported_grant_type' })
    })
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => asServer.listen(0, '127.0.0.1', r))
asUrl = `http://127.0.0.1:${asServer.address().port}`

// ---- il SERVER MCP FINTO di Mattermost: OAuth O Bearer statico, 2 strumenti ----
// registra OGNI Authorization ricevuto sul canale MCP (la seconda corsa
// verifica che sia ESATTAMENTE «Bearer <token>»). Per R1 due endpoint SENZA
// auth (i due «Notion»: il server del catalogo e la voce com.notion/mcp del
// registro) che rispondono `ok:<endpoint>` a tools/call: così si vede a QUALE
// server instrada callTool per prefisso.
const mcpState = { url: '', authorizations: [], mcpCalls: [] }
const MCP_TOOLS = [
  { name: 'mattermost_search', description: 'Search messages', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'mattermost_post', description: 'Post a message', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } } } }
]
const NOTION_TOOLS = [
  { name: 'notion_search', description: 'Search pages', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'notion_post', description: 'Create a page', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }
]
const NOAUTH_ENDPOINTS = new Set() // '/notion-catalogo/mcp', '/notion-registro/mcp' (riempiti sotto)
const mcpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (code, body, headers = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return json(200, { resource: mcpState.url, authorization_servers: [asUrl] })
  }
  // R1: i due Notion finti, senza auth — tools/call risponde ok:<endpoint>
  if (req.method === 'POST' && NOAUTH_ENDPOINTS.has(url.pathname)) {
    let nb = ''
    req.on('data', (c) => (nb += c))
    req.on('end', () => {
      let msg = null
      try { msg = JSON.parse(nb) } catch { res.writeHead(400).end(); return }
      const send = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      if (msg.method === 'initialize') {
        return send({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'notion-finto', version: '1.0.0' } })
      }
      if (String(msg.method).startsWith('notifications/')) {
        res.writeHead(202).end()
        return
      }
      if (msg.method === 'tools/list') return send({ tools: NOTION_TOOLS })
      if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: `ok:${url.pathname}` }] })
      send({})
    })
    return
  }
  if (req.method !== 'POST' || url.pathname !== '/plugins/mattermost-ai/mcp-server/mcp') {
    res.writeHead(404).end()
    return
  }
  const auth = req.headers.authorization ?? ''
  const ok = (auth.startsWith('Bearer ') && (asState.tokens.has(auth.slice(7)) || auth.slice(7) === STATIC_TOKEN))
  if (!ok) {
    mcpState.authorizations.push(auth)
    return json(401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' } }, {
      'www-authenticate': `Bearer resource_metadata="http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource"`
    })
  }
  mcpState.authorizations.push(auth)
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    mcpState.mcpCalls.push(body.slice(0, 200))
    let msg = null
    try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
    const send = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    if (msg.method === 'initialize') {
      return send({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mattermost-finto', version: '2.12.0' } })
    }
    if (String(msg.method).startsWith('notifications/')) {
      res.writeHead(202).end()
      return
    }
    if (msg.method === 'tools/list') return send({ tools: MCP_TOOLS })
    if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: 'ok' }] })
    send({})
  })
})
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r))
mcpPort = mcpServer.address().port
mcpState.url = `http://127.0.0.1:${mcpPort}/plugins/mattermost-ai/mcp-server/mcp`
mcpTemplateUrl = `http://{mattermost_host}/plugins/mattermost-ai/mcp-server/mcp`
// R1: gli URL dei due Notion (catalogo e registro) sui due endpoint senza auth
const notionCatalogoUrl = `http://127.0.0.1:${mcpPort}/notion-catalogo/mcp`
const notionRegistroUrl = `http://127.0.0.1:${mcpPort}/notion-registro/mcp`
NOAUTH_ENDPOINTS.add('/notion-catalogo/mcp')
NOAUTH_ENDPOINTS.add('/notion-registro/mcp')
log(`registro finto ${registryUrl} · AS finto ${asUrl} · server MCP finto ${mcpState.url}`)

// ---- il provider FINTO (openai-compatible, SSE su 127.0.0.1) ----
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => script.push({ text })
const chatRequests = []
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      chatRequests.push(JSON.parse(body))
      const next = script.shift() ?? { text: 'ok' }
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

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

/** Lancia l'app su una cartella dati (env -i + SANDBOT_TEST_*: mai i dati veri). */
const launchApp = (dataDir, debugPort) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: dataDir,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
      // il registro finto e i remoti http di test (SOLO 127.0.0.1)
      SANDBOT_TEST_REGISTRY_URL: registryUrl,
      SANDBOT_TEST_ALLOW_HTTP_REMOTES: '1',
      SANDBOT_WEB_FETCH_ALLOW_LOOPBACK: '1',
      // il «browser» che segue i redirect fino al callback di loopback
      SANDBOT_TEST_FAKE_BROWSER: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let appLog = ''
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  return { app, getLog: () => appLog, stop: () => { try { app.kill('SIGTERM') } catch { /* già via */ } } }
}

/** Il pid del daemon di QUESTA cartella dati (daemon.lock), se già scritto. */
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
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
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

/** Il contesto di una corsa dell'app. */
async function run(debugPort) {
  const page = await connectPage(debugPort)
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
  const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await pageEval(`return !!(${exprTrue})`)) return true
      if (Date.now() > deadline) return false
      await sleep(step)
    }
  }
  const setWindowWidth = async (width, height = 900) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
    await sleep(700)
  }
  const shot = (name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
    log('cattura', name)
  })
  return { page, pageEval, rpc, waitDom, setWindowWidth, shot }
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
  const el = els.find((x) => {
    const t = x.textContent.trim()
    return (${exact ? 't === want' : 't.includes(want)'}) && x.offsetParent !== null
  })
  if (!el) throw new Error('non trovato: ' + want)
  el.click()
  return 'cliccato: ' + want
`)
/** Scrive in un input con l'evento input di React (valore nativo). */
const setInput = (pageEval, selector, value, index = 0) => pageEval(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => x.offsetParent !== null)[${index}]
  if (!el) throw new Error('campo non trovato: ' + ${JSON.stringify(selector)})
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'scritto'
`)
const uiSend = (pageEval, text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 120))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'inviato'
`)
const setDark = async (pageEval, dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(250)
}
const scrollIntoView = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  el?.scrollIntoView({ block: 'center' })
  return el ? 'scrolled' : 'null'
`)

/**
 * Apre la finestra App dal bottone della barra (aria-label, come le sonde di
 * prima). RIPROVA: un re-render del turno in corso può staccare il nodo fra
 * la ricerca e il clic (il clic si perde su un nodo morto).
 */
const openAppWindow = async (r) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    await pointerClick(r.pageEval, `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') === 'App' || b.title === 'App') && b.offsetParent !== null)`)
    if (await r.waitDom(`!!document.querySelector('[data-testid="app-filters"]')`, 2500)) return true
  }
  return false
}
/** Il dialogo della finestra App (il primo [role=dialog] con i filtri dentro). */
const APP_DIALOG = `(document.querySelector('[data-testid="app-filters"]')?.closest('[role="dialog"]') ?? document)`

/** Prepara una corsa: provider finto, bot, modello, 1440. */
const setupBot = async (r) => {
  await r.rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await r.rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await r.rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await r.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await r.page.send('Page.reload')
  await r.waitDom(`typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 30_000)
  await r.setWindowWidth(1440)
  return bot
}

/** Il testo della card server (il primo [data-testid=mcp-server-card] o la card nel transcript). */
const CARD = `(document.querySelector('[data-testid="mcp-server-card"]') ?? [...document.querySelectorAll('div')].find((d) => d.className && String(d.className).includes && String(d.className).includes('rounded') && d.textContent.includes('Aggiungi server MCP')) ?? document.body)`

/**
 * Chiude il FOGLIO dentro la finestra App col clic VERO sul fondo del suo
 * overlay (l'Esc sintetico su window non raggiunge i listener del documento;
 * il punto è a sinistra a metà altezza: fondo dell'overlay, mai la fascia di
 * trascinamento in cima, mai il foglio al centro).
 */
const closeSheetOverlay = async (r) => {
  if (!(await r.pageEval(`return !!document.querySelector('[data-testid="server-sheet"]')`))) return true
  await r.pageEval(`
    const sheet = document.querySelector('[data-testid="server-sheet"]')
    const overlay = sheet.closest('div.fixed.inset-0')
    if (!overlay) return 'no-overlay'
    const rc = overlay.getBoundingClientRect()
    document.elementFromPoint(Math.round(rc.left + 6), Math.round(rc.top + rc.height / 2))?.click()
    return 'fondo'
  `)
  await sleep(600)
  return !(await r.pageEval(`return !!document.querySelector('[data-testid="server-sheet"]')`))
}

/**
 * Chiude la finestra App: prima l'eventuale foglio (clic sul fondo), poi il
 * bottone «Chiudi» della finestra — con VERIFICA (dopo i resize la chiusura
 * può arrivare in ritardo).
 */
const closeAppWindow = async (r) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await closeSheetOverlay(r)
    const chiudi = await r.pageEval(`return !![...document.querySelectorAll('button[aria-label="Chiudi"]')].find((b) => b.offsetParent !== null)`)
    if (chiudi) {
      await pointerClick(r.pageEval, `[...document.querySelectorAll('button[aria-label="Chiudi"]')].find((b) => b.offsetParent !== null)`)
      await sleep(700)
    }
    if (!(await r.pageEval(`return !!document.querySelector('[data-testid="app-filters"]')`))) return true
  }
  return false
}

/**
 * Chiude il pannello del bot se è aperto (i cambi di larghezza possono
 * riaprirlo e su 900 copre la chat: le catture della card devon mostrare la
 * card, non il pannello).
 */
const closeBotPanel = async (r) => {
  for (let i = 0; i < 3; i++) {
    const open = await r.pageEval(`return !![...document.querySelectorAll('button[aria-label="Nascondi il pannello del bot"]')].find((b) => b.offsetParent !== null)`)
    if (!open) return true
    await pointerClick(r.pageEval, `[...document.querySelectorAll('button[aria-label="Nascondi il pannello del bot"]')].find((b) => b.offsetParent !== null)`)
    await sleep(400)
  }
  return false
}

/** Porta il foglio in CIMA (l'intestazione dev'essere nella cattura). */
const sheetToTop = (pageEval) => pageEval(`
  const sheet = document.querySelector('[data-testid="server-sheet"]')
  const scrollable = sheet?.closest('.overflow-y-auto') ?? sheet
  if (scrollable) scrollable.scrollTop = 0
  return 'top'
`)

/**
 * R2 (ritocchi): l'interruttore di «Tutti i bot» sta SULLA STESSA RIGA del
 * nome — il `top` dell'interruttore deve stare DENTRO il box del nome
 * (misurato dal DOM, non dall'aspetto della cattura).
 */
const toggleSameRowCheck = async (r) => {
  const m = await r.pageEval(`return (() => {
    const sheet = document.querySelector('[data-testid="server-sheet"]')
    if (!sheet) return { found: false }
    const rows = [...sheet.querySelectorAll(':scope > div, :scope > div > div')]
    const row = [...sheet.querySelectorAll('div')].find((d) => d.textContent.trim().startsWith('Tutti i bot') && d.querySelector('button[role="switch"]'))
    if (!row) return { found: false }
    const name = [...row.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Tutti i bot')
    const toggle = row.querySelector('button[role="switch"]')
    if (!name || !toggle) return { found: false }
    const n = name.getBoundingClientRect()
    const t = toggle.getBoundingClientRect()
    return { found: true, nameTop: n.top, nameBottom: n.bottom, toggleTop: t.top, toggleBottom: t.bottom, rowClass: String(row.className).slice(0, 60) }
  })()`)
  const ok = m.found === true && m.toggleTop >= m.nameTop - 1 && m.toggleTop <= m.nameBottom + 1
  check(`R2 l'interruttore di «Tutti i bot» è sulla STESSA riga del nome (top ${Math.round(m.toggleTop ?? -1)} nel box ${Math.round(m.nameTop ?? -1)}–${Math.round(m.nameBottom ?? -1)})`,
    ok, ok ? '' : JSON.stringify(m).slice(0, 160))
  return ok
}

/** Una corsa completa della sonda: OAuth o token, a seconda di `mode`. */
async function corsa(mode, dataDir, debugPort) {
  const main = launchApp(dataDir, debugPort)
  try {
    let r
    try {
      r = await run(debugPort)
    } catch (e) {
      throw new Error('pagina CDP non raggiunta: ' + (e?.message ?? e) + '\nlog app:\n' + main.getLog().slice(-1200))
    }
    if (!(await r.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile dopo 40s')
    }
    const bot = await setupBot(r)

    // ============ il bot propone il server del registro (M2/M4, prima dell'Aggiungi) ============
    pushTool('add_mcp_server', { id: `registry:${MATTERMOST_NAME}`, reason: 'per leggere e scrivere su Mattermost' })
    pushText(mode === 'oauth' ? 'Ti ho preparato il collegamento a Mattermost.' : 'Ecco Mattermost: servono l\'indirizzo e un token.')
    // lo stesso messaggio corto per le due corse: la bolla lunga a 900 finiva
    // sotto l'intestazione fissa (cattura sporca, non un difetto dell'app)
    await uiSend(r.pageEval, 'Collega mattermost')
    check(`${mode}: la card «Aggiungi server MCP: Mattermost» compare in chat`,
      await r.waitDom(`${CARD}.textContent.includes('Aggiungi server MCP: Mattermost')`, 30_000))
    const cardText1 = await r.pageEval(`return ${CARD}.textContent`)
    check(`${mode}: M2/M4.1 il nome è «Mattermost», il nome tecnico NON è in card`,
      cardText1.includes('Mattermost') && !cardText1.includes(MATTERMOST_NAME), cardText1.slice(0, 120))
    check(`${mode}: M4.1 «Dove gira: sul server Mattermost che indichi tu» (niente graffe)`,
      cardText1.includes('sul server Mattermost che indichi tu') && !cardText1.includes('{mattermost_host}'))
    check(`${mode}: M4.1 «Accesso: con il tuo account (si apre il browser)»`,
      cardText1.includes('Accesso: con il tuo account'))
    check(`${mode}: M4.1 MAI «serve: una chiave» né «Impostazioni» in card`,
      !cardText1.includes('serve:') && !cardText1.includes('Impostazioni'))
    await scrollIntoView(r.pageEval, CARD)
    await sleep(300)
    if (mode === 'oauth') {
      // ritocchi: la matrice COMPLETA della card (chiaro/scuro × 1440/900 — le
      // catture della card a 900 mancavano); il pannello del bot CHIUSO, che
      // sui resize può riaprirsi e coprire la chat
      for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
        await r.setWindowWidth(w)
        await closeBotPanel(r)
        await setDark(r.pageEval, dark)
        await closeBotPanel(r)
        await scrollIntoView(r.pageEval, CARD)
        await sleep(300)
        await r.shot(`card-prima-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
      }
      await setDark(r.pageEval, false)
      await r.setWindowWidth(1440)
    }

    // ============ «Aggiungi» → la card DIVENTA il modulo (M4.2) ============
    await clickText(r.pageEval, 'Aggiungi', 'button', true)
    check(`${mode}: M4.2 la card diventa il modulo «Ultimo passo: collega Mattermost»`,
      await r.waitDom(`${CARD}.textContent.includes('Ultimo passo: collega Mattermost') && !!document.querySelector('[data-testid="mcp-card-setup"]')`, 20_000))
    check(`${mode}: M3 il campo dell'indirizzo c'è, con la descrizione del registro e il placeholder`,
      await r.waitDom(`!!document.querySelector('[data-testid="setup-field-mattermost_host"][placeholder="chat.example.com"]')`, 8000) &&
      (await r.pageEval(`return ${CARD}.textContent`)).includes('Hostname of your own Mattermost server'))
    check(`${mode}: M3 il bottone «Accedi con Mattermost» c'è ed è DISATTIVO finché l'indirizzo manca`,
      await r.waitDom(`!![...document.querySelectorAll('[data-testid="setup-connect"]')].find((b) => b.textContent.trim() === 'Accedi con Mattermost' && b.disabled)`, 8000))
    if (mode === 'oauth') {
      // R5: l'etichetta di gruppo è «Configurazione» (niente più «Per farlo partire»)
      const moduloText = await r.pageEval(`return ${CARD}.textContent`)
      check('oauth: R5 il gruppo del modulo si chiama «Configurazione» (mai «Per farlo partire»)',
        moduloText.includes('Configurazione') && !moduloText.includes('Per farlo partire'), moduloText.slice(0, 80))
      for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
        await r.setWindowWidth(w)
        await closeBotPanel(r)
        await setDark(r.pageEval, dark)
        await closeBotPanel(r)
        await scrollIntoView(r.pageEval, CARD)
        await sleep(300)
        await r.shot(`card-modulo-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
      }
      await setDark(r.pageEval, false)
      await r.setWindowWidth(1440)
    }

    // ============ la finestra App: «Da completare» PRIMA (M6.1) ============
    if (mode === 'oauth') {
      check('oauth: M6.1 la finestra App mostra la riga «Da completare»',
        await openAppWindow(r) && await r.waitDom(`!!document.querySelector('[data-testid="server-status-setup"]')`, 10_000))
      await sleep(500)
      // R4: l'icona della riga è QUELLA del foglio (l'iniziale «M», non ✦) e il
      // badge dice «Server MCP», non «Diretta: il permesso resta sul tuo Mac»
      const rowDa = await r.pageEval(`return (() => {
        const row = document.querySelector('[data-testid^="server-row-"]')
        if (!row) return { found: false }
        const icon = [...row.querySelectorAll('span')].find((s) => s.className.includes('bg-muted') && s.textContent.trim().length <= 2)
        return { found: true, icon: icon ? icon.textContent.trim() : null, badge: row.querySelector('[data-testid="server-row-mcp-tag"]')?.textContent.trim() ?? null, text: row.textContent.trim().slice(0, 80) }
      })()`)
      check('oauth: R4 la riga ha l\'iniziale «M» del foglio (non ✦)', rowDa.found === true && rowDa.icon === 'M', JSON.stringify(rowDa).slice(0, 120))
      check('oauth: R4 il badge della riga è «Server MCP» (mai «Diretta: il permesso resta sul tuo Mac»)',
        rowDa.badge === 'Server MCP' && !String(rowDa.text).includes('Diretta'), JSON.stringify(rowDa).slice(0, 160))
      await r.shot('app-riga-da-completare-1440-chiaro.png')

    // ============ il foglio del server (M6.2) in chiaro e scuro ============
      // la riga del server apre il foglio sul modulo
      await r.pageEval(`document.querySelector('[data-testid^="server-row-"]')?.click(); return 'riga'`)
      check('oauth: M6.2 il foglio si apre: nome umano, «Server MCP · Pubblicato da mattermost», stato «Da completare»',
        await r.waitDom(`!!document.querySelector('[data-testid="server-sheet"]')`, 8000) &&
        (await r.pageEval(`return document.querySelector('[data-testid="server-sheet"]').textContent`)).includes('Pubblicato da mattermost') &&
        (await r.pageEval(`return !!document.querySelector('[data-testid="server-sheet-setup"]')`)))
      const sheetNoBadge = await r.pageEval(`return document.querySelector('[data-testid="server-sheet"]').textContent`)
      check('oauth: M6.2 via il badge REGISTRY, il pallino e «salva cifrato»',
        !/REGISTRY/.test(sheetNoBadge) && !sheetNoBadge.includes('salva cifrato') && !sheetNoBadge.includes('Server del registro pubblico. Chiavi'))
      await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="server-sheet"]')`)
      await sheetToTop(r.pageEval)
      await sleep(400)
      await r.shot('foglio-da-completare-1440-chiaro.png')
      await setDark(r.pageEval, true)
      // il tema scuro deve ASSESTARSI (finestra e foglio): 250 ms possono
      // bastare a metà transizione — cattura con la finestra ancora chiara
      await sleep(900)
      await sheetToTop(r.pageEval)
      await r.shot('foglio-da-completare-1440-scuro.png')
      await setDark(r.pageEval, false)
      await closeAppWindow(r)
    }

    // ============ l'indirizzo e il collegamento (M3/M4.3) ============
    await setInput(r.pageEval, '[data-testid="setup-field-mattermost_host"]', `127.0.0.1:${mcpPort}`)
    await sleep(300)
    check(`${mode}: M3 il bottone si ATTIVA con l'indirizzo pieno`,
      await r.waitDom(`!![...document.querySelectorAll('[data-testid="setup-connect"]')].find((b) => !b.disabled)`, 8000))

    if (mode === 'token') {
      // M3.2: il token sotto «Avanzate» — l'utente scrive SOLO il valore.
      // R3: il campo ha l'ETICHETTA vista sopra e, appena il token c'è, il
      // pulsante diventa «Collega» (la via OAuth si attenua); svuotandolo si
      // torna ad «Accedi con Mattermost»
      await clickText(r.pageEval, 'Avanzate', '[data-testid="mcp-card-setup"] button')
      await sleep(400)
      check('token: R3 sopra il campo c\'è l\'etichetta VISTA «Token di accesso (facoltativo)»',
        await r.waitDom(`!![...document.querySelectorAll('[data-testid="setup-token-label"]')].find((l) => l.offsetParent !== null && l.textContent.trim() === 'Token di accesso (facoltativo)')`, 6000))
      await setInput(r.pageEval, '[data-testid="setup-token-authorization"]', STATIC_TOKEN)
      await sleep(300)
      const withToken = await r.pageEval(`return (() => {
        const btn = [...document.querySelectorAll('[data-testid="setup-connect"]')].find((b) => b.offsetParent !== null)
        return { label: btn ? btn.textContent.trim() : null }
      })()`)
      check('token: R3 col token scritto il pulsante diventa «Collega»', withToken.label === 'Collega', JSON.stringify(withToken))
      // la riga «Con il tuo account» si attenua: la transizione è breve, si
      // aspetta che l'opacity si ASSETI sotto 1
      const rowOpacityExpr = `(() => {
        const nameSpan = [...document.querySelectorAll('[data-testid="mcp-card-setup"] span')].find((x) => x.textContent.trim() === 'Con il tuo account')
        const row = nameSpan ? nameSpan.closest('div') : null // il div della SettingsRow (muted)
        return row ? getComputedStyle(row).opacity : null
      })()`
      let dimmed = null
      for (let i = 0; i < 20; i++) {
        dimmed = await r.pageEval(`return ${rowOpacityExpr}`)
        if (dimmed !== null && Number(dimmed) < 1) break
        await sleep(150)
      }
      check('token: R3 la via «Con il tuo account» si attenua (opacity < 1)', dimmed !== null && Number(dimmed) < 1, String(dimmed))
      // svuotando il campo si torna ad «Accedi con Mattermost»
      await setInput(r.pageEval, '[data-testid="setup-token-authorization"]', '')
      await sleep(300)
      const noToken = await r.pageEval(`return [...document.querySelectorAll('[data-testid="setup-connect"]')].find((b) => b.offsetParent !== null)?.textContent.trim() ?? null`)
      check('token: R3 svuotando il campo si torna ad «Accedi con Mattermost»', noToken === 'Accedi con Mattermost', String(noToken))
      await setInput(r.pageEval, '[data-testid="setup-token-authorization"]', STATIC_TOKEN)
      await sleep(200)
      for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
        await r.setWindowWidth(w)
        await closeBotPanel(r)
        await setDark(r.pageEval, dark)
        await closeBotPanel(r)
        await scrollIntoView(r.pageEval, CARD)
        // la bolla del messaggio finiva sotto l'intestazione fissa (a 900 la
        // tocca): si scorre ancora un po', così esce dall'inquadratura e la
        // cattura mostra la card pulita
        await r.pageEval(`
          const card = ${CARD}
          const sc = card?.closest('.overflow-y-auto, .scroll-thin')
          if (sc) sc.scrollTop += 90
          return 'scroll+90'
        `)
        await sleep(300)
        await r.shot(`card-modulo-token-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
      }
      await setDark(r.pageEval, false)
      await r.setWindowWidth(1440)
    }
    const auths0 = mcpState.authorizations.length
    // il pulsante principale: «Accedi con Mattermost» in OAuth, «Collega» col token (R3)
    await (mode === 'token'
      ? clickText(r.pageEval, 'Collega', '[data-testid="setup-connect"]', true)
      : clickText(r.pageEval, 'Accedi con Mattermost', 'button', true))
    // «Provo a collegarmi…» poi l'esito
    check(`${mode}: M3.3 l'esito di mezzo «Provo a collegarmi…»`,
      await r.waitDom(`!!document.querySelector('[data-testid="setup-connecting"]')`, 6000))
    check(`${mode}: M4.3 la card si chiude in «✓ Mattermost collegato · 2 strumenti»`,
      await r.waitDom(`!!document.querySelector('[data-testid="mcp-card-connected"]')`, 40_000))
    const doneText = await r.pageEval(`return document.querySelector('[data-testid="mcp-card-connected"]').textContent`)
    check(`${mode}: M4.3 la riga dice 2 strumenti`, doneText.includes('2 strumenti'), doneText)
    if (mode === 'oauth') {
      for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
        await r.setWindowWidth(w)
        await closeBotPanel(r)
        await setDark(r.pageEval, dark)
        await closeBotPanel(r)
        await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="mcp-card-connected"]')`)
        await sleep(300)
        await r.shot(`card-collegato-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
      }
      await setDark(r.pageEval, false)
      await r.setWindowWidth(1440)
      // l'OAuth è GIRATO davvero: PRM → AS → DCR → authorize → token (PKCE)
      check('oauth: OAuth con DCR: il client finto si è registrato e il token è stato emesso',
        asState.registrations >= 1 && asState.tokens.size >= 1, `DCR: ${asState.registrations}, token: ${asState.tokens.size}`)
    } else {
      // la seconda corsa: l'header che arriva al server finto è ESATTAMENTE «Bearer <token>»
      await sleep(800)
      const seen = mcpState.authorizations.slice(auths0)
      check('token: l\'header arrivato al server finto è ESATTAMENTE «Bearer ' + STATIC_TOKEN + '»',
        seen.some((a) => a === `Bearer ${STATIC_TOKEN}`), JSON.stringify(seen.slice(0, 4)))
    }

    // ============ il bot riceve CONNECTOR_CONNECTED (M5.2) ============
    const gotNotify = await (async () => {
      for (let i = 0; i < 40; i++) {
        const entries = await r.rpc(`getEntries(${JSON.stringify(bot.id)})`)
        const hit = entries.find((e) => e.meta?.initiator === 'CONNECTOR_CONNECTED')
        if (hit) return hit
        await sleep(500)
      }
      return null
    })()
    check(`${mode}: M5.2 il bot riceve CONNECTOR_CONNECTED con i nomi mcp__mattermost__*`,
      Boolean(gotNotify) && /mcp__mattermost__\*/.test(String(gotNotify?.content ?? '')),
      String(gotNotify?.content ?? '').slice(0, 120))

    // ============ la finestra App: «Connessa» DOPO + il foglio (M6) ============
    const opened = await openAppWindow(r)
    const connessa = opened && (await r.waitDom(`[...document.querySelectorAll('[data-testid^="server-row-"]')].some((el) => el.textContent.trim().endsWith('Connessa'))`, 10_000))
    const rowDump = connessa ? '' : String(await r.pageEval(`return [...document.querySelectorAll('[data-testid^="server-row-"]')].map((el) => el.textContent.trim()).join(' || ')`)) +
      ' || RPC: ' + JSON.stringify((await r.rpc('connectorsInstalled()').catch((e) => 'ERR ' + e.message))).slice(0, 400)
    check(`${mode}: M6.1 la riga dice «Connessa»`, connessa, rowDump.slice(0, 200))
    if (mode === 'oauth') {
      await sleep(400)
      // R4 anche sulla riga CONNESSA: iniziale «M» e badge «Server MCP»
      const rowCon = await r.pageEval(`return (() => {
        const row = document.querySelector('[data-testid^="server-row-"]')
        if (!row) return { found: false }
        const icon = [...row.querySelectorAll('span')].find((s) => s.className.includes('bg-muted') && s.textContent.trim().length <= 2)
        return { found: true, icon: icon ? icon.textContent.trim() : null, badge: row.querySelector('[data-testid="server-row-mcp-tag"]')?.textContent.trim() ?? null, text: row.textContent.trim().slice(0, 80) }
      })()`)
      check('oauth: R4 la riga CONNESSA ha l\'iniziale «M» e il badge «Server MCP»',
        rowCon.icon === 'M' && rowCon.badge === 'Server MCP' && !String(rowCon.text).includes('Diretta'), JSON.stringify(rowCon).slice(0, 160))
      await r.shot('app-riga-connessa-1440-chiaro.png')
      // il foglio dopo il collegamento: Avanzate con l'indirizzo RISOLTO
      await r.pageEval(`document.querySelector('[data-testid^="server-row-"]')?.click(); return 'riga'`)
      check('oauth: M6.2 il foglio del server collegato: gruppo «Bot che lo usano» con «Tutti i bot»',
        await r.waitDom(`!!document.querySelector('[data-testid="server-sheet"]')`, 8000) &&
        (await r.pageEval(`return document.querySelector('[data-testid="server-sheet"]').textContent`)).includes('Bot che lo usano'))
      // R5: nel foglio collegato NON c'è più «Nessuna configurazione in attesa.»
      // (lo stato in alto dice già «Connessa»)
      const sheetText0 = await r.pageEval(`return document.querySelector('[data-testid="server-sheet"]').textContent`)
      check('oauth: R5 il foglio collegato NON dice «Nessuna configurazione in attesa.»', !sheetText0.includes('Nessuna configurazione in attesa'), sheetText0.slice(0, 80))
      // Avanzate: l'indirizzo RISOLTO (senza graffe), il nome tecnico, «Rimuovi»
      await clickText(r.pageEval, 'Avanzate', '[data-testid="server-sheet"] button')
      await sleep(400)
      const advText = await r.pageEval(`return document.querySelector('[data-testid="server-sheet"]').textContent`)
      check('oauth: M6.2 Avanzate: indirizzo RISOLTO senza graffe + nome tecnico + Rimuovi',
        advText.includes(`127.0.0.1:${mcpPort}/plugins/mattermost-ai/mcp-server/mcp`) && !advText.includes('{mattermost_host}') &&
        advText.includes(MATTERMOST_NAME) && advText.includes('Rimuovi') && advText.includes('I token stanno cifrati'), '')
      // «Rimuovi» con conferma (il bottone rosso non disinstalla subito)
      const confirmShown = await r.pageEval(`
        const btn = [...document.querySelectorAll('[data-testid="server-sheet"] button')].find((b) => b.textContent.trim() === 'Rimuovi')
        if (!btn) return 'no bottone'
        btn.click(); await new Promise((res) => setTimeout(res, 300))
        return [...document.querySelectorAll('[data-testid="server-sheet"] button')].some((b) => b.textContent.trim() === 'Rimuovi davvero') ? 'conferma' : 'subito'
      `)
      check('oauth: M6.2 «Rimuovi» chiede conferma («Rimuovi davvero»)', confirmShown === 'conferma', confirmShown)
      // la matrice del foglio: si RIAPRE pulito (Avanzate CHIUSO e «Rimuovi»
      // normale, com'è all'apertura) — chiaro e scuro, 1440 e 900, con la
      // MISURA R2 dell'interruttore (stessa riga del nome) a OGNI larghezza
      await closeSheetOverlay(r)
      await r.pageEval(`document.querySelector('[data-testid^="server-row-"]')?.click(); return 'riga'`)
      await r.waitDom(`!!document.querySelector('[data-testid="server-sheet"]')`, 8000)
      for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
        await r.setWindowWidth(w)
        await setDark(r.pageEval, dark)
        await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="server-sheet"]')`)
        await sheetToTop(r.pageEval)
        await sleep(350)
        await r.shot(`foglio-collegato-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
        if (!dark) await toggleSameRowCheck(r)
      }
      await setDark(r.pageEval, false)
      await r.setWindowWidth(1440)
    }
    await closeAppWindow(r)
    return { r, main, bot }
  } catch (e) {
    failures++
    console.error(`\n[sonda] ERRORE (corsa ${mode}):`, e.message ?? e)
    try { console.error('--- daemon.log ---\n' + readFileSync(join(dataDir, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
    console.error(main.getLog().slice(-1200))
    return { r: null, main, error: e }
  }
}

const ONLY = process.env.PROBE_ONLY ?? 'all'
try {
  // ============================ la corsa OAuth ============================
  const TMP1 = mkdtempSync(TMP_BASE + 'sandbot-fase-mcp-setup-')
  const DATA1 = join(TMP1, 'data')
  mkdirSync(DATA1, { recursive: true })
  const c1 = await corsa('oauth', DATA1, 9351)
  c1.main?.stop()
  await sleep(800)
  await stopDaemon(DATA1)

  // ============================ la corsa TOKEN ============================
  if (ONLY === 'all' || ONLY === 'token') {
  const TMP2 = mkdtempSync(TMP_BASE + 'sandbot-fase-mcp-setup-')
  const DATA2 = join(TMP2, 'data')
  mkdirSync(DATA2, { recursive: true })
  const c2 = await corsa('token', DATA2, 9352)
  c2.main?.stop()
  await sleep(800)
  await stopDaemon(DATA2)
  }

  // ==================== la corsa NOTION (ritocchi R1) ====================
  // il Notion del CATALOGO (seedato prima del boot, URL sul server finto SENZA
  // auth) + la voce com.notion/mcp del REGISTRO finto installata dal bot:
  // stessi strumenti, prefissi DIVERSI (notion / notion-2) e callTool che
  // instrada ciascuno sul SUO server (i due endpoint rispondono ok:<endpoint>)
  if (ONLY === 'all' || ONLY === 'notion') {
  const TMPN = mkdtempSync(TMP_BASE + 'sandbot-fase-mcp-setup-')
  const DATAN = join(TMPN, 'data') // la cartella dati del daemon (come la fixture)
  mkdirSync(DATAN, { recursive: true })
  {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(DATAN, 'sandbot.db'))
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('mcp.servers', JSON.stringify([{
      id: 'notion', name: 'Notion', transport: 'http', url: notionCatalogoUrl, enabled: true,
      auth: { kind: 'headers' }, catalogId: 'notion', enabledFor: ['*']
    }]))
    db.close()
  }
  const nApp = launchApp(TMPN, 9354)
  try {
    const n = await run(9354)
    if (!(await n.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile (notion)')
    }
    const bot = await setupBot(n)
    // il server del catalogo, così come lo registra il catalogo: i suoi
    // strumenti sono mcp__notion__*
    const cat = await n.rpc('mcpTest("notion")')
    check('R1 il Notion del catalogo collega al finto: strumenti mcp__notion__*',
      cat?.ok === true && (cat.tools ?? []).some((t) => t === 'mcp__notion__notion_search'), JSON.stringify(cat?.tools ?? cat).slice(0, 120))
    // la lettura del registro-notion-2 passa da una grant readOnly (il server
    // del registro non ha l'auto-consenso del catalogo)
    await n.rpc('grantServerReads("notion-2")')
    // il bot propone la voce del registro: stessa etichetta «Notion»
    pushTool('add_mcp_server', { id: 'registry:com.notion/mcp', reason: 'per leggere le pagine Notion' })
    pushText('Ti ho preparato Notion.')
    await uiSend(n.pageEval, 'Collega notion dal registro')
    check('R1 la card «Aggiungi server MCP: Notion» (dal registro) compare in chat',
      await n.waitDom(`${CARD}.textContent.includes('Aggiungi server MCP: Notion')`, 30_000))
    await clickText(n.pageEval, 'Aggiungi', 'button', true)
    // niente variabili: il server parte SUBITO e la card si chiude collegata
    check('R1 la voce del registro si installa e collega (card collegata)',
      await n.waitDom(`!!document.querySelector('[data-testid="mcp-card-connected"]')`, 30_000))
    // il bot riceve CONNECTOR_CONNECTED col prefisso notion-2
    const notify = await (async () => {
      for (let i = 0; i < 40; i++) {
        const entries = await n.rpc(`getEntries(${JSON.stringify(bot.id)})`)
        const hit = entries.find((e) => e.meta?.initiator === 'CONNECTOR_CONNECTED')
        if (hit) return hit
        await sleep(500)
      }
      return null
    })()
    check('R1 il bot riceve CONNECTOR_CONNECTED con i nomi mcp__notion-2__* (il titolo è lo stesso «Notion»)',
      Boolean(notify) && /mcp__notion-2__\*/.test(String(notify?.content ?? '')), String(notify?.content ?? '').slice(0, 120))
    // i DUE prefissi, dal vivo: entrambi i server collegati al finto
    const servers = await n.rpc('mcpList()')
    const reg = (servers ?? []).find((s) => s.source?.name === 'com.notion/mcp')
    const catCfg = (servers ?? []).find((s) => s.catalogId === 'notion')
    check('R1 il toolSlug del registro è notion-2 (quello del catalogo resta notion: il nome non gli cambia mai)',
      reg?.toolSlug === 'notion-2' && catCfg?.toolSlug === undefined, JSON.stringify({ reg: reg?.toolSlug, cat: catCfg?.toolSlug }))
    const regTest = reg ? await n.rpc(`mcpTest(${JSON.stringify(reg.id)})`) : null
    check('R1 i due prefissi sono DIVERSI: mcp__notion__* (catalogo) e mcp__notion-2__* (registro)',
      Boolean(regTest?.tools?.some((t) => t === 'mcp__notion-2__notion_search')) && (cat?.tools ?? []).some((t) => t === 'mcp__notion__notion_search'),
        JSON.stringify(regTest?.tools ?? regTest).slice(0, 120))
    // il routing: il modello CHIAMA un tool per prefisso e ogni server risponde
    // col PROPRIO endpoint (ok:/notion-catalogo/mcp vs ok:/notion-registro/mcp)
    pushTool('mcp__notion__notion_search', { query: 'x' })
    pushTool('mcp__notion-2__notion_search', { query: 'x' })
    pushText('fatto')
    const reqs0 = chatRequests.length
    await uiSend(n.pageEval, 'cerca su notion')
    for (let i = 0; i < 40 && chatRequests.length < reqs0 + 3; i++) await sleep(500)
    const toolResults = chatRequests.slice(reqs0).flatMap((rq) => (rq.messages ?? []).filter((m) => m.role === 'tool'))
    check('R1 callTool instrada ciascuno sul SUO server: mcp__notion__→/notion-catalogo/mcp e mcp__notion-2__→/notion-registro/mcp',
      toolResults.some((m) => String(m.content).includes('ok:/notion-catalogo/mcp')) &&
      toolResults.some((m) => String(m.content).includes('ok:/notion-registro/mcp')),
      JSON.stringify(toolResults.map((m) => String(m.content).slice(0, 40))).slice(0, 200))
    // entrambi i prefissi OFFERTI al provider, senza doppioni
    const last = chatRequests.at(-1)
    const offered = (last?.tools ?? []).map((t) => t.function?.name ?? t.name)
    check('R1 al provider arrivano ENTRAMBI i prefissi (nessun nome duplicato)',
      offered.filter((x) => x === 'mcp__notion__notion_search').length === 1 &&
      offered.filter((x) => x === 'mcp__notion-2__notion_search').length === 1,
      JSON.stringify(offered.filter((x) => String(x).includes('notion'))))
  } catch (e) {
    failures++
    console.error('\n[sonda] ERRORE (notion):', e.message ?? e)
    try { console.error('--- daemon.log ---\n' + readFileSync(join(DATAN, 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  } finally {
    nApp?.stop()
    await sleep(800)
    await stopDaemon(DATAN)
  }
  }

  // ============================ la fixture M7 ============================
  // il server COME LO SALAVANO le versioni di prima: URL con {mattermost_host}
  // letterale e needsAuth key (la prova dell'utente del 2026-11-04)
  const TMP3 = mkdtempSync(TMP_BASE + 'sandbot-fase-mcp-setup-')
  const FIXTURE = join(TMP3, 'fixture')
  mkdirSync(join(FIXTURE, 'data'), { recursive: true })
  const oldServer = {
    id: 'registry-io-github-mattermost-mattermost-plugin-a-7134f7f8',
    name: 'io.github.mattermost/mattermost-plugin-agents',
    transport: 'http',
    url: mcpTemplateUrl,
    enabled: true,
    auth: { kind: 'headers' },
    enabledFor: ['*'],
    source: { kind: 'registry', name: MATTERMOST_NAME, version: '2.12.0' },
    trustLabel: 'GitHub account (mattermost)',
    trustKind: 'github-account',
    needsAuth: { kind: 'key', keys: ['Authorization'] }
  }
  {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(FIXTURE, 'data', 'sandbot.db'))
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('mcp.servers', JSON.stringify([oldServer]))
    db.close()
  }
  if (ONLY !== 'all' && ONLY !== 'fixture') {
    log('fixture saltata (PROBE_ONLY=' + ONLY + ')')
  } else {
  const fxApp = launchApp(FIXTURE, 9353)
  try {
    const f = await run(9353)
    if (!(await f.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile (fixture)')
    }
    const bot = await setupBot(f)
    check('M7: la migrazione ha trasformato l\'URL col buco in urlTemplate + needsAuth setup',
      await (async () => {
        for (let i = 0; i < 20; i++) {
          const servers = await f.rpc('connectorsInstalled()')
          const s = (servers?.servers ?? []).find((x) => x.id === oldServer.id)
          if (s?.urlTemplate && !s.url) return s.needsAuth?.kind === 'setup'
          await sleep(500)
        }
        return false
      })())
    // la riga della finestra App: «Da completare» (arancione), MAI «Connessa»
    check('M7/M6.1 la riga della fixture dice «Da completare», non «Connessa»',
      await openAppWindow(f) && await f.waitDom(`!!document.querySelector('[data-testid="server-status-setup"]')`, 10_000))
    await sleep(400)
    // il foglio: le variabili si rileggono dalla voce del registro (descrizione VERA)
    await f.pageEval(`document.querySelector('[data-testid^="server-row-"]')?.click(); return 'riga'`)
    check('M7/M3 il foglio della fixture rilegge le variabili dal registro (descrizione e placeholder veri)',
      await f.waitDom(`!!document.querySelector('[data-testid="server-sheet-setup"] [data-testid="setup-field-mattermost_host"][placeholder="chat.example.com"]')`, 15_000) &&
      (await f.pageEval(`return document.querySelector('[data-testid="server-sheet"]').textContent`)).includes('Hostname of your own Mattermost server'))
    await scrollIntoView(f.pageEval, `document.querySelector('[data-testid="server-sheet"]')`)
    await sheetToTop(f.pageEval)
    await sleep(400)
    await f.shot('m7-fixture-foglio-1440-chiaro.png')
    await setDark(f.pageEval, true)
    await sheetToTop(f.pageEval)
    await f.shot('m7-fixture-foglio-1440-scuro.png')
    await setDark(f.pageEval, false)
    // ============ R1 alla prova VIVA: la migrazione congela lo slug di oggi
    // (44 caratteri, NON tagliato) e la rinomina M7.3 (nome tecnico → titolo
    // «Mattermost») NON cambia i nomi degli strumenti ============
    await setInput(f.pageEval, '[data-testid="server-sheet"] [data-testid="setup-field-mattermost_host"]', `127.0.0.1:${mcpPort}`)
    await sleep(300)
    // il server della fixture aveva scelto il token (auth headers): il modulo
    // lo chiede subito (l'header si rilegge dalla voce del registro, il server
    // di prima di M1 non ha headerTemplates) — l'utente scrive SOLO il valore
    await setInput(f.pageEval, '[data-testid="server-sheet"] [data-testid="setup-token-authorization"]', STATIC_TOKEN)
    await sleep(300)
    await clickText(f.pageEval, 'Collega', '[data-testid="server-sheet"] [data-testid="setup-connect"]', true)
    check('R1/M7 la fixture si collega dal foglio (stato «Connessa», header «Bearer <token>» al finto)',
      await f.waitDom(`!!document.querySelector('[data-testid="server-sheet-connected"]')`, 40_000) &&
      mcpState.authorizations.some((a) => a === `Bearer ${STATIC_TOKEN}`))
    const afterFix = await (async () => {
      for (let i = 0; i < 20; i++) {
        const servers = await f.rpc('mcpList()')
        const s = (servers ?? []).find((x) => x.id === oldServer.id)
        if (s?.name === 'Mattermost') return s
        await sleep(500)
      }
      return null
    })()
    check('R1/M7.3 il NOME diventa il titolo «Mattermost» alla prima connessione riuscita',
      afterFix?.name === 'Mattermost', JSON.stringify(afterFix?.name))
    const fixTest = afterFix ? await f.rpc(`mcpTest(${JSON.stringify(afterFix.id)})`) : null
    check('R1 ma i nomi degli STRUMENTI non cambiano: lo slug di OGGI resta congelato (mcp__io-github-mattermost-mattermost-plugin-agents__*, non tagliato a 24)',
      Boolean(fixTest?.tools?.some((t) => t === 'mcp__io-github-mattermost-mattermost-plugin-agents__mattermost_search')) &&
      !(fixTest?.tools ?? []).some((t) => t.startsWith('mcp__mattermost__')),
        JSON.stringify(fixTest?.tools ?? fixTest).slice(0, 160))
  } catch (e) {
    failures++
    console.error('\n[sonda] ERRORE (fixture):', e.message ?? e)
    try { console.error('--- daemon.log ---\n' + readFileSync(join(FIXTURE, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  } finally {
    fxApp?.stop()
    await sleep(800)
    await stopDaemon(FIXTURE)
  }
  }
  // ================= la cattura di IMPOSTAZIONI › GENERALI (R2) =================
  // R2 tocca solo il foglio della finestra App, non le Impostazioni: questa
  // cattura PRIMA/DOPO (PROBE_TAG) lo PROVA — il confronto è fra la build di
  // base e quella dei ritocchi.
  if (ONLY === 'impostazioni') {
  const TMPI = mkdtempSync(TMP_BASE + 'sandbot-fase-mcp-setup-')
  const DATAI = join(TMPI, 'data')
  mkdirSync(DATAI, { recursive: true })
  const TAG = process.env.PROBE_TAG ?? 'dopo'
  const iApp = launchApp(DATAI, 9355)
  try {
    const i = await run(9355)
    if (!(await i.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
      throw new Error('window.sandbot non disponibile (impostazioni)')
    }
    await setupBot(i)
    // apertura col «mouse» (menu della barra), poi la sezione Generali
    const viaMenu = await (async () => {
      await pointerClick(i.pageEval, `[...document.querySelectorAll('aside button[aria-haspopup="menu"]')].pop()`)
      if (!(await i.waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((m) => m.textContent.trim() === 'Impostazioni')`, 5000))) return false
      await clickText(i.pageEval, 'Impostazioni', '[role="menuitem"]', true)
      return i.waitDom(`!!document.querySelector('[role="dialog"] nav button')`, 6000)
    })()
    check('impostazioni: il dialogo si apre dal menu della barra', viaMenu === true)
    await sleep(1200)
    await clickText(i.pageEval, 'Generali', '[role="dialog"] nav button', true)
    await i.pageEval(`document.activeElement?.blur?.(); return 'blur'`)
    await sleep(600)
    await scrollIntoView(i.pageEval, `document.querySelector('[role="dialog"] h1, [role="dialog"] h2')`)
    await sleep(300)
    await i.shot(`ritocchi-impostazioni-generali-${TAG}-1440-chiaro.png`)
  } catch (e) {
    failures++
    console.error('\n[sonda] ERRORE (impostazioni):', e.message ?? e)
  } finally {
    iApp?.stop()
    await sleep(800)
    await stopDaemon(DATAI)
  }
  }
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
} finally {
  // le cartelle temporanee delle corse si puliscono (l'app è già chiusa)
  for (const entry of readdirSync(TMP_BASE).filter((f) => f.startsWith('sandbot-fase-mcp-setup-'))) {
    try { rmSync(TMP_BASE + entry, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  }
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { registryServer.closeAllConnections?.(); registryServer.close() } catch { /* già chiusa */ }
  try { asServer.closeAllConnections?.(); asServer.close() } catch { /* già chiusa */ }
  try { mcpServer.closeAllConnections?.(); mcpServer.close() } catch { /* già chiusa */ }
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  process.exit(failures ? 1 : 0)
}
