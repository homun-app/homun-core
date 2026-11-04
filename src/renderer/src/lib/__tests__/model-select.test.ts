// Fase impostazioni (I1): le funzioni PURE del ModelSelect — raggruppamento,
// filtro della ricerca, i tipi ancora da collegare, il primo modello adatto.
import { describe, expect, it } from 'vitest'
import { modelEntries, filterModelEntries, connectableKinds, CONNECTABLE_KINDS, firstSuitableModel } from '../model-select'
import type { ModelInfo, ProviderPublic } from '../../../../shared/types'

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  source: 'live',
  vision: null,
  tools: null,
  thinkingLevels: [],
  cost: null,
  costSource: null,
  local: false,
  ...over
})

const pub = (id: string, kind: ProviderPublic['kind'], name = id): ProviderPublic => ({
  id, name, kind, baseUrl: 'http://127.0.0.1:1', apiKey: '', enabled: true, hasKey: false
})

describe('modelEntries (I1.2): i modelli pronti, raggruppati per provider', () => {
  it('una voce per modello con la chiave stabile provider::modello e il nome del provider', () => {
    const out = modelEntries(
      [pub('ollama', 'ollama', 'Ollama'), pub('prov', 'openai', 'OpenAI')],
      { ollama: [model('kimi'), model('gemma')], prov: [model('gpt-finto')] }
    )
    expect(out.map((e) => e.key)).toEqual(['ollama::kimi', 'ollama::gemma', 'prov::gpt-finto'])
    expect(out[0]).toMatchObject({ providerId: 'ollama', providerName: 'Ollama', model: { id: 'kimi' } })
  })

  it('provider senza elenco (o che ancora carica) non produce voci', () => {
    expect(modelEntries([pub('p', 'groq')], {})).toEqual([])
  })
})

describe('filterModelEntries: la ricerca del popover', () => {
  const entries = modelEntries(
    [pub('p', 'groq', 'Groq')],
    { p: [model('llama-3.3-70b', { label: 'Llama 3.3' }), model('mixtral')] }
  )
  it('case-insensitive su id ed etichetta; query vuota = tutto', () => {
    expect(filterModelEntries(entries, '')).toHaveLength(2)
    expect(filterModelEntries(entries, 'LLAMA')).toHaveLength(1)
    expect(filterModelEntries(entries, 'llama')[0]!.model.id).toBe('llama-3.3-70b')
    // l'etichetta conta come l'id
    expect(filterModelEntries(entries, '3.3')).toHaveLength(1)
    expect(filterModelEntries(entries, 'zzz')).toEqual([])
  })
})

describe('connectableKinds (I1.2): una riga per tipo NON ancora collegato', () => {
  it('senza provider: tutti i tipi, nell\'ordine del foglio (mac, chiavi, server)', () => {
    const kinds = connectableKinds([]).map((c) => c.kind)
    expect(kinds).toEqual(CONNECTABLE_KINDS.map((c) => c.kind))
  })

  it('i tipi collegati spariscono; due server custom contano UN tipo', () => {
    const connected: Array<{ kind: ProviderPublic['kind'] }> = [
      pub('ollama', 'ollama'),
      pub('custom_1', 'openai-compatible', 'Gateway'),
      pub('custom_2', 'openai-compatible', 'Altro gateway')
    ]
    const kinds = connectableKinds(connected).map((c) => c.kind)
    expect(kinds).not.toContain('ollama')
    expect(kinds).not.toContain('openai-compatible')
    expect(kinds).toContain('lmstudio')
    expect(kinds).toContain('anthropic')
    // un provider DISABILITATO resta collegato: il tipo non si propone due volte
    const paused: Array<{ kind: ProviderPublic['kind'] }> = [pub('ollama', 'ollama')]
    expect(connectableKinds(paused).map((c) => c.kind)).not.toContain('ollama')
  })
})

describe('firstSuitableModel (I1.2): il primo adatto dopo un collegamento', () => {
  it('il predefinito del tipo vince se c\'è e usa i tool', () => {
    const ms = [model('altro'), model('kimi-k3:cloud', { tools: true })]
    expect(firstSuitableModel(ms, 'kimi-k3:cloud')).toBe(1)
  })

  it('senza predefinito: il primo che NON dichiara «niente tool»', () => {
    const ms = [model('no-tools', { tools: false }), model('con-tools', { tools: true }), model('sconosciuto')]
    expect(firstSuitableModel(ms, null)).toBe(1)
  })

  it('tutti sconosciuti o lista vuota: il primo (o -1)', () => {
    expect(firstSuitableModel([model('a'), model('b')], null)).toBe(0)
    expect(firstSuitableModel([], null)).toBe(-1)
  })
})
