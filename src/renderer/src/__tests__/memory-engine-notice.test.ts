// Fase memoria-engramma v0.6.19 (E1): l'avviso del motore nella sezione
// «Memoria» — MemoryEngineNotice.tsx. Il motivo «space» (non c'è lo spazio
// per copiare le celle prima che il motore nuovo le aggiorni: la memoria
// resta com'è) deve dire all'utente cosa fare, cioè quanto liberare; gli
// altri motivi restano la frase di prima. Il GB è decimale come in tutto
// Homun (disk-space.ts) e arrotondato per eccesso: meglio chiedere un po'
// di più che pochi byte.
//
// Il componente è PURO (riceve lo stato del motore, non chiama nessuno): la
// sezione Memoria lo carica con un effetto, che in renderToStaticMarkup non
// gira — così l'avviso si rende vero nei test. Il componente VERO, il
// catalogo IT compilato, l'HTML letto come negli altri test del renderer.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHtml, parseHtml, textOf } from './render-helper'
import { MemoryEngineNotice } from '../components/MemoryEngineNotice'

const render = (engine: Parameters<typeof MemoryEngineNotice>[0]['engine']): string =>
  textOf(parseHtml(renderHtml(createElement(MemoryEngineNotice, { engine }))))
const PRIMA = 'Motore della memoria non disponibile: le memorie non si leggono né si scrivono finché non torna.'

describe('E1: l’avviso del motore della memoria', () => {
  it('col motivo space dice quanto liberare, in GB per eccesso: «…liberane 2 GB»', () => {
    expect(render({ available: false, reason: 'space', neededBytes: 1_500_000_000 })).toBe(
      'Serve spazio sul disco per aggiornare la memoria in sicurezza: liberane 2 GB'
    )
    expect(render({ available: false, reason: 'space', neededBytes: 7_000_000_001 })).toBe(
      'Serve spazio sul disco per aggiornare la memoria in sicurezza: liberane 8 GB'
    )
  })

  it('meno di un GB, o un valore che non arriva, si dice 1 GB (mai 0)', () => {
    expect(render({ available: false, reason: 'space', neededBytes: 1 })).toMatch(/liberane 1 GB$/)
    expect(render({ available: false, reason: 'space' })).toMatch(/liberane 1 GB$/)
  })

  it('gli altri motivi restano la frase di prima (il motore non c’è), col motivo o senza', () => {
    for (const reason of ['module', 'open', 'closed', undefined] as const) {
      expect(render({ available: false, ...(reason ? { reason } : {}) })).toBe(PRIMA)
    }
  })

  it('col motore disponibile non disegna nulla', () => {
    expect(renderHtml(createElement(MemoryEngineNotice, { engine: { available: true, version: '0.6.19-beta.1' } }))).toBe('')
  })

  // E3: una cella aggiornata da un Engramma più recente del .node (SCHEMA_TOO_NEW)
  it('E3: col motivo schema-too-new dice di aggiornare Homun — è la memoria che non si tocca, non lui', () => {
    expect(render({ available: false, reason: 'schema-too-new' })).toBe(
      'Questa memoria è stata aggiornata da una versione più recente di Engramma: aggiorna Homun'
    )
  })

  it('la sezione Memoria mostra l’avviso al posto del testo fisso di prima', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'components', 'MemoryPanel.tsx'), 'utf8')
    expect(src).toContain('<MemoryEngineNotice engine={overview.engine} />')
    // il testo fisso non resta due volte: vive nel componente dell'avviso
    expect(src).not.toContain('Motore della memoria non disponibile')
  })
})
