#!/usr/bin/env node
// Server MCP stdio FINTO del browser, FEDELE al Playwright MCP 0.0.83 (fase
// 11b, I3): le AZIONI restituiscono `### Ran Playwright code`, le righe di
// pagina (`- Page URL` / `- Page Title`) e il LINK allo snapshot scritto in un
// file (`.browser/output/…yml`), MAI lo snapshot inline; SOLO browser_snapshot
// lo restituisce inline. Gli elementi si indicano col parametro `target` (come
// nel server vero). Si attiva col flag di test SANDBOT_TEST_FAKE_BROWSER_MCP
// che sostituisce `docker exec …` con `node <questo file>`: quel flag NON
// esiste in produzione. Nessuna rete, nessun browser vero.
// Flag del finto per la SESSIONE MORTA (I4): SANDBOT_TEST_FAKE_BROWSER_MCP_
// DIE_ON_CALL=N fa morire il processo ALLA N-esima chiamata, senza rispondere
// (il client vede chiudersi il trasporto); il daemon lo consuma al primo
// avvio, le sessioni dopo restano vive.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

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
  'https://spa.example/prenota': {
    title: 'Prenotazione cena',
    file: 'page-prenota',
    lines: [
      '- Page URL: https://spa.example/prenota',
      '- Page Title: Prenotazione cena',
      '- heading "Prenotazione cena" [ref=e1]',
      '- textbox "Nome" [ref=e4]',
      '- textbox "Numero carta" [ref=e6]',
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
      // correzione J3: come quotes.toscrape.com/login visto dal revisore — il
      // campo username ha nome accessibile "Username Password" (stranezza
      // della pagina) ma è un text: decide il campo VERO del probe, non il nome
      '- textbox "Username Password" [ref=e8]',
      '- textbox [ref=e9]',
      '- button "Accedi" [ref=e10]'
    ]
  }
}

// fase 12 (0a): il tipo di ogni campo della pagina corrente, come lo restituisce
// browser_evaluate — il campo e9 del login è type=password SENZA nome (nome,
// id, placeholder e aria vuoti: il deny può scattare SOLO dal tipo); l'e8 è
// lo username della pagina vera di quotes.toscrape.com/login: nome
// accessibile "Username Password" MA text/name username/label Username
const FIELD_TYPES = {
  'https://spa.example/offerte': {},
  'https://spa.example/menu': {},
  'https://spa.example/prenota': {
    e4: { type: 'text', autocomplete: 'name', name: 'nome', id: '', placeholder: '', label: 'Nome', aria: '' },
    e6: { type: 'text', autocomplete: 'cc-number', name: 'card', id: 'card-number', placeholder: 'Numero carta', label: 'Numero carta', aria: '' }
  },
  'https://spa.example/login': {
    e8: { type: 'text', autocomplete: 'username', name: 'username', id: '', placeholder: '', label: 'Username', aria: '' },
    e9: { type: 'password', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '' },
    e10: { type: 'submit', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '' }
  }
}

// lo stato della sessione: la pagina corrente (una connessione per bot)
const state = { url: '', page: null }

const TOOLS = [
  { name: 'browser_navigate', description: 'apre un URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'snapshot della pagina (INLINE)', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } },
  { name: 'browser_click', description: 'clicca un ref', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'browser_type', description: 'scrive in un ref', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] } },
  { name: 'browser_press_key', description: 'preme un tasto', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_take_screenshot', description: 'screenshot', inputSchema: { type: 'object', properties: { filename: { type: 'string' } } } },
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

const pageAt = (url) => PAGES[url] ?? {
  title: 'Pagina generica',
  file: 'page-generica',
  lines: ['- Page URL: ' + url, '- Page Title: Pagina generica', '- heading "Pagina generica" [ref=e1]', `- text "Contenuto di ${url}."`]
}

const server = new Server({ name: 'fake-browser-mcp', version: '0.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

const DIE_ON_CALL = Number(process.env.SANDBOT_TEST_FAKE_BROWSER_MCP_DIE_ON_CALL ?? '0')
let calls = 0

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  calls++
  if (DIE_ON_CALL > 0 && calls >= DIE_ON_CALL) process.exit(0) // muore SENZA rispondere (I4)
  if (name === 'browser_navigate') {
    const url = String(args.url ?? '')
    state.url = url
    state.page = pageAt(url)
    return text(actionResult(`await page.goto('${url}')`))
  }
  if (name === 'browser_snapshot') {
    // l'UNICO result con lo snapshot inline (comprese le righe di pagina)
    return text(state.page ? state.page.lines.join('\n') : '(nessuna pagina aperta)')
  }
  if (name === 'browser_click') {
    const target = String(args.target ?? '')
    // il link "Vedi il menu" della pagina offerte porta al menu: l'unica
    // navigazione interna del sito finto
    if (target === 'e2' && state.url === 'https://spa.example/offerte') {
      state.url = 'https://spa.example/menu'
      state.page = PAGES[state.url]
    }
    return text(actionResult(`await page.getByTestId('${target}').click()`))
  }
  if (name === 'browser_type') {
    return text(actionResult(`await page.getByTestId('${String(args.target ?? '')}').fill('(text omitted)')`))
  }
  if (name === 'browser_press_key') {
    return text(actionResult(`await page.keyboard.press('${String(args.key ?? '')}')`))
  }
  if (name === 'browser_take_screenshot') {
    return text(`Screenshot saved to: ${String(args.filename ?? 'screenshot.png')}`)
  }
  if (name === 'browser_wait_for') {
    return text(actionResult('await page.waitForTimeout(1000)'))
  }
  // fase 12 (0a, correzione J3): la valutazione interna del daemon — il
  // result è quello REALE della 0.0.83, NON JSON nudo: `### Result` col JSON
  // indentato, poi il codice eseguito e la pagina (il parser del daemon legge
  // la sola sezione Result). Un ref SENZA campo restituisce testo non-JSON
  // senza la sezione (valutazione fallita per il chiamante → ask)
  if (name === 'browser_evaluate') {
    const fields = FIELD_TYPES[state.url] ?? {}
    const target = String(args.target ?? '')
    const info = fields[target]
    if (!info) return text(`(nessun campo per il ref ${target} in questa pagina)`)
    return text([
      '### Result',
      JSON.stringify(info, null, 2),
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
