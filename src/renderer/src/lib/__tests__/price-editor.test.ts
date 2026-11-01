// Fase 18b (K2): la selezione delle righe dell'editor dei prezzi
// personalizzati — funzione PURA, nessun React, nessuno store.
import { describe, expect, it } from 'vitest'
import { priceEditorRows } from '../price-editor'
import type { ModelUsageRow } from '../../../../shared/types'

/** Una riga di usage:summary (vista per modello) con i soli campi che contano. */
const row = (patch: Partial<ModelUsageRow> = {}): ModelUsageRow => ({
  calls: 1,
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
  costPartial: false,
  providerId: 'p1',
  providerKind: 'zai',
  model: 'glm-5.3',
  source: 'turn',
  agentId: null,
  agentName: null,
  ...patch
})

describe('fase 18b K2: priceEditorRows — chi entra nell\'editor dei prezzi', () => {
  it('riga MAI prezzata (costUsd null, non locale) → entra', () => {
    expect(priceEditorRows([row()], {})).toEqual([
      { providerId: 'p1', model: 'glm-5.3', providerKind: 'zai' }
    ])
  })

  it('riga PARZIALE (costPartial) → entra ANCHE con un costo noto', () => {
    expect(priceEditorRows([row({ costUsd: 0.01, costPartial: true })], {})).toHaveLength(1)
  })

  it('riga COMPLETA con prezzo SALVATO → resta nell\'editor (un prezzo sbagliato si corregge)', () => {
    const rows = [row({ costUsd: 1.23, costPartial: false })]
    const prices = { p1: { 'glm-5.3': { input: 1, output: 2 } } }
    expect(priceEditorRows(rows, prices)).toEqual([
      { providerId: 'p1', model: 'glm-5.3', providerKind: 'zai' }
    ])
  })

  it('riga COMPLETA senza prezzo salvato (costo di catalogo) → NON entra', () => {
    expect(priceEditorRows([row({ costUsd: 1.23, costPartial: false, providerKind: 'groq', model: 'llama' })], {})).toEqual([])
  })

  it('prezzo SALVATO senza chiamate nel periodo → entra lo stesso (un prezzo salvato si vede sempre)', () => {
    const prices = { p9: { 'altro-modello': { input: 1, output: 2 } } }
    const out = priceEditorRows([row()], prices)
    expect(out).toEqual([
      { providerId: 'p1', model: 'glm-5.3', providerKind: 'zai' },
      { providerId: 'p9', model: 'altro-modello', providerKind: '' }
    ])
  })

  it('modello LOCALE escluso — anche senza costo (ollama non ha un prezzo)', () => {
    expect(priceEditorRows([row({ providerKind: 'ollama' })], {})).toEqual([])
    // doppioni (stessa riga due volte, o riga + prezzo salvato) → UNA voce sola
    expect(priceEditorRows([row(), row()], { p1: { 'glm-5.3': { input: 1, output: 2 } } })).toEqual([
      { providerId: 'p1', model: 'glm-5.3', providerKind: 'zai' }
    ])
  })
})
