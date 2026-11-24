// U1 (fase prima-release): le azioni sotto i messaggi del bot — «Rispondi
// citando» e «Passaggi del turno» via (niente uso chiaro), «Copia» resta ed
// È L'UNICA. Al clic l'icona diventa una spunta per 1,5 s col tooltip
// «Copiato»; se il clipboard fallisce la spunta NON compare. Chat VERA resa
// in node, clic sull'handler VERO, orologio finto per i 1,5 s.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, dialogPassThroughMock } from './render-helper'
import { parsePo } from './po-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))
vi.mock('../components/PageView', () => ({ PageView: () => null }))
vi.mock('../components/MemoryPanel', () => ({ MemoryPanel: () => null }))

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

const { Chat } = await import('../components/Chat')
const { useStore } = await import('../store')

const CHAT = fileURLToPath(new URL('../components/Chat.tsx', import.meta.url))

const agent = { id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }

/** un messaggio di testo del bot: la bolla con le azioni al passaggio */
const botMessage = (id: number, content: string): Record<string, unknown> => ({
  id, agentId: 'bot-1', kind: 'send-message', role: 'assistant', content, meta: { message: { type: 'text' } }, createdAt: id
})

function renderChat(entries: Array<Record<string, unknown>>): string {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    rightPanel: false, openGroupId: null, activeId: 'bot-1', agents: [agent],
    providers: [], mainModel: null, entries: entries as never, tasks: [],
    botModelOpen: false, settingsOpen: false, settingsTab: null
  })
  return renderHtml(createElement(Chat, {}))
}

/** il bottone delle azioni col nome accessibile cercato (title/aria-label) */
// Fase design (DS4): l'azione è il pezzo del sistema (Button, solo icona, da 32) — non più un <button>
// scritto a mano con size-7: si riconosce dal nome accessibile, fra i <button> e i <Button>
const isButton = (type: unknown): boolean => type === 'button' || (typeof type === 'function' && (type as { name?: string }).name === 'Button')
const actionButton = (label: string) =>
  capture.els.find(
    (e) => isButton(e.type) && (e.props['aria-label'] === label || e.props.title === label)
  ) ?? null

describe('U1: le azioni sotto i messaggi — via «Cita» e «Passaggi», «Copia» resta', () => {
  it('nel rendering statico non ci sono più «Rispondi citando» né «Passaggi del turno»', () => {
    const html = renderChat([botMessage(1, 'una risposta lunga del bot')])
    expect(actionButton('Rispondi citando')).toBeNull()
    expect(actionButton('Passaggi del turno')).toBeNull()
    expect(html).not.toContain('Rispondi citando')
    expect(html).not.toContain('Passaggi del turno')
  })

  it('«Copia» c\'è, e il clic chiama clipboard.writeText col testo del messaggio', () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      renderChat([botMessage(7, 'la risposta da copiare, per intero')])
      const btn = actionButton('Copia')
      expect(btn, 'il bottone «Copia» dev\'esserci').toBeTruthy()
      ;(btn!.props.onClick as () => void)()
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('la risposta da copiare, per intero')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('la spunta compare e se ne va: orologio finto, 1,5 s esatti', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      renderChat([botMessage(9, 'testo')])
      ;(actionButton('Copia')!.props.onClick as () => void)()
      await vi.advanceTimersByTimeAsync(0) // la promise del clipboard si scioglie
      expect(vi.getTimerCount(), 'la spunta resta accesa: un timer da 1,5 s').toBe(1)
      await vi.advanceTimersByTimeAsync(1499)
      expect(vi.getTimerCount(), 'a 1 s e mezzo mancato, la spunta è ancora lì').toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(vi.getTimerCount(), 'a 1,5 s la spunta se n\'è andata').toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('se il clipboard fallisce la spunta NON compare (nessun timer)', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => Promise.reject(new Error('negato')))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      renderChat([botMessage(11, 'testo')])
      ;(actionButton('Copia')!.props.onClick as () => void)()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('il sorgente: la spunta è la Check di lucide col tooltip «Copiato», 1,5 s', () => {
    const src = readFileSync(CHAT, 'utf8')
    expect(src).toMatch(/copied \? Check : Copy/)
    expect(src).toContain('Copiato')
    expect(src).toMatch(/COPY_FEEDBACK_MS = 1_?500/)
    // il codice morto della citazione non c'è più
    expect(src).not.toContain('setQuote')
    expect(src).not.toContain('Rispondi citando')
  })
})

describe('U1: i cataloghi it/en non hanno più le stringhe tolte (rigenerati)', () => {
  it('«Rispondi citando» e «Passaggi del turno» spariti da it ed en; «Copiato» c\'è', () => {
    for (const locale of ['it', 'en'] as const) {
      const cat = parsePo(locale)
      expect(cat.has('Rispondi citando'), `${locale}: «Rispondi citando» via`).toBe(false)
      expect(cat.has('Passaggi del turno'), `${locale}: «Passaggi del turno» via`).toBe(false)
      expect(cat.has('Copiato'), `${locale}: «Copiato» c'è`).toBe(true)
    }
  })
})
