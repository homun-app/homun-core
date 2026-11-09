#!/usr/bin/env node
// Sonda Electron della fase memoria-engramma · CORREZIONI (C1–C9), sull'app
// IMPACCHETTATA (dist-installers/mac-arm64/Homun.app, release:local) con
// dati TEMPORANEI (SANDBOT_TEST_USER_DATA): MAI la cartella dati vera.
// Il «modello» è il solito server OpenAI-compatible FINTO su 127.0.0.1; il
// motore Engramma è QUELLO VERO (v0.4.2), dentro l'app. Il download del
// modello usa ENGRAMMA_PULL_BASE con un server locale che serve la copia di
// ~/.cache/engramma/models: NESSUNA RETE VERA. web_fetch va alla pagina del
// server finto (SANDBOT_WEB_FETCH_ALLOW_LOOPBACK=1, flag solo-test).
//
//   1. migrazione di una cartella copiata (come la sonda della fase);
//   2. conversazione che scrive (update_memory) e richiama (recall_memory) e
//      ritrova la storia (search_history);
//   3. CORREZIONI C1 dal vivo: turno con web_fetch VERO → risposta finale →
//      search_history in un turno PULITO → il result è incartato come dato
//      esterno e il turno risulta contaminato (meta.contaminated);
//   4. CORREZIONI C4 dal vivo: memoria eliminata → filtro «eliminate» →
//      «Dimentica per sempre» DALLA LAPIDE: nessuna traccia nei file;
//   5. download del modello da ENGRAMMA_PULL_BASE locale: present a true SENZA
//      riapertura del motore (v0.4.2 collega a caldo), RAM prima/dopo;
//   6. CORREZIONI C2 dal vivo: un bot con 1500 messaggi indicizzati e
//      memorie a lapide, ELIMINATO → le sue celle spariscono e NESSUNA radice
//      dei testi resta nei file.
// Tutto ciò che la sonda stampa finisce nel REPORT. A fine sonda app e
// demone si fermano e la cartella temporanea si rimuove.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-memoria-correzioni-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-memoria-engramma-correzioni')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

const MODEL_CACHE = join(homedir(), '.cache', 'engramma', 'models', 'granite-embedding-97m-multilingual-r2')

const log = (...a) => console.log('[sonda]', ...a)
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- il «modello»: server OpenAI-compatible FINTO (che registra le richieste) ----
const captured = []
const CUES = [
  { match: 'Ricorda una cosa', reply: { toolCalls: [{ name: 'update_memory', arguments: { action: 'write', content: "Il gatto dell'utente si chiama Pisolo", tier: 'core' } }] } },
  { match: 'Che animali', reply: { toolCalls: [{ name: 'recall_memory', arguments: { query: 'gatto nome' } }] } },
  { match: 'Ti ricordi cosa ti ho detto', reply: { toolCalls: [{ name: 'search_history', arguments: { query: 'gatto Pisolo' } }] } },
  // C1: il turno contaminato — web_fetch VERO verso la pagina del server finto
  { match: 'Che sconto c\'è sul sito', reply: { toolCalls: [{ name: 'web_fetch', arguments: { url: 'PROMO_URL' } }] } },
  // C1: il turno pulito che rilegge la storia (la risposta del turno del sito)
  { match: 'Cosa ti ho detto dello sconto', reply: { toolCalls: [{ name: 'search_history', arguments: { query: 'codice sconto ZEBRA42' } }] } }
]
const FINALE = {
  'Ricorda una cosa': 'Fatto: ho salvato che il tuo gatto si chiama Pisolo.',
  'Che animali': 'Hai un gatto che si chiama Pisolo.',
  'Ti ricordi cosa ti ho detto': 'Mi hai detto che il tuo gatto si chiama Pisolo.',
  'Che sconto c\'è sul sito': 'Secondo il sito, il codice sconto è ZEBRA42.',
  'Cosa ti ho detto dello sconto': 'Mi avevi detto che il codice sconto è ZEBRA42 (l\'ho ritrovato nella nostra chat).'
}
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const replyFor = (messages) => {
  const lastUserAt = messages.map((m) => m.role).lastIndexOf('user')
  const text = String(messages[lastUserAt]?.content ?? '')
  const cue = CUES.find((c) => text.includes(c.match))
  const after = messages.slice(lastUserAt + 1).filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''))
  const reactivate = after.length > 0 && /now active\. Call it again/.test(after.at(-1))
  if (cue && (after.length === 0 || reactivate)) {
    const promo = `http://127.0.0.1:${providerPort}/pagina-promo`
    return { toolCalls: cue.reply.toolCalls.map((tc) => ({ ...tc, arguments: JSON.parse(JSON.stringify(tc.arguments).replace('PROMO_URL', promo)) })) }
  }
  for (const [k, v] of Object.entries(FINALE)) if (text.includes(k)) return { text: v }
  return { text: 'ok' }
}
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const messages = JSON.parse(body).messages ?? []
    captured.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? ''), toolCalls: m.toolCalls }))
      .filter((m) => m.role === 'user' || m.role === 'tool'))
    const next = replyFor(messages)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunkOf({ role: 'assistant', content: '' }))
    res.write(chunkOf({ content: next.text ?? '' }))
    for (const [i, tc] of (next.toolCalls ?? []).entries()) {
      res.write(chunkOf({ tool_calls: [{ index: i, id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }))
    }
    res.write(chunkOf({}, next.toolCalls ? 'tool_calls' : 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
}
const providerServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) return chatOf(req, res)
  // la pagina che web_fetch legge DAVVERO (C1): testo non fidato
  if (url.pathname === '/pagina-promo') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Promozione attiva: il codice sconto è ZEBRA42, valido fino a domenica.</body></html>')
    return
  }
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- il server del modello (ENGRAMMA_PULL_BASE): la copia locale, nessuna rete ----
if (!existsSync(MODEL_CACHE)) throw new Error('manca il modello in ~/.cache/engramma/models (serve per ENGRAMMA_PULL_BASE)')
const modelServer = createServer((req, res) => {
  const m = /^\/ibm-granite\/granite-embedding-97m-multilingual-r2\/resolve\/([0-9a-f]{40})\/(.+)$/.exec(req.url ?? '')
  const file = m ? join(MODEL_CACHE, m[1], m[2]) : ''
  if (!file || !existsSync(file)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  res.statusCode = 200
  res.setHeader('content-length', statSync(file).size)
  createReadStream(file).pipe(res)
})
await new Promise((r) => modelServer.listen(0, '127.0.0.1', r))
const modelPort = modelServer.address().port

// ---- l'app IMPACCHETTATA con dati temporanei ----
const APP = join(ROOT, 'dist-installers', 'mac-arm64', 'Homun.app')
const ELECTRON = join(APP, 'Contents', 'MacOS', 'Homun')
if (!existsSync(ELECTRON)) throw new Error('manca l\'app impacchettata: npm run release:local')
const DEBUG_PORT = 9352
let appLog = ''
const proc = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
    // C1: web_fetch legge la pagina del server finto (flag solo-test)
    SANDBOT_WEB_FETCH_ALLOW_LOOPBACK: '1',
    // C8/C9: il download del modello dal server locale, senza rete
    ENGRAMMA_PULL_BASE: `http://127.0.0.1:${modelPort}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
proc.stdout.on('data', (d) => { appLog += d.toString() })
proc.stderr.on('data', (d) => { appLog += d.toString() })
/** ferma l'app e ASPETTA che esca: chiudendo scrive la Session Storage, e
 *  un rmSync fatto prima lascerebbe la cartella temporanea ricreata a metà */
const stopApp = async () => {
  if (proc.exitCode !== null) return
  const exited = new Promise((r) => proc.once('exit', r))
  try { proc.kill('SIGTERM') } catch { /* già via */ }
  await Promise.race([exited, sleep(10_000)])
}
const daemonPid = () => {
  try {
    const v = JSON.parse(readFileSync(join(DATA, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
const daemonLogText = () => { try { return readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8') } catch { return '' } }
const stopDaemon = async () => {
  const pid = daemonPid()
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
}
const rssOf = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
/** dopo uno stop la UI rilancia il demone: si aspetta il pid e una RPC che risponde */
let rpcRef = null
const waitDaemon = async (agentId) => {
  for (let i = 0; i < 120; i++) {
    const pid = daemonPid()
    if (pid) {
      try {
        if (rpcRef) await rpcRef(`memoryOverview(${JSON.stringify(agentId)})`)
        return pid
      } catch { /* il demone non risponde ancora */ }
    }
    await sleep(500)
  }
  throw new Error('il demone non è tornato su dopo lo stop')
}

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
    } catch { /* debugger non ancora su */ }
    await sleep(200)
  }
  throw new Error('nessuna pagina CDP: log app:\n' + appLog.slice(-1500))
}
const page = await waitForPage()
log('CDP collegato al renderer (app impacchettata)')
await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 860, mobile: false, deviceScaleFactor: 2 })
await sleep(700)
const pageEval = async (expr) => {
  const r = await page.send('Runtime.evaluate', { expression: `((async () => { ${expr} })())`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = (callExpr) => pageEval(`return await window.sandbot.${callExpr}`)
rpcRef = rpc
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
const shot = async (name) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 860, mobile: false, deviceScaleFactor: 2 })
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
const clickByText = async (piece, scope = 'button') => pageEval(`
  const el = [...document.querySelectorAll('${scope}')].find((b) => (b.textContent ?? '').includes(${JSON.stringify(piece)}))
  if (!el) throw new Error('nessun elemento con testo: ' + ${JSON.stringify(piece)})
  el.click()
  return 'cliccato'
`)
const waitForBotIdle = async (agentId) => waitDom(
  `(await window.sandbot.listAgents()).find((a) => a.id === ${JSON.stringify(agentId)})?.status === 'idle'`, 60_000, 500)
const sendAndWait = async (agentId, text, ms = 60_000) => {
  const finals = async () => (await pageEval(`return await window.sandbot.getEntries(${JSON.stringify(agentId)})`))
    .filter((e) => e.kind === 'send-message' && e.meta?.final === true).length
  const before = await finals()
  await uiSend(text)
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(500)
    if ((await finals()) > before) {
      await waitForBotIdle(agentId)
      return true
    }
  }
  return false
}
const entriesOf = async (agentId) => pageEval(`return await window.sandbot.getEntries(${JSON.stringify(agentId)})`)
/** le radici di un testo nei file grezzi sotto <dataDir>/memory (il metodo di privacy.test.ts) */
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)])
const rootsOf = (text) => text.split(/\s+/).flatMap((w) => {
  const base = w.toLowerCase().replace(/[aeio]$/, '')
  return [w.toLowerCase(), base]
}).filter((n) => n.length >= 6)
/** needles: SOLO parole inventate (una parola comune come «codice» sta legittimamente nella storia di un altro bot) */
const leakScan = (needles) => {
  const roots = [...new Set(needles.flatMap(rootsOf))]
  const leaks = []
  for (const f of walk(join(DATA, 'data', 'memory'))) {
    const raw = readFileSync(f)
    for (const needle of roots) if (raw.includes(Buffer.from(needle))) leaks.push(`${basename(f)}: ${needle}`)
  }
  return leaks
}

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
    throw new Error('window.sandbot non disponibile dopo 40s')
  }
  log('configuro provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)

  // ---- 1. migrazione di una cartella copiata ----
  log('1. migrazione: file della memoria a file (fase 4) e riavvio del demone')
  const mem = (id, content, f = {}) => [
    '---', `id: ${id}`, `created_at: ${f.created_at ?? '1730000000000'}`, `updated_at: ${f.updated_at ?? '1730000000000'}`,
    `tier: ${f.tier ?? 'log'}`, `scope: ${f.scope ?? 'agent'}`, `source: ${f.source ?? 'agent'}`, '---', '', content
  ].join('\n')
  const agentMem = join(DATA, 'data', 'agents', bot.id, 'memory')
  const userMem = join(DATA, 'data', 'user', 'memory')
  mkdirSync(agentMem, { recursive: true })
  mkdirSync(userMem, { recursive: true })
  writeFileSync(join(agentMem, 'mem_core.md'), mem('mem_core', 'Il capo dell\'utente si chiama Marta', { tier: 'core', source: 'user' }))
  writeFileSync(join(agentMem, 'mem_rule.md'), mem('mem_rule', 'i report partono il lunedì', { tier: 'log', source: 'agent' }))
  writeFileSync(join(agentMem, 'mem_futura.md'), mem('mem_futura', 'nota con data nel futuro', { updated_at: String(Date.now() + 86_400_000) }))
  writeFileSync(join(agentMem, 'mem_rotto.md'), 'frontmatter mancante')
  writeFileSync(join(userMem, 'mem_shared.md'), mem('mem_shared', 'condivisa: si risponde in italiano', { scope: 'user', source: 'user', tier: 'core' }))
  await stopDaemon()
  log('demone fermato: la UI lo rilancia, e al boot la migrazione parte')
  let migrated = false
  for (let i = 0; i < 60 && !migrated; i++) {
    await sleep(1000)
    migrated = /memoria a file migrata al motore: \d+ note/.test(daemonLogText())
  }
  const migLine = (daemonLogText().match(/memoria a file migrata al motore: .*/g) ?? []).join(' | ')
  check('migrazione: 4 note migrate (1 file malformato saltato, C6: nessun blocco)', /: 4 note/.test(migLine), migLine)
  const ov1 = await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)
  check('migrazione: conteggi dal motore (own 3, shared 1)', ov1.counts.own === 3 && ov1.counts.shared === 1, JSON.stringify(ov1.counts))

  // ---- 2. conversazione che scrive e richiama ----
  log('2. conversazione: update_memory, recall_memory, search_history')
  check('turno 1 chiuso', await sendAndWait(bot.id, 'Ricorda una cosa: il mio gatto si chiama Pisolo.'))
  const w = await rpc(`memoryList(${JSON.stringify(bot.id)}, { owner: 'bot', tier: 'core' })`)
  check('conversazione: la memoria del gatto è nel motore', w.notes.some((n) => n.body.includes('Pisolo')))
  check('turno 2 chiuso', await sendAndWait(bot.id, 'Che animali ho in casa?'))
  const results2 = (await entriesOf(bot.id)).filter((e) => e.kind === 'tool-result').map((e) => e.content)
  check('conversazione: recall_memory trova la memoria', results2.some((c) => c.includes('Pisolo')))
  await sleep(2500)
  check('turno 3 chiuso', await sendAndWait(bot.id, 'Ti ricordi cosa ti ho detto sul mio gatto?'))
  const results3 = (await entriesOf(bot.id)).filter((e) => e.kind === 'tool-result').map((e) => e.content)
  check('storia: search_history trova la conversazione', results3.some((c) => c.startsWith('- [entry') && c.includes('Pisolo')))

  // ---- 3. CORREZIONI C1: la contaminazione arriva fino alla storia (e torna) ----
  log('3. C1: turno con web_fetch VERO, risposta finale, poi search_history in un turno pulito')
  check('C1: turno del sito chiuso (web_fetch → risposta finale)', await sendAndWait(bot.id, 'Che sconto c\'è sul sito?'))
  const entriesSite = await entriesOf(bot.id)
  const finalSite = entriesSite.filter((e) => e.kind === 'send-message' && e.meta?.final === true).at(-1)
  check('C1: la risposta finale del turno contaminato porta meta.contaminated', finalSite?.meta?.contaminated === true, JSON.stringify(finalSite?.meta?.contaminated))
  const fetchResult = entriesSite.filter((e) => e.kind === 'tool-result').map((e) => e.content).find((c) => c.includes('ZEBRA42'))
  check('C1: web_fetch ha letto DAVVERO la pagina del server finto', !!fetchResult)
  // il job della storia indicizza (in coda): si aspetta un attimo
  await sleep(3000)
  check('C1: il turno pulito della ricerca è chiuso', await sendAndWait(bot.id, 'Cosa ti ho detto dello sconto?'))
  const entriesSearch = await entriesOf(bot.id)
  const finalSearch = entriesSearch.filter((e) => e.kind === 'send-message' && e.meta?.final === true).at(-1)
  check('C1: il turno che legge la risposta contaminata risulta contaminato', finalSearch?.meta?.contaminated === true, JSON.stringify(finalSearch?.meta?.contaminated))
  // e la richiesta al modello porta il result incartato come dato esterno
  const wrapped = captured.some((msgs) => msgs.some((m) => m.role === 'tool' && m.content.includes('<dato_esterno fonte="search_history">') && m.content.includes('ZEBRA42')))
  check('C1: il result di search_history è incartato come dato esterno', wrapped)
  // e NESSUN testo di conversazione è rimasto nei payload dei job
  const { DatabaseSync } = await import('node:sqlite')
  const dbRO = new DatabaseSync(join(DATA, 'data', 'sandbot.db'), { readOnly: true })
  const storyPayloads = dbRO.prepare("SELECT payload_json FROM jobs WHERE kind = 'memory-index-story'").all().map((r) => r.payload_json)
  const userMsgWithText = dbRO.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'user-message' AND payload_json LIKE '%Pisolo%'").get().n
  dbRO.close()
  check('C1: i job della storia portano SOLO {entryId} (nessun testo)', storyPayloads.length > 0 && storyPayloads.every((p) => /^\{"entryId":\d+\}$/.test(p)), `${storyPayloads.length} job, es. ${storyPayloads[0]}`)
  // fuori dallo scopo di C1 (riguarda i job della storia): il job user-message
  // porta il testo del turno come input — lo si registra per il REPORT
  log(`nota (fuori da C1): ${userMsgWithText} job user-message fatti contengono ancora il testo del messaggio dell'utente`)

  // ---- 4. CORREZIONI C4: elimina → filtro «eliminate» → dimentica per sempre ----
  log('4. C4: memoria eliminata, filtro «eliminate», Dimentica per sempre dalla lapide')
  const secret = 'il pin del lucchetto della cantina è quarantadue-sgombro-viola'
  const saved = await rpc(`memorySave(${JSON.stringify(bot.id)}, ${JSON.stringify({ body: secret, tier: 'log' })})`)
  await rpc(`memoryDelete(${JSON.stringify(bot.id)}, ${JSON.stringify(saved.id)})`)
  const deleted = await rpc(`memoryList(${JSON.stringify(bot.id)}, { owner: 'bot', status: 'deleted' })`)
  check('C4: la lapide si elenca nel filtro «eliminate» (col corpo)', deleted.notes.some((n) => n.id === saved.id && n.status === 'deleted' && n.body.includes('quarantadue')), `${deleted.notes.length} eliminate`)
  const ovDel = await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)
  check('C4: il conteggio conta le eliminate', ovDel.counts.deleted >= 1, JSON.stringify(ovDel.counts))
  const detail = await rpc(`memoryNote(${JSON.stringify(bot.id)}, ${JSON.stringify(saved.id)})`)
  check('C4: il dettaglio della lapide apre (Ripristina/Dimentica per sempre)', detail.state === 'deleted' && !!detail.note)
  // la SEZIONE dal vivo: il filtro «eliminate» e i bottoni della lapide
  await clickByText('Tutte').catch(async () => { await clickByText(bot.name) })
  const opened = await waitDom(`[...document.querySelectorAll('button')].some((b) => /\\d+ note/.test(b.textContent ?? ''))`, 20_000)
  if (opened) {
    await pageEval(`
      const b = [...document.querySelectorAll('button')].find((x) => /\\d+ note/.test(x.textContent ?? ''))
      b.click()
      return 'ok'
    `)
    await sleep(600)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(1200)
    const pill = await waitDom(`[...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').trim() === 'eliminate')`, 10_000)
    check('C4 UI: il filtro «eliminate» c\'è nella sezione Memoria', pill)
    if (pill) {
      await pageEval(`
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === 'eliminate')
        b.click()
        return 'ok'
      `)
      await sleep(1000)
      const buttons = await pageEval(`return [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())`)
      check('C4 UI: la lapide ha «Ripristina» e «Dimentica per sempre»', buttons.includes('Ripristina') && buttons.includes('Dimentica per sempre'))
      await shot('memoria-eliminate.png')
    }
  } else {
    check('C4 UI: sezione Memoria raggiungibile', false, 'bottone «N note» non trovato')
  }
  const purge4 = await rpc(`memoryPurge(${JSON.stringify(bot.id)}, ${JSON.stringify(saved.id)})`)
  check('C4: Dimentica per sempre DALLA LAPIDE funziona', purge4.forgotten >= 1 && purge4.scrubbed === true, JSON.stringify({ forgotten: purge4.forgotten, scrubbed: purge4.scrubbed }))
  await stopDaemon()
  const leaks4 = leakScan(['quarantadue', 'sgombro'])
  check('C4: NESSUNA radice del testo nei file sotto memory', leaks4.length === 0, leaks4.slice(0, 3).join(' | '))
  log('demone fermo per la scansione: la UI lo rilancia')
  await waitDaemon(bot.id)

  // ---- 5. download del modello da ENGRAMMA_PULL_BASE locale (nessuna rete) ----
  log('5. modello: RAM del demone prima; download dal server locale (ENGRAMMA_PULL_BASE)')
  let pid5 = await waitDaemon(bot.id)
  await sleep(3000) // il demone appena rilanciato si assesta
  const ramBefore = rssOf(pid5)
  log(`demone pid ${pid5}: RSS ${Math.round(ramBefore / 1024)} MB prima del modello`)
  check('modello: presente=NO prima del click', (await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)).model.present === false)
  await rpc('memoryModelPull()')
  let present = false
  const t0 = Date.now()
  for (let i = 0; i < 600 && !present; i++) {
    await sleep(1000)
    try { present = (await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)).model.present } catch { /* demone occupato */ }
  }
  check('modello: download da ENGRAMMA_PULL_BASE completato e presente', present, `${Math.round((Date.now() - t0) / 1000)} s`)
  // v0.4.2: il motore NON si riapre — si aspetta la riga del collegamento a caldo
  let attached = false
  for (let i = 0; i < 60 && !attached; i++) {
    await sleep(1000)
    attached = /modello collegato \(ricerca ibrida\)/.test(daemonLogText())
  }
  check('modello: collegato A CALDO (nessuna riapertura)', attached, daemonLogText().split('\n').filter((l) => l.includes('Engramma')).at(-1)?.slice(0, 120))
  const hybrid = await rpc(`memorySearch(${JSON.stringify(bot.id)}, 'gatto')`)
  pid5 = daemonPid() ?? pid5
  const ramAfter = rssOf(pid5)
  log(`demone pid ${pid5}: RSS ${Math.round(ramAfter / 1024)} MB dopo il modello`)
  check('modello: la ricerca ibrida trova ancora la memoria', hybrid.some((h) => h.body.includes('Pisolo')), `${hybrid.length} hit`)
  check('modello: RAM del demone cresce (il modello sta in RAM)', ramAfter > ramBefore + 200_000, `prima ${Math.round(ramBefore / 1024)} MB, dopo ${Math.round(ramAfter / 1024)} MB`)

  // ---- 6. CORREZIONI C2: il bot con 1500 messaggi si dimentica per cella ----
  log('6. C2: secondo bot con 1500 messaggi indicizzati e memorie a lapide, poi ELIMINATO')
  const bot2 = await rpc(`createAgent(${JSON.stringify('Bot Oblivione')}, ${JSON.stringify('il bot che sparirà')})`)
  await rpc(`updateAgent(${JSON.stringify(bot2.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  // 20 memorie, 5 a lapide (testi con radici distintive)
  const memSecret = 'la combinazione della cassaforte è ciliegiamara-tredici'
  const saved2 = []
  for (let i = 0; i < 20; i++) {
    saved2.push(await rpc(`memorySave(${JSON.stringify(bot2.id)}, ${JSON.stringify({ body: i === 0 ? memSecret : `memoria numero ${i} del bot oblivione`, tier: 'log' })})`))
  }
  for (const s of saved2.slice(0, 5)) await rpc(`memoryDelete(${JSON.stringify(bot2.id)}, ${JSON.stringify(s.id)})`)
  const ov2 = await rpc(`memoryOverview(${JSON.stringify(bot2.id)})`)
  check('C2: il bot nuovo ha 15 memorie vive e 5 eliminate', ov2.counts.own === 15 && ov2.counts.deleted === 5, JSON.stringify(ov2.counts))
  // 1500 messaggi di conversazione: si scrivono nel DB (WAL: il demone acceso
  // lo regge) col marcatore del backfill azzerato, POI si riavvia il demone →
  // al boot la storia si indicizza (così la UI che lo rilancia subito non
  // arriva prima delle scritture)
  log('scrivo 1500 messaggi nel DB e azzero il marcatore del backfill')
  const STORY_SECRET = 'il codice del binario è sfogliascelto-sette'
  const { DatabaseSync: Db } = await import('node:sqlite')
  const dbW = new Db(join(DATA, 'data', 'sandbot.db'))
  dbW.exec('PRAGMA busy_timeout = 5000')
  const now = Date.now()
  const ins = dbW.prepare('INSERT INTO entries(agent_id, kind, role, content, meta, created_at) VALUES(?,?,?,?,?,?)')
  dbW.exec('BEGIN')
  for (let i = 1; i <= 750; i++) {
    ins.run(bot2.id, 'message', 'user', `domanda ${i}: ${STORY_SECRET} giro ${i}`, null, now - 3_000_000 + i * 1000)
    ins.run(bot2.id, 'send-message', 'assistant', `risposta ${i}: ${STORY_SECRET} resoconto ${i}`, JSON.stringify({ final: true }), now - 3_000_000 + i * 1000 + 500)
  }
  dbW.prepare("DELETE FROM settings WHERE key = 'memory.storyBackfilledAt'").run()
  dbW.exec('COMMIT')
  dbW.close()
  await stopDaemon()
  log('demone fermato: la UI lo rilancia e il backfill indicizza i 1500 messaggi')
  await waitDaemon(bot.id)
  let backfilled = false
  for (let i = 0; i < 90 && !backfilled; i++) {
    await sleep(2000)
    backfilled = /storia delle conversazioni indicizzata: 15\d\d messaggi/.test(daemonLogText())
  }
  check('C2: backfill dei 1500 messaggi (log del demone)', backfilled, (daemonLogText().match(/storia delle conversazioni indicizzata: .*/g) ?? []).at(-1)?.slice(0, 80) ?? 'riga non trovata')
  // si aspetta che la coda svezzi i job della storia
  await sleep(4000)
  // ELIMINAZIONE: agents:delete → job memory-forget-agent → DUE dropCell
  await rpc(`deleteAgent(${JSON.stringify(bot2.id)})`)
  let forgotten = false
  for (let i = 0; i < 60 && !forgotten; i++) {
    await sleep(1000)
    forgotten = new RegExp(`bot ${bot2.id} dimenticato: \\d+ note`).test(daemonLogText())
  }
  const forgetLine = (daemonLogText().match(new RegExp(`bot ${bot2.id} dimenticato: .*`), 'g') ?? []).join(' | ')
  check('C2: il log dell\'oblio porta i NUMERI del DropView', forgotten, forgetLine)
  await stopDaemon()
  const leaks6 = leakScan(['sfogliascelto', 'ciliegiamara'])
  check('C2: NESSUNA radice dei testi (storia e memorie, lapidi comprese) nei file', leaks6.length === 0, leaks6.slice(0, 3).join(' | '))
  // e il bot principale è ancora lì, con la sua memoria
  log('demone fermo per la scansione finale; il bot principale resta')

  log('RIEPILOGO', JSON.stringify({ checks: checks.length, failures, ramBeforeKb: ramBefore, ramAfterKb: ramAfter, downloadSec: Math.round((Date.now() - t0) / 1000) }))
} finally {
  await stopApp()
  await stopDaemon()
  providerServer.close()
  modelServer.close()
  rmSync(TMP, { recursive: true, force: true })
  log('app e demone fermati, cartella temporanea rimossa:', TMP)
}

process.exit(failures ? 1 : 0)
