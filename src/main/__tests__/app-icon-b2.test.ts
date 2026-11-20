// B2 (fase beta10-correzioni): l'icona nuova dell'app, variante B della tavola
// 7 — «solo gli occhi»: quadrato arrotondato teal #157A6E con due occhi a
// capsula crema #F4F1EE. Test PURI su file: build/icon.svg è la sorgente
// unica, build/icon.png e la manifest escono da scripts/genera-icone.mjs
// (l'Electron del repo in finestra offscreen, nessuna dipendenza npm nuova).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng, px, hex } from './lib/png-decode'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SVG_PATH = join(ROOT, 'build', 'icon.svg')
const PNG_PATH = join(ROOT, 'build', 'icon.png')
const MANIFEST_PATH = join(ROOT, 'build', 'icone-manifest.json')

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

/** geometria esatta della tavola 7 / variante B, tela 1024×1024 */
const QUADRO = { x: 100, y: 100, w: 824, h: 824 }
const OCCHIO_SX = { x: 358, y: 408, w: 92, h: 205 }
const OCCHIO_DX = { x: 574, y: 408, w: 92, h: 205 }
const TEAL = '157a6e'
const CREMA = 'f4f1ee'

type Manifesto = {
  iconSvg?: { sha256?: string }
  iconPng?: { sha256?: string; width?: number; height?: number }
  tray16?: { sha256?: string }
  tray32?: { sha256?: string }
  occhioLarghezzaScala?: number
}

describe('B2: build/icon.svg — la sorgente unica (variante B della tavola 7)', () => {
  it('c\'è, ed è la geometria ESATTA della spec (quadrato teal, due occhi crema)', () => {
    const svg = readFileSync(SVG_PATH, 'utf8')
    expect(svg).toContain('viewBox="0 0 1024 1024"')
    expect(svg).toContain(`<rect x="100" y="100" width="824" height="824" rx="185" fill="#157A6E"/>`)
    expect(svg).toContain(`<rect x="358" y="408" width="92" height="205" rx="46" fill="#F4F1EE"/>`)
    expect(svg).toContain(`<rect x="574" y="408" width="92" height="205" rx="46" fill="#F4F1EE"/>`)
  })
})

describe('B2: build/icon.png — 1024 RGBA, i margini trasparenti, i colori giusti', () => {
  const png = decodePng(readFileSync(PNG_PATH))

  it('è 1024×1024 RGBA', () => {
    expect(png.width).toBe(1024)
    expect(png.height).toBe(1024)
  })

  it('il pixel al centro dell\'icona è teal (il quadrato pieno, tra i due occhi)', () => {
    expect(hex(px(png, 512, 512))).toBe(`${TEAL}@255`)
  })

  it('il pixel al centro di OGNI occhio è crema', () => {
    // centri interi, ben dentro le capsule (niente antialias dei bordi)
    const sx = px(png, Math.round(OCCHIO_SX.x + OCCHIO_SX.w / 2), Math.floor(OCCHIO_SX.y + OCCHIO_SX.h / 2))
    const dx = px(png, Math.round(OCCHIO_DX.x + OCCHIO_DX.w / 2), Math.floor(OCCHIO_DX.y + OCCHIO_DX.h / 2))
    expect(hex(sx)).toBe(`${CREMA}@255`)
    expect(hex(dx)).toBe(`${CREMA}@255`)
  })

  it('i margini restano TRASPARENTI come oggi (il quadrato parte a 100/1024)', () => {
    expect(px(png, 10, 10).a).toBe(0)
    expect(px(png, 1013, 1013).a).toBe(0)
    expect(px(png, 512, 20).a).toBe(0)
  })
})

describe('B2: la manifest di genera-icone — l\'hash di ciò che è generato dall\'SVG', () => {
  it('build/icon.png è quello generato: l\'hash combacia con la manifest', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifesto
    expect(sha256(readFileSync(PNG_PATH))).toBe(m.iconPng?.sha256)
  })

  it('la manifest è legata a QUESTO icon.svg (la sorgente unica)', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifesto
    expect(sha256(readFileSync(SVG_PATH))).toBe(m.iconSvg?.sha256)
  })

  it('la manifest dichiara 1024×1024 per l\'icona', () => {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifesto
    expect(m.iconPng?.width).toBe(1024)
    expect(m.iconPng?.height).toBe(1024)
  })
})
