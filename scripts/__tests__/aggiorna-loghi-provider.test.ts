// U5 (fase prima-release): lo script dei loghi NON deve più sovrascrivere
// anthropic.svg e openai.svg — sono i marchi veri di Simple Icons (CC0,
// currentColor) curati a mano, non i logo generici del CDN. La lista di
// esclusione è esportata e lo script la rispetta; l'import NON esegue lo
// script (guardia ESM main), mai rete in un test.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { LOGHI_ESCLUSI, sanitizeSvg } = await import('../aggiorna-loghi-provider.mjs')

const SCRIPT = readFileSync(fileURLToPath(new URL('../aggiorna-loghi-provider.mjs', import.meta.url)), 'utf8')

describe('U5: lo script dei loghi risparmia i due marchi curati a mano', () => {
  it('la lista di esclusione contiene anthropic e openai, col perché nel sorgente', () => {
    expect([...LOGHI_ESCLUSI].sort()).toEqual(['anthropic', 'openai'])
    expect(SCRIPT).toContain('Simple Icons')
    expect(SCRIPT).toContain('ESCLUS')  // il perché sta nel commento della lista
  })

  it('il ciclo dei kind salta quelli esclusi (guardia sul sorgente)', () => {
    // il filtro sta nel loop, non in un angolo morto
    expect(SCRIPT).toMatch(/LOGHI_ESCLUSI\.(has|includes)\(/)
  })

  it('l\'import dello script NON esegue il main (guardia argv): mai fetch in un test', () => {
    expect(SCRIPT).toMatch(/import\.meta\.url[\s\S]{0,120}process\.argv\[1\]/)
  })

  it('sanitizeSvg continua a ripulire (regressione: è esportata e usata)', () => {
    const sporco = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>x()</script><a href="https://evil.example">e</a><circle cx="1" cy="1" r="1"/></svg>'
    const pulito = sanitizeSvg(sporco)
    expect(pulito).not.toContain('<script')
    expect(pulito).not.toContain('onload')
    expect(pulito).not.toContain('https://evil.example')
    expect(pulito).toContain('<circle')
  })
})
