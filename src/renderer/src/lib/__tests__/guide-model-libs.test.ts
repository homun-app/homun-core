// G4 (fase guida): le funzioni pure del passo Modello — la mappa delle
// pagine delle chiavi, il modello consigliato per kind e la regola delle
// schede visibili della griglia (Ollama solo se trovato, Integrato solo se
// idoneo, Google mai).
import { describe, expect, it } from 'vitest'
import { providerKeyUrl, PROVIDER_KEY_URLS } from '../provider-key-urls'
import { recommendedModel, RECOMMENDED_MODEL_PREFIXES } from '../recommended-model'
import { guideProviderCards, GUIDE_OTHER_KINDS } from '../guide-provider-cards'

describe('G4 providerKeyUrl: la pagina delle chiavi di ogni kind', () => {
  it('ogni kind con chiave ha il suo URL https (mai http)', () => {
    for (const kind of ['anthropic', 'openai', 'openrouter', 'xai', 'mistral', 'deepseek', 'groq', 'zai']) {
      const url = providerKeyUrl(kind)
      expect(url, `${kind} deve avere l'URL`).toBeTruthy()
      expect(url!.startsWith('https://')).toBe(true)
    }
  })

  it('il compatibile OpenAI non ha pagina delle chiavi (è un server qualunque)', () => {
    expect(providerKeyUrl('openai-compatible')).toBeNull()
    expect(providerKeyUrl('ollama')).toBeNull()
    expect(providerKeyUrl('kind-sconosciuto')).toBeNull()
  })

  it('la mappa è congelata (nessuna aggiunta a runtime)', () => {
    expect(Object.isFrozen(PROVIDER_KEY_URLS)).toBe(true)
  })
})

describe('G4 recommendedModel: il consigliato viene dai modelli CHE LA CHIAVE ELENCA', () => {
  it('Anthropic: prima i claude-sonnet più recenti, poi claude-opus', () => {
    const models = ['claude-3-5-haiku-20241022', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805']
    expect(recommendedModel('anthropic', models)).toBe('claude-sonnet-4-5-20250929')
    // senza sonnet, l'opus
    expect(recommendedModel('anthropic', ['claude-opus-4-1', 'claude-haiku-4'])).toBe('claude-opus-4-1')
  })

  it('nessuna preferenza combacia → il PRIMO dell\'elenco (mai nomi inventati)', () => {
    expect(recommendedModel('anthropic', ['modello-sconosciuto-x', 'altro'])).toBe('modello-sconosciuto-x')
    expect(recommendedModel('openai-compatible', ['gateway-internal-1', 'gateway-2'])).toBe('gateway-internal-1')
  })

  it('elenco vuoto → null', () => {
    expect(recommendedModel('openai', [])).toBeNull()
  })

  it('il combacio per prefisso ignora le maiuscole; fra i combaci vince l\'id più alto', () => {
    expect(recommendedModel('openai', ['GPT-5-mini', 'gpt-4.1', 'gpt-5.2'])).toBe('gpt-5.2')
    expect(recommendedModel('deepseek', ['deepseek-reasoner', 'deepseek-chat'])).toBe('deepseek-chat')
  })

  it('ogni kind dell\'elenco «Altri…» ha le sue preferenze (anche vuote)', () => {
    for (const k of GUIDE_OTHER_KINDS) {
      expect(Array.isArray(RECOMMENDED_MODEL_PREFIXES[k])).toBe(true)
    }
    expect(RECOMMENDED_MODEL_PREFIXES['openai-compatible']).toEqual([])
  })
})

describe('G4 guideProviderCards: le schede visibili della griglia', () => {
  it('senza Ollama e senza Integrato: le quattro fisse (Anthropic, OpenAI, OpenRouter, Altri…)', () => {
    expect(guideProviderCards({ ollamaFound: false, localAllowed: false })).toEqual(['anthropic', 'openai', 'openrouter', 'others'])
  })

  it('Ollama SOLO se la scoperta lo trova; Integrato SOLO se la macchina lo consente', () => {
    expect(guideProviderCards({ ollamaFound: true, localAllowed: false })).toEqual(['anthropic', 'openai', 'openrouter', 'others', 'ollama'])
    expect(guideProviderCards({ ollamaFound: false, localAllowed: true })).toEqual(['anthropic', 'openai', 'openrouter', 'others', 'local'])
    expect(guideProviderCards({ ollamaFound: true, localAllowed: true })).toEqual(['anthropic', 'openai', 'openrouter', 'others', 'ollama', 'local'])
  })

  it('Google non c\'è mai: non abbiamo il kind, niente scheda finta', () => {
    for (const f of [{ ollamaFound: true, localAllowed: true }, { ollamaFound: false, localAllowed: false }]) {
      expect(guideProviderCards(f)).not.toContain('google')
    }
  })
})
