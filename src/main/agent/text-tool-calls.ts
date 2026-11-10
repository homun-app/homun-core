// Fase locale (L1): il recupero delle chiamate ai tool scritte come TESTO
// grezzo. Con llama-server (e qualunque server OpenAI-compatible con --jinja)
// a volte una chiamata GIUSTA non viene riconosciuta dal parser del template
// e arriva nel testo della risposta; nei dump L1 (Qwen 2 casi, LFM3 6: i
// casi 17, 21, 23, 29, 32, 33, 34 e 45) il formato è sempre lo stesso:
//
//   <tool_call>
//   <function=find_tools>
//   <parameter=group>
//   browser
//   </parameter>
//   </function>
//   </tool_call>
//
// Motivo probabile del mancato parse in llama-server (L1.5): il template
// chat template cerca i tool call nei CONTENT STOPreason='tool_calls' del
// generatore; quando il modello emette ANCHE una riga di testo prima del
// blocco (o due blocchi di fila) la grammatica/regex del template di
// llama-server non riconosce la sequenza come tool call e i token restano
// testo. Il recupero qui sotto copre OGNI versione del server perché lavora
// sulla risposta FINITA, non sullo streaming del template.
//
// Fase locale correzioni 3 (LE1): tutto gira su UN SOLO lexer da sinistra a
// destra (lexToolCallText). Le zone protette di LC3/LD3 si calcolavano su
// tutto il testo, ANCHE dentro i blocchi veri: un backtick o un recinto in
// un <parameter> spezzava il blocco e la chiamata si perdeva (comandi di
// shell e file markdown: i casi più comuni in assoluto). Ora un <tool_call>
// consuma il blocco INTERO qualunque cosa contenga.
//
// Tutto PURO: nessuno store, nessuna rete. Le chiamate recuperate seguono la
// STESSA strada delle native (srotolamento facciate, coercizione, argGuard,
// attivazione per nome, permessi): qui si producono solo {name, arguments}.
export interface ParsedTextToolCall {
  name: string
  /** argomenti serializzati in JSON, come le chiamate native */
  arguments: string
}

export interface TextToolCallParse {
  calls: ParsedTextToolCall[]
  /** il testo rimasto fuori dai blocchi RICONOSCIUTI (i blocchi con nome
   *  sconosciuto o malformati restano al loro posto) */
  text: string
}

/**
 * LD3 (ora nel lexer lexToolCallText): il corpo di un blocco non può
 * contenere un altro `<tool_call>` — il tempered token della vecchia regex
 * `[ \t]*<tool_call>\s*((?:(?!<tool_call>)[\s\S])*?)<\/tool_call>[ \t]*\n?`
 * — così una menzione spaiata non si aggancia alla chiusura del blocco VERO
 * che viene dopo. Nel lexer è la condizione `close < nextOpen`.
 */

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'

/** Un segmento di testo PROTETTO: un recinto di codice o uno span inline. */
export interface ToolCallProtectedSegment {
  kind: 'protected'
  start: number
  end: number
}

/**
 * Un segmento BLOCCO: un `<tool_call>` consumato per intero. `closed` dice
 * se ha la sua `</tool_call>` (col corpo senza altre `<tool_call>`, il
 * tempered token di LD3) o è APERTO in coda al testo.
 */
export interface ToolCallBlockSegment {
  kind: 'block'
  start: number
  end: number
  closed: boolean
}

export type ToolCallTextSegment = ToolCallProtectedSegment | ToolCallBlockSegment

/**
 * La fine di un recinto aperto in `open` (run contato fino a `runEnd`): la
 * fine della riga di CHIUSURA (una riga che è SOLO il recinto dello stesso
 * carattere), o la fine del testo se mai chiuso. La riga d'apertura può
 * portare una info string (```bash).
 */
function fenceEndAt(text: string, ch: string, runEnd: number): number {
  const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{3,}[ \\t]*$`)
  const n = text.length
  const nl = text.indexOf('\n', runEnd) // fine della riga d'apertura
  if (nl === -1) return n
  let j = nl + 1
  while (j <= n) {
    const nl2 = text.indexOf('\n', j)
    const end2 = nl2 === -1 ? n : nl2
    if (closeRe.test(text.slice(j, end2))) return end2
    if (nl2 === -1) return n
    j = nl2 + 1
  }
  return n
}

/**
 * LE1: il LESSORE — UN SOLO passaggio da sinistra a destra. In ogni punto
 * FUORI da un blocco si guarda quale costrutto COMINCIA PER PRIMO:
 *  - un recinto (``` / ~~~ a inizio riga, fino a 3 spazi) o uno span di
 *    codice inline (run di N backtick chiuso dal prossimo run di ESATTAMENTE
 *    N backtick sulla stessa riga): si salta fino alla chiusura → segmento
 *    PROTETTO («ecco il formato»);
 *  - un `<tool_call>`: si consuma il blocco INTERO — chiuso col tempered
 *    token di LD3 oppure APERTO in coda (l'ULTIMO `<tool_call>` del testo) —
 *    QUALUNQUE cosa contenga: backtick e recinti DENTRO un blocco sono
 *    ARGOMENTI, non zone protette (la regressione LD3 nasceva dalle zone
 *    protette calcolate anche dentro i blocchi veri).
 * Recupero, pulizia e hasRawToolCallBlocks usano TUTTI questo lexer: non
 * possono divergere.
 */
export function lexToolCallText(text: string): ToolCallTextSegment[] {
  const segs: ToolCallTextSegment[] = []
  const n = text.length
  let i = 0
  let lineStart = 0
  while (i < n) {
    const ch = text[i]!
    // il recinto: run di 3+ ` o ~ a inizio riga (fino a 3 spazi soli)
    const sinceLineStart = i - lineStart
    if ((ch === '`' || ch === '~') && sinceLineStart <= 3 && text.slice(lineStart, i) === ' '.repeat(sinceLineStart)) {
      let runEnd = i
      while (runEnd < n && text[runEnd] === ch) runEnd++
      if (runEnd - i >= 3) {
        const end = fenceEndAt(text, ch, runEnd)
        segs.push({ kind: 'protected', start: i, end })
        i = lineStart = end < n ? end + 1 : n // salta anche il \n della chiusura
        continue
      }
      // run < 3 all'inizio riga: può essere uno SPAN inline, si prosegue sotto
    }
    if (ch === '`') {
      // lo span inline: run di N backtick, chiusura col prossimo run di
      // ESATTAMENTE N backtick sulla STESSA riga (i run più corti in mezzo
      // sono contenuto); senza chiusura il run è testo
      let runEnd = i
      while (runEnd < n && text[runEnd] === '`') runEnd++
      const len = runEnd - i
      const nl = text.indexOf('\n', i)
      const stop = nl === -1 ? n : nl
      let k = runEnd
      let close = -1
      while (k < stop) {
        if (text[k] === '`') {
          let e = k
          while (e < stop && text[e] === '`') e++
          if (e - k === len) { close = k; break }
          k = e
        } else k++
      }
      if (close >= 0) {
        segs.push({ kind: 'protected', start: i, end: close + len })
        i = close + len
      } else {
        i = runEnd // run non chiuso: testo, si continua a scansionare dopo
      }
      continue
    }
    if (ch === '<' && text.startsWith(OPEN_TAG, i)) {
      const close = text.indexOf(CLOSE_TAG, i + OPEN_TAG.length)
      const nextOpen = text.indexOf(OPEN_TAG, i + OPEN_TAG.length)
      if (close !== -1 && (nextOpen === -1 || close < nextOpen)) {
        // blocco CHIUSO (tempered): il corpo non contiene un altro <tool_call>
        let start = i
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--
        let end = close + CLOSE_TAG.length
        while (end < n && (text[end] === ' ' || text[end] === '\t')) end++
        if (text[end] === '\n') end++
        segs.push({ kind: 'block', start, end, closed: true })
        i = end
      } else if (close === -1 && nextOpen === -1) {
        // blocco APERTO in coda: l'ULTIMO <tool_call>, dopo l'ultima chiusura
        segs.push({ kind: 'block', start: i, end: n, closed: false })
        i = n
      } else {
        // il corpo conterrebbe un altro <tool_call> (tempered) o l'apertura
        // non è l'ultima senza chiusura: questa tag è TESTO, si riparte da dopo
        i += OPEN_TAG.length
        continue
      }
      lineStart = text.lastIndexOf('\n', i - 1) + 1
      continue
    }
    if (ch === '\n') lineStart = i + 1
    i++
  }
  return segs
}

/** Il corpo di un segmento blocco: fra `<tool_call>` e la chiusura (o la fine). */
function blockBody(text: string, seg: ToolCallBlockSegment): string {
  const tagAt = text.indexOf(OPEN_TAG, seg.start)
  const bodyStart = tagAt + OPEN_TAG.length
  const bodyEnd = seg.closed ? text.indexOf(CLOSE_TAG, bodyStart) : seg.end
  return text.slice(bodyStart, bodyEnd).replace(/^\s+/, '')
}

/** La testa XML del formato: <function=nome>. */
const XML_FUNCTION_HEAD_RE = /^<function=([A-Za-z0-9_.\-]+)>/

/** Un parametro del formato XML: <parameter=nome>…</parameter> (multilinea). */
const XML_PARAMETER_RE = /<parameter=([A-Za-z0-9_.\-]+)>\s*([\s\S]*?)\s*<\/parameter>/g

/**
 * Il valore di un parametro: i numeri, i booleani e gli oggetti si leggono
 * come JSON (il caso 21 scrive max_results su una riga sola, «10»); tutto il
 * resto è la stringa grezza, a capo compresi (rimossi solo gli a-capo
 * strutturali ai bordi del blocco parameter).
 */
function paramValueOf(raw: string): unknown {
  const v = raw.trim()
  if (!v) return ''
  if (/^(?:-?\d+(?:\.\d+)?|true|false|null)$/.test(v)) {
    try { return JSON.parse(v) } catch { return v }
  }
  if (v.startsWith('{') || v.startsWith('[') || (v.startsWith('"') && v.endsWith('"'))) {
    try {
      const parsed = JSON.parse(v) as unknown
      return parsed
    } catch { /* JSON rotto: resta la stringa grezza */ }
  }
  return raw.replace(/^\n+/, '').replace(/\n+$/, '')
}

/** Il parse del corpo XML <function=…>…</function>: nome + argomenti, o null se malformato. */
function parseXmlFunctionBlock(body: string): { name: string; args: Record<string, unknown> } | null {
  const m = body.match(XML_FUNCTION_HEAD_RE)
  if (!m) return null
  const rest = body.slice(m[0].length)
  if (!rest.includes('</function>')) return null
  const inner = rest.slice(0, rest.indexOf('</function>'))
  const args: Record<string, unknown> = {}
  for (const p of inner.matchAll(XML_PARAMETER_RE)) {
    args[p[1]!] = paramValueOf(p[2] ?? '')
  }
  return { name: m[1]!, args }
}

/** Il parse del corpo Hermes: JSON {"name":…,"arguments"|"parameters":{…}}. */
function parseHermesBlock(body: string): { name: string; args: Record<string, unknown> } | null {
  const v = body.trim()
  if (!v.startsWith('{')) return null
  let j: { name?: unknown; arguments?: unknown; parameters?: unknown }
  try {
    j = JSON.parse(v) as typeof j
  } catch {
    return null
  }
  if (typeof j.name !== 'string' || !j.name) return null
  const args = j.arguments ?? j.parameters
  const clean = args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
  return { name: j.name, args: clean }
}

/**
 * L1.1: le chiamate scritte come testo, nel formato XML dei dump e in quello
 * Hermes. Accetta SOLO nomi presenti in `knownToolNames` (il catalogo intero
 * del turno, compresi i tool dei gruppi non ancora attivi: le chiamate
 * passano dall'attivazione per nome come oggi); un blocco con nome
 * sconosciuto resta nel testo COM'È. Torna le chiamate e il testo fuori dai
 * blocchi riconosciuti.
 * LC3: un blocco APERTO in fondo al testo (nessuna </tool_call> dopo, il
 * modello si è fermato all'EOS) con un <function=…>…</function> completo si
 * riconosce come gli altri; senza </function> resta testo.
 * LD3: il corpo di un blocco non può contenere un altro <tool_call> (tempered
 * token): una menzione spaiata non si aggancia alla chiusura del blocco dopo;
 * il blocco aperto in coda è l'ULTIMO <tool_call> dopo l'ULTIMA chiusura.
 * LE1: gira sul LESSORE — un solo passaggio: le zone protette non si
 * calcolano più dentro i blocchi veri, quindi backtick e recinti negli
 * ARGOMENTI non spezzano più il recupero.
 */
export function parseTextToolCalls(text: string, knownToolNames: Iterable<string>): TextToolCallParse {
  const known = knownToolNames instanceof Set ? knownToolNames : new Set(knownToolNames)
  const calls: ParsedTextToolCall[] = []
  let out = ''
  let cursor = 0
  for (const seg of lexToolCallText(text)) {
    if (seg.kind === 'protected') {
      // zona protetta (recinto o span inline): testo voluto, com'è — col
      // tratto libero che la precede (blocchi rimasti compresi)
      out += text.slice(cursor, seg.end)
      cursor = seg.end
      continue
    }
    const body = blockBody(text, seg)
    const parsed = parseXmlFunctionBlock(body) ?? parseHermesBlock(body)
    if (!parsed || !known.has(parsed.name)) continue // sconosciuto o malformato: il blocco resta, lo raccoglie la fetta del segmento dopo
    calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.args) })
    out += text.slice(cursor, seg.start) // il testo prima del blocco (blocchi rimasti compresi)
    cursor = seg.end // il blocco intero esce dal testo, bordi compresi
  }
  out += text.slice(cursor)
  return { calls, text: out }
}

/**
 * L1.3: la pulizia per la CONSEGNA — un testo consegnato all'utente non
 * contiene MAI blocchi grezzi, per ogni provider (anche cloud): si tolgono
 * TUTTI i blocchi <tool_call>…</tool_call> (nome sconosciuto compreso), i
 * frammenti <function=…>…</function> orfani e i tag spaiati residui. Se dopo
 * la pulizia resta vuoto, il chiamante usa il recupero normale del loop.
 * LC3: i blocchi dentro un recinto di codice restano COME SONO — sono
 * contenuto voluto («ecco il formato»), anche per i provider cloud.
 * LD3: come i recinti sono protetti anche gli span di codice INLINE
 * (`…` su una riga): una menzione citata NON si toglie dal testo consegnato.
 * LE1: gira sul LESSORE — un blocco esce INTERO anche se i suoi argomenti
 * contengono backtick o recinti (prima la pulizia consegnava il contenuto
 * dell'argomento all'utente).
 */
export function stripTextToolCallBlocks(text: string): string {
  let out = ''
  let pos = 0
  for (const seg of lexToolCallText(text)) {
    if (seg.start > pos) out += stripOrphanFragments(text.slice(pos, seg.start))
    if (seg.kind === 'protected') out += text.slice(seg.start, seg.end) // recinto o span inline: resta com'è
    pos = seg.end // il blocco (chiuso o aperto, nome qualsiasi) ESCE intero
  }
  out += stripOrphanFragments(text.slice(pos))
  return out.trim()
}

/**
 * La pulizia di un tratto LIBERO del lexer: lì i blocchi non ci sono già più
 * (il lexer li ha consumati tutti), restano i frammenti orfani — function…/
 * function in coppia e i tag spaiati (le regex di L1.3, identiche).
 */
function stripOrphanFragments(seg: string): string {
  let out = seg
  // frammenti orfani: function…/function in coppia, poi i tag spaiati
  out = out.replace(/[ \t]*<function=[A-Za-z0-9_.\-]*>[\s\S]*?<\/function>[ \t]*\n?/g, '')
  out = out.replace(/[ \t]*<\/?tool_call>[ \t]*\n?/g, '')
  out = out.replace(/[ \t]*<function=[A-Za-z0-9_.\-]*>[ \t]*\n?/g, '')
  out = out.replace(/[ \t]*<\/?function>[ \t]*\n?/g, '')
  out = out.replace(/[ \t]*<\/?(?:parameter(?:=[A-Za-z0-9_.\-]*)?)>[ \t]*\n?/g, '')
  return out
}

/**
 * L1.3: il testo contiene blocchi (o frammenti) grezzi di chiamata?
 * LC3: quelli DENTRO un recinto di codice non contano — sono contenuto voluto.
 * LD3: non contano nemmeno quelli negli span inline (`…` su una riga).
 * LE1: gira sul LESSORE, come il recupero e la pulizia: non possono divergere.
 */
export function hasRawToolCallBlocks(text: string): boolean {
  let outside = ''
  let pos = 0
  for (const seg of lexToolCallText(text)) {
    if (seg.kind === 'block') return true // un blocco (anche aperto in coda) è grezzo
    if (seg.start > pos) outside += text.slice(pos, seg.start)
    pos = seg.end
  }
  outside += text.slice(pos)
  return /<tool_call>|<function=/.test(outside)
}
