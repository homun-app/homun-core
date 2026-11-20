// M3 (fase beta12-correzioni): quando un connettore NON c'è né nel catalogo
// né in Composio, il bot NON conclude che sia impossibile — dice che si può
// collegare con un server MCP e chiede all'utente se ne ha già uno («lo usi
// in Cursor o Claude? si aggiunge da Server MCP»). Le frasi nuove vivono nel
// prompt (sezione connettori) e nelle descrizioni dei tool; la card con
// «Apri Server MCP» nasce dal tool offer_mcp_window. Qui gli SNAPSHOT delle
// frasi (pure); il loop e il renderer si provano altrove.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectorsSection } from '../prompts'
import { toolDefs } from '../tools'
import { TOOL_GROUPS } from '../core-tools'
import { CONNECTOR_PROPOSAL_TOOLS } from '../connectors-policy'

const TOOLS = fileURLToPath(new URL('../tools.ts', import.meta.url))
const LOOP = fileURLToPath(new URL('../loop.ts', import.meta.url))

const defOf = (name: string) => toolDefs.find((t) => t.name === name)!

describe('M3: il prompt non chiude mai la porta sui server MCP', () => {
  it('la sezione connettori: un servizio mancante NON è impossibile, si collega con un server MCP', () => {
    const s = connectorsSection()
    expect(s).toContain('Not in the catalog nor in Composio')
    expect(s).toContain('≠ impossible')
    expect(s).toContain('MCP server')
    expect(s).toMatch(/offer_mcp_window/)
    expect(s).toMatch(/Cursor, Claude/)
  })

  it('la sezione connettori: chi nomina mcp.json o «server MCP» (utente o skill) va ascoltato, non ignorato', () => {
    const s = connectorsSection()
    expect(s).toContain('mcp.json')
    expect(s).toMatch(/mentions mcp\.json or an "MCP server", acknowledge it/)
  })
})

describe('M3: le descrizioni dei tool', () => {
  it('search_connectors: il vuoto NON è un verdetto di impossibilità', () => {
    expect(defOf('search_connectors').description).toContain('Missing everywhere is not impossible')
    expect(defOf('search_connectors').description).toMatch(/offer_mcp_window/)
  })

  it('offer_connector: per i servizi fuori catalogo/Composio guida a offer_mcp_window', () => {
    expect(defOf('offer_connector').description).toMatch(/offer_mcp_window/)
  })

  it('offer_mcp_window: la card col bottone che apre la finestra, niente connessioni da sola', () => {
    const d = defOf('offer_mcp_window')
    expect(d.description).toMatch(/opens the MCP servers window/)
    expect(d.description).toMatch(/Adds nothing itself/)
    expect(d.description).toMatch(/Cursor, Claude/)
    expect(d.parameters).toMatchObject({ required: ['service'] })
  })
})

describe('M3: offer_mcp_window nel gruppo connettori e nella policy', () => {
  it('sta nel gruppo connectors di TOOL_GROUPS', () => {
    expect(TOOL_GROUPS.find((g) => g.id === 'connectors')!.tools).toContain('offer_mcp_window')
  })

  it('è una proposta come le altre: solo nei turni dell\'utente (CONNECTOR_PROPOSAL_TOOLS)', () => {
    expect(CONNECTOR_PROPOSAL_TOOLS.has('offer_mcp_window')).toBe(true)
  })

  it('nel loop la card nasce dal tool (appendSend type mcp-window) e il permesso è allow come i fratelli', () => {
    const loop = readFileSync(LOOP, 'utf8')
    expect(loop).toMatch(/call\.name === 'offer_mcp_window'/)
    expect(loop).toMatch(/type: 'mcp-window'/)
    const perms = readFileSync(fileURLToPath(new URL('../permissions.ts', import.meta.url)), 'utf8')
    expect(perms).toMatch(/offer_mcp_window/)
  })
})
