// Layer LLM (fase 18a): il contratto del loop e la delega all'adattatore
// @earendil-works/pi-ai (llm-pi.ts, l'unico file che importa la libreria).
// Il loop non si accorge del cambio: LlmStream, LlmChunk, ChatMessage e
// ToolDef restano identici, le protezioni (recupero e sollecito, scadenza
// dello stream, riserva, cicli, gate) restano nel loop. Qui vivono anche la
// traccia diagnostica (solo numeri, mai contenuti né chiavi) e
// mergeToolCallDeltas, che i test usano ancora.
import type { ProviderConfig } from '../../shared/types'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../store/db'
import { piLlmStream } from './llm-pi'

// ---- fase 11 (residuo 0a): traccia diagnostica delle chiamate ----

/**
 * I numeri di una chiamata completata (MAI il contenuto dei messaggi, mai
 * segreti). Fase velocità (S1): in più turnId/callIndex (quale chiamata di
 * quale turno), i tempi (primo token, totale), i byte sul filo (strumenti,
 * sistema, messaggi: lunghezze serializzate, mai il testo), cosa è partito
 * per il ragionamento (thinkingSent: il valore di reasoning_effort o null),
 * l'hash corto della sessione (S4) e cacheRead/cacheWrite dell'usage.
 */
export interface LlmTraceRecord {
  at: string
  model: string
  finishReason: string
  contentLength: number
  reasoningLength: number
  toolCalls: number
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null
  /** fase velocità (S1): il turno e l'indice della chiamata nel turno (null per le chiamate fuori turno: compaction, revisore) */
  turnId?: string | null
  callIndex?: number | null
  /** ms dall'invio al primo chunk (testo o ragionamento) */
  firstTokenMs?: number | null
  /** ms dall'invio alla fine */
  totalMs?: number | null
  /** ms al primo chunk QUANDO è ragionamento (il modello ragiona prima di rispondere) */
  reasoningFirstMs?: number | null
  /** quanti strumenti e quanti byte di JSON.stringify(schemi) sono partiti */
  toolsCount?: number
  toolsBytes?: number
  /** lunghezza serializzata del prompt di sistema e dei messaggi (non il contenuto) */
  systemBytes?: number
  messagesBytes?: number
  /** cosa è partito sul filo per il ragionamento: il valore di reasoning_effort, null se nessuna opzione */
  thinkingSent?: string | null
  /** fase velocità (S4): hash di 8 caratteri del sessionId (mai l'id vero) */
  sessionHash?: string | null
}

/**
 * Con SANDBOT_LLM_TRACE=1 appende una riga JSON in <directory dati>/llm-trace.jsonl
 * per OGNI chiamata completata: modello, finish_reason, lunghezza del content,
 * lunghezza del ragionamento, numero di tool call e usage. Serve a diagnosticare
 * le risposte vuote dei modelli cloud col contesto lungo (indagine 0a): mai il
 * contenuto dei messaggi, mai chiavi o token.
 */
export function traceLlmCall(rec: LlmTraceRecord): void {
  if (process.env.SANDBOT_LLM_TRACE !== '1') return
  try {
    appendFileSync(join(dataDir(), 'llm-trace.jsonl'), JSON.stringify(rec) + '\n')
  } catch {
    // directory dati non disponibile (es. harness senza store): traccia persa, la chiamata resta
  }
}

// ---- formato interno unificato ----
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}

export interface ToolCall {
  id: string
  name: string
  arguments: string // JSON serializzato
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string // per role 'tool'
  images?: string[]   // base64 (png/jpeg/gif/webp) per modelli vision
}

export interface LlmChunk {
  textDelta?: string
  reasoningDelta?: string  // thinking/reasoning token (modelli reasoning)
  toolCalls?: ToolCall[]      // completi alla fine dello streaming
  finishReason?: string
  /** Fase 18a (E4): i numeri dell'ultima chiamata, per l'uso registrato. */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUsd: number | null }
}

export interface LlmStream extends AsyncIterable<LlmChunk> {
  // consuma tutto e restituisce il testo completo + tool calls
  // (fase 18a: anche l'usage dell'ultima chiamata, per l'uso registrato)
  drain(): Promise<{ text: string; toolCalls: ToolCall[]; finishReason: string; usage?: LlmChunk['usage'] }>
}

// ---- accumulo dei tool-call in streaming (§5.4) ----

/** Delta di un tool-call nello streaming OpenAI-compatible. */
export interface ToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

/**
 * Accumula i delta dei tool-call PER INDICE (puro, testabile): itera TUTTI i
 * delta del chunk (non solo il primo), gestendo più tool call nello stesso
 * chunk e argomenti frammentati su più chunk. Restituisce gli accumulatori
 * ordinati per indice.
 */
export function mergeToolCallDeltas(
  acc: Map<number, ToolCallAccumulator>,
  deltas: readonly ToolCallDelta[]
): ToolCallAccumulator[] {
  for (const d of deltas) {
    const idx = d.index ?? 0
    const slot = acc.get(idx) ?? { id: `call_${idx}`, name: '', args: '' }
    if (d.id) slot.id = d.id
    if (d.function?.name) slot.name += d.function.name
    if (d.function?.arguments) slot.args += d.function.arguments
    acc.set(idx, slot)
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
}

/** Opzioni facoltative dello stream (fase 8: temperatura 0 per il revisore delle approvazioni). */
export interface StreamOptions {
  temperature?: number
  /**
   * Fase 18b (H3): livello di ragionamento del bot/routine. 'default' o
   * assente = il comportamento della 18a ESATTO; l'adattatore clampa sul
   * modello vero di QUESTA chiamata (la riserva che cambia modello si ri-clampa).
   */
  thinking?: import('../../shared/types').ThinkingSetting
  /**
   * Fase 18b (H1.3): il setting providers.modelPrices, passato dal CHIAMANTE
   * (il loop legge lo store, l'adattatore no: nessun ciclo di import). Il
   * prezzo si registra al momento della chiamata: cambiarlo non riscrive lo storico.
   */
  modelPrices?: import('../../shared/types').ModelPriceMap
  /**
   * Fase 18b (K6): retry di trasporto dell'SDK dentro pi-ai. Il loop lo mette
   * a 0 quando dopo l'anello attivo c'è ancora una riserva utilizzabile: il
   * passaggio d'anello sostituisce il retry (l'SDK rispetta retry-after fino
   * a 60 s e il turno aspetterebbe fino a ~2 minuti su un provider senza
   * quota). Assente = 2, come sempre. NON va mai sul filo: è un'opzione
   * dell'SDK, non un campo del body.
   */
  maxRetries?: number
  /**
   * Fase velocità (S1): il turno e l'indice della chiamata nel turno, per la
   * traccia (solo numeri e nomi). Assente = chiamata fuori turno
   * (compaction, revisore): turnId nullo nella traccia.
   */
  trace?: { turnId: string; callIndex: number }
  /**
   * Fase velocità (S4): chiave di affinità/cache di pi-ai, STABILE per tutte
   * le chiamate della stessa conversazione (prompt cache dei provider). Non
   * impostare cacheRetention: pi-ai ha già «short» come predefinito.
   */
  sessionId?: string
}

/**
 * Crea uno stream LLM dal provider indicato. Fase 18a: l'interno è
 * @earendil-works/pi-ai (llm-pi.ts); il contratto e i chiamanti non cambiano.
 */
export function llmStream(
  p: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  opts: StreamOptions = {}
): LlmStream {
  return piLlmStream(p, model, messages, tools, signal, opts)
}

// ---- re-esportazioni utili dell'adattatore (per i chiamanti e i test) ----
export { LlmProviderError, PiUserAbortError, modelCapabilities, catalogModelInfos, type ModelCapabilities } from './llm-pi'
