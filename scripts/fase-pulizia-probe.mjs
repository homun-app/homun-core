#!/usr/bin/env node
// Sonda Electron della fase «pulizia» (P1–P6). L'app VERA (build di sviluppo
// in out/) su cartella dati TEMPORANEA, con l'isolamento di sempre: AS FINTO
// con discovery (RFC 9728), DCR e PKCE S256, il server MCP FINTO «Composio
// For You» (fixture ridotta del repo, via SANDBOT_TEST_COMPOSIO_MCP_URL), un
// server MCP FINTO «Notion» DIRETTO (SANDBOT_TEST_MCP_URLS), provider FINTO
// openai-compatible su 127.0.0.1 e «browser» finto che segue i redirect fino
// al callback di loopback. NESSUNA RETE VERA, tutto su 127.0.0.1. Copre:
//   P1: la bozza Composio inviata NON lascia notice col nome tecnico né JSON
//       grezzo in chat (la card dice «Inviata a …», l'esito nei Dettagli);
//   P2: la card d'approvazione di uno strumento DEL BOT dice il nome umano
//       («Creare un bot richiede approvazione», mai create_agent nudo) e la
//       notice «Bloccato dai permessi» porta il nome umano («Comandi»);
//   P3: la finestra App con Composio collegato — UNO stato per riga (mai
//       «Non riuscito» accanto a «Connessa»), nomi del catalogo («Gmail»),
//       azione della decisione in parole («Slack · Collega»), Composio UNA
//       volta sola (riga account), niente «Non riuscito» mentre carica;
//   P4: «Avanzate» di un connettore DIRETTO senza prefissi mcp__ né «[MCP:…]»
//       (che al modello restano), «per bot» con «Tutti i bot» acceso e i bot
//       spenti/disattivati, e «per bot» SOPRA i bottoni Scollega/Ricollega;
//   P5: il riquadro dei passaggi di un turno sotto il secondo dice «< 1 s»;
//   P6: a 900 e 1100 px, col pannello del profilo aperto, il menu «Ragiona»
//       resta DENTRO la colonna della chat (il rettangolo non interseca il
//       pannello);
//   P10 (extra): la riga della data/ora entra nel messaggio per il modello
//       (registrato dal provider finto) e NON nella bolla in chat.
// K1: le catture sono precedute da visibleOnTop e due PNG con nomi diversi
// non possono avere lo stesso hash. A FINE SONDA si chiude ANCHE il daemon di
// sviluppo (probe-daemons), la cartella temporanea viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-pulizia-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'pulizia')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

// i 12 strumenti dalla fixture ridotta del repo (il server Composio finto)
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'src/main/connectors/__tests__/fixtures/composio-for-you-tools.json'), 'utf8'))
const BATCH = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const MANAGE = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'
const CALLS_LOG = join(TMP, 'multi-execute.log')

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

// ---- l'AS FINTO (stessa forma delle sonde OAuth di prima) ----
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
    const code = 'code_' + randomBytes(6).toString('hex')
    asState.codes.set(code, { challenge, redirectUri })
    setTimeout(() => {
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` }).end()
    }, 400)
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
const makeMcpServer = ({ tools, onCall }) => {
  const state = {
    url: '',
    linkRequests: new Map(), // slug → { opened, at }
    adds: new Map(),
    outcomes: new Map()
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.startsWith('/link/')) {
      const slug = url.pathname.split('/')[2]
      state.linkRequests.set(slug, { opened: true, at: Date.now() })
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

// il server COMPOSIO: i 12 strumenti della fixture; il collegamento di un
// toolkit diventa attivo 600 ms dopo il link seguito (turni veloci per P5)
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
          const opened = state.linkRequests.get(entry.name)
          const active = (state.outcomes.get(entry.name) ?? 'ok') === 'ok' && opened?.opened === true
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
      const poll = () => {
        const entry = state.linkRequests.get(slug)
        if (entry?.opened && Date.now() - entry.at >= 600) {
          return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ id: `acc_${slug}`, status: 'ACTIVE' }] }] }) }] })
        }
        if (Date.now() > deadline) {
          return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ status: 'FAILED' }] }] }) }] })
        }
        setTimeout(poll, 80)
      }
      return poll()
    }
    return send({ content: [{ type: 'text', text: JSON.stringify({ data: {} }) }] })
  }
})
await new Promise((r) => composio.server.listen(0, '127.0.0.1', r))
composio.state.url = `http://127.0.0.1:${composio.server.address().port}/mcp`

// il server NOTION (diretto, per P4): due strumenti con descrizioni vere
const notion = makeMcpServer({
  tools: [
    { name: 'NOTION_LIST_PAGES', description: 'elenca le pagine', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'NOTION_SEARCH_PAGES', description: 'cerca nelle pagine', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ],
  onCall: (name, args, send) => send({ content: [{ type: 'text', text: JSON.stringify({ data: { ok: true } }) }] })
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
const DEBUG_PORT = 9346
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
const waitForText = async (text, ms = 40_000) =>
  waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === ${JSON.stringify(text)})`, ms)
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
/** La cronologia di una riga dell'elenco (P3: mai «Non riuscito» mentre carica). */
const timelineOf = async (testid, ms = 40_000) => {
  const samples = []
  const t0 = Date.now()
  for (let i = 0; i < ms / 250; i++) {
    const txt = await pageEval(`return document.querySelector('[data-testid=${JSON.stringify(testid)}]')?.textContent ?? ''`)
    samples.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${txt}`)
    if (txt.includes('Connessa')) break
    await sleep(250)
  }
  return samples
}
const setDark = async (dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(350)
}
const shotsOf = async (name, variants) => {
  for (const [w, dark, tag] of (variants ?? [[1440, false, '1440-chiaro'], [1440, true, '1440-scuro'], [900, false, '900-chiaro'], [900, true, '900-scuro']])) {
    await setWindowWidth(w)
    await setDark(dark)
    await shot(`${name}-${tag}.png`)
  }
  await setDark(false)
  await setWindowWidth(1440)
}
const fakeCalls = () => {
  try { return readFileSync(CALLS_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const waitFakeCalls = async (n, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fakeCalls().length >= n) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}
const noticesOf = async (botId) => (await rpc(`getEntries(${JSON.stringify(botId)})`)).filter((e) => e.kind === 'notice')
/** il testo VISIBILE della chat (fuori da ogni <details> chiuso: il JSON dei
 *  Dettagli tecnici non deve contare come «in chat») */
const chatVisibleText = () => pageEval(`
  const clone = document.body.cloneNode(true)
  clone.querySelectorAll('details:not([open])').forEach((d) => d.remove())
  const main = clone.querySelector('main') ?? clone
  return main.innerText
`)

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- setup: provider finto + il bot principale ----
  log('configuro il provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await page.send('Page.reload')
  check('setup compositore pronto', await waitDom(`!!document.querySelector('form textarea')`, 25_000))
  await setWindowWidth(1440)

  // ============ P4: Notion DIRETTA collegata, il dettaglio e le Avanzate ============
  await clickByLabel('App')
  check('P4a la finestra App si apre', await waitDom(`!!document.querySelector('[data-testid="app-filters"]')`, 10_000))
  await sleep(600)
  await clickTestid('app-connect-notion')
  const notionTimeline = await timelineOf('app-row-notion', 40_000)
  check('P4b la riga Notion arriva a «Connessa» (diretta, OAuth finto)',
    notionTimeline.some((x) => x.includes('Connessa')),
    `ultime: ${notionTimeline.slice(-3).join(' | ')}`)

  // il dettaglio: «per bot» SOPRA i bottoni (P4c) e col rendering della
  // finestra Skill (P4b): «Tutti i bot» acceso, i bot spenti e disattivati
  await clickTestid('app-row-notion')
  check('P4c il dettaglio di Notion si apre', await waitDom(`!!document.querySelector('[data-testid="app-detail-notion"]')`, 8_000))
  await sleep(500)
  const perBot = await pageEval(`
    const detail = document.querySelector('[data-testid="app-detail-notion"]')
    const toggles = detail.querySelector('[data-testid="app-bots-toggles"]')
    const buttons = [...detail.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    const scollega = buttons.findIndex((b) => b.textContent.trim() === 'Scollega')
    const all = toggles ? [...toggles.querySelectorAll('[role="switch"]')].find((s) => s.getAttribute('aria-label') === 'Tutti i bot') : null
    const botSwitches = toggles ? [...toggles.querySelectorAll('[role="switch"]')].filter((s) => s.getAttribute('aria-label') !== 'Tutti i bot') : []
    return {
      hasToggles: !!toggles,
      order: toggles && scollega >= 0 ? toggles.compareDocumentPosition(buttons[scollega]) : 0, // FOLLOWING = il bottone viene DOPO nel documento
      allChecked: all ? all.getAttribute('aria-checked') : null,
      bots: botSwitches.map((s) => ({ checked: s.getAttribute('aria-checked'), disabled: s.disabled }))
    }
  `)
  check('P4d «per bot» c\'è e sta SOTTO lo stato, SOPRA Scollega',
    perBot.hasToggles && perBot.order === 4,
    `order: ${perBot.order} (4 = il bottone Scollega viene DOPO nel documento)`)
  check('P4e «Tutti i bot» ACCESO e i bot SPENTI e DISATTIVATI (come la finestra Skill)',
    perBot.allChecked === 'true' && perBot.bots.length > 0 && perBot.bots.every((b) => b.checked === 'false' && b.disabled === true),
    JSON.stringify(perBot))
  const k1toggles = await visibleOnTop('[data-testid="app-bots-toggles"]')
  check('K1 il blocco «per bot» è scoperto', k1toggles === true, String(k1toggles))
  await shot('dettaglio-notion-perbot-1440-chiaro.png')
  await setDark(true)
  await shot('dettaglio-notion-perbot-1440-scuro.png')
  await setDark(false)

  // Avanzate: nomi SENZA prefisso mcp__ e descrizioni SENZA «[MCP:…]» (P4a)
  await pageEval(`
    const box = document.querySelector('[data-testid="app-advanced"]')
    const btn = [...box.querySelectorAll('button')].find((b) => b.textContent.includes('Avanzate'))
    if (!btn) throw new Error('bottone Avanzate non trovato')
    btn.click()
    return 'avanzate aperte'
  `)
  await sleep(400)
  const avanzate = await pageEval(`
    const box = document.querySelector('[data-testid="app-advanced"]')
    return [...box.querySelectorAll('label')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim())
  `)
  check('P4f «Avanzate»: il nome dello strumento SENZA prefisso mcp__',
    avanzate.some((t) => t.includes('NOTION_LIST_PAGES')) && avanzate.every((t) => !t.includes('mcp__')),
    JSON.stringify(avanzate))
  check('P4g «Avanzate»: la descrizione SENZA «[MCP:…]» (il tag resta al modello)',
    avanzate.some((t) => t.includes('elenca le pagine')) && avanzate.every((t) => !t.includes('[MCP:')),
    JSON.stringify(avanzate))
  const k1avanzate = await visibleOnTop('[data-testid="app-advanced"]')
  check('K1 la sezione Avanzate è scoperta', k1avanzate === true, String(k1avanzate))
  await shotsOf('avanzate-notion')
  // il modello RESTA col nome prefissato: un turno, gli strumenti offerti
  pushTool('send_to_user', { text: 'Pronto.' })
  await closeAppWindow()
  await uiSend('Ciao')
  await waitForText('Pronto.')
  await sleep(600)
  const offered = (chatRequests.at(-1)?.tools ?? []).map((t) => t?.function?.name ?? t?.name)
  check('P4h il modello riceve ANCORA i nomi col prefisso (mcp__notion__…)',
    offered.includes('mcp__notion__NOTION_LIST_PAGES'), offered.filter((n) => n.startsWith('mcp__notion__')).join(', '))

  // ============ P3: Gmail tramite Composio, UNO stato e i nomi del catalogo ============
  await clickByLabel('App')
  await waitDom(`!!(${APP_DIALOG})`, 10_000)
  await sleep(500)
  await clickTestid('app-connect-gmail')
  const gmailTimeline = await timelineOf('app-row-gmail', 60_000)
  check('P3a il collegamento di Gmail arriva a «Connessa»',
    gmailTimeline.some((x) => x.includes('Connessa')),
    `ultime: ${gmailTimeline.slice(-3).join(' | ')}`)
  check('P3b nella cronologia NON compare mai «Non riuscito» (nemmeno un istante)',
    !gmailTimeline.some((x) => x.includes('Non riuscito')),
    gmailTimeline.filter((x) => x.includes('Non riuscito')).join(' | ') || '')
  await sleep(600)
  // P3(c-d): la riga account UNA volta, nessuna riga app «Composio»
  const p3dup = await pageEval(`
    const dialog = ${APP_DIALOG}
    return {
      accountRows: dialog.querySelectorAll('[data-testid="composio-account-row"]').length,
      composioAppRows: [...dialog.querySelectorAll('[data-testid^="app-row-"]')].filter((r) => /composio/i.test(r.dataset.testid)).length,
      gmailName: (dialog.querySelector('[data-testid="app-row-gmail"]')?.textContent ?? '').slice(0, 40)
    }
  `)
  check('P3c la riga «Account Composio» compare UNA volta sola (niente doppione)',
    p3dup.accountRows === 1, `righe account: ${p3dup.accountRows}`)
  check('P3d NESSUNA riga app di Composio nell\'elenco', p3dup.composioAppRows === 0, `righe: ${p3dup.composioAppRows}`)
  check('P3e il nome della riga è quello del catalogo («Gmail», mai lo slug)',
    p3dup.gmailName.startsWith('Gmail'), p3dup.gmailName)
  // P3(a): il dettaglio di Gmail mostra UNO stato, non due contrapposti
  await clickTestid('app-row-gmail')
  check('P3f il dettaglio di Gmail si apre', await waitDom(`!!document.querySelector('[data-testid="app-detail-gmail"]')`, 8_000))
  await sleep(500)
  const gmailDetail = await pageEval(`
    const d = document.querySelector('[data-testid="app-detail-gmail"]')
    const text = d.innerText
    return {
      connessa: (text.match(/Connessa/g) ?? []).length,
      nonRiuscito: (text.match(/Non riuscito/g) ?? []).length,
      perBotIndex: text.indexOf('per bot:'),
      scollegaIndex: text.indexOf('Scollega')
    }
  `)
  check('P3g il dettaglio mostra UNO stato («Connessa») e NESSUN «Non riuscito» accanto',
    gmailDetail.connessa >= 1 && gmailDetail.nonRiuscito === 0,
    JSON.stringify(gmailDetail))
  const k1gmail = await visibleOnTop('[data-testid="app-detail-gmail"]')
  check('K1 il dettaglio di Gmail è scoperto', k1gmail === true, String(k1gmail))
  await shotsOf('dettaglio-gmail')
  // l'account sheet: UNA riga account, nessuno stato per app contraddittorio
  await closeAppWindow()
  await clickByLabel('App')
  await waitDom(`!!(${APP_DIALOG})`, 10_000)
  await clickTestid('composio-account-row')
  check('P3h il foglio dell\'account Composio si apre (UNO stato verde, nessun elenco app contraddittorio)',
    await waitDom(`!!document.querySelector('[data-testid="composio-account-sheet"]')`, 8_000) &&
    !(await pageEval(`return (document.querySelector('[data-testid="composio-account-sheet"]')?.innerText ?? '').includes('Non riuscito')`)))
  await shot('account-composio-1440-chiaro.png')
  await closeAppWindow()

  // ---- i nomi VERI degli strumenti Composio (il toolSlug del server è
  // assegnato all'installazione: si leggono dagli strumenti offerti) ----
  pushText('Ok, tutto collegato.')
  await uiSend('Tutto a posto?')
  await waitForText('Ok, tutto collegato.')
  await sleep(600)
  const offeredNames = (chatRequests.at(-1)?.tools ?? []).map((t) => t?.function?.name ?? t?.name)
  const BATCH_NAME = offeredNames.find((n) => n.includes('COMPOSIO_MULTI_EXECUTE_TOOL'))
  const MANAGE_NAME = offeredNames.find((n) => n.includes('COMPOSIO_MANAGE_CONNECTIONS'))
  check('P3j il modello riceve il blocco e le connessioni di Composio', !!BATCH_NAME && !!MANAGE_NAME,
    `blocco: ${BATCH_NAME ?? 'nessuno'} · connessioni: ${MANAGE_NAME ?? 'nessune'}`)

  // ============ P2: la card d'approvazione senza nomi tecnici ============
  await rpc(`setPermissions(${JSON.stringify({
    default: 'needs_approval',
    rules: [
      { tool: 'send_to_user', pattern: '*', mode: 'always_allow' },
      { tool: 'ask_user', pattern: '*', mode: 'always_allow' },
      { tool: 'recall_memory', pattern: '*', mode: 'always_allow' },
      { tool: 'find_tools', pattern: '*', mode: 'always_allow' },
      { tool: 'use_tool', pattern: '*', mode: 'always_allow' },
      { tool: 'run-command', pattern: '*', mode: 'blocked' },
      { tool: 'create_agent', pattern: '*', mode: 'needs_approval' }
    ]
  })})`)
  // la notice di blocco porta il nome umano («Comandi»), mai run-command
  pushTool('run-command', { command: 'echo no' })
  pushText('Non posso.')
  await uiSend('Esegui un comando.')
  await sleep(2_500)
  const denyNotice = (await noticesOf(bot.id)).findLast((e) => (e.meta?.ui?.id ?? '') === 'notice.deniedByPermissions')
  check('P2a la notice «Bloccato dai permessi» dice «Comandi», mai il nome tecnico',
    !!denyNotice && (await chatVisibleText()).includes('Bloccato dai permessi: Comandi') &&
    !(await chatVisibleText()).includes('Bloccato dai permessi: run-command'),
    denyNotice?.content ?? 'notice non trovata')

  // la card di create_agent (via find_tools + use_tool, come fa il modello):
  // titolo e motivo col nome umano, il tecnico solo nei Dettagli (che per i
  // tool del bot non ci sono: mai create_agent in chat)
  pushTool('find_tools', { query: 'crea un bot' })
  pushTool('use_tool', { name: 'create_agent', arguments: { name: 'Aiutante', role: 'Aiuta con le prove della sonda.' } })
  pushTool('send_to_user', { text: 'Chiedo il consenso.' })
  await uiSend('Creami un aiutante.')
  check('P2b la card d\'approvazione dice «vuole usare Creare un bot»',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('vuole usare Creare un bot'))`, 30_000))
  check('P2c il motivo della card dice «Creare un bot richiede approvazione»',
    await waitDom(`[...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Creare un bot richiede approvazione'))`, 8_000))
  const visibleChat = await chatVisibleText()
  check('P2d in chat NON compare mai il nome tecnico create_agent',
    !visibleChat.includes('create_agent'),
    visibleChat.split('\n').filter((l) => l.includes('create_agent')).join(' | ').slice(0, 120))
  await pageEval(`
    const card = [...document.querySelectorAll('div')].filter((d) => d.offsetParent !== null && d.textContent.includes('Creare un bot richiede')).pop()
    card?.scrollIntoView({ block: 'center' })
    return 'card in centro'
  `)
  await sleep(300)
  await shot('card-create-agent-1440-chiaro.png')
  await setDark(true)
  await shot('card-create-agent-1440-scuro.png')
  await setDark(false)
  await clickByText('Consenti')
  await waitForText('Chiedo il consenso.')
  await sleep(600)
  check('P2e il bot è stato creato DAVVERO (use_tool srotolato)',
    (await rpc('listAgents()')).some((a) => a.name === 'Aiutante'))
  check('P2f la riga decisa dice «Consentito una volta · Creare un bot», mai il tecnico',
    await waitDom(`[...document.querySelectorAll('button, div')].some((d) => d.offsetParent !== null && d.textContent.includes('Consentito una volta') && d.textContent.includes('Creare un bot'))`, 10_000) &&
    !(await chatVisibleText()).match(/Consentito una volta[^]*?create_agent/))

  // ============ P1: la bozza inviata senza nome tecnico né JSON in chat ============
  const mcpBefore = await rpc('mcpList()')
  log('server MCP prima di P1:', JSON.stringify(mcpBefore.map((x) => ({ id: x.id, name: x.name, enabled: x.enabled }))))
  const noticesBeforeSend = (await noticesOf(bot.id)).length
  pushTool(BATCH_NAME, { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'capo@sonda.prova', subject: 'Saluti', body: 'ciao dalla sonda pulizia' } }], sync_response_to_workbench: false })
  pushText('Bozza pronta: controllala tu.')
  await uiSend('Manda un\'email al capo.')
  check('P1a la voce d\'invio diventa BOZZA (card Invia/Scarta)',
    await waitDom(`!![...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Invia')`, 30_000))
  const callsBeforeSend = fakeCalls().length
  await clickByText('Invia')
  check('P1b «Invia» esegue UNA volta la voce d\'invio sul finto',
    (await waitFakeCalls(callsBeforeSend + 1)) && fakeCalls().at(-1)?.args?.tools?.length === 1 &&
    fakeCalls().at(-1)?.args?.tools[0]?.tool_slug === 'GMAIL_SEND_EMAIL',
    JSON.stringify({ voci: fakeCalls().at(-1)?.args?.tools?.length }))
  await sleep(1_500)
  const noticesAfterSend = await noticesOf(bot.id)
  check('P1c invio riuscito: NESSUNA notice nuova (niente «Bozza inviata (…)»)',
    noticesAfterSend.length === noticesBeforeSend,
    `notice: ${noticesAfterSend.length} (prima ${noticesBeforeSend}) — ultima: ${noticesAfterSend.at(-1)?.content.slice(0, 140)}`)
  check('P1d la riga della bozza inviata dice «Inviata a …»',
    await waitDom(`[...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.includes('Inviata a'))`, 10_000))
  const chatAfterSend = await chatVisibleText()
  check('P1e in chat NON compaiono né «Bozza inviata» né il nome tecnico né il JSON dell\'esito',
    !chatAfterSend.includes('Bozza inviata') && !chatAfterSend.includes('composio__') && !chatAfterSend.includes('mcp__') && !chatAfterSend.includes('"ok":true'),
    chatAfterSend.split('\n').filter((l) => /Bozza inviata|composio__|"ok"/.test(l)).join(' | ').slice(0, 160))
  const sentEntry = (await rpc(`getEntries(${JSON.stringify(bot.id)})`)).findLast((e) => e.meta?.message?.type === 'draft')
  check('P1f l\'esito vive nel meta.sendResult della card (per i «Dettagli»), non in chat',
    sentEntry?.meta?.status === 'sent' && typeof sentEntry?.meta?.sendResult === 'string' && sentEntry.meta.sendResult.includes('"ok":true'),
    JSON.stringify({ status: sentEntry?.meta?.status, meta: JSON.stringify(sentEntry?.meta).slice(0, 220) }))
  await pageEval(`
    const row = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.includes('Inviata a'))
    row?.scrollIntoView({ block: 'center' })
    return 'riga in centro'
  `)
  await sleep(300)
  await shot('bozza-inviata-1440-chiaro.png')
  await setDark(true)
  await shot('bozza-inviata-1440-scuro.png')
  await setDark(false)

  // ============ P3 (c): la decisione del collegamento in parole ============
  pushTool(MANAGE_NAME, { toolkits: [{ name: 'slack', action: 'add' }] })
  pushText('Link pronto in card.')
  await uiSend('Collega Slack.')
  check('P3i la card del collegamento dice «Slack · Collega» (mai «add»)',
    await waitDom(`!![...document.querySelectorAll('[data-testid="composio-batch-actions"]')].some((x) => x.offsetParent !== null && x.textContent.includes('Slack · Collega') && !x.textContent.includes('Slack · add'))`, 30_000))
  await pageEval(`
    const card = [...document.querySelectorAll('[data-testid="composio-batch-actions"]')].filter((x) => x.offsetParent !== null).pop()
    card?.scrollIntoView({ block: 'center' })
    return 'card in centro'
  `)
  await sleep(300)
  await shot('card-collega-slack-1440-chiaro.png')
  await clickByText('Rifiuta')
  await sleep(800)

  // ============ P5: il riquadro dei passaggi di un turno sotto il secondo ============
  pushTool('recall_memory', { query: 'oggi' })
  pushText('Fatto al volo.')
  const t0 = Date.now()
  await uiSend('Che ricordi hai?')
  await waitForText('Fatto al volo.')
  await sleep(700)
  const turnMs = Date.now() - t0
  // apre il riquadro dei passaggi dell'ULTIMO messaggio consegnato
  await pageEval(`
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
    const info = buttons.filter((b) => (b.getAttribute('aria-label') ?? '') === 'Passaggi del turno').pop()
    if (!info) throw new Error('bottone Passaggi del turno non trovato')
    info.closest('div').scrollIntoView({ block: 'center' })
    info.click()
    return 'riquadro aperto'
  `)
  check('P5a il riquadro dei passaggi si apre',
    await waitDom(`!!document.querySelector('[data-testid="steps-popover"]')`, 8_000))
  const stepsText = await pageEval(`return [...document.querySelectorAll('[data-testid="steps-popover"]')].filter((x) => x.offsetParent !== null).pop()?.innerText ?? ''`)
  check('P5b il riquadro dice «< 1 s» per il turno rapido (mai «0 s»)',
    stepsText.includes('< 1 s') && !stepsText.includes('· 0 s'),
    `${stepsText.split('\n')[0]} · turno ${turnMs} ms`)
  await pageEval(`
    const pop = [...document.querySelectorAll('[data-testid="steps-popover"]')].filter((x) => x.offsetParent !== null).pop()
    pop?.scrollIntoView({ block: 'center' })
    return 'riquadro in centro'
  `)
  await sleep(300)
  await shot('passaggi-subsecondo-1440-chiaro.png')
  await setDark(true)
  await shot('passaggi-subsecondo-1440-scuro.png')
  await setDark(false)

  // ============ P6: il menu «Ragiona» non copre il pannello a 900 e 1100 ============
  const panelMenuCheck = async (width) => {
    await setWindowWidth(width)
    // apre il pannello del profilo se è chiuso (la pillola del bot in alto);
    // se è già aperto (default) non si tocca
    await pageEval(`
      if (!document.querySelector('[data-testid="bot-panel"]')) {
        const pill = [...document.querySelectorAll('button')].find((b) => /pannello del bot/i.test((b.getAttribute('aria-label') ?? '') + ' ' + (b.title ?? '')) && b.offsetParent !== null)
        if (!pill) throw new Error('pillola del pannello non trovata: ' + [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '').filter(Boolean).join(', ').slice(0, 400))
        pill.click()
      }
      return 'pannello aperto'
    `)
    const panelThere = await waitDom(`!!document.querySelector('[data-testid="bot-panel"]')`, 8_000)
    if (!panelThere) return { ok: false, note: 'pannello non aperto' }
    await sleep(500)
    // apre il menu «Ragiona» del compositore
    await pageEval(`
      const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '') === 'Livello di ragionamento' && x.offsetParent !== null)
      if (!b) throw new Error('selettore Ragiona non trovato')
      b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      b.click()
      return 'menu aperto'
    `)
    const menuThere = await waitDom(`!!document.querySelector('[role="menu"]')`, 8_000)
    if (!menuThere) return { ok: false, note: 'menu non aperto' }
    await sleep(400)
    return pageEval(`
      const menu = document.querySelector('[role="menu"]')
      const panel = document.querySelector('[data-testid="bot-panel"]')
      const sentinel = document.querySelector('main > div[aria-hidden]')
      const s2 = sentinel ? sentinel.getBoundingClientRect() : null
      const m = menu.getBoundingClientRect()
      const p = panel.getBoundingClientRect()
      const overlap = !(m.right <= p.left || m.left >= p.right || m.bottom <= p.top || m.top >= p.bottom)
      return {
        ok: !overlap,
        note: 'menu ' + JSON.stringify({ l: Math.round(m.left), r: Math.round(m.right), t: Math.round(m.top), b: Math.round(m.bottom) }) +
          ' sentinella ' + JSON.stringify(s2 ? { l: Math.round(s2.left), r: Math.round(s2.right) } : null) +
          ' pannello ' + JSON.stringify({ l: Math.round(p.left), r: Math.round(p.right), t: Math.round(p.top), b: Math.round(p.bottom) }) +
          (overlap ? ' → SI intersecano' : ' → nessuna intersezione')
      }
    `)
  }
  const p6a = await panelMenuCheck(900)
  check('P6a a 900 px col pannello aperto il menu «Ragiona» NON interseca il pannello', p6a.ok, p6a.note)
  await shot('ragiona-900-pannello-chiaro.png')
  await setDark(true)
  await shot('ragiona-900-pannello-scuro.png')
  await setDark(false)
  // i menu Radix NON si chiudono con body.click(): Escape sul menu, poi si
  // aspetta che sparisca (altrimenti P6b misura il menu vecchio che si smonta)
  await pageEval(`
    const m = document.querySelector('[role="menu"]')
    ;(m ?? document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'menu chiuso'
  `)
  await waitDom(`!document.querySelector('[role="menu"]')`, 5_000)
  await sleep(400)
  const p6b = await panelMenuCheck(1100)
  check('P6b a 1100 px col pannello aperto il menu «Ragiona» NON interseca il pannello', p6b.ok, p6b.note)
  await shot('ragiona-1100-pannello-chiaro.png')
  await pageEval(`document.body.click()`)
  await sleep(400)

  // ============ P10 (extra): la data/ora al modello, mai in chat ============
  const lastReq = chatRequests.at(-1)
  const lastUser = [...(lastReq?.messages ?? [])].reverse().find((m) => m.role === 'user')
  const chatText = await pageEval(`return document.body.innerText`)
  check('P10a l\'ultimo messaggio utente per il modello porta la riga della data/ora',
    typeof lastUser?.content === 'string' && lastUser.content.includes('Current date and time for the user:') &&
    lastUser.content.includes('Never infer today\'s date from your training data'),
    (lastUser?.content ?? '').slice(-160))
  check('P10b la riga NON compare in chat né nel system prompt',
    !chatText.includes('Current date and time') &&
    !(lastReq?.messages ?? []).some((m) => m.role === 'system' && String(m.content).includes('Current date and time')))

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
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  try { composio.server.closeAllConnections?.(); composio.server.close() } catch { /* già chiusa */ }
  try { notion.server.closeAllConnections?.(); notion.server.close() } catch { /* già chiusa */ }
  try { asServer.closeAllConnections?.(); asServer.close() } catch { /* già chiusa */ }
  stopApp()
  await sleep(800)
  // Vincoli (fase): a fine sonda si chiudono ANCHE i daemon di sviluppo —
  // il controllo è quello condiviso probe-daemons (dall'ambiente dei processi)
  const { found, closed, left } = await stopProbeDaemons('sandbot-fase-pulizia')
  console.log(`daemon di sviluppo: ${found} trovati, ${closed} chiusi, ${left} rimasti`)
  if (left > 0) {
    failures++
    console.error('[sonda] daemon rimasti vivi dopo la chiusura (dall\'ambiente):\n' + findProbeDaemons('sandbot-fase-pulizia').map((d) => d.line).join('\n'))
  }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  process.exit(failures ? 1 : 0)
}
