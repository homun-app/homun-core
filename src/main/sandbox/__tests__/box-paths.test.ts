// Confini dei path del box condiviso (fase 11, punto 1): funzioni PURE con
// filesystem iniettato — nessuna directory reale, nessuna home dell'utente.
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBoxPath, WORKSPACE_ALIAS } from '../box-paths'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-boxpath-test-'))
const ROOT = join(TMP, 'box')
const HOME = join(ROOT, 'home', 'agent_x')
mkdirSync(join(ROOT, 'workspace'), { recursive: true })
mkdirSync(HOME, { recursive: true })
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('resolveBoxPath (puro, confini del box condiviso)', () => {
  it('path RELATIVO risolve sulla home del bot', () => {
    const r = resolveBoxPath('note.md', ROOT, HOME, realpathSync)
    expect(r.ok).toBe(true)
    expect(r.abs).toBe(join(HOME, 'note.md'))
  })

  it('`/workspace` è l\'alias della cartella comune (in entrambe le modalità)', () => {
    expect(resolveBoxPath('/workspace', ROOT, HOME, realpathSync).abs).toBe(join(ROOT, 'workspace'))
    expect(resolveBoxPath('/workspace/progetto/report.md', ROOT, HOME, realpathSync).abs)
      .toBe(join(ROOT, 'workspace', 'progetto', 'report.md'))
    // in docker la radice è /box: stessa forma, radice diversa
    expect(resolveBoxPath('/workspace/r.md', '/box', '/box/home/a', (p) => p).abs).toBe('/box/workspace/r.md')
  })

  it('path ASSOLUTO dentro la radice è ammesso (tutti i bot leggono tutto il box)', () => {
    const r = resolveBoxPath(join(ROOT, 'workspace', 'x.md'), ROOT, HOME, realpathSync)
    expect(r.ok).toBe(true)
    // anche la home di un ALTRO bot: il box è condiviso apposta
    expect(resolveBoxPath(join(ROOT, 'home', 'altro', 'f.md'), ROOT, HOME, realpathSync).ok).toBe(true)
  })

  it('fuori dalla radice → RIFIUTO con motivo chiaro', () => {
    expect(resolveBoxPath('/etc/passwd', ROOT, HOME, realpathSync).ok).toBe(false)
    expect(resolveBoxPath('/etc/passwd', ROOT, HOME, realpathSync).reason).toContain('esce dal box condiviso')
    // radice senza /box come prefisso: /boxy non è /box
    expect(resolveBoxPath('/boxy/x', '/box', '/box/home/a', (p) => p).ok).toBe(false)
  })

  it('path vuoto → rifiuto', () => {
    expect(resolveBoxPath('  ', ROOT, HOME, realpathSync).ok).toBe(false)
  })

  it('../ che esce dalla radice → rifiuto (restare DENTRO il box è lecito: è condiviso)', () => {
    // la home è due livelli sotto la radice: servono tre ../ per uscire
    expect(resolveBoxPath('../../../etc/passwd', ROOT, HOME, realpathSync).ok).toBe(false)
    expect(resolveBoxPath('/workspace/../../../etc/passwd', ROOT, HOME, realpathSync).ok).toBe(false)
    // due ../ arrivano alla radice: dentro il box, ammesso
    expect(resolveBoxPath('../../progetto/x.md', ROOT, HOME, realpathSync).ok).toBe(true)
  })

  it('SYMLINK verso l\'esterno della radice → rifiuto (realpath)', () => {
    const fuori = join(TMP, 'fuori')
    mkdirSync(fuori)
    writeFileSync(join(fuori, 'segreto.txt'), 'x')
    symlinkSync(fuori, join(ROOT, 'workspace', 'link-fuori'))
    expect(resolveBoxPath('link-fuori/segreto.txt', join(ROOT, 'workspace'), join(ROOT, 'workspace'), realpathSync).ok).toBe(false)
    // un symlink INTERNO al box resta ammesso
    symlinkSync(join(ROOT, 'workspace'), join(HOME, 'link-workspace'))
    expect(resolveBoxPath('link-workspace/x.md', ROOT, HOME, realpathSync).ok).toBe(true)
  })

  it('WORKSPACE_ALIAS esportato', () => {
    expect(WORKSPACE_ALIAS).toBe('/workspace')
  })
})
