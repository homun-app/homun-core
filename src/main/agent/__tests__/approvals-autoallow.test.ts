// A2 (fase approvazioni-chiare): il gate dice PER COSA ha fatto passare una
// chiamata — il verdetto allow porta grantId (la standing grant che ha
// coperto) o ruleTool (la regola dell'utente), così il loop scrive la riga
// leggera nell'indice tool_use (allowed_by: grant <id> | rule <tool>). Le
// letture innocue sempre consentite NON lo portano. E la REVOCA di una
// grant fa tornare il gate a chiedere (il registro la elenca con Revoca).
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../../test-tmp'

const state = {
  sandboxMode: 'host' as 'host' | 'docker',
  rules: [] as Array<{ tool: string; pattern: string; mode: 'always_allow' | 'needs_approval' | 'blocked' }>,
  grants: [] as Array<{ tool: string; target: string; scope?: 'readOnly' | null; expiresAt?: number | null; agentId?: string | null }>,
  agents: [] as Array<{ id: string; parentId: string | null }>
}

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-autoallow-a2-'))
const BOX = join(TMP, 'box')

vi.mock('../../store/db', () => ({
  getPermissions: () => ({ default: 'needs_approval' as const, rules: state.rules }),
  listGrants: () => state.grants.map((g, i) => ({ id: i + 1, tool: g.tool, target: g.target, createdAt: 0, scope: g.scope ?? null, expiresAt: g.expiresAt ?? null, agentId: g.agentId ?? null })),
  addGrant: (tool: string, target: string, scope?: 'readOnly', expiresAt?: number, agentId?: string | null) => { state.grants.push({ tool, target, scope, expiresAt, agentId: agentId ?? null }) },
  removeGrant: (id: number) => { state.grants.splice(id - 1, 1) },
  getRoutine: () => null,
  getAgent: (id: string) => state.agents.find((a) => a.id === id) ?? null,
  getSetting: (_key: string, fallback: unknown) => fallback
}))

vi.mock('../../sandbox', () => ({
  workspaceNameForPrompt: () => '/workspace',
  sandboxMode: () => state.sandboxMode,
  boxRoot: () => BOX,
  boxDir: (agentId: string) => join(BOX, 'home', agentId),
  boxShellEgressOf: () => 'none' as const
}))

const { check } = await import('../permissions')

beforeAll(() => mkdirSync(BOX, { recursive: true }))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
beforeEach(() => {
  state.rules = []
  state.grants = []
  state.agents = []
})

describe('A2: il verdetto allow dice PER COSA (grant id o regola)', () => {
  it('la standing grant copre la chiamata → via grant con grantId', async () => {
    state.grants.push({ tool: 'write-file', target: '/tmp/report.md' })
    const v = await check('write-file', { path: '/tmp/report.md' }, 'a-bot')
    expect(v).toMatchObject({ kind: 'allow', via: 'grant', grantId: 1 })
  })

  it('la regola specifica dell\'utente → via rule con ruleTool', async () => {
    state.rules.push({ tool: 'write-file', pattern: '/tmp/', mode: 'always_allow' })
    const v = await check('write-file', { path: '/tmp/report.md' }, 'a-bot')
    expect(v).toMatchObject({ kind: 'allow', via: 'rule', ruleTool: 'write-file' })
  })

  it('il default sempre-consenti → via rule con ruleTool *', async () => {
    state.rules.push({ tool: '*', pattern: '*', mode: 'always_allow' })
    const v = await check('write-file', { path: '/tmp/report.md' }, 'a-bot')
    expect(v).toMatchObject({ kind: 'allow', via: 'rule', ruleTool: '*' })
  })

  it('le letture innocue sempre consentite NON portano né grantId né ruleTool', async () => {
    for (const tool of ['recall_memory', 'search_history', 'read_history', 'skill', 'update_self', 'search_connectors']) {
      const v = await check(tool, {}, 'a-bot')
      expect(v, tool).toMatchObject({ kind: 'allow' })
      expect((v as { grantId?: number }).grantId, tool).toBeUndefined()
      expect((v as { ruleTool?: string }).ruleTool, tool).toBeUndefined()
    }
  })

  it('il verdetto grant di un tool MCP porta il grantId (e la regola il suo tool)', async () => {
    state.grants.push({ tool: 'mcp__ufficio__get_calendario', target: '*' })
    const v = await check('mcp__ufficio__get_calendario', {}, 'a-bot')
    expect(v).toMatchObject({ kind: 'allow', via: 'grant', grantId: 1 })
    state.rules.push({ tool: 'mcp__ufficio__get_calendario', pattern: '*', mode: 'always_allow' })
    state.grants = []
    const v2 = await check('mcp__ufficio__get_calendario', {}, 'a-bot')
    expect(v2).toMatchObject({ kind: 'allow', via: 'rule', ruleTool: 'mcp__ufficio__get_calendario' })
  })

  it('la grant di run-command copre la chiave del comando → via grant con grantId', async () => {
    state.grants.push({ tool: 'run-command', target: 'ls' })
    const v = await check('run-command', { command: 'ls -la' }, 'a-bot')
    expect(v).toMatchObject({ kind: 'allow', via: 'grant' })
    expect((v as { grantId?: number }).grantId).toBe(1)
  })
})

describe('A2: Revoca → il gate chiede di nuovo', () => {
  it('revocata la grant, la STESSA chiamata torna a chiedere', async () => {
    state.grants.push({ tool: 'write-file', target: '/tmp/report.md' })
    expect(await check('write-file', { path: '/tmp/report.md' }, 'a-bot')).toMatchObject({ kind: 'allow' })
    // Revoca: grants:revoke rimuove la riga (qui il mock dello store)
    state.grants = []
    expect(await check('write-file', { path: '/tmp/report.md' }, 'a-bot')).toMatchObject({ kind: 'ask' })
  })

  it('revocata la grant delle LETTURE di un server, la lettura torna a chiedere', async () => {
    const { setMcpAnnotationsLookup } = await import('../permissions')
    setMcpAnnotationsLookup((tool) => tool.startsWith('mcp__ufficio__')
      ? { annotations: { readOnlyHint: true, destructiveHint: false }, catalogServer: false, serverName: 'Ufficio' }
      : undefined)
    state.grants.push({ tool: 'mcp__ufficio__*', target: '*', scope: 'readOnly' })
    expect(await check('mcp__ufficio__get_calendario', {}, 'a-bot')).toMatchObject({ kind: 'allow' })
    state.grants = []
    expect(await check('mcp__ufficio__get_calendario', {}, 'a-bot')).toMatchObject({ kind: 'ask' })
    setMcpAnnotationsLookup(() => undefined)
  })
})
