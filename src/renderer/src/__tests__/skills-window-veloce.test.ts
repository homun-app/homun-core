// Fase SFOGLIA VELOCE (V1): la finestra Skill apre il catalogo SENZA retry
// (la cache scaduta si aggiorna in sottofondo), la prima lettura mostra
// «Cerco i pacchetti…» col conteggio dell'avanzamento e gli eventi del daemon
// (skills:browse-progress, skills:browse-updated) aggiungono la lista nuova.
// Senza DOM (niente jsdom): si legge il sorgente, come le altre guardie del
// renderer; il comportamento VERO lo verifica la sonda
// scripts/fase-skill-sfoglia-probe.mjs sul DOM.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WINDOW = fileURLToPath(new URL('../components/SkillsWindow.tsx', import.meta.url))
const src = readFileSync(WINDOW, 'utf8')

/** Il blocco di un componente interno (dalla `function Nome` al successivo). */
function block(name: string): string {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`componente ${name} non trovato in SkillsWindow.tsx`)
  const next = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, next > 0 ? next : undefined)
}

describe('V1: all\'apertura NESSUN retry — il clone non si rifà a ogni finestra', () => {
  it('il mount chiama skillsBrowse SENZA retry: loadBrowse(true) è sparito, il retry resta al solo bottone «Riprova»', () => {
    // il base apriva FRESCO a OGNI apertura (loadBrowse(true) al mount →
    // retry: true → clone rifatto): non più
    expect(src).not.toContain('loadBrowse(true)')
    const at = src.indexOf('useEffect(() => { loadBrowse')
    expect(at).toBeGreaterThan(0)
    const effect = src.slice(at, src.indexOf('}', src.indexOf(')', at + 30)))
    expect(effect).toContain('browseRetryAt > 0')
  })

  it('la RPC al daemon passa retry SOLO quando chiesto (undefined all\'apertura)', () => {
    expect(src).toContain(`api.skillsBrowse('', retry ? { retry: true } : undefined)`)
  })

  it('il bottone «Riprova» continua a esserci e a cambiare browseRetryAt', () => {
    expect(src).toContain('data-testid="skills-browse-retry"')
    expect(src).toMatch(/setBrowseRetryAt\(Date\.now\(\)\)/)
  })
})

describe('V1: la prima lettura mostra l\'avanzamento, niente spinner muto', () => {
  it('«Cerco i pacchetti…» col conteggio «N di M plugin letti» (testid skills-browse-progress)', () => {
    const at = src.indexOf('skills-browse-loading')
    expect(at).toBeGreaterThan(0)
    const loading = src.slice(at - 200, at + 900)
    expect(loading).toContain('skills-browse-progress')
    expect(src).toContain('<Trans>Cerco i pacchetti…</Trans>')
    expect(src).toMatch(/plugin letti/)
  })

  it('lo stato dell\'avanzamento esiste e si azzera a ogni lettura', () => {
    expect(src).toMatch(/browseProgress/)
    expect(src).toMatch(/setBrowseProgress\(null\)/)
  })
})

describe('V1: la finestra ascolta gli eventi del daemon', () => {
  it('api.onEvent: skills:browse-progress aggiorna il conteggio, skills:browse-updated ricarica la lista', () => {
    const win = block('SkillsWindow')
    expect(win).toContain('api.onEvent')
    const at = win.indexOf('api.onEvent')
    const handler = win.slice(at, at + 700)
    expect(handler).toContain('skills:browse-progress')
    expect(handler).toContain('skills:browse-updated')
    // la lista si ricarica (in silenzio: niente spinner sopra la lista già visibile)
    expect(handler).toMatch(/loadBrowse\(/)
  })
})
