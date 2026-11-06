// Fase 16b (S3.3) — test della mezza riga d'attività (activityPhrase) e del
// raggruppamento dei passaggi per turno (stepsOfTurn). Puri, nei due cataloghi.
// Fase 16b correzioni (P2): le famiglie nuove del daemon + il test di
// coerenza fra la tabella TOOL_FAMILIES e i nomi dei tool definiti nel daemon.
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { activityPhrase, stepsOfTurn, targetOfArguments, hostOf, fileNameOf, stepsDurationSeconds, stepsDurationLabel, TOOL_FAMILIES } from '../activity'
import type { TranscriptEntry } from '../../../../shared/types'
import { itCatalogEntries, enCatalogEntries } from '../../__tests__/po-helper'
import { toolDefs, computerToolDefs, wakeParentToolDef } from '../../../../main/agent/tools'
import { findToolsDef } from '../../../../main/mcp/find-tools'
import { youKeylessProvider, exaMcpKeylessProvider, tavilyKeylessProvider, EXA_MCP_SEARCH_TOOL } from '../../../../main/agent/web-search-providers'

const entry = (over: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'id' | 'kind' | 'role'>): TranscriptEntry => ({
  agentId: 'a', content: '', meta: null, createdAt: 1, ...over
})

describe('fase 16b (S3.3): activityPhrase', () => {
  it.each([
    ['it', 'apre fibrapro.it…', { tool: 'browser_navigate', target: 'https://fibrapro.it/login' }],
    ['it', 'esegue un comando…', { tool: 'run-command', target: 'rm -rf /box' }],
    ['it', 'legge report.md…', { tool: 'read-file', target: '/box/workspace/report.md' }],
    ['it', 'cerca sul web…', { tool: 'web_search', target: 'normativa smart working' }],
    ['it', 'usa il computer…', { tool: 'use-app', target: 'calcolatrice' }],
    ['it', 'scrive un documento…', { tool: 'write_document', target: 'riepilogo' }],
    ['it', 'naviga…', { tool: 'browser_click', target: 'ref=e5' }],
    ['it', 'lavora…', { tool: 'tool_sconosciuto', target: 'x' }],
    ['it', 'lavora…', null]
  ])('%s: %s', (lang, expected, activity) => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    void lang
    expect(i18n.t(activityPhrase(activity as never))).toBe(expected)
  })

  it('fase 16b correzioni (P2): le famiglie nuove del daemon, in italiano', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    expect(i18n.t(activityPhrase({ tool: 'web_fetch', target: 'https://fibrapro.it/brand' }))).toBe('legge fibrapro.it…')
    expect(i18n.t(activityPhrase({ tool: 'list-directory', target: '/box' }))).toBe('guarda i file…')
    expect(i18n.t(activityPhrase({ tool: 'edit_document', target: 'x' }))).toBe('scrive un documento…')
    expect(i18n.t(activityPhrase({ tool: 'read_document', target: 'x' }))).toBe('legge un documento…')
    expect(i18n.t(activityPhrase({ tool: 'visualize', target: 'x' }))).toBe('fa un grafico…')
    expect(i18n.t(activityPhrase({ tool: 'exa', target: 'x' }))).toBe('cerca sul web…')
    expect(i18n.t(activityPhrase({ tool: 'tavily', target: 'x' }))).toBe('cerca sul web…')
    expect(i18n.t(activityPhrase({ tool: 'web_search_exa', target: 'x' }))).toBe('cerca sul web…')
    expect(i18n.t(activityPhrase({ tool: 'save_to_library', target: 'x' }))).toBe('salva nella Libreria…')
    expect(i18n.t(activityPhrase({ tool: 'recall_memory', target: 'x' }))).toBe('ricorda…')
    expect(i18n.t(activityPhrase({ tool: 'update_memory', target: 'x' }))).toBe('prende nota…')
    expect(i18n.t(activityPhrase({ tool: 'spawn_subagent', target: 'x' }))).toBe('chiede a un aiutante…')
    expect(i18n.t(activityPhrase({ tool: 'message_subagent', target: 'x' }))).toBe('chiede a un aiutante…')
    expect(i18n.t(activityPhrase({ tool: 'fill_credential', target: 'x' }))).toBe('compila l\'accesso…')
  })

  it('inglese: le stesse famiglie nel catalogo en', () => {
    i18n.load('en', enCatalogEntries())
    i18n.activate('en')
    expect(i18n.t(activityPhrase({ tool: 'browser_navigate', target: 'https://fibrapro.it/login' }))).toBe('opens fibrapro.it…')
    expect(i18n.t(activityPhrase({ tool: 'run-command', target: 'rm -rf /box' }))).toBe('runs a command…')
    expect(i18n.t(activityPhrase({ tool: 'web_search', target: 'q' }))).toBe('searches the web…')
    expect(i18n.t(activityPhrase(null))).toBe('working…')
    // fase 16b correzioni (P2): le famiglie nuove anche in inglese
    expect(i18n.t(activityPhrase({ tool: 'web_fetch', target: 'https://fibrapro.it/brand' }))).toBe('reads fibrapro.it…')
    expect(i18n.t(activityPhrase({ tool: 'list-directory', target: '/box' }))).toBe('looks through the files…')
    expect(i18n.t(activityPhrase({ tool: 'write_document', target: 'x' }))).toBe('writes a document…')
    expect(i18n.t(activityPhrase({ tool: 'visualize', target: 'x' }))).toBe('makes a chart…')
    expect(i18n.t(activityPhrase({ tool: 'exa', target: 'x' }))).toBe('searches the web…')
    expect(i18n.t(activityPhrase({ tool: 'save_to_library', target: 'x' }))).toBe('saves to the Library…')
    expect(i18n.t(activityPhrase({ tool: 'recall_memory', target: 'x' }))).toBe('remembers…')
    expect(i18n.t(activityPhrase({ tool: 'update_memory', target: 'x' }))).toBe('takes note…')
    expect(i18n.t(activityPhrase({ tool: 'spawn_subagent', target: 'x' }))).toBe('asks a helper…')
    expect(i18n.t(activityPhrase({ tool: 'fill_credential', target: 'x' }))).toBe('fills in the login…')
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
  })

  it('i casi limite: URL non valido, percorso lungo, tool sconosciuto', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    // URL malformato: niente host → la pagina generica, MAI l'URL intero
    expect(i18n.t(activityPhrase({ tool: 'browser_navigate', target: 'not a url' }))).toBe('apre una pagina…')
    // web_fetch senza URL valido: la pagina web generica
    expect(i18n.t(activityPhrase({ tool: 'web_fetch', target: '' }))).toBe('legge una pagina web…')
    // percorso lungo: solo il nome del file
    expect(i18n.t(activityPhrase({ tool: 'write-file', target: '/box/livello1/livello2/livello3/relazione.md' }))).toBe('scrive relazione.md…')
    // il testo del comando NON compare MAI
    const p = i18n.t(activityPhrase({ tool: 'run-command', target: 'curl http://segretissimo.example/x' }))
    expect(p).not.toContain('segretissimo')
    expect(p).toBe('esegue un comando…')
  })

  it('il passato per l\'elenco dei passaggi', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    expect(i18n.t(activityPhrase({ tool: 'browser_navigate', target: 'https://museivaticani.va' }, 'past'))).toBe('Ha aperto museivaticani.va')
    expect(i18n.t(activityPhrase({ tool: 'run-command', target: 'ls' }, 'past'))).toBe('Ha eseguito un comando')
    expect(i18n.t(activityPhrase({ tool: 'read-file', target: '/a/b/report.md' }, 'past'))).toBe('Ha letto report.md')
    // fase 16b correzioni (P2): dove la tabella non prevedeva il passato, si
    // forma come per le famiglie esistenti
    expect(i18n.t(activityPhrase({ tool: 'list-directory', target: '/box' }, 'past'))).toBe('Ha guardato i file')
    expect(i18n.t(activityPhrase({ tool: 'read_document', target: 'x' }, 'past'))).toBe('Ha letto un documento')
    expect(i18n.t(activityPhrase({ tool: 'visualize', target: 'x' }, 'past'))).toBe('Ha fatto un grafico')
    expect(i18n.t(activityPhrase({ tool: 'write_document', target: 'x' }, 'past'))).toBe('Ha scritto un documento')
    expect(i18n.t(activityPhrase({ tool: 'tavily', target: 'x' }, 'past'))).toBe('Ha cercato sul web')
    expect(i18n.t(activityPhrase({ tool: 'save_to_library', target: 'x' }, 'past'))).toBe('Ha salvato nella Libreria')
    expect(i18n.t(activityPhrase({ tool: 'update_memory', target: 'x' }, 'past'))).toBe('Ha preso nota')
    expect(i18n.t(activityPhrase({ tool: 'spawn_subagent', target: 'x' }, 'past'))).toBe('Ha chiesto a un aiutante')
    expect(i18n.t(activityPhrase({ tool: 'fill_credential', target: 'x' }, 'past'))).toBe('Ha compilato l\'accesso')
  })

  it('helper: host e nome del file', () => {
    expect(hostOf('https://fibrapro.it/x?y=1')).toBe('fibrapro.it')
    expect(hostOf('fibrapro.it')).toBeNull()
    expect(fileNameOf('/box/workspace/report.md')).toBe('report.md')
    expect(fileNameOf('')).toBe('')
  })

  // ---- V5 (prova vera): «usa un'app» dice QUALE app e COSA ----

  it('V5: il blocco di Composio — le azioni coi nomi della card («Gmail · Elenca email»), la prima e «+N»', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    const batch = (slugs: string[]) => ({
      tool: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
      target: 'composio',
      args: JSON.stringify({ tools: slugs.map((s) => ({ tool_slug: s })) })
    })
    expect(i18n.t(activityPhrase(batch(['GMAIL_LIST_THREADS'])))).toBe('usa Gmail · Elenca conversazioni…')
    expect(i18n.t(activityPhrase(batch(['GMAIL_LIST_THREADS']), 'past'))).toBe('Ha usato Gmail · Elenca conversazioni')
    // due azioni: la prima e «+1»
    expect(i18n.t(activityPhrase(batch(['GMAIL_LIST_THREADS', 'SLACK_SEARCH_MESSAGES'])))).toBe('usa Gmail · Elenca conversazioni +1…')
    // senza azioni leggibili: la frase generica di prima
    expect(i18n.t(activityPhrase({ tool: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', target: 'composio' }))).toBe('usa un’app…')
  })

  it('V5: SEARCH_TOOLS e GET_TOOL_SCHEMAS — «cerca lo strumento giusto»', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    expect(i18n.t(activityPhrase({ tool: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', target: 'composio' }))).toBe('cerca lo strumento giusto…')
    expect(i18n.t(activityPhrase({ tool: 'mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS', target: 'composio' }, 'past'))).toBe('Ha cercato lo strumento giusto')
  })

  it('V5: MANAGE_CONNECTIONS — «controlla le app collegate» (list) e «collega <App>» (add)', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    const manage = (entries: Array<{ name: string; action: string }>) => ({
      tool: 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS',
      target: 'composio',
      args: JSON.stringify({ toolkits: entries })
    })
    expect(i18n.t(activityPhrase(manage([{ name: 'gmail', action: 'list' }])))).toBe('controlla le app collegate…')
    expect(i18n.t(activityPhrase(manage([{ name: 'gmail', action: 'list' }]), 'past'))).toBe('Ha controllato le app collegate')
    expect(i18n.t(activityPhrase(manage([{ name: 'slack', action: 'add' }])))).toBe('collega Slack…')
    expect(i18n.t(activityPhrase(manage([{ name: 'slack', action: 'add' }]), 'past'))).toBe('Ha collegato Slack')
  })

  it('V5: gli altri server MCP dicono il NOME del server, mai il nome tecnico dello strumento', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    expect(i18n.t(activityPhrase({ tool: 'mcp__linear__create_issue', target: 'linear', app: 'Linear' }))).toBe('usa Linear…')
    expect(i18n.t(activityPhrase({ tool: 'mcp__linear__create_issue', target: 'linear', app: 'Linear' }, 'past'))).toBe('Ha usato Linear')
    // senza nome dal daemon: lo slug del server reso leggibile
    expect(i18n.t(activityPhrase({ tool: 'mcp__ufficio_posta__invia', target: 'ufficio_posta' }, 'past'))).toBe('Ha usato Ufficio posta')
    // il vecchio flusso SDK composio__gmail__…: l'app umana
    expect(i18n.t(activityPhrase({ tool: 'composio__gmail__GMAIL_SEND_EMAIL', target: '' }))).toBe('usa Gmail…')
  })

  it('V5: le stesse frasi nel catalogo en', () => {
    i18n.load('en', enCatalogEntries())
    i18n.activate('en')
    const batch = (slugs: string[]) => ({
      tool: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL',
      target: 'composio',
      args: JSON.stringify({ tools: slugs.map((s) => ({ tool_slug: s })) })
    })
    expect(i18n.t(activityPhrase(batch(['GMAIL_LIST_THREADS']), 'past', 'en'))).toBe('Used Gmail · List threads')
    expect(i18n.t(activityPhrase({ tool: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', target: 'composio' }, 'present', 'en'))).toBe('searches for the right tool…')
    expect(i18n.t(activityPhrase({ tool: 'mcp__linear__create_issue', target: 'linear', app: 'Linear' }, 'past', 'en'))).toBe('Used Linear')
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
  })
})

// fase 16b correzioni (P2): la tabella non si disallinea dal daemon — ogni
// nome deve esistere fra i tool definiti nel daemon (toolDefs, computer e
// find_tools, i provider della catena di ricerca), salvo i prefissi mcp__ e
// browser_ (dinamici/non verificabili staticamente)
describe('fase 16b correzioni (P2): coerenza TOOL_FAMILIES ↔ nomi dei tool del daemon', () => {
  it('ogni nome della tabella esiste nel daemon', () => {
    const names = new Set<string>([
      ...toolDefs.map((t) => t.name),
      ...computerToolDefs.map((t) => t.name),
      wakeParentToolDef.name,
      findToolsDef([], true, () => '').name,
      // i nomi della catena di ricerca keyless (provider + tool MCP di Exa)
      youKeylessProvider().name,
      exaMcpKeylessProvider().name,
      tavilyKeylessProvider().name,
      EXA_MCP_SEARCH_TOOL
    ])
    const ghosts = TOOL_FAMILIES.flatMap((f) => f.tools).filter(
      (t) => !t.startsWith('mcp__') && !t.startsWith('browser_') && !names.has(t)
    )
    expect(ghosts).toEqual([])
  })

  it('la tabella non ha doppioni fra famiglie', () => {
    const all = TOOL_FAMILIES.flatMap((f) => f.tools)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('fase 16b (S3.3): stepsOfTurn — i passaggi del turno', () => {
  const userMsg = (id: number, at = id): TranscriptEntry =>
    entry({ id, kind: 'message', role: 'user', content: 'domanda', createdAt: at * 1000 })
  const call = (id: number, tool: string, args: Record<string, unknown> = {}, at = id): TranscriptEntry =>
    entry({ id, kind: 'tool-call', role: 'assistant', content: tool, createdAt: at * 1000, meta: { id: `c${id}`, arguments: JSON.stringify(args) } })
  const result = (id: number, callId: string, at = id): TranscriptEntry =>
    entry({ id, kind: 'tool-result', role: 'system', content: 'ok', createdAt: at * 1000, meta: { callId } })

  it('i passaggi del turno APERTO: tutto dopo l\'ultimo messaggio utente, ✓/○', () => {
    const entries = [
      userMsg(1),
      call(2, 'browser_navigate', { url: 'https://x.example' }),
      result(3, 'c2'),
      userMsg(4), // nuovo turno: si riparte da qui
      call(5, 'web_search', { query: 'gatti' }),
      call(6, 'run-command', { command: 'ls' })
    ]
    const g = stepsOfTurn(entries, 'open')
    expect(g.steps.map((s) => s.tool)).toEqual(['web_search', 'run-command'])
    expect(g.steps.map((s) => s.done)).toEqual([false, false])
    // con l'entry 5 fatta: il suo ✓ arriva, il 6 resta ○
    const g2 = stepsOfTurn([...entries, result(7, 'c5')], 'open')
    expect(g2.steps.map((s) => s.done)).toEqual([true, false])
  })

  it('i passaggi del turno di un MESSAGGIO dato (la «ⓘ»): fino a quel messaggio', () => {
    const answer = entry({ id: 9, kind: 'send-message', role: 'assistant', content: 'ecco', createdAt: 9000, meta: { message: { type: 'text', text: 'ecco' } } })
    const entries = [
      userMsg(1),
      call(2, 'read-file', { path: '/a/report.md' }),
      result(3, 'c2'),
      answer,
      // il turno DOPO non conta
      userMsg(10),
      call(11, 'web_search', {})
    ]
    const g = stepsOfTurn(entries, { entryId: 9 })
    expect(g.steps).toHaveLength(1)
    expect(g.steps[0]!.tool).toBe('read-file')
    expect(g.steps[0]!.done).toBe(true)
    expect(g.steps[0]!.target).toBe('/a/report.md')
  })

  it('durata e bersaglio dagli argomenti', () => {
    const entries = [
      userMsg(1),
      call(2, 'browser_navigate', { url: 'https://x.example' }, 2),
      result(3, 'c2', 43)
    ]
    const g = stepsOfTurn(entries, 'open')
    expect(stepsDurationSeconds(g, 50_000)).toBe(41)
    expect(targetOfArguments(JSON.stringify({ path: '/a/b/c.md' }))).toBe('/a/b/c.md')
    expect(targetOfArguments('non json')).toBe('')
  })

  it('senza apertura (solo tool, dati vecchi): tutto il transcript', () => {
    const entries = [call(1, 'web_search'), result(2, 'c1')]
    const g = stepsOfTurn(entries, 'open')
    expect(g.steps).toHaveLength(1)
    expect(g.steps[0]!.done).toBe(true)
  })
})

// ---- P5 (fase pulizia): l'etichetta della durata del riquadro dei passaggi ----
describe('P5 — stepsDurationLabel: mai «0 s»', () => {
  const userMsg = (id: number, at = id): TranscriptEntry =>
    entry({ id, kind: 'message', role: 'user', content: 'domanda', createdAt: at * 1000 })
  const call = (id: number, tool: string, args: Record<string, unknown> = {}, at = id): TranscriptEntry =>
    entry({ id, kind: 'tool-call', role: 'assistant', content: tool, createdAt: at * 1000, meta: { id: `c${id}`, arguments: JSON.stringify(args) } })
  const result = (id: number, callId: string, at = id): TranscriptEntry =>
    entry({ id, kind: 'tool-result', role: 'system', content: 'ok', createdAt: at * 1000, meta: { callId } })

  it('durata sotto il secondo (misurata): «< 1 s»', () => {
    // startedAt = il primo passo (2 s), fine 2,4 s: 0 secondi interi
    const entries = [userMsg(1), call(2, 'web_search', {}, 2), result(3, 'c2', 2.4)]
    const g = stepsOfTurn(entries, 'open')
    expect(stepsDurationSeconds(g, 2_400)).toBe(0)
    expect(stepsDurationLabel(g, 2_400)).toBe('< 1 s')
  })

  it('senza durata nota (nessun passo, startedAt nullo): NESSUN tempo', () => {
    const g = stepsOfTurn([userMsg(1)], 'open')
    expect(g.startedAt).toBeNull()
    expect(stepsDurationLabel(g, 99_000)).toBeNull()
  })

  it('un secondo o più: i secondi interi come oggi', () => {
    const entries = [userMsg(1), call(2, 'web_search', {}, 2), result(3, 'c2', 43)]
    const g = stepsOfTurn(entries, 'open')
    expect(stepsDurationLabel(g, 50_000)).toBe('41 s')
  })
})
