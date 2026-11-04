// Test di unità della fase Composio OAuth: il blocco COMPOSIO_MULTI_EXECUTE_TOOL
// (C2) e la tabella degli strumenti (C3), tutto PURO contro la fixture ridotta
// del file di scoperta (nomi, annotazioni e schemi di MULTI_EXECUTE,
// MANAGE_CONNECTIONS e SEARCH_TOOLS — niente descrizioni personalizzate, vedi
// C10). Il test della conversione verso il provider (schema APERTO, C7 punto
// 5) sta qui: toPiContext deve passare lo schema così com'è.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fixtureJson from './fixtures/composio-for-you-tools.json'
import {
  COMPOSIO_MULTI_EXECUTE_TOOL, batchActions, toolBatchOf, objectArguments,
  batchSeverity, batchSeverityOfActions, composioActionKey, classifyBatchAction,
  composioToolkitOfSlug, forceSyncResponseToWorkbenchOff, composioResultError,
  batchResultData, redactBatchLeaves, extractBatchSends, batchSendViaArgs,
  composioBatchGate, manageConnectionsGate, proxyExecuteGate,
  manageConnectionsEntries, parseConnectionsResult, manageConnectionsAgentResult
} from '../tool-batch'
import { composioToolPolicy, COMPOSIO_TOOL_POLICIES, COMPOSIO_CODE_TOOLS, COMMON_COMPOSIO_TOOLKITS } from '../composio-meta'
import { toPiContext } from '../../agent/llm-pi'
import type { ToolDef } from '../../agent/llm'

const fixture = fixtureJson as { tools: Array<{ name: string; annotations?: Record<string, unknown>; inputSchema?: Record<string, unknown> }> }
const fixtureTool = (name: string) => fixture.tools.find((t) => t.name === name)!

/** Il nome completo del blocco su un server MCP qualsiasi (riconosciuto PER NOME). */
const BATCH_TOOL = 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
const CONNECTIONS_TOOL = 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS'
const PROXY_TOOL = 'mcp__composio__COMPOSIO_PROXY_EXECUTE'

const item = (slug: string, args: Record<string, unknown> = {}, account?: string) => ({
  tool_slug: slug,
  arguments: args,
  ...(account ? { account } : {})
})

describe('C2 — la forma del blocco (riconosciuta per nome su qualunque server)', () => {
  it('toolBatchOf riconosce COMPOSIO_MULTI_EXECUTE_TOOL, di qualunque server sia', () => {
    expect(toolBatchOf('COMPOSIO_MULTI_EXECUTE_TOOL')).toEqual({
      items: 'tools', action: 'tool_slug', arguments: 'arguments', account: 'account'
    })
    expect(toolBatchOf('composio_multi_execute_tool')).toBeUndefined()
    expect(toolBatchOf('COMPOSIO_SEARCH_TOOLS')).toBeUndefined()
  })

  it('il nome e la forma combaciano con lo schema VERO del server (fixture di scoperta)', () => {
    const schema = fixtureTool(COMPOSIO_MULTI_EXECUTE_TOOL).inputSchema as {
      properties: { tools: { items: { properties: Record<string, { additionalProperties?: unknown }> } } }
    }
    const shape = toolBatchOf(COMPOSIO_MULTI_EXECUTE_TOOL)!
    const itemProps = schema.properties.tools.items.properties
    expect(itemProps[shape.action]).toBeDefined()
    expect(itemProps[shape.arguments]).toBeDefined()
    expect(itemProps[shape.account]).toBeDefined()
    // C7 punto 5: tools[].arguments è un oggetto APERTO (additionalProperties: true)
    expect(itemProps[shape.arguments]!.additionalProperties).toBe(true)
  })

  it('batchActions: azioni distinte, complete con slug validi, account letto', () => {
    const parsed = batchActions(toolBatchOf(COMPOSIO_MULTI_EXECUTE_TOOL)!, {
      tools: [
        item('GMAIL_SEND_EMAIL', { to: 'a@b.c' }),
        item('GMAIL_SEND_EMAIL', { to: 'd@e.f' }, 'work'),
        item('SLACK_LIST_CHANNELS')
      ]
    })
    expect(parsed.actions).toEqual(['GMAIL_SEND_EMAIL', 'SLACK_LIST_CHANNELS'])
    expect(parsed.complete).toBe(true)
    expect(parsed.items[1]!.account).toBe('work')
    expect(parsed.items[1]!.arguments).toEqual({ to: 'd@e.f' })
  })

  it('batchActions: incompleto se tools manca, è vuoto o una voce non ha tool_slug', () => {
    const shape = toolBatchOf(COMPOSIO_MULTI_EXECUTE_TOOL)!
    expect(batchActions(shape, {}).complete).toBe(false)
    expect(batchActions(shape, { tools: [] }).complete).toBe(false)
    expect(batchActions(shape, { tools: [{ arguments: {} }, item('X_GET_Y')] }).complete).toBe(false)
    expect(batchActions(shape, { tools: [{ tool_slug: '  ', arguments: {} }] }).complete).toBe(false)
  })

  it('objectArguments: gli argomenti possono arrivare come oggetto o stringa JSON (Rakazo)', () => {
    expect(objectArguments({ a: 1 })).toEqual({ a: 1 })
    expect(objectArguments('{"a": 1}')).toEqual({ a: 1 })
    expect(objectArguments('non json')).toEqual({})
    expect(objectArguments([1])).toEqual({})
    expect(objectArguments(null)).toEqual({})
  })
})

describe('C2 punto 1 — il toolkit dallo slug e la classificazione', () => {
  it('il prefisso più lungo fra gli slug noti vince; altrimenti il primo segmento', () => {
    expect(composioToolkitOfSlug('GMAIL_SEND_EMAIL')).toBe('gmail')
    expect(composioToolkitOfSlug('SLACK_SEARCH_MESSAGES')).toBe('slack')
    expect(composioToolkitOfSlug('MICROSOFT_TEAMS_LIST_CHANNELS', ['microsoft_teams'])).toBe('microsoft_teams')
    // slug interamente sconosciuto: primo segmento (fail closed sul nome)
    expect(composioToolkitOfSlug('CRMXYZ_PUSH_LEAD')).toBe('crmxyz')
  })

  it('la classificazione toglie il prefisso, ma i pattern valgono ANCHE sullo slug intero', () => {
    // senza prefisso (A6): FETCH_EMAILS NON è lettura (fetch non è un verbo di
    // lettura nella tabella di Rakazo: fail closed → card)
    expect(classifyBatchAction('FETCH_EMAILS')).toBe('write')
    // con il prefisso del toolkit davanti: stesso verdetto (C2 punto 1)
    expect(classifyBatchAction('GMAIL_FETCH_EMAILS')).toBe('write')
    expect(classifyBatchAction('GMAIL_LIST_THREADS')).toBe('read')
    expect(classifyBatchAction('SLACK_SEARCH_MESSAGES')).toBe('read')
    // SEND restituirebbe bozza a monte; nel blocco classificato come send
    expect(classifyBatchAction('GMAIL_SEND_EMAIL')).toBe('send')
    expect(classifyBatchAction('SLACK_CREATE_REMINDER')).toBe('write')
    expect(classifyBatchAction('GITHUB_CREATE_ISSUE')).toBe('write')
    expect(classifyBatchAction('NOTION_DELETE_PAGE')).toBe('destructive')
    expect(classifyBatchAction('CONTACT_GET_AND_UPDATE')).toBe('write')
  })

  it('la severità decide l’azione più severa: destructive > write > send > read', () => {
    expect(batchSeverity(['read', 'read'])).toBe('read')
    expect(batchSeverity(['read', 'send'])).toBe('send')
    expect(batchSeverity(['send', 'write'])).toBe('write')
    expect(batchSeverity(['write', 'destructive'])).toBe('destructive')
    expect(batchSeverityOfActions(['GMAIL_LIST_THREADS', 'SLACK_SEARCH_MESSAGES'])).toBe('read')
    expect(batchSeverityOfActions(['GMAIL_LIST_THREADS', 'NOTION_DELETE_PAGE'])).toBe('destructive')
    // lista vuota: fail closed, write
    expect(batchSeverityOfActions([])).toBe('write')
  })
})

describe('C2 punti 2–4 — il gate del blocco (regole e consensi PER AZIONE)', () => {
  const gate = (args: Record<string, unknown>, extra: Partial<Parameters<typeof composioBatchGate>[0]> = {}) =>
    composioBatchGate({ toolName: BATCH_TOOL, args, rules: [], grants: [], uiLang: 'it', ...extra })

  it('blocco di sole LETTURE: allow senza card', () => {
    const v = gate({ tools: [item('GMAIL_LIST_THREADS'), item('SLACK_SEARCH_MESSAGES')] })
    expect(v).toEqual({ kind: 'allow', via: 'rule' })
  })

  it('lettura + scrittura: ask con le DUE azioni in card (decide la più severa)', () => {
    const v = gate({ tools: [item('GMAIL_LIST_THREADS'), item('SLACK_CREATE_REMINDER')] })
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.severity).toBe('write')
      expect(v.actions.map((a) => a.slug)).toEqual(['GMAIL_LIST_THREADS', 'SLACK_CREATE_REMINDER'])
      expect(v.actions.map((a) => a.app)).toEqual(['Gmail', 'Slack'])
      expect(v.noAlways).toBe(false)
    }
  })

  it('distruttiva: ask SENZA «Consenti sempre»', () => {
    const v = gate({ tools: [item('NOTION_DELETE_PAGE')] })
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.destructive).toBe(true)
      expect(v.noAlways).toBe(true)
    }
  })

  it('voce senza nome (incomplete): card, MAI consentita in automatico', () => {
    const v = gate({ tools: [item('GMAIL_LIST_THREADS'), { arguments: {} }] })
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.incomplete).toBe(true)
      expect(v.reason).toBe('incomplete')
      expect(v.noAlways).toBe(true)
    }
  })

  it('una regola blocked sullo strumento del blocco (o sul server) blocca tutto', () => {
    const v = gate({ tools: [item('GMAIL_LIST_THREADS')] }, { rules: [{ tool: BATCH_TOOL, mode: 'blocked' }] })
    expect(v).toEqual({ kind: 'deny' })
    const v2 = gate({ tools: [item('GMAIL_LIST_THREADS')] }, { rules: [{ tool: 'mcp__*', mode: 'blocked' }] })
    expect(v2).toEqual({ kind: 'deny' })
  })

  it('una regola always_allow sullo strumento del blocco NON conta (il wrapper non consente)', () => {
    const v = gate({ tools: [item('SLACK_CREATE_REMINDER')] }, { rules: [{ tool: BATCH_TOOL, mode: 'always_allow' }] })
    expect(v.kind).toBe('ask')
  })

  it('il blocco è consentito da regola/grant solo se lo è OGNI azione (chiave composio-action:)', () => {
    const key = composioActionKey('SLACK_CREATE_REMINDER')
    const key2 = composioActionKey('GMAIL_LIST_THREADS')
    // una sola azione consentita: l'altra non si porta dietro
    expect(gate({ tools: [item('SLACK_CREATE_REMINDER'), item('GITHUB_CREATE_ISSUE')] }, { grants: [key] }).kind).toBe('ask')
    // TUTTE consentite (una da grant, una da regola): allow
    const v = gate(
      { tools: [item('SLACK_CREATE_REMINDER'), item('GMAIL_LIST_THREADS')] },
      { grants: [key], rules: [{ tool: key2, mode: 'always_allow' }] }
    )
    expect(v).toEqual({ kind: 'allow', via: 'grant' })
    // una regola blocked PER AZIONE nega tutto
    expect(gate({ tools: [item('GMAIL_LIST_THREADS')] }, { rules: [{ tool: key2, mode: 'blocked' }] })).toEqual({ kind: 'deny' })
    // una regola ask PER AZIONE forza la card anche su una lettura
    expect(gate({ tools: [item('GMAIL_LIST_THREADS')] }, { rules: [{ tool: key2, mode: 'needs_approval' }] }).kind).toBe('ask')
  })

  it('C4 — fiducia per app: dopo la contaminazione una lettura su un toolkit NUOVO chiede; su uno usato no', () => {
    const args = { tools: [item('GMAIL_LIST_THREADS')] }
    // turno non contaminato: passa
    expect(gate(args, { trust: { tainted: false, trustedApps: [] } }).kind).toBe('allow')
    // contaminato, gmail mai usato: card
    const ask = gate(args, { trust: { tainted: true, trustedApps: [] } })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.reason).toBe('trust')
    // contaminato, gmail già usato nel turno: passa (elenca poi leggi)
    expect(gate(args, { trust: { tainted: true, trustedApps: ['gmail'] } }).kind).toBe('allow')
    // un blocco Gmail non rende fidato Slack
    const slack = gate({ tools: [item('SLACK_LIST_CHANNELS')] }, { trust: { tainted: true, trustedApps: ['gmail'] } })
    expect(slack.kind).toBe('ask')
  })
})

describe('C5/C3 — il gate di MANAGE_CONNECTIONS e PROXY_EXECUTE', () => {
  const gate = (args: Record<string, unknown>, extra: Partial<Parameters<typeof manageConnectionsGate>[0]> = {}) =>
    manageConnectionsGate({ toolName: CONNECTIONS_TOOL, args, rules: [], grants: [], uiLang: 'it', ...extra })

  it('list è lettura (allow); add è la card di collegamento SENZA «sempre»', () => {
    expect(gate({ toolkits: [{ name: 'gmail', action: 'list' }] })).toEqual({ kind: 'allow', via: 'rule' })
    const add = gate({ toolkits: [{ name: 'gmail', action: 'add' }] })
    expect(add.kind).toBe('ask')
    if (add.kind === 'ask') {
      expect(add.actions[0]!.app).toBe('Gmail')
      expect(add.noAlways).toBe(true)
    }
  })

  it('rename chiede; remove è distruttiva senza «sempre»', () => {
    const rename = gate({ toolkits: [{ name: 'gmail', action: 'rename', account_id: 'a1', alias: 'lavoro' }] })
    expect(rename.kind).toBe('ask')
    const remove = gate({ toolkits: [{ name: 'gmail', action: 'remove', account_id: 'a1' }] })
    expect(remove.kind).toBe('ask')
    if (remove.kind === 'ask') {
      expect(remove.destructive).toBe(true)
      expect(remove.noAlways).toBe(true)
    }
  })

  it('voce senza nome (o toolkits assente): chiede sempre', () => {
    expect(gate({ toolkits: [{ action: 'list' }] }).kind).toBe('ask')
    expect(gate({}).kind).toBe('ask')
  })

  it('proxyExecuteGate: SEMPRE card, mai «sempre»; GET è lettura, POST scrittura', () => {
    const get = proxyExecuteGate({ toolName: PROXY_TOOL, args: { toolkit_slug: 'github', endpoint: '/user/repos', method: 'GET' }, rules: [], grants: [], uiLang: 'it' })
    expect(get.kind).toBe('ask')
    if (get.kind === 'ask') {
      expect(get.severity).toBe('read')
      expect(get.noAlways).toBe(true)
      expect(get.actions[0]!.app).toBe('GitHub')
      // K3 (ritocchi): «Richiesta diretta GET /…», mai «PROXY»
      expect(get.actions[0]!.action).toBe('Richiesta diretta GET /user/repos')
    }
    const post = proxyExecuteGate({ toolName: PROXY_TOOL, args: { toolkit_slug: 'github', endpoint: '/repos', method: 'POST', body: { name: 'x' } }, rules: [], grants: [], uiLang: 'it' })
    if (post.kind === 'ask') expect(post.severity).toBe('write')
  })

  // ---- K3 (ritocchi): nomi umani e azioni LOCALIZZATE, mai slug o parole del server ----

  it('K3: le azioni di MANAGE_CONNECTIONS nella lingua della UI (add → Collega/Connect, …)', () => {
    const cases = [
      ['add', 'Collega', 'Connect'],
      ['list', 'Elenca collegamenti', 'List connections'],
      ['rename', 'Rinomina collegamento', 'Rename connection'],
      ['remove', 'Scollega', 'Disconnect']
    ] as const
    for (const [action, it, en] of cases) {
      const itGate = gate({ toolkits: [{ name: 'slack', action }] })
      expect(itGate.kind).toBe(action === 'list' ? 'allow' : 'ask')
      if (itGate.kind === 'ask') expect(itGate.actions[0]!.action).toBe(it)
      if (action !== 'list') {
        const enGate = manageConnectionsGate({ toolName: CONNECTIONS_TOOL, args: { toolkits: [{ name: 'slack', action }] }, rules: [], grants: [], uiLang: 'en' })
        if (enGate.kind === 'ask') expect(enGate.actions[0]!.action).toBe(en)
      }
    }
  })

  it('K3: l\'app della card è il nome umano (slug noto) o la forma leggibile (slug ignoto)', () => {
    const known = gate({ toolkits: [{ name: 'slack', action: 'add' }] })
    if (known.kind === 'ask') expect(known.actions[0]!.app).toBe('Slack')
    const unknown = gate({ toolkits: [{ name: 'crm_xyz', action: 'add' }] })
    if (unknown.kind === 'ask') expect(unknown.actions[0]!.app).toBe('Crm xyz')
  })

  it('K3: la richiesta diretta del proxy è localizzata anche in inglese, mai «PROXY»', () => {
    const en = proxyExecuteGate({ toolName: PROXY_TOOL, args: { toolkit_slug: 'gmail', endpoint: '/v1/send', method: 'POST' }, rules: [], grants: [], uiLang: 'en' })
    if (en.kind === 'ask') expect(en.actions[0]!.action).toBe('Direct request POST /v1/send')
  })
})

describe('C3 — la tabella degli strumenti (elenco chiuso, fail closed)', () => {
  it('la tabella copre i 12 nomi del file di scoperta', () => {
    const names = fixture.tools.map((t) => t.name)
    expect(names).toHaveLength(12)
    for (const name of names) {
      expect(COMPOSIO_TOOL_POLICIES[name]).toBeDefined()
    }
  })

  it('i 6 offerti e i 6 nascosti esattamente come da tabella', () => {
    const offered = fixture.tools.map((t) => t.name).filter((n) => composioToolPolicy(n).offered)
    expect(offered.sort()).toEqual([
      'COMPOSIO_GET_TOOL_SCHEMAS',
      'COMPOSIO_MANAGE_CONNECTIONS',
      'COMPOSIO_MULTI_EXECUTE_TOOL',
      'COMPOSIO_PROXY_EXECUTE',
      'COMPOSIO_SEARCH_TOOLS',
      'COMPOSIO_WAIT_FOR_CONNECTIONS'
    ].sort())
  })

  it('uno strumento NUOVO, non in tabella, non si offre (tools.listChanged)', () => {
    expect(composioToolPolicy('COMPOSIO_NEW_SHINY_TOOL').offered).toBe(false)
  })

  it('le code tool non si offrono (Rakazo COMPOSIO_CODE_TOOLS) e sono in tabella', () => {
    expect([...COMPOSIO_CODE_TOOLS].every((n) => !composioToolPolicy(n).offered)).toBe(true)
  })

  it('la lista dei toolkit comuni ha una trentina di voci con slug e nome', () => {
    expect(COMMON_COMPOSIO_TOOLKITS.length).toBeGreaterThanOrEqual(28)
    expect(COMMON_COMPOSIO_TOOLKITS.length).toBeLessThanOrEqual(34)
    expect(COMMON_COMPOSIO_TOOLKITS.some((t) => t.slug === 'gmail')).toBe(true)
    expect(COMMON_COMPOSIO_TOOLKITS.some((t) => t.slug === 'spotify')).toBe(true)
  })
})

describe('C3/C7 — sync_response_to_workbench e i risultati del blocco', () => {
  it('gli argomenti partono SEMPRE con sync_response_to_workbench false (lo schema lo richiede)', () => {
    const forced = forceSyncResponseToWorkbenchOff({ tools: [item('X_GET_Y')], thought: 'p', sync_response_to_workbench: true })
    expect(forced.sync_response_to_workbench).toBe(false)
    expect(forceSyncResponseToWorkbenchOff({ tools: [] }).sync_response_to_workbench).toBe(false)
  })

  it('composioResultError tiene gli errori VERI di data.results (500 caratteri, massimo 5, ripuliti)', () => {
    const data = {
      results: [
        { tool_slug: 'GMAIL_SEND_EMAIL', error: 'Recipient not found' },
        { tool_slug: 'SLACK_SEND_MESSAGE', response: { error: 'channel_not_found' } },
        ...Array.from({ length: 6 }, (_, i) => ({ tool_slug: `T_${i}`, error: `e${i}`.repeat(120) }))
      ]
    }
    const out = composioResultError('2 out of 9 tools failed', data)
    expect(out).toContain('GMAIL_SEND_EMAIL: Recipient not found')
    expect(out).toContain('SLACK_SEND_MESSAGE: channel_not_found')
    expect(out).toContain('+3 more')
    // i dettagli lunghi si troncano a 500
    const long = composioResultError('1 out of 1 tools failed', { results: [{ tool_slug: 'T', error: 'x'.repeat(600) }] })
    expect(long.length).toBeLessThan(600)
    expect(long).toContain('…')
    // senza results resta il testo del server
    expect(composioResultError('ok', {})).toBe('ok')
    expect(composioResultError('ok', undefined)).toBe('ok')
  })

  it('composioResultError ripulisce i segreti in ogni errore', () => {
    const out = composioResultError('1 out of 1 tools failed', {
      results: [{ tool_slug: 'T', error: 'api_key=ak_SECRET123456789 was rejected' }]
    })
    expect(out).not.toContain('ak_SECRET123456789')
    expect(out).toContain('[redacted]')
  })

  it('batchResultData trova il campo data del risultato MCP (JSON)', () => {
    expect(batchResultData('{"data":{"results":[1]}}')).toEqual({ results: [1] })
    expect(batchResultData('{"results":[2]}')).toEqual({ results: [2] })
    expect(batchResultData('non json')).toBeUndefined()
  })

  it('redactBatchLeaves maschera i segreti in OGNI foglia', () => {
    const redacted = redactBatchLeaves({ a: 'chiave ak_ABCDEFG123', b: [{ c: 'Bearer xyz' }], d: 3 })
    expect(redacted.a).not.toContain('ak_ABCDEFG123')
    expect(JSON.stringify(redacted)).not.toContain('Bearer xyz')
    expect(redacted.d).toBe(3)
  })
})

describe('C7 punto 3 — le voci d’invio escono dal blocco e diventano bozze', () => {
  it('extractBatchSends separa invii e resto, con sync forzato', () => {
    const r = extractBatchSends({
      tools: [item('GMAIL_LIST_THREADS'), item('GMAIL_SEND_EMAIL', { to: 'a@b.c', subject: 's', body: 'ciao' })],
      sync_response_to_workbench: true
    })
    expect(r.sends.map((s) => s.slug)).toEqual(['GMAIL_SEND_EMAIL'])
    expect(r.rest.map((s) => s.slug)).toEqual(['GMAIL_LIST_THREADS'])
    expect(r.restArgs!.tools).toHaveLength(1)
    expect(r.restArgs!.sync_response_to_workbench).toBe(false)
    // senza invii: restArgs null (gli argomenti NON si toccano)
    expect(extractBatchSends({ tools: [item('GMAIL_LIST_THREADS')] }).restArgs).toBeNull()
  })

  it('batchSendViaArgs: la via è il blocco stesso con UNA sola voce e sync false', () => {
    const via = batchSendViaArgs({ slug: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'ciao' }, account: 'work' })
    expect(via.tools).toEqual([{ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'ciao' }, account: 'work' }])
    expect(via.sync_response_to_workbench).toBe(false)
  })
})

describe('C5 — MANAGE_CONNECTIONS: voci, parsing tollerante, risultato al modello', () => {
  it('manageConnectionsEntries legge le voci (default add, tollerante)', () => {
    expect(manageConnectionsEntries({ toolkits: [{ name: 'gmail' }, { name: 'slack', action: 'list' }, { action: 'remove' }] })).toEqual([
      { name: 'gmail', action: 'add', named: true },
      { name: 'slack', action: 'list', named: true },
      { name: '', action: 'remove', named: false }
    ])
    expect(manageConnectionsEntries({})).toEqual([])
  })

  it('parseConnectionsResult trova redirect_url, id e stati in un JSON qualsiasi (formato VERO da verificare)', () => {
    // un risultato d'esempio scritto in base alla descrizione del server
    const example = JSON.stringify({
      toolkits: [
        { toolkit: 'gmail', status: 'success', redirect_url: 'https://composio.example/authorize?req=1' },
        { toolkit: 'slack', status: 'error', accounts: [{ id: 'acc_1', status: 'ACTIVE', alias: 'work' }] }
      ]
    })
    const parsed = parseConnectionsResult(example)
    expect(parsed.redirectUrls).toEqual([{ url: 'https://composio.example/authorize?req=1', toolkit: 'gmail' }])
    expect(parsed.accounts.some((a) => a.id === 'acc_1' && a.status === 'ACTIVE' && a.alias === 'work')).toBe(true)
    // formato non JSON: vuoto, mai un'eccezione
    expect(parseConnectionsResult('non json')).toEqual({ redirectUrls: [], accounts: [] })
  })

  it('manageConnectionsAgentResult NON passa il link al modello: dice che sta nella card', () => {
    const out = manageConnectionsAgentResult('{"redirect_url":"https://segreto.example/x","toolkit":"gmail"}', [{ toolkit: 'gmail' }])
    expect(out).not.toContain('segreto.example')
    expect(out).toContain('connection card')
    // senza link: il risultato passa così com'è
    expect(manageConnectionsAgentResult('ok', [])).toBe('ok')
  })
})

describe('C7 punto 5 — lo schema del blocco arriva al provider APERTO', () => {
  it('toPiContext non chiude tools[].arguments (additionalProperties: true passa così com’è)', () => {
    const schema = fixtureTool(COMPOSIO_MULTI_EXECUTE_TOOL).inputSchema!
    const tools: ToolDef[] = [{ name: BATCH_TOOL, description: '[MCP:Composio] blocco', parameters: structuredClone(schema) }]
    const ctx = toPiContext([{ role: 'user', content: 'ciao' }], tools)
    const sent = (ctx.tools ?? [])[0]!.parameters as {
      properties: { tools: { items: { properties: { arguments: { additionalProperties: unknown } } } } }
    }
    expect(sent.properties.tools.items.properties.arguments.additionalProperties).toBe(true)
  })
})
