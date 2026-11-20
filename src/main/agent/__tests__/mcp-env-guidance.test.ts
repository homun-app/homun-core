// E3 (fase mcp-env): il bot propone la strada GIUSTA. Il caso vero: il bot
// propose add_mcp_server url:https://mattermost.competitoor.com/mcp —
// l'indirizzo della WEB APP (l'OAuth metadata risponde 501) — il server non
// si aggiunge e il bot dà la colpa al servizio. Qui gli SNAPSHOT: le regole
// del prompt (un URL di web app NON è un server MCP; l'import da Cursor,
// Claude o ZCode), la frase della card, la guida quando l'aggiunta fallisce
// — e il bot che NON legge ~/.cursor/mcp.json da solo (quello è il clic
// dell'utente, E2).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectorsSection } from '../prompts'
import { MCP_WINDOW_IMPORT_GUIDANCE } from '../connectors-policy'
import { toolDefs } from '../tools'

const toolDefByName = (name: string): string => toolDefs.find((t) => t.name === name)!.description

const LOOP_SRC = readFileSync(fileURLToPath(new URL('../loop.ts', import.meta.url)), 'utf8')
const API_SRC = readFileSync(fileURLToPath(new URL('../../../daemon/api.ts', import.meta.url)), 'utf8')

describe('E3: le regole del prompt dei connettori', () => {
  it('un URL di WEB APP non è un server MCP: mai proporlo con add_mcp_server url:', () => {
    const s = connectorsSection()
    expect(s).toMatch(/web app[\s\S]*?NOT an MCP server/i)
    expect(s).toMatch(/never propose it with add_mcp_server/)
  })

  it('il bot dice l\'import: se l\'utente lo usa già in Cursor, Claude o ZCode, la finestra importa il server', () => {
    const s = connectorsSection()
    expect(s).toMatch(/Cursor, Claude(,| or) ZCode/)
    expect(s).toMatch(/import/i)
  })

  it('il bot NON legge mcp.json o la config di Claude da solo: l\'import è il clic dell\'utente', () => {
    const s = connectorsSection()
    expect(s).toMatch(/never read/i)
    expect(s).toMatch(/mcp\.json/)
  })
})

describe('E3: la frase della card e le descrizioni dei tool', () => {
  it('offer_mcp_window: il result dice Cursor, Claude o ZCode e l\'IMPORT', () => {
    expect(LOOP_SRC).toMatch(/card shown to the user[\s\S]*?Cursor, Claude or ZCode[\s\S]*?import/)
  })

  it('la descrizione di offer_mcp_window cita Cursor, Claude o ZCode (e resta ≤ 200 caratteri)', () => {
    const d = toolDefByName('offer_mcp_window')
    expect(d).toMatch(/Cursor/)
    expect(d).toMatch(/ZCode/)
    expect(d.length).toBeLessThanOrEqual(200)
  })
})

describe('E3: l\'aggiunta fallita guida verso la card e la frase', () => {
  it('la guida esiste e dice: niente colpa al servizio, card offer_mcp_window, import da Cursor/Claude/ZCode', () => {
    expect(MCP_WINDOW_IMPORT_GUIDANCE).toMatch(/do not blame/i)
    expect(MCP_WINDOW_IMPORT_GUIDANCE).toMatch(/offer_mcp_window/)
    expect(MCP_WINDOW_IMPORT_GUIDANCE).toMatch(/Cursor, Claude or ZCode/)
    expect(MCP_WINDOW_IMPORT_GUIDANCE).toMatch(/import the server from that window/)
  })

  it('l\'esito negativo del click sulla card porta la guida (snapshot del sorgente del resolver)', () => {
    // nel testo [sistema] del fallimento, per le card url: (e i not-mcp), la
    // guida dice al bot che proporre
    expect(API_SRC).toMatch(/MCP_WINDOW_IMPORT_GUIDANCE/)
  })
})
