// Fase 17c (C8), correzioni D4: la guardia contro il testo italiano nei
// sorgenti del daemon, del main e degli shared — come unwrapped-text-guard
// della 17a, ma sui .ts del backend. Per ogni StringLiteral e TemplateElement
// fuori dai commenti e dagli argomenti di console.* fallisce se il letterale
// è italiano secondo isItalianLiteral (accentate, ≥2 parole funzionali IT, o
// ≥1 parola IT_STRONG senza parole EN — la terza regola della 17c-correzioni:
// prima «Nuova email» e «errore del modello: » passavano senza allarme).
//
// L'allowlist è per LETTERALE {file, text}: text è il prefisso esatto della
// stringa (come la stampa la guardia). Una voce che non corrisponde a NESSUN
// letterale fa fallire il test («voce morta»): l'allowlist non marcisce. Per
// SIMBOLO restano solo i tre casi di liste o dati per costruzione (anch'essi
// falliscono se morti); il vecchio permesso per funzione intera copriva tutto
// runTurn — la funzione più lunga del repo — e ogni nuova notice italiana
// scritta lì dentro passava.
//
// Nota: come la 17a, la specifica diceva "API del compilatore TypeScript" ma
// il repo ha TypeScript 7 (nativo) senza API JS: si usa @babel/parser, già
// nel grafo di Lingui (stesso AST).
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { isItalianLiteral, IT_STRONG } from './italian-detection'

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

// Allowlist per LETTERALE: { file, text } con text = prefisso esatto del
// letterale come la guardia lo stampa. Il motivo in commento per ogni voce.
// Fase 18a (E0): le voci dei trigger, delle etichette dei prompt secondari,
// dell'errore interno del loop e del motivo di sospensione del gruppo sono
// SCOMPARSE (testi corretti): restano solo errori di avvio per lo sviluppatore
// e codici invarianti.
const ALLOWED_LITERALS: ReadonlyArray<{ file: string; text: string }> = [
  // marcatori invarianti del prompt: <evento> (fase 6) non si traduce
  { file: 'src/shared/triggers.ts', text: 'evento' },
  { file: 'src/shared/triggers.ts', text: '<evento>' },
  { file: 'src/shared/triggers.ts', text: '</evento>' },
  // marcatori invarianti <messaggio_da_agente>/<messaggio_dal_padre> (fase 7/12)
  { file: 'src/shared/agent-message.ts', text: '<messaggio_da' },
  { file: 'src/shared/agent-message.ts', text: 'messaggio_da' },
  { file: 'src/shared/agent-message.ts', text: '</messaggio_da' },
  // fase 19a (V5): il marcatore invariante della nota dell'utente nella
  // ripresa dopo la presa di controllo (come <messaggio_da_agente>)
  { file: 'src/main/agent/screen.ts', text: '\n\n<nota_utente>' },
  { file: 'src/main/agent/screen.ts', text: '\n</nota_utente>' },
  // descrizione di send_to_agent: cita il marcatore <messaggio_da_agente> (invariante)
  { file: 'src/main/agent/tools.ts', text: 'Sends a message to another bot of the user (delegation' },
  // errori di avvio per lo SVILUPPATORE (lanciano al boot, finiscono nel log)
  { file: 'src/main/connectors/index.ts', text: 'il catalogo non è un array' },
  { file: 'src/main/connectors/index.ts', text: ': non è un oggetto' },
  { file: 'src/main/templates/index.ts', text: 'il template non è un oggetto' },
  { file: 'src/main/templates/index.ts', text: 'roles deve essere un array di stringhe non vuote' },
  { file: 'src/main/templates/index.ts', text: ': non è un oggetto' },
  { file: 'src/main/templates/index.ts', text: ': askUserFor deve essere un array di domande' },
  { file: 'src/main/daemon-client.ts', text: 'il daemon non ha scritto daemon.json entro il timeout' },
  // messaggio del keychain FINTO dei test (strumento di test, non UI)
  { file: 'src/daemon/keychain.ts', text: 'operazione non supportata dal keychain finto' },
  // value del widget dell'onboarding: CODICE del ruolo (lo legge roleTemplates), non testo
  { file: 'src/daemon/onboarding.ts', text: 'lavoro-codice' },
  // nome app localizzato → bundle (parser di open_app, C7)
  { file: 'src/main/computeruse/index.ts', text: 'impostazioni di sistema' },
  // fase 18a (E0): codici del piano box (chiavi del piano sandbox, non testo)
  { file: 'src/main/sandbox/docker-argv.ts', text: 'mount-plugin-mancante' },
  { file: 'src/main/sandbox/docker-argv.ts', text: 'mount-browser-mancante' }
]

// Allowlist per SIMBOLO — SOLO liste o dati per costruzione (D4). Anche queste
// voci falliscono se non coprono più nessun letterale.
const ALLOWED_SYMBOLS: Record<string, string[]> = {
  // il rilevatore stesso contiene le parole italiane (lista per costruzione)
  'src/shared/language.ts': ['IT_WORDS'],
  // R4 (fase app — ritocchi): il glossario degli oggetti delle azioni Composio
  // in italiano (lista per costruzione, come IT_WORDS del rilevatore)
  'src/shared/composio-names.ts': ['ACTION_OBJECTS'],
  // fase catalogo app (P2): le etichette it/en delle categorie nostre — POche
  // e FISSE, dati per costruzione (non testi della UI, che passano da Trans)
  'src/shared/app-catalog/index.ts': ['APP_CATEGORY_LABELS'],
  // fase impostazioni (I4.5): i nomi umani degli strumenti per la pagina
  // Approvazioni — tabella bilingue per costruzione, come ACTION_OBJECTS
  'src/shared/tool-names.ts': ['NAMES', 'PREFIX_NAMES'],
  // lista di riconoscimento dei campi con credenziali (legge la pagina, C7);
  // COMMIT_WORDS non scatta più e NON è in lista: una voce morta fallirebbe
  'src/main/agent/browser-guard.ts': ['CREDENTIAL_FIELD_WORDS'],
  // dati FINTI dei provider di test (attivi solo con SANDBOT_TEST_FAKE_WEB_SEARCH*)
  'src/main/agent/web-tools.ts': ['search'],
  // fase 18a (E0): validazioni del catalogo connettori e dei template al BOOT —
  // errori per lo sviluppatore che finiscono nel log, come le voci per letterale
  // qui sopra (con IT_STRONG allargato scattano i singoli «mancante», «deve»…)
  'src/main/connectors/index.ts': ['validateCatalog', 'loadCatalog'],
  'src/main/templates/index.ts': ['validateTemplate', 'loadTemplates']
}

interface Node {
  type: string
  [k: string]: unknown
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

/** Un letterale italiano trovato (dove, che testo, in che simbolo). */
interface Flagged {
  file: string
  line: number
  text: string
  symbol: string
}

function flagItalianLiterals(): Flagged[] {
  const files = [
    ...walk(join(ROOT, 'src/main')),
    ...walk(join(ROOT, 'src/daemon')),
    ...walk(join(ROOT, 'src/shared'))
  ]
  const flagged: Flagged[] = []
  for (const path of files) {
    const rel = relative(ROOT, path)
    if (rel === 'src/main/i18n.ts') continue // dizionario della 17a (escluso per specifica)
    if (rel === 'src/shared/ui-messages.ts') continue // il catalogo U: l'italiano è la verità
    const code = readFileSync(path, 'utf8')
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })
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
        if (!insideComment && !isConsoleArg(node, parents) && isItalianLiteral(text)) {
          flagged.push({ file: rel, line: loc.line, text, symbol: enclosingSymbol(node, nextParents) })
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
  }
  return flagged
}

describe('fase 17c correzioni (D4): la rilevazione del letterale italiano', () => {
  // gli 8 che prima passavano senza allarme (D4, problema 2)
  it('POSITIVI: le stringhe corte italiane scattano (terza regola, IT_STRONG)', () => {
    const positives = [
      'errore del modello: ',
      'Nuova email',
      'Webhook ricevuto',
      'Evento del calendario in arrivo',
      'handshake col daemon scaduto',
      'utente',
      'codice TOTP',
      'il server "X" richiede i valori A, B: l\'utente li inserisce nelle Impostazioni',
      // fase 18a (E0): le nuove parole di IT_STRONG prendono i residui 17b
      'schedule: espressione cron mancante',
      'schedule: every non valido ("x")',
      'connector_poll: intervalMin deve essere ≥ 2 minuti'
    ]
    for (const p of positives) {
      expect(isItalianLiteral(p), `dovrebbe scattare: "${p}"`).toBe(true)
    }
  })

  it('NEGATIVI: l\'inglese (anche con item italiano esterno) non scatta', () => {
    const negatives = [
      'per day',
      'non-empty value',
      'Sends a message to another bot',
      'model error: x',
      // l'item italiano esterno con l'etichetta inglese NON scatta: New ed
      // email non sono in IT_STRONG (se scattasse, la colpevole esce da IT_STRONG)
      'New email: Fattura'
    ]
    for (const n of negatives) {
      expect(isItalianLiteral(n), `NON dovrebbe scattare: "${n}"`).toBe(false)
    }
  })

  it('IT_STRONG non contiene le parole ambigue vietate (per, non, a, e, i, o, come, data)', () => {
    for (const w of ['per', 'non', 'a', 'e', 'i', 'o', 'come', 'data']) {
      expect(IT_STRONG.has(w), `ambigua in IT_STRONG: "${w}"`).toBe(false)
    }
  })
})

describe('fase 17c (C8+D4): guardia del testo italiano in main/daemon/shared', () => {
  const flagged = flagItalianLiterals()

  it('nessun letterale italiano fuori da allowlist/console/commenti', () => {
    expect(flagged.length).toBeGreaterThan(10) // sanity: la guardia vede davvero
    const errors: string[] = []
    for (const f of flagged) {
      const byLiteral = ALLOWED_LITERALS.some((a) => a.file === f.file && f.text.startsWith(a.text))
      const bySymbol = (ALLOWED_SYMBOLS[f.file] ?? []).includes(f.symbol)
      if (!byLiteral && !bySymbol) {
        errors.push(`${f.file}:${f.line} (${f.symbol}) "${f.text.slice(0, 90)}"`)
      }
    }
    expect(errors).toEqual([])
  })

  it('l\'allowlist per letterale non ha voci MORTE (ogni prefisso copre almeno un letterale)', () => {
    const dead = ALLOWED_LITERALS.filter(
      (a) => !flagged.some((f) => f.file === a.file && f.text.startsWith(a.text))
    )
    expect(dead.map((d) => `${d.file} "${d.text}"`)).toEqual([])
  })

  it('l\'allowlist per simbolo non ha voci MORTE (ogni simbolo copre almeno un letterale)', () => {
    const dead: string[] = []
    for (const [file, symbols] of Object.entries(ALLOWED_SYMBOLS)) {
      for (const s of symbols) {
        if (!flagged.some((f) => f.file === file && f.symbol === s)) dead.push(`${file} ${s}`)
      }
    }
    expect(dead).toEqual([])
  })
})
