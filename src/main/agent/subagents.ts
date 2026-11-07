// Policy dei SOTTOAGENTI (fase 12, punti 2 e 3) — modulo PURO: la whitelist
// dei tool del figlio con i motivi dei rifiuti, i limiti delle spawn, il
// sollecito e la decisione di chiusura robusta (flash a volte risponde vuoto:
// la chiusura non dipende dal modello). Niente store, niente daemon: i test
// girano in nodo puro.

/**
 * Punto 2: al massimo 4 spawn per turno del padre (di solito 2-4 sottoagenti
 * bastano; oltre è rumore).
 */
export const MAX_SPAWNS_PER_TURN = 4

/** Punto 2: al massimo 6 figli APERTI (queued o running) per padre. */
export const MAX_OPEN_SUBAGENTS = 6

/** Punto 3: il summary di wake_parent al massimo 2.000 caratteri (condensato). */
export const WAKE_SUMMARY_MAX_CHARS = 2_000

/** La nota della chiusura automatica (il figlio non ha chiamato wake_parent). */
export const AUTO_CLOSE_NOTE = '(automatic close: the subagent did not deliver with wake_parent)'

/**
 * Punto 3: il brief deve essere autosufficiente — 200 caratteri sono il minimo
 * per obiettivo, confini e formato del risultato. Messaggio del rifiuto.
 */
export const SHORT_BRIEF_ERROR =
  'the brief must be self-sufficient: goal, boundaries, result format (at least 200 characters)'

/** Punto 3, validazione pura del brief: presente e lungo abbastanza. */
export function subagentBriefError(brief: string): string | null {
  if (!brief.trim()) return 'title and brief are required'
  if (brief.trim().length < 200) return SHORT_BRIEF_ERROR
  return null
}

// ---- correzione J4: i CONFINI nel brief non sono OBIETTIVI ----

/**
 * Le frasi che dichiarano un CONFINE o un CONFRONTO, non un obiettivo: le
 * menzioni dei nomi qui dentro NON contano (il prompt del padre chiede proprio
 * confini espliciti come "non cercare SvelteKit né Remix: lo cerca un altro",
 * e "quando sceglierlo rispetto a SvelteKit" è un confronto, non lavoro da
 * fare). Parola intera, IT e EN.
 */
const BRIEF_BOUNDARY_RE =
  /(?<![\p{L}\p{N}])(?:non|né|esclus[oa]e?|not|don't|doesn't|lo (?:cerca|fa) un altro|li (?:cerca|fa) un altro|rispetto a|in confronto a|piuttosto che|versus|vs|compared to)(?![\p{L}\p{N}])/iu

/**
 * briefTargets (pura, correzione J4): i nomi che il brief indica come
 * OBIETTIVO. Il brief si spezza in righe e frasi; le frasi di confine o di
 * confronto (BRIEF_BOUNDARY_RE) ignorano TUTTI i nomi che contengono, i nomi
 * nelle altre frasi contano (parola intera, case-insensitive). Un brief del
 * padre ben fatto ha UN solo obiettivo: gli altri framework si NOMINANO solo
 * nei confini. Torna i nomi (minuscoli) nell'ordine di `names`.
 */
export function briefTargets(brief: string, names: readonly string[]): string[] {
  const hit = new Set<string>()
  for (const line of brief.split(/\r?\n/)) {
    for (const phrase of line.split(/(?<=[.!?:;])\s+/)) {
      if (!phrase.trim() || BRIEF_BOUNDARY_RE.test(phrase)) continue
      for (const name of names) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')
        if (re.test(phrase)) hit.add(name.toLowerCase())
      }
    }
  }
  return names.filter((n) => hit.has(n.toLowerCase())).map((n) => n.toLowerCase())
}

// ---- correzione K2 (caso 21 eval): l'OBIETTIVO di un brief ----

/** La regex di un nome come PAROLA INTERA (case-insensitive), come in briefTargets. */
const nameRe = (name: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')

/**
 * briefTarget (pura, correzione K2): l'OBIETTIVO di un brief. Vince il
 * framework del TITOLO della spawn quando il titolo ne nomina esattamente
 * uno ("Ricerca su Remix"): inseguire ogni formulazione del brief con altre
 * parole chiave non converge — "per un confronto comparativo con SvelteKit e
 * Remix" NON è un confine. Altrimenti vince il framework con PIÙ menzioni
 * nel brief (parola intera), purché il massimo sia UNICO; col pareggio non
 * c'è un obiettivo (null). briefTargets resta come segnale secondario.
 */
export function briefTarget(title: string, brief: string, names: readonly string[]): string | null {
  const inTitle = names.filter((n) => nameRe(n).test(title)).map((n) => n.toLowerCase())
  if (inTitle.length === 1) return inTitle[0]!
  const counts = names.map((n) => ({
    name: n.toLowerCase(),
    count: (brief.match(new RegExp(nameRe(n).source, 'giu')) ?? []).length
  }))
  const max = Math.max(...counts.map((c) => c.count))
  if (max === 0) return null
  const top = counts.filter((c) => c.count === max)
  return top.length === 1 ? top[0]!.name : null
}

// ---- punto 3: la whitelist dei tool del figlio ----

/** I tool di LAVORO e lettura che il figlio riceve (i browser_* se disponibili si aggiungono a parte). */
const SUBAGENT_BASE_TOOLS = new Set([
  'run-command', 'await_shell',
  'read-file', 'write-file', 'list-directory',
  'web_search', 'web_fetch',
  'recall_memory', 'skill',
  // fase token (T2): la ricerca dei gruppi è del figlio come del padre
  // (browser e tasks si trovano; i gruppi esclusi dalla whitelist no)
  'find_tools',
  'wake_parent'
])

/** I motivi dei rifiuti, per gruppo: al modello arriva "non disponibile ai sottoagenti: <motivo>". */
const SUBAGENT_DENY_REASONS: ReadonlyArray<{ test: (tool: string) => boolean; reason: string }> = [
  {
    // fase risposta (R2.5): anche message_user è vietato nel figlio, come
    // send_to_user: il figlio consegna al padre con wake_parent
    test: (t) => ['send_to_user', 'message_user', 'ask_user', 'send_to_agent', 'post_to_group', 'pass'].includes(t),
    reason: 'the subagent does not talk with the user or the other bots: deliver to the parent with wake_parent'
  },
  {
    test: (t) => ['spawn_subagent', 'check_subagent', 'message_subagent', 'stop_subagent'].includes(t),
    reason: 'no subagents inside subagents'
  },
  {
    test: (t) => ['create_task', 'update_task'].includes(t),
    reason: 'tasks are opened from the parent\'s chat: here you work on the brief'
  },
  {
    test: (t) => ['update_memory', 'update_skill', 'update_state'].includes(t),
    reason: 'memory, skills and routines belong to the parent and stay read-only'
  },
  {
    test: (t) => ['copy_to_box', 'copy_from_box'].includes(t),
    reason: 'file exchange with the Mac is handled by the parent'
  },
  {
    test: (t) => t === 'use-app',
    reason: 'the user\'s computer is not touched from a subagent'
  },
  // fase 19a (V7): lo schermo del bot è del PADRE — il browser del figlio è
  // headless (niente desktop) e il suo turno non può chiudersi in attesa
  // dell'utente: consegna al padre con wake_parent
  {
    test: (t) => t === 'computer_observe' || t === 'computer_act',
    reason: 'the subagent\'s browser is headless: it has no screen of its own, the parent holds the desktop'
  },
  {
    test: (t) => t === 'request_takeover',
    reason: 'a subagent turn cannot wait for the user: tell the parent with wake_parent'
  },
  {
    test: (t) => t === 'list_agents' || t === 'list-credentials',
    reason: 'the subagent works on the brief; the roster and the vault belong to the parent'
  },
  {
    test: (t) => ['draft_external', 'offer_connector', 'search_connectors', 'add_mcp_server', 'install_plugin', 'propose_rule_change', 'create_agent', 'update_agent', 'delete_agent', 'create_group', 'update_group'].includes(t),
    reason: 'external sends, connectors and bot configuration belong to the parent'
  }
]

/**
 * Punto 3: un tool è ammesso nel turno del figlio? I browser_* (se disponibili)
 * e i connettori mcp__* passano sempre attraverso il gate dei permessi, come
 * nel padre.
 */
export function subagentToolAllowed(tool: string): boolean {
  if (SUBAGENT_BASE_TOOLS.has(tool)) return true
  if (tool.startsWith('browser_') || tool.startsWith('mcp__')) return true
  return false
}

/** Il motivo del rifiuto per un tool escluso (null se è ammesso). */
export function subagentToolDenyReason(tool: string): string | null {
  if (subagentToolAllowed(tool)) return null
  for (const d of SUBAGENT_DENY_REASONS) {
    if (d.test(tool)) return d.reason
  }
  return 'only available to the parent bot'
}

// ---- punto 3: la chiusura robusta ----

/**
 * Il sollecito dell'UNICA chiamata di recupero del figlio che finisce il turno
 * senza wake_parent: i tool sono ristretti a wake_parent.
 */
export const SUBAGENT_RECOVERY_NUDGE =
  'You have not delivered to the parent: call wake_parent NOW with status ("done" or "failed") and a condensed summary of the result (that only, no other tool).'

export interface SubagentClosureFacts {
  /** il figlio ha chiamato wake_parent nel turno */
  wakeCalled: boolean
  /** il sollecito è già stato fatto (una volta sola) */
  nudged: boolean
  /** l\'ultimo testo libero non vuoto del figlio (il ripiego del summary) */
  freeText: string
  /** il turno è finito STOPPED per errore del modello */
  modelError: boolean
}

export type SubagentClosure =
  | { kind: 'none' }
  | { kind: 'nudge' }
  | { kind: 'auto-done' }
  | { kind: 'auto-failed' }

/**
 * subagentClosure (pura, punto 3): cosa fare di un figlio il cui turno è
 * finito. wake_parent → niente. Senza consegna: PRIMA una chiamata di
 * recupero col sollecito (nudge); se anche quella non consegna, chiusura
 * automatica — done col testo libero (troncato) se c'è, failed se è vuoto.
 * L'errore del modello chiude failed subito (niente sollecito su un modello
 * che non risponde).
 */
export function subagentClosure(f: SubagentClosureFacts): SubagentClosure {
  if (f.wakeCalled) return { kind: 'none' }
  if (f.modelError) return { kind: 'auto-failed' }
  if (!f.nudged) return { kind: 'nudge' }
  return f.freeText.trim() ? { kind: 'auto-done' } : { kind: 'auto-failed' }
}

/** Il summary della chiusura automatica: l'ultimo testo libero + la nota (puro). */
export function autoCloseSummary(freeText: string): string {
  const text = freeText.trim().slice(0, WAKE_SUMMARY_MAX_CHARS)
  return `${text}\n${AUTO_CLOSE_NOTE}`.trim()
}

/** Il summary della scadenza: l'ultimo testo libero + la nota dei minuti (puro). */
export function expiredSummary(freeText: string, minutes: number): string {
  const text = freeText.trim().slice(0, WAKE_SUMMARY_MAX_CHARS)
  return [text, `(expired after ${minutes} minutes)`].filter((l) => l).join('\n')
}
