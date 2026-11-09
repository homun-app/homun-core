#!/usr/bin/env node
// Sonda Electron della fase memoria-engramma, sull'app IMPACCHETTATA
// (dist-installers/mac-arm64/Homun.app, release:local) con dati TEMPORANEI
// (SANDBOT_TEST_USER_DATA): MAI la cartella dati vera dell'utente. Il
// «modello» è il solito server OpenAI-compatible FINTO su 127.0.0.1; il motore
// Engramma invece è QUELLO VERO, dentro l'app. Copre i quattro punti della
// prova dal vivo (M8):
//   1. migrazione di una cartella copiata (file markdown della fase 4 → note,
//      con la copia di sicurezza in memory-legacy-<data>/);
//   2. una conversazione che scrive (update_memory) e richiama (recall_memory)
//      + il richiamo della storia (search_history);
//   3. il download del modello DAL VIVO (l'unico download: parte dal click),
//      con la RAM del demone prima e dopo;
//   4. «Dimentica per sempre» (purge: il testo sparisce anche dai file).
// Tutto ciò che la sonda stampa finisce nel REPORT; le catture in
// docs/catture/fase-memoria-engramma/. A fine sonda app e demone si fermano e
// la cartella temporanea si rimuove.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-memoria-engramma-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-memoria-engramma')
mkdirSync(DATA, { recursive: true })
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

// ---- il «modello»: server OpenAI-compatible FINTO ----
// copione DECISO dall'ultimo messaggio utente della richiesta: le richieste
// extra tra i turni (auto-review, compaction) non spostano la copione
const CUES = [
  { match: 'Ricorda una cosa', reply: { toolCalls: [{ name: 'update_memory', arguments: { action: 'write', content: "Il gatto dell'utente si chiama Pisolo", tier: 'core' } }] } },
  { match: 'Che animali', reply: { toolCalls: [{ name: 'recall_memory', arguments: { query: 'gatto nome' } }] } },
  { match: 'Ti ricordi cosa ti ho detto', reply: { toolCalls: [{ name: 'search_history', arguments: { query: 'gatto Pisolo' } }] } }
]
const FINALE = {
  'Ricorda una cosa': 'Fatto: ho salvato che il tuo gatto si chiama Pisolo.',
  'Che animali': 'Hai un gatto che si chiama Pisolo.',
  'Ti ricordi cosa ti ho detto': 'Mi hai detto che il tuo gatto si chiama Pisolo.'
}
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
/**
 * La risposta per una richiesta: se l'ultimo messaggio utente contiene un
 * CUE e la richiesta NON ne contiene già il result (secondo giro), parte la
 * chiamata di strumento; al giro dopo (o subito senza cue) la frase finale.
 */
const replyFor = (messages) => {
  const lastUserAt = messages.map((m) => m.role).lastIndexOf('user')
  const text = String(messages[lastUserAt]?.content ?? '')
  const cue = CUES.find((c) => text.includes(c.match))
  // il result dello strumento c'è già DOPO l'ultimo messaggio utente: giro 2
  const after = messages.slice(lastUserAt + 1).filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''))
  // come un modello vero: dopo l'attivazione del gruppo per nome si richiama
  const reactivate = after.length > 0 && /now active\. Call it again/.test(after.at(-1))
  if (cue && (after.length === 0 || reactivate)) return cue.reply
  for (const [k, v] of Object.entries(FINALE)) if (text.includes(k)) return { text: v }
  return { text: 'ok' }
}
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const next = replyFor(JSON.parse(body).messages ?? [])
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
  if (url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'finto' }] }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- l'app IMPACCHETTATA con dati temporanei ----
const APP = join(ROOT, 'dist-installers', 'mac-arm64', 'Homun.app')
const ELECTRON = join(APP, 'Contents', 'MacOS', 'Homun')
if (!existsSync(ELECTRON)) throw new Error('manca l\'app impacchettata: npm run release:local')
const DEBUG_PORT = 9351
let appLog = ''
const proc = spawn(ELECTRON, [`--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
proc.stdout.on('data', (d) => { appLog += d.toString() })
proc.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => { try { proc?.kill('SIGTERM') } catch { /* già via */ } }
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
/** clicca il primo elemento il cui testo contiene esattamente il pezzo dato */
const clickByText = async (piece, scope = 'button') => pageEval(`
  const el = [...document.querySelectorAll('${scope}')].find((b) => (b.textContent ?? '').includes(${JSON.stringify(piece)}))
  if (!el) throw new Error('nessun elemento con testo: ' + ${JSON.stringify(piece)})
  el.click()
  return 'cliccato'
`)
const waitForBotIdle = async (agentId) => waitDom(
  `(await window.sandbot.listAgents()).find((a) => a.id === ${JSON.stringify(agentId)})?.status === 'idle'`, 60_000, 500)
/** manda un messaggio e aspetta la NUOVA risposta finale (il turno è davvero partito e chiuso) */
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
const toolResultsOf = async (agentId) => {
  const entries = await pageEval(`return await window.sandbot.getEntries(${JSON.stringify(agentId)})`)
  return entries.filter((e) => e.kind === 'tool-result').map((e) => e.content)
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
  log('M8.1 migrazione: scrivo i file della memoria a file (fase 4) e riavvio il demone')
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
  log('riga del log:', migLine)
  check('migrazione: 4 note migrate (1 file malformato saltato)', /: 4 note/.test(migLine), migLine)
  check('migrazione: avvisi nel log (data futura e file rotto)', /avvisi/.test(migLine))
  const legacyDir = readdirSync(join(DATA, 'data')).find((d) => d.startsWith('memory-legacy-'))
  check('migrazione: copia di sicurezza memory-legacy-<data>', !!legacyDir && existsSync(join(DATA, 'data', legacyDir, 'agents', bot.id, 'memory', 'mem_core.md')), legacyDir)
  check('migrazione: i file originali non ci sono più', readdirSync(agentMem).length === 0)
  const ov1 = await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)
  check('migrazione: conteggi dal motore (own 3, shared 1)', ov1.counts.own === 3 && ov1.counts.shared === 1, JSON.stringify(ov1.counts))
  check('migrazione: motore attivo e senza modello', ov1.engine.available === true && ov1.model.present === false, `versione ${ov1.engine.version}`)

  // ---- 2. conversazione che scrive e richiama ----
  log('M8.2 conversazione: update_memory, poi recall_memory, poi search_history')
  check('turno 1 chiuso con la risposta', await sendAndWait(bot.id, 'Ricorda una cosa: il mio gatto si chiama Pisolo.'))
  const w = await rpc(`memoryList(${JSON.stringify(bot.id)}, { owner: 'bot', tier: 'core' })`)
  check('conversazione: la memoria del gatto è nel motore', w.notes.some((n) => n.body.includes('Pisolo') && n.agentId === bot.id), `${w.total} core`)
  check('conversazione: la source punta al turno (homun:chat/<bot>/<entry>)', w.notes.some((n) => n.source === `homun:chat/${bot.id}/` + n.entryId))

  check('turno 2 chiuso con la risposta', await sendAndWait(bot.id, 'Che animali ho in casa?'))
  const allResults = await toolResultsOf(bot.id)
  log('tool-result del turno recall (ultimi 3):', JSON.stringify(allResults.slice(-3).map((c) => c.slice(0, 100))))
  check('conversazione: recall_memory trova la memoria', allResults.some((c) => c.includes('Pisolo')), allResults.at(-1)?.slice(0, 120))

  // la storia: il messaggio dell'utente e la risposta finale sono indicizzati (in coda)
  await sleep(2500)
  check('turno 3 chiuso con la risposta', await sendAndWait(bot.id, 'Ti ricordi cosa ti ho detto sul mio gatto?'))
  const histResults = (await toolResultsOf(bot.id))
  log('tool-result del turno storia (ultimi 3):', JSON.stringify(histResults.slice(-3).map((c) => c.slice(0, 100))))
  check('storia: search_history trova la conversazione', histResults.some((c) => c.startsWith('- [entry') && c.includes('Pisolo')), histResults.at(-1)?.slice(0, 140))
  check('storia: indicizzazione iniziale completata', (await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)).storyIndexed === true)

  // ---- la sezione Memoria: catture + Perché lo so? ----
  log('catturo la sezione Memoria (Impostazioni del bot → Memoria «N note ›»)')
  await sleep(800)
  // il foglio «Impostazioni del bot» si apre dal pannello del bot (il link
  // «Tutte >» delle routine lo apre sulla sezione Routine, col Profilo sopra)
  await clickByText('Tutte').catch(async () => { await clickByText(bot.name) })
  const opened = await waitDom(`[...document.querySelectorAll('button')].some((b) => /\\d+ note/.test(b.textContent ?? ''))`, 20_000)
  if (opened) {
    await pageEval(`
      const b = [...document.querySelectorAll('button')].find((x) => /\\d+ note/.test(x.textContent ?? ''))
      b.click()
      return 'ok'
    `)
    await sleep(600)
    // chiude il foglio (Esc): sotto c'è la sezione Memoria della chat
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(1200)
    await shot('memoria-elenco.png')
    await clickByText('Perché lo so?').catch(() => undefined)
    await sleep(900)
    await shot('memoria-perche.png')
  } else {
    const labels = await pageEval(`return [...document.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') ?? '') + '|' + (b.textContent ?? '').trim().slice(0, 30)).filter((x) => x !== '|')`)
    log('bottoni presenti:', JSON.stringify(labels))
    check('sezione Memoria raggiungibile (bottone note nel pannello destro)', false, 'bottone non trovato')
  }

  // ---- 3. download del modello (l'unico: parte dal click) ----
  log('M8.3 download del modello: RAM del demone prima')
  let pid = daemonPid()
  const ramBefore = rssOf(pid)
  log(`demone pid ${pid}: RSS ${ramBefore} kB (${Math.round(ramBefore / 1024)} MB) prima del modello`)
  const clicked = await pageEval(`
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes('scarica il modello'))
    if (b) { b.click(); return true }
    return false
  `).catch(() => false)
  check('modello: il bottone «Migliora la ricerca» è nella sezione', clicked === true, clicked ? 'cliccato' : 'bottone non trovato')
  if (!clicked) await rpc('memoryModelPull()')
  let present = false
  let progressShot = false
  const t0 = Date.now()
  for (let i = 0; i < 900 && !present; i++) {
    await sleep(1000)
    try { present = (await rpc(`memoryOverview(${JSON.stringify(bot.id)})`)).model.present } catch { /* demone occupato */ }
    if (!progressShot && i === 10) {
      progressShot = true
      await shot('memoria-modello-download.png').catch(() => undefined)
    }
  }
  check('modello: download completato e presente', present, `${Math.round((Date.now() - t0) / 1000)} s`)
  // il demone RIAPRE il motore dopo il download (l'embedder si lega
  // all'apertura): si aspetta la riga nel log, poi la ricerca ibrida
  let reopened = false
  for (let i = 0; i < 60 && !reopened; i++) {
    await sleep(1000)
    reopened = /modello caricato \(ibrida\)/.test(daemonLogText())
  }
  check('modello: motore riaperto con l\'embedder', reopened, daemonLogText().split('\n').filter((l) => l.includes('Engramma')).at(-1)?.slice(0, 120))
  const hybrid = await rpc(`memorySearch(${JSON.stringify(bot.id)}, 'gatto')`)
  await sleep(2500)
  pid = daemonPid() ?? pid
  const ramAfter = rssOf(pid)
  log(`demone pid ${pid}: RSS ${ramAfter} kB (${Math.round(ramAfter / 1024)} MB) dopo il modello (e la ricerca ibrida)`)
  check('modello: la ricerca ibrida trova ancora la memoria', hybrid.some((h) => h.body.includes('Pisolo')), `${hybrid.length} hit`)
  check('modello: RAM del demone cresce (il modello sta in RAM)', ramAfter > ramBefore + 200_000, `prima ${Math.round(ramBefore / 1024)} MB, dopo ${Math.round(ramAfter / 1024)} MB`)
  await sleep(2000)
  await shot('memoria-modello-presente.png')

  // ---- 4. Dimentica per sempre ----
  log('M8.4 Dimentica per sempre (purge)')
  const saved = await rpc(`memorySave(${JSON.stringify(bot.id)}, ${JSON.stringify({ body: 'il pin del lucchetto della cantina è quarantadue-sgombro-viola', tier: 'log' })})`)
  const purge = await rpc(`memoryPurge(${JSON.stringify(bot.id)}, ${JSON.stringify(saved.id)})`)
  check('purge: forgotten ≥ 1', purge.forgotten >= 1, JSON.stringify({ forgotten: purge.forgotten, scrubbed: purge.scrubbed, pending: purge.pending }))
  check('purge: oblio completo (scrubbed)', purge.scrubbed === true, `pending: ${purge.pending.join(',') || '—'}`)
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)])
  const rawFiles = walk(join(DATA, 'data', 'memory'))
  const leaks = rawFiles.filter((f) => readFileSync(f).includes('quarantadue') || readFileSync(f).includes('sgombro'))
  check('purge: NESSUN file sotto <dataDir>/memory contiene il testo', leaks.length === 0, leaks.map((f) => f.split('/').pop()).join(','))
  const after = await rpc(`memoryList(${JSON.stringify(bot.id)}, { owner: 'bot' })`)
  check('purge: la nota non è più nell\'elenco', !after.notes.some((n) => n.id === saved.id))

  log('RIEPILOGO', JSON.stringify({ checks: checks.length, failures, ramBeforeKb: ramBefore, ramAfterKb: ramAfter, downloadSec: Math.round((Date.now() - t0) / 1000) }))
} finally {
  stopApp()
  await stopDaemon()
  providerServer.close()
  rmSync(TMP, { recursive: true, force: true })
  log('app e demone fermati, cartella temporanea rimossa:', TMP)
}

process.exit(failures ? 1 : 0)
