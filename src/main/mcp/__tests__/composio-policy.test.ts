// Test K6 (fase Composio OAuth — ritocchi): la tabella degli strumenti di
// Composio (C3) vale PER NOME su OGNI server MCP, come il gate del blocco.
// Un server AGGIUNTO A MANO verso Composio (catalogId assente) non riporta
// al modello REMOTE_WORKBENCH/REMOTE_BASH_TOOL & co.: offeredMcpTools filtra
// per nome, callTool rifiuta un nascosto chiamato per nome con «not available
// in Homun», e i nomi SENZA prefisso COMPOSIO_ restano come sono. Il test di
// callTool usa un server http verso 127.0.0.1 MAI connesso: il rifiuto avviene
// PRIMA di ogni connessione. Il prefisso del gateway viene dal nome VERO del
// server (composioServerTools), non più scritto a mano.
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'
import fixtureJson from '../../connectors/__tests__/fixtures/composio-for-you-tools.json'

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-composio-policy-'))
const { setDataDir, setSetting } = await import('../../store/db')
setDataDir(TMP)
const mcp = await import('../index')
import type { McpServerConfig } from '../index'

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const fixture = fixtureJson as { tools: Array<{ name: string }> }
const fixtureNames = fixture.tools.map((t) => t.name)

/** Un server MANUALE verso Composio: niente catalogId, nome qualunque. */
const manualComposio = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'manuale-composio-test',
  name: 'il mio Composio',
  transport: 'http',
  url: 'http://127.0.0.1:9/mcp',
  enabled: true,
  ...over
})

describe('K6 — la tabella C3 per NOME, su qualunque server', () => {
  it('i 12 strumenti della fixture su un server SENZA catalogId → offerti SOLO i 6', () => {
    const offered = offeredOf(fixtureNames)
    expect(offered.sort()).toEqual([
      'COMPOSIO_GET_TOOL_SCHEMAS',
      'COMPOSIO_MANAGE_CONNECTIONS',
      'COMPOSIO_MULTI_EXECUTE_TOOL',
      'COMPOSIO_PROXY_EXECUTE',
      'COMPOSIO_SEARCH_TOOLS',
      'COMPOSIO_WAIT_FOR_CONNECTIONS'
    ])
  })

  it('i nomi SENZA prefisso COMPOSIO_ restano come sono (il filtro non li tocca)', () => {
    const mixed = ['WEATHER_GET', ...fixtureNames, 'notes_search']
    expect(offeredOf(mixed).sort()).toEqual([
      'COMPOSIO_GET_TOOL_SCHEMAS',
      'COMPOSIO_MANAGE_CONNECTIONS',
      'COMPOSIO_MULTI_EXECUTE_TOOL',
      'COMPOSIO_PROXY_EXECUTE',
      'COMPOSIO_SEARCH_TOOLS',
      'COMPOSIO_WAIT_FOR_CONNECTIONS',
      'WEATHER_GET',
      'notes_search'
    ].sort())
  })

  it('fail closed: un nome COMPOSIO_* NUOVO (non in tabella) non si offre; i nascosti nemmeno', () => {
    expect(mcp.composioToolOffered('COMPOSIO_REMOTE_BASH_TOOL')).toBe(false)
    expect(mcp.composioToolOffered('COMPOSIO_SUBMIT_FEEDBACK')).toBe(false)
    expect(mcp.composioToolOffered('COMPOSIO_BRAND_NEW_SHINY_TOOL')).toBe(false)
    expect(mcp.composioToolOffered('COMPOSIO_MULTI_EXECUTE_TOOL')).toBe(true)
    expect(mcp.composioToolOffered('SOMETHING_ELSE')).toBe(true)
  })

  it('callTool di COMPOSIO_REMOTE_BASH_TOOL su un server manuale → «not available in Homun» (mai eseguito)', async () => {
    setSetting('mcp.servers', [manualComposio()])
    const out = await mcp.callTool('mcp__il-mio-composio__COMPOSIO_REMOTE_BASH_TOOL', { command: 'id' })
    expect(out).toBe('COMPOSIO_REMOTE_BASH_TOOL is not available in Homun.')
  })
})

describe('K6 — il prefisso degli strumenti dal nome VERO del server', () => {
  it('composioServerTools deriva mcp__<slug>__ dal server con catalogId composio', () => {
    setSetting('mcp.servers', [
      manualComposio({ id: 'composio', catalogId: 'composio', name: 'Composio For You' })
    ])
    expect(mcp.composioServerTools()).toEqual({
      manageConnections: 'mcp__composio-for-you__COMPOSIO_MANAGE_CONNECTIONS',
      waitForConnections: 'mcp__composio-for-you__COMPOSIO_WAIT_FOR_CONNECTIONS'
    })
  })

  it('senza server Composio vale lo slug storico «composio»', () => {
    setSetting('mcp.servers', [manualComposio()])
    expect(mcp.composioServerTools().waitForConnections).toBe('mcp__composio__COMPOSIO_WAIT_FOR_CONNECTIONS')
  })
})

/** I nomi che restano dopo la tabella C3 (offeredMcpTools, PURO). */
function offeredOf(names: string[]): string[] {
  return mcp.offeredMcpTools(names.map((name) => ({ name }))).map((t) => t.name)
}
