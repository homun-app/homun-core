// G4 (fase guida): le schede visibili della griglia del passo Modello —
// regola PURA (la stessa visibilità delle strade di guideProviderPaths del
// daemon): Anthropic, OpenAI, OpenRouter e «Altri…» sempre; Ollama SOLO se
// la scoperta lo trova; Integrato SOLO se l'idoneità della macchina lo
// consente (mai unsupported). Google non c'è: non abbiamo il kind, niente
// scheda finta.
export type GuideProviderCardId = 'anthropic' | 'openai' | 'openrouter' | 'others' | 'ollama' | 'local'

export interface GuideProviderCardsFacts {
  /** la scoperta dei servizi locali ha trovato Ollama */
  ollamaFound: boolean
  /** la strada Integrato è concessa su questa macchina (eligibility ≠ unsupported) */
  localAllowed: boolean
}

/** Le schede visibili, in ordine fisso. */
export function guideProviderCards(f: GuideProviderCardsFacts): readonly GuideProviderCardId[] {
  const out: GuideProviderCardId[] = ['anthropic', 'openai', 'openrouter', 'others']
  if (f.ollamaFound) out.push('ollama')
  if (f.localAllowed) out.push('local')
  return out
}

/**
 * Gli ALTRI tipi con chiave dell'elenco «Altri…» (più il compatibile
 * OpenAI, che chiede anche l'indirizzo): ordine fisso, solo kind esistenti.
 */
export const GUIDE_OTHER_KINDS: readonly ['xai', 'mistral', 'deepseek', 'groq', 'zai', 'openai-compatible'] = [
  'xai', 'mistral', 'deepseek', 'groq', 'zai', 'openai-compatible'
]
