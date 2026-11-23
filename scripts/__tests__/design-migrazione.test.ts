// Fase design (DS4): la prova dello script che migra le classi del renderer
// ai token di DS1 (scripts/design-migrazione.mjs). Le regole sono PURE
// (migrateToken, migrateClasses, migrateIconClasses) e la riscrittura del
// sorgente lavora sulle posizioni dell'AST (migrateSource): stringhe, template
// literal, testo JSX e le classi delle icone lucide — mai i commenti.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrateClasses, migrateIconClasses, migrateSource, migrateToken } from '../design-migrazione.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'design-migrazione.mjs')

describe('design-migrazione: le regole, token per token', () => {
  it('le taglie di Tailwind diventano le sei dimensioni (le varianti davanti restano)', () => {
    const map = { 'text-xs': 'text-caption', 'text-sm': 'text-body', 'text-base': 'text-reading', 'text-lg': 'text-title', 'text-xl': 'text-title', 'text-2xl': 'text-page', 'text-3xl': 'text-page' }
    for (const [a, b] of Object.entries(map)) expect(migrateToken(a!), a).toBe(b)
    expect(migrateToken('hover:text-sm')).toBe('hover:text-body')
    expect(migrateToken('md:text-lg')).toBe('md:text-title')
    expect(migrateToken('text-sm/6')).toBe('text-body')
  })
  it('le dimensioni libere in px vanno alla più vicina delle sei', () => {
    for (const [a, b] of [['text-[8px]', 'text-caption'], ['text-[11px]', 'text-caption'], ['text-[12px]', 'text-caption'], ['text-[12.5px]', 'text-small'], ['text-[13px]', 'text-small'], ['text-[13.5px]', 'text-small'], ['text-[14px]', 'text-body'], ['text-[15px]', 'text-body'], ['text-[15.5px]', 'text-body'], ['text-[16px]', 'text-reading'], ['text-[17px]', 'text-reading'], ['text-[19px]', 'text-title'], ['text-[22px]', 'text-title'], ['text-[26px]', 'text-page'], ['text-[44px]', 'text-page']]) expect(migrateToken(a!), a).toBe(b)
    // quelle che NON sono px (relative) restano: le decide la pagina a mano
    expect(migrateToken('text-[0.85em]')).toBe('text-[0.85em]')
  })
  it('l’interlinea scritta a mano esce (ogni dimensione ha la sua), i pesi tornano fra 400, 500 e 600, niente maiuscoletto', () => {
    for (const t of ['leading-relaxed', 'leading-snug', 'leading-none', 'leading-5', 'leading-[1.1]', 'uppercase', 'tracking-wide', 'hover:tracking-tight', 'dark:uppercase']) expect(migrateToken(t), t).toBeNull()
    expect(migrateToken('font-bold')).toBe('font-semibold')
    expect(migrateToken('font-extrabold')).toBe('font-semibold')
    expect(migrateToken('font-light')).toBe('font-normal')
    expect(migrateToken('font-medium')).toBe('font-medium')
    expect(migrateToken('font-display')).toBe('font-display')
  })
  it('tre raggi: le misure di fabbrica e quelle libere vanno a control (fino a 8) o surface; i lati restano', () => {
    for (const t of ['rounded', 'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-[6px]', 'rounded-[8px]', 'rounded-[9px]']) expect(migrateToken(t), t).toBe('rounded-control')
    for (const t of ['rounded-xl', 'rounded-2xl', 'rounded-3xl', 'rounded-[10px]', 'rounded-[22px]']) expect(migrateToken(t), t).toBe('rounded-surface')
    expect(migrateToken('rounded-t-lg')).toBe('rounded-t-control')
    expect(migrateToken('rounded-br-md')).toBe('rounded-br-control')
    expect(migrateToken('sm:rounded-2xl')).toBe('sm:rounded-surface')
    expect(migrateToken('rounded-full')).toBe('rounded-full')
    expect(migrateToken('rounded-none')).toBe('rounded-none')
    expect(migrateToken('rounded-[inherit]')).toBe('rounded-[inherit]')
  })
  it('le spaziature fuori scala vanno al valore più vicino (a parità: in orizzontale il maggiore, in verticale il minore)', () => {
    const map = { 'p-[18px]': 'p-5', 'pt-[60px]': 'pt-16', 'pl-[26px]': 'pl-6', 'mt-[70px]': 'mt-16', 'py-[13px]': 'py-3', '-m-[2px]': '-m-0.5', '-mt-[6px]': '-mt-1.5', 'md:gap-[18px]': 'md:gap-5',
      'px-2.5': 'px-3', 'py-2.5': 'py-2', 'gap-3.5': 'gap-4', 'gap-7': 'gap-8', 'pl-11': 'pl-12', 'pt-14': 'pt-12', 'top-11': 'top-10', 'left-11': 'left-12', 'space-y-2.5': 'space-y-2', '-ml-3.5': '-ml-4', '-top-11': '-top-10',
      'p-section': 'p-section', 'h-control': 'h-control', 'p-4': 'p-4', 'h-7': 'h-7', 'p-[calc(100vw-1rem)]': 'p-[calc(100vw-1rem)]' }
    for (const [a, b] of Object.entries(map)) expect(migrateToken(a!), a).toBe(b)
  })
})

describe('design-migrazione: le stringhe', () => {
  it('solo le liste di classi cambiano: la prosa no, i token che escono spariscono senza lasciare spazi doppi', () => {
    expect(migrateClasses('flex items-center gap-3 text-sm hover:text-lg')).toBe('flex items-center gap-3 text-body hover:text-title')
    expect(migrateClasses('rounded-lg p-4 uppercase tracking-wide leading-relaxed font-bold')).toBe('rounded-control p-4 font-semibold')
    expect(migrateClasses('  text-xs  mt-2 ')).toBe('  text-caption mt-2 ')
    expect(migrateClasses('the rounded corners of the app window')).toBe('the rounded corners of the app window')
    expect(migrateClasses('Salvato ✓')).toBe('Salvato ✓')
  })
  it('le icone lucide: 16 nel testo, 20 nelle testate (sotto i 18 px → 4, da 18 a 28 → 5, oltre restano: sono illustrazioni)', () => {
    expect(migrateIconClasses('size-3.5 shrink-0')).toBe('size-4 shrink-0')
    expect(migrateIconClasses('size-3')).toBe('size-4')
    expect(migrateIconClasses('size-6')).toBe('size-5')
    expect(migrateIconClasses('h-4 w-4')).toBe('h-4 w-4')
    expect(migrateIconClasses('mt-1 size-2')).toBe('mt-1 size-4')
    expect(migrateIconClasses('size-10')).toBe('size-10')
  })
  it('la riscrittura del sorgente: stringhe, template literal, testo JSX e classi delle icone — con le virgolette e le sequenze di fuga intatte; i commenti no', () => {
    const src = [
      "// text-sm e rounded-lg in un commento: restano",
      "const a = 'flex text-sm rounded-lg p-[18px]'",
      'const b = `p-4 ${x ? "gap-7" : "gap-3"} mt-[70px]`',
      'const c = "flex gap-2.5 \\"quoted\\" text-[13px]"',
      'const d = <p className="text-caption rounded" title="rounded">ciao text-xs</p>',
      "import { Search, ChevronLeft } from 'lucide-react'",
      'const e = <Search className="size-3.5 shrink-0" />',
      'const f = <ChevronLeft className="mt-1 size-6 text-muted-foreground" />',
      'const g = <p className="flex items-center">{cond ? "text-xs" : \'rounded-xl\'}</p>'
    ].join('\n')
    const { source, changed } = migrateSource(src)
    expect(source).toBe([
      "// text-sm e rounded-lg in un commento: restano",
      "const a = 'flex text-body rounded-control p-5'",
      'const b = `p-4 ${x ? "gap-8" : "gap-3"} mt-16`',
      'const c = "flex gap-3 \\"quoted\\" text-small"',
      'const d = <p className="text-caption rounded-control" title="rounded">ciao text-xs</p>',
      "import { Search, ChevronLeft } from 'lucide-react'",
      'const e = <Search className="size-4 shrink-0" />',
      'const f = <ChevronLeft className="mt-1 size-5 text-muted-foreground" />',
      'const g = <p className="flex items-center">{cond ? "text-caption" : \'rounded-surface\'}</p>'
    ].join('\n'))
    expect(changed).toHaveLength(9)
  })
  it('una seconda passata non cambia più nulla (è idempotente)', () => {
    const once = migrateSource("const a = 'flex text-xs rounded-lg px-2.5 font-bold uppercase leading-relaxed'").source
    expect(migrateSource(once).changed).toEqual([])
  })
})

describe('design-migrazione: da riga di comando', () => {
  it('--dry conta e NON scrive; senza --file è asciutto per scelta', () => {
    const file = join(ROOT, 'src', 'renderer', 'src', 'components', 'PluginPanel.tsx')
    const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex')
    const before = hash()
    const dry = spawnSync(process.execPath, [SCRIPT, '--file', 'src/renderer/src/components/PluginPanel.tsx', '--dry'], { encoding: 'utf8' })
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stdout).toMatch(/stringhe di classi cambiate: \d+/)
    expect(dry.stdout).toMatch(/--dry: niente scritto/)
    expect(hash()).toBe(before)
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(none.status, none.stderr).toBe(0)
    expect(none.stdout).toMatch(/stringhe di classi cambiate: 0/)
  })
})
