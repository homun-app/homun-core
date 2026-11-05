#!/usr/bin/env node
// Sonda Electron della fase SKILL (S1–S10): l'app VERA (build di sviluppo in
// out/) su cartella dati TEMPORANEA, tutto finto e SOLO su 127.0.0.1 —
//   • MIGRAZIONE: il DB seminato con DUE bot che hanno skill per bot
//     (una identica → uniti; una omonima diversa → -<slug>; una sola) — il
//     daemon la gira al primo avvio e la verifica si fa da RPC;
//   • REPO GIT LOCALE file:// con TRE skill: una valida con references/,
//     una con un link simbolico (mostrata spenta col motivo), una col nome
//     sbagliato (maiuscole) — mai github.com;
//   • PROVIDER FINTO (openai-compatible, SSE) che registra OGNI messaggio
//     ricevuto: il `/nome` del compositore si verifica su ciò che arriva al
//     modello;
//   • la CONTAMINAZIONE alla lettura di una skill importata si vede dal
//     blocco <dato_esterno> nel result del tool (decisione 3).
//
// Copre, con CATTURE in docs/catture/skill/ (chiaro e scuro, 1440 e 900):
//   la finestra (elenco, filtri), il dettaglio, la nuova skill, l'import con
//   anteprima e l'elenco `/` del compositore.
//
// A FINE SONDA si chiude OGNI daemon avviato (per ogni cartella usata si
// legge daemon.lock, si termina il pid, si CONTROLLA che sia sparito) e il
// pgrep finale non deve trovare nessun sandbot nelle cartelle della sonda
// (S10.2). Niente Docker, nessun push, mai il Portachiavi vero.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const SHOTS = join(ROOT, 'docs', 'catture', 'skill')
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

// ---- il repository git LOCALE con le tre skill (file:// SOLO col flag) ----
const REPO = mkdtempSync(TMP_BASE + 'sandbot-skill-repo-')
{
  mkdirSync(join(REPO, 'skills', 'stile-readme', 'references'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'stile-readme', 'SKILL.md'),
    '---\nname: stile-readme\ndescription: come sistemare un README del progetto\nlicense: MIT\n---\n# Regole del README\n\nTitolo breve, sezioni Obiettivi, Installazione, Uso.')
  writeFileSync(join(REPO, 'skills', 'stile-readme', 'references', 'esempio.md'), '# Esempio di sezione\nCosi\u0300 si scrive una sezione.')
  mkdirSync(join(REPO, 'skills', 'con-symlink', 'references'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'con-symlink', 'SKILL.md'), '---\nname: con-symlink\ndescription: con un link simbolico dentro\n---\nIstruzioni.')
  writeFileSync(join(REPO, 'skills', 'con-symlink', 'references', 'vero.md'), 'contenuto vero')
  try { symlinkSync('references/vero.md', join(REPO, 'skills', 'con-symlink', 'link.md')) } catch { /* piattaforma senza symlink */ }
  mkdirSync(join(REPO, 'skills', 'nome-scorretto'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'nome-scorretto', 'SKILL.md'), '---\nname: Nome Sbagliato\ndescription: il nome non rispetta lo standard\n---\nIstruzioni.')
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO })
}
const REPO_URL = `file://${REPO}`
log('repo di prova:', REPO_URL)

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

const launchApp = (userData, debugPort) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      // userData: la cartella dati del daemon (DB, skills) è <userData>/data
      SANDBOT_TEST_USER_DATA: userData,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(userData, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(userData, 'safestorage-finta.json'),
      // il clone file:// per l'import delle skill (SOLO 127.0.0.1/locale)
      SANDBOT_TEST_ALLOW_FILE_URLS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let appLog = ''
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  return { app, getLog: () => appLog, stop: () => { try { app.kill('SIGTERM') } catch { /* già via */ } } }
}

/** Il pid del daemon di QUESTA cartella dati (daemon.lock), se già scritto. */
const daemonPid = (dataDir) => {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, 'data', 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
/**
 * S10.2: la sonda chiude TUTTI i daemon che ha avviato — per ogni cartella
 * usata si legge daemon.lock, si termina il pid, si CONTROLLA che sia sparito
 * (SIGKILL se serve) e il pgrep finale non deve trovare nessun sandbot vivo
 * nelle cartelle della sonda.
 */
const stopDaemon = async (dataDir) => {
  const pid = daemonPid(dataDir)
  if (!pid) return true
  try { process.kill(pid, 'SIGTERM') } catch { /* già via */ }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return true }
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
  for (let i = 0; i < 15; i++) {
    try { process.kill(pid, 0); await sleep(200) } catch { return true }
  }
  return false
}
/** La verifica finale (S10.2): NESSUN daemon vivo nelle cartelle della sonda.
 *  Si guarda il PROCESSO daemon (--homun-daemon), non gli helper di Electron
 *  (gpu/network) che spariscono poco dopo e non aprono né possiedono dati. */
const assertNoDaemonLeft = async (prefix) => {
  const pgrepDaemon = () => {
    const out = spawnSync('/usr/bin/pgrep', ['-fl', 'sandbot'], { encoding: 'utf8' })
    return (out.stdout ?? '').split('\n').filter((line) => line.includes(prefix) && line.includes('--homun-daemon'))
  }
  // qualche secondo di grazia: il figlio daemon muore poco dopo il SIGTERM
  let alive = pgrepDaemon()
  for (let i = 0; i < 15 && alive.length > 0; i++) {
    await sleep(600)
    alive = pgrepDaemon()
  }
  return alive
}

// ---- CDP ----
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
async function connectPage(debugPort) {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      const target = list.find((t) => t.type === 'page')
      if (target) return await openCdp(target.webSocketDebuggerUrl)
    } catch { /* il debugger non è ancora su */ }
    await sleep(200)
  }
  throw new Error('nessuna pagina CDP')
}

async function run(debugPort) {
  const page = await connectPage(debugPort)
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
  const waitDom = async (exprTrue, timeoutMs = 30_000, step = 250) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await pageEval(`return !!(${exprTrue})`)) return true
      if (Date.now() > deadline) return false
      await sleep(step)
    }
  }
  const setWindowWidth = async (width, height = 900) => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
    await sleep(700)
  }
  const shot = (name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
    log('cattura', name)
  })
  return { page, pageEval, rpc, waitDom, setWindowWidth, shot }
}

/** Il clic VERO: pointerdown/click (i trigger Radix aprono su pointerdown). */
const pointerClick = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  if (!el) throw new Error('non trovato (pointerClick)')
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
  el.click()
  return 'cliccato'
`)
const clickText = (pageEval, text, selector = 'button', exact = false) => pageEval(`
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
  const want = ${JSON.stringify(text)}
  const el = els.find((x) => {
    const t = x.textContent.trim()
    return (${exact ? 't === want' : 't.includes(want)'}) && x.offsetParent !== null
  })
  if (!el) throw new Error('non trovato: ' + want)
  el.click()
  return 'cliccato: ' + want
`)
const setInput = (pageEval, selector, value, index = 0) => pageEval(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => x.offsetParent !== null)[${index}]
  if (!el) throw new Error('campo non trovato: ' + ${JSON.stringify(selector)})
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'scritto'
`)
const uiSend = (pageEval, text) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 150))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return 'inviato'
`)
const setDark = async (pageEval, dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(250)
}
const scrollIntoView = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  el?.scrollIntoView({ block: 'center' })
  return el ? 'scrolled' : 'null'
`)
/** Scrive nel compositore e PREME un tasto (frecce/Invio/Esc dell'elenco `/`). */
const composerKey = (pageEval, key) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))
  return 'tasto ' + ${JSON.stringify(key)}
`)

/** Prepara una corsa: provider finto, bot, modello, 1440. */
const setupBot = async (r) => {
  await r.rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  const agents0 = await r.rpc('listAgents()')
  const bot = agents0.find((a) => a.name === 'Alfa') ?? agents0[0]
  if (!bot) throw new Error('nessun bot (onboarding?)')
  await r.rpc(`updateAgent(${JSON.stringify(bot.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await r.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await r.page.send('Page.reload')
  await r.waitDom(`typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 30_000)
  await r.setWindowWidth(1440)
  return bot
}

const SKILLS_WINDOW = `(document.querySelector('[data-testid="skills-window"]') ?? document)`
const closeSkillsWindow = async (r) => {
  await clickText(r.pageEval, '✕', '[data-testid="skills-window"] button')
  await sleep(400)
}

// ============================ la corsa ============================
const TMP = mkdtempSync(TMP_BASE + 'sandbot-fase-skill-')
// userData = <TMP>/data (SANDBOT_TEST_USER_DATA); la cartella DATI del daemon
// (DB, skills, daemon.lock) è <userData>/data — LÌ va il semino della
// migrazione (due bot con le skill per bot)
const USER = join(TMP, 'data')
const DATA = join(USER, 'data')
mkdirSync(DATA, { recursive: true })
const usedDirs = [DATA]

// il DB seminato: DUE bot con le skill PER BOT della migrazione (S2.4)
const ALFA = 'agent_alfa'
const BETA = 'agent_beta'
{
  const skill = (name, body) => `---\nname: ${name}\ndescription: descrizione di ${name}\n---\n${body}`
  for (const [id, name] of [[ALFA, 'Alfa'], [BETA, 'Beta Bot']]) {
    mkdirSync(join(DATA, 'agents', id, 'skills'), { recursive: true })
  }
  // identica in entrambi → UNA sola, enabledFor unito
  mkdirSync(join(DATA, 'agents', ALFA, 'skills', 'riassunto-riunione'), { recursive: true })
  writeFileSync(join(DATA, 'agents', ALFA, 'skills', 'riassunto-riunione', 'SKILL.md'), skill('riassunto-riunione', 'Tre punti elenco e una riga Prossimi passi.'))
  mkdirSync(join(DATA, 'agents', BETA, 'skills', 'riassunto-riunione'), { recursive: true })
  writeFileSync(join(DATA, 'agents', BETA, 'skills', 'riassunto-riunione', 'SKILL.md'), skill('riassunto-riunione', 'Tre punti elenco e una riga Prossimi passi.'))
  // omonima DIVERSA → la seconda diventa triage-beta-bot
  mkdirSync(join(DATA, 'agents', ALFA, 'skills', 'triage'), { recursive: true })
  writeFileSync(join(DATA, 'agents', ALFA, 'skills', 'triage', 'SKILL.md'), skill('triage', 'Versione di Alfa.'))
  mkdirSync(join(DATA, 'agents', BETA, 'skills', 'triage'), { recursive: true })
  writeFileSync(join(DATA, 'agents', BETA, 'skills', 'triage', 'SKILL.md'), skill('triage', 'Versione di Beta, DIVERSA.'))
  // una sola
  mkdirSync(join(DATA, 'agents', ALFA, 'skills', 'solo-di-alfa'), { recursive: true })
  writeFileSync(join(DATA, 'agents', ALFA, 'skills', 'solo-di-alfa', 'SKILL.md'), skill('solo-di-alfa', 'Solo di Alfa.'))
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DATA, 'sandbot.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', provider_id TEXT, model TEXT, status TEXT DEFAULT 'offline', unread INTEGER DEFAULT 0, created_at INTEGER, created_by TEXT, section TEXT DEFAULT '', parent_id TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  const ins = db.prepare('INSERT INTO agents(id, name, description, status, unread, created_at, created_by, section, parent_id) VALUES (?,?,?,?,?,?,?,?,?)')
  ins.run(ALFA, 'Alfa', 'bot Alfa', 'idle', 0, 1000, null, '', null)
  ins.run(BETA, 'Beta Bot', 'bot Beta', 'idle', 0, 1001, null, '', null)
  db.close()
}

const main = launchApp(USER, 9361)
try {
  let r
  try {
    r = await run(9361)
  } catch (e) {
    throw new Error('pagina CDP non raggiunta: ' + (e?.message ?? e) + '\nlog app:\n' + main.getLog().slice(-1200))
  }
  if (!(await r.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
    throw new Error('window.sandbot non disponibile dopo 40s')
  }
  const bot = await setupBot(r)

  // ============ 1. la MIGRAZIONE (S2.4): due bot, nomi in conflitto ============
  const lib = await (async () => {
    for (let i = 0; i < 30; i++) {
      const l = await r.rpc('skillsLibrary()')
      if ((l.library ?? []).length > 0) return l
      await sleep(500)
    }
    return null
  })()
  check('migrazione: la libreria ha le skill dei due bot', Boolean(lib && lib.library.length >= 4), JSON.stringify(lib?.library.map((s) => s.name)))
  const byName = Object.fromEntries((lib?.library ?? []).map((s) => [s.name, s]))
  check('migrazione: la skill IDENTICA è UNA sola con enabledFor unito (entrambi i bot)',
    byName['riassunto-riunione'] && byName['riassunto-riunione'].enabledFor.includes(ALFA) && byName['riassunto-riunione'].enabledFor.includes(BETA),
    JSON.stringify(byName['riassunto-riunione']?.enabledFor))
  check('migrazione: la omonima DIVERSA è rinumerata <name>-<slug del bot>',
    Boolean(byName['triage']) && Boolean(byName['triage-beta-bot']),
    Object.keys(byName).join(', '))
  check('migrazione: source migrated e la skill sola è arrivata',
    byName['solo-di-alfa']?.source === 'migrated' && byName['triage']?.source === 'migrated')
  check('migrazione: le cartelle VECCHIE non ci sono più', !existsSync(join(DATA, 'agents', ALFA, 'skills', 'triage')))

  // ============ 2. la FINESTRA (S4): elenco, filtri, dettaglio, nuova, ============
  // ============ versioni, bot, rimozione (dalla barra, accanto ad App) ============
  check('finestra: si apre dalla voce della barra (accanto ad App)',
    await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="sidebar-skills"]')].find((b) => b.offsetParent !== null)`) === 'cliccato' &&
    await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 8000))
  await sleep(500)
  check('finestra: l\'elenco mostra il nome umanizzato e l\'origine',
    await r.waitDom(`${SKILLS_WINDOW}.textContent.includes('Riassunto riunione') && ${SKILLS_WINDOW}.textContent.includes('migrata')`, 6000))
  check('finestra: «Bot che la usano» in breve sulla riga (tutti e due)',
    (await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-row-"]')].find((x) => x.textContent.includes('Riassunto'))?.textContent.includes('2 bot')`)) === true)
  // i filtri
  await clickText(r.pageEval, 'Create dai bot', '[data-testid="skills-filters"] button', true)
  await sleep(300)
  const filBot = await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-row-"]')].map((x) => x.textContent).join(' | ')`)
  check('finestra: il filtro «Create dai bot» svuota l\'elenco (qui sono tutte migrate)', !filBot.includes('Riassunto'), filBot.slice(0, 80))
  await clickText(r.pageEval, 'Importate', '[data-testid="skills-filters"] button', true)
  await sleep(300)
  check('finestra: il filtro «Importate» è vuoto prima dell\'import', !(await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-row-"]')].length > 0`)))
  await clickText(r.pageEval, 'Tutte', '[data-testid="skills-filters"] button', true)
  await sleep(300)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await closeSkillsWindow(r)
    await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="sidebar-skills"]')].find((b) => b.offsetParent !== null)`)
    await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 5000)
    await sleep(400)
    await r.shot(`finestra-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)

  // il DETTAGLIO (modello ServerSheet)
  await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-row-"]')].find((x) => x.textContent.includes('Riassunto'))?.click() ?? false`)
  check('dettaglio: nome, descrizione, istruzioni e «Bot che la usano»',
    await r.waitDom(`!!document.querySelector('[data-testid="skill-editor"]') && ${SKILLS_WINDOW}.textContent.includes('Bot che la usano') && ${SKILLS_WINDOW}.textContent.includes('Tutti i bot')`, 6000))
  check('dettaglio: un interruttore per bot (Alfa e Beta Bot)',
    (await r.pageEval(`return ${SKILLS_WINDOW}.textContent.includes('Alfa') && ${SKILLS_WINDOW}.textContent.includes('Beta Bot')`)) === true)
  // MODIFICA: cambia la descrizione e salva → la versione precedente resta
  await setInput(r.pageEval, '[data-testid="skill-field-description"]', 'come riassumere una riunione in tre punti (modificata dalla sonda)')
  await clickText(r.pageEval, 'Salva', '[data-testid="skill-editor"] button', true)
  await sleep(700)
  await clickText(r.pageEval, 'Avanzate', '[data-testid="skill-editor"] button')
  await sleep(400)
  check('versioni: la modifica conserva la precedente (con origine tu)',
    await r.waitDom(`${SKILLS_WINDOW}.textContent.includes('Versioni precedenti') && [...document.querySelectorAll('[data-testid="skill-editor"] button')].some((b) => b.textContent.trim() === 'Ripristina')`, 6000))
  // RIPRISTINA: la descrizione torna quella di prima (e crea un'altra versione)
  await clickText(r.pageEval, 'Ripristina', '[data-testid="skill-editor"] button')
  await sleep(800)
  const descAfterRestore = await r.pageEval(`return document.querySelector('[data-testid="skill-field-description"]')?.value ?? ''`)
  check('versioni: il ripristino riporta la descrizione di prima', !descAfterRestore.includes('modificata dalla sonda'), descAfterRestore.slice(0, 60))
  // BOT CHE LA USANO: il SECONDO interruttore (il primo bot dopo «Tutti i
  // bot») spegne quel bot — la verifica vera la fa la RPC sull'enabledFor
  await r.pageEval(`
    const switches = [...document.querySelectorAll('[data-testid="skill-editor"] [role="switch"]')]
    if (switches.length < 2) throw new Error('interruttori attesi >= 2, trovati ' + switches.length)
    switches[1].click()
    return 'switch del primo bot cliccato'
  `)
  await sleep(700)
  const libAfterToggle = await r.rpc('skillsLibrary()')
  const rr = libAfterToggle.library.find((s) => s.name === 'riassunto-riunione')
  check('«Bot che la usano»: l\'interruttore cambia l\'enabledFor della skill', rr && !rr.enabledFor.includes('*') && rr.enabledFor.length >= 1, JSON.stringify(rr?.enabledFor))
  // per le prove successive del `/` la skill torna visibile a TUTTI
  await r.rpc(`skillsSetEnabledFor(${JSON.stringify('riassunto-riunione')}, ${JSON.stringify(['*'])})`)
  await sleep(300)
  await closeSkillsWindow(r)

  // NUOVA SKILL (S4.3): il nome si propone dalla descrizione; nasce per Tutti i bot
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="sidebar-skills"]')].find((b) => b.offsetParent !== null)`)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 5000)
  await clickText(r.pageEval, 'Nuova skill', 'button', true)
  check('nuova skill: l\'editor vuoto si apre',
    await r.waitDom(`!!document.querySelector('[data-testid="skill-editor-new"]')`, 5000))
  await setInput(r.pageEval, '[data-testid="skill-field-description"]', 'esporta il report settimanale in pdf')
  await sleep(400)
  const proposed = await r.pageEval(`return document.querySelector('[data-testid="skill-field-name"]')?.value ?? ''`)
  check('nuova skill: il nome si PROPONE dalla descrizione', proposed.includes('esporta') || proposed.includes('report'), proposed)
  await setInput(r.pageEval, '[data-testid="skill-field-body"]', '1. raccogli i dati della settimana\n2. scrivi il report\n3. esporta in pdf')
  await clickText(r.pageEval, 'Salva', '[data-testid="skill-editor-new"] button', true)
  await sleep(700)
  const libNew = await r.rpc('skillsLibrary()')
  const nuova = libNew.library.find((s) => s.description.includes('report settimanale'))
  check('nuova skill: salvata e abilitata per TUTTI i bot', Boolean(nuova && nuova.enabledFor.includes('*')), JSON.stringify(nuova?.enabledFor))
  check('nuova skill: la riga compare nell\'elenco', await r.waitDom(`${SKILLS_WINDOW}.textContent.includes('report settimanale')`, 4000))
  // RIMOZIONE (con conferma)
  await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-row-"]')].find((x) => x.textContent.includes('report settimanale'))?.click() ?? false`)
  await r.waitDom(`!!document.querySelector('[data-testid="skill-editor"]')`, 5000)
  await clickText(r.pageEval, 'Rimuovi', '[data-testid="skill-editor"] button', true)
  await sleep(300)
  check('rimozione: chiede conferma («Rimuovi davvero»)',
    await r.waitDom(`!!document.querySelector('[data-testid="skill-remove-confirm"]')`, 4000))
  await clickText(r.pageEval, 'Rimuovi davvero', '[data-testid="skill-remove-confirm"]', true)
  await sleep(700)
  const libDel = await r.rpc('skillsLibrary()')
  check('rimozione: la skill non c\'è più', !libDel.library.some((s) => s.description.includes('report settimanale')))
  await closeSkillsWindow(r)

  // ============ 3. l'IMPORT da GitHub (S6): anteprima, errori, aggiunta ============
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="sidebar-skills"]')].find((b) => b.offsetParent !== null)`)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 5000)
  // errore UMANO: indirizzo non GitHub
  await clickText(r.pageEval, 'Da GitHub', 'button', true)
  await waitDomOk(r, `!!document.querySelector('[data-testid="skills-github"]')`, 'import: il modulo «Da GitHub» si apre')
  await setInput(r.pageEval, '[data-testid="skills-github-url"]', 'https://gitlab.com/owner/repo')
  await clickText(r.pageEval, 'Anteprima', '[data-testid="skills-github"] button', true)
  check('import: indirizzo NON GitHub → errore umano (mai git grezzo)',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-github-error"]') && ${SKILLS_WINDOW}.textContent.includes('Non è un indirizzo GitHub')`, 8000))
  // il conflitto di nome: stile-readme GIA' in libreria → l'anteprima deve
  // proporre <name>-2 modificabile (mai una sovrascrittura silenziosa)
  await r.rpc(`skillsSave(${JSON.stringify({ name: 'stile-readme', description: 'già presente in libreria', body: 'istruzioni locali' })})`).catch((e) => log('skillsSave conflitto:', e?.message))
  await sleep(300)
  // l'anteprima dal repo locale
  await setInput(r.pageEval, '[data-testid="skills-github-url"]', REPO_URL)
  await clickText(r.pageEval, 'Anteprima', '[data-testid="skills-github"] button', true)
  check('import: l\'anteprima mostra repository e commit corto',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-github-repo"]') && ${SKILLS_WINDOW}.textContent.includes('@')`, 20_000))
  check('import: la riga fissa «Solo istruzioni: gli script inclusi non vengono eseguiti.»',
    (await r.pageEval(`return ${SKILLS_WINDOW}.textContent.includes('Solo istruzioni')`)) === true)
  check('import: la skill col NOME SBAGLIATO è spenta col motivo (in italiano)',
    await r.waitDom(`${SKILLS_WINDOW}.textContent.includes('nome-scorretto') && ${SKILLS_WINDOW}.textContent.includes('Nome non valido')`, 6000))
  const symlinkShown = await r.pageEval(`return ${SKILLS_WINDOW}.textContent.includes('con-symlink') && ${SKILLS_WINDOW}.textContent.includes('link simbolico')`)
  check('import: la skill col LINK SIMBOLICO è spenta col motivo', symlinkShown === true)
  check('import: la skill valida ha file count e licenza',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-github-item-stile-readme"]') && ${SKILLS_WINDOW}.textContent.includes('MIT')`, 6000))
  // la casella della skill valida è SPUNTATA di default: si verifica e basta
  const checkedDefault = await r.pageEval(`return document.querySelector('[data-testid="skills-github-item-stile-readme"] input[type="checkbox"]')?.checked === true`)
  check('import: la skill valida è spuntata di default', checkedDefault === true)
  check('import: nome già presente → propone <name>-2 modificabile (mai silenzioso)',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-github-rename-stile-readme"]')`, 5000))
  const renameVal = await r.pageEval(`return document.querySelector('[data-testid="skills-github-rename-stile-readme"]')?.value ?? ''`)
  check('import: il nome proposto è stile-readme-2', renameVal === 'stile-readme-2', renameVal)
  // catture dell'anteprima (prima di aggiungere)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-github-item-stile-readme"]')`)
    await sleep(300)
    await r.shot(`import-anteprima-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
  await clickText(r.pageEval, 'Aggiungi', '[data-testid="skills-github"] button', true)
  await sleep(1500)
  const importErr = await r.pageEval(`return document.querySelector('[data-testid="skills-github-error"]')?.textContent ?? ''`)
  if (importErr) log('errore di Aggiungi:', importErr)
  const libImp = await r.rpc('skillsLibrary()')
  log('libreria dopo Aggiungi:', JSON.stringify(libImp.library.map((x) => `${x.name}/${x.source}`)))
  const imported = libImp.library.find((s) => s.name === 'stile-readme-2')
  check('import: «Aggiungi» copia SOLO le scelte con source github e origin fissato',
    Boolean(imported && imported.source === 'github' && imported.origin && imported.origin.repo === REPO_URL && /^[0-9a-f]{40}$/.test(imported.origin.commit)),
    JSON.stringify(imported ? { s: imported.source, o: imported.origin?.repo?.slice(0, 40), c: imported.origin?.commit?.slice(0, 8) } : null))
  check('import: i file di supporto arrivano (references/esempio.md)', Boolean(imported && imported.files.includes('references/esempio.md')), JSON.stringify(imported?.files))
  await closeSkillsWindow(r)

  // ============ 4. il `/` nel COMPOSITORE (S7) — ciò che arriva al modello ============
  await r.pageEval(`document.querySelector('form textarea')?.focus(); return 'focus'`)
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, '/')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'scritto /'
  `)
  check('compositore: `/` all\'inizio apre l\'elenco delle skill del bot',
    await r.waitDom(`!!document.querySelector('[data-testid="slash-picker"]')`, 5000))
  // il filtro mentre scrivi
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, '/riassunto')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'filtrato'
  `)
  await sleep(300)
  check('compositore: l\'elenco si filtra mentre scrivi', await r.waitDom(`!!document.querySelector('[data-testid="slash-picker"]') && document.querySelector('[data-testid="slash-picker"]').textContent.includes('/riassunto-riunione')`, 4000))
  // catture dell'elenco `/`
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await sleep(300)
    await r.shot(`slash-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
  // Invio SCEGLIE: nel campo resta `/riassunto-riunione `
  await composerKey(r.pageEval, 'Enter')
  await sleep(300)
  const afterPick = await r.pageEval(`return document.querySelector('form textarea')?.value ?? ''`)
  check('compositore: Invio SCEGLIE — nel campo resta /riassunto-riunione ', afterPick.startsWith('/riassunto-riunione '), JSON.stringify(afterPick))
  // il resto del messaggio si APPENDE dopo `/riassunto-riunione ` (il campo
  // non si sovrascrive), poi invio: ciò che arriva al modello lo dice il
  // provider finto
  pushText('Fatto: tre punti e i prossimi passi.')
  const reqs0 = chatRequests.length
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ta.value + 'sulla riunione di oggi')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((res) => setTimeout(res, 150))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'inviato: ' + ta.value
  `)
  for (let i = 0; i < 40 && chatRequests.length <= reqs0; i++) await sleep(500)
  const lastReq = chatRequests.at(-1)
  const lastUser = (lastReq?.messages ?? []).filter((m) => m.role === 'user').at(-1)
  check('turno: al modello arriva «The user invoked the skill … follow its instructions»',
    Boolean(lastUser && String(lastUser.content).startsWith('The user invoked the skill "riassunto-riunione" for this message: follow its instructions.')),
    String(lastUser?.content ?? '').slice(0, 80))
  check('turno: le ISTRUZIONI della skill sono dentro il messaggio, poi --- e il resto',
    Boolean(lastUser && String(lastUser.content).includes('Prossimi passi') && String(lastUser.content).includes('---') && String(lastUser.content).includes('sulla riunione di oggi')))
  // la bolla compatta /nome
  check('trascrizione: la bolla mostra l\'etichetta compatta /riassunto-riunione',
    await r.waitDom(`[...document.querySelectorAll('span')].some((x) => x.textContent.trim() === '/riassunto-riunione')`, 8000))

  // ============ 5. la CONTAMINAZIONE alla lettura di una skill importata ============
  pushTool('skill', { name: 'stile-readme-2' })
  pushText('Ho letto la skill importata.')
  const reqs1 = chatRequests.length
  await uiSend(r.pageEval, 'carica la skill stile-readme-2 e dimmi cosa dice')
  for (let i = 0; i < 40 && chatRequests.length <= reqs1; i++) await sleep(500)
  const contaminated = await (async () => {
    for (let i = 0; i < 30; i++) {
      const entries = await r.rpc(`getEntries(${JSON.stringify(bot.id)})`)
      const hit = entries.find((e) => e.kind === 'tool-result' && String(e.content).includes('dato_esterno') && String(e.content).includes('stile-readme-2'))
      if (hit) return hit
      await sleep(500)
    }
    return null
  })()
  check('contaminazione: il result della skill IMPORTATA è un blocco <dato_esterno fonte="skill:…">',
    Boolean(contaminated && contaminated.meta?.webEvidence === true && /fonte="skill:stile-readme-2"/.test(String(contaminated?.content))),
    String(contaminated?.content ?? '').slice(0, 80))

  // ============ 6. l'EXPORT (S4) ============
  const saved = await r.rpc(`skillsSave(${JSON.stringify({ name: 'esporta-prova', description: 'skill temporanea per la prova di esportazione', body: 'istruzioni' })})`)
  check('export: la skill di prova si salva', saved?.ok === true)
  const exp = await r.rpc('skillsExport("esporta-prova")')
  const expOk = exp?.ok === true && exp.path.startsWith(join(homedir(), 'Downloads', 'Homun', 'skills', 'esporta-prova')) && existsSync(join(exp.path, 'SKILL.md'))
  check('export: la cartella finisce in ~/Downloads/Homun/skills/<name>/ con lo SKILL.md', expOk, exp?.path ?? JSON.stringify(exp))
  if (exp?.path) { try { rmSync(exp.path, { recursive: true, force: true }) } catch { /* già via */ } }
  await r.rpc('skillsDelete("esporta-prova")').catch(() => undefined)

  // catture finali: dettaglio e nuova skill nella matrice
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="sidebar-skills"]')].find((b) => b.offsetParent !== null)`)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 5000)
  await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-row-"]')].find((x) => x.textContent.includes('Riassunto'))?.click() ?? false`)
  await r.waitDom(`!!document.querySelector('[data-testid="skill-editor"]')`, 5000)
  await sleep(400)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skill-field-body"]')`)
    await sleep(300)
    await r.shot(`dettaglio-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
  await closeSkillsWindow(r)
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="sidebar-skills"]')].find((b) => b.offsetParent !== null)`)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 5000)
  await clickText(r.pageEval, 'Nuova skill', 'button', true)
  await r.waitDom(`!!document.querySelector('[data-testid="skill-editor-new"]')`, 5000)
  await setInput(r.pageEval, '[data-testid="skill-field-description"]', 'prepara il riepilogo mensile delle spese')
  await sleep(300)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await sleep(300)
    await r.shot(`nuova-skill-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  try { console.error(main.getLog().slice(-1200)) } catch { /* niente log */ }
} finally {
  main?.stop()
  await sleep(800)
  for (const dir of usedDirs) await stopDaemon(dir)
}

// ============================ chiusura (S10.2) ============================
const left = await assertNoDaemonLeft('sandbot-fase-skill')
if (left.length) {
  failures++
  console.error('[sonda] daemon rimasti vivi dopo la chiusura:\n' + left.join('\n'))
  for (const line of left) {
    const pid = Number(line.split(' ')[0])
    if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* già via */ } }
  }
} else {
  console.log('[sonda] nessun daemon vivo nelle cartelle della sonda (pgrep)')
}
try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
try { rmSync(REPO, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
// con fallimenti le cartelle RESTANO (diagnostica); verdi si puliscono
if (failures === 0 && !process.env.PROBE_KEEP) {
  for (const entry of readdirSync(TMP_BASE).filter((f) => f.startsWith('sandbot-fase-skill-') || f.startsWith('sandbot-skill-repo-'))) {
    try { rmSync(TMP_BASE + entry, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  }
} else {
  console.log('[sonda] cartelle di prova conservate (PROBE_KEEP o fallimenti)')
}
console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
console.log(`catture in ${SHOTS}`)
process.exit(failures ? 1 : 0)

/** waitDom con check() integrato. */
async function waitDomOk(r, expr, id, timeoutMs = 8000) {
  const ok = await r.waitDom(expr, timeoutMs)
  check(id, ok)
  return ok
}
