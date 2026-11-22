// V1 (fase stato-vivo): il blocco «Collegamenti ora» del prompt di sistema,
// ricalcolato a OGNI turno: i server MCP funzionanti (nome + strumenti), i
// server ACCESI che non partono (categoria X2, frase fissa) e le app Composio
// attive. La REGOLA che mancava nella chat del 21/11: il blocco è la verità
// CORRENTE di tool e collegamenti; se un riassunto o un messaggio precedente
// dice altro, vince il blocco. PURA e col TETTO DEI TOKEN MISURATO
// (caratteri/4): la misura sta nella costante, il test la presidia — MAI
// alzarla per far passare un test.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connectionsNowSection, CONNECTIONS_NOW_TOKEN_BUDGET } from '../connected-apps'

const tok = (s: string): number => Math.ceil(s.length / 4)

describe("V1: connectionsNowSection — il blocco «Collegamenti ora» del prompt", () => {
  it('vuoto senza nulla; con il server X funzionante il blocco c\'è, con la REGOLA che vince sui riassunti', () => {
    expect(connectionsNowSection({ working: [], failing: [], off: [], composioApps: [] })).toBe('')
    // il caso della chat del 21/11: il riassunto dice «non ho accesso a X» ma
    // il server X FUNZIONA — la verifica è sul TESTO del prompt, non sul
    // modello: il blocco contiene X e la regola che vince sul riassunto
    const s = connectionsNowSection({ working: [{ name: 'mattermost', toolCount: 14 }], failing: [], off: [], composioApps: [] })
    expect(s).toContain('# Connections now')
    expect(s).toContain('- mattermost: 14 tools')
    expect(s).toContain('This block is the current truth about your tools and connections. If a summary or an earlier message says otherwise, this block wins.')
  })

  it('i server che NON partono: una riga con la categoria X2 (frase fissa, niente testo libero)', () => {
    const s = connectionsNowSection({
      working: [],
      failing: [{ name: 'studio-mcp', category: 'unreachable' }, { name: 'vecchio-mcp', category: 'command-not-found' }],
      off: [],
      composioApps: []
    })
    expect(s).toContain('- studio-mcp: does not start (unreachable)')
    expect(s).toContain('- vecchio-mcp: does not start (command not found)')
    // solo la frase fissa della categoria: il testo libero dell'errore non entra
    expect(s.match(/does not start/g)?.length).toBe(2)
  })

  it('le app Composio attive sulla loro riga; un server col nome di un\'app non si duplica', () => {
    const s = connectionsNowSection({
      working: [{ name: 'Notion', toolCount: 5 }],
      failing: [],
      off: [],
      composioApps: [{ name: 'Trello', accounts: [] }]
    })
    expect(s).toContain('- Composio: Trello')
    expect(s).toContain('- Notion: 5 tools')
  })

  it('V4: i server SPENTI hanno la loro riga corta — il bot sa che lo strumento ESISTE ma è spento', () => {
    const s = connectionsNowSection({ working: [], failing: [], off: [{ name: 'orion-moon' }], composioApps: [] })
    expect(s).toContain('- orion-moon: switched off — ask the user to turn it on in Plugin')
  })

  it(`il tetto: 8 funzionanti + 4 non parti + 4 spenti + 6 app multi-account ≤ ${CONNECTIONS_NOW_TOKEN_BUDGET} token (caratteri/4, misurato)`, () => {
    const working = Array.from({ length: 8 }, (_, i) => ({ name: `server-con-nome-lungo-${i}`, toolCount: 10 + i }))
    const failing = Array.from({ length: 9 }, (_, i) => ({ name: `rotto-${i}`, category: 'startup-error' as const }))
    const off = Array.from({ length: 9 }, (_, i) => ({ name: `spento-${i}` }))
    const composioApps = Array.from({ length: 6 }, (_, i) => ({
      name: `App${i}`,
      accounts: [
        { alias: `lavoro${i}`, email: `utente${i}@azienda.test` },
        { alias: `personale${i}`, email: `utente${i}@gmail.test` },
        { alias: `altro${i}`, email: `utente${i}@altra.test` }
      ]
    }))
    const s = connectionsNowSection({ working, failing, off, composioApps })
    expect(tok(s)).toBeLessThanOrEqual(CONNECTIONS_NOW_TOKEN_BUDGET)
    // oltre i tetti gli elenchi si tagliano (il tetto non si sposta)
    const tanti = connectionsNowSection({
      working: Array.from({ length: 30 }, (_, i) => ({ name: `s-${i}`, toolCount: 5 })),
      failing: [],
      off: [],
      composioApps: []
    })
    expect(tok(tanti)).toBeLessThanOrEqual(CONNECTIONS_NOW_TOKEN_BUDGET)
    expect(tanti).toMatch(/and \d+ more/)
  })

  it('la regola d\'uso resta: gli strumenti PRIMA di ogni altra strada, mai curl dal computer isolato', () => {
    const s = connectionsNowSection({ working: [{ name: 'orion-moon', toolCount: 3 }], failing: [], off: [], composioApps: [] })
    expect(s).toMatch(/FIRST/)
    expect(s).toContain('find_tools')
    expect(s).toMatch(/never (use )?curl/i)
    expect(s).toMatch(/isolated computer/)
  })

  it('il loop la usa (sezione VARIABILE del system prompt, mai nel prefisso in cache)', () => {
    const LOOP = readFileSync(fileURLToPath(new URL('../loop.ts', import.meta.url)), 'utf8')
    expect(LOOP).toMatch(/connectionsNowSection\(/)
    expect(LOOP).not.toMatch(/connectedAppsLine|connectedMcpServersSection/)
  })
})
