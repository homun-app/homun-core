// Fase pagine (G1/G2): le funzioni PURE della pagina — l'anteprima della card
// in chat (pagePreview: titolo dal #, intro saltando righe vuote e immagini,
// SOLO i titoli ##/###) e l'indice del documento (pageHeadings: id stabili
// dal testo dei titoli, suffisso sui doppi, niente titoli dentro i blocchi
// di codice). Nessun componente qui: servono alla card, alla pagina aperta e
// ai test.
// Fase pagine · ritocchi (P2): pageBody — il corpo da rendere nella pagina
// aperta, dove il primo `# ` uguale al titolo NON si riduplica (il titolo lo
// mostra già la pagina con la sua riga dedicata).

export interface PagePreview {
  /** il titolo dal primo `# ` (null se non c'è) */
  title: string | null
  /** il primo paragrafo di testo (null nel documento vuoto) */
  intro: string | null
  /** i titoli ## e ### in ordine, senza prefisso */
  headings: string[]
}

/** La riga è vuota (solo spazi)? */
const isBlank = (line: string): boolean => !line.trim()

/** La riga è un'immagine Markdown (`![alt](…)`, anche su più righe no: qui basta l'inizio)? */
const isImage = (line: string): boolean => /^\s*!\[[^\]]*\]\([^)]*\)/.test(line)

/**
 * R2 (fase ritocchi-beta18): il TESTO di una riga di Markdown per
 * l'anteprima — la funzione UNICA delle card della Libreria (pagePreview) e
 * della vista a elenco. Trasforma `[testo](url)` in `testo` e le immagini in
 * niente; toglie corsivo e grassetto SOLO come marcatori di inizio e fine
 * parola, mai un `_` dentro una parola (`lib_x`, `snake_case` restano
 * intatti); i marcatori di riga (titolo, lista, citazione) e i backtick del
 * codice inline spariscono. Pura.
 */
export function previewLineText(line: string): string {
  let s = line.trim()
  // le immagini spariscono; i link diventano il loro testo
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // i marcatori di riga: titolo, lista, citazione
  s = s.replace(/^(?:>+\s*|#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, '')
  // corsivo e grassetto SOLO a confini di parola: il marcatore non è mai
  // attaccato a una parola da un lato e staccato dall'altro — un `_` DENTRO
  // una parola (lib_x, snake_case) non è un marcatore e resta
  s = s.replace(/(?<![A-Za-z0-9_`])\*\*(\S(?:[\s\S]*?\S)?)\*\*(?![A-Za-z0-9_`])/g, '$1')
  s = s.replace(/(?<![A-Za-z0-9_`])\*(\S(?:[\s\S]*?\S)?)\*(?![A-Za-z0-9_`])/g, '$1')
  s = s.replace(/(?<![A-Za-z0-9_`])_(\S(?:[\s\S]*?\S)?)_(?![A-Za-z0-9_`])/g, '$1')
  // codice inline: i backtick spariscono (come faceva la vista a elenco)
  s = s.replace(/`([^`]*)`/g, '$1')
  return s.trim()
}

/** Il testo di un titolo senza i # e spazi/adiacenti (#). */
const headingText = (line: string): string => line.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()

/** Siamo DENTRO un blocco di codice? (si alterna a ogni ``` di apertura/chiusura). */
const inFence = (lines: string[]): boolean => {
  let fence = false
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
  }
  return fence
}

/**
 * G1: l'anteprima della card della pagina, dal Markdown della versione
 * corrente. Il titolo è il primo `# `; l'intro è il primo paragrafo utile
 * (si saltano le righe vuote, le immagini e i titoli; il testo è quello di
 * previewLineText, mai il markdown grezzo — R2); l'indice sono i titoli ##
 * e ### in ordine. Pura: stesso Markdown → stesso risultato.
 */
export function pagePreview(markdown: string): PagePreview {
  const lines = markdown.split('\n')
  let title: string | null = null
  let intro: string | null = null
  const headings: string[] = []
  let fence = false
  let introDone = false
  let paragraph: string[] = []
  const flush = (): void => {
    if (!introDone && paragraph.length) {
      intro = paragraph.join(' ')
      introDone = true
    }
    paragraph = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      flush()
      continue
    }
    if (fence) continue
    if (isBlank(line)) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      if (!title && h[1] === '#') title = headingText(line)
      else if (h[1] === '##' || h[1] === '###') headings.push(headingText(line))
      continue
    }
    if (isImage(line)) continue
    // R2: il testo dell'anteprima, non il markdown (link e immagini
    // compresi); una riga che diventa vuota (solo immagini inline) non conta
    const txt = previewLineText(line)
    if (txt) paragraph.push(txt)
  }
  flush()
  return { title, intro, headings }
}

export interface PageHeading {
  /** 2 per ##, 3 per ### */
  level: 2 | 3
  text: string
  /** id stabile per l'ancora (minuscolo, trattini, suffisso sui doppi) */
  id: string
}

/** Accenti e lettere accentate → base (Perché → perche), per id stabili. */
const deaccent = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** L'id di un titolo: minuscolo, senza accenti, i non-alfanumerici become trattini. */
export function headingIdOf(text: string, used: Set<string>): string {
  const base = deaccent(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sezione'
  let id = base
  let n = 2
  while (used.has(id)) id = `${base}-${n++}`
  used.add(id)
  return id
}

/**
 * G2: l'indice della pagina — i titoli ## e ### con id stabili per le ancore
 * (i doppi prendono un suffisso -2, -3…). I titoli dentro i blocchi di
 * codice non contano. Pura.
 */
export function pageHeadings(markdown: string): PageHeading[] {
  const out: PageHeading[] = []
  const used = new Set<string>()
  let fence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const h = /^(##|###)\s+(.*)$/.exec(line)
    if (h) {
      const text = headingText(line)
      out.push({ level: h[1] === '##' ? 2 : 3, text, id: headingIdOf(text, used) })
    }
  }
  return out
}

/**
 * P2: il confronto fra il titolo della pagina e il testo di un `# ` —
 * maiuscole, spazi e punteggiatura in coda NON contano.
 */
function samePageTitle(headingTextOfLine: string, title: string): boolean {
  const norm = (s: string): string =>
    s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/\p{P}+$/u, '').trim()
  return norm(headingTextOfLine) === norm(title)
}

/**
 * P2: il corpo da rendere nella pagina aperta. Se la PRIMA riga non vuota
 * del Markdown è un `# ` il cui testo coincide col titolo della pagina
 * (maiuscole, spazi e punteggiatura in coda non contano), quella riga NON si
 * rende nel corpo: il titolo lo mostra già la pagina, non serve due volte.
 * Un `# ` diverso, più in basso o dentro un blocco di codice resta. L'indice
 * e gli id dei titoli non cambiano (qui si toglie solo un `# `, che
 * nell'indice non c'è mai). Pura.
 */
export function pageBody(markdown: string, title: string): string {
  const lines = markdown.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(```|~~~)/.test(line)) return markdown // si entra in un blocco di codice: il primo «titolo» sarebbe codice
    if (!line.trim()) continue
    const h = /^#\s+(.*)$/.exec(line)
    if (h && samePageTitle(h[1] ?? '', title)) {
      lines.splice(i, 1)
      return lines.join('\n')
    }
    return markdown // la prima riga non vuota non è il titolo: tutto resta
  }
  return markdown
}
