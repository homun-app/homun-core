// Fase design (DS4): il modulo di configurazione ai token — campi da 36, un
// solo bottone pieno. Viveva in server-sheet-error.test.ts col foglio del
// server (C0 della fase linguaggio lo ha cancellato: nessuno lo montava);
// il modulo è vivo (lo usa la card MCP in chat) e la sua prova resta, qui.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'

describe('DS4 (fase design): il modulo di configurazione ai token — campi da 36, un solo bottone pieno', () => {
  it('i campi sono alti 36 col raggio dei controlli e il testo di riga; il bottone che collega è un Button, spento finché manca un valore', async () => {
    const { ServerSetupModule } = await import('../components/ServerSetup')
    const spec = {
      serverId: 'srv', name: 'Mattermost', transport: 'http', auth: 'headers', needsSetup: true, urlTemplate: 'https://{mattermost_host}/mcp',
      variables: [{ name: 'mattermost_host', isRequired: true, isSecret: false, description: 'L\'indirizzo del server' }],
      tokenHeader: { name: 'Authorization', valueTemplate: 'Bearer {token}', variable: 'token', saved: false }
    } as never
    const root = parseHtml(renderHtml(createElement(ServerSetupModule, { spec, testid: 'server-setup' })))
    const modulo = findAll(root, (n) => n.attrs['data-testid'] === 'server-setup')[0]!
    const inputs = findAll(modulo, (n) => n.tag === 'input')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    for (const input of inputs) {
      for (const cls of ['h-control', 'rounded-control', 'text-body']) expect((input.attrs.class ?? '').split(/\s+/), cls).toContain(cls)
    }
    const connect = findAll(modulo, (n) => n.attrs['data-testid'] === 'setup-connect')[0]!
    expect(connect.attrs['data-slot']).toBe('button')
    for (const cls of ['bg-foreground', 'h-control', 'rounded-full']) expect((connect.attrs.class ?? '').split(/\s+/), cls).toContain(cls)
    // i campi obbligatori sono vuoti: non si può ancora collegare
    expect(connect.attrs.disabled).toBeDefined()
  })
})
