// GC2 (fase guida-correzioni): le pillole dei modelli del pannello con chiave
// della guida — funzione PURA: al massimo 4, col CONSIGLIATO per primo
// (recommendedModel) e poi gli altri NELL'ORDINE dell'elenco; un modello
// scelto dal picker che non è fra le pillole DIVENTA una pillola, al posto
// dell'ultima. Il trigger «Altri modelli…» non mostra mai il valore.
import { recommendedModel } from './recommended-model'

/** Quante pillole di modelli sta nella guida (più il trigger del picker). */
export const MAX_GUIDE_MODEL_PILLS = 4

/**
 * (PURA) Le pillole dei modelli per il pannello della guida: il consigliato
 * per primo, poi gli altri nell'ordine dell'elenco, al massimo
 * MAX_GUIDE_MODEL_PILLS; se il modello scelto non è fra loro, prende il
 * posto dell'ultima pillola (selezionata dal chiamante con aria-pressed).
 */
export function guideModelPills(kind: string, models: readonly string[], selected: string | null): string[] {
  const rec = recommendedModel(kind, models)
  const rest = models.filter((m) => m !== rec)
  const base = (rec ? [rec, ...rest] : [...rest]).slice(0, MAX_GUIDE_MODEL_PILLS)
  if (selected && !base.includes(selected)) {
    return [...base.slice(0, MAX_GUIDE_MODEL_PILLS - 1), selected]
  }
  return base
}
