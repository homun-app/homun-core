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
import type { ChatMessage } from './llm'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../shared/types'

const DEFAULT_MAX_MESSAGES = 40

/** meta.message di una entry send-message, se presente e ben formata. */
function payloadOf(e: TranscriptEntry): SendMessageMeta | null {
  if (e.kind !== 'send-message' || !e.meta) return null
  const m = e.meta as Partial<SendMessageMeta>
  return m.message ? (m as SendMessageMeta) : null
}

/** La tool-call che ha prodotto la entry send-message (meta.call, con ripiego sul payload). */
function sendCallOf(e: TranscriptEntry): { name: string; arguments: string } {
  const m = payloadOf(e)
  if (m?.call) return { name: m.call.name, arguments: m.call.arguments }
  const p = m?.message
  if (p?.type === 'widget') return { name: 'ask_user', arguments: JSON.stringify(p) }
  if (p?.type === 'draft') return { name: 'draft_external', arguments: JSON.stringify(p) }
  return { name: 'send_to_user', arguments: JSON.stringify({ text: e.content }) }
}

/** Il tool result che il modello vede per una send-message: cosa sa l'utente e come è finita. */
export function sendResultText(e: TranscriptEntry): string {
  const m = payloadOf(e)
  const p = m?.message
  // fase 7 (correzione A2): la delega a un altro bot NON è "inviato all'utente":
  // il turno successivo trova la coppia chiamata/risultato con l'esito della coda
  if (m?.agentSend) {
    return `messaggio in coda per ${m.toAgentName ?? 'un altro bot'} (passaggio ${m.hop ?? 1}): l'altro bot non vede questa conversazione`
  }
  if (m && p?.type === 'widget') {
    if (m.respondedValue !== undefined) return `l'utente ha risposto: ${JSON.stringify(m.respondedValue)}`
    if (m.widgetDismissed) return "widget mostrato all'utente, poi scartato: l'utente ha proseguito senza rispondere"
    return "widget mostrato all'utente: turno terminato in attesa della risposta"
  }
  if (m && p?.type === 'draft') {
    if (m.status === 'sent') return "bozza inviata all'utente che l'ha confermata"
    if (m.status === 'discarded') return "bozza scartata dall'utente"
    return "bozza creata e mostrata all'utente: l'invio avverrà solo se l'utente lo conferma"
  }
  return "inviato all'utente"
}

/** entries → messaggi: i tool-call si aggregano al messaggio assistant, i result diventano messaggi tool. */
function toMessages(entries: TranscriptEntry[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const e of entries) {
    if (e.kind === 'message') {
      // residuo fase 2a: un assistant vuoto (stream interrotto da crash/errore
      // prima di qualsiasi token) non deve mai arrivare al modello — Anthropic
      // e altri provider rifiutano i blocchi di testo vuoti. Se la risposta
      // conteneva tool call, le entry tool-call seguenti si aggregano da sole
      // in un assistant con sole chiamate (contenuto testo assente).
      if (e.role === 'assistant' && !e.content.trim()) continue
      msgs.push({ role: e.role === 'user' ? 'user' : 'assistant', content: e.content })
    } else if (e.kind === 'thinking') {
      // fase 3: il testo libero del modello è ragionamento interno — resta
      // contenuto assistant per il modello, MAI visibile all'utente in chat
      if (e.content.trim()) msgs.push({ role: 'assistant', content: e.content })
    } else if (e.kind === 'send-message') {
      // fase 3 (§3bis L2): ciò che il bot ha detto all'utente torna al modello
      // come tool call + tool result, non come testo assistant
      const call = { id: `send_${e.id}`, ...sendCallOf(e) }
      const prev = msgs[msgs.length - 1]
      if (prev && prev.role === 'assistant') {
        prev.toolCalls = [...(prev.toolCalls ?? []), call]
      } else {
        msgs.push({ role: 'assistant', content: '', toolCalls: [call] })
      }
      msgs.push({ role: 'tool', toolCallId: call.id, content: sendResultText(e) })
    } else if (e.kind === 'summary') {
      // fase 4: riepilogo dei turni più vecchi (compaction) — entra come
      // messaggio utente di contesto al posto delle entry che copre
      if (e.content.trim()) msgs.push({ role: 'user', content: `[riepilogo dei turni precedenti]\n${e.content}` })
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
    // notice/approval/event non entrano nella storia del modello
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
  let msgs = toMessages(effective)
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
 */
export function visibleReplyEntries(entries: TranscriptEntry[], sinceId = 0): TranscriptEntry[] {
  return entries.filter((e) => e.id > sinceId && e.kind === 'send-message')
}
