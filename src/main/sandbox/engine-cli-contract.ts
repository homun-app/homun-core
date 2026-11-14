// Fase box-apple-cli-vera (BAV1): il contratto argv ↔ help di una CLI di un
// MOTORE del box, GENERICO. Riceve gli argv di un motore qualunque e le help
// VERE di quel motore (le fixture catturate dalla CLI) e dice se l'argv parla
// la lingua della CLI: niente template Go ({{…}}), --format solo coi valori
// che la help dichiara, opzioni solo quelle che la help elenca per quel
// sottocomando. Apple `container` è il primo a usarla; Podman e WSL2 la
// riusano senza riscriverla.
//
// PURA: nessuno spawn, nessun filesystem — help e argv arrivano da chi chiama.

/** L'esito del contratto per UN argv: niente violazioni = l'argv è VEROfORME. */
export type EngineArgvViolation =
  | { kind: 'go-template'; token: string }
  | { kind: 'format-value'; value: string; allowed: string[] }
  | { kind: 'unknown-option'; option: string; subcommand: string }
  | { kind: 'help-missing'; subcommand: string }

/** La firma di un sottocomando letta dalla sua help: opzioni e valori di --format. */
export interface CliOptionSignature {
  /** `-x` e `--long` ammessi, con l'esito «l'opzione prende un valore». */
  options: Map<string, boolean>
  /** i valori che la help dichiara per --format («(values: json, table, …)»), o null. */
  formatValues: string[] | null
}

/**
 * La firma delle opzioni dalla help VERA (PURa). Le opzioni sono le righe
 * indentate che cominciano con `-`: `-x, --long <v>` (l'angolare dice che
 * l'opzione prende un VALORE: chi controlla un argv salta il token dopo).
 * Gli alias stanno separati da virgola, spazio o `/` (es. `-w, --workdir,
 * --cwd <dir>` e `--enable-kernel-install/--disable-kernel-install`).
 */
export function cliOptionSignature(helpText: string): CliOptionSignature {
  const options = new Map<string, boolean>()
  for (const raw of helpText.split('\n')) {
    const m = /^ {2,}((?:-{1,2}[A-Za-z0-9][\w-]*)(?:[ ,/]+(?:-{1,2}[A-Za-z0-9][\w-]*))*(?:[ ]+<[^>]+>)?).*/.exec(raw)
    if (!m) continue // riga di descrizione (o il proseguo di un'opzione andata a capo)
    const head = m[1]!
    const takesValue = /<[^>]+>\s*$/.test(head.trim())
    for (const token of head.split(/[ ,/]+/)) {
      if (/^-{1,2}[A-Za-z0-9][\w-]*$/.test(token)) options.set(token, takesValue)
    }
  }
  // i valori di --format: la help li dice tra parentesi («values: json, table,
  // yaml, toml; default: table») — fino a «default:», solo parole nude
  let formatValues: string[] | null = null
  const fv = /--format\s+<[^>]+>.*?\(values:\s*([^)]+)\)/.exec(helpText)
  if (fv) {
    formatValues = fv[1]!.split(/default:/)[0]!.split(/[;,]/).map((v) => v.trim()).filter((v) => /^[A-Za-z0-9]+$/.test(v))
  }
  return { options, formatValues }
}

/** Le opzioni di un argv, dopo le parole del sottocomando e fino al primo posizionale. */
function optionsOfArgv(argv: string[], subcommand: string, signature: CliOptionSignature | null): { option: string; value?: string }[] {
  const out: { option: string; value?: string }[] = []
  let i = 0
  // le parole del sottocomando si Saltano ('volume', 'ls' di volume ls)
  for (const w of subcommand.split(' ').filter(Boolean)) {
    if (argv[i] === w) i++
  }
  for (; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--') break // il separatore: tutto il resto è posizionale
    if (!t.startsWith('-')) break // il primo posizionale CHIUDE le opzioni (dopo: il comando del container)
    if (t.startsWith('--') && t.includes('=')) {
      out.push({ option: t.slice(0, t.indexOf('=')), value: t.slice(t.indexOf('=') + 1) })
      continue
    }
    // senza firma (help mancante) si assume che --format prenda un valore,
    // come in tutta la famiglia di CLI: il valore si controlla lo stesso
    const takes = signature?.options.get(t) ?? (t === '--format' ? true : undefined)
    out.push(takes ? { option: t, value: argv[i + 1] } : { option: t })
    if (takes) i++
  }
  return out
}

export interface CheckEngineArgvOptions {
  /** il sottocomando di QUESTO argv (es. 'volume ls'): chi chiama lo conosce. */
  subcommand: string
  /** le help vere del motore, chiave = sottocomando ('run', 'volume ls', …). */
  helps: Record<string, string>
  /**
   * i valori ammessi di --format quando la help del sottocomando non li dice
   * (o manca): per Apple json/table/yaml/toml, dall'errore vero della 1.7.1.
   */
  formatValues?: string[]
  /**
   * i sottocomandi che --format NON lo hanno affatto (la CLI vera lo rifiuta:
   * `inspect --format …` → Error: Unknown option '--format').
   */
  noFormatSubcommands?: string[]
}

/**
 * Il contratto di UN argv contro la help vera del suo sottocomando (PURO).
 * Le violazioni di 'go-template', 'format-value' e 'unknown-option' scattano
 * SEMPRE (sono la lingua della CLI); 'help-missing' dice che il
 * sottocomando non ha help in fixture: le sue opzioni NON si possono
 * controllare — chi chiama lo segnala, la help si cattura dal vivo.
 */
export function checkEngineArgv(argv: string[], opts: CheckEngineArgvOptions): EngineArgvViolation[] {
  const violations: EngineArgvViolation[] = []
  // 1. MAI template Go: la CLI vera li rifiuta ovunque compaiano
  for (const t of argv) {
    if (typeof t === 'string' && t.includes('{{')) violations.push({ kind: 'go-template', token: t })
  }
  const help = opts.helps[opts.subcommand]
  const signature = help !== undefined ? cliOptionSignature(help) : null
  // sottocomando vuoto = argv di SOLO opzioni globali (es. `--version`): niente help da pretendere
  if (signature === null && opts.subcommand !== '') {
    violations.push({ kind: 'help-missing', subcommand: opts.subcommand })
  }
  const formatAllowed = signature?.formatValues ?? opts.formatValues ?? null
  const opts2 = optionsOfArgv(argv, opts.subcommand, signature)
  for (const { option, value } of opts2) {
    if (option === '--format') {
      if (opts.noFormatSubcommands?.includes(opts.subcommand)) {
        violations.push({ kind: 'unknown-option', option, subcommand: opts.subcommand })
        continue
      }
      if (formatAllowed !== null && !(value !== undefined && formatAllowed.includes(value))) {
        violations.push({ kind: 'format-value', value: value ?? '(manca)', allowed: formatAllowed })
      }
    }
    if (signature !== null && !signature.options.has(option)) {
      violations.push({ kind: 'unknown-option', option, subcommand: opts.subcommand })
    }
  }
  return violations
}

/** Le violazioni che contano: le help mancanti si SEGNALANO, non bloccano. */
export function hardViolations(violations: EngineArgvViolation[]): EngineArgvViolation[] {
  return violations.filter((v) => v.kind !== 'help-missing')
}
