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
 * Un blocco <tool_call>…</tool_call> intero, con eventuali a-capo ai bordi.
 * LD3: il corpo non può contenere un altro `<tool_call>` (tempered token
 * `(?:(?!<tool_call>)[\s\S])*?`) — così una menzione spaiata non si aggancia
 * alla chiusura del blocco VERO che viene dopo.
 */
const TOOL_CALL_BLOCK_RE = /[ \t]*<tool_call>\s*((?:(?!<tool_call>)[\s\S])*?)<\/tool_call>[ \t]*\n?/g

/**
 * Fase locale correzioni (LC3): le porzioni di testo DENTRO un recinto di
 * codice (``` o ~~~, fino alla chiusura dello stesso carattere o alla fine
 * del testo se mai chiuso). Sono contenuto VOLUTO («ecco il formato»): il
 * recupero non le esegue e la pulizia non le tocca.
 */
export function codeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let i = 0
  const n = text.length
  while (i < n) {
    const nl = text.indexOf('\n', i)
    const lineEnd = nl === -1 ? n : nl
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, lineEnd))
    if (m) {
      const ch = m[1]![0]! // ` o ~
      const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{3,}[ \\t]*$`)
      // la chiusura: una riga che è SOLO il recinto dello stesso carattere
      let j = nl === -1 ? n : nl + 1
      let rangeEnd = n // mai chiuso → fino alla fine del testo
      while (j <= n) {
        const nl2 = text.indexOf('\n', j)
        const end2 = nl2 === -1 ? n : nl2
        if (closeRe.test(text.slice(j, end2))) { rangeEnd = end2; break }
        if (nl2 === -1) break
        j = nl2 + 1
      }
      ranges.push([i, rangeEnd])
      i = rangeEnd >= n ? n : rangeEnd + 1
    } else {
      i = lineEnd + 1
    }
  }
  return ranges
}

/** L'indice cade dentro un recinto di codice? (per match già calcolati) */
function inAnyRange(ranges: Array<[number, number]>, idx: number): boolean {
  for (const [a, b] of ranges) if (idx >= a && idx < b) return true
  return false
}

/**
 * LD3: gli span di codice INLINE di un tratto — `` `…` `` (o `` ``…`` ``) su
 * UNA riga: un run di N backtick si chiude col PROSSIMO run di ESATTAMENTE N
 * backtick sulla stessa riga (i run più corti in mezzo sono contenuto); senza
 * chiusura sulla riga il run è testo e non fa span. Citare il formato
 * («usa `<tool_call>` così») è contenuto voluto come i recinti.
 */
function inlineCodeSpans(text: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let li = from
  while (li < to) {
    const nl = text.indexOf('\n', li)
    const lineEnd = nl === -1 || nl >= to ? to : nl
    let j = li
    while (j < lineEnd) {
      if (text[j] !== '`') { j++; continue }
      let openEnd = j
      while (openEnd < lineEnd && text[openEnd] === '`') openEnd++
      const len = openEnd - j
      // la chiusura: il prossimo run della STESSA lunghezza, sulla stessa riga
      let k = openEnd
      let close = -1
      while (k < lineEnd) {
        if (text[k] === '`') {
          let e = k
          while (e < lineEnd && text[e] === '`') e++
          if (e - k === len) { close = k; break }
          k = e
        } else k++
      }
      if (close >= 0) {
        out.push([j, close + len])
        j = close + len
      } else {
        j = openEnd // run non chiuso: testo, si continua a scansionare dopo
      }
    }
    li = nl === -1 || nl >= to ? to : nl + 1
  }
  return out
}

/**
 * LC3 + LD3: le zone PROTETTE di un testo, in ordine — i recinti di codice
 * (``` o ~~~, fino alla chiusura dello stesso carattere o alla fine se mai
 * chiusi) E gli span di codice inline sui tratti liberi. Sono contenuto
 * VOLUTO: il recupero non li esegue e la pulizia non li tocca.
 */
export function protectedRanges(text: string): Array<[number, number]> {
  const fences = codeFenceRanges(text)
  const out: Array<[number, number]> = []
  let pos = 0
  const n = text.length
  for (const [a, b] of fences) {
    if (a > pos) out.push(...inlineCodeSpans(text, pos, a))
    out.push([a, b])
    pos = b
  }
  if (pos < n) out.push(...inlineCodeSpans(text, pos, n))
  return out
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
 * LD3: il recupero gira PER TRATTI fuori dalle zone protette (recinti E span
 * inline), come la pulizia — non sul testo intero per poi filtrare: una
 * menzione nel recinto non ingoia più il blocco vero che viene dopo. Il
 * blocco aperto in coda è l'ULTIMO <tool_call> dopo l'ULTIMA </tool_call>:
 * un blocco chiuso con nome sconosciuto davanti non lo nasconde più.
 */
export function parseTextToolCalls(text: string, knownToolNames: Iterable<string>): TextToolCallParse {
  const known = knownToolNames instanceof Set ? knownToolNames : new Set(knownToolNames)
  const guarded = protectedRanges(text)
  const calls: ParsedTextToolCall[] = []
  let out = ''
  let cursor = 0

  // i blocchi CHIUSI dei tratti liberi, uno per tratto (tra le zone protette)
  const consumeClosed = (from: number, to: number): void => {
    const seg = text.slice(from, to)
    for (const m of seg.matchAll(TOOL_CALL_BLOCK_RE)) {
      const idx = from + (m.index ?? 0)
      const body = m[1] ?? ''
      const parsed = parseXmlFunctionBlock(body) ?? parseHermesBlock(body)
      if (!parsed || !known.has(parsed.name)) continue // sconosciuto o malformato: il blocco resta
      calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.args) })
      out += text.slice(cursor, idx)
      cursor = idx + m[0].length
    }
  }

  for (const [a, b] of guarded) {
    if (a > cursor) {
      consumeClosed(cursor, a)
      out += text.slice(cursor, a) // il resto del tratto libero, blocchi rimasti compresi
      cursor = a
    }
    out += text.slice(a, b) // zona protetta (recinto o span inline): com'è
    cursor = b
  }
  consumeClosed(cursor, text.length)

  // il blocco APERTO in coda: l'ULTIMO <tool_call> dopo l'ULTIMA
  // </tool_call>, fuori dalle zone protette (il corpo arriva in fondo al testo)
  const lastClose = text.lastIndexOf('</tool_call>')
  const openAt = text.lastIndexOf('<tool_call>')
  if (openAt > lastClose && openAt >= cursor && !inAnyRange(guarded, openAt)) {
    const body = text.slice(openAt).replace(/^[ \t]*<tool_call>\s*/, '')
    const parsed = parseXmlFunctionBlock(body) ?? parseHermesBlock(body)
    if (parsed && known.has(parsed.name)) {
      calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.args) })
      out += text.slice(cursor, openAt)
      cursor = text.length
    }
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
 */
export function stripTextToolCallBlocks(text: string): string {
  const guarded = protectedRanges(text)
  let out = ''
  let pos = 0
  for (const [a, b] of guarded) {
    if (a > pos) out += stripUnfenced(text.slice(pos, a))
    out += text.slice(a, b) // zona protetta (recinto o span inline): resta com'è
    pos = b
  }
  out += stripUnfenced(text.slice(pos))
  return out.trim()
}

/** La pulizia di un tratto FUORI dai recinti (le regex di L1.3, identiche). */
function stripUnfenced(seg: string): string {
  let out = seg.replace(TOOL_CALL_BLOCK_RE, '')
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
 */
export function hasRawToolCallBlocks(text: string): boolean {
  const guarded = protectedRanges(text)
  let outside = ''
  let pos = 0
  for (const [a, b] of guarded) {
    if (a > pos) outside += text.slice(pos, a)
    pos = b
  }
  outside += text.slice(pos)
  return /<tool_call>|<function=/.test(outside)
}
