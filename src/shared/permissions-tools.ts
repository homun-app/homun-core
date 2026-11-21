// PL2 (fase plugin): i selettori della scheda «Autorizzazioni» LEGGONO e
// SCRIVONO le regole per strumento che esistono già (permissions:
// always_allow / needs_approval / blocked) — nessun modello nuovo. Modulo
// PURO condiviso: il renderer costruisce la configurazione nuova, il gate
// del daemon la applica con la stessa scala di specificità (la regola
// ESATTA dello strumento vince sulle larghe mcp__* e *).
import type { PermissionMode, PermissionsConfig, PermissionRule } from './types'

/** La base minima dei test (il default vero sta in store/db.ts getPermissions). */
export const DEFAULT_PERMISSIONS_FOR_TEST: PermissionsConfig = Object.freeze({
  default: 'needs_approval',
  rules: Object.freeze([{ tool: 'mcp__*', pattern: '*', mode: 'needs_approval' }])
}) as PermissionsConfig

/** La regola di strumento matcha? (stessa semantica di ruleToolMatches: esatta, prefisso xxx-*, '*') */
function ruleToolMatchesLite(ruleTool: string, tool: string): boolean {
  if (ruleTool === '*' || ruleTool === tool) return true
  return ruleTool.endsWith('*') && tool.startsWith(ruleTool.slice(0, -1))
}

/**
 * La regola EFFETTIVA di uno strumento: la più specifica tra quelle con
 * pattern '*' (la scala del gate: esatta 3 > prefisso 1 > '*' 0), altrimenti
 * il default della configurazione.
 */
export function toolRuleOf(cfg: PermissionsConfig, tool: string): PermissionMode {
  let best: { mode: PermissionMode; score: number } | null = null
  for (const r of cfg.rules) {
    if (r.pattern !== '*') continue
    if (!ruleToolMatchesLite(r.tool, tool)) continue
    const score = r.tool === tool ? 3 : r.tool === '*' ? 0 : 1
    if (!best || score > best.score) best = { mode: r.mode, score }
  }
  return best?.mode ?? cfg.default
}

/**
 * La scelta del selettore scrive la regola SPECIFICA dello strumento
 * (upsert: la vecchia specifica si sostituisce, le altre regole non si
 * toccano). Tornare al default della configurazione TOGLIE la specifica
 * inutile: quello che resta è più facile da leggere.
 */
export function withToolRule(cfg: PermissionsConfig, tool: string, mode: PermissionMode): PermissionsConfig {
  const rules = cfg.rules.filter((r) => !(r.tool === tool && r.pattern === '*'))
  if (mode === cfg.default) return { ...cfg, rules }
  const rule: PermissionRule = { tool, pattern: '*', mode }
  return { ...cfg, rules: [...rules, rule] }
}
