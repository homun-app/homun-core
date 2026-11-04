#!/usr/bin/env node
// Sonda Electron della fase «Composio — correzioni dalla prova vera» (V1–V13).
// L'app VERA (build di sviluppo in out/) su cartella dati TEMPORANEA, con lo
// stesso isolamento delle sonde precedenti: AS FINTO con discovery (RFC 9728),
// DCR e PKCE S256, DUE server MCP FINTI (il «Composio For You» della fixture
// ridotta del repo + un server «Notion» diretto per V13, via
// SANDBOT_TEST_MCP_URLS), provider FINTO openai-compatible su 127.0.0.1 e
// «browser» finto che segue i redirect fino al callback di loopback.
// NESSUNA RETE VERA, tutto su 127.0.0.1. Copre:
//   V1+V3: GMAIL_FETCH_EMAILS passa SENZA card (fetch è lettura) e la risposta
//          «salvata nella workbench» arriva al modello PULITA: niente
//          next_steps né istruzioni sul codice, la nota fissa c'è;
//   V2: «Sempre» su una card del blocco → riga decisa «Consentito sempre»;
//   V4: con la chat scorsa in fondo, il riquadro dei passaggi (mascotte e ⓘ)
//          è INTERAMENTE sopra la casella di scrittura;
//   V5: la mezza riga dice l'app («usa Notion…») e il passo passato dice
//          l'azione («Ha usato Gmail · Legge email»);
//   V6: card in attesa → Annulla → «Collega»; attesa finita male → «Non
//          riuscito» con Riprova → una nuova chiamata add (link nuovo);
//   V9: la card del blocco dice «Vuole fare 1 azione su Slack»;
//   V10: UNA sola sezione «Connesse» (niente «Collegate», niente falso
//          «Nessuna app collegata» con Gmail collegata), con la riga Skill;
//   V11: testata «N connesse ›» col plurale, dettaglio con l'email (mai
//          l'id tecnico dell'account), niente nota per sviluppatori e
//          «Tutti i bot» senza casella per le app Composio;
//   V12: la cronologia di un collegamento riuscito NON contiene mai
//          «Non riuscito»;
//   V13: dettaglio di Notion DIRETTA collegata → «Avanzate» → disattivato uno
//          strumento → il modello non lo riceve più.
// K1: ogni cattura è preceduta da visibleOnTop e a fine sonda due PNG con
// nomi diversi non possono avere lo stesso hash.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-composio-prova-vera-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'composio-prova-vera')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

// i 12 strumenti dalla fixture ridotta del repo (il server Composio finto)
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'src/main/connectors/__tests__/fixtures/composio-for-you-tools.json'), 'utf8'))
const BATCH = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const MANAGE = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'
const LINKS_LOG = join(TMP, 'links.log')
const CALLS_LOG = join(TMP, 'multi-execute.log')

/** La risposta «salvata nella workbench» vista nella prova VERA, coi dati
 *  personali sostituiti (V3). */
const WORKBENCH_SPILL = JSON.stringify({
  successful: true,
  data: {
    results: [
      {
        tool_slug: 'GMAIL_FETCH_EMAILS',
        successful: true,
        data: {
          data_preview: 'Da: persona@esempio.it\nA: utente@esempio.it\nOggetto: La richiesta di prova\n\nCiao, ti scrivo per la richiesta di prova…',
          structure_info: { mime_type: 'message/rfc822', size_bytes: 174521, preview_chars: 400 },
          saved_response_path: '/var/composio/workbench/sessions/finta/responses/GMAIL_FETCH_EMAILS_7f3a2b.json',
          next_steps: 'The full response was saved to a file. Read the saved response file, then write code to parse it and run the analysis.'
        }
      }
    ],
    session: { id: 'sessione-finta', instructions: 'REQUIRED: Pass session_id "sessione-finta" in ALL subsequent meta tool calls for this workflow.' }
  },
  error: null
})

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

// ---- l'AS FINTO con la FORMA dei metadati veri di Composio (login.composio.dev) ----
const asState = {
  authorizeRequests: [],
  clients: new Map(),
  codes: new Map(),
  refreshTokens: new Set(),
  tokens: new Set(),
  registrations: 0
}
let asUrl = ''
const asServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
    return json(200, {
      issuer: asUrl,
      authorization_endpoint: `${asUrl}/oauth/authorize`,
      token_endpoint: `${asUrl}/oauth2/token`,
      registration_endpoint: `${asUrl}/oauth2/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access']
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
    asState.authorizeRequests.push(url)
    const clientId = url.searchParams.get('client_id') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const challenge = url.searchParams.get('code_challenge') ?? ''
    const method = url.searchParams.get('code_challenge_method') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (!asState.clients.has(clientId)) return json(400, { error: 'unauthorized_client' })
    if (!(asState.clients.get(clientId).redirect_uris ?? []).includes(redirectUri)) return json(400, { error: 'invalid_request' })
    if (!challenge || method !== 'S256') return json(400, { error: 'invalid_request', error_description: 'pkce' })
    // il «login finto»: approva (dopo un attimo, così la sonda vede bene la
    // fase di attesa) e torna al callback di loopback
    const code = 'code_' + randomBytes(6).toString('hex')
    asState.codes.set(code, { challenge, redirectUri })
    setTimeout(() => {
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` }).end()
    }, 700)
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
        asState.codes.delete(params.get('code') ?? '')
        const access = 'ACCESS_' + randomBytes(6).toString('hex')
        const refresh = 'REFRESH_' + randomBytes(4).toString('hex')
        asState.tokens.add(access)
        asState.refreshTokens.add(refresh)
        return json(200, { access_token: access, token_type: 'bearer', expires_in: 3600, refresh_token: refresh })
      }
      json(400, { error: 'unsupported_grant_type' })
    })
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => asServer.listen(0, '127.0.0.1', r))
asUrl = `http://127.0.0.1:${asServer.address().port}`

// ---- la fabbrica dei server MCP FINTI (uno per «Composio», uno per «Notion») ----
// Ogni server: PRM che punta all'AS finto, tools/list, tools/call e i link
// finti del login delle app (solo il server Composio). `list` risponde nella
// forma VERA di V8 (data.results.<toolkit>, stati minuscoli, is_default,
// user_info.email, session_id); gli ESITI per slug sono decisi da `outcomeOf`.
const makeMcpServer = ({ tools, onCall }) => {
  const state = {
    url: '',
    linkRequests: new Map(), // slug → { opened, at }
    adds: new Map(), // slug → quante chiamate add (per V6: il link NUOVO)
    outcomes: new Map() // slug → 'ok' | 'fail' (l'esito del collegamento)
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.startsWith('/link/')) {
      const slug = url.pathname.split('/')[2]
      state.linkRequests.set(slug, { opened: true, at: Date.now() })
      try { appendFileSync(LINKS_LOG, `${slug}\n`) } catch { /* best effort */ }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>login finto riuscito</body></html>')
      return
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        resource: state.url,
        authorization_servers: [asUrl]
      }))
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      res.writeHead(405).end()
      return
    }
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || !asState.tokens.has(auth.slice(7))) {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${state.url.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
      }).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let msg = null
      try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      const send = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      if (msg.method === 'initialize') {
        return send({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'finto', version: '0.1.0' }
        })
      }
      if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
        res.writeHead(202).end()
        return
      }
      if (msg.method === 'tools/list') {
        return send({ tools })
      }
      if (msg.method === 'tools/call') {
        return onCall(msg.params?.name ?? '', msg.params?.arguments ?? {}, send, state)
      }
      res.writeHead(404).end()
    })
  })
  return { server, state }
}

/** La risposta `list` nella forma VERA della prova (dati sostituiti). */
const realList = (slug, active, email) => JSON.stringify({
  successful: true,
  data: {
    message: `Processed 1 toolkit: ${active ? '1 active' : '0 active'}`,
    results: {
      [slug]: {
        toolkit: slug,
        status: active ? 'active' : 'initiated',
        accounts: active
          ? [{ id: `acc_${slug}`, status: 'active', is_default: true, ...(email ? { user_info: { email } } : {}) }]
          : []
      }
    },
    summary: { total_toolkits: 1, active_connections: active ? 1 : 0, initiated_connections: active ? 0 : 1, failed_connections: 0 },
    session: { id: 'sessione-finta', instructions: 'REQUIRED: Pass session_id "sessione-finta" in ALL subsequent meta tool calls for this workflow.' }
  },
  error: null
})

// il server COMPOSIO: i 12 strumenti della fixture, MANAGE con link finti ed
// esiti per slug, WAIT che aspetta il link, MULTI_EXECUTE che registra le
// chiamate e risponde con la workbench spill per GMAIL_FETCH_EMAILS
const composio = makeMcpServer({
  tools: FIXTURE.tools.map((t) => ({
    name: t.name,
    description: t.title ?? t.name,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
    ...(t.annotations ? { annotations: t.annotations } : {})
  })),
  onCall: (name, args, send, state) => {
    if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
      try { appendFileSync(CALLS_LOG, JSON.stringify({ name, args }) + '\n') } catch { /* best effort */ }
      const slugs = (args.tools ?? []).map((t) => t.tool_slug)
      if (slugs.includes('GMAIL_FETCH_EMAILS')) {
        // V3: la risposta grande finisce nella workbench remota (forma vera)
        return send({ content: [{ type: 'text', text: WORKBENCH_SPILL }] })
      }
      const results = (args.tools ?? []).map((t) => ({ tool_slug: t.tool_slug, data: { ok: true, arguments: t.arguments }, error: null }))
      return send({ content: [{ type: 'text', text: JSON.stringify({ data: { results } }) }] })
    }
    if (name === 'COMPOSIO_MANAGE_CONNECTIONS') {
      const out = { successful: true, data: { results: {}, session: { id: 'sessione-finta', instructions: '…' } }, error: null }
      for (const entry of args.toolkits ?? []) {
        if (entry.action === 'add') {
          state.adds.set(entry.name, (state.adds.get(entry.name) ?? 0) + 1)
          state.linkRequests.set(entry.name, { opened: false, at: Date.now() })
          out.data.results[entry.name] = {
            toolkit: entry.name,
            status: 'success',
            redirect_url: `${state.url.replace(/\/mcp$/, '')}/link/${entry.name}?req=${state.adds.get(entry.name)}-${randomBytes(3).toString('hex')}`
          }
        } else if (entry.action === 'list') {
          const mode = state.outcomes.get(entry.name) ?? 'ok'
          const opened = state.linkRequests.get(entry.name)
          const active = mode === 'ok' && opened?.opened === true
          out.data.results[entry.name] = { toolkit: entry.name, status: active ? 'active' : 'initiated', accounts: active ? [{ id: `acc_${entry.name}`, status: 'active', is_default: true, user_info: { email: 'utente@example.com' } }] : [] }
        } else if (entry.action === 'remove') {
          state.linkRequests.delete(entry.name)
          out.data.results[entry.name] = { toolkit: entry.name, status: 'removed' }
        } else {
          out.data.results[entry.name] = { toolkit: entry.name, status: 'renamed' }
        }
      }
      return send({ content: [{ type: 'text', text: JSON.stringify(out) }] })
    }
    if (name === 'COMPOSIO_WAIT_FOR_CONNECTIONS') {
      const slug = (args.toolkits ?? [])[0] ?? ''
      const deadline = Date.now() + 300_000
      const mode = state.outcomes.get(slug) ?? 'ok'
      const poll = () => {
        const entry = state.linkRequests.get(slug)
        // il collegamento diventa attivo 4,2 s dopo il link seguito (così la
        // sonda vede bene la fase «Completa il login di <app> nel browser…»);
        // 'fail': WAIT risponde dopo 3 s ma il collegamento resta initiated
        // (V8: lo stato lo dice list) → esito definitivo «Non riuscito», con
        // la fase d'attesa visibile prima, anche dopo Riprova
        if (mode === 'fail') {
          return setTimeout(() => send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, status: 'failed' }] }) }] }), 3000)
        }
        if (entry?.opened && Date.now() - entry.at >= 4200) {
          return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ id: `acc_${slug}`, status: 'ACTIVE' }] }] }) }] })
        }
        if (Date.now() > deadline) {
          return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ status: 'FAILED' }] }] }) }] })
        }
        setTimeout(poll, 100)
      }
      return poll()
    }
    return send({ content: [{ type: 'text', text: JSON.stringify({ data: {} }) }] })
  }
})
await new Promise((r) => composio.server.listen(0, '127.0.0.1', r))
composio.state.url = `http://127.0.0.1:${composio.server.address().port}/mcp`

// il server NOTION (diretto, per V13): due strumenti, uno lento (per la
// mezza riga e il popover mentre lavora)
const notionSlow = { current: false }
const notion = makeMcpServer({
  tools: [
    { name: 'NOTION_LIST_PAGES', description: 'elenca le pagine', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'NOTION_SEARCH_PAGES', description: 'cerca nelle pagine', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ],
  onCall: (name, args, send) => {
    if (name === 'NOTION_LIST_PAGES' && notionSlow.current) {
      // la chiamata lenta: la mascotte resta visibile mentre lavora (V4/V5)
      setTimeout(() => send({ content: [{ type: 'text', text: JSON.stringify({ data: { pages: ['Pagina uno', 'Pagina due'] } }) }] }), 4000)
      return
    }
    return send({ content: [{ type: 'text', text: JSON.stringify({ data: { ok: true } }) }] })
  }
})
await new Promise((r) => notion.server.listen(0, '127.0.0.1', r))
notion.state.url = `http://127.0.0.1:${notion.server.address().port}/mcp`
log('server MCP Composio finto su', composio.state.url, '· Notion finto su', notion.state.url, '· AS finto su', asUrl)

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
const DEBUG_PORT = 9343
let appLog = ''
let app = null
const launchApp = () => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
      SANDBOT_TEST_COMPOSIO_MCP_URL: composio.state.url,
      SANDBOT_TEST_MCP_URLS: JSON.stringify({ notion: notion.state.url }),
      SANDBOT_TEST_FAKE_BROWSER: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
app = launchApp()
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
const setWindowWidth = async (width, height = 800) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
  const w = await pageEval('return window.innerWidth')
  if (w !== width) throw new Error(`viewport emulato non applicato: ${w} ≠ ${width}`)
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
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
const clickByLabel = (label) => pageEval(`
  const b = [...document.querySelectorAll('button')]
    .find((x) => (x.getAttribute('aria-label') === ${JSON.stringify(label)} || x.title === ${JSON.stringify(label)}) && x.offsetParent !== null)
  if (!b) throw new Error('bottone non trovato: ' + ${JSON.stringify(label)})
  b.click()
  return 'cliccato'
`)
const clickByText = (text, scope = 'button') => pageEval(`
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
    .filter((x) => x.offsetParent !== null)
    .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
  if (!b) throw new Error('nessun bottone col testo: ' + ${JSON.stringify(text)})
  b.click()
  return 'cliccato'
`)
const clickTestid = (testid) => pageEval(`
  const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
  if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
  el.scrollIntoView({ block: 'center' })
  const b = el.matches('button') ? el : el.querySelector('button')
  ;(b ?? el).click()
  return 'cliccato'
`)
/** La finestra App: il dialogo che contiene le pillole dei filtri. */
const APP_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('[data-testid="app-filters"]'))`
const closeAppWindow = async () => {
  await pageEval(`
    for (let i = 0; i < 8; i++) {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) break
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      const x = dialog.querySelector('button[aria-label="Chiudi"]')
      if (x) x.click()
      await new Promise((r) => setTimeout(r, 250))
    }
    return 'cicli fatti'
  `)
  await sleep(400)
  const open = await pageEval(`return document.querySelectorAll('[role="dialog"]').length`)
  if (open) throw new Error(`la finestra App non si è chiusa (${open} dialoghi ancora aperti)`)
  return 'chiusa'
}
/** K1: l'elemento è VISIBILE IN CIMA? (elementFromPoint del centro DENTRO l'elemento) */
const visibleOnTop = (selector) => pageEval(`
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'non trovato: ' + ${JSON.stringify(selector)}
  if (el.offsetParent === null) return 'non renderizzato (offsetParent nullo)'
  el.scrollIntoView({ block: 'center' })
  await new Promise((r) => setTimeout(r, 300))
  const r = el.getBoundingClientRect()
  const cx = Math.round(r.left + r.width / 2)
  const cy = Math.round(r.top + r.height / 2)
  if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return 'fuori viewport: ' + cx + ',' + cy
  const hit = document.elementFromPoint(cx, cy)
  if (hit && el.contains(hit)) return true
  return 'coperto: ' + (hit ? hit.tagName + '.' + String(hit.className).slice(0, 60) : 'niente')
`)
/** V6: clicca il bottone di UNA card di collegamento precisa (per slug), non
 *  il primo bottone con quel testo (le card in chat possono essere più di una). */
const connectorCardButton = (slugInCard, label) => pageEval(`
  const card = [...document.querySelectorAll('[data-testid="connector-card"]')]
    .filter((c) => c.offsetParent !== null)
    .find((c) => c.textContent.includes(${JSON.stringify(slugInCard)}))
  if (!card) throw new Error('card ' + ${JSON.stringify(slugInCard)} + ' non trovata')
  const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
  if (!btn) throw new Error('bottone ' + ${JSON.stringify(label)} + ' non trovato nella card ' + ${JSON.stringify(slugInCard)} + ': ' + card.textContent.slice(0, 100))
  btn.click()
  return 'cliccato ' + ${JSON.stringify(label)} + ' su ' + ${JSON.stringify(slugInCard)}
`)

/**
 * V4/V6-diagnostica: cosa mostra la card di uno slug (finestra corta).
 */
/** La cronologia di una riga dell'elenco: cosa mostra e quando (per V12). */
const timelineOf = async (testid, ms = 40_000) => {
  const samples = []
  const t0 = Date.now()
  for (let i = 0; i < ms / 250; i++) {
    const txt = await pageEval(`return document.querySelector('[data-testid=${JSON.stringify(testid)}]')?.textContent ?? ''`)
    samples.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${txt.replace(/^✉️/, '')}`)
    if (txt.includes('Connessa')) break
    await sleep(250)
  }
  return samples
}
/** V4: il riquadro è INTERAMENTE sopra il bordo superiore della casella? */
const popoverAboveComposer = () => pageEval(`
  const pop = [...document.querySelectorAll('[data-testid="steps-popover"]')].filter((x) => x.offsetParent !== null).pop()
  if (!pop) return 'riquadro dei passaggi non trovato'
  const composer = document.querySelector('form textarea')?.closest('form')
  if (!composer) return 'compositore non trovato'
  const r = pop.getBoundingClientRect()
  const limit = Math.min(composer.getBoundingClientRect().top, window.innerHeight)
  if (r.top < 0) return 'fuori finestra in alto: ' + r.top
  if (r.bottom > limit) return 'sotto la casella: ' + r.bottom + ' > ' + limit
  return true
`)
const setDark = async (dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(350)
}
const VARIANTS = [
  [1440, false, '1440-chiaro'],
  [1440, true, '1440-scuro'],
  [900, false, '900-chiaro'],
  [900, true, '900-scuro']
]
const shotsOf = async (name) => {
  for (const [w, dark, tag] of VARIANTS) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`${name}-${tag}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)
}
const chatRequestsCount = () => chatRequests.length
/** gli strumenti offerti al modello nell'ULTIMA richiesta al provider finto */
const offeredToolsOf = (request) => (request?.tools ?? []).map((t) => t?.function?.name ?? t?.name)

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

  // ============ V13a: Notion DIRETTA collegata (server finto) ============
  await clickByLabel('App')
  check('V13a la finestra App si apre', await waitDom(`!!document.querySelector('[data-testid="app-filters"]')`, 10_000))
  await sleep(600)
  await clickTestid('app-connect-notion')
  const notionTimeline = await timelineOf('app-row-notion', 40_000)
  log('timeline notion:', JSON.stringify(notionTimeline))
  check('V13b la riga Notion arriva a «Connessa» (diretta, OAuth finto)',
    notionTimeline.some((x) => x.includes('Connessa')),
    `ultime: ${notionTimeline.slice(-3).join(' | ')}`)

  // ---- un turno per gli strumenti offerti PRIMA di disattivare ----
  pushTool('send_to_user', { text: 'Pronto.' })
  await closeAppWindow()
  await uiSend('Ciao')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Pronto.')`, 30_000).catch(() => undefined)
  await sleep(800)
  const offeredBefore = offeredToolsOf(chatRequests.at(-1))
  check('V13c il modello riceve gli strumenti di Notion (prima di disattivarne uno)',
    offeredBefore.includes('mcp__notion__NOTION_LIST_PAGES') && offeredBefore.includes('mcp__notion__NOTION_SEARCH_PAGES'),
    offeredBefore.filter((n) => n.startsWith('mcp__notion__')).join(', '))

  // ---- V13d: dettaglio → Avanzate → disattiva NOTION_SEARCH_PAGES ----
  await clickByLabel('App')
  await waitDom(`!!(${APP_DIALOG})`, 10_000)
  await clickTestid('app-row-notion')
  check('V13d il dettaglio di Notion ha la sezione «Avanzate» (chiusa)',
    await waitDom(`!!document.querySelector('[data-testid="app-advanced"]')`, 8_000) &&
    !(await pageEval(`return document.querySelector('[data-testid="app-advanced"] details, [data-testid="app-advanced"] input[type="checkbox"]')`)))
  await pageEval(`
    const box = document.querySelector('[data-testid="app-advanced"]')
    const btn = [...box.querySelectorAll('button')].find((b) => b.textContent.includes('Avanzate'))
    if (!btn) throw new Error('bottone Avanzate non trovato')
    btn.click()
    return 'avanzate aperte'
  `)
  await sleep(400)
  check('V13e «Avanzate» apre l\'elenco degli strumenti e le istruzioni',
    await pageEval(`
      const box = document.querySelector('[data-testid="app-advanced"]')
      return !!box && box.querySelectorAll('input[type="checkbox"]').length === 2 && !!box.querySelector('textarea')
    `))
  const k1avanzate = await visibleOnTop('[data-testid="app-advanced"]')
  check('K1 la sezione Avanzate è scoperta', k1avanzate === true, String(k1avanzate))
  await shotsOf('avanzate-notion')
  await pageEval(`
    const box = document.querySelector('[data-testid="app-advanced"]')
    const labels = [...box.querySelectorAll('label')]
    const target = labels.find((l) => l.textContent.includes('NOTION_SEARCH_PAGES'))
    if (!target) throw new Error('strumento non trovato')
    target.querySelector('input').click()
    return 'disattivato'
  `)
  await sleep(800)
  await pageEval(`document.querySelector('[data-testid="app-advanced"]').closest('div.fixed').click()`)
  await sleep(600)

  // ---- e il modello NON riceve più lo strumento disattivato ----
  pushTool('send_to_user', { text: 'Ancora qui.' })
  await closeAppWindow()
  await uiSend('Ricontrolla')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Ancora qui.')`, 30_000).catch(() => undefined)
  await sleep(800)
  const offeredAfter = offeredToolsOf(chatRequests.at(-1))
  check('V13f lo strumento disattivato NON è più offerto al modello',
    offeredAfter.includes('mcp__notion__NOTION_LIST_PAGES') && !offeredAfter.includes('mcp__notion__NOTION_SEARCH_PAGES'),
    offeredAfter.filter((n) => n.startsWith('mcp__notion__')).join(', '))

  // ============ V12 + V11: Gmail tramite Composio, con la cronologia ============
  await clickByLabel('App')
  await waitDom(`!!(${APP_DIALOG})`, 10_000)
  await sleep(500)
  await clickTestid('app-connect-gmail')
  const gmailTimeline = await timelineOf('app-row-gmail', 60_000)
  log('timeline gmail:', JSON.stringify(gmailTimeline))
  check('V12a il collegamento di Gmail arriva a «Connessa»',
    gmailTimeline.some((x) => x.includes('Connessa')),
    `ultime: ${gmailTimeline.slice(-3).join(' | ')}`)
  check('V12b nella cronologia di un collegamento riuscito NON compare mai «Non riuscito»',
    !gmailTimeline.some((x) => x.includes('Non riuscito')),
    gmailTimeline.filter((x) => x.includes('Non riuscito')).join(' | ') || '')
  const seenPhases = gmailTimeline.some((x) => x.includes('Accedi a Composio nel browser')) && gmailTimeline.some((x) => x.includes('Completa il login di Gmail nel browser'))
  check('V12c le fasi di attesa restano visibili («Accedi a Composio…» e «Completa il login…»)', seenPhases)

  // ---- V10: UNA sola sezione «Connesse» ----
  await sleep(600)
  const sectionInfo = await pageEval(`
    const dialog = ${APP_DIALOG}
    const sections = dialog.querySelectorAll('[data-testid="connected-section"]')
    const headings = [...dialog.querySelectorAll('strong')].map((s) => s.textContent.trim())
    return {
      sections: sections.length,
      hasCollegate: dialog.textContent.includes('Collegate'),
      hasEmptyOld: dialog.textContent.includes('Nessuna app collegata'),
      text: sections[0]?.textContent ?? ''
    }
  `)
  check('V10a UNA sola sezione «Connesse» (niente titolo «Collegate»)',
    sectionInfo.sections === 1 && !sectionInfo.hasCollegate,
    JSON.stringify({ sections: sectionInfo.sections, hasCollegate: sectionInfo.hasCollegate }))
  check('V10b niente falso «Nessuna app collegata» con Gmail collegata; c\'è la riga Skill',
    !sectionInfo.hasEmptyOld && sectionInfo.text.includes('Skill dei bot') && sectionInfo.text.includes('Gmail') && sectionInfo.text.includes('Notion'),
    sectionInfo.text.slice(0, 120))
  const k1sez = await visibleOnTop('[data-testid="connected-section"]')
  check('K1 la sezione Connesse è scoperta', k1sez === true, String(k1sez))
  await shotsOf('sezione-connesse')

  // ---- V11: la testata conta, il dettaglio di Gmail ----
  const summary = await pageEval(`
    const s = document.querySelector('[data-testid="connected-summary"]')
    return s ? s.textContent.trim() : null
  `)
  check('V11a la testata dice «2 connesse ›» (col plurale) e i loghi',
    (summary ?? '').endsWith('2 connesse ›'), JSON.stringify(summary))
  await clickTestid('app-row-gmail')
  check('V11b il dettaglio di Gmail si apre', await waitDom(`!!document.querySelector('[data-testid="app-detail-gmail"]')`, 8_000))
  await sleep(600)
  const detailText = await pageEval(`return document.querySelector('[data-testid="app-detail-gmail"]').innerText`)
  check('V11c il dettaglio mostra l\'EMAIL dell\'account, mai l\'id tecnico',
    detailText.includes('utente@example.com') && !detailText.includes('acc_gmail') && !/account\s+acc_/.test(detailText),
    detailText.split('\n').filter((l) => l.includes('@') || l.includes('acc_')).join(' | '))
  check('V11d niente nota per sviluppatori e niente descrizione inglese in italiano',
    !detailText.includes('La descrizione arriva dal catalogo') && !detailText.includes('Send, read and search'),
    detailText.split('\n').slice(0, 6).join(' | '))
  check('V11e «Tutti i bot» come testo per l\'app Composio',
    detailText.includes('Tutti i bot') && detailText.includes('per bot:'),
    detailText.split('\n').filter((l) => l.includes('Tutti i bot') || l.includes('per bot')).join(' | '))
  const gmailCheckboxes = await pageEval(`return document.querySelector('[data-testid="app-detail-gmail"]').querySelectorAll('input[type="checkbox"]').length`)
  check('V11f nessuna casella per bot nel dettaglio di Gmail (la scelta non esiste)',
    gmailCheckboxes === 0, `caselle: ${gmailCheckboxes}`)
  const k1dettaglio = await visibleOnTop('[data-testid="app-detail-gmail"]')
  check('K1 il dettaglio di Gmail è scoperto', k1dettaglio === true, String(k1dettaglio))
  await shotsOf('dettaglio-gmail')
  await pageEval(`document.querySelector('[data-testid="app-detail-gmail"]').parentElement.click()`)
  await sleep(500)
  await closeAppWindow()

  // ============ V3: la risposta della workbench arriva PULITA al modello ============
  const reqBeforeSpill = chatRequestsCount()
  pushTool(BATCH, { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { max: 5 } }], thought: 'leggo', sync_response_to_workbench: true })
  pushTool('send_to_user', { text: 'Email lette.' })
  await uiSend('Leggi le email.')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Email lette.')`, 40_000).catch(() => undefined)
  await sleep(800)
  const toolTexts = chatRequests
    .slice(reqBeforeSpill)
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content))
    .join('\n---\n')
  check('V3a la lettura GMAIL_FETCH_EMAILS passa SENZA card (V1: fetch è lettura)',
    !(await rpc(`getEntries(${JSON.stringify(bot.id)})`)).some((e) => e.kind === 'approval' && e.meta?.status === 'pending'))
  check('V3b al modello arriva la NOTA della workbench (mai cercare il file sul Mac)',
    toolTexts.includes('never search for it locally'), toolTexts.slice(0, 160))
  check('V3c niente next_steps né istruzioni sul codice o sul file salvato',
    !toolTexts.includes('next_steps') && !toolTexts.includes('write code') && !toolTexts.includes('saved response') && !toolTexts.includes('/var/composio/workbench/'),
    toolTexts.slice(0, 160))
  check('V3d l\'anteprima resta (data_preview)',
    toolTexts.includes('La richiesta di prova'))

  // ---- V5: il passo passato del riquadro dice l'azione («Gmail · Legge email») ----
  // V4 (verifica): finestra BASSA, così l'ultimo messaggio sta vicino alla
  // casella e sotto non c'è spazio: è il caso in cui il riquadro DEVE aprirsi
  // verso l'alto (a 800 di altezza c'era spazio e il caso non si provava)
  await setWindowWidth(1440, 520)
  await pageEval(`
    const scroller = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight && d.clientHeight > 300 && d.contains(document.querySelector('form textarea')))
    if (scroller) { scroller.scrollTop = scroller.scrollHeight }
    return 'chat in fondo'
  `)
  await sleep(300)
  await pageEval(`
    const btns = [...document.querySelectorAll('button')]
      .filter((b) => (b.getAttribute('aria-label') ?? '') === 'Passaggi del turno' && b.offsetParent !== null)
    const last = btns[btns.length - 1]
    if (!last) throw new Error('nessun bottone Passaggi del turno')
    last.click()
    return 'cliccato l’ultimo'
  `)
  check('V5a il riquadro dei passaggi si apre sul messaggio finito', await waitDom(`!!document.querySelector('[data-testid="steps-popover"]')`, 8_000))
  await sleep(500)
  const stepsText = await pageEval(`return document.querySelector('[data-testid="steps-popover"]').innerText`)
  check('V5b il passo passato dice «Ha usato Gmail · Leggi email»',
    stepsText.includes('Ha usato Gmail · Leggi email'), stepsText.split('\n').slice(0, 4).join(' | '))

  // ---- V4: il riquadro è INTERAMENTE sopra la casella di scrittura ----
  const v4msg = await popoverAboveComposer()
  check('V4a (messaggio finito) il riquadro è interamente sopra la casella', v4msg === true, String(v4msg))
  const k1pop = await visibleOnTop('[data-testid="steps-popover"]')
  check('K1 il riquadro dei passaggi è scoperto', k1pop === true, String(k1pop))
  // la direzione è STABILE (prima si invertiva a ogni render) e verso l'alto
  const dirOf = () => pageEval(`
    const pop = [...document.querySelectorAll('[data-testid="steps-popover"]')].filter((x) => x.offsetParent !== null).pop()
    return pop?.parentElement?.className.includes('bottom-full') ? 'su' : pop ? 'giù' : 'nessuno'
  `)
  const dirs = []
  for (let i = 0; i < 5; i++) { dirs.push(await dirOf()); await sleep(200) }
  check('V4d il riquadro si apre verso l\'alto e ci resta (finestra bassa)', dirs.every((d) => d === 'su'), dirs.join(','))
  for (const dark of [false, true]) {
    await setDark(dark)
    await shot(`passaggi-in-basso-1440x520-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)
  await pageEval(`document.body.click()`)
  await sleep(400)

  // ============ V5 live + V4 mascotte: la chiamata LENTA di Notion ============
  notionSlow.current = true
  pushTool('mcp__notion__NOTION_LIST_PAGES', {})
  pushTool('send_to_user', { text: 'Pagine di Notion lette.' })
  await uiSend('Le pagine di Notion, per favore.')
  // la card dell'approvazione (il server Notion non annota readOnly) con la
  // mascotte che lavora intanto: mezza riga «usa Notion…» e popover in alto
  check('V5c mentre lavora, la mezza riga dice «usa Notion…» (il nome del server)',
    await waitDom(`[...document.querySelectorAll('[aria-live="polite"]')].some((x) => x.offsetParent !== null && x.textContent.trim() === 'usa Notion…')`, 20_000))
  await pageEval(`
    const scroller = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight && d.clientHeight > 300 && d.contains(document.querySelector('form textarea')))
    if (scroller) { scroller.scrollTop = scroller.scrollHeight }
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Cosa sta facendo'))
    if (!btn) throw new Error('mascotte non trovata')
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    return 'mascotte hover'
  `)
  await sleep(700)
  check('V4b (mascotte) il riquadro dei passaggi è interamente sopra la casella',
    await waitDom(`!!document.querySelector('[data-testid="steps-popover"]')`, 8_000))
  const v4mascotte = await popoverAboveComposer()
  check('V4c il riquadro della mascotte è interamente sopra la casella', v4mascotte === true, String(v4mascotte))
  await pageEval(`
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Cosa sta facendo'))
    btn?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    return 'mascotte unhover'
  `)
  await sleep(400)
  await clickByText('Consenti')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Pagine di Notion lette.')`, 40_000).catch(() => undefined)
  await sleep(600)

  // ============ V2 + V9: «Sempre» su una card del blocco ============
  pushTool(BATCH, { tools: [{ tool_slug: 'SLACK_CREATE_REMINDER', arguments: { channel: '#sonda', text: 'ricordati la sonda' } }], sync_response_to_workbench: false })
  pushTool('send_to_user', { text: 'Fatto.' })
  await uiSend('Crea un promemoria su Slack.')
  check('V9 la card del blocco dice «Vuole fare 1 azione su Slack»',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Vuole fare 1 azione su Slack'))`, 30_000))
  // il menu «Altre opzioni ▾» accanto a Consenti: voce «Sempre»
  await pageEval(`
    const phrase = [...document.querySelectorAll('p, div')]
      .filter((x) => x.offsetParent !== null && x.textContent.includes('Vuole fare 1 azione su Slack'))
      .filter((x) => x.querySelector('[aria-haspopup="menu"]') === null)
      .pop()
    let card = phrase
    while (card && !card.querySelector('[aria-haspopup="menu"]')) card = card.parentElement
    const menu = card?.querySelector('[aria-haspopup="menu"]')
    if (!menu) throw new Error('menu Consenti sempre non trovato')
    menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    menu.click()
    await new Promise((r) => setTimeout(r, 500))
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim() === 'Sempre')
    if (!item) throw new Error('voce Sempre non trovata')
    item.click()
    return 'sempre cliccato'
  `)
  check('V2 «Sempre» → la riga decisa dice «Consentito sempre»',
    await waitDom(`[...document.querySelectorAll('button, div')].some((d) => d.offsetParent !== null && d.textContent.includes('Consentito sempre'))`, 15_000))
  await sleep(600)
  const k1sempre = await pageEval(`
    const el = [...document.querySelectorAll('div')].filter((d) => d.offsetParent !== null && d.textContent.includes('Consentito sempre') && d.textContent.includes('Slack')).pop()
    if (!el) return 'riga decisa non trovata'
    el.scrollIntoView({ block: 'center' })
    await new Promise((r) => setTimeout(r, 300))
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    return hit && el.contains(hit) ? true : 'coperto: ' + (hit ? hit.tagName : 'niente')
  `)
  check('K1 la riga decisa è scoperta', k1sempre === true, String(k1sempre))
  await shotsOf('card-sempre')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Fatto.')`, 30_000).catch(() => undefined)
  await sleep(600)

  // ============ V6: Annulla durante l'attesa; Non riuscito → Riprova (link nuovo) ============
  // --- 6.1 Annulla: il link di Dropbox NON viene seguito → attesa → Annulla ---
  pushTool(MANAGE, { toolkits: [{ name: 'dropbox', action: 'add' }] })
  pushTool('send_to_user', { text: 'Card Dropbox pronta.' })
  await uiSend('Collega Dropbox.')
  check('V6.0a la card d\'approvazione del collegamento Dropbox appare',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Dropbox · Collega'))`, 20_000))
  await clickByText('Consenti')
  check('V6a la card «Collega Dropbox tramite Composio» appare',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Collega Dropbox tramite Composio'))`, 20_000))
  await connectorCardButton('Dropbox', 'Collega')
  check('V6b la card entra in attesa con ANNULLA',
    await waitDom(`[...document.querySelectorAll('[data-testid="connector-card"]')].some((c) => c.offsetParent !== null && c.textContent.includes('In attesa del login nel browser') && [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Annulla'))`, 10_000))
  await connectorCardButton('Dropbox', 'Annulla')
  check('V6c dopo Annulla la card torna a «Collega» (niente attesa)',
    await waitDom(`[...document.querySelectorAll('[data-testid="connector-card"]')].some((c) => c.offsetParent !== null && c.textContent.includes('Dropbox') && [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Collega'))`, 10_000))
  const gwAfterCancel = await rpc('composioGatewayStatus()')
  check('V6d il gateway non ha più un\'attesa dopo l\'annullo', gwAfterCancel.pending === null, JSON.stringify(gwAfterCancel.pending))
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Card Dropbox pronta.')`, 30_000).catch(() => undefined)
  await sleep(500)

  // --- 6.2 Non riuscito → Riprova chiede un link NUOVO ---
  composio.state.outcomes.set('trello', 'fail') // WAIT ok ma il collegamento resta initiated
  pushTool(MANAGE, { toolkits: [{ name: 'trello', action: 'add' }] })
  pushTool('send_to_user', { text: 'Card Trello pronta.' })
  await uiSend('Collega Trello.')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Trello · Collega'))`, 20_000)
  await clickByText('Consenti')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Collega Trello tramite Composio'))`, 20_000)
  await connectorCardButton('Trello', 'Collega')
  check('V6e l\'attesa finita male dice «Non riuscito» con RIPROVA',
    await waitDom(`[...document.querySelectorAll('[data-testid="connector-card"]')].some((c) => c.offsetParent !== null && c.textContent.includes('Trello') && c.textContent.includes('Non riuscito') && [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Riprova'))`, 20_000))
  const addsBefore = composio.state.adds.get('trello') ?? 0
  const k1nonriuscito = await visibleOnTop('[data-testid="connector-card"]')
  check('K1 la card Non riuscito è scoperta', k1nonriuscito === true, String(k1nonriuscito))
  await shotsOf('collegamento-non-riuscito')
  const v6click = await pageEval(`
    const cards = [...document.querySelectorAll('[data-testid="connector-card"]')].filter((c) => c.offsetParent !== null)
    const card = cards.find((c) => c.textContent.includes('Trello'))
    if (!card) return 'card Trello non trovata: ' + cards.map((c) => c.textContent.slice(0, 40)).join(' || ')
    const riprova = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Riprova')
    if (!riprova) return 'nessun bottone Riprova: ' + card.textContent.slice(0, 120)
    riprova.click()
    return 'riprovato'
  `)
  if (v6click !== 'riprovato') throw new Error('V6f: ' + v6click)
  check('V6f Riprova torna in attesa (link nuovo richiesto)',
    await waitDom(`[...document.querySelectorAll('[data-testid="connector-card"]')].some((c) => c.offsetParent !== null && c.textContent.includes('Trello') && c.textContent.includes('In attesa del login nel browser'))`, 15_000))
  await sleep(1200)
  const addsAfter = composio.state.adds.get('trello') ?? 0
  check('V6g Riprova ha chiamato add una SECONDA volta (il link vecchio era monouso)',
    addsAfter === addsBefore + 1, `add per trello: ${addsBefore} → ${addsAfter}`)
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Card Trello pronta.')`, 40_000).catch(() => undefined)

  // ---- K1: due PNG con NOMI diversi non possono avere lo stesso hash ----
  const byHash = new Map()
  const dup = []
  for (const name of readdirSync(SHOTS).filter((n) => n.endsWith('.png')).sort()) {
    const h = createHash('sha256').update(readFileSync(join(SHOTS, name))).digest('hex')
    if (byHash.has(h)) dup.push(`${name} ≡ ${byHash.get(h)}`)
    else byHash.set(h, name)
  }
  check('K1 nessuna cattura duplicata (stesso hash con nomi diversi)', dup.length === 0, dup.join('; '))
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-9000)) } catch { /* niente log */ }
  console.error(appLog.slice(-1500))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  if (failures > 0) {
    try { console.error('--- daemon.log (coda) ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-4000)) } catch { /* niente log */ }
  }
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  try { composio.server.closeAllConnections?.(); composio.server.close() } catch { /* già chiusa */ }
  try { notion.server.closeAllConnections?.(); notion.server.close() } catch { /* già chiusa */ }
  try { asServer.closeAllConnections?.(); asServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // Vincoli (fase): a fine sonda si chiude ANCHE il daemon di sviluppo
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid()
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
