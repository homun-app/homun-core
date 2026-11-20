// E2 (fase mcp-env): il bottone «Importa da Cursor, Claude o ZCode» nella
// finestra «Server MCP» — SOLO al clic dell'utente si leggono i file (il
// main li legge nei suoi due gestori); l'elenco mostra nome e tipo SENZA
// valori segreti, caselle da spuntare (nessuna di default), i doppioni sono
// «già presenti» e non si sovrascrivono. Guardie sul sorgente + preload.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WIN_SRC = readFileSync(fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url)), 'utf8')
const PRELOAD_SRC = readFileSync(fileURLToPath(new URL('../../../preload/index.ts', import.meta.url)), 'utf8')

describe('E2: il bottone Importa e il suo elenco (guardie sul sorgente)', () => {
  it('il bottone si chiama «Importa da Cursor, Claude o ZCode» e apre l\'elenco solo al clic', () => {
    expect(WIN_SRC).toContain('Importa da Cursor, Claude o ZCode')
    expect(WIN_SRC).toMatch(/data-testid="mcp-import-button"/)
    expect(WIN_SRC).toMatch(/data-testid="mcp-import-list"/)
  })

  it('l\'elenco arriva da api.mcpImportScan() (lettura SOLO al clic, nel main)', () => {
    expect(WIN_SRC).toMatch(/api\.mcpImportScan\(\)/)
    expect(PRELOAD_SRC).toMatch(/mcpImportScan/)
    expect(PRELOAD_SRC).toMatch(/mcpImportApply/)
  })

  it('caselle da spuntare, NESSUNA spuntata di default, e l\'importazione passa da api.mcpImportApply', () => {
    expect(WIN_SRC).toMatch(/data-testid="mcp-import-check"/)
    expect(WIN_SRC).toMatch(/checked=\{importPicks\[/)
    expect(WIN_SRC, 'la scansione azzera le spunte: nessuna spuntata di default').toMatch(/setImportPicks\(\{\}\)/)
    expect(WIN_SRC).toMatch(/api\.mcpImportApply\(/)
  })

  it('il nome che esiste già è «già presente» e la sua casella non si può spuntare', () => {
    expect(WIN_SRC).toContain('già presente')
    expect(WIN_SRC).toMatch(/disabled=\{[^}]*existing/)
  })

  it('nessun valore segreto nell\'elenco: il renderer riceve solo nomi (scan row senza valori)', () => {
    expect(WIN_SRC).not.toMatch(/secretValue|tokenValue/)
    expect(WIN_SRC).toMatch(/secretNames/)
  })
})
