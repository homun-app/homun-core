// Fase 9 (punto 1): modello predefinito e modello di riserva per provider.
// Modulo PURO: i default sono per kind (la scelta è del revisore, con prove sui
// comportamenti: kimi-k3:cloud 15/15 → predefinito, glm-5.3:cloud 14/15 →
// riserva, glm-5.3-flash:cloud piccolo e veloce → revisore dell'auto-review)
// e l'utente li cambia per provider dalle impostazioni (setting
// 'providers.modelDefaults', chiave = id del provider, campo per campo).
//
// Fase 16c (C3.3): «Come gli altri» — il modello principale (models.main) e
// resolveAgentModel, la funzione pura che decide CHE modello esegue un bot:
// il suo se l'ha scelto, il principale se segue gli altri, niente altrimenti.
import type { ProviderKind, MainModel } from '../../shared/types'

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

// ---- fase 16c (C3.3): «Come gli altri» ----
// Fase 16c correzioni (R3/R4): resolveAgentModel e i suoi tipi vivono in
// src/shared/agent-model.ts (puro, zero dipendenze) così lo usa anche il
// renderer; qui restano i re-esport per i chiamanti storici del main/daemon.
export { resolveAgentModel, type AgentModelView, type ResolvedAgentModel, type ActiveProviders } from '../../shared/agent-model'

/** Dipendenze di assignFirstMainModel (iniettabili nei test). */
export interface FirstMainDeps {
  getMain(): MainModel | null
  setMain(m: MainModel | null): void
  /** il provider appena salvato (null se sparito/disattivato) */
  savedProvider(): import('../../shared/types').ProviderConfig | null
  getOverrides(): ModelDefaultsMap
  supportsTools(provider: { id: string; kind: string }, model: string): Promise<{ ok: boolean; checked: boolean; error?: string }>
}

/**
 * Fase 16c (C3.3): quando si collega il primo provider e models.main non c'è,
 * il principale diventa il suo modello predefinito (quello che sceglierebbe
 * oggi assignDefaultModel, capability "tools" verificata). Se il default non
 * c'è o non passa il check, models.main resta vuoto (lo sceglie l'utente).
 */
export async function assignFirstMainModel(deps: FirstMainDeps): Promise<void> {
  if (deps.getMain()) return
  const provider = deps.savedProvider()
  if (!provider || !provider.enabled) return
  const dm = defaultModelFor(provider, deps.getOverrides())
  if (!dm) return
  const check = await deps.supportsTools(provider, dm)
  if (!check.ok) return
  deps.setMain({ providerId: provider.id, model: dm, thinking: null })
}

/**
 * Fase 16c (C3.3/C7): il modello da ASSEGNARE a un bot nuovo (interfaccia,
 * template, create_agent del modello). Se models.main esiste il bot nasce
 * «Come gli altri» (null/null, segue il principale); senza, il turno resta
 * quello di oggi (assignDefaultModel del chiamante).
 */
export function newAgentModel(main: MainModel | null | undefined): 'follows-main' | 'assign-default' {
  return main && main.providerId && main.model ? 'follows-main' : 'assign-default'
}
