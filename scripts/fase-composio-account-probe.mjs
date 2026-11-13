#!/usr/bin/env node
// Sonda Electron della fase «composio-account» (CA): più account per la
// stessa app, e il bot che sa subito cosa è collegato. L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, con l'isolamento delle
// sonde Composio precedenti: AS FINTO con discovery (RFC 9728), DCR e PKCE
// S256, server Composio FINTO su 127.0.0.1 (la fixture ridotta del repo, via
// SANDBOT_TEST_COMPOSIO_MCP_URL) che tiene PIÙ ACCOUNT per toolkit (add con
// alias e link per account, list con alias/email/is_default, rename,
// remove), provider FINTO openai-compatible e «browser» finto che segue i
// redirect. NESSUNA RETE VERA, tutto su 127.0.0.1. Copre:
//   CA1: due account Gmail nella finestra App — il collegamento del primo
//        (col login di Composio in mezzo), «Aggiungi un altro account» con
//        alias «personale» e il secondo che si collega;
//   CA2: il dettaglio elenca gli account (alias in grassetto, email in
//        grigio, «Da ricollegare» per i non attivi), «Rinomina» (fabio →
//        lavoro) e «Togli» (con conferma);
//   CA3: il turno del provider finto riceve la riga «Gmail — accounts:
//        lavoro (fabio@azienda.test), personale (fabio@gmail.test)» con la
//        regola `account`, e search_connectors comincia con «Already
//        connected via Composio: …»;
//   K1: ogni cattura è preceduta da visibleOnTop e due PNG con nomi diversi
//        non possono avere lo stesso hash.
// Catture in docs/catture/composio-account/. A FINE SONDA si chiude ANCHE
// il daemon di sviluppo (pid in daemon.lock dentro la cartella dati
// temporanea), la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-composio-account-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'composio-account')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

// i 12 strumenti dalla fixture ridotta del repo (il server Composio finto)
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'src/main/connectors/__tests__/fixtures/composio-for-you-tools.json'), 'utf8'))
const MANAGE = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'

// le email dei DUE login finti: il primo account (fabio@azienda.test) e il
// secondo, aggiunto da «Aggiungi un altro account» con alias «personale»
const EMAILS = ['fabio@azienda.test', 'fabio@gmail.test']
// dopo quanti ms dal link seguito l'account diventa ATTIVO (la fase
// «Completa il login…» deve vedersi)
const LOGIN_MS = 2000

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

// ---- il server Composio FINTO: PIÙ ACCOUNT per toolkit ----
// Ogni add crea un account NUOVO (INITIATED, con l'alias richiesto) e un
// link che porta l'id dell'account e l'email del login finto; il «browser»
// finto apre il link, l'account diventa attivo dopo LOGIN_MS (dentro la
// WAIT, come il login vero). `list` torna TUTTI gli account con
// alias/email/is_default; rename e remove per account_id.
const composioState = {
  url: '',
  /** slug → Array<{ id, alias, email, status, openedAt }> */
  accounts: new Map(),
  adds: 0,
  manageCalls: []
}
const composioServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // il «login finto» dell'app: /link/<slug>/<accountId>?email=…
  if (req.method === 'GET' && url.pathname.startsWith('/link/')) {
    const [, , slug, id] = url.pathname.split('/')
    const email = url.searchParams.get('email') ?? 'utente@example.com'
    const account = (composioState.accounts.get(slug) ?? []).find((a) => a.id === id)
    if (account) {
      account.openedAt = Date.now()
      account.email = email
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>login finto riuscito</body></html>')
    return
  }
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      resource: composioState.url,
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
      'www-authenticate': `Bearer resource_metadata="${composioState.url.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
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
      return send({
        tools: FIXTURE.tools.map((t) => ({
          name: t.name,
          description: t.title ?? t.name,
          inputSchema: t.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
          ...(t.annotations ? { annotations: t.annotations } : {})
        }))
      })
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name ?? ''
      const args = msg.params?.arguments ?? {}
      if (name === 'COMPOSIO_MANAGE_CONNECTIONS') {
        composioState.manageCalls.push(JSON.parse(JSON.stringify(args)))
        const out = { successful: true, data: { results: {}, session: { id: 'sessione-finta', instructions: '…' } }, error: null }
        for (const entry of args.toolkits ?? []) {
          const slug = entry.name
          const list = composioState.accounts.get(slug) ?? []
          if (entry.action === 'add') {
            // SEMPRE un account nuovo (CA1: add non cortocircuita mai)
            composioState.adds++
            const id = `acc_${slug}_${composioState.adds}`
            const email = EMAILS[composioState.adds - 1] ?? 'utente@example.com'
            list.push({ id, alias: entry.alias, email: null, status: 'INITIATED', openedAt: null })
            composioState.accounts.set(slug, list)
            out.data.results[slug] = {
              toolkit: slug,
              status: 'success',
              redirect_url: `${composioState.url.replace(/\/mcp$/, '')}/link/${slug}/${id}?email=${encodeURIComponent(email)}&req=${randomBytes(3).toString('hex')}`
            }
          } else if (entry.action === 'list') {
            const anyActive = list.some((a) => a.status === 'ACTIVE')
            out.data.results[slug] = {
              toolkit: slug,
              status: anyActive ? 'active' : 'initiated',
              accounts: list.map((a, i) => ({
                id: a.id,
                status: a.status.toLowerCase(),
                is_default: i === 0,
                ...(a.alias ? { alias: a.alias } : {}),
                ...(a.email ? { user_info: { email: a.email } } : {})
              }))
            }
          } else if (entry.action === 'rename') {
            const account = list.find((a) => a.id === entry.account_id)
            if (account) account.alias = entry.alias
            out.data.results[slug] = { toolkit: slug, status: 'renamed' }
          } else if (entry.action === 'remove') {
            composioState.accounts.set(slug, list.filter((a) => a.id !== entry.account_id))
            out.data.results[slug] = { toolkit: slug, status: 'removed' }
          }
        }
        return send({ content: [{ type: 'text', text: JSON.stringify(out) }] })
      }
      if (name === 'COMPOSIO_WAIT_FOR_CONNECTIONS') {
        const slug = (args.toolkits ?? [])[0] ?? ''
        const deadline = Date.now() + 300_000
        const poll = () => {
          const list = composioState.accounts.get(slug) ?? []
          const pending = list.filter((a) => a.status === 'INITIATED')
          // l'account col link seguito diventa attivo dopo LOGIN_MS (il
          // «login nel browser» dell'utente); senza attese aperte risponde subito
          for (const a of pending) {
            if (a.openedAt !== null && Date.now() - a.openedAt >= LOGIN_MS) a.status = 'ACTIVE'
          }
          if (list.filter((a) => a.status === 'INITIATED').length === 0) {
            return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: list.map((a) => ({ id: a.id, status: a.status })) }] }) }] })
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
    res.writeHead(404).end()
  })
})
await new Promise((r) => composioServer.listen(0, '127.0.0.1', r))
composioState.url = `http://127.0.0.1:${composioServer.address().port}/mcp`
log('server MCP Composio finto su', composioState.url, '· AS finto su', asUrl)

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
      SANDBOT_TEST_COMPOSIO_MCP_URL: composioState.url,
      SANDBOT_TEST_FAKE_BROWSER: '1',
      // OB (fase onboarding-b): macchina NON supportata (fatto finto): il
      // passo Computer non c'è e la guida si attraversa come prima
      SANDBOT_TEST_FAKE_ARCH: 'x86_64'
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
const setInputValue = (inputExpr, value) => pageEval(`
  const input = ${inputExpr}
  if (!input) throw new Error('campo non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'scritto'
`)
/** il testo del dettaglio di Gmail (finestra App aperta sul suo foglio) */
const DETAIL = `document.querySelector('[data-testid="app-detail-gmail"]')`
const detailText = () => pageEval(`return ${DETAIL}?.innerText ?? ''`)

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // fase guida: al primo avvio c'è la GUIDA — la si attraversa coi clic
  // (benvenuto → modello saltato → permessi «Chiedimi prima», che qui scrive
  // i default → Pronto → «Apri la chat») e la card del focus si chiude senza
  // scegliere. I flussi di questa sonda sono sugli ACCOUNT, non sulla guida
  if (await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 20_000)) {
    await clickTestid('guide-continue')
    await waitDom(`!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000)
    await clickTestid('guide-skip')
    await waitDom(`!!document.querySelector('[data-testid="guide-step-approvals"]')`, 10_000)
    await clickTestid('guide-approvals-ask')
    await waitDom(`!document.querySelector('[data-testid="guide-continue"]')?.disabled`, 10_000)
    await clickTestid('guide-continue')
    await waitDom(`!!document.querySelector('[data-testid="guide-step-ready"]')`, 10_000)
    await clickTestid('guide-continue')
  }
  await waitDom(`!!document.querySelector('form textarea')`, 25_000)
  if (await waitDom(`!!document.querySelector('[data-testid="focus-dismiss"]')`, 8_000)) {
    await clickTestid('focus-dismiss')
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

  // ============ CA1: il primo account Gmail (col login di Composio in mezzo) ============
  await clickByLabel('App')
  check('CA1a la finestra App si apre', await waitDom(`!!document.querySelector('[data-testid="app-filters"]')`, 10_000))
  await sleep(600)
  await clickTestid('app-connect-gmail')
  check('CA1b il collegamento di Gmail arriva a «Connessa» (login di Composio incluso)',
    await waitDom(`!!document.querySelector('[data-testid="app-row-gmail"]') && document.querySelector('[data-testid="app-row-gmail"]').innerText.includes('Connessa')`, 90_000),
    'attesi login di Composio + login di Gmail finti')

  // ============ CA2: il dettaglio elenca gli account ============
  await clickTestid('app-row-gmail')
  check('CA2a il dettaglio di Gmail mostra la sezione degli account', await waitDom(`!!document.querySelector('[data-testid="app-accounts"]')`, 8_000))
  await sleep(600)
  const oneAccount = await detailText()
  check('CA2b UN account: alias «fabio» (parte locale dell\'email) e l\'email in grigio, MAI l\'id tecnico',
    oneAccount.includes('fabio') && oneAccount.includes('fabio@azienda.test') && !oneAccount.includes('acc_gmail'),
    oneAccount.split('\n').filter((l) => l.includes('fabio') || l.includes('acc_')).join(' | '))
  const k1uno = await visibleOnTop('[data-testid="app-accounts"]')
  check('K1 la sezione account è scoperta', k1uno === true, String(k1uno))
  await shot('dettaglio-un-account-1440-chiaro.png')

  // ============ CA1/CA2: «Aggiungi un altro account» con alias ============
  await clickTestid('app-add-account')
  check('CA1c «Aggiungi un altro account» chiede un nome facoltativo (placeholder «lavoro, personale…»)',
    await waitDom(`!!document.querySelector('[data-testid="app-accounts"] input')`) &&
    (await pageEval(`return document.querySelector('[data-testid="app-accounts"] input')?.placeholder ?? ''`)) === 'lavoro, personale…',
    await pageEval(`return document.querySelector('[data-testid="app-accounts"] input')?.placeholder ?? '(nessuno)'`))
  await shot('aggiungi-altro-account-1440-chiaro.png')
  await setInputValue(`document.querySelector('[data-testid="app-accounts"] input')`, 'personale')
  await pageEval(`
    const box = document.querySelector('[data-testid="app-accounts"]')
    const btn = [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Collega')
    if (!btn) throw new Error('bottone Collega non trovato')
    btn.click()
    return 'collega cliccato'
  `)
  check('CA1d il SECONDO account (alias «personale», fabio@gmail.test) compare nel dettaglio',
    await waitDom(`${DETAIL}?.innerText.includes('personale') && ${DETAIL}?.innerText.includes('fabio@gmail.test')`, 60_000),
    'il login finto del secondo account dura ' + LOGIN_MS + ' ms')
  await sleep(800)
  const twoAccounts = await detailText()
  check('CA2c il dettaglio elenca DUE account: fabio (fabio@azienda.test) e personale (fabio@gmail.test)',
    twoAccounts.includes('fabio') && twoAccounts.includes('fabio@azienda.test') && twoAccounts.includes('personale') && twoAccounts.includes('fabio@gmail.test'),
    twoAccounts.split('\n').filter((l) => l.includes('fabio') || l.includes('personale')).join(' | '))
  const k1due = await visibleOnTop('[data-testid="app-accounts"]')
  check('K1 l\'elenco dei due account è scoperto', k1due === true, String(k1due))
  await shot('dettaglio-due-account-1440-chiaro.png')
  await pageEval(`document.documentElement.classList.add('dark')`)
  await sleep(350)
  await shot('dettaglio-due-account-1440-scuro.png')
  await pageEval(`document.documentElement.classList.remove('dark')`)
  await sleep(350)

  // ============ CA2: «Rinomina» ============
  await pageEval(`
    const row = document.querySelector('[data-testid="app-account-acc_gmail_1"]')
    if (!row) throw new Error('riga del primo account non trovata')
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Rinomina')
    if (!btn) throw new Error('bottone Rinomina non trovato')
    btn.click()
    return 'rinomina aperta'
  `)
  await sleep(300)
  await setInputValue(`document.querySelector('[data-testid="app-account-acc_gmail_1"] input')`, 'lavoro')
  await shot('rinomina-account-1440-chiaro.png')
  await pageEval(`
    const row = document.querySelector('[data-testid="app-account-acc_gmail_1"]')
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Salva')
    if (!btn) throw new Error('bottone Salva non trovato')
    btn.click()
    return 'salvato'
  `)
  check('CA2d «Rinomina» fabio → lavoro: la riga aggiorna alias ed email',
    await waitDom(`${DETAIL}?.innerText.includes('lavoro') && ${DETAIL}?.innerText.includes('fabio@azienda.test') && !${DETAIL}?.innerText.includes('Rinomina fabio')`, 20_000))
  // la rename è arrivata al server finto con l'alias normalizzato
  const renameCall = composioState.manageCalls.find((c) => (c.toolkits ?? []).some((e) => e.action === 'rename'))
  check('CA2e la rename al server porta account_id e alias «lavoro»',
    Boolean(renameCall && renameCall.toolkits[0].account_id === 'acc_gmail_1' && renameCall.toolkits[0].alias === 'lavoro'),
    JSON.stringify(renameCall?.toolkits ?? null))
  await pageEval(`document.querySelector('[data-testid="app-detail-gmail"]')?.closest('div.fixed')?.click()`)
  await sleep(400)
  await closeAppWindow()

  // ============ CA3: il turno riceve la riga con i DUE account ============
  pushTool('send_to_user', { text: 'Pronto.' })
  await uiSend('Ciao')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Pronto.')`, 30_000).catch(() => undefined)
  await sleep(800)
  const systemOf = (request) => String((request?.messages ?? [])[0]?.content ?? '')
  const lastSystem = systemOf(chatRequests.at(-1))
  check('CA3a il turno riceve la riga con i DUE account e la regola `account`',
    lastSystem.includes('Gmail — accounts: lavoro (fabio@azienda.test), personale (fabio@gmail.test)') &&
    lastSystem.includes('pass `account` in every MULTI_EXECUTE item for Gmail'),
    lastSystem.match(/Connected apps[^.]*/)?.[0]?.slice(0, 160) ?? '(riga non trovata)')

  // ---- CA3: search_connectors comincia con ciò che è GIÀ collegato ----
  // (il tool sta in un gruppo: la prima chiamata lo ATTIVA, la seconda gira)
  pushTool('search_connectors', { query: 'posta' })
  pushTool('search_connectors', { query: 'posta' })
  pushTool('send_to_user', { text: 'Fatto.' })
  await uiSend('Cosa posso collegare per la posta?')
  await waitDom(`[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === 'Fatto.')`, 40_000).catch(() => undefined)
  await sleep(800)
  const toolTexts = chatRequests
    .slice(-4)
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content)))
    .join('\n---\n')
  check('CA3b search_connectors («posta») dice PRIMA cosa c\'è già, con i due account',
    toolTexts.includes('Already connected via Composio: Gmail (lavoro: fabio@azienda.test, personale: fabio@gmail.test)'),
    toolTexts.slice(0, 200))

  // ============ CA2: «Togli» (con conferma) ============
  await clickByLabel('App')
  await waitDom(`!!(${APP_DIALOG})`, 10_000)
  await clickTestid('app-row-gmail')
  check('CA2f il dettaglio si riapre con i due account', await waitDom(`!!document.querySelector('[data-testid="app-accounts"]')`, 8_000))
  await pageEval(`
    const row = document.querySelector('[data-testid="app-account-acc_gmail_2"]')
    if (!row) throw new Error('riga del secondo account non trovata')
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Togli')
    if (!btn) throw new Error('bottone Togli non trovato')
    btn.click()
    return 'togli cliccato'
  `)
  await sleep(300)
  check('CA2g «Togli» chiede la CONFERMA («Togli davvero»)',
    await pageEval(`
      const row = document.querySelector('[data-testid="app-account-acc_gmail_2"]')
      return !!row && [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Togli davvero')
    `))
  await pageEval(`
    const row = document.querySelector('[data-testid="app-account-acc_gmail_2"]')
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Togli davvero')
    if (!btn) throw new Error('conferma non trovata')
    btn.click()
    return 'confermato'
  `)
  check('CA2h dopo il Togli resta UN account (lavoro), personale sparito',
    await waitDom(`!document.querySelector('[data-testid="app-account-acc_gmail_2"]') && ${DETAIL}?.innerText.includes('lavoro')`, 20_000))
  const k1dopo = await visibleOnTop('[data-testid="app-accounts"]')
  check('K1 l\'elenco dopo il Togli è scoperto', k1dopo === true, String(k1dopo))
  await shot('dopo-togli-1440-chiaro.png')
  await closeAppWindow()

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
  try { composioServer.closeAllConnections?.(); composioServer.close() } catch { /* già chiusa */ }
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
