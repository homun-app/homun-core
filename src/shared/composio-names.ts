// R4 (fase app — ritocchi): i nomi delle azioni Composio nella lingua
// dell'utente, SENZA traduzioni col modello e senza rete: un verbo da tabella
// + l'oggetto da un glossario. Regola d'oro: MAI mezze traduzioni — se il
// verbo o UNA qualunque parola dell'oggetto non è in tabella si torna null e
// il chiamante usa il nome originale di Composio. In inglese si torna sempre
// null (il nome di Composio è già inglese).
//
// Modulo PURO in shared: lo usano il daemon (describeTool, lo status delle
// app collegate) e il renderer (il titolo della card d'approvazione, che si
// ri-localizza quando cambia lingua). Nessuna dipendenza: solo tabelle.
// Fase catalogo app (P7): i nomi umani degli APP arrivano dal catalogo curato
// nel repo (app-catalog/composio-catalog.json); la tabella dei comuni resta
// il ripiego per gli slug fuori catalogo.
import type { UiLanguage } from './ui-language'
import composioCatalogJson from './app-catalog/composio-catalog.json'

/** I nomi del catalogo curato, per slug (P7). */
const CATALOG_NAMES = new Map(
  (composioCatalogJson as unknown as Array<{ slug: string; name: string }>)
    .map((e) => [e.slug.toLowerCase(), e.name])
)

/** I verbi delle azioni (il PRIMO segmento dello slug), in italiano. */
const ACTION_VERBS: Readonly<Record<string, string>> = {
  send: 'Invia',
  create: 'Crea',
  update: 'Aggiorna',
  delete: 'Elimina',
  list: 'Elenca',
  get: 'Leggi',
  fetch: 'Leggi',
  read: 'Leggi',
  search: 'Cerca',
  find: 'Cerca',
  query: 'Cerca',
  add: 'Aggiungi',
  remove: 'Rimuovi',
  reply: 'Rispondi',
  forward: 'Inoltra',
  move: 'Sposta',
  archive: 'Archivia',
  upload: 'Carica',
  download: 'Scarica',
  schedule: 'Pianifica',
  invite: 'Invita',
  post: 'Pubblica',
  publish: 'Pubblica',
  share: 'Condividi',
  edit: 'Modifica',
  cancel: 'Annulla',
  close: 'Chiudi',
  open: 'Apri',
  start: 'Avvia',
  stop: 'Ferma',
  assign: 'Assegna',
  approve: 'Approva',
  reject: 'Rifiuta',
  accept: 'Accetta',
  mark: 'Contrassegna',
  set: 'Imposta',
  export: 'Esporta',
  import: 'Importa',
  rename: 'Rinomina',
  reset: 'Reimposta',
  sync: 'Sincronizza',
  duplicate: 'Duplica',
  clone: 'Clona',
  watch: 'Osserva'
}

/** Il glossario degli oggetti (i segmenti DOPO il verbo), in italiano.
 *  I plurali inglesi hanno una voce loro: la mappa deve essere esplicita. */
const ACTION_OBJECTS: Readonly<Record<string, string>> = {
  // messaggistica e posta
  message: 'messaggio', messages: 'messaggi',
  chat: 'chat',
  thread: 'conversazione', threads: 'conversazioni',
  email: 'email', emails: 'email',
  mail: 'posta',
  draft: 'bozza', drafts: 'bozze',
  reply: 'risposta', replies: 'risposte',
  comment: 'commento', comments: 'commenti',
  mention: 'menzione', mentions: 'menzioni',
  reaction: 'reazione', reactions: 'reazioni',
  channel: 'canale', channels: 'canali',
  reminder: 'promemoria', reminders: 'promemoria',
  notification: 'notifica', notifications: 'notifiche',
  attachment: 'allegato', attachments: 'allegati',
  recipient: 'destinatario', recipients: 'destinatari',
  sender: 'mittente',
  subject: 'oggetto',
  body: 'corpo',
  text: 'testo',
  // calendario e riunioni
  event: 'evento', events: 'eventi',
  calendar: 'calendario', calendars: 'calendari',
  meeting: 'riunione', meetings: 'riunioni',
  call: 'chiamata', calls: 'chiamate',
  invite: 'invito', invites: 'inviti',
  schedule: 'pianificazione',
  task: 'attività', tasks: 'attività',
  // file e documenti
  file: 'file', files: 'file',
  folder: 'cartella', folders: 'cartelle',
  document: 'documento', documents: 'documenti',
  sheet: 'foglio', sheets: 'fogli',
  spreadsheet: 'foglio di calcolo', spreadsheets: 'fogli di calcolo',
  page: 'pagina', pages: 'pagine',
  note: 'nota', notes: 'note',
  image: 'immagine', images: 'immagini',
  photo: 'foto', photos: 'foto',
  video: 'video', videos: 'video',
  link: 'link', links: 'link',
  row: 'riga', rows: 'righe',
  // gestione e CRM
  contact: 'contatto', contacts: 'contatti',
  deal: 'trattativa', deals: 'trattative',
  lead: 'lead', leads: 'lead',
  customer: 'cliente', customers: 'clienti',
  company: 'azienda', companies: 'aziende',
  user: 'utente', users: 'utenti',
  issue: 'issue', issues: 'issue',
  ticket: 'ticket', tickets: 'ticket',
  project: 'progetto', projects: 'progetti',
  board: 'bacheca', boards: 'bacheche',
  card: 'scheda', cards: 'schede',
  list: 'elenco', lists: 'elenchi',
  item: 'elemento', items: 'elementi',
  record: 'record', records: 'record',
  label: 'etichetta', labels: 'etichette',
  field: 'campo', fields: 'campi',
  form: 'modulo', forms: 'moduli',
  survey: 'sondaggio', surveys: 'sondaggi',
  section: 'sezione', sections: 'sezioni',
  status: 'stato',
  goal: 'obiettivo', goals: 'obiettivi',
  campaign: 'campagna', campaigns: 'campagne',
  segment: 'segmento', segments: 'segmenti',
  subscriber: 'iscritto', subscribers: 'iscritti',
  team: 'team', teams: 'team',
  workspace: 'workspace',
  database: 'database', databases: 'database',
  table: 'tabella', tables: 'tabelle',
  repository: 'repository',
  playlist: 'playlist', playlists: 'playlist',
  track: 'traccia', tracks: 'tracce',
  invoice: 'fattura', invoices: 'fatture',
  order: 'ordine', orders: 'ordini',
  product: 'prodotto', products: 'prodotti'
}

/** I segmenti dello slug: SEND_EMAIL → [send, email] (camelCase non esiste negli slug Composio). */
function segmentsOf(name: string): string[] {
  return name.trim().split(/[_\-.]+/).filter(Boolean).map((s) => s.toLowerCase())
}

const isVerb = (w: string): boolean => w in ACTION_VERBS

/**
 * Lo slug dell'azione SENZA prefissi: accetta il nome completo dello
 * strumento (composio__gmail__GMAIL_SEND_EMAIL) o lo slug nudo, con o senza
 * il nome del toolkit ripetuto in testa (GMAIL_SEND_EMAIL → SEND_EMAIL — si
 * toglie il primo segmento solo quando NON è un verbo e il secondo lo è).
 */
export function bareActionSlug(name: string): string {
  let s = name.trim()
  if (s.toLowerCase().startsWith('composio__')) {
    const rest = s.slice('composio__'.length)
    const sep = rest.indexOf('__')
    if (sep > 0) s = rest.slice(sep + 2)
  }
  const segs = segmentsOf(s)
  if (segs.length >= 3 && !isVerb(segs[0] ?? '') && isVerb(segs[1] ?? '')) return segs.slice(1).join('_')
  return segs.join('_')
}

/**
 * R4: il nome dell'azione nella lingua della UI, o null quando non si può
 * tradurre PER INTERO (verbo o oggetto fuori tabella, o lingua non italiana:
 * in inglese vince il nome originale di Composio). Il chiamante decide il
 * ripiego: il nome umano dei dati di Composio, o lo slug reso leggibile.
 */
export function localizedActionName(actionSlug: string, uiLang: UiLanguage): string | null {
  if (uiLang !== 'it') return null
  const segs = segmentsOf(bareActionSlug(actionSlug))
  if (segs.length < 2) return null
  const verb = ACTION_VERBS[segs[0]!]
  if (!verb) return null
  const parts: string[] = []
  for (const w of segs.slice(1)) {
    const it = ACTION_OBJECTS[w]
    if (!it) return null // mai mezze traduzioni
    parts.push(it)
  }
  return `${verb} ${parts.join(' ')}`
}

// ---- fase Composio OAuth (C5): i toolkit comuni ----
// V7 (prova vera): gli slug VERI di Composio. La tabella della faseOAuth
// aveva slug inventati («gcal», «gsheets», «calendar») e la card diceva
// «Collega Googlecalendar tramite Composio»; lo slug vero visto dal
// risultato di MANAGE_CONNECTIONS è «googlecalendar». La tabella è il
// RIPIEGO per gli slug fuori catalogo (il catalogo curato P7 ha i nomi);
// gli alias vecchi restano SOLO per leggere dati già salvati.

/** Una voce della lista dei toolkit comuni: slug, nome da mostrare. */
export interface ComposioToolkitRef {
  slug: string
  name: string
}

export const COMMON_COMPOSIO_TOOLKITS: readonly ComposioToolkitRef[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Calendar' },
  { slug: 'googledrive', name: 'Google Drive' },
  { slug: 'googlesheets', name: 'Google Sheets' },
  { slug: 'googledocs', name: 'Google Docs' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'linear', name: 'Linear' },
  { slug: 'hubspot', name: 'HubSpot' },
  { slug: 'outlook', name: 'Outlook' },
  { slug: 'microsoft_teams', name: 'Teams' },
  { slug: 'trello', name: 'Trello' },
  { slug: 'asana', name: 'Asana' },
  { slug: 'jira', name: 'Jira' },
  { slug: 'dropbox', name: 'Dropbox' },
  { slug: 'airtable', name: 'Airtable' },
  { slug: 'discord', name: 'Discord' },
  { slug: 'linkedin', name: 'LinkedIn' },
  { slug: 'youtube', name: 'YouTube' },
  { slug: 'calendly', name: 'Calendly' },
  { slug: 'zoom', name: 'Zoom' },
  { slug: 'salesforce', name: 'Salesforce' },
  { slug: 'shopify', name: 'Shopify' },
  { slug: 'stripe', name: 'Stripe' },
  { slug: 'figma', name: 'Figma' },
  { slug: 'todoist', name: 'Todoist' },
  { slug: 'clickup', name: 'ClickUp' },
  { slug: 'spotify', name: 'Spotify' },
  { slug: 'telegram', name: 'Telegram' },
  { slug: 'whatsapp', name: 'WhatsApp' },
  { slug: 'instagram', name: 'Instagram' },
  { slug: 'x_twitter', name: 'X' },
  { slug: 'zendesk', name: 'Zendesk' },
  { slug: 'intercom', name: 'Intercom' },
  { slug: 'gitlab', name: 'GitLab' }
]

/**
 * V7: gli alias della vecchia tabella inventata, tenuti SOLO per leggere
 * dati già salvati (le chiavi di composioGateway.apps e i nomi scritti
 * nelle sonde di ieri). MAI per crearne di nuovi.
 */
export const LEGACY_TOOLKIT_ALIASES: Readonly<Record<string, string>> = {
  gcal: 'googlecalendar',
  gdrive: 'googledrive',
  gsheets: 'googlesheets',
  calendar: 'googlecalendar'
}

/** V7: lo slug canonico di uno slug vecchio (gli alias diventano lo slug vero); gli altri passano. */
export function canonicalToolkitSlug(slug: string): string {
  const key = slug.trim().toLowerCase()
  return LEGACY_TOOLKIT_ALIASES[key] ?? key
}

/** Gli slug noti (toolkit comuni + i collegati): per ricavare il toolkit dallo slug di un'azione (C2). */
export function knownToolkitSlugs(extra: readonly string[] = []): string[] {
  return [...new Set([...COMMON_COMPOSIO_TOOLKITS.map((t) => t.slug), ...extra.map((s) => s.toLowerCase())])]
}

/**
 * Il nome umano di uno slug: il nome del CATALOGO CURATO nel repo (fase
 * catalogo app, P7) se c'è, altrimenti la tabella dei comuni qui accanto,
 * altrimenti la forma leggibile (K3 dei ritocchi: mai lo slug grezzo
 * all'utente — «slack» non è un nome, «x_twitter» nemmeno). «x_twitter» è in
 * tabella («X»); uno slug ignoto «foo_bar» diventa «Foo bar». V7: gli alias
 * vecchi si canonicalizzano prima («gcal» → «Google Calendar»).
 */
export function composioToolkitName(slug: string): string {
  const key = canonicalToolkitSlug(slug)
  const fromCatalog = CATALOG_NAMES.get(key)
  if (fromCatalog) return fromCatalog
  const known = COMMON_COMPOSIO_TOOLKITS.find((t) => t.slug === key)?.name
  if (known) return known
  const readable = key.replace(/[_\-.]+/g, ' ').trim()
  if (!readable) return slug
  return readable.charAt(0).toUpperCase() + readable.slice(1)
}

/**
 * Il toolkit di uno slug d'azione (A6 punto 1 / C2, qui da K6 dei ritocchi
 * perché serve anche al renderer): il prefisso più LUNGO fra gli slug noti
 * (i toolkit collegati + la tabella dei comuni), altrimenti il primo
 * segmento. GMAIL_SEND_EMAIL → gmail, MICROSOFT_TEAMS_LIST_CHANNELS →
 * microsoft_teams (se noto), CRMXYZ_PUSH_LEAD → crmxyz.
 */
export function composioToolkitOfSlug(slug: string, connectedSlugs: readonly string[] = []): string {
  const action = slug.trim().toLowerCase()
  const known = knownToolkitSlugs(connectedSlugs)
    .filter((k) => action !== k && action.startsWith(`${k}_`) && action.length > k.length + 1)
    .sort((a, b) => b.length - a.length)[0]
  if (known) return known
  return action.split('_')[0] ?? action
}

// ---- K3 (fase Composio OAuth — ritocchi): le azioni MANAGE_CONNECTIONS e
// PROXY nella lingua della UI, come localizedActionName: tabelle pure in
// shared, mai la parola del server («add», «PROXY») nella card o nella riga
// decisa. Il daemon passa la lingua della UI al gate.

/** Le azioni di COMPOSIO_MANAGE_CONNECTIONS per la card (it/en). */
export type ComposioConnectionsAction = 'add' | 'list' | 'rename' | 'remove'

const CONNECTIONS_ACTIONS_IT: Readonly<Record<ComposioConnectionsAction, string>> = {
  add: 'Collega',
  list: 'Elenca collegamenti',
  rename: 'Rinomina collegamento',
  remove: 'Scollega'
}

const CONNECTIONS_ACTIONS_EN: Readonly<Record<ComposioConnectionsAction, string>> = {
  add: 'Connect',
  list: 'List connections',
  rename: 'Rename connection',
  remove: 'Disconnect'
}

/** L'azione di una voce di toolkits[] nella lingua della UI (K3). */
export function localizedConnectionsAction(action: ComposioConnectionsAction, uiLang: UiLanguage): string {
  return (uiLang === 'en' ? CONNECTIONS_ACTIONS_EN : CONNECTIONS_ACTIONS_IT)[action]
}

/** L'azione di COMPOSIO_PROXY_EXECUTE nella lingua della UI: mai «PROXY» (K3). */
/** RW4: il percorso per il TITOLO — senza query string, tagliato con «…» oltre ~60 caratteri. */
export const PROXY_TITLE_PATH_CHARS = 60

/** RW4: il percorso di un endpoint senza query string, tagliato per il titolo. */
export function proxyPathForTitle(endpoint: string): string {
  const noQuery = endpoint.split('?')[0] ?? endpoint
  return noQuery.length > PROXY_TITLE_PATH_CHARS ? `${noQuery.slice(0, PROXY_TITLE_PATH_CHARS - 1)}…` : noQuery
}

/**
 * L'azione della richiesta diretta per la card: «Richiesta diretta GET
 * /members/me/boards». RW4: il titolo NON contiene mai l'endpoint intero —
 * niente query string, taglio con «…» oltre ~60 caratteri (l'endpoint
 * completo sta UNA volta, nel riquadro degli argomenti).
 */
export function localizedProxyRequestAction(method: string, endpoint: string, uiLang: UiLanguage): string {
  const label = uiLang === 'en' ? 'Direct request' : 'Richiesta diretta'
  return `${label} ${method} ${proxyPathForTitle(endpoint)}`.trim()
}

// ---- V9 (prova vera): le app della card del blocco ----

/**
 * I nomi (già umani) delle app di una card del blocco, uniti nella lingua
 * della UI: «Gmail e Slack» / «Gmail and Slack». VUOTO → «Composio» (una
 * voce senza nome non dice quale app: meglio il servizio che un elenco finto).
 */
export function composioAppsLabel(apps: readonly string[], uiLang: UiLanguage): string {
  const unique = [...new Set(apps.map((a) => a.trim()).filter(Boolean))]
  if (unique.length === 0) return 'Composio'
  if (unique.length === 1) return unique[0]!
  const last = uiLang === 'en' ? ' and ' : ' e '
  return `${unique.slice(0, -1).join(', ')}${last}${unique[unique.length - 1]!}`
}

// ---- K7 (fase Composio OAuth — ritocchi): da dove parte una bozza ----

/** L'app (nome umano) e l'account della via di una bozza che passa da Composio. */
export interface ComposioViaInfo {
  app: string
  account?: string
}

/**
 * K7: se la via di una bozza è il blocco di Composio (o uno strumento
 * composio__ del vecchio flusso SDK), l'app e l'account della voce da
 * mostrare nella riga «<app> tramite Composio». Null per ogni altra via:
 * la riga riguarda SOLO le superfici Composio (regola A7).
 */
export function composioViaInfo(via: { tool: string; args?: Record<string, unknown> } | null | undefined): ComposioViaInfo | null {
  if (!via) return null
  if (via.tool.startsWith('composio__')) return { app: composioToolkitName(via.tool.split('__')[1] ?? '') }
  if (via.tool.split('__').slice(2).join('__') === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const tools = via.args?.tools
    const item = Array.isArray(tools) && tools[0] && typeof tools[0] === 'object'
      ? (tools[0] as { tool_slug?: unknown; account?: unknown })
      : null
    const slug = typeof item?.tool_slug === 'string' ? item.tool_slug : ''
    const account = typeof item?.account === 'string' && item.account.trim() ? item.account.trim() : undefined
    const app = slug ? composioToolkitName(composioToolkitOfSlug(slug)) : 'Composio'
    return { app, ...(account ? { account } : {}) }
  }
  return null
}
