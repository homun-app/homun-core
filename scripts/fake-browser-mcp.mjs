#!/usr/bin/env node
// Server MCP stdio FINTO del browser, FEDELE al Playwright MCP 0.0.83 (fase
// 11b, I3 — e, da Q2 della fase 14 correzioni 2, anche al prefisso f<n> che
// dal VERO server i ref del documento principale prendono dalla seconda
// navigazione nella scheda): le AZIONI restituiscono `### Ran Playwright
// code`, le righe di pagina (`- Page URL` / `- Page Title`) e il LINK allo
// snapshot scritto in un file (`.browser/output/…yml`), MAI lo snapshot
// inline; SOLO browser_snapshot lo restituisce inline. Gli elementi si
// indicano col parametro `target` (come nel server vero). Si attiva col flag
// di test SANDBOT_TEST_FAKE_BROWSER_MCP che sostituisce `docker exec …` con
// `node <questo file>`: quel flag NON esiste in produzione. Nessuna rete,
// nessun browser vero.
// Flag del finto per la SESSIONE MORTA (I4): SANDBOT_TEST_FAKE_BROWSER_MCP_
// DIE_ON_CALL=N fa morire il processo ALLA N-esima chiamata, senza rispondere
// (il client vede chiudersi il trasporto); il daemon lo consuma al primo
// avvio, le sessioni dopo restano vive.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync } from 'node:fs'
import * as http from 'node:http'

// P3/P4 (fase uso-permessi): il SITO FINTO SERVITO su 127.0.0.1 — la sonda
// alza un server HTTP locale e il finto MCP legge DAVVERO le sue pagine
// (navigazione vera su loopback, mai rete fuori da 127.0.0.1). Il corpo di
// ogni pagina: la PRIMA riga è il titolo, le altre sono le righe dello
// snapshot; un link con destinazione si scrive `- link "Nome" [ref=e2] -> /percorso`
// (il click sul ref naviga a quell'indirizzo del sito).
const dynFetch = (url) => new Promise((resolve) => {
  try {
    const u = new URL(url)
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return resolve(null)
    const req = http.request({ host: u.hostname, port: Number(u.port) || 80, method: 'GET', path: u.pathname + u.search }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => resolve(res.statusCode === 200 ? b : null))
    })
    req.on('error', () => resolve(null))
    req.end()
  } catch {
    resolve(null)
  }
})
const dynPageOf = async (url) => {
  const body = await dynFetch(url)
  if (body === null) return null
  const lines = body.split('\n').map((l) => l.trimEnd()).filter((l, i) => i > 0 || l !== '')
  const title = (lines.shift() ?? 'Pagina').replace(/^#\s*/, '')
  return {
    title,
    file: 'page-dinamica',
    lines: [`- Page URL: ${url}`, `- Page Title: ${title}`, ...lines]
  }
}
/** la destinazione `/percorso` di un ref della pagina corrente (i link del sito finto). */
const dynRefTarget = (ref) => {
  if (!state.page) return null
  for (const l of state.page.lines) {
    const m = new RegExp(`\\[ref=${ref}\\]\\s*->\\s*(\\S+)`).exec(l)
    if (m) return m[1]
  }
  return null
}

// SV6 (fase schermo-vivo): SANDBOT_TEST_FAKE_BROWSER_MCP_EXIT_FILE=<path> fa
// USCIRE questo processo quando il file compare — la sonda chiude così il
// browser del bot in modo deterministico (il transport chiuso spegne la
// sessione). Solo-test, come gli altri flag del finto.
const EXIT_FILE = process.env.SANDBOT_TEST_FAKE_BROWSER_MCP_EXIT_FILE
if (EXIT_FILE) {
  setInterval(() => { if (existsSync(EXIT_FILE)) process.exit(0) }, 300)
  setInterval(() => undefined, 1 << 30) // tiene il loop vivo finché non esce
}

// lo snapshot inline di browser_snapshot inizia con le righe di pagina (- Page URL/
// - Page Title), come il server VERO: fase 12 (0b) le righe del result composto
// vengono da qui (le più recenti), non dal result dell'azione.
// le pagine del sito finto: offerte (la pagina "JS-only" suggerita da web_fetch),
// menu (link libero), prenotazione (campo carta e pulsante di conferma) e
// login (fase 12, 0a: un campo type=password SENZA nome accessibile, come
// quello visto dal revisore su quotes.toscrape.com/login)
const PAGES = {
  'https://spa.example/offerte': {
    title: 'Offerte del weekend',
    file: 'page-offerte',
    lines: [
      '- Page URL: https://spa.example/offerte',
      '- Page Title: Offerte del weekend',
      '- heading "Offerte del weekend" [ref=e1]',
      '- text "Sconto 20% sul secondo pasto con il coupon WEEKEND20."',
      '- link "Vedi il menu" [ref=e2]'
    ]
  },
  'https://spa.example/menu': {
    title: 'Menu del weekend',
    file: 'page-menu',
    lines: [
      '- Page URL: https://spa.example/menu',
      '- Page Title: Menu del weekend',
      '- heading "Menu del weekend" [ref=e1]',
      '- text "Antipasto, due primi, dolce. 28 euro a persona."',
      '- link "Torna alle offerte" [ref=e2]'
    ]
  },
  // T4 (fase web-strategia): la pagina con la COMBOBOX di ricerca (come il
  // campo «From» di Trainline): le opzioni della listbox compaiono solo dal
  // SECONDO snapshot dopo la scrittura (il daemon le ASPETTA, ≤ 3 s)
  'https://spa.example/treni': {
    title: 'Cerca treni',
    file: 'page-treni',
    lines: [
      '- Page URL: https://spa.example/treni',
      '- Page Title: Cerca treni',
      '- heading "Cerca treni" [ref=e1]',
      '- combobox "From" [ref=e4]',
      '- button "Cerca treni" [ref=e8]'
    ]
  },
  'https://spa.example/treni?inviato': {
    title: 'Ricerca inviata',
    file: 'page-treni-inviato',
    lines: [
      '- Page URL: https://spa.example/treni?inviato',
      '- Page Title: Ricerca inviata',
      '- heading "Ricerca inviata" [ref=e1]',
      '- text "La ricerca è partita."'
    ]
  },
  'https://spa.example/prenota': {
    title: 'Prenotazione cena',
    file: 'page-prenota',
    lines: [
      '- Page URL: https://spa.example/prenota',
      '- Page Title: Prenotazione cena',
      '- heading "Prenotazione cena" [ref=e1]',
      '- textbox "Nome" [ref=e4]',
      '- textbox "Numero carta" [ref=e6]',
      // giro K1: il campo dell'esempio aria-labelledby — <span id="l">Numero
      // carta</span><input aria-labelledby="l" name="f1"> — SENZA nome nello
      // snapshot: il deny arriva dal CAMPO VERO del probe (aria)
      '- textbox [ref=e7]',
      '- button "Conferma prenotazione" [ref=e8]'
    ]
  },
  'https://spa.example/login': {
    title: 'Accedi',
    file: 'page-login',
    lines: [
      '- Page URL: https://spa.example/login',
      '- Page Title: Accedi',
      '- heading "Accedi" [ref=e1]',
      // correzione J3, giro K1: come quotes.toscrape.com/login visto dal
      // revisore — il campo username ha DUE label nel DOM ("Username" e
      // "Password"): il nome accessibile "Username Password" è CORRETTO e il
      // campo è deny, dal nome E dal campo vero del probe
      '- textbox "Username Password" [ref=e8]',
      '- textbox [ref=e9]',
      '- button "Accedi" [ref=e10]'
    ]
  },
  // fase 14 (punto 7d): il login del sito di prova della verifica — username
  // (text), password (password) e campo codice (text), ognino col suo tipo
  'https://app.example.test/login': {
    title: 'Accedi al portale',
    file: 'page-appexample-login',
    lines: [
      '- Page URL: https://app.example.test/login',
      '- Page Title: Accedi al portale',
      '- heading "Accedi al portale" [ref=e1]',
      '- textbox "Email" [ref=e2]',
      '- textbox "Password" [ref=e3]',
      '- textbox "Codice di verifica" [ref=e4]',
      '- button "Accedi" [ref=e5]'
    ]
  },
  // P3 (fase 14 correzioni): pagina col campo di login DENTRO un iframe di
  // un'ALTRA origine — il prefisso del ref NON è un segnale di iframe (Q2:
  // dalla seconda navigazione lo hanno anche i campi della pagina principale);
  // il probe riporta top:false e l'origine DEL FRAME: fill_credential rifiuta
  // dal confronto origine/top del campo
  'https://app.example.test/embedded': {
    title: 'Accesso incorporato',
    file: 'page-appexample-embedded',
    lines: [
      '- Page URL: https://app.example.test/embedded',
      '- Page Title: Accesso incorporato',
      '- heading "Accesso incorporato" [ref=e1]',
      '- textbox "Utente" [ref=e2]',
      '- button "Accedi" [ref=e3]'
    ]
  },
  // fase 19a (correzioni 3, M5): pagina di login con CAMPO PASSWORD ma sonda
  // del form CHE FALLISCE — il result della evaluate non ha la sezione
  // ### Result, come una valutazione non riuscita del server vero: il daemon
  // riceve null e non aggiunge NESSUNA nota (né errore)
  'https://sonda.example/login-fallita': {
    title: 'Accedi (sonda guasta)',
    file: 'page-sonda-login',
    lines: [
      '- Page URL: https://sonda.example/login-fallita',
      '- Page Title: Accedi (sonda guasta)',
      '- heading "Accedi" [ref=e1]',
      '- textbox "Email" [ref=e2]',
      '- textbox "Password" [ref=e3]',
      '- button "Accedi" [ref=e4]'
    ]
  },
  // fase 19a (correzioni 3, M5): pagina di login CON la sfida anti-bot — c'è
  // il campo password (la sonda direbbe true) ma lo snapshot contiene la
  // firma della sfida: vince SNAPSHOT_BLOCKED_NOTE, la nota del login non si
  // aggiunge (M5.3)
  'https://protetto.example/login': {
    title: 'Verifica',
    file: 'page-protetto-login',
    lines: [
      '- Page URL: https://protetto.example/login',
      '- Page Title: Verifica',
      '- heading "Verify you are human" [ref=e1]',
      '- text "Complete the verification to continue."',
      '- textbox "Email" [ref=e2]',
      '- textbox "Password" [ref=e3]',
      '- button "Accedi" [ref=e4]'
    ]
  }
}

// fase 12 (0a): il tipo di ogni campo della pagina corrente, come lo restituisce
// browser_evaluate — il campo e9 del login è type=password SENZA nome (nome,
// id, placeholder e aria vuoti: il deny può scattare SOLO dal tipo); l'e8 è
// lo username della pagina vera di quotes.toscrape.com/login: nome
// accessibile "Username Password" e, col probe del giro K1, DUE label ("Username"
// e "Password") — il campo è credential anche dal nome vero, esito atteso deny;
// l'e7 della prenota è l'esempio aria-labelledby (nome assente nello snapshot,
// aria "Numero carta" dallo span): deny dal probe
const FIELD_TYPES = {
  'https://spa.example/offerte': {},
  'https://spa.example/menu': {},
  'https://app.example.test/login': {
    e2: { type: 'text', autocomplete: 'username', name: 'email', id: 'email', placeholder: '', label: 'Email', aria: '', title: '' },
    e3: { type: 'password', autocomplete: 'current-password', name: 'password', id: '', placeholder: '', label: 'Password', aria: '', title: '' },
    e4: { type: 'text', autocomplete: 'one-time-code', name: 'otp', id: '', placeholder: '', label: 'Codice di verifica', aria: '', title: '' },
    e5: { type: 'submit', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '' }
  },
  'https://spa.example/prenota': {
    e4: { type: 'text', autocomplete: 'name', name: 'nome', id: '', placeholder: '', label: 'Nome', aria: '', title: '' },
    e6: { type: 'text', autocomplete: 'cc-number', name: 'card', id: 'card-number', placeholder: 'Numero carta', label: 'Numero carta', aria: '', title: '' },
    e7: { type: 'text', autocomplete: '', name: 'f1', id: '', placeholder: '', label: '', aria: 'Numero carta', title: '' }
  },
  'https://spa.example/login': {
    e8: { type: 'text', autocomplete: '', name: 'username', id: 'username', placeholder: '', label: 'Username Password', aria: '', title: '' },
    e9: { type: 'password', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '' },
    e10: { type: 'submit', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '' }
  },
  // P3: il campo e2 della pagina embedded è DENTRO un iframe di widget.example.net
  'https://app.example.test/embedded': {
    e2: { type: 'text', autocomplete: 'username', name: 'user', id: '', placeholder: '', label: 'Utente', aria: '', title: '', origin: 'https://widget.example.net', top: false },
    e3: { type: 'submit', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '' }
  },
  // fase 19a (correzioni 3, M5): le pagine nuove — la login-fallita ha il
  // campo password (è una pagina di login), la protetto/login pure
  'https://sonda.example/login-fallita': {
    e2: { type: 'text', autocomplete: 'username', name: 'email', id: '', placeholder: '', label: 'Email', aria: '', title: '' },
    e3: { type: 'password', autocomplete: 'current-password', name: 'password', id: '', placeholder: '', label: 'Password', aria: '', title: '' },
    e4: { type: 'submit', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '' }
  },
  'https://protetto.example/login': {
    e2: { type: 'text', autocomplete: 'username', name: 'email', id: '', placeholder: '', label: 'Email', aria: '', title: '' },
    e3: { type: 'password', autocomplete: 'current-password', name: 'password', id: '', placeholder: '', label: 'Password', aria: '', title: '' },
    e4: { type: 'submit', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '' }
  }
}

// fase 19a (correzioni 3, M5.2): la sonda del FORM DI LOGIN del daemon — la
// STESSA stringa COSTANTE di LOGIN_FORM_FN (src/main/agent/browser.ts): true
// se nella pagina c'è almeno un input[type=password] visibile. Il finto la
// riconosce dalla stringa e risponde dal tipo dei campi della pagina corrente
// (le pagine del finto non hanno DOM: i campi SONO FIELD_TYPES). La pagina
// login-fallita simula la valutazione NON RIUSCITA: testo senza ### Result.
const LOGIN_FORM_FN =
  "() => Array.from(document.querySelectorAll('input[type=password]')).some((el) => !el.disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')"

// lo stato della sessione: la pagina corrente (una connessione per bot) e i
// testi digitati per ref (il vero snapshot di Playwright mostra il testo dei
// campi compilati: è così che la REDAZIONE di fase 14 si vede davvero)
const state = { url: '', page: null }
const typed = {}
// T4: gli snapshot letti DA QUANDO la combobox e4 è scritta (le opzioni compaiono dal secondo)
let comboSnaps = 0

// Q2 (fase 14 correzioni 2): come il Playwright MCP 0.0.83 VERO, dalla
// SECONDA navigazione nella stessa sessione i ref del documento PRINCIPALE
// escono col prefisso f<n> (n cresce di 1 a ogni navigazione: 1ª senza,
// 2ª f1…, 3ª f2…): il prefisso NON dice "iframe", dice solo "documento
// diverso dal primo della scheda". Lo conta browser_navigate (il driver
// delle navigazioni qui; il click→menu di offerte è una scorciatoia e non
// fa crescere l'albero). Il campo in iframe della pagina embedded resta
// riconosciuto SOLO dal probe (top:false), che riceve il ref come arriva
// (f<n>e<n> o e<n>) e cerca il campo di partenza.
let navigations = 0
const refPrefix = () => (navigations >= 2 ? `f${navigations - 1}` : '')
const withPrefix = (lines) => lines.map((l) => l.replace(/\[ref=(\w+)\]/g, (_, r) => `[ref=${refPrefix()}${r}]`))
const baseRef = (ref) => ref.replace(/^f\d+e/, 'e')

const TOOLS = [
  { name: 'browser_navigate', description: 'apre un URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'snapshot della pagina (INLINE)', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } },
  { name: 'browser_click', description: 'clicca un ref', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'browser_type', description: 'scrive in un ref', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] } },
  { name: 'browser_press_key', description: 'preme un tasto', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_take_screenshot', description: 'screenshot', inputSchema: { type: 'object', properties: { filename: { type: 'string' }, element: { type: 'string' }, target: { type: 'string' } } } },
  { name: 'browser_wait_for', description: 'attende', inputSchema: { type: 'object', properties: {} } },
  // fase 12 (0a): lo schema della 0.0.83 — obbligatorio solo `function`; il
  // daemon lo chiama internamente col target = ref per leggere il tipo del
  // campo. Un ref SENZA campo restituisce testo NON JSON (valutazione fallita
  // per il chiamante → ask)
  {
    name: 'browser_evaluate',
    description: 'valuta una funzione sulla pagina',
    inputSchema: {
      type: 'object',
      properties: { function: { type: 'string' }, target: { type: 'string' }, element: { type: 'string' } },
      required: ['function']
    }
  }
]

const text = (t) => ({ content: [{ type: 'text', text: t }] })

// il result di un'AZIONE, come il server vero: codice eseguito, righe di
// pagina e LINK al file dello snapshot (che qui non esiste davvero)
const actionResult = (code) => [
  '### Ran Playwright code',
  code,
  '### Page',
  `- Page URL: ${state.url}`,
  `- Page Title: ${state.page?.title ?? ''}`,
  '### Snapshot',
  `- [Snapshot](.browser/output/${state.page?.file ?? 'page'}.yml)`
].join('\n')

// fase 19a (correzioni 3): l'hash non cambia la pagina (come nel browser
// vero): la pagina si cerca anche SENZA hash, l'URL resta quella richiesta
const pageAt = (url) => PAGES[url] ?? PAGES[url.split('#')[0]] ?? {
  title: 'Pagina generica',
  file: 'page-generica',
  lines: ['- Page URL: ' + url, '- Page Title: Pagina generica', '- heading "Pagina generica" [ref=e1]', `- text "Contenuto di ${url}."`]
}
// i CAMPI della pagina corrente (anche qui l'hash non cambia la pagina)
const fieldsAt = (url) => FIELD_TYPES[url] ?? FIELD_TYPES[url.split('#')[0]] ?? {}

const server = new Server({ name: 'fake-browser-mcp', version: '0.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

const DIE_ON_CALL = Number(process.env.SANDBOT_TEST_FAKE_BROWSER_MCP_DIE_ON_CALL ?? '0')
// CCK2 (fase computer-card-correzioni): la risposta di OGNI chiamata può
// RITARDARE di un tempo pilotato — la sonda della card «Computer» legge lo
// stato «Acceso» DURANTE l'apertura del browser, e quella finestra deve
// durare più dei poll della card (300 ms): MAI affidarsi alla velocità di uno
// spawn caldo. Flag solo-test, come DIE_ON_CALL: senza env, nessun ritardo.
const CALL_DELAY_MS = Number(process.env.SANDBOT_TEST_FAKE_BROWSER_MCP_DELAY_MS ?? '0')
let calls = 0

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  calls++
  if (DIE_ON_CALL > 0 && calls >= DIE_ON_CALL) process.exit(0) // muore SENZA rispondere (I4)
  if (CALL_DELAY_MS > 0) await new Promise((r) => setTimeout(r, CALL_DELAY_MS))
  if (name === 'browser_navigate') {
    const url = String(args.url ?? '')
    navigations++ // dalla seconda navigazione i ref prendono il prefisso f<n>
    state.url = url
    // P3/P4: il sito finto su 127.0.0.1 si legge DAVVERO dal suo server
    state.page = (await dynPageOf(url)) ?? pageAt(url)
    return text(actionResult(`await page.goto('${url}')`))
  }
  if (name === 'browser_snapshot') {
    // l'UNICO result con lo snapshot inline (comprese le righe di pagina); i
    // campi compilati mostrano il loro testo, come nello snapshot VERO
    if (!state.page) return text('(nessuna pagina aperta)')
    let lines = state.page.lines
    // T4: la combobox scritta mostra il testo E, dal secondo snapshot, la
    // listbox con le opzioni (come una pagina vera che le carica in ritardo)
    if (state.url === 'https://spa.example/treni') {
      comboSnaps++
      lines = state.page.lines.flatMap((l) => {
        if (/combobox "From" \[ref=e4\]/.test(l) && typed.e4 !== undefined) {
          const base = [l.replace(/\[ref=e4\]/, `[ref=e4]: ${typed.e4}`)]
          if (comboSnaps >= 2) {
            base.push('- listbox "Stazioni" [ref=e9]')
            base.push('  - option "Milano Centrale" [ref=e10]')
            base.push('  - option "Milano Porta Garibaldi" [ref=e11]')
            base.push('  - option "Milano Lambrate" [ref=e12]')
          }
          return base
        }
        return [l]
      })
    }
    const withTyped = withPrefix(lines).map((l) => {
      const m = /^(\s*-\s+textbox[^\n]*?\[ref=(\w+)\])([^\n]*)$/.exec(l)
      if (m && typed[m[2]] !== undefined) return `${m[1]}: ${typed[m[2]]}`
      return l
    })
    return text(withTyped.join('\n'))
  }
  if (name === 'browser_click') {
    const target = String(args.target ?? '')
    // il link "Vedi il menu" della pagina offerte porta al menu: l'unica
    // navigazione interna del sito finto (il ref può avere il prefisso f<n>)
    if (baseRef(target) === 'e2' && state.url === 'https://spa.example/offerte') {
      state.url = 'https://spa.example/menu'
      state.page = PAGES[state.url]
    }
    // P3/P4: il click su un link del sito finto su 127.0.0.1 naviga DAVVERO
    // alla sua destinazione (e cresce l'albero dei documenti, come nel vero:
    // i ref della pagina nuova prendono il prefisso)
    const dynTarget = dynRefTarget(baseRef(target))
    if (dynTarget !== null && state.url.startsWith('http://127.0.0.1')) {
      const next = new URL(dynTarget, state.url).toString()
      const page = await dynPageOf(next)
      if (page) {
        navigations++
        state.url = next
        state.page = page
      }
    }
    return text(actionResult(`await page.getByTestId('${target}').click()`))
  }
  if (name === 'browser_type') {
    // come il server VERO 0.0.83: il result porta il CODICE Playwright col
    // TESTO digitato (è per questo che fill_credential BUTTA il result e il
    // daemon redige ogni output del bot); il testo resta nel campo e RIAPPARE
    // nello snapshot successivo (come nel browser vero)
    typed[String(args.target ?? '')] = String(args.text ?? '')
    if (baseRef(String(args.target ?? '')) === 'e4') comboSnaps = 0
    // T4: il submit SU UNA COMBOBOX non deve mai arrivare qui; se arriva, la
    // pagina lo dice (il test lo vede dall'URL)
    if (args.submit === true && state.url === 'https://spa.example/treni') {
      state.url = 'https://spa.example/treni?inviato'
      state.page = PAGES[state.url]
    }
    return text(actionResult(`await page.getByTestId('${String(args.target ?? '')}').fill('${String(args.text ?? '')}')`))
  }
  if (name === 'browser_press_key') {
    return text(actionResult(`await page.keyboard.press('${String(args.key ?? '')}')`))
  }
  if (name === 'browser_take_screenshot') {
    // SV8 (fase schermo-vivo): il finto è FEDELE al Playwright MCP 0.0.83,
    // che accotta { element, target } (optionalElementSchema) per catturare
    // SOLO l'elemento — il target ricevuto si ECHOA, così i test PROVANO che
    // il ref del tool arriva davvero allo strumento di cattura
    const el = args.target ? `\n- Element captured: target=${String(args.target)}` : ''
    return text(`Screenshot saved to: ${String(args.filename ?? 'screenshot.png')}${el}`)
  }
  if (name === 'browser_wait_for') {
    return text(actionResult('await page.waitForTimeout(1000)'))
  }
  // fase 12 (0a, correzione J3): la valutazione interna del daemon — il
  // result è quello REALE della 0.0.83, NON JSON nudo: `### Result` col JSON
  // indentato, poi il codice eseguito e la pagina (il parser del daemon legge
  // la sola sezione Result). Un ref SENZA campo restituisce testo non-JSON
  // senza la sezione (valutazione fallita per il chiamante → ask).
  // P3 (fase 14 correzioni): il JSON porta anche origin (del FRAME del campo)
  // e top (documento TOP) — i default vengono dalla pagina corrente e ogni
  // campo può sovrascriverli (il test dell'iframe: top:false, origine diversa)
  if (name === 'browser_evaluate') {
    // fase 19a (correzioni 3, M5.2): la sonda del form di login del daemon —
    // risposta BOOLEANA dal tipo dei campi della pagina corrente (nel formato
    // REALE della 0.0.83: ### Result col JSON). Sulla pagina login-fallita la
    // valutazione NON riesce (nessuna sezione Result → null per il daemon)
    if (String(args.function ?? '') === LOGIN_FORM_FN) {
      if (state.url === 'https://sonda.example/login-fallita') {
        return text('(la valutazione della sonda del login non è riuscita)')
      }
      const hasLoginForm = Object.values(fieldsAt(state.url)).some((f) => f.type === 'password')
      return text([
        '### Result',
        JSON.stringify(hasLoginForm),
        '### Ran Playwright code',
        '```js',
        `await page.evaluate(${String(args.function ?? '')})`,
        '```',
        '### Page',
        `- Page URL: ${state.url}`,
        `- Page Title: ${state.page?.title ?? ''}`
      ].join('\n'))
    }
    const fields = fieldsAt(state.url)
    // il ref arriva come nello snapshot (f<n>e<n> dalla seconda navigazione):
    // il campo di partenza è senza prefisso
    const target = String(args.target ?? '')
    const info = fields[baseRef(target)]
    if (!info) return text(`(nessun campo per il ref ${target} in questa pagina)`)
    const full = { origin: new URL(state.url).origin, top: true, ...info }
    return text([
      '### Result',
      JSON.stringify(full, null, 2),
      '### Ran Playwright code',
      '```js',
      `await page.locator('[ref=${target}]').evaluate(${String(args.function ?? '')})`,
      '```',
      '### Page',
      `- Page URL: ${state.url}`,
      `- Page Title: ${state.page?.title ?? ''}`
    ].join('\n'))
  }
  return text(`Tool sconosciuto: ${name}`)
})

await server.connect(new StdioServerTransport())
