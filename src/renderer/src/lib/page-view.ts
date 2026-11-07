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
 * (si saltano le righe vuote, le immagini e i titoli); l'indice sono i
 * titoli ## e ### in ordine. Pura: stesso Markdown → stesso risultato.
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
    paragraph.push(line.trim())
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
