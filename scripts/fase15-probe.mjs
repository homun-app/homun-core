#!/usr/bin/env node
// Verifica d'integrazione della FASE 15 col daemon REALE su cartella dati
// temporanea, provider FINTO openai-compatible (SSE su 127.0.0.1: le risposte
// del modello sono uno SCRIPT della probe) e catena di ricerca FINTA via
// SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN=1 (variante SANDBOT_TEST_* che in
// produzione non esiste): You.com risponde 429, Exa risponde con un risultato
// che punta al server http locale della probe (SANDBOT_TEST_FAKE_WEB_URL). Si
// vede così il passaggio al provider successivo NELLA STESSA chiamata, il
// raffreddamento di You.com nell'RPC websearch:status e la riga "Fonte della
// ricerca". NESSUN endpoint vero (You.com, Exa, Tavily, Ollama), nessun
// Docker, nessun modello cloud: i provider finti girano nel processo.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-fase15-probe-'))
const HOME = join(TMP, 'home')
const DATA = join(TMP, 'data')
mkdirSync(HOME, { recursive: true })
mkdirSync(DATA, { recursive: true })

const log = (...a) => console.log('[probe]', ...a)
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- il provider FINTO (openai-compatible, SSE) + la pagina web finta ----

/** Lo script delle risposte del modello: la probe lo riempie prima di ogni turno. */
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => script.push({ text })

let providerPort = 0
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // la pagina finta che il risultato di Exa punta: il bot può leggerla con web_fetch
  if (req.method === 'GET' && url.pathname === '/pagina-web') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Orari della prova: dal lunedì al sabato (pagina finta della probe).')
    return
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
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
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
providerPort = providerServer.address().port
const FAKE_PAGE = `http://127.0.0.1:${providerPort}/pagina-web`

// ---- il daemon REALE su dati temporanei e HOME finta ----

const daemon = spawn(process.execPath, ['out/main/daemon.js', '--data', DATA], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME,
    SANDBOT_DATA_DIR: DATA,
    // deroghe SOLO test (in produzione non esistono): la catena FINTA
    // You.com-429 → Exa-ok e la pagina finta del risultato; il loopback per
    // il web_fetch della pagina; il Keychain finto per non toccare quello vero
    SANDBOT_TEST_FAKE_WEB_SEARCH_CHAIN: '1',
    SANDBOT_TEST_FAKE_WEB_URL: FAKE_PAGE,
    SANDBOT_WEB_FETCH_ALLOW_LOOPBACK: '1',
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finto.json')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let daemonLog = ''
daemon.stdout.on('data', (d) => { daemonLog += d.toString() })
daemon.stderr.on('data', (d) => { daemonLog += d.toString() })
const stopDaemon = () => { try { daemon.kill('SIGTERM') } catch { /* già via */ } }

// daemon.json col token
let info = null
for (let i = 0; i < 100; i++) {
  const p = join(DATA, 'daemon.json')
  if (existsSync(p)) {
    try { info = JSON.parse(readFileSync(p, 'utf8')); break } catch { /* ancora a metà */ }
  }
  await sleep(100)
}
if (!info) {
  console.error('il daemon non ha scritto daemon.json:\n' + daemonLog.slice(-2000))
  providerServer.close(); stopDaemon(); process.exit(1)
}
log('daemon su porta', info.port)

// ---- client RPC sul WebSocket del daemon (nativo di Node) ----

let ws = null
let rpcId = 1
const pending = new Map()
const events = []
function connect() {
  return new Promise((resolveConn, rejectConn) => {
    ws = new WebSocket(`ws://127.0.0.1:${info.port}`)
    ws.onopen = () => ws.send(JSON.stringify({ hello: true, token: info.token }))
    ws.onerror = (e) => rejectConn(e)
    ws.onmessage = (m) => {
      const v = JSON.parse(m.data)
      if (v.hello) return resolveConn()
      if (v.ev) { events.push(v.ev); return }
      if (v.rpc && v.method) {
        ws.send(JSON.stringify({ rpc: true, id: v.id, ok: false, error: 'non disponibile nella probe' }))
        return
      }
      if (v.rpc && pending.has(v.id)) {
        const p = pending.get(v.id)
        pending.delete(v.id)
        v.ok ? p.resolve(v.result) : p.reject(new Error(v.error))
      }
    }
  })
}
const call = (method, ...params) =>
  new Promise((resolveP, rejectP) => {
    const id = rpcId++
    pending.set(id, { resolve: resolveP, reject: rejectP })
    ws.send(JSON.stringify({ rpc: true, id, method, params }))
  })
const turnMark = async (agentId) => {
  const entries = await call('agents:entries', agentId, 0)
  return entries.length ? entries[entries.length - 1].id : 0
}
const waitTurnEnd = async (agentId, mark, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = await call('agents:entries', agentId, mark)
    if (entries.find((e) => e.kind === 'event' && e.meta?.turnEnd)) return entries
    if (Date.now() > deadline) throw new Error('timeout turno: log:\n' + daemonLog.slice(-1500))
    await sleep(200)
  }
}

try {
  await connect()
  log('connesso al daemon')

  await call('providers:save', { id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })
  const agent = await call('agents:create', 'Bot', 'Assistente di prova della fase 15.')
  await call('agents:update', agent.id, { providerId: 'finto', model: 'finto' })

  // ---- 1. web_search: You.com 429 → Exa ok NELLA STESSA chiamata ----
  const QUERY_1 = 'orari musei di prova fase quindici'
  pushTool('web_search', { query: QUERY_1 })
  pushText('Trovato: la pagina degli orari.')
  let mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Cerca gli orari dei musei di prova.')
  let entries = await waitTurnEnd(agent.id, mark)
  const search1 = entries.find((e) => e.kind === 'tool-result' && e.meta?.webEvidence)
  check('1a web_search risponde (catena finta: You 429 → Exa)', !!search1 && String(search1.content).includes('Fonte della ricerca: Exa'),
    search1 ? String(search1.content).split('\n').find((l) => l.includes('Fonte')) ?? '' : 'nessun result')
  check('1b meta.provider = exa, webContent vero, nessun searchFailed', search1?.meta?.provider === 'exa' && search1?.meta?.webContent === true && search1?.meta?.searchFailed === undefined,
    `provider=${search1?.meta?.provider} webContent=${search1?.meta?.webContent}`)
  check('1c il risultato punta alla pagina finta', String(search1?.content ?? '').includes(FAKE_PAGE))

  // ---- 2. lo stato per la UI: You.com in raffreddamento, Exa disponibile ----
  const status = await call('websearch:status')
  const you = status?.providers?.find((p) => p.name === 'you')
  const exa = status?.providers?.find((p) => p.name === 'exa')
  const tavily = status?.providers?.find((p) => p.name === 'tavily')
  check('2a websearch:status: keyless VERO e tre provider', status?.keyless === true && you && exa && tavily,
    `keyless=${status?.keyless} provider=${status?.providers?.map((p) => p.name).join(',')}`)
  check('2b You.com in raffreddamento (~60 s, ultimo errore 429)', typeof you?.cooldownUntil === 'number' && you.cooldownUntil > Date.now() && you.lastError?.kind === 'rate-limit' && you.lastError?.status === 429,
    `cooldownUntil=${you?.cooldownUntil} lastError=${JSON.stringify(you?.lastError)}`)
  check('2c Exa e Tavily disponibili', exa?.cooldownUntil === undefined && tavily?.cooldownUntil === undefined)

  // ---- 3. seconda ricerca: You.com SALTATO (raffreddamento), Exa risponde ----
  const QUERY_2 = 'biglietti musei di prova'
  pushTool('web_search', { query: QUERY_2 })
  pushText('Anche i biglietti sono sulla stessa pagina.')
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Cerca anche i biglietti.')
  entries = await waitTurnEnd(agent.id, mark)
  const search2 = entries.find((e) => e.kind === 'tool-result' && e.meta?.webEvidence)
  check('3 seconda ricerca: You.com saltato, di nuovo Exa', search2?.meta?.provider === 'exa' && String(search2.content).includes('Fonte della ricerca: Exa'))

  // ---- 4. privacy: la query MAI nel log del daemon ----
  check('4 nessuna query nel log del daemon (al più la lunghezza)', !daemonLog.includes(QUERY_1) && !daemonLog.includes(QUERY_2) && !daemonLog.includes('orari musei'),
    `${daemonLog.length} caratteri di log`)

  // ---- 5. il link del risultato si LEGGE con web_fetch locale (loopback di test) ----
  pushTool('web_fetch', { url: FAKE_PAGE })
  pushText('La pagina conferma gli orari.')
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Apri la pagina trovata.')
  entries = await waitTurnEnd(agent.id, mark)
  const fetched = entries.find((e) => e.kind === 'tool-result' && e.meta?.webEvidence && String(e.content).includes('pagina_web'))
  check('5 web_fetch legge la pagina del risultato (con difese SSRF, loopback solo test)', !!fetched && String(fetched.content).includes('dal lunedì al sabato'))

  // ---- 6. l'interruttore: keyless SPENTO → lo stato lo riflette ----
  await call('settings:set', 'webSearch.keyless', false)
  const keylessNow = await call('settings:get', 'webSearch.keyless', true)
  check('6 setting webSearch.keyless persistito (interruttore della UI)', keylessNow === false, `keyless=${keylessNow}`)
  const statusOff = await call('websearch:status')
  check("6b lo stato riflette l'interruttore spento", statusOff?.keyless === false)
  await call('settings:set', 'webSearch.keyless', true)
} catch (e) {
  failures++
  console.error('probe fallita:', e)
} finally {
  stopDaemon()
  await sleep(300)
}

// ---- scenario B: daemon SENZA catena finta e keyless SPENTO → WEB_SEARCH_INACTIVE ----
// (nessuna rete: senza chiave e col keyless spento la catena è VUOTA prima di
// qualunque chiamata — si verifica il messaggio del tool su un daemon vero)
try {
  const DATA2 = join(TMP, 'data-b')
  mkdirSync(DATA2, { recursive: true })
  const daemon2 = spawn(process.execPath, ['out/main/daemon.js', '--data', DATA2], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME,
      SANDBOT_DATA_DIR: DATA2,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA2, 'keychain-finto.json')
      // NESSUN flag della catena finta qui
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log2 = ''
  daemon2.stdout.on('data', (d) => { log2 += d.toString() })
  daemon2.stderr.on('data', (d) => { log2 += d.toString() })
  let info2 = null
  for (let i = 0; i < 100; i++) {
    const p = join(DATA2, 'daemon.json')
    if (existsSync(p)) {
      try { info2 = JSON.parse(readFileSync(p, 'utf8')); break } catch { /* metà */ }
    }
    await sleep(100)
  }
  if (!info2) throw new Error('daemon B senza daemon.json:\n' + log2.slice(-1000))

  let ws2 = null
  let rpc2Id = 1
  const pending2 = new Map()
  await new Promise((resolveConn, rejectConn) => {
    ws2 = new WebSocket(`ws://127.0.0.1:${info2.port}`)
    ws2.onopen = () => ws2.send(JSON.stringify({ hello: true, token: info2.token }))
    ws2.onerror = (e) => rejectConn(e)
    ws2.onmessage = (m) => {
      const v = JSON.parse(m.data)
      if (v.hello) return resolveConn()
      if (v.rpc && v.method) {
        ws2.send(JSON.stringify({ rpc: true, id: v.id, ok: false, error: 'non disponibile nella probe' }))
        return
      }
      if (v.rpc && pending2.has(v.id)) {
        const p = pending2.get(v.id)
        pending2.delete(v.id)
        v.ok ? p.resolve(v.result) : p.reject(new Error(v.error))
      }
    }
  })
  const call2 = (method, ...params) =>
    new Promise((resolveP, rejectP) => {
      const id = rpc2Id++
      pending2.set(id, { resolve: resolveP, reject: rejectP })
      ws2.send(JSON.stringify({ rpc: true, id, method, params }))
    })
  const waitTurnEnd2 = async (agentId, mark, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const entries = await call2('agents:entries', agentId, mark)
      if (entries.find((e) => e.kind === 'event' && e.meta?.turnEnd)) return entries
      if (Date.now() > deadline) throw new Error('timeout turno B: log:\n' + log2.slice(-1000))
      await sleep(200)
    }
  }

  await call2('providers:save', { id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })
  const agent2 = await call2('agents:create', 'Bot B', 'Assistente di prova B.')
  await call2('agents:update', agent2.id, { providerId: 'finto', model: 'finto' })
  await call2('settings:set', 'webSearch.keyless', false)

  pushTool('web_search', { query: 'qualsiasi cosa' })
  pushText('La ricerca è disattivata.')
  const entriesAll = await call2('agents:entries', agent2.id, 0)
  const mark2 = entriesAll.length ? entriesAll[entriesAll.length - 1].id : 0
  await call2('chat:send', agent2.id, 'Cerca una cosa qualsiasi.')
  const entriesB = await waitTurnEnd2(agent2.id, mark2)
  const searchB = entriesB.find((e) => e.kind === 'tool-result' && e.meta?.webEvidence)
  check('7 keyless SPENTO senza chiave → WEB_SEARCH_INACTIVE (nessuna rete)', !!searchB && String(searchB.content).includes('La ricerca web è disattivata nelle impostazioni'),
    String(searchB?.content ?? '').split('\n')[0])
  check('8 nessuna contaminazione senza risultati', searchB?.meta?.webContent === false || searchB?.meta?.webContent === undefined)
  daemon2.kill('SIGTERM')
  await sleep(300)
} catch (e) {
  failures++
  console.error('probe B fallita:', e)
} finally {
  providerServer.close()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* la home del daemon può essere ancora attiva */ }
}

console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
process.exit(failures === 0 ? 0 : 1)
