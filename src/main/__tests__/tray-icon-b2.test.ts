// B2 (fase beta10-correzioni): l'icona della BARRA DEI MENU diventa la
// versione template monocroma della STESSA forma dell'app (variante B):
// quadrato arrotondato pieno con i due occhi TRASPARENTI (fill-rule
// evenodd), 16 px + 32 px @2x, setTemplateImage. I buffer PNG vivono nel
// modulo GENERATO da scripts/genera-icone.mjs partendo da build/icon.svg.
// Test PURI: decodifica dei buffer + la guardia sul sorgente di tray.ts
// (come le guardie delle sonde: grep mirato, senza importare electron).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodePng, px, hex } from './lib/png-decode'
import {
  TRAY_TEMPLATE_16_PNG_BASE64,
  TRAY_TEMPLATE_32_PNG_BASE64
} from '../tray-icon.generated'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

/** centri degli occhi nella tela 1024, scalati alla dimensione del tray
 * (floor: il punto continuo (6.31, 7.98) sta nel pixel (6,7), non nel round) */
const occhio = (size: number) => ({
  sx: { x: Math.floor(((358 + 92 / 2) / 1024) * size), y: Math.floor(((408 + 205 / 2) / 1024) * size) },
  dx: { x: Math.floor(((574 + 92 / 2) / 1024) * size), y: Math.floor(((408 + 205 / 2) / 1024) * size) }
})

describe('B2: i PNG template del tray — 16 e 32 (@2x), monocromi, occhi buco', () => {
  const p16 = decodePng(Buffer.from(TRAY_TEMPLATE_16_PNG_BASE64, 'base64'))
  const p32 = decodePng(Buffer.from(TRAY_TEMPLATE_32_PNG_BASE64, 'base64'))

  it('il base è 16×16 e la versione @2x è 32×32', () => {
    expect(p16.width).toBe(16)
    expect(p16.height).toBe(16)
    expect(p32.width).toBe(32)
    expect(p32.height).toBe(32)
  })

  it('al centro dell\'icona il quadrato è pieno e NERO (template: la forma conta, il colore è neutro)', () => {
    // (8,4) e (16,8): centro in orizzontale, sopra la fascia degli occhi —
    // lontano da ogni bordo antialiasato del quadrato e dei buchi
    expect(hex(px(p16, 8, 4))).toBe('000000@255')
    expect(hex(px(p32, 16, 8))).toBe('000000@255')
  })

  it('gli occhi sono TRASPARENTI (buchi) in entrambe le versioni', () => {
    const e16 = occhio(16)
    expect(px(p16, e16.sx.x, e16.sx.y).a).toBeLessThan(16)
    expect(px(p16, e16.dx.x, e16.dx.y).a).toBeLessThan(16)
    const e32 = occhio(32)
    expect(px(p32, e32.sx.x, e32.sx.y).a).toBe(0)
    expect(px(p32, e32.dx.x, e32.dx.y).a).toBe(0)
  })

  it('i PNG del tray in build/ sono gli stessi byte del modulo generato', () => {
    const m = JSON.parse(readFileSync(`${ROOT}/build/icone-manifest.json`, 'utf8')) as { tray16?: { sha256?: string }, tray32?: { sha256?: string } }
    expect(sha256(Buffer.from(TRAY_TEMPLATE_16_PNG_BASE64, 'base64'))).toBe(m.tray16?.sha256)
    expect(sha256(Buffer.from(TRAY_TEMPLATE_32_PNG_BASE64, 'base64'))).toBe(m.tray32?.sha256)
  })
})

describe('B2: tray.ts usa l\'immagine template con la @2x (guardia sul sorgente)', () => {
  const TRAY = readFileSync(fileURLToPath(new URL('../tray.ts', import.meta.url)), 'utf8')

  it('l\'icona nasce dai buffer generati, NON più dal PNG base64 generico', () => {
    expect(TRAY).toContain('tray-icon.generated')
    expect(TRAY).not.toContain('iVBORw0KGgo')
  })

  it('aggiunge la rappresentazione @2x (32 px, scaleFactor 2) e la dichiara TEMPLATE', () => {
    expect(TRAY).toMatch(/addRepresentation\(\s*\{\s*scaleFactor:\s*2/)
    expect(TRAY).toContain('setTemplateImage(true)')
  })
})
