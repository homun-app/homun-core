// OB4 (fase onboarding-b): la preparazione in background DOPO la guida —
// una riga discreta nel pannello del bot principale, sotto «Computer»:
// «In preparazione… N%» mentre scarica (o senza percentuale nelle altre
// fasi), «Serve la tua password: Apri l'installazione» sull'attesa
// dell'Installer (il bottone RIAPRE l'installazione), e a fine «Pronto».
// Render statico del componente VERO col store.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { useStore } from '../store'
import type { BoxSetupState } from '../../../shared/types'

const { ComputerPrepRow } = await import('../components/ComputerPrepRow')

const setupState = (patch: Partial<BoxSetupState>): BoxSetupState => ({
  phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null, skipped: [], phaseStartedAt: null,
  neededBytes: 3_400_000_000, ...patch
})

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

const textOf = (n: ReturnType<typeof parseHtml>): string =>
  findAll(n, () => true).map((x) => x.text ?? '').join(' ')

const renderRow = (boxSetup: BoxSetupState | null): { html: string; tree: ReturnType<typeof parseHtml> } => {
  setStoreStateForRender(useStore, { boxSetup })
  const html = renderHtml(createElement(ComputerPrepRow))
  return { html, tree: parseHtml(html) }
}

describe('OB4: la riga della preparazione nel pannello del bot', () => {
  it('scarico: «In preparazione…» con la percentuale', () => {
    const { html } = renderRow(setupState({ phase: 'downloading', bytes: 250, total: 1000 }))
    expect(html).toContain('In preparazione… 25%')
  })

  it('le altre fasi che corrono: «In preparazione…» senza percentuale', () => {
    for (const phase of ['checking-space', 'verifying', 'starting-service', 'installing-kernel', 'building-image'] as const) {
      expect(renderRow(setupState({ phase })).html, phase).toContain('In preparazione…')
    }
  })

  it('attesa dell\'Installer: «Serve la tua password» col bottone «Apri l\'installazione»', () => {
    const { html, tree } = renderRow(setupState({ phase: 'awaiting-installer' }))
    expect(html).toContain('Serve la tua password')
    expect(byTestId(tree, 'bot-prep-open-installer').length).toBe(1)
    expect(html).toContain('Apri l’installazione')
  })

  it('a fine preparazione: «Pronto»', () => {
    expect(renderRow(setupState({ phase: 'ready' })).html).toContain('Pronto')
  })

  it('senza preparazione (o annullata, o in errore): NESSUNA riga — niente rumore', () => {
    expect(renderRow(null).html).not.toContain('In preparazione')
    expect(renderRow(setupState({ phase: 'idle' })).html).not.toContain('In preparazione')
    expect(renderRow(setupState({ phase: 'cancelled' })).html).not.toContain('In preparazione')
    expect(renderRow(setupState({ phase: 'error' })).html).not.toContain('In preparazione')
  })
})
