#!/usr/bin/env node
// Sonda Electron della fase SKILL · CATALOGO (K8): l'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA, tutto finto e SOLO su
// 127.0.0.1 — mai github.com:
//   • REPO GIT LOCALE file:// con tre voci: una in skills/ col segnaposto
//     $ARGUMENTS e file da escludere (evals/, examples/, README.md), una alla
//     RADICE come humanizer, una «solo con /» (invocation 'user');
//   • CATALOGO FINTO (SANDBOT_TEST_SKILL_CATALOG, col file:// del repo e il
//     commit fissato) che una seconda versione cambia: «Aggiornamento
//     disponibile» col flusso di oggi (diff, versione vecchia conservata);
//   • PROVIDER FINTO (openai-compatible, SSE) che registra OGNI richiesta:
//     il system prompt, il corpo del `/voce` con le note e $ARGUMENTS
//     sostituito si verificano su ciò che arriva al modello.
//
// Controlli (K8): 1) Sfoglia mostra categorie e filtri, la ricerca filtra;
// 2) anteprima: fonte, licenza, file (senza evals/), «Adattamenti di Homun»;
// 3) Aggiungi per il solo bot Alfa: libreria, «Aggiunta», / di Alfa sì e di
// Beta no; 4) un turno /voce testo: corpo, note in coda, $ARGUMENTS;
// 5) invocation 'user': fuori dal system prompt, rifiutata dal tool skill,
// funzionante con /; 6) «Aggiornamento disponibile» col secondo catalogo e
// l'aggiornamento che funziona; 7) a 1440 e 900, in chiaro e in scuro,
// catture (guardate in locale).
//
// A FINE CORSA si chiude OGNI daemon avviato (pid da daemon.lock, poi il
// controllo dall'AMBIENTE dei processi); le cartelle temporanee si
// cancellano SODO DOPO che i daemon sono spariti. Niente Docker, nessun
// push, mai il Portachiavi vero. I menu Radix si chiudono con Escape.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/'
const SHOTS = join(ROOT, 'docs', 'catture', 'skill-catalogo')
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

// ---- il repository git LOCALE (file:// SOLO col flag di test) ----
const REPO = mkdtempSync(TMP_BASE + 'sandbot-skillcat-repo-')
const CON = join(REPO, 'skills', 'con-argomenti')
{
  // 1. col segnaposto $ARGUMENTS e file da escludere
  mkdirSync(join(CON, 'references'), { recursive: true })
  mkdirSync(join(CON, 'evals'), { recursive: true })
  mkdirSync(join(CON, 'examples'), { recursive: true })
  writeFileSync(join(CON, 'SKILL.md'),
    '---\nname: con-argomenti\ndescription: riscrive un testo col tono giusto\nlicense: MIT\n---\nRiscrivi il testo: $ARGUMENTS\nPrima parola: $1\nRegola ferrea: non inventare nulla.')
  writeFileSync(join(CON, 'LICENSE'), 'MIT License (finta, di prova)')
  writeFileSync(join(CON, 'README.md'), '# leggimi (da escludere)')
  writeFileSync(join(CON, 'references', 'guida.md'), '# Guida al tono')
  writeFileSync(join(CON, 'evals', 'evals.json'), '{}')
  writeFileSync(join(CON, 'examples', 'esempio.md'), '# esempio (da escludere)')
  // 2. alla RADICE, come humanizer (il name del frontmatter NON è l'id)
  mkdirSync(join(REPO, 'references'), { recursive: true })
  mkdirSync(join(REPO, 'scripts'), { recursive: true })
  writeFileSync(join(REPO, 'SKILL.md'), '---\nname: umanizza\ndescription: toglie i tic da IA\n---\nRiscrivi come una persona, senza inventare.')
  writeFileSync(join(REPO, 'LICENSE'), 'MIT License (finta, di prova)')
  writeFileSync(join(REPO, 'README.md'), '# leggimi (da escludere)')
  writeFileSync(join(REPO, 'references', 'patterns.md'), '# pattern dei tic')
  writeFileSync(join(REPO, 'scripts', 'check.py'), 'print(1)')
  // 3. «solo con /» (invocation 'user' nel catalogo)
  mkdirSync(join(REPO, 'skills', 'domanda-attenta'), { recursive: true })
  writeFileSync(join(REPO, 'skills', 'domanda-attenta', 'SKILL.md'),
    '---\nname: domanda-attenta\ndescription: tre domande per verificare una risposta\n---\nFai tre domande che verificano la risposta.')
  const git = (cmd) => execSync(cmd, { cwd: REPO })
  git('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm A')
}
const shaOf = (ref) => execSync(`git rev-parse ${ref}`, { cwd: REPO }).toString().trim()
const COMMIT_A = shaOf('HEAD')

/** Il catalogo finto (stessa forma del file del repo), al commit dato. */
const catalogJson = (commit, noteExtra = '') => JSON.stringify({
  version: 1,
  reviewedAt: '2026-11-06',
  categories: ['writing', 'work', 'thinking', 'research', 'career'],
  skills: [
    {
      id: 'con-argomenti', license: 'MIT', category: 'work', reviewed: '2026-11-06',
      source: { repo: `file://${REPO}`, commit, path: 'skills/con-argomenti' },
      description: { it: 'Riscrive un testo col tono giusto.', en: 'Rewrites a text with the right tone.' },
      files: { exclude: ['evals/**', 'examples/**', 'README.md'] },
      homunNotes: `Adatta gli esempi al paese dell'utente.${noteExtra}`
    },
    {
      id: 'umanizza', license: 'MIT', category: 'writing', reviewed: '2026-11-06',
      source: { repo: `file://${REPO}`, commit, path: '' },
      description: { it: 'Toglie i tic da IA a un testo.', en: 'Removes AI tells from a text.' },
      files: { exclude: ['README.md', 'scripts/**', 'skills/**'] },
      homunNotes: 'Non toccare la tipografia della lingua.'
    },
    {
      id: 'domanda-attenta', license: 'MIT', category: 'thinking', reviewed: '2026-11-06',
      source: { repo: `file://${REPO}`, commit, path: 'skills/domanda-attenta' },
      description: { it: 'Tre domande per verificare una risposta.', en: 'Three questions to check an answer.' },
      files: { exclude: ['evals/**'] },
      homunNotes: 'Usala solo se l\'utente la chiama.',
      invocation: 'user'
    }
  ]
}, null, 2)

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

const launchApp = (userData, catalogFile, debugPort) => {
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      // userData: la cartella dati del daemon (DB, skills) è <userData>/data
      SANDBOT_TEST_USER_DATA: userData,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(userData, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(userData, 'safestorage-finta.json'),
      // il clone file:// per l'installazione delle voci (SOLO locale)
      SANDBOT_TEST_ALLOW_FILE_URLS: '1',
      // il catalogo finto (K3: sostituisce quello del repo; si legge SOLO
      // insieme a SANDBOT_TEST_USER_DATA)
      SANDBOT_TEST_SKILL_CATALOG: catalogFile
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
/** K8: i menu Radix si chiudono con ESCAPE (un click sul body non basta). */
const closeRadixMenus = (pageEval) => pageEval(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 200))
  return 'Escape'
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
const composerKey = (pageEval, key) => pageEval(`
  const ta = document.querySelector('form textarea')
  if (!ta) throw new Error('compositore non trovato')
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))
  return 'tasto ' + ${JSON.stringify(key)}
`)

/** Prepara una corsa: provider finto, bot Alfa attivo, 1440. */
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

/** Clicca per data-testid (attendendolo): niente filtro di visibilità, che durante le animazioni dei dialoghi Radix ammazza i clic giusti. */
const clickTestId = async (r, testid, timeoutMs = 20_000) => {
  const ok = await r.waitDom(`!!document.querySelector('[data-testid=${JSON.stringify(testid)}]')`, timeoutMs)
  if (!ok) throw new Error('non trovato: ' + testid)
  await r.pageEval(`document.querySelector('[data-testid=${JSON.stringify(testid)}]').click(); return 'cliccato: ' + ${JSON.stringify(testid)}`)
  return true
}

/** Aspetta che l'anteprima di una voce abbia caricato (o errore): lo staging può metterci qualche secondo. */
const waitForPreviewLoaded = async (r) => {
  for (let i = 0; i < 40; i++) {
    const ready = await r.pageEval(`return !!document.querySelector('[data-testid="skills-catalog-preview-license"]') || !!document.querySelector('[data-testid="skills-catalog-preview-error"]')`)
    if (ready) return true
    await sleep(500)
  }
  return false
}

const SKILLS_WINDOW = `(document.querySelector('[data-testid="skills-window"]') ?? document)`
const openSkillsFromMenu = async (r) => {
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
  await sleep(250)
  await clickText(r.pageEval, 'Skill', '[data-testid="menu-skills"]', true)
  await sleep(250)
  return true
}
const closeSkillsWindow = async (r) => {
  await clickText(r.pageEval, '✕', '[data-testid="skills-window"] button')
  await sleep(400)
}

// ============================ la corsa ============================
const TMP = mkdtempSync(TMP_BASE + 'sandbot-fase-skill-catalogo-')
const USER = join(TMP, 'data')
const DATA = join(USER, 'data')
mkdirSync(DATA, { recursive: true })
const usedDirs = [DATA]
const CATALOG_FILE = join(TMP, 'catalogo-finto.json')
writeFileSync(CATALOG_FILE, catalogJson(COMMIT_A))

// il DB seminato: DUE bot (Alfa attivo, Beta per il «solo Alfa»)
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
  db.close()
}

const main = launchApp(USER, CATALOG_FILE, 9363)
try {
  let r
  try {
    r = await run(9363)
  } catch (e) {
    throw new Error('pagina CDP non raggiunta: ' + (e?.message ?? e) + '\nlog app:\n' + main.getLog().slice(-1200))
  }
  if (!(await r.waitDom(`typeof window.sandbot !== 'undefined' && !!window.sandbot.saveProvider`, 40_000))) {
    throw new Error('window.sandbot non disponibile dopo 40s')
  }
  const bot = await setupBot(r)

  // ============ 1. Sfoglia: categorie, filtri, ricerca (nessuna rete) ============
  // K8: un menu Radix si chiude con ESCAPE — prova vera sul menu dell'account
  await pointerClick(r.pageEval, `[...document.querySelectorAll('[data-testid="account-menu-trigger"]')].find((b) => b.offsetParent !== null)`)
  await sleep(250)
  await closeRadixMenus(r.pageEval)
  check('1·il menu Radix dell\'account si chiude con Escape',
    (await r.pageEval(`return !document.querySelector('[data-testid="menu-skills"]')`)) === true)
  check('1·finestra: si apre dal menu in fondo',
    (await openSkillsFromMenu(r)) && await r.waitDom(`!!document.querySelector('[data-testid="skills-window"]')`, 8000))
  // il catalogo è NEL repo (qui: nel file finto locale): la lista appare subito
  const subito = Date.now()
  check('1·l\'elenco del catalogo appare SUBITO (nessuna rete: il catalogo è lì)',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-entry-umanizza"]')`, 6000),
    `${Date.now() - subito} ms`)
  check('1·le TRE voci del catalogo finto ci sono tutte',
    (await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]') && !!document.querySelector('[data-testid="skills-catalog-entry-domanda-attenta"]')`, 4000)))
  check('1·raggruppate per categoria coi titoletti (Scrittura, Lavoro, Pensiero)',
    (await r.pageEval(`return ['Scrittura','Lavoro','Pensiero'].every((t) => ${SKILLS_WINDOW}.textContent.includes(t))`)) === true)
  check('1·i titoletti di categoria seguono l\'ordine del catalogo (Scrittura prima di Lavoro prima di Pensiero)',
    (await r.pageEval(`const w = ${SKILLS_WINDOW}.textContent; return w.indexOf('Scrittura') < w.indexOf('Lavoro') && w.indexOf('Lavoro') < w.indexOf('Pensiero')`)) === true)
  check('1·la riga mostra la descrizione nella lingua e la fonte owner/repo',
    (await r.pageEval(`const row = document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]'); return !!row && row.textContent.includes('Riscrive un testo col tono giusto.') && row.textContent.includes('sandbot-skillcat-repo')`)) === true)
  // i filtri a pillola
  check('1·i filtri a pillola: «Tutte» più TUTTE e cinque le categorie',
    (await r.pageEval(`const f = document.querySelector('[data-testid="skills-catalog-filters"]'); return !!f && ['Tutte','Scrittura','Lavoro','Pensiero','Ricerca','Carriera'].every((t) => f.textContent.includes(t))`)) === true)
  await clickText(r.pageEval, 'Lavoro', '[data-testid="skills-catalog-filters"] button', true)
  await sleep(300)
  check('1·il filtro «Lavoro» lascia SOLO le voci di quella categoria',
    (await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-catalog-entry-"]')].filter((x) => x.offsetParent !== null).map((x) => x.getAttribute('data-testid')).join(',')`)) === 'skills-catalog-entry-con-argomenti')
  await clickText(r.pageEval, 'Tutte', '[data-testid="skills-catalog-filters"] button', true)
  await sleep(300)
  // la ricerca in alto filtra ANCHE il catalogo
  await setInput(r.pageEval, '[data-testid="skills-search"]', 'umanizza')
  await sleep(400)
  check('1·la ricerca in alto filtra anche il catalogo (una riga: umanizza)',
    (await r.pageEval(`return [...document.querySelectorAll('[data-testid^="skills-catalog-entry-"]')].filter((x) => x.offsetParent !== null).map((x) => x.getAttribute('data-testid')).join(',')`)) === 'skills-catalog-entry-umanizza')
  await setInput(r.pageEval, '[data-testid="skills-search"]', '')
  await sleep(300)

  // ============ 2. l'ANTEPRIMA di una voce: fonte, licenza, file, note ============
  await clickText(r.pageEval, 'Con argomenti', '[data-testid^="skills-catalog-entry-"]')
  check('2·l\'anteprima si apre',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-preview"]')`, 30_000))
  await waitForPreviewLoaded(r)
  check('2·fonte (owner/repo) e commit fissato (12) in cima',
    (await r.pageEval(`return !!document.querySelector('[data-testid="skills-catalog-preview-source"]')?.textContent.includes('sandbot-skillcat-repo') && document.querySelector('[data-testid="skills-catalog-preview-commit"]')?.textContent === ${JSON.stringify(COMMIT_A.slice(0, 12))}`)) === true)
  check('2·la licenza della voce',
    (await r.pageEval(`return document.querySelector('[data-testid="skills-catalog-preview-license"]')?.textContent.includes('MIT')`)) === true)
  const filesText = await r.pageEval(`return document.querySelector('[data-testid="skills-catalog-preview-files"]')?.textContent ?? ''`)
  check('2·i file che entrano: SKILL.md, LICENSE e references/guida.md',
    filesText.includes('SKILL.md') && filesText.includes('LICENSE') && filesText.includes('references/guida.md'), filesText.slice(0, 120))
  check('2·NIENTE evals/ né examples/ né README.md nell\'elenco dei file',
    !filesText.includes('evals/') && !filesText.includes('examples/') && !filesText.includes('README.md'), '')
  check('2·«Adattamenti di Homun» col testo delle note',
    (await r.pageEval(`const n = document.querySelector('[data-testid="skills-catalog-preview-notes"]'); return !!n && n.textContent.includes('Adattamenti di Homun') && n.textContent.includes('Adatta gli esempi al paese')`)) === true)

  // ============ 3. Aggiungi per il SOLO bot Alfa ============
  // il PRIMO interruttore è «Tutti i bot» (si spegne), il SECONDO è Alfa
  await r.pageEval(`
    const switches = [...document.querySelectorAll('[data-testid="skills-catalog-preview"] [role="switch"]')]
    if (switches.length < 3) throw new Error('interruttori attesi >= 3, trovati ' + switches.length)
    switches[0].click()
    return 'Tutti i bot giù'
  `)
  await sleep(250)
  await r.pageEval(`
    const switches = [...document.querySelectorAll('[data-testid="skills-catalog-preview"] [role="switch"]')]
    switches[1].click()
    return 'Alfa acceso'
  `)
  await sleep(250)
  await clickTestId(r, 'skills-catalog-add')
  const added = await (async () => {
    for (let i = 0; i < 40; i++) {
      const lib = await r.rpc('skillsLibrary()')
      const hit = lib.library.find((s) => s.name === 'con-argomenti')
      if (hit) return hit
      await sleep(500)
    }
    return null
  })()
  check('3·in libreria: cartella = id, source github, origin col catalogId e il commit fissato',
    Boolean(added && added.source === 'github' && added.origin?.catalogId === 'con-argomenti' && added.origin?.commit === COMMIT_A),
    JSON.stringify(added ? { s: added.source, cat: added.origin?.catalogId, c: added.origin?.commit?.slice(0, 8) } : null))
  check('3·«Bot che la usano» è SOLO Alfa', Boolean(added && JSON.stringify(added.enabledFor) === JSON.stringify([ALFA])), JSON.stringify(added?.enabledFor))
  check('3·le note per Homun vivono nella voce (e il disco NON le ha)',
    Boolean(added?.homunNotes?.includes('Adatta gli esempi')) && !readFileSync(join(DATA, 'skills', 'con-argomenti', 'SKILL.md'), 'utf8').includes('Adatta gli esempi'))
  check('3·la skill resta «di terzi»: imported nel `/` di Alfa',
    (await r.rpc(`skillsInvocable(${JSON.stringify(ALFA)})`)).some((s) => s.name === 'con-argomenti' && s.imported === true))
  check('3·il `/` di Beta NON la vede (solo Alfa)',
    !(await r.rpc(`skillsInvocable(${JSON.stringify(BETA)})`)).some((s) => s.name === 'con-argomenti'))
  // la riga del catalogo ora dice «Aggiunta»
  await closeSkillsWindow(r)
  await openSkillsFromMenu(r)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')`, 8000)
  check('3·la riga del catalogo mostra «Aggiunta»',
    (await r.pageEval(`return document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')?.textContent.includes('Aggiunta')`)) === true)
  await closeSkillsWindow(r)

  // ============ 5 (prima parte). una voce invocation 'user' ============
  // si installa dalla finestra, poi: FUORI dal system prompt, RIFIUTATA dal
  // tool skill, funzionante col `/`
  await openSkillsFromMenu(r)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-entry-domanda-attenta"]')`, 8000)
  check('5·la voce «solo con /» è marcata nella sua anteprima',
    true)
  await clickText(r.pageEval, 'Domanda attenta', '[data-testid^="skills-catalog-entry-"]')
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-preview"]')`, 30_000)
  await waitForPreviewLoaded(r)
  check('5·l\'anteprima la dichiara «solo con /»',
    (await r.pageEval(`return ${SKILLS_WINDOW}.textContent.includes('solo con /')`)) === true)
  await clickTestId(r, 'skills-catalog-add')
  await (async () => {
    for (let i = 0; i < 40; i++) {
      const lib = await r.rpc('skillsLibrary()')
      if (lib.library.some((s) => s.name === 'domanda-attenta')) return
      await sleep(500)
    }
  })()
  const domEntry = (await r.rpc('skillsLibrary()')).library.find((s) => s.name === 'domanda-attenta')
  check('5·installata con invocation \'user\' e le sue note',
    Boolean(domEntry?.invocation === 'user' && domEntry?.homunNotes?.includes('solo se l\'utente')),
    JSON.stringify({ inv: domEntry?.invocation, note: Boolean(domEntry?.homunNotes) }))
  await closeSkillsWindow(r)

  // ============ 4. un turno /voce testo: corpo, note in coda, $ARGUMENTS ============
  await r.pageEval(`document.querySelector('form textarea')?.focus(); return 'focus'`)
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, '/con-argo')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'scritto /con-argo'
  `)
  check('4·l\'elenco `/` del compositore propone la voce installata',
    await r.waitDom(`!!document.querySelector('[data-testid="slash-picker"]') && document.querySelector('[data-testid="slash-picker"]').textContent.includes('/con-argomenti')`, 5000))
  await composerKey(r.pageEval, 'Enter')
  await sleep(300)
  pushText('Fatto.')
  const reqs0 = chatRequests.length
  await r.pageEval(`
    const ta = document.querySelector('form textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ta.value + 'riscrivi questo testo')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((res) => setTimeout(res, 150))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return 'inviato'
  `)
  for (let i = 0; i < 40 && chatRequests.length <= reqs0; i++) await sleep(500)
  const lastReq = chatRequests.at(-1)
  const sys = (lastReq?.messages ?? []).find((m) => m.role === 'system')
  const lastUser = (lastReq?.messages ?? []).filter((m) => m.role === 'user').at(-1)
  const content = String(lastUser?.content ?? '')
  // 5 (seconda parte): il system prompt
  check('5·system prompt: la voce NORMALE c\'è, quella «solo con /» NO (K6)',
    Boolean(sys && String(sys.content).includes('- con-argomenti:') && !String(sys.content).includes('domanda-attenta')),
    'sys contiene con-argomenti: ' + String(sys?.content ?? '').includes('- con-argomenti:'))
  check('4·il corpo della skill è nel turno (istruzioni + regola ferrea)',
    content.includes('The user invoked the skill "con-argomenti"') && content.includes('Regola ferrea: non inventare nulla.'))
  check('4·$ARGUMENTS sostituito col testo dopo il nome (e $1 la prima parola)',
    content.includes('Riscrivi il testo: riscrivi questo testo') && content.includes('Prima parola: riscrivi') && !content.includes('$ARGUMENTS'),
    content.slice(0, 130))
  check('4·le note per Homun in coda al corpo (dopo le istruzioni, prima di ---)',
    content.includes('## Notes for Homun\nAdatta gli esempi al paese') && content.indexOf('Regola ferrea') < content.indexOf('## Notes for Homun') && content.indexOf('## Notes for Homun') < content.lastIndexOf('---'))
  check('4·il resto del messaggio dopo ---',
    content.includes('---\nriscrivi questo testo'))

  // 5 (terza parte): il tool skill la RIFIUTA
  pushTool('skill', { name: 'domanda-attenta' })
  pushText('Ok, capito.')
  const reqs1 = chatRequests.length
  await uiSend(r.pageEval, 'carica la skill domanda-attenta')
  for (let i = 0; i < 40 && chatRequests.length <= reqs1; i++) await sleep(500)
  const refusal = await (async () => {
    for (let i = 0; i < 30; i++) {
      const entries = await r.rpc(`getEntries(${JSON.stringify(bot.id)})`)
      const hit = entries.reverse().find((e) => e.kind === 'tool-result' && String(e.content).includes('This skill runs only when the user invokes it with /name.'))
      if (hit) return hit
      await sleep(500)
    }
    return null
  })()
  check('5·il tool skill la RIFIUTA con l\'errore chiaro in inglese', Boolean(refusal),
    String(refusal?.content ?? '').slice(0, 90))
  // 5 (quarta parte): il `/domanda-attenta` FUNZIONA
  pushText('Tre domande fatte.')
  const reqs2 = chatRequests.length
  await uiSend(r.pageEval, '/domanda-attenta verifica la risposta di prima')
  for (let i = 0; i < 40 && chatRequests.length <= reqs2; i++) await sleep(500)
  const domUser = (chatRequests.at(-1)?.messages ?? []).filter((m) => m.role === 'user').at(-1)
  check('5·il `/domanda-attenta` dell\'utente FUNZIONA come sempre (col corpo)',
    Boolean(domUser && String(domUser.content).includes('The user invoked the skill "domanda-attenta"') && String(domUser.content).includes('Fai tre domande')),
    String(domUser?.content ?? '').slice(0, 90))

  // ============ 6. «Aggiornamento disponibile» col secondo catalogo ============
  // il repository VA AVANTI (commit B: SKILL.md nuovo + un file ammesso) e il
  // catalogo finto cambia commit (e note)
  writeFileSync(join(CON, 'SKILL.md'),
    '---\nname: con-argomenti\ndescription: riscrive un testo col tono giusto (v2)\nlicense: MIT\n---\nRiscrivi il testo: $ARGUMENTS\nRegola ferrea v2: non inventare mai nulla.')
  writeFileSync(join(CON, 'references', 'nuovo.md'), '# Guida nuova')
  execSync('git add -A && git commit -qm B', { cwd: REPO })
  const COMMIT_B = shaOf('HEAD')
  writeFileSync(CATALOG_FILE, catalogJson(COMMIT_B, ' In italiano guarda gli equivalenti.'))
  log('secondo catalogo finto al commit', COMMIT_B.slice(0, 8))
  await sleep(400)
  await openSkillsFromMenu(r)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')`, 8000)
  check('6·la riga mostra «Aggiornamento disponibile»',
    (await r.pageEval(`return document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')?.textContent.includes('Aggiornamento disponibile')`)) === true)
  await clickText(r.pageEval, 'Con argomenti', '[data-testid^="skills-catalog-entry-"]')
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-preview"]')`, 30_000)
  await waitForPreviewLoaded(r)
  check('6·l\'anteprima mostra la sezione «Aggiornamento disponibile»',
    (await r.pageEval(`return ${SKILLS_WINDOW}.textContent.includes('Aggiornamento disponibile')`)) === true)
  await clickTestId(r, 'skills-catalog-update-preview')
  check('6·il diff: vecchio commit → nuovo (B), file aggiunto references/nuovo.md',
    await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-update-diff"]') && ${SKILLS_WINDOW}.textContent.includes(${JSON.stringify(COMMIT_A.slice(0, 8))}) && ${SKILLS_WINDOW}.textContent.includes(${JSON.stringify(COMMIT_B.slice(0, 8))}) && ${SKILLS_WINDOW}.textContent.includes('references/nuovo.md')`, 30_000))
  await clickTestId(r, 'skills-catalog-update-apply')
  const updated = await (async () => {
    for (let i = 0; i < 40; i++) {
      const lib = await r.rpc('skillsLibrary()')
      const hit = lib.library.find((s) => s.name === 'con-argomenti')
      if (hit?.origin?.commit === COMMIT_B) return hit
      await sleep(500)
    }
    return null
  })()
  check('6·l\'aggiornamento porta il commit NUOVO e le note NUOVE del catalogo',
    Boolean(updated && updated.origin?.commit === COMMIT_B && updated.homunNotes?.includes('equivalenti')),
    JSON.stringify(updated ? { c: updated.origin?.commit?.slice(0, 8), note: updated.homunNotes?.slice(-40) } : null))
  check('6·il disco: SKILL.md nuovo, il file aggiunto, la versione VECCHIA conservata',
    readFileSync(join(DATA, 'skills', 'con-argomenti', 'SKILL.md'), 'utf8').includes('Regola ferrea v2')
      && existsSync(join(DATA, 'skills', 'con-argomenti', 'references', 'nuovo.md'))
      && readdirSync(join(DATA, 'skills', 'con-argomenti', '.versions')).some((f) => f.endsWith('.md')))
  check('6·le esclusioni restano: niente evals/ né examples/',
    !existsSync(join(DATA, 'skills', 'con-argomenti', 'evals')) && !existsSync(join(DATA, 'skills', 'con-argomenti', 'examples')))
  await closeSkillsWindow(r)
  await openSkillsFromMenu(r)
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')`, 8000)
  check('6·la riga ora dice solo «Aggiunta» (più niente aggiornamento)',
    (await r.pageEval(`const t = document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')?.textContent ?? ''; return t.includes('Aggiunta') && !t.includes('Aggiornamento disponibile')`)) === true)

  // ============ 7. catture: 1440 e 900, chiaro e scuro ============
  // «niente sporge»: controllo sul DOM (le catture si guardano in locale):
  // il contenuto della finestra e la pagina non scrollano in LARGHEZZA
  const nothingSticksOut = async () => {
    const m = await r.pageEval(`return (() => {
      const content = document.querySelector('[data-testid="skills-content"]')
      const dialog = document.querySelector('[data-testid="skills-window"]')
      return {
        content: content ? { scroll: content.scrollWidth, client: content.clientWidth } : null,
        page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
        dialogRight: dialog ? dialog.getBoundingClientRect().right : null,
        inner: window.innerWidth
      }
    })()`)
    return Boolean(m.content && m.content.scroll <= m.content.client + 1
      && m.page.scroll <= m.page.client + 1 && m.dialogRight !== null && m.dialogRight <= m.inner + 1)
  }
  await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-catalog-entry-con-argomenti"]')`)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await scrollIntoView(r.pageEval, `document.querySelector('[data-testid="skills-catalog-category-work"]')`)
    await sleep(300)
    await r.shot(`catalogo-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
    check(`7·catalogo a ${w} ${dark ? 'scuro' : 'chiaro'}: niente sporge (DOM)`, await nothingSticksOut())
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
  await clickText(r.pageEval, 'Con argomenti', '[data-testid^="skills-catalog-entry-"]')
  await r.waitDom(`!!document.querySelector('[data-testid="skills-catalog-preview"]')`, 20_000)
  await waitForPreviewLoaded(r)
  for (const [w, dark] of [[1440, false], [1440, true], [900, false], [900, true]]) {
    await r.setWindowWidth(w)
    await setDark(r.pageEval, dark)
    await sleep(300)
    await r.shot(`anteprima-${w}-${dark ? 'scuro' : 'chiaro'}.png`)
    check(`7·anteprima a ${w} ${dark ? 'scuro' : 'chiaro'}: niente sporge (DOM)`, await nothingSticksOut())
  }
  await setDark(r.pageEval, false)
  await r.setWindowWidth(1440)
  await closeSkillsWindow(r)
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  try { console.error(main.getLog().slice(-1200)) } catch { /* niente log */ }
} finally {
  main?.stop()
  await sleep(800)
  await stopProbeDaemons('sandbot-fase-skill-catalogo')
  for (const dir of usedDirs) await stopDaemon(dir)
}

// ============================ chiusura ============================
const { found, closed, left } = await stopProbeDaemons('sandbot-fase-skill-catalogo')
if (left > 0) {
  failures++
  console.error('[sonda] daemon rimasti vivi dopo la chiusura (dall\'ambiente):\n' + findProbeDaemons('sandbot-fase-skill-catalogo').map((d) => d.line).join('\n'))
} else {
  console.log(`[sonda] NESSUN daemon vivo (ps eww: ${found} trovati, ${closed} chiusi)`)
}
try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
try { rmSync(REPO, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
if (failures === 0 && !process.env.PROBE_KEEP) {
  for (const entry of readdirSync(TMP_BASE).filter((f) => f.startsWith('sandbot-fase-skill-catalogo-') || f.startsWith('sandbot-skillcat-repo-'))) {
    try { rmSync(TMP_BASE + entry, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  }
} else {
  console.log('[sonda] cartelle di prova conservate (PROBE_KEEP o fallimenti)')
}
console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
console.log(`catture in ${SHOTS}`)
process.exit(failures ? 1 : 0)
