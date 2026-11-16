// U4 (fase prima-release): «Libera spazio» libera davvero e mostra cosa sta
// facendo. La sezione carica i dati con un effetto (nel render statico parte
// vuota): gli STATI VISIVI si provano sul componente presentazionale
// PruneFeedback (spinner «Libero spazio…», «Liberati X» misurati sul disco,
// «Non c'era niente da liberare.»), la soglia dei 50 MB sulla pura
// pruneOutcome, e il wiring (RPC boxSpacePrune, ricarica, errore della build
// in corso, tutti i bottoni disabilitati mentre lavora) con le guardie sul
// sorgente — il pattern del repo per i componenti a effetti.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml } from './render-helper'
import { pruneOutcome, PruneFeedback, fmtBytes, PRUNE_NOTHING_THRESHOLD_BYTES } from '../components/settings/DiskSpaceSection'

const SRC = readFileSync(fileURLToPath(new URL('../components/settings/DiskSpaceSection.tsx', import.meta.url)), 'utf8')

describe('U4: pruneOutcome (pura) — sotto i 50 MB non c\'era niente da liberare', () => {
  it('null o non finito → niente da dire', () => {
    expect(pruneOutcome(null)).toBe(null)
    expect(pruneOutcome(Number.NaN)).toBe(null)
  })
  it('sopra la soglia → i byte liberati; la soglia esatta è 50 MB', () => {
    expect(PRUNE_NOTHING_THRESHOLD_BYTES).toBe(50_000_000)
    expect(pruneOutcome(6_946_705_408)).toEqual({ kind: 'freed', bytes: 6_946_705_408 })
    expect(pruneOutcome(50_000_000)).toEqual({ kind: 'freed', bytes: 50_000_000 })
    expect(pruneOutcome(49_999_999)).toEqual({ kind: 'nothing' })
    expect(pruneOutcome(0)).toEqual({ kind: 'nothing' })
  })
})

describe('U4: PruneFeedback — spinner mentre libera, poi l\'esito', () => {
  it('lavorando: spinner e «Libero spazio…» (testid disk-space-prune-working)', () => {
    const html = renderHtml(createElement(PruneFeedback, { working: true, outcome: null }))
    expect(html).toContain('data-testid="disk-space-prune-working"')
    expect(html).toContain('Libero spazio…')
    expect(html).toContain('animate-spin')
  })
  it('esito con i byte DAVVERO liberati: «Liberati 6,9 GB» (misurati sul disco)', () => {
    const html = renderHtml(createElement(PruneFeedback, { working: false, outcome: { kind: 'freed', bytes: 6_946_705_408 } }))
    expect(html).toContain('data-testid="disk-space-freed"')
    expect(html).toContain(`Liberati ${fmtBytes(6_946_705_408)}`)
  })
  it('guadagno sotto la soglia: «Non c\'era niente da liberare.»', () => {
    const html = renderHtml(createElement(PruneFeedback, { working: false, outcome: { kind: 'nothing' } }))
    expect(html).toContain('data-testid="disk-space-nothing"')
    // il rendering statico escapa l'apostrofo («&#x27;»)
    expect(html).toContain('Non c&#x27;era niente da liberare.')
  })
  it('ferma e senza esito: non c\'è nessuna riga', () => {
    const html = renderHtml(createElement(PruneFeedback, { working: false, outcome: null }))
    expect(html).not.toContain('disk-space-prune-working')
    expect(html).not.toContain('disk-space-freed')
    expect(html).not.toContain('disk-space-nothing')
  })
})

describe('U4: il wiring della sezione (guarda sul codice, come OB3/sandbox-mode)', () => {
  it('il clic «Libera spazio» chiama boxSpacePrune, poi ricarica la sezione', () => {
    expect(SRC).toContain("id === 'reclaimable'")
    expect(SRC).toContain('api.boxSpacePrune()')
  })
  it('mentre lavora il bottone dice «Libero spazio…» e TUTTI i bottoni della sezione sono disabilitati', () => {
    expect(SRC).toMatch(/busy === 'reclaimable'/)
    expect(SRC).toContain('disabled={busy !== null || row.bytes === null}')
  })
  it("l'esito arriva da freedBytes della RPC tramite pruneOutcome", () => {
    expect(SRC).toContain('pruneOutcome(r.freedBytes')
  })
  it("l'errore «build in corso» ha il suo testo: «Il computer dei bot si sta costruendo: riprova quando ha finito»", () => {
    expect(SRC).toContain("'build-in-progress'")
    expect(SRC).toContain('Il computer dei bot si sta costruendo')
  })
})
