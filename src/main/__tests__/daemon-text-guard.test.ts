// Fase 17c (C8): la guardia contro il testo italiano nei sorgenti del daemon,
// del main e degli shared — come unwrapped-text-guard della 17a, ma sui .ts
// del backend. Per ogni StringLiteral e TemplateElement fuori dai commenti e
// dagli argomenti di console.* fallisce se contiene accented italiane OPPURE
// almeno due parole funzionali italiane (la lista IT_WORDS di language.ts),
// e non è nell'allowlist file:simbolo qui sotto (le voci di C7, col motivo).
//
// Nota: come la 17a, la specifica diceva "API del compilatore TypeScript" ma
// il repo ha TypeScript 7 (nativo) senza API JS: si usa @babel/parser, già
// nel grafo di Lingui (stesso AST).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { IT_WORDS } from '../../shared/language'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'locales' || f === '__tests__' || f === 'node_modules' || f === 'out' || f === 'dist') continue
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

// Allowlist esplicita file:simbolo — SOLO le voci di C7 (testo che legge il
// modello, parser, liste di riconoscimento, dati finti, dizionario 17a,
// errori di avvio per lo sviluppatore), col motivo in commento per riga.
const ALLOWLIST: Record<string, string[]> = {
  // parser e liste di riconoscimento (C7): leggono il testo del modello o della pagina
  'src/main/agent/browser-guard.ts': ['COMMIT_WORDS', 'CREDIT_FIELD_WORDS'],
  'src/main/agent/subagents.ts': ['subagentBriefError'],
  'src/main/agent/group-turns.ts': ['parseMentions'],
  // nomi app localizzati → bundle (parser di open_app, C7)
  'src/main/computeruse/index.ts': ['openApp'],
  // dati FINTI dei provider di test (C7): attivi solo con SANDBOT_TEST_FAKE_WEB_SEARCH*
  'src/main/agent/web-tools.ts': ['search'],
  // testo che il modello rilegge (C7, 17b invariato salvo C0)
  'src/main/agent/loop.ts': ['failSubagent', 'runTurn'],
  'src/main/agent/stream-deadline.ts': ['StreamDeadlineError'],
  // descrizioni dei tool: citano il marcatore <messaggio_da_agente> (invariante)
  'src/main/agent/tools.ts': ['toolDefs'],
  // errore d'avvio del main per lo sviluppatore (log)
  'src/main/daemon-client.ts': ['ensureDaemonRunning'],
  // la lista IT_WORDS è il rilevatore stesso (contiene le parole italiane)
  'src/shared/language.ts': ['IT_WORDS'],
  // errori di avvio per lo SVILUPPATORE (C7): validateCatalog lancia al boot
  'src/main/connectors/index.ts': ['validateCatalog', 'loadCatalog'],
  'src/main/templates/index.ts': ['validateTemplate', 'loadTemplates'],
  // titolo presence_return del trigger (blocco <evento> per il modello, 17b)
  'src/daemon/scheduler.ts': ['tickConnectorPolls'],
  'src/daemon/presence.ts': ['handleReturn'],
  // keychain finto dei test (strumento di test, non UI)
  'src/daemon/keychain.ts': ['run'],
}

interface Node {
  type: string
  [k: string]: unknown
}

/** Accented italiane (minuscole e maiuscole). */
const ACCENTED = /[àèéìòùÀÈÉÌÒÙ]/

/** Almeno due parole funzionali IT (token [a-zà-ÿ']+, come il grep di B2). */
function italianWordHits(text: string): number {
  const tokens = text.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []
  return tokens.filter((t) => IT_WORDS.has(t)).length
}

function isConsoleArg(node: Node, parents: Node[]): boolean {
  const call = [...parents].reverse().find((p) => p.type === 'CallExpression') as
    | { callee?: { type?: string; name?: string; object?: { name?: string }; property?: { name?: string } } }
    | undefined
  if (!call) return false
  const c = call.callee
  if (c?.type === 'MemberExpression') {
    return c.object?.name === 'console' || (c.object?.name === 'globalThis' && c.property?.name === 'console')
  }
  return c?.name === 'console' || false
}

/** Il nome della dichiarazione che contiene il nodo (function/const/classe/metodo). */
function enclosingSymbol(node: Node, parents: Node[]): string {
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i]!
    if (p.type === 'FunctionDeclaration' && (p as { id?: { name?: string } }).id?.name) {
      return (p as unknown as { id: { name: string } }).id.name
    }
    if (p.type === 'ClassMethod' || p.type === 'ObjectMethod') {
      const key = (p as { key?: { name?: string } }).key?.name
      if (key) return key
    }
    if (p.type === 'VariableDeclarator') {
      const id = p as { id?: { name?: string } }
      if (id.id?.name) return id.id.name
    }
  }
  return '(module)'
}

function checkFile(path: string): string[] {
  const rel = relative(ROOT, path)
  if (rel === 'src/main/i18n.ts') return [] // dizionario della 17a (escluso per specifica)
  if (rel === 'src/shared/ui-messages.ts') return [] // il catalogo U: l'italiano è la verità
  const code = readFileSync(path, 'utf8')
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
  const errors: string[] = []
  const visit = (node: Node, parents: Node[]): void => {
    const nextParents = [...parents, node]
    let text: string | null = null
    let loc: { line: number } | null = null
    if (node.type === 'StringLiteral') {
      text = node.value as string
      loc = (node.loc as { start: { line: number } }).start
    } else if (node.type === 'TemplateElement') {
      text = (node.value as { cooked: string }).cooked
      loc = (node.loc as { start: { line: number } }).start
    }
    if (text !== null && loc) {
      const insideComment = false // l'AST di babel non contiene i commenti
      const allowed = ALLOWLIST[rel] ?? []
      if (!insideComment && !isConsoleArg(node, parents) && (ACCENTED.test(text) || italianWordHits(text) >= 2)) {
        const symbol = enclosingSymbol(node, nextParents)
        if (!allowed.includes(symbol)) {
          errors.push(`${rel}:${loc.line} (${symbol}) "${text.slice(0, 90)}"`)
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue
      const child = (node as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object' && (c as Node).type) visit(c as Node, nextParents)
      } else if (child && typeof child === 'object' && (child as Node).type) {
        visit(child as Node, nextParents)
      }
    }
  }
  visit(ast.program as unknown as Node, [])
  return errors
}

describe('fase 17c (C8): guardia del testo italiano in main/daemon/shared', () => {
  it('nessun letterale italiano fuori da allowlist/console/commenti', () => {
    const files = [
      ...walk(join(ROOT, 'src/main')),
      ...walk(join(ROOT, 'src/daemon')),
      ...walk(join(ROOT, 'src/shared'))
    ]
    expect(files.length).toBeGreaterThan(50)
    const errors = files.flatMap(checkFile)
    expect(errors).toEqual([])
  })
})
