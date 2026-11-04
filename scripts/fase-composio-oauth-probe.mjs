#!/usr/bin/env node
// Sonda Electron della fase Composio OAuth (C1–C7) + RITOCCI (K1–K7). L'app
// VERA (build di sviluppo in out/) su cartella dati TEMPORANEA, provider
// FINTO openai-compatible su 127.0.0.1 e un SERVER MCP FINTO che imita
// Composio «For You»: gli stessi 12 strumenti con gli schemi della fixture
// ridotta del repo, MULTI_EXECUTE che registra le chiamate su file,
// MANAGE_CONNECTIONS che restituisce un redirect_url finto e un OAuth FINTO
// con discovery (RFC 9728), DCR e PKCE S256. La voce di catalogo punta lì
// con SANDBOT_TEST_COMPOSIO_MCP_URL (solo insieme a SANDBOT_TEST_USER_DATA)
// e il «browser» è finto anche lui: SANDBOT_TEST_FAKE_BROWSER=1 fa seguire i
// redirect con fetch fino al callback di loopback, mai il browser vero.
// Copre:
//   C1: Accedi → login finto → «Composio collegato» (e l'AS finto ha visto
//       resource=<server MCP> e i 4 scope, PKCE S256, DCR client pubblico);
//   C3: il provider finto vede SOLO i 6 strumenti offerti (il corpo delle
//       richieste chat/completions viene registrato);
//   C2: blocco di sole letture senza card; lettura + scrittura → card con le
//       DUE azioni; distruttiva senza «Sempre»;
//   C7: lettura + invio → bozza estratta + lettura eseguita; Invia esegue
//       UNA volta il blocco con la SOLA voce d'invio (e sync false);
//   C4: dopo un risultato non fidato, lettura su un'app NUOVA → card;
//   C5: MANAGE_CONNECTIONS add → card di collegamento → Collega apre il link
//       (registrato dal finto, non dal browser vero) → card «Collegata»;
//   C6: la strada della chiave sta SOLO nel foglio «Per sviluppatori».
// RITOCCI K1–K7 verificati QUI:
//   K1: la finestra App si CHIUDE prima di ogni turno in chat e ogni cattura
//       è preceduta da visibleOnTop (elementFromPoint DENTRO l'elemento);
//       C2e riscritto (non più tautologia); a fine sonda due PNG con nomi
//       diversi non possono avere lo stesso hash;
//   K2: nel dettaglio del gateway niente «Non riuscito» accanto a
//       «Collegata»;
//   K3: la card dice «Collega Slack tramite Composio», la card d'approvazione
//       «Slack · Collega» e la riga decisa pure;
//   K4: nessuna riga normale di Composio sotto la card (con e senza ricerca);
//   K5: la riga Composio in «Collegate» non dice «Diretta»;
//   K7: la bozza estratta contiene «Gmail tramite Composio».
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-composio-oauth-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'composio-oauth')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

// ---- i 12 strumenti dalla fixture ridotta del repo (C10: senza descrizioni) ----
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'src/main/connectors/__tests__/fixtures/composio-for-you-tools.json'), 'utf8'))
const BATCH = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const MANAGE = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'
const CALLS_LOG = join(TMP, 'multi-execute.log')
const LINKS_LOG = join(TMP, 'links.log')

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

// ---- il server MCP FINTO che imita Composio «For You» ----
// Gli strumenti collegati: il fake fa finta che GMAIL e SLACK siano
// collegabili (add) e connette chi ha seguito il link (auto-login 700 ms).
const mcpState = {
  url: '',
  connectedToolkits: new Set(), // i toolkit il cui link è stato seguito
  linkRequests: new Map(), // slug → { opened: boolean, at }
  waiters: []
}
const mcpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  // il «browser finto» dell'utente che completa il login dell'app
  if (req.method === 'GET' && url.pathname.startsWith('/link/')) {
    const slug = url.pathname.split('/')[2]
    mcpState.linkRequests.set(slug, { opened: true, at: Date.now() })
    try { appendFileSync(LINKS_LOG, `${slug}\n`) } catch { /* best effort */ }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>login finto riuscito</body></html>')
    return
  }
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      resource: mcpState.url,
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
      'www-authenticate': `Bearer resource_metadata="${mcpState.url.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
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
        serverInfo: { name: 'composio-finto', version: '0.1.0' }
      })
    }
    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
      res.writeHead(202).end()
      return
    }
    if (msg.method === 'tools/list') {
      // la fixture ridotta non ha descrizioni (C10) e porta lo schema solo
      // dei tre strumenti chiave: qui si completano i campi che l'SDK richiede
      const tools = FIXTURE.tools.map((t) => ({
        name: t.name,
        description: t.title ?? t.name,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
        ...(t.annotations ? { annotations: t.annotations } : {})
      }))
      return send({ tools })
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
        try { appendFileSync(CALLS_LOG, JSON.stringify({ name, args }) + '\n') } catch { /* best effort */ }
        // ogni azione risponde ok (data.results), come il server vero
        const results = (args.tools ?? []).map((t) => ({ tool_slug: t.tool_slug, data: { ok: true, arguments: t.arguments }, error: null }))
        const text = JSON.stringify({ data: { results } })
        return send({ content: [{ type: 'text', text }] })
      }
      if (name === 'COMPOSIO_MANAGE_CONNECTIONS') {
        const out = { toolkits: [] }
        for (const entry of args.toolkits ?? []) {
          if (entry.action === 'add') {
            mcpState.linkRequests.set(entry.name, { opened: false, at: Date.now() })
            out.toolkits.push({ toolkit: entry.name, status: 'success', redirect_url: `${mcpState.url.replace(/\/mcp$/, '')}/link/${entry.name}?req=${randomBytes(3).toString('hex')}` })
          } else if (entry.action === 'list') {
            const connected = mcpState.linkRequests.get(entry.name)?.opened
            out.toolkits.push({ toolkit: entry.name, accounts: [{ id: `acc_${entry.name}`, status: connected ? 'ACTIVE' : 'INITIATED' }] })
          } else if (entry.action === 'remove') {
            mcpState.linkRequests.delete(entry.name)
            out.toolkits.push({ toolkit: entry.name, status: 'removed' })
          } else {
            out.toolkits.push({ toolkit: entry.name, status: 'renamed' })
          }
        }
        return send({ content: [{ type: 'text', text: JSON.stringify(out) }] })
      }
      if (name === 'COMPOSIO_WAIT_FOR_CONNECTIONS') {
        const slug = (args.toolkits ?? [])[0] ?? ''
        const deadline = Date.now() + (args.timeoutMs ?? 240_000)
        const poll = () => {
          if (mcpState.linkRequests.get(slug)?.opened) {
            return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ id: `acc_${slug}`, status: 'ACTIVE' }] }] }) }] })
          }
          if (Date.now() > deadline) return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ status: 'FAILED' }] }] }) }] })
          setTimeout(poll, 100)
        }
        return poll()
      }
      // gli altri strumenti (SEARCH_TOOLS, GET_TOOL_SCHEMAS…) rispondono vuoti
      return send({ content: [{ type: 'text', text: JSON.stringify({ data: {} }) }] })
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r))
mcpState.url = `http://127.0.0.1:${mcpServer.address().port}/mcp`
log('server MCP finto su', mcpState.url, '· AS finto su', asUrl)

// ---- il provider FINTO (openai-compatible, SSE su 127.0.0.1) ----
// Le risposte sono uno script in coda; OGNI richiesta viene registrata (il
// corpo intero) così la sonda vede QUALI strumenti sono offerti al modello.
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
const DEBUG_PORT = 9341
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
      SANDBOT_TEST_COMPOSIO_MCP_URL: mcpState.url,
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
  const b = el.matches('button') ? el : el.querySelector('button')
  ;(b ?? el).click()
  return 'cliccato'
`)
const clickSidebar = (name) => pageEval(`
  const sidebar = document.querySelector('aside')
  const b = sidebar && [...sidebar.querySelectorAll('button')]
    .find((x) => x.textContent.trim().startsWith(${JSON.stringify(name)}) && x.offsetParent !== null && !x.getAttribute('aria-expanded'))
  if (!b) throw new Error('riga della barra non trovata: ' + ${JSON.stringify(name)})
  b.click()
  return 'selezionato'
`)
const APP_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes('Tutte le app'))`

/**
 * K1 (ritocchi): chiude la finestra App (Esc, col bottone × come ripiego)
 * PRIMA di ogni turno in chat — ieri le catture card-fiducia-* e
 * card-blocco-* mostravano la finestra APERTA SOPRA la chat. Fallisce se un
 * dialogo resta aperto: le card si devono fotografare in chat, scoperte.
 */
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
  if (open) throw new Error(`K1: la finestra App non si è chiusa (${open} dialoghi ancora aperti)`)
  return 'chiusa'
}

/**
 * K1 (ritocchi): l'elemento è VISIBILE IN CIMA? Lo porta in vista
 * (scrollIntoView al centro) e controlla che elementFromPoint del suo centro
 * cada DENTRO l'elemento — non basta offsetParent (quello coperto dalla
 * finestra App lo aveva comunque). true, o il motivo per cui NON lo è.
 */
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
const pendingApprovals = async (botId) =>
  (await rpc(`getEntries(${JSON.stringify(botId)})`)).filter((e) => e.kind === 'approval' && e.meta?.status === 'pending')

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

  // ============ C6: la chiave SOLO nel foglio sviluppatori ============
  await clickByLabel('App')
  check('C6a la finestra App si apre', await waitDom(`!!document.querySelector('[data-testid="developers-link"]')`, 10_000))
  const mainText = await pageEval(`return document.querySelector('[role="dialog"]').textContent`)
  check('C6b la card in cima è «Più di mille app con Composio» con Accedi e NESSUN campo chiave',
    mainText.includes('Più di mille app con Composio') && mainText.includes('Accedi') && !mainText.includes('Incolla la chiave'))
  await clickTestid('developers-link')
  check('C6c il foglio sviluppatori ha «Chiave di progetto Composio (sviluppatori)»',
    await waitDom(`!!document.querySelector('[data-testid="developers-sheet"]') && [...document.querySelectorAll('[data-testid="developers-sheet"] strong, [data-testid="developers-sheet"] p')].some((x) => x.textContent.includes('Chiave di progetto Composio'))`, 8_000))
  await pageEval(`document.querySelector('[data-testid="developers-sheet"]').parentElement.click()`)
  await sleep(400)

  // ---- catture: la card Accedi (1440/900 × chiaro/scuro) ----
  await shotsOf('accedi-card')

  // ============ K4: Composio NON compare due volte in «Tutte le app» ============
  // sotto la card «Più di mille app con Composio» non ci deve essere ANCHE la
  // riga normale del catalogo («Composio — Più di mille app con un solo
  // accesso · Collega»), né senza ricerca né cercando «composio»
  const k4aText = await pageEval(`return (${APP_DIALOG}).textContent`)
  check('K4a nessuna riga normale di Composio sotto la card (tagline «un solo accesso» assente)',
    !k4aText.includes('un solo accesso'))
  await pageEval(`
    const input = document.querySelector('input[placeholder="Cerca tra app e skill"]')
    if (!input) throw new Error('campo di ricerca non trovato')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, 'composio')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ricerca: composio'
  `)
  await sleep(700)
  const k4bText = await pageEval(`return (${APP_DIALOG}).textContent`)
  check('K4b cercando «composio» resta la CARD, non la riga',
    k4bText.includes('Più di mille app con Composio') && !k4bText.includes('un solo accesso'))
  await pageEval(`
    const input = document.querySelector('input[placeholder="Cerca tra app e skill"]')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ricerca pulita'
  `)
  await sleep(500)

  // ============ C1: Accedi → login finto → Composio collegato ============
  await clickTestid('composio-login-card') // il bottone Accedi sta dentro la card
  check('C1a la card passa ad «Apri il browser e accedi a Composio»',
    await waitDom(`!!document.querySelector('[data-testid="composio-login-waiting"]')`, 8_000))
  // il flusso OAuth gira: discovery 401 → PRM → AS → DCR → authorize → browser
  // finto → callback → token. Il connettore diventa connesso e la card lo dice
  check('C1b il login finto completa → «Composio collegato»',
    await waitDom(`!!document.querySelector('[data-testid="composio-linked"]')`, 30_000),
    `AS finto: ${asState.registrations} registrazioni, ${asState.authorizeRequests.length} authorize`)
  const q = asState.authorizeRequests[0]?.searchParams
  check('C1c la richiesta di autorizzazione porta resource=<server MCP> e i 4 scope',
    q?.get('resource') === mcpState.url && q?.get('scope') === 'openid profile email offline_access' && q?.get('code_challenge_method') === 'S256',
    `resource=${q?.get('resource')} scope=${q?.get('scope')}`)
  const clientMeta = [...asState.clients.values()][0]
  check('C1d DCR: client pubblico nativo con redirect di loopback',
    clientMeta?.application_type === 'native' && /^client_/.test([...asState.clients.keys()][0] ?? '') && (clientMeta?.redirect_uris ?? [])[0]?.startsWith('http://127.0.0.1:'),
    JSON.stringify({ application_type: clientMeta?.application_type, redirect: (clientMeta?.redirect_uris ?? [])[0] }))
  check('C1e il token è stato emesso dall\'AS finto (refresh incluso)',
    asState.tokens.size >= 1 && asState.refreshTokens.size >= 1)
  const connectorsNow = await rpc('connectorsList()')
  const composioEntry = connectorsNow.find((c) => c.id === 'composio')
  check('C1f il connettore Composio è connesso con i suoi strumenti offerti',
    composioEntry?.state?.status === 'connected' && (composioEntry?.tools ?? []).length === 6,
    `strumenti: ${(composioEntry?.tools ?? []).length} stato: ${composioEntry?.state?.status} errore: ${composioEntry?.state?.error ?? '-'}`)

  // ============ C3: il modello vede SOLO i 6 strumenti offerti ============
  // un turno qualsiasi: la prima richiesta al provider finto porta gli strumenti
  pushText('Ciao.')
  await closeAppWindow() // K1: da qui in poi la chat dev'essere SCOPERTA
  await uiSend('Ciao!')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Ciao.')`, 30_000).catch(() => undefined)
  await sleep(1_200)
  const lastRequest = chatRequests.at(-1)
  const offered = offeredToolsOf(lastRequest)
  check('C3 il modello finto vede SOLO i 6 strumenti offerti (niente code tool, skill, feedback)',
    offered.filter((n) => n.startsWith('mcp__composio__')).length === 6 &&
    !offered.includes('mcp__composio__COMPOSIO_REMOTE_WORKBENCH') &&
    !offered.includes('mcp__composio__COMPOSIO_SUBMIT_FEEDBACK') &&
    !offered.includes('mcp__composio__COMPOSIO_SEARCH_SKILLS'),
    offered.filter((n) => n.startsWith('mcp__composio__')).join(', '))

  // ============ C2: blocco di sole letture → NESSUNA card ============
  pushTool(BATCH, { tools: [{ tool_slug: 'GMAIL_LIST_THREADS', arguments: { max: 5 } }], thought: 'elenca', sync_response_to_workbench: true })
  pushText('Fatto: 5 conversazioni.')
  await closeAppWindow() // K1
  await uiSend('Elencami le conversazioni di Gmail.')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.includes('5 conversazioni'))`, 30_000).catch(() => undefined)
  await sleep(1_000)
  check('C2a blocco di sole letture: NESSUNA card d\'approvazione',
    (await pendingApprovals(bot.id)).length === 0)
  check('C2b la lettura è arrivata al server MCP finto CON sync_response_to_workbench false',
    (await waitFakeCalls(1)) && fakeCalls()[0]?.name === 'COMPOSIO_MULTI_EXECUTE_TOOL' && fakeCalls()[0]?.args?.sync_response_to_workbench === false,
    JSON.stringify(fakeCalls()[0]?.args?.sync_response_to_workbench))

  // ============ C4: dopo il risultato non fidato, lettura su app NUOVA → card ============
  // nello STESSO turno non è più possibile (il turno è chiuso): si riapre con
  // una lettura su un toolkit mai usato DOPO che il turno è stato contaminato
  // dalla lettura Gmail qui sopra → il nuovo turno parte già con la regola di
  // fiducia per le letture su app nuove? No: la contaminazione è per turno.
  // Per provarla SERVE un turno con due chiamate: la prima contamina, la
  // seconda legge un'app nuova → card (fiducia C4).
  pushTool(BATCH, { tools: [{ tool_slug: 'SLACK_SEARCH_MESSAGES', arguments: { query: 'sonda' } }], sync_response_to_workbench: false })
  pushTool(BATCH, { tools: [{ tool_slug: 'NOTION_GET_PAGES', arguments: {} }], sync_response_to_workbench: false })
  pushText('Fatto.')
  await closeAppWindow() // K1
  await uiSend('Cerca su Slack e poi dimmi le pagine di Notion.')
  check('C4 dopo il risultato di Slack, la lettura su Notion (app nuova) chiede la card',
    await waitDom(`!![...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('tramite Composio'))`, 30_000))
  await sleep(600)
  const c4Approval = (await pendingApprovals(bot.id)).at(-1)
  check('C4b la card è quella di fiducia (motivo dell\'id approval.composioTrust)',
    c4Approval?.meta?.ui?.id === 'approval.composioTrust', JSON.stringify(c4Approval?.meta?.ui?.id))
  // K1: la card di fiducia dev'essere VISIBILE IN CIMA prima della cattura
  const k1fiducia = await visibleOnTop('[data-testid="approval-tech-details"]')
  check('K1 la card di fiducia è scoperta (elementFromPoint dentro la card)', k1fiducia === true, String(k1fiducia))
  await shotsOf('card-fiducia')
  // si chiude la card per proseguire puliti
  await clickByText('Rifiuta')
  await sleep(1_200)

  // ============ C2: lettura + scrittura → card con le DUE azioni ============
  pushTool(BATCH, {
    tools: [
      { tool_slug: 'GMAIL_LIST_THREADS', arguments: { max: 2 } },
      { tool_slug: 'SLACK_CREATE_REMINDER', arguments: { channel: '#sonda', text: 'ricordati la sonda' } }
    ],
    sync_response_to_workbench: false
  })
  pushText('aspetto il consenso')
  await closeAppWindow() // K1
  await uiSend('Leggi Gmail e crea un promemoria su Slack.')
  check('C2c lettura + scrittura → card d\'approvazione con le DUE azioni',
    await waitDom(`!![...document.querySelectorAll('[data-testid="composio-batch-actions"]')].some((x) => x.offsetParent !== null && x.textContent.includes('Gmail · Elenca conversazioni') && x.textContent.includes('Slack · Crea promemoria'))`, 30_000))
  const batchCardText = await pageEval(`return [...document.querySelectorAll('[data-testid="composio-batch-actions"]')].filter((x) => x.offsetParent !== null).pop()?.textContent ?? ''`)
  check('C2d la card mostra gli argomenti brevi dell\'azione (canale e testo)',
    batchCardText.includes('#sonda') && batchCardText.includes('ricordati la sonda'), batchCardText.slice(0, 100))
  // K1 (ritocchi): C2e riscritto — la vecchia era una tautologia (un nome che
  // non esiste non può comparire). Ora: riga «tramite Composio» visibile,
  // Dettagli tecnici CHIUSI (un <details> senza open) col nome tecnico DENTRO,
  // e il testo visibile della card SENZA i dettagli che non lo contiene
  const c2e = await pageEval(`return (() => {
    const details = [...document.querySelectorAll('[data-testid="approval-tech-details"]')].filter((x) => x.offsetParent !== null).pop()
    if (!details) return 'dettagli non trovati'
    if (details.tagName !== 'DETAILS') return 'non è un <details>: ' + details.tagName
    if (details.open || details.hasAttribute('open')) return 'i dettagli sono APERTI'
    const card = details.closest('.rounded-\\\\[18px\\\\]')
    if (!card) return 'card non trovata'
    if (!card.innerText.includes('tramite Composio')) return 'manca la riga «tramite Composio»'
    if (!details.textContent.includes('COMPOSIO_MULTI_EXECUTE_TOOL')) return 'il nome tecnico non è nei dettagli'
    const senzaDettagli = card.cloneNode(true)
    senzaDettagli.querySelectorAll('details').forEach((d) => d.remove())
    return senzaDettagli.innerText.includes('COMPOSIO_MULTI_EXECUTE_TOOL') ? 'il nome tecnico è VISIBILE fuori dai dettagli' : true
  })()`)
  check('C2e la card ha la riga «tramite Composio»; il nome tecnico sta SOLO nei Dettagli chiusi', c2e === true, String(c2e))
  // K1: la card del blocco dev'essere VISIBILE IN CIMA prima della cattura
  const k1blocco = await visibleOnTop('[data-testid="composio-batch-actions"]')
  check('K1 la card del blocco è scoperta (elementFromPoint dentro la card)', k1blocco === true, String(k1blocco))
  await shotsOf('card-blocco')
  await clickByText('Consenti')
  check('C2f dopo il consenso il blocco intero è eseguito (una sola chiamata con le due voci)',
    (await waitFakeCalls(3)) && fakeCalls()[2]?.args?.tools?.length === 2,
    `voci: ${fakeCalls()[2]?.args?.tools?.length}`)
  await sleep(1_500)

  // ============ C2: distruttiva senza «Sempre» ============
  pushTool(BATCH, { tools: [{ tool_slug: 'NOTION_DELETE_PAGE', arguments: { page_id: 'p1' } }], sync_response_to_workbench: false })
  pushText('aspetto')
  await closeAppWindow() // K1
  await uiSend('Elimina la pagina p1 su Notion.')
  check('C2g distruttiva → card',
    await waitDom(`!![...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && /non si (può|possono) annullare/.test(d.textContent))`, 30_000))
  // K1: anche senza cattura, la card dev'essere VISIBILE IN CIMA
  const k1distruttiva = await visibleOnTop('[data-testid="approval-tech-details"]')
  check('K1 la card distruttiva è scoperta (elementFromPoint dentro la card)', k1distruttiva === true, String(k1distruttiva))
  const sembreDisabled = await pageEval(`
    const card = [...document.querySelectorAll('div')].filter((d) => d.offsetParent !== null && /non si (può|possono) annullare/.test(d.textContent)).pop()
    const menu = card?.querySelector('[aria-haspopup="menu"]')
    if (!menu) return null
    menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    menu.click()
    await new Promise((r) => setTimeout(r, 500))
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const sempre = items.find((x) => x.textContent.trim() === 'Sempre')
    return sempre ? (sempre.getAttribute('aria-disabled') === 'true' || sempre.getAttribute('data-disabled') === 'true' || sempre.disabled === true) : null
  `)
  check('C2h la distruttiva NON offre «Sempre» (voce disabilitata)', sembreDisabled === true, `sempre disabilitato: ${sembreDisabled}`)
  await pageEval(`document.body.click()`)
  await sleep(400)
  await clickByText('Rifiuta')
  await sleep(1_000)

  // ============ C7: lettura + invio → bozza estratta + lettura eseguita ============
  const callsBefore = fakeCalls().length
  pushTool(BATCH, {
    tools: [
      { tool_slug: 'GMAIL_LIST_THREADS', arguments: { max: 3 } },
      { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'capo@sonda.prova', subject: 'Saluti', body: 'ciao dalla sonda OAuth' } }
    ],
    sync_response_to_workbench: false
  })
  pushText('Bozza pronta.')
  await closeAppWindow() // K1
  await uiSend('Leggi Gmail e manda un\'email al capo.')
  check('C7a la voce d\'invio diventa BOZZA (card Invia/Scarta)',
    await waitDom(`!![...document.querySelectorAll('button')].some((b) => b.offsetParent !== null && b.textContent.trim() === 'Invia')`, 30_000))
  // K7: la bozza dice da DOVE parte («Gmail tramite Composio», regola A7)
  const bozzaText = await pageEval(`return [...document.querySelectorAll('[data-testid="draft-card"]')].filter((x) => x.offsetParent !== null).pop()?.innerText ?? ''`)
  check('K7 la bozza contiene «Gmail tramite Composio» (la riga della via)',
    bozzaText.includes('Gmail tramite Composio'), bozzaText.split('\\n').slice(0, 3).join(' | '))
  // K1: la bozza dev'essere VISIBILE IN CIMA prima della cattura
  const k1bozza = await visibleOnTop('[data-testid="draft-card"]')
  check('K1 la bozza è scoperta (elementFromPoint dentro la card)', k1bozza === true, String(k1bozza))
  check('C7b la lettura è passata SENZA card ed è stata eseguita da sola (chiamata con la SOLA lettura)',
    (await waitFakeCalls(callsBefore + 1)) && fakeCalls().at(-1)?.args?.tools?.length === 1 && fakeCalls().at(-1)?.args?.tools[0]?.tool_slug === 'GMAIL_LIST_THREADS',
    `voci: ${fakeCalls().at(-1)?.args?.tools?.length}`)
  check('C7c NESSUNA approval in sospeso per il blocco (l\'invio è bozza, la lettura è passata)',
    (await pendingApprovals(bot.id)).length === 0)
  const draftEntry = (await rpc(`getEntries(${JSON.stringify(bot.id)})`)).findLast((e) => e.meta?.message?.type === 'draft')
  check('C7d la bozza porta to/subject/body dalla voce e la via è il blocco con UNA sola voce',
    draftEntry?.meta?.message?.to === 'capo@sonda.prova' && draftEntry?.meta?.message?.subject === 'Saluti' &&
    draftEntry?.meta?.message?.via?.tool === BATCH && draftEntry?.meta?.message?.via?.args?.tools?.length === 1 &&
    draftEntry?.meta?.message?.via?.args?.sync_response_to_workbench === false,
    JSON.stringify({ to: draftEntry?.meta?.message?.to, viaTools: draftEntry?.meta?.message?.via?.args?.tools?.length }))
  await shotsOf('bozza-estratta')
  const callsBeforeSend = fakeCalls().length
  await clickByText('Invia')
  check('C7e «Invia» esegue UNA volta il blocco con la SOLA voce d\'invio (e sync false)',
    (await waitFakeCalls(callsBeforeSend + 1)) && fakeCalls().at(-1)?.args?.tools?.length === 1 &&
    fakeCalls().at(-1)?.args?.tools[0]?.tool_slug === 'GMAIL_SEND_EMAIL' && fakeCalls().at(-1)?.args?.sync_response_to_workbench === false,
    JSON.stringify({ voci: fakeCalls().at(-1)?.args?.tools?.length, sync: fakeCalls().at(-1)?.args?.sync_response_to_workbench }))
  await sleep(1_200)

  // ============ C5: MANAGE_CONNECTIONS add → card di collegamento ============
  // il gate chiede PRIMA (C5 è una voce «connect»: card d'approvazione senza
  // «sempre»), poi l'esecuzione crea la card di collegamento col link
  pushTool(MANAGE, { toolkits: [{ name: 'slack', action: 'add' }] })
  pushText('Link pronto in card.')
  await closeAppWindow() // K1
  await uiSend('Collega Slack.')
  // K3: l'azione della card è LOCALIZZATA («Slack · Collega», non «Slack · add»)
  const c5approval = await waitDom(`!![...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && (d.textContent.includes('vuole collegare o cambiare le app connesse tramite Composio') || /Slack · Collega/.test(d.textContent)))`, 30_000)
  check('C5a il modello chiama add → la CARD D\'APPROVAZIONE del collegamento (id approval.composioConnect)',
    c5approval,
    c5approval ? '' : `chat: ${String(await pageEval('return document.body.innerText.slice(-1200)')).slice(-600)}`)
  const c5cardText = await pageEval(`return [...document.querySelectorAll('[data-testid="composio-batch-actions"]')].filter((x) => x.offsetParent !== null).pop()?.innerText ?? ''`)
  check('K3 la card d\'approvazione del collegamento dice «Slack · Collega» (azione localizzata)',
    c5cardText.includes('Slack · Collega') && !c5cardText.includes('Slack · add'), c5cardText.split('\\n')[0] ?? '')
  await clickByText('Consenti')
  await sleep(800)
  // K3: la riga decisa dice «Slack · Collega», non «Slack · add»
  const k3decisa = await waitDom(`!![...document.querySelectorAll('button, div')].some((d) => d.offsetParent !== null && d.textContent.includes('Consentito una volta') && d.textContent.includes('Slack · Collega'))`, 15_000)
  check('K3 la riga decisa dice «Slack · Collega»', k3decisa)
  const c5card = await waitDom(`!![...document.querySelectorAll('div')].some((d) => d.offsetParent !== null && d.textContent.includes('Collega Slack tramite Composio'))`, 20_000)
  check('C5a2 dopo il consenso → card di collegamento «Collega Slack tramite Composio» (nome umano, K3)',
    c5card,
    c5card ? '' : `testo card: ${String(await pageEval(`return (() => { const cards = [...document.querySelectorAll('div')].filter((d) => d.textContent.includes('composio-app')); return document.body.innerText.split('\\n').filter((l) => l.includes('Collega') || l.includes('tramite Composio')).join(' | ').slice(-400) })()`))}`)
  // il risultato al modello NON contiene il link
  const modelSawLink = await rpc(`getEntries(${JSON.stringify(bot.id)})`).then((entries) => {
    const result = entries.findLast((e) => e.kind === 'tool-result' && e.meta?.callId)
    return result?.content?.includes('/link/slack') ?? false
  })
  check('C5b il risultato al modello NON contiene il link (sta solo nella card)',
    modelSawLink === false)
  // K1: la card di collegamento dev'essere VISIBILE IN CIMA prima della cattura
  const k1collegamento = await visibleOnTop('[data-testid="connector-card"]')
  check('K1 la card di collegamento è scoperta (elementFromPoint dentro la card)', k1collegamento === true, String(k1collegamento))
  await shotsOf('card-collegamento')
  await clickByText('Collega')
  check('C5c il clic apre il link nel «browser finto» (registrato, mai il browser vero)',
    await (async () => {
      const deadline = Date.now() + 15_000
      for (;;) {
        try {
          if (readFileSync(LINKS_LOG, 'utf8').includes('slack')) return true
        } catch { /* ancora niente */ }
        if (Date.now() > deadline) return false
        await sleep(300)
      }
    })())
  check('C5d la card si aggiorna a «Collegata» dopo il login finto (WAIT_FOR_CONNECTIONS)',
    await waitDom(`!![...document.querySelectorAll('p')].some((p) => p.offsetParent !== null && p.textContent.includes('✓ Collegata'))`, 20_000))

  // ---- la finestra App: il dettaglio di Composio con le app collegate ----
  await clickByLabel('App')
  check('C5e la riga Composio sta in «Collegate»', await waitDom(`!!(${APP_DIALOG}) && ${APP_DIALOG}.textContent.includes('Composio')`, 10_000))
  // K5: la riga Composio dice «Tramite Composio», MAI «Diretta» (login e
  // azioni passano dai server di Composio, non restano sul Mac)
  const k5row = await pageEval(`
    const dialog = ${APP_DIALOG}
    const row = [...((dialog ?? document).querySelectorAll('button'))].find((b) => b.textContent.includes('Composio'))
    if (!row) throw new Error('riga Composio non trovata')
    return row.textContent
  `)
  check('K5 la riga Composio in «Collegate» non contiene «Diretta» (dice Tramite Composio)',
    k5row.includes('Tramite Composio') && !k5row.includes('Diretta'), k5row.slice(0, 140))
  await pageEval(`
    const dialog = ${APP_DIALOG}
    const row = [...((dialog ?? document).querySelectorAll('button'))].find((b) => b.textContent.includes('Composio'))
    if (!row) throw new Error('riga Composio non trovata')
    row.click()
    return 'dettaglio'
  `)
  check('C5f il dettaglio del gateway elenca «App collegate tramite Composio» con Slack Collegata',
    await waitDom(`!!document.querySelector('[data-testid="composio-gateway-detail"]') && [...document.querySelectorAll('[data-testid="gateway-app-slack"]')].some((x) => x.offsetParent !== null && x.textContent.includes('Collegata'))`, 15_000))
  // K2: quando slack è Collegata, nel dettaglio NON c'è più il riquadro
  // «Non riuscito» della sua attesa (ieri convivevano)
  const k2detail = await pageEval(`return document.querySelector('[data-testid="composio-gateway-detail"]')?.textContent ?? ''`)
  check('K2 nel dettaglio non c\'è «Non riuscito» quando slack è Collegata',
    !k2detail.includes('Non riuscito'), k2detail.split('\\n').filter((l) => l.includes('Slack') || l.includes('riuscito')).join(' | ').slice(0, 160))
  await shotsOf('dettaglio-gateway')

  // ============ C8: la riga dei pari dice le app, non «Composio» ============
  const appsLine = await rpc('composioGatewayStatus()')
  check('C8 lo status del gateway ha slack ACTIVE (la riga dei pari la legge con appsForAgent)',
    appsLine?.connected?.some((a) => a.slug === 'slack' && a.status === 'ACTIVE') === true,
    JSON.stringify(appsLine?.connected?.map((a) => `${a.slug}:${a.status}`)))

  // ---- K1: due PNG con NOMI diversi non possono avere lo stesso hash ----
  // (ieri card-fiducia-900-* e card-blocco-900-* erano byte per byte uguali:
  // il sintomo della finestra App sopra la chat; se torna, la sonda fallisce)
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
  try { mcpServer.closeAllConnections?.(); mcpServer.close() } catch { /* già chiusa */ }
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
