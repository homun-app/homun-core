// La riga di un server MCP non mostra mai «undefined»: per i server npm che
// girano nel computer isolato (E4) il comando sta in box.command/box.args.
import { describe, expect, it } from 'vitest'
import { serverCommandLine } from '../lib/mcp-row'

describe('serverCommandLine', () => {
  it('stdio sul Mac: comando e argomenti', () => {
    expect(serverCommandLine({ transport: 'stdio', command: 'npx', args: ['-y', '@donach/mattermost-mcp'] })).toBe('npx -y @donach/mattermost-mcp')
  })
  it('stdio nel computer isolato: il comando del box, mai «undefined»', () => {
    const line = serverCommandLine({ transport: 'stdio', box: { workdir: '/w', command: 'npx', args: ['--yes', '@acme/pdf-mcp@2.1.0'] } })
    expect(line).toBe('npx --yes @acme/pdf-mcp@2.1.0')
    expect(line).not.toContain('undefined')
  })
  it('http: l\'indirizzo', () => {
    expect(serverCommandLine({ transport: 'http', url: 'https://orion.example/mcp' })).toBe('https://orion.example/mcp')
  })
  it('senza niente: stringa vuota, non «undefined»', () => {
    expect(serverCommandLine({ transport: 'stdio' })).toBe('')
  })
})
