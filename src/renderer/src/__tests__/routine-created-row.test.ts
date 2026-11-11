// B3 (fase beta.4), punto 4: «Routine creata (in pausa)» ha il bottone
// «Attiva». Un clic attiva la routine; se manca il fuso orario prima lo
// chiede (stessa UI della pagina Routine); la routine RESTA in pausa per
// default — il clic dell'utente è il consenso. Render vero con
// react-dom/server + api finta che registra le chiamate.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import { callsOf, stubApiMethod } from './render-helper-install'

vi.mock('../components/ui/dialog', () => ({ Dialog: () => null }))

// la cattura delle props degli elementi resi: per «cliccare» senza DOM si
// invoca il VERO handler del bottone trovato (mock del runtime JSX)
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

const { RoutineCreatedRow, RoutineTzAsk, activatePlanOf } = await import('../components/RoutineCreatedRow')
const { useStore } = await import('../store')

import type { TranscriptEntry } from '../../../shared/types'

const entryOf = (id: number, name: string): TranscriptEntry => ({
  id: 9, agentId: 'agent_x', kind: 'event', role: 'system', content: `Routine creata (in pausa): ${name}`,
  createdAt: 1, meta: { automation: { action: 'create', id, name }, ui: { id: 'event.routineCreate', values: { name } } }
}) as unknown as TranscriptEntry

function renderRow(id: number, name: string, routine: { timezone: string } | null): { html: string; tree: ReturnType<typeof parseHtml> } {
  stubApiMethod('listRoutines', () => (routine ? [{ id, title: name, timezone: routine.timezone, enabled: 0 }] : []))
  stubApiMethod('updateRoutine', () => ({ ok: true }))
  setStoreStateForRender(useStore, {})
  capture.els.length = 0
  const html = renderHtml(createElement(RoutineCreatedRow, { entry: entryOf(id, name) }))
  return { html, tree: parseHtml(html) }
}

describe('B3: «Routine creata (in pausa)» col bottone Attiva', () => {
  it('la riga c\'è, col bottone «Attiva» accanto, e RESTA in pausa finché non si clicca', () => {
    const { html } = renderRow(3, 'Riassunto mattina', { timezone: 'Europe/Rome' })
    expect(html).toContain('Routine creata (in pausa): Riassunto mattina')
    expect(html).toContain('Attiva')
    // nessuna attivazione automatica: NESSUNA updateRoutine senza il clic
    expect(callsOf('updateRoutine')).toHaveLength(0)
  })

  it('col fuso orario: un clic ATTIVA la routine (enabled: 1, senza input)', async () => {
    const before = callsOf('updateRoutine').length
    renderRow(4, 'Backup', { timezone: 'Europe/Rome' })
    const attiva = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'routine-activate')!
    expect(attiva).toBeTruthy()
    await (attiva.props.onClick as () => Promise<void>)()
    const calls = callsOf('updateRoutine').slice(before)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toBe(4)
    expect(calls[0]!.args[1]).toEqual({ enabled: 1 })
  })

  it('SENZA fuso orario: il clic NON attiva — prima si chiede il fuso (piano puro + UI della pagina Routine)', async () => {
    // il piano (puro): senza fuso si chiede, con il fuso si attiva
    expect(activatePlanOf({ timezone: '' })).toBe('ask-timezone')
    expect(activatePlanOf({ timezone: 'Europe/Rome' })).toBe('activate')
    expect(activatePlanOf(null)).toBe('ask-timezone')
    // e nel flusso vero: clic → NESSUNA updateRoutine (aspetta il fuso)
    const before = callsOf('updateRoutine').length
    renderRow(5, 'Notizie', { timezone: '' })
    const attiva = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'routine-activate')!
    await (attiva.props.onClick as () => Promise<void>)()
    expect(callsOf('updateRoutine').slice(before)).toHaveLength(0)
  })

  it('la domanda del fuso ha la STESSA UI della pagina Routine, e Conferma attiva coi due pezzi', async () => {
    stubApiMethod('updateRoutineTrigger', () => ({ ok: true }))
    setStoreStateForRender(useStore, {})
    const html = renderHtml(createElement(RoutineTzAsk, { routineId: 6, onDone: () => undefined }))
    expect(html).toContain('Fuso orario (es. Europe/Rome)')
    capture.els.length = 0
    renderHtml(createElement(RoutineTzAsk, { routineId: 6, onDone: () => undefined }))
    const conferma = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'routine-tz-confirm')!
    expect(conferma).toBeTruthy()
    await (conferma.props.onClick as () => Promise<void>)()
    // il fuso passa da routines:update-trigger (che lo valida, come la pagina Routine)
    const calls = callsOf('updateRoutineTrigger')
    expect(calls[calls.length - 1]!.args[1]).toMatchObject({ enabled: 1, timezone: expect.any(String) })
  })
})
