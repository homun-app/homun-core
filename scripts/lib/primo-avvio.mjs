// Fase primo-avvio: l'app IMPACCHETTATA di prova (--dir, non firmata) su
// dati TEMPORANEI, per la riproduzione (P2) e per la sonda. Tutto quello che
// serve a lanciare una copia di Homun senza toccare né i dati veri né
// l'HOMUN DI PRODUZIONE:
//   - l'app arriva da --app=<percorso>/Homun.app (o HOMUN_TEST_APP) e DEVE
//     stare in una cartella temporanea di TMP_BASE: mai /Applications/Homun.app,
//     mai dist-installers/;
//   - i dati stanno in una mkdtemp con SANDBOT_TEST_USER_DATA (A8), con
//     Portachiavi e SafeStorage FINTI e la CLI `container` FINTA;
//   - il registro del ciclo di vita (Logs/main.log nella temporanea) si
//     legge e si divide per avvio;
//   - le finestre si guardano dal DI FUORI con window-list (Swift, sola
//     lettura, CGWindowListCopyWindowInfo): mai osascript.
import { spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * L'app impacchettata da provare: --app=<percorso>/Homun.app (o la
 * variabile HOMUN_TEST_APP). Solo una copia di prova in una temporanea.
 */
export function resolveTestApp(argv = process.argv.slice(2), env = process.env, tmpBase = TMP_BASE) {
  const given = argv.find((a) => a.startsWith('--app='))?.slice('--app='.length) ?? env.HOMUN_TEST_APP
  if (!given) {
    throw new Error('manca l\'app impacchettata da provare: --app=<percorso>/Homun.app (build --dir non firmata, in una cartella temporanea)')
  }
  const app = resolve(given)
  // PRIMA i divieti, poi l'esistenza: /Applications/Homun.app non si tocca nemmeno con uno stat
  if (app.startsWith('/Applications/') || app.includes('/dist-installers/')) {
    throw new Error(`mai /Applications/Homun.app né dist-installers: solo l'app --dir di prova (${app})`)
  }
  if (!`${app}/`.startsWith(`${tmpBase}/`)) {
    throw new Error(`l'app di prova deve stare in una cartella temporanea di ${tmpBase}: ${app}`)
  }
  const exe = join(app, 'Contents', 'MacOS', 'Homun')
  if (!existsSync(exe)) throw new Error(`non è un Homun.app: ${app}`)
  return { app, exe }
}

/** Compila window-list (sola lettura) nella cartella di lavoro della sonda. */
export function compileWindowList(workDir) {
  const bin = join(workDir, 'window-list')
  const r = spawnSync('swiftc', ['-O', join(import.meta.dirname, 'window-list.swift'), '-o', bin], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`swiftc (window-list) fallito: ${String(r.stderr ?? '').slice(0, 400)}`)
  return bin
}

/**
 * Le finestre del processo `pid` (tutte, anche fuori schermo) e gli schermi;
 * con pid 0 TUTTE le finestre a schermo, senza i nomi delle app.
 */
export function windowList(tool, pid) {
  return runTool(tool, ['windows', String(pid)])
}

/**
 * I processi del bundle di Homun e quale macOS considera ATTIVO (sola
 * lettura, NSRunningApplication). UI e daemon sono due processi dello stesso
 * bundle: se l'attivo è il daemon — che non ha finestre — quella della UI
 * resta senza fuoco e può finire dietro.
 */
export function appActivation(tool, bundleId = 'app.homun.desktop') {
  return runTool(tool, ['apps', bundleId])
}

function runTool(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8', timeout: 15_000 })
  if (r.status !== 0) throw new Error(`window-list ${args[0]} fallito: ${String(r.stderr ?? '').slice(0, 300)}`)
  return JSON.parse(r.stdout)
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/**
 * PURA: la finestra «normale» del processo che è davvero A SCHERMO — layer 0,
 * alpha > 0, onscreen, larga almeno minSide — e la frazione della sua area
 * che sta dentro uno schermo. `win` è la finestra trovata (o null).
 */
export function onScreenWindow(list, minSide = 200) {
  const candidates = (list.windows ?? [])
    .filter((w) => w.layer === 0 && w.alpha > 0 && w.onscreen === true && w.w >= minSide && w.h >= minSide)
    .sort((a, b) => b.w * b.h - a.w * a.h)
  const win = candidates[0] ?? null
  if (!win) return { win: null, inside: 0 }
  // la parte dentro gli schermi: somma delle intersezioni, campionata su una griglia
  const N = 24
  let inScreen = 0
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const px = win.x + ((i + 0.5) * win.w) / N
      const py = win.y + ((j + 0.5) * win.h) / N
      if ((list.screens ?? []).some((s) => px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h)) inScreen++
    }
  }
  return { win, inside: inScreen / (N * N) }
}

/**
 * PURA: quanta della finestra è COPERTA dalle finestre che le stanno davanti
 * (tutte le app, layer 0, a schermo). `all` è la lista completa in ordine z
 * (pid 0): 0 = nessuno la copre, 1 = completamente nascosta.
 */
export function coveredByWindowsInFront(all, win, screens = []) {
  if (!win || typeof win.z !== 'number') return 0
  const front = (all.windows ?? []).filter((w) => w.layer === 0 && typeof w.z === 'number' && w.z < win.z && overlap(w, win) > 0)
  const N = 24
  let covered = 0
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const px = win.x + ((i + 0.5) * win.w) / N
      const py = win.y + ((j + 0.5) * win.h) / N
      if (front.some((w) => px >= w.x && px < w.x + w.w && py >= w.y && py < w.y + w.h)) covered++
    }
  }
  // del desktop non si tiene conto: fuori dagli schermi non c'è niente da vedere
  void screens
  return covered / (N * N)
}

/** La CLI `container` FINTA della sonda (mai quella vera). */
export function writeFakeContainer(dir) {
  const path = join(dir, 'fake-container.sh')
  writeFileSync(path, [
    '#!/bin/sh',
    '# CLI container FINTA della sonda: niente docker, niente container vero',
    'if [ "$1" = "--version" ]; then echo "container 1.7.1-finta"; exit 0; fi',
    'echo "[]" ; exit 0'
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

/** L'ambiente dell'app di prova: dati temporanei, Portachiavi e SafeStorage finti, container finto. */
export function appEnv(dataDir, fakeContainer) {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SANDBOT_TEST_USER_DATA: dataDir,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(dataDir, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(dataDir, 'safestorage-finta.json'),
    HOMUN_CONTAINER_PATH: fakeContainer
  }
}

/**
 * Avvia l'app di prova dall'eseguibile (come tutte le sonde): il processo è
 * un figlio della sonda. Torna { pid, exited: Promise<code>, output() }.
 */
export function launchExecutable(exe, env, { debugPort } = {}) {
  const args = debugPort ? [`--remote-debugging-port=${debugPort}`, '--lang=it'] : ['--lang=it']
  const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d.toString() })
  child.stderr.on('data', (d) => { output += d.toString() })
  return {
    pid: child.pid,
    exited: new Promise((res) => child.on('exit', (code) => res(code))),
    output: () => output,
    kill: (sig) => { try { child.kill(sig) } catch { /* già via */ } }
  }
}

/**
 * Avvia l'app di prova come farebbe il Finder (o un elemento di accesso, con
 * background: true): `open` la registra in LaunchServices e la attiva. Il
 * processo NON è un figlio della sonda: il pid si trova dall'ambiente
 * (SANDBOT_TEST_USER_DATA) e l'uscita si aspetta col pid.
 */
export function launchWithOpen(app, exe, env, { debugPort, background = false } = {}) {
  const args = ['-n']
  if (background) args.push('-g')
  for (const [k, v] of Object.entries(env)) {
    if (k === 'HOME' || k === 'PATH') continue // quelli sono di sistema, come per un lancio dal Finder
    args.push('--env', `${k}=${v}`)
  }
  args.push(app, '--args', '--lang=it')
  if (debugPort) args.push(`--remote-debugging-port=${debugPort}`)
  const r = spawnSync('/usr/bin/open', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`open dell'app di prova fallito: ${String(r.stderr ?? '').slice(0, 300)}`)
  return { pid: null, exe }
}

/** Il clic sul Dock VERO: `open` all'app che già gira la riattiva (reopen). */
export function reopenWithOpen(app) {
  const r = spawnSync('/usr/bin/open', [app], { encoding: 'utf8' })
  return r.status === 0
}

/** Le righe di `ps` con l'ambiente: pid e riga di comando. */
export function processLines() {
  const out = spawnSync('/bin/ps', ['eww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return String(out.stdout ?? '').split('\n').filter(Boolean)
}

/**
 * I processi (UI e daemon) dell'app di prova che usano la cartella dati:
 * dall'AMBIENTE (SANDBOT_TEST_USER_DATA), non dagli argomenti. Solo quelli.
 */
export function findAppProcesses(dataDir, exe) {
  return processLines()
    .map((line) => ({ pid: Number(line.trim().split(/\s+/, 1)[0]), line }))
    .filter((p) => Number.isInteger(p.pid) && p.pid > 1 && p.pid !== process.pid)
    .filter((p) => p.line.includes(`SANDBOT_TEST_USER_DATA=${dataDir}`) && p.line.includes(exe))
    .map((p) => ({ pid: p.pid, daemon: p.line.includes('--homun-daemon'), main: !p.line.includes('--type=') }))
}

export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitPidGone(pid, capMs = 15_000, stepMs = 100) {
  const deadline = Date.now() + capMs
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
  return true
}

/** Aspetta che `pick()` dia un valore (o null al timeout). */
export async function waitFor(pick, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let v
    try {
      v = await pick()
    } catch {
      v = null // non ancora pronto: si riprova
    }
    if (v !== null && v !== undefined && v !== false) return v
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

// ---- il registro del ciclo di vita ----

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (\S+)(?: (.*))?$/

/** PURA: una riga del registro → { at (ms), iso, event, f: {chiave: valore} }. */
export function parseLogLine(line) {
  const m = LINE.exec(line)
  if (!m) return null
  const f = {}
  for (const part of (m[3] ?? '').split(' ')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq > 0) f[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return { at: Date.parse(m[1]), iso: m[1], event: m[2], f, raw: line }
}

export const mainLogPath = (dataDir) => join(dataDir, 'Logs', 'main.log')

export function readMainLog(dataDir) {
  const file = mainLogPath(dataDir)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { text, chars: text.length, lines: text.split('\n').filter(Boolean) }
}

/**
 * PURA: le righe di UN avvio della UI — dall'ultima riga «boot … mode=ui» in
 * poi (compresa), con in mezzo anche quelle del daemon (stesso file).
 */
export function lastUiBoot(rawLines) {
  let start = -1
  rawLines.forEach((l, i) => {
    const p = parseLogLine(l)
    if (p && p.event === 'boot' && p.f.mode === 'ui') start = i
  })
  return bootFrom(rawLines, start)
}

const bootFrom = (rawLines, start) => {
  if (start === -1) return null
  const parsed = rawLines.slice(start).map(parseLogLine).filter(Boolean)
  return { bootAt: parsed[0].at, bootPid: Number(parsed[0].f.pid), lines: parsed }
}

/**
 * Le righe dell'avvio NATO DOPO `sinceChars` (la lunghezza che il registro
 * aveva prima di lanciare): null finché la sua riga «boot … mode=ui» non è
 * scritta — così non si prende per sbaglio l'avvio di prima.
 */
export function uiBootSince(text, sinceChars) {
  const lines = text.slice(sinceChars).split('\n').filter(Boolean)
  const start = lines.findIndex((l) => {
    const p = parseLogLine(l)
    return p !== null && p.event === 'boot' && p.f.mode === 'ui'
  })
  return bootFrom(lines, start)
}

/** I ms dall'avvio della prima riga con quell'evento (o null). */
export const msOf = (boot, event, nth = 0) => {
  const hits = boot.lines.filter((l) => l.event === event)
  const l = hits[nth]
  return l ? l.at - boot.bootAt : null
}

// ---- CDP (come le altre sonde) ----

export async function httpJson(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json())
}

export async function openCdp(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => {
    sock.onopen = res
    sock.onerror = () => rej(new Error('cdp: connessione fallita'))
  })
  let id = 0
  const waits = new Map()
  sock.onmessage = (m) => {
    const v = JSON.parse(m.data)
    if (v.id && waits.has(v.id)) {
      const w = waits.get(v.id)
      waits.delete(v.id)
      if (v.error) w.rej(new Error(v.error.message))
      else w.res(v.result)
    }
  }
  return {
    sock,
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const mid = ++id
        waits.set(mid, { res, rej })
        sock.send(JSON.stringify({ id: mid, method, params }))
      })
  }
}

/** La pagina PRINCIPALE dell'App di prova (non la PiP), o null. */
export async function mainTarget(port) {
  const list = await httpJson(port, '/json/list')
  return list.find((t) => t.type === 'page' && (t.url ?? '').includes('homun://app') && !(t.url ?? '').includes('/pip/')) ?? null
}

export async function pageEval(cdp, expr, timeoutMs = 20_000) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: `((async () => { ${expr} })())`, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => {
      throw new Error('timeout Runtime.evaluate')
    })
  ])
  if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300))
  return r?.result?.value
}

// ---- il setup della prima volta: la guida si chiude (modello FINTO, un bot) ----

const sseChunk = (delta, finish) =>
  'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'finto', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'

/**
 * Il modello FINTO openai-compatible su 127.0.0.1: risponde a /models e a
 * /chat/completions con un «ok». Serve solo a chiudere la guida del primo
 * avvio (la cartella dati così com'è per l'utente: nessun turno).
 */
export async function startFakeProvider() {
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'finto' }] }))
      return
    }
    if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sseChunk({ role: 'assistant', content: 'ok' }, null))
      res.write(sseChunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

/** RPC dal renderer con retry: window.sandbot può non essere ancora esposto dal preload. */
export async function rpcOn(cdp, callExpr) {
  let last = null
  for (let i = 0; i < 10; i++) {
    try {
      return await pageEval(cdp, `if (!window.sandbot) throw new Error('preload non pronto'); return await window.sandbot.${callExpr}`)
    } catch (e) {
      last = e
      await sleep(700)
    }
  }
  throw last
}

/** True quando la chat è a schermo (il campo di scrittura): la guida è chiusa. */
export const chatIsUp = (cdp) => pageEval(cdp, 'return !!document.querySelector(\'form textarea\')').catch(() => false)

/**
 * Chiude la guida del primo avvio dal renderer (provider finto, un bot):
 * RPC con retry, finché la chat non compare.
 */
export async function closeGuide(cdp, providerPort) {
  await rpcOn(cdp, `saveProvider(${JSON.stringify({ id: 'finto', name: 'Finto locale', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${providerPort}/v1`, enabled: true })})`)
  await rpcOn(cdp, `settingsSet(${JSON.stringify('models.main')}, ${JSON.stringify({ providerId: 'finto', model: 'finto', thinking: null })})`)
  await rpcOn(cdp, `settingsSet(${JSON.stringify('sandbox.mode')}, ${JSON.stringify('host')})`).catch(() => undefined)
  for (let round = 0; round < 5; round++) {
    for (const step of ['welcome', 'model', 'computer', 'approvals']) {
      await rpcOn(cdp, `onboardingAdvance(${JSON.stringify(step)}, 'skipped')`).catch(() => undefined)
      await sleep(500)
    }
    if (await chatIsUp(cdp)) return true
  }
  return false
}
