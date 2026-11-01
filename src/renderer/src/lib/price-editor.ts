// Fase 18b (K2): la selezione delle righe dell'editor dei prezzi
// personalizzati della pagina «Uso e costi», estratta in funzione PURA del
// renderer (testata senza React). Prima dell'editor entravano solo le righe
// SENZA costo: appena una chiamata registrava un costo la riga usciva
// dall'editor e un prezzo sbagliato non si poteva più correggere.
import type { ModelPriceMap, ModelUsageRow } from '../../../shared/types'
import { isLocalKind } from '../../../main/agent/live-models'

/** Una riga dell'editor dei prezzi (providerId+modello, con il kind per l'etichetta). */
export interface PriceEditorRow {
  providerId: string
  model: string
  /** il kind del provider ('' per i modelli con prezzo salvato e SENZA chiamate) */
  providerKind: string
}

/**
 * K2: i modelli che entrano nell'editor dei prezzi. Dalle righe del periodo
 * (vista per modello) entrano i NON LOCALI che valgono almeno una di:
 * - `costUsd === null` (nessun prezzo conosciuto);
 * - `costPartial` (costo parziale: qualcuna senza prezzo);
 * - hanno già un prezzo salvato in `providers.modelPrices`.
 * Si aggiungono poi, SENZA doppioni, i modelli con un prezzo salvato che nel
 * periodo non hanno chiamate: un prezzo salvato si vede sempre (e si può
 * togliere svuotando entrambi i campi), anche se il provider è locale o non
 * esiste più.
 */
export function priceEditorRows(rows: ModelUsageRow[], prices: ModelPriceMap): PriceEditorRow[] {
  const out: PriceEditorRow[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r.providerId || !r.model) continue
    if (isLocalKind(r.providerKind)) continue // i locali non hanno un prezzo
    const hasPrice = !!prices[r.providerId]?.[r.model]
    if (r.costUsd !== null && !r.costPartial && !hasPrice) continue // costo noto, niente da scrivere
    const key = `${r.providerId}|${r.model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ providerId: r.providerId, model: r.model, providerKind: r.providerKind })
  }
  for (const [providerId, models] of Object.entries(prices)) {
    for (const model of Object.keys(models)) {
      const key = `${providerId}|${model}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ providerId, model, providerKind: '' })
    }
  }
  return out
}
