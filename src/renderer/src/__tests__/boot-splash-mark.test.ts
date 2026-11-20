// La schermata di avvio mostra l'icona di Homun (variante B), non più
// l'emoji segnaposto 🧚 che l'utente vedeva dopo ogni aggiornamento.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8')
const ICON = readFileSync(fileURLToPath(new URL('../../../../build/icon.svg', import.meta.url)), 'utf8')

describe('BootSplash: il marchio di Homun', () => {
  it('niente emoji segnaposto nella schermata di avvio', () => {
    const splash = APP.slice(APP.indexOf('function BootSplash'))
    expect(splash.slice(0, splash.indexOf('\n}\n'))).not.toContain('🧚')
  })
  it('usa la stessa geometria e gli stessi colori di build/icon.svg', () => {
    for (const frag of ['rx="185"', '#157A6E', 'x="358" y="408" width="92" height="205"', 'x="574" y="408" width="92" height="205"', '#F4F1EE']) {
      expect(ICON).toContain(frag)
      expect(APP).toContain(frag)
    }
  })
})
