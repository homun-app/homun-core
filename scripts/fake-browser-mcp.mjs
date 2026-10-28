#!/usr/bin/env node
// Server MCP stdio FINTO del browser (fase 11b, punto 6 e verifica): implementa
// browser_navigate, browser_snapshot, browser_click e browser_type con snapshot
// FISSI e deterministici nel formato di Playwright MCP (`- ruolo "nome" [ref=…]`,
// riga `Page URL: …`). Si attiva col flag di test SANDBOT_TEST_FAKE_BROWSER_MCP
// che sostituisce `docker exec …` con `node <questo file>`: quel flag NON esiste
// in produzione. Nessuna rete, nessun browser vero.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// le pagine del sito finto: offerte (la pagina "JS-only" suggerita da web_fetch),
// menu (link libero) e prenotazione (campo carta e pulsante di conferma)
const PAGES = {
  'https://spa.example/offerte': [
    'Page URL: https://spa.example/offerte',
    '- heading "Offerte del weekend" [ref=e1]',
    '- text "Sconto 20% sul secondo pasto con il coupon WEEKEND20."',
    '- link "Vedi il menu" [ref=e2]'
  ].join('\n'),
  'https://spa.example/menu': [
    'Page URL: https://spa.example/menu',
    '- heading "Menu del weekend" [ref=e1]',
    '- text "Antipasto, due primi, dolce. 28 euro a persona."',
    '- link "Torna alle offerte" [ref=e2]'
  ].join('\n'),
  'https://spa.example/prenota': [
    'Page URL: https://spa.example/prenota',
    '- heading "Prenotazione cena" [ref=e1]',
    '- textbox "Nome" [ref=e4]',
    '- textbox "Numero carta" [ref=e6]',
    '- button "Conferma prenotazione" [ref=e8]'
  ].join('\n')
}

// lo stato della sessione: la pagina corrente (una connessione per bot)
const state = { url: '', page: '' }

const TOOLS = [
  { name: 'browser_navigate', description: 'apre un URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'snapshot della pagina', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'clicca un ref', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'browser_type', description: 'scrive in un ref', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] } },
  { name: 'browser_take_screenshot', description: 'screenshot', inputSchema: { type: 'object', properties: { filename: { type: 'string' } } } },
  { name: 'browser_wait_for', description: 'attende', inputSchema: { type: 'object', properties: {} } }
]

const text = (t) => ({ content: [{ type: 'text', text: t }] })

const server = new Server({ name: 'fake-browser-mcp', version: '0.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  if (name === 'browser_navigate') {
    const url = String(args.url ?? '')
    state.url = url
    state.page = PAGES[url] ?? [
      `Page URL: ${url}`,
      '- heading "Pagina generica" [ref=e1]',
      `- text "Contenuto di ${url}."`
    ].join('\n')
    return text(`Navigated to ${url}\n${state.page}`)
  }
  if (name === 'browser_snapshot') {
    return text(state.page || '(nessuna pagina aperta)')
  }
  if (name === 'browser_click') {
    const target = String(args.target ?? '')
    // il link "Vedi il menu" della pagina offerte porta al menu: l'unica
    // navigazione interna del sito finto
    if (target === 'e2' && state.url === 'https://spa.example/offerte') {
      state.url = 'https://spa.example/menu'
      state.page = PAGES[state.url]
      return text(`Clicked link "Vedi il menu" [ref=e2]\n${state.page}`)
    }
    return text(`Clicked element [ref=${target}]\n${state.page}`)
  }
  if (name === 'browser_type') {
    return text(`Typed into [ref=${String(args.target ?? '')}] (text omitted)\n${state.page}`)
  }
  if (name === 'browser_take_screenshot') {
    return text(`Screenshot saved to: ${String(args.filename ?? 'screenshot.png')}`)
  }
  if (name === 'browser_wait_for') {
    return text('Waited.')
  }
  return text(`Tool sconosciuto: ${name}`)
})

await server.connect(new StdioServerTransport())
