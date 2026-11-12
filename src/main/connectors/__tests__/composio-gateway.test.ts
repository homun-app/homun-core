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
  // CA4: la riconnessione del client MCP e la riga di log del daemon
  const reopens: number[] = []
  const logLines: string[] = []
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
    retryDelayMs: () => 0,
    // CA4 (fase composio-account): il client MCP si RIAPRE su Connection closed
    reopenMcp: () => {
      reopens.push(Date.now())
    },
    logLine: (line) => logLines.push(line)
  })
  return { manager, fake, opened, settings, reopens, logLines }
}

const addResult = (slug: string) => JSON.stringify({
  toolkits: [{ toolkit: slug, status: 'success', redirect_url: `https://mcp.example/authorize?tk=${slug}` }]
})

/** La risposta `list` nel FORMATO VERO della prova (V8, dati sostituiti). */
const realListResult = (slug: string, opts: { id?: string; email?: string; status?: string } = {}) =>
  realListMany(slug, [{ id: opts.id ?? `acc_${slug}`, status: opts.status ?? 'active', is_default: true, ...(opts.email ? { email: opts.email } : {}) }], opts.status ?? 'active')

/** CA1: la risposta `list` con PIÙ account (alias, email, is_default). */
const realListMany = (
  slug: string,
  accounts: Array<{ id: string; alias?: string; email?: string; status?: string; is_default?: boolean }>,
  toolkitStatus = 'active'
) =>
  JSON.stringify({
    successful: true,
    data: {
      results: {
        [slug]: {
          toolkit: slug,
          status: accounts.some((a) => (a.status ?? 'active') === 'active') ? toolkitStatus : 'initiated',
          accounts: accounts.map((a) => ({
            id: a.id,
            status: a.status ?? 'active',
            is_default: a.is_default ?? false,
            ...(a.alias ? { alias: a.alias } : {}),
            ...(a.email ? { user_info: { email: a.email } } : {})
          }))
        }
      },
      summary: { total_toolkits: 1, active_connections: accounts.filter((a) => (a.status ?? 'active') === 'active').length, initiated_connections: 0, failed_connections: 0 },
      session: { id: 'zulu', instructions: 'REQUIRED: Pass session_id "zulu" in ALL subsequent meta tool calls for this workflow.' }
    },
    error: null
  })

/** Il fake che risponde per strumento e azione di toolkits[0]. */
const byAction = (
  answers: { wait?: () => string; list?: () => string; add?: () => string; remove?: () => string; rename?: () => string }
): FakeMcp['respond'] => (tool, args) => {
  const action = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]?.action ?? (Array.isArray(args.toolkits) && typeof args.toolkits[0] === 'string' ? 'wait' : 'add')
  if (original(tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS') return answers.wait?.() ?? realListResult('x')
  if (action === 'list') return answers.list?.() ?? realListResult('x')
  if (action === 'remove') return answers.remove?.() ?? JSON.stringify({ toolkits: [{ toolkit: 'x', status: 'removed' }] })
  if (action === 'rename') return answers.rename?.() ?? JSON.stringify({ toolkits: [{ toolkit: 'x', status: 'renamed' }] })
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
    // CA1: la riga porta TUTTI gli account (qui uno, senza email → senza alias)
    await vi.waitFor(() => {
      expect(manager.status().connected).toEqual([
        { slug: 'gmail', name: 'Gmail', status: 'ACTIVE', accountId: 'acc_9', accounts: [{ accountId: 'acc_9', status: 'ACTIVE', isDefault: true }] }
      ])
    })
  })

  it('V8: WAIT dal formato ignoto → lo stato viene dal list (se list non dice active NON è collegata)', async () => {
    const { manager } = makeManager(gradualConnect('gmail', 'gmail_aaa-bbb', () =>
      JSON.stringify({ qualunque: { cosa: 'il formato di WAIT non lo conosciamo' } })
    , 'utente@example.com'))
    await manager.connectApp('gmail', { name: 'Gmail' })
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
    await manager.connectApp('gmail', { name: 'Gmail' })
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('FAILED')
      expect(manager.status().pending?.failed).toBe(true)
    })
  })

  it('V12: WAIT in errore («Connection closed») MA list dice active → collegata, MAI «Non riuscito»', async () => {
    const { manager, fake } = makeManager(gradualConnect('slack', 'a1', () => {
      throw new Error('Connection closed')
    }))
    await manager.connectApp('slack', { name: 'Slack' })
    // la riga diventa ACTIVE senza mai passare per FAILED
    await vi.waitFor(() => {
      expect(manager.status().connected[0]?.status).toBe('ACTIVE')
      expect(manager.status().pending).toBeNull()
    })
    expect(manager.status().connected[0]?.status).not.toBe('FAILED')
    // la WAIT è stata ritentata prima di fidarsi del list — CA4: 3 tentativi
    // e OGNI tentativo riapre il client e ripete (3 × 2 = 6 chiamate)
    expect(fake.calls.filter((c) => original(c.tool) === 'COMPOSIO_WAIT_FOR_CONNECTIONS')).toHaveLength(6)
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
    const r = await manager.connectApp('slack', { name: 'Slack' })
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
    const r = await manager.connectApp('gmail', { name: 'Gmail' })
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
    await manager.connectApp('notion', { name: 'Notion' })
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
    const started = manager.connectApp('x', { name: 'X' })
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
    const first = await manager.connectApp('slack', { name: 'Slack' })
    expect(first.ok).toBe(true)
    await vi.waitFor(() => {
      // l'attesa è finita male: «Non riuscito · Riprova»
      expect(manager.status().pending?.failed).toBe(true)
      expect(manager.status().connected[0]?.status).toBe('FAILED')
    })
    // Riprova (come fa la card): una NUOVA chiamata add (link nuovo, monouso il
    // vecchio) e una nuova attesa
    const second = await manager.connectApp('slack', { name: 'Slack' })
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
    await manager.connectApp('slack', { name: 'Slack' })
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
    await manager.connectApp('gmail', { name: 'Gmail' })
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
    await manager.connectApp('a', { name: 'Beta' })
    await manager.connectApp('b', { name: 'Alpha' })
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
    await Promise.all([manager.connectApp('slack', { name: 'Slack' }), manager.connectApp('slack', { name: 'Slack' })])
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
    await manager.connectApp('slack', { name: 'Slack' })
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

// ---- CA1 (fase composio-account): più account per la stessa app ----

/** Lo stato locale già in formato nuovo (due account Gmail attivi). */
const twoAccountGmail = {
  gmail: {
    name: 'Gmail',
    accounts: [
      { accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', status: 'ACTIVE', connectedAt: 1, isDefault: true },
      { accountId: 'a2', alias: 'personale', email: 'fabio@gmail.test', status: 'ACTIVE', connectedAt: 2 }
    ]
  }
}

describe('CA1 — più account per app', () => {
  it('connectApp another: SALTA il controllo «già attivo», chiama add CON l\'alias normalizzato, e dopo il login il list rilegge TUTTI gli account', async () => {
    const state = { second: false }
    const { manager, fake, opened } = makeManager(byAction({
      wait: () => { state.second = true; return realListMany('gmail', []) },
      list: () => state.second
        ? realListMany('gmail', [
            { id: 'a1', alias: 'fabio', email: 'fabio@azienda.test', is_default: true },
            { id: 'a2', alias: 'casapersonale', email: 'fabio@gmail.test' }
          ])
        : realListMany('gmail', [{ id: 'a1', alias: 'fabio', email: 'fabio@azienda.test', is_default: true }]),
      add: () => addResult('gmail')
    }))
    await manager.connectApp('gmail', { name: 'Gmail', another: true, alias: ' Casa Personale ' })
    // l'add è partito NONOSTANTE l'account attivo, con l'alias normalizzato
    const add = fake.calls.find((c) => (c.args.toolkits as Array<{ action?: string; alias?: string }>)?.[0]?.action === 'add')
    expect(add?.args.toolkits).toEqual([{ name: 'gmail', action: 'add', alias: 'casapersonale' }])
    expect(opened).toHaveLength(1)
    await vi.waitFor(() => {
      const row = manager.status().connected.find((a) => a.slug === 'gmail')
      expect(row?.accounts).toHaveLength(2)
      expect(row?.accounts?.map((a) => a.alias)).toEqual(['fabio', 'casapersonale'])
    })
  })

  it('connectApp SENZA another e un account attivo resta «already» (nessun add)', async () => {
    const { manager, fake, opened } = makeManager(byAction({
      list: () => realListMany('gmail', [{ id: 'a1', alias: 'lavoro', email: 'fabio@azienda.test' }])
    }))
    const r = await manager.connectApp('gmail', { name: 'Gmail' })
    expect(r).toEqual({ ok: true, already: true })
    expect(fake.calls.some((c) => JSON.stringify(c.args).includes('"add"'))).toBe(false)
    expect(opened).toHaveLength(0)
  })

  it('l\'alias predefinito è la parte locale dell\'email, univoca nel toolkit', async () => {
    const state = { second: false }
    const { manager } = makeManager(byAction({
      wait: () => { state.second = true; return realListMany('gmail', []) },
      list: () => state.second
        ? realListMany('gmail', [
            { id: 'a1', email: 'fabio@azienda.test', is_default: true },
            { id: 'a2', email: 'fabio@gmail.test' }
          ])
        : realListMany('gmail', [{ id: 'a1', email: 'fabio@azienda.test', is_default: true }]),
      add: () => addResult('gmail')
    }))
    await manager.connectApp('gmail', { name: 'Gmail', another: true })
    await vi.waitFor(() => {
      const row = manager.status().connected.find((a) => a.slug === 'gmail')
      expect(row?.accounts?.map((a) => a.alias)).toEqual(['fabio', 'fabio-2'])
    })
  })

  it('renameAccount: rename con account_id e alias normalizzato/univoco, poi il list rilegge', async () => {
    // lo stato locale: a1 «lavoro», a2 «personale» (twoAccountGmail)
    const state = { aliases: new Map([['a1', 'lavoro'], ['a2', 'personale']]) }
    const { manager, fake, settings } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string; account_id?: string; alias?: string }> | undefined)?.[0]
      if (entry?.action === 'rename') {
        state.aliases.set(entry.account_id ?? '', entry.alias ?? '')
        return JSON.stringify({ toolkits: [{ toolkit: 'gmail', status: 'renamed' }] })
      }
      if (entry?.action === 'list') {
        return realListMany('gmail', [...state.aliases.entries()].map(([id, alias]) => ({
          id, alias, email: id === 'a1' ? 'fabio@azienda.test' : 'fabio@gmail.test', is_default: id === 'a1'
        })))
      }
      return addResult('gmail')
    })
    settings.set('composioGateway.apps', structuredClone(twoAccountGmail))
    // «Lavoro» normalizzato è «lavoro», già preso da a1 → a2 diventa «lavoro-2»
    const renamesOf = () => fake.calls.filter((c) => (c.args.toolkits as Array<{ action?: string }>)?.[0]?.action === 'rename')
    const r = await manager.renameAccount('gmail', 'a2', 'Lavoro')
    expect(r.ok).toBe(true)
    expect(renamesOf()[0]?.args.toolkits).toEqual([{ name: 'gmail', action: 'rename', account_id: 'a2', alias: 'lavoro-2' }])
    // dopo il rename il list rilegge e la riga mostra l'alias nuovo
    expect(manager.status().connected.find((a) => a.slug === 'gmail')?.accounts?.find((a) => a.accountId === 'a2')?.alias).toBe('lavoro-2')
    // un alias libero passa normalizzato, senza suffissi
    const r2 = await manager.renameAccount('gmail', 'a1', ' Casa ')
    expect(r2.ok).toBe(true)
    expect(renamesOf()[1]?.args.toolkits).toEqual([{ name: 'gmail', action: 'rename', account_id: 'a1', alias: 'casa' }])
  })

  it('removeAccount: remove per account; togliere l\'ULTIMO account toglie l\'app', async () => {
    const state = { ids: ['a1', 'a2'] }
    const { manager, fake, settings } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string; account_id?: string }> | undefined)?.[0]
      if (entry?.action === 'remove') {
        state.ids = state.ids.filter((x) => x !== entry.account_id)
        return JSON.stringify({ toolkits: [{ toolkit: 'gmail', status: 'removed' }] })
      }
      if (entry?.action === 'list') {
        return realListMany('gmail', state.ids.map((id, i) => ({ id, alias: i === 0 ? 'lavoro' : 'personale', email: `fabio${i}@azienda.test` })))
      }
      return addResult('gmail')
    })
    settings.set('composioGateway.apps', structuredClone(twoAccountGmail))
    // rimuove il SECONDO account: la riga resta con uno
    const r = await manager.removeAccount('gmail', 'a2')
    expect(r.ok).toBe(true)
    const remove = fake.calls.find((c) => (c.args.toolkits as Array<{ action?: string }>)?.[0]?.action === 'remove')
    expect(remove?.args.toolkits).toEqual([{ name: 'gmail', action: 'remove', account_id: 'a2' }])
    expect(manager.status().connected.find((a) => a.slug === 'gmail')?.accounts).toHaveLength(1)
  })

  it('removeAccount dell\'ultimo account: la riga dell\'app SPARISCE', async () => {
    const state = { ids: ['a1', 'a2'] }
    const { manager, settings } = makeManager((tool, args) => {
      const action = (args.toolkits as Array<{ action?: string; account_id?: string }> | undefined)?.[0]?.action
      if (action === 'remove') {
        const id = (args.toolkits as Array<{ account_id?: string }>)[0]!.account_id
        state.ids = state.ids.filter((x) => x !== id)
        return JSON.stringify({ toolkits: [{ toolkit: 'gmail', status: 'removed' }] })
      }
      if (action === 'list') {
        return realListMany('gmail', state.ids.map((id) => ({ id, alias: 'lavoro', email: 'fabio@azienda.test' })))
      }
      return addResult('gmail')
    })
    settings.set('composioGateway.apps', structuredClone(twoAccountGmail))
    // il primo remove lascia un account; il SECONDO toglie l'ultimo e la
    // riga dell'app sparisce (CA1 punto 3)
    await manager.removeAccount('gmail', 'a1')
    expect(manager.status().connected.find((a) => a.slug === 'gmail')?.accounts).toHaveLength(1)
    const r2 = await manager.removeAccount('gmail', 'a2')
    expect(r2.ok).toBe(true)
    expect(manager.status().connected.find((a) => a.slug === 'gmail')).toBeUndefined()
  })

  it('il limite di account: la UI lo sa in parole semplici (error account-limit, nessun browser)', async () => {
    const { manager, fake, opened } = makeManager(byAction({
      list: () => realListMany('gmail', [
        { id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }, { id: 'a5' }
      ]),
      add: () => JSON.stringify({
        toolkits: [{ toolkit: 'gmail', status: 'error', error: 'Max account limit reached: 5 accounts per toolkit. Remove one to add another.' }]
      })
    }))
    const r = await manager.connectApp('gmail', { name: 'Gmail', another: true, alias: 'extra' })
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ error: 'account-limit', accountCount: 5 })
    expect(opened).toHaveLength(0)
    expect(fake.calls.some((c) => c.tool.includes('WAIT_FOR_CONNECTIONS'))).toBe(false)
  })

  it('la migrazione del formato vecchio si vede dallo status (un account piatto → accounts[0])', async () => {
    const { manager, settings } = makeManager(byAction({ add: () => addResult('x') }))
    settings.set('composioGateway.apps', { gmail: { name: 'Gmail', accountId: 'vecchio', status: 'ACTIVE', connectedAt: 9, email: 'utente@example.com' } })
    const row = manager.status().connected[0]
    expect(row).toMatchObject({ slug: 'gmail', status: 'ACTIVE', accountId: 'vecchio', email: 'utente@example.com' })
    expect(row?.accounts).toEqual([{ accountId: 'vecchio', alias: 'utente', email: 'utente@example.com', status: 'ACTIVE' }])
  })

  it('refreshAccounts sostituisce l\'elenco con TUTTI gli account del toolkit', async () => {
    const { manager, settings } = makeManager(byAction({
      list: () => realListMany('gmail', [
        { id: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', is_default: true },
        { id: 'a2', alias: 'personale', email: 'fabio@gmail.test' }
      ])
    }))
    settings.set('composioGateway.apps', structuredClone(twoAccountGmail))
    await manager.refreshAccounts()
    const row = manager.status().connected.find((a) => a.slug === 'gmail')
    expect(row?.accounts).toEqual([
      { accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', status: 'ACTIVE', isDefault: true },
      { accountId: 'a2', alias: 'personale', email: 'fabio@gmail.test', status: 'ACTIVE' }
    ])
  })
})


// ---- CA4 (fase composio-account): la connessione chiusa si riapre ----

describe('CA4 — «Connection closed»: il client MCP si riapre, add/remove non si ripetono', () => {
  const CLOSED = 'MCP error -32000: Connection closed'

  it('il list cade una volta → riconnessione e RIPETIZIONE: gli account arrivano, con la riga di log SENZA link né token', async () => {
    let listCalls = 0
    const { manager, reopens, logLines } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]
      if (entry?.action === 'list') {
        listCalls++
        if (listCalls === 1) throw new Error(CLOSED)
        return realListMany('gmail', [{ id: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', is_default: true }])
      }
      return addResult('gmail')
    })
    const r = await manager.connectApp('gmail', { name: 'Gmail' })
    // il pre-controllo è passato dalla riconnessione: l'account c'è già → already
    expect(r).toEqual({ ok: true, already: true })
    expect(listCalls).toBe(2)
    expect(reopens).toHaveLength(1)
    expect(logLines.join('\n')).toContain('reopened')
    // la riga di log non porta MAI il link né gli argomenti
    expect(logLines.join('\n')).not.toContain('mcp.example')
    expect(logLines.join('\n')).not.toContain('toolkits')
  })

  it('l\'add NON si ripete dopo che la richiesta è partita: cade → si rilegge list e si decide (già collegata)', async () => {
    let addCalls = 0
    const state = { active: false }
    const { manager, fake, reopens, opened } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]
      if (entry?.action === 'add') {
        addCalls++
        // la richiesta ERA partita: il collegamento riesce sul server
        state.active = true
        throw new Error(CLOSED)
      }
      if (entry?.action === 'list') {
        if (!state.active) return JSON.stringify({ data: { results: { gmail: { toolkit: 'gmail', status: 'initiated', accounts: [] } } } })
        return realListMany('gmail', [{ id: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', is_default: true }])
      }
      return JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'a1', status: 'ACTIVE' }] }] })
    })
    const r = await manager.connectApp('gmail', { name: 'Gmail' })
    expect(r).toEqual({ ok: true, already: true })
    // l\'add è partito UNA sola volta: la richiesta può essere già avvenuta
    expect(addCalls).toBe(1)
    expect(fake.calls.filter((c) => (c.args.toolkits as Array<{ action?: string }>)?.[0]?.action === 'add')).toHaveLength(1)
    expect(reopens).toHaveLength(1)
    expect(opened).toHaveLength(0)
  })

  it('il remove NON si ripete: cade → list decide (l\'account non c\'è più → ok)', async () => {
    let removeCalls = 0
    const state = { ids: ['a1', 'a2'] }
    const { manager, settings } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string; account_id?: string }> | undefined)?.[0]
      if (entry?.action === 'remove') {
        removeCalls++
        // la richiesta ERA partita: l'account non c'è più anche se la risposta è caduta
        state.ids = state.ids.filter((x) => x !== entry.account_id)
        if (removeCalls === 1) throw new Error(CLOSED)
        return JSON.stringify({ toolkits: [{ toolkit: 'gmail', status: 'removed' }] })
      }
      if (entry?.action === 'list') {
        return realListMany('gmail', state.ids.map((id, i) => ({ id, alias: i === 0 ? 'lavoro' : 'personale' })))
      }
      return addResult('gmail')
    })
    settings.set('composioGateway.apps', structuredClone(twoAccountGmail))
    const r = await manager.removeAccount('gmail', 'a2')
    expect(r.ok).toBe(true)
    // il remove è partito UNA volta sola; il list dice che a2 non c\'è più
    expect(removeCalls).toBe(1)
    expect(manager.status().connected.find((a) => a.slug === 'gmail')?.accounts).toHaveLength(1)
  })

  it('la WAIT cade una volta → riconnessione e ripetizione: il collegamento finisce comunque attivo', async () => {
    let waitCalls = 0
    const state = { active: false }
    const { manager, reopens } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]
      if (tool.includes('WAIT_FOR_CONNECTIONS')) {
        waitCalls++
        if (waitCalls === 1) throw new Error(CLOSED)
        state.active = true
        return JSON.stringify({ toolkits: [{ toolkit: 'gmail', accounts: [{ id: 'a1', status: 'ACTIVE' }] }] })
      }
      if (entry?.action === 'list') {
        if (!state.active) return JSON.stringify({ data: { results: { gmail: { toolkit: 'gmail', status: 'initiated', accounts: [] } } } })
        return realListMany('gmail', [{ id: 'a1', email: 'fabio@azienda.test', is_default: true }])
      }
      return addResult('gmail')
    })
    await manager.connectApp('gmail', { name: 'Gmail' })
    await vi.waitFor(() => {
      expect(manager.status().connected.find((a) => a.slug === 'gmail')?.status).toBe('ACTIVE')
    })
    expect(waitCalls).toBeGreaterThanOrEqual(2)
    expect(reopens.length).toBeGreaterThanOrEqual(1)
  })

  it('V12 aggiornata: la WAIT che cade SEMPRE non è un fallimento definitivo — decide il list', async () => {
    const { manager } = makeManager((tool, args) => {
      const entry = (args.toolkits as Array<{ action?: string }> | undefined)?.[0]
      if (tool.includes('WAIT_FOR_CONNECTIONS')) throw new Error(CLOSED)
      if (entry?.action === 'list') return realListMany('gmail', [{ id: 'a1', email: 'fabio@azienda.test', is_default: true }])
      return addResult('gmail')
    })
    await manager.connectApp('gmail', { name: 'Gmail' })
    await vi.waitFor(() => {
      expect(manager.status().connected.find((a) => a.slug === 'gmail')?.status).toBe('ACTIVE')
      expect(manager.status().pending).toBeNull()
    })
  })
})
