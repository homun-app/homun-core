// RW (fase revisore sulla richiesta, punto 3): il nome che non esiste si
// rifiuta SUBITO, prima del gate — con i nomi validi VICINI per distanza di
// edit (COMPROSIO_PROXY_EXECUTE → COMPOSIO_PROXY_EXECUTE, il caso vero del
// grant 2). Tutto PURO.
import { describe, expect, it } from 'vitest'
import { editDistance, closestToolNames, unknownToolMessage } from '../unknown-tool'

const OFFERED = [
  'mcp__composio__COMPOSIO_PROXY_EXECUTE',
  'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
  'mcp__composio__COMPOSIO_SEARCH_TOOLS',
  'mcp__gmail__send_message',
  'run-command',
  'read-file'
]

describe('RW3: editDistance (Levenshtein)', () => {
  it('i casi noti: il typo del caso vero 1, un insert 1, uguali 0', () => {
    expect(editDistance('COMPROSIO', 'COMPOSIO')).toBe(1)
    expect(editDistance('abc', 'abcd')).toBe(1)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('', 'abc')).toBe(3)
  })
})

describe('RW3: closestToolNames — fino a 3 nomi validi vicini', () => {
  it('il nome inventato del caso vero propone lo strumento VERO per primo', () => {
    const close = closestToolNames('mcp__composio-2__COMPROSIO_PROXY_EXECUTE', OFFERED)
    expect(close[0]).toBe('mcp__composio__COMPOSIO_PROXY_EXECUTE')
    expect(close.length).toBeLessThanOrEqual(3)
  })

  it('un nome lontano non propone niente (max 3, solo i vicini)', () => {
    expect(closestToolNames('cucina la pasta', OFFERED)).toEqual([])
    expect(closestToolNames('zzzzzzzzzz', OFFERED)).toEqual([])
  })

  it('un errore di battitura minimo trova il nome giusto', () => {
    expect(closestToolNames('mcp__gmail__send_messag', OFFERED)).toContain('mcp__gmail__send_message')
  })
})

describe('RW3: unknownToolMessage — il testo per il modello', () => {
  it('dice che lo strumento non esiste e propone i vicini', () => {
    const msg = unknownToolMessage('mcp__composio-2__COMPROSIO_PROXY_EXECUTE', OFFERED)
    expect(msg).toContain('mcp__composio-2__COMPROSIO_PROXY_EXECUTE')
    expect(msg).toContain('does not exist')
    expect(msg).toContain('mcp__composio__COMPOSIO_PROXY_EXECUTE')
  })

  it('senza vicini resta la sola dichiarazione di inesistenza', () => {
    const msg = unknownToolMessage('cucina la pasta', OFFERED)
    expect(msg).toContain('does not exist')
    expect(msg).not.toContain('COMPOSIO_PROXY_EXECUTE')
  })
})
