#!/usr/bin/env node
// Sonda Electron della fase «chat-limiti» (CL3, con CL1/CL2 dal vivo).
// L'app VERA (build di sviluppo in out/) su cartella dati TEMPORANEA,
// isolamento di sempre: NESSUNA RETE VERA, tutto su 127.0.0.1. Il «modello»
// è un server OpenAI-compatible FINTO che risponde da copione; la pagina di
// annunci e le sue immagini PNG (VERE e piccole, generate a runtime con
// zlib: nessun download) le serve un server http di prova su 127.0.0.1.
// Copione: web_fetch della pagina → show_images di 2 url visti nel result.
// Copre:
//   CL1/CL2 (dal vivo): il result di web_fetch contiene TUTTI e 5 gli
//     annunci del listing (titolo+prezzo) e le 5 immagini con l'INDIRIZZO;
//   CL3: la card galleria appare in chat, le miniature si caricano da
//     homun://app/media/<hash>.<ext>, NESSUN img[src^="http"] nel DOM, sotto
//     ogni miniatura il dominio e il link alla pagina; un clic apre l'overlay
//     con l'immagine grande;
//   catture CDP in docs/catture/chat-limiti/.
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (pid in daemon.lock
// dentro la cartella dati temporanea), la cartella viene rimossa, nessun push.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = process.env.SANDBOT_PROBE_ROOT ?? resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP = mkdtempSync('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/sandbot-fase-chat-limiti-')
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'chat-limiti')
mkdirSync(DATA, { recursive: true })

const log = (...a) => console.log('[sonda]', ...a)
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- PNG veri e piccoli, generati a runtime (nessun download) ----
const crc32 = (buf) => zlib.crc32(buf) >>> 0
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
/** un PNG w×h a tinta unita (truecolor 8 bit): 5 colori diversi per 5 annunci */
const pngSolid = (w, h, [r, g, b]) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r
    row[1 + x * 3 + 1] = g
    row[1 + x * 3 + 2] = b
  }
  const idat = zlib.deflateSync(Buffer.concat(Array(h).fill(row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))
  ])
}
const ANNUNCI = [
  { titolo: 'Moto Guzzi V7 Special 2024', prezzo: '€ 8.900', colore: [140, 20, 20] },
  { titolo: 'Moto Guzzi V7 Stone 2023', prezzo: '€ 7.400', colore: [20, 20, 30] },
  { titolo: 'Moto Guzzi V7 III Racer 2019', prezzo: '€ 8.100', colore: [180, 150, 20] },
  { titolo: 'Moto Guzzi V7 Classic 2011', prezzo: '€ 5.900', colore: [30, 90, 150] },
  { titolo: 'Moto Guzzi V7 Special 2022', prezzo: '€ 8.450', colore: [90, 90, 95] }
]
const PNGS = ANNUNCI.map((a) => pngSolid(96, 72, a.colore))

// ---- il server di prova: la pagina di annunci e le sue immagini ----
const webServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/lista') {
    const articles = ANNUNCI.map((a, i) => [
      `<article class="item" data-id="${i + 1}">`,
      `<h2><a href="/annunci/v7-${i + 1}.htm">${a.titolo}</a></h2>`,
      `<p class="price">${a.prezzo}</p>`,
      `<img src="/img/${i + 1}.png" alt="Foto ${i + 1}" width="96" height="72">`,
      '</article>'
    ].join('')).join('\n')
    const html = [
      '<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><title>V7 usate</title></head><body>',
      '<header>Annunci</header><main>',
      '<h1>Moto Guzzi V7 usate</h1>',
      articles,
      '</main><footer>pagina di prova della sonda</footer></body></html>'
    ].join('')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
    return
  }
  const img = /^\/img\/([1-5])\.png$/.exec(url.pathname)
  if (img) {
    const png = PNGS[Number(img[1]) - 1]
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) }).end(png)
    return
  }
  res.writeHead(404).end('nope')
})
await new Promise((r) => webServer.listen(0, '127.0.0.1', r))
const webPort = webServer.address().port
const LISTA = `http://127.0.0.1:${webPort}/lista`
log(`pagina di annunci su ${LISTA}`)

// ---- il «modello»: server OpenAI-compatible FINTO (risponde da copione) ----
const script = []
const pushTool = (name, args) => script.push({ toolCalls: [{ name, arguments: args }] })
const pushText = (text) => script.push({ text })
const chatRequests = []
const chunkOf = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-finto', object: 'chat.completion.chunk', created: 1, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const chatOf = (req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    chatRequests.push(JSON.parse(body))
    const next = script.shift() ?? { text: 'ok' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(chunkOf({ role: 'assistant', content: '' }))
    if (next.text) res.write(chunkOf({ content: next.text }))
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

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9348
let appLog = ''
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
    // il loopback dei test: web_fetch e show_images possono leggere il server
    // di prova su 127.0.0.1 (flag che non esiste in produzione)
    SANDBOT_WEB_FETCH_ALLOW_LOOPBACK: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => {
  try { app?.kill('SIGTERM') } catch { /* già via */ }
}
/** chiude l'app ASPETTANDO che il processo esca davvero (SIGTERM, poi di nuovo, poi SIGKILL): un'UI orfana con la stdout su una pipe chiusa va in crash-loop di EPIPE — visto dal vivo, SIGTERM ignorato a metà avvio */
const stopAppAndWait = async () => {
  const pid = app?.pid
  stopApp()
  for (let i = 0; i < 15; i++) {
    try { process.kill(pid, 0) } catch { return }
    await sleep(400)
    if (i === 7) stopApp()
  }
  try { app?.kill('SIGKILL') } catch { /* già via */ }
  await sleep(400)
}
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

// ---- CDP: pagina del renderer (come le sonde delle fasi precedenti) ----
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
const page = await waitForPage()
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
const setWindowWidth = async (width, height = 820) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const shot = async (name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
const entriesOf = (agentId) => pageEval(`return await window.sandbot.getEntries(${JSON.stringify(agentId)})`)
const waitForText = async (text, ms = 40_000) =>
  waitDom(`[...document.querySelectorAll('div,p')].some((d) => d.textContent.trim() === ${JSON.stringify(text)})`, ms)

try {
  if (!(await waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }

  // ---- la GUIDA del primo avvio, in fretta: «Salta per ora» su ogni passo
  // che lo offre, «Continua» altrimenti, finché la chat non si apre
  const click = (testid) => pageEval(`
    const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
    el.click()
    return 'cliccato'
  `)
  if (await waitDom(`!!document.querySelector('[data-testid="guide-step-welcome"]')`, 20_000)) {
    for (let i = 0; i < 12 && !(await waitDom(`!!document.querySelector('form textarea')`, 2500)); i++) {
      // il passo Permessi vuole una scelta: «Chiedimi prima» (come la prova
      // vera della beta.5), poi «Continua» si abilita
      if (await pageEval(`return !!document.querySelector('[data-testid="guide-approvals-ask"]')`)) {
        await click('guide-approvals-ask')
        await sleep(400)
      }
      const hasSkip = await pageEval(`return !!document.querySelector('[data-testid="guide-skip"]')`)
      const hasCont = await pageEval(`return !document.querySelector('[data-testid="guide-continue"]')?.disabled`)
      if (hasSkip) await click('guide-skip')
      else if (hasCont) await click('guide-continue')
      else await sleep(600)
    }
  }
  check('setup la chat si apre (guida percorsa o già fatta)', await waitDom(`!!document.querySelector('form textarea')`, 25_000))

  // ---- setup: provider finto + il bot principale ----
  log('configuro provider finto e il bot…')
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await rpc('listAgents()')
  const bot = agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await setWindowWidth(1440)
  mkdirSync(SHOTS, { recursive: true })
  for (const f of readdirSync(SHOTS)) rmSync(join(SHOTS, f))

  // ============ il copione: web_fetch → show_images di 2 url ============
  const IMG1 = `http://127.0.0.1:${webPort}/img/1.png`
  const IMG2 = `http://127.0.0.1:${webPort}/img/2.png`
  const FINALE = 'Ecco due foto degli annunci V7, direttamente dalla pagina che ho letto.'
  pushTool('web_fetch', { url: LISTA })
  pushTool('show_images', { urls: [IMG1, IMG2], caption: 'Due annunci dalla pagina' })
  pushText(FINALE)
  await uiSend('Mi mostri le foto delle Moto Guzzi V7?')

  // ---- CL1/CL2 dal vivo: il result di web_fetch tiene TUTTI gli annunci ----
  const fetchResultOk = await (async () => {
    for (let i = 0; i < 40; i++) {
      const es = await entriesOf(bot.id)
      const tr = es.findLast((e) => e.kind === 'tool-result' && String(e.content).includes('<pagina_web'))
      if (tr) {
        const c = String(tr.content)
        return ANNUNCI.every((a) => c.includes(a.titolo)) && ANNUNCI.every((a) => c.includes(a.prezzo)) &&
          ANNUNCI.every((_, i) => c.includes(`![Foto ${i + 1}](http://127.0.0.1:${webPort}/img/${i + 1}.png)`))
      }
      await sleep(400)
    }
    return false
  })()
  check('CL1/CL2 il result di web_fetch contiene TUTTI e 5 gli annunci (titolo+prezzo) e le 5 immagini con l\'indirizzo', fetchResultOk)

  // ---- CL3: la card galleria in chat ----
  check('CL3 la card galleria appare in chat', await waitDom(`!!document.querySelector('[data-testid="image-gallery"]')`, 45_000))
  await waitDom(
    `[...document.querySelectorAll('[data-testid="image-gallery"] img')].length >= 2 && ` +
    `[...document.querySelectorAll('[data-testid="image-gallery"] img')].every((i) => i.complete && i.naturalWidth > 0)`,
    20_000
  )
  const dom = await pageEval(`
    const card = document.querySelector('[data-testid="image-gallery"]')
    const imgs = card ? [...card.querySelectorAll('img')] : []
    return {
      imgs: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      homun: imgs.filter((i) => i.src.startsWith('homun://app/media/')).length,
      figs: card ? [...card.querySelectorAll('figcaption')].map((f) => f.textContent.trim()) : [],
      pageLinks: card ? [...card.querySelectorAll('a[href^="http"]')].map((a) => a.href) : []
    }`)
  check('CL3 le miniature si caricano DAVVERO (naturalWidth > 0)', dom.imgs >= 2 && dom.loaded === dom.imgs, JSON.stringify(dom))
  check('CL3 OGNI src è homun://app/media/… (il protocollo dell\'app)', dom.homun === dom.imgs && dom.imgs >= 2)
  check('CL3 NESSUN img[src^="http"] nel DOM della chat',
    (await pageEval(`return document.querySelectorAll('img[src^="http"]').length`)) === 0)
  check('CL3 sotto ogni miniatura il DOMINIO di provenienza', dom.figs.length >= 2 && dom.figs.every((f) => f.includes('127.0.0.1')), dom.figs.join(' | '))
  check('CL3 sotto ogni miniatura il LINK alla pagina degli annunci', dom.pageLinks.length >= 2 && dom.pageLinks.every((h) => h === LISTA), dom.pageLinks.join(' | '))
  await shot('galleria-1440-chiaro.png')

  // ---- CL3: il clic apre l'immagine grande ----
  await pageEval(`document.querySelector('[data-testid="image-gallery"] img')?.closest('button')?.click()`)
  check('CL3 il clic sulla miniatura apre l\'immagine grande',
    await waitDom(`!!document.querySelector('[role="dialog"] img') && (() => { const i = document.querySelector('[role="dialog"] img'); return i.src.startsWith('homun://app/media/') })()`))
  await sleep(400)
  await shot('galleria-zoom-1440-chiaro.png')
  await pageEval(`document.querySelector('[role="dialog"]')?.click()`)

  // ---- CL3: le entry del turno raccontano il giro ----
  const es = await entriesOf(bot.id)
  const siCall = es.findLast((e) => e.kind === 'tool-call' && e.content === 'show_images')
  const siRes = es.findLast((e) => e.kind === 'tool-result' && e.meta?.shownImages !== undefined)
  const gallery = es.findLast((e) => e.kind === 'send-message' && e.meta?.message?.type === 'images')
  check('CL3 la entry send-message è una galleria con le DUE immagini chieste',
    gallery?.meta?.message?.images?.length === 2 &&
    gallery.meta.message.images.every((im) => /^[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/.test(im.file) && im.pageUrl === LISTA),
    JSON.stringify(gallery?.meta?.message?.images?.map((i) => i.file.slice(0, 8) + '.' + i.file.split('.').pop())))
  check('CL3 il tool-result dice 2 immagini mostrate e la tool-call c\'è', !!siCall && siRes?.meta?.shownImages === 2)
  check('CL3 il file dell\'immagine esiste nella cartella chat-images dei dati dell\'app (hash dal contenuto)', await (async () => {
    const files = gallery?.meta?.message?.images ?? []
    if (files.length !== 2) return false
    const png1 = PNGS[0]
    const sha = createHash('sha256').update(png1).digest('hex')
    return files.some((f) => f.file === `${sha}.png`)
  })())
  await waitForText(FINALE, 20_000)

  // ---- K1: nessuna cattura duplicata ----
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
  console.error(appLog.slice(-1500))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  // il log del daemon SEMPRE: la prima cosa da guardare quando un check fallisce
  try { console.log('--- daemon.log (coda) ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-4000)) } catch { /* niente log */ }
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
  try { webServer.closeAllConnections?.(); webServer.close() } catch { /* già chiusa */ }
  await stopAppAndWait()
  // Vincoli (fase): a fine sonda si chiude ANCHE il daemon di sviluppo
  await stopDaemon()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  const stillAlive = daemonPid()
  console.log(`daemon di sviluppo chiuso: ${stillAlive === null ? 'sì (nessun lock residuo)' : `NO, pid ${stillAlive} ancora in lock`}`)
  process.exit(failures ? 1 : 0)
}
