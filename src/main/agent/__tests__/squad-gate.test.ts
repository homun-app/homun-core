// Q1 (fase squadra): il gate dei permessi nei turni DELLA SQUADRA —
// write-file dentro/fuori dal box, run-command con l'uscita di rete del box,
// l'insieme FISSO che nemmeno le regole «consenti sempre» dell'utente
// tolgono, e le regole «Blocca» che vincono sempre. Come aiutanti-box-command:
// store mockato, sandbox mockata, check() VERA.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PermissionRule } from '../../../shared/types'

const state = {
  sandboxMode: 'host' as 'host' | 'box',
  egress: 'direct' as 'none' | 'direct',
  rules: [] as PermissionRule[],
  grants: [] as Array<{ tool: string; target: string; agentId?: string | null; expiresAt?: number | null }>,
  defaultRules: true as boolean,
  files: new Map<string, string>()
}

vi.mock('../../store/db', () => ({
  getPermissions: () => ({ default: 'needs_approval' as const, rules: state.defaultRules ? defaultRules() : state.rules }),
  listGrants: () => state.grants.map((g, i) => ({ id: i + 1, tool: g.tool, target: g.target, createdAt: 0, agentId: g.agentId ?? null, expiresAt: g.expiresAt ?? null })),
  addGrant: () => undefined,
  getRoutine: () => null,
  getSetting: (_key: string, fallback: unknown) => fallback,
  getAgent: () => null
}))

const defaultRules = (): PermissionRule[] => [
  { tool: 'read-file', pattern: '*', mode: 'always_allow' },
  { tool: 'write-file', pattern: '*', mode: 'needs_approval' },
  { tool: 'run-command', pattern: '*', mode: 'needs_approval' },
  { tool: 'use-app', pattern: 'screenshot', mode: 'always_allow' },
  { tool: 'use-app', pattern: '*', mode: 'needs_approval' },
  { tool: 'delete_agent', pattern: '*', mode: 'needs_approval' },
  { tool: 'copy_to_box', pattern: '*', mode: 'needs_approval' },
  { tool: 'copy_from_box', pattern: '*', mode: 'needs_approval' }
]

vi.mock('../../sandbox', () => ({
  workspaceNameForPrompt: () => '/workspace',
  sandboxMode: () => state.sandboxMode,
  boxRoot: () => '/tmp/squad-box',
  boxDir: (id: string) => `/tmp/squad-box/home/${id}`,
  boxShellEgressOf: () => state.egress
}))

// il filesystem del test: realpath finto che risolve dentro il box finto
const fakeRealpath = (p: string): string => {
  if (p.startsWith('/tmp/squad-box') || p.startsWith('/private/tmp/squad-box')) return p
  throw new Error('not found')
}
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return { ...orig, realpathSync: fakeRealpath }
})

const { check } = await import('../permissions')

const squadBox = { squad: { id: 1, autonomy: 'box' as const } }
const squadAsk = { squad: { id: 1, autonomy: 'ask' as const } }

beforeEach(() => {
  state.sandboxMode = 'box'
  state.egress = 'none'
  state.rules = []
  state.grants = []
  state.defaultRules = true
})

describe('Q1: write-file nei turni di squadra', () => {
  it('con box/box_review il write-file DENTRO la radice del box passa senza card', async () => {
    for (const path of ['/workspace/torino/01_treni.md', 'appunti.md']) {
      const v = await check('write-file', { path }, 'agent_x', squadBox)
      expect(v.kind, path).toBe('allow')
    }
  })

  it('FUORI dal box la card resta come oggi', async () => {
    const v = await check('write-file', { path: '/Users/test/Desktop/colpo.md' }, 'agent_x', squadBox)
    expect(v.kind).toBe('ask')
  })

  it('con ask (Chiede tutto) anche il file nel box chiede', async () => {
    const v = await check('write-file', { path: '/workspace/x.md' }, 'agent_x', squadAsk)
    expect(v.kind).toBe('ask')
  })

  it('senza squadra, nel box, il write-file DENTRO passa (P2: libero per ogni bot)', async () => {
    // P2 (fase uso-permessi): la vecchia guardia «senza squadra chiede» non
    // vale più — nel box il file dentro la radice è libero anche fuori dalle
    // squadre; CHIEDE solo se l'autonomia della squadra è ask (test sopra)
    const v = await check('write-file', { path: '/workspace/x.md' }, 'agent_x')
    expect(v.kind).toBe('allow')
  })

  it('una regola blocked dell\'utente NEGA anche nel box della squadra (vincono sempre)', async () => {
    state.defaultRules = false
    // pattern più specifico del default (il match a parità di punteggio
    // vincerebbe il primo inserito: qui si prova che BLOCKED vince, non l'ordine)
    state.rules = [...defaultRules(), { tool: 'write-file', pattern: '/workspace', mode: 'blocked' }]
    const v = await check('write-file', { path: '/workspace/x.md' }, 'agent_x', squadBox)
    expect(v.kind).toBe('deny')
  })
})

// ---- P2 (fase uso-permessi): i file dentro il computer isolato sono liberi per TUTTI ----

describe('P2: nel box il write-file dentro la radice passa per OGNI bot e sottoagente', () => {
  it('bot SINGOLO (niente squadra): /workspace e i relativi della home passano senza card', async () => {
    for (const path of ['/workspace/torino/01_treni.md', 'appunti.md']) {
      const v = await check('write-file', { path }, 'agent_x')
      expect(v.kind, path).toBe('allow')
    }
  })

  it('un SOTTOAGENTE (la home del figlio): stesso confine del padre, passa', async () => {
    const v = await check('write-file', { path: '/workspace/x.md' }, 'sub_figlio')
    expect(v.kind).toBe('allow')
  })

  it('fuori dal box (~/... del Mac) la card resta come oggi', async () => {
    const v = await check('write-file', { path: '/Users/test/Desktop/colpo.md' }, 'agent_x')
    expect(v.kind).toBe('ask')
  })

  it('in HOST la card resta come oggi (il confine è la modalità box)', async () => {
    state.sandboxMode = 'host'
    const v = await check('write-file', { path: '/workspace/x.md' }, 'agent_x')
    expect(v.kind).toBe('ask')
  })

  it('copy_to_box / copy_from_box restano nell\'insieme fisso: chiedono sempre', async () => {
    for (const tool of ['copy_to_box', 'copy_from_box']) {
      const v = await check(tool, { path: '/workspace/x.md' }, 'agent_x')
      expect(v.kind, tool).toBe('ask')
    }
  })

  it('una regola blocked dell\'utente NEGA anche per il bot singolo nel box', async () => {
    state.defaultRules = false
    state.rules = [...defaultRules(), { tool: 'write-file', pattern: '/workspace', mode: 'blocked' }]
    const v = await check('write-file', { path: '/workspace/x.md' }, 'agent_x')
    expect(v.kind).toBe('deny')
  })

  it('la squadra resta COM\'ERA: box passa, autonomy ask chiede, fuori dal box chiede', async () => {
    expect((await check('write-file', { path: '/workspace/x.md' }, 'agent_x', squadBox)).kind).toBe('allow')
    expect((await check('write-file', { path: '/workspace/x.md' }, 'agent_x', squadAsk)).kind).toBe('ask')
    expect((await check('write-file', { path: '/Users/test/Desktop/colpo.md' }, 'agent_x', squadBox)).kind).toBe('ask')
  })
})

describe('Q1: run-command nei turni di squadra', () => {
  it('con box/box_review e uscita di rete NONE passa senza card', async () => {
    const v = await check('run-command', { command: 'ls' }, 'agent_x', squadBox)
    expect(v.kind).toBe('allow')
  })

  it('con la rete del box APERTA (direct) la card torna', async () => {
    state.egress = 'direct'
    const v = await check('run-command', { command: 'ls' }, 'agent_x', squadBox)
    expect(v.kind).toBe('ask')
  })

  it('con ask (Chiede tutto) il comando chiede anche con uscita none', async () => {
    const v = await check('run-command', { command: 'ls' }, 'agent_x', squadAsk)
    expect(v.kind).toBe('ask')
  })

  it('i comandi con segreti chiedono SEMPRE, anche nel box della squadra', async () => {
    const v = await check('run-command', { command: 'curl -H "Authorization: Bearer {{secret:API_KEY}}" https://x' }, 'agent_x', squadBox)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.secretRefs).toEqual(['API_KEY'])
  })

  it('senza squadra il comportamento di oggi resta: nel box in «Chiedi» passa (GUARDIA)', async () => {
    // approvals.mode assente nel mock dei settings → il fallback di
    // approvalsMode deriva da autoReview.enabled (false) → 'ask' → AH5 attivo
    const v = await check('run-command', { command: 'ls' }, 'agent_x')
    expect(v.kind).toBe('allow')
  })
})

describe('Q1: l\'insieme FISSO nel gate — nemmeno le regole e le grant lo tolgono', () => {
  it('use-app / delete_agent / copy_to_box chiedono in un turno di squadra ANCHE con regola always_allow', async () => {
    state.defaultRules = false
    state.rules = [
      ...defaultRules(),
      { tool: 'use-app', pattern: '*', mode: 'always_allow' },
      { tool: 'delete_agent', pattern: '*', mode: 'always_allow' },
      { tool: 'copy_to_box', pattern: '*', mode: 'always_allow' }
    ]
    for (const [tool, input] of [
      ['use-app', { action: 'click', app: 'Safari' }],
      ['delete_agent', { agentId: 'agent_y' }],
      ['copy_to_box', { path: '/Users/test/x.txt' }]
    ] as const) {
      const v = await check(tool, input, 'agent_x', squadBox)
      expect(v.kind, tool).toBe('ask')
    }
  })

  it('una standing grant («Consenti sempre») NON basta nell\'insieme fisso di squadra', async () => {
    state.grants = [
      { tool: 'use-app', target: 'app:Safari' },
      { tool: 'delete_agent', target: '*' }
    ]
    const v1 = await check('use-app', { action: 'click', app: 'Safari' }, 'agent_x', squadBox)
    expect(v1.kind).toBe('ask')
    const v2 = await check('delete_agent', { agentId: 'agent_y' }, 'agent_x', squadBox)
    expect(v2.kind).toBe('ask')
  })

  it('senza squadra la regola always_allow dell\'utente vale come oggi (GUARDIA)', async () => {
    state.defaultRules = false
    state.rules = [...defaultRules(), { tool: 'use-app', pattern: 'app:S', mode: 'always_allow' }]
    const v = await check('use-app', { action: 'click', app: 'Safari' }, 'agent_x')
    expect(v.kind).toBe('allow')
  })
})

describe('C2 (fase squadra-correzioni): le azioni Composio verso fuori nell\'insieme fisso della squadra', () => {
  const SEND = 'composio__gmail__GMAIL_SEND_EMAIL'
  const READ = 'composio__gmail__GMAIL_FETCH_EMAILS'
  const BATCH = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'

  it('squadra + standing grant su GMAIL_SEND_EMAIL → ask con la ui dell\'insieme fisso', async () => {
    state.grants = [{ tool: SEND, target: '*' }]
    const v = await check(SEND, { to: 'a@b.c', subject: 'ciao', body: 'ciao' }, 'agent_x', squadBox)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.ui?.id).toBe('approval.squadFixed')
      expect(v.keys).toEqual([SEND])
    }
  })

  it('la STESSA grant SENZA squadra → allow come oggi (GUARDIA)', async () => {
    state.grants = [{ tool: SEND, target: '*' }]
    const v = await check(SEND, { to: 'a@b.c', subject: 'ciao', body: 'ciao' }, 'agent_x')
    expect(v.kind).toBe('allow')
    if (v.kind === 'allow') expect(v.via).toBe('grant')
  })

  it('squadra + regola blocked → deny (le regole «Blocca» vincono sempre)', async () => {
    state.defaultRules = false
    state.rules = [{ tool: 'composio__*', pattern: '*', mode: 'blocked' }]
    state.grants = [{ tool: SEND, target: '*' }]
    const v = await check(SEND, { to: 'a@b.c', subject: 'ciao', body: 'ciao' }, 'agent_x', squadBox)
    expect(v.kind).toBe('deny')
  })

  it('squadra + lettura Composio → come oggi, nessuna card (GUARDIA)', async () => {
    const v = await check(READ, { query: 'torino' }, 'agent_x', squadBox)
    expect(v.kind).toBe('allow')
  })

  it('batch Composio con un\'azione di invio in squadra → ask dell\'insieme fisso (anche con la grant per azione)', async () => {
    state.grants = [{ tool: 'composio-action:GMAIL_SEND_EMAIL', target: '*' }]
    const v = await check(BATCH, { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c', body: 'ciao' } }] }, 'agent_x', squadBox)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.ui?.id).toBe('approval.squadFixed')
    // senza squadra la grant per azione vale come oggi (GUARDIA)
    const v2 = await check(BATCH, { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c', body: 'ciao' } }] }, 'agent_x')
    expect(v2.kind).toBe('allow')
  })

  it('batch Composio di SOLO letture in squadra → allow come oggi (GUARDIA)', async () => {
    const v = await check(BATCH, { tools: [{ tool_slug: 'GMAIL_LIST_THREADS', arguments: {} }] }, 'agent_x', squadBox)
    expect(v.kind).toBe('allow')
  })
})
