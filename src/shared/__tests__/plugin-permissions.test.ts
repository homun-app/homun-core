// PL2 (fase plugin): i selettori delle Autorizzazioni scrivono le regole
// PER STRUMENTO che esistono già (permissions: always_allow /
// needs_approval / blocked) — niente modelli nuovi. Pure: leggere la regola
// effettiva di uno strumento e costruire la configurazione nuova dopo una
// scelta (un upsert, la specifica vince; tornare al default toglie la
// specifica inutile).
import { describe, expect, it } from 'vitest'
import type { PermissionsConfig } from '../types'
import { toolRuleOf, withToolRule, DEFAULT_PERMISSIONS_FOR_TEST } from '../permissions-tools'

const base = DEFAULT_PERMISSIONS_FOR_TEST

describe('PL2: toolRuleOf — la regola effettiva di uno strumento', () => {
  it('nessuna regola specifica → il default (o la regola mcp__* larga)', () => {
    expect(toolRuleOf(base, 'mcp__srv__search')).toBe('needs_approval')
    const withMcp: PermissionsConfig = { default: 'needs_approval', rules: [{ tool: 'mcp__*', pattern: '*', mode: 'always_allow' }] }
    expect(toolRuleOf(withMcp, 'mcp__srv__search')).toBe('always_allow')
  })

  it('la regola SPECIFICA dello strumento vince sulle larghe', () => {
    const cfg: PermissionsConfig = {
      default: 'needs_approval',
      rules: [
        { tool: 'mcp__*', pattern: '*', mode: 'always_allow' },
        { tool: 'mcp__srv__write_thing', pattern: '*', mode: 'blocked' }
      ]
    }
    expect(toolRuleOf(cfg, 'mcp__srv__write_thing')).toBe('blocked')
    expect(toolRuleOf(cfg, 'mcp__srv__other')).toBe('always_allow')
  })
})

describe('PL2: withToolRule — la scelta del selettore scrive la regola', () => {
  it('scegliere «Consenti sempre» aggiunge la regola specifica always_allow', () => {
    const next = withToolRule(base, 'mcp__srv__search', 'always_allow')
    expect(next.rules).toContainEqual({ tool: 'mcp__srv__search', pattern: '*', mode: 'always_allow' })
    expect(toolRuleOf(next, 'mcp__srv__search')).toBe('always_allow')
  })

  it('cambiare idea SOSTITUISCE la regola specifica (niente doppioni)', () => {
    const once = withToolRule(base, 'mcp__srv__search', 'always_allow')
    const twice = withToolRule(once, 'mcp__srv__search', 'blocked')
    const rules = twice.rules.filter((r) => r.tool === 'mcp__srv__search')
    expect(rules).toEqual([{ tool: 'mcp__srv__search', pattern: '*', mode: 'blocked' }])
    expect(toolRuleOf(twice, 'mcp__srv__search')).toBe('blocked')
  })

  it('gli altri strumenti e le altre regole non si toccano', () => {
    const cfg: PermissionsConfig = { default: 'needs_approval', rules: [{ tool: 'run-command', pattern: 'git *', mode: 'always_allow' }] }
    const next = withToolRule(cfg, 'mcp__srv__search', 'always_allow')
    expect(next.rules).toContainEqual({ tool: 'run-command', pattern: 'git *', mode: 'always_allow' })
    expect(next.rules).toHaveLength(2)
  })

  it('tornare al valore di default della configurazione TOGLIE la specifica inutile', () => {
    const once = withToolRule(base, 'mcp__srv__search', 'always_allow')
    const back = withToolRule(once, 'mcp__srv__search', 'needs_approval')
    expect(back.rules.some((r) => r.tool === 'mcp__srv__search')).toBe(false)
    expect(toolRuleOf(back, 'mcp__srv__search')).toBe('needs_approval')
  })
})
