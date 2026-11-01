// Fase 17a (L7): parser .po minimale per i test dei cataloghi (ambiente node,
// niente jsdom). Legge le coppie msgid/msgstr con escape standard gettext.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'

/** Il percorso del catalogo di una lingua (locales/{locale}/messages.po). */
export function poPath(locale: 'it' | 'en'): string {
  return fileURLToPath(new URL(`../locales/${locale}/messages.po`, import.meta.url))
}

function unquote(block: string): string {
  const parts = block.match(/"((?:[^"\\]|\\.)*)"/g) ?? []
  return parts
    .map((p) => p.slice(1, -1))
    .join('')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/** Le coppie msgid → msgstr del catalogo (l'header msgid "" escluso). */
export function parsePo(locale: 'it' | 'en'): Map<string, string> {
  const text = readFileSync(poPath(locale), 'utf8')
  const out = new Map<string, string>()
  const re = /msgid ((?:"(?:[^"\\]|\\.)*"\s*)+)msgstr ((?:"(?:[^"\\]|\\.)*"\s*)*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = unquote(m[1]!)
    if (id === '') continue
    out.set(id, unquote(m[2]!))
  }
  return out
}

/**
 * Gli argomenti {…} di un messaggio ICU, al livello esterno (dentro un
 * plural conta l'argomento del plural, non le forme interne).
 */
export function icuArgs(message: string): Set<string> {
  const out = new Set<string>()
  let depth = 0
  let i = 0
  while (i < message.length) {
    const c = message[i]!
    if (c === '{') {
      if (depth === 0) {
        let name = ''
        let j = i + 1
        while (j < message.length && message[j] !== ',' && message[j] !== '}') {
          name += message[j]
          j++
        }
        name = name.trim()
        if (/^[a-zA-Z0-9_]+$/.test(name)) out.add(name)
      }
      depth++
      i++
    } else if (c === '}') {
      depth = Math.max(0, depth - 1)
      i++
    } else i++
  }
  return out
}

/**
 * Le entrate del catalogo it pronte per i18n.load: chiave = msgid sorgente E
 * chiave = id hash (quella che il runtime genera dalle macro). Lingua
 * sorgente: msgstr vuoto vale il msgid stesso.
 */
export function itCatalogEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const [id, str] of parsePo('it')) {
    const value = str || id
    entries[id] = value
    entries[generateMessageId(id)] = value
  }
  return entries
}

/**
 * Fase 16b (S3.3): le entrate del catalogo en pronte per i18n.load — chiave
 * = msgid sorgente E chiave = id hash; msgstr vuoto ricade sul msgid (test
 * della mezza riga d'attività in inglese).
 */
export function enCatalogEntries(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const [id, str] of parsePo('en')) {
    const value = str || id
    entries[id] = value
    entries[generateMessageId(id)] = value
  }
  return entries
}
