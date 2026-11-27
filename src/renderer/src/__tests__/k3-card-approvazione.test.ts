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

describe('K3 (e): «Rifiuta» è UNA regola sola, quella del catalogo (Button destructive)', () => {
  /** Per ogni bottone «Rifiuta» il suo fondo: rosso pieno (destructive), fondo card o tenue (secondario). */
  const fondi = (root: HtmlNode): string[][] => findAll(root, (n) => n.tag === 'button' && textOf(n) === 'Rifiuta')
    .map((b) => classes(b).filter((c) => c === 'bg-destructive' || c === 'bg-card' || c === 'bg-muted'))

  it('nella card dei messaggi, nel riquadro sopra il campo e nella coda della squadra «Rifiuta» è lo STESSO bottone: rosso pieno, mai secondario', () => {
    const card = fondi(albero(ApprovalCard, { entry: COMANDO() }))
    const riquadro = fondi(albero(ApprovalRequestContent, { entry: COMANDO(), agentName: 'Nora' }))
    setStoreStateForRender(useStore, {
      openGroupId: 1,
      groups: [{ id: 1, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1', members: [{ agentId: 'a1', name: 'Capo', coordinator: true }], createdAt: 1, lastMessageAt: null, autonomy: 'box' }],
      groupPending: [{ agentId: 'a2', agentName: 'Turismo', approvalId: 'ap-1', tool: 'fill_credential', phrase: 'Compilare il modulo.', category: 'dati-tuoi', why: 'fisso', when: Date.now() - 120_000, fromSubagent: false }],
      groupActivity: [], groupReviewerPassed: []
    })
    const coda = fondi(albero(ApprovalsQueue, {}))
    expect(card).toHaveLength(1)
    expect(riquadro).toHaveLength(1)
    expect(coda).toHaveLength(1)
    for (const [dove, f] of [['card', card], ['riquadro', riquadro], ['coda', coda]] as const) {
      expect(f[0], dove).toEqual(['bg-destructive'])
    }
  })
})
