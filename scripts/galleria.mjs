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
const combinazioni = (page) => [
  [1280, 'chiaro'], [1280, 'scuro'],
  ...(LARGHEZZE_EXTRA.includes(page.id) ? [[900, 'chiaro'], [900, 'scuro']] : [])
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
 * fase linguaggio-ritocchi (R1): il controllo che la macchina fa a OGNI scena,
 * oltre al confronto coi pixel: le TRADUZIONI MANCANTI raccolte dal vivo: il renderer (con
 * SANDBOT_TEST_*, solo nelle corse di prova) accumula gli id che Lingui
 * dichiara mancanti; la galleria svuota l'elenco a ogni scena. Prende anche
 * un messaggio costruito a runtime, che l'estrazione statica non vede
 * (l'allineamento del catalogo al codice lo copre la guardia della suite,
 * src/__tests__/guardie/lingui-catalogo.test.ts).
 *
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

/**
 * Il controllo R1 di una scena: riempie `errori` — una scena
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

/** La cattura di UNA combinazione: viewport, tema, apertura della scena, preparazione, maschere, screenshot + strip. I controlli delle maschere e i due controlli di fase linguaggio-ritocchi (controlliScena) riempiono `errori`: una scena col vaso rotto è ROSSA, non catturata. */
const cattura = async (s, page, ctx, w, tema, errori = []) => {
  await s.viewport(w, 800 - 800 + (w === 900 ? 640 : 800))
  await s.tema(tema)
  await closeOverlays(s)
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
    const fuori = await s.eval(`return (() => {
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
  const catturaPrima = page.id === 'popover-chiedi'
  if (!catturaPrima) {
    await s.attendiRete({ quieta: 300, entro: 8_000 }).catch(() => undefined)
    await s.attendiStabile('body', { entro: 4_000 }).catch(() => undefined)
  }
  // fase linguaggio-ritocchi (R1): le traduzioni mancanti a OGNI cattura,
  // prima delle maschere di questa scena — a quell'ora i render della scena
  // sono tutti fatti, e il confronto dei pixel non li vede
  await controlliScena(s, errori)
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
    // fase linguaggio-ritocchi (R1): il controllo vale per la guida pure
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
      esiti.push(confronta(page, tema, w))
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
      for (const [w, tema] of combinazioni(page).concat([[1280, 'chiaro'], [1280, 'scuro']])) {
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
