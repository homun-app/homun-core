// Test del formato Agent Skills (fase skill S1): parser YAML vero (js-yaml),
// regole dello standard sui nomi e sulle lunghezze, chiavi sconosciute
// conservate al giro lettura→scrittura, BOM e CRLF.
import { describe, expect, it } from 'vitest'
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
