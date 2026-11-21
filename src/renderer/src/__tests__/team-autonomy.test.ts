// Q1 (fase squadra): la schermata 3 del disegno — «Autonomia della squadra».
// Guardia UI: le tre voci del disegno con le loro descrizioni, la colonna
// «Chiede sempre a te» che non si può svuotare, la nota sul coordinatore e
// il radio che seleziona (Salva chiama groupUpdate con l'autonomia scelta).
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, setStoreStateForRender, parseHtml, findAll, textOf, dialogPassThroughMock } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())

const { TeamAutonomySheet, autonomyShortLabel, AUTONOMY_CHOICES } = await import('../components/TeamAutonomySheet')
const { useStore } = await import('../store')

const group = () => ({
  id: 1, name: 'Weekend Torino', description: '', createdBy: 'user', coordinatorId: 'a1',
  members: [{ agentId: 'a1', name: 'Capo', coordinator: true }],
  createdAt: 1, lastMessageAt: null, autonomy: 'box' as const
})

function renderSheet(): ReturnType<typeof parseHtml> {
  const updates: Array<Record<string, unknown>> = []
  setStoreStateForRender(useStore, {
    groups: [group()],
    groupUpdate: (gid: number, patch: Record<string, unknown>) => {
      updates.push({ gid, patch })
      return Promise.resolve()
    }
  })
  const html = renderHtml(createElement(TeamAutonomySheet, { group: group(), onClose: () => undefined }))
  return parseHtml(html)
}

describe('Q1: la schermata Autonomia della squadra (tavola 3 del disegno)', () => {
  it('le TRE voci del disegno con le descrizioni giuste, «Libera nel computer» consigliata e selezionata', () => {
    const tree = renderSheet()
    const text = textOf(tree)
    expect(text).toContain('Autonomia del team')
    expect(text).toContain('Weekend Torino · vale per tutti i bot del team, finché il team esiste')
    expect(text).toContain('Chiede tutto')
    expect(text).toContain('Ogni azione con effetti passa da te. Per provare un team nuovo.')
    expect(text).toContain('Libera nel computer')
    expect(text).toContain('consigliata')
    expect(text).toContain('Tutto quello che resta nel computer isolato lo fa da sola. Fuori dal computer chiede.')
    expect(text).toContain('Libera nel computer + revisore')
    expect(text).toContain('I dubbi arrivano a te.')
    expect(text).toContain('Quanto fa da sola')
  })

  it('le due colonne del disegno, e quella di destra non si può svuotare', () => {
    const tree = renderSheet()
    const text = textOf(tree)
    expect(text).toContain('Fa da sola')
    for (const row of ['creare e modificare file nel computer', 'leggere e cercare pagine web', 'lanciare sottoagenti']) {
      expect(text, row).toContain(row)
    }
    expect(text).toContain('Chiede sempre a te')
    for (const row of ['moduli con i tuoi dati, login, Cassaforte', 'pagamenti e acquisti', 'eliminare un bot']) {
      expect(text, row).toContain(row)
    }
    expect(text).toContain('Questa colonna non si può svuotare.')
  })

  it('la nota del disegno: decide il revisore, MAI il coordinatore', () => {
    const tree = renderSheet()
    expect(textOf(tree)).toContain('Il coordinatore non approva al posto tuo')
  })

  it('tre radio, selezionata quella del gruppo; Salva c\'è ed è disabilitata finché non cambia', () => {
    const tree = renderSheet()
    const radios = findAll(tree, (n) => n.tag === 'input' && n.attrs.type === 'radio')
    expect(radios.length).toBe(3)
    expect('checked' in radios[1]!.attrs).toBe(true)
    expect('checked' in radios[0]!.attrs).toBe(false)
    expect('checked' in radios[2]!.attrs).toBe(false)
    const save = findAll(tree, (n) => n.attrs['data-testid'] === 'team-autonomy-save')[0]
    expect(save).toBeTruthy()
    expect('disabled' in save!.attrs).toBe(true)
  })

  it('le etichette corte delle tre autonomia (la pillola della chat) e i tre valori nell\'ordine del disegno', () => {
    expect(AUTONOMY_CHOICES.map((c) => c.value)).toEqual(['ask', 'box', 'box_review'])
    const t = (d: { id: string; message?: string }) => d.message ?? d.id
    const byId = Object.fromEntries(AUTONOMY_CHOICES.map((c) => [c.value, t(c.short as never)]))
    expect(byId.ask).toContain('chiede tutto')
    expect(byId.box).toContain('nel computer')
    expect(byId.box_review).toContain('revisore')
  })
})
