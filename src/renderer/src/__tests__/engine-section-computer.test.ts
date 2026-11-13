// OB3 (fase onboarding-b): Impostazioni › Generali, la scheda del motore —
// con `not-installed` il bottone «Installa» avvia la STESSA preparazione
// della guida (box:setup-start) e mostra la STESSA lista d'avanzamento
// (BoxSetupProgress, il componente condiviso); il link alle release resta
// come «Dettagli»; con la preparazione in corso o in errore la stessa
// lista con Riprova/Annulla. Render statico del componente VERO.
import './render-helper-install'
import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { useStore } from '../store'
import type { BoxSetupState, EngineStatusInfo } from '../../../shared/types'

const { EngineSection, engineStatusText, engineRowAction } = await import('../components/settings/EngineSection')
const { stubApiMethod } = await import('./render-helper-install')

const notInstalled = (): EngineStatusInfo => ({
  setting: 'apple-container',
  chosen: null,
  appleState: 'not-installed',
  dockerRunning: false
})

const setupState = (patch: Partial<BoxSetupState>): BoxSetupState => ({
  phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null, skipped: [],
  neededBytes: 3_400_000_000, ...patch
})

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

const renderEngine = (boxSetup: BoxSetupState | null): { html: string; tree: ReturnType<typeof parseHtml> } => {
  setStoreStateForRender(useStore, { boxSetup })
  const html = renderHtml(createElement(EngineSection))
  return { html, tree: parseHtml(html) }
}

describe('OB3: engineStatusText — not-installed ora ha l\'azione INSTALLA (pura)', () => {
  it('con not-installed l\'azione è «Installa» (la preparazione di OB1)', () => {
    expect(engineStatusText(notInstalled())).toMatchObject({ action: 'install' })
  })

  it('gli altri stati non cambiano', () => {
    expect(engineStatusText({ ...notInstalled(), appleState: 'stopped' })).toMatchObject({ action: 'start' })
    expect(engineStatusText({ ...notInstalled(), appleState: 'kernel-missing' })).toMatchObject({ action: 'kernel' })
    expect(engineStatusText({ ...notInstalled(), appleState: 'ready' })).toMatchObject({ action: null })
  })
})

describe('OB3: la scheda del motore con la preparazione', () => {
  beforeEach(() => {
    // la riga del motore la carica la RPC (useEffect): nel render statico si
    // stubba la risposta con lo stato richiesto dal test
    stubApiMethod('boxEngineStatus', () => notInstalled())
    stubApiMethod('boxSetupState', () => null)
  })

  it("not-installed: il bottone «Installa» e il link alle release come «Dettagli» (guardia sul sorgente)", () => {
    // la riga del motore la carica la RPC (useEffect): nel render statico
    // l'effetto non gira, quindi il bottone e il link sono una guardia sul
    // sorgente — dal vivo li prova la sonda (OB6) con clic veri
    const SRC = readFileSync(fileURLToPath(new URL('../components/settings/EngineSection.tsx', import.meta.url)), 'utf8')
    expect(SRC).toContain('data-testid="engine-install"')
    expect(SRC).toContain('void boxSetupStart()')
    expect(SRC).toContain('Dettagli')
    expect(SRC).toContain('https://github.com/apple/container/releases')
  })

  it("la preparazione in corsa: la STESSA lista d'avanzamento della guida", () => {
    const { tree } = renderEngine(setupState({ phase: 'downloading', bytes: 500, total: 1000 }))
    expect(byTestId(tree, 'box-setup-progress').length).toBe(1)
    expect(byTestId(tree, 'box-setup-row-download')[0]!.attrs['data-status']).toBe('running')
    expect(byTestId(tree, 'box-setup-cancel').length).toBe(1)
  })

  it("sull'attesa dell'Installer: il bottone «Apri l'installazione»", () => {
    const { tree } = renderEngine(setupState({ phase: 'awaiting-installer' }))
    expect(byTestId(tree, 'box-setup-open-installer').length).toBe(1)
  })

  it("l'errore: il messaggio in parole con «Riprova»", () => {
    const { html, tree } = renderEngine(setupState({
      phase: 'error',
      error: { phase: 'downloading', code: 'download', message: 'Il download dello strumento di Apple non è riuscito.' }
    }))
    expect(html).toContain('Il download dello strumento di Apple non è riuscito.')
    expect(byTestId(tree, 'engine-setup-retry').length).toBe(1)
  })

  it('pronta o mai partita: nessuna lista (la riga del motore basta)', () => {
    expect(byTestId(renderEngine(null).tree, 'box-setup-progress').length).toBe(0)
    expect(byTestId(renderEngine(setupState({ phase: 'ready' })).tree, 'box-setup-progress').length).toBe(0)
  })
})

describe('OBR4: nella scheda del motore, con la preparazione in errore, resta solo «Riprova»', () => {
  beforeEach(() => {
    stubApiMethod('boxEngineStatus', () => notInstalled())
    stubApiMethod('boxSetupState', () => null)
  })

  it('engineRowAction (pura): con error l\'azione «Installa» sparisce — fa la stessa cosa di «Riprova»', () => {
    expect(engineRowAction('install', 'error')).toBeNull()
    // fuori dall'errore «Installa» resta
    expect(engineRowAction('install', null)).toBe('install')
    expect(engineRowAction('install', 'idle')).toBe('install')
    expect(engineRowAction('install', 'cancelled')).toBe('install')
    // «Accendi» e «Installa il kernel» (BX4) non sono la preparazione: restano
    expect(engineRowAction('start', 'error')).toBe('start')
    expect(engineRowAction('kernel', 'error')).toBe('kernel')
    expect(engineRowAction(null, 'error')).toBeNull()
  })

  it('il bottone «Installa» passa da quell\'azione (guardia sul sorgente: nel render statico la riga del motore non si carica)', () => {
    const SRC = readFileSync(fileURLToPath(new URL('../components/settings/EngineSection.tsx', import.meta.url)), 'utf8')
    expect(SRC).toContain('engineRowAction(status?.action ?? null, boxSetup?.phase ?? null)')
    expect(SRC).toContain("{rowAction === 'install' && (")
    expect(SRC).not.toContain("{status?.action === 'install' && (")
  })

  it("nel render dell'errore: il messaggio, UN «Riprova» e nessun «Installa»", () => {
    const { html, tree } = renderEngine(setupState({
      phase: 'error',
      error: { phase: 'verifying', code: 'sha256', message: 'Il pacchetto scaricato non è quello atteso: l’ho cancellato.' }
    }))
    expect(html).toContain('Il pacchetto scaricato non è quello atteso')
    expect(byTestId(tree, 'engine-setup-retry').length).toBe(1)
    expect(byTestId(tree, 'engine-install').length).toBe(0)
  })
})
