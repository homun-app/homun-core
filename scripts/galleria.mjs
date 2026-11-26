#!/usr/bin/env node
// F1 (fase fondamenta): LA GALLERIA VISIVA — regressione visiva pixel per
// pixel. Avvia l'app VERA da out/ con lo stesso ambiente delle sonde (dati
// temporanei, HOME finta, modello finto su 127.0.0.1, Composio finto — il
// motore sonda.mjs), apre una lista fissa di SCENE (le pagine della sonda di
// design, in scripts/lib/scene.mjs, più la pagina dei componenti di F2), le
// cattura via CDP e le confronta con le immagini approvate.
//
//   node scripts/galleria.mjs [--solo id1,id2] [--approva id1,id2|tutte]
//
// Determinismo (la condizione perché il confronto abbia senso):
//   · orologio fermo nel renderer (Date e Date.now fissati a 2026-11-20T10:00:00Z);
//   · animazioni e transizioni spente e cursore di testo nascosto, col foglio
//     di stile iniettato SOLO dalla galleria (foglioGalleria del motore);
//   · attesa di document.fonts.ready e di due requestAnimationFrame (s.cattura);
//   · attesa su condizione, non a tempo (attendiRete, attendiStabile);
//   · se un pezzo resta variabile si MASCHERA (MASCHERE qui sotto) — un
//     selettore coperto da un rettangolo pieno prima del confronto, col
//     motivo scritto accanto; le maschere sono elencate nel REPORT.
//
// Il confronto: magick compare -metric AE -fuzz 1% — una scena passa solo con
// 0 pixel diversi. Per ogni scena diversa: galleria/.diff/<nome>.png con tre
// pannelli (approvata | nuova | differenza in rosso) e .diff/index.html.
// Esce con 1 se una scena è diversa, manca, o è nuova senza immagine approvata.
// NON si approva mai in automatico: --approva copia e STAMPA l'elenco delle
// scene, che va in un commit con il motivo.
// Catture PNG alla scala 1 senza metadati (magick -strip). Le approvate stanno
// in galleria/approvate/ (peso totale ≤ 15 MB, controllato a fine corsa).
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { avviaSonda, ROOT } from './lib/sonda.mjs'
import { PAGES, NOMI, preparaDeterministica, closeOverlays, openPage, openOverlay, ISTANTE_FERMO } from './lib/scene.mjs'
import { modelloFinto } from './lib/modello-finto.mjs'

const MAGICK = '/opt/homebrew/bin/magick'
const GALLERIA = join(ROOT, 'galleria')
const APPROVATE = join(GALLERIA, 'approvate')
const CATTURE = join(GALLERIA, '.catture')
const DIFF = join(GALLERIA, '.diff')
for (const d of [APPROVATE, CATTURE, DIFF]) mkdirSync(d, { recursive: true })

const argv = process.argv.slice(2)
const argValue = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
/** --app: l'app da avviare (package.json + out/; default: questo repo) — la prova ROSSA sulla base la passa. */
const APP_DIR = resolve(argValue('--app') ?? ROOT)
const SOLO = argValue('--solo')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null
const APPROVA = argValue('--approva')
const approvaSet = APPROVA === 'tutte' ? 'tutte' : APPROVA?.split(',').map((x) => x.trim()).filter(Boolean) ?? null

// --foglio: il FOGLIO DI CONTROLLO delle approvate — tutte in miniatura a
// gruppi (coi nomi), il click apre l'immagine intera. Serve a GUARDARSELE
// davvero, una per una: niente «nessun difetto» per gruppi interi.
if (argv.includes('--foglio')) {
  const idDi = (nome) => nome.replace(/\.png$/, '').replace(/-(chiaro|scuro)(-900)?$/, '')
  const gruppoDi = (id) => id === 'guida' ? 'Guida' : id.startsWith('componenti-') ? 'Componenti' : PAGES.find((p) => p.id === id)?.group ?? 'Altre'
  const ordine = ['Guida', 'Chat', 'Menu', 'Dialoghi', 'Barra', 'Plugin', 'Libreria', 'Approvazioni', 'Attività', 'Impostazioni', 'Componenti', 'Altre']
  const gruppi = new Map()
  for (const f of readdirSync(APPROVATE).filter((f) => f.endsWith('.png')).sort()) {
    const g = gruppoDi(idDi(f))
    if (!gruppi.has(g)) gruppi.set(g, [])
    gruppi.get(g).push(f)
  }
  writeFileSync(join(DIFF, 'foglio.html'), [
    '<!doctype html><meta charset="utf-8"><title>galleria — il foglio di controllo delle approvate</title>',
    '<style>body{background:#141419;color:#eee;font:14px -apple-system,Helvetica,sans-serif;margin:24px}h1{font-size:20px}h2{margin:28px 0 8px;font-size:16px}a{display:inline-block;margin:6px;vertical-align:top}img{display:block;width:240px;border:1px solid #444;border-radius:4px}span{display:block;font:11px ui-monospace,monospace;color:#aaa;padding:2px 0 6px}</style>',
    '<h1>Le approvate, un gruppo per volta — il click apre l\'immagine intera</h1>',
    ...[...gruppi.keys()].sort((a, b) => (ordine.indexOf(a) < 0 ? ordine.length : ordine.indexOf(a)) - (ordine.indexOf(b) < 0 ? ordine.length : ordine.indexOf(b)) || a.localeCompare(b)).map((g) => `<h2>${g} (${gruppi.get(g).length})</h2>` + gruppi.get(g).map((f) => `<a href="../approvate/${f}" target="_blank"><img loading="lazy" src="../approvate/${f}" alt="${f}"><span>${f.replace(/\.png$/, '')}</span></a>`).join('')),
    ''
  ].join('\n'))
  console.log('[galleria] foglio di controllo:', join(DIFF, 'foglio.html'))
  process.exit(0)
}

/** Le dimensioni della galleria: ogni scena a 1280×800 in chiaro e in scuro; anche 900×640 per queste. */
const LARGHEZZE_EXTRA = ['chat', 'plugin-lista', 'libreria-griglia']
// fase linguaggio-ritocchi (R3): il controllo «niente tagliato» vale a 900
// per OGNI scena — le altre ci arrivano con una passata SOLO CONTROLLO (niente
// cattura, niente confronto: la 900 delle tre scene qui sopra si controlla
// già durante la cattura)
const combinazioni = (page) => [
  [1280, 'chiaro'], [1280, 'scuro'],
  ...(LARGHEZZE_EXTRA.includes(page.id) ? [[900, 'chiaro'], [900, 'scuro']] : [[900, 'solo-controllo']])
]

/**
 * LE MASCHERE: l'eccezione al determinismo. Un selettore coperto da un
 * rettangolo pieno PRIMA del confronto, col motivo scritto accanto. Ogni
 * maschera va elencata nel REPORT della fase. Vuota alla prima corsa: si
 * aggiunge una maschera solo per una differenza che resta tra due corse di
 * fila identiche (mai per nascondere una differenza reale).
 *
 * G1 (fase fondamenta-galleria): le maschere delle ORE (registro, documento,
 * chat, chat-avvisi, chat-bot, chat-team) sono state TOLTE: da G0 i dati sono
 * seminati all'istante fermo e nessuna riga è più a orologio reale — il
 * controllo a ogni cattura le dichiarava MORTE (0 elementi coperti), erano
 * codice morto. Resta la mascotte del dialogo: il colore è hash dell'id del
 * bot che verrà creato, casuale per definizione.
 */
const MASCHERE = {
  'dialogo-nuovo': [
    { espr: `(() => [...document.querySelectorAll('[role="dialog"] svg')].filter((sv) => { const r = sv.getBoundingClientRect(); return r.width >= 60 && r.height >= 60 }))()`,
      motivo: 'l\'anteprima della mascotte del nuovo bot: il colore è hash dell\'id casuale del bot che verrà creato — diverso a ogni corsa per definizione' }
  ]
}
/**
 * fase linguaggio-ritocchi: I TRE CONTROLLI che la macchina fa a OGNI scena,
 * oltre al confronto coi pixel. Nessuno dei tre difetti della fase era stato
 * preso da un controllo automatico: ora li prende la galleria.
 *
 * R1 — le TRADUZIONI MANCANTI raccolte dal vivo: il renderer (con
 * SANDBOT_TEST_*, solo nelle corse di prova) accumula gli id che Lingui
 * dichiara mancanti; la galleria svuota l'elenco a ogni scena. Prende anche
 * un messaggio costruito a runtime, che l'estrazione statica non vede
 * (l'allineamento del catalogo al codice lo copre la guardia della suite,
 * src/__tests__/guardie/lingui-catalogo.test.ts).
 *
 * R2 — UN CONTROLLO UNA VOLTA SOLA: due controlli interattivi VISIBILI con
 * lo stesso nome accessibile e lo stesso ruolo (gruppo, bottone, scheda)
 * nella stessa pagina sono ROSSI. Unica eccezione, dichiarata per ruolo e
 * contenitore: i controlli ripetuti UNA PER RIGA («Apri», «⋯», l'interruttore
 * di ogni riga) — ognuno sta in una riga o card DIVERSA di una lista o
 * tabella; due nomi uguali nella STESSA riga restano rossi.
 *
 * R3 — NIENTE TAGLIATO: il rettangolo di ogni controllo visibile (scheda,
 * pillola, bottone, campo) deve stare dentro quello del contenitore che
 * ritaglia più vicino (overflow hidden/auto/scroll — chi scorre in orizzontale
 * a riposo sta tagliando) e dentro la finestra in orizzontale. In verticale
 * contano solo i ritagli DURI (hidden/clip): un controllo oltre il bordo di
 * un corpo che scorre è lo scorrimento, non un difetto. In più la BARRA
 * delle pagine di elenco non scorre in orizzontale (scrollWidth ≤ clientWidth).
 */
const VISIBILE_JS = `
  const visibile = (el) => {
    if (!el.getClientRects().length) return false
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    // VISIBILE = interseca la finestra: il popover «Chiedi al volo» sta nel
    // DOM già posizionato SOPRA lo schermo quando è chiuso (e chi sta oltre
    // la piega di un corpo che scorre non è nella cattura) — né l'uno né
    // l'altro si vedono
    if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) return false
    // le azioni al passaggio (opacity-0 fino all'hover) non sono visibili
    for (let n = el; n instanceof Element; n = n.parentElement) {
      const st = getComputedStyle(n)
      if (st.visibility === 'hidden' || Number(st.opacity) === 0) return false
    }
    return true
  }`

/** R2: i controlli duplicati (nome accessibile + ruolo), con l'eccezione per riga. */
const CONTROLLO_DOPPIONI = `return (() => {
  ${VISIBILE_JS}
  const nomeDi = (el) => {
    const aria = el.getAttribute('aria-label') ?? el.getAttribute('title')
    return String(aria ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim()
  }
  const ruoloDi = (el) => el.getAttribute('role') ?? el.tagName.toLowerCase()
  // la riga (o card) del controllo ripetuto: dentro una lista o una tabella
  // (una voce di un listbox è una riga anche lei: ogni opzione la sua azione)
  const rigaDi = (el) =>
    el.closest('tr, li, [role="row"], [role="listitem"], [role="option"], [data-testid*="-row"], [data-testid*="-card"], [data-testid*="-item"]')
    ?? (el.closest('.divide-y') ? el.closest('.divide-y > *') : null)
  const perChiave = new Map()
  for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [role="group"]')) {
    if (!visibile(el)) continue
    const nome = nomeDi(el)
    if (!nome) continue
    const chiave = ruoloDi(el) + '::' + nome
    if (!perChiave.has(chiave)) perChiave.set(chiave, [])
    perChiave.get(chiave).push(el)
  }
  const doppi = []
  for (const [chiave, els] of perChiave) {
    if (els.length < 2) continue
    const righe = els.map(rigaDi)
    if (righe.every(Boolean) && new Set(righe).size === els.length) continue
    doppi.push('«' + chiave.split('::')[1] + '» (' + chiave.split('::')[0] + ') ×' + els.length)
  }
  return doppi
})()`

/** R3: i controlli tagliati dal contenitore o dalla finestra, e la barra che scorre in orizzontale. */
const CONTROLLO_TAGLI = `return (() => {
  ${VISIBILE_JS}
  const TOL = 0.5
  const problemi = []
  const CONTROLLI = 'button, [role="button"], [role="tab"], a[href], input, select, textarea, [role="switch"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"]'
  const clippa = (el, assi) => {
    for (let n = el.parentElement; n instanceof Element; n = n.parentElement) {
      const st = getComputedStyle(n)
      // in X il primo che ritaglia (hidden/clip/auto/scroll) è il contenitore
      // del controllo; in Y il primo che ritaglia in QUALSIASI modo decide:
      // se scorre (auto/scroll) è lo scorrimento di sempre — non un difetto —
      // e si smette di cercare, altrimenti un ritaglio duro più lontano
      // prenderebbe le righe a metà del bordo di una lista che scorre
      if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        if (assi === 'x' && ['hidden', 'clip', 'auto', 'scroll'].includes(st.overflowX)) return { n, asse: st.overflowX }
        if (assi === 'y') return ['hidden', 'clip'].includes(st.overflowY) ? { n, asse: st.overflowY } : null
      }
    }
    return null
  }
  const descrizione = (el) => {
    const nome = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? (el.textContent ?? '').replace(/\\s+/g, ' ').trim()
    const ruolo = el.getAttribute('role') ?? el.tagName.toLowerCase()
    return '«' + String(nome).slice(0, 40) + '» (' + ruolo + ')'
  }
  for (const el of document.querySelectorAll(CONTROLLI)) {
    if (!visibile(el)) continue
    const r = el.getBoundingClientRect()
    const fuori = (v, min, max) => v < min - TOL || v > max + TOL
    const clipX = clippa(el, 'x')
    if (clipX) {
      const c = clipX.n.getBoundingClientRect()
      if (fuori(r.left, c.left, c.right) || fuori(r.right, c.left, c.right)) {
        problemi.push(descrizione(el) + ' tagliato in orizzontale dal contenitore (left ' + Math.round(r.left) + ', right ' + Math.round(r.right) + ' su ' + Math.round(c.left) + '–' + Math.round(c.right) + ')')
        continue
      }
    } else if (r.left < -TOL || r.right > window.innerWidth + TOL) {
      problemi.push(descrizione(el) + ' esce dalla finestra (left ' + Math.round(r.left) + ', right ' + Math.round(r.right) + ' su ' + window.innerWidth + ')')
      continue
    }
    const clipY = clippa(el, 'y')
    if (clipY) {
      const c = clipY.n.getBoundingClientRect()
      if (fuori(r.top, c.top, c.bottom) || fuori(r.bottom, c.top, c.bottom)) {
        problemi.push(descrizione(el) + ' tagliato in verticale da un ritaglio duro (top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom) + ' su ' + Math.round(c.top) + '–' + Math.round(c.bottom) + ')')
      }
    }
  }
  // niente di cui sopra su elementi invisibili: il popover «Chiedi al volo»
  // chiuso sta nel DOM sopra lo schermo, e le voci scorse fuori da una lista
  // non si vedono — un controllo che non si vede non è tagliato
  // la barra delle pagine di elenco non scorre in orizzontale
  for (const barra of document.querySelectorAll('[data-page-shell="toolbar"]')) {
    const riga = barra.querySelector(':scope > div') ?? barra
    for (const el of [barra, riga]) {
      if (el.scrollWidth > el.clientWidth + TOL) {
        problemi.push('la barra della pagina scorre in orizzontale (scrollWidth ' + el.scrollWidth + ' > clientWidth ' + el.clientWidth + ')')
        break
      }
    }
  }
  return problemi
})()`

/** R1: svuota il raccoglitore e torna quanti id ha scartato (vedasi dove si chiama, in cattura). */
const scartaTraduzioni = (s) => s.eval('return window.__sandbotTraduzioniMancanti ? window.__sandbotTraduzioniMancanti.drain().length : 0')

/**
 * I tre controlli di una scena (R1/R2/R3): riempiono `errori` — una scena
 * col vaso rotto è ROSSA, non catturata.
 */
const controlliScena = async (s, errori) => {
  // R1: le traduzioni mancanti raccolte dal renderer da quando si è svuotato l'ultima volta
  const mancanti = await s.eval('return (window.__sandbotTraduzioniMancanti ? window.__sandbotTraduzioniMancanti.drain() : null)')
  if (mancanti === null) {
    errori.push('il raccoglitore delle traduzioni mancanti non è nel renderer (SANDBOT_TEST_USER_DATA attivo?)')
  } else {
    const unici = [...new Map(mancanti.map((m) => [`${m.locale}:${m.id}`, m])).values()]
    for (const m of unici) errori.push(`traduzione mancante (${m.locale}): ${m.id}`)
  }
  // R2: un controllo una volta sola
  for (const d of await s.eval(CONTROLLO_DOPPIONI)) errori.push(`controllo duplicato: ${d}`)
  // R3: niente tagliato
  for (const p of await s.eval(CONTROLLO_TAGLI)) errori.push(`controllo tagliato: ${p}`)
}

/**
 * Le scene dei COMPONENTI (F2/G2): UNA PER SEZIONE della pagina, in chiaro e
 * in scuro — come Storybook/Chromatic, una cattura per storia, non una
 * pagina lunga in una foto sola. L'elenco delle sezioni lo dà la pagina
 * stessa (__galleriaComponenti.sezioni()): le scene nascono a runtime.
 */
const sceneComponenti = (sezioni) => sezioni.map((id) => ({
  id: `componenti-${id}`, label: `Componenti › ${id}`, group: 'Componenti',
  root: `document.querySelector('[data-testid="galleria-componenti"]')`,
  scene: true, withSidebar: true, open: 'componenti', sezione: id, focus: null
}))

const nomeCattura = (page, tema, w) => `${page.id}-${tema}${w !== 1280 ? `-${w}` : ''}.png`

const T0 = Date.now()
const log = (...a) => console.log('[galleria]', `+${((Date.now() - T0) / 1000).toFixed(1)}s`, ...a)

/**
 * La cattura di UNA combinazione: viewport, tema, apertura della scena,
 * preparazione, maschere, screenshot + strip. I controlli delle maschere e
 * i tre controlli di fase linguaggio-ritocchi (controlliScena) riempiono
 * `errori`: una scena col vaso rotto è ROSSA, non catturata.
 * Con tema 'solo-controllo' (R3, la passata a 900 delle scene senza cattura):
 * apre la scena, fa i controlli e basta — niente tema, maschere né foto.
 */
/**
 * Il LAYOUT ASSESTATO dopo un cambio di misura. L'app ricalcola il layout con
 * un resize DEBOUNCED (App.tsx, RESIZE_DEBOUNCE_MS), e fino a quel momento la
 * pagina è com'era: a 900 la barra laterale resta LARGA e l'area della pagina
 * è 636 invece di 824. La stabilità a due frame del motore (attendiStabile) ci
 * casca, perché nel transitorio i rettangoli sono fermi. Qui si chiede che
 * barra e colonna tengano lo stesso rettangolo per più del debounce: se dopo
 * di esso cambiano, quello non era il layout della finestra, e si ripete.
 * Torna false (senza lanciare) se non si assesta mai: la scena è ROSSA col
 * motivo, la corsa non muore.
 */
const attendiLayout = (s) => s.attendi(`(() => new Promise((ok) => {
  const leggi = () => ['aside', 'main'].map((q) => { const el = document.querySelector(q); if (!el) return 'x'; const r = el.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.width) }).join('|')
  const prima = leggi()
  setTimeout(() => ok(leggi() === prima), 180)
}))()`, { entro: 6_000, motivo: 'il layout della finestra nuova sia applicato (il resize dell\'app è debounced)' })

const cattura = async (s, page, ctx, w, tema, errori = []) => {
  const solo = tema === 'solo-controllo'
  await s.viewport(w, 800 - 800 + (w === 900 ? 640 : 800))
  if (solo) {
    // R3: la passata di SOLO CONTROLLO a 900. Le PAGINE restano aperte al
    // cambio di misura (le aveva aperte la cattura a 1280): riaprirle
    // significherebbe cliccare di nuovo quel che la scena ha già cliccato, e
    // certi clic non sono idempotenti — la riga di una squadra GIÀ attiva la
    // CHIUDE, e la barra cambierebbe secondo il NUMERO di passate, non secondo
    // l'app. Si riapre solo quel che il cambio di misura chiude da sé: i
    // dialoghi, i menu, i fogli (openOverlay rifà lui le sue condizioni)
    if (!(await attendiLayout(s).catch(() => false))) errori.push('il layout non si è assestato dopo il cambio di misura')
    if (page.overlay) { await closeOverlays(s); await openOverlay(s, page) }
    await s.attendiRete({ quieta: 300, entro: 8_000 }).catch(() => undefined)
    await s.attendiStabile('body', { entro: 4_000 }).catch(() => undefined)
    await controlliScena(s, errori)
    return null
  }
  await s.tema(tema)
  await closeOverlays(s)
  // R1: le traduzioni mancanti si contano da QUI in poi. La scena di prima,
  // ri-renderizzata dal cambio di misura, ha potuto rendere di nuovo i suoi id
  // (l'evento «missing» scatta a ogni chiamata): senza questo scarto finivano
  // nella scena NUOVA — «V_pNa0», che è di Collegati, attribuito alla scena
  // dopo. Nella passata di solo controllo non si scarta: lì la pagina è
  // quella della scena stessa, e il suo ri-render al cambio di misura conta
  await scartaTraduzioni(s)
  // la pagina dei componenti (F2/G2): UNA SEZIONE per scena, la apre il suo
  // API (apri(sezione)), la chiude closeOverlays
  if (page.open === 'componenti') {
    const api = await s.eval(`return typeof window.__galleriaComponenti === 'object' && typeof window.__galleriaComponenti?.apri === 'function'`).catch(() => false)
    if (!api) {
      // l'import di App.tsx è silenzioso: qui lo rifacciamo per VEDERE l'errore
      const errore = await s.eval(`try { await import(window.__galleriaUrl); return 'import ok' } catch (e) { return 'import KO: ' + (e?.message ?? e) }`).catch((e) => 'eval KO: ' + e.message)
      log('ERRORE: l\'API della pagina componenti non è montata —', errore, '· url:', await s.eval(`return window.__galleriaUrl ?? null`).catch(() => '?'))
    }
    // un REMOUNT pulito a ogni combinazione (apri chiude e rimonta: come le
    // altre pagine si riaprono)
    await s.eval(`window.__galleriaComponenti?.apri(${JSON.stringify(page.sezione)}); return true`)
    await s.attendi(`(() => { const el = document.querySelector('[data-testid="galleria-componenti-contenuto"]'); return !!el })()`, { entro: 10_000, motivo: `la sezione ${page.sezione} della pagina componenti si apra col suo contenuto` })
    // G2: la radice della sezione deve stare INTERA nel viewport — una
    // cattura che taglia il fondo in silenzio non è una prova (se la sezione
    // non ci sta, si divide in due scene: chi sta fuori non si vede).
    // Solo alle CATTURE (800 di altezza): la passata di controllo a 900 è
    // 640 di altezza e le sezioni lunghe non c'entrano per costruzione
    const fuori = solo ? null : await s.eval(`return (() => {
      const el = document.querySelector('[data-testid="galleria-componenti-contenuto"]')
      if (!el) return 'il contenuto della pagina componenti non è nel DOM'
      const sezione = el.dataset.sezione ?? null
      if (sezione !== null && sezione !== ${JSON.stringify(page.sezione)}) return 'la sezione aperta è «' + sezione + '», non «' + ${JSON.stringify(page.sezione)} + '»'
      const r = el.getBoundingClientRect()
      if (r.height === 0) return 'la sezione è alta 0'
      if (r.top < -0.5 || r.bottom > window.innerHeight + 0.5) {
        return 'la sezione ' + (sezione ?? '(pagina intera)') + ' esce dal viewport: top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom) + ' su ' + window.innerHeight
      }
      return null
    })()`)
    if (fuori) errori.push(fuori)
  } else {
    await openPage(s, page, ctx)
  }
  if (page.overlay && page.open !== 'componenti') await openOverlay(s, page)
  if (page.prepare === 'chat-fondo') await s.eval(`
    const sc = document.querySelector('main .overflow-y-auto')
    const n = document.querySelector('[data-notice]')
    if (sc && n) sc.scrollTop = Math.max(0, n.getBoundingClientRect().top - sc.getBoundingClientRect().top - 60)
    else if (sc) sc.scrollTop = sc.scrollHeight
    return true`)
  // la chat col messaggio lungo: lo scroll dichiara il FONDO, lo stato a cui
  // l'app converge comunque (stick-to-bottom: le notizie raggruppate fanno
  // un secondo passo di rendering e l'app riscorre). L'ancora al TITOLO di
  // prima faceva la CORSA con l'app: in una corsa su sei (la terza di
  // stabilità, dentro fatto.mjs con la macchina che aveva appena lavorato)
  // vinceva lei e la scena finiva col messaggio in CIMA, rossa (1,6e9
  // livelli). Con entrambi gli scrittori d'accordo sul fondo la corsa è
  // innocua; il ri-ancoraggio per ULTIMO (qui sotto, in cattura) chiude il
  // caso del contenuto che cresce DOPO il prepare.
  if (page.prepare === 'chat-md') await s.eval(`
    const sc = document.querySelector('main .overflow-y-auto')
    if (sc) sc.scrollTop = sc.scrollHeight
    return true`)
  // le sezioni ASINCRONE delle Impostazioni › Generali (Spazio su disco, il
  // motore del computer dei bot) si riempiono da RPC che NON passano dalla
  // rete del renderer: la cattura poteva cadere a metà (righe e filetta
  // assenti, e la colonna che da corta diventava lunga faceva apparire e
  // sparire la barra di scorrimento — il rettangolo 6×17 che differiva tra
  // due corse). Si aspetta la CONDIZIONE, non un tempo
  if (page.id === 'impostazioni-generali') {
    await s.attendi(`(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.querySelector('nav'))
      if (!d) return false
      const t = d.textContent ?? ''
      if (t.includes('Sto guardando')) return false
      return !!d.querySelector('[data-testid="disk-space-section"]') && t.includes('Spazio libero sul Mac')
    })()`, { entro: 10_000, motivo: 'le sezioni asincrone delle Impostazioni Generali (spazio su disco, motore) siano caricate' })
  }
  // le maschere della scena PRECEDENTE si tolgono: i rettangoli sono fissi
  // allo schermo e coprirebbero le scene successive. UNA funzione sola del
  // motore (sonda.mjs), con lo stesso attributo della creazione — la copia
  // che stava qui cercava «data-galleriaMaschera» e non toglieva mai nulla
  await s.togliMaschere()
  // il POPOVER ⌘K si chiude da solo entro ~1 s dall'apertura (già nell'originale):
  // la cattura parte SUBITO dopo l'apertura, prima delle attese di stabilità
  const catturaPrima = !solo && page.id === 'popover-chiedi'
  if (!catturaPrima) {
    await s.attendiRete({ quieta: 300, entro: 8_000 }).catch(() => undefined)
    await s.attendiStabile('body', { entro: 4_000 }).catch(() => undefined)
  }
  // fase linguaggio-ritocchi: i tre controlli (R1/R2/R3) a OGNI passata,
  // prima delle maschere di questa scena — PRIMA delle attese erano già tutti
  // i render della scena, e il confronto dei pixel non li vede
  await controlliScena(s, errori)
  if (solo) return null
  // G1: il CONTROLLO a ogni cattura — PRIMA delle maschere di questa scena,
  // nel DOM non può esserci NESSUN rettangolo (con qualunque ortografia
  // dell'attributo: un rettangolo che la pulizia non toglie è una maschera
  // avanzata, e la scena sotto resta mezza invisibile al confronto)
  const avanzano = await s.contaMaschere()
  if (avanzano !== 0) errori.push(`avanzano ${avanzano} rettangoli di maschera dalla scena precedente`)
  let coperti = 0
  for (const m of MASCHERE[page.id] ?? []) {
    const n = await s.mascheraEspr(m.espr)
    coperti += n
    log(`maschera ${page.id} ${w}/${tema}: ${n} elementi — ${m.motivo}`)
    // una maschera dichiarata che copre 0 elementi è MORTA: o l'ora non è
    // più a orologio reale (va tolta dalla configurazione) o l'espressione
    // è sbagliata (va corretta) — non può passare in silenzio
    if (n === 0) errori.push(`maschera morta (0 elementi coperti): ${m.motivo}`)
  }
  // il numero di rettangoli presenti dev'essere il numero di elementi coperti
  // dalle maschere di QUESTA scena (per le scene senza maschere: 0)
  const presenti = await s.contaMaschere()
  if (presenti !== coperti) errori.push(`rettagli di maschera nel DOM ${presenti} ≠ elementi coperti ${coperti}`)
  // lo scroll della chat si RI-ANCORA al fondo per ULTIMO, dopo tutte le
  // attese e i controlli: se il contenuto è cresciuto dopo il prepare (il
  // secondo passo delle notizie raggruppate), lo scrollTop assoluto messo
  // allora non è più il fondo — e l'ancora dev'essere l'ULTIMO scrittore
  // prima dello screenshot
  if (page.prepare === 'chat-md') {
    await s.eval(`const sc = document.querySelector('main .overflow-y-auto'); if (sc) sc.scrollTop = sc.scrollHeight; return true`)
  }
  const percorso = join(CATTURE, nomeCattura(page, tema, w))
  await s.cattura(percorso)
  // PNG senza metadati: strip subito dopo la cattura
  const r = spawnSync(MAGICK, [percorso, '-strip', percorso])
  if (r.status !== 0) throw new Error('magick -strip è fallito su ' + percorso)
  return percorso
}

/** Il confronto di UNA cattura con l'approvata: AE con fuzz 1%, 0 pixel diversi per passare. */
const confronta = (page, tema, w) => {
  const nome = nomeCattura(page, tema, w)
  const approvata = join(APPROVATE, nome)
  if (!existsSync(approvata)) return { nome, scena: page.id, esito: 'nuova' }
  const diff = join(DIFF, nome)
  const r = spawnSync(MAGICK, ['compare', '-metric', 'AE', '-fuzz', '1%', approvata, join(CATTURE, nome), diff], { encoding: 'utf8' })
  const ae = Number(String(r.stderr ?? '').trim().split(/\s/)[0])
  if (Number.isNaN(ae)) return { nome, scena: page.id, esito: 'errore', dettaglio: String(r.stderr ?? r.error).slice(0, 200) }
  if (ae === 0) return { nome, scena: page.id, esito: 'uguale' }
  // tre pannelli: approvata | nuova | differenza in rosso
  spawnSync(MAGICK, ['montage', approvata, join(CATTURE, nome), diff, '-tile', '3x1', '-geometry', '+2+2', '-background', '#26262b', '-fill', '#fff', '-pointsize', '16', '-label', `${nome} · ${ae} px`, diff])
  return { nome, scena: page.id, esito: 'diversa', ae }
}

// ---- la corsa ----
const esiti = []
try {
  const modello = modelloFinto()
  const porta = await modello.avvia()
  // la pagina dei COMPONENTI (F2): compilata FUORI dal build dell'app (il
  // marcatore non entra in out/), copiata accanto a index.html e caricata dal
  // renderer con un import() dinamico dietro SANDBOT_TEST_GALLERIA=1
  log('compilo il modulo della pagina dei componenti…')
  const compilo = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build', '--config', 'scripts/galleria-modulo.config.mjs'], { cwd: ROOT, encoding: 'utf8' })
  if (compilo.status !== 0) throw new Error('la compilazione del modulo è fallita: ' + String(compilo.stderr ?? compilo.stdout).slice(-800))
  const MODULO = 'galleria-componenti.js' // l'estensione .js: il protocol homun:// non conosce .mjs (MIME_TYPES) e l'import fallirebbe
  const MODULO_CSS = 'galleria-componenti.css'
  copyFileSync(join(GALLERIA, '.modulo', MODULO), join(ROOT, 'out', 'renderer', MODULO))
  const cssModulo = existsSync(join(GALLERIA, '.modulo', MODULO_CSS)) ? readFileSync(join(GALLERIA, '.modulo', MODULO_CSS), 'utf8') : null
  log('modulo compilato:', MODULO + (cssModulo ? ` + css (${Math.round(cssModulo.length / 1024)} KB)` : ''))

  const s = await avviaSonda({
    prefix: 'sandbot-galleria',
    appDir: APP_DIR,
    envExtra: { SANDBOT_TEST_GALLERIA: '1' },
    // l'orologio fermo è a SETTE GIORNI dall'avvio della corsa e i dati finti nascono
    // a ora reale (≈ l'avvio): OGNI tempo relativo mostrato è «7 giorni fa» — la stringa
    // non cambia né col jitter di secondi del setup né tra una corsa e l'altra. Un
    // orologio fermo a offset 0 rendeva i tempi relativi dipendenti dal tempo di setup
    // («adesso» vs «1 minuto») e un istante costante nel passato li faceva crescere a
    // ogni corsa (la distanza dal main, a orologio reale, non si congela).
    // l'orologio fermo ALL'ISTANTE FERMO dei dati (2026-11-20T10:00:00Z): le date
    // mostrate («20/11/2026») e i tempi relativi («adesso») sono COSTANTI per sempre,
    // a qualsiasi ora e giorno girino le corse
    orologioFermo: new Date(ISTANTE_FERMO).toISOString(),
    // il rendering DETERMINISTICO: rasterizzazione software, niente LCD/subpixel,
    // profilo colore forzato — il testo si rasterizza uguale a ogni corsa
    interruttoriChromium: ['--disable-gpu', '--disable-gpu-rasterization', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--force-color-profile=srgb', '--disable-partial-raster'],
    foglioGalleria: true,
    // il nome del modulo lo sa SOLO chi avvia la galleria: il bundle resta senza marcatore
    scriptAvvio: [`window.__galleriaUrl = 'homun://app/${MODULO}'`],
    log
  })
  await s.avvia()
  if (cssModulo) {
    await s.eval(`(() => { if (document.getElementById('galleria-modulo-css')) return true; const st = document.createElement('style'); st.id = 'galleria-modulo-css'; st.textContent = ${JSON.stringify('CSS_PLACEHOLDER')}; document.head.appendChild(st); return true })()`)
  }
  log('pagina su; orologio fermo, animazioni spente')

  // la GUIDA prima del setup (poi non si vede più)
  await s.viewport(1280, 800)
  const guida = PAGES.find((p) => p.id === 'guida')
  await s.attendi(`!!document.querySelector('[data-testid="guide-view"]')`, { entro: 25_000, motivo: 'la guida iniziale compaia' })
  // la STEPPER della guida: il passo «Computer» compare solo quando la sonda
  // del motore Apple del daemon risponde (asincrona: una corsa catturava tre
  // etichette, l'altra quattro). Si aspetta che la fila sia FERMA su due
  // letture distanti — una CONDIZIONE, non un tempo fisso.
  {
    const railTesto = `(() => { const r = document.querySelector('[data-testid="guide-rail"]'); return r ? (r.textContent ?? '').trim() : null })()`
    let prima = await s.eval(`return ${railTesto}`).catch(() => null)
    for (let i = 0; i < 20; i++) {
      await s.attendi(`(() => { return true })()`, { entro: 700, passo: 700 }).catch(() => undefined)
      const seconda = await s.eval(`return ${railTesto}`).catch(() => null)
      if (prima !== null && seconda === prima) break
      prima = seconda
    }
  }
  for (const tema of ['chiaro', 'scuro']) {
    await s.tema(tema)
    await s.attendiRete({ quieta: 300, entro: 8_000 }).catch(() => undefined)
    // fase linguaggio-ritocchi: i tre controlli valgono per la guida pure
    const erroriGuida = []
    await controlliScena(s, erroriGuida)
    if (erroriGuida.length) esiti.push({ nome: nomeCattura(guida, tema, 1280), scena: guida.id, esito: 'rossa', dettaglio: erroriGuida.join(' · ') })
    for (const m of MASCHERE.guida ?? []) await s.mascheraEspr(m.espr)
    const percorso = join(CATTURE, nomeCattura(guida, tema, 1280))
    await s.cattura(percorso)
    spawnSync(MAGICK, [percorso, '-strip', percorso])
    log('cattura', nomeCattura(guida, tema, 1280), erroriGuida.length ? `ROSSA (${erroriGuida.join(' · ')})` : '')
  }

  const { ctx } = await preparaDeterministica(s, { providerPort: porta })
  log('setup deterministico fatto (timeline e Libreria seminati all\'istante fermo)')
  // R1: si svuota il raccoglitore DOPO il setup — un id mancante reso prima
  // delle scene (la chat nuda) non deve tingere la prima scena
  await s.eval('return window.__sandbotTraduzioniMancanti ? window.__sandbotTraduzioniMancanti.drain().length : 0').then((n) => { if (n) log('svuotati', n, 'id mancanti resi prima delle scene') }).catch(() => undefined)

  // le sezioni della pagina dei componenti le dichiara la PAGINA (componenti.tsx):
  // la galleria non tiene una lista sua da far driftare
  const sezioni = await s.attendi(`(() => { const a = window.__galleriaComponenti?.sezioni?.(); return Array.isArray(a) && a.length > 0 ? a : null })()`, { entro: 15_000, motivo: 'la pagina dei componenti dia le sue sezioni' })
  log('le sezioni dei componenti:', sezioni.join(', '))
  const pages = [...PAGES.filter((p) => p.when !== 'prima-del-setup'), ...sceneComponenti(sezioni)]
  const vuole = (p) => !SOLO || SOLO.includes(p.id)
  for (const page of pages.filter(vuole)) {
    for (const [w, tema] of combinazioni(page)) {
      const errori = []
      await cattura(s, page, ctx, w, tema, errori)
      if (errori.length) {
        // la scena è ROSSA col motivo: i controlli delle maschere non sono
        // un test a parte, valgono a OGNI cattura
        esiti.push({ nome: nomeCattura(page, tema, w), scena: page.id, esito: 'rossa', dettaglio: errori.join(' · ') })
        continue
      }
      // la passata a 900 di SOLO CONTROLLO non entra negli esiti (niente
      // cattura, niente confronto): i suoi errori, semmai, sono già sopra
      if (tema !== 'solo-controllo') esiti.push(confronta(page, tema, w))
    }
    log(page.id, '→', esiti.filter((e) => e.scena === page.id).map((e) => `${e.esito}${e.ae ? ` (${e.ae} px)` : ''}`).join(', '))
  }

  // index.html delle differenze (da aprire nel browser)
  const diverse = esiti.filter((e) => e.esito === 'diversa')
  const rosse = esiti.filter((e) => e.esito === 'rossa')
  // G0: NESSUN TURNO DAL VIVO. Il modello finto registra ogni chiamata a
  // /chat/completions: il setup deterministico non ne fa nessuna e nessuna
  // scena deve farne partire uno. Se il registro non è vuoto la corsa è
  // ROSSA col testo del turno (niente soglie, niente maschere: la causa si
  // corregge — erano le presentazioni dei bot alla creazione).
  const turniDalVivo = modello.requests.length
  if (turniDalVivo) for (const r of modello.requests) log('  ✗ TURNO DAL VIVO: +' + ((r.at - T0) / 1000).toFixed(1) + 's', String(r.lastUser).replace(/\s+/g, ' ').slice(0, 100))
  writeFileSync(join(DIFF, 'index.html'), [
    '<!doctype html><meta charset="utf-8"><title>galleria — le scene diverse</title>',
    '<style>body{background:#141419;color:#eee;font:14px -apple-system,Helvetica,sans-serif;margin:24px}img{display:block;max-width:100%;margin:8px 0 32px;border:1px solid #444}h2{margin:32px 0 8px}</style>',
    '<h1>Le scene diverse (' + diverse.length + ')</h1>',
    ...(diverse.length === 0 ? ['<p>Nessuna differenza: le catture sono identiche alle approvate.</p>'] : diverse.map((e) => `<h2>${e.nome} — ${e.ae} px</h2><img src="./${e.nome}">`)),
    ''
  ].join('\n'))

  // --approva: copia le catture in approvate/, SOPRASCRIVENDO quelle vecchie
  // (G3: «rigenera tutte» deve poterle rifare) e togliendo le ORFANE — le
  // approvate di scene che non esistono più. MAI in automatico: l'elenco va
  // nel commit col motivo.
  if (approvaSet) {
    const copiate = []
    const valide = new Set()
    for (const page of pages.filter(vuole).concat([guida])) {
      // le passate di solo controllo non hanno cattura: niente da approvare
      for (const [w, tema] of combinazioni(page).concat([[1280, 'chiaro'], [1280, 'scuro']]).filter(([_, tema]) => tema !== 'solo-controllo')) {
        const nome = nomeCattura(page, tema, w)
        valide.add(nome)
        const da = join(CATTURE, nome)
        const a = join(APPROVATE, nome)
        if (existsSync(da) && (approvaSet === 'tutte' || approvaSet.includes(page.id))) {
          copyFileSync(da, a)
          copiate.push(nome)
        }
      }
    }
    const rimosse = readdirSync(APPROVATE).filter((f) => f.endsWith('.png') && !valide.has(f))
    for (const f of rimosse) rmSync(join(APPROVATE, f))
    if (copiate.length) log('APPROVATE (da committare con elenco e motivo):', [...new Set(copiate)].join(', '))
    else log('--approva: nessuna cattura da copiare per le scene richieste')
    if (rimosse.length) log('APPROVATE ORFANE RIMOSSE (scene che non esistono più):', rimosse.join(', '))
  }

  const nuove = esiti.filter((e) => e.esito === 'nuova')
  const errs = esiti.filter((e) => e.esito === 'errore')
  const peso = readdirSync(APPROVATE).reduce((a, f) => a + statSync(join(APPROVATE, f)).size, 0)
  log(`scene: ${esiti.length} · uguali ${esiti.length - diverse.length - nuove.length - errs.length - rosse.length} · diverse ${diverse.length} · ROSSE ${rosse.length} · nuove senza approvata ${nuove.length} · errori ${errs.length}${turniDalVivo ? ` · TURNI DAL VIVO ${turniDalVivo}` : ''}`)
  log(`peso di galleria/approvate/: ${(peso / 1024 / 1024).toFixed(1)} MB (limite 15 MB)`)
  if (rosse.length) for (const e of rosse) log('  ✗', e.nome, 'ROSSA —', e.dettaglio ?? '')
  if (diverse.length || nuove.length || errs.length) {
    for (const e of [...errs, ...nuove, ...diverse]) log('  ✗', e.nome, e.esito, e.ae ? `${e.ae} px` : e.dettaglio ?? '')
    log('le differenze sono in', DIFF, '(apri index.html)')
  }
  modello.chiudi()
  const fine = await s.fine()
  if (fine.cartelleRimaste.length) log('ERRORE DI PULIZIA:', fine.cartelleRimaste.join(', '))
  // il modulo della pagina componenti si TIRA GIÙ da out/: il build deve restare
  // senza il marcatore (la guardia componenti.test.ts lo verifica a ogni corsa)
  try {
    rmSync(join(ROOT, 'out', 'renderer', 'galleria-componenti.js'))
    rmSync(join(ROOT, 'out', 'renderer', 'galleria-componenti.mjs')) // il nome della prima era: nessuna copia vecchia resta in out/
  } catch { /* già via */ }
  process.exit(diverse.length || rosse.length || nuove.length || errs.length || turniDalVivo || fine.cartelleRimaste.length ? 1 : 0)
} catch (e) {
  log('FATAL:', e?.stack ?? e)
  try { rmSync(join(ROOT, 'out', 'renderer', 'galleria-componenti.js')) } catch { /* già via */ }
  process.exit(1)
}
