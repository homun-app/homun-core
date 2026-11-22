// PL2 (fase plugin): i selettori della scheda «Autorizzazioni» scrivono le
// regole per strumento che esistono già — l'unità è il GATE: la regola
// scritta da withToolRule (shared/permissions-tools, la stessa che userà la
// UI) deve valere alla chiamata successiva di check(). Store mockato come
// permissions.test.ts.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { PermissionRule } from '../../../shared/types'
import { withToolRule, toolRuleOf } from '../../../shared/permissions-tools'

// stato condiviso col mock: le regole che il gate legge
const state = {
  rules: [] as PermissionRule[]
}

vi.mock('../../store/db', () => ({
  getPermissions: () => ({ default: 'needs_approval' as const, rules: state.rules }),
  listGrants: () => [],
  addGrant: () => undefined,
  getRoutine: () => null,
  getAgent: () => null,
  getSetting: (_key: string, fallback: unknown) => fallback
}))

vi.mock('../../sandbox', () => ({
  workspaceNameForPrompt: () => '/workspace',
  sandboxMode: () => 'host' as const,
  boxRoot: () => '/unused',
  boxDir: (id: string) => `/unused/${id}`
}))

const { check } = await import('../permissions')

beforeEach(() => {
  // la base plausibile di un'installazione: mcp__* chiede
  state.rules = [{ tool: 'mcp__*', pattern: '*', mode: 'needs_approval' }]
})

describe('PL2: la regola scritta dal selettore vale al gate', () => {
  it('«Consenti sempre» → allow alla chiamata successiva (via rule)', async () => {
    const cfg = withToolRule({ default: 'needs_approval', rules: state.rules }, 'mcp__ufficio__search', 'always_allow')
    state.rules = cfg.rules
    expect(toolRuleOf(cfg, 'mcp__ufficio__search')).toBe('always_allow')
    const v = await check('mcp__ufficio__search', {})
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.via).toBe('rule')
  })

  it('«Chiedi» torna a chiedere (e sostituisce un always_allow precedente)', async () => {
    const once = withToolRule({ default: 'needs_approval', rules: state.rules }, 'mcp__ufficio__search', 'always_allow')
    const cfg = withToolRule(once, 'mcp__ufficio__search', 'needs_approval')
    state.rules = cfg.rules
    const v = await check('mcp__ufficio__search', {})
    expect(v.kind).toBe('ask')
  })

  it('«Blocca» → deny, e vince anche su una regola larga always_allow', async () => {
    state.rules = [{ tool: 'mcp__*', pattern: '*', mode: 'always_allow' }]
    const cfg = withToolRule({ default: 'needs_approval', rules: state.rules }, 'mcp__ufficio__delete_thing', 'blocked')
    state.rules = cfg.rules
    const v = await check('mcp__ufficio__delete_thing', {})
    expect(v.kind).toBe('deny')
    // la regola larga continua a valere per gli ALTRI strumenti
    const other = await check('mcp__ufficio__search', {})
    expect(other.kind).toBe('allow')
  })

  it('una regola specifica resta nel vicolo del SOLO strumento (niente effetti sugli altri)', async () => {
    const cfg = withToolRule({ default: 'needs_approval', rules: state.rules }, 'mcp__ufficio__search', 'always_allow')
    state.rules = cfg.rules
    const other = await check('mcp__ufficio__write_thing', {})
    expect(other.kind).toBe('ask')
  })
})
