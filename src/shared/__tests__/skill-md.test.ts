// Test del formato Agent Skills (fase skill S1): parser YAML vero (js-yaml),
// regole dello standard sui nomi e sulle lunghezze, chiavi sconosciute
// conservate al giro lettura→scrittura, BOM e CRLF.
// K1 (fase skill ritocchi): buildSkillMd deve RILEGGERE tutto quello che
// scrive — parse → build → parse con frontmatter identico, anche sui valori
// che il serializzatore a mano rompeva (trattino iniziale, 1e3, mappe annidate
// con a capo, mappe vuote, chiavi col due punti).
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import {
  parseSkillMd, buildSkillMd, isValidSkillName, humanizeSkillName,
  SKILL_NAME_MAX, SKILL_DESCRIPTION_MAX
} from '../skill-md'

describe('S1: nomi validi e non (tabella)', () => {
  const cases: Array<[string, boolean]> = [
    ['ricerca-web', true],
    ['a', true],
    ['a1-b2', true],
    ['pubblica-articolo', true],
    ['Ricerca', false],          // maiuscola
    ['ricerca web', false],      // spazio
    ['ricerca_web', false],      // underscore
    ['-ricerca', false],         // trattino iniziale
    ['ricerca-', false],         // trattino finale
    ['ricerca--web', false],     // doppio trattino
    ['-x', false],
    ['x-', false],
    ['--', false],
    ['-a-', false],
    ['a--b', false],
    ['', false],
    ['x'.repeat(SKILL_NAME_MAX), true],
    ['x'.repeat(SKILL_NAME_MAX + 1), false],
    ['../x', false],
    ['..', false],
    ['a/b', false]
  ]
  for (const [name, ok] of cases) {
    it(`${JSON.stringify(name)} → ${ok}`, () => {
      expect(isValidSkillName(name)).toBe(ok)
    })
  }
})

describe('S1: parse', () => {
  it('frontmatter semplice (le skill di oggi si leggono identiche)', () => {
    const r = parseSkillMd('---\nname: triage-email\ndescription: smista la posta in arrivo\n---\n\n## Passi\n1. leggi\n')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.skill.name).toBe('triage-email')
      expect(r.skill.description).toBe('smista la posta in arrivo')
      expect(r.skill.body).toBe('## Passi\n1. leggi\n')
    }
  })

  it('descrizione su più righe: > (folded) e | (literal)', () => {
    const folded = parseSkillMd('---\nname: r\n\ndescription: >\n  prima riga\n  seconda riga\n---\ncorpo')
    expect(folded.ok).toBe(true)
    if (folded.ok) expect(folded.skill.description).toBe('prima riga seconda riga')
    const literal = parseSkillMd('---\nname: r\ndescription: |\n  prima\n  seconda\n---\ncorpo')
    expect(literal.ok).toBe(true)
    if (literal.ok) expect(literal.skill.description).toBe('prima\nseconda')
  })

  it('license, compatibility, metadata e allowed-tools si leggono', () => {
    const r = parseSkillMd([
      '---',
      'name: data-report',
      'description: report dei dati',
      'license: MIT',
      'compatibility: Claude Code, SandBot',
      'metadata:',
      '  author: somebody',
      '  version: "2"',
      'allowed-tools: [read-file, list-directory]',
      '---',
      'corpo'
    ].join('\n'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.skill.license).toBe('MIT')
      expect(r.skill.compatibility).toBe('Claude Code, SandBot')
      expect(r.skill.metadata).toEqual({ author: 'somebody', version: '2' })
      expect(r.skill.allowedTools).toEqual(['read-file', 'list-directory'])
    }
  })

  it('chiavi SCONOSCIUTE si conservano (anche strutture)', () => {
    const text = [
      '---',
      'name: mistery',
      'description: con chiavi extra',
      'when-to-use: sempre',
      'x-count: 3',
      'nested:',
      '  a: 1',
      '  b: due',
      '---',
      'corpo'
    ].join('\n')
    const r = parseSkillMd(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skill.frontmatter['when-to-use']).toBe('sempre')
    expect(r.skill.frontmatter['x-count']).toBe(3)
    // il giro lettura→scrittura non perde niente: riparsificato, stesso valore
    const rebuilt = parseSkillMd(buildSkillMd(r.skill))
    expect(rebuilt.ok).toBe(true)
    if (rebuilt.ok) {
      expect(rebuilt.skill.frontmatter['when-to-use']).toBe('sempre')
      expect(rebuilt.skill.frontmatter['x-count']).toBe(3)
      expect(rebuilt.skill.frontmatter.nested).toEqual({ a: 1, b: 'due' })
      expect(rebuilt.skill.body).toBe(r.skill.body)
    }
  })

  it('BOM e CRLF non rompono niente', () => {
    const bom = parseSkillMd('\uFEFF---\r\nname: bom-skill\r\ndescription: con bom e crlf\r\n---\r\n\r\ncorpo\r\nsu due righe')
    expect(bom.ok).toBe(true)
    if (bom.ok) {
      expect(bom.skill.name).toBe('bom-skill')
      expect(bom.skill.description).toBe('con bom e crlf')
      expect(bom.skill.body).toBe('corpo\nsu due righe')
    }
  })

  it('descrizione oltre 1024 caratteri → errore con conteggio', () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX + 1)
    const r = parseSkillMd(`---\nname: lunga\ndescription: ${long}\n---\ncorpo`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]!.english).toContain('1024')
  })

  it('compatibility oltre 500 → errore; metadata non stringa → errore', () => {
    const compat = parseSkillMd(`---\nname: c\ndescription: d\ncompatibility: ${'y'.repeat(501)}\n---\ncorpo`)
    expect(compat.ok).toBe(false)
    if (!compat.ok) expect(compat.issues.some((i) => i.english.includes('compatibility'))).toBe(true)
    const meta = parseSkillMd('---\nname: c\ndescription: d\nmetadata:\n  a:\n    b: 1\n---\ncorpo')
    expect(meta.ok).toBe(false)
    if (!meta.ok) expect(meta.issues.some((i) => i.english.includes('metadata'))).toBe(true)
  })

  it('frontmatter mancante / YAML rotto / nome invalido / descrizione vuota', () => {
    expect(parseSkillMd('solo istruzioni').ok).toBe(false)
    const rotto = parseSkillMd('---\nname: [rotto\ndescription: d\n---\ncorpo')
    expect(rotto.ok).toBe(false)
    if (!rotto.ok) expect(rotto.issues[0]!.english).toContain('frontmatter')
    const nome = parseSkillMd('---\nname: NoValid\ndescription: d\n---\ncorpo')
    expect(nome.ok).toBe(false)
    const vuota = parseSkillMd('---\nname: valida\ndescription: ""\n---\ncorpo')
    expect(vuota.ok).toBe(false)
    // più problemi INSIEME (l'editor li mostra tutti)
    const due = parseSkillMd('---\nname: --\ndescription: ""\n---\ncorpo')
    expect(due.ok).toBe(false)
    if (!due.ok) expect(due.issues.length).toBeGreaterThanOrEqual(2)
  })

  it('K10: description che non è testo (un numero) → «la descrizione deve essere testo», NON «mancante»', () => {
    const numero = parseSkillMd('---\nname: con-numero\ndescription: 1e3\n---\ncorpo')
    expect(numero.ok).toBe(false)
    if (!numero.ok) {
      expect(numero.issues.some((i) => i.ui.id === 'skill.descriptionNotText')).toBe(true)
      expect(numero.issues.some((i) => i.ui.id === 'skill.descriptionMissing')).toBe(false)
    }
    const booleano = parseSkillMd('---\nname: con-bool\ndescription: true\n---\ncorpo')
    expect(booleano.ok).toBe(false)
    if (!booleano.ok) expect(booleano.issues.some((i) => i.ui.id === 'skill.descriptionNotText')).toBe(true)
  })
})

describe('S1: build', () => {
  it('roundtrip semplice e descrizione su più righe riscritta come block scalar', () => {
    const built = buildSkillMd({ name: 'multi', description: 'prima\nseconda', body: 'corpo' })
    expect(built).toContain('description: |-\n  prima\n  seconda')
    const r = parseSkillMd(built)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.skill.description).toBe('prima\nseconda')
      expect(r.skill.body).toBe('corpo')
    }
  })

  it('le chiavi sconosciute si riscrivono identiche al giro', () => {
    const original = '---\nname: keep\ndescription: d\nunknown-key: valore\nx-list: [a, b]\n---\ncorpo\ncon righe'
    const parsed = parseSkillMd(original)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const again = parseSkillMd(buildSkillMd(parsed.skill))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.skill.frontmatter).toEqual(parsed.skill.frontmatter)
  })

  it('umanizzazione del nome', () => {
    expect(humanizeSkillName('pubblica-articolo')).toBe('Pubblica articolo')
    expect(humanizeSkillName('rss')).toBe('Rss')
  })
})

describe('K1: il giro parse → build → parse non rompe NIENTE (yaml.dump, JSON_SCHEMA)', () => {
  /** Il giro identico: parse → build → parse, il frontmatter torna uguale. */
  const roundtrip = (fm: string, note = ''): void => {
    const text = `---\n${fm}\n---\nCorpo della skill.`
    const p1 = parseSkillMd(text)
    expect(p1.ok, `primo parse deve riuscire (${note})`).toBe(true)
    if (!p1.ok) return
    const rebuilt = buildSkillMd(p1.skill)
    const p2 = parseSkillMd(rebuilt)
    expect(p2.ok, `il build produce YAML che si rilegge (${note}) — scritto:\n${rebuilt}`).toBe(true)
    if (!p2.ok) return
    expect(p2.skill.frontmatter, `frontmatter identico dopo il giro (${note}) — scritto:\n${rebuilt}`).toEqual(p1.skill.frontmatter)
    expect(p2.skill.body).toBe(p1.skill.body)
    expect(p2.skill.name).toBe(p1.skill.name)
    expect(p2.skill.description).toBe(p1.skill.description)
  }

  // i sei casi che il serializzatore a mano rompeva (tabella della spec K1)
  it('descrizione col trattino iniziale', () => {
    roundtrip('name: con-trattino\ndescription: "- inizia col trattino"', 'trattino iniziale')
  })
  it('descrizione "1e3" resta una stringa (non diventa un numero)', () => {
    roundtrip('name: numero-like\ndescription: "1e3"', '1e3')
  })
  it('metadata con valore su più righe resta una mappa di stringhe', () => {
    roundtrip('name: con-note\ndescription: d\nmetadata: { note: "riga1\\nriga2" }', 'metadata multilinea')
  })
  it('x-homun con mappa annidata a due livelli', () => {
    roundtrip('name: annidata\ndescription: d\nx-homun: { deep: { k: v } }', 'nested deep')
  })
  it('metadata vuota {} resta una mappa vuota (non null)', () => {
    roundtrip('name: vuota\ndescription: d\nmetadata: {}', 'metadata {}')
  })
  it('chiave col due punti', () => {
    roundtrip('name: con-chiave-strana\ndescription: d\n"key: with colon": v', 'chiave col due punti')
  })

  // i casi che già passano: devono continuare a passare
  it('# nella descrizione, allowed-tools vuoto, lista di mappe, stringhe true/null/0, unicode', () => {
    roundtrip('name: casi-ok\ndescription: "usa # per i titoli"\nallowed-tools: []', 'cancelletto + lista vuota')
    roundtrip('name: lista-mappe\ndescription: d\nsteps:\n  - { a: 1 }\n  - { b: due }', 'lista di mappe')
    roundtrip('name: stringhe-finte\ndescription: d\nx-true: "true"\nx-null: "null"\nx-zero: "0"', 'stringhe true/null/0')
    roundtrip('name: unicode\ndescription: "descrizione con àccènti e 記号"\nmetadata: { autore: "José" }', 'unicode')
  })
  it('descrizione di 1024 caratteri', () => {
    roundtrip(`name: lunga-1024\ndescription: ${JSON.stringify('d'.repeat(1024))}`, 'descrizione 1024')
  })

  it('500 frontmatter casuali (PRNG a seme fisso, alfabeto con -:#"\'{}[]|> spazi, a capo e cifre)', () => {
    // PRNG deterministico (LCG a seme fisso): la stessa corsa ogni volta
    let seed = 0x2f6e2b1
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const ALPHABET = '-:#"\'{}[]|> \n0123456789'
    const chars = (max: number): string => {
      const n = Math.floor(rnd() * (max + 1))
      let out = ''
      for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(rnd() * ALPHABET.length)]
      return out
    }
    const randomValue = (depth: number): unknown => {
      const pick = rnd()
      if (pick < 0.55 || depth >= 2) {
        const s = chars(24)
        // i numeri: stringhe di CIFRE brevi (niente perdita di precisione)
        if (/^[0-9]{1,15}$/.test(s) && rnd() < 0.5) return Number(s)
        return s
      }
      if (pick < 0.75) return Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => randomValue(depth + 1))
      const map: Record<string, unknown> = {}
      const n = 1 + Math.floor(rnd() * 3)
      for (let i = 0; i < n; i++) map[chars(8)] = randomValue(depth + 1)
      return map
    }
    for (let i = 0; i < 500; i++) {
      const fm: Record<string, unknown> = {}
      const n = 1 + Math.floor(rnd() * 4)
      for (let k = 0; k < n; k++) fm[chars(8)] = randomValue(0)
      // l'input YAML lo scrive js-yaml (valido per costruzione); buildSkillMd
      // deve rileggerlo identico: il giro è quello vero della finestra
      const fmText = yaml.dump(fm, { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()
      const p1 = parseSkillMd(`---\nname: roundtrip\ndescription: d\n${fmText}\n---\nCorpo.`)
      expect(p1.ok, `caso ${i}: input non parsificabile`).toBe(true)
      if (!p1.ok) continue
      const rebuilt = buildSkillMd(p1.skill)
      const p2 = parseSkillMd(rebuilt)
      expect(p2.ok, `caso ${i}: il build non si rilegge —\n${rebuilt}`).toBe(true)
      if (!p2.ok) continue
      expect(p2.skill.frontmatter, `caso ${i}: frontmatter diverso dopo il giro —\n${rebuilt}`).toEqual(p1.skill.frontmatter)
    }
  })
})
