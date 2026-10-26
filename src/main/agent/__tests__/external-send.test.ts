// Test della classificazione degli invii esterni (§3bis L5): quali tool MCP
// sono invii verso l'esterno e come nasce la bozza da una chiamata intercettata.
// Sezione D1 (review fase 3): "ciò che l'utente vede è esattamente ciò che
// viene inviato" — via ammesso solo per tool di invio, campi visibili letti
// da via.args tramite la fieldMap, nessun argomento nascosto.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTERNAL_SEND_TOOLS, isExternalSend, channelForServer, draftFromExternalCall,
  prepareDraft, applyDraftBody
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
    // D1: il payload ora porta anche la fieldMap e gli argomenti non mappati
    // (threadId), così la card non ha campi nascosti
    expect(d).toEqual({
      type: 'draft', channel: 'email', to: 'x@y.it', subject: 'Oggetto', body: 'Testo',
      via: { tool: 'mcp__gmail__send_message', args },
      fieldMap: { to: 'to', subject: 'subject', body: 'body' },
      extraArgs: [{ key: 'threadId', value: 't123' }]
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

describe('D1: prepareDraft — via ammesso SOLO per i tool di invio esterno', () => {
  it("via.tool non di invio (run-command): via scartato, bozza di solo testo, viaRejected per la tool-result", () => {
    const { message, viaRejected } = prepareDraft({
      channel: 'email', to: 'x@y.it', body: 'testo',
      via: { tool: 'run-command', args: { command: 'rm -rf /' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(message).toEqual({ type: 'draft', channel: 'email', to: 'x@y.it', body: 'testo' })
    expect(viaRejected).toBe('run-command')
  })

  it('tool MCP qualsiasi non classificato come invio: via scartato pure', () => {
    const { message, viaRejected } = prepareDraft({
      channel: 'other', to: 'wiki', body: 'pagina',
      via: { tool: 'mcp__notion__create_page', args: { title: 'x' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(message.via).toBeUndefined()
    expect(viaRejected).toBe('mcp__notion__create_page')
  })

  it('via non strutturato (tool mancante): trattato come assente, ma segnalato', () => {
    const { message, viaRejected } = prepareDraft({
      channel: 'email', to: 'x@y.it', body: 't', via: { args: { body: 't' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(message.via).toBeUndefined()
    expect(viaRejected).toBeTruthy()
  })

  it('invio esterno valido: to/subject/body del modello FINISCONO in via.args e il payload li rilegge da lì', () => {
    const { message, viaRejected } = prepareDraft({
      channel: 'email', to: 'visibile@esempio.it', subject: 'Oggetto', body: 'corpo visibile',
      via: { tool: 'mcp__gmail__send_message', args: { to: 'nascosto@esempio.it', subject: 'vecchio', body: 'corpo nascosto' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(viaRejected).toBeUndefined()
    // unica fonte di verità: via.args aggiornato dai campi visibili
    expect(message.via).toEqual({
      tool: 'mcp__gmail__send_message',
      args: { to: 'visibile@esempio.it', subject: 'Oggetto', body: 'corpo visibile' }
    })
    // la card mostra esattamente ciò che verrà inviato
    expect(message.to).toBe('visibile@esempio.it')
    expect(message.subject).toBe('Oggetto')
    expect(message.body).toBe('corpo visibile')
    expect(message.fieldMap).toEqual({ to: 'to', subject: 'subject', body: 'body' })
  })

  it('argomenti extra (bcc, thread_id): sempre visibili in extraArgs ("Altri parametri" della card)', () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'x@y.it', body: 'ciao',
      via: { tool: 'mcp__gmail__send_message', args: { to: 'x@y.it', subject: 'Oggetto', body: 'ciao', bcc: 'boss@esempio.it', thread_id: 't1' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(message.extraArgs).toEqual([
      { key: 'bcc', value: 'boss@esempio.it' },
      { key: 'thread_id', value: 't1' }
    ])
  })

  it('nomi di argomento sconosciuti: bodyLocked (modifica disabilitata), corpo di ripiego sul JSON, argomenti grezzi', () => {
    const { message } = prepareDraft({
      channel: 'other', to: '', body: 'testo del modello',
      via: { tool: 'mcp__altro__push', args: { payload: { a: 1 } } },
      cfg: { altro: ['push'] }
    })
    expect(message.bodyLocked).toBe(true)
    expect(message.body).toBe('{"payload":{"a":1}}')
    expect(message.extraArgs).toEqual([{ key: 'payload', value: '{"a":1}' }])
    expect(message.fieldMap).toEqual({})
  })
})

describe('residuo fase 4 (0a): il campo visibile mantiene il tipo dell’argomento originale', () => {
  it('to originale array + stringa visibile "a@x, b@y" → via.args riceve un array (split su virgola e trim)', () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'a@x, b@y', body: 'ciao',
      via: { tool: 'mcp__gmail__send_message', args: { to: ['a@x', 'b@y'], subject: 'Oggetto', body: 'ciao' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(message.via?.args.to).toEqual(['a@x', 'b@y'])
    // la card mostra la versione leggibile (readableArg unisce con virgole)
    expect(message.to).toBe('a@x, b@y')
  })

  it('lo split funziona anche senza spazi e scarta le parti vuote', () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'a@x,b@y, ,c@z', body: 'ciao',
      via: { tool: 'mcp__gmail__send_message', args: { to: ['a@x'], body: 'ciao' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    expect(message.via?.args.to).toEqual(['a@x', 'b@y', 'c@z'])
  })

  it('argomento originale stringa: resta stringa (nessuna coercizione superflua)', () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'solo@x', body: 'ciao',
      via: { tool: 'mcp__gmail__send_message', args: { to: ['altro'], subject: 's', body: 'b' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    // subject era stringa: il valore visibile lo rimpiazza restando stringa
    expect(message.via?.args.subject).toBe('s')
    expect(typeof message.via?.args.to).toBe('object')
  })
})

describe('D1: applyDraftBody — la modifica aggiorna anche gli argomenti che verranno inviati', () => {
  it('bozza con fieldMap: body nuovo in message.body E in via.args[fieldMap.body]', () => {
    const { message } = prepareDraft({
      channel: 'email', to: 'x@y.it', body: 'originale',
      via: { tool: 'mcp__gmail__send_message', args: { to: 'x@y.it', body: 'originale' } },
      cfg: DEFAULT_EXTERNAL_SEND_TOOLS
    })
    applyDraftBody(message, 'modificato')
    expect(message.body).toBe('modificato')
    expect(message.via?.args).toEqual({ to: 'x@y.it', body: 'modificato' })
  })

  it("bozza senza fieldMap (salvata prima della correzione): la fieldMap si ricalcola dagli argomenti", () => {
    const message = {
      type: 'draft' as const, channel: 'email' as const, to: 'x@y.it', body: 'originale',
      via: { tool: 'mcp__gmail__send_message', args: { to: 'x@y.it', subject: 'Oggetto', body: 'originale' } }
    }
    applyDraftBody(message, 'modificato')
    expect(message.body).toBe('modificato')
    expect(message.via.args).toEqual({ to: 'x@y.it', subject: 'Oggetto', body: 'modificato' })
  })

  it('bozza di solo testo (senza via): tocca solo il testo visibile', () => {
    const { message } = prepareDraft({ channel: 'other', to: '', body: 't', cfg: DEFAULT_EXTERNAL_SEND_TOOLS })
    applyDraftBody(message, 'nuovo')
    expect(message.body).toBe('nuovo')
    expect(message.via).toBeUndefined()
  })
})
