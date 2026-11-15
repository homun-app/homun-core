// MB3 (fase modalita-box): la scelta si VEDE e si CAMBIA nelle Impostazioni —
// la riga «Dove girano i comandi» nella scheda «Computer dei bot» (accanto a
// «Spazio su disco», Generali), l'azione di store sandboxModeSet (UNA RPC che
// scrive sandbox.mode E sandbox.modeSet insieme) e la card «Computer» che
// segue il cambio col meccanismo di CCK3 (readBoxInUse). «Sul computer del
// bot» senza preparazione avvia la preparazione con lo STESSO flusso della
// guida (boxSetupStart), nessun percorso nuovo.
import './render-helper-install'
import { describe, expect, it, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { stubApiMethod, callsOf, fakeApiCalls } from './render-helper-install'
import { useStore } from '../store'
import type { BoxSetupState, EngineStatusInfo } from '../../../shared/types'

const { EngineSection, modeChoiceLabel, modeChoiceHint, sandboxModeCoerced } = await import('../components/settings/EngineSection')
const { computerCardState } = await import('../lib/computer-card')

const notInstalled = (): EngineStatusInfo => ({
  setting: 'apple-container',
  chosen: null,
  appleState: 'not-installed',
  dockerRunning: false
})

const setupState = (patch: Partial<BoxSetupState>): BoxSetupState => ({
  phase: 'idle', bytes: null, total: null, buildPhase: null, error: null, startedAt: null, skipped: [], phaseStartedAt: null,
  neededBytes: 3_400_000_000, ...patch
})

const byTestId = (tree: ReturnType<typeof parseHtml>, testId: string) =>
  findAll(tree, (n) => n.attrs['data-testid'] === testId)

describe('MB3: le pure della riga — etichette, consigli e il valore storico', () => {
  it('le due voci della scelta (pura)', () => {
    expect(modeChoiceLabel('box')).toMatchObject({ message: 'Sul computer del bot' })
    expect(modeChoiceLabel('host')).toMatchObject({ message: 'Direttamente sul Mac' })
  })

  it('il consiglio del box e la frase del Mac (pura)', () => {
    expect(modeChoiceHint('box')).toMatchObject({ message: expect.stringContaining('Consigliato') })
    expect(modeChoiceHint('host')).toMatchObject({ message: expect.stringContaining('approvazioni') })
  })

  it("il valore storico 'docker' si LEGGE come box (come sandboxMode)", () => {
    expect(sandboxModeCoerced('docker')).toBe('box')
    expect(sandboxModeCoerced('box')).toBe('box')
    expect(sandboxModeCoerced('host')).toBe('host')
  })
})

describe('MB3: la riga «Dove girano i comandi» nella scheda Computer dei bot', () => {
  beforeEach(() => {
    stubApiMethod('boxEngineStatus', () => notInstalled())
    stubApiMethod('settingsGet', (key, fallback) => (String(key) === 'sandbox.mode' ? 'host' : fallback))
  })

  it('i due bottoni della scelta con i loro testi (render del componente VERO)', () => {
    setStoreStateForRender(useStore, { boxSetup: null })
    const html = renderHtml(createElement(EngineSection))
    const tree = parseHtml(html)
    expect(byTestId(tree, 'sandbox-mode-box').length).toBe(1)
    expect(byTestId(tree, 'sandbox-mode-host').length).toBe(1)
    expect(html).toContain('Sul computer del bot')
    expect(html).toContain('Direttamente sul Mac')
    expect(html).toContain('Dove girano i comandi')
  })

  it('il clic passa dalla scelta all\'azione di store sandboxModeSet (guardia sul sorgente, come OB3)', () => {
    const SRC = readFileSync(fileURLToPath(new URL('../components/settings/EngineSection.tsx', import.meta.url)), 'utf8')
    expect(SRC).toContain('sandbox-mode-${id}')
    expect(SRC).toContain('sandboxModeSet(')
  })
})

describe('MB3: sandboxModeSet — l\'azione di store (api finta)', () => {
  beforeEach(() => {
    stubApiMethod('boxModeSet', () => ({ mode: 'box', modeSet: true }))
    stubApiMethod('settingsGet', (key, fallback) => (String(key) === 'sandbox.mode' ? 'box' : fallback))
    stubApiMethod('boxSetupStart', () => null)
    fakeApiCalls.length = 0 // il registro dell'api finta è di MODULO: si azzera a ogni test
    useStore.setState({ boxInUse: false, boxSetup: null })
  })

  it('la scelta scrive mode E modeSet: UNA sola RPC box:mode-set col valore', async () => {
    await useStore.getState().sandboxModeSet('host')
    expect(callsOf('boxModeSet')).toHaveLength(1)
    expect(callsOf('boxModeSet')[0]!.args[0]).toBe('host')
  })

  it('«Sul computer del bot» SENZA preparazione avvia la preparazione — la STESSA della guida (boxSetupStart)', async () => {
    useStore.setState({ boxSetup: null })
    await useStore.getState().sandboxModeSet('box')
    expect(callsOf('boxSetupStart').length).toBe(1)
    // e anche dall'errore o dall'annullato si riparte (la scelta dell'utente)
    fakeApiCalls.length = 0
    useStore.setState({ boxSetup: setupState({ phase: 'error', error: { phase: 'downloading', code: 'download', message: 'x' } }) })
    await useStore.getState().sandboxModeSet('box')
    useStore.setState({ boxSetup: setupState({ phase: 'cancelled' }) })
    await useStore.getState().sandboxModeSet('box')
    expect(callsOf('boxSetupStart').length).toBe(2)
  })

  it('con la preparazione GIÀ fatta (ready) o in corsa NON riparte; «Direttamente sul Mac» non parte mai', async () => {
    useStore.setState({ boxSetup: setupState({ phase: 'ready' }) })
    await useStore.getState().sandboxModeSet('box')
    useStore.setState({ boxSetup: setupState({ phase: 'downloading' }) })
    await useStore.getState().sandboxModeSet('box')
    useStore.setState({ boxSetup: null })
    await useStore.getState().sandboxModeSet('host')
    expect(callsOf('boxSetupStart').length).toBe(0)
  })

  it('dopo il cambio la card passa da «Non in uso» a «Spento»/«In attesa» (CCK3: readBoxInUse)', async () => {
    const before = computerCardState({ boxRuntime: null, activity: null, browser: 'stopped', boxSetupPhase: null, boxInUse: false })
    expect(before.status).toBe('unavailable') // «Non in uso», come dalla prova della beta.5
    expect(useStore.getState().boxInUse).toBe(false)
    await useStore.getState().sandboxModeSet('box')
    expect(useStore.getState().boxInUse).toBe(true) // la modalità si è RILETTA
    const after = computerCardState({ boxRuntime: null, activity: null, browser: 'stopped', boxSetupPhase: null, boxInUse: true })
    expect(after.status).not.toBe('unavailable') // «Spento»: il computer del bot c'è, adesso
  })
})
