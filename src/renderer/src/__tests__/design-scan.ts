// Fase design (DS6): LA LOGICA della guardia sul sorgente del renderer (il test è
// design-guard.test.ts, che la importa; qui le regole, la lettura delle stringhe
// dall'AST e la scansione). «Un sistema di
// regole piccolo, scritto in un posto solo, che il codice NON PUÒ aggirare»:
// i token sono in styles.css (DS1) e qui si vieta di scrivere a mano ciò che
// i token dovrebbero decidere.
//
// Cosa non deve comparire nei sorgenti del renderer (stringhe di classi,
// template literal, testo JSX — NON i commenti, che si leggono con l'AST):
//   text-[…]                  — dimensioni di testo libere (eccezione: i colori con var)
//   text-xs … text-9xl        — le taglie di Tailwind: si usano le sei di DS1
//   p-[…] m-[…] gap-[…] …     — spaziature con valore libero: la scala di Tailwind (multipli di 4) o le distanze con un nome
//   rounded-[…]               — raggi liberi
//   rounded, rounded-lg…      — i raggi di fabbrica: restano rounded-control, rounded-surface, rounded-full
//   max-w-[…px], w-[…px]      — larghezze libere in px: le tre di DS1 (o l'area meno i margini)
//   uppercase, tracking-…     — nessun maiuscoletto
//   emoji                     — solo icone lucide nell'interfaccia
//   font-bold, font-light…    — i pesi sono 400, 500, 600
//   leading-…                 — ogni dimensione di testo ha la sua interlinea: non si riscrive
//   p-2.5, gap-7, top-11…     — le spaziature sono dalla scala (0.5 1 1.5 2 3 4 5 6 8 10 12 16) o con un nome
//   le icone lucide           — 16 px (size-4) o 20 px (size-5), sempre scritti
// Le eccezioni vivono in UN file (lib/design-exceptions.ts), ognuna con il
// motivo; qui si controlla che nessuna sia morta. Nessuna area è esente:
// (finché le pagine passavano al sistema, DS4, c'era un elenco provvisorio
// di aree non ancora migrate: a fine fase è vuoto ed è uscito).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { DESIGN_EXCEPTIONS, type DesignRule } from '../lib/design-exceptions'

export const SRC = fileURLToPath(new URL('..', import.meta.url)) // src/renderer/src (il sorgente guardato, dal nuovo posto delle guardie)
export const CSS_PATH = join(SRC, 'styles.css')
const CSS = readFileSync(CSS_PATH, 'utf8')

/** Le regole: una per token di classe (le varianti `hover:` e compagnia stanno davanti). */
/** Le regole sulle stringhe (le icone e le emoji si guardano altrove). */
export const RULES: Readonly<Record<Exclude<DesignRule, 'icon-size' | 'emoji'>, RegExp>> & { emoji: RegExp } = {
  'text-arbitrary': /^(?:[\w-]+:)*-?!?text-\[/,
  'text-tailwind': /^(?:[\w-]+:)*-?!?text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/,
  'spacing-arbitrary': /^(?:[\w-]+:)*-?!?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[/,
  'radius-arbitrary': /^(?:[\w-]+:)*-?!?rounded(?:-[trbl]{1,2}|-ss|-se|-ee|-es)?-\[/,
  'radius-other': /^(?:[\w-]+:)*-?!?rounded(?:-(?:ss|se|ee|es|[trbl]{1,2}))?(?:-(?:xs|sm|md|lg|xl|2xl|3xl|4xl))?$/,
  'width-px': /^(?:[\w-]+:)*-?!?(?:max-w|w)-\[\d*\.?\d+px\]$/,
  'uppercase-tracking': /^(?:[\w-]+:)*-?!?(?:uppercase|tracking(?:-\S+)?)$/,
  emoji: /\p{Extended_Pictographic}/u,
  'font-weight': /^(?:[\w-]+:)*-?!?font-(?:bold|extrabold|black|light|thin|extralight|\[)/,
  leading: /^(?:[\w-]+:)*-?!?leading-/,
  'spacing-scale': /^(?:[\w-]+:)*-?!?(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left|start|end)-(\d*\.?\d+)$/
}
/** I valori della scala di spaziatura (DS1): le utility con un numero diverso sono violazioni. */
export const SPACING_SCALE: readonly string[] = ['0', '0.5', '1', '1.5', '2', '3', '4', '5', '6', '8', '10', '12', '16']
/** Le due misure delle icone lucide (DS1): 16 px nel testo e nei bottoni, 20 px nelle testate. */
export const ICON_SIZES: readonly string[] = ['size-4', 'size-5']

/** Un token che dice «questa stringa è una lista di classi» (una utility qualunque di layout o aspetto). */
const CLASS_LIKE = /^(?:!?-?(?:[\w-]+:))*(?:flex|grid|inline-flex|inline-grid|inline-block|block|hidden|contents|truncate|relative|absolute|fixed|sticky|static|isolate|container|underline|italic|flex-\S+|grid-\S+|col-\S+|row-\S+|items-\S+|justify-\S+|self-\S+|content-\S+|gap-\S+|space-[xy]-\S+|p[xytrbl]?-\S+|m[xytrbl]?-\S+|text-\S+|bg-\S+|border\b|border-\S+|divide-\S+|rounded\S*|font-\S+|leading-\S+|tracking-\S+|size-\S+|w-\S+|h-\S+|min-\S+|max-\S+|top-\S+|bottom-\S+|left-\S+|right-\S+|inset-\S+|translate-\S+|transition\S*|duration-\S+|cursor-\S+|overflow-\S+|shadow\S*|opacity-\S+|z-\S+|order-\S+|shrink\S*|grow\S*|basis-\S+|object-\S+|select-\S+|pointer-events-\S+|whitespace-\S+|break-\S+|align-\S+|list-\S+|outline\S*|ring\S*|sr-only|no-drag|drag-region|antialiased)$/

/**
 * La stringa è una lista di classi? Almeno DUE token lo dicono, oppure è un
 * token solo («flex», «hidden»): una parola di prosa che capita («rounded»)
 * non basta.
 */
export const isClassList = (value: string): boolean => {
  const tokens = value.split(/\s+/).filter((t) => t !== '')
  // il meno davanti (le spaziature negative: -mt-2) non fa parte del nome: si toglie prima di guardare
  const like = tokens.filter((t) => CLASS_LIKE.test(t.replace(/^-/, ''))).length
  return like >= 2 || (tokens.length === 1 && like === 1)
}

/**
 * PURA: le violazioni di UNA stringa. `exempt` toglie le occorrenze coperte
 * da un'eccezione della stessa regola (globale: la guardia non decide file per
 * file). Torna { rule, token } per ognuna.
 */
export const violationsOfString = (value: string, exempt: (rule: DesignRule, text: string) => string): Array<{ rule: DesignRule; token: string }> => {
  const out: Array<{ rule: DesignRule; token: string }> = []
  // le emoji si cercano in OGNI stringa e in ogni testo JSX (anche fuori da una lista di classi)
  const emoji = RULES.emoji
  emoji.lastIndex = 0
  const hit = emoji.exec(value)
  if (hit) out.push({ rule: 'emoji', token: hit[0] })
  if (!isClassList(value)) return out
  for (const token of value.split(/\s+/)) {
    if (token === '') continue
    for (const [rule, re] of Object.entries(RULES) as Array<[DesignRule, RegExp]>) {
      if (rule === 'emoji') continue
      const t = exempt(rule, token)
      if (!re.test(t)) continue
      // la spaziatura numerica è una violazione solo fuori dalla scala
      if (rule === 'spacing-scale' && SPACING_SCALE.includes(t.match(/([\d.]+)$/)?.[1] ?? '')) continue
      out.push({ rule, token })
    }
  }
  return out
}

interface Node {
  type?: string
  [k: string]: unknown
}

/** Le stringhe di un sorgente (valori, template literal, testo JSX): i commenti NON ci sono. */
export function stringsOf(source: string): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Node
    // un template literal si legge nell'ordine della fonte: pezzo fisso, espressione, pezzo fisso…
    if (n.type === 'TemplateLiteral' && Array.isArray(n.quasis) && Array.isArray(n.expressions)) {
      n.quasis.forEach((q, i) => {
        const cooked = (q as { value?: { cooked?: unknown } }).value?.cooked
        if (typeof cooked === 'string') out.push(cooked)
        const expressions = n.expressions as unknown[]
        if (i < expressions.length) visit(expressions[i])
      })
      return
    }
    if (n.type === 'StringLiteral' && typeof n.value === 'string') out.push(n.value)
    else if (n.type === 'TemplateElement' && typeof n.value === 'object' && n.value !== null && typeof (n.value as { cooked?: unknown }).cooked === 'string') out.push((n.value as { cooked: string }).cooked)
    else if (n.type === 'JSXText' && typeof n.value === 'string') out.push(n.value)
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'errors' || key === 'tokens' || key === 'comments') continue
      const child = n[key]
      if (Array.isArray(child)) for (const c of child) visit(c)
      else if (child && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child)
    }
  }
  visit(ast.program)
  return out
}

/**
 * PURA: le icone lucide (importate da lucide-react e scritte come <Nome … />)
 * di un sorgente che NON portano una delle due misure, con la riga. La
 * dimensione va scritta sempre: senza, lucide fa 24 px.
 */
export function iconViolations(source: string): Array<{ line: number; name: string; token: string }> {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const lucide = new Set<string>()
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const n of m[1]!.split(',')) { const id = n.trim().split(/\s+as\s+/).pop()!.trim(); if (id) lucide.add(id) }
  }
  const out: Array<{ line: number; name: string; token: string }> = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Node
    const name = n.name as Node | undefined
    if ((n.type === 'JSXOpeningElement' || n.type === 'JSXSelfClosingElement') && name?.type === 'JSXIdentifier' && lucide.has(String(name.name))) {
      const attrs = (n.attributes ?? []) as Node[]
      const attr = attrs.find((a) => a.type === 'JSXAttribute' && (a.name as Node | undefined)?.type === 'JSXIdentifier' && (a.name as Node).name === 'className')
      const value = attr?.value as Node | undefined
      const inner = value?.expression as Node | undefined
      // la classe fissa (stringa), in un'espressione o in un template literal (bastano i pezzi fissi)
      const cls = value?.type === 'StringLiteral' ? String(value.value)
        : value?.type === 'JSXExpressionContainer' && inner?.type === 'StringLiteral' ? String(inner.value)
        : value?.type === 'JSXExpressionContainer' && inner?.type === 'TemplateLiteral' ? (inner.quasis as Node[]).map((q) => String((q.value as { cooked?: unknown }).cooked ?? '')).join(' ')
        : null
      const sizes = (cls ?? '').split(/\s+/).filter((t) => /(?:^|:)(?:size|-?[wh])-\d*\.?\d+$/.test(t))
      const loc = n.loc as { start?: { line?: number } } | undefined
      if (!cls || sizes.length === 0) out.push({ line: loc?.start?.line ?? 0, name: String(name.name), token: '(senza misura)' })
      else for (const size of sizes) if (!ICON_SIZES.includes(size)) out.push({ line: loc?.start?.line ?? 0, name: String(name.name), token: size })
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'errors' || key === 'tokens' || key === 'comments') continue
      const child = n[key]
      if (Array.isArray(child)) for (const c of child) visit(c)
      else if (child && typeof child === 'object' && typeof (child as Node).type === 'string') visit(child)
    }
  }
  visit(ast.program)
  return out
}

export function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      // i test sono fuori: qui i token vietati si scrivono apposta
      if (name === '__tests__' || name === 'locales' || name === 'assets') continue
      sourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      // il file delle eccezioni contiene i motivi e gli elenchi, non classi
      if (full === join(SRC, 'lib', 'design-exceptions.ts')) continue
      out.push(full)
    }
  }
  return out
}

export const rel = (p: string): string => relative(SRC, p).split(sep).join('/')
/** Tutto ciò che la guardia vede, per file: OGNI file del renderer, nessuna area esente. */
export function scan(): Array<{ file: string; rule: DesignRule; token: string; text: string }> {
  const out: Array<{ file: string; rule: DesignRule; token: string; text: string }> = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    const exempt = (rule: DesignRule, token: string): string => {
      let t = token
      for (const e of DESIGN_EXCEPTIONS) {
        if (e.rule !== rule) continue
        e.pattern.lastIndex = 0
        t = t.replace(e.pattern, '')
      }
      return t
    }
    for (const value of stringsOf(source)) {
      for (const v of violationsOfString(value, exempt)) out.push({ file: rel(file), rule: v.rule, token: v.token, text: value.length > 90 ? `${value.slice(0, 87)}…` : value })
    }
    // le icone: si guardano dall'AST (l'elemento e le sue classi), non dalle stringhe
    const iconExempt = (token: string): string => {
      let t = token
      for (const e of DESIGN_EXCEPTIONS) { if (e.rule !== 'icon-size') continue; e.pattern.lastIndex = 0; t = t.replace(e.pattern, '') }
      return t
    }
    for (const v of iconViolations(source)) {
      if (iconExempt(`${v.name} ${v.token}`) !== `${v.name} ${v.token}`) continue
      out.push({ file: rel(file), rule: 'icon-size', token: `${v.token} (<${v.name} />, riga ${v.line})`, text: '' })
    }
  }
  return out
}

