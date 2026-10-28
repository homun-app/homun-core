// Layer LLM: SDK ufficiali (openai per tutto ciò che è OpenAI-compatible, @anthropic-ai/sdk
// per Anthropic nativo) + normalizzazione in un formato ToolCall interno unico.
// Aggiungere un provider = base URL + API key nella config, zero codice.
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../store/db'
import type { ProviderConfig } from '../../shared/types'

// ---- fase 11 (residuo 0a): traccia diagnostica delle chiamate ----

/** I numeri di una chiamata completata (MAI il contenuto dei messaggi, mai segreti). */
export interface LlmTraceRecord {
  at: string
  model: string
  finishReason: string
  contentLength: number
  reasoningLength: number
  toolCalls: number
  usage: { input: number; output: number } | null
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
  images?: string[]   // base64 PNG (per modelli vision)
}

export interface LlmChunk {
  textDelta?: string
  reasoningDelta?: string  // thinking/reasoning token (modelli reasoning)
  toolCalls?: ToolCall[]      // completi alla fine dello streaming
  finishReason?: string
  usage?: { input: number; output: number }
}

export interface LlmStream extends AsyncIterable<LlmChunk> {
  // consuma tutto e restituisce il testo completo + tool calls
  drain(): Promise<{ text: string; toolCalls: ToolCall[]; finishReason: string }>
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

function openAiClient(p: ProviderConfig): OpenAI {
  return new OpenAI({
    baseURL: p.baseUrl.replace(/\/$/, '') + '/v1',
    apiKey: p.apiKey || 'not-needed',
    dangerouslyAllowBrowser: false
  })
}

function anthropicClient(p: ProviderConfig): Anthropic {
  return new Anthropic({ baseURL: p.baseUrl.replace(/\/$/, ''), apiKey: p.apiKey })
}

// ---- adapter OpenAI-compatible (Ollama, LM Studio, Z.ai, OpenRouter, Mistral, xAI, ...) ----
/** Opzioni facoltative dello stream (fase 8: temperatura 0 per il revisore delle approvazioni). */
export interface StreamOptions {
  temperature?: number
}

function openAiStream(p: ProviderConfig, messages: ChatMessage[], tools: ToolDef[], model: string, signal: AbortSignal, opts: StreamOptions = {}): LlmStream {
  const client = openAiClient(p)
  const oaiMessages = messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments }
        }))
      }
    }
    return { role: m.role as 'system' | 'user' | 'assistant', content: m.content }
  })
  const oaiTools = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
  // messaggi con immagini → content parts (vision, formato OpenAI-compatible)
  const typedMessages = oaiMessages.map((m, i) => {
    const imgs = messages[i].images
    if (!imgs?.length) return m
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text: messages[i].content }]
    for (const img of imgs) {
      parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } })
    }
    return { ...m, content: parts }
  }) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[]

  async function* iterate(): AsyncIterable<LlmChunk> {
    const stream = await client.chat.completions.create(
      { model, messages: typedMessages, tools: oaiTools.length ? oaiTools : undefined, stream: true, stream_options: { include_usage: true }, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) },
      { signal }
    )
    const acc = new Map<number, { id: string; name: string; args: string }>()
    let finish = 'stop'
    // residuo 0a: numeri per la traccia diagnostica (mai il contenuto)
    let contentLen = 0
    let reasoningLen = 0
    let usage: { input: number; output: number } | null = null
    for await (const part of stream) {
      if (part.usage) usage = { input: part.usage.prompt_tokens ?? 0, output: part.usage.completion_tokens ?? 0 }
      const c = part.choices?.[0]
      if (!c) continue
      if (c.delta?.content) { contentLen += c.delta.content.length; yield { textDelta: c.delta.content } }
      // modelli reasoning (Ollama/DeepSeek/QwQ): thinking in delta.reasoning o reasoning_content
      const reasoning = (c.delta as unknown as { reasoning?: string; reasoning_content?: string }).reasoning
        ?? (c.delta as unknown as { reasoning_content?: string }).reasoning_content
      if (reasoning) { reasoningLen += reasoning.length; yield { reasoningDelta: reasoning } }
      // §5.4: itera TUTTI i delta del chunk, accumulando per index
      if (c.delta?.tool_calls?.length) {
        mergeToolCallDeltas(acc, c.delta.tool_calls as ToolCallDelta[])
      }
      if (c.finish_reason) finish = c.finish_reason
    }
    const ordered = mergeToolCallDeltas(acc, [])
    const toolCalls = ordered.map((v) => ({ id: v.id, name: v.name, arguments: v.args }))
    traceLlmCall({ at: new Date().toISOString(), model, finishReason: finish, contentLength: contentLen, reasoningLength: reasoningLen, toolCalls: toolCalls.length, usage })
    yield { toolCalls: toolCalls.length ? toolCalls : undefined, finishReason: finish }
  }

  const iterable = iterate()
  return {
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
    async drain() {
      let text = ''
      let toolCalls: ToolCall[] = []
      let finishReason = 'stop'
      for await (const ch of iterable) {
        if (ch.textDelta) text += ch.textDelta
        if (ch.toolCalls) toolCalls = ch.toolCalls
        if (ch.finishReason) finishReason = ch.finishReason
      }
      return { text, toolCalls, finishReason }
    }
  }
}

// ---- adapter Anthropic nativo ----

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export interface AnthropicMessage { role: 'user' | 'assistant'; content: AnthropicBlock[] }

/**
 * Converte il formato interno in blocchi content Anthropic (puro, testabile).
 * Residuo fase 2a: MAI blocchi text vuoti o di soli spazi — un assistant con
 * sole tool call ha solo blocchi tool_use, e un messaggio che resterebbe senza
 * alcun blocco viene scartato (Anthropic rifiuta i blocchi di testo vuoti).
 */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const aMsgs: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue // il system prompt viaggia nel campo dedicato
    if (m.role === 'tool') {
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: m.toolCallId!, content: m.content }
      const last = aMsgs[aMsgs.length - 1]
      if (last?.role === 'user') last.content.push(block)
      else aMsgs.push({ role: 'user', content: [block] })
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: AnthropicBlock[] = []
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeParse(tc.arguments) })
      }
      aMsgs.push({ role: 'assistant', content: blocks })
      continue
    }
    const blocks: AnthropicBlock[] = []
    if (m.content.trim()) blocks.push({ type: 'text', text: m.content })
    for (const img of m.images ?? []) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } })
    }
    // residuo 2a: mai un messaggio con zero blocchi (testo vuoto e niente altro)
    if (!blocks.length) continue
    aMsgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: blocks })
  }
  return aMsgs
}

function anthropicStream(p: ProviderConfig, messages: ChatMessage[], tools: ToolDef[], model: string, signal: AbortSignal, opts: StreamOptions = {}): LlmStream {
  const client = anthropicClient(p)
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const aMsgs = toAnthropicMessages(messages)
  const aTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema
  }))

  async function* iterate(): AsyncIterable<LlmChunk> {
    const stream = client.messages.stream(
      {
        model,
        system: system || undefined,
        // i blocchi image hanno media_type letterale nell'SDK: il formato interno è più lasco
        messages: aMsgs as unknown as Anthropic.MessageParam[],
        tools: aTools.length ? aTools : undefined,
        max_tokens: 8192,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})
      },
      { signal }
    )
    let finish = 'stop'
    const toolCalls: ToolCall[] = []
    // residuo 0a: numeri per la traccia diagnostica (mai il contenuto)
    let contentLen = 0
    let reasoningLen = 0
    let usage: { input: number; output: number } | null = null
    for await (const event of stream) {
      if (event.type === 'message_start') {
        usage = { input: event.message.usage?.input_tokens ?? 0, output: event.message.usage?.output_tokens ?? 0 }
      }
      if (event.type === 'message_delta') {
        if (event.usage?.output_tokens !== undefined) usage = { input: usage?.input ?? 0, output: event.usage.output_tokens }
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        contentLen += event.delta.text.length
        yield { textDelta: event.delta.text }
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolCalls.push({ id: event.content_block.id, name: event.content_block.name, arguments: '' })
      } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        const last = toolCalls[toolCalls.length - 1]
        if (last) last.arguments += event.delta.partial_json
      } else if (event.type === 'message_delta') {
        finish = event.delta.stop_reason ?? 'stop'
      }
    }
    traceLlmCall({ at: new Date().toISOString(), model, finishReason: finish === 'tool_use' ? 'tool_calls' : finish, contentLength: contentLen, reasoningLength: reasoningLen, toolCalls: toolCalls.length, usage })
    yield { toolCalls: toolCalls.length ? toolCalls : undefined, finishReason: finish === 'tool_use' ? 'tool_calls' : finish }
  }

  const iterable = iterate()
  return {
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
    async drain() {
      let text = ''
      let toolCalls: ToolCall[] = []
      let finishReason = 'stop'
      for await (const ch of iterable) {
        if (ch.textDelta) text += ch.textDelta
        if (ch.toolCalls) toolCalls = ch.toolCalls
        if (ch.finishReason) finishReason = ch.finishReason
      }
      return { text, toolCalls, finishReason }
    }
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return {} }
}

/** Crea uno stream LLM dal provider indicato. */
export function llmStream(
  p: ProviderConfig,
  model: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  opts: StreamOptions = {}
): LlmStream {
  if (p.kind === 'anthropic') return anthropicStream(p, messages, tools, model, signal, opts)
  return openAiStream(p, messages, tools, model, signal, opts)
}
