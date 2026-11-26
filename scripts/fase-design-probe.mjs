#!/usr/bin/env node
// Sonda di MISURA della fase design: l'app VERA su out/, dati TEMPORANEI,
// HOME finta, modello FINTO su 127.0.0.1. Per OGNI pagina e scheda di DS4, a
// 900×640 · 1280×800 · 1680×1050, in chiaro e in scuro, MISURA come la vede
// l'utente (getComputedStyle, i rettangoli; la rotella di CDP non serve):
//   testo       — ogni testo visibile ha una dimensione fra 12, 13, 14, 16, 20, 28 px; nessuna emoji
//   icone       — le icone lucide sono da 16 px (testo e bottoni) o 20 px (testate)
//   larghezza   — nessun elemento più largo della finestra (nessuno scorrimento orizzontale della pagina)
//   scorrimento — il contenitore che scorre arriva al bordo destro (±1 px) e il contenuto è centrato alla larghezza giusta
//   a-capo      — nessuna scheda (UnderlineTabs) né intestazione o cella breve di tabella va a capo
//   testate     — le testate delle colonne sono alte 52 px e le icone della barra hanno il centro sulla riga dei semafori (dalla trafficLightPosition configurata)
//   fuoco       — dopo la pressione del mouse nessun anello di fuoco visibile
//   R8 (b20-ritocchi) — LA DISPOSIZIONE, ciò che le misure di dimensione non vedevano:
//   sovrapposizioni  — nessun testo visibile sotto una testata (data-col-head) senza sfondo, a scorrimento a metà
//   righe-spezzate   — in ogni <li> del markdown il primo blocco di testo in riga è una riga sola, se la larghezza lo consente
//   pillole          — nessuna pillola o badge schiacciata (scrollWidth ≤ clientWidth + 1)
//   contrasto-puntini— i puntini dei bot hanno contrasto ≥ 3:1 col fondo della riga, in chiaro e in scuro
//   altezza-barra    — le voci della barra di navigazione stanno fra 32 e 36 px
// Le catture (solo CDP, alla scala 1) vanno in docs/catture/fase-design/:
// 1280×800 chiaro e scuro per ogni pagina, più 900 e 1680 per Chat, Plugin e
// Libreria; i numeri in docs/misure/fase-design/<prima|dopo>.json. Con
// --affiancate (alla fine della corsa «dopo») ogni coppia prima/dopo diventa
// UNA immagine col prima a sinistra e il dopo a destra: sono le catture
// affiancate del REPORT; le due grezze escono.
//
//   node scripts/fase-design-probe.mjs [--app <cartella>] [--prima] [--solo id1,id2] [--senza-catture] [--affiancate]
//
// --app: l'app da avviare (package.json + out/; default: questo repo). Le
//        misure «prima» vengono dal build della base (il tag fase-b20-bug),
//        salvato in una temporanea: STESSA sonda, stessi dati.
// --prima: catture «prima-*.png» e misure in prima.json.
// Uscita 1 se c'è ANCHE UNA violazione (sulla base è rossa: è la misura
// «prima»). Nessuna rete fuori da 127.0.0.1, nessun Docker, nessun Composio
// vero, mai i file VERI delle altre app (solo la HOME finta).
//
// F7 (fase fondamenta): la sonda usa il MOTORE comune (scripts/lib/sonda.mjs)
// e LE SCENE sono in scripts/lib/scene.mjs (la galleria le condivide). Un
// avvio per corsa, porta CDP libera scelta a caso, attese su CONDIZIONE (mai
// sleep fissi). Cosa controlla NON cambia: stesse misure e stessi controlli.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { avviaSonda, ROOT, messaggioTentativiLocali } from './lib/sonda.mjs'
import { modelloFinto } from './lib/modello-finto.mjs'
import { PAGES, NOMI, prepara, closeOverlays, openPage, openOverlay, WIDTHS, HEAD_HEIGHT, NARROW_AREA_BELOW, PAGE_MARGIN, PAGE_MARGIN_NARROW } from './lib/scene.mjs'

const argv = process.argv.slice(2)
const argValue = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
const APP_DIR = resolve(argValue('--app') ?? ROOT)
const PRIMA = argv.includes('--prima')
const AFFIANCATE = argv.includes('--affiancate')
const SOLO = argValue('--solo')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
/** Le scritte delle affiancate: chi le vuole diverse (una fase nuova con un'altra
 *  base di riferimento) le passa da riga di comando, il resto è «PRIMA»/«DOPO». */
const ETICHETTA_PRIMA = argValue('--etichetta-prima') ?? 'PRIMA'
const ETICHETTA_DOPO = argValue('--etichetta-dopo') ?? 'DOPO'
const PREFIX = 'sandbot-fase-design'
const SHOTS = join(ROOT, 'docs', 'catture', 'fase-design')
const MISURE = join(ROOT, 'docs', 'misure', 'fase-design')
for (const d of [SHOTS, MISURE]) mkdirSync(d, { recursive: true })
const shotName = (name) => `${PRIMA ? 'prima-' : ''}${name}.png`
/** --senza-catture: solo le misure (le corse di prova della sonda stessa). */
const NO_SHOTS = argv.includes('--senza-catture')

const results = []
const T0 = Date.now()
const log = (...a) => console.log('[fase-design]', `+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a)
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) })
  log(ok ? 'OK ' : 'KO ', name, ok ? '' : '— ' + detail)
}
const trySection = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    log('ERRORE nella sezione', name, '—', e.message)
    results.push({ name: `${name}: la sezione è arrivata in fondo senza errori`, ok: false, detail: e.message })
  }
}
/** --senza-catture: i gruppi con le catture anche a 900 e 1680 (DS6). */
const CAPTURE_GROUPS = ['Chat', 'Plugin', 'Libreria']

/** Le sei dimensioni di DS1 (px). Tutto il resto è una violazione. */
export const ALLOWED_SIZES = [12, 13, 14, 16, 20, 28]
/** Le misure delle testate (DS3): il bottone dei semafori è alto 14 px; le icone della testata in bottoni da 32 px, la prima a 12 px dai semafori. */
export const TRAFFIC_LIGHT_BUTTON = 14
export const TRAFFIC_LIGHTS_WIDTH = 14 + 20 * 2
export const HEAD_BUTTON = 32
export const HEAD_FIRST_ICON_GAP = 12
const SIZES = [[900, 640], [1280, 800], [1680, 1050]]
const THEMES = ['chiaro', 'scuro']

// ---- il «modello» FINTO (scripts/lib/modello-finto.mjs) e il server MCP http col token (scripts/lib/scene.mjs) ----
const modello = modelloFinto()
const providerPort = await modello.avvia()
const mcp = await import('./lib/scene.mjs').then((m) => m.serverMcpToken())
const mcpHttpPort = mcp.porta

// ---- il sorgente del build che si avvia (le posizioni dei semafori, DS3) ----
const trafficLightsOf = () => {
  const bundle = join(APP_DIR, 'out', 'main', 'index.js')
  if (!existsSync(bundle)) return null
  const js = readFileSync(bundle, 'utf8')
  const m = /trafficLightPosition:\s*(\{[^}]*\}|\w+)/.exec(js)
  if (!m) return null
  // un letterale, oppure il nome di una costante (`const NOME = { x: 12, y: 20 }`)
  const lit = m[1].startsWith('{') ? m[1] : new RegExp(`(?:const|let|var)\\s+${m[1]}\\s*=\\s*(\\{[^}]*\\})`).exec(js)?.[1]
  const x = /\bx:\s*(\d+)/.exec(lit ?? '')?.[1]
  const y = /\by:\s*(\d+)/.exec(lit ?? '')?.[1]
  return x && y ? { file: 'out/main/index.js', x: Number(x), y: Number(y) } : null
}
const LIGHTS = trafficLightsOf()

/** L'impronta del build che si avvia (per il REPORT). */
const buildFingerprint = () => {
  const h = createHash('sha256')
  for (const f of ['out/main/index.js', 'out/main/daemon.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    const p = join(APP_DIR, f)
    h.update(f).update(existsSync(p) ? readFileSync(p) : 'MANCANTE')
  }
  return h.digest('hex').slice(0, 16)
}
log('app:', APP_DIR, PRIMA ? '(PRIMA)' : '', 'build:', buildFingerprint(), 'semafori:', JSON.stringify(LIGHTS))
const MEASURE_JS = (rootExpr, { withSidebar }) => `(() => {
  const root = ${rootExpr}
  if ((${rootExpr}) === null) return { missing: true }
  const scope = root ?? document.body
  const side = document.querySelector('aside')
  const round = (v) => Math.round(v * 10) / 10
  const rr = root?.getBoundingClientRect() ?? null
  const rootInfo = rr ? { left: round(rr.left), right: round(rr.right), width: round(rr.width), dialog: root.getAttribute('role') === 'dialog' } : null
  const allowed = ${JSON.stringify(ALLOWED_SIZES)}
  const headHeight = ${HEAD_HEIGHT}
  const inScope = (el) => (scope === document.body ? true : scope.contains(el)) && (${withSidebar ? 'true' : '!side?.contains(el)'})
  const vis = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'
  }
  const skip = (el) => !!el.closest('svg, canvas, .xterm, .sr-only, [aria-hidden="true"], script, style')
  const sel = (el) => el.tagName.toLowerCase() + (el.dataset?.testid ? '[' + el.dataset.testid + ']' : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\\s+/).slice(0, 3).join('.') : '')
  const describe = (el) => ({ sel: sel(el).slice(0, 70), text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 36) })

  // ---- testo: ogni elemento con un testo diretto visibile ----
  const bySize = {}
  const textSamples = []
  const emoji = /\\p{Extended_Pictographic}/u
  const emojiSamples = []
  let texts = 0
  let emojis = 0
  const note = (el, text) => {
    if (!inScope(el) || !vis(el) || skip(el)) return
    const size = Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2
    bySize[size] = (bySize[size] ?? 0) + 1
    texts++
    if (!allowed.includes(size) && textSamples.length < 10) textSamples.push({ ...describe(el), size })
    if (text && emoji.test(text)) {
      emojis++
      if (emojiSamples.length < 8) emojiSamples.push({ ...describe(el), chars: [...new Set(text.match(/\\p{Extended_Pictographic}/gu) ?? [])].join('') })
    }
  }
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue?.trim()) note(n.parentElement, n.nodeValue)
  }
  for (const field of scope.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (field.placeholder) note(field)
  }

  // ---- icone: le icone lucide sono da 16 px (testo e bottoni) o 20 (testate) ----
  const iconSizes = {}
  const iconSamples = []
  for (const el of scope.querySelectorAll('svg.lucide')) {
    if (!inScope(el) || !vis(el) || el.closest('.sr-only')) continue
    const box = el.getBoundingClientRect()
    const k = Math.round(box.width) + 'x' + Math.round(box.height)
    iconSizes[k] = (iconSizes[k] ?? 0) + 1
    if (!['16x16', '20x20'].includes(k) && iconSamples.length < 8) iconSamples.push({ sel: (el.getAttribute('class') ?? '').slice(0, 60), size: k, where: sel(el.parentElement ?? el).slice(0, 50) })
  }

  // ---- larghezza: niente più largo della finestra ----
  const iw = window.innerWidth
  const pageScrollX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > iw + 1
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX
      if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true
    }
    return false
  }
  const wide = []
  for (const el of scope.querySelectorAll('*')) {
    if (!inScope(el) || !vis(el) || clipped(el) || skip(el)) continue
    const r = el.getBoundingClientRect()
    if (r.right > iw + 1 || r.left < -1) wide.push({ ...describe(el), left: round(r.left), right: round(r.right) })
  }

  // ---- scorrimento: il contenitore che scorre e il contenuto ----
  // il contenitore che scorre in VERTICALE: il più esterno (una tabella o un blocco di codice che scorrono in orizzontale stanno DENTRO la pagina, non sono loro)
  const all = [scope, ...scope.querySelectorAll('*')].filter((el) => {
    if (!inScope(el)) return false
    const cs = getComputedStyle(el)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.clientHeight >= 200 && el.clientWidth >= 200
  })
  const set = new Set(all)
  const scrollers = all.filter((el) => { for (let a = el.parentElement; a && a !== scope; a = a.parentElement) if (set.has(a)) return false; return true })
    .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)
  const sc = scrollers[0] ?? null
  let scroll = null
  if (sc) {
    const r = sc.getBoundingClientRect()
    const marked = sc.querySelector(':scope > [data-page-content], :scope [data-page-content]')
    const kids = [...sc.children].filter(vis)
    const content = marked ?? (kids.length === 1 ? kids[0] : kids.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] ?? null)
    const cr = content?.getBoundingClientRect() ?? null
    scroll = {
      sel: sel(sc).slice(0, 70), left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom), innerWidth: iw, innerHeight: window.innerHeight,
      // la larghezza UTILE: senza la barra di scorrimento e senza lo spazio che il corpo le riserva (scrollbar-gutter)
      clientWidth: sc.clientWidth,
      overflow: sc.scrollHeight > sc.clientHeight + 1,
      content: cr ? { sel: sel(content).slice(0, 70), width: round(cr.width), left: round(cr.left), right: round(cr.right), centered: round(Math.abs((cr.left + cr.right) / 2 - (r.left + r.right) / 2)) } : null
    }
  }

  // ---- a capo: schede, intestazioni e celle brevi di tabella ----
  // si guarda ogni PEZZO di testo diretto (un elemento con il suo testo): una cella a due righe volute (titolo + sottotitolo, ognuno nel suo span) non è un a capo; lo è un pezzo che si spezza
  const lines = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const tops = new Set()
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top / 6))
    return tops.size
  }
  const piecesOf = (el) => [el, ...el.querySelectorAll('*')].filter((x) => [...x.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? '').trim()))
  const wrapOf = (els, maxText) => els.filter((el) => inScope(el) && vis(el) && (el.textContent ?? '').trim() && (!maxText || (el.textContent ?? '').trim().length <= maxText)).map((el) => ({ el, piece: piecesOf(el).find((x) => lines(x) > 1) ?? null })).filter((x) => x.piece).map((x) => ({ ...describe(x.piece), lines: lines(x.piece) }))
  const tabs = [...scope.querySelectorAll('[role="tab"]')]
  const wrappedTabs = wrapOf(tabs)
  const wrappedLists = [...scope.querySelectorAll('[role="tablist"]')].filter((l) => inScope(l) && vis(l) && new Set([...l.querySelectorAll('[role="tab"]')].filter(vis).map((t) => Math.round(t.getBoundingClientRect().top / 6))).size > 1).map(describe)
  const wrappedHeads = wrapOf([...scope.querySelectorAll('th')])
  const wrappedCells = wrapOf([...scope.querySelectorAll('td')], 24)

  // ---- testate: le colonne (data-col-head) o, senza, la fascia di trascinamento della barra ----
  const heads = []
  const markedHeads = [...document.querySelectorAll('[data-col-head]')]
  for (const el of (markedHeads.length ? markedHeads : (side ? [side.querySelector('.drag-region')].filter(Boolean) : []))) {
    if (!vis(el)) continue
    const r = el.getBoundingClientRect()
    const icons = [...el.querySelectorAll('button')].filter(vis).map((b) => { const br = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') || b.title || (b.textContent ?? '').trim().slice(0, 20), w: round(br.width), h: round(br.height), cy: round((br.top + br.bottom) / 2), left: round(br.left), right: round(br.right) } })
    heads.push({ name: el.dataset.colHead ?? 'barra', height: round(r.height), top: round(r.top), left: round(r.left), right: round(r.right), icons: icons.slice(0, 12) })
  }
  const sideRect = side?.getBoundingClientRect() ?? null

  // ---- R8 (b20-ritocchi): LA DISPOSIZIONE — come le cose si mettono ----
  // (a) SOVRAPPOSIZIONI: nessun testo visibile sotto una testata senza
  // sfondo. Al punto centrale di ogni riga di testo caduta nella fascia dei
  // 52, CON le testate visibili si chiede chi è in cima: se è la TESTATA, il
  // testo le scorre sotto; allora la si nasconde e si rifà la domanda: se è
  // il testo, la testata deve COPRIRLO (sfondo velato o sfocatura). Se in
  // cima c'è altro — un dialogo sopra la colonna — non è un testo della
  // fascia, e non si conta. Tutto a scorrimento a metà
  const overlapped = []
  {
    const bands = [...document.querySelectorAll('[data-col-head]')].filter(vis).map((el) => ({ el, r: el.getBoundingClientRect() }))
    if (bands.length) {
      const savedScroll = sc ? sc.scrollTop : 0
      if (sc && sc.scrollHeight > sc.clientHeight) sc.scrollTop = Math.floor((sc.scrollHeight - sc.clientHeight) / 2)
      const pieces = [...scope.querySelectorAll('*')].filter((el) => inScope(el) && !skip(el) && [...el.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? '').trim()))
      const alphaOf = (bg) => {
        const a = /rgba?\\((?:[\\d.]+, ){2}[\\d.]+, ?([\\d.]+)\\)/.exec(bg)
        if (a) return Number(a[1])
        const ok = /oklch\\([^/)]*\\/ ?([\\d.]+)%?\\)/.exec(bg)
        if (ok) return Number(ok[1])
        return bg === 'transparent' ? 0 : 1
      }
      const hidden = []
      try {
        for (const el of pieces) {
          if (!vis(el)) continue
          const er = el.getBoundingClientRect()
          if (er.width === 0 || er.height === 0) continue
          const cxOf = (b) => Math.min(Math.max((er.left + er.right) / 2, b.r.left + 1), b.r.right - 1)
          const cyOf = (b) => Math.min(Math.max((er.top + er.bottom) / 2, b.r.top + 1), b.r.bottom - 1)
          // 1) con le testate VISIBILI: la fascia che comanda il punto (se il
          //    punto non è di nessuna fascia — un dialogo sopra — si salta)
          let owner = null
          let pt = null
          for (const b of bands) {
            if (!(er.top < b.r.bottom - 1 && er.bottom > b.r.top + 1 && er.right > b.r.left && er.left < b.r.right)) continue
            const hit0 = document.elementFromPoint(cxOf(b), cyOf(b))
            if (hit0 && (hit0 === b.el || b.el.contains(hit0))) { owner = b; pt = [cxOf(b), cyOf(b)]; break }
          }
          if (!owner) continue
          // 2) fascia nascosta: al punto si vede IL TESTO? (l'elemento stesso o
          //    un suo discendente: se la domanda torna un ANTENATO — la radice
          //    del guscio che sta sotto la fascia nascosta — il testo lì non è
          //    raggiungibile, non è lui che si vede)
          hidden.push([owner.el, owner.el.style.visibility])
          owner.el.style.visibility = 'hidden'
          const hit = document.elementFromPoint(pt[0], pt[1])
          owner.el.style.visibility = hidden[hidden.length - 1][1]
          hidden.pop()
          if (!hit || !(hit === el || el.contains(hit))) continue
          // 3) la fascia copre? (sfondo con alpha, o sfocatura)
          const csHead = getComputedStyle(owner.el)
          const copre = alphaOf(csHead.backgroundColor) > 0 || csHead.backdropFilter !== 'none'
          if (!copre) overlapped.push({ ...describe(el), head: owner.el.dataset.colHead })
        }
      } finally {
        for (const [el, v] of hidden) el.style.visibility = v
        if (sc && sc.scrollHeight > sc.clientHeight) sc.scrollTop = savedScroll
      }
    }
  }

  // (b) RIGHE SPEZZATE: in ogni <li> del markdown il primo blocco di testo in
  // riga è UNA riga sola, se la larghezza lo consente (l'involucro flex-col
  // metteva «Ricavi:», «in crescita», «del 12%…» una sotto l'altra anche
  // quando ci stavano insieme). L'involucro — un solo figlio BLOCCO senza
  // testo suo — si ATTRAVERSA: il blocco di riga è quello che sta dentro. Se
  // non ci stanno, andare a capo è giusto: lo si decide misurando il
  // contenuto in nowrap
  const brokenListLines = []
  {
    const INLINE = new Set(['STRONG', 'EM', 'CODE', 'A', 'DEL', 'MARK', 'B', 'I', 'SPAN', 'SMALL', 'ABBR', 'SUB', 'SUP'])
    for (const li of scope.querySelectorAll('li')) {
      if (!inScope(li) || !vis(li) || skip(li)) continue
      let box = li
      for (let d = 0; d < 3; d++) {
        const kids0 = [...box.childNodes].filter((n) => (n.nodeType === 1 && n.tagName !== 'BR') || (n.nodeType === 3 && (n.nodeValue ?? '').trim()))
        if (kids0.length === 1 && kids0[0].nodeType === 1 && !INLINE.has(kids0[0].tagName)) { box = kids0[0]; continue }
        break
      }
      const kids = [...box.childNodes].filter((n) => (n.nodeType === 3 && (n.nodeValue ?? '').trim()) || (n.nodeType === 1 && INLINE.has(n.tagName)))
      if (!kids.length) continue
      const range = document.createRange()
      range.setStartBefore(kids[0])
      range.setEndAfter(kids[kids.length - 1])
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map((r) => Math.round(r.top / 6)))
      if (tops.size <= 1) continue
      const probeEl = document.createElement('span')
      probeEl.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap'
      for (const k of kids) probeEl.appendChild(k.cloneNode(true))
      box.appendChild(probeEl)
      const oneLine = probeEl.getBoundingClientRect().width
      probeEl.remove()
      const csBox = getComputedStyle(box)
      const available = box.clientWidth - parseFloat(csBox.paddingLeft) - parseFloat(csBox.paddingRight)
      if (oneLine <= available) brokenListLines.push({ ...describe(li), oneLine: round(oneLine), available: round(available) })
    }
  }

  // (c) PILLOLE SCHIACCIATE: ogni pillola o badge sta larga quanto il suo
  // contenuto (la «Strada» si vedeva come una «s» in un cerchio: scrollWidth
  // molto oltre clientWidth)
  const squashed = []
  for (const el of scope.querySelectorAll('[class*="rounded-full"]')) {
    if (!inScope(el) || !vis(el) || skip(el)) continue
    if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? '').trim())) continue
    if (el.scrollWidth > el.clientWidth + 1) squashed.push({ ...describe(el), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth })
  }

  // (d) CONTRASTO dei puntini di stato: ≥ 3:1 col fondo della riga (il primo
  // antenato con uno sfondo), in entrambi i temi. I colori computed arrivano
  // come oklch(…) (il tema li dichiara così) o rgb(…): si convertono a sRGB
  // e si fa la luminanza WCAG
  const dotIssues = []
  {
    const oklchToSrgb = (L, C, H) => {
      const h = (H * Math.PI) / 180
      const a = C * Math.cos(h)
      const b = C * Math.sin(h)
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b
      const s_ = L - 0.0894841775 * a - 1.291485548 * b
      const l = l_ * l_ * l_
      const m = m_ * m_ * m_
      const s = s_ * s_ * s_
      const gam = (v) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))
      return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)]
    }
    const parse = (s) => {
      const mk = (c, a) => ({ c, a: a === undefined ? 1 : a })
      const rgb = /rgba?\\(([\\d.]+), ([\\d.]+), ([\\d.]+)(?:, ?([\\d.]+))?\\)/.exec(s ?? '')
      if (rgb) return mk([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], rgb[4] === undefined ? undefined : Number(rgb[4]))
      const ok = /oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)/.exec(s ?? '')
      if (ok) return mk(oklchToSrgb(Number(ok[1]), Number(ok[2]), Number(ok[3])), ok[4] === undefined ? undefined : Number(ok[4]))
      return null
    }
    const chan = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
    const lum = (c) => 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2])
    for (const dot of scope.querySelectorAll('[data-testid="bot-dot-color"]')) {
      if (!inScope(dot) || !vis(dot)) continue
      const d = parse(getComputedStyle(dot).backgroundColor)
      if (!d || d.a === 0) continue
      let row = null
      for (let a = dot.parentElement; a; a = a.parentElement) { const p = parse(getComputedStyle(a).backgroundColor); if (p && p.a > 0) { row = p; break } }
      if (!row) row = parse(getComputedStyle(document.body).backgroundColor) ?? { c: [1, 1, 1], a: 1 }
      const l1 = lum(d.c)
      const l2 = lum(row.c)
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      if (ratio < 3) dotIssues.push({ sel: sel(dot.parentElement ?? dot).slice(0, 60), ratio: round(ratio) })
    }
  }

  // (e) LE ALTEZZE DELLA BARRA: le voci della navigazione stanno fra 32 e
  // 36 px (R3: erano 52, un errore della spec di fase-design)
  const navRowBad = []
  {
    const navEl = document.querySelector('aside nav')
    if (navEl) {
      for (const el of navEl.querySelectorAll('*')) {
        if (typeof el.className !== 'string' || !(/(^|\\s)h-row(-nav)?(\\s|$)/.test(el.className))) continue
        if (!vis(el)) continue
        const h = Math.round(el.getBoundingClientRect().height)
        if (h < 32 || h > 36) navRowBad.push({ sel: sel(el).slice(0, 60), height: h })
      }
    }
  }
  return { root: rootInfo, rail: sideRect ? sideRect.width < 160 : false, texts, bySize, textSamples, emojis, emojiSamples, iconSizes, iconSamples, pageScrollX, wide: wide.slice(0, 12), wideCount: wide.length, scroll, tabs: tabs.filter((t) => inScope(t) && vis(t)).length, wrappedTabs, wrappedLists, wrappedHeads, wrappedCells, heads, overlappedCount: overlapped.length, overlapped: overlapped.slice(0, 6), brokenListLines: brokenListLines.slice(0, 6), brokenListCount: brokenListLines.length, squashed: squashed.slice(0, 6), squashedCount: squashed.length, dotIssues: dotIssues.slice(0, 6), dotIssueCount: dotIssues.length, navRowBad: navRowBad.slice(0, 6), navRowBadCount: navRowBad.length }
})()`

const RING_JS = `
  const el = document.activeElement
  if (!el || el === document.body) return null
  const cs = getComputedStyle(el)
  return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow, text: (el.textContent ?? '').trim().slice(0, 24) }
`
const ringShown = (r) => r !== null && ((r.outline.startsWith('none') === false && !/ 0px/.test(r.outline)) || (r.shadow && r.shadow !== 'none'))

export const violationsOf = (m, { width = null, heads = true, edges = true } = {}) => {
  const out = { testo: 0, icone: 0, larghezza: 0, scorrimento: 0, 'a-capo': 0, testate: 0, fuoco: 0, emoji: 0, sovrapposizioni: 0, 'righe-spezzate': 0, pillole: 0, 'contrasto-puntini': 0, 'altezza-barra': 0, dettaglio: [] }
  if (!m || m.missing) { out.mancante = 1; out.dettaglio.push('PAGINA NON TROVATA (radice assente)'); return out }
  for (const [size, n] of Object.entries(m.bySize ?? {})) {
    if (!ALLOWED_SIZES.includes(Number(size))) { out.testo += n; out.dettaglio.push(`testo ${size}px ×${n}`) }
  }
  if (m.textSamples?.length) out.dettaglio.push(...m.textSamples.slice(0, 4).map((s) => `  ${s.size}px ${s.sel} «${s.text}»`))
  out.icone = Object.entries(m.iconSizes ?? {}).filter(([k]) => !['16x16', '20x20'].includes(k)).reduce((a, [, n]) => a + Number(n), 0)
  if (out.icone) out.dettaglio.push(...(m.iconSamples ?? []).map((i) => `  icona ${i.size} ${i.sel} in ${i.where}`))
  if (m.pageScrollX) { out.larghezza += 1; out.dettaglio.push('la pagina scorre in orizzontale') }
  if (m.wideCount > 0) { out.larghezza += m.wideCount; out.dettaglio.push(...m.wide.slice(0, 3).map((w) => `  fuori: ${w.sel} ${w.left}–${w.right}`)) }
  const sc = m.scroll
  if (sc && edges) {
    // il contenitore che scorre è largo quanto l'area della pagina: la sua barra sta sul bordo destro dell'area (della finestra, quando a destra non c'è nessun pannello)
    const edge = m.root?.right ?? sc.innerWidth
    const gap = edge - sc.right
    if (Math.abs(gap) > 1) { out.scorrimento += 1; out.dettaglio.push(`lo scorrimento finisce a ${sc.right} (bordo dell'area ${edge}: ${gap} px)`) }
    // e comincia dal bordo sinistro dell'area (i dialoghi con la navigazione a sinistra no: si misura solo il bordo destro)
    if (m.root && !m.root.dialog && Math.abs(sc.left - m.root.left) > 1) { out.scorrimento += 1; out.dettaglio.push(`lo scorrimento comincia a ${sc.left} (bordo dell'area ${m.root.left})`) }
  }
  if (width && sc) {
    if (!sc.content) { out.scorrimento += 1; out.dettaglio.push('nessun contenuto dentro lo scorrimento') }
    else {
      // l'area utile è quella DENTRO la barra di scorrimento (e lo spazio che il corpo le riserva ai lati: la barra di scroll-thin occupa 6 px)
      const area = sc.clientWidth
      const margin = area < NARROW_AREA_BELOW ? PAGE_MARGIN_NARROW : PAGE_MARGIN
      const expected = Math.min(WIDTHS[width], area - 2 * margin) // la larghezza scelta, o l'area meno i due margini
      if (Math.abs(sc.content.width - expected) > 1) { out.scorrimento += 1; out.dettaglio.push(`contenuto largo ${sc.content.width} (atteso ${expected}: ${width}, area utile ${area})`) }
      if (sc.content.centered > 1) { out.scorrimento += 1; out.dettaglio.push(`contenuto non centrato: ${sc.content.centered} px`) }
    }
  }
  out['a-capo'] = (m.wrappedTabs?.length ?? 0) + (m.wrappedLists?.length ?? 0) + (m.wrappedHeads?.length ?? 0) + (m.wrappedCells?.length ?? 0)
  if (out['a-capo']) out.dettaglio.push(...[...(m.wrappedTabs ?? []).map((w) => `  scheda a capo: «${w.text}»`), ...(m.wrappedLists ?? []).map((w) => `  schede su due righe: ${w.sel}`), ...(m.wrappedHeads ?? []).map((w) => `  intestazione a capo: «${w.text}»`), ...(m.wrappedCells ?? []).map((w) => `  cella breve a capo: «${w.text}»`)].slice(0, 4))
  out.emoji = m.emojis ?? 0
  if (out.emoji) out.dettaglio.push(...(m.emojiSamples ?? []).map((e) => `  emoji ${e.chars} in ${e.sel} «${e.text}»`))
  // ---- R8 (b20-ritocchi): la disposizione ----
  out.sovrapposizioni = m.overlappedCount ?? 0
  if (out.sovrapposizioni) out.dettaglio.push(...(m.overlapped ?? []).map((o) => `  «${o.text}» (${o.sel}) visibile sotto la testata ${o.head} senza sfondo`))
  out['righe-spezzate'] = m.brokenListCount ?? 0
  if (out['righe-spezzate']) out.dettaglio.push(...(m.brokenListLines ?? []).map((b) => `  voce di elenco spezzata: «${b.text}» (${b.oneLine}px in ${b.available}px disponibili)`))
  out.pillole = m.squashedCount ?? 0
  if (out.pillole) out.dettaglio.push(...(m.squashed ?? []).map((p) => `  pillola schiacciata: «${p.text}» (${p.clientWidth}px per ${p.scrollWidth}px di testo)`))
  out['contrasto-puntini'] = m.dotIssueCount ?? 0
  if (out['contrasto-puntini']) out.dettaglio.push(...(m.dotIssues ?? []).map((d) => `  puntino a contrasto ${d.ratio}:1 (servono 3:1): ${d.sel}`))
  out['altezza-barra'] = m.navRowBadCount ?? 0
  if (out['altezza-barra']) out.dettaglio.push(...(m.navRowBad ?? []).map((n) => `  voce della barra alta ${n.height} (fra 32 e 36): ${n.sel}`))
  if (heads) {
    if (!m.heads?.length) { out.testate += 1; out.dettaglio.push('nessuna testata misurata') }
    for (const h of m.heads ?? []) {
      if (Math.abs(h.height - HEAD_HEIGHT) > 1) { out.testate += 1; out.dettaglio.push(`testata ${h.name} alta ${h.height} (attesi ${HEAD_HEIGHT})`) }
      // in rotaia (finestra stretta) la barra ha solo la fascia dei semafori: le sue icone stanno in fila sotto, fuori misura
      if (h.name === 'barra' && m.rail) continue
      // la guida iniziale non ha colonne: la sua fascia è solo lo spazio dei semafori (altezza sì, icone no)
      if (h.name === 'guida') continue
      // tutte le colonne hanno la testata in CIMA alla finestra
      if (h.name !== 'barra' && Math.abs(h.top) > 1) { out.testate += 1; out.dettaglio.push(`testata ${h.name} comincia a ${h.top} px (atteso 0: le testate sono allineate)`) }
      if (!h.icons.length) { out.testate += 1; out.dettaglio.push(`testata ${h.name}: nessuna icona`) }
      const center = h.top + h.height / 2
      for (const b of h.icons) {
        // i bottoni della testata sono alti 32 px e centrati nella riga
        if (Math.abs(b.h - HEAD_BUTTON) > 1) { out.testate += 1; out.dettaglio.push(`bottone «${b.label}» della testata ${h.name} alto ${b.h} (attesi ${HEAD_BUTTON})`) }
        if (Math.abs(b.cy - center) > 1) { out.testate += 1; out.dettaglio.push(`bottone «${b.label}» della testata ${h.name} centrato a ${b.cy} (riga ${center})`) }
      }
    }
  }
  return out
}
/** La riga dei semafori (dalla posizione configurata) contro le icone della barra: centro sulla stessa riga (±1), la prima a 12 px dai semafori. */
const lightsRowOf = (m, lights) => {
  const out = []
  const row = lights.y + TRAFFIC_LIGHT_BUTTON / 2 // il centro dei bottoni dei semafori
  const head = m.heads?.find((h) => h.name === 'barra')
  if (!head || m.rail) return out // rotaia: le icone stanno in fila sotto i semafori, non sulla loro riga
  const first = [...head.icons].sort((a, b) => a.left - b.left)[0]
  for (const b of head.icons) if (Math.abs(b.cy - row) > 1) out.push(`icona «${b.label}» centrata a ${b.cy} (riga dei semafori ${row})`)
  if (first && Math.abs(first.left - (lights.x + TRAFFIC_LIGHTS_WIDTH + HEAD_FIRST_ICON_GAP)) > 1) out.push(`la prima icona («${first.label}») comincia a ${first.left} (atteso ${lights.x + TRAFFIC_LIGHTS_WIDTH + HEAD_FIRST_ICON_GAP}: ${HEAD_FIRST_ICON_GAP} px dai semafori)`)
  return out
}
const totalOf = (v) => v.testo + v.icone + v.larghezza + v.scorrimento + v['a-capo'] + v.testate + v.fuoco + v.emoji + v.sovrapposizioni + v['righe-spezzate'] + v.pillole + v['contrasto-puntini'] + v['altezza-barra'] + (v.mancante ?? 0)

// ---- la misura di UNA pagina, con il motore (attese su condizione) ----
const shot = async (name) => {
  await s.cattura(join(SHOTS, shotName(name)))
  log('cattura', shotName(name))
}

const measurePage = async (page, ctx) => {
  const rows = []
  for (const [w, h] of sizesOf(page)) {
    await s.viewport(w, h)
    for (const theme of THEMES) {
      await s.tema(theme)
      await s.assesta()
      // OGNI combinazione si apre da capo: la pagina (chiusa da Esc e dal cambio di misura), poi quel che si chiude da solo
      await openPage(s, page, ctx)
      if (page.overlay) await openOverlay(s, page)
      if (page.prepare === 'chat-fondo') await s.eval(`const sc = document.querySelector('main .overflow-y-auto'); if (sc) sc.scrollTop = sc.scrollHeight; return true`)
      // il messaggio lungo in markdown in cima alla finestra (la cattura lo deve mostrare)
      if (page.prepare === 'chat-md') await s.eval(`
        const sc = document.querySelector('main .overflow-y-auto')
        if (sc) {
          const hh = [...sc.querySelectorAll('h2, h3')].find((x) => (x.textContent ?? '').includes('Riepilogo del mese'))
          if (hh) sc.scrollTop = Math.max(0, sc.scrollTop + hh.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16)
          else sc.scrollTop = 0
        }
        return true`)
      await s.attendiRete({ quieta: 250, entro: 4_000 }).catch(() => undefined)
      // la pagina STABILE: le transizioni di apertura (scale/fade) finite, il rettangolo della radice fermo
      await s.attendiStabileEspr(page.root, { entro: 1_500 }).catch(() => undefined)
      // un overlay che si RICHIUDE da solo (il menu dell'account nel tema scuro chiude entro ~1 s dall'apertura) si RIAPRE prima della misura
      if (page.overlay && (await s.eval(`return ((${page.root})) !== null`).catch(() => true)) === false) {
        await openOverlay(s, page)
        // la riapertura ha le sue transizioni: la radice STABILE prima di misurare
        await s.attendiStabileEspr(page.root, { entro: 1_500 }).catch(() => undefined)
      }
      const raw = await s.eval(`return ${MEASURE_JS(page.root, { withSidebar: page.withSidebar === true })}`)

      if (raw?.missing) {
        const why = await s.eval(`return {
          menus: [...document.querySelectorAll('[role="menu"]')].map((m) => m.getClientRects().length),
          dark: document.documentElement.classList.contains('dark'),
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => ({ rects: d.getClientRects().length, nav: !!d.querySelector('nav'), text: (d.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60) })),
          quick: !!document.querySelector('input[placeholder^="Chiedi qualcosa"]'),
          placeholder: document.querySelector('form textarea')?.placeholder ?? null,
          panels: [...document.querySelectorAll('[data-testid="library-panel"], [data-testid="approvals-center"], [data-testid="plugin-page"], [data-testid="page-view"]')].map((e) => e.dataset.testid),
          overlayDivs: [...document.querySelectorAll('main div.absolute')].filter((d) => d.getClientRects().length > 0).length
        }`).catch((e) => ({ errore: e.message }))
        log(`DIAGNOSTICA ${page.id}: la radice manca ·`, JSON.stringify(why))
      }
      const v = violationsOf(raw, { width: page.scroll ?? null, edges: page.scene !== true })
      const ring = await pressForFocus(page.focus ?? null)
      if (ring !== null && ring !== undefined) {
        v.fuoco = ring === 'nessun bersaglio' ? 0 : ringShown(ring) ? 1 : 0
        if (v.fuoco) v.dettaglio.push(`anello di fuoco dopo la pressione del mouse su «${ring.text}»: ${ring.outline}`)
      }
      // le icone della barra: il centro sulla riga dei semafori (dalla posizione configurata)
      if (LIGHTS) for (const d of lightsRowOf(raw, LIGHTS)) { v.testate += 1; v.dettaglio.push(d) }
      const total = totalOf(v)
      rows.push({ page: page.id, width: w, height: h, theme, total, ...Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'dettaglio')), dettaglio: v.dettaglio, raw: { texts: raw?.texts, bySize: raw?.bySize, scroll: raw?.scroll, tabs: raw?.tabs, heads: raw?.heads } })
      log(`MISURA ${page.id} ${w}×${h} ${theme}: ${total} violazioni · testo ${v.testo} · icone ${v.icone} · larghezza ${v.larghezza} · scorrimento ${v.scorrimento} · a-capo ${v['a-capo']} · testate ${v.testate} · fuoco ${v.fuoco} · emoji ${v.emoji} · sovrapposizioni ${v.sovrapposizioni} · righe-spezzate ${v['righe-spezzate']} · pillole ${v.pillole} · contrasto-puntini ${v['contrasto-puntini']} · altezza-barra ${v['altezza-barra']}${v.dettaglio.length ? '\n    ' + v.dettaglio.slice(0, 8).join('\n    ') : ''}`)
      // le catture: 1280×800 chiaro e scuro per OGNI pagina; anche 900 e 1680 per Chat, Plugin e Libreria
      const capture = (w === 1280 && h === 800) || CAPTURE_GROUPS.includes(page.group)
      if (capture && !NO_SHOTS) await shot(`${page.id}-${w}x${h}-${theme}`)
    }
  }
  await s.viewport(1280, 800)
  await s.tema('chiaro')
  return rows
}

/** La pressione del mouse (senza il rilascio sull'elemento: nessun clic) per misurare l'anello di fuoco. */
const pressForFocus = async (focusExpr) => {
  if (focusExpr === null || focusExpr === undefined) return null
  const point = await s.centro(focusExpr).catch(() => null)
  if (!point || point.x <= 0 || point.y <= 0) return 'nessun bersaglio'
  await s.eval(`document.activeElement?.blur?.(); return true`)
  await s.assesta()
  await s.mouse({ type: 'mouseMoved', x: point.x, y: point.y })
  await s.mouse({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  // la pressione: l'attesa su CONDIZIONE è il fuoco stesso; il rilascio FUORI dall'elemento non ha mai un anello
  await s.attendi(`(() => { const el = document.activeElement; return el && el !== document.body ? (el.tagName ?? '') : null })()`, { entro: 2_000, motivo: 'il fuoco dopo la pressione del mouse' }).catch(() => undefined)
  const ring = await s.eval(RING_JS)
  await s.mouse({ type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1 })
  await s.eval(`document.activeElement?.blur?.(); return true`)
  return ring
}

const sizesOf = (page) => (page.sizes === 'all' ? SIZES : SIZES.filter(([w, h]) => w === 1280))
const wants = (page) => !SOLO || SOLO.includes(page.id)
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]
/**
 * La coppia prima/dopo di una cattura, AFFIANCATA: una immagine sola, col
 * «prima» a sinistra e il «dopo» a destra, ognuna con la sua scritta. La
 * compone il Chromium dell'app stessa (un velo sopra la pagina, via CDP):
 * nessun pacchetto per le immagini. Poi le due grezze escono.
 */
const composePair = async (name) => {
  const before = join(SHOTS, `prima-${name}.png`)
  const after = join(SHOTS, shotName(name))
  if (PRIMA || !existsSync(before) || !existsSync(after)) return false
  const a = readFileSync(before)
  const b = readFileSync(after)
  const [w, h] = pngSize(a)
  const strip = 30
  await s.viewport(2 * w + 8, h + strip)
  const label = (t) => `<div style="height:${strip - 8}px;display:flex;align-items:flex-end;padding:0 12px 6px;font:600 14px -apple-system,Helvetica,sans-serif;color:#444;white-space:nowrap">${t}</div>`
  const img = (buf) => `data:image/png;base64,${buf.toString('base64')}`
  await s.eval(`
    document.getElementById(${JSON.stringify(`sonda-affiancate-${name}`)})?.remove()
    const d = document.createElement('div')
    d.id = ${JSON.stringify(`sonda-affiancate-${name}`)}
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex'
    d.innerHTML = ${JSON.stringify(`<div style="display:flex;flex-direction:column">${label(ETICHETTA_PRIMA)}<img style="display:block;width:${w}px;height:${h}px" src="${img(a)}"></div><div style="width:8px;background:#d9d9de"></div><div style="display:flex;flex-direction:column">${label(ETICHETTA_DOPO)}<img style="display:block;width:${w}px;height:${h}px" src="${img(b)}"></div>`)}
    document.body.appendChild(d)
    await Promise.all([...d.querySelectorAll('img')].map((i) => i.decode().catch(() => undefined)))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return true
  `)
  const png = await s.screenshotRaw()
  await s.eval(`document.getElementById(${JSON.stringify(`sonda-affiancate-${name}`)})?.remove(); return true`)
  // PRIMA si tolgono le due grezze, POI si scrive la composta: il nome della composta
  // è quello della cattura DOPO (`${name}.png`), e rmSync(after) cancellerebbe
  // proprio il file appena scritto (l'ho visto: cartella vuota a fine corsa)
  rmSync(before)
  rmSync(after)
  writeFileSync(join(SHOTS, `${name}.png`), png)
  log('affiancate:', `${name}.png`)
  return true
}

/** La sonda: UN avvio, porta CDP libera a caso, attese su condizione (il motore). */
const s = await avviaSonda({
  prefix: PREFIX,
  envExtra: {},
  log
})

let measurements = []
let porta = null
try {
  const { url, porta: portaCorsa } = await s.avvia()
  porta = portaCorsa
  log('pagina:', url)

  // ---- la GUIDA (prima del setup: poi non si vede più) ----
  await s.attendi(`!!document.querySelector('[data-testid="guide-view"]')`, { entro: 25_000, motivo: 'la guida iniziale compaia' })
  await s.viewport(1280, 800)
  await s.attendiRete({ quieta: 400, entro: 5_000 }).catch(() => undefined)
  const ctx0 = { mainName: NOMI.main, botName: NOMI.bot, teamName: NOMI.team }
  for (const page of PAGES.filter((p) => p.when === 'prima-del-setup' && wants(p))) {
    await trySection('guida', async () => { measurements.push(...(await measurePage(page, ctx0))) })
  }

  // ---- setup: provider finto, guida chiusa, bot, plugin, documenti, squadra, routine, Cassaforte (scripts/lib/scene.mjs) ----
  const { ctx } = await prepara(s, { modello, providerPort, mcpHttpPort, tokenBuono: mcp.token })
  log('setup fatto (bot, plugin, documenti, squadra, routine, cassaforte)')

  // ---- OGNI pagina, OGNI combinazione ----
  for (const page of PAGES.filter((p) => p.when !== 'prima-del-setup' && wants(p))) {
    await trySection(page.id, async () => {
      await s.viewport(1280, 800)
      await s.tema('chiaro')
      await openPage(s, page, ctx)
      measurements.push(...(await measurePage(page, ctx)))
    })
  }

  // ---- la tabella: violazioni per pagina (prima/dopo nel REPORT) ----
  const perPage = {}
  for (const m of measurements) {
    perPage[m.page] ??= { label: PAGES.find((p) => p.id === m.page)?.label ?? m.page, combos: 0, total: 0, by: { testo: 0, icone: 0, larghezza: 0, scorrimento: 0, 'a-capo': 0, testate: 0, fuoco: 0, emoji: 0, sovrapposizioni: 0, 'righe-spezzate': 0, pillole: 0, 'contrasto-puntini': 0, 'altezza-barra': 0, mancante: 0 } }
    perPage[m.page].combos++
    perPage[m.page].total += m.total
    for (const k of Object.keys(perPage[m.page].by)) perPage[m.page].by[k] += m[k] ?? 0
  }
  const grand = Object.values(perPage).reduce((a, p) => a + p.total, 0)
  log('TABELLA violazioni per pagina (somma sulle combinazioni):')
  for (const [id, p] of Object.entries(perPage)) log(`  ${String(p.total).padStart(6)}  ${p.label} (${p.combos} combinazioni) · ${Object.entries(p.by).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || 'zero'}`)
  log(`TOTALE: ${grand} violazioni in ${measurements.length} combinazioni misurate`)
  const file = join(MISURE, `${PRIMA ? 'prima' : 'dopo'}.json`)
  writeFileSync(file, JSON.stringify({ build: buildFingerprint(), app: APP_DIR, semafori: LIGHTS, totale: grand, combinazioni: measurements.length, perPage, measurements: measurements.map(({ raw, dettaglio, ...rest }) => ({ ...rest, dettaglio, scroll: raw?.scroll ?? null, bySize: raw?.bySize ?? null, heads: raw?.heads ?? null })) }, null, 1))
  log('misure salvate in', file)
  check('la sonda di misura è arrivata in fondo', true)
  check(`nessuna violazione (${grand} in ${measurements.length} combinazioni)`, grand === 0 && measurements.length > 0, `${grand} violazioni in ${measurements.length} combinazioni`)
  check('ogni pagina elencata in DS4 è stata misurata', Object.keys(perPage).length >= PAGES.filter((p) => wants(p)).length, `${Object.keys(perPage).length} di ${PAGES.filter((p) => wants(p)).length}`)
  // una pagina misurata in meno di sei combinazioni (3 misure × 2 temi) non è misurata: nel REPORT «prima» i buchi si dichiarano
  const short = Object.values(perPage).filter((pg) => pg.combos < SIZES.length * THEMES.length)
  check(`ogni pagina in tutte le ${SIZES.length * THEMES.length} combinazioni`, short.length === 0, short.map((pg) => `${pg.label} (${pg.combos})`).join(', '))

  // ---- le catture affiancate (solo nella corsa «dopo», con --affiancate) ----
  if (AFFIANCATE && !PRIMA && !NO_SHOTS) {
    const names = [...new Set(measurements.filter((m) => (m.width === 1280 && m.height === 800) || CAPTURE_GROUPS.includes(PAGES.find((p) => p.id === m.page)?.group)).map((m) => `${m.page}-${m.width}x${m.height}-${m.theme}`))]
    let made = 0
    for (const n of names) {
      if (await composePair(n).catch((e) => { log('affiancate: salto', n, '—', e.message); return false })) made++
    }
    check(`le catture prima/dopo sono affiancate (${made} su ${names.length})`, made === names.length, `${names.length - made} senza la coppia`)
    await s.viewport(1280, 800)
  }

  // ---- pulizia ----
  const fine = await s.fine({ porta })
  const left = fine.conteggio
  check('pulizia: 0 cartelle sandbot-fase-design-* rimaste', left === 0 && fine.cartelleRimaste.length === 0, `rimaste ${left}${fine.cartelleRimaste.length ? ': ' + fine.cartelleRimaste.join(', ') : ''}`)
  check('I1: 0 connessioni verso i servizi LLM locali veri (il registro è vuoto)', fine.tentativiLocali.length === 0, messaggioTentativiLocali(fine.tentativiLocali))
  const daemons = await import('./lib/probe-daemons.mjs').then((m) => m.findProbeDaemons(PREFIX))
  check('pulizia: 0 daemon della sonda', daemons.length === 0, JSON.stringify(daemons))
  const fakes = spawnSync('/usr/bin/pgrep', ['-f', 'fake-plugin-pulita-mcp.mjs'], { encoding: 'utf8' })
  const fakePids = (fakes.stdout ?? '').split('\n').filter(Boolean).map(Number)
  check('pulizia: 0 server MCP finti rimasti', fakePids.length === 0, `pid ${fakePids.join(', ')}`)
} catch (e) {
  log('FATAL:', e.message)
  log(s.appLog().slice(-1200))
  results.push({ name: 'la sonda è arrivata in fondo senza errori', ok: false, detail: e.message })
  await s.fine({ porta }).catch(() => undefined)
}
modello.chiudi()
mcp.chiudi()

const ok = results.filter((r) => r.ok).length
log(`CORSA fase-design${PRIMA ? ' (PRIMA)' : ''}: ${ok}/${results.length} controlli OK`)
if (results.some((r) => !r.ok)) {
  for (const r of results.filter((x) => !x.ok)) log('  KO:', r.name, '—', r.detail)
  process.exit(1)
}
process.exit(0)
