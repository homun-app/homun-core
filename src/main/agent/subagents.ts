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
export const AUTO_CLOSE_NOTE = '(chiusura automatica: il sottoagente non ha consegnato con wake_parent)'

/**
 * Punto 3: il brief deve essere autosufficiente — 200 caratteri sono il minimo
 * per obiettivo, confini e formato del risultato. Messaggio del rifiuto.
 */
export const SHORT_BRIEF_ERROR =
  'il brief deve essere autosufficiente: obiettivo, confini, formato del risultato (almeno 200 caratteri)'

/** Punto 3, validazione pura del brief: presente e lungo abbastanza. */
export function subagentBriefError(brief: string): string | null {
  if (!brief.trim()) return 'servono title e brief'
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

// ---- punto 3: la whitelist dei tool del figlio ----

/** I tool di LAVORO e lettura che il figlio riceve (i browser_* se disponibili si aggiungono a parte). */
const SUBAGENT_BASE_TOOLS = new Set([
  'run-command', 'await_shell',
  'read-file', 'write-file', 'list-directory',
  'web_search', 'web_fetch',
  'recall_memory', 'skill',
  'wake_parent'
])

/** I motivi dei rifiuti, per gruppo: al modello arriva "non disponibile ai sottoagenti: <motivo>". */
const SUBAGENT_DENY_REASONS: ReadonlyArray<{ test: (tool: string) => boolean; reason: string }> = [
  {
    test: (t) => ['send_to_user', 'ask_user', 'send_to_agent', 'post_to_group', 'pass'].includes(t),
    reason: 'il sottoagente non parla con l\'utente né con gli altri bot: consegna al padre con wake_parent'
  },
  {
    test: (t) => ['spawn_subagent', 'check_subagent', 'message_subagent', 'stop_subagent'].includes(t),
    reason: 'niente sottoagenti dentro sottoagenti'
  },
  {
    test: (t) => ['create_task', 'update_task'].includes(t),
    reason: 'i task si aprono dalla chat del padre: qui si lavora sul brief'
  },
  {
    test: (t) => ['update_memory', 'update_skill', 'update_state'].includes(t),
    reason: 'memoria, skill e routine sono del padre e restano in sola lettura'
  },
  {
    test: (t) => ['copy_to_box', 'copy_from_box'].includes(t),
    reason: 'lo scambio di file col Mac lo gestisce il padre'
  },
  {
    test: (t) => t === 'use-app',
    reason: 'il computer dell\'utente non si tocca da un sottoagente'
  },
  {
    test: (t) => t === 'list_agents' || t === 'list-credentials',
    reason: 'il sottoagente lavora sul brief, il roster e il vault sono del padre'
  },
  {
    test: (t) => ['draft_external', 'offer_connector', 'search_connectors', 'propose_rule_change', 'create_agent', 'update_agent', 'delete_agent', 'create_group', 'update_group'].includes(t),
    reason: 'gli invii esterni, i connettori e la configurazione dei bot sono del padre'
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
  return 'disponibile solo al bot padre'
}

// ---- punto 3: la chiusura robusta ----

/**
 * Il sollecito dell'UNICA chiamata di recupero del figlio che finisce il turno
 * senza wake_parent: i tool sono ristretti a wake_parent.
 */
export const SUBAGENT_RECOVERY_NUDGE =
  'Non hai consegnato al padre: chiama ORA wake_parent con status ("done" o "failed") e un summary condensato del risultato (solo quello, nessun altro tool).'

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
  return [text, `(scaduto dopo ${minutes} minuti)`].filter((l) => l).join('\n')
}
