// B4 (fase beta.4): il bot sa quali app ha collegate. Una riga nel prompt di
// ogni turno, nella PARTE CHE CAMBIA (mai nel prefisso in cache): le app
// collegate tramite Composio (stato locale di composio-gateway) e i server
// MCP attivi del bot, con l'ordine dei nomi, il tetto di 20 e poi «and N
// more». E search_connectors su un'app già collegata risponde subito
// «già collegata tramite Composio», senza proporne un'altra.
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { connectedAppsLine, connectedAppMatch, CONNECTED_APPS_MAX_NAMES } = await import('../connected-apps')
const { systemPrompt } = await import('../prompts')

let root: string
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sandbot-connapps-test-'))
  const { setDataDir, dataDir } = await import('../../store/db')
  setDataDir(root)
  dataDir()
  const { openMemoryEngine } = await import('../../memory/engine')
  const st = await openMemoryEngine({ dataDir: root })
  if (!st.available) throw new Error('motore Engramma non disponibile nei test: ' + st.error)
})
afterAll(async () => {
  const { closeMemoryEngine } = await import('../../memory/engine')
  await closeMemoryEngine()
  rmSync(root, { recursive: true, force: true })
})

describe('B4: connectedAppsLine — la riga del prompt (pura)', () => {
  it('con le app collegate c\'è, con la guida Composio e i server MCP', () => {
    const line = connectedAppsLine({ composioApps: [{ name: 'Trello', accounts: [] }, { name: 'Gmail', accounts: [] }], mcpServers: ['Notion'] })
    expect(line).toContain('Connected apps (via Composio: COMPOSIO_SEARCH_TOOLS to find the action, then COMPOSIO_MULTI_EXECUTE_TOOL): Trello; Gmail')
    expect(line).toContain('MCP servers: Notion')
    expect(line).toMatch(/use these tools|use THESE tools/i)
    expect(line).toMatch(/not history, memory, the browser or a new connector/)
  })

  it('SENZA app e SENZA server la riga NON c\'è (stringa vuota)', () => {
    expect(connectedAppsLine({ composioApps: [], mcpServers: [] })).toBe('')
  })

  it('l\'ordine dei nomi resta quello dato; massimo 20, poi «and N more»', () => {
    expect(CONNECTED_APPS_MAX_NAMES).toBe(20)
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `App${i}`, accounts: [] as Array<{ alias?: string; email?: string }> }))
    const line = connectedAppsLine({ composioApps: many, mcpServers: [] })
    expect(line).toContain('App0; App1')
    expect(line).toMatch(/App19, and 5 more/)
    expect(line).not.toContain('App20')
    // i server MCP contano nello stesso tetto
    const line2 = connectedAppsLine({ composioApps: many.slice(0, 10), mcpServers: many.slice(10).map((a) => a.name) })
    expect(line2).toMatch(/and 5 more/)
  })

  it('la riga NON sta nel prefisso in cache: systemPrompt non la contiene', () => {
    const agent = { id: 'a', name: 'Bot', description: '', providerId: 'p', model: 'm', status: 'idle' as const, unread: 0, createdAt: 1 }
    const p = systemPrompt(agent, { subagents: true })
    expect(p).not.toContain('Connected apps')
    // e nessuna sezione del prompt base la introduce
    expect(p).not.toMatch(/# Connected apps/)
  })
})

describe('B4: connectedAppMatch — query che nomina un\'app già collegata (pura)', () => {
  const CONNECTED = [
    { slug: 'trello', name: 'Trello' },
    { slug: 'gmail', name: 'Gmail' }
  ]

  it('il nome o lo slug, maiuscole irrilevanti', () => {
    expect(connectedAppMatch('trello', CONNECTED)?.slug).toBe('trello')
    expect(connectedAppMatch('Trello', CONNECTED)?.slug).toBe('trello')
    expect(connectedAppMatch('GMAIL', CONNECTED)?.slug).toBe('gmail')
    expect(connectedAppMatch('slack', CONNECTED)).toBeNull()
  })

  it('il nome dentro la query («le board di trello»)', () => {
    expect(connectedAppMatch('le mie board di trello', CONNECTED)?.slug).toBe('trello')
  })
})

describe('BC4: connectedAppMatch confronta su PAROLE INTERE (confine Unicode, maiuscole irrilevanti)', () => {
  it('«dropbox» con «Box» collegata → null: box è DENTRO la parola, non una parola a sé', () => {
    const box = [{ slug: 'box', name: 'Box' }]
    expect(connectedAppMatch('dropbox', box)).toBeNull()
    expect(connectedAppMatch('mandalo su dropbox per favore', box)).toBeNull()
    expect(connectedAppMatch('inbox', box)).toBeNull()
    // «Box» come parola intera resta trovato
    expect(connectedAppMatch('mettilo su Box', box)?.slug).toBe('box')
    expect(connectedAppMatch('BOX', box)?.slug).toBe('box')
  })

  it('«le board di trello» → Trello (il nome è una parola della query)', () => {
    const trello = [{ slug: 'trello', name: 'Trello' }]
    expect(connectedAppMatch('le board di trello', trello)?.slug).toBe('trello')
    expect(connectedAppMatch('trello!', trello)?.slug).toBe('trello')
    expect(connectedAppMatch('TRELLO?', trello)?.slug).toBe('trello')
  })

  it('«google calendar» con «Google Calendar» collegata → sì (nome multi-parola intero)', () => {
    const gcal = [{ slug: 'google-calendar', name: 'Google Calendar' }]
    expect(connectedAppMatch('google calendar', gcal)?.slug).toBe('google-calendar')
    expect(connectedAppMatch('sincronizza Google Calendar domani', gcal)?.slug).toBe('google-calendar')
    // una PARTE del nome non basta: «calendar» da solo non nomina «Google Calendar»
    expect(connectedAppMatch('calendar', gcal)).toBeNull()
    expect(connectedAppMatch('il mio calendar appuntamento', gcal)).toBeNull()
  })

  it('i confini sono UNICODE: le lettere accentate contano come parte della parola', () => {
    const apps = [{ slug: 'cafe', name: 'Café' }]
    // «café» dentro «récafé»: la é accentata è una lettera → NON è una parola a sé
    expect(connectedAppMatch('récafé', apps)).toBeNull()
    expect(connectedAppMatch('voglio Café', apps)?.slug).toBe('cafe')
  })
})

// ---- B4: l'integrazione (gateway FINTO, niente rete) ----

const { setActiveComposioGateway } = await import('../../connectors/composio-gateway')
const { executeTool } = await import('../tools')

const fakeGateway = (apps: Array<{ slug: string; name: string; accounts?: Array<{ accountId: string; alias?: string; email?: string; status: string }> }>) =>
  ({
    status: () => ({
      active: true,
      connected: apps.map((a) => ({
        ...a,
        status: 'ACTIVE',
        accountId: a.accounts?.[0]?.accountId ?? 'acct',
        ...(a.accounts ? { accounts: a.accounts } : {})
      })),
      pending: null
    })
  }) as unknown as import('../../connectors/composio-gateway').ComposioGatewayManager

describe('B4: search_connectors su un\'app già collegata', () => {
  it('risponde subito «già collegata tramite Composio», senza proporne un\'altra', async () => {
    setActiveComposioGateway(fakeGateway([{ slug: 'trello', name: 'Trello' }]))
    try {
      const { output, meta } = await executeTool('agent_x', 'search_connectors', { query: 'trello' })
      expect(output).toContain('already connected via Composio')
      expect(output).toContain('COMPOSIO_SEARCH_TOOLS')
      expect(meta).toEqual({ connectedApp: 'trello' })
    } finally {
      setActiveComposioGateway(null)
    }
  })

  it('CA3: la query GENERICA («email») comincia con l\'elenco di ciò che è già collegato', async () => {
    setActiveComposioGateway(fakeGateway([
      { slug: 'gmail', name: 'Gmail', accounts: [{ accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', status: 'ACTIVE' }, { accountId: 'a2', alias: 'personale', email: 'fabio@gmail.test', status: 'ACTIVE' }] },
      { slug: 'trello', name: 'Trello', accounts: [{ accountId: 't1', status: 'ACTIVE' }] }
    ]))
    try {
      const { output } = await executeTool('agent_x', 'search_connectors', { query: 'email' })
      // il risultato COMINCIA con l'elenco di ciò che c'è già (prima delle
      // righe dei connettori da installare)
      expect(output.startsWith('Already connected via Composio: Gmail (lavoro: fabio@azienda.test, personale: fabio@gmail.test), Trello.')).toBe(true)
      expect(output).toContain('the results below are apps NOT connected yet')
    } finally {
      setActiveComposioGateway(null)
    }
  })

  it('CA3: la query che NOMINA l\'app collegata dice anche QUALI account', async () => {
    setActiveComposioGateway(fakeGateway([
      { slug: 'gmail', name: 'Gmail', accounts: [{ accountId: 'a1', alias: 'lavoro', email: 'fabio@azienda.test', status: 'ACTIVE' }, { accountId: 'a2', alias: 'personale', email: 'fabio@gmail.test', status: 'ACTIVE' }] }
    ]))
    try {
      const { output, meta } = await executeTool('agent_x', 'search_connectors', { query: 'gmail' })
      expect(output).toContain('"Gmail" is already connected via Composio (accounts: lavoro (fabio@azienda.test), personale (fabio@gmail.test)):')
      expect(meta).toEqual({ connectedApp: 'gmail' })
    } finally {
      setActiveComposioGateway(null)
    }
  })

  it('senza il gateway collegato la ricerca procede come oggi (nessun esito finto)', async () => {
    setActiveComposioGateway(null)
    // nessun gateway → nessuna risposta «già collegata»: il result è quello
    // del runner vero (qui: la query corta si rifiuta, come sempre)
    const { output } = await executeTool('agent_x', 'search_connectors', { query: 'x' })
    expect(output).not.toContain('already connected')
  })
})

// ---- CA3 (fase composio-account): il bot sa quali account ha, e quale usare ----

const { alreadyConnectedPrefix } = await import('../connected-apps')
const { missingAccountOfItems } = await import('../../connectors/tool-batch')

const ACC = (alias?: string, email?: string) => ({ ...(alias ? { alias } : {}), ...(email ? { email } : {}) })

describe('CA3: connectedAppsLine — la riga porta gli ACCOUNT', () => {
  it('un SOLO account: l\'email accanto al nome («quale casella ho collegato?» ha risposta)', () => {
    const line = connectedAppsLine({ composioApps: [{ name: 'Gmail', accounts: [ACC(undefined, 'fabio@gmail.test')] }], mcpServers: [] })
    expect(line).toContain('Gmail — fabio@gmail.test')
    expect(line).not.toContain('accounts:')
  })

  it('PIÙ account: l\'elenco alias (email) e la regola `account` esplicita', () => {
    const line = connectedAppsLine({
      composioApps: [{ name: 'Gmail', accounts: [ACC('lavoro', 'fabio@azienda.test'), ACC('personale', 'fabio@gmail.test')] }],
      mcpServers: []
    })
    expect(line).toContain('Gmail — accounts: lavoro (fabio@azienda.test), personale (fabio@gmail.test)')
    expect(line).toContain('pass `account` in every MULTI_EXECUTE item for Gmail')
  })

  it('la guida Composio e i server MCP restano; 0 account → solo il nome', () => {
    const line = connectedAppsLine({
      composioApps: [{ name: 'Trello', accounts: [] }, { name: 'Gmail', accounts: [ACC('lavoro', 'f@azienda.test')] }],
      mcpServers: ['Notion']
    })
    expect(line).toContain('Connected apps (via Composio: COMPOSIO_SEARCH_TOOLS to find the action, then COMPOSIO_MULTI_EXECUTE_TOOL):')
    expect(line).toContain('Trello; Gmail — lavoro (f@azienda.test)')
    expect(line).toContain('MCP servers: Notion')
    expect(line).toMatch(/not history, memory, the browser or a new connector/)
  })

  it('più di 3 account per app: i primi 3 più «and N more»', () => {
    const line = connectedAppsLine({
      composioApps: [{ name: 'Gmail', accounts: [ACC('a'), ACC('b'), ACC('c'), ACC('d')] }],
      mcpServers: []
    })
    expect(line).toContain('accounts: a, b, c, and 1 more')
    expect(line).not.toContain('(d)')
  })

  it('il tetto di 20 nomi resta: conta le APP', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `App${i}`, accounts: [] }))
    const line = connectedAppsLine({ composioApps: many, mcpServers: [] })
    expect(line).toContain('App0')
    expect(line).toMatch(/App19, and 5 more/)
    expect(line).not.toContain('App20')
  })
})

describe('CA3: alreadyConnectedPrefix — search_connectors dice prima cosa c\'è GIÀ', () => {
  it('comincia con «Already connected via Composio: …» con gli account per app', () => {
    const prefix = alreadyConnectedPrefix([
      { slug: 'gmail', name: 'Gmail', accounts: [ACC('lavoro', 'fabio@azienda.test'), ACC('personale', 'fabio@gmail.test')] },
      { slug: 'trello', name: 'Trello', accounts: [ACC(undefined, 'fabio@trello.test')] }
    ])
    expect(prefix).toMatch(/^Already connected via Composio: /)
    expect(prefix).toContain('Gmail (lavoro: fabio@azienda.test, personale: fabio@gmail.test)')
    expect(prefix).toContain('Trello (fabio@trello.test)')
    expect(prefix).toContain('Use those for their data; the results below are apps NOT connected yet.')
  })

  it('senza email vale l\'alias; senza né alias né email resta il solo nome', () => {
    const prefix = alreadyConnectedPrefix([
      { slug: 'slack', name: 'Slack', accounts: [ACC('lavoro')] },
      { slug: 'box', name: 'Box', accounts: [{}] }
    ])
    expect(prefix).toContain('Slack (lavoro)')
    // senza né alias né email resta il SOLO nome (niente parentesi vuote)
    expect(prefix).toContain('Box')
    expect(prefix).not.toContain('Box (')
  })
})

describe('CA3: missingAccountOfItems — il blocco MULTI_EXECUTE senza `account`', () => {
  const accountsOf = (toolkit: string) =>
    toolkit === 'gmail'
      ? [{ accountId: 'a1', alias: 'lavoro' }, { accountId: 'a2', alias: 'personale' }]
      : toolkit === 'trello'
        ? [{ accountId: 't1' }]
        : []

  it('toolkit con PIÙ account attivi e voce senza `account`: il testo per il modello', () => {
    const refusal = missingAccountOfItems(
      [{ slug: 'GMAIL_SEND_EMAIL', arguments: {} }],
      ['gmail'],
      accountsOf
    )
    expect(refusal).toBe('Gmail has 2 accounts: lavoro, personale. Pass `account` with the one the user means; if unclear, ask them with ask_user.')
  })

  it('la voce CON `account` passa; un solo account non chiede nulla', () => {
    expect(missingAccountOfItems([{ slug: 'GMAIL_SEND_EMAIL', arguments: {}, account: 'lavoro' }], ['gmail'], accountsOf)).toBeNull()
    expect(missingAccountOfItems([{ slug: 'TRELLO_GET_BOARDS', arguments: {} }], ['gmail', 'trello'], accountsOf)).toBeNull()
  })

  it('più toolkit carenti: una frase per ciascuno', () => {
    const refusal = missingAccountOfItems(
      [{ slug: 'GMAIL_SEND_EMAIL', arguments: {} }, { slug: 'SLACK_POST_MESSAGE', arguments: {} }],
      ['gmail', 'slack'],
      (tk) => (tk === 'gmail' ? [{ accountId: 'a1', alias: 'lavoro' }, { accountId: 'a2', alias: 'personale' }] : tk === 'slack' ? [{ accountId: 's1', alias: 'ufficio' }, { accountId: 's2' }] : [])
    )
    expect(refusal).toContain('Gmail has 2 accounts: lavoro, personale.')
    expect(refusal).toContain('Slack has 2 accounts: ufficio, account 2.')
  })
})
