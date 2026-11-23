// M2 (fase 0.3.1001): la regola si rovescia — una entry `role: 'user'` CON un
// qualsiasi initiator NON è un fumetto dell'utente: è una riga di sistema
// breve (routine, giro al rientro, risvegli) col testo del modello chiuso nei
// dettagli. Tabella per OGNI initiator + undefined, e lo snapshot del modello
// della riga (la mappa id/valori che il componente Chat rende).
import { describe, expect, it } from 'vitest'
import { i18n } from '@lingui/core'
import { readFileSync } from 'node:fs'
import { openingRowFor, routineTitleOf } from '../lib/opening-rows'
import type { TranscriptEntry } from '../../../shared/types'
import { itCatalogEntries } from './po-helper'

// come la sidebar: le etichette si risolvono dal catalogo it (i msgid nuovi
// ricadono su se stessi — la lingua sorgente è l'italiano)
i18n.load('it', itCatalogEntries())
i18n.activate('it')

const entry = (meta: Record<string, unknown> | null | undefined): Pick<TranscriptEntry, 'role' | 'meta'> =>
  ({ role: 'user', meta: meta ?? null })

/** Il nome dell'icona lucide di una riga di sistema (B2: niente più emoji). */
const iconName = (icon: unknown): string => (icon as { displayName?: string } | undefined)?.displayName ?? '(nessuna icona)'

/** Il «come si rende»: kind + nome dell'icona + testo dell'etichetta nella lingua attiva (it). */
function rendered(meta: Record<string, unknown> | null): Record<string, unknown> {
  const row = openingRowFor(entry(meta))
  if (row.kind === 'system') return { kind: 'system', icon: iconName(row.icon), label: i18n.t(row.label) }
  return { kind: row.kind, ...(row.kind === 'details' ? { template: row.template } : {}) }
}

describe('M2: openingRowFor — tabella per initiator', () => {
  it('undefined (o vuoto) → fumetto dell’utente', () => {
    expect(openingRowFor(entry(undefined)).kind).toBe('user')
    expect(openingRowFor(entry(null)).kind).toBe('user')
    expect(openingRowFor(entry({ initiator: '' })).kind).toBe('user')
    expect(openingRowFor(entry({ routineTitle: 'X' })).kind).toBe('user') // solo il titolo non basta
  })

  it('ROUTINE → riga di sistema col titolo; senza titolo resta «Routine»', () => {
    expect(rendered({ initiator: 'ROUTINE', routineTitle: 'Backup' })).toEqual({
      kind: 'system', icon: 'Timer', label: 'Routine «Backup»'
    })
    expect(rendered({ initiator: 'ROUTINE' })).toEqual({ kind: 'system', icon: 'Timer', label: 'Routine' })
  })

  it('LOOK_AROUND → «Al tuo rientro»', () => {
    expect(rendered({ initiator: 'LOOK_AROUND' })).toEqual({ kind: 'system', icon: 'Hand', label: 'Al tuo rientro' })
  })

  // B2 (fase b20-bug): ⚙ era un'emoji — le icone delle righe di sistema sono
  // lucide (regola: mai emoji nell'interfaccia)
  it('B2: PLUGIN_ENABLED_RESUME → «Plugin attivato — riprendo» con l’icona lucide Zap', () => {
    expect(rendered({ initiator: 'PLUGIN_ENABLED_RESUME' })).toEqual({ kind: 'system', icon: 'Zap', label: 'Plugin attivato — riprendo' })
  })

  it('B2: il turno rifatto da «Riprova» (retryOf, senza initiator: un messaggio della chat) è una riga di sistema «Riprovo», mai una seconda bolla dell’utente', () => {
    expect(rendered({ retryOf: 44 })).toEqual({ kind: 'system', icon: 'RotateCcw', label: 'Riprovo' })
    // un turno automatico rifatto resta la SUA riga (è ancora un avvio automatico)
    expect(rendered({ retryOf: 44, initiator: 'SHELL_DONE' })).toEqual({ kind: 'system', icon: 'Cog', label: 'Avvio automatico' })
  })

  it('AGENT / TEMPLATE_IMPORT / TASK_DONE → i rendering di prima, mai fumetto utente', () => {
    expect(openingRowFor(entry({ initiator: 'AGENT' })).kind).toBe('agent')
    expect(openingRowFor(entry({ initiator: 'TEMPLATE_IMPORT' }))).toEqual({ kind: 'details', template: true })
    expect(openingRowFor(entry({ initiator: 'TASK_DONE' }))).toEqual({ kind: 'details', template: false })
  })

  it('gli altri initiator (risvegli di sistema) → etichetta generica «Avvio automatico»', () => {
    for (const initiator of ['GROUP_TURN', 'SHELL_DONE', 'SUBAGENTS_DONE', 'CONNECTOR_CONNECTED', 'ALTRO']) {
      expect(rendered({ initiator })).toEqual({ kind: 'system', icon: 'Cog', label: 'Avvio automatico' })
    }
  })

  it('routineTitleOf: solo stringhe non vuote', () => {
    expect(routineTitleOf({ routineTitle: 'Backup' })).toBe('Backup')
    expect(routineTitleOf({ routineTitle: '  ' })).toBeUndefined()
    expect(routineTitleOf(null)).toBeUndefined()
  })

  // lo snapshot del componente: la mappa completa initiator → riga resa, in
  // italiano (il repo non ha infrastruttura DOM di test: il modello della
  // riga è ciò che Chat.tsx rende punto per punto)
  it('snapshot: ogni initiator → la riga resa', () => {
    const table = [
      'ROUTINE', 'LOOK_AROUND', 'AGENT', 'TEMPLATE_IMPORT', 'TASK_DONE',
      'GROUP_TURN', 'SHELL_DONE', 'SUBAGENTS_DONE', 'CONNECTOR_CONNECTED',
      'PLUGIN_ENABLED_RESUME', '(Riprovo: retryOf)'
    ].map((initiator) => ({ initiator, row: rendered(initiator === '(Riprovo: retryOf)' ? { retryOf: 9 } : { initiator, ...(initiator === 'ROUTINE' ? { routineTitle: 'Backup' } : {}) }) }))
    table.push({ initiator: '(nessuno)', row: rendered(null) })
    expect(table).toMatchInlineSnapshot(`
      [
        {
          "initiator": "ROUTINE",
          "row": {
            "icon": "Timer",
            "kind": "system",
            "label": "Routine «Backup»",
          },
        },
        {
          "initiator": "LOOK_AROUND",
          "row": {
            "icon": "Hand",
            "kind": "system",
            "label": "Al tuo rientro",
          },
        },
        {
          "initiator": "AGENT",
          "row": {
            "kind": "agent",
          },
        },
        {
          "initiator": "TEMPLATE_IMPORT",
          "row": {
            "kind": "details",
            "template": true,
          },
        },
        {
          "initiator": "TASK_DONE",
          "row": {
            "kind": "details",
            "template": false,
          },
        },
        {
          "initiator": "GROUP_TURN",
          "row": {
            "icon": "Cog",
            "kind": "system",
            "label": "Avvio automatico",
          },
        },
        {
          "initiator": "SHELL_DONE",
          "row": {
            "icon": "Cog",
            "kind": "system",
            "label": "Avvio automatico",
          },
        },
        {
          "initiator": "SUBAGENTS_DONE",
          "row": {
            "icon": "Cog",
            "kind": "system",
            "label": "Avvio automatico",
          },
        },
        {
          "initiator": "CONNECTOR_CONNECTED",
          "row": {
            "icon": "Cog",
            "kind": "system",
            "label": "Avvio automatico",
          },
        },
        {
          "initiator": "PLUGIN_ENABLED_RESUME",
          "row": {
            "icon": "Zap",
            "kind": "system",
            "label": "Plugin attivato — riprendo",
          },
        },
        {
          "initiator": "(Riprovo: retryOf)",
          "row": {
            "icon": "RotateCcw",
            "kind": "system",
            "label": "Riprovo",
          },
        },
        {
          "initiator": "(nessuno)",
          "row": {
            "kind": "user",
          },
        },
      ]
    `)
  })
})

describe('B2 (fase beta.4): il prompt della presentazione è NASCOSTO', () => {
  it('BOT_INTRO → nessuna riga in chat (né bolla, né dettagli: non compare)', () => {
    expect(openingRowFor(entry({ initiator: 'BOT_INTRO' })).kind).toBe('hidden')
  })
})

// ---- B2 (fase b20-bug): mai emoji nell'interfaccia ----
describe('B2: le righe di apertura hanno icone lucide, mai emoji', () => {
  const source = readFileSync(new URL('../lib/opening-rows.ts', import.meta.url), 'utf8')
  it('in opening-rows.ts non c’è nessuna emoji (le icone sono componenti lucide)', () => {
    // intervalli dei pittogrammi e dei simboli emoji (non toccano «—», ««», «…»)
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u
    expect(emoji.test(source)).toBe(false)
  })
  it('ogni riga di sistema porta un COMPONENTE lucide (non una stringa)', () => {
    for (const meta of [{ initiator: 'ROUTINE' }, { initiator: 'LOOK_AROUND' }, { initiator: 'PLUGIN_ENABLED_RESUME' }, { initiator: 'SHELL_DONE' }, { retryOf: 3 }]) {
      const row = openingRowFor(entry(meta))
      expect(row.kind).toBe('system')
      if (row.kind !== 'system') continue
      // un componente React (l'oggetto forwardRef di lucide), con il suo nome
      expect(typeof row.icon).not.toBe('string')
      expect((row.icon as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.forward_ref'))
      expect((row.icon as unknown as { displayName?: string }).displayName).toMatch(/^(Timer|Hand|Zap|Cog|RotateCcw)$/)
    }
  })
})
