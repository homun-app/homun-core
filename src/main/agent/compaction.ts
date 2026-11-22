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
import { effectiveEntries } from './history'
import type { ProviderConfig, SandbotEvent, TranscriptEntry } from '../../shared/types'

export const DEFAULT_CONTEXT_TOKENS = 32_000
/**
 * Soglia di compaction: si riassume quando la storia VISTA DAL MODELLO
 * (ultimo summary + entry successive) supera questa frazione del budget.
 */
export const COMPACT_THRESHOLD = 0.7
/**
 * D5 (fase deleghe): ISTERESI — il confine scelto deve riportare il resto
 * SOTTO questa frazione del budget, così il turno dopo non è già di nuovo
 * sopra soglia (il difetto del 22/11: 36 compattazioni, una per turno).
 */
export const COMPACT_TARGET = 0.45
/**
 * D5: il tetto del DIGEST sul budget del modello — oltre, si tagliano prima
 * gli output lunghi (risultati degli strumenti, ragionamento), MAI il
 * riassunto precedente.
 */
export const COMPACT_DIGEST_CAP = 0.5

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
 * Piano di compaction (puro): null se non serve. D5 (fase deleghe): il
 * chiamante passa la storia VISTA DAL MODELLO (effectiveEntries: l'ultimo
 * summary + le entry successive), non tutta la storia. Il confine è un
 * messaggio utente: il prefix riassunto è fatto di turni COMPLETI (mai un
 * tool-call a metà) e il suffix che resta al modello contiene sempre il
 * turno corrente (mai riassunto). ISTERESI: si parte solo sopra
 * COMPACT_THRESHOLD e il confine deve riportare il resto sotto
 * COMPACT_TARGET (non la soglia di partenza): si riassume il MINIMO
 * necessario per stare tranquilli per parecchi turni.
 */
export function planCompaction(entries: TranscriptEntry[], budgetTokens: number, thresholds: { start?: number; target?: number } = {}): CompactionPlan | null {
  const start = thresholds.start ?? COMPACT_THRESHOLD
  const target = thresholds.target ?? COMPACT_TARGET
  const startLimit = Math.floor(budgetTokens * start)
  const targetLimit = Math.floor(budgetTokens * target)
  if (estimateHistoryTokens(entries) <= startLimit) return null
  const userIds = entries.filter((e) => e.kind === 'message' && e.role === 'user').map((e) => e.id)
  if (userIds.length < 2) return null // un solo turno: niente da riassumere
  // confine di turno = un messaggio utente: il prefix è TUTTO ciò che sta
  // prima (turni completi, mai un tool-call a metà; il SUMMARY non si
  // ri-assume — il suo contenuto viaggia nel digest come riassunto
  // precedente), il suffix parte da lì e contiene sempre il turno corrente.
  // Si prova dal confine più vecchio: il primo che riporta il suffix SOTTO
  // TARGET minimizza ciò che si riassume
  for (const u of userIds) {
    const covered = entries.filter((e) => e.id < u && e.kind !== 'summary')
    if (!covered.length) continue
    const suffix = entries.filter((e) => e.id >= u)
    if (estimateHistoryTokens(suffix) <= targetLimit) {
      return { coversUpTo: covered[covered.length - 1]!.id, covered }
    }
  }
  // nemmeno riassumendo tutto ciò che precede il turno corrente si scende
  // sotto il target: si riassume comunque, MA solo se il prefix ha massa
  // sufficiente perché il riepilogo porti un risparmio reale (se l'overhead
  // sta nel turno corrente, il summary sarebbe solo rumore)
  const lastU = userIds[userIds.length - 1]!
  const covered = entries.filter((e) => e.id < lastU && e.kind !== 'summary')
  return covered.length && estimateHistoryTokens(covered) >= 256
    ? { coversUpTo: covered[covered.length - 1]!.id, covered }
    : null
}

/**
 * Digest testuale delle entry per la chiamata di riassunto (puro): i turni in
 * forma leggibile, con i contenuti lunghi troncati — al riepilogo bastano i
 * fatti, non gli output integrali. D5: i tagli sono PARAMETRICI (il tetto
 * del digest li stringe prima di toccare qualunque altra cosa).
 */
export function entriesToDigest(entries: TranscriptEntry[], cuts: { message?: number; reasoning?: number; tool?: number; result?: number } = {}): string {
  const msgCut = cuts.message ?? 2000
  const reasonCut = cuts.reasoning ?? 800
  const toolCut = cuts.tool ?? 500
  const resultCut = cuts.result ?? 500
  const lines: string[] = []
  const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)
  for (const e of entries) {
    // fase 18a (E0): le etichette sono ENGLESI — le legge il modello e con le
    // vecchie etichette italiane la compaction tendeva a riassumere in italiano
    if (e.kind === 'message') lines.push(`${e.role === 'user' ? 'USER' : 'ASSISTANT'}: ${cut(e.content, msgCut)}`)
    else if (e.kind === 'send-message') lines.push(`BOT→USER: ${cut(e.content, msgCut)}`)
    else if (e.kind === 'thinking') lines.push(`(reasoning) ${cut(e.content, reasonCut)}`)
    else if (e.kind === 'summary') lines.push(`(previous summary) ${cut(e.content, msgCut)}`)
    else if (e.kind === 'tool-call') lines.push(`TOOL ${e.content}: ${cut(String(e.meta?.arguments ?? ''), toolCut)}`)
    else if (e.kind === 'tool-result') lines.push(`RESULT: ${cut(e.content, resultCut)}`)
    // notice/approval/event: contabilità interna, non entra nel riepilogo
  }
  return lines.join('\n')
}

/**
 * D5: il digest INCREMENTALE — il riassunto precedente INTERO (mai tagliato)
 * più le sole entry nuove da coprire, col TETTO del digest rispettato: oltre
 * COMPACT_DIGEST_CAP del budget si stringono PRIMA i tagli degli output
 * lunghi (risultati degli strumenti, ragionamento) e, se non basta, si
 * lasciano fuori i RESULT più vecchi — il riassunto precedente non si tocca
 * mai (puro).
 */
export function incrementalDigest(
  prevSummary: string | null,
  covered: TranscriptEntry[],
  budgetTokens: number
): string {
  const capChars = Math.floor(budgetTokens * COMPACT_DIGEST_CAP) * 4
  const summaryLine = prevSummary?.trim() ? `(previous summary) ${prevSummary.trim()}` : null
  const head = summaryLine ? `${summaryLine}\n` : ''
  // si stringono prima i tagli degli output lunghi, poi si lasciano fuori i
  // RESULT vecchi, e ULTIMO ricorso si stringono anche i messaggi — il
  // riassunto precedente non si tocca MAI
  let resultCut = 500
  let reasoningCut = 800
  let msgCut = 2000
  const build = (): string => head + entriesToDigest(covered, { result: resultCut, reasoning: reasoningCut, message: msgCut })
  let body = build()
  while (body.length > capChars && (resultCut > 60 || reasoningCut > 60)) {
    resultCut = Math.max(60, Math.floor(resultCut / 2))
    reasoningCut = Math.max(60, Math.floor(reasoningCut / 2))
    body = build()
  }
  if (body.length <= capChars) return body
  // ancora sopra: i RESULT escono dal digest, dal più vecchio, finché basta
  const entries = covered.filter((e) => e.kind !== 'tool-result')
  body = head + entriesToDigest(entries, { result: resultCut, reasoning: reasoningCut, message: msgCut })
  while (body.length > capChars && msgCut > 60) {
    msgCut = Math.max(60, Math.floor(msgCut / 2))
    body = head + entriesToDigest(entries, { result: resultCut, reasoning: reasoningCut, message: msgCut })
  }
  return body
}

/**
 * Orchestrazione: se serve, produce e persiste l'entry summary. D5 (fase
 * deleghe): la stima e il piano usano la storia VISTA DAL MODELLO
 * (effectiveEntries, lo stesso criterio di buildMessages) e il digest è
 * INCREMENTALE (il riassunto precedente + le sole entry nuove, col tetto).
 * Ritorna true se ha creato un riepilogo; qualunque errore della chiamata
 * LLM lascia il transcript invariato (fallback sul taglio a confine di
 * turno esistente) e scrive UNA riga di log con la categoria, senza testo
 * del modello. La chiamata LLM è iniettata (nei test: LLM finto).
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
  const visible = effectiveEntries(entries)
  const plan = planCompaction(visible, budget)
  if (!plan) return false
  // il digest è incrementale: il riassunto precedente (se c'è, è la prima
  // entry del visible) più le SOLE entry nuove da coprire
  const prev = visible.find((e) => e.kind === 'summary')
  try {
    const summary = (await runLlm(incrementalDigest(prev?.content ?? null, plan.covered, budget))).trim()
    if (!summary) return false
    appendEntry({ agentId, kind: 'summary', role: 'system', content: summary, meta: { coversUpTo: plan.coversUpTo } })
    emit({ type: 'entries', agentId, entries: getEntries(agentId).slice(-1) })
    return true
  } catch (e) {
    // D5: il fallimento si vede — una riga con la categoria, mai testo del
    // modello né del provider; il turno prosegue senza riepilogo (fallback)
    const category = e instanceof Error ? e.name : typeof e
    console.log(`[compaction] fallita per ${agentId}: categoria ${category}`)
    return false
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
