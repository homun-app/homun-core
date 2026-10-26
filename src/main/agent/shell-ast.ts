// Analisi statica dei comandi shell per il gate dei permessi (§5.1 del report).
//
// Perché web-tree-sitter + grammatica wasm: il binding nativo tree-sitter
// richiederebbe un rebuild per ogni versione di Electron; la versione wasm
// gira identica in dev, nei test (nodo puro) e nell'app impacchettata.
//
// Risoluzione dei file .wasm (scelta documentata):
//   1. env SANDBOT_WASM_DIR — override esplicito (test/CI)
//   2. <process.resourcesPath>/vendor — build impacchettata: electron-builder
//      copia qui la directory vendor/ via extraResources
//   3. <projectRoot>/vendor — dev/test, riempita da scripts/prepare-wasm.mjs
//      (pretest/predev/prebuild)
//   4. <projectRoot>/node_modules/{web-tree-sitter,tree-sitter-bash} — fallback
//      naturale quando vendor/ non è stato preparato (funziona anche dentro
//      l'asar, perché il fs di Electron legge i file asar in modo trasparente)
// Il project root si trova risalendo da import.meta.dirname fino alla directory
// con package.json (src/main/agent → sandbot/, bundle out/main → sandbot/,
// app.asar → radice dell'app).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Parser, Language, type Node as SyntaxNode, type Tree } from 'web-tree-sitter'
import { SECRET_REF } from './secrets'

export interface ShellCommand {
  name: string
  /** Primo argomento non-flag, solo per i tool a sottocomandi (git, npm, ...) */
  sub?: string
  argv: string[]
  /** true se il comando è preceduto da una o più assegnazioni (FOO=x cmd): modifica l'ambiente del comando */
  hasEnvPrefix?: boolean
}

export interface ShellAnalysis {
  commands: ShellCommand[]
  hasSubstitution: boolean
  /**
   * Destinazioni dei redirect di output verso FILE (>, >>, &>, &>> , >|, <>),
   * compresi quelli in comando con heredoc. Le duplicazioni di fd (2>&1, >&2)
   * NON compaiono: non scrivono su file. Il gate esclude le destinazioni
   * innocue (/dev/null, /dev/stdout, /dev/stderr).
   */
  redirectTargets: string[]
  /** Comodo: true se c'è almeno un redirect di output verso file. */
  hasRedirectToFile: boolean
  /** Nomi dei segreti {{secret:NOME}} presenti nella riga (§5.6: mai auto-approvabili). */
  secretRefs: string[]
  parseError: boolean
}

/** Comandi i cui argomenti iniziano con un sottocomando (per la chiave "name sub"). */
export const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'docker', 'kubectl', 'brew', 'pnpm', 'yarn', 'cargo', 'go'
])

const ARGUMENT_TYPES = new Set(['word', 'string', 'raw_string', 'number_literal', 'concatenation'])

function findProjectRoot(start: string): string | null {
  let dir = start
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function wasmCandidates(): Array<{ core: string; bash: string }> {
  const out: Array<{ core: string; bash: string }> = []
  const add = (dir: string) =>
    out.push({
      core: join(dir, 'web-tree-sitter.wasm'),
      bash: join(dir, 'tree-sitter-bash.wasm')
    })
  if (process.env.SANDBOT_WASM_DIR) add(process.env.SANDBOT_WASM_DIR)
  // build impacchettata (Electron): process.resourcesPath è definito solo lì
  if (process.resourcesPath) add(join(process.resourcesPath, 'vendor'))
  const root = findProjectRoot(import.meta.dirname)
  for (const base of [root, process.cwd()]) {
    if (!base) continue
    add(join(base, 'vendor'))
    add(join(base, 'node_modules', 'web-tree-sitter'))
  }
  // il fallback node_modules usa due directory diverse per i due wasm
  if (root) {
    out.push({
      core: join(root, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
      bash: join(root, 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm')
    })
  }
  return out
}

let parserPromise: Promise<Parser> | null = null

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const cand = wasmCandidates().find((c) => existsSync(c.core) && existsSync(c.bash))
      if (!cand) throw new Error('wasm tree-sitter non trovati (web-tree-sitter.wasm / tree-sitter-bash.wasm)')
      await Parser.init({ locateFile: () => cand.core })
      const parser = new Parser()
      // Language.load accetta i byte del wasm: niente fetch/URL, funziona anche
      // dentro l'asar e nei test in nodo puro
      parser.setLanguage(await Language.load(new Uint8Array(readFileSync(cand.bash))))
      return parser
    })()
    // se l'init fallisce (es. wasm mancanti) riprova alla prossima chiamata
    parserPromise.catch(() => { parserPromise = null })
  }
  return parserPromise
}

/** Rimuove le virgolette esterne di un token semplice ("x" / 'x'). */
function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  }
  return text
}

function commandArgv(node: SyntaxNode): string[] {
  const argv: string[] = []
  for (const child of node.namedChildren) {
    // command_name è il primo argomento; variable_assignment (FOO=bar cmd) e
    // i redirect non sono argomenti posizionali
    if (child.type === 'command_name' || ARGUMENT_TYPES.has(child.type)) {
      argv.push(unquote(child.text))
    }
  }
  return argv
}

interface WalkAcc {
  commands: ShellCommand[]
  hasSubstitution: boolean
  redirectTargets: string[]
}

// operatori di redirect che scrivono su file ('>&' con destinazione a parola
// è comunque una scrittura; con fd numerico è una duplicazione, esclusa sotto)
const OUTPUT_REDIRECT_OPS = new Set(['>', '>>', '&>', '&>>', '>|', '<>', '>&'])

function walk(node: SyntaxNode, acc: WalkAcc): void {
  if (node.type === 'command_substitution' || node.type === 'process_substitution') {
    acc.hasSubstitution = true
  }
  if (node.type === 'file_redirect') {
    const dest = node.childForFieldName('destination')
    // destination numerica = duplicazione di fd (2>&1, >&2): innocua, non è un file
    if (dest && dest.type !== 'number') {
      for (let i = 0; i < node.childCount; i++) {
        if (OUTPUT_REDIRECT_OPS.has(node.child(i)!.text)) {
          acc.redirectTargets.push(unquote(dest.text))
          break
        }
      }
    }
  }
  if (node.type === 'command') {
    const nameNode = node.childForFieldName('name')
    const argv = commandArgv(node)
    // FOO=x cmd: le assegnazioni prima del nome modificano l'ambiente del comando
    const hasEnvPrefix = node.namedChildren.some((c) => c.type === 'variable_assignment')
    if (nameNode) {
      const name = unquote(nameNode.text)
      let sub: string | undefined
      if (SUBCOMMAND_TOOLS.has(name)) {
        const arg = argv.slice(1).find((a) => !a.startsWith('-'))
        if (arg) sub = arg
      }
      acc.commands.push({ name, sub, argv, hasEnvPrefix })
    }
  }
  for (let i = 0; i < node.childCount; i++) walk(node.child(i)!, acc)
}

function analyzeTree(tree: Tree, secretRefs: string[]): ShellAnalysis {
  const acc: WalkAcc = { commands: [], hasSubstitution: false, redirectTargets: [] }
  walk(tree.rootNode, acc)
  return {
    commands: acc.commands,
    hasSubstitution: acc.hasSubstitution,
    redirectTargets: acc.redirectTargets,
    hasRedirectToFile: acc.redirectTargets.length > 0,
    secretRefs,
    parseError: tree.rootNode.hasError
  }
}

/**
 * Analizza una riga di comando shell ed estrae OGNI comando semplice
 * (pipeline, ;, &&, ||, subshell, $(...), backtick). Funzione deterministica:
 * stesso input → stesso output, nessun effetto collaterale oltre alla cache
 * (lazy) del parser.
 */
export async function analyzeCommand(src: string): Promise<ShellAnalysis> {
  // i riferimenti ai segreti vivono nella riga grezza, non nell'AST
  const secretRefs = [...new Set([...src.matchAll(SECRET_REF)].map((m) => m[1]!))]
  const parser = await getParser()
  const tree = parser.parse(src)
  if (!tree) {
    return { commands: [], hasSubstitution: false, redirectTargets: [], hasRedirectToFile: false, secretRefs, parseError: true }
  }
  return analyzeTree(tree, secretRefs)
}
