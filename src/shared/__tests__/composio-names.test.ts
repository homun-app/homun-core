// R4 (fase app — ritocchi): i nomi delle azioni nella lingua dell'utente.
// Pure: verbo da tabella + oggetto dal glossario, MAI mezze traduzioni (una
// parola fuori tabella → null → il chiamante usa il nome originale di
// Composio) e in inglese sempre null (vince il nome originale).
import { describe, expect, it } from 'vitest'
import { localizedActionName, bareActionSlug } from '../composio-names'

describe('R4 — localizedActionName', () => {
  it('SLACK_CREATE_REMINDER → «Crea promemoria»', () => {
    expect(localizedActionName('SLACK_CREATE_REMINDER', 'it')).toBe('Crea promemoria')
  })

  it('GMAIL_SEND_EMAIL → «Invia email»', () => {
    expect(localizedActionName('GMAIL_SEND_EMAIL', 'it')).toBe('Invia email')
  })

  it('GMAIL_LIST_THREADS → «Elenca conversazioni» (plurale esplicito nel glossario)', () => {
    expect(localizedActionName('GMAIL_LIST_THREADS', 'it')).toBe('Elenca conversazioni')
  })

  it('HUBSPOT_CREATE_DEAL → «Crea trattativa»', () => {
    expect(localizedActionName('HUBSPOT_CREATE_DEAL', 'it')).toBe('Crea trattativa')
  })

  it('una parola sconosciuta (canvas) → null: mai mezze traduzioni', () => {
    expect(localizedActionName('SLACK_CREATE_CANVAS_SECTION', 'it')).toBeNull()
  })

  it('in inglese → null (il chiamante usa il nome originale di Composio)', () => {
    expect(localizedActionName('SLACK_CREATE_REMINDER', 'en')).toBeNull()
    expect(localizedActionName('GMAIL_SEND_EMAIL', 'en')).toBeNull()
  })

  it('accetta anche il nome completo dello strumento (composio__slack__…)', () => {
    expect(localizedActionName('composio__slack__SLACK_CREATE_REMINDER', 'it')).toBe('Crea promemoria')
    expect(localizedActionName('composio__gmail__GMAIL_SEND_EMAIL', 'it')).toBe('Invia email')
  })

  it('senza verbo in testa, o con una sola parola → null', () => {
    expect(localizedActionName('REMINDER', 'it')).toBeNull()
    expect(localizedActionName('SEND', 'it')).toBeNull()
    expect(localizedActionName('TODAY_GET', 'it')).toBeNull() // verbo non in testa
    expect(localizedActionName('WEATHER_GET_TODAY', 'it')).toBeNull() // today fuori glossario
  })

  it('bareActionSlug: accetta il nome completo e toglie il toolkit ripetuto in testa (forma minuscola normalizzata)', () => {
    expect(bareActionSlug('composio__gmail__GMAIL_SEND_EMAIL')).toBe('send_email')
    expect(bareActionSlug('GMAIL_SEND_EMAIL')).toBe('send_email')
    expect(bareActionSlug('SEND_EMAIL')).toBe('send_email')
    expect(bareActionSlug('WEATHER_GET_TODAY')).toBe('get_today')
  })
})

// ---- K3/K7 (fase Composio OAuth — ritocchi): nomi umani e via delle bozze ----

import { composioToolkitName, composioToolkitOfSlug, composioViaInfo, localizedConnectionsAction, localizedProxyRequestAction } from '../composio-names'

describe('K3 — composioToolkitName: mai slug grezzi', () => {
  it('slug noto → il nome della tabella (x_twitter → «X»)', () => {
    expect(composioToolkitName('slack')).toBe('Slack')
    expect(composioToolkitName('x_twitter')).toBe('X')
    expect(composioToolkitName('GMAIL')).toBe('Gmail')
  })

  it('slug ignoto → prima lettera maiuscola e _ → spazio (foo_bar → «Foo bar»)', () => {
    expect(composioToolkitName('foo_bar')).toBe('Foo bar')
    expect(composioToolkitName('crmxyz')).toBe('Crmxyz')
    expect(composioToolkitName('')).toBe('')
  })
})

describe('K6 — composioToolkitOfSlug (spostata in shared, identica)', () => {
  it('prefisso più lungo fra gli slug noti, altrimenti il primo segmento', () => {
    expect(composioToolkitOfSlug('GMAIL_SEND_EMAIL')).toBe('gmail')
    expect(composioToolkitOfSlug('MICROSOFT_TEAMS_LIST_CHANNELS', ['microsoft_teams'])).toBe('microsoft_teams')
    expect(composioToolkitOfSlug('CRMXYZ_PUSH_LEAD')).toBe('crmxyz')
  })
})

describe('K3 — le azioni di MANAGE_CONNECTIONS e del proxy nella lingua della UI', () => {
  it('add → Collega/Connect, list → Elenca collegamenti/List connections, rename/remove come da tabella', () => {
    expect(localizedConnectionsAction('add', 'it')).toBe('Collega')
    expect(localizedConnectionsAction('add', 'en')).toBe('Connect')
    expect(localizedConnectionsAction('list', 'it')).toBe('Elenca collegamenti')
    expect(localizedConnectionsAction('list', 'en')).toBe('List connections')
    expect(localizedConnectionsAction('rename', 'it')).toBe('Rinomina collegamento')
    expect(localizedConnectionsAction('rename', 'en')).toBe('Rename connection')
    expect(localizedConnectionsAction('remove', 'it')).toBe('Scollega')
    expect(localizedConnectionsAction('remove', 'en')).toBe('Disconnect')
  })

  it('il proxy dice «Richiesta diretta GET /…» in it e «Direct request …» in en, mai «PROXY»', () => {
    expect(localizedProxyRequestAction('GET', '/v1/threads', 'it')).toBe('Richiesta diretta GET /v1/threads')
    expect(localizedProxyRequestAction('POST', '/v1/send', 'en')).toBe('Direct request POST /v1/send')
  })
})

describe('K7 — composioViaInfo: da dove parte una bozza', () => {
  const batchVia = {
    tool: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
    args: {
      tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c' }, account: 'lavoro' }],
      sync_response_to_workbench: false
    }
  }

  it('via = il blocco di Composio → l\'app umana e l\'account della voce', () => {
    expect(composioViaInfo(batchVia)).toEqual({ app: 'Gmail', account: 'lavoro' })
  })

  it('blocco su QUALUNQUE server (nome originale COMPOSIO_MULTI_EXECUTE_TOOL) e senza account', () => {
    expect(composioViaInfo({
      tool: 'mcp__il-mio-composio__COMPOSIO_MULTI_EXECUTE_TOOL',
      args: { tools: [{ tool_slug: 'SLACK_POST_MESSAGE', arguments: {} }] }
    })).toEqual({ app: 'Slack' })
  })

  it('via = strumento composio__ del vecchio flusso SDK → il toolkit dal nome', () => {
    expect(composioViaInfo({ tool: 'composio__gmail__GMAIL_SEND_EMAIL', args: {} })).toEqual({ app: 'Gmail' })
  })

  it('ogni altra via (o nessuna) → null: la riga riguarda solo le superfici Composio', () => {
    expect(composioViaInfo({ tool: 'mcp__ufficio__invia_email', args: {} })).toBeNull()
    expect(composioViaInfo(null)).toBeNull()
    expect(composioViaInfo(undefined)).toBeNull()
  })
})
