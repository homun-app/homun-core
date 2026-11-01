// Fase 16b (S3.3) — test della mezza riga d'attività (activityPhrase) e del
// raggruppamento dei passaggi per turno (stepsOfTurn). Puri, nei due cataloghi.
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { activityPhrase, stepsOfTurn, targetOfArguments, hostOf, fileNameOf, stepsDurationSeconds } from '../activity'
import type { TranscriptEntry } from '../../../../shared/types'
import { itCatalogEntries, enCatalogEntries } from '../../__tests__/po-helper'

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
    ['it', 'scrive un documento…', { tool: 'save_document', target: 'riepilogo' }],
    ['it', 'naviga…', { tool: 'browser_click', target: 'ref=e5' }],
    ['it', 'lavora…', { tool: 'tool_sconosciuto', target: 'x' }],
    ['it', 'lavora…', null]
  ])('%s: %s', (lang, expected, activity) => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    void lang
    expect(i18n.t(activityPhrase(activity as never))).toBe(expected)
  })

  it('inglese: le stesse famiglie nel catalogo en', () => {
    i18n.load('en', enCatalogEntries())
    i18n.activate('en')
    expect(i18n.t(activityPhrase({ tool: 'browser_navigate', target: 'https://fibrapro.it/login' }))).toBe('opens fibrapro.it…')
    expect(i18n.t(activityPhrase({ tool: 'run-command', target: 'rm -rf /box' }))).toBe('runs a command…')
    expect(i18n.t(activityPhrase({ tool: 'web_search', target: 'q' }))).toBe('searches the web…')
    expect(i18n.t(activityPhrase(null))).toBe('working…')
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
  })

  it('i casi limite: URL non valido, percorso lungo, tool sconosciuto', () => {
    i18n.load('it', itCatalogEntries())
    i18n.activate('it')
    // URL malformato: niente host → la pagina generica, MAI l'URL intero
    expect(i18n.t(activityPhrase({ tool: 'browser_navigate', target: 'not a url' }))).toBe('apre una pagina…')
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
  })

  it('helper: host e nome del file', () => {
    expect(hostOf('https://fibrapro.it/x?y=1')).toBe('fibrapro.it')
    expect(hostOf('fibrapro.it')).toBeNull()
    expect(fileNameOf('/box/workspace/report.md')).toBe('report.md')
    expect(fileNameOf('')).toBe('')
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
