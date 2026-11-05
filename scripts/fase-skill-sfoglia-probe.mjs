#!/usr/bin/env node
// Sonda Electron della fase SKILL · SFOGLIA (B1–B5): l'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, tutto finto e SOLO su
// 127.0.0.1 —
//   • MARKETPLACE GIT LOCALE file:// con i CINQUE plugin della spec: (a) solo
//     skill (2), (b) skill + .mcp.json, (c) sorgente esterna, (d) solo skill +
//     commands/, (e) path che esce dalla cartella. Registrato in
//     connectors.marketplaces nella cartella dati temporanea, col marketplace
//     UFFICIALE TOGLTO: nessuna rete fuori da 127.0.0.1, mai github.com;
//   • PROVIDER FINTO (openai-compatible, SSE) che registra OGNI messaggio:
//     il turno con /<plugin>--<skill> si verifica su ciò che arriva al modello.
//
// Copre (B5):
//   1. «Skill» nel menu dell'account sotto «Collega app» (barra LARGA e
//      ROTAIA) e NON più come bottone nella barra;
//   2. Sfoglia mostra SOLO (a) e (d) («2 skill» e «1 skill»); (b), (c), (e) no;
//   3. la ricerca filtra;
//   4. anteprima di (d): skill e «non usate: commands»; Annulla BUTTA lo
//      staging (la cartella sparisce);
//   5. Aggiungi (a) per il SOLO bot Alfa: «Dai plugin» + «Aggiunto» in
//      Sfoglia; `/` di Alfa mostra <plugin>--<skill>, quello di Beta no;
//   6. un turno di Alfa con /<plugin>--<skill> arriva al provider col CORPO
//      della skill e la riga d'invocazione;
//   7. marketplace illeggibile (cartella rinominata) → «Alcuni pacchetti non
//      si sono caricati.» e «Riprova» funziona dopo il ripristino.
//
// Fase ritocchi (T1–T5): un solo campo di ricerca (il campo in alto filtra
// ANCHE i pacchetti; «Nessuna skill trovata» al posto dell'invito lungo),
// il contenuto della finestra è un @container (toggle e righe ADESSO
// affiancati, ±8 px sul top), l'anteprima col displayName della griglia e
// lo slug nella riga piccola, «‹ Indietro» in alto (UN solo «Annulla»,
// entrambi scartano lo staging) e il focus d'apertura sul campo di ricerca
// (niente anello su «Nuova skill»).
//
// Catture in docs/catture/skill/: sfoglia-* e menu-skill-* (1440 e 900,
// chiaro e scuro). A FINE SONDA si chiude OGNI daemon avviato (dall'AMBIENTE,
// helper probe-daemons) e le cartelle temporanee si cancellano SOLO DOPO.
// Niente Docker, nessun push, mai il Portachiavi vero.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

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

// ---- il marketplace git LOCALE con i cinque plugin della spec (file:// SOLO col flag) ----
const REPO = mkdtempSync(TMP_BASE + 'sandbot-sfoglia-mp-')
{
  const mk = (p) => { mkdirSync(join(REPO, p), { recursive: true }); return join(REPO, p) }
  const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nISTRUZIONI di ${name}: primo passo, secondo passo.`
  writeFileSync(join(mk('.claude-plugin'), 'marketplace.json'), JSON.stringify({
    name: 'mp-di-prova',
    owner: 'tester',
    plugins: [
      { name: 'due-skill', description: 'Due skill per ordinare le idee', source: './plugins/due-skill' },
      { name: 'con-connettore', description: 'Una skill e un server', source: './plugins/con-connettore' },
      { name: 'esterno', description: 'Vive su GitHub', source: { source: 'github', repo: 'owner/esterno' } },
      { name: 'con-comandi', description: 'Una skill con comandi non usati', source: './plugins/con-comandi' },
      { name: 'fuori', description: 'Dichiara un path che esce', source: './plugins/fuori' }
    ]
  }))
  // (a) solo skill, 2 skill
  mkdirSync(join(REPO, 'plugins', 'due-skill', '.claude-plugin'), { recursive: true })
  writeFileSync(join(REPO, 'plugins', 'due-skill', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'due-skill' }))
  writeFileSync(join(mk('plugins/due-skill/skills/ordina'), 'SKILL.md'), skillMd('ordina', 'come ordinare le idee'))
  writeFileSync(join(mk('plugins/due-skill/skills/riordina'), 'SKILL.md'), skillMd('riordina', 'come riordinare le idee'))
  // (b) skill + .mcp.json → CONNETTORE
  mkdirSync(join(REPO, 'plugins', 'con-connettore', '.claude-plugin'), { recursive: true })
  writeFileSync(join(REPO, 'plugins', 'con-connettore', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'con-connettore' }))
  writeFileSync(join(mk('plugins/con-connettore/skills/collega'), 'SKILL.md'), skillMd('collega', 'come collegare'))
  writeFileSync(join(REPO, 'plugins', 'con-connettore', '.mcp.json'), JSON.stringify({ mcpServers: { servizio: { url: 'https://servizio.example/mcp' } } }))
  // (c) sorgente esterna (github) — nel marketplace.json sopra
  // (d) solo skill + commands/
  mkdirSync(join(REPO, 'plugins', 'con-comandi', '.claude-plugin'), { recursive: true })
  writeFileSync(join(REPO, 'plugins', 'con-comandi', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'con-comandi' }))
  writeFileSync(join(mk('plugins/con-comandi/skills/esegui'), 'SKILL.md'), skillMd('esegui', 'come eseguire'))
  writeFileSync(join(mk('plugins/con-comandi/commands'), 'pippo.md'), '# comando pippo')
  // (e) manifest che dichiara una skill FUORI dalla cartella
  mkdirSync(join(REPO, 'plugins', 'fuori', '.claude-plugin'), { recursive: true })
  writeFileSync(join(REPO, 'plugins', 'fuori', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fuori', skills: ['../altrove'] }))
  writeFileSync(join(mk('plugins/fuori/skills/dentro'), 'SKILL.md'), skillMd('dentro', 'la skill di fuori'))
  writeFileSync(join(mk('altrove'), 'SKILL.md'), skillMd('altrove', 'il bersaglio del path che esce'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO })
}
const REPO_URL = `file://${REPO}`
log('marketplace di prova:', REPO_URL)

// ---- il provider FINTO (openai-compatible, SSE su 127.0.0.1) ----
const script = []
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
      chunk({}, 'stop')
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
// SOLO così: env pulita + cartella dati temporanea + keychain/safestorage FINTI
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const launchApp = (userData, debugPort) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: userData,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(userData, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(userData, 'safestorage-finta.json'),
      // il clone file:// del marketplace di prova (SOLO locale, mai github.com)
      SANDBOT_TEST_ALLOW_FILE_URLS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let appLog = ''
  app.stdout.on('data', (d) => { appLog += d.toString() })
  app.stderr.on('data', (d) => { appLog += d.toString() })
  return { app, getLog: () => appLog, stop: () => { try { app.kill('SIGTERM') } catch { /* già via */ } } }
}

const daemonPid = (dataDir) => {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, 'daemon.lock'), 'utf8'))
    return Number.isInteger(v.pid) && v.pid > 1 && v.pid !== process.pid ? v.pid : null
  } catch { return null }
}
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
const setDark = async (pageEval, dark) => {
  await pageEval(`document.documentElement.classList.${dark ? 'add' : 'remove'}('dark')`)
  await sleep(250)
}
const scrollIntoView = (pageEval, selectorExpr) => pageEval(`
  const el = ${selectorExpr}
  el?.scrollIntoView({ block: 'center' })
  return el ? 'scrolled' : 'null'
`)
/** Le cartelle di staging dei plugin (sandbot-plugin-*): il daemon senza
 *  TMPDIR nell'env usa /tmp, i test la base indicata — si guardano ENTRAMBE
 *  (con prefisso della base, così il confronto resta per nome). */
const stagingDirs = () => {
  const out = []
  for (const base of [TMP_BASE, '/tmp/']) {
    try { for (const f of readdirSync(base)) if (f.startsWith('sandbot-plugin-')) out.push(base + f) } catch { /* base illeggibile */ }
  }
  return out
}
/** Le cartelle di staging NUOVE da un certo elenco (residui di corse passate a parte). */
const nuoveStaging = (prima) => stagingDirs().filter((d) => !prima.includes(d))

const SKILLS_WINDOW = `(document.querySelector('[data-testid="skills-window"]') ?? document)`
/** B1: la finestra si apre dal MENU dell'account (il bottone della barra non c'è più). */
const openSkillsFromMenu = async (r) => {
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
  await sleep(250)
  await clickText(r.pageEval, 'Skill', '[data-testid="menu-skills"]', true)
  await sleep(250)
}
/** Chiude il menu Radix: un click su body NON basta, serve un tasto Escape. */
const chiudiMenu = async (r) => {
  await r.pageEval(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return 'escape'
  `)
  await sleep(250)
}
/** L'ordine delle voci del menu account aperto (testi degli item Radix). */
const menuItems = (pageEval) => pageEval(`
  const items = [...document.querySelectorAll('[role="menuitem"]')].filter((x) => x.offsetParent !== null)
  return items.map((x) => x.textContent.trim())
`)

// ============================ la corsa ============================
const TMP = mkdtempSync(TMP_BASE + 'sandbot-fase-sfoglia-')
const USER = join(TMP, 'data')
const DATA = join(USER, 'data')
mkdirSync(DATA, { recursive: true })
const usedDirs = [DATA]

// il DB seminato: DUE bot (Alfa e Beta) e il marketplace LOCALE al posto di
// quello ufficiale (il default di connectors.marketplaces è sovrascritto dal
// setting: NESSUNA rete verso github.com)
const ALFA = 'agent_alfa'
const BETA = 'agent_beta'
{
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DATA, 'sandbot.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', provider_id TEXT, model TEXT, status TEXT DEFAULT 'offline', unread INTEGER DEFAULT 0, created_at INTEGER, created_by TEXT, section TEXT DEFAULT '', parent_id TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  const ins = db.prepare('INSERT INTO agents(id, name, description, status, unread, created_at, created_by, section, parent_id) VALUES (?,?,?,?,?,?,?,?,?)')
  ins.run(ALFA, 'Alfa', 'bot Alfa', 'idle', 0, 1000, null, '', null)
  ins.run(BETA, 'Beta Bot', 'bot Beta', 'idle', 0, 1001, null, '', null)
  const st = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  // B5: il marketplace di prova registrato e quello UFFICIALE tolto
  st.run('connectors.marketplaces', JSON.stringify([{ name: 'mp-di-prova', source: REPO_URL, kind: 'git', official: false, addedAt: 1 }]))
  db.close()
}

const main = launchApp(USER, 9371)
try {
  let r
  try {
    r = await run(9371)
  } catch (e) {
    throw new Error('pagina CDP non raggiunta: ' + (e?.message ?? e) + '\nlog app:\n' + main.getLog().slice(-1200))
  }
  if (!(await r.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
    throw new Error('window.sandbot non disponibile dopo 40s')
  }
  // provider finto + modello per i due bot
  await r.rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  await r.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  const agents0 = await r.rpc('listAgents()')
  const alfa = agents0.find((a) => a.name === 'Alfa')
  const beta = agents0.find((a) => a.name === 'Beta Bot')
  if (!alfa || !beta) throw new Error('i due bot non ci sono (onboarding?)')
  await r.rpc(`updateAgent(${JSON.stringify(alfa.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await r.rpc(`updateAgent(${JSON.stringify(beta.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
  await r.page.send('Page.reload')
  await r.waitDom(`typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 30_000)
  await r.setWindowWidth(1440)

  // ============ 1. «Skill» nel MENU sotto «Collega app» (B1) ============
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
  await sleep(400)
  const menuLarga = await menuItems(r.pageEval)
  check('menu (barra larga): «Skill» sta sotto «Collega app» e prima di «Impostazioni»',
    menuLarga.indexOf('Collega app') >= 0 && menuLarga.indexOf('Skill') === menuLarga.indexOf('Collega app') + 1 && menuLarga.indexOf('Impostazioni') > menuLarga.indexOf('Skill'),
    JSON.stringify(menuLarga))
  await chiudiMenu(r)
  await sleep(300)
  // catture del menu (barra larga): il menu dev'essere APERTO nello scatto
  // (Radix apre su pointerdown: lo si aspetta APERTO prima di scattare)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
    await r.waitDom(`[...document.querySelectorAll('[role="menuitem"]')].some((x) => x.offsetParent !== null && x.textContent.trim() === 'Skill')`, 6000)
    await sleep(250)
    await r.shot(`menu-skill-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
    await chiudiMenu(r)
    await sleep(250)
  }
  // la ROTAIA: sotto i 1000 px la barra diventa stretta da sola
  await r.setWindowWidth(920)
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
  await sleep(400)
  const menuRotaia = await menuItems(r.pageEval)
  check('menu (ROTAIA): «Skill» sta sotto «Collega app» e prima di «Impostazioni»',
    menuRotaia.indexOf('Collega app') >= 0 && menuRotaia.indexOf('Skill') === menuRotaia.indexOf('Collega app') + 1 && menuRotaia.indexOf('Impostazioni') > menuRotaia.indexOf('Skill'),
    JSON.stringify(menuRotaia))
  await chiudiMenu(r)
  await sleep(300)
  check('barra: il bottone «Skill» NON c\'è più (né largo né rotaia)',
    await r.pageEval(`return !document.querySelector('[data-testid="sidebar-skills"]')`))
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)

  // ============ 2. SFOGLIA mostra SOLO (a) e (d) (B4/B2) ============
  await openSkillsFromMenu(r)
  if (!(await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 8000))) throw new Error('la finestra Skill non si apre dal menu')
  // ---- ritocchi T5/T2/T1: come si presenta la finestra ALL'APERTURA ----
  // T5: il focus va al campo di ricerca (che non ha anello); «Nuova skill»
  // non focalizzato → niente anello arancione/chiaro nelle catture
  await r.waitDom(`document.activeElement === document.querySelector('[data-testid="skills-search"]')`, 3000)
  const focusApertura = await r.pageEval(`
    const search = document.querySelector('[data-testid="skills-search"]')
    const nuova = document.querySelector('[data-testid="skills-new"]')
    return {
      focusSearch: document.activeElement === search,
      nuovaFocusVisible: nuova ? nuova.matches(':focus-visible') : null,
      nuovaOutline: nuova ? getComputedStyle(nuova).outlineStyle : null
    }
  `)
  check('apertura (T5): il focus va al campo di ricerca, «Nuova skill» senza anello',
    focusApertura.focusSearch === true && focusApertura.nuovaFocusVisible === false,
    JSON.stringify(focusApertura))
  // T2: il contenuto della finestra è un @container (le righe SettingsRow
  // mettono il controllo a destra, come nel dialogo Impostazioni)
  check('finestra (T2): il contenuto è un @container',
    await r.pageEval(`const c = document.querySelector('[data-testid="skills-content"]'); return !!c && c.classList.contains('@container')`))
  // T1: UN solo campo «Cerca skill» (quello in alto), nessuno dentro Sfoglia
  check('sfoglia (T1): un solo campo di ricerca, NESSUNO dentro la sezione',
    await r.pageEval(`return document.querySelectorAll('[data-testid="skills-window"] input').length === 1 && !!document.querySelector('[data-testid="skills-search"]') && !document.querySelector('[data-testid="skills-browse-search"]')`))
  // T1: qui la libreria è DAVVERO vuota e non c'è ricerca → l'invito lungo
  check('elenco (T1): libreria davvero vuota senza ricerca → l\'invito lungo',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-empty"]') && !document.querySelector('[data-testid="skills-empty-filtered"]')`, 6000))
  const browseOk = await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-entry-due-skill"]') && !!document.querySelector('[data-testid="skills-browse-entry-con-comandi"]')`, 30_000)
  check('sfoglia: mostra (a) due-skill e (d) con-comandi', browseOk)
  const entriesText = await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-browse-entry-"]')].map((x) => x.dataset.testid + ' :: ' + x.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`)
  check('sfoglia: (b) con-connettore, (c) esterno e (e) fuori NON ci sono',
    !entriesText.includes('con-connettore') && !entriesText.includes('esterno') && !entriesText.includes('fuori'),
    entriesText.slice(0, 160))
  check('sfoglia: «2 skill» su (a) e «1 skill» su (d)',
    entriesText.includes('2 skill') && entriesText.includes('1 skill'))
  // gli scarti contati dal catalogo (per il REPORT): esterna, connettore, path che esce
  const browse0 = await r.rpc('skillsBrowse()')
  log('scarti del catalogo:', JSON.stringify(browse0.skipped))
  check('sfoglia: gli scarti hanno il motivo (esterna, connettore, path che esce)',
    browse0.skipped.some((s) => s.plugin === 'esterno' && /external source/.test(s.reason)) &&
    browse0.skipped.some((s) => s.plugin === 'con-connettore' && /MCP/.test(s.reason)) &&
    browse0.skipped.some((s) => s.plugin === 'fuori' && /leave/i.test(s.reason)))

  // ============ 3. la ricerca filtra (T1: dal campo IN ALTO, insieme ============
  // ============ alle skill dei plugin e ai pacchetti di Sfoglia)    ============
  await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-search"]')`)
  await setInput(r.pageEval, '[data-testid="skills-search"]', 'comandi')
  await sleep(400)
  const filtered = await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-browse-entry-"]')].filter((x) => x.offsetParent !== null).map((x) => x.dataset.testid).join(',')`)
  check('sfoglia (T1): la ricerca IN ALTO filtra i pacchetti (solo con-comandi per «comandi»)', filtered === 'skills-browse-entry-con-comandi', filtered)
  check('elenco (T1): ricerca senza skill → «Nessuna skill trovata», NON l\'invito lungo',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-empty-filtered"]') && !document.querySelector('[data-testid="skills-empty"]')`, 4000))
  await setInput(r.pageEval, '[data-testid="skills-search"]', 'zzz-non-esiste')
  await sleep(400)
  check('sfoglia: nessun risultato → «Nessun pacchetto trovato»',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-empty"]')`, 4000))
  check('elenco (T1): ricerca totalmente vuota → resta il messaggio corto',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-empty-filtered"]') && !document.querySelector('[data-testid="skills-empty"]')`, 4000))
  await setInput(r.pageEval, '[data-testid="skills-search"]', '')
  await sleep(400)
  check('elenco (T1): senza ricerca e libreria VUOTA torna l\'invito lungo',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-empty"]') && !document.querySelector('[data-testid="skills-empty-filtered"]')`, 4000))

  // catture della sezione (dopo le prove di ricerca, elenco pieno)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse"]')`)
    await sleep(300)
    await r.shot(`sfoglia-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)

  // ============ 4. l'ANTEPRIMA di (d): skill, «non usate: commands», ============
  // ============ Annulla BUTTA lo staging ============
  const stagingPrimaList = stagingDirs()
  await pointerClick(r.pageEval, `document.querySelector('[data-testid="skills-browse-entry-con-comandi"]')`)
  const previewOk = await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-preview"]')`, 30_000)
  check('anteprima (d): si apre e mostra sha12 e marketplace', previewOk &&
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-sha"]') && ${SKILLS_WINDOW}.textContent.includes('mp-di-prova')`, 8000))
  check('anteprima (d): la skill con la descrizione',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-skill-con-comandi--esegui"]') && ${SKILLS_WINDOW}.textContent.includes('come eseguire')`, 6000))
  check('anteprima (d): «non usate: commands»',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-ignored"]') && ${SKILLS_WINDOW}.textContent.includes('non usate: commands')`, 6000))
  // il toggle «Tutti i bot» acceso → i bot SPENTI e DISATTIVATI (B4)
  const togglesStato = await r.pageEval(`
    const sw = [...document.querySelectorAll('[data-testid="skills-browse-preview"] [role="switch"]')]
    return { n: sw.length, tutti: sw[0]?.getAttribute('aria-checked'), botSpenti: sw.slice(1).every((x) => x.getAttribute('aria-checked') === 'false'), botDisattivati: sw.slice(1).every((x) => x.disabled) }
  `)
  check('anteprima: «Tutti i bot» acceso → i toggle dei bot SPENTI e DISATTIVATI',
    togglesStato.n >= 3 && togglesStato.tutti === 'true' && togglesStato.botSpenti && togglesStato.botDisattivati,
    JSON.stringify(togglesStato))
  // ---- ritocchi T2/T3/T4, verificati SUL DOM dell'anteprima ----
  // T2: il toggle di «Tutti i bot» sta SULLA STESSA RIGA del nome (prima il
  // controllo finiva sotto: righe altissime) — si confronta il top, ±8 px
  const rowSame = await r.pageEval(`
    const sw = document.querySelector('[data-testid="skills-browse-preview"] [role="switch"]')
    const title = sw.parentElement.previousElementSibling
    return { diff: Math.abs(sw.getBoundingClientRect().top - title.getBoundingClientRect().top) }
  `)
  check('anteprima (T2): «Tutti i bot» col toggle SULLA STESSA RIGA del nome (±8 px)', rowSame.diff <= 8, `Δtop = ${rowSame.diff.toFixed(1)} px`)
  // T4: in alto «‹ Indietro», UN solo «Annulla» (in basso, accanto ad «Aggiungi»)
  const btnCounts = await r.pageEval(`
    const vis = [...document.querySelectorAll('[data-testid="skills-browse-preview"] button')].filter((b) => b.offsetParent !== null)
    return {
      back: vis.some((b) => b.textContent.trim() === 'Indietro'),
      annulla: vis.filter((b) => b.textContent.trim() === 'Annulla').length,
      aggiungi: vis.filter((b) => b.textContent.trim() === 'Aggiungi').length
    }
  `)
  check('anteprima (T4): in alto «‹ Indietro», UN solo «Annulla» (in basso, con «Aggiungi»)',
    btnCounts.back && btnCounts.annulla === 1 && btnCounts.aggiungi === 1, JSON.stringify(btnCounts))
  // T3: il titolo è lo STESSO nome della griglia (displayName), lo slug
  // scende nella riga piccola accanto a marketplace e sha12
  const head = await r.pageEval(`
    const title = document.querySelector('[data-testid="skills-browse-preview-title"]')
    const sha = document.querySelector('[data-testid="skills-browse-sha"]')
    return { title: title?.textContent.trim() ?? '', sotto: (title?.nextElementSibling?.textContent ?? '').replace(/\\s+/g, ' ').trim(), sha: sha?.textContent ?? '' }
  `)
  check('anteprima (T3): il titolo è il displayName della griglia («Con Comandi»)', head.title === 'Con Comandi', head.title)
  check('anteprima (T3): lo slug nella riga piccola, con marketplace e sha12',
    head.sotto === `con-comandi · mp-di-prova · ${head.sha}`, head.sotto)
  // lo staging È VIVO (cartelle sandbot-plugin- NUOVE) e Annulla lo BUTTA
  await sleep(500)
  const stagingConPreview = nuoveStaging(stagingPrimaList)
  check('anteprima: lo staging è VIVO finché non si decide', stagingConPreview.length > 0, `${stagingPrimaList.length} → ${stagingPrimaList.length + stagingConPreview.length}: ${stagingConPreview.join(', ')}`)
  // catture dell'anteprima
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse-ignored"]')`)
    await sleep(300)
    await r.shot(`sfoglia-anteprima-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
  // T4: «‹ Indietro» in alto FA LA STESSA COSA dell'«Annulla»: scarta lo
  // staging e torna all'elenco (come il «‹ Indietro» del dettaglio)
  await clickText(r.pageEval, 'Indietro', '[data-testid="skills-browse-preview"] button', true)
  await sleep(800)
  const stagingDopoIndietro = nuoveStaging(stagingPrimaList)
  check('anteprima (T4): «‹ Indietro» SCARTA lo staging e torna all\'elenco',
    stagingDopoIndietro.length === 0 && await r.waitDom(`!document.querySelector('[data-testid="skills-browse-preview"]') && !!document.querySelector('[data-testid="skills-browse-entry-due-skill"]')`, 5000),
    `nuove rimaste: ${stagingDopoIndietro.join(', ') || 'nessuna'}`)
  // ...e l'«Annulla» rimasto in basso butta pure lui lo staging
  for (let attempt = 0; attempt < 3 && !(await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-preview"]')`, 1500)); attempt++) {
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse-entry-con-comandi"]')`)
    await pointerClick(r.pageEval, `document.querySelector('[data-testid="skills-browse-entry-con-comandi"]')`)
  }
  if (!(await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-preview"]')`, 10_000))) {
    throw new Error('la riapertura dell\'anteprima di con-comandi non riesce (3 tentativi)')
  }
  // l'«Annulla» scarta solo se l'anteprima è CARICA (altrimenti chiude e basta)
  if (!(await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-sha"]')`, 30_000))) {
    throw new Error('la riapertura dell\'anteprima di con-comandi non carica lo staging')
  }
  await sleep(500)
  await clickText(r.pageEval, 'Annulla', '[data-testid="skills-browse-preview"] button', true)
  await sleep(800)
  const stagingDopoAnnulla = nuoveStaging(stagingPrimaList)
  check('anteprima: l\'«Annulla» in basso BUTTA lo staging (la cartella sparisce)', stagingDopoAnnulla.length === 0, `nuove rimaste: ${stagingDopoAnnulla.join(', ') || 'nessuna'}`)
  check('anteprima: chiusa, si torna all\'elenco', await r.waitDom(`!document.querySelector('[data-testid="skills-browse-preview"]') && !!document.querySelector('[data-testid="skills-browse-entry-due-skill"]')`, 5000))

  // ============ 5. AGGIUNGI (a) per il SOLO bot Alfa (B3) ============
  // (il click può arrivare durante un re-render: si riprova un paio di volte)
  for (let attempt = 0; attempt < 3 && !(await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-preview"]')`, 1500)); attempt++) {
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse-entry-due-skill"]')`)
    await pointerClick(r.pageEval, `document.querySelector('[data-testid="skills-browse-entry-due-skill"]')`)
  }
  if (!(await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-preview"]')`, 10_000))) {
    throw new Error('l\'anteprima di due-skill non si apre (3 tentativi)')
  }
  // l'anteprima carica in modo asincrono (staging del pacchetto): il contenitore
  // c'è PRIMA dei toggle — si aspetta «Tutti i bot» + almeno un bot
  if (!(await r.waitDom(`document.querySelectorAll('[data-testid="skills-browse-preview"] [role="switch"]').length >= 2`, 20_000))) {
    throw new Error('l\'anteprima di due-skill non mostra i toggle «Bot che la usano»')
  }
  await sleep(300)
  // «Tutti i bot» OFF, poi ACCENDO solo Alfa (il primo toggle dei bot)
  await r.pageEval(`
    const sw = [...document.querySelectorAll('[data-testid="skills-browse-preview"] [role="switch"]')]
    sw[0].click()
    return 'tutti i bot spento'
  `)
  await sleep(250)
  const botLabels = await r.pageEval(`
    return [...document.querySelectorAll('[data-testid="skills-browse-preview"] [role="switch"]')].slice(1).map((x) => x.getAttribute('aria-label'))
  `)
  const idxAlfa = botLabels.findIndex((l) => l === 'Alfa')
  await r.pageEval(`
    const sw = [...document.querySelectorAll('[data-testid="skills-browse-preview"] [role="switch"]')]
    sw[${idxAlfa + 1}].click()
    return 'Alfa acceso'
  `)
  await sleep(250)
  await clickText(r.pageEval, 'Aggiungi', '[data-testid="skills-browse-add"]', true)
  const installato = await r.waitDom(`!document.querySelector('[data-testid="skills-browse-preview"]')`, 30_000)
  check('aggiungi: l\'anteprima si chiude (installato senza card in chat)', installato)
  const lib1 = await r.rpc('skillsLibrary()')
  check('aggiungi: il pacchetto compare in «Dai plugin» (finestra Skill)',
    (lib1.plugins ?? []).some((g) => g.plugin === 'due-skill' && g.skills.some((s) => s.name === 'due-skill--ordina')),
    JSON.stringify((lib1.plugins ?? []).map((g) => g.plugin)))
  const browse1 = await r.rpc('skillsBrowse()')
  check('aggiungi: in Sfoglia il pacchetto ha l\'etichetta «Aggiunto»',
    browse1.entries.find((e) => e.name === 'due-skill')?.installed === true)
  // l'etichetta si VEDE nella riga
  await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-entry-due-skill"]')`, 10_000)
  await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse-entry-due-skill"]')`)
  check('aggiungi: la riga di Sfoglia mostra «Aggiunto»',
    await r.waitDom(`document.querySelector('[data-testid="skills-browse-entry-due-skill"]')?.textContent.includes('Aggiunto')`, 6000))
  // NESSUNA voce in chat: l'ultima entry di Alfa non è un [sistema] del plugin
  const entriesAlfa = await r.rpc(`getEntries(${JSON.stringify(alfa.id)})`)
  const vociPlugin = (entriesAlfa ?? []).filter((e) => String(e.content ?? '').includes('Plugin "due-skill" installed'))
  check('aggiungi: NESSUNA voce in chat né [sistema] al modello', vociPlugin.length === 0)
  await clickText(r.pageEval, '✕', '[data-testid="skills-window"] button')
  await sleep(400)

  // il `/` del compositore: Alfa SÌ, Beta NO
  await r.pageEval(`document.querySelector('form textarea')?.focus(); return 'focus'`)
  const scrivi = (t) => r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(t)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'scritto'
  `)
  // (il compositore attivo è quello del bot selezionato: seleziono Alfa)
  await r.pageEval(`
    const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith('Alfa') && b.offsetParent !== null)
    if (btn) btn.click()
    return 'selezionato Alfa'
  `)
  await sleep(500)
  await scrivi('/')
  check('compositore Alfa: `/` mostra la skill del pacchetto (<plugin>--<skill>)',
    await r.waitDom(`!!document.querySelector('[data-testid="slash-picker"]') && document.querySelector('[data-testid="slash-picker"]').textContent.includes('/due-skill--ordina')`, 6000))
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return 'chiuso elenco'
  `)
  await sleep(300)
  await r.pageEval(`
    const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith('Beta') && b.offsetParent !== null)
    if (btn) btn.click()
    return 'selezionato Beta'
  `)
  await sleep(600)
  await scrivi('/')
  await sleep(500)
  const slashBeta = await r.pageEval(`return document.querySelector('[data-testid="slash-picker"]')?.textContent ?? ''`)
  check('compositore Beta: `/` NON mostra la skill del pacchetto (solo per Alfa)', !slashBeta.includes('due-skill--ordina'), slashBeta.slice(0, 80))
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ta.value = ''
    return 'pulito'
  `)
  await r.pageEval(`
    const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim().startsWith('Alfa') && b.offsetParent !== null)
    if (btn) btn.click()
    return 'selezionato Alfa'
  `)
  await sleep(600)

  // ============ 6. un TURNO di Alfa con /due-skill--ordina ============
  pushText('Fatto: idee ordinate.')
  const reqs0 = chatRequests.length
  await scrivi('/due-skill--ordina le idee della settimana')
  await sleep(200)
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'inviato'
  `)
  for (let i = 0; i < 60 && chatRequests.length <= reqs0; i++) await sleep(500)
  const lastReq = chatRequests.at(-1)
  const lastUser = (lastReq?.messages ?? []).filter((m) => m.role === 'user').at(-1)
  check('turno: la riga d\'invocazione arriva al modello (The user invoked the skill)',
    Boolean(lastUser && String(lastUser.content).startsWith('The user invoked the skill "due-skill--ordina"')),
    String(lastUser?.content ?? '').slice(0, 80))
  check('turno: il CORPO della skill è nel messaggio, poi il testo dell\'utente',
    Boolean(lastUser && String(lastUser.content).includes('ISTRUZIONI di ordina') && String(lastUser.content).includes('le idee della settimana')))

  // ============ 7. marketplace ILLEGGIBILE → riga + «Riprova» (B2/B4) ============
  // il marketplace diventa illeggibile (cartella rinominata) con la finestra
  // GIÀ CHIUSA: alla RIAPERTURA il primo caricamento è fresco → la riga
  const REPO_NASCOSTO = REPO + '-nascosto'
  renameSync(REPO, REPO_NASCOSTO)
  await openSkillsFromMenu(r)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 8000)
  check('illeggibile: «Alcuni pacchetti non si sono caricati.» con «Riprova»',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-unavailable"]') && ${SKILLS_WINDOW}.textContent.includes('Alcuni pacchetti non si sono caricati.') && !!document.querySelector('[data-testid="skills-browse-retry"]')`, 30_000))
  const browseKo = await r.rpc(`skillsBrowse('', ${JSON.stringify({ retry: true })})`)
  check('illeggibile: il catalogo RPC riporta il marketplace in unavailable e l\'elenco vuoto',
    browseKo.entries.length === 0 && browseKo.unavailable.length === 1 && browseKo.unavailable[0].source === REPO_URL,
    JSON.stringify(browseKo.unavailable))
  // ripristino → «Riprova» FUNZIONA (gli errori non stanno mai in cache)
  renameSync(REPO_NASCOSTO, REPO)
  await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse-retry"]')`)
  await pointerClick(r.pageEval, `document.querySelector('[data-testid="skills-browse-retry"]')`)
  check('ripristino: «Riprova» riporta i pacchetti (errori mai in cache)',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-entry-due-skill"]') && !document.querySelector('[data-testid="skills-browse-unavailable"]')`, 30_000))
  await clickText(r.pageEval, '✕', '[data-testid="skills-window"] button')
  await sleep(300)
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  try { console.error(main.getLog().slice(-1200)) } catch { /* niente log */ }
} finally {
  main?.stop()
  await sleep(800)
  // K8: si chiude DALL'AMBIENTE (helper condiviso), poi il giro del lock
  await stopProbeDaemons('sandbot-fase-sfoglia')
  for (const dir of usedDirs) await stopDaemon(dir)
}

// ============================ chiusura ============================
const { found, closed, left } = await stopProbeDaemons('sandbot-fase-sfoglia')
if (left > 0) {
  failures++
  console.error('[sonda] daemon rimasti vivi dopo la chiusura (dall\'ambiente):\n' + findProbeDaemons('sandbot-fase-sfoglia').map((d) => d.line).join('\n'))
} else {
  console.log(`[sonda] NESSUN daemon vivo (ps eww: ${found} trovati, ${closed} chiusi)`)
}
try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
try { rmSync(REPO, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
// con fallimenti le cartelle RESTANO (diagnostica); verdi si puliscono
if (failures === 0 && !process.env.PROBE_KEEP) {
  for (const entry of readdirSync(TMP_BASE).filter((f) => f.startsWith('sandbot-fase-sfoglia-') || f.startsWith('sandbot-sfoglia-mp-'))) {
    try { rmSync(TMP_BASE + entry, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  }
} else {
  console.log('[sonda] cartelle di prova conservate (PROBE_KEEP o fallimenti)')
}
console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
console.log(`catture in ${SHOTS}`)
process.exit(failures ? 1 : 0)
