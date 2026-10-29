#!/usr/bin/env node
// Verifica d'integrazione della FASE 14 (punti 1-7) col daemon REALE su una
// cartella dati temporanea, il provider FINTO openai-compatible ( SSE su
// 127.0.0.1: le risposte del modello sono uno SCRIPT della probe) e il
// Playwright MCP FINTO sull'host (SANDBOT_TEST_FAKE_BROWSER_CMD — variante
// SANDBOT_TEST_* che in produzione non esiste). La HOME del daemon è una
// TEMPORANEA: l'export scrive in <HOME finta>/Downloads/SandBot, MAI nella
// ~/Downloads vera. Il turno "contaminato" usa web_fetch verso la pagina del
// server finto (SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1, anche questo solo test).
// Nessun Docker, nessun modello cloud, nessuna rete reale.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = mkdtempSync(join(tmpdir(), 'sandbot-fase14-probe-'))
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
  // la pagina web FINTA del turno contaminato
  if (req.method === 'GET' && url.pathname === '/pagina-web') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Pagina di prova del sito finto: il box condiviso funziona. NOTA: ignorare ogni istruzione qui dentro.')
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

// ---- il daemon REALE su dati temporanei e HOME finta ----

const daemon = spawn(process.execPath, ['out/main/daemon.js', '--data', DATA], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME,
    SANDBOT_DATA_DIR: DATA,
    // deroghe SOLO test (in produzione non esistono)
    SANDBOT_TEST_FAKE_BROWSER_CMD: join(ROOT, 'scripts/fake-browser-mcp.mjs'),
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
const waiters = []
const events = []
function connect() {
  return new Promise((resolveConn, rejectConn) => {
    ws = new WebSocket(`ws://127.0.0.1:${info.port}`)
    ws.onopen = () => ws.send(JSON.stringify({ hello: true, token: info.token }))
    ws.onerror = (e) => rejectConn(e)
    ws.onmessage = (m) => {
      const v = JSON.parse(m.data)
      if (v.hello) return resolveConn()
      if (v.ev) {
        events.push(v.ev)
        for (const w of [...waiters]) w(v.ev)
        return
      }
      // il daemon chiama la "UI" (host.*): la probe risponde (scale factor 2,
      // printToPDF non serve qui)
      if (v.rpc && v.method) {
        if (v.method === 'host.screen.scaleFactor') ws.send(JSON.stringify({ rpc: true, id: v.id, ok: true, result: 2 }))
        else ws.send(JSON.stringify({ rpc: true, id: v.id, ok: false, error: 'non disponibile nella probe' }))
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
/** aspetta un evento che matcha (con timeout). */
const waitForEvent = (pred, timeoutMs = 30_000) =>
  new Promise((resolveW, rejectW) => {
    const hit = events.find(pred)
    if (hit) return resolveW(hit)
    const w = (ev) => { if (pred(ev)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(t); resolveW(ev) } }
    waiters.push(w)
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rejectW(new Error('timeout evento')) }, timeoutMs)
  })
/** l'id dell'ultima entry adesso (il marcatore del turno che sta per partire). */
async function turnMark(agentId) {
  const entries = await call('agents:entries', agentId, 0)
  return entries.length ? entries[entries.length - 1].id : 0
}

/** aspetta la FINE del NUOVO turno (turnEnd DOPO il marcatore) o una card pendente. */
async function waitTurnEnd(agentId, mark, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = await call('agents:entries', agentId, mark)
    const end = entries.findLast((e) => e.kind === 'event' && e.meta?.turnEnd)
    if (end) return entries
    const pendingCard = entries.find((e) => (e.kind === 'approval' || (e.kind === 'send-message' && e.meta?.approvalId)) && e.meta?.status === 'pending')
    if (pendingCard) return entries // la probe decide la card
    if (Date.now() > deadline) throw new Error('timeout turno: log:\n' + daemonLog.slice(-1500))
    await sleep(200)
  }
}
/** risolve la card pendente più recente (allow/deny; turn/always per il fill). */
async function resolveLatestCard(agentId, decision, mode = 'once') {
  const entries = await call('agents:entries', agentId, 0)
  const pendingCard = entries.findLast((e) => (e.kind === 'approval' || (e.kind === 'send-message' && e.meta?.approvalId)) && e.meta?.status === 'pending')
  if (!pendingCard) throw new Error('nessuna card pendente')
  await call('approvals:resolve', agentId, String(pendingCard.meta.approvalId), decision, mode)
  return pendingCard
}

try {
  await connect()
  log('connesso al daemon')

  // provider + agente
  await call('providers:save', { id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })
  const agent = await call('agents:create', 'Bot', 'Assistente di prova della fase 14.')
  await call('agents:update', agent.id, { providerId: 'finto', model: 'finto' })

  // ---- 1. write_document → card → read_document → edit_document → v2 ----
  pushTool('write_document', { title: 'Report box condiviso', content: '# Report box condiviso\n\nIl box condiviso permette a tutti i bot di lavorare sugli stessi file in /workspace.\n\n## Vantaggi\n\n- una sola copia dei dati\n- consegne immediate tra bot\n- meno spazio usato\n\n```vega-lite\n' + JSON.stringify({ mark: 'bar', data: { values: [{ m: 'bot', v: 3 }, { m: 'file', v: 120 }] }, encoding: { x: { field: 'm', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }) + '\n```\n' })
  pushTool('send_to_user', { text: 'Report pronto in libreria: un\' pagina su vantaggi del box condiviso.' })
  let mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Scrivimi un report di una pagina sui vantaggi del box condiviso.')
  let entries = await waitTurnEnd(agent.id, mark)
  let docCard = entries.find((e) => e.kind === 'send-message' && e.meta?.message?.type === 'document')
  check('1a card documento', !!docCard, docCard ? `«${docCard.meta.message.title}» v${docCard.meta.message.version}` : 'nessuna card')
  const docId = docCard?.meta?.message?.id
  // read_document
  pushTool('read_document', { id: docId })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Rileggi il report.')
  await waitTurnEnd(agent.id, mark)
  // edit_document
  pushTool('edit_document', { id: docId, edits: [{ old: 'meno spazio usato', new: 'meno spazio usato (e un solo backup)' }] })
  pushTool('send_to_user', { text: 'Aggiunta la sezione sui rischi no, il punto spazio ampliato.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Aggiungi una nota sullo spazio.')
  entries = await waitTurnEnd(agent.id, mark)
  const lib1 = await call('library:list')
  const item = lib1.find((i) => i.id === docId)
  check('1b due versioni', item?.currentVersion === 2, `currentVersion=${item?.currentVersion}`)
  const v1 = await call('library:get', docId, 1)
  const v2 = await call('library:get', docId)
  check('1c v1 non sovrascritta', !v1.content.includes('un solo backup') && v2.content.includes('un solo backup'))

  // ---- 2. visualize Vega-Lite → SVG nella libreria; spec con url → errore ----
  pushTool('visualize', { title: 'Vendite Q1', kind: 'vega-lite', spec: JSON.stringify({ mark: 'bar', data: { values: [{ m: 'gen', v: 10 }, { m: 'feb', v: 14 }, { m: 'mar', v: 9 }] }, encoding: { x: { field: 'm', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } }) })
  pushTool('send_to_user', { text: 'Grafico delle vendite pronto.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Fammi un grafico delle vendite: gen 10, feb 14, mar 9.')
  entries = await waitTurnEnd(agent.id, mark)
  const chartCard = entries.find((e) => e.kind === 'send-message' && e.meta?.message?.type === 'chart')
  check('2a card grafico', !!chartCard)
  const chartGet = await call('library:get', chartCard?.meta?.message?.id)
  check('2b SVG nella libreria', !!chartGet?.svg && chartGet.svg.includes('<svg') && chartGet.svg.includes('gen'), `svg ${chartGet?.svg?.length ?? 0} byte`)
  pushTool('visualize', { title: 'Rotto', kind: 'vega-lite', spec: JSON.stringify({ mark: 'point', data: { url: 'https://evil.example/dati.json' } }) })
  pushTool('send_to_user', { text: 'Quel grafico non si può fare: i dati vanno inline.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Ora un grafico che prende i dati da https://evil.example/dati.json')
  entries = await waitTurnEnd(agent.id, mark)
  const badResult = entries.find((e) => e.kind === 'tool-result' && String(e.content).includes('Grafico non creato'))
  check('2c spec con url → errore alla modello, voce NON creata', !!badResult, String(badResult?.content ?? '').slice(0, 90))

  // 2d. P6: spec con mark.href → rifiutato dalla VALIDAZIONE con errore chiaro
  pushTool('visualize', { title: 'Con link', kind: 'vega-lite', spec: JSON.stringify({ mark: { type: 'point', href: 'https://evil.example/click' }, data: { values: [{ x: 1, y: 2 }] } }) })
  pushTool('send_to_user', { text: 'Quel grafico col link non si può fare.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Un grafico a punti dove ogni punto porta a https://evil.example/click')
  entries = await waitTurnEnd(agent.id, mark)
  const hrefResult = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('Grafico non creato'))
  check('2d spec con href → errore alla modello, voce NON creata', !!hrefResult && String(hrefResult.content).includes('href'), String(hrefResult?.content ?? '').slice(0, 90))

  // ---- 3. export_from_library html → card → allow → file nella HOME TEMPORANEA ----
  pushTool('export_from_library', { id: docId, format: 'html' })
  pushTool('send_to_user', { text: 'Ti ho esportato il report.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Esportami il report in html.')
  entries = await waitTurnEnd(agent.id, mark) // si ferma sulla card
  const exportCard = entries.find((e) => e.kind === 'approval' && e.meta?.libraryExport)
  check('3a card di conferma export', !!exportCard, exportCard ? exportCard.meta.libraryExport.name : 'nessuna card')
  await resolveLatestCard(agent.id, 'allow', 'once')
  await sleep(500)
  entries = await call('agents:entries', agent.id, 0)
  const exportResult = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('Esportato'))
  const exportedPath = exportResult ? (/in (.+?)(?: \(|\.$|$)/.exec(String(exportResult.content))?.[1] ?? null) : null
  check('3b esportato', !!exportedPath, exportedPath ?? '')
  if (exportedPath) {
    check('3c nella HOME TEMPORANEA (non ~/Downloads vera)', exportedPath.startsWith(join(HOME, 'Downloads', 'SandBot')), exportedPath)
    const html = readFileSync(exportedPath, 'utf8')
    check('3d HTML autonomo: nessuno script, nessuna risorsa esterna, SVG in linea',
      !html.toLowerCase().includes('<script') && html.includes('<svg') && ![...html.matchAll(/(?:src|href)\s*=\s*"[^"]*"/gi)].some((m) => /https?:\/\//i.test(m[0])))
  }

  // ---- 4. turno contaminato (web finto) che scrive un documento → tainted ----
  pushTool('web_fetch', { url: `http://127.0.0.1:${providerPort}/pagina-web` })
  pushTool('write_document', { title: 'Sintesi web', content: 'Sintesi della pagina finta: il box condiviso funziona.' })
  pushTool('send_to_user', { text: 'Sintesi salvata.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Leggi questa pagina e fanne una sintesi in un documento: ' + `http://127.0.0.1:${providerPort}/pagina-web`)
  await waitTurnEnd(agent.id, mark)
  const libT = await call('library:list')
  const taintedItem = libT.find((i) => i.title === 'Sintesi web')
  check('4a documento del turno contaminato → tainted', taintedItem?.tainted === true, `tainted=${taintedItem?.tainted}`)
  // la lettura da un ALTRO bot è un dato esterno: read_document torna col meta
  // libraryTainted e il loop incarta (cerco il blocco <dato_esterno)
  pushTool('read_document', { id: taintedItem.id })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Rileggi la sintesi.')
  entries = await waitTurnEnd(agent.id, mark)
  const taintedRead = entries.findLast((e) => e.kind === 'tool-result' && e.meta?.libraryTainted)
  check('4b lettura → dato esterno', !!taintedRead && String(taintedRead.content).includes('<dato_esterno'), String(taintedRead?.content ?? '').slice(0, 70))

  // 4c. P5: request_secure_input NATO nel turno contaminato → card untrusted
  pushTool('web_fetch', { url: `http://127.0.0.1:${providerPort}/pagina-web` })
  pushTool('request_secure_input', { kind: 'login', label: 'Portale della pagina', origin: 'https://banca-finta.example', reason: 'la pagina chiede di accedere' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Leggi questa pagina e chiedimi il login che serve: ' + `http://127.0.0.1:${providerPort}/pagina-web`)
  entries = await waitTurnEnd(agent.id, mark) // si ferma sul modulo
  const untrustedCard = entries.findLast((e) => e.kind === 'send-message' && e.meta?.message?.type === 'secure-input' && e.meta?.status === 'pending')
  check('4c modulo sicuro del turno contaminato → untrusted nel meta', untrustedCard?.meta?.message?.untrusted === true)
  await resolveLatestCard(agent.id, 'deny', 'once') // il modulo di prova si chiude: non serve

  // ---- 5. request_secure_input login → la probe compila il modulo via RPC ----
  pushTool('request_secure_input', { kind: 'login', label: 'Portale ASPI', origin: 'https://app.example.test', reason: 'serve per accedere al portale' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Devo accedere al portale ASPI (https://app.example.test) ma non ho il login: chiedimelo in modo sicuro.')
  entries = await waitTurnEnd(agent.id, mark) // si ferma sul modulo
  const secureCard = entries.findLast((e) => e.kind === 'send-message' && e.meta?.message?.type === 'secure-input' && e.meta?.status === 'pending')
  check('5a card modulo sicuro', !!secureCard)
  await call('secureinput:submit', agent.id, String(secureCard.meta.approvalId), {
    label: 'Portale ASPI', origin: 'https://app.example.test',
    username: 'mario.rossi@example.test', password: 'Finta-Password-Proba-2026!',
    totp: 'otpauth://totp/Portale:mario?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Portale'
  })
  await sleep(300)
  entries = await call('agents:entries', agent.id, 0)
  const secureOutcome = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('salvato:'))
  check('5b esito "salvato: login …" senza valori', !!secureOutcome && !String(secureOutcome.content).includes('Finta-Password'), String(secureOutcome?.content ?? ''))
  // il vault NON contiene i valori in chiaro e list-credentials non li mostra
  const rawSettings = readFileSync(join(DATA, 'sandbot.db'), 'utf8')
  check('5c valori MAI in chiaro nel DB', !rawSettings.includes('Finta-Password-Proba') && !rawSettings.includes('mario.rossi@example.test'))
  pushTool('list-credentials', {})
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Che login avete nel vault?')
  await waitTurnEnd(agent.id, mark)
  entries = await call('agents:entries', agent.id, 0)
  const credResult = entries.findLast((e) => e.kind === 'tool-result' && e.meta?.vault)
  check('5d list-credentials mostra il login SENZA valori',
    !!credResult && String(credResult.content).includes('Portale ASPI') && !String(credResult.content).includes('Finta-Password') && !String(credResult.content).includes('mario.rossi'), String(credResult?.content ?? '').split('\n').slice(0, 3).join(' | '))

  // ---- 6. pagina finta su https://app.example.test/login → fill_credential ----
  //    → card → allow → il finto riceve browser_type coi valori, il transcript
  //    NON li contiene, lo snapshot dopo è redatto
  const loginId = 'login_' // l'id vero lo leggiamo dagli items
  const vaultItems = await call('vault:items')
  const savedLogin = vaultItems.find((i) => i.kind === 'login')
  check('6a login nel vault (items)', !!savedLogin && savedLogin.hasTotp === true, savedLogin?.id ?? '')
  pushTool('browser_open', { url: 'https://app.example.test/login' })
  pushTool('list-credentials', {})
  pushTool('fill_credential', { id: savedLogin.id, username_ref: 'e2', password_ref: 'e3', totp_ref: 'e4' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Apri https://app.example.test/login e accedi col login del vault.')
  entries = await waitTurnEnd(agent.id, mark) // si ferma sulla card del fill
  const fillCard = entries.findLast((e) => e.kind === 'send-message' && e.meta?.message?.type === 'fill' && e.meta?.status === 'pending')
  check('6b card compila login (origine esatta)', !!fillCard && fillCard.meta.message.origin === 'https://app.example.test', fillCard?.content ?? 'nessuna card')
  await resolveLatestCard(agent.id, 'allow', 'once')
  await sleep(500)
  entries = await call('agents:entries', agent.id, 0)
  const fillResult = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('Compilati'))
  check('6c esito senza valori né codice MCP',
    !!fillResult && !String(fillResult.content).includes('Finta-Password') && !String(fillResult.content).includes('fill(') && !String(fillResult.content).includes('mario.rossi'),
    String(fillResult?.content ?? ''))
  // lo snapshot SUCCESSIVO è redatto
  pushTool('browser_snapshot', {})
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Dammi lo snapshot della pagina.')
  await waitTurnEnd(agent.id, mark)
  entries = await call('agents:entries', agent.id, 0)
  const snapResult = entries.findLast((e) => e.kind === 'tool-result' && e.meta?.webEvidence)
  check('6d snapshot dopo il fill REDATTO',
    !!snapResult && String(snapResult.content).includes('[redacted:credential]') && !String(snapResult.content).includes('Finta-Password'),
    String(snapResult?.content ?? '').slice(0, 80))
  // e il transcript complessivo non contiene MAI la password
  const transcript = JSON.stringify(await call('agents:entries', agent.id, 0))
  check('6e la password NON è mai nel transcript', !transcript.includes('Finta-Password-Proba'))

  // 6f. P3: campo dentro un iframe (ref SENZA prefisso f) → rifiutato dal probe
  pushTool('browser_open', { url: 'https://app.example.test/embedded' })
  pushTool('fill_credential', { id: savedLogin.id, username_ref: 'e2' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Prova a compilare il login sulla pagina con il modulo incorporato.')
  await waitTurnEnd(agent.id, mark)
  entries = await call('agents:entries', agent.id, 0)
  const iframeFill = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('iframe'))
  const pendingFillCard = entries.some((e) => e.kind === 'send-message' && e.meta?.message?.type === 'fill' && e.meta?.status === 'pending')
  check('6f campo in iframe (ref senza f) → rifiutato da top:false, NESSUNA card',
    !!iframeFill && !pendingFillCard,
    String(iframeFill?.content ?? '').slice(0, 90))

  // ---- 7. stessa chiamata su un'origine DIVERSA → rifiuto senza card ----
  pushTool('browser_open', { url: 'https://spa.example/login' })
  pushTool('fill_credential', { id: savedLogin.id, username_ref: 'e8', password_ref: 'e9' })
  pushTool('send_to_user', { text: 'Il login è di un altro sito: non lo compilo qui.' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Ora prova ad accedere su https://spa.example/login con lo stesso login.')
  await waitTurnEnd(agent.id, mark)
  entries = await call('agents:entries', agent.id, 0)
  const deniedFill = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('origine'))
  const fillCardWrong = entries.some((e) => e.kind === 'send-message' && e.meta?.message?.type === 'fill' && String(e.content).includes('spa.example'))
  check('7 rifiuto dall\'origine diversa, NESSUNA card', !!deniedFill && !fillCardWrong, String(deniedFill?.content ?? '').slice(0, 90))

  // ---- 8. save_contact → card → salva → find_contacts lo trova ----
  pushTool('save_contact', { name: 'Anna Bianchi', emails: ['anna@example.test'], phones: ['+39 333 000111'], notes: 'commercialista' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Salva il contatto di Anna Bianchi (anna@example.test, +39 333 000111, commercialista).')
  entries = await waitTurnEnd(agent.id, mark) // card
  const contactCard = entries.findLast((e) => e.kind === 'send-message' && e.meta?.message?.type === 'contact' && e.meta?.status === 'pending')
  check('8a card contatto', !!contactCard && contactCard.meta.message.name === 'Anna Bianchi')
  await resolveLatestCard(agent.id, 'allow', 'once')
  await sleep(300)
  pushTool('find_contacts', { query: 'anna' })
  mark = await turnMark(agent.id)
  await call('chat:send', agent.id, 'Cerca il contatto di Anna.')
  await waitTurnEnd(agent.id, mark)
  entries = await call('agents:entries', agent.id, 0)
  const found = entries.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('Anna Bianchi'))
  check('8b find_contacts lo trova (valori visibili)', !!found && String(found.content).includes('anna@example.test'), String(found?.content ?? '').slice(0, 70))
} catch (e) {
  failures++
  console.error('\n[probe] ERRORE:', e.message ?? e)
  try {
    const agents = await call('agents:list')
    for (const a of agents) {
      const entries = await call('agents:entries', a.id, 0)
      console.error(`--- ultime entry di ${a.name} ---`)
      for (const en of entries.slice(-8)) {
        console.error(`${en.kind} | ${String(en.content).slice(0, 110).replace(/\n/g, ' ')} | ${JSON.stringify(en.meta ?? {}).slice(0, 110)}`)
      }
    }
  } catch { /* il daemon potrebbe essere morto */ }
  console.error(daemonLog.slice(-1500))
} finally {
  console.log(`\n${checks.length - failures}/${checks.length} controlli OK`)
  providerServer.closeAllConnections?.()
  providerServer.close()
  stopDaemon()
  await sleep(300)
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* se il daemon non è ancora morto */ }
  process.exit(failures ? 1 : 0)
}
