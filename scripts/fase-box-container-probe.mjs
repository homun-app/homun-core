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
import { spawn } from 'node:child_process'
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
    stop: () => { try { proc.kill('SIGTERM') } catch { /* già via */ } }
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
  if (btn.disabled) return { ok: false, why: 'bottone DISABILITATO' }
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
  for (let giro = 0; giro < GIRI.length; giro++) {
    const { mode, expect } = GIRI[giro]
    log(`--- giro ${giro + 1}/4: CLI finta «${mode}» ---`)
    app = launchApp(mode, giro)
    const port = DEBUG_PORT_BASE + giro
    let page = await waitForPage(port, (t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
    if (!page) throw new Error(`nessuna pagina app (${mode}): log:\n${app.getAppLog().slice(-1500)}`)
    if (!(await waitDom(page, `typeof window.sandbot !== 'undefined'`, 40_000))) throw new Error('window.sandbot non disponibile')
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
    app.stop()
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
  check('BX5 Spazio su disco: le CINQUE righe ci sono', (rows ?? []).length === 5, JSON.stringify((rows ?? []).map((r) => r.id)))
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
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(app?.dataDir ?? TMP, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  try { app?.stop() } catch { /* già via */ }
  await sleep(1000)
  // 0 daemon a fine sonda (il controllo condiviso, dall'ambiente)
  const { found, closed, left } = await stopProbeDaemons(PREFIX)
  console.log(`daemon di sviluppo: ${found} trovati, ${closed} chiusi, ${left} rimasti`)
  if (left > 0) {
    failures++
    console.error('daemon rimasti:\n' + findProbeDaemons(PREFIX).map((d) => d.line).join('\n'))
  }
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* l'app può essere ancora viva */ }
  process.exit(failures ? 1 : 0)
}
