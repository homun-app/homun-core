// A2 (fase approvazioni-chiare): il segmento REGISTRO del centro «Da
// approvare» — accanto alle richieste in attesa. Per giorno: richiesta, bot,
// scelta, da dove e quando; filtri Approvate / Rifiutate / Scadute / «Passate
// da sole»; le righe vecchie dicono «decisione precedente al registro»; il
// link «Registro di oggi» porta QUI (non più ad Attività). E la sezione
// «Consentiti sempre»: le grant attive, con Revoca.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { callsOf, stubApiMethod } from './render-helper-install'
import type { ApprovalsCenterRow } from '../../../shared/types'

vi.mock('../components/ui/dialog', () => ({}) as never)

// le props degli elementi resi (per «cliccare»: l'HTML statico non porta gli handler)
const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

/** rende e clicca il bottone col testid (o col testo) cercato */
const clickRendered = (renderFn: () => unknown, match: (props: Record<string, unknown>) => boolean): boolean => {
  capture.els.length = 0
  renderFn()
  const el = capture.els.find((e) => e.type === 'button' && match(e.props))
  if (!el || typeof el.props.onClick !== 'function') return false
  ;(el.props.onClick as () => void)()
  return true
}

const { ApprovalsCenter } = await import('../components/ApprovalsCenter')
const { useStore } = await import('../store')
const { registroModel, groupRegistroByDay, REGISTRO_FILTERS } = await import('../lib/approvals-center')
const { grantDisplayName } = await import('../lib/approval-app')

/** una riga del registro come arriva da approvals:log */
/** una riga del registro come arriva da approvals:log (Partial sul ritorno) */
const logRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'decision',
  key: 'ap-1',
  approvalId: 'ap-1',
  agentId: 'a-solleciti',
  botName: 'Solleciti',
  phrase: 'Mandare il sollecito a Rossi Srl.',
  tool: 'draft_external',
  decision: 'allow',
  mode: 'always',
  via: 'chat',
  allowedBy: null,
  at: Date.now() - 3_600_000,
  legacy: false,
  ...over
})
const ROWS = (): Array<Record<string, unknown>> => [
  logRow(),
  logRow({ key: 'ap-2', approvalId: 'ap-2', agentId: 'a-archivio', botName: 'Archivio', phrase: 'Cliccare «Verifica».', decision: 'deny', mode: 'once', via: 'center', at: Date.now() - 7_200_000 }),
  logRow({ key: 'ap-3', approvalId: 'ap-3', agentId: 'a-turismo', botName: 'Turismo', phrase: 'Compilare il modulo.', decision: 'expired', mode: null, via: 'expired', at: Date.now() - 108_000_000 }),
  logRow({ kind: 'auto', key: 'auto-write-file', approvalId: null, agentId: 'a-ricerche', botName: 'Ricerche', phrase: 'write-file', tool: 'write-file', decision: 'auto', mode: null, via: null, allowedBy: 'grant 12', at: Date.now() - 200_000 }),
  logRow({ key: 'ap-vecchia', approvalId: 'ap-vecchia', agentId: 'a-vecchio', botName: 'Vecchio', phrase: 'Clic vecchio.', decision: null, mode: null, via: null, legacy: true, at: 1_000 })
]

const grant = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7, tool: 'run-command', target: 'git status', createdAt: Date.now() - 86_400_000, scope: null, expiresAt: null, agentId: null, ...over
})

function renderCenter(patch: Record<string, unknown> = {}, registroInitial?: { log?: unknown[]; grants?: unknown[] }): ReturnType<typeof parseHtml> {
  setStoreStateForRender(useStore, {
    approvalsAll: [] as ApprovalsCenterRow[],
    approvalsSnoozed: {},
    approvalsOpen: true,
    approvalsView: 'richieste',
    approvalsFocusId: null,
    approvalsBannerCollapsed: false,
    groups: [],
    agents: [],
    entries: [],
    activeId: 'a-bot',
    openGroupId: null,
    activityOpen: false,
    openLibraryId: null,
    approvalsQueueOpen: false,
    ...patch
  })
  const props = registroInitial ? ({ registroInitial } as never) : undefined
  return parseHtml(renderHtml(createElement(ApprovalsCenter, props)))
}

beforeEach(() => {
  useStore.setState({ approvalsAll: [], approvalsOpen: false, approvalsView: 'richieste' })
  stubApiMethod('approvalsLog', () => ROWS())
  stubApiMethod('grantsList', () => [
    grant(),
    grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })
  ])
})

// ---- il modello puro del registro ----

describe('A2: il modello del registro (registroModel, pura)', () => {
  it('i filtri: Approvate / Rifiutate / Scadute / Passate da sole — ciascuno conta le sue righe', () => {
    expect(REGISTRO_FILTERS.map((f) => f.id)).toEqual(['approve', 'deny', 'expired', 'auto'])
    const rows = ROWS() as never[]
    for (const f of REGISTRO_FILTERS) {
      const filtered = registroModel(rows, f.id)
      const want = f.id === 'approve' ? ['ap-1'] : f.id === 'deny' ? ['ap-2'] : f.id === 'expired' ? ['ap-3'] : ['auto-write-file']
      expect(filtered.map((r) => r.key), f.id).toEqual(want)
    }
  })

  it('il raggruppamento per giorno: oggi, ieri, poi le date', () => {
    const days = groupRegistroByDay(registroModel(ROWS() as never[], 'all'))
    expect(days[0]!.label).toMatch(/oggi/i)
    expect(days.length).toBeGreaterThanOrEqual(2)
    // l'ordine è dal più recente
    expect(days[0]!.rows[0]!.key).toBe('auto-write-file')
  })
})

// ---- il render del segmento ----

describe('A2: il segmento Registro nel centro', () => {
  it('le due schede «Richieste» e «Registro»', () => {
    const text = textOf(renderCenter())
    expect(text).toContain('Richieste')
    expect(text).toContain('Registro')
  })

  it('la vista Registro: per giorno con frase, bot, scelta, da dove e quando; i filtri; la riga vecchia', () => {
    const text = textOf(renderCenter({ approvalsView: 'registro' }, { log: ROWS(), grants: [grant(), grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })] }))
    expect(text).toContain('Mandare il sollecito a Rossi Srl.')
    expect(text).toContain('Consentito sempre')
    expect(text).toContain('dalla chat')
    expect(text).toContain('Rifiutato')
    expect(text).toContain('dal centro')
    expect(text).toContain('Scaduto')
    expect(text).toContain('decisione precedente al registro')
    expect(text).toContain('Approvate')
    expect(text).toContain('Rifiutate')
    expect(text).toContain('Scadute')
    expect(text).toContain('Passate da sole')
  })

  it('la «passata da sola» compare con la grant che l\'ha coperta', () => {
    const text = textOf(renderCenter({ approvalsView: 'registro' }, { log: ROWS(), grants: [grant(), grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })] }))
    expect(text).toContain('write-file')
    expect(text).toContain('grant 12')
  })

  it('«Registro di oggi» apre il Registro, NON Attività', () => {
    expect(clickRendered(() => renderCenter(), (props) => (props['data-testid'] ?? '') === 'approvals-open-registro')).toBe(true)
    expect(useStore.getState().activityOpen).toBe(false)
    expect(useStore.getState().approvalsView).toBe('registro')
    expect(useStore.getState().approvalsOpen).toBe(true)
    expect(textOf(renderCenter({ approvalsView: 'registro' }, { log: ROWS(), grants: [grant(), grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })] }))).toContain('decisione precedente al registro')
  })

  it('«Consentiti sempre»: le grant attive con Revoca (il click chiama la grants:revoke di oggi)', () => {
    const tree = renderCenter({ approvalsView: 'registro' }, { log: ROWS(), grants: [grant(), grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })] })
    const text = textOf(tree)
    expect(text).toContain('Consentiti sempre')
    expect(text).toContain('git status')
    expect(grantDisplayName({ tool: 'mcp__notion__*', target: '*', scope: 'readOnly' }, 'it')).toBe('Letture di notion')
    expect(text).toContain('Letture di notion')
    expect(clickRendered(() => renderCenter({ approvalsView: 'registro' }, { log: ROWS(), grants: [grant(), grant({ id: 8, tool: 'mcp__notion__*', target: '*', scope: 'readOnly', agentId: 'a-bot' })] }), (props) => (props['data-testid'] ?? '') === 'grant-revoke')).toBe(true)
    // il gruppo del bot viene prima, «Tutti i bot» ultimo (groupGrantsByBot): la prima Revoca è quella del bot
    expect(callsOf('grantRevoke').slice(-1)[0]!.args).toEqual([8])
  })
})
