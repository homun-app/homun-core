// AH5 (fase aiutanti): nel BOX, in modalità «Chiedi», i comandi girano SENZA
// card — il confine lo fa l'isolamento, non il nome del comando (il modello di
// Codex e Claude Code col sandbox). Restano: le regole blocked (negano), i
// secretRefs (chiedono), copy_to_box/copy_from_box (chiedono sempre, ramo
// loro), host INVARIATO. La regola dei contenuti non fidati per run-command
// nel box dipende dall'USCITA DI RETE dei comandi: boxShellEgress (pura) dice
// 'none' (Apple --internal, o modalità none) oppure 'direct' (la bridge di
// Docker, che fa NAT verso internet).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PermissionRule } from '../../../shared/types'

// stato condiviso coi mock, PRIMA degli import dinamici
const state = {
  sandboxMode: 'host' as 'host' | 'box',
  egress: 'direct' as 'none' | 'direct',
  approvalsMode: undefined as string | undefined,
  rules: [] as PermissionRule[],
  grants: [] as Array<{ tool: string; target: string; expiresAt?: number | null }>
}
const settings = new Map<string, unknown>()

vi.mock('../../store/db', () => ({
  getPermissions: () => ({ default: 'needs_approval' as const, rules: state.rules }),
  listGrants: () => state.grants.map((g, i) => ({ id: i + 1, tool: g.tool, target: g.target, createdAt: 0, expiresAt: g.expiresAt ?? null })),
  addGrant: (tool: string, target: string) => { state.grants.push({ tool, target }) },
  getRoutine: () => null,
  getSetting: (key: string, fallback: unknown) => (settings.has(key) ? settings.get(key) : fallback)
}))

vi.mock('../../sandbox', () => ({
  sandboxMode: () => state.sandboxMode,
  boxRoot: () => '/tmp/box',
  boxDir: (id: string) => `/tmp/box/home/${id}`,
  boxShellEgressOf: () => state.egress
}))

const { check } = await import('../permissions')
const { boxShellEgress } = await import('../../sandbox/box-egress')
const { liftContaminatedAllow } = await import('../auto-review')

beforeEach(() => {
  state.sandboxMode = 'host'
  state.egress = 'direct'
  state.approvalsMode = undefined
  state.rules = []
  state.grants = []
  settings.clear()
  settings.set('permissions.timeoutMs', 300_000)
})

describe('AH5: boxShellEgress (pura) — l\'uscita di rete dei comandi del box', () => {
  it('Apple container: rete --internal (homun-box) → none; la modalità none → none per entrambi i motori', () => {
    expect(boxShellEgress('apple-container', 'bridge')).toBe('none')
    expect(boxShellEgress('apple-container', 'none')).toBe('none')
    expect(boxShellEgress('docker', 'none')).toBe('none')
  })

  it('Docker: il box sta sulla rete bridge DI DOCKER, che fa NAT verso internet → direct', () => {
    expect(boxShellEgress('docker', 'bridge')).toBe('direct')
  })
})

describe('AH5: nel box, in «Chiedi», run-command non chiede', () => {
  const boxAsk = () => {
    state.sandboxMode = 'box'
    state.egress = 'none'
    settings.set('approvals.mode', 'ask')
  }

  it('ls, mkdir e cp passano SENZA card (verdetto allow)', async () => {
    boxAsk()
    for (const command of ['ls', 'mkdir nuova', 'cp a b']) {
      const v = await check('run-command', { command })
      expect(v.kind, command).toBe('allow')
    }
  })

  it('GUARDIA: in HOST chiedono come oggi', async () => {
    state.sandboxMode = 'host'
    settings.set('approvals.mode', 'ask')
    for (const command of ['ls', 'mkdir nuova', 'cp a b']) {
      const v = await check('run-command', { command })
      expect(v.kind, command).toBe('ask')
    }
  })

  it('una regola blocked dell\'utente su rm continua a NEGARE anche nel box', async () => {
    boxAsk()
    state.rules = [{ tool: 'run-command', pattern: 'rm', mode: 'blocked' }]
    const v = await check('run-command', { command: 'rm -rf /tmp/x' })
    expect(v.kind).toBe('deny')
  })

  it('i comandi con riferimenti a segreti continuano a CHIEDERE anche nel box', async () => {
    boxAsk()
    const v = await check('run-command', { command: 'curl -H "Authorization: Bearer {{secret:API_KEY}}" https://x' })
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.secretRefs).toEqual(['API_KEY'])
  })

  it('GUARDIA: fuori da «Chiedi» (Automatico) il gate resta quello di oggi', async () => {
    state.sandboxMode = 'box'
    state.egress = 'none'
    settings.set('approvals.mode', 'auto')
    const v = await check('run-command', { command: 'ls' })
    expect(v.kind).toBe('ask')
  })
})

describe('AH5: contenuti non fidati e uscita di rete (liftContaminatedAllow)', () => {
  const allow = { kind: 'allow' as const, via: 'rule' as const }

  it('box Apple (uscita none) + turno contaminato → run-command PASSA (non può far uscire niente)', () => {
    expect(liftContaminatedAllow(allow, 'run-command', true, true).kind).toBe('allow')
  })

  it('box con uscita direct (bridge di Docker) + turno contaminato → run-command torna a CHIEDERE come oggi', () => {
    expect(liftContaminatedAllow(allow, 'run-command', true, false).kind).toBe('ask')
  })

  it('gli ALTRI tool con effetti tornano a chiedere anche nel box senza uscita (il lift è per run-command)', () => {
    expect(liftContaminatedAllow(allow, 'send_to_agent', true, true).kind).toBe('ask')
  })

  it('senza contaminazione nulla cambia (guardia)', () => {
    expect(liftContaminatedAllow(allow, 'run-command', false, true).kind).toBe('allow')
  })
})
