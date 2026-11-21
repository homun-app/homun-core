// U5 (fase mcp-ui): dopo «Importa» (e dopo ogni aggiunta o modifica) il test
// di connessione parte DA SOLO per ogni server toccato e la riga mostra il
// pallino verde «N strumenti» o rosso con l'errore — riusa mcp:test e il
// segno di U1 (RowTestStatus). Guardie sul sorgente del renderer e del
// daemon; il DOM vero lo prova la sonda.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MCPW = readFileSync(fileURLToPath(new URL('../components/McpWindow.tsx', import.meta.url)), 'utf8')
const API = readFileSync(fileURLToPath(new URL('../../../daemon/api.ts', import.meta.url)), 'utf8')

describe('U5: il test di connessione parte DA SOLO dopo import/aggiunta/modifica', () => {
  it('dopo «Importa»: ogni server CREATO riceve subito runTest (il pallino nella riga)', () => {
    const start = MCPW.indexOf('const applyImport = async')
    const block = MCPW.slice(start, MCPW.indexOf('\n  }', start))
    expect(block).not.toBe('')
    // i creati si riconoscono dagli esiti dell'apply e si testano SUBITO
    expect(block).toMatch(/'created'/)
    expect(block).toMatch(/runTest\(/)
  })

  it('dopo «Salva» (aggiunta o modifica): il server salvato riceve subito runTest', () => {
    const at = MCPW.indexOf('await api.mcpSave(')
    const block = MCPW.slice(MCPW.lastIndexOf('onClick={async', at), MCPW.indexOf('<Trans>Salva</Trans>', at))
    expect(block).not.toBe('')
    expect(block).toMatch(/runTest\(/)
  })

  it('il daemon: mcp:save fa subito il test e manda la nota ai bot abilitati (notifyMcpServerState)', () => {
    const start = API.indexOf("'mcp:save'")
    const block = API.slice(start, API.indexOf("'mcp:delete'", start))
    expect(block).not.toBe('')
    expect(block).toMatch(/notifyMcpServerState\(/)
    expect(block).toMatch(/testServer\(/)
  })
})
