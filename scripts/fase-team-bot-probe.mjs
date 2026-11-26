// Sonda della fase team-bot — K2 e K3 provati DAL VIVO con la UI, come le
// altre sonde: app VERA (out/, serve `npm run build` prima) su dati
// TEMPORANEI (SANDBOT_TEST_USER_DATA), provider FINTO su 127.0.0.1, guida
// chiusa, niente LLM vero, niente container vero. Qui NON servono turni di
// chat: menu, archiviazione, eliminazione e clic sono percorsi di UI+RPC.
//
//   K2: il «⋯» su ogni riga di bot e di team (il PRINCIPALE non lo ha) e lo
//       STESSO menu col tasto destro; Rinomina in linea; Archivia → fuori
//       dalla barra, dentro «Archiviati», routine in pausa, NESSUN dato
//       perso, Ripristina; Elimina → conferma chiara, «Eliminato · Annulla»
//       per 10 s che RIPRISTINA, il team eliminato lascia i bot al loro
//       posto (casella spenta di default) e sta in «Archiviati › Eliminati».
//   K3: clic sul nome del team non attivo → chat APERTA e membri VISIBILI;
//       secondo clic → membri chiusi; doppio clic → rinomina in linea.
//
// Catture CDP in docs/catture/fase-team-bot/. VERDE in TRE corse di fila:
//   node scripts/fase-team-bot-probe.mjs --run 1|2|3
// Pulizia: a fine corsa 0 cartelle sandbot-fase-team-bot-*, 0 daemon della
// sonda, 0 llama-server della corsa rimasti vivi.
import { spawn, execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'
import { leggiTentativiLocali, messaggioTentativiLocali, fotografaLlamaServerDellaCorsa, llamaServerDellaCorsa, messaggioLlamaServer } from './lib/sonda.mjs'
import { cleanupProbeRun, countProbeDirs } from './lib/probe-rm.mjs'

const runArg = process.argv.find((a) => /^--?run/.test(a))
const run = runArg ? (Number(runArg.split('=')[1] ?? process.argv[process.argv.indexOf(runArg) + 1]) || 1) : 1
const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const PREFIX = 'sandbot-fase-team-bot'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-team-bot')
mkdirSync(SHOTS, { recursive: true })

const log = (...a) => console.log(`[sonda r${run}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${what} (${ms} ms)`)), ms))])

let failed = 0
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  if (!ok) failed++
  log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ` — ${detail}` : ''}`)
}

const DATA = mkdtempSync(join(TMP_BASE, `${PREFIX}-`))

// ---- il modello FINTO: risponde sempre testo (qui non servono turni) ----
const providerServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'finto' }] }))
      return
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ role: 'assistant', content: 'ok' }, null))
      res.write(sse({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
})
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r))
const providerPort = providerServer.address().port

// ---- l'app Electron VERA (out/) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9427 + run
let appLog = ''
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`, '--lang=it'], {
  cwd: ROOT,
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SANDBOT_TEST_USER_DATA: DATA,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
    SANDBOT_TEST_FAKE_BROWSER_MCP: join(ROOT, 'scripts', 'fake-browser-mcp.mjs')
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
app.stdout.on('data', (d) => { appLog += d.toString() })
app.stderr.on('data', (d) => { appLog += d.toString() })
const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
process.on('SIGINT', () => { stopApp(); process.exit(130) })
process.on('SIGTERM', () => { stopApp(); process.exit(143) })

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
const waitForPage = async (urlIncludes) => {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await httpJson('/json/list')
      const target = list.find((t) => t.type === 'page' && (t.url ?? '').includes(urlIncludes))
      if (target) return { cdp: await openCdp(target.webSocketDebuggerUrl), url: target.url }
    } catch { /* il debugger non è ancora su */ }
    await sleep(200)
  }
  throw new Error(`nessuna pagina CDP per ${urlIncludes}: log app:\n` + appLog.slice(-1500))
}
const main = await waitForPage('')
const page = main.cdp
log('CDP collegato al renderer')
const pageEval = async (expr) => {
  let r
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      r = await withTimeout(page.send('Runtime.evaluate', {
        expression: `((async () => { ${expr} })())`,
        awaitPromise: true,
        returnByValue: true
      }), 35_000, 'Runtime.evaluate')
      break
    } catch (e) {
      if (attempt === 3) throw e
      await sleep(2500)
    }
  }
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const rpc = async (callExpr) => {
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try {
      return await pageEval(`return await window.sandbot.${callExpr}`)
    } catch (e) {
      lastErr = e
      await sleep(1500)
    }
  }
  throw lastErr
}
const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
  const deadline = Date.now() + timeoutMs
  const fast = async () => {
    try {
      return await withTimeout(page.send('Runtime.evaluate', {
        expression: `((async () => { return !!(${exprTrue}) })())`,
        awaitPromise: true,
        returnByValue: true
      }), 8_000, 'fast eval').then((r) => {
        if (r.exceptionDetails) return null
        return r?.result?.value === true
      })
    } catch {
      return null // occupata: si riprova
    }
  }
  for (;;) {
    const v = await fast()
    if (v === true) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
const setViewport = async (width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const settle = async () => {
  await page.send('Page.bringToFront').catch(() => undefined)
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await pageEval(`await Promise.race([new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) }), new Promise((resolve) => setTimeout(resolve, 1500))])`)
  await sleep(350)
}
const shot = async (name) => {
  await settle()
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
}
/** clic per SELETTORE (i «⋯» non hanno testo) — si RIPROVA entro il tetto dei click UI (5 s) */
const clickSel = async (sel, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    `).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}
/** clic su una VOCE del menu aperto (role=menuitem), per testo ESATTO */
const clickMenuItem = async (text) => pageEval(`
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const b = items.find((x) => x.textContent.trim() === ${JSON.stringify(text)})
  if (!b) return false
  b.click()
  return true
`).catch(() => false)
/** apre il menu della riga col «⋯»: il trigger Radix ascolta POINTERDOWN
 * (un .click() nudo non basta) — si RIPROVA entro il tetto dei click UI */
const openRowMenu = async (sel, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await pageEval(`
      const el = document.querySelector(${JSON.stringify(sel)})
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }))
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true }))
      el.click()
      return true
    `).catch(() => false)
    if (ok && await waitDom(`document.querySelectorAll('[role="menuitem"]').length > 0`, 2_000, 150)) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}
/** il tasto destro su una riga della barra (il menu è lo stesso del «⋯») */
const contextMenuOn = async (sel) => pageEval(`
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  return true
`).catch(() => false)
const closeMenus = async () => { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => undefined); await sleep(400) }
const sidebarText = async () => pageEval(`return document.querySelector('aside')?.textContent ?? ''`).catch(() => '')
const barHasRow = async (name) => waitDom(`[...document.querySelectorAll('aside nav button')].some((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))`, 5_000, 250)
/** aspetta che la riga SPARISCA dalla barra (il verso di barHasRow: l'archiviazione e l'eliminazione la tolgono) */
const barLacksRow = async (name, timeoutMs = 5_000) => waitDom(`![...document.querySelectorAll('aside nav button')].some((b) => b.textContent.trim().startsWith(${JSON.stringify(name)}))`, timeoutMs, 250)
/** la sezione «Archiviati» APERTA (idempotente: se è già aperta non la richiude) */
const openArchivedSection = async () => {
  await waitDom(`document.querySelector('[data-testid="archived-section"]') !== null`, 5_000)
  const isOpen = await pageEval(`return document.querySelector('[data-testid="archived-section"]')?.getAttribute('aria-expanded') === 'true'`).catch(() => false)
  if (!isOpen) await clickSel('[data-testid="archived-section"]')
  return waitDom(`document.querySelector('[data-testid="archived-section"]')?.getAttribute('aria-expanded') === 'true'`, 5_000)
}

try {
  // ---- setup: provider finto, guida chiusa, i bot e il team ----
  if (!(await waitDom(`typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile: ' + appLog.slice(-800))
  await setViewport(1280, 860)
  await rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpc(`onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(600)
    }
    if (await waitDom(`document.querySelector('aside')`, 15_000)) break
  }
  if (!(await waitDom(`document.querySelector('aside')`, 1_000))) throw new Error('la guida non si è chiusa: ' + appLog.slice(-600))

  const agents0 = await rpc(`listAgents()`)
  const mainId = agents0[0]?.id
  check('setup: c\'è il bot principale', !!mainId, `agents=${agents0.length}`)

  const mkBot = async (name, role) => {
    const a = await rpc(`createAgent(${JSON.stringify(name)}, ${JSON.stringify(role)})`)
    await rpc(`updateAgent(${JSON.stringify(a.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    return a
  }
  const competitoor = await mkBot('Competitoor', 'Prezzi dei concorrenti')
  const capo = await mkBot('Capo', 'Coordina')
  const treni = await mkBot('Treni', 'Orari')
  const group = await rpc(`groupCreate(${JSON.stringify('Weekend Torino')}, ${JSON.stringify([capo.id, treni.id])}, ${JSON.stringify(capo.id)}, ${JSON.stringify('Guida per un weekend a Torino')})`)
  // una routine ACCESA per Competitoor: archiviare la mette in pausa
  await rpc(`createRoutine(${JSON.stringify(competitoor.id)}, ${JSON.stringify('Ogni ora')}, ${JSON.stringify('p')}, ${JSON.stringify('0 * * * *')})`)
  await sleep(900)

  // =========== 1. il «⋯» su bot e team; il PRINCIPALE senza ===========
  const moreBot = `[data-testid="row-more"][data-agent="${competitoor.id}"]`
  const moreTeam = `[data-testid="row-more"][data-group="${group.id}"]`
  check('K2: il «⋯» c\'è sulla riga del bot (aria-label «Altre azioni»)', await waitDom(`document.querySelector(${JSON.stringify(moreBot)}) !== null`, 5_000) &&
    await pageEval(`return document.querySelector(${JSON.stringify(moreBot)})?.getAttribute('aria-label')`) === 'Altre azioni')
  check('K2: il «⋯» c\'è sulla riga del team', await waitDom(`document.querySelector(${JSON.stringify(moreTeam)}) !== null`, 5_000))
  check('K2: il PRINCIPALE non ha il «⋯»', await pageEval(`return document.querySelectorAll('[data-testid="row-more"]').length`) >= 2 &&
    !(await pageEval(`return document.querySelector(${JSON.stringify(`[data-testid="row-more"][data-agent="${mainId}"]`)}) !== null`)))

  // il menu del bottone: le tre voci
  const menuItems = async () => pageEval(`return [...document.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim())`).catch(() => [])
  check('K2: menu del «⋯» del bot: Rinomina · Archivia · Elimina', await openRowMenu(moreBot) && (await menuItems()).includes('Rinomina') && (await menuItems()).includes('Archivia') && (await menuItems()).includes('Elimina'), JSON.stringify(await menuItems()))
  await shot('1-menu-riga.png')
  // il tasto destro sul TEAM: lo stesso menu, con anche le impostazioni
  await closeMenus()
  check('K2: il tasto destro sulla riga del team apre il menu', await contextMenuOn(moreTeam) &&
    await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Apri impostazioni del team')`, 5_000))
  const teamItems = await menuItems()
  check('K2: il menu del team ha anche «Apri impostazioni del team»', teamItems.includes('Apri impostazioni del team') && teamItems.includes('Archivia'), JSON.stringify(teamItems))
  await closeMenus()

  // =========== 2. Rinomina (dal menu): campo in linea, Invio salva ===========
  await openRowMenu(moreBot)
  await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Rinomina')`, 5_000)
  await clickMenuItem('Rinomina')
  check('K2: «Rinomina» apre il campo in linea', await waitDom(`document.querySelector('[data-testid="bot-rename"]') !== null`, 5_000))
  await pageEval(`
    const inp = document.querySelector('[data-testid="bot-rename"]')
    if (!inp) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, 'Competitoor Due')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  `)
  check('K2: Invio salva — il nome nuovo è nella barra e negli agents', await barHasRow('Competitoor Due') &&
    await waitDom(`(await window.sandbot.listAgents()).some((a) => a.id === ${JSON.stringify(competitoor.id)} && a.name === 'Competitoor Due')`, 10_000))

  // =========== 3. Archivia il bot: barra, routine in pausa, dati, Ripristina ===========
  await openRowMenu(`[data-testid="row-more"][data-agent="${competitoor.id}"]`)
  await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Archivia')`, 5_000)
  await clickMenuItem('Archivia')
  const navTexts1 = () => pageEval(`return [...document.querySelectorAll('aside nav button')].map((b) => b.textContent.trim().slice(0, 30))`).catch(() => [])
  check('K3/K2: la riga esce dalla barra e arriva in «Archiviati» (conteggio)', await barLacksRow('Competitoor Due') &&
    await waitDom(`document.querySelector('[data-testid="archived-section"]')?.textContent.includes('Archiviati')`, 5_000) &&
    (await sidebarText()).includes('Archiviati'), `nav=${JSON.stringify(await navTexts1())}`)
  const archived = (await rpc(`listAgents()`)).find((a) => a.id === competitoor.id)
  check('K2: nessun dato perso — il bot resta con archivedAt, la routine in pausa', archived?.archivedAt != null &&
    (await rpc(`listRoutines(${JSON.stringify(competitoor.id)})`)).every((r) => r.enabled === 0), `archivedAt=${archived?.archivedAt ?? null}`)
  await shot('2-archiviati.png')
  // Ripristina: torna nella barra, le routine RESTANO in pausa
  await openArchivedSection()
  await waitDom(`document.querySelector('[data-testid="archived-restore-agent-${competitoor.id}"]') !== null`, 5_000)
  await clickSel(`[data-testid="archived-restore-agent-${competitoor.id}"]`)
  check('K2: «Ripristina» riporta il bot nella barra (routine ancora in pausa: decide l\'utente)', await barHasRow('Competitoor Due') &&
    (await rpc(`listAgents()`)).find((a) => a.id === competitoor.id)?.archivedAt == null &&
    (await rpc(`listRoutines(${JSON.stringify(competitoor.id)})`)).every((r) => r.enabled === 0))

  // =========== 4. Archivia il team: dorme, i membri restano bot singoli ===========
  await contextMenuOn(moreTeam)
  await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Archivia')`, 5_000)
  await clickMenuItem('Archivia')
  check('K2: il team archiviato esce dalla barra e i MEMBRI tornano bot singoli', await waitDom(`![...document.querySelectorAll('aside nav button')].some((b) => b.textContent.trim().startsWith('Weekend Torino'))`, 5_000) &&
    await barHasRow('Capo') && await barHasRow('Treni') &&
    (await rpc(`listGroups()`)).find((g) => g.id === group.id)?.archivedAt != null, `nav=${JSON.stringify(await navTexts1())}`)
  await openArchivedSection()
  await waitDom(`document.querySelector('[data-testid="archived-restore-group-${group.id}"]') !== null`, 5_000)
  await clickSel(`[data-testid="archived-restore-group-${group.id}"]`)
  check('K2: «Ripristina» riporta il team (e i membri rientrano nella sua riga)', await waitDom(`[...document.querySelectorAll('aside nav button')].some((b) => b.textContent.trim().startsWith('Weekend Torino'))`, 5_000) &&
    (await rpc(`listGroups()`)).find((g) => g.id === group.id)?.archivedAt == null, `nav=${JSON.stringify(await navTexts1())}`)

  // =========== 5. Elimina il bot: conferma, «Eliminato · Annulla» ===========
  await openRowMenu(`[data-testid="row-more"][data-agent="${competitoor.id}"]`)
  await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Elimina')`, 5_000)
  await clickMenuItem('Elimina')
  check('K2: la conferma dice cosa si cancella e cosa resta', await waitDom(`document.querySelector('[data-testid="delete-confirm"]') !== null`, 5_000) &&
    (await pageEval(`return document.querySelector('[data-testid="delete-confirm"]')?.textContent ?? ''`)).includes('I documenti nella Libreria restano'))
  await shot('3-elimina-conferma.png')
  await clickSel('[data-testid="delete-confirm-ok"]')
  check('K2: eliminato — la riga esce e l\'avviso «Eliminato · Annulla» c\'è', await barLacksRow('Competitoor Due') &&
    await waitDom(`document.querySelector('[data-testid="removed-undo"]') !== null`, 5_000) &&
    (await pageEval(`return document.querySelector('[data-testid="removed-undo"]')?.textContent ?? ''`)).includes('Annulla'))
  await shot('4-annulla.png')
  // Annulla DENTRO i 10 secondi: il bot torna
  await clickSel('[data-testid="removed-undo"] button')
  check('K2: «Annulla» (entro 10 s) RIPRISTINA il bot nella barra', await barHasRow('Competitoor Due') &&
    (await rpc(`listAgents()`)).find((a) => a.id === competitoor.id)?.deletedAt == null)

  // =========== 6. Elimina il team: la casella spenta, i bot restano ===========
  await contextMenuOn(moreTeam)
  await waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.textContent.trim() === 'Elimina')`, 5_000)
  await clickMenuItem('Elimina')
  check('K2: conferma del team — «I bot restano» e la casella SPENTA di default', await waitDom(`document.querySelector('[data-testid="delete-confirm"]') !== null`, 5_000) &&
    (await pageEval(`return document.querySelector('[data-testid="delete-confirm"]')?.textContent ?? ''`)).includes('I bot restano') &&
    (await pageEval(`return document.querySelector('[data-testid="delete-confirm-members"]')?.checked`)) === false)
  await clickSel('[data-testid="delete-confirm-ok"]')
  check('K2: il team eliminato lascia i BOT al loro posto', await barHasRow('Capo') && await barHasRow('Treni') &&
    (await rpc(`listAgents()`)).filter((a) => [capo.id, treni.id].includes(a.id)).every((a) => a.deletedAt == null))
  check('K2: il team eliminato sta in «Archiviati › Eliminati» (recuperabile 30 giorni)', await openArchivedSection() &&
    await waitDom(`document.querySelector('[data-testid="archived-restore-group-${group.id}"]') !== null`, 5_000) &&
    (await sidebarText()).includes('Eliminati'))

      // =========== 7. K3: il clic sul nome del team apre/chiude, il doppio clic rinomina ===========
  // (il team è stato eliminato al punto 6: si ripristina per provare K3)
  await clickSel(`[data-testid="archived-restore-group-${group.id}"]`)
  if (!(await waitDom(`[...document.querySelectorAll('aside nav button')].some((b) => b.textContent.trim().startsWith('Weekend Torino'))`, 5_000))) {
    check('K3: setup — il team torna in barra per le prove del clic', false, 'team non ripristinato')
  } else {
    // clic sul NOME di un team NON attivo: apre la chat E mostra i membri
    const teamNameBtn = await pageEval(`
      const rows = [...document.querySelectorAll('aside nav button')]
      const b = rows.find((x) => x.textContent.trim().startsWith('Weekend Torino'))
      if (!b) return null
      b.click()
      return true
    `)
    check('K3: clic sul nome del team non attivo → la chat del team E i membri', teamNameBtn === true &&
      await waitDom(`document.querySelector('form textarea') && (document.querySelector('form textarea').placeholder ?? '').includes('Scrivi al team')`, 5_000) &&
      await waitDom(`[...document.querySelectorAll('aside nav button')].some((b) => (b.getAttribute('aria-label') ?? '').includes('Chiudi i membri di Weekend Torino'))`, 5_000))
    // secondo clic SULLO STESSO NOME (ora attivo): i membri si chiudono
    const closed = await pageEval(`
      const rows = [...document.querySelectorAll('aside nav button')]
      const b = rows.find((x) => x.textContent.trim().startsWith('Weekend Torino'))
      if (!b) return null
      b.click()
      return true
    `)
    check('K3: secondo clic sul nome (team attivo) → i membri si CHIUDONO', closed === true &&
      await waitDom(`![...document.querySelectorAll('aside nav button')].some((b) => (b.getAttribute('aria-label') ?? '').includes('Chiudi i membri di Weekend Torino'))`, 5_000))
    // doppio clic: rinomina in linea (Invio salva, Esc annulla)
    const dbl = await pageEval(`
      const rows = [...document.querySelectorAll('aside nav button')]
      const b = rows.find((x) => x.textContent.trim().startsWith('Weekend Torino'))
      // il doppio clic arriva sullo SPAN del nome (il bersaglio vero del
      // puntatore), non sul bottone: da lì risale
      const span = b ? [...b.querySelectorAll('span')].find((x) => x.textContent.trim() === 'Weekend Torino') : null
      if (!span) return null
      span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
      return true
    `)
    check('K3: doppio clic sul nome → campo di rinomina in linea', dbl === true &&
      await waitDom(`document.querySelector('[data-testid="team-rename"]') !== null`, 5_000))
    await pageEval(`
      const inp = document.querySelector('[data-testid="team-rename"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, 'Weekend Torino Due')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    `)
    check('K3: Invio salva — il nome nuovo del team è nella barra', await waitDom(`(await window.sandbot.listGroups()).some((g) => g.id === ${group.id} && g.name === 'Weekend Torino Due')`, 10_000))
    // il doppio clic vale ANCHE per i bot: campo in linea sulla riga del bot
    const dblBot = await pageEval(`
      const rows = [...document.querySelectorAll('aside nav button')]
      const b = rows.find((x) => x.textContent.trim().startsWith('Competitoor Due'))
      const span = b ? [...b.querySelectorAll('span')].find((x) => x.textContent.trim() === 'Competitoor Due') : null
      if (!span) return null
      span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))
      return true
    `)
    check('K3: doppio clic sul nome di un BOT → campo di rinomina in linea', dblBot === true &&
      await waitDom(`document.querySelector('[data-testid="bot-rename"]') !== null`, 5_000))
  }
} catch (e) {
  check('la sonda è arrivata in fondo senza eccezioni', false, e instanceof Error ? e.message : String(e))
} finally {
  // ---- pulizia (come le altre sonde) ----
  // SIGTERM di grazia, poi SIGKILL: un'app che si trascina (menu aperti,
  // dialoghi) non deve tenere in vita la corsa
  // I2 (fase isolamento-locale): la FOTOGRAFIA dei llama-server discendenti dell'app e del daemon si scatta PRIMA di spegnerli
  const fotografiaLlama = fotografaLlamaServerDellaCorsa({ prefix: PREFIX, radice: DATA, home: null, pidApp: app.pid })
  stopApp()
  await sleep(1500)
  try { if (Number.isInteger(app.pid) && app.pid > 1) process.kill(app.pid, 'SIGKILL') } catch { /* già via */ }
  try {
    // anche gli HELPER (gpu/rete/crashpad) portano --user-data-dir della
    // corsa: senza chiudere loro, la cartella dati resta presa
    const apps = execSync(`pgrep -f "remote-debugging-port=${DEBUG_PORT}|user-data-dir=.*${PREFIX}-" || true`, { encoding: 'utf8' }).trim()
    for (const pidStr of apps.split('\n').filter(Boolean)) {
      const pid = Number(pidStr)
      if (Number.isInteger(pid) && pid !== process.pid && pid !== app.pid) {
        try { process.kill(pid, 'SIGKILL'); log('processo residuo chiuso:', pidStr) } catch { /* già via */ }
      }
    }
  } catch { /* pgrep vuoto */ }
  await stopProbeDaemons(PREFIX, { log }).catch((e) => log('stopProbeDaemons:', e.message))
  // I1 (fase isolamento-locale): il REGISTRO delle connessioni verso i servizi LLM locali veri del Mac
  // (lo scrive l'app in prova) si legge PRIMA che la cartella dati sparisca: una connessione = corsa ROSSA
  const tentativiLocali = leggiTentativiLocali(DATA)
  check('I1: 0 connessioni verso i servizi LLM locali veri (il registro è vuoto)', tentativiLocali.length === 0, messaggioTentativiLocali(tentativiLocali))
  await cleanupProbeRun({ pids: [app.pid], prefix: PREFIX, dirs: [DATA], log, capMs: 20_000 }).catch((e) => log('cleanupProbeRun:', e.message))
  await stopProbeDaemons(PREFIX, { log }).catch(() => undefined)
  await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
  let left = countProbeDirs(PREFIX, [DATA])
  if (left > 0) {
    await sleep(1500)
    await cleanupProbeRun({ pids: [], prefix: PREFIX, dirs: [], log, capMs: 10_000 }).catch(() => undefined)
    left = countProbeDirs(PREFIX, [DATA])
  }
  const leftDirs = left > 0 ? readdirSync(TMP_BASE).filter((d) => d.startsWith(PREFIX + '-')) : []
  check('pulizia: 0 cartelle sandbot-fase-team-bot-* rimaste', leftDirs.length === 0, `${leftDirs.length} cartelle: ${leftDirs.join(', ')}`)
  const daemons = findProbeDaemons(PREFIX)
  check('pulizia: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  // I2: si contano solo i llama-server della corsa (catena dei padri, oppure radice o HOME finta negli argomenti)
  const llamas = llamaServerDellaCorsa({ prefix: PREFIX, radice: DATA, home: null, fotografia: fotografiaLlama })
  check('pulizia: 0 llama-server della corsa rimasti vivi', llamas.length === 0, messaggioLlamaServer(llamas) || 'nessuno')
  await new Promise((r) => providerServer.close(r))
}

log(`CORSA r${run}: ${results.filter((r) => r.ok).length}/${results.length} controlli OK`)
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
