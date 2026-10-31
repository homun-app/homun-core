// Compaction della history (fase 4): quando la storia stimata supera il 70%
// del budget di contesto del modello (configurabile per provider/modello con
// il setting contextBudgetTokens["<providerId>/<model>"], default 32k token,
// stima caratteri/4), i turni più vecchi vengono riassunti in un'entry kind
// 'summary' con una chiamata LLM separata. buildMessages usa il summary al
// posto dei turni che copre (meta.coversUpTo); le entry RESTANO nel DB.
// Se la chiamata di riassunto fallisce si ripiega sul taglio a confine di
// turno già fatto da buildMessages: il turno non deve mai fallire.
//
// La decisione (quanto riassumere) è una funzione pura; l'orchestrazione
// (lettura entry, LLM, append) riceve la chiamata LLM iniettata.
import { getEntries, appendEntry, getSetting, recordModelUsage } from '../store/db'
import { llmStream } from './llm'
import type { ProviderConfig, SandbotEvent, TranscriptEntry } from '../../shared/types'

export const DEFAULT_CONTEXT_TOKENS = 32_000
/** Soglia di compaction: si riassume quando la storia stimata supera questa frazione del budget. */
export const COMPACT_THRESHOLD = 0.7

/** Stima token di una sequenza di entry (caratteri/4, come da specifica). */
export function estimateHistoryTokens(entries: TranscriptEntry[]): number {
  return Math.ceil(entries.reduce((n, e) => n + e.content.length, 0) / 4)
}

export interface CompactionPlan {
  /** id dell'ultima entry riassunta (diventa meta.coversUpTo del summary). */
  coversUpTo: number
  covered: TranscriptEntry[]
}

/**
 * Piano di compaction (puro): null se non serve. Il confine è un messaggio
 * utente: il prefix riassunto è fatto di turni COMPLETI (mai un tool-call a
 * metà) e il suffix che resta al modello contiene sempre il turno corrente
 * (mai riassunto). Si riassume il MINIMO necessario: il confine più vecchio
 * che riporta il resto sotto soglia.
 */
export function planCompaction(entries: TranscriptEntry[], budgetTokens: number, threshold = COMPACT_THRESHOLD): CompactionPlan | null {
  const limit = Math.floor(budgetTokens * threshold)
  if (estimateHistoryTokens(entries) <= limit) return null
  const userIds = entries.filter((e) => e.kind === 'message' && e.role === 'user').map((e) => e.id)
  if (userIds.length < 2) return null // un solo turno: niente da riassumere
  // confine di turno = un messaggio utente: il prefix è TUTTO ciò che sta
  // prima (turni completi, mai un tool-call a metà), il suffix parte da lì e
  // contiene sempre il turno corrente. Si prova dal confine più vecchio:
  // il primo che riporta il suffix sotto soglia minimizza ciò che si riassume
  for (const u of userIds) {
    const covered = entries.filter((e) => e.id < u)
    if (!covered.length) continue
    const suffix = entries.filter((e) => e.id >= u)
    if (estimateHistoryTokens(suffix) <= limit) {
      return { coversUpTo: covered[covered.length - 1]!.id, covered }
    }
  }
  // nemmeno riassumendo tutto ciò che precede il turno corrente si scende
  // sotto soglia: si riassume comunque, MA solo se il prefix ha massa
  // sufficiente perché il riepilogo porti un risparmio reale (se l'overhead
  // sta nel turno corrente, il summary sarebbe solo rumore)
  const lastU = userIds[userIds.length - 1]!
  const covered = entries.filter((e) => e.id < lastU)
  return covered.length && estimateHistoryTokens(covered) >= 256
    ? { coversUpTo: covered[covered.length - 1]!.id, covered }
    : null
}

/**
 * Digest testuale delle entry per la chiamata di riassunto (puro): i turni in
 * forma leggibile, con i contenuti lunghi troncati — al riepilogo bastano i
 * fatti, non gli output integrali.
 */
export function entriesToDigest(entries: TranscriptEntry[]): string {
  const lines: string[] = []
  const cut = (s: string, n = 2000): string => (s.length > n ? s.slice(0, n) + '…' : s)
  for (const e of entries) {
    // fase 18a (E0): le etichette sono ENGLESI — le legge il modello e con le
    // vecchie etichette italiane la compaction tendeva a riassumere in italiano
    if (e.kind === 'message') lines.push(`${e.role === 'user' ? 'USER' : 'ASSISTANT'}: ${cut(e.content)}`)
    else if (e.kind === 'send-message') lines.push(`BOT→USER: ${cut(e.content)}`)
    else if (e.kind === 'thinking') lines.push(`(reasoning) ${cut(e.content, 800)}`)
    else if (e.kind === 'summary') lines.push(`(previous summary) ${cut(e.content)}`)
    else if (e.kind === 'tool-call') lines.push(`TOOL ${e.content}: ${cut(String(e.meta?.arguments ?? ''), 500)}`)
    else if (e.kind === 'tool-result') lines.push(`RESULT: ${cut(e.content, 500)}`)
    // notice/approval/event: contabilità interna, non entra nel riepilogo
  }
  return lines.join('\n')
}

/**
 * Orchestrazione: se serve, produce e persiste l'entry summary. Ritorna true
 * se ha creato un riepilogo; qualunque errore della chiamata LLM lascia il
 * transcript invariato (fallback sul taglio a confine di turno esistente).
 * La chiamata LLM è iniettata (nei test: LLM finto).
 */
export async function maybeCompactHistory(
  agentId: string,
  providerId: string,
  model: string,
  runLlm: (digest: string) => Promise<string>,
  emit: (e: SandbotEvent) => void
): Promise<boolean> {
  const entries = getEntries(agentId)
  const budgets = getSetting<Record<string, number>>('contextBudgetTokens', {})
  const budget = budgets[`${providerId}/${model}`] ?? DEFAULT_CONTEXT_TOKENS
  const plan = planCompaction(entries, budget)
  if (!plan) return false
  try {
    const summary = (await runLlm(entriesToDigest(plan.covered))).trim()
    if (!summary) return false
    appendEntry({ agentId, kind: 'summary', role: 'system', content: summary, meta: { coversUpTo: plan.coversUpTo } })
    emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
    return true
  } catch {
    return false // il turno prosegue senza riepilogo (fallback)
  }
}

/** Chiamata LLM del riepilogo: prompt dedicato, nessun tool. */
export async function summarizeWithLlm(
  provider: ProviderConfig,
  model: string,
  digest: string,
  compactionPrompt: (digest: string) => string,
  agentId: string | null = null
): Promise<string> {
  const controller = new AbortController()
  const stream = llmStream(provider, model, [{ role: 'user', content: compactionPrompt(digest) }], [], controller.signal)
  let acc = ''
  let usage: import('./llm').LlmChunk['usage'] | undefined
  for await (const ch of stream) {
    if (ch.textDelta) acc += ch.textDelta
    if (ch.usage) usage = ch.usage
  }
  // fase 18a (E4): uso registrato del riepilogo (source 'compaction')
  if (usage) {
    recordModelUsage({
      agentId,
      providerId: provider.id,
      providerKind: provider.kind,
      model,
      source: 'compaction',
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      costUsd: usage.costUsd ?? null
    })
  }
  return acc
}
