// A2 (fase centro-autorizzazioni): il centro «Da approvare» (tavola 4) —
// tutte le richieste che spettano all'utente, in un posto. Gruppi (squadre
// poi bot singoli), filtri per tipo con i conteggi, card con categoria, bot
// («tramite un sottoagente»), attesa e perché, i bottoni di OGGI per quel
// tipo di card («Consenti per questa missione» solo dove Q2 lo permette,
// bozze con Invia/Modifica/Rifiuta), «Rimanda» per un'ora (solo vista), più
// di 3 per tipo nel gruppo → «+N … Vedi». MAI un «approva tutto».
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, textOf, findAll } from './render-helper'
import { callsOf } from './render-helper-install'
import type { ApprovalsCenterRow, TranscriptEntry } from '../../../shared/types'

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})

const { ApprovalsCenter } = await import('../components/ApprovalsCenter')
const { visibleApprovalsRows, groupApprovalsRows } = await import('../lib/approvals-center')
const { useStore } = await import('../store')

const row = (over: Partial<ApprovalsCenterRow> = {}): ApprovalsCenterRow => ({
  agentId: 'a-turismo', agentName: 'Turismo', parentId: null, parentName: null, fromSubagent: false,
  botId: 'a-turismo', botName: 'Turismo', squad: { id: 1, name: 'Weekend Torino' },
  approvalId: 'ap-1', entryId: 1, tool: 'fill_credential', phrase: 'Compilare il modulo del Museo Egizio con nome ed email.',
  category: 'dati-tuoi', why: 'fisso', when: Date.now() - 120_000, isDraft: false, preview: null,
  ...over
})

const groups = () =>([
  { id: 1, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a-turismo', members: [{ agentId: 'a-turismo', name: 'Turismo', coordinator: true }], createdAt: 1, lastMessageAt: null, autonomy: 'box' as const },
  { id: 2, name: 'Fatture marzo', description: '', createdBy: 'user', coordinatorId: 'a-solleciti', members: [{ agentId: 'a-solleciti', name: 'Solleciti', coordinator: true }], createdAt: 2, lastMessageAt: null, autonomy: 'box' as const }
])

function renderCenter(rows: ApprovalsCenterRow[], patch: Record<string, unknown> = {}): ReturnType<typeof parseHtml> {
  capture.els.length = 0
  setStoreStateForRender(useStore, {
    approvalsAll: rows,
    approvalsSnoozed: {},
    approvalsOpen: true,
    approvalsFocusId: null,
    approvalsBannerCollapsed: false,
    groups: groups(),
    agents: [],
    entries: [],
    activeId: 'a-turismo',
    openGroupId: null,
    activityOpen: false,
    openLibraryId: null,
    approvalsQueueOpen: false,
    ...patch
  })
  return parseHtml(renderHtml(createElement(ApprovalsCenter)))
}

/** i bottoni resi col testid cercato */
const buttonsWithTestid = (testid: string) =>
  capture.els.filter((e) => e.type === 'button' && e.props['data-testid'] === testid)

beforeEach(() => {
  useStore.setState({ approvalsAll: [], approvalsSnoozed: {}, approvalsOpen: false, approvalsFocusId: null })
})

describe('A2: il centro «Da approvare» (tavola 4)', () => {
  it('testata, filtri con conteggi, gruppi con «Apri la squadra» e card complete', () => {
    const rows = [
      row(),
      row({ agentId: 'a-alloggio', botId: 'a-alloggio', botName: 'Alloggio', fromSubagent: true, parentId: 'a-capo', parentName: 'Capo', agentName: 'Figlio', approvalId: 'ap-2', tool: 'browser_click', phrase: 'Cliccare «Verifica disponibilità».', category: 'sito-interattivo', why: 'revisore', when: Date.now() - 240_000, preview: { url: 'https://booking.example' } }),
      row({ agentId: 'a-solleciti', agentName: 'Solleciti', botId: 'a-solleciti', botName: 'Solleciti', squad: { id: 2, name: 'Fatture marzo' }, approvalId: 'ap-3', tool: 'draft_external', phrase: 'Mandare il sollecito a Rossi Srl.', category: 'invio', why: null, when: Date.now() - 720_000, isDraft: true, preview: { to: 'amministrazione@rossi.example', subject: 'Fattura 214' } }),
      row({ agentId: 'a-ricerche', agentName: 'Ricerche', botId: 'a-ricerche', botName: 'Ricerche', squad: null, approvalId: 'ap-4', tool: 'fill_credential', phrase: 'Accedere a LinkedIn.', category: 'dati-tuoi', why: null, when: Date.now() - 3_600_000 })
    ]
    const tree = renderCenter(rows)
    const text = textOf(tree)
    expect(text).toContain('Da approvare')
    expect(text).toContain('4 richieste da 4 bot')
    expect(text).toContain('solo tu puoi deciderle')
    expect(text).toContain('ogni richiesta si decide anche dove è nata')
    // i filtri per tipo con i conteggi
    expect(text).toContain('Tutte · 4')
    expect(text).toContain('I tuoi dati · 2')
    expect(text).toContain('Invii · 1')
    expect(text).toContain('Siti · 1')
    // i gruppi: le squadre, poi i bot singoli
    expect(text).toContain('Weekend Torino')
    expect(text).toContain('team · 2')
    expect(text).toContain('Apri il team')
    expect(text).toContain('Fatture marzo')
    expect(text).toContain('team · 1')
    expect(text).toContain('Ricerche')
    expect(text).toContain('bot · 1')
    // la card del sottoagente mostra il padre
    expect(text).toContain('tramite un sottoagente')
    expect(text).toContain('aspetta da 2 min')
    // il perché della card di oggi
    expect(text).toContain('sempre a te')
    expect(text).toContain('il revisore non è sicuro')
    // l'anteprima già nella card: destinatario e oggetto della bozza
    expect(text).toContain('A: amministrazione@rossi.example')
    expect(text).toContain('Oggetto: Fattura 214')
    // i bottoni di oggi: missione SOLO dove Q2 la permette (sito, squadra, non fisso)
    expect(buttonsWithTestid('approval-allow-once').length).toBe(3)
    expect(buttonsWithTestid('approval-mission').length).toBe(1)
    expect(buttonsWithTestid('approval-deny').length).toBe(4)
    expect(buttonsWithTestid('approval-draft-send').length).toBe(1)
    expect(buttonsWithTestid('approval-draft-edit').length).toBe(1)
    expect(buttonsWithTestid('approval-snooze').length).toBe(rows.length)
  })

  it('NESSUN bottone «approva tutto» nel DOM', () => {
    const rows = [row(), row({ approvalId: 'ap-2' }), row({ approvalId: 'ap-3' })]
    const tree = renderCenter(rows)
    const all = findAll(tree, (n) => n.tag === 'button')
    for (const b of all) {
      const label = [textOf(b), b.attrs['aria-label'] ?? '', b.attrs.title ?? ''].join(' ').toLowerCase()
      expect(label).not.toContain('approva tutto')
      expect(label).not.toContain('approve all')
    }
  })

  it('il centro decide una richiesta e la card nella chat del bot passa a decisa', () => {
    const approvalEntry: TranscriptEntry = {
      id: 9, agentId: 'a-turismo', kind: 'approval', role: 'system',
      content: 'Compilare il modulo del Museo Egizio con nome ed email.',
      meta: { approvalId: 'ap-1', tool: 'fill_credential', status: 'pending' }, createdAt: 1
    }
    renderCenter([row()], { entries: [approvalEntry] })
    const btn = buttonsWithTestid('approval-allow-once')[0]
    expect(btn).toBeTruthy()
    ;(btn!.props.onClick as () => void)()
    const calls = callsOf('resolveApproval')
    expect(calls[calls.length - 1]!.args).toEqual(['a-turismo', 'ap-1', 'allow', 'once'])
    // la card nella chat del bot passa a decisa (l'ottimistico di oggi)
    const en = useStore.getState().entries.find((e) => e.meta?.approvalId === 'ap-1')
    expect(en?.meta?.status).toBe('allowed')
  })

  it('«Rimanda»: la toglie dalla vista (solo dalla vista) e dopo 1 ora torna', () => {
    const rows = [row(), row({ approvalId: 'ap-2' })]
    renderCenter(rows)
    const btn = buttonsWithTestid('approval-snooze')[0]
    ;(btn!.props.onClick as () => void)()
    // lo stato finisce in un setting
    const set = callsOf('settingsSet').find((c) => c.args[0] === 'approvals.snoozed')
    expect(set).toBeTruthy()
    const snoozed = set!.args[1] as Record<string, number>
    expect(Object.keys(snoozed)).toEqual(['ap-1'])
    const now = Date.now()
    // sparita dalla vista, NON dalle richieste
    expect(visibleApprovalsRows(rows, snoozed, now)).toHaveLength(1)
    expect(rows).toHaveLength(2)
    // dopo 1 ora torna
    expect(visibleApprovalsRows(rows, snoozed, now + 3_600_000 + 1)).toHaveLength(2)
  })

  it('più di 3 richieste dello stesso tipo nello stesso gruppo: «+N … Vedi»', () => {
    const rows = [
      row(),
      row({ approvalId: 'ap-b', when: Date.now() - 130_000 }),
      row({ approvalId: 'ap-c', when: Date.now() - 140_000 }),
      row({ agentId: 'a-alloggio', botId: 'a-alloggio', botName: 'Alloggio', approvalId: 'ap-d', phrase: 'Archivio: clic su fatture.', when: Date.now() - 150_000 }),
      row({ agentId: 'a-alloggio', botId: 'a-alloggio', botName: 'Alloggio', approvalId: 'ap-e', phrase: 'Archivio: altro clic.', when: Date.now() - 160_000 })
    ]
    const tree = renderCenter(rows)
    const text = textOf(tree)
    expect(text).toContain('+2')
    expect(text).toContain('Vedi')
    // le card mostrate del gruppo restano 3 (le altre nella riga +N)
    const articles = findAll(tree, (n) => n.tag === 'article')
    expect(articles.length).toBe(3)
  })

  it('il raggruppamento puro: prima le squadre nell\'ordine di urgenza, poi i bot', () => {
    const rows = [
      row({ botId: 'a-solo', botName: 'Solo', squad: null, approvalId: 'x1', when: 3_000 }),
      row({ squad: { id: 2, name: 'Fatture marzo' }, botId: 'a-s', botName: 'S', approvalId: 'x2', when: 2_000 }),
      row({ approvalId: 'x3', when: 1_000 })
    ]
    const grouped = groupApprovalsRows(rows)
    expect(grouped.map((g) => g.kind)).toEqual(['squad', 'squad', 'bot'])
    expect(grouped[0]!.squad!.id).toBe(1)
    expect(grouped[2]!.bot!.botName).toBe('Solo')
  })

  it('l\'evento open-approvals (il click sulla notifica) apre il centro su quella richiesta', async () => {
    const { useStore: st } = await import('../store')
    // il gestore dell'evento lo registra init(); qui si chiama direttamente
    // l'azione che il case 'open-approvals' usa, con l'evento simulato
    st.setState({ approvalsOpen: false, approvalsFocusId: null, activityOpen: true })
    st.getState().setApprovalsOpen(true, 'ap-9')
    expect(st.getState().approvalsOpen).toBe(true)
    expect(st.getState().approvalsFocusId).toBe('ap-9')
    expect(st.getState().activityOpen).toBe(false)
  })

  it('0 richieste: il messaggio vuoto, nessun gruppo', () => {
    const tree = renderCenter([])
    const text = textOf(tree)
    expect(text).toContain('Nessuna richiesta in attesa')
    expect(text).not.toContain('Apri la squadra')
  })
})
