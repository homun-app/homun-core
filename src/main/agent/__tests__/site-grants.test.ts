// P3 (fase uso-permessi): il permesso per DOMINIO che resta — «Consenti sempre
// su lefrecce.it». Test PURI del modulo: il dominio registrabile di un URL
// (riusa registrableDomainOf di T5; un IP o un host senza punti è il confine
// stesso), la chiave del grant (site:<dominio>) e QUALI ask copre: la
// navigazione e i clic sui controlli non di conferma (refMissing, il ref
// scaduto delle pagine che cambiano in JavaScript) — MAI le azioni di conferma
// (commit), gli invii del modulo (submit/enter) né i campi non verificabili
// (probe: l'insieme fisso). Nessun DOM, nessun store.
import { describe, expect, it } from 'vitest'
import {
  SITE_GRANT_TOOL, siteGrantKey, siteGrantDomainOfUrl, siteGrantCoversAsk, siteGrantOfferable
} from '../site-grants'

describe('P3: siteGrantDomainOfUrl — il dominio registrabile dell\'URL della card', () => {
  it('www e sottodomini → il dominio registrabile (lefrecce.it, trenitalia.com)', () => {
    expect(siteGrantDomainOfUrl('https://www.lefrecce.it/Italo/RicercaTreno')).toBe('lefrecce.it')
    expect(siteGrantDomainOfUrl('https://biglietti.trenitalia.com/it/ acquista')).toBe('trenitalia.com')
    expect(siteGrantDomainOfUrl('http://viaggi.trenitalia.com')).toBe('trenitalia.com')
  })

  it('i SLD noti a tre etichette (co.uk → bbc.co.uk)', () => {
    expect(siteGrantDomainOfUrl('https://www.bbc.co.uk/news')).toBe('bbc.co.uk')
  })

  it('un IP o un host senza punti è il confine stesso (il sito finto delle sonde su 127.0.0.1)', () => {
    expect(siteGrantDomainOfUrl('http://127.0.0.1:8123/pagina')).toBe('127.0.0.1')
    expect(siteGrantDomainOfUrl('http://localhost:3000')).toBe('localhost')
  })

  it('about:blank, data:, file:, url rotta o senza host → NULL (nessun confine, niente grant)', () => {
    expect(siteGrantDomainOfUrl('about:blank')).toBeNull()
    expect(siteGrantDomainOfUrl('data:text/html,ciao')).toBeNull()
    expect(siteGrantDomainOfUrl('file:///etc/passwd')).toBeNull()
    expect(siteGrantDomainOfUrl('')).toBeNull()
    expect(siteGrantDomainOfUrl('ht!tp://[')).toBeNull()
  })
})

describe('P3: la chiave del grant e cosa copre', () => {
  it('la chiave è site:<dominio registrabile>; il tool virtuale è uno solo', () => {
    expect(SITE_GRANT_TOOL).toBe('browser-site')
    expect(siteGrantKey('lefrecce.it')).toBe('site:lefrecce.it')
  })

  it('copre la navigazione e i clic NON di conferma: il ref scaduto (refMissing) passa', () => {
    expect(siteGrantCoversAsk('refMissing')).toBe(true)
  })

  it('MAI le azioni di conferma (commit), gli invii del modulo (submit, enter) né i campi probe (insieme fisso)', () => {
    expect(siteGrantCoversAsk('commit')).toBe(false)
    expect(siteGrantCoversAsk('submit')).toBe(false)
    expect(siteGrantCoversAsk('enter')).toBe(false)
    expect(siteGrantCoversAsk('probe')).toBe(false)
  })

  it('la card propone «Consenti sempre su <dominio>» solo dove il grant serve (la stessa copertura)', () => {
    expect(siteGrantOfferable('refMissing')).toBe(true)
    expect(siteGrantOfferable('commit')).toBe(false)
    expect(siteGrantOfferable('submit')).toBe(false)
    expect(siteGrantOfferable('enter')).toBe(false)
    expect(siteGrantOfferable('probe')).toBe(false)
  })
})
