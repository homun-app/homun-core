// A4 (fase approvazioni-chiare) punto 5 — difesa in profondità:
// permissions:set (daemon) RIFIUTA always_allow sugli strumenti
// dell'insieme fisso (invii, pagamenti) con un errore leggibile; e il GATE
// li fa chiedere ANCHE fuori dalle squadre quando la regola è always_allow
// (per «Blocca» non cambia niente: il deny resta deny).
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TMP_ROOT = TEST_TMP_BASE + '/'

const { setDataDir, dataDir, db } = await import('../../main/store/db')
const { buildApiMethods } = await import('../api')
import type { JobWorker } from '../worker'
import type { SandbotEvent } from '../../shared/types'
import { TEST_TMP_BASE } from '../../test-tmp'
import type { PermissionsConfig } from '../../shared/types'

let events: SandbotEvent[]
const emit: (e: SandbotEvent) => void = (e) => events.push(e)
const api: Record<string, (p: unknown[]) => unknown> = buildApiMethods(emit, { poke: () => undefined } as unknown as JobWorker)

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(TMP_ROOT, 'sandbot-fisso-a4-'))
  setDataDir(dir)
  dataDir()
  db()
})
beforeEach(() => {
  events = []
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const cfgOf = (rules: PermissionsConfig['rules']): PermissionsConfig => ({ default: 'needs_approval', rules })

describe('A4.5: permissions:set rifiuta always_allow sull\'insieme fisso', () => {
  it('send_email di un server MCP → ERRORE leggibile, niente scritture', () => {
    const before = (db().prepare('SELECT value FROM settings WHERE key = ?').get('permissions') as { value: string } | undefined)?.value
    expect(() => api['permissions:set']!([cfgOf([{ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'always_allow' }])]))
      .toThrow(/insieme|always/i)
    const after = (db().prepare('SELECT value FROM settings WHERE key = ?').get('permissions') as { value: string } | undefined)?.value
    expect(after).toBe(before)
  })

  it('un\'azione Composio d\'invio → ERRORE anche lei', () => {
    expect(() => api['permissions:set']!([cfgOf([{ tool: 'composio__gmail__GMAIL_SEND_EMAIL', pattern: '*', mode: 'always_allow' }])]))
      .toThrow(/insieme|always/i)
    // e un pagamento
    expect(() => api['permissions:set']!([cfgOf([{ tool: 'mcp__shop__checkout_order', pattern: '*', mode: 'always_allow' }])]))
      .toThrow(/insieme|always/i)
  })

  it('Chiedi e Blocca sugli strumenti fissi RESTANO possibili (e i non fissi anche sempre)', () => {
    expect(() => api['permissions:set']!([cfgOf([{ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'needs_approval' }])])).not.toThrow()
    expect(() => api['permissions:set']!([cfgOf([{ tool: 'mcp__ufficio__send_email', pattern: '*', mode: 'blocked' }])])).not.toThrow()
    expect(() => api['permissions:set']!([cfgOf([{ tool: 'mcp__ufficio__search_emails', pattern: '*', mode: 'always_allow' }])])).not.toThrow()
  })
})
