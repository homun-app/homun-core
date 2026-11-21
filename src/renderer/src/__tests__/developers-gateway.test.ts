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

describe('U3 → PL1: il riquadro «Server MCP personalizzato» resta UNA riga piccola in fondo', () => {
  // PL1 (fase plugin): il contenuto sta in DevelopersContent; la riga piccola
  // che riporta alla finestra «Server MCP» è il FOOTER che il foglio passa
  // (la pagina Plugin non lo passa: i server MCP stanno lì, in casa)
  it('DevelopersContent NON contiene la riga (la passa il foglio come footer)', () => {
    const b = developersBlock()
    expect(b).not.toContain('Apri la finestra Server MCP')
    expect(b).not.toContain('I server MCP si gestiscono nella finestra Server MCP')
    expect(b).toMatch(/footer/)
  })

  it('il foglio passa la riga piccola che riporta alla finestra «Server MCP» e chiude (un foglio solo)', () => {
    const start = APPSW.indexOf('function DevelopersSheet(')
    const b = APPSW.slice(start, APPSW.indexOf('\nfunction ', start + 10))
    expect(b).toMatch(/setMcpOpen\(true\)/)
    expect(b).toMatch(/onClose\(\)/)
    expect(b).toContain('data-testid="developers-open-mcp"')
  })
})

describe('U3: il link «Gateway, plugin e registro» porta DIRETTAMENTE alla sezione Gateway', () => {
  it('la finestra «Server MCP» si CHIUDE e «Per sviluppatori» apre con lo scroll al Gateway', () => {
    const at = MCPW.indexOf('data-testid="mcp-window-developers"')
    const block = MCPW.slice(MCPW.lastIndexOf('<button', at), MCPW.indexOf('</button>', at))
    expect(block).toContain('setMcpOpen(false)')
    expect(block).toMatch(/setAppsDevelopersScrollTo\('gateway'\)/)
    expect(block).toContain('setAppsOpen(true)')
    expect(block).toContain('setAppsOpenDevelopers(true)')
  })

  it('lo store ha appsDevelopersScrollTo (consumata all\'apertura, come appsOpenDevelopers)', () => {
    expect(STORE).toMatch(/appsDevelopersScrollTo: 'gateway' \| null/)
    expect(STORE).toMatch(/appsDevelopersScrollTo: null/)
    expect(STORE).toMatch(/setAppsDevelopersScrollTo\(/)
  })

  it('AppsWindow consuma il target e il foglio scorre all\'ancora Gateway', () => {
    const b = developersBlock()
    expect(b).toMatch(/scrollTo/)
    expect(b).toMatch(/scrollIntoView/)
    expect(b).toMatch(/developers-gateway/)
    // AppsWindow passa il target al foglio quando lo apre da «Server MCP»
    const iUse = APPSW.indexOf('appsDevelopersScrollTo')
    expect(iUse).toBeGreaterThan(0)
  })
})
