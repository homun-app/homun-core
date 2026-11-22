// A4 (fase approvazioni-chiare) punto 5 — il GATE: gli strumenti
// dell'insieme fisso (invii, pagamenti) chiedono ANCHE fuori dalle squadre
// quando la regola è always_allow: la regola «Consenti sempre» non può
// togliere l'utente dalle azioni verso fuori. Per «Blocca» non cambia
// niente: il deny resta deny. Letture e strumenti normali invariati.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = {
  sandboxMode: 'host' as 'host' | 'docker',
  rules: [] as Array<{ tool: string; pattern: string; mode: 'always_allow' | 'needs_approval' | 'blocked' }>,
  grants: [] as Array<{ tool: string; target: string; scope?: 'readOnly' | null; expiresAt?: number | null; agentId?: string | null }>,
  agents: [] as Array<{ id: string; parentId: string | null }>
}

const TMP = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-fisso-gate-a4-'))
const BOX = join(TMP, 'box')

vi.mock('../../store/db', () => ({
  getPermissions: () => ({ default: 'needs_approval' as const, rules: state.rules }),
  listGrants: () => state.grants.map((g, i) => ({ id: i + 1, tool: g.tool, target: g.target, createdAt: 0, scope: g.scope ?? null, expiresAt: g.expiresAt ?? null, agentId: g.agentId ?? null })),
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
import { TEST_TMP_BASE } from '../../../test-tmp'

beforeAll(() => mkdirSync(BOX, { recursive: true }))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
beforeEach(() => {
  state.rules = []
  state.grants = []
  state.agents = []
})

describe('A4.5: il gate chiede per l\'insieme fisso anche FUORI dalle squadre con always_allow', () => {
  it('regola specifica always_allow su send_email → ASK (niente squadre)', async () => {
    state.rules = [{ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'always_allow' }]
    const v = await check('mcp__ufficio__send_email', { to: 'a@b.example' }, 'a-bot')
    expect(v.kind).toBe('ask')
  })

  it('regola generica always_allow (default sempre) → l\'invio chiede lo stesso', async () => {
    state.rules = [{ tool: 'mcp__*', pattern: '*', mode: 'always_allow' }]
    const v = await check('mcp__ufficio__send_email', {}, 'a-bot')
    expect(v.kind).toBe('ask')
    state.rules = [{ tool: '*', pattern: '*', mode: 'always_allow' }]
    const v2 = await check('mcp__ufficio__send_email', {}, 'a-bot')
    expect(v2.kind).toBe('ask')
  })

  it('un\'azione Composio d\'invio con always_allow → ASK', async () => {
    state.rules = [{ tool: 'composio__gmail__GMAIL_SEND_EMAIL', pattern: '*', mode: 'always_allow' }]
    const v = await check('composio__gmail__GMAIL_SEND_EMAIL', {}, 'a-bot')
    expect(v.kind).toBe('ask')
  })

  it('«Blocca» NON cambia niente: il deny resta deny (anche per i fissi)', async () => {
    state.rules = [{ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'blocked' }]
    const v = await check('mcp__ufficio__send_email', {}, 'a-bot')
    expect(v.kind).toBe('deny')
  })

  it('letture e strumenti NORMALI con always_allow → allow, come oggi', async () => {
    state.rules = [{ tool: 'mcp__ufficio__search_emails', pattern: '*', mode: 'always_allow' }]
    const v = await check('mcp__ufficio__search_emails', {}, 'a-bot')
    expect(v).toMatchObject({ kind: 'allow', via: 'rule' })
    // run-command e i tool del bot NON sono dell'insieme fisso del PLUGIN
    state.rules = [{ tool: 'run-command', pattern: '*', mode: 'always_allow' }]
    const v2 = await check('run-command', { command: 'ls' }, 'a-bot')
    expect(v2).toMatchObject({ kind: 'allow' })
  })
})
