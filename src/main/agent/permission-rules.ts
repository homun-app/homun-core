// Logica pura dei permessi, separata da store/db (che importa Electron)
// per essere testabile in nodo puro con vitest.
import { join, resolve, sep } from 'node:path'
import type { PermissionMode, PermissionRule } from '../../shared/types'
import type { ShellAnalysis, ShellCommand } from './shell-ast'

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
  // fase 4: grant/regole per skill e routine, non per tool intero
  if (tool === 'update_skill') {
    return `skill ${String(input.name ?? '')}`
  }
  if (tool === 'update_state') {
    return input.target === 'routine' ? `routine ${String(input.id ?? '')}` : 'memory'
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
  /** Nomi dei segreti {{secret:NOME}} usati dal comando (per la approval card). */
  secretRefs: string[]
}

// ---- never-auto: comandi che eseguono altri comandi ----

/**
 * Comandi MAI approvabili automaticamente (né da grant né da regole
 * always_allow; una regola `blocked` continua a valere → deny). Sono shell,
 * wrapper e interpreti che eseguono come codice ciò che ricevono come
 * argomento: la chiave del permesso (il nome del comando) non dice nulla
 * su cosa verrà eseguito davvero.
 */
export const NEVER_AUTO = new Set([
  // shell e builtin che eseguono stringhe/file come codice
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'exec', 'source', '.',
  // wrapper che lanciano un altro comando o ne alterano ambiente/privilegi
  'env', 'sudo', 'doas', 'su', 'xargs', 'nohup', 'nice', 'timeout', 'time',
  'watch', 'command', 'builtin', 'parallel', 'ssh', 'script', 'chroot',
  'stdbuf', 'unbuffer', 'tee',
  // builtin che alterano lo stato della shell corrente
  'export', 'alias', 'declare', 'typeset', 'set', 'unset', 'trap',
  // interpreti di scripting
  'python', 'python2', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php',
  'osascript', 'awk', 'gawk', 'lua'
])

/**
 * Basename del nome del comando ("/usr/bin/env" → "env"): il gate never-auto
 * e i casi condizionali find/git confrontano il basename, altrimenti un path
 * assoluto nasconde il comando reale (`/usr/bin/env rm -rf ~` non è "env").
 */
function commandBasename(name: string): string {
  const i = name.lastIndexOf('/')
  return i === -1 ? name : name.slice(i + 1)
}

/** Opzioni di find che eseguono comandi, cancellano o scrivono file: con una di queste find è never-auto. */
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])

/** true se il comando non può MAI essere approvato automaticamente. */
export function isNeverAuto(c: Pick<ShellCommand, 'name' | 'argv'>): boolean {
  const name = commandBasename(c.name)
  if (NEVER_AUTO.has(name)) return true
  const args = c.argv.slice(1)
  if (name === 'find' && args.some((a) => FIND_EXEC_FLAGS.has(a))) return true
  // git -c (config arbitraria, es. core.pager) e --exec-path (binario git alternativo)
  if (name === 'git' && (args.includes('-c') || args.some((a) => a === '--exec-path' || a.startsWith('--exec-path=')))) return true
  return false
}

/** Redirect verso queste destinazioni è innocuo (discard o fd standard). */
const HARMLESS_REDIRECT_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

// ---- fase 5: annotazioni MCP → permessi ----

/** Annotazioni MCP standard che interessano il gate (readOnly/destructive/openWorld). */
export interface McpAnnotationsLike {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * Fase 5: modo derivato dalle annotazioni MCP per i tool dei server connessi,
 * quando l'utente non ha regole specifiche (§3.6d "governance degli
 * strumenti"): readOnlyHint=true → always_allow; destructiveHint=true oppure
 * openWorldHint=true → ask; annotazioni assenti → null (vale la regola di
 * default, needs_approval). Le regole blocked dell'utente vincono sempre.
 */
export function mcpAnnotationMode(a: McpAnnotationsLike | undefined): PermissionMode | null {
  if (!a) return null
  if (a.readOnlyHint === true) return 'always_allow'
  if (a.destructiveHint === true || a.openWorldHint === true) return 'needs_approval'
  return null
}

/**
 * C5 (lettura file): il path sta dentro la cartella del bot? Funzione PURA:
 * il filesystem passa da parametro (realpath per neutralizzare ../ e i
 * symlink). Un path ancora inesistente resta al solo resolve (realpath della
 * directory + basename).
 */
export function isInsideBox(
  path: string,
  box: string,
  realpathSync: (p: string) => string
): boolean {
  // realpath del path; se non esiste ancora, risale al primo antenato esistente
  // e ricompone (necessario anche per neutralizzare symlink in mezzo al path,
  // es. /var → /private/var su macOS)
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      const parts = p.split(sep)
      const leaf: string[] = []
      while (parts.length > 1) {
        leaf.unshift(parts.pop()!)
        const ancestor = parts.join(sep) || sep
        try {
          return join(realpathSync(ancestor), ...leaf)
        } catch {
          // continua a salire
        }
      }
      return p
    }
  }
  const resolved = real(resolve(box, path))
  const boxReal = real(box)
  return resolved === boxReal || resolved.startsWith(boxReal + sep)
}

/**
 * Verdetto permessi per un run-command, dato l'analisi shell.
 * - allow solo se OGNI comando estratto è coperto da grant esatta o regola always_allow
 * - parseError o sostituzioni $(...) / backtick → sempre ask
 * - una sola regola blocked → deny (vince su tutto il resto)
 * - MAI allow automatico per:
 *   · comandi con segreti {{secret:...}} (§5.6) → ask "usa le credenziali: ..."
 *   · comandi never-auto (shell/interpreti/wrapper, find -exec, git -c) → ask "esegue altri comandi"
 *   · redirect di output verso file (esclusi /dev/null, /dev/stdout, /dev/stderr
 *     e le duplicazioni di fd) → ask "scrive su file"
 *   · comandi preceduti da assegnazioni (FOO=x cmd) → ask "modifica l'ambiente del comando"
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
    return { kind: 'ask', reasons: ['comando non interpretabile in modo affidabile'], keys, secretRefs: a.secretRefs }
  }
  if (a.hasSubstitution) {
    return { kind: 'ask', reasons: ['contiene una sostituzione di comando ($(...) o backtick)'], keys, secretRefs: a.secretRefs }
  }
  if (keys.length === 0) {
    return { kind: 'ask', reasons: ['nessun comando riconosciuto'], keys: [], secretRefs: a.secretRefs }
  }
  // blocked vince su tutto: mai chiedere quello che una regola vieta
  for (const key of keys) {
    if (bestRuleMode(key, rules, 'run-command') === 'blocked') {
      return { kind: 'deny', reasons: ['Command blocked by permissions configuration'], keys, secretRefs: a.secretRefs }
    }
  }
  // §5.6: un comando che usa credenziali non viene MAI auto-approvato
  // (né grant né always_allow valgono): l'utente deve vederlo ogni volta
  if (a.secretRefs.length) {
    return {
      kind: 'ask',
      reasons: [`usa le credenziali: ${a.secretRefs.join(', ')}`],
      keys,
      secretRefs: a.secretRefs
    }
  }
  const reasons: string[] = []
  let allCovered = true
  let anyGrant = false
  const neverAuto = new Set(a.commands.filter(isNeverAuto).map(commandKey))
  const envPrefixKeys = new Set(a.commands.filter((c) => c.hasEnvPrefix).map(commandKey))
  for (const key of keys) {
    if (neverAuto.has(key)) {
      allCovered = false
      reasons.push(`${key} esegue altri comandi`)
      continue
    }
    if (envPrefixKeys.has(key)) {
      allCovered = false
      reasons.push(`${key} modifica l'ambiente del comando`)
      continue
    }
    if (grants.includes(key)) {
      anyGrant = true
      continue
    }
    const mode = bestRuleMode(key, rules, 'run-command') ?? fallback
    if (mode === 'needs_approval') {
      allCovered = false
      reasons.push(`${key} richiede approvazione`)
    }
  }
  // redirect di output verso file non innocui: vale per l'intera riga,
  // oltre alle chiavi dei singoli comandi
  if (a.redirectTargets.some((t) => !HARMLESS_REDIRECT_TARGETS.has(t))) {
    allCovered = false
    reasons.unshift('scrive su file')
  }
  if (allCovered) return { kind: 'allow', via: anyGrant ? 'grant' : 'rule', reasons: [], keys, secretRefs: [] }
  return { kind: 'ask', reasons, keys, secretRefs: [] }
}
