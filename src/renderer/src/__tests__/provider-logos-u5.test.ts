// U5 (fase prima-release): i loghi Anthropic e OpenAI sono i marchi VERI di
// Simple Icons 15.0.0 (CC0), monocromi con fill="currentColor" su fondo
// trasparente — niente piastrella chiara nel tema scuro: prendono il colore
// del testo. Un SOLO componente (ProviderMark) li rende ovunque; gli SVG
// monocromi vanno INLINE (dentro un <img> un SVG non eredita currentColor).
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderHtml } from './render-helper'
import { providerLogoUrl, providerLogoSvg, MONOCHROME_LOGO_KINDS } from '../lib/provider-logos'
import { ProviderMark } from '../components/settings/AddProviderSheet'

const DIR = fileURLToPath(new URL('../assets/provider-logos/', import.meta.url))
const file = (name: string): string => readFileSync(`${DIR}${name}`, 'utf8')

describe('U5: i due file sono i marchi veri, monocromi, senza piastrella', () => {
  it('anthropic.svg e openai.svg hanno fill="currentColor" e niente vecchi colori', () => {
    for (const name of ['anthropic.svg', 'openai.svg']) {
      const svg = file(name)
      expect(svg).toContain('fill="currentColor"')
      // i difetti di prima: la stellina di Claude e il ricalco blu di OpenAI
      expect(svg).not.toContain('#d97757')
      expect(svg).not.toContain('#30302e')
      expect(svg).not.toContain('#0000ff')
      expect(svg).not.toContain('#8080ff')
      expect(svg).not.toContain('#ffffff')
    }
  })

  it('MONOCHROME_LOGO_KINDS sono proprio anthropic e openai (gli altri restano come sono)', () => {
    expect([...MONOCHROME_LOGO_KINDS].sort()).toEqual(['anthropic', 'openai'])
  })

  it('providerLogoSvg torna il contenuto INLINE (per l\'ereditarietà di currentColor), providerLogoUrl resta per gli altri', () => {
    expect(providerLogoSvg('anthropic')).toContain('currentColor')
    expect(providerLogoSvg('openai')).toContain('currentColor')
    expect(providerLogoSvg('mistral')).toBe(null)
    expect(providerLogoUrl('anthropic')).toBeTruthy()
    expect(providerLogoUrl('openai')).toBeTruthy()
  })
})

describe('U5: ProviderMark — monocromi inline col colore del testo, gli altri sulla piastrella di oggi', () => {
  it('anthropic: SVG inline, NESSUNA piastrella dark:bg-white, colore del testo', () => {
    const html = renderHtml(createElement(ProviderMark, { kind: 'anthropic', name: 'Anthropic' }))
    expect(html).toContain('<svg')
    expect(html).not.toContain('dark:bg-white')
    expect(html).not.toContain('<img')
    expect(html).toContain('text-foreground')
  })

  it('openai: come anthropic (inline, senza piastrella)', () => {
    const html = renderHtml(createElement(ProviderMark, { kind: 'openai', name: 'OpenAI' }))
    expect(html).toContain('<svg')
    expect(html).not.toContain('dark:bg-white')
  })

  it('un logo NON monocromo (per esempio openrouter) resta <img> sulla piastrella di oggi', () => {
    const html = renderHtml(createElement(ProviderMark, { kind: 'openrouter', name: 'OpenRouter' }))
    expect(html).toContain('<img')
    expect(html).toContain('dark:bg-white')
  })

  it('senza logo resta l\'iniziale, come oggi', () => {
    const html = renderHtml(createElement(ProviderMark, { kind: 'lmstudio', name: 'LM Studio' }))
    expect(html).toContain('L')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<svg')
  })
})

describe('U5: il README della cartella dice fonte, licenza e regola', () => {
  it('nomina Simple Icons, CC0 e la regola monocromo = currentColor senza piastrella', () => {
    const readme = file('README.md')
    expect(readme).toContain('Simple Icons')
    expect(readme).toContain('CC0')
    expect(readme).toContain('currentColor')
    expect(readme).toContain('nessuna piastrella')
  })
})
