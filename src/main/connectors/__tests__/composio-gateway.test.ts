// Test di unità (C5): il gateway delle app dentro il server Composio, con
// callMcp e openExternal FINTI in memoria — il flusso add → link → clic →
// WAIT (5 minuti, annullabile) → verifica `list` (V8) → «Collegata»/
// «Non riuscito», il risultato del modello SENZA link, Rimuovi e il list.
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

/** La risposta `list` nel FORMATO VERO della prova (V8, dati sostituiti). */
const realListResult = (slug: string, opts: { id?: string; email?: string; status?: string } = {}) =>
  JSON.stringify({
    successful: true,
    data: {
      results: {
        [slug]: {
          toolkit: slug,
          status: opts.status ?? 'active',
          accounts: [
            { id: opts.id ?? `acc_${slug}`, status: opts.status ?? 'active', is_default: true, ...(opts.email ? { user_info: { email: opts.email } } : {}) }
          ]
        }
      },
      summary: { total_toolkits: 1, active_connections: 1, initiated_connections: 0, failed_connections: 0 },
      session: { id: 'zulu', instructions: 'REQUIRED: Pass session_id "zulu" in ALL subsequent meta tool calls for this workflow.' }
    },
    error: null
  })

/** Il fake che risponde per strumento e azione di toolkits[0]. */
const byAction = (
  answers: { wait?: () => string; list?: () => string; add?: () => string; remove?: () => string }
): FakeMcp['respond'] => (tool, args) => {
  const action = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]?.action ?? (Array.isArray(args.toolkits) && typeof args.toolkits[0] === 'string' ? 'wait' : 'add')
  if (original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS') return answers.wait?.() ?? realListResult('x')
  if (action === 'list') return answers.list?.() ?? realListResult('x')
  if (action === 'remove') return answers.remove?.() ?? JSON.stringify({ toolkits: [{ toolkit: 'x', status: 'removed' }] })
  return answers.add?.() ?? addResult('x')
}

/**
 * Il fake del collegamento che AVVIENE: `list` dice «initiated» finché la
 * WAIT non gira (il login dell'utente), poi l'account diventa attivo — così
 * il pre-controllo V8 di connectApp NON cortocircuita l'add.
 */
const gradualConnect = (slug: string, id: string, waitImpl?: () => string, email?: string) => {
  const state = { loginDone: false }
  return byAction({
    wait: () => {
      state.loginDone = true
      return waitImpl?.() ?? realListResult(slug, { id })
    },
    list: () => realListResult(slug, { id, status: state.loginDone ? 'active' : 'initiated', ...(email ? { email } : {}) }),
    add: () => addResult(slug)
  })
}

describe('C5 punto 1 — il flusso DAL BOT (add → card → clic → attesa)', () => {
  it('il risultato add del modello: il link NON passa nel testo, la card lo apre al clic', async () => {
    const { manager, opened, fake } = makeManager(byAction({
      wait: () => JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'acc_wait', status: 'ACTIVE' }] }] }),
      list: () => realListResult('gmail', { id: 'acc_9' }),
      add: () => addResult('gmail')
    }))
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
    // V8: lo stato lo dice `list` (account is_default, email), non la WAIT
    await vi.waitFor(() => {
      expect(manager.status().connected).toEqual([
        { slug: 'gmail', name: 'Gmail', status: 'ACTIVE', accountId: 'acc_9' }
      ])
    })
  })

  it('V8: WAIT dal formato ignoto → lo stato viene dal list (se list non dice active NON è collegata)', async () => {
    const { manager } = makeManager(gradualConnect('gmail', 'gmail_aaa-bbb', () =>
      JSON.stringify({ qualunque: { cosa: 'il formato di WAIT non lo conosciamo' } })
    , 'utente@example.com'))
    await manager.connectApp('gmail', 'Gmail')
    await vi.waitFor(() => {
      expect(manager.status().connected[0]).toMatchObject({
        slug: 'gmail', status: 'ACTIVE', accountId: 'gmail_aaa-bbb', email: 'utente@example.com'
      })
    })
  })

  it('V8: WAIT finita bene MA il list non dice active → NON riuscito', async () => {
    const { manager } = makeManager(byAction({
      wait: () => JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'a', status: 'ACTIVE' }] }] }),
      list: () => realListResult('gmail', { status: 'initiated' }),
      add: () => addResult('gmail')
    }))
    await manager.connectApp('gmail', 'Gmail')
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('FAILED')
      expect(manager.status().pending?.failed).toBe(true)
    })
  })

  it('V12: WAIT in errore («Connection closed») MA list dice active → collegata, MAI «Non riuscito»', async () => {
    const { manager, fake } = makeManager(gradualConnect('slack', 'a1', () => {
      throw new Error('Connection closed')
    }))
    await manager.connectApp('slack', 'Slack')
    // la riga diventa ACTIVE senza mai passare per FAILED
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('ACTIVE')
      expect(manager.status().pending).toBeNull()
    })
    expect(manager.status().connected[0]?.status).not.toBe('FAILED')
    // la WAIT è stata ritentata (3 tentativi) prima di fidarsi del list
    expect(fake.calls.filter((c) => original(c.tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS')).toHaveLength(3)
  })

  it('il link di una card scade dopo l’uso (un secondo clic non apre nulla)', async () => {
    const { manager, opened } = makeManager(byAction({ add: () => addResult('gmail') }))
    const handled = manager.handleAgentManageResult({ toolkits: [{ name: 'gmail', action: 'add' }] }, addResult('gmail'))
    await manager.cardConnect(handled.cards[0]!.key)
    const again = await manager.cardConnect(handled.cards[0]!.key)
    expect(again.ok).toBe(false)
    expect(opened).toHaveLength(1)
  })
})

describe('C5 punto 2 — il flusso DALLA FINESTRA APP', () => {
  it('connectApp: add → il link si apre SUBITO (il clic nella finestra è dell\'utente) → attesa → collegata', async () => {
    const { manager, opened } = makeManager(gradualConnect('slack', 'acc_1'))
    const r = await manager.connectApp('slack', 'Slack')
    expect(r.ok).toBe(true)
    expect(r.already).toBeUndefined()
    expect(opened).toEqual(['https://mcp.example/authorize?tk=slack'])
    await vi.waitFor(() => {
      expect(manager.status().connected.find((a) => a.slug === 'slack')?.status).toBe('ACTIVE')
    })
    // il pending è sparito
    expect(manager.status().pending).toBeNull()
  })

  it('V8: connectApp con un account GIÀ attivo → NESSUN add (mai account doppi), riga «Collegata»', async () => {
    const { manager, fake, opened } = makeManager((tool, args) => {
      const action = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]?.action
      if (action === 'add') throw new Error('V8: add non doveva essere chiamato')
      return realListResult('gmail', { id: 'gmail_gia', email: 'utente@example.com' })
    })
    const r = await manager.connectApp('gmail', 'Gmail')
    expect(r).toEqual({ ok: true, already: true })
    expect(fake.calls.some((c) => JSON.stringify(c.args).includes('"add"'))).toBe(false)
    expect(opened).toHaveLength(0)
    expect(manager.status().connected[0]).toMatchObject({ slug: 'gmail', status: 'ACTIVE', accountId: 'gmail_gia' })
  })

  it('connectApp senza link nella risposta: errore chiaro, niente browser', async () => {
    const { manager, opened } = makeManager(byAction({
      add: () => JSON.stringify({ toolkits: [{ toolkit: 'x' }] }),
      list: () => JSON.stringify({ toolkits: [{ toolkit: 'x' }] })
    }))
    const r = await manager.connectApp('x')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('link')
    expect(opened).toHaveLength(0)
  })

  it('removeApp: remove con l\'account_id, la riga sparisce', async () => {
    const { manager, fake } = makeManager(byAction({
      list: () => realListResult('notion', { id: 'acc_7' }),
      add: () => addResult('notion')
    }))
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

  it('cancelWait annulla l\'attesa del login', async () => {
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
    // V6: dopo l'annullo il gateway NON ha più un'attesa
    expect(manager.status().pending).toBeNull()
  })

  it('V6: dopo il fallimento, Riprova chiede un add NUOVO e una nuova attesa', async () => {
    const { manager, fake, opened } = makeManager(byAction({
      wait: () => JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ status: 'FAILED' }] }] }),
      list: () => JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ status: 'INITIATED' }] }] }),
      add: () => addResult('slack')
    }))
    const first = await manager.connectApp('slack', 'Slack')
    expect(first.ok).toBe(true)
    await vi.waitFor(() => {
      // l'attesa è finita male: «Non riuscito · Riprova»
      expect(manager.status().pending?.failed).toBe(true)
      expect(manager.status().connected[0]?.status).toBe('FAILED')
    })
    // Riprova (come fa la card): una NUOVA chiamata add (link nuovo, monouso il
    // vecchio) e una nuova attesa
    const second = await manager.connectApp('slack', 'Slack')
    expect(second.ok).toBe(true)
    const adds = fake.calls.filter((c) => (c.args.toolkits as Array<{ action?: string }>)?.[0]?.action === 'add')
    expect(adds.length).toBe(2)
    expect(opened).toHaveLength(2)
    await vi.waitFor(() => {
      expect(manager.status().pending).not.toBeNull()
    })
  })

  it('V8: il session_id del server si ripassa nelle chiamate successive del gateway', async () => {
    const { manager, fake } = makeManager(gradualConnect('slack', 's1'))
    await manager.connectApp('slack', 'Slack')
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('ACTIVE')
    })
    await manager.refreshAccounts()
    // il list dopo la prima risposta (che portava data.session.id) ripassa il session_id
    const lists = fake.calls.filter((c) => original(c.tool) === 'COMPOSIO_MANAGE_CONNECTIONS' && (c.args.toolkits as Array<{ action?: string }>)?.[0]?.action === 'list')
    expect(lists.length).toBeGreaterThanOrEqual(2)
    expect(lists[0]!.args.session_id).toBeUndefined() // la prima lo riceve dal server
    for (const later of lists.slice(1)) expect(later.args.session_id).toBe('zulu')
  })
})

describe('C5 punto 3 — il list (V8: la forma vera letta per prima)', () => {
  it('refreshAccounts aggiorna ACTIVE/RECONNECT; errore di rete lascia la riga', async () => {
    let mode = 0
    const { manager } = makeManager(byAction({
      wait: () => realListResult('gmail', { id: 'a1' }),
      list: () => {
        mode += 1
        // dopo il collegamento, il list risponde prima EXPIRED poi cade
        if (mode <= 1) return realListResult('gmail', { id: 'a1' })
        if (mode === 2) return JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'a1', status: 'EXPIRED' }] }] })
        throw new Error('server giù')
      },
      add: () => addResult('gmail')
    }))
    await manager.connectApp('gmail', 'Gmail')
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('ACTIVE')
    })
    await manager.refreshAccounts()
    expect(manager.status().connected[0]?.status).toBe('RECONNECT')
    // il server non risponde: la riga resta com'è, mai un'eccezione alla UI
    await manager.refreshAccounts()
    expect(manager.status().connected[0]?.status).toBe('RECONNECT')
  })
})

describe('C5 — lo stato che vede la UI', () => {
  it('active, righe ordinate per nome, pending con failed', async () => {
    const { manager } = makeManager(byAction({
      wait: () => { throw new Error('errore di rete simulato') },
      list: () => JSON.stringify({ toolkits: [] }), // list senza account: non attivo
      add: () => addResult('a')
    }))
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
    const { manager, fake } = makeManager(gradualConnect('slack', 'a1'))
    // la card in chat e la finestra App partono INSIEME per lo stesso toolkit
    await Promise.all([manager.connectApp('slack', 'Slack'), manager.connectApp('slack', 'Slack')])
    await vi.waitFor(() => {
      expect(manager.status().connected.find((a) => a.slug === 'slack')?.status).toBe('ACTIVE')
    })
    expect(fake.calls.filter((c) => original(c.tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS')).toHaveLength(1)
  })

  it('K2/V12: l\'attesa finita MALE seguita da ACTIVE dello stesso toolkit → pending assente, mai FAILED', async () => {
    const waitFailed = JSON.stringify({ toolkits: [{ toolkit: 'slack', accounts: [{ status: 'FAILED' }] }] })
    const { manager } = makeManager(byAction({
      wait: () => waitFailed,
      list: () => realListResult('slack', { id: 'a1' }),
      add: () => addResult('slack')
    }))
    await manager.connectApp('slack', 'Slack')
    // V8+V12: il FALLIMENTO della WAIT non basta — list dice ACTIVE, quindi la
    // riga è «Collegata» e NON è mai comparsa come «Non riuscito»
    await vi.waitFor(() => {
      expect(manager.status().pending).toBeNull()
      expect(manager.status().connected.find((a) => a.slug === 'slack')).toMatchObject({ status: 'ACTIVE' })
    })
  })

  it('K3: un nome salvato UGUALE allo slug (dati vecchi) si legge col nome umano', async () => {
    const { manager, settings } = makeManager(byAction({ add: () => addResult('x') }))
    // lo stato su disco di una sonda vecchia: name = slug
    settings.set('composioGateway.apps', { slack: { name: 'slack', accountId: null, status: 'ACTIVE', connectedAt: 1 } })
    expect(manager.status().connected[0]?.name).toBe('Slack')
  })
})
