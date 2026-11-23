#!/usr/bin/env node
// Fase design (DS4): la MIGRAZIONE meccanica delle classi del renderer ai
// token di DS1. Le pagine passano al sistema una per commit: per ognuna
// questo script riscrive le classi di testo, raggi, spaziature e pesi nei SUOI
// file (le stringhe lette dall'AST, come la guardia: i commenti non si
// toccano), poi la pagina si sistema a mano dove serve giudizio (larghezze,
// emoji, strutture). Non è una scopa magica: è il primo passo, lo stesso per
// tutti; quel che resta lo dice la guardia (design-guard.test.ts).
//
//   node scripts/design-migrazione.mjs --file src/renderer/src/components/Chat.tsx [--file …] [--dry]
//
// Cosa riscrive (e con quale regola):
//   testo     text-xs→caption · text-sm→body · text-base→reading · text-lg→title · text-xl→title · text-2xl e oltre→page;
//             text-[Npx]→la più vicina delle sei (≤12 caption · <14 small · <16 body · <18 reading · <24 title · oltre page);
//             leading-* esce (ogni dimensione ha la sua interlinea);
//   raggi     rounded, rounded-sm/md/lg→control · rounded-xl/2xl/3xl→surface · rounded-[Npx]→ control (≤9) o surface;
//   spaziature p-[Npx], m-[Npx]… → il valore della scala più vicino; e fuori scala (2.5, 3.5, 7, 9, 11, 13, 14, 15) → il più vicino
//             (a parità: in orizzontale il maggiore, in verticale il minore);
//   pesi      font-bold, font-extrabold, font-black→semibold · font-light, font-thin, font-extralight→normal;
//   maiuscoletti  uppercase e tracking-* escono;
//   icone     le icone lucide con misura fuori dalle due (16 nel testo, 20 nelle testate): <18→size-4, da 18→size-5.
// NON tocca: larghezze (max-w-*, w-*: le decide la pagina), le dimensioni libere non in px (calc, var, %),
// le emoji (DS5), i file di test.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'

const argv = process.argv.slice(2)
const files = []
for (let i = 0; i < argv.length; i++) if (argv[i] === '--file') files.push(argv[++i])
const DRY = argv.includes('--dry') || files.length === 0
const ROOT = join(import.meta.dirname, '..')

// ---- le regole (le stesse della guardia: __tests__/design-scan.ts) ----
const VARIANT = /^((?:[\w-]+:)*-?!?)/
/** La più vicina delle sei dimensioni (DS1): ≤12 caption · fino a 14 small · fino a 16 body · fino a 18 reading · fino a 24 title · oltre page. */
const sizeName = (px) => (px <= 12 ? 'caption' : px < 14 ? 'small' : px < 16 ? 'body' : px < 18 ? 'reading' : px < 24 ? 'title' : 'page')
const TEXT_NAMED = { xs: 'caption', sm: 'body', base: 'reading', lg: 'title', xl: 'title', '2xl': 'page', '3xl': 'page', '4xl': 'page' }
const RADIUS = { '': 'control', sm: 'control', md: 'control', lg: 'control', xl: 'surface', '2xl': 'surface', '3xl': 'surface' }
const SCALE = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192, 224, 256]
const ALLOWED = new Set(['0', '0.5', '1', '1.5', '2', '3', '4', '5', '6', '8', '10', '12', '16'])
const H_AXIS = /^(?:px|pl|pr|ps|pe|mx|ml|mr|ms|me|gap-x|space-x|left|right|start|end|inset-x)$/
const V_AXIS = /^(?:py|pt|pb|ps|pe|my|mt|mb|ms|me|gap-y|space-y|top|bottom|inset-y)$/
/** I nomi delle utility di spaziatura (senza il valore). */
const SPACING = /^(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left|start|end)$/
/** Il nome con un valore della scala (`px-2.5`, `-mt-7` senza il meno, che sta nel prefisso). */
const SPACING_VALUE = /^(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left|start|end)-(\d*\.?\d+)$/
const isClassLike = (t) => /^(?:!?-?(?:[\w-]+:))*(?:flex|grid|inline-flex|inline-grid|inline-block|block|hidden|contents|truncate|relative|absolute|fixed|sticky|static|isolate|container|underline|italic|flex-\S+|grid-\S+|col-\S+|row-\S+|items-\S+|justify-\S+|self-\S+|content-\S+|gap-\S+|space-[xy]-\S+|p[xytrbl]?-\S+|m[xytrbl]?-\S+|text-\S+|bg-\S+|border\b|border-\S+|divide-\S+|rounded\S*|font-\S+|leading-\S+|tracking-\S+|size-\S+|w-\S+|h-\S+|min-\S+|max-\S+|top-\S+|bottom-\S+|left-\S+|right-\S+|inset-\S+|translate-\S+|transition\S*|duration-\S+|cursor-\S+|overflow-\S+|shadow\S*|opacity-\S+|z-\S+|order-\S+|shrink\S*|grow\S*|basis-\S+|object-\S+|select-\S+|pointer-events-\S+|whitespace-\S+|break-\S+|align-\S+|list-\S+|outline\S*|ring\S*|sr-only|no-drag|drag-region|antialiased)$/.test(t)
const isClassList = (value) => {
  const tokens = value.split(/\s+/).filter((t) => t !== '')
  const like = tokens.filter((t) => isClassLike(t.replace(/^-/, ''))).length
  return like >= 2 || (tokens.length === 1 && like === 1)
}

/** A parità di distanza vince il maggiore per le spaziature orizzontali, per `gap` e per `p-` (tutti i lati): fanno più aria; per le verticali il minore. */
const TIE_UP = (name) => H_AXIS.test(name) || name === 'gap' || name === 'p'
/** Il più vicino valore della scala (in px, multipli di 4); a parità vince il maggiore se `up`, altrimenti il minore. */
const nearest = (px, up) => {
  let best = SCALE[0]
  let bestD = Infinity
  for (const v of SCALE) {
    const d = Math.abs(v - px)
    if (d < bestD || (d === bestD && up && v > best)) { best = v; bestD = d }
  }
  return best / 4
}
const num = (value) => (/^-?\d*\.?\d+$/.test(value) ? Number(value) : null)

/**
 * PURA: un token di classe dopo la migrazione (null = esce). Le varianti
 * davanti (`hover:`, `md:`, il meno) restano.
 */
export const migrateToken = (token) => {
  const m = VARIANT.exec(token)
  const prefix = m ? m[1] : ''
  const body = prefix ? token.slice(prefix.length) : token
  const out = migrateBody(body)
  if (out === null) return null
  // il meno davanti (le spaziature negative: -m-2): vale anche per la forma nuova
  const negative = prefix.endsWith('-') && SPACING.test(out.split('-')[0] ?? '') ? '-' : ''
  return out === '' ? '' : (negative ? prefix.slice(0, -1) : prefix) + negative + out
}
const migrateBody = (b) => {
  if (b === 'uppercase' || /^tracking(-[\w[]+.]*)?$/.test(b) || /^leading-(?:none|tight|snug|normal|relaxed|loose|\[[^\]]+\]|-?[\d.]+)$/.test(b)) return null
  if (b === 'font-bold' || b === 'font-extrabold' || b === 'font-black') return 'font-semibold'
  if (b === 'font-light' || b === 'font-thin' || b === 'font-extralight') return 'font-normal'
  let m
  if ((m = /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl)(?:\/\S+)?$/.exec(b))) return `text-${TEXT_NAMED[m[1]]}`
  if ((m = /^text-\[(\d*\.?\d+)px\]$/.exec(b))) return `text-${sizeName(Number(m[1]))}`
  if ((m = /^rounded(?:-(ss|se|ee|es|[trbl]{1,2}))?(?:-(.+))?$/.exec(b))) {
    const side = m[1] ? `-${m[1]}` : ''
    const rest = m[2] ?? ''
    if (rest === '' ) return `rounded${side}-control`
    if (rest === 'full' || rest === 'none') return b
    if (rest in RADIUS) return `rounded${side}-${RADIUS[rest]}`
    const px = /^\[(\d*\.?\d+)px\]$/.exec(rest)
    if (px) return `rounded${side}-${Number(px[1]) <= 9 ? 'control' : 'surface'}`
    return b
  }
  if ((m = /^(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[(-?\d*\.?\d+)px\]$/.exec(b))) {
    return `${m[1]}-${nearest(Number(m[2]), TIE_UP(m[1]))}`
  }
  if ((m = SPACING_VALUE.exec(b))) {
    // fuori dalla scala (2.5, 3.5, 7, 9, 11, 13…): il valore più vicino; la spaziatura con un nome (p-section) non arriva qui
    return `${m[1]}-${nearest(Number(m[2]) * 4, TIE_UP(m[1]))}`
  }
  return b
}

/** PURA: una stringa di classi dopo la migrazione (i token che escono spariscono, niente doppi spazi). */
export const migrateClasses = (value) => {
  if (!isClassList(value)) return value
  const leading = /^\s*/.exec(value)[0]
  const trailing = /\s*$/.exec(value)[0]
  const tokens = value.trim().split(/\s+/).map(migrateToken).filter((t) => t !== null)
  return leading + tokens.join(' ') + trailing
}
/** PURA: la classe di un'icona lucide: la misura fra le due (16 nel testo, 20 nelle testate). */
export const migrateIconClasses = (value) => {
  if (!isClassList(value)) return value
  return value.trim().split(/\s+/).map((t) => {
    const body = t.replace(VARIANT, '')
    const m = /^(size|h|w)-(\d*\.?\d+)$/.exec(body)
    if (!m) return t
    const px = Number(m[2]) * 4
    if (px >= 18 && px < 32) return t.replace(body, `${m[1]}-5`)
    if (px < 18) return t.replace(body, `${m[1]}-4`)
    return t
  }).join(' ')
}

/** Le stringhe di un sorgente CON la loro posizione nella fonte: { start, end, value, kind }. */
const stringsWithPos = (source) => {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const out = []
  const lucide = new Set()
  const prose = new WeakSet()
  for (const mm of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) for (const n of mm[1].split(',')) { const id = n.trim().split(/\s+as\s+/).pop().trim(); if (id) lucide.add(id) }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    const n = node
    if (n.type === 'TemplateElement') { out.push({ start: n.start, end: n.end, value: n.value.cooked, kind: 'template' }) }
    if (n.type === 'StringLiteral' && typeof n.value === 'string' && !prose.has(n)) out.push({ start: n.start, end: n.end, value: n.value, kind: 'string', quote: n.extra?.raw?.[0] ?? "'" })
    if (n.type === 'JSXText' && typeof n.value === 'string') out.push({ start: n.start, end: n.end, value: n.value, kind: 'jsx' })
    if (n.type === 'JSXAttribute' && n.name?.name !== 'className' && n.name?.name !== 'class' && n.value?.type === 'StringLiteral' && typeof n.value.value === 'string') {
      // gli altri attributi sono prosa (title, aria-label, placeholder, data-*): la parola «rounded» in un suggerimento non è una classe
      prose.add(n.value)
    }
    if (n.type === 'JSXOpeningElement' && n.name?.type === 'JSXIdentifier' && lucide.has(n.name.name)) {
      for (const a of n.attributes ?? []) if (a.type === 'JSXAttribute' && a.name?.name === 'className' && a.value?.type === 'StringLiteral') out.push({ start: a.value.start, end: a.value.end, value: a.value.value, kind: 'icon', quote: a.value.extra?.raw?.[0] ?? '"' })
    }
    for (const key of Object.keys(n)) {
      if (['loc', 'start', 'end', 'extra', 'errors', 'tokens', 'comments'].includes(key)) continue
      const child = n[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(ast.program)
  return out.sort((a, b) => a.start - b.start)
}

const escapeWith = (quote, value) => value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`).replace(/\n/g, '\\n')

/** Il sorgente dopo la migrazione, e quante stringhe sono cambiate. */
export const migrateSource = (source) => {
  const edits = []
  for (const s of stringsWithPos(source)) {
    const next = s.kind === 'icon' ? migrateIconClasses(s.value) : migrateClasses(s.value)
    if (next === s.value) continue
    let text
    if (s.kind === 'string' || s.kind === 'icon') text = `${s.quote}${escapeWith(s.quote, next)}${s.quote}`
    else if (s.kind === 'jsx') text = next
    else text = next.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
    edits.push({ ...s, next, text })
  }
  let out = ''
  let at = 0
  for (const e of edits) { out += source.slice(at, e.start) + e.text; at = e.end }
  out += source.slice(at)
  return { source: out, changed: edits.map((e) => ({ from: e.value, to: e.next })) }
}

if (import.meta.main) {
  let total = 0
  for (const f of files) {
    const before = readFileSync(join(ROOT, f), 'utf8')
    const { source: after, changed } = migrateSource(before)
    total += changed.length
    console.log(`${changed.length ? String(changed.length).padStart(4) : '   -'}  ${f}`)
    if (!DRY && changed.length) writeFileSync(join(ROOT, f), after)
  }
  if (DRY && files.length) console.log('(--dry: niente scritto)')
  console.log(`stringhe di classi cambiate: ${total}`)
}
