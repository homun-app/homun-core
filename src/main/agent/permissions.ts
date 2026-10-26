// Sistema permessi — replica del modello verificato nell'originale:
// always_allow | needs_approval | blocked, con standing grants persistenti.
import { getPermissions, listGrants, addGrant } from '../store/db'
import type { PermissionMode } from '../../shared/types'

export type Verdict =
  | { kind: 'allow'; via: 'rule' | 'grant' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

/** Chiave target per tool: comando shell → prima parola+prefisso, file → path normalizzato. */
export function targetKey(tool: string, input: Record<string, unknown>): string {
  if (tool === 'run-command') {
    const cmd = String(input.command ?? '')
    const first = cmd.trim().split(/\s+/)[0] ?? ''
    return first
  }
  if (tool === 'read-file' || tool === 'write-file' || tool === 'list-directory') {
    return String(input.path ?? '')
  }
  if (tool === 'use-app') {
    return String(input.action ?? '') // scope per azione, come l'originale
  }
  return '*'
}

function matchRule(tool: string, target: string, rules: ReturnType<typeof getPermissions>['rules']): PermissionMode | null {
  // regola più specifica vince: tool esatto prima di prefisso (*) prima di '*'
  const score = (r: typeof rules[number]) =>
    (r.tool !== '*' ? (r.tool.endsWith('*') ? 1 : 3) : 0) + (r.pattern !== '*' ? 1 : 0)
  const ordered = [...rules].sort((a, b) => score(b) - score(a))
  for (const r of ordered) {
    if (r.tool === '*') {
      // match tutto
    } else if (r.tool.endsWith('*')) {
      if (!tool.startsWith(r.tool.slice(0, -1))) continue
    } else if (r.tool !== tool) continue
    if (r.pattern !== '*' && !target.startsWith(r.pattern)) continue
    return r.mode
  }
  return null
}

export function check(tool: string, input: Record<string, unknown>): Verdict {
  const target = targetKey(tool, input)
  const cfg = getPermissions()

  const mode = matchRule(tool, target, cfg.rules) ?? cfg.default
  if (mode === 'blocked') return { kind: 'deny', reason: 'Command blocked by permissions configuration' }

  // standing grant: l'utente ha detto "Always allow" per questo tool+target
  const grant = listGrants().find((g) => g.tool === tool && (g.target === target || target.startsWith(g.target)))
  if (grant) return { kind: 'allow', via: 'grant' }

  if (mode === 'always_allow') return { kind: 'allow', via: 'rule' }
  return { kind: 'ask', reason: `${tool}${target !== '*' ? ` (${target})` : ''} richiede approvazione` }
}

/** Registra una standing grant dopo "Always allow". */
export function grantStanding(tool: string, input: Record<string, unknown>): void {
  addGrant(tool, targetKey(tool, input))
}
