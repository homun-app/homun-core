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

// le pagine del sito finto: offerte (la pagina "JS-only" suggerita da web_fetch),
// menu (link libero) e prenotazione (campo carta e pulsante di conferma)
const PAGES = {
  'https://spa.example/offerte': {
    title: 'Offerte del weekend',
    file: 'page-offerte',
    lines: [
      'Page URL: https://spa.example/offerte',
      '- heading "Offerte del weekend" [ref=e1]',
      '- text "Sconto 20% sul secondo pasto con il coupon WEEKEND20."',
      '- link "Vedi il menu" [ref=e2]'
    ]
  },
  'https://spa.example/menu': {
    title: 'Menu del weekend',
    file: 'page-menu',
    lines: [
      'Page URL: https://spa.example/menu',
      '- heading "Menu del weekend" [ref=e1]',
      '- text "Antipasto, due primi, dolce. 28 euro a persona."',
      '- link "Torna alle offerte" [ref=e2]'
    ]
  },
  'https://spa.example/prenota': {
    title: 'Prenotazione cena',
    file: 'page-prenota',
    lines: [
      'Page URL: https://spa.example/prenota',
      '- heading "Prenotazione cena" [ref=e1]',
      '- textbox "Nome" [ref=e4]',
      '- textbox "Numero carta" [ref=e6]',
      '- button "Conferma prenotazione" [ref=e8]'
    ]
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
  { name: 'browser_wait_for', description: 'attende', inputSchema: { type: 'object', properties: {} } }
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
  lines: ['Page URL: ' + url, '- heading "Pagina generica" [ref=e1]', `- text "Contenuto di ${url}."`]
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
  return text(`Tool sconosciuto: ${name}`)
})

await server.connect(new StdioServerTransport())
