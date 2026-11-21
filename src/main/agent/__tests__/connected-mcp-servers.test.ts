// U5 (fase mcp-ui): il prompt dei connettori porta l'ELENCO BREVE dei server
// MCP collegati e funzionanti per quel bot (nome + una riga), con la regola
// «per un servizio che ha un server collegato, usa i suoi strumenti
// (find_tools) prima di qualunque altra strada; mai curl dal box». PURA e col
// TETTO DEI TOKEN MISURATO (caratteri/4): la misura sta nella costante, il
// test la presidia — MAI alzarla per far passare un test.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectedMcpServersSection, CONNECTED_MCP_SECTION_TOKEN_BUDGET } from '../connected-apps'

const tok = (s: string): number => Math.ceil(s.length / 4)

describe('U5: connectedMcpServersSection — l\'elenco dei server collegati nel prompt', () => {
  it('vuota senza server; una riga per server (nome + strumenti)', () => {
    expect(connectedMcpServersSection([])).toBe('')
    const s = connectedMcpServersSection([
      { name: 'orion-moon', toolCount: 12 },
      { name: 'mattermost', toolCount: 8 }
    ])
    expect(s).toContain('# Connected MCP servers')
    expect(s).toContain('- orion-moon: 12 tools')
    expect(s).toContain('- mattermost: 8 tools')
  })

  it('la REGOLA: gli strumenti del server collegato PRIMA di ogni altra strada, mai curl dal box', () => {
    const s = connectedMcpServersSection([{ name: 'orion-moon', toolCount: 3 }])
    expect(s).toMatch(/BEFORE any other route/)
    expect(s).toContain('find_tools')
    expect(s).toMatch(/never (use )?curl/i)
    expect(s).toMatch(/isolated computer/)
  })

  it(`il tetto: 8 server ≤ ${CONNECTED_MCP_SECTION_TOKEN_BUDGET} token (caratteri/4, misurato)`, () => {
    const otto = Array.from({ length: 8 }, (_, i) => ({ name: `server-con-nome-lungo-${i}`, toolCount: 10 + i }))
    const s = connectedMcpServersSection(otto)
    expect(tok(s)).toBeLessThanOrEqual(CONNECTED_MCP_SECTION_TOKEN_BUDGET)
    // e oltre 8 server l'elenco si taglia (il tetto non si sposta)
    const tanti = Array.from({ length: 30 }, (_, i) => ({ name: `server-${i}`, toolCount: 5 }))
    const sTanti = connectedMcpServersSection(tanti)
    expect(tok(sTanti)).toBeLessThanOrEqual(CONNECTED_MCP_SECTION_TOKEN_BUDGET)
    expect(sTanti).toMatch(/and \d+ more/)
  })

  it('il loop la usa (sezione VARIABILE del system prompt, mai nel prefisso in cache)', () => {
    const LOOP = readFileSync(fileURLToPath(new URL('../loop.ts', import.meta.url)), 'utf8')
    expect(LOOP).toMatch(/connectedMcpServersSection\(/)
  })
})
