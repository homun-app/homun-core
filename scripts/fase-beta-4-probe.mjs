#!/usr/bin/env node
// Sonda Electron della fase beta.4 (B1). L'app VERA (build di sviluppo in
// out/) su cartella dati TEMPORANEA, guidata via CDP (nessun provider qui:
// la finestra dell'aggiornamento non parla col modello). Copre:
//   B1: la finestra dell'aggiornamento (gancio SANDBOT_TEST_USER_DATA +
//       SANDBOT_TEST_UPDATE_NOTES, senza toccare GitHub) con la fixture VERA
//       delle note beta.3, a 1470×956 e a 1280×720:
//       — i TRE bottoni (Scarica e installa · Apri le note · Più tardi) sono
//         DENTRO la finestra visibile (getBoundingClientRect dentro innerHeight);
//       — l'area delle note SCORRE;
//       — nelle note mostrate non c'è NESSUN «<» (testo semplice, mai HTML).
// A FINE SONDA si chiude ANCHE il daemon di sviluppo (il controllo condiviso
// probe-daemons, dall'ambiente), la cartella viene rimossa. Mai il Portachiavi
// vero, mai la cartella dati vera (env SANDBOT_TEST_*), niente Docker, NESSUNA
// rete (il gancio di prova non controlla GitHub), nessun push.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findProbeDaemons, stopProbeDaemons } from './lib/probe-daemons.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// Vincoli della fase: temporanei SOLO con mkdtemp nella cartella indicata
const PREFIX = 'sandbot-fase-beta-4-'
const TMP = mkdtempSync(`/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T/${PREFIX}`)
const DATA = join(TMP, 'data')
const SHOTS = join(ROOT, 'docs', 'catture', 'beta-4')
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
// la fixture VERA delle note beta.3 (copiata tale e quale nei test) fa da
// corpo della release finta del gancio di prova
const NOTES_FILE = join(TMP, 'release-notes-beta3.html')
copyFileSync(join(ROOT, 'src', 'main', '__tests__', 'fixtures', 'release-notes-beta3.html'), NOTES_FILE)

const log = (...a) => console.log('[sonda]', ...a)
let failures = 0
const checks = []
const check = (id, ok, note = '') => {
  checks.push({ id, ok, note })
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${id}${note ? ` — ${note}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- l'app Electron (build di sviluppo) con dati temporanei ----
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const DEBUG_PORT = 9352
let app = null
let appLog = ''
const launchApp = () => {
  const proc = spawn(ELECTRON, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: ROOT,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SANDBOT_TEST_USER_DATA: DATA,
      SANDBOT_TEST_FAKE_KEYCHAIN: join(DATA, 'keychain-finta.json'),
      SANDBOT_TEST_FAKE_SAFESTORAGE: join(DATA, 'safestorage-finta.json'),
      // B1: il gancio di prova — la finestra dell'offerta con la fixture beta.3
      SANDBOT_TEST_UPDATE_NOTES: NOTES_FILE
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d) => { appLog += d.toString() })
  proc.stderr.on('data', (d) => { appLog += d.toString() })
  return proc
}
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
    }),
    close: () => { try { sock.close() } catch { /* già chiusa */ } }
  }
}
/** Aspetta che esista un target pagina (app o finestra offerta) e lo apre. */
async function waitForPage(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const list = await httpJson('/json/list')
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
/** Larghezza della finestra APP emulata (il layout del renderer la vede). */
const setAppViewport = async (page, width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 2 })
  await sleep(700)
}
const shot = (page, name) => page.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  log('cattura', name)
})
const waitDom = async (page, exprTrue, timeoutMs = 30_000, step = 300) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pageEval(page, `return !!(${exprTrue})`).catch(() => false)) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}

/** B1: i controlli sulla finestra dell'offerta, a una data dimensione APP. */
async function probeUpdateWindow(appPage, width, height, tag) {
  await setAppViewport(appPage, width, height)
  // la finestra dell'offerta: la pagina data: del gancio di prova
  const offer = await waitForPage((t) => (t.url ?? '').startsWith('data:text/html'))
  if (!offer) {
    check(`B1 ${tag}: la finestra dell'offerta si apre (gancio di prova)`, false, 'nessuna pagina data: nei target')
    return
  }
  check(`B1 ${tag}: la finestra dell'offerta si apre (gancio di prova)`, true)
  await waitDom(offer, `document.getElementById('upd-notes') && document.getElementById('upd-notes').textContent.length > 100`, 15_000)
  const facts = await pageEval(offer, `return (() => {
    const inView = (id) => {
      const el = document.getElementById(id)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { id, top: Math.round(r.top), bottom: Math.round(r.bottom), innerH: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight }
    }
    const notes = document.getElementById('upd-notes')
    const cs = notes ? getComputedStyle(notes) : null
    return {
      buttons: ['upd-download', 'upd-open-notes', 'upd-later'].map(inView),
      notesLen: notes ? notes.textContent.length : 0,
      notesHasLt: notes ? notes.textContent.includes('<') : true,
      scrolls: notes ? notes.scrollHeight > notes.clientHeight : false,
      overflowY: cs ? cs.overflowY : null,
      innerW: window.innerWidth, innerH: window.innerHeight
    }
  })()`)
  const labels = { upd_download: 'Scarica e installa', upd_open_notes: 'Apri le note', upd_later: 'Più tardi' }
  for (const b of facts?.buttons ?? []) {
    check(`B1 ${tag}: bottone «${labels[b.id] ?? b.id}» DENTRO la finestra visibile`,
      b?.visible === true, `top=${b?.top} bottom=${b?.bottom} innerH=${b?.innerH}`)
  }
  check(`B1 ${tag}: l'area delle note SCORRE (contenuto più alto dell'area)`,
    facts?.scrolls === true && ['auto', 'scroll'].includes(facts?.overflowY ?? ''),
    `scrollHeight>clientHeight=${facts?.scrolls} overflow-y=${facts?.overflowY}`)
  check(`B1 ${tag}: nelle note NESSUN «<» (testo semplice, mai HTML)`,
    facts?.notesHasLt === false && (facts?.notesLen ?? 0) > 500, `caratteri=${facts?.notesLen}`)
  check(`B1 ${tag}: la finestra resta AL MASSIMO 460×520 pt`,
    (facts?.innerW ?? 9999) <= 460 && (facts?.innerH ?? 9999) <= 520, `${facts?.innerW}×${facts?.innerH}`)
  await shot(offer, `b1-finestra-aggiornamento-${tag}.png`)
  offer.close()
}

try {
  // ---- giro 1: 1470×956 (finestra app ampia) ----
  app = launchApp()
  let appPage = await waitForPage((t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
  if (!appPage) throw new Error('nessuna pagina app: log:\n' + appLog.slice(-1500))
  log('CDP collegato al renderer (giro 1)')
  if (!(await waitDom(appPage, `typeof window.sandbot !== 'undefined'`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s')
  }
  await probeUpdateWindow(appPage, 1470, 956, '1470x956')
  appPage.close()
  stopApp()
  await sleep(1200)
  const d1 = await stopProbeDaemons(PREFIX)
  log(`daemon dopo il giro 1: ${d1.found} trovati, ${d1.closed} chiusi, ${d1.left} rimasti`)

  // ---- giro 2: 1280×720 (finestra app bassa): si RIAPRE l'app ----
  app = launchApp()
  appPage = await waitForPage((t) => (t.url ?? '').startsWith('http') || (t.url ?? '').startsWith('homun://'))
  if (!appPage) throw new Error('nessuna pagina app (giro 2): log:\n' + appLog.slice(-1500))
  log('CDP collegato al renderer (giro 2)')
  if (!(await waitDom(appPage, `typeof window.sandbot !== 'undefined'`, 30_000))) {
    throw new Error('window.sandbot non disponibile dopo 30s (giro 2)')
  }
  await probeUpdateWindow(appPage, 1280, 720, '1280x720')
  appPage.close()
} catch (e) {
  failures++
  console.error('\n[sonda] ERRORE:', e.message ?? e)
  try { console.error('--- daemon.log ---\n' + readFileSync(join(DATA, 'data', 'daemon.log'), 'utf8').slice(-2500)) } catch { /* niente log */ }
  console.error(appLog.slice(-1200))
} finally {
  console.log(`\n${failures === 0 ? 'TUTTI I CONTROLLI OK' : 'CONTROLLI FALLITI'}: ${checks.filter((c) => c.ok).length}/${checks.length}`)
  console.log(`catture in ${SHOTS}`)
  stopApp()
  await sleep(800)
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
