// Fase pagine · ritocchi (P3): i suggerimenti seguono la lingua
// dell'interfaccia. Il modello puro non restituisce più label (visto nei test
// di lib/bot-suggestions); qui si guarda la UI e i cataloghi, come le altre
// guardie del renderer (niente jsdom): la UI costruisce il testo da
// action.kind (più il nome dell'app) con i msg macro di Lingui, e il testo
// precompilato della routine segue la lingua dell'UTENTE (setting
// agent.userLanguage, o la lingua dell'interfaccia) — «Fai di questo una
// routine: …» / «Make this a routine: …». Il comportamento VERO in inglese
// («Connect Slack») lo verifica la sonda scripts/fase-pagine-probe.mjs.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePo } from './po-helper'

const PANEL = fileURLToPath(new URL('../components/RightPanel.tsx', import.meta.url))
const MODEL = fileURLToPath(new URL('../lib/bot-suggestions.ts', import.meta.url))
const I18N = fileURLToPath(new URL('../lib/i18n.ts', import.meta.url))
const panelSrc = readFileSync(PANEL, 'utf8')
const modelSrc = readFileSync(MODEL, 'utf8')
const i18nSrc = readFileSync(I18N, 'utf8')

/** Il blocco di un componente interno (dalla `function Nome` al successivo). */
function block(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato`)
  const next = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, next > 0 ? next : undefined)
}

describe('P3: la UI costruisce il testo dei suggerimenti con Lingui', () => {
  it('le tre etichette nascono da action.kind coi msg macro (Collega + nome app)', () => {
    const sec = block(panelSrc, 'SuggestionsBlock')
    expect(sec).toContain('msg`Collega ${')
    expect(sec).toContain('msg`Crea una routine`')
    expect(sec).toContain('msg`Descrivi cosa fa questo bot`')
  })

  it('nessuna label presa dal modello: il testo non arriva più dalla funzione pura', () => {
    expect(panelSrc).not.toContain('s.label')
    expect(modelSrc).not.toContain('Collega ')
    expect(modelSrc).not.toContain('Crea una routine')
    expect(modelSrc).not.toContain('Descrivi cosa fa questo bot')
    expect(modelSrc).not.toContain('Fai di questo una routine')
  })

  it('il nome dell\'app per l\'etichetta arriva dalle app del catalogo (appId → nome)', () => {
    const sec = block(panelSrc, 'SuggestionsBlock')
    expect(sec).toMatch(/appId.*name|name.*appId/s)
  })
})

describe('P3: il testo precompilato della routine segue la lingua dell\'utente', () => {
  it('la UI legge agent.userLanguage e ripiega sulla lingua dell\'interfaccia', () => {
    const sec = block(panelSrc, 'SuggestionsBlock')
    expect(sec).toContain('agent.userLanguage')
    expect(sec).toContain('activeLanguage')
  })

  it('la frase precompilata vive nei msg macro; quando la lingua dell\'utente DIFFERISCE da quella attiva si legge il catalogo di quella lingua', () => {
    const sec = block(panelSrc, 'SuggestionsBlock')
    expect(sec).toContain('msg`Fai di questo una routine: ${')
    expect(sec).toContain('phraseIn')
    expect(i18nSrc).toContain('export async function phraseIn')
  })
})

describe('P3: i cataloghi hanno le frasi dei suggerimenti in it e in en', () => {
  const catIt = parsePo('it')
  const catEn = parsePo('en')

  it('«Collega {0}» si traduce «Connect {0}» (l\'etichetta con la UI in inglese)', () => {
    expect(catEn.get('Collega {0}')).toBe('Connect {0}')
  })

  it('«Crea una routine» si traduce «Create a routine»', () => {
    expect(catIt.get('Crea una routine')).toBe('Crea una routine')
    expect(catEn.get('Crea una routine')).toBe('Create a routine')
  })

  it('«Descrivi cosa fa questo bot» si traduce «Describe what this bot does»', () => {
    expect(catEn.get('Descrivi cosa fa questo bot')).toBe('Describe what this bot does')
  })

  it('«Fai di questo una routine: {request}» si traduce «Make this a routine: {request}»', () => {
    expect(catIt.get('Fai di questo una routine: {request}')).toBe('Fai di questo una routine: {request}')
    expect(catEn.get('Fai di questo una routine: {request}')).toBe('Make this a routine: {request}')
  })
})
