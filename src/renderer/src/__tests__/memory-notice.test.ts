// Fase memoria-engramma v0.6.19 (E3): gli errori delle AZIONI sulla memoria
// si leggono. Prima salva, conferma, scarta, elimina e ripristina in
// MemoryPanel facevano `.then(after)` senza prendere il rifiuto: se il
// motore diceva di no (per esempio «an external note is born in quarantine»,
// o una memoria che non c'è più) l'interfaccia non diceva nulla — una
// promessa rifiutata senza voce. Ora ogni azione passa da run(): a riuscita
// ricarica, al rifiuto mostra la frase che arriva dal demone.
//
// La frase è del CATALOGO, già nella lingua dell'interfaccia: la scrive il
// demone dal e.code del motore (memory-rpc.ts), mai il suo messaggio inglese
// — lo provano i test del demone (errori-interfaccia.test.ts). Qui il
// componente che la disegna è PURO come l'avviso del motore (E1): negli
// altri test del renderer gli effetti non girano, così l'avviso si rende
// vero; e il collegamento delle azioni si legge nel sorgente della sezione.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHtml, parseHtml, textOf } from './render-helper'
import { MemoryNotice } from '../components/MemoryEngineNotice'

const render = (notice: Parameters<typeof MemoryNotice>[0]['notice']): string =>
  textOf(parseHtml(renderHtml(createElement(MemoryNotice, { notice }))))

describe('E3: l’avviso di un’azione sulla memoria', () => {
  it('la frase del catalogo (dal demone, nella lingua dell’interfaccia) si mostra com’è, nell’avviso dell’errore', () => {
    const html = renderHtml(createElement(MemoryNotice, { notice: { kind: 'text', text: 'Questa memoria non c’è più: l’elenco si è aggiornato.' } }))
    expect(textOf(parseHtml(html))).toBe('Questa memoria non c’è più: l’elenco si è aggiornato.')
    expect(html).toContain('text-destructive')
  })

  it('null non disegna nulla; «quasi dimenticato» e l’errore generico restano le frasi di prima', () => {
    expect(renderHtml(createElement(MemoryNotice, { notice: null }))).toBe('')
    expect(render('pending')).toBe('Quasi dimenticato: alcuni byte restano nel registro delle scritture e vengono rimossi alla prossima scrittura del motore.')
    expect(render('error')).toBe('Operazione non riuscita.')
  })

  it('la sezione Memoria disegna l’avviso con MemoryNotice, e non tiene più le frasi due volte', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'components', 'MemoryPanel.tsx'), 'utf8')
    expect(src).toContain('<MemoryNotice notice={notice} />')
    expect(src).not.toContain('Operazione non riuscita.')
    expect(src).not.toContain('Quasi dimenticato')
  })

  it('salva, conferma, scarta, elimina, ripristina e dimentica per sempre passano tutte da run( — il rifiuto si mostra, mai una promessa senza voce', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'components', 'MemoryPanel.tsx'), 'utf8')
    const calls = [...src.matchAll(/api\.memory(Save|Confirm|Discard|Delete|Restore|Purge)\(/g)]
    // sette chiamate: il ripristino sta nell'elenco (lapidi) e nel dettaglio
    expect(calls.map((c) => c[1]).sort()).toEqual(['Confirm', 'Delete', 'Discard', 'Purge', 'Restore', 'Restore', 'Save'])
    for (const c of calls) {
      // subito prima della chiamata c'è run( — l'unico modo di agire sulla memoria
      expect(src.slice(c.index! - 4, c.index!)).toBe('run(')
    }
    // e run prende il rifiuto: la frase dell'errore va nell'avviso, e si ricarica lo stesso
    const run = src.slice(src.indexOf('const run ='), src.indexOf('const save ='))
    expect(run).toMatch(/\.then\(\s*\(r\) => \{ setNotice\(null\); done\?\.\(r\); after\(\) \},\s*\(e: unknown\) => \{ setNotice\(/)
    expect(run).toContain('after()')
    // mai un'azione lanciata e abbandonata: niente «void api.memory<azione>(», niente «.then(after)» senza il rifiuto
    expect(src).not.toMatch(/void api\.memory(Save|Confirm|Discard|Delete|Restore|Purge)\(/)
    expect(src).not.toMatch(/api\.memory\w+\([^)]*\)\.then\(after\)/)
  })
})
