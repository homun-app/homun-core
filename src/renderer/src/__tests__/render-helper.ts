// RV (fase beta.2) — IL RENDER DEI TEST DEL RENDERER, SENZA DOM: i componenti
// veri resi con react-dom/server (il catalogo IT compilato, come farebbe il
// plugin vite del renderer), l'HTML prodotto PARSED in un albero su cui si
// chiede (botti per nome accessibile, antenati, testi) e — quando serve
// «cliccare» — le props degli elementi resi si catturano mockando il runtime
// JSX (vedi captureJsxMock nel file di test) e invocando il VERO handler.
//
// Perché così e non Testing Library: nel repo non c'è (né jsdom), e i
// vincoli della fase vietano i download — gli altri test del renderer sono
// funzioni pure e guardie sul sorgente; questo è il livello più alto
// raggiungibile offline: componente VERO, store VERO, handler VERO.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { i18n, type Messages } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { messages as itMessages } from '../locales/it/messages.mjs'

/** Attiva il catalogo IT compilato (una volta) e rende l'elemento in HTML. */
export function renderHtml(element: React.ReactElement): string {
  i18n.load('it', itMessages as unknown as Messages)
  i18n.activate('it')
  return renderToStaticMarkup(createElement(I18nProvider, { i18n }, element))
}

/**
 * Lo stato dello store per il RENDER: il server di React usa getServerSnapshot
 * (zustand: getInitialState), quindi si patcha ANCHE lo stato iniziale —
 * così i componenti resi vedono i dati del test e gli handler leggono getState.
 */
export function setStoreStateForRender(
  useStore: { setState(p: unknown): void; getInitialState(): unknown },
  patch: Record<string, unknown>
): void {
  useStore.setState(patch)
  Object.assign(useStore.getInitialState() as Record<string, unknown>, patch)
}

/** Il Dialog di Radix vive in un Portal (sul server: nulla): passante per i test. */
export function dialogPassThroughMock(): Record<string, unknown> {
  const pass = (tag: string) => ({ children, className, ...rest }: { children?: unknown; className?: string } & Record<string, unknown>) =>
    createElement('div', { 'data-mock': tag, className, ...rest }, children as never)
  return {
    Dialog: pass('dialog'),
    DialogContent: pass('dialog-content'),
    DialogTitle: pass('dialog-title'),
    DialogDescription: pass('dialog-description'),
    DialogHeader: pass('dialog-header'),
    DialogFooter: pass('dialog-footer'),
    DialogClose: pass('dialog-close'),
    DialogTrigger: pass('dialog-trigger'),
    DialogOverlay: pass('dialog-overlay'),
    DialogPortal: pass('dialog-portal')
  }
}

// ---- il mini-parser dell'HTML statico di React ----

export interface HtmlNode {
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
  text: string
  parent: HtmlNode | null
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** L'albero dell'HTML statico di React (ben formato, attributi sempre doppi apici). */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], text: '', parent: null }
  let cur = root
  let i = 0
  while (i < html.length) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        i = html.indexOf('-->', i) + 3
        continue
      }
      const end = html.indexOf('>', i)
      const raw = html.slice(i + 1, end)
      i = end + 1
      if (raw.startsWith('/')) {
        if (cur.parent) cur = cur.parent
        continue
      }
      const selfClosing = raw.endsWith('/')
      const body = selfClosing ? raw.slice(0, -1) : raw
      const m = /^([a-zA-Z][\w:-]*)/.exec(body)
      if (!m) continue
      const attrs: Record<string, string> = {}
      for (const a of body.slice(m[0].length).matchAll(/([^\s=/>]+)="([^"]*)"/g)) {
        attrs[a[1]!] = decodeEntities(a[2]!)
      }
      const node: HtmlNode = { tag: m[1]!, attrs, children: [], text: '', parent: cur }
      cur.children.push(node)
      if (!selfClosing && !VOID_TAGS.has(node.tag)) cur = node
    } else {
      const next = html.indexOf('<', i)
      const text = html.slice(i, next === -1 ? html.length : next)
      i = next === -1 ? html.length : next
      cur.text += decodeEntities(text)
    }
  }
  return root
}

/** Visita i nodi in ordine documento (radice compresa). */
export function walk(node: HtmlNode, fn: (n: HtmlNode) => void): void {
  fn(node)
  for (const c of node.children) walk(c, fn)
}

/** Il testo del nodo e di tutti i discendenti (spazi compattati). */
export function textOf(node: HtmlNode): string {
  let out = ''
  walk(node, (n) => {
    out += n.text
  })
  return out.replace(/\s+/g, ' ').trim()
}

/** Il NOME ACCESSIBILE alla buona: aria-label, title, altrimenti il testo. */
export function accessibleName(node: HtmlNode): string {
  return node.attrs['aria-label'] ?? node.attrs['title'] ?? textOf(node)
}

/** Tutti i nodi che soddisfano il predicato. */
export function findAll(root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode[] {
  const out: HtmlNode[] = []
  walk(root, (n) => {
    if (n !== root && pred(n)) out.push(n)
  })
  return out
}

/** true se un ANCESTRO del nodo soddisfa il predicato. */
export function hasAncestor(node: HtmlNode, pred: (n: HtmlNode) => boolean): boolean {
  for (let a = node.parent; a; a = a.parent) if (pred(a)) return true
  return false
}

/** Il primo nodo che contiene esattamente questo testo (comodo per le righe). */
export function findByText(root: HtmlNode, text: string): HtmlNode | null {
  return findAll(root, (n) => textOf(n) === text)[0] ?? null
}
