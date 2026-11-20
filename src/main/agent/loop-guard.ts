// Protezioni e stato live del turno (fase 8, §3bis L7/L11) — modulo PURO:
// l'attività corrente del bot (nome tool + target, senza testo generato dal
// modello) e la loop detection (la stessa tool call ripetuta 3 volte di fila).
// Il nome del tool e il target arrivano dagli ARGOMENTI della chiamata, mai
// dall'output del modello: la sidebar mostra "sta facendo X…" senza rischio
// di mostrare testo iniettato.
import { createHash } from 'node:crypto'

/** Comando abbreviato su una riga (per la sidebar). */
export function abbreviateCommand(cmd: string, max = 48): string {
  const one = cmd.trim().split('\n')[0] ?? ''
  return one.length > max ? one.slice(0, max) + '…' : one
}

/**
 * L'attività corrente (§3bis L7): nome del tool e target leggibile —
 * path per i file, comando abbreviato per la shell, nome del connettore
 * per i tool MCP, il nome del tool altrimenti.
 */
export function activityOf(
  tool: string,
  input: Record<string, unknown>,
  serverName?: string
): { tool: string; target: string; app?: string; args?: string } {
  let target = ''
  let args: string | undefined
  let app: string | undefined
  if (tool === 'run-command') target = abbreviateCommand(String(input.command ?? ''))
  else if (tool === 'read-file' || tool === 'write-file' || tool === 'list-directory') target = String(input.path ?? '')
  else if (tool.startsWith('mcp__')) {
    target = tool.split('__')[1] ?? tool
    app = serverName
    // V5 (prova vera): gli argomenti COMPATTI degli strumenti meta di Composio
    // (SOLO i nomi delle azioni e dei toolkit, mai i valori: destinatari e
    // testi non si mostrano) — così la mascotte dice «usa Gmail · Elenca email…»
    const original = tool.split('__').slice(2).join('__')
    if (original === 'COMPOSIO_MULTI_EXECUTE_TOOL' && Array.isArray(input.tools)) {
      const slugs = input.tools
        .map((t) => (t && typeof t === 'object' ? String((t as { tool_slug?: unknown }).tool_slug ?? '') : ''))
        .filter(Boolean)
      if (slugs.length > 0) args = JSON.stringify({ tools: slugs.map((x) => ({ tool_slug: x })) })
    } else if (original === 'COMPOSIO_MANAGE_CONNECTIONS' && Array.isArray(input.toolkits)) {
      const entries = input.toolkits
        .map((t) => (t && typeof t === 'object'
          ? { name: String((t as { name?: unknown }).name ?? ''), action: String((t as { action?: unknown }).action ?? 'add') }
          : null))
        .filter((t): t is { name: string; action: string } => !!t)
      if (entries.length > 0) args = JSON.stringify({ toolkits: entries })
    }
  }
  else if (tool === 'use-app') target = String(input.action ?? '')
  // fase 16b correzioni (P2): anche web_fetch porta l'URL letto — la mascotte
  // dice «legge <host>…» invece della pagina web generica
  else if (tool === 'web_fetch') target = String(input.url ?? '')
  // fase chat-limiti (CL3): quante foto — gli url NON si mostrano (la
  // sidebar dice «mostra 3 foto…», senza testo dal web)
  else if (tool === 'show_images') target = `${(Array.isArray(input.urls) ? input.urls.length : 0) + (Array.isArray(input.paths) ? input.paths.length : 0)} foto`
  // fase 11b: il browser — l'URL per l'apertura, il ref per le azioni
  else if (tool === 'browser_open') target = String(input.url ?? '')
  else if (tool.startsWith('browser_')) target = String(input.ref ?? '')
  // fase 19a: lo schermo del bot — il motivo della richiesta, il numero di azioni
  else if (tool === 'request_takeover') target = abbreviateCommand(String(input.reason ?? ''))
  else if (tool === 'computer_act') target = `${Array.isArray(input.actions) ? input.actions.length : 0} actions`
  return { tool, target, ...(app ? { app } : {}), ...(args ? { args } : {}) }
}

/**
 * La chiave di ripetizione di una chiamata (pura). Fase 19a (V6): per
 * computer_act la chiave è l'HASH delle azioni — ripetere le STESSE azioni
 * con formattazione diversa (spazi, observe, chiavi in altro ordine dentro
 * gli oggetti è già normalizzato da JSON.stringify) con lo schermo che non
 * cambia è comunque la stessa chiamata; la regola resta quella delle altre
 * ripetizioni (3 di fila fermano il turno).
 */
export function repeatKeyOf(name: string, args: string): string {
  if (name !== 'computer_act') return `${name}\u0000${args}`
  try {
    const parsed = JSON.parse(args || '{}') as { actions?: unknown }
    return `computer_act\u0000${createHash('sha256').update(JSON.stringify(parsed.actions ?? null)).digest('hex')}`
  } catch {
    return `${name}\u0000${args}`
  }
}

// ---- SV7 (fase schermo-vivo): la serie con i RISULTATI, come Rakazo ----
//
// La vecchia loop detection guardava SOLO gli argomenti PRIMA della chiamata:
// fermava chi aspettava legittimamente una pagina con chiamate identiche che
// davano risultati diversi, e non riconosceva chi girava a vuoto con chiamate
// un po' diverse. Qui la serie si traccia DOPO il risultato, con l'impronta
// del risultato (per lo schermo il FRAME, non il testo con l'ora): il
// controllo è PURO e le soglie sono ESPORtate (i perché nel REPORT).

/** Quante chiamate identiche FALLITE di fila fermano il turno. */
export const IDENTICAL_FAILING_STOP = 3

/** Quante chiamate identiche con la STESSA risposta riuscita di fila fermano. */
export const IDENTICAL_NO_PROGRESS_STOP = 6

/** Quante chiamate identiche con risposte diverse, o quasi-uguali (solo cifre), fermano. */
export const SIMILAR_STOP = 25

/** Quante volte di fila lo STESSO strumento risponde uguale qualunque input fermano. */
export const SAME_RESULT_STOP = 25

/** Quanti lotti computer_act oltre il limite rifiutati di fila fermano. */
export const OVER_LIMIT_ACTIONS_STOP = 4

/**
 * Gli strumenti di ATTESA: aspettare è il loro mestiere — la stessa risposta
 * riuscita NON è mancanza di progresso per loro, contano solo nella serie
 * «simili» (la chiamata identica con la stessa risposta resta legittima).
 */
const WAIT_TOOLS = new Set(['await_shell', 'browser_wait'])

/** Il tipo di fermata della serie (il summary del figlio lo nomina). */
export type ToolStreakStop =
  | 'identical-failing'
  | 'identical-no-progress'
  | 'similar'
  | 'same-result'
  | 'over-limit-actions'

/** Lo stato della serie di un turno (opaco: si porta in giro e si passa indietro). */
export interface ToolStreakState {
  key: string | null
  keyFailing: number
  keySameOk: number
  shape: string | null
  similar: number
  tool: string | null
  toolFingerprint: string | null
  toolSameFingerprint: number
  overLimit: number
}

/** La serie all'inizio del turno. */
export function initialToolStreakState(): ToolStreakState {
  return {
    key: null,
    keyFailing: 0,
    keySameOk: 0,
    shape: null,
    similar: 0,
    tool: null,
    toolFingerprint: null,
    toolSameFingerprint: 0,
    overLimit: 0
  }
}

/**
 * La chiave «SIMILE» (come `shape` in Rakazo): gli argomenti con le sequenze
 * di cifre sostituite — sfogliare pagine o leggere a pezzi cambia solo i
 * numeri. Pura.
 */
export function shapeKeyOf(name: string, args: string): string {
  return repeatKeyOf(name, args.replace(/\d+/g, '#'))
}

/**
 * Il contenuto di un result visto dal modello SENZA tempi e durate (pura):
 * i timestamp e le durate cambiano a ogni chiamata anche quando tutto il
 * resto è identico, e non sono progresso.
 */
export function normalizeResultForFingerprint(content: string): string {
  return content
    // timestamp ISO e orari
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '#TIME')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '#TIME')
    // durate: 12 ms, 1.5s, 3 sec, 2 minutes…
    .replace(/\b\d+(\.\d+)?\s*(ms|millisecond[is]o?|s|sec|seconds?|secondi|min|minutes?|minuti)\b/gi, '#DUR')
}

/** L'impronta del result (pura): hash del contenuto normalizzato. */
export function toolResultFingerprint(content: string): string {
  return createHash('sha256').update(normalizeResultForFingerprint(content)).digest('hex')
}

/** La chiamata tracciata (nome + argomenti come arrivano dal modello). */
export interface TrackedToolCall {
  name: string
  args: string
}

/** Il risultato tracciato: impronta, esito e l'eventuale lotto rifiutato. */
export interface TrackedToolResult {
  fingerprint: string
  failed: boolean
  /** computer_act oltre COMPUTER_ACTIONS_MAX: il rifiuto c'è già, si CONTA */
  overLimit?: boolean
  /**
   * T1 (fase web-strategia): questo result porta le NOVITÀ di un figlio
   * (check_subagent che torna perché il figlio è AVANZATO) — l'attesa su un
   * figlio che fa progressi non è «la stessa azione ripetuta»: la serie
   * «simile» si azzera. Conta solo se il figlio è fermo.
   */
  progress?: boolean
}

/**
 * UN passo della serie (PURA): registra la chiamata con il SUO risultato e
 * dice se la serie ha passato una soglia. Il controllo sta DOPO il risultato:
 * la chiamata che fa scattare la soglia è già stata eseguita — la successiva
 * non parte. Le soglie e i loro perché stanno sopra (e nel REPORT).
 */
export function trackToolStreak(
  state: ToolStreakState,
  call: TrackedToolCall,
  result: TrackedToolResult
): { state: ToolStreakState; stop: ToolStreakStop | null } {
  const s: ToolStreakState = { ...state }
  const key = repeatKeyOf(call.name, call.args)
  const shape = shapeKeyOf(call.name, call.args)
  const sameKey = key === s.key
  const sameShape = shape === s.shape
  // quando più soglie passano nello stesso passo vince la più SPECIFICA
  // (il lotto rifiutato è un segnale più netto di «identica che fallisce»,
  // la stessa risposta riuscita è più netta di «simili»)
  let stop: ToolStreakStop | null = null

  // lotti computer_act rifiutati DI FILA (il rifiuto esiste già: qui si CONTA)
  if (result.overLimit === true) {
    s.overLimit++
    if (s.overLimit >= OVER_LIMIT_ACTIONS_STOP) stop ??= 'over-limit-actions'
  } else {
    s.overLimit = 0
  }

  // identiche che FALLISCONO di fila (conta la prima della serie)
  if (result.failed) {
    s.keyFailing = sameKey ? s.keyFailing + 1 : 1
    if (s.keyFailing >= IDENTICAL_FAILING_STOP) stop ??= 'identical-failing'
  } else {
    s.keyFailing = 0
    // identiche con la STESSA risposta riuscita di fila (le attese escluse:
    // aspettare è il loro mestiere, restano nella serie «simile»)
    if (WAIT_TOOLS.has(call.name)) {
      s.keySameOk = 0
    } else {
      s.keySameOk = sameKey && result.fingerprint === s.toolFingerprint ? s.keySameOk + 1 : 1
      if (s.keySameOk >= IDENTICAL_NO_PROGRESS_STOP) stop ??= 'identical-no-progress'
    }
  }

  // lo STESSO strumento risponde uguale QUALUNQUE input, di fila (le attese
  // escluse anche qui: la stessa risposta è il loro mestiere)
  if (!result.failed && !WAIT_TOOLS.has(call.name) && call.name === s.tool && result.fingerprint === s.toolFingerprint) {
    s.toolSameFingerprint++
    if (s.toolSameFingerprint >= SAME_RESULT_STOP) stop ??= 'same-result'
  } else {
    s.toolSameFingerprint = 1
  }

  // la serie «simile»: LUNGHEZZA della sequenza di chiamate con la STESSA
  // forma (identiche, o che cambiano solo nei numeri) — conta la prima.
  // T1 (fase web-strategia): un result che porta NOVITÀ di un figlio (le
  // attese di check_subagent su chi avanza) azzera la serie: aspettare un
  // figlio che lavora non è ripetere la stessa azione; conta solo se è fermo
  if (result.progress === true) s.similar = 0
  if (sameShape) s.similar++
  else s.similar = 1
  if (s.similar >= SIMILAR_STOP) stop ??= 'similar'

  s.key = key
  s.shape = shape
  s.tool = call.name
  s.toolFingerprint = result.fingerprint
  return { state: s, stop }
}
/**
 * Correzione C5 (fase 10): il motivo per cui un turno finisce STOPPED per un
 * errore del modello. 429 (o il testo "usage limit"/"rate limit", come scrive
 * Ollama cloud quando la sessione è esaurita) è un limite d'uso del provider:
 * va distinto dagli altri errori perché il gruppo si sospende, non fallisce.
 */
export type ModelStopReason = 'model-error' | 'rate-limit'

export function stopReasonOfError(err: unknown): ModelStopReason {
  const status = (err as { status?: number } | null)?.status
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return status === 429 || /429|usage limit|rate limit/i.test(msg) ? 'rate-limit' : 'model-error'
}
