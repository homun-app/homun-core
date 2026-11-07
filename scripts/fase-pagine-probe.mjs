#!/usr/bin/env node
// Sonda Electron della fase «pagine» (G1–G7). L'app VERA (build di sviluppo
// in out/) su cartella dati TEMPORANEA, con l'isolamento di sempre e il
// provider FINTO openai-compatible su 127.0.0.1: NESSUNA RETE VERA. Il
// provider risponde con un write_document LUNGO (10 sezioni + un blocco
// vega-lite) e poi con un secondo documento da 14 sezioni. Controlla:
//   G1: la card in chat con l'anteprima e l'etichetta «Pagina»;
//   G2: il clic apre la pagina a tutta larghezza, con l'indice di 10 voci
//       (e «Mostra tutti (14)» sul documento più lungo), il clic su una voce
//       dell'indice SCORRE alla sezione, il grafico vega-lite è reso, il
//       compositore resta sospeso e il messaggio scritto da lì arriva al
//       provider con la riga [The user is reading the page …], ✕ ed Esc
//       tornano alla chat, la riga «versione N · aggiornata …» porta allo
//       storico con «Ripristina»;
//   G3: la scheda Libreria del bot mostra la pagina sotto «Oggi» con i filtri
//       Tutti/Pagine/Media; il clic sul nome apre «Impostazioni del bot» con
//       Profilo, Routine e Avanzate;
//   G4: un suggerimento «Collega Slack» dopo un messaggio che nomina Slack,
//       che sparisce con ✕ e NON torna;
//   G7: niente sporge a 1440/1100/900, in chiaro e in scuro.
// I menu Radix si chiudono con Escape. TRE CORSE, 0 daemon dopo ognuna
// (probe-daemons). Le catture (docs/catture/pagine/) sono fatte in locale e
// Dichiarate controllate sul DOM.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-pagine'
const SHOTS = join(ROOT, 'docs', 'catture', 'pagine')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log('[sonda]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Il documento lungo: titolo #, intro, N sezioni ##, un blocco vega-lite inline. */
const docOf = (title, sections) => [
  `# ${title}`,
  '',
  'Questo documento raccoglie il lavoro della settimana e le prossime mosse.',
  '',
  ...Array.from({ length: sections }, (_v, i) => [
    `## Sezione ${i + 1}`,
    '',
    `Testo della sezione ${i + 1}: numeri, note e considerazioni utili al lettore.`,
    ...(i === sections - 1
      ? [
          '',
          'Il grafico dei carichi del mese:',
          '',
          '```vega-lite',
          JSON.stringify({
            mark: 'bar',
            data: { values: [{ m: 'gen', v: 10 }, { m: 'feb', v: 14 }, { m: 'mar', v: 9 }] },
            encoding: { x: { field: 'm', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } }
          }),
          '```'
        ]
      : []),
    ''
  ].join('\n'))
].join('\n')

async function runOnce(run, shots) {
  const TMP = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))
  const DATA = join(TMP, 'data')
  mkdirSync(DATA, { recursive: true })
  let failures = 0
  const checks = []
  const check = (id, ok, note = '') => {
    checks.push({ id, ok, note })
    if (!ok) failures++
    console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
  }

  // ---- il provider finto (openai-compatible, SSE) ----
  const chatRequests = []
  const script = [
    { toolCalls: [{ name: 'write_document', arguments: { title: 'Brief della settimana', content: docOf('Brief della settimana', 10) } }] },
    { text: 'Il brief è pronto: apri la pagina dalla card qui sopra.' },
    { toolCalls: [{ name: 'write_document', arguments: { title: 'Manuale operativo', content: docOf('Manuale operativo', 14) } }] },
    { text: 'Fatto: anche il manuale è in libreria.' },
    { text: 'Ho guardato: per Slack serve il collegamento.' }
  ]
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
  const DEBUG_PORT = 9351 + run
  let appLog = ''
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
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
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }

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
      } catch { /* il debugger non è ancora su */ }
      await sleep(200)
    }
    throw new Error('nessuna pagina CDP: log app:\n' + appLog.slice(-1500))
  }
  const page = await waitForPage()
  log(`corsa ${run}: CDP collegato al renderer`)

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
  const clickTestid = (testid) => pageEval(`
    const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
    el.scrollIntoView({ block: 'center' })
    const b = el.matches('button') ? el : el.querySelector('button')
    ;(b ?? el).click()
    return 'cliccato'
  `)
  const pointerClick = (selectorExpr) => pageEval(`
    const el = ${selectorExpr}
    if (!el) throw new Error('non trovato (pointerClick)')
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
    el.click()
    return 'cliccato'
  `)
  /** Chiude il menu Radix aperto con Escape e ASPETTA che sparisca. */
  const closeRadixMenu = async () => {
    await pageEval(`
      const m = document.querySelector('[role="menu"]')
      ;(m ?? document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return 'escape'
    `)
    const gone = await waitDom(`!document.querySelector('[role="menu"]')`, 5_000)
    if (!gone) throw new Error('il menu Radix non si è chiuso con Escape')
    await sleep(300)
  }
  const setDark = async (dark) => {
    await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
    await sleep(350)
  }
  /** Niente sporge: la pagina non scorre in orizzontale e il pannello resta dentro. */
  const nothingSticksOut = () => pageEval(`
    const doc = document.documentElement
    const panel = document.querySelector('[data-testid="bot-panel"]')
    return {
      scrollW: doc.scrollWidth, innerW: window.innerWidth,
      panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : null
    }
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

    // ============ G1: la card della pagina ============
    await uiSend('preparami il brief della settimana come pagina')
    check('G1a la card della pagina compare (con anteprima)', await waitDom(`!!document.querySelector('[data-testid="page-card"] [data-testid="page-card-preview"]')`, 40_000))
    check('G1b l\'etichetta dice «Pagina»', await waitDom(`[...document.querySelectorAll('[data-testid="page-card-label"]')].some((x) => x.textContent.trim() === 'Pagina')`, 10_000))
    const cardPreview = await pageEval(`
      const card = document.querySelector('[data-testid="page-card"]')
      return {
        titolo: card.querySelector('.font-display')?.textContent ?? '',
        voci: [...card.querySelectorAll('ul li span:last-child')].map((x) => x.textContent),
        sfuma: !!card.querySelector('.bg-gradient-to-b')
      }
    `)
    check('G1c l\'anteprima ha titolo, 6 voci d\'indice e la sfumatura',
      cardPreview.titolo === 'Brief della settimana' && cardPreview.voci.length === 6 && cardPreview.voci[0] === 'Sezione 1' && cardPreview.sfuma,
      JSON.stringify(cardPreview).slice(0, 160))
    if (run === 1) await shot('01-card-pagina-1440-chiaro.png')

    // ============ G2: la pagina aperta ============
    await clickTestid('page-card')
    check('G2a il clic apre la pagina (page-view, tutta larghezza)', await waitDom(`!!document.querySelector('[data-testid="page-view"]')`, 10_000))
    check('G2b l\'indice ha 10 voci', await waitDom(`document.querySelectorAll('[data-testid="page-toc-item"]').length === 10`, 10_000))
    check('G2c il grafico vega-lite è reso (img dentro la pagina)', await waitDom(`!!document.querySelector('[data-testid="page-view"] img[src^="data:image/svg"]')`, 20_000))
    check('G2d la riga «versione 1 · aggiornata …» c\'è', await waitDom(`(document.querySelector('[data-testid="page-version"]')?.textContent ?? '').includes('versione 1')`, 5_000))
    // il compositore resta SOSPESO sopra la pagina
    const composerVisible = await pageEval(`
      const ta = document.querySelector('form textarea')
      const r = ta?.getBoundingClientRect()
      return !!r && r.top < window.innerHeight && r.bottom > 0 && ta.offsetParent !== null
    `)
    check('G2e il compositore è visibile mentre la pagina è aperta', composerVisible)
    // il clic su una voce dell'indice SCORRE alla sezione
    const scrolled = await pageEval(`
      const items = [...document.querySelectorAll('[data-testid="page-toc-item"]')]
      items[2].click()
      await new Promise((r) => setTimeout(r, 900))
      const h = [...document.querySelectorAll('[data-testid="page-view"] h2')].find((x) => x.textContent.trim() === 'Sezione 3')
      return h ? Math.round(h.getBoundingClientRect().top) : null
    `)
    check('G2f il clic sull\'ultima voce scorre alla sezione (top vicino alla cima)', scrolled !== null && scrolled < 140, `top=${scrolled}`)
    // il menu Esporta si apre e si chiude con Escape
    await pointerClick(`document.querySelector('[data-testid="page-export"]')`)
    check('G2g il menu Esporta offre md/html/pdf', await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].filter((x) => ['md','html','pdf'].includes(x.textContent.trim())).length === 3`, 5_000))
    await closeRadixMenu()

    // il messaggio scritto dalla pagina arriva al provider CON la riga di contesto
    await uiSend('allunga la sezione dei numeri')
    await sleep(5_000)
    const req3 = chatRequests.find((r) => (r.messages?.at(-1)?.content ?? '').includes('[The user is reading the page "Brief della settimana" (id '))
    check('G2h il messaggio dalla pagina arriva al modello con la riga di lettura', !!req3,
      req3 ? (req3.messages.at(-1).content.split('\n')[0] ?? '').slice(0, 90) : `richieste: ${chatRequests.length}`)
    check('G2i in chat il messaggio resta SENZA la riga (solo testo)', await waitDom(
      `[...document.querySelectorAll('main .justify-end > div')].some((d) => d.textContent.trim() === 'allunga la sezione dei numeri') && ![...document.querySelectorAll('main')].some((d) => d.textContent.includes('[The user is reading'))`, 10_000))

    // il secondo documento (14 sezioni) → «Mostra tutti (14)»
    check('G2j la seconda card compare', await waitDom(`document.querySelectorAll('[data-testid="page-card"]').length >= 2`, 40_000))
    await clickTestid('page-close')
    check('G2m la ✕ torna alla chat', await waitDom(`!document.querySelector('[data-testid="page-view"]')`, 5_000))
    const cards = await pageEval(`return document.querySelectorAll('[data-testid="page-card"]').length`)
    await pageEval(`
      const card = [...document.querySelectorAll('[data-testid="page-card"]')][${cards - 1}]
      card.querySelector('button').click()
      return "aperta-ultima"
    `)
    check('G2n il documento da 14+ titoli mostra «Mostra tutti»', await waitDom(`!!document.querySelector('[data-testid="page-toc-all"]') && document.querySelectorAll('[data-testid="page-toc-item"]').length === 12`, 10_000))
    const allShown = await pageEval(`
      document.querySelector('[data-testid="page-toc-all"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      return document.querySelectorAll('[data-testid="page-toc-item"]').length
    `)
    check('G2o «Mostra tutti» apre l’indice completo', allShown === 14, `voci=${allShown}`)
    // Esc chiude la pagina
    await pageEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    check('G2p Esc chiude la pagina e torna alla chat', await waitDom(`!document.querySelector('[data-testid="page-view"]') && !!document.querySelector('form textarea')`, 5_000))
    if (run === 1) await shot('02-pagina-aperta-1440-chiaro.png')

    // la riga della versione porta allo storico con «Ripristina»
    await clickTestid('page-card')
    await waitDom(`!!document.querySelector('[data-testid="page-version"]')`, 5_000)
    await clickTestid('page-version')
    check('G2q lo storico della libreria si apre (Versioni + ← Lista)', await waitDom(
      `document.body.textContent.includes('Versioni:') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '← Lista')`, 10_000))
    await pageEval(`
      const back = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '← Lista')
      back?.click()
      return 'lista'
    `)
    await sleep(400)
    await pageEval(`
      const back = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '') === 'Torna alla chat')
      back?.click()
      return 'chat'
    `)
    check('G2r dalla lista della libreria si torna alla chat', await waitDom(
      `!document.body.textContent.includes('Cerca per titolo') && !!document.querySelector('form textarea')`, 5_000))

    // ============ G3: la scheda Libreria del bot ============
    check('G3a le due schede Attività · Libreria', await waitDom(`!!document.querySelector('[data-testid="bot-tab-activity"]') && !!document.querySelector('[data-testid="bot-tab-library"]')`, 10_000))
    await clickTestid('bot-tab-library')
    check('G3b la Libreria del bot mostra la pagina sotto «Oggi»', await waitDom(`
      (() => {
        const lib = document.querySelector('[data-testid="bot-library"]')
        return !!lib
          && [...lib.querySelectorAll('p')].some((p) => p.textContent.trim() === 'Oggi')
          && [...lib.querySelectorAll('button')].some((b) => b.textContent.includes('Brief della settimana'))
      })()
    `, 10_000))
    check('G3c i filtri Tutti / Pagine / Media', await waitDom(
      `[...document.querySelectorAll('[data-testid="bot-library-filters"] button')].map((b) => b.textContent.trim()).join('|') === 'Tutti|Pagine|Media'`, 5_000))
    const filterMedia = await pageEval(`
      document.querySelector('[data-testid="bot-library-filters"] button:nth-child(3)').click()
      await new Promise((r) => setTimeout(r, 300))
      const lib = document.querySelector('[data-testid="bot-library"]')
      return [...lib.querySelectorAll('button')].filter((b) => b.textContent.includes('Brief della settimana')).length
    `)
    check('G3d il filtro Media nasconde le pagine', filterMedia === 0)
    await pageEval(`document.querySelector('[data-testid="bot-library-filters"] button:nth-child(1)').click()`)
    if (run === 1) await shot('04-pannello-libreria-1440-chiaro.png')

    // ============ G4: il suggerimento «Collega Slack» ============
    await clickTestid('bot-tab-activity')
    await uiSend('guarda su Slack cosa dicono di noi')
    check('G4a il suggerimento «Collega Slack» compare in Attività', await waitDom(
      `[...document.querySelectorAll('[data-testid="bot-suggestion"]')].some((x) => x.textContent.includes('Collega Slack'))`, 30_000))
    if (run === 1) await shot('03-pannello-attivita-1440-chiaro.png')
    await clickTestid('bot-suggestion-dismiss')
    check('G4b la ✕ chiude il suggerimento', await waitDom(`!document.querySelector('[data-testid="bot-suggestion"]')`, 5_000))
    await clickTestid('bot-tab-library')
    await sleep(300)
    await clickTestid('bot-tab-activity')
    // il blocco ricarica i dismissed dal setting (RPC): si aspetta che il
    // suggerimento NON compaia, né subito né dopo
    await sleep(1800)
    const afterBack = await pageEval(`
      return {
        suggerimenti: [...document.querySelectorAll('[data-testid="bot-suggestion"]')].map((x) => x.textContent.trim()),
        setting: await window.sandbot.settingsGet('suggestions.dismissed', {}),
        botId: (await window.sandbot.listAgents())[0].id
      }
    `)
    check('G4c il suggerimento NON torna (dismissed per questo bot)',
      afterBack.suggerimenti.length === 0,
      JSON.stringify(afterBack).slice(0, 220))

    // il clic sul nome apre «Impostazioni del bot» con Profilo, Routine e Avanzate
    await clickTestid('bot-settings-trigger')
    check('G3e «Impostazioni del bot» si apre con Profilo, Routine e Avanzate', await waitDom(`
      (() => {
        const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes('Impostazioni del bot'))
        return !!dlg && dlg.textContent.includes('Profilo') && dlg.textContent.includes('Routine') && dlg.textContent.includes('Avanzate')
      })()
    `, 10_000))
    if (run === 1) await shot('06-impostazioni-bot-1440-chiaro.png')
    await pageEval(`
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return 'esc'
    `)
    check('G3f il foglio si chiude con Esc', await waitDom(`![...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('Impostazioni del bot'))`, 5_000))

    // ============ G7: niente sporge a 1440/1100/900, chiaro e scuro ============
    // con la pagina aperta
    await clickTestid('page-card')
    await waitDom(`!!document.querySelector('[data-testid="page-view"]')`, 5_000)
    for (const [w, dark] of [[1440, false], [1440, true], [1100, false], [1100, true], [900, false], [900, true]]) {
      await setWindowWidth(w)
      await setDark(dark)
      const m = await nothingSticksOut()
      check(`G7a pagina aperta ${w} ${dark ? 'scuro' : 'chiaro'}: niente sporge`,
        m.scrollW <= m.innerW && (m.panelRight === null || m.panelRight <= m.innerW), JSON.stringify(m))
      if (run === 1 && w === 1440 && dark) await shot('05-pagina-1440-scuro.png')
    }
    await setDark(false)
    // col pannello su Attività
    await pageEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await waitDom(`!document.querySelector('[data-testid="page-view"]')`, 5_000)
    for (const w of [1440, 1100, 900]) {
      await setWindowWidth(w)
      const m = await nothingSticksOut()
      check(`G7b pannello Attività ${w}: niente sporge`, m.scrollW <= m.innerW && (m.panelRight === null || m.panelRight <= m.innerW), JSON.stringify(m))
    }
    await setWindowWidth(1440)

    // K1: due PNG con nomi diversi non possono avere lo stesso hash (solo corsa 1)
    if (run === 1 && shots) {
      const byHash = new Map()
      const dup = []
      for (const name of readdirSync(SHOTS).filter((n) => n.endsWith('.png')).sort()) {
        const h = createHash('sha256').update(readFileSync(join(SHOTS, name))).digest('hex')
        if (byHash.has(h)) dup.push(`${name} ≡ ${byHash.get(h)}`)
        else byHash.set(h, name)
      }
      check('K1 nessuna cattura duplicata (stesso hash con nomi diversi)', dup.length === 0, dup.join('; '))
    }
  } catch (e) {
    failures++
    console.error(`\n[sonda corsa ${run}] ERRORE:`, e.message ?? e)
    try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'daemon.log'), 'utf8').slice(-6000)) } catch { /* niente log */ }
    console.error(appLog.slice(-1200))
  } finally {
    console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'} (corsa ${run}): ${checks.filter((c) => c.ok).length}/${checks.length}`)
    try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
    stopApp()
    await sleep(800)
    // 0 daemon dopo OGNI corsa (il controllo condiviso, dall'ambiente)
    const { found, closed, left } = await stopProbeDaemons(PREFIX)
    console.log(`[corsa ${run}] daemon: ${found} trovati, ${closed} chiusi, ${left} rimasti`)
    if (left > 0) {
      failures++
      console.error(`[corsa ${run}] daemon rimasti:\n` + findProbeDaemons(PREFIX).map((d) => d.line).join('\n'))
    }
    try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  }
  return failures
}

let total = 0
for (const run of [1, 2, 3]) {
  log(`--- corsa ${run} di 3 ---`)
  total += await runOnce(run, run === 1)
}
console.log(total === 0 ? '\nSONDA VERDE in 3 corse' : `\nSONDA ROSSA: ${total} corse con fallimenti`)
process.exit(total ? 1 : 0)
