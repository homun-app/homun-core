// Fase 17a (L7.3): la guardia contro i testi non avvolti. Per ogni .tsx del
// renderer fallisce se trova un JsxText con almeno due lettere fuori da
// <Trans>/<Plural>, o un attributo placeholder/title/aria-label/alt con una
// stringa letterale che contiene lettere. È la rete di sicurezza che
// impedisce di reintrodurre testi fissi.
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

function check(file: string): string[] {
  const problems: string[] = []
  const ast = parse(readFileSync(file, 'utf8'), {
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
