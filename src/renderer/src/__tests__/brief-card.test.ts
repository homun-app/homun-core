// P5 (fase uso-permessi): il compito dell'aiutante si legge come un compito,
// non come XML — il messaggio di apertura del sottoagente (il <brief> del
// padre) si rende come card «Compito affidato da <bot>»: titolo, le prime
// righe e «mostra tutto»; NESSUN tag visibile. La bola scura dell'utente
// resta SOLO per i messaggi dell'utente. Render statico del componente VERO.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf } from './render-helper'
import { formatSubagentBrief } from '../../../shared/agent-message'
import type { TranscriptEntry } from '../../../shared/types'

const { BriefCard } = await import('../components/BriefCard')
const { useStore } = await import('../store')

const briefEntry: TranscriptEntry = {
  id: 3,
  agentId: 'sub-9',
  kind: 'message',
  role: 'user',
  content: formatSubagentBrief(
    'Cerca i biglietti del treno',
    'Trova i treni Roma–Torino di domattina, solo andata.\nRiporta prezzo e orario di ciascuna soluzione.\nEvita le offerte in classe business.\nSe la pagina chiede il login, fermati e riferisci.',
    'it'
  ),
  meta: {},
  createdAt: 100
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('P5: la card «Compito affidato da <bot>» al posto del brief grezzo', () => {
  it('titolo del compito, nome del PADRE, prime righe e «mostra tutto»: NESSUN <brief> visibile', () => {
    setStoreStateForRender(useStore as never, {
      agents: [
        { id: 'bot-padre', name: 'Segretario', description: '', providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 1 },
        { id: 'sub-9', name: 'Cerca biglietti', description: '', providerId: 'p', model: 'm', status: 'idle', unread: 0, createdAt: 2, parentId: 'bot-padre' }
      ] as never
    })
    const html = renderHtml(createElement(BriefCard, { entry: briefEntry }))
    const root = parseHtml(html)
    const text = textOf(root)
    // la card dice CHI ha affidato il compito e il TITOLO (dal tag, non visibile)
    expect(text).toContain('Compito affidato da Segretario')
    expect(text).toContain('Cerca i biglietti del treno')
    // le prime righe del compito ci sono, la chiusura del testo resta dietro «mostra tutto»
    expect(text).toContain('Trova i treni Roma–Torino di domattina')
    expect(findAll(root, (n) => textOf(n) === 'mostra tutto')).toBeTruthy()
    // NESSUN tag visibile e NESSUNA regola per il modello
    expect(text).not.toContain('<brief')
    expect(text).not.toContain('</brief>')
    expect(text).not.toContain('wake_parent')
  })

  it('guardia sul sorgente: la chat rende BriefCard per il brief, MAI la bolla utente', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/Chat.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/parseSubagentBrief\(entry\.content\)/)
    // la bolla utente resta SOLO per i messaggi dell'utente: il brief NON passa da lì
    expect(src).toMatch(/if \(brief\)/)
  })
})
