// F7 (fase fondamenta): il motore comune delle sonde. Ogni sonda avviava da sé
// l'app, il collegamento CDP e le attese, con SLEEP FISSI (nei 42 sonde sono
// 793): un'attesa fissa è lenta quando la condizione arriva prima e falsa
// quando arriva dopo. Lo stato dell'arte (Playwright, Cypress) è aspettare una
// CONDIZIONE, non un tempo: qui stanno l'avvio (dati temporanei, HOME finta,
// porta CDP libera scelta a caso — NON calcolata da --run), lo spegnimento
// sicuro (probe-daemons + probe-rm), e le attese:
//   attendi(espressione, { entro, motivo })   — Runtime.evaluate ogni 50 ms
//   attendiTestid / attendiTesto              — esiste ed è visibile
//   attendiRete({ quieta })                   — nessuna richiesta in volo
//   attendiStabile(selettore)                 — rettangolo fermo per due frame
// e le azioni che aspettano prima di agire (clic, scrivi, cattura, misura).
// UN avvio solo per sonda: tra una scena e l'altra lo stato si rimette a posto
// navigando e con i dati finti, non riavviando l'app (una scena che vuole
// davvero un'app nuova lo dichiara nella sua definizione).
// La galleria (scripts/galleria.mjs) usa questo stesso motore.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { stopProbeDaemons } from './probe-daemons.mjs'
import { cleanupProbeRun, countProbeDirs } from './probe-rm.mjs'

export const ROOT = join(import.meta.dirname, '..', '..')
export const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + what)), ms))])

/** Una porta libera su 127.0.0.1, scelta dal sistema (listen(0)): mai una porta fissa, mai calcolata da --run. */
export const portaLibera = async () => {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

/** Il client CDP di una pagina: send con tetto, eval, e i listener degli eventi (per attendiRete). */
export async function apriCdp(url) {
  const sock = new WebSocket(url)
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej })
  let id = 0
  const waits = new Map()
  const listeners = new Map()
  sock.onmessage = (m) => {
    const v = JSON.parse(m.data)
    if (v.id && waits.has(v.id)) { const w = waits.get(v.id); waits.delete(v.id); v.error ? w.rej(new Error(v.error.message)) : w.res(v.result) }
    else if (v.method && listeners.has(v.method)) { for (const fn of listeners.get(v.method)) fn(v.params ?? {}) }
  }
  return {
    sock,
    on: (method, fn) => { listeners.get(method) ?? listeners.set(method, new Set()); listeners.get(method).add(fn) },
    send: (method, params = {}, capMs = 20_000) => withTimeout(new Promise((res, rej) => {
      const mid = ++id
      waits.set(mid, { res, rej })
      sock.send(JSON.stringify({ id: mid, method, params }))
    }), capMs, method)
  }
}

/** Le richieste del renderer in volo (per attendiRete): Network.enable e un contatore netto. */
const contatoreRete = (cdp) => {
  const stato = { attivi: 0, ultimo: Date.now() }
  cdp.on('Network.requestWillBeSent', (p) => { if (!(p.type === 'WebSocket' && p.initiator?.type !== 'script')) { stato.attivi++; stato.ultimo = Date.now() } })
  cdp.on('Network.loadingFinished', (p) => { stato.attivi = Math.max(0, stato.attivi - 1); stato.ultimo = Date.now() })
  cdp.on('Network.loadingFailed', (p) => { stato.attivi = Math.max(0, stato.attivi - 1); stato.ultimo = Date.now() })
  return stato
}

/**
 * Avvia una sonda: la cartella temporanea (mkdtemp nella base dei vincoli), i
 * dati, la HOME finta, l'app VERA di `appDir` su out/, la porta CDP libera
 * scelta a caso, il collegamento e i gestori di segnale. Torna un oggetto con
 * i metodi del motore. Le sonde passano i loro server finti in `envExtra`
 * (le porte nascono con portaLibera(), mai fisse).
 */
export async function avviaSonda({
  prefix, appDir = ROOT, envExtra = {}, log = (...a) => console.log(`[${prefix}]`, ...a),
  /** istante ISO per l'orologio fermo nel renderer (la galleria); null = niente */
  orologioFermo = null,
  /** foglio di stile della galleria: animazioni e transizioni spente, cursore nascosto */
  foglioGalleria = false,
  /** sorgenti da registrare PRIMA di ogni documento (es. window.__galleriaUrl per la pagina componenti) */
  scriptAvvio = [],
  /** interruttori Chromium EXTRA (la galleria passa quelli del rendering deterministico) */
  interruttoriChromium = [],
  chiudiPerSegnale = true
} = {}) {
  const tmp = mkdtempSync(`${TMP_BASE}/${prefix}-`)
  const data = join(tmp, 'data')
  const home = join(tmp, 'home')
  const db = join(data, 'data', 'sandbot.db')
  mkdirSync(data, { recursive: true })
  mkdirSync(home, { recursive: true })
  const T0 = Date.now()
  let appLog = ''
  let app = null
  let cdp = null
  let rete = null
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    // gli spill dei sort di SQLite (file -shm/-wal nella temporanea di sistema)
    // finiscono DENTRO la cartella della sonda, che la pulizia si cancella
    SQLITE_TMPDIR: tmp,
    SANDBOT_TEST_USER_DATA: data,
    SANDBOT_TEST_FAKE_KEYCHAIN: join(data, 'keychain-finta.json'),
    SANDBOT_TEST_FAKE_SAFESTORAGE: join(data, 'safestorage-finta.json'),
    ...(envExtra ?? {})
  }
  const stopApp = () => { try { app?.kill('SIGTERM') } catch { /* già via */ } }
  const waitPidGone = async (pid, capMs = 15_000) => {
    const deadline = Date.now() + capMs
    while (pidAlive(pid)) {
      if (Date.now() > deadline) return false
      await sleep(200)
    }
    return true
  }
  const pulizia = async ({ parziale = false } = {}) => {
    stopApp()
    try {
      if (Number.isInteger(app?.pid)) await waitPidGone(app.pid, 8_000)
      await stopProbeDaemons(prefix, { log: () => undefined }).catch(() => undefined)
      if (!parziale) {
        const r = await cleanupProbeRun({ pids: [], prefix, dirs: [tmp], log: () => undefined, capMs: 20_000 }).catch(() => ({ left: ['?'] }))
        return r
      }
    } catch { /* meglio possibile */ }
    return null
  }
  if (chiudiPerSegnale) {
    process.on('SIGINT', () => { void pulizia().then(() => process.exit(130)) })
    process.on('SIGTERM', () => { void pulizia().then(() => process.exit(143)) })
    // un'eccezione non catturata (per esempio in un server finto della sonda) chiude app, daemon e cartella: una corsa caduta non lascia nulla
    process.on('uncaughtException', (e) => { console.error(`[${prefix}] eccezione non catturata:`, e?.stack ?? e); void pulizia().then(() => process.exit(1)) })
    process.on('unhandledRejection', (e) => { console.error(`[${prefix}] rifiuto non catturato:`, e instanceof Error ? e.stack : e); void pulizia().then(() => process.exit(1)) })
  }

  const httpJson = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json()))

  const s = {
    prefix, tmp, data, home, db, log, env,
    /** Il pid dell'app (una sola avviata per corsa; nessuna scena la riavvia). */
    get pid() { return app?.pid ?? null },
    appLog: () => appLog,
    t: () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`,
    /** Avvia l'app e collega CDP (una volta sola): risolve con la pagina principale (non i PiP). */
    avvia: async () => {
      if (app) throw new Error('l\'app è già avviata: UN avvio per sonda')
      const debugPort = await portaLibera()
      log('avvio', appDir, '(CDP su porta libera', debugPort + ')')
      // la finestra COPERTA: senza questi tre interruttori Chromium la considera nascosta e non consegna più gli eventi
      const CHROMIUM_COVERED = ['--disable-features=MacWebContentsOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
      app = spawn(ELECTRON, ['.', `--remote-debugging-port=${debugPort}`, '--lang=it', ...CHROMIUM_COVERED, ...interruttoriChromium], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      app.stdout.on('data', (d) => { appLog += d.toString() })
      app.stderr.on('data', (d) => { appLog += d.toString() })
      // difensiva: un residuo sulla STESSA porta (rischio di corsa appena caduta) va via
      const deadline = Date.now() + 30_000
      for (;;) {
        try {
          const list = await httpJson(debugPort, '/json/list')
          const target = list.find((t) => t.type === 'page' && !(t.url ?? '').includes('/pip/'))
          if (target) {
            cdp = await apriCdp(target.webSocketDebuggerUrl)
            await cdp.send('Page.enable').catch(() => undefined)
            await cdp.send('Network.enable').catch(() => undefined)
            rete = contatoreRete(cdp)
            // l'orologio fermo e il foglio della galleria entrano PRIMA di ogni documento
            if (orologioFermo) {
              await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
                (() => {
                  const FISSO = Date.parse(${JSON.stringify(orologioFermo)})
                  class DataFermo extends Date { constructor(...a) { a.length ? super(...a) : super(FISSO) } static now() { return FISSO } }
                  window.Date = DataFermo
                })()` })
            }
            if (foglioGalleria) {
              await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
                (() => {
                  // i <select> CHIUSI: il testo li dipinge il tema nativo di macOS
                  // (NativeThemeMac), FUORI dalla rasterizzazione deterministica di
                  // Blink — il suo antialiasing è cambiato tra la corsa che ha
                  // generato le approvate e ogni corsa successiva, restando poi
                  // fermo: la cattura non può dipendere dallo stato di sessione
                  // della macchina. Con appearance:none il controllo lo dipinge
                  // Blink come tutto il resto (byte-identico tra corse); il chevron
                  // lo disegna questo foglio, che esiste SOLO nella galleria.
                  const chevron = (c) => "url(\\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='" + c + "' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\\")"
                  const css = [
                    '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
                    'select{-webkit-appearance:none;appearance:none;background-repeat:no-repeat;background-position:right 10px center;padding-right:28px;background-image:' + chevron('%2371717a'),
                    'html.dark select{background-image:' + chevron('%23a1a1aa')
                  ].join('\\n')
                  const metti = () => { const st = document.createElement('style'); st.id = 'galleria-fermo'; st.textContent = css; document.documentElement.appendChild(st) }
                  if (document.documentElement) metti()
                  document.addEventListener('DOMContentLoaded', metti, { once: true })
                })()` })
            }
            for (const source of scriptAvvio) {
              await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
            }
            return { url: target.url, porta: debugPort }
          }
        } catch { /* il debugger non è ancora su */ }
        if (Date.now() > deadline) throw new Error('nessuna pagina entro 30 s: ' + appLog.slice(-600))
        await sleep(100)
      }
    },
    /** Runtime.evaluate: l'espressione (corpo di una funzione async) valutata nel renderer. */
    eval: async (expr, capMs = 30_000) => {
      const r = await withTimeout(cdp.send('Runtime.evaluate', { expression: `((async () => { ${expr} })())`, awaitPromise: true, returnByValue: true }), capMs, 'Runtime.evaluate')
      if (r.exceptionDetails) throw new Error('eccezione nel renderer: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 400))
      return r?.result?.value
    },
    /** La chiamata a window.sandbot (preload), finché non è pronto. */
    rpc: async (callExpr) => {
      for (let i = 0; i < 8; i++) {
        try {
          return await s.eval(`if (!window.sandbot) throw new Error('preload non pronto'); return await window.sandbot.${callExpr}`)
        } catch (e) {
          if (i === 7) throw e
          await sleep(400)
        }
      }
    },
    /**
     * L'attesa su CONDIZIONE: espressione vera, interrogata ogni 50 ms. Alla
     * scadenza fallisce con il motivo e l'ultimo valore visto.
     */
    attendi: async (espr, { entro = 10_000, motivo = 'condizione', passo = 50 } = {}) => {
      const deadline = Date.now() + entro
      let ultimo = null
      let errore = null
      for (;;) {
        try {
          ultimo = await s.eval(`return (${espr})`)
          if (ultimo !== null && ultimo !== undefined && ultimo !== false) return ultimo
        } catch (e) { errore = e; ultimo = `ERRORE: ${String(e.message).slice(0, 200)}` }
        if (Date.now() > deadline) {
          throw new Error(`attesa scaduta (${entro} ms): ${motivo} — ultimo valore: ${JSON.stringify(ultimo)?.slice(0, 300)}${errore && String(errore.message).includes('eccezione nel renderer') ? '' : ''}`)
        }
        await sleep(passo)
      }
    },
    /** attendiTestid: l'elemento ESISTE ed è VISIBILE (ha rettangoli). Con più testid: il primo che compare. */
    attendiTestid: async (testid, { entro = 10_000, motivo } = {}) => {
      const selector = [].concat(testid).map((id) => `[data-testid=${JSON.stringify(id)}]`).join(', ')
      return s.attendi(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!(el && el.getClientRects().length > 0) })()`,
        { entro, motivo: motivo ?? `l'elemento ${[].concat(testid).join(' o ')} esista e sia visibile` })
    },
    /** attendiTesto: un nodo con questo testo (includi) o esatto, visibile. */
    attendiTesto: async (testo, { entro = 10_000, esatto = false, motivo } = {}) => s.attendi(
      `(() => { const t = ${JSON.stringify(testo)}; return [...document.querySelectorAll('*')].some((x) => x.getClientRects().length > 0 && (x.children.length === 0) && ${esatto ? '(x.textContent ?? "").trim() === t' : '(x.textContent ?? "").includes(t)'}) })()`,
      { entro, motivo: motivo ?? `il testo «${testo}» sia visibile` }),
    /** attendiRete: nessuna richiesta del renderer in volo, e nessuna nuova da `quieta` ms. */
    attendiRete: async ({ quieta = 400, entro = 15_000 } = {}) => {
      const deadline = Date.now() + entro
      for (;;) {
        const adesso = Date.now()
        if (rete.attivi === 0 && adesso - rete.ultimo >= quieta) return true
        if (adesso > deadline) throw new Error(`attesa scaduta (${entro} ms): la rete si è quietata? — ${rete.attivi} richieste in volo`)
        await sleep(50)
      }
    },
    /** attendiStabile: il rettangolo dell'elemento non cambia per due frame. */
    attendiStabile: async (selettore, { entro = 10_000 } = {}) => s.attendi(
      `(() => new Promise((ok) => {
        const el = document.querySelector(${JSON.stringify(selettore)})
        if (!el || el.getClientRects().length === 0) return ok(false)
        const r0 = el.getBoundingClientRect()
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const r1 = el.getBoundingClientRect()
          ok(Math.abs(r0.left - r1.left) < 0.5 && Math.abs(r0.top - r1.top) < 0.5 && Math.abs(r0.width - r1.width) < 0.5 && Math.abs(r0.height - r1.height) < 0.5)
        }))
      }))()`,
      { entro, motivo: `il rettangolo di ${selettore} sia fermo per due frame` }),
    /**
     * attendiStabileEspr: il RETTANGOLO dell'elemento scelto da un'espressione
     * JS non cambia tra due letture a 120 ms di distanza (le transizioni di
     * apertura — scale e fade — sono finite: due frame consecutivi da soli
     * possono cadere a metà animazione, e le misure vedevano icone a 15×15).
     */
    attendiStabileEspr: async (espr, { entro = 8_000, quieto = 120 } = {}) => {
      const rectJs = `(() => { const el = (${espr}); if (!el || el.getClientRects().length === 0) return null; const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10)).join(',') })()`
      const deadline = Date.now() + entro
      let prima = await s.eval(`return (${rectJs})`).catch(() => null)
      for (;;) {
        await sleep(quieto)
        const seconda = await s.eval(`return (${rectJs})`).catch(() => null)
        if (prima !== null && seconda !== null && seconda === prima) return true
        prima = seconda
        if (Date.now() > deadline) throw new Error(`attesa scaduta (${entro} ms): il rettangolo non si stabilizza (${espr.slice(0, 80)})`)
      }
    },
    /**
     * Il clic: PRIMA attende che l'elemento esista e sia visibile, POI clicca
     * (pointerdown/up + click, come le sonde). target = testid (uno, o una
     * lista di alternative: il primo che compare) oppure un oggetto { selettore }.
     * Il clic si RIPETE finché l'elemento sta in vista (React può remontare
     * la pagina fra un poll e l'altro: un solo tentativo perdeva il clic).
     */
    clic: async (target, { entro = 10_000, motivo } = {}) => {
      const selettore = Array.isArray(target)
        ? target.map((id) => `[data-testid=${JSON.stringify(id)}]`).join(', ')
        : typeof target === 'string' ? `[data-testid=${JSON.stringify(target)}]` : target.selettore
      const espr = `
        const el = document.querySelector(${JSON.stringify(selettore)})
        if (!el) return false
        // solo se non è già intero in vista, e «nearest»: «center» faceva scorrere anche la RADICE dell'app
        const rr = el.getBoundingClientRect()
        if (rr.top < 0 || rr.bottom > window.innerHeight || rr.left < 0 || rr.right > window.innerWidth) el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }))
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }))
        el.click()
        return true`
      const deadline = Date.now() + entro
      for (;;) {
        const ok = await s.eval(espr).catch(() => false)
        if (ok === true) return true
        if (Date.now() > deadline) throw new Error(`clic non riuscito entro ${entro} ms: ${motivo ?? `il bersaglio ${selettore}`}`)
        await sleep(50)
      }
    },
    /** Il clic del primo bottone/voce con questo testo (esatto di serie) dentro `scope` — ripetuto finché sta in vista. */
    clicTesto: async (testo, scope = 'document', { entro = 10_000, esatto = true, selector = 'button, [role="tab"], [role="menuitem"], [role="button"], [role="radio"]' } = {}) => {
      const espr = `
        const nodes = [...(${scope}).querySelectorAll(${JSON.stringify(selector)})]
        const t = ${JSON.stringify(testo)}
        const b = nodes.find((x) => ${esatto ? '(x.textContent ?? "").trim() === t' : '(x.textContent ?? "").includes(t)'})
        if (!b) return false
        b.click()
        return true`
      const deadline = Date.now() + entro
      for (;;) {
        const ok = await s.eval(espr).catch(() => false)
        if (ok === true) return true
        if (Date.now() > deadline) throw new Error(`clic non riuscito entro ${entro} ms: nessuna voce ${esatto ? 'esattamente' : 'che includa'} «${testo}»`)
        await sleep(50)
      }
    },
    /** Il clic per aria-label/title (due voci con la stessa etichetta: quella VISIBILE) — ripetuto finché sta in vista. */
    clicAria: async (label, { entro = 10_000, esatto = true } = {}) => {
      const espr = `
        const t = ${JSON.stringify(label)}
        // due bottoni con la stessa etichetta (barra larga e barra stretta): si prende quello VISIBILE
        const all = [...document.querySelectorAll('aside button, aside [role="button"], button, [role="button"]')].filter((x) => { const a = x.getAttribute('aria-label') ?? x.title ?? ''; return ${esatto ? 'a === t' : 'a.includes(t)'} || (x.textContent ?? '').trim() === t })
        const b = all.find((x) => x.getClientRects().length > 0) ?? all[0]
        if (!b) return false
        b.click()
        return true`
      const deadline = Date.now() + entro
      for (;;) {
        const ok = await s.eval(espr).catch(() => false)
        if (ok === true) return true
        if (Date.now() > deadline) throw new Error(`clic non riuscito entro ${entro} ms: nessuna voce con etichetta «${label}»`)
        await sleep(50)
      }
    },
    /** Il clic della riga di un bot (o della squadra) nella barra o nella rotaia — ripetuto finché sta in vista. */
    clicRigaBarra: async (nome, { team = false, entro = 10_000 } = {}) => {
      const espr = `
        const n = ${JSON.stringify(nome)}
        const nodes = [...document.querySelectorAll('aside button[title], aside [role="button"]')].filter((x) => x.getClientRects().length > 0)
        const b = nodes.find((x) => (x.title ?? '').trim() === n || (x.querySelector('span.truncate')?.textContent ?? '').trim() === n${team ? " || (x.textContent ?? '').includes(n)" : ''})
        if (!b) return false
        b.click()
        return true`
      const deadline = Date.now() + entro
      for (;;) {
        const ok = await s.eval(espr).catch(() => false)
        if (ok === true) return true
        if (Date.now() > deadline) throw new Error(`clic non riuscito entro ${entro} ms: la riga «${nome}» nella barra`)
        await sleep(50)
      }
    },
    /** scrivi: attende il campo, imposta il valore come un utente (input event). */
    scrivi: async (selettore, testo, { entro = 10_000 } = {}) => {
      await s.attendi(`(() => { const el = document.querySelector(${JSON.stringify(selettore)}); return !!(el && el.getClientRects().length > 0) })()`,
        { entro, motivo: `il campo ${selettore} esista e sia visibile` })
      return s.eval(`
        const el = document.querySelector(${JSON.stringify(selettore)})
        if (!el) return false
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(testo)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true`)
    },
    /** Un messaggio scritto nel campo di scrittura e inviato con Invio, come farebbe l'utente (la pausa fra input e Invio è DI PROPOSITO: il React state aggiorna il testo al giro successivo, senza pausa l'invio parte a volte col campo vuoto). */
    invia: async (testo) => {
      await s.scrivi('form textarea', testo)
      await sleep(150)
      return s.eval(`
        const ta = document.querySelector('form textarea')
        if (!ta) throw new Error('campo di scrittura non trovato')
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return true`)
    },
    /** viewport alla scala 1 di serie (le misure sono px CSS, le catture restano leggere); una sonda può passare la sua scala. */
    viewport: async (w, h, { scala = 1 } = {}) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, mobile: false, deviceScaleFactor: scala })
      await s.attendiRete({ quieta: 120, entro: 3_000 }).catch(() => undefined)
      await s.attendiStabile('aside, main, [data-testid="guide-view"], div.h-screen', { entro: 3_000 }).catch(() => undefined)
    },
    tema: async (t) => {
      await s.eval(`document.documentElement.classList.${t === 'scuro' ? 'add' : 'remove'}('dark'); return true`)
      // attesa DI PROPOSITO: le transizioni del tema durano fino a ~250 ms (le misure di colore
      // e le catture devono vedere il tema STABILE, come l'originale con sleep(280))
      await sleep(500)
    },
    /** L'attesa di assestamento prima di ogni cattura: fonti caricate, due frame, e la rete quieta (l'originale aspettava 350 ms dopo i frame). */
    assesta: async () => {
      await cdp.send('Page.bringToFront').catch(() => undefined)
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await s.eval(`await Promise.race([new Promise((resolve) => { let n = 0; const step = () => { if (++n >= 2) resolve(); else requestAnimationFrame(step) }; requestAnimationFrame(step) }), new Promise((resolve) => setTimeout(resolve, 1500))])`)
      await s.attendiRete({ quieta: 300, entro: 3_000 }).catch(() => undefined)
    },
    /**
     * Il puntatore NEUTRO: lo sposta in un punto che non sta sopra NIENTE di
     * interattivo e lo VERIFICA (la catena di elementi sotto il punto). Dove
     * sta davvero il puntatore dell'utente non lo sa nessuno: se resta dove
     * capita, l':hover disegna righe e bottoni evidenziati che cambiano da
     * corsa a corsa (dove la finestra copre lo schermo). Un mouseMoved via
     * CDP è un evento VERO: dopo di lui l'hover è dove lo abbiamo messo noi.
     */
    puntatoreNeutro: async () => {
      const w = (await s.eval(`return window.innerWidth`)) ?? 1280
      const h = (await s.eval(`return window.innerHeight`)) ?? 800
      // (3,3) no: lassù stanno le luci di traffico hiddenInset, l'hover le ACCENDE
      const punti = [[w - 3, 3], [Math.floor(w / 2), 3], [3, h - 3], [w - 3, h - 3], [w - 3, Math.floor(h / 2)]]
      const sotto = []
      for (const [x, y] of punti) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
        const interattivo = await s.eval(`(() => {
          let el = document.elementFromPoint(${x}, ${y})
          while (el) {
            if (el.matches?.('button, a, select, input, textarea, label, summary, option, [role="button"], [role="menuitem"], [role="tab"], [role="radio"], [role="switch"], [role="combobox"], [aria-haspopup], [data-state="open"], [data-state="delayed-open"], [class*="hover:"]')) return (el.tagName + '.' + String(el.className).slice(0, 60))
            el = el.parentElement
          }
          return null
        })()`).catch(() => null)
        if (!interattivo) return { x, y }
        sotto.push(`(${x},${y})→${interattivo}`)
      }
      throw new Error('nessun punto neutro per il puntatore: ' + sotto.join(' · '))
    },
    /** cattura: assestamento + fonti + screenshot PNG (solo CDP), scritto su file. */
    cattura: async (percorso) => {
      await s.eval(`await document.fonts.ready; return true`)
      await s.assesta()
      // il puntatore si mette al punto neutro per ULTIMO, vicino allo
      // screenshot: un elemento montato dopo la verifica resterebbe coperto
      // dall'hover senza che il controllo lo veda
      await s.puntatoreNeutro()
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(percorso, Buffer.from(r.data, 'base64'))
      return percorso
    },
    /** Il PNG grezzo della finestra (senza attese: per le COMPOSIZIONI, tipo le affiancate della sonda di design). */
    screenshotRaw: async () => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(r.data, 'base64')
    },
    /** Tasto fisico via CDP (per ⌘K e compagnia). */
    tasto: async (desc) => {
      await cdp.send('Input.dispatchKeyEvent', desc)
      return true
    },
    /** Punto al centro dell'elemento (per il fuoco e i gesti del mouse). */
    centro: async (selettore) => s.eval(`
      const el = ${selettore}
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }`),
    /** Evento del mouse alla posizione (per la pressione del fuoco). */
    mouse: async (desc) => cdp.send('Input.dispatchMouseEvent', desc),
    /**
     * La maschera per ESPRESSIONE: copre con un rettangolo pieno OGNI
     * elemento tornato (i dati a ora reale che nessun orologio fermo può
     * congelare). Torna QUANTI elementi ha coperto. Il rettangolo porta
     * l'attributo data-galleria-maschera: UN SOLO nome, lo stesso che tolgono
     * togliMaschere e che conta contaMaschere (la copia che stava in
     * galleria.mjs cercava «data-galleriaMaschera» — mai trovato, e i
     * rettangoli restavano su tutte le scene successive).
     */
    mascheraEspr: async (espr, { colore = '#f0f' } = {}) => s.eval(`
      const els = (${espr})
      if (!Array.isArray(els)) return 0
      let n = 0
      for (const el of els) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const d = document.createElement('div')
        d.setAttribute('data-galleria-maschera', '1')
        d.style.cssText = 'position:fixed;z-index:2147483646;background:${colore};pointer-events:none'
        d.style.left = r.left + 'px'; d.style.top = r.top + 'px'; d.style.width = r.width + 'px'; d.style.height = r.height + 'px'
        document.body.appendChild(d)
        n++
      }
      return n`),
    /** Toglie TUTTI i rettangoli di maschera (l'attributo canonico) e torna quanti ne ha tolti. */
    togliMaschere: async () => s.eval(`
      const via = [...document.querySelectorAll('[data-galleria-maschera]')]
      for (const d of via) d.remove()
      return via.length`),
    /**
     * Quanti rettangoli di maschera ci sono nel DOM, con QUALUNQUE
     * ortografia dell'attributo: il tripwire del controllo della galleria —
     * un rettangolo scritto con un nome diverso da quello che la pulizia
     * toglie non deve passare in silenzio (com'era successo).
     */
    contaMaschere: async () => s.eval(`
      return document.querySelectorAll('[data-galleria-maschera],[data-galleriamaschera],[data-galleriaMaschera]').length`),
    /** La fine della sonda: app spenta, figli della porta di debug via, daemon chiusi, cartelle cancellate e CONTEGGIATE. */
    fine: async ({ porta } = {}) => {
      try { cdp?.sock.close() } catch { /* già chiusa */ }
      stopApp()
      if (Number.isInteger(app?.pid)) await waitPidGone(app.pid).catch(() => undefined)
      // difensiva (dalla sonda squadra): un'app occupata può ignorare il
      // SIGTERM e rispawnare il daemon — i FIGLI Electron nati con la nostra
      // porta di debug si chiudono per pid
      if (porta) {
        try {
          const pg = spawnSync('/usr/bin/pgrep', ['-f', `remote-debugging-port=${porta}`], { encoding: 'utf8' })
          for (const pidStr of (pg.stdout ?? '').split('\n').filter(Boolean)) {
            const pid = Number(pidStr)
            if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== app?.pid) {
              try { process.kill(pid, 'SIGKILL') } catch { /* già via */ }
            }
          }
        } catch { /* pgrep vuoto */ }
        await sleep(400)
      }
      await stopProbeDaemons(prefix, { log: () => undefined }).catch(() => undefined)
      const r = await cleanupProbeRun({ pids: [], prefix, dirs: [tmp], log: () => undefined, capMs: 20_000 }).catch(() => ({ left: ['?'] }))
      const left = countProbeDirs(prefix, [tmp])
      return { cartelleRimaste: r?.left ?? [], conteggio: left }
    }
  }
  return s
}
