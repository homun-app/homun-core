// K3 (fase conversione-chat): i difetti delle card di approvazione visti da K1.
//   (c) la card scaduta diceva «expired» grezzo: lo stato del daemon passato
//       alla riga com'era — ora una frase del catalogo;
//   (e) «Rifiuta» era rosso pieno nella coda della squadra e neutro (secondario
//       su fondo card) nella card in chat: una regola sola, quella del catalogo.
// Render VERO con react-dom/server, come gli altri test delle card.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, textOf, findAll, setStoreStateForRender, type HtmlNode } from './render-helper'
import type { TranscriptEntry } from '../../../shared/types'

const { ApprovalCard, ApprovalRequestContent } = await import('../components/ApprovalCard')
const { ApprovalsQueue } = await import('../components/ApprovalsQueue')
const { useStore } = await import('../store')

/** La entry di un comando da approvare, com'è nel transcript; `status` è quello che il daemon scrive dopo la decisione (o la scadenza). */
const COMANDO = (status?: string): TranscriptEntry => ({
  id: 1, agentId: 'a', kind: 'approval', role: 'system', content: '', createdAt: 1_700_000_000_000,
  meta: { approvalId: 'ap1', tool: 'run-command', input: { command: 'git status' }, status: status ?? 'pending' }
}) as never

const albero = (tipo: unknown, props: Record<string, unknown>): HtmlNode => parseHtml(renderHtml(createElement(tipo as never, props as never)))
const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')
/** Il testo della riga che resta dopo la decisione (il bottone della riga: Disclosure). */
const rigaDecisa = (status: string): string => textOf(findAll(albero(ApprovalCard, { entry: COMANDO(status) }), (n) => n.tag === 'button')[0]!)

describe('K3 (c): la card scaduta dice una frase del catalogo, mai lo stato grezzo', () => {
  it('scaduta: «Scaduta: il bot non aspetta più» — la stessa frase della presa di controllo scaduta — e mai «expired»', () => {
    expect(rigaDecisa('expired')).toContain('Scaduta: il bot non aspetta più')
    expect(rigaDecisa('expired')).not.toContain('expired')
  })

  it('gli altri esiti restano quelli di sempre, e uno stato che il catalogo non conosce non si mostra grezzo: «Chiusa»', () => {
    expect(rigaDecisa('allowed')).toContain('Consentito una volta')
    expect(rigaDecisa('denied')).toContain('Rifiutato')
    expect(rigaDecisa('cancelled')).toContain('Annullato (interrupt)')
    expect(rigaDecisa('uno-stato-mai-visto')).toContain('Chiusa')
    expect(rigaDecisa('uno-stato-mai-visto')).not.toContain('uno-stato-mai-visto')
  })
})
