// Fase 17a (L7.3): la guardia contro i testi non avvolti. Per ogni .tsx del
// renderer fallisce se trova un JsxText con almeno due lettere fuori da
// <Trans>/<Plural>, o un attributo placeholder/title/aria-label/alt con una
// stringa letterale che contiene lettere. È la rete di sicurezza che
// impedisce di reintrodurre testi fissi.
//
// Fase 17a correzioni (K2): nei .tsx è vietato importare `t` da
// '@lingui/core/macro' — quella `t` legge l'istanza globale al momento del
// render e NON è reattiva al cambio lingua (testi vecchi finché il
// componente non si ri-renderizza per altri motivi). Nei componenti si usa
// `const { t } = useLingui()` da '@lingui/react/macro'; `msg`, `plural` e
// `select` da '@lingui/core/macro' restano ammessi (descriptor a livello di
// modulo e plurali ICU, risolti nel componente).
//
// Fase 17a correzioni (K3): dentro un figlio di <Trans>/<Plural> una
// StringLiteral è un SEGNAPOSTO, non testo da tradurre: se compare come ramo
// di un ternario o di un &&/|| resta italiana anche in inglese. Ternario e
// rami si scrivono FUORI dal testo, come messaggi interi distinti.
//
// Nota: la specifica chiedeva l'API del compilatore TypeScript, ma il repo ha
// TypeScript 7 (nativo), che NON espone l'API JS; si usa @babel/parser, già
// nel grafo delle dipendenze Lingui installate (stesso AST per JSX/TSX).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function walkTsxD(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walkTsxD(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

// Allowlist di marchi, acronimi tecnici e simboli che RESTANO fuori dalle
// macro (identici in ogni lingua):
// - Homun: il nome del prodotto
// - TOTP: acronimo tecnico (Time-based One-Time Password)
// - via: preposizione identica in inglese ("via email")
const ALLOWED_TEXT = new Set(['Homun', 'TOTP', 'via'])
// - HH:MM: formato dell'orario; client_id/client_secret: campi OAuth letterali
const ALLOWED_ATTR = new Set(['HH:MM', 'client_id', 'client_secret'])
// K3: stringhe letterali ammesse come ramo dentro <Trans>/<Plural> —
// 'login'/'secret' in LibraryCards sono i valori tecnici di card.kind,
// identici in inglese (il tipo del modulo sicuro)
const ALLOWED_TRANS_BRANCH = new Set(['login', 'secret'])

interface Node {
  type: string
  [k: string]: unknown
}

function isInsideTrans(parents: Node[]): boolean {
  return parents.some(
    (n) =>
      n.type === 'JSXElement' &&
      (n.openingElement as { name?: { name?: string } }).name?.name !== undefined &&
      ['Trans', 'Plural', 'Select', 'SelectOrdinal'].includes(
        (n.openingElement as { name: { name: string } }).name.name
      )
  )
}

function jsxElementName(el: Node | undefined): string | undefined {
  if (!el || el.type !== 'JSXElement') return undefined
  return (el.openingElement as { name?: { name?: string } }).name?.name
}

/** K2: true se il nodo è un import di `t` da '@lingui/core/macro'. */
function importsCoreMacroT(node: Node): boolean {
  if (node.type !== 'ImportDeclaration') return false
  if ((node.source as { value?: string }).value !== '@lingui/core/macro') return false
  return (node.specifiers as Array<{ type?: string; imported?: { name?: string } }> | undefined)?.some(
    (s) => s.type === 'ImportSpecifier' && s.imported?.name === 't'
  ) ?? false
}

/**
 * K3: le StringLiteral raggiunte scendendo solo per rami di ternari e
 * operands di &&/|| (le comparazioni nei testi dei ternari non sono testo
 * mostrato e non si toccano).
 */
function stringBranches(expr: Node | null | undefined): string[] {
  if (!expr || typeof expr !== 'object') return []
  const out: string[] = []
  const walk = (n: Node): void => {
    if (n.type === 'ConditionalExpression') {
      walk(n.consequent as Node)
      walk(n.alternate as Node)
      return
    }
    if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||')) {
      walk(n.left as Node)
      walk(n.right as Node)
      return
    }
    if (n.type === 'StringLiteral') out.push(String(n.value))
  }
  walk(expr)
  return out
}

function checkSource(src: string): string[] {
  const problems: string[] = []
  const ast = parse(src, {
    plugins: ['typescript', 'jsx'],
    sourceType: 'module'
  })
  const visit = (node: Node, parents: Node[]): void => {
    if (node.type === 'JSXText') {
      const text = (node.value as string).trim()
      const letters = (text.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length
      if (letters >= 2 && !isInsideTrans(parents) && !ALLOWED_TEXT.has(text)) {
        problems.push(`testo non avvolto: "${text.slice(0, 60)}"`)
      }
      return
    }
    if (node.type === 'JSXAttribute') {
      const name = (node.name as { name?: string }).name
      const value = node.value as { type?: string; value?: string } | null
      if (
        name && ['placeholder', 'title', 'aria-label', 'alt'].includes(name) &&
        value?.type === 'StringLiteral' && /[a-zA-ZÀ-ÿ]/.test(value.value ?? '') &&
        !ALLOWED_ATTR.has(value.value ?? '')
      ) {
        problems.push(`attributo ${name} letterale: "${value.value!.slice(0, 60)}"`)
      }
      return
    }
    if (importsCoreMacroT(node)) {
      problems.push("import di `t` da '@lingui/core/macro' in un .tsx: usare `const { t } = useLingui()` da '@lingui/react/macro'")
      return
    }
    if (node.type === 'JSXExpressionContainer') {
      // K3: solo i figli diretti di <Trans>/<Plural> sono testo tradotto
      const parent = parents[parents.length - 1]
      if (['Trans', 'Plural', 'Select', 'SelectOrdinal'].includes(jsxElementName(parent) ?? '')) {
        for (const lit of stringBranches(node.expression as Node)) {
          const letters = (lit.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length
          if (letters >= 2 && !ALLOWED_TRANS_BRANCH.has(lit)) {
            problems.push(`stringa letterale come ramo dentro <${jsxElementName(parent)}>: "${lit.slice(0, 60)}"`)
          }
        }
      }
    }
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object' && 'type' in (c as Node)) visit(c as Node, [...parents, node])
      } else if (child && typeof child === 'object' && 'type' in (child as Node)) {
        visit(child as Node, [...parents, node])
      }
    }
  }
  visit(ast.program as unknown as Node, [])
  return problems
}

function check(file: string): string[] {
  return checkSource(readFileSync(file, 'utf8'))
}

describe('fase 17a (L3): guardia contro i testi non avvolti', () => {
  it('nessun .tsx del renderer ha testo visibile fuori da <Trans>/t', () => {
    const files = walkTsxD(ROOT)
    expect(files.length).toBeGreaterThan(20)
    const failures: string[] = []
    for (const f of files) {
      for (const p of check(f)) failures.push(`${relative(process.cwd(), f)}: ${p}`)
    }
    expect(failures).toEqual([])
  })
})

describe('fase 17a (K2): la t dei .tsx viene dal hook, non dal modulo', () => {
  it("fallisce su un .tsx che importa t da '@lingui/core/macro'", () => {
    const src = "import { t } from '@lingui/core/macro'\nexport const x = () => t`Cerca`\n"
    expect(checkSource(src)).toEqual([
      "import di `t` da '@lingui/core/macro' in un .tsx: usare `const { t } = useLingui()` da '@lingui/react/macro'"
    ])
  })
  it('msg, plural e select da @lingui/core/macro restano ammessi', () => {
    const src = "import { msg, plural, select } from '@lingui/core/macro'\nconst d = msg`Bot`\n"
    expect(checkSource(src)).toEqual([])
  })
  it("useLingui da '@lingui/react/macro' è ammesso", () => {
    const src = "import { useLingui } from '@lingui/react/macro'\nexport const C = () => { const { t } = useLingui(); return t`Cerca` }\n"
    expect(checkSource(src)).toEqual([])
  })
})

describe('fase 17a (K3): niente stringhe italiane come rami dentro <Trans>', () => {
  it('fallisce su una StringLiteral ramo di ternario figlia di <Trans>', () => {
    const src = `const a = () => (
  <Trans>serve: {keys} {kind === 'key' ? '(header)' : '(impostazione del plugin)'}</Trans>
)`
    expect(checkSource(src)).toEqual([
      'stringa letterale come ramo dentro <Trans>: "(header)"',
      'stringa letterale come ramo dentro <Trans>: "(impostazione del plugin)"'
    ])
  })
  it('fallisce su una StringLiteral ramo di && dentro <Trans>', () => {
    const src = `const a = () => (
  <Trans>fiducia: {trust}{untrusted && ' · non verificato'}</Trans>
)`
    expect(checkSource(src)).toEqual([
      'stringa letterale come ramo dentro <Trans>: " · non verificato"'
    ])
  })
  it('fallisce su una StringLiteral ramo di || figlia di <Plural>', () => {
    const src = `const a = () => (
  <Plural value={n} one="# file" other="# file">{x || 'errore'}</Plural>
)`
    expect(checkSource(src)).toEqual([
      'stringa letterale come ramo dentro <Plural>: "errore"'
    ])
  })
  it('le comparazioni nei testi dei ternari non sono testo e non si toccano', () => {
    const src = `const a = () => (
  <Trans>ultima attività {x}{status === 'needs_input' ? t\` — rispondi\` : ''}</Trans>
)`
    expect(checkSource(src).filter((p) => p.includes('ramo'))).toEqual([])
  })
  it('i messaggi interi scelti col ternario fuori dal testo passano', () => {
    const src = `const a = () => (
  <p>{kind === 'key'
    ? <Trans>serve: {keys} (header)</Trans>
    : <Trans>serve: {keys} (variabile d’ambiente)</Trans>}</p>
)`
    expect(checkSource(src)).toEqual([])
  })
})
