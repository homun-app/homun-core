// U3 (fase mcp-ui): niente giro a vuoto tra «Server MCP» e «Per sviluppatori».
// Il link «Gateway, plugin e registro» apre «Per sviluppatori» SCORRENDO alla
// sezione Gateway, con le sezioni in ordine Gateway → Plugin → Registro; il
// riquadro «Server MCP personalizzato» diventa UNA riga piccola in fondo; i
// due fogli non si impilano MAI (aprire l'uno chiude l'altro).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APPSW = readFileSync(fileURLToPath(new URL('../components/AppsWindow.tsx', import.meta.url)), 'utf8')
const MCPW = readFileSync(fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url)), 'utf8')
const STORE = readFileSync(fileURLToPath(new URL('../store.ts', import.meta.url)), 'utf8')

function developersBlock(): string {
  // PL1 (fase plugin): il contenuto del foglio vive in DevelopersContent
  // (esportata, la pagina Plugin la incorpora in «Avanzate»)
  const start = APPSW.indexOf('function DevelopersContent(')
  if (start < 0) throw new Error('DevelopersContent non trovata')
  return APPSW.slice(start, APPSW.indexOf('\nfunction ', start + 10) > 0 ? APPSW.indexOf('\nfunction ', start + 10) : undefined)
}

describe('U3: «Per sviluppatori» — le sezioni in ordine Gateway, Plugin, Registro', () => {
  it('il GATEWAY è la PRIMA sezione (prima della chiave Composio e del registro)', () => {
    const b = developersBlock()
    const iGateway = b.indexOf('<GatewayTab />')
    const iKey = b.indexOf('<ComposioKeySection />')
    const iRegistry = b.indexOf('Cerca nel registro MCP')
    expect(iGateway).toBeGreaterThanOrEqual(0)
    expect(iKey).toBeGreaterThan(iGateway)
    expect(iRegistry).toBeGreaterThan(iGateway)
  })

  it('la sezione Gateway ha l\'ANCORA per lo scroll (developers-gateway)', () => {
    const b = developersBlock()
    expect(b).toMatch(/id="developers-gateway"|data-testid="developers-gateway"/)
  })
})

describe('U3 → PL7: il foglio non c\'è più — il contenuto sta in «Avanzate» della pagina', () => {
  it('DevelopersContent non ha NESSUN rimando alla finestra «Server MCP» (la casa è la pagina)', () => {
    const b = developersBlock()
    expect(b).not.toContain('Apri la finestra Server MCP')
    expect(b).not.toContain('I server MCP si gestiscono nella finestra Server MCP')
    expect(b).not.toContain('setMcpOpen')
    // il gateway resta la PRIMA sezione, con l'ancora per lo scroll
    expect(b).toMatch(/id="developers-gateway"/)
  })

  it('la pagina Plugin incorpora DevelopersContent in «Avanzate» (id plugin-advanced)', () => {
    const panel = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
    expect(panel).toMatch(/<DevelopersContent scrollTo=\{null\} \/>/)
    expect(panel).toMatch(/id="plugin-advanced"/)
  })
})

describe('U3 → PL7: lo scroll alle sezioni resta (dal menù Aggiungi al marketplace)', () => {
  it('DevelopersContent scorre all\'ancora chiesta (gateway o marketplace)', () => {
    const b = developersBlock()
    expect(b).toMatch(/scrollTo/)
    expect(b).toMatch(/scrollIntoView/)
    expect(b).toMatch(/developers-gateway/)
    expect(b).toMatch(/developers-marketplace/)
  })

  it('il menù «Aggiungi un marketplace» della pagina scorre ad Avanzate', () => {
    const panel = readFileSync(fileURLToPath(new URL('../components/PluginPanel.tsx', import.meta.url)), 'utf8')
    expect(panel).toMatch(/getElementById\('plugin-advanced'\)\?\.scrollIntoView/)
  })
})
