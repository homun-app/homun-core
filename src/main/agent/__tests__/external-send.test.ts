// Test della classificazione degli invii esterni (§3bis L5): quali tool MCP
// sono invii verso l'esterno e come nasce la bozza da una chiamata intercettata.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTERNAL_SEND_TOOLS, isExternalSend, channelForServer, draftFromExternalCall
} from '../external-send'

describe('isExternalSend (config di default)', () => {
  it('gmail e slack: i tool di invio della config sono invii esterni', () => {
    expect(isExternalSend('mcp__gmail__send_message', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__gmail__reply', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__gmail__forward', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__slack__slack_send_message', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__slack__slack_schedule_message', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
  })

  it('i tool di LETTURA dello stesso server NON sono invii esterni', () => {
    expect(isExternalSend('mcp__gmail__search_threads', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('mcp__gmail__read_thread', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('mcp__slack__list_channels', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
  })

  it('tool interni e nomi malformati mai; config personalizzata sostituisce le default', () => {
    expect(isExternalSend('run-command', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('send_to_user', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('gmail__send_message', DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    // l'utente configura i suoi server: la config data vince sulle default
    const custom = { outlook: ['send_mail'] }
    expect(isExternalSend('mcp__outlook__send_mail', custom)).toBe(true)
    expect(isExternalSend('mcp__gmail__send_message', custom)).toBe(false)
  })
})

describe('channelForServer', () => {
  it('deduce il canale dallo slug del server', () => {
    expect(channelForServer('gmail')).toBe('email')
    expect(channelForServer('workspace-mail')).toBe('email')
    expect(channelForServer('slack')).toBe('slack')
    expect(channelForServer('azienda-slack-mcp')).toBe('slack')
    expect(channelForServer('notion')).toBe('other')
  })
})

describe('draftFromExternalCall', () => {
  it('costruisce la bozza dagli argomenti comuni, con via = la chiamata originale', () => {
    const args = { to: 'x@y.it', subject: 'Oggetto', body: 'Testo', threadId: 't123' }
    const d = draftFromExternalCall('mcp__gmail__send_message', args)
    expect(d).toEqual({
      type: 'draft', channel: 'email', to: 'x@y.it', subject: 'Oggetto', body: 'Testo',
      via: { tool: 'mcp__gmail__send_message', args }
    })
  })

  it('nomi alternativi (recipient/text/message) e channel/body di ripiego', () => {
    const d = draftFromExternalCall('mcp__slack__slack_send_message', { channel: '#general', text: 'ciao' })
    expect(d.channel).toBe('slack')
    expect(d.to).toBe('#general')
    expect(d.body).toBe('ciao')
    expect(d.subject).toBeUndefined()

    // nessun campo noto: corpo di ripiego sul JSON degli argomenti
    const fallback = draftFromExternalCall('mcp__altro__push', { payload: 1 })
    expect(fallback.channel).toBe('other')
    expect(fallback.body).toBe('{"payload":1}')
  })
})
