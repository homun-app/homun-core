// CC3 (fase computer-card): la card «Computer» — la funzione PURA che decide
// lo stato dai TRE fatti (lo stato del box dal daemon, l'attività del bot,
// il browser aperto) più la preparazione del computer. Una riga per ogni
// stato della tabella della spec, e i casi di confine: lo strumento NON del
// computer, il comando il cui TESTO non compare MAI, il browser aperto senza
// attività, la preparazione che vince su tutto. I testi si verificano sui
// cataloghi VERI it/en (po-helper).
import { describe, expect, it, beforeAll } from 'vitest'
import { i18n } from '@lingui/core'
import { itCatalogEntries, enCatalogEntries } from '../../__tests__/po-helper'
import { computerCardState, type ComputerCardFacts } from '../computer-card'
import type { BotActivity } from '../activity'
import type { BoxRuntime, BoxSetupPhase } from '../../../../shared/types'

beforeAll(() => {
  i18n.load('it', itCatalogEntries())
  i18n.load('en', enCatalogEntries())
  i18n.activate('it')
})

const facts = (over: Partial<ComputerCardFacts> = {}): ComputerCardFacts => ({
  boxRuntime: { state: 'running', since: 1 },
  activity: null as BotActivity | null,
  browser: 'stopped',
  boxSetupPhase: null as BoxSetupPhase | null,
  boxInUse: true,
  ...over
})

describe('CC3: una riga per ogni stato della tabella', () => {
  it('In preparazione: box-setup in corso VINCE su tutto (anche col box acceso e un comando in corsa)', () => {
    const v = computerCardState(facts({ boxSetupPhase: 'building-image', activity: { tool: 'run-command', target: 'ls /usr/bin' } }))
    expect(v.status).toBe('prep')
    expect(i18n.t(v.label)).toBe('In preparazione')
    expect(v.dot).toBe('bg-waiting')
    expect(v.line).toBeNull()
  })

  it('le fasi FERME (idle, ready, error, cancelled) NON sono preparazione', () => {
    for (const phase of ['idle', 'ready', 'error', 'cancelled'] as BoxSetupPhase[]) {
      expect(computerCardState(facts({ boxSetupPhase: phase })).status, phase).not.toBe('prep')
    }
  })

  it('Acceso: box running + attività del computer (run-command) — riga «esegue un comando…» SENZA il comando', () => {
    const v = computerCardState(facts({ activity: { tool: 'run-command', target: 'ls /usr/bin' } }))
    expect(v.status).toBe('on')
    expect(i18n.t(v.label)).toBe('Acceso')
    expect(v.dot).toBe('bg-chart-2')
    const line = i18n.t(v.line!)
    expect(line).toBe('esegue un comando…')
    expect(line).not.toContain('ls')
  })

  it('In attesa: box running, NESSUNA attività del computer', () => {
    const v = computerCardState(facts())
    expect(v.status).toBe('waiting')
    expect(i18n.t(v.label)).toBe('In attesa')
    expect(v.dot).toBe('bg-waiting')
    expect(v.line).toBeNull()
  })

  it("In attesa anche con un'attività NON del computer (send_to_user): la riga resta vuota", () => {
    const v = computerCardState(facts({ activity: { tool: 'send_to_user', target: '' } }))
    expect(v.status).toBe('waiting')
    expect(v.line).toBeNull()
  })

  it('Spento: box stopped o missing', () => {
    const stopped = computerCardState(facts({ boxRuntime: { state: 'stopped', since: 2 } satisfies BoxRuntime }))
    expect(stopped.status).toBe('off')
    expect(i18n.t(stopped.label)).toBe('Spento')
    expect(stopped.dot).toBe('bg-muted-foreground/40')
    expect(computerCardState(facts({ boxRuntime: { state: 'missing', since: 2 } satisfies BoxRuntime })).status).toBe('off')
  })

  it('Non in uso: sandbox.mode ≠ box (o motore assente) — grigio, qualunque sia il resto', () => {
    const v = computerCardState(facts({ boxInUse: false, activity: { tool: 'run-command', target: 'x' } }))
    expect(v.status).toBe('unavailable')
    expect(i18n.t(v.label)).toBe('Non in uso')
    expect(v.dot).toBe('bg-muted-foreground/40')
    expect(v.line).toBeNull()
  })
})

describe("CC3: la riga sotto l'etichetta", () => {
  it("browser aperto senza attività → «In attesa» e «Browser aperto»", () => {
    const v = computerCardState(facts({ browser: 'running' }))
    expect(v.status).toBe('waiting')
    expect(i18n.t(v.line!)).toBe('Browser aperto')
  })

  it("browser_open in corso → «Acceso» con la frase del browser (l'host, mai l'url intero)", () => {
    const v = computerCardState(facts({ activity: { tool: 'browser_open', target: 'https://it.wikipedia.org' } }))
    expect(v.status).toBe('on')
    expect(i18n.t(v.line!)).toBe('apre it.wikipedia.org…')
  })

  it("box non ancora letto (null) → Spento finché la prima lettura non arriva", () => {
    expect(computerCardState(facts({ boxRuntime: null })).status).toBe('off')
  })
})

describe('CC3: i testi nuovi ci sono anche in EN (il catalogo allineato)', () => {
  it('In attesa / Non in uso / Browser aperto / In preparazione', () => {
    i18n.activate('en')
    expect(i18n.t(computerCardState(facts()).label)).toBe('Idle')
    expect(i18n.t(computerCardState(facts({ boxInUse: false })).label)).toBe('Not in use')
    expect(i18n.t(computerCardState(facts({ browser: 'running' })).line!)).toBe('Browser open')
    expect(i18n.t(computerCardState(facts({ boxSetupPhase: 'building-image' })).label)).toBe('Preparing')
    i18n.activate('it')
  })
})
