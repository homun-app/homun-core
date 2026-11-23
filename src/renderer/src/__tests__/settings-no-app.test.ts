// PP3 (fase plugin-pulita): «App e skill» esce dalle Impostazioni. La voce
// diceva solo «stanno nella pagina Plugin › Apri»: una voce che manda
// altrove è rumore. Ora la colonna ha sei sezioni; chi chiede ancora la
// scheda 'app' (un chiamante di setSettingsTab, un rimando vecchio) arriva
// alla pagina Plugin e le Impostazioni si chiudono. E nessun testo del
// prodotto cita più «App e skill».
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll, dialogPassThroughMock } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const SETTINGS_SRC = readFileSync(fileURLToPath(new URL('../components/Settings.tsx', import.meta.url)), 'utf8')
const { Settings } = await import('../components/Settings')
const { useStore } = await import('../store')

const SEZIONI = ['Generali', 'Modelli', 'Approvazioni', 'Cassaforte', 'Routine', 'Uso e costi']
const renderColumn = (): string[] => {
  setStoreStateForRender(useStore, { settingsOpen: true, settingsTab: null })
  const tree = parseHtml(renderHtml(createElement(Settings)))
  return findAll(tree, (n) => n.tag === 'nav' && (n.attrs.class ?? '').includes('space-y-0.5')).flatMap((nav) =>
    findAll(nav, (n) => n.tag === 'button').map((b) => textOf(b).trim())
  )
}

describe('PP3: la colonna delle Impostazioni non ha più «App e skill»', () => {
  it('le sezioni sono sei: Generali · Modelli · Approvazioni · Cassaforte · Routine · Uso e costi', () => {
    expect(renderColumn()).toEqual(SEZIONI)
  })

  it('nel sorgente non restano né la voce né il pezzo che diceva «vai alla pagina Plugin»', () => {
    expect(SETTINGS_SRC).not.toContain('App e skill')
    expect(SETTINGS_SRC).not.toContain('AppPluginRedirect')
    expect(SETTINGS_SRC).not.toContain('settings-open-plugin')
  })
})

describe("PP3: chi chiede ancora la scheda 'app' arriva alla pagina Plugin", () => {
  it("setSettingsTab('app') apre la pagina Plugin, chiude le Impostazioni e non lascia una scheda appesa", async () => {
    setStoreStateForRender(useStore, { settingsOpen: true, settingsTab: null, pluginOpen: false })
    useStore.getState().setSettingsTab('app')
    const s = useStore.getState()
    expect(s.pluginOpen).toBe(true)
    expect(s.settingsOpen).toBe(false)
    expect(s.settingsTab).toBe(null)
  })

  it("le altre schede si aprono come prima: setSettingsTab('vault') non apre la pagina Plugin", () => {
    setStoreStateForRender(useStore, { settingsOpen: true, settingsTab: null, pluginOpen: false })
    useStore.getState().setSettingsTab('vault')
    const s = useStore.getState()
    expect(s.settingsTab).toBe('vault')
    expect(s.pluginOpen).toBe(false)
    expect(s.settingsOpen).toBe(true)
  })

  it("a Impostazioni chiuse, setSettingsTab('app') apre comunque la pagina Plugin (il rimando vale anche da fuori)", () => {
    setStoreStateForRender(useStore, { settingsOpen: false, settingsTab: null, pluginOpen: false })
    useStore.getState().setSettingsTab('app')
    expect(useStore.getState().pluginOpen).toBe(true)
    expect(useStore.getState().settingsOpen).toBe(false)
  })

  it("la pagina si apre come dagli altri rimandi: chiude Attività e Libreria (regola B1)", () => {
    setStoreStateForRender(useStore, { settingsOpen: false, settingsTab: null, pluginOpen: false, activityOpen: true, openLibraryId: '' })
    useStore.getState().setSettingsTab('app')
    const s = useStore.getState()
    expect(s.pluginOpen).toBe(true)
    expect(s.activityOpen).toBe(false)
    expect(s.openLibraryId).toBe(null)
  })
})

describe('PP3: testi', () => {
  /** I sorgenti del prodotto (niente test, cataloghi, risorse) sotto una cartella. */
  const sourcesOf = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return ['__tests__', 'locales', 'assets'].includes(e.name) ? [] : sourcesOf(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })

  it('nessun sorgente del prodotto cita più «App e skill» nei testi (IT né EN) — i commenti che ne raccontano la storia restano', () => {
    const src = fileURLToPath(new URL('../../..', import.meta.url))
    const senzaCommenti = (text: string): string => text
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const hits = sourcesOf(src).filter((f) => /App e skill|Apps and skills/.test(senzaCommenti(readFileSync(f, 'utf8'))))
    expect(hits).toEqual([])
  })

  it('il catalogo inglese non ha più la voce «App e skill»', () => {
    const en = readFileSync(fileURLToPath(new URL('../locales/en/messages.po', import.meta.url)), 'utf8')
    expect(en).not.toContain('Apps and skills')
  })
})
