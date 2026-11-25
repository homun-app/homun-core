// X2 (fase sicurezza-beta16): il testo completo dell'errore di un server MCP
// resta SOLO nella UI — la riga rossa della vista «Server MCP» — troncato a
// 300 caratteri e mostrato come TESTO (mai HTML: il corpo di una risposta può
// contenerlo). Guardia sul sorgente; la pura è provata in
// src/main/mcp/__tests__/error-category.test.ts. Il foglio del server che si
// provava qui (il DOM) era morto da PL7: la fase linguaggio (C0) lo ha
// cancellato con i suoi test DOM.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MCPW = readFileSync(fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url)), 'utf8')

describe('X2: la riga della finestra «Server MCP» usa lo stesso taglio (guardia sul sorgente)', () => {
  it('RowTestStatus passa l\'errore da clipErrorText, sia nel segno sia nel suggerimento', () => {
    const start = MCPW.indexOf('function RowTestStatus')
    const block = MCPW.slice(start, MCPW.indexOf('\n}', start))
    expect(block).not.toBe('')
    expect(block).toMatch(/clipErrorText\(/)
  })
})
