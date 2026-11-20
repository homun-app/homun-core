// T2 (fase web-strategia): gli errori del web dicono la CAUSA giusta — una
// riga in testa al result di browser_open/web_fetch che distingue: host
// inesistente (NXDOMAIN), pagina inesistente (404 o redirect a una pagina
// «non trovata»), blocco anti-bot, pagina di manutenzione. Dal caso vero: il
// bot concluse «Trenitalia blocca il mio computer» davanti a host che non
// risolvevano (biglietti.trenitalia.com, m.trenitalia.com) e a pagine 404,
// senza aprire mai la home vera. Le righe sono in INGLESE (testo di sistema
// per il modello, come sempre): le dice all'utente nella SUA lingua il bot.

/** Le quattro cause, come codici stabili per i meta dei tool-result. */
export type WebErrorKind = 'host-missing' | 'page-missing' | 'anti-bot' | 'maintenance'

/** Le righe in testa al result (in parole, con la mossa giusta dopo). */
export const WEB_ERROR_LINES: Record<WebErrorKind, string> = {
  'host-missing': 'This address does not exist (the site name does not resolve). It is not a block: open the site home and search from there.',
  'page-missing': 'This page does not exist on this site: go back to the home page and use the site search.',
  'anti-bot': 'The site is blocking automated access: try another source or ask the user to open it themselves (Take control).',
  maintenance: 'The site says it is under maintenance.'
}

/** Il motivo è «l'host non risolve» (anche dentro un redirect rifiutato)? (puro) */
export function isHostNotResolvedReason(reason: string): boolean {
  return /host not resolved:/i.test(reason)
}

/**
 * La pagina manca: 404, oppure l'URL FINALE è una pagina «non trovata» del
 * sito (tanti siti rispondono 200 con un redirect a /page-not-found). (puro)
 */
const NOT_FOUND_URL_RE = /(?:^|[/_.-])(?:page-not-found|pagina-non-trovata|not-found|notfound|404)(?:$|[./_-])/i

export function pageMissing(status: number, finalUrl: string): boolean {
  if (status === 404) return true
  let path = finalUrl
  try {
    path = new URL(finalUrl).pathname
  } catch {
    // non un URL: si prova sul testo com'è
  }
  return NOT_FOUND_URL_RE.test(path)
}

/** La manutenzione si dichiara nella TESTA della pagina, non in un paragrafo. */
const MAINTENANCE_RE =
  /in manutenzione|under maintenance|maintenance mode|scheduled maintenance|torneremo presto|we'?ll be back|be back soon|back shortly/i

/** La pagina è di manutenzione o cortesia? (puro: solo i primi 300 caratteri) */
export function maintenancePage(text: string): boolean {
  return MAINTENANCE_RE.test(text.replace(/\s+/g, ' ').trim().slice(0, 300))
}

/**
 * La causa giusta di un esito di web_fetch (puro): host che non risolve →
 * host-missing (NON è un blocco); blocco con firma di sfida → anti-bot; 404 o
 * pagina not-found → page-missing; manutenzione in testa → maintenance. Per
 * tutto il resto NESSUNA riga (un errore qualsiasi non è una diagnosi).
 */
export function classifyWebFetchOutcome(
  o:
    | { ok: true; text: string; finalUrl: string; status: number; contentType?: string; downloadedBytes?: number; truncated?: boolean; jsBuilt?: boolean; elapsedMs?: number }
    | { ok: false; reason: string; blocked?: boolean; unsupported?: boolean; status?: number; elapsedMs?: number }
): WebErrorKind | null {
  if (!o.ok) {
    if (isHostNotResolvedReason(o.reason)) return 'host-missing'
    if (o.blocked) return 'anti-bot'
    if (o.status === 404) return 'page-missing'
    return null
  }
  if (pageMissing(o.status, o.finalUrl)) return 'page-missing'
  if (maintenancePage(o.text)) return 'maintenance'
  return null
}

/** Gli errori di navigazione del browser che parlano del tunnel del proxy. */
const TUNNEL_ERR_RE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED/i

/** Le firme di una sfida anti-bot nella pagina (come CHALLENGE_SIGNATURES, più le IT). */
const ANTI_BOT_PAGE_RE =
  /just a moment|attention required|verify you are (?:a )?human|verifica che sei (?:umano|una persona)|unusual traffic|enable javascript and cookies to continue/i

/**
 * La causa giusta di un browser_open finito male (puro): il tunnel del proxy
 * rifiutato per DNS (il registro del proxy lo dice) → host-missing; l'URL
 * finale è una pagina not-found → page-missing; la pagina è la sfida →
 * anti-bot; la testa dice manutenzione → maintenance. Altrimenti nulla.
 */
export function classifyBrowserOpenError(a: { resultText: string; finalUrl: string; hostDnsRefused: boolean }): WebErrorKind | null {
  if (a.hostDnsRefused && TUNNEL_ERR_RE.test(a.resultText)) return 'host-missing'
  if (pageMissing(200, a.finalUrl)) return 'page-missing'
  if (ANTI_BOT_PAGE_RE.test(a.resultText.replace(/\s+/g, ' ').slice(0, 500))) return 'anti-bot'
  if (maintenancePage(a.resultText)) return 'maintenance'
  return null
}
