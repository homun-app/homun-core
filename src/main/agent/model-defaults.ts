// Fase 9 (punto 1): modello predefinito e modello di riserva per provider.
// Modulo PURO: i default sono per kind (la scelta è del revisore, con prove sui
// comportamenti: kimi-k3:cloud 15/15 → predefinito, glm-5.3:cloud 14/15 →
// riserva, glm-5.3-flash:cloud piccolo e veloce → revisore dell'auto-review)
// e l'utente li cambia per provider dalle impostazioni (setting
// 'providers.modelDefaults', chiave = id del provider, campo per campo).
import type { ProviderKind } from '../../shared/types'

/** I modelli di un provider: predefinito, riserva, revisore dell'auto-review. */
export interface ModelDefaults {
  defaultModel?: string
  fallbackModel?: string
  autoReviewModel?: string
}

/** Override dell'utente per id di provider (setting 'providers.modelDefaults'). */
export type ModelDefaultsMap = Record<string, ModelDefaults>

export const MODEL_DEFAULTS_BY_KIND: Partial<Record<ProviderKind, ModelDefaults>> = {
  ollama: { defaultModel: 'kimi-k3:cloud', fallbackModel: 'glm-5.3:cloud', autoReviewModel: 'glm-5.3-flash:cloud' }
}

/** I default del provider: quelli del suo kind sovrascritti dagli override utente. */
export function modelDefaultsFor(provider: { id: string; kind: string }, overrides: ModelDefaultsMap = {}): ModelDefaults {
  return { ...MODEL_DEFAULTS_BY_KIND[provider.kind as ProviderKind], ...overrides[provider.id] }
}

/** Il modello predefinito (onboarding e bot da template), se configurato. */
export function defaultModelFor(provider: { id: string; kind: string }, overrides: ModelDefaultsMap = {}): string | null {
  return modelDefaultsFor(provider, overrides).defaultModel ?? null
}

/** Il modello di riserva per i turni il cui modello principale non risponde. */
export function fallbackModelFor(provider: { id: string; kind: string }, overrides: ModelDefaultsMap = {}): string | null {
  return modelDefaultsFor(provider, overrides).fallbackModel ?? null
}

/** Il modello del revisore dell'auto-review (piccolo e veloce). */
export function autoReviewModelFor(provider: { id: string; kind: string }, overrides: ModelDefaultsMap = {}): string | null {
  return modelDefaultsFor(provider, overrides).autoReviewModel ?? null
}

/** Dipendenze della scelta provider+modello per un bot nuovo (iniettabili nei test). */
export interface AssignmentDeps {
  listProviders(): Array<{ id: string; kind: string; enabled: boolean }>
  getOverrides(): ModelDefaultsMap
  supportsTools(provider: { id: string; kind: string }, model: string): Promise<{ ok: boolean; checked: boolean; error?: string }>
}

export interface ModelAssignment {
  providerId: string
  model: string | null
  /** Il default non è assegnabile (es. capability "tools" assente): il perché, leggibile. */
  warning?: string
}

/**
 * Fase 9 (punto 1): provider attivo + modello predefinito per un bot nuovo
 * (onboarding e template). Prima di assegnare il modello verifica che
 * supporti i tool; senza defaultModel configurato il bot resta senza modello
 * (niente più "primo modello dell'elenco" della fase 7).
 */
export async function assignDefaultModel(deps: AssignmentDeps): Promise<ModelAssignment | null> {
  const provider = deps.listProviders().find((p) => p.enabled)
  if (!provider) return null
  const dm = defaultModelFor(provider, deps.getOverrides())
  if (!dm) return { providerId: provider.id, model: null }
  const check = await deps.supportsTools(provider, dm)
  if (check.ok) return { providerId: provider.id, model: dm }
  return { providerId: provider.id, model: null, warning: check.error }
}
