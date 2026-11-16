// U6 (fase prima-release): «Compatibile OpenAI» con Nome, Indirizzo e Chiave
// FACOLTATIVA («Prova» col solo indirizzo), l'URL vero della prova sotto il
// campo, il modello a mano quando /models manca o è vuoto, «Altro…» accanto
// alle pillole, e l'icona Server generica (nessun marchio: non è un'azienda).
// Il pannello della guida è stato interno al componente: i campi si provano
// con le guardie sul sorgente (il pattern del repo), le regole con le pure.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml } from './render-helper'
import { ProviderMark } from '../components/settings/AddProviderSheet'
import { suggestedNameOf, probeButtonDisabled } from '../lib/use-provider-setup'

const GUIDE = readFileSync(fileURLToPath(new URL('../components/GuideModelStep.tsx', import.meta.url)), 'utf8')
const SHEET = readFileSync(fileURLToPath(new URL('../components/settings/AddProviderSheet.tsx', import.meta.url)), 'utf8')
const SETUP = readFileSync(fileURLToPath(new URL('../lib/use-provider-setup.ts', import.meta.url)), 'utf8')

describe('U6: il Nome si precompila con l\'host (pura)', () => {
  it('l\'host dell\'indirizzo, senza schema né porta', () => {
    expect(suggestedNameOf('http://127.0.0.1:8000/v1')).toBe('127.0.0.1')
    expect(suggestedNameOf('http://nas.local:8080')).toBe('nas.local')
    expect(suggestedNameOf('https://api.together.xyz/v1')).toBe('api.together.xyz')
    expect(suggestedNameOf('')).toBe('')
  })
})

describe('U6: «Prova» si abilita col SOLO indirizzo (pura)', () => {
  it('per il compatibile serve l\'indirizzo, NON la chiave; per i tipi a chiave resta la chiave', () => {
    expect(probeButtonDisabled({ probing: false, apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', needsAddress: true })).toBe(false)
    expect(probeButtonDisabled({ probing: true, apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', needsAddress: true })).toBe(true)
    expect(probeButtonDisabled({ probing: false, apiKey: '', baseUrl: '  ', needsAddress: true })).toBe(true)
    expect(probeButtonDisabled({ probing: false, apiKey: 'sk-x', baseUrl: '', needsAddress: false })).toBe(false)
    expect(probeButtonDisabled({ probing: false, apiKey: '', baseUrl: '', needsAddress: false })).toBe(true)
  })
})

describe('U6: i campi della guida (guarda sul sorgente, come i test del pannello di oggi)', () => {
  it('il campo Nome precompilato con l\'host, salvato come name del provider', () => {
    expect(GUIDE).toContain('data-testid="guide-name-input"')
    expect(GUIDE).toContain('suggestedNameOf')
    expect(SETUP).toContain('suggestedNameOf')
  })

  it('la chiave è FACOLTATIVA: la nota e la regola del «Prova»', () => {
    expect(GUIDE).toContain('lasciala vuota se il server non la chiede')
    expect(GUIDE).toContain('probeButtonDisabled')
  })

  it('sotto l\'indirizzo, l\'URL che la prova chiama davvero (niente correzioni silenziose)', () => {
    expect(GUIDE).toContain('data-testid="guide-probe-url"')
    expect(GUIDE).toMatch(/openAiCompatBase|liveModelsUrl/)
  })

  it('il modello a mano quando /models manca o è vuoto, e «Altro…» accanto alle pillole', () => {
    expect(GUIDE).toContain('data-testid="guide-manual-model"')
    expect(GUIDE).toContain('data-testid="guide-model-other"')
    // il campo compare quando la prova È ARRIVATA ma l'elenco è vuoto
    expect(GUIDE).toMatch(/setup\.probe\.ok === true[\s\S]{0,1600}models\.length === 0/)
  })

  it('il foglio delle Impostazioni: nome precompilato, chiave facoltativa, modello a mano', () => {
    expect(SHEET).toContain('suggestedNameOf')
    expect(SHEET).toContain('data-testid="sheet-manual-model"')
  })

  it('il salvataggio usa il NOME scritto (non «Server» di fabbrica)', () => {
    expect(SETUP).toMatch(/name\.trim\(\) \|\| suggested/)
  })
})

describe('U6: l\'icona generica Server per il compatibile (nessun marchio)', () => {
  it('ProviderMark per openai-compatible e custom: icona lucide Server, monocroma, niente iniziale-botta', () => {
    for (const kind of ['openai-compatible', 'custom']) {
      const html = renderHtml(createElement(ProviderMark, { kind, name: 'Il mio gateway' }))
      expect(html).toContain('lucide-server')
      expect(html).not.toContain('dark:bg-white')
    }
  })

  it('un kind col marchio resta col suo trattamento (anthropic inline)', () => {
    const html = renderHtml(createElement(ProviderMark, { kind: 'anthropic', name: 'Anthropic' }))
    expect(html).toContain('<svg')
    expect(html).not.toContain('lucide-server')
  })
})
