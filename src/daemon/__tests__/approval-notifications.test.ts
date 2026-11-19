// A4 (fase centro-autorizzazioni): la notifica di sistema delle richieste
// — quando nasce una richiesta per l'utente e la finestra NON è in primo
// piano: «<Bot> chiede a te: <frase breve>», il click apre il centro su
// quella richiesta. Raggruppata: al massimo una ogni 30 s; se nel frattempo
// ne nascono altre, «3 richieste aspettano te». Rispetta l'impostazione
// delle notifiche di oggi (disabledAgents). Finta di sistema nei test.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApprovalNotifier, APPROVAL_NOTIFY_WINDOW_MS } from '../approval-notifications'

const NOW = 1_000_000

function makeNotifier(focused: boolean) {
  const delivered: Array<{ title: string; body: string; openApprovalsFor: string }> = []
  const n = createApprovalNotifier({
    notify: (title, body, openApprovalsFor) => delivered.push({ title, body, openApprovalsFor }),
    windowFocused: () => focused,
    now: () => Date.now(),
    lang: 'it'
  })
  return { n, delivered }
}

describe('A4: la notifica raggruppata delle richieste', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('finestra NON a fuoco, 3 richieste in 10 s → 1 singola + 1 aggregata (e il click apre il centro)', () => {
    const { n, delivered } = makeNotifier(false)
    n.onApprovalBorn({ enabled: true, agentName: 'Turismo', phrase: 'Compilare il modulo del Museo Egizio.', approvalId: 'ap-1' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ title: 'Turismo chiede a te', body: 'Compilare il modulo del Museo Egizio.', openApprovalsFor: 'ap-1' })
    vi.advanceTimersByTime(3_000)
    n.onApprovalBorn({ enabled: true, agentName: 'Solleciti', phrase: 'Mandare una mail.', approvalId: 'ap-2' })
    vi.advanceTimersByTime(3_000)
    n.onApprovalBorn({ enabled: true, agentName: 'Ricerche', phrase: 'Accedere a LinkedIn.', approvalId: 'ap-3' })
    // nel frattempo NESSUNA nuova notifica
    expect(delivered).toHaveLength(1)
    // alla finestra di 30 s dalla prima: l'aggregata
    vi.advanceTimersByTime(APPROVAL_NOTIFY_WINDOW_MS)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ title: '3 richieste aspettano te', openApprovalsFor: 'all' })
  })

  it('con la finestra a fuoco, nessuna', () => {
    const { n, delivered } = makeNotifier(true)
    n.onApprovalBorn({ enabled: true, agentName: 'Turismo', phrase: 'x', approvalId: 'ap-1' })
    vi.advanceTimersByTime(APPROVAL_NOTIFY_WINDOW_MS * 2)
    expect(delivered).toHaveLength(0)
  })

  it('notifiche spente per quel bot (l\'impostazione di oggi): niente', () => {
    const { n, delivered } = makeNotifier(false)
    n.onApprovalBorn({ enabled: false, agentName: 'Turismo', phrase: 'x', approvalId: 'ap-1' })
    vi.advanceTimersByTime(APPROVAL_NOTIFY_WINDOW_MS * 2)
    expect(delivered).toHaveLength(0)
  })

  it('la cadenza: dopo 30 s una richiesta nuova ha la sua singola', () => {
    const { n, delivered } = makeNotifier(false)
    n.onApprovalBorn({ enabled: true, agentName: 'A', phrase: 'prima.', approvalId: 'ap-1' })
    vi.advanceTimersByTime(APPROVAL_NOTIFY_WINDOW_MS + 1)
    n.onApprovalBorn({ enabled: true, agentName: 'B', phrase: 'seconda.', approvalId: 'ap-2' })
    expect(delivered).toHaveLength(2)
    expect(delivered[1]).toMatchObject({ title: 'B chiede a te', openApprovalsFor: 'ap-2' })
  })

  it('una sola nel gruppo: niente aggregata (nulla di nuovo da dire)', () => {
    const { n, delivered } = makeNotifier(false)
    n.onApprovalBorn({ enabled: true, agentName: 'A', phrase: 'prima.', approvalId: 'ap-1' })
    vi.advanceTimersByTime(APPROVAL_NOTIFY_WINDOW_MS * 2)
    expect(delivered).toHaveLength(1)
  })

  it('la finestra torna a fuoco: l\'aggregata in sospeso NON si consegna', () => {
    const focused = { v: false }
    const delivered: unknown[] = []
    const n = createApprovalNotifier({
      notify: () => delivered.push(1),
      windowFocused: () => focused.v,
      now: () => Date.now(),
      lang: 'it'
    })
    n.onApprovalBorn({ enabled: true, agentName: 'A', phrase: 'prima.', approvalId: 'ap-1' })
    vi.advanceTimersByTime(3_000)
    n.onApprovalBorn({ enabled: true, agentName: 'B', phrase: 'seconda.', approvalId: 'ap-2' })
    focused.v = true
    vi.advanceTimersByTime(APPROVAL_NOTIFY_WINDOW_MS)
    expect(delivered).toHaveLength(1) // solo la singola di A
  })

})
