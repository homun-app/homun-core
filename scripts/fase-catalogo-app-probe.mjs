#!/usr/bin/env node
// Sonda Electron della fase catalogo app (P3–P8). L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, con lo stesso isolamento e
// gli stessi server FINTI della sonda OAuth: AS con discovery (RFC 9728), DCR
// e PKCE S256, server MCP «Composio For You» con MANAGE_CONNECTIONS che
// restituisce un redirect_url finto e il «browser» finto che lo segue. Il
// catalogo è quello curato nel repo (composio-catalog.json, coi loghi veri):
// NESSUNA RETE VERA, tutto su 127.0.0.1.
// Copre:
//   P3: nessuna riga «Composio» nell'elenco e nessun campo slug; filtri a
//       pillola (anche «Altro ▾»), «Visualizza tutto»; ricerca «gma» → Gmail
//       per prima; ricerca senza risultati → messaggio vuoto gentile;
//       marchio doppio: UNA sola riga Gmail; testata «1 connesse ›» col logo;
//   P4: «Connetti» su Gmail con Composio NON ancora entrato → «Accedi a
//       Composio nel browser…» → login finto → «Completa il login di Gmail
//       nel browser…» → riga «Connessa», SENZA mai aprire la riga Composio
//       (che non esiste più);
//   P5: dettaglio di Gmail con «Tramite Composio» e Scollega;
//   P6: la riga discreta «Account Composio · connesso» e il suo foglio
//       (Gestisci su Composio, Disattiva).
// K1 (ritocchi): ogni cattura è preceduta da visibleOnTop e a fine sonda due
// PNG con nomi diversi non possono avere lo stesso hash.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-catalogo-app-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'catalogo-app')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

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
    // fase «Accedi a Composio nel browser…») e torna al callback di loopback
    const code = 'code_' + randomBytes(6).toString('hex')
    asState.codes.set(code, { challenge, redirectUri })
    setTimeout(() => {
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` }).end()
    }, 1200)
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

// ---- il server MCP FINTO che imita Composio «For You» (minimo indispensabile) ----
// Gli strumenti servono SOLO perché il connettore si collega: MANAGE_CONNECTIONS
// crea i link finti, WAIT_FOR_CONNECTIONS connette chi ha seguito il link.
const TOOLS = [
  { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', description: 'esegui azioni', inputSchema: { type: 'object', properties: {} } },
  { name: 'COMPOSIO_MANAGE_CONNECTIONS', description: 'collega app', inputSchema: { type: 'object', properties: {} } },
  { name: 'COMPOSIO_WAIT_FOR_CONNECTIONS', description: 'attesa login', inputSchema: { type: 'object', properties: {} } },
  { name: 'COMPOSIO_SEARCH_TOOLS', description: 'cerca strumenti', inputSchema: { type: 'object', properties: {} } },
  { name: 'COMPOSIO_GET_TOOL_SCHEMAS', description: 'schemi', inputSchema: { type: 'object', properties: {} } },
  { name: 'COMPOSIO_REMOTE_BROWSER_TOOL', description: 'browser', inputSchema: { type: 'object', properties: {} } }
]
const mcpState = { url: '', linkRequests: new Map() }
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
      return send({ tools: TOOLS })
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
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
          const opened = mcpState.linkRequests.get(slug)?.opened
          // il link seguito non basta: l'ACTIVE arriva dopo un attimo (più di
          // un giro del polling della UI, 2 s), così la sonda vede bene ANCHE
          // la fase «Completa il login di <app> nel browser…»
          const openedAt = mcpState.linkRequests.get(slug)?.at ?? 0
          if (opened && Date.now() - openedAt >= 4200) {
            return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ id: `acc_${slug}`, status: 'ACTIVE' }] }] }) }] })
          }
          if (Date.now() > deadline) return send({ content: [{ type: 'text', text: JSON.stringify({ toolkits: [{ toolkit: slug, accounts: [{ status: 'FAILED' }] }] }) }] })
          setTimeout(poll, 100)
        }
        return poll()
      }
      return send({ content: [{ type: 'text', text: JSON.stringify({ data: {} }) }] })
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r))
mcpState.url = `http://127.0.0.1:${mcpServer.address().port}/mcp`
log('server MCP finto su', mcpState.url, '· AS finto su', asUrl)

// ---- il provider FINTO (serve solo a superare l'onboarding, niente turni in chat) ----
const providerServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9342
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
const clickTextIn = (text, scope) => pageEval(`
  const b = [...document.querySelectorAll(${JSON.stringify(scope)})]
    .filter((x) => x.offsetParent !== null)
    .find((x) => x.textContent.trim() === ${JSON.stringify(text)})
  if (!b) throw new Error('nessun elemento col testo: ' + ${JSON.stringify(text)})
  b.click()
  return 'cliccato'
`)
/** La finestra App: il dialogo che contiene le pillole dei filtri. */
const APP_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('[data-testid="app-filters"]'))`
const dialogText = () => pageEval(`return (${APP_DIALOG})?.textContent ?? ''`)

const setSearch = (q) => pageEval(`
  const input = document.querySelector('input[placeholder="Cerca tra app e skill"]')
  if (!input) throw new Error('campo di ricerca non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(input, ${JSON.stringify(q)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ricerca: ' + ${JSON.stringify(q)}
`)

/**
 * K1 (ritocchi): l'elemento è VISIBILE IN CIMA? scrollIntoView al centro e
 * elementFromPoint del centro DENTRO l'elemento.
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

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- setup: provider finto (per l'onboarding, niente turni in chat) ----
  log('configuro il provider finto e la finestra App…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await page.send('Page.reload')
  await setWindowWidth(1440)

  // ============ P3: la finestra «App» nuova ============
  await clickByLabel('App')
  check('P3a la finestra App si apre (le pillole dei filtri ci sono)', await waitDom(`!!document.querySelector('[data-testid="app-filters"]')`, 10_000))
  await sleep(600)

  // P3b: NESSUNA riga «Composio» e NESSUN campo slug
  const initialText = await dialogText()
  check('P3b nessuna riga «Composio» nell\'elenco (e la parola non compare proprio)',
    !initialText.includes('Composio') && !initialText.includes('composio'),
    initialText.includes('Composio') ? 'la parola compare: ' + initialText.slice(0, 200) : '')
  check('P3c nessun campo slug (il placeholder di ieri non esiste)',
    !initialText.includes("slug dell'app") && !(await pageEval(`return !!document.querySelector('input[list="composio-toolkit-slugs"]')`)))

  // P3d: marchio doppio → UNA sola riga Gmail (consigliata, non due)
  const gmailRows = await pageEval(`return document.querySelectorAll('[data-testid="app-row-gmail"]').length`)
  check('P3d marchio doppio: UNA sola riga Gmail', gmailRows === 1, `righe: ${gmailRows}`)
  // e le consigliate sono SEI (le featured del file di cura)
  const featuredCount = await pageEval(`
    const dialog = ${APP_DIALOG}
    const featured = [...(dialog?.querySelectorAll('p') ?? [])].find((p) => p.textContent.trim() === 'Consigliate per te')
    return featured ? featured.nextElementSibling.querySelectorAll('[data-testid^="app-row-"]').length : -1
  `)
  check('P3e «Consigliate per te» con 6 app su due colonne', featuredCount === 6, `consigliate: ${featuredCount}`)

  // ---- catture: l'elenco iniziale ----
  const k1elenco = await visibleOnTop('[data-testid="app-filters"]')
  check('K1 l\'elenco iniziale è scoperto', k1elenco === true, String(k1elenco))
  await shotsOf('elenco-iniziale')

  // P3f: i filtri a pillola — una categoria, e «Altro ▾» con le categorie che non entrano
  check('P3f le pillole: Tutte, Connesse e le categorie (c\'è «Produttività»)',
    await pageEval(`return [...document.querySelectorAll('[data-testid="app-filters"] button')].some((b) => b.textContent.trim() === 'Produttività')`))
  check('P3g «Altro ▾» raccoglie le categorie che non entrano (dentro c\'è «Finanza»)',
    await pageEval(`
      const pills = [...document.querySelectorAll('[data-testid="app-filters"] button')]
      const altro = pills.find((b) => b.textContent.trim() === 'Altro ▾')
      if (!altro) return false
      altro.click()
      await new Promise((r) => setTimeout(r, 400))
      return [...document.querySelectorAll('[data-testid="app-filters"] [class*="absolute"] button, [data-testid="app-filters"] .absolute button')].some((b) => b.textContent.trim() === 'Finanza')
    `))
  await clickTextIn('Finanza', '[data-testid="app-filters"] button')
  check('P3h il filtro «Finanza» (da Altro ▾) lascia solo le app di finanza',
    await waitDom(`!!(${APP_DIALOG}) && !!${APP_DIALOG}.querySelector('[data-testid="app-row-paypal"]') && !${APP_DIALOG}.querySelector('[data-testid="app-row-gmail"]')`, 8_000))
  const k1filtro = await visibleOnTop('[data-testid="app-row-paypal"]')
  check('K1 la griglia del filtro è scoperta', k1filtro === true, String(k1filtro))
  await shotsOf('filtro-categoria')
  await clickTextIn('Tutte', '[data-testid="app-filters"] button')
  await sleep(500)

  // P3i: «Visualizza tutto» di una sezione con più di 6 app
  check('P3i «Visualizza tutto» della sezione Produttività porta al filtro',
    await pageEval(`
      const btn = document.querySelector('[data-testid="view-all-productivity"]')
      if (!btn) return 'bottone assente'
      btn.click()
      await new Promise((r) => setTimeout(r, 600))
      const grid = ${APP_DIALOG}
      const rows = [...(grid?.querySelectorAll('[data-testid^="app-row-"]') ?? [])].map((r) => r.dataset.testid)
      return rows.length > 6 && rows.includes('app-row-trello') ? true : 'righe: ' + rows.join(',')
    `))
  await clickTextIn('Tutte', '[data-testid="app-filters"] button')
  await sleep(500)

  // P3l: la ricerca «gma» → Gmail per prima
  await setSearch('gma')
  await sleep(700)
  const firstRow = await pageEval(`return (${APP_DIALOG})?.querySelector('[data-testid^="app-row-"]')?.dataset.testid ?? ''`)
  check('P3l ricerca «gma» → Gmail per prima', firstRow === 'app-row-gmail', firstRow)
  const k1ricerca = await visibleOnTop('[data-testid="app-row-gmail"]')
  check('K1 la riga della ricerca è scoperta', k1ricerca === true, String(k1ricerca))
  await shotsOf('ricerca')

  // P3m: ricerca senza risultati → messaggio vuoto gentile
  await setSearch('zzzz')
  check('P3m ricerca senza risultati → «Nessuna app trovata»',
    await waitDom(`!!(${APP_DIALOG}) && ${APP_DIALOG}.textContent.includes('Nessuna app trovata')`, 8_000))
  await setSearch('')
  await sleep(600)

  // ============ P4: «Connetti» in un passo, con Composio NON ancora entrato ============
  check('P4a Composio NON è ancora entrato (nessuna riga Account in fondo)',
    !(await pageEval(`return !!document.querySelector('[data-testid="composio-account-row"]')`)))
  await clickTestid('app-connect-gmail')
  // la timeline della riga: cosa mostra e quando (per capire le fasi)
  const timeline = []
  const t0 = Date.now()
  for (let i = 0; i < 60; i++) {
    const txt = await pageEval(`return document.querySelector('[data-testid="app-row-gmail"]')?.textContent ?? ''`)
    const gw = txt.includes('Connessa') || txt.includes('Ricollega')
      ? ` [gw ${JSON.stringify((await rpc('composioGatewayStatus()')).connected)}]`
      : ''
    timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${txt.replace(/^✉️/, '')}${gw}`)
    if (txt.includes('Connessa')) break
    await sleep(250)
  }
  log('timeline gmail:', JSON.stringify(timeline))
  check('P4b la riga dice «Accedi a Composio nel browser…»',
    timeline.some((x) => x.includes('Accedi a Composio nel browser')))
  const k1riga = await visibleOnTop('[data-testid="app-row-gmail"]')
  check('K1 la riga in collegamento è scoperta', k1riga === true, String(k1riga))
  await shotsOf('riga-collegamento')
  // il login finto gira (discovery → DCR → authorize → browser finto → token):
  // appena il connettore risulta connesso il DAEMON prosegue da solo con
  // connectApp per gmail — la riga passa a «Completa il login di Gmail…»
  const p4c = timeline.some((x) => x.includes('Completa il login di Gmail nel browser'))
  check('P4c dopo il login la riga dice «Completa il login di Gmail nel browser…»', p4c,
    p4c ? '' : 'testo riga: ' + String(await pageEval(`return document.querySelector('[data-testid="app-row-gmail"]')?.textContent ?? ''`)).slice(0, 140))
  // il link finto di gmail viene aperto dal «browser finto» (mai quello vero)
  const gmailLink = await (async () => {
    const deadline = Date.now() + 15_000
    for (;;) {
      try { if (readFileSync(LINKS_LOG, 'utf8').includes('gmail')) return true } catch { /* ancora niente */ }
      if (Date.now() > deadline) return false
      await sleep(300)
    }
  })()
  check('P4d il link di Gmail è stato aperto dal browser finto (WAIT → ACTIVE)', gmailLink)
  check('P4e la riga arriva a «Connessa» senza mai aprire la riga Composio',
    await waitDom(`!![...document.querySelectorAll('[data-testid="app-row-gmail"]')].some((r) => r.offsetParent !== null && r.textContent.includes('Connessa'))`, 30_000))
  check('P4f il dettaglio del gateway di ieri NON esiste proprio',
    !(await pageEval(`return !!document.querySelector('[data-testid="composio-gateway-detail"]')`)))

  // P3n: la testata dice «1 connesse ›» col logo
  const summary = await pageEval(`
    const s = document.querySelector('[data-testid="connected-summary"]')
    return s ? { text: s.textContent.trim(), logos: s.querySelectorAll('span.grid, img').length, html: s.innerHTML.slice(0, 260) } : null
  `)
  check('P3n la testata dice «1 connesse ›» col logo', /1 conness[ae]/.test(summary?.text ?? '') && (summary?.logos ?? 0) >= 1,
    JSON.stringify(summary))

  // ============ P5: il dettaglio di Gmail ============
  await pageEval(`
    const row = document.querySelector('[data-testid="app-row-gmail"]')
    if (!row) throw new Error('riga Gmail non trovata')
    row.click()
    return 'dettaglio'
  `)
  check('P5a il foglio del dettaglio apre con «Tramite Composio» e Scollega',
    await waitDom(`!!document.querySelector('[data-testid="app-detail-gmail"]') && document.querySelector('[data-testid="app-detail-gmail"]').textContent.includes('Tramite Composio') && [...document.querySelectorAll('[data-testid="app-detail-gmail"] button')].some((b) => b.textContent.trim() === 'Scollega')`, 8_000))
  const detailNoSlug = await pageEval(`return document.querySelector('[data-testid="app-detail-gmail"]')?.textContent ?? ''`)
  check('P5b il dettaglio NON mostra slug né nomi di strumenti', !detailNoSlug.includes('gmail_') && !detailNoSlug.includes('GMAIL_'), detailNoSlug.slice(0, 120))
  const k1dettaglio = await visibleOnTop('[data-testid="app-detail-gmail"]')
  check('K1 il dettaglio è scoperto', k1dettaglio === true, String(k1dettaglio))
  await shotsOf('dettaglio')
  // si chiude il foglio del dettaglio cliccando il fondo (il pannello ferma la propagazione)
  await pageEval(`document.querySelector('[data-testid="app-detail-gmail"]').parentElement.click()`)
  await sleep(600)
  check('P5c il foglio del dettaglio si è chiuso', !(await pageEval(`return !!document.querySelector('[data-testid="app-detail-gmail"]')`)))

  // ============ P6: l'account Composio, non un'app ============
  check('P6a la riga discreta «Account Composio · connesso» sta in fondo',
    await waitDom(`!!document.querySelector('[data-testid="composio-account-row"]')`, 8_000))
  await clickTestid('composio-account-row')
  check('P6b il foglio dell\'account ha la spiegazione, «Gestisci su Composio» e Disattiva',
    await waitDom(`!!document.querySelector('[data-testid="composio-account-sheet"]') && document.querySelector('[data-testid="composio-account-sheet"]').textContent.includes('Gestisci su Composio') && [...document.querySelectorAll('[data-testid="composio-account-sheet"] button')].some((b) => b.textContent.trim() === 'Disattiva')`, 8_000))
  const k1account = await visibleOnTop('[data-testid="composio-account-sheet"]')
  check('K1 il foglio dell\'account è scoperto', k1account === true, String(k1account))
  await shotsOf('foglio-account')

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
