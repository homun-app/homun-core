// E2 (fase mcp-env): il bottone «Importa da Cursor, Claude o ZCode» nella
// finestra «Server MCP» — SOLO al clic dell'utente si leggono i file (il
// main li legge nei suoi due gestori); l'elenco mostra nome e tipo SENZA
// valori segreti, caselle da spuntare (nessuna di default), i doppioni sono
// «già presenti» e non si sovrascrivono. Guardie sul sorgente + preload.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// C0 (fase linguaggio): l'elenco di import sta in plugin/import-list.tsx, il
// bottone e la scansione in McpWindow: le guardie li leggono insieme
const WIN_SRC = readFileSync(fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url)), 'utf8')
  + readFileSync(fileURLToPath(new URL('../components/plugin/import-list.tsx', import.meta.url)), 'utf8')
const PRELOAD_SRC = readFileSync(fileURLToPath(new URL('../../../preload/index.ts', import.meta.url)), 'utf8')

describe('E2: il bottone Importa e il suo elenco (guardie sul sorgente)', () => {
  it('il bottone si chiama «Importa da altre app» (U7: otto app) e apre l\'elenco solo al clic', () => {
    expect(WIN_SRC).toContain('Importa da altre app')
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
    // U2: le spunte per chiave di riga (origine primaria : nome)
    expect(WIN_SRC).toMatch(/picks\[importRowKey\(r\)\] === true/)
    expect(WIN_SRC, 'la scansione azzera le spunte: nessuna spuntata di default').toMatch(/setImportPicks\(\{\}\)/)
    expect(WIN_SRC).toMatch(/api\.mcpImportApply\(/)
  })

  it('il nome che esiste già è «già collegato» (U2) e la sua casella non si può spuntare', () => {
    expect(WIN_SRC).toContain('già collegato')
    expect(WIN_SRC).toMatch(/disabled=\{r\.existing\}/)
  })

  it('nessun valore segreto nell\'elenco: il renderer riceve solo nomi (scan row senza valori)', () => {
    expect(WIN_SRC).not.toMatch(/secretValue|tokenValue/)
    // il conteggio dei segreti arriva dalla lib (r.secretCount), mai un valore
    expect(WIN_SRC).toMatch(/secretCount/)
    expect(WIN_SRC).toMatch(/data-testid="mcp-import-secrets"/)
  })
})
