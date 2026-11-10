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

/** Un blocco <tool_call>…</tool_call> intero (non-greedy), con eventuali a-capo ai bordi. */
const TOOL_CALL_BLOCK_RE = /[ \t]*<tool_call>\s*([\s\S]*?)<\/tool_call>[ \t]*\n?/g

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
 * riconosce come gli altri; senza </function> resta testo. I blocchi dentro
 * un recinto di codice non si toccano MAI: sono contenuto voluto.
 */
export function parseTextToolCalls(text: string, knownToolNames: Iterable<string>): TextToolCallParse {
  const known = knownToolNames instanceof Set ? knownToolNames : new Set(knownToolNames)
  const fences = codeFenceRanges(text)
  const calls: ParsedTextToolCall[] = []
  let out = ''
  let last = 0
  for (const m of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    if (inAnyRange(fences, m.index ?? 0)) continue // nel recinto: è testo voluto
    const body = m[1] ?? ''
    const parsed = parseXmlFunctionBlock(body) ?? parseHermesBlock(body)
    if (!parsed || !known.has(parsed.name)) continue // sconosciuto o malformato: il blocco resta
    calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.args) })
    out += text.slice(last, m.index)
    last = (m.index ?? 0) + m[0].length
  }
  // LC3: il blocco APERTO in coda — un <tool_call> rimasto senza chiusura
  const tail = text.slice(last)
  const openIdx = tail.indexOf('<tool_call>')
  if (openIdx !== -1) {
    const openAt = last + openIdx
    const after = tail.slice(openIdx)
    if (!after.includes('</tool_call>') && !inAnyRange(fences, openAt)) {
      const body = after.replace(/^[ \t]*<tool_call>\s*/, '')
      const parsed = parseXmlFunctionBlock(body) ?? parseHermesBlock(body)
      if (parsed && known.has(parsed.name)) {
        calls.push({ name: parsed.name, arguments: JSON.stringify(parsed.args) })
        out += tail.slice(0, openIdx)
        last = text.length // il blocco aperto arriva in fondo al testo
      }
    }
  }
  out += text.slice(last)
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
 */
export function stripTextToolCallBlocks(text: string): string {
  const fences = codeFenceRanges(text)
  let out = ''
  let pos = 0
  for (const [a, b] of fences) {
    if (a > pos) out += stripUnfenced(text.slice(pos, a))
    out += text.slice(a, b) // il recinto resta com'è
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
 */
export function hasRawToolCallBlocks(text: string): boolean {
  const fences = codeFenceRanges(text)
  let outside = ''
  let pos = 0
  for (const [a, b] of fences) {
    if (a > pos) outside += text.slice(pos, a)
    pos = b
  }
  outside += text.slice(pos)
  return /<tool_call>|<function=/.test(outside)
}
