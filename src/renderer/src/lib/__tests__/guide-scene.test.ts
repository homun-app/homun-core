// G2 (fase guida): le funzioni pure della scena — guideMood e guideBubble,
// coi testi del mockup approvato in Lingui it/en. I msgid nascono dalle
// macro msg: i cataloghi compilati (it/en messages.mjs) devono contenerli,
// così la nuvoletta esce nella lingua giusta senza modello né token.
import { describe, expect, it, beforeAll } from 'vitest'
import { i18n } from '@lingui/core'
import { messages as itMessages } from '../../locales/it/messages.mjs'
import { messages as enMessages } from '../../locales/en/messages.mjs'

// i cataloghi compilati sono Record<string, unknown> per il d.ts: qui sono stringhe
const itMsgs = itMessages as unknown as Record<string, string>
const enMsgs = enMessages as unknown as Record<string, string>
import { guideMood, guideBubble, EMPTY_GUIDE_FACTS, type GuideFacts } from '../guide-scene'

const facts = (patch: Partial<GuideFacts>): GuideFacts => ({ ...EMPTY_GUIDE_FACTS, ...patch })

beforeAll(() => {
  i18n.load('it', itMsgs)
  i18n.load('en', enMsgs)
})

/** La frase nella lingua data (activate + t, come la UI). */
const phrase = (lang: 'it' | 'en', step: Parameters<typeof guideBubble>[0], f: GuideFacts): string => {
  i18n.activate(lang)
  return i18n.t(guideBubble(step, f))
}

describe('G2 guideMood (pura): l\'umore della mascotte per passo e fatti', () => {
  it('passo Tu: idle, e happy finché dura il lampo dopo faccia o colore', () => {
    expect(guideMood('welcome', facts({}))).toBe('idle')
    expect(guideMood('welcome', facts({ flashHappy: true }))).toBe('happy')
  })

  it('passo Modello: thinking senza scelta; listening durante prova o download; happy col modello pronto; waiting con la chiave rifiutata', () => {
    expect(guideMood('model', facts({}))).toBe('thinking')
    expect(guideMood('model', facts({ providerPath: 'cloud', probe: 'testing' }))).toBe('listening')
    expect(guideMood('model', facts({ providerPath: 'local', download: 'running' }))).toBe('listening')
    expect(guideMood('model', facts({ modelReady: true }))).toBe('happy')
    expect(guideMood('model', facts({ providerPath: 'cloud', probe: 'bad' }))).toBe('waiting')
  })

  it('la prova in corso vince anche col modello pronto (si vede che ascolta)', () => {
    expect(guideMood('model', facts({ modelReady: true, probe: 'testing' }))).toBe('listening')
  })

  it('passo Permessi: speaking. Passo Pronto: happy', () => {
    expect(guideMood('approvals', facts({}))).toBe('speaking')
    expect(guideMood('ready', facts({}))).toBe('happy')
  })
})

describe('G2 guideBubble (pura): le frasi della nuvoletta, in it e en', () => {
  it('passo Tu: il saluto, e col nome scritto la frase col nome', () => {
    expect(phrase('it', 'welcome', facts({}))).toBe('Ciao! Sono il tuo nuovo bot. Come mi chiami?')
    expect(phrase('it', 'welcome', facts({ name: 'Nanna' }))).toBe('Nanna? Mi piace. E che faccia ho?')
    expect(phrase('en', 'welcome', facts({}))).toBe('Hi! I’m your new bot. What will you call me?')
    expect(phrase('en', 'welcome', facts({ name: 'Nanna' }))).toBe('Nanna? I like it. And what do I look like?')
  })

  it('passo Modello senza scelta: «mi serve un cervello»', () => {
    expect(phrase('it', 'model', facts({}))).toBe('Mi serve un cervello. Con cosa penso?')
    expect(phrase('en', 'model', facts({}))).toBe('I need a brain. What do I think with?')
  })

  it('passo Modello cloud: invito, prova, riuscita, rifiuto', () => {
    expect(phrase('it', 'model', facts({ providerPath: 'cloud' }))).toBe('Incolla la chiave: la provo subito.')
    expect(phrase('it', 'model', facts({ providerPath: 'cloud', probe: 'testing' }))).toBe('Provo la chiave…')
    expect(phrase('it', 'model', facts({ providerPath: 'cloud', probe: 'ok', modelReady: true }))).toBe('Funziona! Sento già i pensieri.')
    expect(phrase('it', 'model', facts({ providerPath: 'cloud', probe: 'bad' }))).toBe('Mmh, questa chiave non entra.')
    expect(phrase('en', 'model', facts({ providerPath: 'cloud', probe: 'testing' }))).toBe('Testing the key…')
  })

  it('passo Modello Ollama: l\'invito a scegliere, e il modello scelto', () => {
    expect(phrase('it', 'model', facts({ providerPath: 'ollama' }))).toBe('Hai già Ollama: scegli un modello.')
    expect(phrase('it', 'model', facts({ providerPath: 'ollama', ollamaChosen: true }))).toBe('Perfetto, uso quello sul Mac.')
    expect(phrase('en', 'model', facts({ providerPath: 'ollama' }))).toBe('You already have Ollama: pick a model.')
  })

  it('passo Modello Integrato: invito, download, pronto', () => {
    expect(phrase('it', 'model', facts({ providerPath: 'local' }))).toBe('Posso pensare tutto qui sul Mac.')
    expect(phrase('it', 'model', facts({ providerPath: 'local', download: 'running' }))).toBe('Scarico… ci vuole qualche minuto.')
    expect(phrase('it', 'model', facts({ providerPath: 'local', download: 'done' }))).toBe('Scaricato: penso da qui.')
    expect(phrase('en', 'model', facts({ providerPath: 'local', download: 'running' }))).toBe('Downloading… it takes a few minutes.')
  })

  it('passo Permessi e Pronto', () => {
    expect(phrase('it', 'approvals', facts({}))).toBe('Quanto posso fare senza chiederti?')
    expect(phrase('it', 'ready', facts({}))).toBe('Eccomi! Andiamo?')
    expect(phrase('en', 'approvals', facts({}))).toBe('How much can I do without asking you?')
    expect(phrase('en', 'ready', facts({}))).toBe('Here I am! Shall we go?')
  })
})
