// Fase design (DS6): la guardia sul sorgente del renderer. «Un sistema di
// regole piccolo, scritto in un posto solo, che il codice NON PUÒ aggirare»:
// i token sono in styles.css (DS1) e qui si vieta di scrivere a mano ciò che
// i token dovrebbero decidere. La logica (regole, lettura delle stringhe
// dall'AST, scansione) sta in design-scan.ts.
//
// Cosa non deve comparire nei sorgenti del renderer (stringhe di classi,
// template literal, testo JSX — NON i commenti):
//   text-[…]                  — dimensioni di testo libere (eccezione: i colori con var)
//   text-xs … text-9xl        — le taglie di Tailwind: si usano le sei di DS1
//   p-[…] m-[…] gap-[…] …     — spaziature con valore libero: la scala di Tailwind (multipli di 4) o le distanze con un nome
//   rounded-[…]               — raggi liberi
//   rounded, rounded-lg…      — i raggi di fabbrica: restano rounded-control, rounded-surface, rounded-full
//   max-w-[…px], w-[…px]      — larghezze libere in px: le tre di DS1 (o l'area meno i margini)
//   uppercase, tracking-…     — nessun maiuscoletto
//   emoji                     — solo icone lucide nell'interfaccia
// Le eccezioni vivono in UN file (lib/design-exceptions.ts), ognuna con il
// motivo; qui si controlla che nessuna sia morta. Lì sta anche, provvisorio
// fino a fine DS4, l'elenco delle aree non ancora migrate.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_EXCEPTIONS, MIGRATION_PENDING, type DesignRule } from '../lib/design-exceptions'
import { CSS_PATH, SRC, isClassList, rel, scan, sourceFiles, stringsOf, violationsOfString } from './design-scan'

const CSS = readFileSync(CSS_PATH, 'utf8')
const none = (_rule: DesignRule, token: string): string => token

describe('DS6: la guardia sul sorgente del renderer', () => {
  const found = scan()
  const byRule = (rule: DesignRule) => found.filter((x) => x.rule === rule)

  it('nessuna dimensione di testo libera (text-[…]) fuori dalle eccezioni', () => {
    expect(byRule('text-arbitrary').map((x) => `${x.file}: «${x.text}»`)).toEqual([])
  })
  it('nessuna taglia di Tailwind (text-xs … text-9xl): solo le sei dimensioni di DS1', () => {
    expect(byRule('text-tailwind').map((x) => `${x.file}: ${x.token} in «${x.text}»`).slice(0, 40)).toEqual([])
  })
  it('nessuna spaziatura con valore libero (p-[…], m-[…], gap-[…], space-[…])', () => {
    expect(byRule('spacing-arbitrary').map((x) => `${x.file}: ${x.token}`).slice(0, 40)).toEqual([])
  })
  it('nessun raggio libero (rounded-[…])', () => {
    expect(byRule('radius-arbitrary').map((x) => `${x.file}: ${x.token}`).slice(0, 40)).toEqual([])
  })
  it('i raggi sono tre: rounded-control, rounded-surface, rounded-full (niente rounded-lg, rounded-xl…)', () => {
    expect(byRule('radius-other').map((x) => `${x.file}: ${x.token} in «${x.text}»`).slice(0, 40)).toEqual([])
  })
  it('nessuna larghezza libera in px (max-w-[…px], w-[…px])', () => {
    expect(byRule('width-px').map((x) => `${x.file}: ${x.token}`).slice(0, 40)).toEqual([])
  })
  it('nessun maiuscoletto (uppercase, tracking-…)', () => {
    expect(byRule('uppercase-tracking').map((x) => `${x.file}: ${x.token}`).slice(0, 40)).toEqual([])
  })
  it('nessuna emoji nei sorgenti del renderer (solo icone lucide)', () => {
    expect(byRule('emoji').map((x) => `${x.file}: ${x.token} in «${x.text}»`).slice(0, 40)).toEqual([])
  })
  it('styles.css: niente maiuscoletto scritto a mano', () => {
    expect(CSS).not.toMatch(/text-transform:\s*uppercase/)
    expect(CSS).not.toMatch(/letter-spacing:/)
  })

  it('ogni eccezione è VIVA (copre almeno un’occorrenza): un’esenzione morta si toglie', () => {
    // le occorrenze che le eccezioni coprono davvero, rule per rule
    const covered = new Map<string, number>()
    for (const file of sourceFiles(SRC)) {
      for (const value of stringsOf(readFileSync(file, 'utf8'))) {
        if (!isClassList(value)) continue
        for (const token of value.split(/\s+/)) {
          for (const e of DESIGN_EXCEPTIONS) {
            e.pattern.lastIndex = 0
            if (e.pattern.test(token)) covered.set(e.id, (covered.get(e.id) ?? 0) + 1)
          }
        }
      }
    }
    const dead = DESIGN_EXCEPTIONS.filter((e) => !covered.has(e.id)).map((e) => e.id)
    expect(dead).toEqual([])
  })
  it('ogni area «non ancora migrata» esiste davvero (nessuna voce morta nell’elenco provvisorio)', () => {
    const files = sourceFiles(SRC).map(rel)
    const dead = MIGRATION_PENDING.filter((prefix) => !files.some((f) => f.startsWith(prefix)))
    expect(dead).toEqual([])
  })
})

describe('DS6: la guardia vede quello che deve vedere', () => {
  const none = (_rule: DesignRule, token: string): string => token
  it('riconosce ogni regola in una lista di classi (con le varianti davanti)', () => {
    expect(violationsOfString('flex items-center gap-3 text-sm hover:text-lg', none).map((v) => `${v.rule}:${v.token}`)).toEqual(['text-tailwind:text-sm', 'text-tailwind:hover:text-lg'])
    expect(violationsOfString('p-[14px] -m-[2px] md:gap-[calc(100vw-1rem)] space-y-[13px]', none).map((v) => v.token).sort()).toEqual(['-m-[2px]', 'md:gap-[calc(100vw-1rem)]', 'p-[14px]', 'space-y-[13px]'].sort())
    expect(violationsOfString('rounded-[22px] rounded-t-lg rounded sm:rounded-2xl rounded-full rounded-control rounded-surface rounded-none', none).map((v) => `${v.rule}:${v.token}`)).toEqual([
      'radius-arbitrary:rounded-[22px]', 'radius-other:rounded-t-lg', 'radius-other:rounded', 'radius-other:sm:rounded-2xl'
    ])
    expect(violationsOfString('w-[36rem] max-w-[80%] max-w-[36rem] w-[120px] max-w-[720px]', none).map((v) => v.token)).toEqual(['w-[120px]', 'max-w-[720px]'])
    expect(violationsOfString('uppercase tracking-wide hover:tracking-tight text-caption', none).map((v) => v.token)).toEqual(['uppercase', 'tracking-wide', 'hover:tracking-tight'])
    expect(violationsOfString('text-[13px] text-[var(--bubble-user-foreground)]', none).map((v) => v.rule)).toEqual(['text-arbitrary', 'text-arbitrary'])
  })
  it('una stringa che NON è una lista di classi non conta (le emoji sì: stanno in qualunque testo)', () => {
    expect(violationsOfString('the rounded corners of the app window', none)).toEqual([])
    expect(violationsOfString('Salvato ✓', none)).toEqual([])
    expect(violationsOfString('Errore ⚠ nei server', none).map((v) => v.rule)).toEqual(['emoji'])
  })
  it("l'esenzione toglie SOLO ciò che copre (il colore con var), il resto resta", () => {
    const exempt = (rule: DesignRule, token: string): string => {
      let t = token
      for (const e of DESIGN_EXCEPTIONS) if (e.rule === rule) { e.pattern.lastIndex = 0; t = t.replace(e.pattern, '') }
      return t
    }
    expect(violationsOfString('text-[var(--bubble-user-foreground)] text-[13px]', exempt).map((v) => v.token)).toEqual(['text-[13px]'])
  })
  it('le stringhe si leggono dall’AST: i commenti NON contano', () => {
    const src = [
      '// text-sm e rounded-lg in un commento: non è interfaccia',
      'const a = "flex text-sm"',
      'const b = `p-4 ${x ? "gap-7" : "gap-3"}`',
      'const C = () => <p className="text-caption" title="rounded">ciao</p>',
      '/* ⚙ */ const d = "ok"'
    ].join('\n')
    // il template literal: pezzo fisso, poi le stringhe dell'espressione, poi il pezzo fisso finale (vuoto)
    expect(stringsOf(src)).toEqual(['flex text-sm', 'p-4 ', 'gap-7', 'gap-3', '', 'text-caption', 'rounded', 'ciao', 'ok'])
  })
})
