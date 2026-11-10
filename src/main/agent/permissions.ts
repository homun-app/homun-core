// Sistema permessi — replica del modello verificato nell'originale:
// always_allow | needs_approval | blocked, con standing grants persistenti.
// Dal gate §5.1: run-command passa dall'analisi shell (tree-sitter), le grant
// fanno match per chiave ESATTA ("name" o "name sub"), mai per prefisso.
import { realpathSync } from 'node:fs'
import { getPermissions, listGrants, addGrant, getRoutine } from '../store/db'
import { sandboxMode, boxRoot, boxDir } from '../sandbox'
import { resolveBoxPath } from '../sandbox/box-paths'
import type { PermissionMode } from '../../shared/types'
import { targetKey, runCommandVerdict, commandKey, isNeverAuto, ruleToolMatches, mcpAnnotationMode, serverReadGrantCovers, grantActive, useAppAlwaysAsk, useAppTargetsMatch, type McpAnnotationsLike } from './permission-rules'
// fase app (A6): la classificazione delle azioni di Composio (pura)
import { classifyComposioToolName } from '../connectors/composio-actions'
// fase Composio OAuth (C2/C3/C5/C4): il gate del blocco e degli strumenti
// del server «For You», riconosciuti PER NOME su qualunque server MCP
import {
  composioBatchGate, manageConnectionsGate, proxyExecuteGate, toolBatchOf
} from '../connectors/tool-batch'
import { connectorReadRequiresApproval, composioTrustKeyOfToolName } from './composio-trust'
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
  /** M4: il nome del server come lo vede l'utente (per la card delle letture) */
  serverName?: string
}

/**
 * Fase Composio OAuth (C4): la fiducia del turno che il loop passa al gate —
 * `tainted` dice se nel turno è entrato contenuto esterno, `trustedApps` i
 * toolkit Composio già usati o approvati nel turno (una lettura su un
 * toolkit NUOVO, dopo la contaminazione, chiede la card).
 */
export interface ComposioTurnTrust {
  tainted: boolean
  trustedApps: string[]
}

let mcpAnnotationsLookup: (tool: string) => McpAnnotationInfo | undefined = () => undefined

export function setMcpAnnotationsLookup(fn: (tool: string) => McpAnnotationInfo | undefined): void {
  mcpAnnotationsLookup = fn
}

/**
 * Fase 0.3.1001 (M1): le annotazioni CORRENTI di un tool MCP, lette dalla
 * stessa lookup del gate (il client MCP del daemon le tiene aggiornate) —
 * servono al classificatore degli invii esterni, che con readOnlyHint true
 * non classifica mai un tool come invio.
 */
export function mcpAnnotationsOf(tool: string): McpAnnotationsLike | undefined {
  return mcpAnnotationsLookup(tool)?.annotations
}

/**
 * Fase 17c (C2): i verdetti ask portano anche l'UiText del motivo (ui, o uis
 * per run-command che somma più motivi). `reason` resta il testo per il
 * modello dove il modello lo legge; la card mostra l'UiText.
 */
export type Verdict =
  | { kind: 'allow'; via: 'rule' | 'grant' }
  | {
      kind: 'ask'
      reason: string
      keys?: string[]
      secretRefs?: string[]
      ui?: UiText
      uis?: UiText[]
  /**
   * M4 (fase 0.3.1001): la card di un tool MCP con readOnlyHint true (e
   * non destructive) di un server MANUALE può offrire «Consenti sempre le
   * letture di <server>» — slug del server e nome da mostrare.
   */
  mcpServerRead?: { slug: string; name: string }
  /**
   * Fase app (A6): l'azione Composio della card — il modo (distruttivo o
   * meno) decide se offrire «Consenti sempre»; il nome umano
   * («Gmail · Invia email») e la riga «tramite Composio» stanno nella card.
   */
  composio?: { destructive: boolean }
  /**
   * Fase Composio OAuth (C7): le azioni del blocco (o le voci di
   * MANAGE_CONNECTIONS / PROXY_EXECUTE) per la card — titolo dalle azioni,
   * argomenti per azione, «…» se una voce non ha nome. `noAlways` toglie
   * «Consenti sempre» (incomplete, distruttive, proxy, collegamenti).
   */
  composioBatch?: {
    actions: import('../connectors/tool-batch').ComposioBatchActionInfo[]
    incomplete: boolean
    destructive: boolean
    noAlways: boolean
    /** il motivo in codice: azione | voce senza nome | fiducia (C4) | regola */
    reason: 'action' | 'incomplete' | 'trust' | 'rule'
  }
}
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
    // fase memoria-engramma (M3): lo scope è la CELLA dove vive la nota
    // (bot-<id> → agent, utente → user), letta dal motore
    const { memoryScopeOf } = await import('../memory/memory-store')
    return await memoryScopeOf(agentId ?? '', id)
  } catch {
    return null
  }
}

/**
 * Verdetto per una chiamata tool. Async: run-command richiede l'analisi shell.
 * `agentId` serve al gate C5 (lettura file dentro/fuori dalla box in host).
 * M3 (fase 0.3.1001): `turn.userDirectTurn` dice se il turno è aperto da un
 * messaggio diretto dell'utente (niente initiator, non automatico, non
 * contaminato) — serve a update_state create activate:true.
 * Fase Composio OAuth (C4): `turn.composioTrust` porta la fiducia del turno
 * per le letture Composio (toolkit usati/approvati e contaminazione).
 */
export async function check(
  tool: string,
  input: Record<string, unknown>,
  agentId?: string,
  turn: { userDirectTurn?: boolean; composioTrust?: ComposioTurnTrust } = {}
): Promise<Verdict> {
  const cfg = getPermissions()

  // fase 4: la LETTURA di memoria e skill tocca solo i file dell'agente →
  // sempre consentita, anche con config utente personalizzata (viene prima
  // delle regole perché non ha effetti fuori dai file del bot)
  // fase memoria-engramma (M5): anche la storia delle conversazioni è una
  // lettura (search_history/read_history)
  if (tool === 'recall_memory' || tool === 'search_history' || tool === 'read_history' || tool === 'skill') {
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
    const v = updateStateVerdict(input as UpdateStateArgs, routine, { userDirectTurn: turn.userDirectTurn === true })
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
  // fase app (A6 punto 4): gli strumenti di Composio (composio__<tk>__<ACTION>).
  // L'utente ha collegato l'app con la procedura guidata: le LETTURE passano
  // senza card; gli INVI diventano bozze a monte di qui (isExternalSend); le
  // altre scritture chiedono con la card; le distruttive chiedono SENZA
  // «Consenti sempre» (meta.composio.destructive). Le regole dell'utente
  // vincono come per i server (blocked nega, una regola specifica decide).
  if (tool.startsWith('composio__')) {
    const matching = cfg.rules.filter((r) => ruleToolMatches(r.tool, tool))
    if (matching.some((r) => r.mode === 'blocked')) {
      return { kind: 'deny', reason: 'Command blocked by permissions configuration' }
    }
    const specific = matching.find((r) => r.tool !== '*' && r.tool !== 'composio__*')
    if (specific) {
      return specific.mode === 'always_allow'
        ? { kind: 'allow', via: 'rule' }
        : { kind: 'ask', reason: `${tool} requires approval`, ui: ui(UI.approvalToolRequires, { tool }), composio: { destructive: false } }
    }
    if (listGrants().some((g) => g.tool === tool && g.target === '*')) {
      return { kind: 'allow', via: 'grant' }
    }
    const kind = classifyComposioToolName(tool)
    if (kind === 'read') {
      // C4: la fiducia per app nel turno — dopo la contaminazione una lettura
      // su un toolkit NON ancora usato né approvato chiede (un testo iniettato
      // potrebbe sceglierne gli argomenti); su un toolkit già usato resta libera
      const trustKey = composioTrustKeyOfToolName(tool)
      if (
        trustKey && turn.composioTrust &&
        connectorReadRequiresApproval({ tainted: turn.composioTrust.tainted, trusted: turn.composioTrust.trustedApps.includes(trustKey) })
      ) {
        return {
          kind: 'ask',
          reason: `${tool} reads a Composio app this turn has not used yet, after untrusted content entered it`,
          ui: ui(UI.approvalComposioTrust, { tool }),
          composio: { destructive: false }
        }
      }
      return { kind: 'allow', via: 'rule' }
    }
    return {
      kind: 'ask',
      reason: `${tool} acts towards the outside (Composio app action)`,
      ui: ui(UI.approvalComposioAction, { tool }),
      composio: { destructive: kind === 'destructive' }
    }
  }

  if (tool.startsWith('mcp__')) {
    // fase Composio OAuth (C2/C3/C5): gli strumenti del server Composio che
    // si giudicano per CONTENUTO — il blocco azione per azione, le
    // connessioni per voce di toolkits[], il proxy sempre card. Riconosciuti
    // PER NOME ORIGINALE su qualunque server MCP (come Rakazo).
    const originalName = tool.split('__').slice(2).join('__')
    if (toolBatchOf(originalName) || originalName === 'COMPOSIO_MANAGE_CONNECTIONS' || originalName === 'COMPOSIO_PROXY_EXECUTE') {
      const grants = listGrants().filter((g) => g.target === '*').map((g) => g.tool)
      const { uiLanguage } = await import('../ui-language')
      const { composioGateway } = await import('../connectors/composio-gateway')
      const gateInput = {
        toolName: tool,
        args: input,
        rules: cfg.rules,
        grants,
        ...(turn.composioTrust ? { trust: turn.composioTrust } : {}),
        ...(composioGateway() ? { connectedSlugs: composioGateway()!.connectedSlugs() } : {}),
        uiLang: uiLanguage()
      }
      const outcome = toolBatchOf(originalName)
        ? composioBatchGate(gateInput)
        : originalName === 'COMPOSIO_MANAGE_CONNECTIONS'
          ? manageConnectionsGate(gateInput)
          : proxyExecuteGate(gateInput)
      if (outcome.kind === 'allow') return { kind: 'allow', via: outcome.via }
      if (outcome.kind === 'deny') return { kind: 'deny', reason: 'Command blocked by permissions configuration' }
      const count = outcome.actions.length
      const reasonText =
        outcome.reason === 'trust'
          ? `${tool} reads a Composio app this turn has not used yet, after untrusted content entered it`
          : outcome.reason === 'incomplete'
            ? `${tool} runs a Composio batch with an unnamed action`
            : originalName === 'COMPOSIO_PROXY_EXECUTE'
              ? `${tool} sends a raw HTTP request to a connected app's API`
              : originalName === 'COMPOSIO_MANAGE_CONNECTIONS'
                ? `${tool} changes the apps connected through Composio`
                : `${tool} runs ${count} Composio action${count === 1 ? '' : 's'} that act towards the outside`
      // V9 (prova vera): la frase del blocco dice QUALI app («Vuole fare 2
      // azioni su Gmail e Slack») — i nomi umani delle azioni del gate
      const { composioAppsLabel } = await import('../../shared/composio-names')
      const uiLang = gateInput.uiLang
      const apps = composioAppsLabel(outcome.actions.map((a) => a.app), uiLang)
      return {
        kind: 'ask',
        reason: reasonText,
        ui: ui(
          outcome.reason === 'trust'
            ? UI.approvalComposioTrust
            : originalName === 'COMPOSIO_PROXY_EXECUTE'
              ? UI.approvalComposioProxy
              : originalName === 'COMPOSIO_MANAGE_CONNECTIONS'
                ? UI.approvalComposioConnect
                : UI.approvalComposioBatch,
          { count, apps }
        ),
        composio: { destructive: outcome.destructive },
        composioBatch: {
          actions: outcome.actions,
          incomplete: outcome.incomplete,
          destructive: outcome.destructive,
          noAlways: outcome.noAlways,
          reason: outcome.reason
        }
      }
    }
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
    // M4 (fase 0.3.1001): la grant «Consenti sempre le letture di <server>»
    // (mcp__<server>__* scope readOnly) copre QUESTA chiamata solo se le
    // annotazioni CORRENTI del tool sono readOnly e non destructive — il
    // controllo è a ogni chiamata, non alla concessione
    if (info && listGrants().some((g) => serverReadGrantCovers(g.tool, g.scope, tool, info.annotations))) {
      return { kind: 'allow', via: 'grant' }
    }
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
    // M4: il tool di un server manuale dichiara readOnly (e non destructive) →
    // la card offre «Consenti sempre le letture di <server>»
    if (
      info && !info.catalogServer &&
      info.annotations?.readOnlyHint === true && info.annotations.destructiveHint !== true
    ) {
      const slug = tool.split('__')[1] ?? ''
      return {
        kind: 'ask',
        reason: `${tool} requires approval`,
        ui: ui(UI.approvalToolRequires, { tool }),
        mcpServerRead: { slug, name: info.serverName ?? slug }
      }
    }
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

  // fase use-app (U3): i comandi riconosciuti come tasti di invio (Return, o
  // un type che finisce con a-capo) in un'app di posta o chat chiedono SEMPRE:
  // un Invio lì dentro può spedire — grant e regole always_allow non lo coprono
  if (tool === 'use-app') {
    const sendKey = useAppAlwaysAsk(input)
    if (sendKey) {
      return { kind: 'ask', reason: `use-app (${sendKey}) requires approval`, ui: ui(UI.approvalUseAppSend, { app: String(input.app ?? '') }) }
    }
  }

  // standing grant: match ESATTO tool+target ("Consenti sempre" su quel
  // target); fase use-app (U3): una grant SCADUTA (i 10 minuti) non vale più;
  // R4 (ritocchi): per use-app il confronto ignora maiuscole e .app (app: e url:)
  const grant = listGrants().find((g) =>
    g.tool === tool &&
    (tool === 'use-app' ? useAppTargetsMatch(g.target, target) : g.target === target) &&
    grantActive(g)
  )
  if (grant) return { kind: 'allow', via: 'grant' }

  if (mode === 'always_allow') return { kind: 'allow', via: 'rule' }
  // fase use-app (U3): la card dice l'APP o l'HOST, mai la chiave tecnica
  if (tool === 'use-app') {
    if (String(input.action ?? '') === 'open_url') {
      let host = ''
      try {
        host = new URL(String(input.url ?? '')).host
      } catch {
        host = String(input.url ?? '').slice(0, 60)
      }
      return { kind: 'ask', reason: `use-app (${target}) requires approval`, ui: ui(UI.approvalUseAppUrl, { host }) }
    }
    return { kind: 'ask', reason: `use-app (${target}) requires approval`, ui: ui(UI.approvalUseApp, { app: String(input.app ?? '').trim() || '?' }) }
  }
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
export async function grantStanding(tool: string, input: Record<string, unknown>, opts: { expiresAtMs?: number } = {}): Promise<void> {
  if (tool === 'update_state') return
  if (tool === 'run-command') {
    const analysis = await analyzeCommand(String(input.command ?? ''))
    if (analysis.secretRefs.length) return
    for (const key of new Set(analysis.commands.filter((c) => !isNeverAuto(c)).map(commandKey))) addGrant(tool, key)
    return
  }
  // fase Composio OAuth (C7 punto 2): «Consenti sempre» su un blocco salva un
  // consenso PER AZIONE (composio-action:<SLUG>), mai per lo strumento del
  // blocco (Rakazo packages/db/src/events.ts:1033–1049)
  if (tool.startsWith('mcp__')) {
    // RW (fase revisore sulla richiesta, punto 3): rete di sicurezza — mai
    // un consenso per uno strumento che non corrisponde a nulla di noto
    // (il nome inventato del caso vero: «COMPROSIO_PROXY_EXECUTE»). Il
    // guard già rifiuta la chiamata; qui non si salva il grant
    if (!mcpAnnotationsLookup(tool)) return
    const shape = toolBatchOf(tool.split('__').slice(2).join('__'))
    if (shape) {
      const { batchActions, composioActionKey } = await import('../connectors/tool-batch')
      const parsed = batchActions(shape, input)
      for (const slug of parsed.actions) addGrant(composioActionKey(slug), '*')
      return
    }
  }
  // fase use-app (U3): «Consenti per 10 minuti a <App>» salva la grant con la
  // scadenza (expires_at); senza opts resta il «Consenti sempre» di sempre
  addGrant(tool, targetKey(tool, input), undefined, opts.expiresAtMs)
}
