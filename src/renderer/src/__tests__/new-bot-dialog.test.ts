// B2 (fase beta.4): il dialogo «Nuovo» chiede SOLO nome e aspetto — niente
// menu bot/squadra, niente «Cosa farà?», niente «Descrivilo tu». In fondo il
// link «Parti da un modello» apre l'elenco di oggi (lo stesso flusso col
// kickstart). Render vero con react-dom/server (niente DOM nel repo).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, dialogPassThroughMock, textOf } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

// la cattura delle props degli elementi resi: React NON renderizza
// disabled={false} nell'HTML statico, quindi il prop vero del bottone Crea
// si legge dagli elementi catturati (mock del runtime JSX)
const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

const { NewBotDialog } = await import('../components/BotDialogs')
const { useStore } = await import('../store')

const SOURCE = readFileSync(fileURLToPath(new URL('../components/BotDialogs.tsx', import.meta.url)), 'utf8')
const SIDEBAR = readFileSync(fileURLToPath(new URL('../components/Sidebar.tsx', import.meta.url)), 'utf8')

const TEMPLATES = [
  { id: 'inbox-manager', name: { it: 'Gestore della posta', en: 'Inbox manager' }, description: { it: 'Ordina la posta', en: 'Sorts mail' }, avatar: '📬' },
  { id: 'daily-briefing', name: { it: 'Riassunto del giorno', en: 'Daily briefing' }, description: { it: 'Il mattino riassume', en: 'Morning digest' }, avatar: '☀️' }
]

function renderDialog(): { html: string; tree: ReturnType<typeof parseHtml> } {
  const html = renderHtml(createElement(NewBotDialog, { onClose: () => undefined }))
  return { html, tree: parseHtml(html) }
}

describe('B2: il dialogo «Nuovo» chiede solo nome e aspetto', () => {
  it('SENZA «Cosa farà?» e SENZA «Descrivilo tu»', () => {
    setStoreStateForRender(useStore, { select: async () => undefined })
    const { html } = renderDialog()
    expect(html).not.toContain('Cosa farà?')
    expect(html).not.toContain('Descrivilo tu')
  })

  it('il bottone Crea è ATTIVO solo con un nome (senza nome è disabled)', () => {
    setStoreStateForRender(useStore, { select: async () => undefined })
    capture.els.length = 0
    renderDialog()
    // il prop VERO (React non renderizza disabled={false} nell'HTML statico)
    // a nome vuoto l'UNICO bottone disabled del dialogo è il Crea
    const crea = capture.els.find((e) => e.type === 'button' && e.props.disabled === true)
    expect(crea, 'il bottone Crea senza nome deve essere disabled').toBeTruthy()
    // la regola: canCreate richiede un nome NON vuoto (guarda sul codice)
    expect(SOURCE).toContain('const canCreate = !busy && name.trim().length > 0')
  })

  it('il link «Parti da un modello» c\'è, e apre l\'elenco di oggi col kickstart (guarda sul codice)', () => {
    setStoreStateForRender(useStore, { select: async () => undefined })
    const { html } = renderDialog()
    expect(html).toContain('Parti da un modello')
    // il flusso dei modelli non si perde: crea con createAgentFromTemplate e
    // applica POI nome e aspetto scelti qui (updateAgent), come oggi
    expect(SOURCE).toContain('api.createAgentFromTemplate(tpl.id)')
    expect(SOURCE).toContain('api.createAgent(name.trim())')
  })

  it('la squadra NON nasce dal dialogo: niente «Nuova squadra» né NewTeamDialog nella barra', () => {
    setStoreStateForRender(useStore, { select: async () => undefined })
    const { html } = renderDialog()
    expect(html).not.toContain('Nuova squadra')
    expect(SIDEBAR).not.toContain('NewTeamDialog')
    expect(SIDEBAR).not.toContain('Nuova squadra')
  })
})
