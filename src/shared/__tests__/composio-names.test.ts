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

import { composioToolkitName, composioToolkitOfSlug, composioViaInfo, localizedConnectionsAction, localizedProxyRequestAction, canonicalToolkitSlug, knownToolkitSlugs, COMMON_COMPOSIO_TOOLKITS, composioAppsLabel } from '../composio-names'
import { formatUi, ui } from '../ui-text'
import { UI } from '../ui-messages'

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

  // ---- V7 (prova vera): slug VERI di Composio e alias vecchi ----

  it('V7: composioToolkitName degli slug veri visti nella prova', () => {
    expect(composioToolkitName('googlecalendar')).toBe('Google Calendar')
    expect(composioToolkitName('googledrive')).toBe('Google Drive')
    expect(composioToolkitName('googlesheets')).toBe('Google Sheets')
    expect(composioToolkitName('googledocs')).toBe('Google Docs')
    expect(composioToolkitName('microsoft_teams')).toBe('Microsoft Teams')
    expect(composioToolkitName('stripe')).toBe('Stripe')
  })

  it('V7: gli alias vecchi si leggono ma si canonicalizzano (mai per crearne di nuovi)', () => {
    expect(canonicalToolkitSlug('gcal')).toBe('googlecalendar')
    expect(canonicalToolkitSlug('gsheets')).toBe('googlesheets')
    expect(canonicalToolkitSlug('calendar')).toBe('googlecalendar')
    expect(canonicalToolkitSlug('gmail')).toBe('gmail')
    // dati GIÀ SALVATI con lo slug inventato di ieri → il nome vero
    expect(composioToolkitName('gcal')).toBe('Google Calendar')
    expect(composioToolkitName('gdrive')).toBe('Google Drive')
    // ma gli slug inventati NON sono più slug noti per il classificatore
    expect(knownToolkitSlugs().includes('gcal')).toBe(false)
    expect(knownToolkitSlugs().includes('googlecalendar')).toBe(true)
  })

  it('V7: la tabella dei comuni non ha doppioni (né slug né nomi)', () => {
    const slugs = COMMON_COMPOSIO_TOOLKITS.map((t) => t.slug)
    const names = COMMON_COMPOSIO_TOOLKITS.map((t) => t.name)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(new Set(names).size).toBe(names.length)
    expect(slugs.includes('gcal')).toBe(false)
    expect(slugs.includes('gsheets')).toBe(false)
    expect(slugs.includes('calendar')).toBe(false)
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

  // ---- V9 (prova vera): le app della card del blocco ----

  it('V9: composioAppsLabel unisce i nomi nella lingua della UI (vuoto → Composio)', () => {
    expect(composioAppsLabel(['Gmail'], 'it')).toBe('Gmail')
    expect(composioAppsLabel(['Gmail', 'Slack'], 'it')).toBe('Gmail e Slack')
    expect(composioAppsLabel(['Gmail', 'Slack', 'Notion'], 'it')).toBe('Gmail, Slack e Notion')
    expect(composioAppsLabel(['Gmail', 'Slack'], 'en')).toBe('Gmail and Slack')
    // doppi nomi (più azioni sulla stessa app) → una volta sola
    expect(composioAppsLabel(['Gmail', 'Gmail'], 'it')).toBe('Gmail')
    expect(composioAppsLabel([], 'it')).toBe('Composio')
    expect(composioAppsLabel(['', '  '], 'en')).toBe('Composio')
  })

  it('V9: la frase della card del blocco per 1 e 2 azioni, in it e en', () => {
    expect(formatUi(ui(UI.approvalComposioBatch, { count: 1, apps: 'Gmail' }), 'it')).toBe('Vuole fare 1 azione su Gmail')
    expect(formatUi(ui(UI.approvalComposioBatch, { count: 2, apps: 'Gmail e Slack' }), 'it')).toBe('Vuole fare 2 azioni su Gmail e Slack')
    expect(formatUi(ui(UI.approvalComposioBatch, { count: 1, apps: 'Gmail' }), 'en')).toBe('Wants to run 1 action on Gmail')
    expect(formatUi(ui(UI.approvalComposioBatch, { count: 2, apps: 'Gmail and Slack' }), 'en')).toBe('Wants to run 2 actions on Gmail and Slack')
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

// ---- RW4: il titolo della richiesta diretta senza l'endpoint intero ----

describe('RW4 — localizedProxyRequestAction: percorso senza query, tagliato', () => {
  it('il titolo NON contiene mai la query string', () => {
    const t = localizedProxyRequestAction('GET', '/members/me/boards?filter=starred&fields=id,name,url', 'it')
    expect(t).toBe('Richiesta diretta GET /members/me/boards')
    expect(t).not.toContain('?')
    expect(localizedProxyRequestAction('GET', '/1/boards/abc/cards?fields=all', 'en')).toBe('Direct request GET /1/boards/abc/cards')
  })

  it('oltre ~60 caratteri il percorso si taglia con «…»', () => {
    const long = `/1/lists/${'65a1c9f2e8b3d4a5b6c7d8e9f0'.repeat(3)}/cards`
    expect(long.length).toBeGreaterThan(60)
    const t = localizedProxyRequestAction('GET', long + '?x=1', 'it')
    expect(t).toContain('…')
    expect(t.length).toBeLessThanOrEqual('Richiesta diretta GET '.length + 60)
  })
})
