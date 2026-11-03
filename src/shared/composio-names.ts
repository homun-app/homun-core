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
import type { UiLanguage } from './ui-language'

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
