// T5 (fase web-strategia): la provenienza degli URL nel turno — cercare
// prima, aprire dopo, come regola del CODICE (il prompt da solo non bastava:
// il modello andava dritto a browser_open con indirizzi profondi inventati).
// Il loop tiene l'insieme degli URL e degli host VISTI nel turno — messaggi
// dell'utente, risultati di web_search, link delle pagine lette, e tutto ciò
// che entra come result (memoria, skill, pagine della Libreria) — e
// browser_open/web_fetch con un URL PROFONDO mai visto NON aprono: il result
// rimanda a web_search o alla home del sito. Libere RESTANO: la home di un
// dominio (anche mai visto: un sito nuovo si visita dalla porta), gli URL
// visti e i redirect delle pagine già aperte (l'URL finale si registra). Un
// SOTTODOMINIO mai visto dello stesso dominio NON si apre nemmeno alla home:
// è il caso di biglietti.trenitalia.com inventato. I sottoagenti ereditano
// gli URL visti dal brief del padre (il brief è il loro testo di apertura).
// È una regola di QUALITÀ, non di sicurezza: non chiede niente all'utente,
// rimette il bot sulla strada giusta. Puro, senza store.

/** La riga del rifiuto, in parole (inglese, testo di sistema). */
export const UNSEEN_URL_LINE =
  'This address does not come from anything you have seen: search it with web_search, or open the site home and use its search.'

/** Lo stato degli URL visti nel turno (opaco, vive solo nel turno). */
export interface TurnSeenUrls {
  urls: Set<string>
  hosts: Set<string>
}

/** Lo stato all'inizio del turno. */
export function createSeenUrlState(): TurnSeenUrls {
  return { urls: new Set(), hosts: new Set() }
}

/** L'URL canonico per il confronto (null se non http/https o rotto). */
export function normalizeSeenUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = ''
    // lo slash finale di un path non-radice non distingue due scritture dello stesso URL
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '')
    return u.toString()
  } catch {
    return null
  }
}

/** Gli URL http(s) citati in un testo (puliti della punteggiatura finale). */
export function urlsInText(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    out.push(m[0].replace(/[.,;:!?]+$/, ''))
  }
  return out
}

/** Registra un URL visto (con il suo host). */
export function noteSeenUrl(state: TurnSeenUrls, rawUrl: string): void {
  const n = normalizeSeenUrl(rawUrl)
  if (!n) return
  state.urls.add(n)
  try {
    state.hosts.add(new URL(n).hostname)
  } catch {
    // già validato sopra
  }
}

/** Registra TUTTI gli URL citati in un testo (messaggio utente, result, brief). */
export function noteSeenUrls(state: TurnSeenUrls, text: string): void {
  for (const u of urlsInText(text)) noteSeenUrl(state, u)
}

/**
 * La home ai fini della regola: radice, o UN SOLO segmento di lingua
 * (`/it`, `/en`, `/en-us`, con `.html`/`.htm`). Tutto il resto è profondo.
 */
export function isHomePath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return true
  if (segments.length > 1) return false
  return /^[a-z]{2}(-[a-z]{2})?(\.html?|\.htm)?$/i.test(segments[0]!)
}

/** URL profondo: path oltre la home, o una query (il path della home con query resta profondo). */
export function urlIsDeep(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    return u.search !== '' || !isHomePath(u.pathname)
  } catch {
    return true
  }
}

/** I suffissi di secondo livello che contano col loro dominio (co.uk → bbc.co.uk). */
const SECOND_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'or.jp', 'ne.jp',
  'com.br', 'com.mx', 'com.ar', 'co.in', 'co.za', 'com.tr', 'com.cn', 'com.sg', 'co.nz', 'com.pl'
])

/** Il dominio registrabile (naive: ultime due etichette, tre sui SLD noti). */
export function registrableDomainOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const last2 = labels.slice(-2).join('.')
  if (SECOND_LEVEL_TLDS.has(last2) && labels.length >= 3) return labels.slice(-3).join('.')
  return last2
}

/**
 * L'host di una HOME è libero quando: è stato visto, oppure è un dominio
 * NUOVO (nessun host visto dello stesso dominio registrabile), oppure è
 * l'APEX di un dominio di cui si è visto un host (www visto → apex sì). Un
 * SOTTODOMINIO mai visto dello stesso dominio NON è libero, nemmeno alla
 * home: è il caso degli host inventati.
 */
function homeHostAllowed(host: string, state: TurnSeenUrls): boolean {
  const h = host.toLowerCase()
  if (state.hosts.has(h)) return true
  const dom = registrableDomainOf(h)
  for (const seen of state.hosts) {
    if (registrableDomainOf(seen) === dom) return h === dom
  }
  return true
}

/**
 * La decisione (PURO): l'URL si apre quando è STATO VISTO nel turno (anche
 * profondo), oppure non è profondo e il suo host è libero (la home di un
 * dominio nuovo o visto). Altrimenti il rifiuto con la riga in parole.
 */
export function seenUrlDecision(state: TurnSeenUrls, rawUrl: string): { allow: true } | { allow: false; line: string } {
  const n = normalizeSeenUrl(rawUrl)
  if (n === null) return { allow: true } // non è un URL: le guardie di sempre dicono il resto
  if (state.urls.has(n)) return { allow: true }
  if (!urlIsDeep(n)) {
    try {
      if (homeHostAllowed(new URL(n).hostname, state)) return { allow: true }
    } catch {
      return { allow: true }
    }
  }
  return { allow: false, line: UNSEEN_URL_LINE }
}
