// P3 (fase uso-permessi): «Consenti sempre su <dominio registrabile>» — un
// permesso per DOMINIO che resta. L'utente autorizza il SITO (lefrecce.it),
// non la pagina, e il grant non scade: navigare, aprire link, cliccare
// controlli che non sono di conferma, scrivere nei campi di ricerca o filtro,
// scegliere opzioni di combobox e scorrere NON chiedono più su quel dominio e
// i suoi sottodomini — ANCHE nei turni contaminati (il lift F8 resta per tutto
// il resto: comandi, invii del modulo, altri siti, azioni di conferma).
// MAI coperte: le azioni di conferma o impegno (ask commit: invia, conferma,
// paga, acquista, prenota…), l'insieme fisso (pagamenti, credenziali,
// Cassaforte, campi probe o di dati personali) e l'uscita dal dominio.
// Rischio residuo DICHIARATO nel REPORT: una pagina ostile letta altrove può
// spingere il bot a navigare o cliccare controlli non di conferma su quel
// sito, ma non a confermare, pagare o inviare dati personali. PURO, senza store.
import { registrableDomainOf } from './seen-urls'
import type { BrowserAskInfo } from './browser-guard'

/**
 * Il tool VIRTUALE del grant di sito: una sola voce in «Impostazioni ›
 * Approvazioni» per dominio, revocabile da lì. Il target è site:<dominio
 * registrabile> (come il confine dei grant di missione di S1).
 */
export const SITE_GRANT_TOOL = 'browser-site'

/** La chiave del grant: site:<dominio registrabile>. */
export function siteGrantKey(domain: string): string {
  return `site:${domain}`
}

/**
 * Il dominio registrabile dell'URL della pagina della card (riusa
 * registrableDomainOf di T5): www.lefrecce.it → lefrecce.it,
 * biglietti.trenitalia.com → trenitalia.com. Un IP o un host senza punti
 * (127.0.0.1, localhost) è il confine stesso. NULL quando l'URL non ha un
 * confine di sito: about:blank, data:, file:, url rotta — niente grant
 * (la decisione vale «una volta»), come missionGrantTarget di S1.
 */
export function siteGrantDomainOfUrl(url: string): string | null {
  let host: string
  try {
    const u = new URL(String(url ?? ''))
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null
    host = u.hostname.toLowerCase()
  } catch {
    return null
  }
  // un IP o un host senza punti non ha un dominio registrabile: l'host è il confine
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.')) return host
  const dom = registrableDomainOf(host)
  return dom || null
}

/**
 * Quali ask del browser-guard copre il grant di sito: la navigazione e i clic
 * sui controlli NON di conferma — in pratica il ref SCADUTO (refMissing), la
 * card che tornava a ogni pagina che cambia in JavaScript («50 autorizzazioni
 * per il sito di Trenitalia»). MAI commit (conferma/impegno), submit o enter
 * (gli invii del modulo: il lift F8 resta) né probe (l'insieme fisso).
 */
export function siteGrantCoversAsk(kind: BrowserAskInfo['kind']): boolean {
  return kind === 'refMissing'
}

/**
 * La card propone «Consenti sempre su <dominio>» solo dove il grant serve:
 * la stessa copertura di siteGrantCoversAsk (su una card di conferma o di
 * invio il grant NON avrebbe tolto la prossima card: propolarlo ingannerebbe).
 */
export function siteGrantOfferable(kind: BrowserAskInfo['kind']): boolean {
  return siteGrantCoversAsk(kind)
}
