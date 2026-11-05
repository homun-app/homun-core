// Fase skill (S10.1): la guardia del salvataggio delle impostazioni Avanzate.
// «Look-around al rientro» e «Pausa delle routine» aggiornavano SOLO lo stato
// locale: mancava settingsSet, quindi al riavvio tornavano i valori di prima.
// Il test cerca nel sorgente di Settings.tsx che i due NumberField di Avanzate
// chiamino api.settingsSet con la chiave giusta — sul codice di oggi
// (onChange={setMinAwayHours}) FAILISCE, col fix PASSA. Stile delle guardie
// sul sorgente di fase 17a (unwrapped-text-guard): @babel/parser, non l'API
// TS (il repo ha TypeScript 7 nativo).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const SETTINGS_TSX = fileURLToPath(new URL('../components/Settings.tsx', import.meta.url))

/**
 * Il sorgente dell'attributo onChange di ogni NumberField la cui aria-label
 * contiene `label`. Cammina l'AST; l'aria-label e\u0300 un'espressione (t`…`),
 * quindi si guarda la FETTIA di sorgente degli attributi, non il valore.
 */
function numberFieldOnChange(source: string, label: string): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] })
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.type === 'JSXOpeningElement') {
      const name = n.name as { name?: string } | undefined
      if (name?.name === 'NumberField') {
        const attrs = (n.attributes ?? []) as Array<{ name?: { name?: string }; start?: number; end?: number }>
        const chunk = attrs.map((a) => source.slice(a.start ?? 0, a.end ?? 0)).join(' ')
        if (chunk.includes(label)) {
          const onChange = attrs.find((a) => a.name?.name === 'onChange')
          found.push(onChange ? source.slice(onChange.start ?? 0, onChange.end ?? 0) : '(nessun onChange)')
        }
      }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object' && (v as { type?: string }).type) visit(v)
    }
  }
  visit(ast)
  return found
}

describe('S10.1: le impostazioni Avanzate si SALVANO (guardia sul sorgente)', () => {
  const source = readFileSync(SETTINGS_TSX, 'utf8')

  it('il campo «Look-around al rientro» chiama api.settingsSet(\'minAwayHours\', …)', () => {
    const handlers = numberFieldOnChange(source, 'Look-around al rientro')
    expect(handlers.length).toBeGreaterThan(0)
    expect(handlers[0]).toContain("api.settingsSet('minAwayHours'")
  })

  it('il campo «Pausa delle routine» chiama api.settingsSet(\'awayPauseDays\', …)', () => {
    const handlers = numberFieldOnChange(source, 'Pausa delle routine')
    expect(handlers.length).toBeGreaterThan(0)
    expect(handlers[0]).toContain("api.settingsSet('awayPauseDays'")
  })
})
