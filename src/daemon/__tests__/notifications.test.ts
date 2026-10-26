// Test delle regole di soppressione delle notifiche (fase 6, §3bis L9):
// funzione PURA — disabled per l'agente → l'utente sta già guardando
// quell'agente → già letto → throttle di 5 s per agente → consegna.
import { describe, expect, it } from 'vitest'
import { decideNotification, notifyTexts, NOTIFY_THROTTLE_MS } from '../notifications'

const NOW = 1_000_000

describe('decideNotification (puro, ordine delle regole)', () => {
  it('consegna quando nulla scatta', () => {
    expect(decideNotification({ enabled: true, viewing: false, read: false, lastNotifiedAt: null, now: NOW }))
      .toEqual({ deliver: true })
  })

  it('1. notifiche disattivate per l\'agente', () => {
    expect(decideNotification({ enabled: false, viewing: false, read: false, lastNotifiedAt: null, now: NOW }))
      .toEqual({ deliver: false, suppress: 'disabled' })
  })

  it('2. l\'utente sta già guardando quell\'agente (vince sul già letto)', () => {
    expect(decideNotification({ enabled: true, viewing: true, read: true, lastNotifiedAt: NOW, now: NOW }))
      .toEqual({ deliver: false, suppress: 'viewing' })
  })

  it('3. già letto (vince sul throttle)', () => {
    expect(decideNotification({ enabled: true, viewing: false, read: true, lastNotifiedAt: NOW, now: NOW }))
      .toEqual({ deliver: false, suppress: 'read' })
  })

  it('4. throttle di 5 s per agente, poi si consegna di nuovo', () => {
    const last = NOW - (NOTIFY_THROTTLE_MS - 1)
    expect(decideNotification({ enabled: true, viewing: false, read: false, lastNotifiedAt: last, now: NOW }))
      .toEqual({ deliver: false, suppress: 'throttled' })
    expect(decideNotification({ enabled: true, viewing: false, read: false, lastNotifiedAt: NOW - NOTIFY_THROTTLE_MS, now: NOW }))
      .toEqual({ deliver: true })
    // lastNotifiedAt mai impostato: nessun throttle
    expect(decideNotification({ enabled: true, viewing: false, read: false, lastNotifiedAt: null, now: NOW }))
      .toEqual({ deliver: true })
  })

  it('throttle configurabile', () => {
    expect(decideNotification({ enabled: true, viewing: false, read: false, lastNotifiedAt: NOW - 60_000, now: NOW, throttleMs: 120_000 }))
      .toEqual({ deliver: false, suppress: 'throttled' })
  })
})

describe('notifyTexts', () => {
  it('agent-done: "ha risposto" con anteprima troncata', () => {
    const t = notifyTexts('Bot', { type: 'agent-notify', agentId: 'a', kind: 'done', preview: 'Risultato lungo '.repeat(30), at: NOW })
    expect(t.title).toBe('Bot ha risposto')
    expect(t.body.length).toBeLessThanOrEqual(120)
  })

  it('agent-needs-input: "ha bisogno di te"', () => {
    const t = notifyTexts('Bot', { type: 'agent-notify', agentId: 'a', kind: 'needs-input', preview: 'run-command: usa le credenziali', at: NOW })
    expect(t.title).toBe('Bot ha bisogno di te')
    expect(t.body).toContain('run-command')
  })
})
