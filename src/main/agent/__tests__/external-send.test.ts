// Test della classificazione degli invii esterni (§3bis L5): quali tool MCP
// sono invii verso l'esterno e come nasce la bozza da una chiamata intercettata.
// Sezione D1 (review fase 3): "ciò che l'utente vede è esattamente ciò che
// viene inviato" — via ammesso solo per tool di invio, campi visibili letti
// da via.args tramite la fieldMap, nessun argomento nascosto.
// Fase 0.3.1001 (M1): classificazione per annotazioni e NOME, non per elenco
// di server — anche i server aggiunti a mano ("ufficio" con send_email).
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTERNAL_SEND_TOOLS, isExternalSend, channelForServer, channelForTool, draftFromExternalCall,
  prepareDraft, applyDraftBody, sendLikeName, autoViaForChannel
} from '../external-send'

describe('isExternalSend (config di default + nome)', () => {
  it('gmail e slack: i tool di invio della config sono invii esterni', () => {
    expect(isExternalSend('mcp__gmail__send_message', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__gmail__reply', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__gmail__forward', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__slack__slack_send_message', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('mcp__slack__slack_schedule_message', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
  })

  it('i tool di LETTURA dello stesso server NON sono invii esterni', () => {
    expect(isExternalSend('mcp__gmail__search_threads', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('mcp__gmail__read_thread', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('mcp__slack__list_channels', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
  })

  it('tool interni e nomi malformati mai; la config dell’utente è una sovrascrittura esplicita', () => {
    expect(isExternalSend('run-command', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('send_to_user', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('gmail__send_message', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    // l'utente configura i suoi server: la config data AGGIUNGE (sovrascrittura
    // esplicita) — e il nome continua a valere per tutti gli altri server
    const custom = { outlook: ['spedisci'] }
    expect(isExternalSend('mcp__outlook__spedisci', undefined, custom)).toBe(true)
    expect(isExternalSend('mcp__gmail__send_message', undefined, custom)).toBe(true)
    expect(isExternalSend('mcp__gmail__search_threads', undefined, custom)).toBe(false)
  })

  it('M1: server aggiunti a mano — l’espressione di invio sul nome li classifica da sola', () => {
    for (const name of ['send_email', 'gmail_send_message', 'reply', 'slack_send_message', 'post_message']) {
      expect(sendLikeName(name)).toBe(true)
    }
    for (const name of ['list_emails', 'read_email', 'search', 'create_event']) {
      expect(sendLikeName(name)).toBe(false)
    }
    expect(isExternalSend('mcp__ufficio__send_email', undefined, {})).toBe(true)
    expect(isExternalSend('mcp__ufficio__gmail_send_message', undefined, {})).toBe(true)
    expect(isExternalSend('mcp__ufficio__post_message', undefined, {})).toBe(true)
    expect(isExternalSend('mcp__ufficio__list_emails', undefined, {})).toBe(false)
    expect(isExternalSend('mcp__ufficio__read_email', undefined, {})).toBe(false)
    expect(isExternalSend('mcp__ufficio__search', undefined, {})).toBe(false)
    expect(isExternalSend('mcp__ufficio__create_event', undefined, {})).toBe(false)
  })

  it('verifica 0.3.1001: camelCase e kebab-case sono invii come lo snake_case', () => {
    for (const name of ['sendEmail', 'sendMessage', 'postMessage', 'send-email', 'SendEmail', 'replyToThread', 'chat_postMessage', 'messages.send']) {
      expect(sendLikeName(name)).toBe(true)
    }
    expect(isExternalSend('mcp__telegram__sendMessage', undefined, {})).toBe(true)
    expect(channelForTool('mcp__ufficio__sendEmail')).toBe('email')
    expect(channelForTool('mcp__ufficio__send-mail')).toBe('email')
  })

  it('verifica 0.3.1001: un nome che comincia con un verbo di lettura non è mai un invio', () => {
    for (const name of ['get_post', 'read_post', 'getPost', 'list_sent_messages', 'search_posts', 'fetch-reply', 'findReplies', 'list_posts']) {
      expect(sendLikeName(name)).toBe(false)
    }
    expect(isExternalSend('mcp__blog__get_post', undefined, {})).toBe(false)
  })

  it('verifica 0.3.1001: verbo di lettura seguito da send/forward resta un invio (fail closed)', () => {
    for (const name of ['fetch_and_send', 'read_and_forward', 'getAndSendReport', 'get_send_status']) {
      expect(sendLikeName(name)).toBe(true)
    }
    expect(isExternalSend('mcp__x__fetch_and_send', { readOnlyHint: true }, {})).toBe(false)
  })

  it('M1: readOnlyHint true ESCLUDE sempre (le annotazioni servono a escludere, non a includere)', () => {
    expect(isExternalSend('mcp__ufficio__send_email', { readOnlyHint: true }, {})).toBe(false)
    // openWorldHint da solo NON basta: molti server lo mettono anche sulle letture
    expect(isExternalSend('mcp__ufficio__list_emails', { openWorldHint: true }, {})).toBe(false)
    expect(isExternalSend('mcp__ufficio__send_email', { openWorldHint: true }, {})).toBe(true)
  })
})

describe('channelForServer / channelForTool', () => {
  it('deduce il canale dallo slug del server', () => {
    expect(channelForServer('gmail')).toBe('email')
    expect(channelForServer('workspace-mail')).toBe('email')
    expect(channelForServer('slack')).toBe('slack')
    expect(channelForServer('azienda-slack-mcp')).toBe('slack')
    expect(channelForServer('notion')).toBe('other')
  })

  it('M1: server sconosciuto → canale dal NOME del tool (email/mail → email)', () => {
    expect(channelForTool('mcp__ufficio__send_email')).toBe('email')
    expect(channelForTool('mcp__ufficio__send_mail')).toBe('email')
    expect(channelForTool('mcp__ufficio__post_message')).toBe('other')
    expect(channelForTool('mcp__gmail__send_message')).toBe('email')
  })
})

describe('M1: autoViaForChannel — la via di una bozza senza via', () => {
  const schema = {
    type: 'object',
    properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
    required: ['to', 'body']
  }
  const candidates = [
    { name: 'mcp__ufficio__send_email', parameters: schema },
    { name: 'mcp__ufficio__list_emails', parameters: schema }
  ]

  it('un solo invio per il canale: via compilata dallo schema, argomenti dai campi visibili', () => {
    const r = autoViaForChannel('email', { to: 'x@y.it', subject: 'Oggetto', body: 'ciao' }, candidates, {})
    expect(r.via).toEqual({ tool: 'mcp__ufficio__send_email', args: { to: 'x@y.it', subject: 'Oggetto', body: 'ciao' } })
    expect(r.hint).toBeUndefined()
  })

  it('nessun invio per il canale: hint no-tool', () => {
    const r = autoViaForChannel('slack', { to: '#generale', body: 'ciao' }, candidates, {})
    expect(r.via).toBeUndefined()
    expect(r.hint).toBe('no-tool')
  })

  it('più invii per il canale: hint pick con i candidati (sceglie il modello)', () => {
    const two = [...candidates, { name: 'mcp__ufficio__send_mail', parameters: schema }]
    const r = autoViaForChannel('email', { to: 'x@y.it', body: 'ciao' }, two, {})
    expect(r.via).toBeUndefined()
    expect(r.hint).toBe('pick')
    expect(r.candidates).toEqual(['mcp__ufficio__send_email', 'mcp__ufficio__send_mail'])
  })

  it('required senza valore dai campi visibili: niente via, hint missing-required', () => {
    const strict = {
      type: 'object',
      properties: { to: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string' } },
      required: ['to', 'body', 'threadId']
    }
    const r = autoViaForChannel('email', { to: 'x@y.it', body: 'ciao' }, [{ name: 'mcp__ufficio__send_email', parameters: strict }], {})
    expect(r.via).toBeUndefined()
    expect(r.hint).toBe('missing-required')
  })

  it('prepareDraft senza via compila la via e la riporta (viaAuto); con hint la mette in sendHint', () => {
    const ok = prepareDraft({ channel: 'email', to: 'x@y.it', subject: 'Oggetto', body: 'ciao', cfg: {}, candidates })
    expect(ok.viaAuto).toBe(true)
    expect(ok.message.via).toEqual({ tool: 'mcp__ufficio__send_email', args: { to: 'x@y.it', subject: 'Oggetto', body: 'ciao' } })
    const none = prepareDraft({ channel: 'slack', to: '#generale', body: 'ciao', cfg: {}, candidates })
    expect(none.message.via).toBeUndefined()
    expect(none.message.sendHint).toBe('no-tool')
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

  it('fase 5 (0c): applyDraftBody mantiene il TIPO dell\'argomento originale (array → split su virgola)', () => {
    const message = {
      type: 'draft' as const, channel: 'email' as const, to: 'a@x, b@y', body: 'testo',
      via: { tool: 'mcp__gmail__send_message', args: { to: ['a@x', 'b@y'], body: ['riga 1', 'riga 2'] } }
    }
    applyDraftBody(message, 'a@z, c@w non è il body — nuovo testo')
    // il body era un array: la stringa modificata torna array (split su virgola)
    expect(message.via.args.body).toEqual(['a@z', 'c@w non è il body — nuovo testo'])
    // to non è toccato da applyDraftBody e resta array
    expect(message.via.args.to).toEqual(['a@x', 'b@y'])
    expect(message.body).toBe('a@z, c@w non è il body — nuovo testo')
  })
})

// ---- fase app (A6 punto 3): gli strumenti Composio sono invii in BOZZA ----

describe('isExternalSend sugli strumenti Composio (composio__<tk>__<ACTION>)', () => {
  it('SEND dopo il prefisso del toolkit → invio (bozza), via lo strumento stesso', () => {
    expect(isExternalSend('composio__gmail__GMAIL_SEND_EMAIL', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
    expect(isExternalSend('composio__slack__SLACK_SEND_MESSAGE', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(true)
  })
  it('letture e scritture normali NON sono invii (passano dal gate: card o consentite)', () => {
    expect(isExternalSend('composio__gmail__GMAIL_LIST_THREADS', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
    expect(isExternalSend('composio__github__GITHUB_CREATE_ISSUE', undefined, DEFAULT_EXTERNAL_SEND_TOOLS)).toBe(false)
  })
  it('il canale della bozza arriva dal toolkit (gmail → email, slack → slack)', () => {
    expect(channelForTool('composio__gmail__GMAIL_SEND_EMAIL')).toBe('email')
    expect(channelForTool('composio__slack__SLACK_SEND_MESSAGE')).toBe('slack')
  })
  it('draftFromExternalCall costruisce la bozza con via = strumento Composio', () => {
    const d = draftFromExternalCall('composio__slack__SLACK_SEND_MESSAGE', {
      channel: '#generale', text: 'ciao a tutti'
    })
    expect(d.type).toBe('draft')
    expect(d.channel).toBe('slack')
    expect(d.via?.tool).toBe('composio__slack__SLACK_SEND_MESSAGE')
    expect(d.via?.args).toEqual({ channel: '#generale', text: 'ciao a tutti' })
  })
})
