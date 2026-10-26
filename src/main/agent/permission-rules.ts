// Logica pura dei permessi, separata da store/db (che importa Electron)
// per essere testabile in nodo puro con vitest.
import type { PermissionMode, PermissionRule } from '../../shared/types'
import type { ShellAnalysis } from './shell-ast'

/** Chiave target per tool non-shell: file → path normalizzato, azioni → nome azione. */
// Per run-command questa chiave NON si usa più per il match: il gate passa da
// analyzeCommand/runCommandVerdict (vedi sotto). Resta come etichetta display.
export function targetKey(tool: string, input: Record<string, unknown>): string {
  if (tool === 'read-file' || tool === 'write-file' || tool === 'list-directory') {
    return String(input.path ?? '')
  }
  if (tool === 'use-app') {
    return String(input.action ?? '') // scope per azione, come l'originale
  }
  return '*'
}

// ---- gate run-command (§5.1): chiavi esatte "name" o "name sub" ----

/** Chiave di permesso di un comando: "name", oppure "name sub" per i tool a sottocomandi. */
export function commandKey(c: { name: string; sub?: string }): string {
  return c.sub ? `${c.name} ${c.sub}` : c.name
}

/** La regola di un tool copre questo tool? ('*', prefisso 'xxx-*', nome esatto) */
export function ruleToolMatches(ruleTool: string, tool: string): boolean {
  if (ruleTool === '*') return true
  if (ruleTool.endsWith('*')) return tool.startsWith(ruleTool.slice(0, -1))
  return ruleTool === tool
}

/**
 * Pattern di una regola run-command contro una chiave di comando:
 * - '*'            → tutto
 * - 'name'         → il comando name, incluse le sue chiavi "name sub"
 * - 'name *'       → qualunque sottocomando di name (il spazio rende il match
 *                    per parola intera: "rm *" non copre "rmdir")
 * - 'name sub'     → solo quella chiave esatta
 * Mai matching per prefisso di stringa grezzo: "rm" non copre "rmdir".
 */
export function commandRuleMatches(pattern: string, key: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(' *')) {
    const name = pattern.slice(0, -2)
    return key === name || key.startsWith(name + ' ')
  }
  return key === pattern || key.split(' ')[0] === pattern
}

/** Regola più specifica che si applica alla chiave (stessa policy di scoring del resto dei tool). */
function bestRuleMode(key: string, rules: readonly PermissionRule[], tool: string): PermissionMode | null {
  const score = (r: PermissionRule) =>
    (r.tool !== '*' ? (r.tool.endsWith('*') ? 1 : 3) : 0) + (r.pattern !== '*' ? 1 : 0)
  let best: PermissionRule | null = null
  for (const r of rules) {
    if (!ruleToolMatches(r.tool, tool)) continue
    if (!commandRuleMatches(r.pattern, key)) continue
    if (!best || score(r) > score(best)) best = r
  }
  return best?.mode ?? null
}

export interface RunCommandDecision {
  kind: 'allow' | 'ask' | 'deny'
  via?: 'rule' | 'grant'
  reasons: string[]
  /** Tutte le chiavi estratte dal comando (per approval card e standing grants). */
  keys: string[]
}

/**
 * Verdetto permessi per un run-command, dato l'analisi shell.
 * - allow solo se OGNI comando estratto è coperto da grant esatta o regola always_allow
 * - parseError o sostituzioni $(...) / backtick → sempre ask
 * - una sola regola blocked → deny
 * Le grant sono chiavi ESATTE ("git status" non copre "git push").
 */
export function runCommandVerdict(
  a: ShellAnalysis,
  grants: readonly string[],
  rules: readonly PermissionRule[],
  fallback: PermissionMode
): RunCommandDecision {
  const keys = [...new Set(a.commands.map(commandKey))]
  if (a.parseError) {
    return { kind: 'ask', reasons: ['comando non interpretabile in modo affidabile'], keys }
  }
  if (a.hasSubstitution) {
    return { kind: 'ask', reasons: ['contiene una sostituzione di comando ($(...) o backtick)'], keys }
  }
  if (keys.length === 0) {
    return { kind: 'ask', reasons: ['nessun comando riconosciuto'], keys: [] }
  }
  const reasons: string[] = []
  let allCovered = true
  let anyGrant = false
  for (const key of keys) {
    if (grants.includes(key)) {
      anyGrant = true
      continue
    }
    const mode = bestRuleMode(key, rules, 'run-command') ?? fallback
    if (mode === 'blocked') {
      return { kind: 'deny', reasons: ['Command blocked by permissions configuration'], keys }
    }
    if (mode === 'needs_approval') {
      allCovered = false
      reasons.push(`${key} richiede approvazione`)
    }
  }
  if (allCovered) return { kind: 'allow', via: anyGrant ? 'grant' : 'rule', reasons: [], keys }
  return { kind: 'ask', reasons, keys }
}
