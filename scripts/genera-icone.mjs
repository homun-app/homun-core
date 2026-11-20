#!/usr/bin/env node
// B2 (fase beta10-correzioni): genera TUTTE le icone dell'app partendo dalla
// sorgente UNICA build/icon.svg (variante B della tavola 7: quadrato teal con
// due occhi crema). Nessuna dipendenza npm nuova: usa l'Electron del repo in
// una finestra NASCOSTA (about:blank) e rasterizza l'SVG su <canvas> —
// toDataURL è deterministico, quindi rigenerare dà gli stessi byte.
//
// Produce:
//   build/icon.png             1024×1024 RGBA, margini trasparenti come oggi
//                              (electron-builder ne ricava l'icns)
//   build/tray-template-16.png quadrato arrotondato NERO con i due occhi
//   build/tray-template-32.png TRASPARENTI (fill-rule evenodd): l'icona
//                              template della barra dei menu, 16 px + 32 @2x
//   build/icone-manifest.json  gli sha256 di sorgente e prodotti (il test
//                              pinna che i file committati siano questi)
//   src/main/tray-icon.generated.ts  i due PNG del tray in base64 (dentro
//                              l'asar: nei files di build c'è solo out/)
//
// Uso: node scripts/genera-icone.mjs [--out DIR] [--icona64 PATH]
//   --out DIR     scrive TUTTI gli output in DIR (le prove di rigenerazione
//                 non toccano build/ e src/)
//   --icona64 P   scrive anche l'icona a 64 px in P (confronto nel Dock)
//
// Il tray NON è un file a parte: la sua forma deriva dalla geometria di
// icon.svg (i tre <rect> letti e riuniti in un <path> unico evenodd). Se gli
// occhi a 16 px spariscono, OCCHI_SCALA li allarga in proporzione intorno al
// centro (il valore usato è nella manifest e nel REPORT).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TMP_BASE = '/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T'
const SVG_PATH = join(ROOT, 'build', 'icon.svg')

// Allargamento degli occhi del TRAY (1 = proporzioni esatte dell'SVG).
// A 16 px gli occhi misurano ~1,4×3,2 px: si valutano dalla mappa alpha
// stampata a fine corsa e si decide (il perché finisce nel REPORT).
const OCCHI_SCALA = 1

const args = process.argv.slice(2)
const outArgIdx = args.indexOf('--out')
const OUT_DIR = outArgIdx >= 0 ? resolve(args[outArgIdx + 1]) : join(ROOT, 'build')
const icona64Idx = args.indexOf('--icona64')
const ICONA64 = icona64Idx >= 0 ? resolve(args[icona64Idx + 1]) : null

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---- 1. la sorgente unica: build/icon.svg ----
const svgApp = readFileSync(SVG_PATH, 'utf8')
const rectRe = /<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="([\d.]+)"\s+fill="#([0-9A-Fa-f]{6})"\s*\/>/g
const rects = [...svgApp.matchAll(rectRe)].map((m) => ({
  x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), r: Number(m[5]), fill: m[6].toUpperCase()
}))
if (rects.length !== 3) throw new Error(`icon.svg: servono 3 <rect> (quadrato + 2 occhi), trovati ${rects.length}`)
const [quadrato, occhio1, occhio2] = rects
if (quadrato.fill !== '157A6E') throw new Error(`icon.svg: il quadrato deve essere #157A6E, è #${quadrato.fill}`)
for (const o of [occhio1, occhio2]) {
  if (o.fill !== 'F4F1EE') throw new Error(`icon.svg: gli occhi devono essere #F4F1EE, sono #${o.fill}`)
  if (o.w !== o.h && o.r !== o.w / 2) throw new Error('icon.svg: gli occhi devono essere capsule (rx = larghezza/2)')
}

// ---- 2. il tray: stessa forma, monocroma, occhi BUCO (fill-rule evenodd) ----
const rrectPath = (x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h / 2)
  const f = (v) => Number(v.toFixed(3))
  return [
    `M${f(x + rr)} ${f(y)}`, `H${f(x + w - rr)}`, `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}`,
    `V${f(y + h - rr)}`, `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}`,
    `H${f(x + rr)}`, `A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)}`,
    `V${f(y + rr)}`, `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)}`, 'Z'
  ].join('')
}
const occhioScala = (o) => {
  const w = o.w * OCCHI_SCALA
  const h = o.h * OCCHI_SCALA
  const cx = o.x + o.w / 2
  const cy = o.y + o.h / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h, r: w / 2 }
}
const e1 = occhioScala(occhio1)
const e2 = occhioScala(occhio2)
const svgTray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path fill="#000000" fill-rule="evenodd" d="${rrectPath(quadrato.x, quadrato.y, quadrato.w, quadrato.h, quadrato.r)} ${rrectPath(e1.x, e1.y, e1.w, e1.h, e1.r)} ${rrectPath(e2.x, e2.y, e2.w, e2.h, e2.r)}"/></svg>`

// ---- 3. l'app Electron temporanea che rasterizza (finestra nascosta) ----
const TMP = mkdtempSync(join(TMP_BASE, 'sandbot-genera-icone-'))
const resultPath = join(TMP, 'risultato.json')
writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'genera-icone', type: 'module', main: 'main.mjs' }, null, 2))
writeFileSync(join(TMP, 'main.mjs'), `// Generatore offscreen: riceve gli SVG via env, rasterizza su canvas e
// restituisce i PNG (base64) con le mappe alpha per la verifica occhi.
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

const cfg = JSON.parse(process.env.GENERA_ICONE_CFG)
app.dock?.hide?.()
app.whenReady().then(async () => {
  let out
  try {
    const win = new BrowserWindow({ show: false, width: 320, height: 240 })
    await win.loadURL('about:blank')
    const render = async (svg, size) => {
      const dataUrl = JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'))
      // niente template literal qui dentro: solo concatenazione, così il
      // sorgente resta leggibile anche generato
      const expr = '(async () => {' +
        'const img = new Image(); ' +
        'img.src = ' + dataUrl + '; ' +
        'await img.decode(); ' +
        "const c = document.createElement('canvas'); " +
        'c.width = ' + size + '; c.height = ' + size + '; ' +
        "const ctx = c.getContext('2d'); " +
        'ctx.drawImage(img, 0, 0, ' + size + ', ' + size + '); ' +
        'const data = ctx.getImageData(0, 0, ' + size + ', ' + size + ').data; ' +
        'const alpha = []; ' +
        'for (let i = 3; i < data.length; i += 4) alpha.push(data[i]); ' +
        "return { png: c.toDataURL('image/png').split(',', 2)[1], alpha }; " +
        '})()'
      return await win.webContents.executeJavaScript(expr)
    }
    out = {
      icon1024: await render(cfg.svgApp, 1024),
      tray16: await render(cfg.svgTray, 16),
      tray32: await render(cfg.svgTray, 32),
      icon64: cfg.want64 ? await render(cfg.svgApp, 64) : null
    }
    app.exit(0)
  } catch (e) {
    out = { error: String(e?.stack ?? e) }
    app.exit(1)
  } finally {
    writeFileSync(cfg.resultPath, JSON.stringify(out))
  }
})
`)

const cfg = { svgApp, svgTray, resultPath, want64: !!ICONA64 }
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const child = spawn(ELECTRON, [TMP], {
  env: { HOME: process.env.HOME, PATH: process.env.PATH, GENERA_ICONE_CFG: JSON.stringify(cfg) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let childLog = ''
child.stdout.on('data', (d) => { childLog += d.toString() })
child.stderr.on('data', (d) => { childLog += d.toString() })
const exitCode = await new Promise((res, rej) => {
  const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; rej(new Error('timeout: Electron del generatore non è uscito (90 s)')) }, 90_000)
  child.on('exit', (c) => { clearTimeout(t); res(c ?? -1) })
  child.on('error', rej)
})
let risultato
try {
  risultato = JSON.parse(readFileSync(resultPath, 'utf8'))
} catch {
  risultato = null
}
rmSync(TMP, { recursive: true, force: true })
if (exitCode !== 0 || !risultato || risultato.error) {
  console.error('genera-icone: Electron uscito con', exitCode, '—', risultato?.error ?? childLog.slice(-800))
  process.exit(1)
}

// ---- 4. i file di output ----
mkdirSync(OUT_DIR, { recursive: true })
const iconPng = Buffer.from(risultato.icon1024.png, 'base64')
const tray16 = Buffer.from(risultato.tray16.png, 'base64')
const tray32 = Buffer.from(risultato.tray32.png, 'base64')
writeFileSync(join(OUT_DIR, 'icon.png'), iconPng)
writeFileSync(join(OUT_DIR, 'tray-template-16.png'), tray16)
writeFileSync(join(OUT_DIR, 'tray-template-32.png'), tray32)
const manifest = {
  generato: 'scripts/genera-icone.mjs — Electron del repo, finestra nascosta, canvas→PNG deterministico',
  occhiScala: OCCHI_SCALA,
  iconSvg: { sha256: sha256(Buffer.from(svgApp, 'utf8')) },
  iconPng: { sha256: sha256(iconPng), width: 1024, height: 1024 },
  tray16: { sha256: sha256(tray16), width: 16, height: 16 },
  tray32: { sha256: sha256(tray32), width: 32, height: 32 }
}
writeFileSync(join(OUT_DIR, 'icone-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const tsDir = outArgIdx >= 0 ? OUT_DIR : join(ROOT, 'src', 'main')
writeFileSync(join(tsDir, 'tray-icon.generated.ts'), `// GENERATO da scripts/genera-icone.mjs partendo da build/icon.svg — NON editare a mano.
// L'icona template della barra dei menu: la STESSA forma dell'app (quadrato
// arrotondato pieno, due occhi TRASPARENTI), monocroma. 16 px + 32 px (@2x).
export const TRAY_TEMPLATE_16_PNG_BASE64 = '${risultato.tray16.png}'

export const TRAY_TEMPLATE_32_PNG_BASE64 = '${risultato.tray32.png}'
`)
if (ICONA64) {
  mkdirSync(resolve(ICONA64, '..'), { recursive: true })
  writeFileSync(ICONA64, Buffer.from(risultato.icon64.png, 'base64'))
}

// ---- 5. la verifica a occhio (letterale): la mappa alpha del 16 px ----
const a = risultato.tray16.alpha
console.log('genera-icone: scritti icon.png (1024), tray-template-16/32.png, icone-manifest.json, tray-icon.generated.ts in', OUT_DIR)
console.log('  sha256 icon.png :', manifest.iconPng.sha256)
console.log('  sha256 tray16   :', manifest.tray16.sha256)
console.log('  sha256 tray32   :', manifest.tray32.sha256)
console.log('mappa alpha del tray 16×16 (0=buco, 255=pieno), per valutare gli occhi:')
for (let y = 0; y < 16; y++) {
  console.log('  ', Array.from({ length: 16 }, (_, x) => String(Math.round(a[y * 16 + x] / 36)).padStart(2)).join(' '))
}
const occhioPx = (o) => ({ x: Math.floor((o.x + o.w / 2) / 1024 * 16), y: Math.floor((o.y + o.h / 2) / 1024 * 16) })
for (const [nome, o] of [['sx', occhio1], ['dx', occhio2]]) {
  const p = occhioPx(o)
  console.log(`  occhio ${nome}: centro px (${p.x},${p.y}) alpha=${a[p.y * 16 + p.x]} (0 = occhio visibile come buco)`)
}
