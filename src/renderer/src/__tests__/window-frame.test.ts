// Fase design (DS3): LA CORNICE DELLA FINESTRA — i tre semafori e le icone
// della barra col centro sulla stessa riga; la testata di OGNI colonna (barra
// di sinistra, area principale, pannelli, pagine) alta 52 px e in cima alla
// finestra; la fascia di trascinamento è tutta quella riga, con i controlli
// no-drag. Le misure vive le fa la sonda fase-design: qui si controlla che il
// sorgente non possa disallinearle — le costanti stanno in un posto solo
// (shared/window-frame.ts: le legge il main per il BrowserWindow e il
// renderer per le testate) e OGNI fascia di trascinamento è una testata.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { COLUMN_HEAD_HEIGHT, SIDEBAR_HEAD_PAD, TRAFFIC_LIGHT_BUTTON, TRAFFIC_LIGHT_PITCH, TRAFFIC_LIGHT_POSITION, TRAFFIC_LIGHT_ROW, TRAFFIC_LIGHTS_WIDTH } from '../../../shared/window-frame'
import { CSS_PATH, SRC, rel, sourceFiles } from './design-scan'

const MAIN_INDEX = fileURLToPath(new URL('../../../main/index.ts', import.meta.url))

describe('DS3: le costanti della cornice', () => {
  it('i semafori al centro della riga di 52: il centro dei loro bottoni è il centro della testata', () => {
    expect(COLUMN_HEAD_HEIGHT).toBe(52)
    expect(TRAFFIC_LIGHT_ROW).toBe(COLUMN_HEAD_HEIGHT / 2)
  })
  it('la prima icona della barra a 12 px dai semafori (tre bottoni da 14, 20 px fra un centro e l’altro)', () => {
    expect(TRAFFIC_LIGHTS_WIDTH).toBe(TRAFFIC_LIGHT_BUTTON + TRAFFIC_LIGHT_PITCH * 2)
    expect(SIDEBAR_HEAD_PAD).toBe(TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHTS_WIDTH + 12)
  })
})

describe('DS3: il main e il renderer leggono la STESSA cornice', () => {
  const MAIN = readFileSync(MAIN_INDEX, 'utf8')
  it('la finestra nasce con la barra del titolo nascosta e la posizione dei semafori presa dalle costanti', () => {
    expect(MAIN).toMatch(/titleBarStyle:\s*'hiddenInset'/)
    expect(MAIN).toMatch(/trafficLightPosition:\s*TRAFFIC_LIGHT_POSITION\b/)
  })
  it('il documento non può scorrere, nemmeno da solo (overflow: clip sul body: focus e scrollIntoView non spostano la finestra)', () => {
    const css = readFileSync(CSS_PATH, 'utf8')
    const body = /@layer base\s*\{[\s\S]*?\bbody\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(body).toMatch(/overflow:\s*clip;/)
    expect(body).not.toMatch(/overflow:\s*hidden;/)
  })
  it('la radice dell’app non scorre nemmeno da sola (overflow-clip): un focus() o un scrollIntoView sui suoi figli non può spostare la finestra', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
    const root = /className="relative flex h-screen w-screen flex-col overflow-(\w+) bg-background text-foreground"/.exec(app)
    expect(root?.[1]).toBe('clip')
  })
  it('la vecchia costante della sola barra (80, scritta a mano) non esiste più: si usa SIDEBAR_HEAD_PAD', () => {
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8'), rel(file)).not.toMatch(/TRAFFIC_LIGHT_INSET/)
    }
  })
})

interface Node {
  type?: string
  [k: string]: unknown
}

/** Il testo fisso dell’attributo `className` di un elemento JSX (stringa o template literal), oppure null. */
const classTextOf = (el: Node): string | null => {
  const attrs = (el.attributes ?? []) as Node[]
  const attr = attrs.find((a) => a.type === 'JSXAttribute' && (a.name as Node | undefined)?.name === 'className')
  const value = attr?.value as Node | undefined
  if (!value) return null
  if (value.type === 'StringLiteral') return String(value.value)
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression as Node
    if (expr.type === 'StringLiteral') return String(expr.value)
    // un template literal: bastano i pezzi fissi
    if (expr.type === 'TemplateLiteral') return (expr.quasis as Node[]).map((q) => String((q.value as { cooked?: unknown }).cooked ?? '')).join(' ')
  }
  return null
}
const attrText = (el: Node, name: string): string | null => {
  const attr = ((el.attributes ?? []) as Node[]).find((a) => a.type === 'JSXAttribute' && (a.name as Node | undefined)?.name === name)
  const value = attr?.value as Node | undefined
  if (!value) return null
  if (value.type === 'StringLiteral') return String(value.value)
  if (value.type === 'JSXExpressionContainer' && (value.expression as Node).type === 'StringLiteral') return String((value.expression as Node).value)
  return '(espressione)'
}

describe('DS3: ogni fascia di trascinamento è una testata (e ogni testata è una fascia)', () => {
  const elements = () => {
    const out: Array<{ file: string; cls: string | null; head: string | null }> = []
    for (const file of sourceFiles(SRC)) {
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        const n = node as Node
        if (n.type === 'JSXOpeningElement') out.push({ file: rel(file), cls: classTextOf(n), head: attrText(n, 'data-col-head') })
        for (const key of Object.keys(n)) {
          if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'errors' || key === 'tokens' || key === 'comments') continue
          const child = n[key]
          if (Array.isArray(child)) for (const c of child) visit(c)
          else if (child && typeof child === 'object') visit(child)
        }
      }
      visit(parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program)
    }
    return out
  }
  const has = (cls: string | null, token: string): boolean => (cls ?? '').split(/\s+/).includes(token)

  it('nessuna fascia alta a mano (60, 48, 44 px): la riga è quella dei 52, dichiarata dal token', () => {
    const bands = elements().filter((e) => has(e.cls, 'drag-region'))
    expect(bands.length, 'le fasce di trascinamento').toBeGreaterThan(3)
    const bad = bands.filter((e) => !has(e.cls, 'h-col-head')).map((e) => `${e.file}: ${e.cls}`)
    expect(bad).toEqual([])
  })
  it('ogni fascia è marcata come testata (data-col-head) e ogni testata è una fascia alta 52', () => {
    const all = elements()
    const noHead = all.filter((e) => has(e.cls, 'drag-region') && e.head === null).map((e) => `${e.file}: ${e.cls}`)
    const noBand = all.filter((e) => e.head !== null && !(has(e.cls, 'drag-region') && has(e.cls, 'h-col-head'))).map((e) => `${e.file} [${e.head}]: ${e.cls}`)
    expect({ noHead, noBand }).toEqual({ noHead: [], noBand: [] })
  })
})
