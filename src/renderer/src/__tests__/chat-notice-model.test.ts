// RV4 (fase beta.2), punti 2 e 3: il bottone «Scegli un modello» della
// notice in chat apre il selettore del BOT (non più Impostazioni › Modelli),
// finché c'è almeno un provider configurato; senza provider resta
// Impostazioni › Modelli, dove prima va aggiunto un provider. E la notice
// RIPETUTA: «Configura prima un provider e un modello…» due volte di fila
// (due invii: il messaggio utente non viene scritto quando non c'è modello)
// si mostra UNA volta, con un contatore discreto. Chat VERA resa in node,
// clic sull'handler VERO del bottone.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'

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

const agent = { id: 'bot-1', name: 'Trello', description: '', providerId: null, model: null, status: 'offline', unread: 0, createdAt: 1 }

const notice = (id: number): Record<string, unknown> => ({
  id,
  agentId: 'bot-1',
  kind: 'notice',
  role: 'system',
  content: 'Configura prima un provider e un modello nelle impostazioni dell’agente.',
  meta: { ui: { id: 'notice.configureProviderFirst' } },
  createdAt: id
})

/** La chat del bot con le entry e i provider del caso. */
function renderChat(over: Record<string, unknown>) {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    rightPanel: false,
    openGroupId: null,
    activeId: 'bot-1',
    agents: [agent],
    providers: [],
    mainModel: null,
    entries: [],
    tasks: [],
    // i test cliccano: si parte sempre da tutto chiuso
    botModelOpen: false,
    settingsOpen: false,
    settingsTab: null,
    ...over
  })
  const html = renderHtml(createElement(Chat, {}))
  return { html, tree: parseHtml(html) }
}

/**
 * Il bottone «Scegli un modello» della notice, catturato dal render: si
 * riconosce dalla sua classe (i bottoni di Radix non passano dal runtime JSX
 * del repo, gli indici dell'HTML e della cattura non coincidono) — così si
 * clicca il bottone di OGGI e il rosso è il comportamento attuale.
 */
const chooseButton = () =>
  capture.els.find(
    (e) =>
      e.type === 'button' &&
      typeof e.props.className === 'string' &&
      e.props.className.includes('bg-muted px-3') &&
      typeof e.props.onClick === 'function'
  ) ?? null

describe('RV4: «Scegli un modello» apre il selettore del BOT della chat', () => {
  it('con almeno un provider ATTIVO: apre il selettore del bot, NON le Impostazioni', () => {
    renderChat({
      providers: [{ id: 'p1', name: 'Anthropic', kind: 'anthropic', enabled: true }],
      entries: [notice(1) as never]
    })
    const btn = chooseButton()
    expect(btn, 'il bottone «Scegli un modello» dev’esserci').toBeTruthy()
    ;(btn!.props.onClick as () => void)()
    const s = useStore.getState()
    expect(s.botModelOpen).toBe(true)
    expect(s.rightPanel).toBe(true)
    expect(s.settingsOpen).toBe(false)
  })

  it('senza provider configurati: resta Impostazioni › Modelli (prima va aggiunto un provider)', () => {
    renderChat({ providers: [], entries: [notice(1) as never] })
    const btn = chooseButton()!
    ;(btn.props.onClick as () => void)()
    const s = useStore.getState()
    expect(s.settingsOpen).toBe(true)
    expect(s.settingsTab).toBe('modelli')
    expect(s.botModelOpen).toBe(false)
  })
})

describe('RV4: la notice ripetuta si mostra UNA volta (con contatore discreto)', () => {
  it('due notice identiche CONSECUTIVE → una riga sola, con «×2»', () => {
    const { tree, html } = renderChat({ entries: [notice(1), notice(2)] as never })
    const text = 'Configura prima un provider e un modello'
    const rows = findAll(tree, (n) => textOf(n).includes(text))
    // UNA notice visibile (il testo compare in un solo posto del documento)
    expect(rows.filter((r) => r.tag !== '#root').length).toBeGreaterThan(0)
    const occurrences = html.split(text).length - 1
    expect(occurrences, 'il testo della notice compare UNA volta').toBe(1)
    expect(html).toContain('×2')
  })

  it('due notice identiche con ALTRO in mezzo → due righe (niente raggruppamento forzato)', () => {
    const { html } = renderChat({
      entries: [
        notice(1),
        { id: 2, agentId: 'bot-1', kind: 'message', role: 'user', content: 'ciao', meta: null, createdAt: 2 },
        notice(3)
      ] as never
    })
    const text = 'Configura prima un provider e un modello'
    expect(html.split(text).length - 1).toBe(2)
    expect(html).not.toContain('×2')
  })
})
