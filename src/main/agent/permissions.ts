// Sistema permessi — replica del modello verificato nell'originale:
// always_allow | needs_approval | blocked, con standing grants persistenti.
// Dal gate §5.1: run-command passa dall'analisi shell (tree-sitter), le grant
// fanno match per chiave ESATTA ("name" o "name sub"), mai per prefisso.
import { realpathSync } from 'node:fs'
import { getPermissions, listGrants, addGrant, getRoutine } from '../store/db'
import { sandboxMode, boxRoot, boxDir } from '../sandbox'
import { resolveBoxPath } from '../sandbox/box-paths'
import type { PermissionMode } from '../../shared/types'
import { targetKey, runCommandVerdict, commandKey, isNeverAuto, ruleToolMatches, mcpAnnotationMode, type McpAnnotationsLike } from './permission-rules'
import { analyzeCommand } from './shell-ast'
import { updateStateVerdict, memoryScopeVerdict, type UpdateStateArgs } from './update-state'
// fase 17c (C2): l'UiText accanto a reason — la card mostra la lingua dell'utente
import { ui } from '../ui-language'
import { UI } from '../../shared/ui-messages'
import type { UiText } from '../../shared/types'

// re-export: i consumer continuano a importare targetKey da qui (loop.ts usa permissions.targetKey)
export { targetKey }

/**
 * Fase 5: annotazioni dei tool MCP, fornite dal client MCP del daemon
 * (iniettate per non creare il collegamento inverso permissions→mcp).
 * Fase 6 (residuo 0a): `catalogServer` dice se il tool appartiene a un server
 * del catalogo — solo per quelli l'annotazione readOnlyHint dà auto-allow.
 */
export interface McpAnnotationInfo {
  annotations: McpAnnotationsLike | undefined
  catalogServer: boolean
}
let mcpAnnotationsLookup: (tool: string) => McpAnnotationInfo | undefined = () => undefined

export function setMcpAnnotationsLookup(fn: (tool: string) => McpAnnotationInfo | undefined): void {
  mcpAnnotationsLookup = fn
}

/**
 * Fase 17c (C2): i verdetti ask portano anche l'UiText del motivo (ui, o uis
 * per run-command che somma più motivi). `reason` resta il testo per il
 * modello dove il modello lo legge; la card mostra l'UiText.
 */
export type Verdict =
  | { kind: 'allow'; via: 'rule' | 'grant' }
  | { kind: 'ask'; reason: string; keys?: string[]; secretRefs?: string[]; ui?: UiText; uis?: UiText[] }
  | { kind: 'deny'; reason: string }

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

/**
 * Scope della memoria esistente per update/delete (M3): l'argomento può non
 * riportarlo, ma modificare una memoria GIÀ condivisa chiede comunque. Lettura
 * best-effort: se la memoria non si trova (assente, id malformato, store non
 * disponibile) resta null → vale lo scope dell'argomento (default agent).
 */
async function currentMemoryScope(agentId: string | undefined, id: unknown): Promise<'agent' | 'user' | null> {
  if (typeof id !== 'string' || !id) return null
  try {
    const { listMemories } = await import('./memory')
    return listMemories(agentId ?? '').find((m) => m.id === id)?.scope ?? null
  } catch {
    return null
  }
}

/**
 * Verdetto per una chiamata tool. Async: run-command richiede l'analisi shell.
 * `agentId` serve al gate C5 (lettura file dentro/fuori dalla box in host).
 */
export async function check(
  tool: string,
  input: Record<string, unknown>,
  agentId?: string
): Promise<Verdict> {
  const cfg = getPermissions()

  // fase 4: la LETTURA di memoria e skill tocca solo i file dell'agente →
  // sempre consentita, anche con config utente personalizzata (viene prima
  // delle regole perché non ha effetti fuori dai file del bot)
  if (tool === 'recall_memory' || tool === 'skill') {
    return { kind: 'allow', via: 'rule' }
  }

  // fase 5: il funnel dei connettori — search_connectors è una lettura del
  // catalogo, offer_connector crea solo una entry nel transcript (la
  // connessione vera parte dal click dell'utente). Fase 13 (punti 2 e 4):
  // add_mcp_server e install_plugin sono uguali — PROPONGONO una card, non
  // installano nulla; l'installazione parte dal click e non passa di qui
  // (mai "Consenti sempre" su quelle card).
  if (tool === 'search_connectors' || tool === 'offer_connector' || tool === 'add_mcp_server' || tool === 'install_plugin') {
    return { kind: 'allow', via: 'rule' }
  }

  // fase 5 (residuo M3): scrivere memorie — lo scope del bot resta sempre
  // consentito; lo scope CONDIVISO 'user' (prompt di tutti i bot) chiede
  // all'utente con il contenuto in card
  if (tool === 'update_memory') {
    const v = memoryScopeVerdict(input as UpdateStateArgs, await currentMemoryScope(agentId, input.id))
    if (v.kind === 'ask') return v
    return { kind: 'allow', via: 'rule' }
  }

  // fase 4: update_state decide per azione — create/pause/delete sempre;
  // resume e update di schedule/prompt su una routine ATTIVA chiedono
  // all'utente (cambiano ciò che il bot eseguirà da solo in futuro).
  // Fase 5 (residuo M1): le ask di update_state NON sono coperte da grant
  // ("Consenti sempre" non viene offerto e grantStanding non salva): una
  // grant su una routine autorizzerebbe anche il cambio del prompt di una
  // routine attiva senza più nessuna card.
  if (tool === 'update_state') {
    const target = targetKey(tool, input)
    const mode = matchRule(tool, target, cfg.rules) ?? cfg.default
    if (mode === 'blocked') return { kind: 'deny', reason: 'Command blocked by permissions configuration' }
    if (input.target !== 'routine') {
      // target memory: stesso verdetto di update_memory (M3)
      const v = memoryScopeVerdict(input as UpdateStateArgs, await currentMemoryScope(agentId, input.id))
      if (v.kind === 'ask') return v
      return { kind: 'allow', via: 'rule' }
    }
    const routine = Number.isInteger(Number(input.id)) && Number(input.id) > 0
      ? getRoutine(Number(input.id))
      : null
    const v = updateStateVerdict(input as UpdateStateArgs, routine)
    if (v.kind === 'ask') return { kind: 'ask', reason: v.reason, ui: v.ui }
    return { kind: 'allow', via: 'rule' }
  }

  if (tool === 'run-command') {
    const analysis = await analyzeCommand(String(input.command ?? ''))
    // grant esatte per questo tool; le righe vecchie (prima parola, es. "git")
    // restano nel DB ma ora fanno match solo sulla chiave identica
    const grants = listGrants().filter((g) => g.tool === tool).map((g) => g.target)
    const d = runCommandVerdict(analysis, grants, cfg.rules, cfg.default)
    if (d.kind === 'deny') return { kind: 'deny', reason: d.reasons[0] ?? 'Command blocked by permissions configuration' }
    if (d.kind === 'allow') return { kind: 'allow', via: d.via ?? 'rule' }
    return {
      kind: 'ask',
      reason: d.reasons.join('; '),
      ...(d.uis.length ? { uis: d.uis } : {}),
      keys: d.keys,
      ...(d.secretRefs.length ? { secretRefs: d.secretRefs } : {})
    }
  }

  // fase 5 (punto 4): i tool MCP senza regole specifiche dell'utente derivano
  // il modo dalle annotazioni standard del server — readOnlyHint → sempre
  // consentito, destructiveHint/openWorldHint → chiede. Le regole blocked
  // vincono sempre; una regola specifica dell'utente batte le annotazioni;
  // gli invii esterni (externalSendTools) restano bozze a monte del gate.
  if (tool.startsWith('mcp__')) {
    const matching = cfg.rules.filter((r) => ruleToolMatches(r.tool, tool))
    if (matching.some((r) => r.mode === 'blocked')) {
      return { kind: 'deny', reason: 'Command blocked by permissions configuration' }
    }
    // regola specifica per QUESTO tool (o suo prefisso), non i wildcard generici
    const specific = matching.find((r) => r.tool !== '*' && r.tool !== 'mcp__*')
    if (specific) {
      return specific.mode === 'always_allow'
        ? { kind: 'allow', via: 'rule' }
        : { kind: 'ask', reason: `${tool} requires approval`, ui: ui(UI.approvalToolRequires, { tool }) }
    }
    if (listGrants().some((g) => g.tool === tool && g.target === '*')) {
      return { kind: 'allow', via: 'grant' }
    }
    const info = mcpAnnotationsLookup(tool)
    const annotated = mcpAnnotationMode(info?.annotations, info?.catalogServer ?? false)
    if (annotated === 'always_allow') return { kind: 'allow', via: 'rule' }
    if (annotated === 'needs_approval') {
      return {
        kind: 'ask',
        reason: `${tool} acts towards the outside (MCP server annotation)`,
        ui: ui(UI.approvalMcpOutward, { tool })
      }
    }
    // annotazioni assenti: regola di default (mcp__* → needs_approval) o default globale
    const mode = matchRule(tool, '*', cfg.rules) ?? cfg.default
    if (mode === 'always_allow') return { kind: 'allow', via: 'rule' }
    return { kind: 'ask', reason: `${tool} requires approval`, ui: ui(UI.approvalToolRequires, { tool }) }
  }

  const target = targetKey(tool, input)
  const mode = matchRule(tool, target, cfg.rules) ?? cfg.default
  if (mode === 'blocked') return { kind: 'deny', reason: 'Command blocked by permissions configuration' }

  // C5: in modalità host i tool di lettura sono always_allow (o coperti da
  // grant) SOLO per i path DENTRO il box condiviso (fase 11: la radice è
  // <dir dati>/box e vale per TUTTI i bot — relativi alla home, /workspace
  // alias della cartella comune), dopo resolve+realpath (neutralizza ../ e
  // symlink). Fuori dal box → ask. In docker resta com'era.
  if (
    (tool === 'read-file' || tool === 'list-directory') &&
    sandboxMode() === 'host' &&
    agentId &&
    !resolveBoxPath(String(input.path ?? ''), boxRoot(), boxDir(agentId), realpathSync).ok
  ) {
    return { kind: 'ask', reason: 'reads outside the shared box', ui: ui(UI.approvalReadsOutsideBox) }
  }

  // standing grant: match ESATTO tool+target ("Consenti sempre" su quel target)
  const grant = listGrants().find((g) => g.tool === tool && g.target === target)
  if (grant) return { kind: 'allow', via: 'grant' }

  if (mode === 'always_allow') return { kind: 'allow', via: 'rule' }
  return {
    kind: 'ask',
    reason: `${tool}${target !== '*' && target ? ` (${target})` : ''} requires approval`,
    ui: target !== '*' && target
      ? ui(UI.approvalToolTargetRequires, { tool, target })
      : ui(UI.approvalToolRequires, { tool })
  }
}

/**
 * Registra una standing grant dopo "Always allow".
 * Per run-command salva una grant per OGNI chiave estratta dal comando, MAI:
 * - per comandi che usano segreti {{secret:...}} (C4: chiedono ogni volta);
 * - per chiavi never-auto (C1: non sarebbero comunque utilizzabili);
 * - per update_state (M1): una grant per routine coprirebbe anche i cambi
 *   futuri del prompt di una routine attiva — le sue card non offrono
 *   "Consenti sempre" e il gate non consulta più le grant già salvate.
 */
export async function grantStanding(tool: string, input: Record<string, unknown>): Promise<void> {
  if (tool === 'update_state') return
  if (tool === 'run-command') {
    const analysis = await analyzeCommand(String(input.command ?? ''))
    if (analysis.secretRefs.length) return
    for (const key of new Set(analysis.commands.filter((c) => !isNeverAuto(c)).map(commandKey))) addGrant(tool, key)
    return
  }
  addGrant(tool, targetKey(tool, input))
}
