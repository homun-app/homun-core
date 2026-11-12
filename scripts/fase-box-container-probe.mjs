#!/usr/bin/env node
// Sonda Electron della fase box-container (BX5). L'app VERA (build di
// sviluppo in out/) su cartella dati TEMPORANEA (mkdtemp), guidata via CDP;
// il motore del box è Apple container con la CLI FINTA scripts/fake-container.mjs
// (SANDBOT_TEST_USER_DATA + SANDBOT_TEST_CONTAINER_CLI: il motore la usa al
// posto della vera SOLO in questo modo). Copre:
//   - Impostazioni › «Computer dei bot» nei QUATTRO stati della CLI finta
//     (not-installed, stopped, kernel-missing, ready): il testo in parole e
//     i bottoni/link giusti per ciascuno;
//   - «Spazio su disco» con le dimensioni FINTE del df della CLI finta;
//   - «Libera spazio» → la CLI finta riceve SOLO comandi di pulizia sicura;
//   - «Rimuovi» l'immagine → riceve lo STOP e la DELETE DELL'IMMAGINE,
//     MAI la delete dei volumi;
//   - «Elimina i file dei bot» → dopo la conferma, la DELETE dei volumi.
// Nessun motore vero, nessun download, nessuna rete fuori da 127.0.0.1 (il
// provider non serve: nessun turno di modello). A fine OGNI giro l'app si
// chiude E il daemon di sviluppo pure (stopProbeDaemons); la cartella dati
// si rimuove. Mai il Portachiavi vero, mai i dati veri dell'utente.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const PREFIX = 'sandbot-fase-box-container-'
const TMP = mkdtempSync(`/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/${PREFIX}`)
const SHOTS = join(ROOT, 'docs', 'catture', 'box-container')
mkdirSync(SHOTS, { recursive: true })

// la CLI finta come wrapper ESEGUIBILE nel TMP: il PATH del daemon è minimo
// (niente node), quindi lo shebang `env node` non partirebbe — il wrapper
// invoca il node ESPPLICITO (process.execPath) con la fake .mjs
const FAKE_SRC = join(ROOT, 'scripts', 'fake-container.mjs')
const FAKE_CLI = join(TMP, 'container')
writeFileSync(FAKE_CLI, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SRC}" "$@"\n`)
chmodSync(FAKE_CLI, 0o755)

const log = (...a) => console.log('[sonda]', ...a)

/**
 * Chiude l'app E l'aspetta davvero: SIGTERM, 3 s, poi SIGKILL. Un'app viva
 * RISPAWNA il suo daemon (ensureConnected) anche dopo che stopProbeDaemons
 * l'ha chiuso — la fuga si chiude solo chiudendo l'app per davvero.
 */
const stopAppHard = async (proc) => {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const gone = new Promise((r) => proc.once('exit', r))
  try { proc.kill('SIGTERM') } catch { return }
  const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* già via */ } }, 3_000)
  await Promise.race([gone, sleep(5_000)])
  clearTimeout(killer)
}

/** Le app residue delle corse precedenti (env della sonda + porta di debug): si chiudono PRIMA di partire. */
const stopProbeApps = async () => {
  const out = spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const pids = (out.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes('--remote-debugging-port=93') && line.includes(PREFIX) && !line.includes('--homun-daemon'))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  if (!pids.length) return 0
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* già via */ } }
  await sleep(2500)
  for (const pid of pids) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* già via */ }
  }
  return pids.length
}

let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Il log degli argv ricevuti dalla CLI finta (una riga JSON per chiamata). */
const readCliLog = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv)
  } catch {
    return []
  }
}

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT_BASE = 9366

/** Lancia l'app in una modalità della CLI finta; torna {app, stop, cliLog}. */
const launchApp = (mode, giro) => {
  const dataDir = join(TMP, `data-${mode}`)
  mkdirSync(join(dataDir, 'data'), { recursive: true })
  // come fase-impostazioni-probe: provider FINTI pre-seminati perché la
  // autodiscovery non parli con Ollama/LM Studio VERI del Mac (se ci sono)
  const db = new DatabaseSync(join(dataDir, 'data', 'sandbot.db'))
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(
    'providers',
    JSON.stringify([{ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', enabled: true }])
  )
  // i giri degli STATI del motore Apple girano col selettore ESPLICITO su
  // apple-container: in auto, su un Mac dove Docker risponde, la scelta
  // giusta è docker (e la riga lo dice — lo provano i test dell'auto);
  // solo il giro ready lascia 'auto' (apple pronto vince su docker)
  if (mode !== 'ready') {
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('sandbox.engine', '"apple-container"')
  }
  db.close()
  const cliLogFile = join(TMP, `cli-${mode}-${giro}.jsonl`)
  try { rmSync(cliLogFile) } catch { /* nuovo giro */ }
  let appLog = ''
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT_BASE + giro}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: dataDir,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
      // BX5.2: il motore usa la CLI finta SOLO con queste due variabili
      SANDBOT_TEST_CONTAINER_CLI: FAKE_CLI,
      SANDBOT_TEST_CONTAINER_MODE: mode,
      SANDBOT_TEST_CONTAINER_LOG: cliLogFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return {
    proc,
    dataDir,
    cliLogFile,
    getAppLog: () => appLog,
    stop: () => stopAppHard(proc)
  }
}

// ---- CDP ----
const httpJson = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json()))
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
    }),
    close: () => { try { sock.close() } catch { /* già chiusa */ } }
  }
}
async function waitForPage(port, predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const list = await httpJson(port, '/json/list')
      const target = list.find((t) => t.type === 'page' && predicate(t))
      if (target) return await openCdp(target.webSocketDebuggerUrl)
    } catch { /* il debugger non è ancora su */ }
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}
const pageEval = async (page, expr) => {
  const r = await page.send('Runtime.evaluate', {
    expression: `((async () => { ${expr} })())`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
  return r?.result?.value
}
const waitDom = async (page, exprTrue, timeoutMs = 30_000, step = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pageEval(page, `return !!(${exprTrue})`).catch(() => false)) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}
/** fase onboarding-a: al primo avvio c'è la GUIDA a tutta finestra — la si
 *  attraversa (benvenuto → modello saltato → autorizzazioni «Chiedi prima»)
 *  per avere la shell vera con le Impostazioni; se la guida non c'è, no-op. */
const crossOnboardingGuide = async (page) => {
  if (!(await waitDom(page, `!!document.querySelector('[data-testid="guide-step-welcome"]')`, 20_000))) return true
  const click = (testid) => pageEval(page, `
    const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!el) throw new Error('elemento non trovato: ' + ${JSON.stringify(testid)})
    el.click()
    return 'cliccato'
  `)
  await click('guide-continue')
  if (!(await waitDom(page, `!!document.querySelector('[data-testid="guide-step-model"]')`, 10_000))) return false
  await click('guide-skip')
  if (!(await waitDom(page, `!!document.querySelector('[data-testid="guide-step-approvals"]')`, 10_000))) return false
  // le autorizzazioni si SALTANO: questa sonda semina il suo approvals.mode
  // nei dati (per esempio «never») e la guida non deve sovrascriverlo
  await click('guide-skip')
  return waitDom(page, `!!document.querySelector('form textarea')`, 20_000)
}

/** Apre le Impostazioni con ⌘, (input TRUSTED) e aspetta la colonna delle sezioni. */
const openSettings = async (page) => {
  const NAV = `!!document.querySelector('[role="dialog"] nav button')`
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 4 })
    if (await waitDom(page, NAV, 5000)) return true
  }
  return false
}
const shot = (page, name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
})

/** Il testo della riga di stato del motore (+ i bottoni visibili della riga). */
const engineFacts = (page) => pageEval(page, `return (() => {
  const sec = document.querySelector('[data-testid="engine-section"]')
  if (!sec) return null
  const txt = sec.querySelector('[data-testid="engine-status-text"]')
  const btns = [...sec.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim())
  const hint = document.querySelector('[data-testid="engine-install-hint"]')
  return {
    status: txt ? txt.textContent.trim() : null,
    buttons: btns,
    hasGithubLink: !!(hint && hint.querySelector('a') && hint.querySelector('a').href.includes('github.com/apple/container/releases')),
    autoActive: btns.includes('Automatico')
  }
})()`)

/** I fatti della sezione «Spazio su disco»: righe, dimensioni, bottoni. */
const diskFacts = (page) => pageEval(page, `return (() => {
  const sec = document.querySelector('[data-testid="disk-space-section"]')
  if (!sec) return null
  const rows = [...sec.querySelectorAll('[data-testid^="disk-space-"]')].filter((el) => el.dataset.testid !== 'disk-space-section' && el.dataset.testid !== 'disk-space-error').map((el) => ({
    id: el.dataset.testid.replace('disk-space-', ''),
    text: el.querySelector('p') ? el.querySelector('p').textContent.trim() : '',
    size: el.querySelectorAll('p')[1] ? el.querySelectorAll('p')[1].textContent.trim() : '',
    disabled: el.querySelector('button') ? el.querySelector('button').disabled : null,
    action: el.querySelector('button') ? el.querySelector('button').textContent.trim() : ''
  }))
  return rows
})()`)

/** Il click del bottone di una riga (per testid della riga). */
const clickRowAction = (page, rowId) => pageEval(page, `
  const row = document.querySelector('[data-testid="disk-space-${rowId}"]')
  if (!row) return { ok: false, why: 'riga non trovata' }
  const btn = row.querySelector('button')
  if (!btn) return { ok: false, why: 'bottone non trovato' }
  if (btn.disabled) {
    const rows = [...document.querySelectorAll('[data-testid^="disk-space-"]')].map((el) => ({ id: el.dataset.testid, size: el.querySelectorAll('p')[1]?.textContent.trim() ?? '' }))
    const err = document.querySelector('[data-testid="disk-space-error"]')?.textContent?.trim() ?? ''
    return { ok: false, why: 'bottone DISABILITATO', rows, err }
  }
  btn.click()
  return { ok: true }
`)

/** Aspetta che nel log della CLI finta compaia un argv che soddisfa il predicato. */
const waitForArgv = async (cliLogFile, pred, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (readCliLog(cliLogFile).some(pred)) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}

/** Un argv che TOGLIE l'immagine del box (image delete/rm col NOSTRO tag). */
const isImageRemove = (argv) => argv[0] === 'image' && (argv[1] === 'delete' || argv[1] === 'rm') && String(argv[2] ?? '').startsWith('sandbot-box:')
/** Un argv che TOGLIE un volume (volume delete/rm). */
const isVolumeRemove = (argv) => argv[0] === 'volume' && (argv[1] === 'delete' || argv[1] === 'rm')
/** Un argv di pulizia SICURA (image prune senza -a, o builder prune). */
const isSafePrune = (argv) => (argv[0] === 'image' && argv[1] === 'prune' && !argv.includes('-a')) || (argv[0] === 'builder' && argv[1] === 'prune')

// ---- i quattro stati della CLI finta ----
const GIRI = [
  { mode: 'not-installed', expect: (f) => f.status.includes('Da installare') && f.hasGithubLink },
  { mode: 'stopped', expect: (f) => f.status.includes('Spento') && f.buttons.includes('Accendi') },
  { mode: 'kernel-missing', expect: (f) => f.status.includes('kernel') && f.buttons.includes('Installa il kernel') },
  { mode: 'ready', expect: (f) => f.status.includes('Pronto') && f.status.includes('Apple container') }
]

let app = null
try {
  // nessuna app né daemon di prove precedenti in giro (porte e carico): si
  // parte puliti — PRIMA le app, che altrimenti RISPAWNANO i loro daemon
  {
    const apps = await stopProbeApps()
    const pre = await stopProbeDaemons(PREFIX)
    if (apps > 0 || pre.found > 0) log(`pulizia iniziale: ${apps} app e ${pre.found} daemon lasciati da corse precedenti, chiusi`)
  }
  for (let giro = 0; giro < GIRI.length; giro++) {
    const { mode, expect } = GIRI[giro]
    log(`--- giro ${giro + 1}/4: CLI finta «${mode}» ---`)
    app = launchApp(mode, giro)
    const port = DEBUG_PORT_BASE + giro
    let page = await waitForPage(port, (t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
    if (!page) throw new Error(`nessuna pagina app (${mode}): log:\n${app.getAppLog().slice(-1500)}`)
    if (!(await waitDom(page, `typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile')
    if (!(await crossOnboardingGuide(page))) throw new Error(`la guida del primo avvio non si attraversa (${mode})`)
    if (!(await openSettings(page))) throw new Error(`le Impostazioni non si aprono (${mode})`)

    // la riga «Computer dei bot»: testo e azioni dello stato
    if (!(await waitDom(page, `!!document.querySelector('[data-testid="engine-status-text"]') && document.querySelector('[data-testid="engine-status-text"]').textContent.trim().length > 3`, 25_000))) {
      check(`BX5 ${mode}: la riga «Computer dei bot» esiste e dice lo stato`, false, 'testo mancante')
    } else {
      // la sonda del daemon può metterci un attimo: si aspetta che il testo
      // diventi STABILE su uno degli stati attesi
      let f = null
      for (let i = 0; i < 40; i++) {
        f = await engineFacts(page)
        if (f && f.status !== 'Sto guardando…' && !/checking/i.test(f.status ?? '')) break
        await sleep(500)
      }
      check(`BX5 ${mode}: la riga «Computer dei bot» dice lo stato giusto in parole`, !!f && expect(f), JSON.stringify(f))
      check(`BX5 ${mode}: il selettore mostra Automatico/Apple container/Docker`, f?.autoActive === true, `bottoni: ${JSON.stringify(f?.buttons)}`)
    }
    await shot(page, `engine-${mode}.png`)
    page.close()
    await app.stop()
    await sleep(1200)
    const d = await stopProbeDaemons(PREFIX)
    log(`daemon dopo ${mode}: ${d.found} trovati, ${d.closed} chiusi, ${d.left} rimasti`)
  }

  // ---- il giro READY completo: Spazio su disco + le tre azioni ----
  log('--- giro 5/5: le azioni di «Spazio su disco» (CLI finta pronta) ---')
  const giro = 4
  app = launchApp('ready', giro)
  const port = DEBUG_PORT_BASE + giro
  let page = await waitForPage(port, (t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
  if (!page) throw new Error('nessuna pagina app (ready-azioni): log:\n' + app.getAppLog().slice(-1500))
  if (!(await waitDom(page, `typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile')
  if (!(await crossOnboardingGuide(page))) throw new Error('la guida del primo avvio non si attraversa (ready-azioni)')
  if (!(await openSettings(page))) throw new Error('le Impostazioni non si aprono (ready-azioni)')
  if (!(await waitDom(page, `!!document.querySelector('[data-testid="disk-space-section"]')`, 25_000))) {
    throw new Error('la sezione «Spazio su disco» non compare')
  }
  // le dimensioni FINTE del df della CLI finta
  let rows = null
  for (let i = 0; i < 40 && !rows; i++) {
    const r = await diskFacts(page)
    if (r && r.some((x) => x.size && x.size !== '—')) rows = r
    else await sleep(500)
  }
  const by = Object.fromEntries((rows ?? []).map((r) => [r.id, r]))
  const daemonTail = () => { try { return readFileSync(join(app.dataDir, 'data', 'daemon.log'), 'utf8').slice(-1500) } catch { return '(niente daemon.log)' } }
  check('BX5 Spazio su disco: le CINQUE righe ci sono', (rows ?? []).length === 5, JSON.stringify((rows ?? []).map((r) => r.id)) + '\ndaemon.log:\n' + daemonTail())
  check('BX5 le dimensioni finte del df: immagine 1.2 GB, file dei bot 315 MB, recuperabile 1.2 GB',
    by['box-image']?.size === '1.2 GB' && by['box-files']?.size === '315 MB' && by.reclaimable?.size === '1.2 GB',
    `immagine=${by['box-image']?.size} file=${by['box-files']?.size} recuperabile=${by.reclaimable?.size}`)
  check('BX5 senza modelli installati le righe modello restano senza dimensione (bottone spento)',
    by.model?.size === '—' && by.model?.disabled === true && by['memory-model']?.size === '—' && by['memory-model']?.disabled === true,
    `model=${by.model?.size}/${by.model?.disabled} memoria=${by['memory-model']?.size}/${by['memory-model']?.disabled}`)

  // le conferme si accettano tutte (il testo giusto lo provano i test del renderer)
  await pageEval(page, 'window.confirm = () => true; return true')

  // «Libera spazio»: SOLO pulizia sicura
  {
    const cliLog = app.cliLogFile
    const before = readCliLog(cliLog).length
    void before
    const clicked = await clickRowAction(page, 'reclaimable')
    check('BX5 «Libera spazio» si può cliccare (riga recuperabile attiva)', clicked?.ok === true, String(clicked?.why ?? ''))
    const got = await waitForArgv(cliLog, isSafePrune)
    const all = readCliLog(cliLog)
    check('BX5 «Libera spazio» → la CLI finta riceve SOLO pulizia sicura (prune)', got === true, JSON.stringify(all.slice(-4)))
    check('BX5 «Libera spazio» NON tocca né l\'immagine né i volumi', !all.some(isImageRemove) && !all.some(isVolumeRemove), 'nessun image delete / volume delete nel log')
    await waitDom(page, `!!document.querySelector('[data-testid="disk-space-reclaimable"]')`, 5000).catch(() => undefined)
  }

  // «Rimuovi» l'immagine: STOP + DELETE DELL'IMMAGINE, MAI i volumi
  {
    const cliLog = app.cliLogFile
    const clicked = await clickRowAction(page, 'box-image')
    check('BX5 «Rimuovi» l\'immagine si può cliccare', clicked?.ok === true, String(clicked?.why ?? ''))
    const gotRemove = await waitForArgv(cliLog, isImageRemove)
    const all = readCliLog(cliLog)
    const gotStop = all.some((argv) => argv[0] === 'stop' && argv[1] === 'sandbot-box')
    check('BX5 «Rimuovi» l\'immagine → STOP del box e DELETE dell\'immagine (col NOSTRO tag)', gotRemove && gotStop, JSON.stringify(all.filter((a) => a[0] === 'stop' || a[0] === 'image').slice(-4)))
    check('BX5 «Rimuovi» l\'immagine NON tocca i volumi', !all.some(isVolumeRemove), 'nessun volume delete nel log')
  }

  // «Elimina i file dei bot»: CONFERMA e poi la DELETE dei volumi
  {
    const cliLog = app.cliLogFile
    const clicked = await clickRowAction(page, 'box-files')
    check('BX5 «Elimina i file dei bot» si può cliccare', clicked?.ok === true, String(clicked?.why ?? ''))
    const gotVolume = await waitForArgv(cliLog, (argv) => isVolumeRemove(argv) && argv.includes('sandbot-box'))
    const all = readCliLog(cliLog)
    const gotRm = all.some((argv) => (argv[0] === 'rm' || argv[0] === 'delete') && argv.includes('sandbot-box'))
    check('BX5 «Elimina i file dei bot» → rimozione del container e DELETE del volume del box', gotVolume && gotRm, JSON.stringify(all.filter((a) => a[0] === 'rm' || a[0] === 'volume').slice(-4)))
  }

  await shot(page, 'spazio-dopo-azioni.png')
  page.close()

  // ---- BR (fase box-rete): la rete del box — none ISOLATA e VERIFICATA, e il cambio che RICREA ----
  // Tre giri con la sandbox PILOTA (sandbox.mode=box, motore apple-container,
  // rete scelta nel DB) e un TURNO VERO del bot (provider finto su 127.0.0.1):
  // la CLI finta ricorda container e reti NEL SUO LOG, quindi il giro 2 vede
  // il box nato bridge del giro 1 e lo RICREA su homun-box-isolated.
  log('--- BR: la rete del box (none isolata, cambio che ricrea) ---')
  const chatRequests = []
  const replies = []
  const providerServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        chatRequests.push(JSON.parse(body))
        const next = replies.shift() ?? { text: 'ok' }
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
  const pushTool = (name, args) => replies.push({ toolCalls: [{ name, arguments: args }] })
  const pushText = (text) => replies.push({ text })

  /** L'app col box PILOTATO: settings seminati nel DB, log della CLI finta scelto, env extra a piacere. */
  const launchBoxApp = (giro, opts) => {
    const dataDir = join(TMP, `data-br-${giro}`)
    mkdirSync(join(dataDir, 'data'), { recursive: true })
    const db = new DatabaseSync(join(dataDir, 'data', 'sandbot.db'))
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(
      'providers',
      JSON.stringify([{ id: 'finto', name: 'Finto (locale)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'k', enabled: true }])
    )
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('sandbox.engine', '"apple-container"')
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('sandbox.mode', '"box"')
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('sandbox.network', JSON.stringify(opts.network))
    // i turni della sonda non chiedono approvazioni: si scrive un FILE del
    // bot (nessun comando da approvare, nessun output da aspettare)
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('approvals.mode', '"never"')
    db.close()
    const cliLogFile = opts.cliLogFile
    let appLog = ''
    const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT_BASE + giro}`], {
      cwd: ROOT,
      env: {
        HOME: process.env.HOME,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        SANDBOT_TEST_USER_DATA: dataDir,
        SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
        SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
        SANDBOT_TEST_CONTAINER_CLI: FAKE_CLI,
        SANDBOT_TEST_CONTAINER_MODE: 'ready',
        SANDBOT_TEST_CONTAINER_LOG: cliLogFile,
        ...(opts.extraEnv ?? {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc.stdout.on('data', (d) => { appLog += d.toString() })
    proc.stderr.on('data', (d) => { appLog += d.toString() })
    return { proc, dataDir, cliLogFile, getAppLog: () => appLog, stop: () => { try { proc.kill('SIGTERM') } catch { /* già via */ } } }
  }

  /** Apre l'app, collega il bot al provider finto e MANDA un messaggio in chat. */
  const boxTurn = async (giro, opts, userText, replyWhen) => {
    app = launchBoxApp(giro, opts)
    const port = DEBUG_PORT_BASE + giro
    const page = await waitForPage(port, (t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
    if (!page) throw new Error(`nessuna pagina app (BR giro ${giro}): log:\n${app.getAppLog().slice(-1500)}`)
    if (!(await waitDom(page, `typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile (BR)')
    const rpc = (callExpr) => pageEval(page, `return await window.sandbot.${callExpr}`)
    // fase onboarding-a: la guida del primo avvio va attraversata anche qui
    if (!(await crossOnboardingGuide(page))) throw new Error('la guida del primo avvio non si attraversa (BR)')
    if (await waitDom(page, `!!document.querySelector('[data-testid="focus-dismiss"]')`, 8_000)) {
      await pageEval(page, `document.querySelector('[data-testid="focus-dismiss"]').click(); return 'chiusa'`)
    }
    const agents = await rpc('listAgents()')
    if (!agents?.[0]) throw new Error('nessun bot (BR)')
    await rpc(`updateAgent(${JSON.stringify(agents[0].id)}, ${JSON.stringify({ providerId: 'finto', model: 'finto' })})`)
    await page.send('Page.reload')
    if (!(await waitDom(page, `!!document.querySelector('form textarea')`, 25_000))) throw new Error('compositore non pronto (BR)')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, mobile: false, deviceScaleFactor: 2 })
    await sleep(700)
    await pageEval(page, `
      const ta = document.querySelector('form textarea')
      if (!ta) throw new Error('compositore non trovato')
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, ${JSON.stringify(userText)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'inviato'
    `)
    // la risposta del bot chiude il turno (il testo atteso arriva col reply scriptato)
    const seen = await waitDom(page, `[...document.querySelectorAll('div')].some((d) => d.textContent.trim() === ${JSON.stringify(replyWhen)})`, 60_000)
    if (!seen) {
      const chatText = await pageEval(page, `return document.body.innerText.slice(0, 1200)`).catch(() => '(chat illeggibile)')
      throw new Error(`la risposta del bot non è arrivata (BR giro ${giro}) — richieste al provider: ${chatRequests.length}; chat:\n${chatText}\n--- log app:\n${app.getAppLog().slice(-1200)}`)
    }
    await sleep(600)
    return page
  }

  // BR-A: il box nasce in BRIDGE (stato nel log della CLI finta)
  const brLog = join(TMP, 'cli-br.jsonl')
  try { rmSync(brLog) } catch { /* nuovo giro */ }
  {
    pushTool('write-file', { path: 'rete-prova-bridge.txt', content: 'bridge' })
    pushText('Fatto in bridge.')
    const page = await boxTurn(10, { network: 'bridge', cliLogFile: brLog }, 'Scrivi il file rete-prova-bridge.txt', 'Fatto in bridge.')
    const log = readCliLog(brLog)
    const run = log.find((a) => a[0] === 'run' && a.includes('-d'))
    check('BR il box nasce in bridge sulla rete homun-box', !!run && run[run.indexOf('--network') + 1] === 'homun-box', JSON.stringify(run?.slice(0, 10)))
    check('BR in bridge NESSUN --no-dns e nessun isolamento', !run.includes('--no-dns') && !log.some((a) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0'), 'bridge non isola')
    const hasPath = (argv, name) => argv.some((x) => typeof x === 'string' && x.includes(name))
    check('BR la scrittura del bot è girata nel box', log.some((a) => a[0] === 'exec' && hasPath(a, 'rete-prova-bridge.txt')), 'nessun exec di scrittura')
    await shot(page, 'br-box-bridge-turno.png')
    page.close()
  }
  await app.stop()
  await sleep(1200)
  await stopProbeDaemons(PREFIX)

  // BR-B: si passa a NONE a app RIAPERTA (stesso log): il box bridge si RICREA
  // su homun-box-isolated, con link down e VERIFICA
  {
    const beforeBridge = readCliLog(brLog).length
    pushTool('write-file', { path: 'rete-prova-none.txt', content: 'none' })
    pushText('Fatto in none.')
    const page = await boxTurn(11, { network: 'none', cliLogFile: brLog }, 'Scrivi il file rete-prova-none.txt', 'Fatto in none.')
    const log = readCliLog(brLog)
    const after = log.slice(beforeBridge)
    const ricreato = after.find((a) => a[0] === 'run' && a.includes('-d'))
    check('BR5a none: il run -d porta --network homun-box-isolated --no-dns',
      !!ricreato && ricreato[ricreato.indexOf('--network') + 1] === 'homun-box-isolated' && ricreato.includes('--no-dns'),
      JSON.stringify(ricreato?.slice(0, 12)))
    check('BR5b la CLI finta registra il link down COME ROOT e la verifica operstate',
      after.some((a) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0' && (a[a.indexOf('-c') + 1] ?? '').includes('ip link set')) &&
      after.some((a) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0' && (a[a.indexOf('-c') + 1] ?? '').includes('operstate')),
      'manca il link down o la verifica')
    check('BR5c il passaggio bridge → none RICREA il box (rm del container, MAI dei volumi)',
      after.some((a) => a[0] === 'rm' && a.includes('sandbot-box')) && !after.some((a) => a[0] === 'volume' && (a[1] === 'rm' || a[1] === 'delete')),
      'rm del container atteso')
    check('BR5 la scrittura del bot gira anche nel box ISOLATO', after.some((a) => a[0] === 'exec' && a.some((x) => typeof x === 'string' && x.includes('rete-prova-none.txt'))), 'nessun exec di scrittura')
    await shot(page, 'br-bridge-none-ricreato.png')
    page.close()
  }
  await app.stop()
  await sleep(1200)
  await stopProbeDaemons(PREFIX)

  // BR-C: la VERIFICA FALLISCE (operstate = up): NESSUN box, l'errore in parole
  // nella chat del bot
  {
    const chatFrom = chatRequests.length
    const failLog = join(TMP, 'cli-br-fail.jsonl')
    try { rmSync(failLog) } catch { /* nuovo giro */ }
    pushTool('run-command', { command: 'echo non-partira' })
    pushText('Non riesco a isolare il computer del bot dalla rete: per sicurezza non l\'ho avviato.')
    const page = await boxTurn(12, { network: 'none', cliLogFile: failLog, extraEnv: { SANDBOT_TEST_CONTAINER_OPERSTATE: 'up' } }, 'Esegui echo non-partira', "Non riesco a isolare il computer del bot dalla rete: per sicurezza non l'ho avviato.")
    const log = readCliLog(failLog)
    const runAt = log.findIndex((a) => a[0] === 'run' && a.includes('-d'))
    const rmAt = log.findIndex((a) => a[0] === 'rm' && a.includes('sandbot-box'))
    // il giro usa un COMANDO vero: l'isolamento cade PRIMA di ogni exec del
    // bot, quindi il comando non deve MAI arrivare alla CLI
    check('BR5d verifica fallita: il box si è RIMOSSO (rm -f DOPO il run) e il comando NON è mai girato',
      runAt >= 0 && rmAt > runAt && !log.some((a) => a[0] === 'exec' && a.some((x) => typeof x === 'string' && x.includes('echo non-partira'))),
      `run=${runAt} rm=${rmAt}`)
    // l'errore IN PAROLE arriva al modello come risultato del tool: è la chat del bot
    const toolTexts = chatRequests
      .slice(chatFrom)
      .flatMap((r) => (r.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content)))
      .join('\n---\n')
    check('BR5e l\'errore in parole nella chat del bot («Non riesco a isolare…»)',
      toolTexts.includes('Non riesco a isolare il computer del bot dalla rete: per sicurezza non l\'ho avviato'),
      toolTexts.slice(0, 160))
    await shot(page, 'br-chat-errore-isolamento.png')
    page.close()
  }

  // ---- BRR (fase box-rete-riavvio): il box none FERMATO E RIPARTITO si
  // VERIFICA di nuovo ----
  // Il box none del giro BR-B è nel log della CLI finta, con le interfacce
  // GIÙ. Lo si FERMA (stop): il suo start sarà un BOOT NUOVO e le interfacce
  // tornano SU. Il comando del bot dopo: l'ensure del riuso VERIFICA, poi
  // link down e verifica di nuovo, e il comando GIRA.
  {
    log('--- BRR: il riavvio del box none (stop → comando del bot) ---')
    const stop = spawnSync(process.execPath, [FAKE_SRC, 'stop', 'sandbot-box'], {
      encoding: 'utf8',
      env: { ...process.env, SANDBOT_TEST_CONTAINER_MODE: 'ready', SANDBOT_TEST_CONTAINER_LOG: brLog }
    })
    if (stop.status !== 0) throw new Error(`lo stop del box non è riuscito: ${stop.stderr}`)
    const afterStop = readCliLog(brLog).length
    pushTool('write-file', { path: 'rete-prova-riavvio.txt', content: 'riavviato' })
    pushText('Fatto dopo il riavvio.')
    const page = await boxTurn(13, { network: 'none', cliLogFile: brLog }, 'Scrivi il file rete-prova-riavvio.txt', 'Fatto dopo il riavvio.')
    const after = readCliLog(brLog).slice(afterStop)
    const isRootExec = (a) => a[0] === 'exec' && a[1] === '-u' && a[2] === '0'
    const sh = (a) => (a[a.indexOf('-c') + 1] ?? '')
    const checkAt = after.map((a, i) => (isRootExec(a) && sh(a).includes('operstate') ? i : -1)).filter((i) => i >= 0)
    const downAt = after.findIndex((a) => isRootExec(a) && sh(a).includes('ip link set'))
    check('BRR il box FERMATO si RIUSA (nessun run -d nuovo, nessun rm) e il suo start è un BOOT NUOVO',
      after.some((a) => a[0] === 'start' && a.includes('sandbot-box')) && !after.some((a) => a[0] === 'run' && a.includes('-d')) && !after.some((a) => a[0] === 'rm'),
      JSON.stringify(after.filter((a) => ['start', 'run', 'rm'].includes(a[0])).map((a) => a.slice(0, 3))))
    check('BRR la verifica CADE sul boot, poi LINK DOWN e la verifica PASSA',
      downAt >= 0 && checkAt.length === 2 && checkAt[0] < downAt && checkAt[1] > downAt,
      `verifiche=${JSON.stringify(checkAt)} linkDown=${downAt}`)
    check('BRR e il comando del bot GIRA nel box riusato e ri-verificato',
      after.some((a) => a[0] === 'exec' && a.some((x) => typeof x === 'string' && x.includes('rete-prova-riavvio.txt'))),
      'nessun exec di scrittura')
    await shot(page, 'brr-riavvio-riuso-verificato.png')
    page.close()
  }
  try { providerServer.closeAllConnections?.(); providerServer.close() } catch { /* già chiusa */ }
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(app?.dataDir ?? TMP, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { await app?.stop() } catch { /* già via */ }
  await sleep(1000)
  // 0 app e 0 daemon a fine sonda (le app vive RESPAWNANO i daemon: prima loro)
  await stopProbeApps()
  const { found, closed, left } = await stopProbeDaemons(PREFIX)
  console.log(`daemon di sviluppo: ${found} trovati, ${closed} chiusi, ${left} rimasti`)
  if (left > 0) {
    failures++
    console.error('daemon rimasti:\n' + findProbeDaemons(PREFIX).map((d) => d.line).join('\n'))
  }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  process.exit(failures ? 1 : 0)
}
