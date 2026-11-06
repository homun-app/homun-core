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
// Fase SFOGLIA VELOCE (V1–V4), allargata:
//   2b. la SECONDA apertura della finestra NON rifà il clone (si contano le
//       cartelle -tree, le chiamate `git clone` registrate dal git della sonda
//       e una sentinella DENTRO il clone resta) e la lista appare entro 2 s;
//   7.  «Riprova» funziona (l'illeggibile ora si vede quando un aggiornamento
//       fallisce: aprire non rilegge più il marketplace);
//   8.  V3, il compositore: centro del textarea e del bottone Invia ≤ 2 px (la
//       misura della spec), più graffetta e Ragiona ≤ 1 px e l'INCHIOSTRO dei
//       pixel (testo contro icone) misurato IN LOCALE nel renderer, a 1440 e
//       900, chiaro e scuro, con e senza testo; col testo a capo il campo
//       cresce verso l'alto e i bottoni restano in basso;
//   T.  i TEMPI d'apertura su un'ALTRA app (cartella dati sua) con un
//       marketplace finto da 30 plugin e un `git` RALLENTATO apposta (1 s per
//       `show` e per `clone`, come il clone parziale da GitHub): prima
//       apertura (col conteggio «N di 30 plugin letti»), seconda apertura,
//       dopo un riavvio del daemon.
// Il `git` della sonda è un involucro LOCALE di /usr/bin/git (registra le
// chiamate e, nella parte T, le rallenta): arriva al daemon da HOMUN_GIT_PATH,
// l'unica variabile in più rispetto all'avvio pulito. Nessuna rete.
//
// Catture in docs/catture/skill/: sfoglia-* e menu-skill-* (1440 e 900,
// chiaro e scuro), compositore-* (V3), sfoglia-avanzamento-* (T). A FINE
// SONDA si chiude OGNI daemon avviato (dall'AMBIENTE, helper probe-daemons)
// e le cartelle temporanee si cancellano SOLO DOPO.
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

/**
 * Fase sfoglia veloce (V4): il `git` della sonda — un involucro di
 * /usr/bin/git che REGISTRA ogni chiamata (per contare i clone) e, se
 * chiesto, RALLENTA `show` e `clone` (come il clone parziale da GitHub: circa
 * 1 s per blob). Arriva al daemon da HOMUN_GIT_PATH (tool-paths). Tutto locale.
 */
function makeGitWrapper(prefix, { showDelay = 0, cloneDelay = 0 } = {}) {
  const dir = mkdtempSync(TMP_BASE + prefix)
  const logFile = join(dir, 'git.log')
  const script = join(dir, 'git')
  writeFileSync(script, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${logFile}'`,
    'case " $* " in',
    `  *" show "*) ${showDelay ? `/bin/sleep ${showDelay}` : ':'} ;;`,
    `  *" clone "*) ${cloneDelay ? `/bin/sleep ${cloneDelay}` : ':'} ;;`,
    'esac',
    'exec /usr/bin/git "$@"',
    ''
  ].join('\n'), { mode: 0o755 })
  const lines = () => { try { return readFileSync(logFile, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  return { dir, script, lines, clones: () => lines().filter((l) => / clone /.test(` ${l} `)).length }
}
/** Le cartelle -tree (i cloni dell'albero di Sfoglia) nella cache dei marketplace. */
const treeDirs = (dataDir) => {
  try { return readdirSync(join(dataDir, 'cache', 'marketplaces')).filter((d) => d.endsWith('-tree')) } catch { return [] }
}

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
const launchApp = (userData, debugPort, extraEnv = {}) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: userData,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(userData, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(userData, 'safestorage-finta.json'),
      // il clone file:// del marketplace di prova (SOLO locale, mai github.com)
      SANDBOT_TEST_ALLOW_FILE_URLS: '1',
      // fase sfoglia veloce: HOMUN_GIT_PATH verso il git della sonda (locale)
      ...extraEnv
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
/** La lista di Sfoglia è VISIBILE: almeno una voce e nessun caricamento in corso. */
const LISTA_PRONTA = `!!document.querySelector('[data-testid^="skills-browse-entry-"]') && !document.querySelector('[data-testid="skills-browse-loading"]')`
/**
 * Fase sfoglia veloce: apre la finestra dal menu e misura i ms dal click
 * sulla voce «Skill» alla lista visibile. L'orologio è NELLA pagina
 * (performance.now al click, un MutationObserver segna l'istante in cui la
 * lista appare): il sondaggio CDP e le catture non sporcano la misura.
 * onPoll gira a ogni giro (per vedere l'avanzamento). null = mai pronta.
 */
const openSkillsTimed = async (r, { readyExpr = LISTA_PRONTA, timeoutMs = 120_000, onPoll } = {}) => {
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
  await r.waitDom(`[...document.querySelectorAll('[data-testid="menu-skills"]')].some((x) => x.offsetParent !== null)`, 6000, 50)
  await r.pageEval(`
    window.__sondaT0 = null
    window.__sondaPronta = null
    window.__sondaObs?.disconnect()
    window.__sondaObs = new MutationObserver(() => {
      if (window.__sondaT0 !== null && window.__sondaPronta === null && (${readyExpr})) {
        window.__sondaPronta = performance.now()
        window.__sondaObs.disconnect()
      }
    })
    window.__sondaObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    const el = [...document.querySelectorAll('[data-testid="menu-skills"]')].find((x) => x.offsetParent !== null && x.textContent.trim() === 'Skill')
    if (!el) throw new Error('voce «Skill» non trovata')
    window.__sondaT0 = performance.now()
    el.click()
    return 'cliccato'
  `)
  const t0 = Date.now()
  for (;;) {
    const ms = await r.pageEval(`
      if (window.__sondaPronta !== null) return window.__sondaPronta - window.__sondaT0
      return (${readyExpr}) ? performance.now() - window.__sondaT0 : null
    `)
    if (ms !== null) return Math.round(ms)
    if (onPoll) await onPoll(Date.now() - t0)
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(50)
  }
}
const chiudiFinestra = async (r) => {
  await clickText(r.pageEval, '✕', '[data-testid="skills-window"] button')
  await r.waitDom(`!document.querySelector('[data-testid="skills-window"]')`, 5000)
  await sleep(200)
}

/** Il DB seminato: i bot dati e il marketplace LOCALE al posto di quello ufficiale. */
async function seedDb(dataDir, marketplaceUrl, marketplaceName, bots) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dataDir, 'sandbot.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', provider_id TEXT, model TEXT, status TEXT DEFAULT 'offline', unread INTEGER DEFAULT 0, created_at INTEGER, created_by TEXT, section TEXT DEFAULT '', parent_id TEXT);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  const ins = db.prepare('INSERT INTO agents(id, name, description, status, unread, created_at, created_by, section, parent_id) VALUES (?,?,?,?,?,?,?,?,?)')
  bots.forEach(([id, name, description], i) => ins.run(id, name, description, 'idle', 0, 1000 + i, null, '', null))
  const st = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  // B5: il marketplace di prova registrato e quello UFFICIALE tolto
  st.run('connectors.marketplaces', JSON.stringify([{ name: marketplaceName, source: marketplaceUrl, kind: 'git', official: false, addedAt: 1 }]))
  db.close()
}

/** Provider finto + modello per i bot dati, poi ricarica (come la prima parte). */
async function setupProvider(r, botNames) {
  await r.rpc(`saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'chiave-finta-di-prova', enabled: true })})`)
  await r.rpc(`settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  const agents = await r.rpc('listAgents()')
  const out = {}
  for (const name of botNames) {
    const a = agents.find((x) => x.name === name)
    if (!a) throw new Error(`il bot ${name} non c'è (onboarding?)`)
    await r.rpc(`updateAgent(${JSON.stringify(a.id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    out[name] = a
  }
  await r.page.send('Page.reload')
  await r.waitDom(`typeof window.sandbot !== 'undefined' && !!document.querySelector('form textarea')`, 30_000)
  return out
}

/** I tempi misurati (per il REPORT): stampati in fondo come JSON. */
const tempi = {}

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
await seedDb(DATA, REPO_URL, 'mp-di-prova', [[ALFA, 'Alfa', 'bot Alfa'], [BETA, 'Beta Bot', 'bot Beta']])

// il git della sonda (NESSUN rallentamento qui): registra i clone per 2b
const gitMain = makeGitWrapper('sandbot-sfoglia-git-')
const main = launchApp(USER, 9371, { HOMUN_GIT_PATH: gitMain.script })
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
  const bots = await setupProvider(r, ['Alfa', 'Beta Bot'])
  const alfa = bots['Alfa']
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

  // ============ 2b. (V1) la SECONDA apertura NON rifà il clone ============
  // si contano le cartelle -tree, le chiamate `git clone` registrate dal git
  // della sonda e una SENTINELLA dentro il clone dell'albero (un re-clone la
  // cancellerebbe); con la cache la lista appare entro 2 s
  const treesPrima = treeDirs(DATA)
  const clonesPrima = gitMain.clones()
  check('2b: dopo la prima apertura c\'è UNA cartella -tree', treesPrima.length === 1, JSON.stringify(treesPrima))
  const sentinella = treesPrima[0] ? join(DATA, 'cache', 'marketplaces', treesPrima[0], 'sonda-sentinella') : null
  if (sentinella) writeFileSync(sentinella, 'resta')
  await chiudiFinestra(r)
  const secondaMs = await openSkillsTimed(r, { timeoutMs: 60_000 })
  tempi.principaleSeconda = secondaMs
  check('2b: la seconda apertura mostra la lista entro 2 s (cache)', secondaMs !== null && secondaMs <= 2000, `${secondaMs} ms`)
  await sleep(500) // un eventuale lavoro in sottofondo avrebbe il tempo di partire
  check('2b: la seconda apertura NON rifà il clone (nessun `git clone` in più)', gitMain.clones() === clonesPrima, `${clonesPrima} → ${gitMain.clones()}`)
  check('2b: le cartelle -tree restano UNA, la sentinella dentro il clone c\'è ancora',
    treeDirs(DATA).length === 1 && sentinella !== null && existsSync(sentinella), JSON.stringify(treeDirs(DATA)))
  check('2b: la cache del catalogo è su disco (cache/marketplaces/skill-browse.json)',
    existsSync(join(DATA, 'cache', 'marketplaces', 'skill-browse.json')))

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
  // U4 (fase pulizia · ritocchi): il timbro [Sent: …] sta PRIMA di tutto, poi l'espansione
  check('turno: la riga d\'invocazione arriva al modello, subito dopo il timbro [Sent: …]',
    Boolean(lastUser && /^\[Sent: [^\]\n]*\]\n\nThe user invoked the skill "due-skill--ordina"/.test(String(lastUser.content))),
    String(lastUser?.content ?? '').slice(0, 110))
  check('turno: il CORPO della skill è nel messaggio, poi il testo dell\'utente',
    Boolean(lastUser && String(lastUser.content).includes('ISTRUZIONI di ordina') && String(lastUser.content).includes('le idee della settimana')))

  // ============ 7. marketplace ILLEGGIBILE → riga + «Riprova» (B2/B4) ============
  // Fase sfoglia veloce (V1): APRIRE non rilegge più il marketplace (la
  // cache è fresca, nessun retry all'apertura) — l'illeggibile si vede quando
  // un AGGIORNAMENTO fallisce. Qui una riprova via RPC (la stessa chiamata del
  // bottone) col marketplace nascosto; poi la finestra mostra la riga col
  // «Riprova», che dopo il ripristino riporta i pacchetti
  const REPO_NASCOSTO = REPO + '-nascosto'
  renameSync(REPO, REPO_NASCOSTO)
  const browseKo = await r.rpc(`skillsBrowse('', ${JSON.stringify({ retry: true })})`)
  check('illeggibile: il catalogo RPC riporta il marketplace in unavailable e l\'elenco vuoto',
    browseKo.entries.length === 0 && browseKo.unavailable.length === 1 && browseKo.unavailable[0].source === REPO_URL,
    JSON.stringify(browseKo.unavailable))
  await openSkillsFromMenu(r)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 8000)
  check('illeggibile: «Alcuni pacchetti non si sono caricati.» con «Riprova»',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-unavailable"]') && ${SKILLS_WINDOW}.textContent.includes('Alcuni pacchetti non si sono caricati.') && !!document.querySelector('[data-testid="skills-browse-retry"]')`, 30_000))
  // ripristino → «Riprova» FUNZIONA (gli errori non stanno mai in cache)
  renameSync(REPO_NASCOSTO, REPO)
  const clonesPrimaRiprova = gitMain.clones()
  await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-browse-retry"]')`)
  await pointerClick(r.pageEval, `document.querySelector('[data-testid="skills-browse-retry"]')`)
  check('ripristino: «Riprova» riporta i pacchetti (errori mai in cache)',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-browse-entry-due-skill"]') && !document.querySelector('[data-testid="skills-browse-unavailable"]')`, 30_000))
  // V1: la riprova col marketplace INVARIATO non rifà il clone (ls-remote:
  // stessa HEAD → fetch leggero sul clone esistente)
  const chiamateRiprova = gitMain.lines().slice(-40).join(' | ')
  check('ripristino (V1): «Riprova» con la HEAD invariata NON rifà il clone (ls-remote + fetch)',
    gitMain.clones() === clonesPrimaRiprova && / ls-remote /.test(` ${chiamateRiprova} `) && / fetch /.test(` ${chiamateRiprova} `),
    `clone ${clonesPrimaRiprova} → ${gitMain.clones()}`)
  await clickText(r.pageEval, '✕', '[data-testid="skills-window"] button')
  await sleep(300)

  // ============ 8. (V3) il COMPOSITORE allineato ============
  // la misura della spec: il centro del rettangolo del textarea e quello di
  // Invia ≤ 2 px. DA SOLA non distingue (sul base: textarea 44 px, Invia 40,
  // allineati in basso → Δ 2 px; dopo: 36 contro 40 → Δ 2 px) — per questo
  // anche graffetta e Ragiona (≤ 1 px) e l'INCHIOSTRO: il centro verticale dei
  // pixel del testo contro quello dell'icona della graffetta, calcolato IN
  // LOCALE nel renderer (canvas sullo scatto del form), ≤ 2 px
  await r.waitDom(`!!document.querySelector('form button[type="submit"]')`, 30_000)
  const misuraCompositore = () => r.pageEval(`
    const ta = document.querySelector('form textarea')
    const form = ta.closest('form')
    const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, mid: b.top + b.height / 2, bottom: b.bottom } }
    // chi c'è DAVVERO sopra il centro di un bottone (un pannello in sovrimpressione?)
    const sopra = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return !top ? 'niente' : el.contains(top) ? 'il bottone' : (top.closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName.toLowerCase())
    }
    const send = form.querySelector('button[type="submit"]')
    const reason = form.querySelector('[aria-label="Livello di ragionamento"]')
    return {
      ta: rect(ta),
      send: rect(send),
      clip: rect(form.querySelector('button[aria-label^="Allega immagine"]')),
      reason: rect(reason),
      form: rect(form),
      rows: ta.rows,
      sopraInvia: sopra(send),
      sopraRagiona: sopra(reason)
    }
  `)
  /** Lo scatto del SOLO form e i centri dell'inchiostro (testo, icone), in locale. */
  const inchiostro = async (m) => {
    const clip = { x: m.form.x - 6, y: m.form.y - 6, width: m.form.w + 12, height: m.form.h + 12, scale: 1 }
    const shotData = (await r.page.send('Page.captureScreenshot', { format: 'png', clip })).data
    const centri = await r.pageEval(`
      const img = new Image()
      img.src = 'data:image/png;base64,${shotData}'
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const { data, width } = g.getImageData(0, 0, img.width, img.height)
      const k = img.width / ${clip.width}
      const ox = ${clip.x}
      const oy = ${clip.y}
      const px = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]] }
      // il centro dei pixel che si staccano dallo sfondo della zona (pesato sul contrasto)
      const centro = (x0, y0, x1, y1) => {
        const X0 = Math.round((x0 - ox) * k), Y0 = Math.round((y0 - oy) * k), X1 = Math.round((x1 - ox) * k), Y1 = Math.round((y1 - oy) * k)
        const bg = px(X0, Y0)
        let s = 0
        let w = 0
        for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
          const p = px(x, y)
          const d = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2])
          if (d > 60) { s += y * d; w += d }
        }
        return w ? oy + s / w / k : null
      }
      const m = ${JSON.stringify(m)}
      const quadro = (b, half) => [b.x + b.w / 2 - half, b.mid - half, b.x + b.w / 2 + half, b.mid + half]
      return {
        testo: centro(m.ta.x + 12, m.ta.y, Math.min(m.ta.x + m.ta.w - 12, m.ta.x + 12 + 220), m.ta.y + m.ta.h),
        graffetta: centro(...quadro(m.clip, 10)),
        ragiona: centro(m.reason.x + 4, m.reason.y + 4, m.reason.x + m.reason.w - 4, m.reason.y + m.reason.h - 4),
        invia: centro(...quadro(m.send, 10))
      }
    `)
    return { shotData, centri }
  }
  const scriviCompositore = (t) => r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(t)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.blur()
    return 'scritto'
  `)
  const v3 = []
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    for (const testo of ['', 'Ciao Alfa, una riga sola']) {
      await scriviCompositore(testo)
      await sleep(300)
      const m = await misuraCompositore()
      const { shotData, centri } = await inchiostro(m)
      const nome = `compositore-${w}-${dark ? 'scuro' : 'chiaro'}-${testo ? 'testo' : 'vuoto'}`
      writeFileSync(join(SHOTS, `${nome}.png`), Buffer.from(shotData, 'base64'))
      log('cattura', `${nome}.png`)
      const delta = (a, b) => (a === null || b === null ? null : Math.abs(a - b))
      const d = {
        nome,
        altezza: m.ta.h,
        invia: delta(m.ta.mid, m.send.mid),
        graffetta: delta(m.ta.mid, m.clip.mid),
        ragiona: delta(m.ta.mid, m.reason.mid),
        inkGraffetta: delta(centri.testo, centri.graffetta),
        inkRagiona: delta(centri.testo, centri.ragiona),
        inkInvia: delta(centri.testo, centri.invia),
        sopraInvia: m.sopraInvia,
        sopraRagiona: m.sopraRagiona
      }
      v3.push(d)
      const f = (x) => (x === null ? 'n/d' : x.toFixed(2))
      check(`V3 ${nome}: centro textarea ↔ Invia ≤ 2 px (la misura della spec)`, d.invia !== null && d.invia <= 2, `Δ ${f(d.invia)} px, textarea alto ${m.ta.h} px`)
      check(`V3 ${nome}: centro textarea ↔ graffetta e Ragiona ≤ 1 px`, d.graffetta !== null && d.ragiona !== null && d.graffetta <= 1 && d.ragiona <= 1, `Δ ${f(d.graffetta)} / ${f(d.ragiona)} px`)
      check(`V3 ${nome}: INCHIOSTRO del testo ↔ icona della graffetta ≤ 2 px (pixel, in locale)`, d.inkGraffetta !== null && d.inkGraffetta <= 2,
        `Δ ${f(d.inkGraffetta)} px (Ragiona ${f(d.inkRagiona)}, Invia ${f(d.inkInvia)}; sopra Invia: ${d.sopraInvia}, sopra Ragiona: ${d.sopraRagiona})`)
    }
  }
  // col testo A CAPO il campo cresce verso l'alto e i bottoni restano in basso
  await r.setWindowWidth(1440)
  await setDark(r.pageEval, false)
  await scriviCompositore('riga uno\nriga due\nriga tre')
  await sleep(300)
  const ml = await misuraCompositore()
  writeFileSync(join(SHOTS, 'compositore-1440-chiaro-a-capo.png'), Buffer.from((await inchiostro(ml)).shotData, 'base64'))
  log('cattura', 'compositore-1440-chiaro-a-capo.png')
  check('V3: col testo a capo il campo cresce verso l\'alto e i bottoni restano in basso',
    ml.rows === 3 && ml.ta.h > 50 && Math.abs(ml.ta.bottom - ml.send.bottom) <= 1 && ml.ta.y < ml.send.y - 10,
    `righe ${ml.rows}, alto ${ml.ta.h} px, Δ basso ${Math.abs(ml.ta.bottom - ml.send.bottom).toFixed(1)} px`)
  await scriviCompositore('')
  log('V3 misure:', JSON.stringify(v3))
  tempi.v3 = v3
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

// ============================ T. i TEMPI d'apertura ============================
// un'ALTRA app (cartella dati sua) con un marketplace finto da 30 plugin e il
// git RALLENTATO apposta (1 s per show e per clone, come il clone parziale da
// GitHub): la prima apertura (col conteggio dell'avanzamento), la seconda e
// quella dopo un riavvio del daemon. 30 plugin = 24 di sole skill col
// manifest, 3 senza manifest (sole skill, nessuna lettura), 3 connettori
// (.mcp.json): in Sfoglia ne restano 27
const REPO30 = mkdtempSync(TMP_BASE + 'sandbot-sfoglia-mp-')
{
  const defs = Array.from({ length: 30 }, (_, i) => ({
    name: `pacchetto-${String(i + 1).padStart(2, '0')}`,
    mcp: i % 10 === 9,
    manifest: i % 10 !== 4
  }))
  mkdirSync(join(REPO30, '.claude-plugin'), { recursive: true })
  writeFileSync(join(REPO30, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'mp-trenta',
    owner: 'tester',
    plugins: defs.map((d) => ({ name: d.name, description: `Il ${d.name} di prova`, source: `./plugins/${d.name}` }))
  }))
  for (const d of defs) {
    const base = join(REPO30, 'plugins', d.name)
    mkdirSync(join(base, 'skills', 'unica'), { recursive: true })
    writeFileSync(join(base, 'skills', 'unica', 'SKILL.md'), `---\nname: unica\ndescription: la skill di ${d.name}\n---\nIstruzioni di ${d.name}.`)
    if (d.manifest) {
      mkdirSync(join(base, '.claude-plugin'), { recursive: true })
      writeFileSync(join(base, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: d.name }))
    }
    if (d.mcp) writeFileSync(join(base, '.mcp.json'), JSON.stringify({ mcpServers: { s: { url: 'https://servizio.example/mcp' } } }))
  }
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: REPO30 })
}
const ATTESI30 = 27
const TT = mkdtempSync(TMP_BASE + 'sandbot-fase-sfoglia-tempi-')
const USER_T = join(TT, 'data')
const DATA_T = join(USER_T, 'data')
mkdirSync(DATA_T, { recursive: true })
await seedDb(DATA_T, `file://${REPO30}`, 'mp-trenta', [['agent_tempo', 'Tempo', 'bot dei tempi']])
const gitLento = makeGitWrapper('sandbot-sfoglia-git-lento-', { showDelay: 1, cloneDelay: 1 })
const appT = launchApp(USER_T, 9372, { HOMUN_GIT_PATH: gitLento.script })
try {
  let r
  try {
    r = await run(9372)
  } catch (e) {
    throw new Error('pagina CDP (tempi) non raggiunta: ' + (e?.message ?? e) + '\nlog app:\n' + appT.getLog().slice(-1200))
  }
  if (!(await r.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
    throw new Error('window.sandbot (tempi) non disponibile dopo 40s')
  }
  await setupProvider(r, ['Tempo'])
  await r.setWindowWidth(1440)
  const quanteVoci = () => r.pageEval(`return document.querySelectorAll('[data-testid^="skills-browse-entry-"]').length`)

  // ---- T1: la PRIMA apertura in assoluto (niente cache): il conteggio ----
  const visti = []
  let scatti = 0
  const primaMs = await openSkillsTimed(r, {
    timeoutMs: 150_000,
    onPoll: async () => {
      // il blocco del caricamento: «Cerco i pacchetti…» e il conteggio del daemon
      const t = await r.pageEval(`return document.querySelector('[data-testid="skills-browse-loading"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`)
      if (!t) return
      visti.push(t)
      if (!/plugin letti/.test(t)) return
      if (scatti === 0) {
        scatti++
        await r.shot('sfoglia-avanzamento-1440-chiaro.png')
      } else if (scatti === 1) {
        scatti++
        await setDark(r.pageEval, true)
        if (await r.pageEval(`return !!document.querySelector('[data-testid="skills-browse-progress"]')`)) await r.shot('sfoglia-avanzamento-1440-scuro.png')
        await setDark(r.pageEval, false)
      }
    }
  })
  tempi.primaApertura = primaMs
  const conteggi = visti.map((t) => /(\d+) di (\d+) plugin letti/.exec(t)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])])
  check('T1: la prima apertura mostra «Cerco i pacchetti…» col conteggio «N di 30 plugin letti»',
    visti.some((t) => t.includes('Cerco i pacchetti')) && conteggi.some(([d, tot]) => tot === 30 && d < 30),
    `${visti.length} letture, ${scatti} catture: ${[...new Set(visti)].slice(0, 3).join(' / ') || 'nessuna'}`)
  check('T1: il conteggio cresce e non torna mai indietro',
    conteggi.length > 0 && conteggi.every((c, i) => i === 0 || c[0] >= conteggi[i - 1][0]),
    JSON.stringify([...new Set(conteggi.map((c) => c[0]))]))
  const vociT1 = await quanteVoci()
  check('T1: alla fine la lista è completa (27 pacchetti di sole skill)', primaMs !== null && vociT1 === ATTESI30, `${primaMs} ms, ${vociT1} voci`)

  // ---- T2: la SECONDA apertura (cache) ----
  const treesT = treeDirs(DATA_T)
  const sentT = treesT[0] ? join(DATA_T, 'cache', 'marketplaces', treesT[0], 'sonda-sentinella') : null
  if (sentT) writeFileSync(sentT, 'resta')
  await chiudiFinestra(r)
  const clonesT2 = gitLento.clones()
  const secondaMs = await openSkillsTimed(r, { timeoutMs: 150_000 })
  tempi.secondaApertura = secondaMs
  check('T2: la seconda apertura mostra la lista entro 2 s', secondaMs !== null && secondaMs <= 2000, `${secondaMs} ms`)
  await sleep(500)
  check('T2: NESSUN clone in più, una sola -tree, la sentinella dentro il clone resta',
    gitLento.clones() === clonesT2 && treeDirs(DATA_T).length === 1 && !!sentT && existsSync(sentT),
    `clone ${clonesT2} → ${gitLento.clones()}, -tree ${treeDirs(DATA_T).length}`)
  await chiudiFinestra(r)

  // ---- T3: dopo un RIAVVIO del daemon (la cache su disco) ----
  const pid0 = daemonPid(DATA_T)
  await stopDaemon(DATA_T)
  const tRiavvio = Date.now()
  await r.rpc('listAgents()') // il client si riconnette e il daemon riparte
  tempi.riavvioDelDaemon = Date.now() - tRiavvio
  const pid1 = daemonPid(DATA_T)
  check('T3: il daemon è ripartito (pid nuovo)', !!pid1 && pid1 !== pid0, `${pid0} → ${pid1}`)
  await sleep(800)
  const clonesT3 = gitLento.clones()
  const dopoRiavvioMs = await openSkillsTimed(r, { timeoutMs: 150_000 })
  tempi.dopoRiavvio = dopoRiavvioMs
  check('T3: dopo il riavvio del daemon la lista appare entro 2 s (cache su disco)', dopoRiavvioMs !== null && dopoRiavvioMs <= 2000, `${dopoRiavvioMs} ms`)
  await sleep(500)
  const vociT3 = await quanteVoci()
  check('T3: dopo il riavvio NESSUN clone in più e la lista completa',
    gitLento.clones() === clonesT3 && vociT3 === ATTESI30, `clone ${clonesT3} → ${gitLento.clones()}, ${vociT3} voci`)
  await chiudiFinestra(r)
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE (tempi):', e.message ?? e)
  try { console.error('--- daemon.log (tempi) ---\n' + readFileSync(join(DATA_T, 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  try { console.error(appT.getLog().slice(-1200)) } catch { /* niente log */ }
} finally {
  appT?.stop()
  await sleep(800)
  await stopProbeDaemons('sandbot-fase-sfoglia')
  await stopDaemon(DATA_T)
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
try { rmSync(REPO30, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
// i tempi d'apertura (per il REPORT): ms dal click su «Skill» alla lista visibile
console.log('[tempi] ' + JSON.stringify({
  primaApertura: tempi.primaApertura, secondaApertura: tempi.secondaApertura,
  riavvioDelDaemon: tempi.riavvioDelDaemon, dopoRiavvio: tempi.dopoRiavvio,
  principaleSeconda: tempi.principaleSeconda
}))
// con fallimenti le cartelle RESTANO (diagnostica); verdi si puliscono
if (failures === 0 && !process.env.PROBE_KEEP) {
  for (const entry of readdirSync(TMP_BASE).filter((f) => f.startsWith('sandbot-fase-sfoglia-') || f.startsWith('sandbot-sfoglia-mp-') || f.startsWith('sandbot-sfoglia-git-'))) {
    try { rmSync(TMP_BASE + entry, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  }
} else {
  console.log('[sonda] cartelle di prova conservate (PROBE_KEEP o fallimenti)')
}
console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
console.log(`catture in ${SHOTS}`)
process.exit(failures ? 1 : 0)
