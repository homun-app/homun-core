// G4 (fase guida): il modello CONSIGLIATO di un provider — funzione pura:
// per ogni kind una lista breve e prudente di preferenze per PREFISSO,
// applicata ai modelli che la chiave elenca DAVVERO; se nessuna preferenza
// combacia si prende il primo dell'elenco (mai nomi inventati). Dentro una
// preferenza che combacia vince l'id più alto (le versioni più recenti
// ordinano dopo nel nome: 4-5 > 4, 20250929 > 20250101).
export type RecommendableKind =
  | 'anthropic' | 'openai' | 'openrouter' | 'xai' | 'mistral' | 'deepseek' | 'groq' | 'zai' | 'openai-compatible'

/**
 * Le preferenze per prefisso, in ordine. Prudenti: solo famiglie di modelli
 * note, che supportano i tool e sono disponibili con una chiave normale.
 */
export const RECOMMENDED_MODEL_PREFIXES: Readonly<Record<RecommendableKind, readonly string[]>> = Object.freeze({
  anthropic: ['claude-sonnet', 'claude-opus'],
  openai: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
  openrouter: ['anthropic/claude-sonnet', 'openai/gpt-5', 'openai/gpt-4.1'],
  xai: ['grok-4', 'grok-3'],
  mistral: ['mistral-large', 'mistral-medium'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  groq: ['llama-3.3', 'llama-3.1', 'qwen'],
  zai: ['glm-4'],
  'openai-compatible': []
})

/**
 * (PURA) Il modello consigliato per il kind fra quelli elencati dalla chiave:
 * la prima preferenza con almeno un combacio vince (fra i combaci, l'id più
 * alto); senza combaci il primo dell'elenco; elenco vuoto → null.
 */
export function recommendedModel(kind: string, models: readonly string[]): string | null {
  if (models.length === 0) return null
  const prefixes = RECOMMENDED_MODEL_PREFIXES[kind as RecommendableKind] ?? []
  for (const p of prefixes) {
    const matches = models
      .filter((m) => m.toLowerCase().startsWith(p.toLowerCase()))
      .sort((a, b) => b.localeCompare(a))
    if (matches.length > 0) return matches[0]!
  }
  return models[0]!
}
