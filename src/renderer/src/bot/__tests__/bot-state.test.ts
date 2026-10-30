// Test dello stato della mascotte (fase 16, U3): ogni riga della tabella di
// priorità della specifica e le precedenze (delta batte running, la scrittura
// dell'utente batte waiting, offline batte tutto, happy scade dopo 1,5 s).
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import type { MessageDescriptor } from '@lingui/core'
import { botStateFor, botStatusText, botAriaLabel, HAPPY_MS } from '../bot-state'
import { itCatalogEntries } from '../../__tests__/po-helper'

// fase 17a: botStatusText/botAriaLabel tornano descriptor; l'italiano si
// risolve dal catalogo it (lingua sorgente), come farà la UI con i18n._()
i18n.load('it', itCatalogEntries())
i18n.activate('it')
const T = (d: MessageDescriptor): string => i18n.t(d)

const NOW = 1_000_000

describe('fase 16 (U3): botStateFor — righe della tabella', () => {
  it('status offline → idle (con dimmed a monte), batte tutto', () => {
    expect(botStateFor({ status: 'offline', streaming: true, userTyping: true })).toBe('idle')
    expect(botStateFor({ status: 'offline', turnEnd: { value: 'AWAITING_USER', sendAt: null }, now: NOW })).toBe('idle')
  })
  it('delta in arrivo → speaking', () => {
    expect(botStateFor({ status: 'running', streaming: true })).toBe('speaking')
  })
  it('status thinking → thinking', () => {
    expect(botStateFor({ status: 'thinking' })).toBe('thinking')
  })
  it('status running → listening (sotto: "Sta facendo: X")', () => {
    expect(botStateFor({ status: 'running' })).toBe('listening')
  })
  it('utente che scrive a questo bot → listening', () => {
    expect(botStateFor({ status: 'idle', userTyping: true })).toBe('listening')
  })
  it('paused-for-approval → waiting', () => {
    expect(botStateFor({ status: 'paused-for-approval' })).toBe('waiting')
  })
  it('fine turno AWAITING_USER → waiting', () => {
    expect(botStateFor({ status: 'idle', turnEnd: { value: 'AWAITING_USER', sendAt: null }, now: NOW })).toBe('waiting')
  })
  it('fine turno FINISHED con send-message negli ultimi 1,5 s → happy', () => {
    expect(
      botStateFor({ status: 'idle', turnEnd: { value: 'FINISHED', sendAt: NOW - 800 }, now: NOW })
    ).toBe('happy')
  })
  it('altrimenti → idle', () => {
    expect(botStateFor({ status: 'idle', now: NOW })).toBe('idle')
    expect(botStateFor({ status: 'idle', turnEnd: { value: 'FINISHED', sendAt: null }, now: NOW })).toBe('idle')
    expect(botStateFor({ status: 'idle', turnEnd: { value: 'STOPPED', sendAt: NOW }, now: NOW })).toBe('idle')
  })
})

describe('fase 16 (U3): precedenze', () => {
  it('il delta batte running', () => {
    expect(botStateFor({ status: 'running', streaming: true })).toBe('speaking')
  })
  it('la scrittura dell’utente batte waiting', () => {
    expect(
      botStateFor({ status: 'paused-for-approval', userTyping: true, now: NOW })
    ).toBe('listening')
    expect(
      botStateFor({ status: 'idle', userTyping: true, turnEnd: { value: 'AWAITING_USER', sendAt: null }, now: NOW })
    ).toBe('listening')
  })
  it('happy scade dopo 1,5 s e torna idle', () => {
    expect(
      botStateFor({ status: 'idle', turnEnd: { value: 'FINISHED', sendAt: NOW - HAPPY_MS - 1 }, now: NOW })
    ).toBe('idle')
  })
  it('thinking batte running e la scrittura dell’utente', () => {
    expect(botStateFor({ status: 'thinking', userTyping: true })).toBe('thinking')
  })
})

describe('fase 16 (U3) / 17a: testi di stato e aria-label (dal catalogo it)', () => {
  it('i testi dell’intestazione', () => {
    expect(T(botStatusText({ status: 'offline' }))).toBe('Offline')
    expect(T(botStatusText({ status: 'idle', now: NOW }))).toBe('Online')
    expect(T(botStatusText({ status: 'thinking' }))).toBe('Sta pensando…')
    expect(T(botStatusText({ status: 'running', activityTool: 'run-command' }))).toBe('Sta facendo: run-command')
    expect(T(botStatusText({ status: 'running' }))).toBe('Sta scrivendo…')
    expect(T(botStatusText({ status: 'idle', userTyping: true }))).toBe('Sta scrivendo…')
    expect(T(botStatusText({ status: 'idle', streaming: true }))).toBe('Sta scrivendo…')
    expect(T(botStatusText({ status: 'paused-for-approval' }))).toBe('Aspetta te')
  })
  it('l’aria-label della mascotte', () => {
    expect(T(botAriaLabel('Nanna', 'thinking'))).toBe('Nanna, sta pensando')
    expect(T(botAriaLabel('Nanna', 'idle'))).toBe('Nanna')
    expect(T(botAriaLabel('Nanna', 'waiting'))).toBe('Nanna, aspetta te')
  })
  it('i descriptor portano i valori (il nome del bot, il tool in corso)', () => {
    const d = botStatusText({ status: 'running', activityTool: 'run-command' })
    expect(d.message).toBe('Sta facendo: {0}')
    expect(d.values).toEqual({ 0: 'run-command' })
    const a = botAriaLabel('Nanna', 'happy')
    expect(T(a)).toBe('Nanna è contento')
  })
})
