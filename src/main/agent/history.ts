// Cronologia del modello (§5.3) — modulo PURO (nessun import Electron):
// stesso input → stesso output, testabile in nodo puro con vitest.
//
// Invarianti:
// - [system, ...history] in ordine cronologico, il messaggio utente corrente
//   compare UNA volta sola (è l'ultimo entry del transcript passato in input)
// - le immagini dell'utente si attaccano all'ULTIMO messaggio utente
// - il taglio avviene solo a confine di turno (un messaggio utente inizia un
//   turno): mai un tool-result senza la sua tool-call, mai una tool-call senza
//   result (in quel caso si aggiunge un result sintetico "interrupted")
//
// Fase 3 (§3bis L2): l'agente parla SOLO tramite tool. Le entry 'send-message'
// tornano al modello come tool call + tool result (il modello vede COSA ha
// detto all'utente, non un testo assistant); le entry 'thinking' (testo libero
// generato dal modello) tornano come contenuto assistant.
//
// U4 (fase pulizia · ritocchi): ogni messaggio utente comincia con la sua
// ora di invio («[Sent: Friday, 2026-11-06 15:30 (Europe/Rome)]», una riga
// vuota, poi il testo), dal createdAt GIÀ salvato dell'entry: lo stesso
// messaggio dà sempre lo stesso testo, il prefisso resta identico fra i turni
// e la cache del provider tiene. Il riassunto della compattazione non lo
// riceve; le entry non cambiano (il timbro vive solo nel contenuto per il
// modello, mai nella storia salvata né in chat).
import type { ChatMessage } from './llm'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../shared/types'
// fase 9 (punto 0b): il result di una send di testo riporta l'inizio del testo
import { deliveredResultText } from './turn-sends'
import { systemTimeZone, withSentStamp } from './current-time'

const DEFAULT_MAX_MESSAGES = 40

/** meta.message di una entry send-message, se presente e ben formata. */
function payloadOf(e: TranscriptEntry): SendMessageMeta | null {
  if (e.kind !== 'send-message' || !e.meta) return null
  const m = e.meta as Partial<SendMessageMeta>
  return m.message ? (m as SendMessageMeta) : null
}

/** La tool-call che ha prodotto la entry send-message (meta.call, con ripiego sul payload). */
export function sendCallOf(e: TranscriptEntry): { name: string; arguments: string } {
  const m = payloadOf(e)
  if (m?.call) return { name: m.call.name, arguments: m.call.arguments }
  const p = m?.message
  if (p?.type === 'widget') return { name: 'ask_user', arguments: JSON.stringify(p) }
  if (p?.type === 'draft') return { name: 'draft_external', arguments: JSON.stringify(p) }
  // fase 8: i payload task/rule tornano col tool CHE LI HA CREATI (non come
  // send_to_user con argomenti fuori schema: certi modelli rispondono vuoto)
  if (p?.type === 'task') return { name: 'create_task', arguments: JSON.stringify({ title: p.title, brief: p.title }) }
  if (p?.type === 'rule') return { name: 'propose_rule_change', arguments: JSON.stringify({ kind: p.kind, text: p.text, ...(p.why !== undefined ? { why: p.why } : {}) }) }
  return { name: 'send_to_user', arguments: JSON.stringify({ text: e.content }) }
}

/**
 * Fase risposta (R9): una send-message di TESTO torna al modello come TESTO
 * assistant — la risposta finale (meta.final), i ripieghi e le vecchie send
 * prodotte da send_to_user in chat privata. Restano coppie chiamata/risultato
 * solo message_user (meta.call.name) e le send dei turni di GRUPPO
 * (meta.groupChain); le deleghe send_to_agent (meta.agentSend) restano
 * coppie come oggi (il loro result è l'esito della coda, non «consegnato»).
 */
function textSendAsAssistantText(e: TranscriptEntry): boolean {
  const m = payloadOf(e)
  if (!m) return false
  const p = m.message
  if (p?.type !== 'text') return false
  if (m.agentSend) return false
  // correzione C3: le send dei turni di gruppo portano la catena in meta
  if ((e.meta as { groupChain?: unknown } | null)?.groupChain) return false
  // message_user resta coppia chiamata/risultato (è un tool vero); le send
  // senza call (finali, ripieghi) e le vecchie send_to_user in privato sono
  // testo assistant
  return m.call === undefined || m.call.name === 'send_to_user'
}

/** Il tool result che il modello vede per una send-message: cosa sa l'utente e come è finita. */
export function sendResultText(e: TranscriptEntry): string {
  const m = payloadOf(e)
  const p = m?.message
  // fase 7 (correzione A2): la delega a un altro bot NON è "inviato all'utente":
  // il turno successivo trova la coppia chiamata/risultato con l'esito della coda
  if (m?.agentSend) {
    return `message queued for ${m.toAgentName ?? 'another bot'} (hop ${m.hop ?? 1}): the other bot does not see this conversation`
  }
  if (m && p?.type === 'widget') {
    if (m.respondedValue !== undefined) return `the user answered: ${JSON.stringify(m.respondedValue)}`
    if (m.widgetDismissed) return "widget shown to the user, then dismissed: the user moved on without answering"
    return "widget shown to the user: turn ended awaiting the answer"
  }
  if (m && p?.type === 'draft') {
    if (m.status === 'sent') return "draft sent by the user who confirmed it"
    if (m.status === 'discarded') return "draft discarded by the user"
    return "draft created and shown to the user: it will be sent only if the user confirms"
  }
  // fase risposta (R9): il result ESATTO che il modello ha visto nel turno,
  // quando la consegna l'ha salvato (message_user: tetto dei 500 caratteri e
  // trattenute dichiarate) — la storia ricostruita resta identica a quella
  // letta, anche se la funzione dovesse cambiare
  if (typeof m?.resultText === 'string') return m.resultText
  // fase 9 (punto 0b): per le send di TESTO il result riporta l'inizio di ciò
  // che l'utente ha ricevuto — il modello può verificare che è arrivato intero
  // (il bug dei messaggi multipli nasceva da un result senza riscontro);
  // held = entry trattenuta nell'outbox di un turno automatico (fase 6)
  return deliveredResultText(e.content, { held: m?.held === true })
}

/**
 * Fase 16b correzioni (P1): la event discreta del riepilogo di chiusura nella
 * chat privata del coordinatore (meta.summaryMessageId numerico + meta.call
 * valida) — per il modello è una send_to_user: torna {call, resultText} se la
 * entry deve entrare nella storia, null altrimenti (tutte le altre event e le
 * righe scritte prima della correzione restano fuori, come sempre).
 */
function summaryEventOf(e: TranscriptEntry): { call: { name: string; arguments: string }; resultText: string } | null {
  if (e.kind !== 'event' || typeof e.meta?.summaryMessageId !== 'number' || !e.meta.call) return null
  const c = e.meta.call as { name?: unknown; arguments?: unknown }
  if (typeof c.name !== 'string' || !c.name || typeof c.arguments !== 'string') return null
  if (typeof e.meta.resultText !== 'string') return null
  return { call: { name: c.name, arguments: c.arguments }, resultText: e.meta.resultText }
}

/** entries → messaggi: i tool-call si aggregano al messaggio assistant, i result diventano messaggi tool. */
function toMessages(entries: TranscriptEntry[], timeZone: string): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const e of entries) {
    if (e.kind === 'message') {
      // residuo fase 2a: un assistant vuoto (stream interrotto da crash/errore
      // prima di qualsiasi token) non deve mai arrivare al modello — Anthropic
      // e altri provider rifiutano i blocchi di testo vuoti. Se la risposta
      // conteneva tool call, le entry tool-call seguenti si aggregano da sole
      // in un assistant con sole chiamate (contenuto testo assente).
      if (e.role === 'assistant' && !e.content.trim()) continue
      // U4: utente, [sistema], messaggi da altri bot e aperture delle routine
      // portano l'ora di invio della LORO entry, sempre la stessa
      msgs.push(e.role === 'user'
        ? { role: 'user', content: withSentStamp(e.content, e.createdAt, timeZone) }
        : { role: 'assistant', content: e.content })
    } else if (e.kind === 'thinking') {
      // fase 3: il testo libero del modello è ragionamento interno — resta
      // contenuto assistant per il modello, MAI visibile all'utente in chat
      if (e.content.trim()) msgs.push({ role: 'assistant', content: e.content })
    } else if (e.kind === 'send-message') {
      // fase 3 (§3bis L2) → fase risposta (R9): le send di TESTO tornano al
      // modello come TESTO assistant (la risposta finale, i ripieghi e le
      // vecchie send_to_user delle chat private: il modello non vede mai lo
      // schema vecchio da abbandonare). Le altre (widget, bozze, card,
      // message_user, le send dei gruppi e le deleghe) restano coppie
      // chiamata/risultato, come sempre
      if (textSendAsAssistantText(e)) {
        if (e.content.trim()) msgs.push({ role: 'assistant', content: e.content })
      } else {
        const call = { id: `send_${e.id}`, ...sendCallOf(e) }
        const prev = msgs[msgs.length - 1]
        if (prev && prev.role === 'assistant') {
          prev.toolCalls = [...(prev.toolCalls ?? []), call]
        } else {
          msgs.push({ role: 'assistant', content: '', toolCalls: [call] })
        }
        msgs.push({ role: 'tool', toolCallId: call.id, content: sendResultText(e) })
      }
    } else if (e.kind === 'event' && summaryEventOf(e)) {
      // fase 16b correzioni (P1): il riepilogo di chiusura del coordinatore è
      // una event discreta nella SUA chat privata, ma il modello l'ha detto
      // con send_to_user — la storia ricostruisce la coppia chiamata/risultato
      // col result IDENTICO a quello visto nel turno (meta.resultText, salvato
      // alla consegna). Le altre event restano fuori.
      const s = summaryEventOf(e)!
      const call = { id: `send_${e.id}`, name: s.call.name, arguments: s.call.arguments }
      const prev = msgs[msgs.length - 1]
      if (prev && prev.role === 'assistant') {
        prev.toolCalls = [...(prev.toolCalls ?? []), call]
      } else {
        msgs.push({ role: 'assistant', content: '', toolCalls: [call] })
      }
      msgs.push({ role: 'tool', toolCallId: call.id, content: s.resultText })
    } else if (e.kind === 'summary') {
      // fase 4: riepilogo dei turni più vecchi (compaction) — entra come
      // messaggio utente di contesto al posto delle entry che copre
      if (e.content.trim()) msgs.push({ role: 'user', content: `[summary of the previous turns]\n${e.content}` })
    } else if (e.kind === 'tool-call') {
      const prev = msgs[msgs.length - 1]
      const call = { id: String(e.meta?.id ?? e.id), name: String(e.meta?.name ?? ''), arguments: String(e.meta?.arguments ?? '{}') }
      if (prev && prev.role === 'assistant') {
        prev.toolCalls = [...(prev.toolCalls ?? []), call]
      } else {
        msgs.push({ role: 'assistant', content: '', toolCalls: [call] })
      }
    } else if (e.kind === 'tool-result') {
      msgs.push({ role: 'tool', toolCallId: String(e.meta?.callId ?? ''), content: e.content })
    }
    // notice/approval/event non entrano nella storia del modello — tranne la
    // event del riepilogo di chiusura, gestita sopra (P1, fase 16b correzioni)
  }
  return msgs
}

/** Taglia rispettando i confini di turno: il suffix conservato parte da un messaggio utente. */
function trimToTurnBoundary(msgs: ChatMessage[], max: number): ChatMessage[] {
  if (msgs.length <= max) return msgs
  const firstAllowed = msgs.length - max
  for (let i = firstAllowed; i < msgs.length; i++) {
    if (msgs[i].role === 'user') return msgs.slice(i)
  }
  // nessun confine disponibile nel budget: mantiene il budget, il repair sotto
  // sistemera' gli orfani eventuali
  return msgs.slice(firstAllowed)
}

/**
 * Ripara le coppie tool orfane dopo il taglio (o dopo un interrupt):
 * - tool-result la cui tool-call è stata tagliata → scartato
 * - tool-call rimasta senza result → result sintetico "interrupted"
 */
function repairToolPairs(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role === 'tool') {
      const callSeen = msgs.slice(0, i).some(
        (x) => x.role === 'assistant' && x.toolCalls?.some((tc) => tc.id === m.toolCallId)
      )
      if (!callSeen) continue // result orfano: la sua call è fuori dal taglio
      out.push(m)
      continue
    }
    out.push(m)
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // result che seguono subito la chiamata, prima del prossimo messaggio non-tool
      const answered = new Set<string>()
      let j = i + 1
      while (j < msgs.length && msgs[j].role === 'tool') {
        answered.add(msgs[j].toolCallId ?? '')
        j++
      }
      for (const tc of m.toolCalls) {
        if (!answered.has(tc.id)) out.push({ role: 'tool', toolCallId: tc.id, content: 'interrupted' })
      }
    }
  }
  return out
}

export interface BuildMessagesOptions {
  /** Budget massimo di messaggi di storia (escluso il system). */
  maxMessages?: number
  /** U4: il fuso dei timbri [Sent: …]; di default quello del sistema (UTC se non valido). */
  timeZone?: string | null
}

/**
 * Costruisce i messaggi per il modello a partire dal transcript (che INCLUDE
 * già il messaggio utente corrente come ultimo entry). Funzione pura: non
 * modifica gli input.
 */
export function buildMessages(
  system: string,
  entries: TranscriptEntry[],
  currentImages?: string[],
  opts: BuildMessagesOptions = {}
): ChatMessage[] {
  const max = opts.maxMessages ?? DEFAULT_MAX_MESSAGES
  const timeZone = opts.timeZone === undefined ? systemTimeZone() : (opts.timeZone ?? 'UTC')
  // fase 4: l'entry summary più recente SOSTITUISCE i turni che copre
  // (meta.coversUpTo) — le entry restano nel DB, ma al modello non arrivano
  let effective = entries
  for (let i = entries.length - 1; i >= 0; i--) {
    const s = entries[i]!
    if (s.kind === 'summary' && typeof s.meta?.coversUpTo === 'number') {
      effective = entries.filter((e) => e.id > (s.meta!.coversUpTo as number) || e.id === s.id)
      break
    }
  }
  let msgs = toMessages(effective, timeZone)
  msgs = trimToTurnBoundary(msgs, max)
  msgs = repairToolPairs(msgs)
  // le immagini vanno all'ULTIMO messaggio utente (quello corrente)
  if (currentImages?.length) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        msgs[i] = { ...msgs[i], images: [...(msgs[i].images ?? []), ...currentImages] }
        break
      }
    }
  }
  return [{ role: 'system', content: system }, ...msgs]
}

/**
 * Fase 3 (§3bis L2): estrae i messaggi che l'utente VEDE in chat da una
 * sequenza di entry — solo le 'send-message' (text/widget/draft), MAI il
 * testo libero del modello (kind 'thinking'). `sinceId` limita al turno
 * corrente (le entry successive a quella che lo ha aperto).
 * Fase 8 (residuo 0a): le deleghe send_to_agent (meta.agentSend, "A <nome
 * bot>") NON sono messaggi all'utente — non contano come risposta visibile
 * e non producono notifiche agent-done di un turno che ha solo delegato.
 */
export function visibleReplyEntries(entries: TranscriptEntry[], sinceId = 0): TranscriptEntry[] {
  return entries.filter((e) => e.id > sinceId && e.kind === 'send-message' && !(e.meta as Partial<SendMessageMeta> | null)?.agentSend)
}
