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
import type { ChatMessage } from './llm'
import type { TranscriptEntry } from '../../shared/types'

const DEFAULT_MAX_MESSAGES = 40

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
  let msgs = toMessages(entries)
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
