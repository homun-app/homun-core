// G3 (fase fondamenta-galleria): la guardia delle APPROVATE della galleria.
//   · nessuna immagine approvata contiene pixel #ff00ff (il colore pieno delle
//     maschere) TRANNER le scene con una maschera dichiarata (MASCHERE in
//     scripts/galleria.mjs): il quadrato della mascotte di dialogo-nuovo era
//     restato su 54 approvate perché la pulizia non toglieva mai niente —
//     dove il quadrato stava, il confronto era CIECO.
//   · veloce: un solo passaggio magick per file (`+opaque` dipinge di nero
//     tutto ciò che non è esattamente #ff00ff; la media è > 0 se anche un
//     solo pixel puro resta).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'

const QUI = dirname(fileURLToPath(import.meta.url))
const RADICE = join(QUI, '..', '..', '..')
const APPROVATE = join(RADICE, 'galleria', 'approvate')
const MAGICK = '/opt/homebrew/bin/magick'

/** Le scene con una maschera dichiarata: le chiavi dell'oggetto MASCHERE di galleria.mjs. */
function sceneConMaschera(): string[] {
  const sorgente = readFileSync(join(RADICE, 'scripts', 'galleria.mjs'), 'utf8')
  const blocco = sorgente.slice(sorgente.indexOf('const MASCHERE = {'), sorgente.indexOf('\n}', sorgente.indexOf('const MASCHERE = {')))
  return [...blocco.matchAll(/^\s{2}'?([^':\n]+)'?:\s*\[/gm)].map((m) => m[1]!.trim())
}

/** Quanti pixel #ff00ff puri ci sono (come frazione: 0 = nessuno). */
function frazioneMagenta(file: string): number {
  const r = spawnSync(MAGICK, [file, '-alpha', 'off', '-fill', 'black', '+opaque', '#FF00FF', '-format', '%[fx:mean]', 'info:'], { encoding: 'utf8' })
  const v = Number(String(r.stdout ?? '').trim())
  return Number.isFinite(v) ? v : NaN
}

describe('le approvate della galleria non hanno maschere addosso', () => {
  it('nessuna immagine approvata contiene pixel #ff00ff, tranne le scene con maschera dichiarata', { timeout: 60_000 }, () => {
    const conMaschera = new Set(sceneConMaschera())
    const file = readdirSync(APPROVATE).filter((f) => f.endsWith('.png')).sort()
    expect(file.length).toBeGreaterThan(0)
    const sporche: string[] = []
    for (const f of file) {
      // il nome è <scena>-<tema>[-900].png: la scena è ciò che resta
      const m = f.match(/^(.*)-(chiaro|scuro)(-900)?\.png$/)
      const scena = m?.[1] ?? f.replace(/\.png$/, '')
      if (conMaschera.has(scena)) continue
      const fr = frazioneMagenta(join(APPROVATE, f))
      if (!(fr === 0)) sporche.push(`${f} (${Number.isNaN(fr) ? 'magick KO' : `${(fr * 100).toFixed(3)}%`})`)
    }
    expect(sporche, `approvate col magenta delle maschere: ${sporche.join(', ')}`).toEqual([])
  })
})
