// T5 (fase web-strategia): cercare prima, aprire dopo — la provenienza degli
// URL nel turno è una regola del CODICE. Il loop tiene l'insieme degli URL e
// degli host VISTI nel turno (messaggi dell'utente, risultati di web_search,
// link delle pagine lette, memoria/skill/pagine della Libreria che entrano
// come result); browser_open e web_fetch con un URL PROFONDO mai visto NON
// aprono e rimandano a web_search o alla home. La home di un dominio resta
// sempre libera; un SOTTODOMINIO mai visto dello stesso dominio no (il caso
// di biglietti.trenitalia.com inventato). I sottoagenti ereditano gli URL
// visti dal brief del padre.
import { describe, expect, it } from 'vitest'
import {
  createSeenUrlState, noteSeenUrls, noteSeenUrl, urlsInText, isHomePath, urlIsDeep,
  registrableDomainOf, seenUrlDecision, UNSEEN_URL_LINE
} from '../seen-urls'

describe('T5: i puri della provenienza', () => {
  it('isHomePath: radice o UN segmento di lingua (con .html)', () => {
    for (const p of ['/', '', '/it', '/en', '/it.html', '/en-us', '/it.htm']) expect(isHomePath(p), p).toBe(true)
    for (const p of ['/menu', '/it/acquista', '/it/acquista/cerca-soluzioni', '/pagina-home/prodotti', '/a/b']) expect(isHomePath(p), p).toBe(false)
  })

  it('urlIsDeep: query → profondo; path profondo → profondo; home → no', () => {
    expect(urlIsDeep('https://www.trenitalia.com/it/acquista/cerca-soluzioni')).toBe(true)
    expect(urlIsDeep('https://x.example/search?q=treni')).toBe(true)
    expect(urlIsDeep('https://www.trenitalia.com/it.html')).toBe(false)
    expect(urlIsDeep('https://www.trenitalia.com/')).toBe(false)
  })

  it('registrableDomainOf: ultime due etichette, i SLD noti a tre', () => {
    expect(registrableDomainOf('www.trenitalia.com')).toBe('trenitalia.com')
    expect(registrableDomainOf('biglietti.trenitalia.com')).toBe('trenitalia.com')
    expect(registrableDomainOf('trenitalia.com')).toBe('trenitalia.com')
    expect(registrableDomainOf('news.bbc.co.uk')).toBe('bbc.co.uk')
  })

  it('urlsInText: gli URL http(s) del testo, ripuliti della punteggiatura', () => {
    const text = 'guarda https://www.trenitalia.com/it.html e anche https://e656.net/orari?t=1, poi (https://kombo.example/it) fine'
    const urls = urlsInText(text)
    expect(urls).toContain('https://www.trenitalia.com/it.html')
    expect(urls).toContain('https://e656.net/orari?t=1')
    expect(urls).toContain('https://kombo.example/it')
  })

  it('noteSeenUrls: il testo del turno (messaggi, result, brief) semina URL e host', () => {
    const s = createSeenUrlState()
    noteSeenUrls(s, 'ho letto https://www.trenitalia.com/it.html e https://e656.net/orari')
    expect(seenUrlDecision(s, 'https://www.trenitalia.com/it.html').allow).toBe(true)
    expect(seenUrlDecision(s, 'https://e656.net/orari').allow).toBe(true)
  })
})

describe('T5: seenUrlDecision — profondo mai visto rifiutato, il resto libero', () => {
  it('URL PROFONDO mai visto → rifiutato (il motivo in parole)', () => {
    const s = createSeenUrlState()
    const d = seenUrlDecision(s, 'https://www.trenitalia.com/it/acquista/cerca-soluzioni')
    expect(d.allow).toBe(false)
    expect(UNSEEN_URL_LINE).toMatch(/web_search/)
    expect(UNSEEN_URL_LINE).toMatch(/home/i)
  })

  it('la HOME di un dominio MAI VISTO si apre (un sito nuovo si visita dalla porta)', () => {
    const s = createSeenUrlState()
    expect(seenUrlDecision(s, 'https://www.trenitalia.com/').allow).toBe(true)
    expect(seenUrlDecision(s, 'https://www.trenitalia.com/it.html').allow).toBe(true)
  })

  it('l\'URL profondo VISTO nel turno si apre (risultato di ricerca, link di pagina, messaggio)', () => {
    const s = createSeenUrlState()
    noteSeenUrl(s, 'https://www.trenitalia.com/it/acquista/cerca-soluzioni')
    expect(seenUrlDecision(s, 'https://www.trenitalia.com/it/acquista/cerca-soluzioni').allow).toBe(true)
  })

  it('il SOTTODOMINIO mai visto dello stesso dominio NON si apre, nemmeno alla home', () => {
    const s = createSeenUrlState()
    noteSeenUrl(s, 'https://www.trenitalia.com/it.html')
    expect(seenUrlDecision(s, 'https://biglietti.trenitalia.com/').allow).toBe(false)
    expect(seenUrlDecision(s, 'https://m.trenitalia.com/').allow).toBe(false)
  })

  it('l\'APEX si apre quando si è visto il www (è lo stesso dominio principale); il www NUOVO quando si è visto l\'apex NO', () => {
    const s = createSeenUrlState()
    noteSeenUrl(s, 'https://www.trenitalia.com/it.html')
    expect(seenUrlDecision(s, 'https://trenitalia.com/').allow).toBe(true)
    const s2 = createSeenUrlState()
    noteSeenUrl(s2, 'https://trenitalia.com/')
    expect(seenUrlDecision(s2, 'https://www.trenitalia.com/').allow).toBe(false)
    expect(seenUrlDecision(s2, 'https://altrosito.example/').allow).toBe(true)
  })

  it('un URL profondo di un ALTRO dominio mai visto resta rifiutato (prima la ricerca o la home)', () => {
    const s = createSeenUrlState()
    noteSeenUrl(s, 'https://www.trenitalia.com/it.html')
    expect(seenUrlDecision(s, 'https://e656.net/orari/milano-roma').allow).toBe(false)
  })
})
