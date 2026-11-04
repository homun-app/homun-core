// Test di unità (C5): il gateway delle app dentro il server Composio, con
// callMcp e openExternal FINTI in memoria — il flusso add → link → clic →
// WAIT (5 minuti, annullabile) → «Collegata»/«Non riuscito», il risultato
// del modello SENZA link, Rimuovi e il list tollerante.
import { describe, expect, it, vi } from 'vitest'
import { createComposioGatewayManager } from '../composio-gateway'

interface FakeMcp {
  calls: Array<{ tool: string; args: Record<string, unknown>; opts?: { timeoutMs?: number } }>
  respond: (tool: string, args: Record<string, unknown>) => string
}

/** il nome originale dello strumento dal nome completo mcp__composio__X */
const original = (tool: string): string => tool.split('__').slice(2).join('__')

const makeManager = (respond: FakeMcp['respond']) => {
  const fake: FakeMcp = { calls: [], respond }
  const opened: string[] = []
  const settings = new Map<string, unknown>()
  const emitted: unknown[] = []
  const manager = createComposioGatewayManager({
    callMcp: async (tool, args, opts) => {
      fake.calls.push({ tool, args, opts })
      return fake.respond(tool, args)
    },
    gatewayActive: () => true,
    getSetting: <T>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key, value) => settings.set(key, value),
    openExternal: async (url) => {
      opened.push(url)
    },
    hasUi: () => true,
    emit: (e) => emitted.push(e),
    // fase catalogo app (P4): i tentativi di una chiamata MCP rotta partono
    // subito nei test (nel daemon vero aspettano 600 ms)
    retryDelayMs: () => 0
  })
  return { manager, fake, opened, settings }
}

const addResult = (slug: string) => JSON.stringify({
  toolkits: [{ toolkit: slug, status: 'success', redirect_url: `https://mcp.example/authorize?tk=${slug}` }]
})

describe('C5 punto 1 — il flusso DAL BOT (add → card → clic → attesa)', () => {
  it('il risultato add del modello: il link NON passa nel testo, la card lo apre al clic', async () => {
    const { manager, opened, fake } = makeManager((tool) =>
      original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS'
        ? JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'acc_9', status: 'ACTIVE' }] }] })
        : addResult('gmail')
    )
    const handled = manager.handleAgentManageResult(
      { toolkits: [{ name: 'gmail', action: 'add' }] },
      addResult('gmail')
    )
    // il modello non vede il link
    expect(handled.output).not.toContain('mcp.example')
    expect(handled.output).toContain('connection card')
    expect(handled.cards).toHaveLength(1)
    expect(handled.cards[0]!.slug).toBe('gmail')
    // il clic dell'utente apre il link nel browser e aspetta il login
    const r = await manager.cardConnect(handled.cards[0]!.key)
    expect(r.ok).toBe(true)
    expect(opened).toEqual(['https://mcp.example/authorize?tk=gmail'])
    // WAIT_FOR_CONNECTIONS per QUEL toolkit, con timeout 5 minuti
    const wait = fake.calls.find((c) => c.tool.includes('WAIT_FOR_CONNECTIONS'))
    expect(wait?.args.toolkits).toEqual(['gmail'])
    expect(wait?.opts?.timeoutMs).toBe(5 * 60_000)
    // la risposta ACTIVE del server → riga collegata (K3: nome UMANO)
    await vi.waitFor(() => {
      expect(manager.status().connected).toEqual([
        { slug: 'gmail', name: 'Gmail', status: 'ACTIVE', accountId: 'acc_9' }
      ])
    })
  })

  it('il link di una card scade dopo l’uso (un secondo clic non apre nulla)', async () => {
    const { manager, opened } = makeManager(() => addResult('gmail'))
    const handled = manager.handleAgentManageResult({ toolkits: [{ name: 'gmail', action: 'add' }] }, addResult('gmail'))
    await manager.cardConnect(handled.cards[0]!.key)
    const again = await manager.cardConnect(handled.cards[0]!.key)
    expect(again.ok).toBe(false)
    expect(opened).toHaveLength(1)
  })
})

describe('C5 punto 2 — il flusso DALLA FINESTRA APP', () => {
  it('connectApp: add → il link si apre SUBITO (il clic nella finestra è dell’utente) → attesa → collegata', async () => {
    const { manager, opened } = makeManager((tool) =>
      tool.includes('MANAGE_CONNECTIONS')
        ? addResult('slack')
        : JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ id: 'acc_1', status: 'ACTIVE' }] }] })
    )
    const r = await manager.connectApp('slack', 'Slack')
    expect(r.ok).toBe(true)
    expect(opened).toEqual(['https://mcp.example/authorize?tk=slack'])
    await vi.waitFor(() => {
      expect(manager.status().connected.find((a) => a.slug === 'slack')?.status).toBe('ACTIVE')
    })
    // il pending è sparito
    expect(manager.status().pending).toBeNull()
  })

  it('connectApp senza link nella risposta: errore chiaro, niente browser', async () => {
    const { manager, opened } = makeManager(() => JSON.stringify({ toolkits: [{ toolkit: 'x' }] }))
    const r = await manager.connectApp('x')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('link')
    expect(opened).toHaveLength(0)
  })

  it('removeApp: remove con l’account_id, la riga sparisce', async () => {
    const { manager, fake } = makeManager((tool, args) => {
      const entries = (args.toolkits as Array<{ action?: string }>) ?? []
      if (original(tool) === 'COMPOSIO_MANAGE_CONNECTIONS' && entries.some((e) => e.action === 'add')) return addResult('notion')
      return JSON.stringify({ toolkits: [{ toolkit: 'notion', accounts: [{ id: 'acc_7', status: 'ACTIVE' }] }] })
    })
    await manager.connectApp('notion', 'Notion')
    await vi.waitFor(() => {
      expect(manager.status().connected.some((a) => a.slug === 'notion')).toBe(true)
    })
    const r = await manager.removeApp('notion')
    expect(r.ok).toBe(true)
    const remove = fake.calls.find((c) => JSON.stringify(c.args).includes('"remove"'))
    expect(remove?.args.toolkits).toEqual([{ name: 'notion', action: 'remove', account_id: 'acc_7' }])
    expect(manager.status().connected).toEqual([])
  })

  it('cancelWait annulla l’attesa del login', async () => {
    let releaseWait!: () => void
    const { manager } = makeManager((tool) => {
      if (tool.includes('WAIT_FOR_CONNECTIONS')) {
        return new Promise<string>((resolve) => {
          releaseWait = () => resolve(JSON.stringify({ toolkits: [{ toolkit: 'x', accounts: [{ id: 'a', status: 'ACTIVE' }] }] }))
        }) as unknown as string
      }
      return addResult('x')
    })
    const started = manager.connectApp('x', 'X')
    await vi.waitFor(() => {
      expect(manager.status().pending?.slug).toBe('x')
    })
    manager.cancelWait()
    releaseWait()
    await started
    expect(manager.status().connected).toEqual([])
  })
})

describe('C5 punto 3 — il list tollerante (il formato vero va verificato con l’account)', () => {
  it('refreshAccounts aggiorna ACTIVE/RECONNECT quando lo stato si legge; formato ignoto lascia la riga', async () => {
    let mode = 0
    const { manager } = makeManager((tool) => {
      if (tool.includes('WAIT_FOR_CONNECTIONS')) return JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'a1', status: 'ACTIVE' }] }] })
      // dopo il collegamento, il list risponde prima EXPIRED poi un formato sconosciuto
      mode += 1
      if (mode === 1) return addResult('gmail')
      return mode === 2
        ? JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'a1', status: 'EXPIRED' }] }] })
        : 'risposta senza json utile'
    })
    await manager.connectApp('gmail', 'Gmail')
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('ACTIVE')
    })
    await manager.refreshAccounts()
    expect(manager.status().connected[0]?.status).toBe('RECONNECT')
    // formato non deducibile: la riga resta com'è (la UI dice «Gestisci su Composio»)
    await manager.refreshAccounts()
    expect(manager.status().connected[0]?.status).toBe('RECONNECT')
  })
})

describe('C5 — lo stato che vede la UI', () => {
  it('active, righe ordinate per nome, pending con failed', async () => {
    const { manager } = makeManager((tool) => {
      if (original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS') throw new Error('errore di rete simulato')
      return addResult('a')
    })
    await manager.connectApp('a', 'Beta')
    await manager.connectApp('b', 'Alpha')
    await vi.waitFor(() => {
      const st = manager.status()
      expect(st.active).toBe(true)
      expect(st.connected.map((a) => a.name)).toEqual(['Alpha', 'Beta'])
      expect(st.connected.every((a) => a.status === 'FAILED')).toBe(true)
    })
  })

  // ---- K2 (ritocchi): le attese non si accavallano, «Non riuscito» sparisce ----

  it('K2: due attese sullo stesso toolkit → UNA sola chiamata WAIT_FOR_CONNECTIONS', async () => {
    const { manager, fake } = makeManager((tool) =>
      original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS'
        ? JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ id: 'a1', status: 'ACTIVE' }] }] })
        : addResult('slack')
    )
    // la card in chat e la finestra App partono INSIEME per lo stesso toolkit
    await Promise.all([manager.connectApp('slack', 'Slack'), manager.connectApp('slack', 'Slack')])
    await vi.waitFor(() => {
      expect(manager.status().connected.find((a) => a.slug === 'slack')?.status).toBe('ACTIVE')
    })
    expect(fake.calls.filter((c) => original(c.tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS')).toHaveLength(1)
  })

  it('K2: un\'attesa fallita seguita da ACTIVE dello stesso toolkit → pending assente', async () => {
    const waitFailed = JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ status: 'FAILED' }] }] })
    const listActive = JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ id: 'a1', status: 'ACTIVE' }] }] })
    const { manager } = makeManager((tool, args) => {
      if (original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS') return waitFailed
      const action = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]?.action
      return action === 'list' ? listActive : addResult('slack')
    })
    await manager.connectApp('slack', 'Slack')
    // l'attesa è finita MALE: il riquadro dice «Non riuscito»
    await vi.waitFor(() => {
      expect(manager.status().pending?.failed).toBe(true)
    })
    // ma nel frattempo il toolkit è diventato ACTIVE (qui: refreshAccounts):
    // il riquadro sparisce, resta la riga «Collegata»
    await manager.refreshAccounts()
    expect(manager.status().pending).toBeNull()
    expect(manager.status().connected.find((a) => a.slug === 'slack')).toMatchObject({ status: 'ACTIVE' })
  })

  it('K3: un nome salvato UGUALE allo slug (dati vecchi) si legge col nome umano', async () => {
    const { manager, settings } = makeManager(() => addResult('x'))
    // lo stato su disco di una sonda vecchia: name = slug
    settings.set('composioGateway.apps', { slack: { name: 'slack', accountId: null, status: 'ACTIVE', connectedAt: 1 } })
    expect(manager.status().connected[0]?.name).toBe('Slack')
  })
})
