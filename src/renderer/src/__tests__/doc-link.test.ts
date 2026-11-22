// D6 (fase deleghe): i link nei documenti non rompono la finestra. Il caso
// vero dell'indice del ricettario (lib_1934ffa7 v3): `[Pastiera napoletana](lib_f52c42f6)`
// diventava homun://app/… e will-navigate lo lasciava passare (è nell'origine
// dell'app) — senza estensione l'app intera si ricaricava, con `.md` la
// finestra diventava bianca «Not found». docLinkTarget (puro) decide, il
// componente `a` di DocumentMarkdown esegue: lib_… apre il documento nella
// Libreria, #ancora scorre, http(s) va al browser esterno SENZA navigare,
// /workspace e /box restano PERCORSI (copia), tutto il resto è testo.
import './render-helper-install'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'

const capture = vi.hoisted(() => ({ els: [] as Array<{ type: unknown; props: Record<string, unknown> }> }))
vi.mock('react/jsx-dev-runtime', async (orig) => {
  const m = (await orig()) as Record<string, (...a: unknown[]) => unknown>
  return {
    ...m,
    jsxDEV: (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
      capture.els.push({ type, props })
      return m.jsxDEV!(type, props, ...rest)
    }
  }
})


const { docLinkTarget, DocumentBody } = await import('../components/DocumentMarkdown')

describe('D6: docLinkTarget — la tabella dei casi (puro)', () => {
  it('lib_<id> in ogni forma riconosciuta apre il documento della Libreria', () => {
    expect(docLinkTarget('lib_f52c42f6')).toEqual({ kind: 'doc', id: 'lib_f52c42f6' })
    expect(docLinkTarget('homun://app/lib_f52c42f6')).toEqual({ kind: 'doc', id: 'lib_f52c42f6' })
    expect(docLinkTarget('homun://app/lib_f52c42f6/')).toEqual({ kind: 'doc', id: 'lib_f52c42f6' })
    expect(docLinkTarget('#lib_f52c42f6')).toEqual({ kind: 'doc', id: 'lib_f52c42f6' })
  })

  it('l\'ancora interna scorre alla sezione; http(s) e mailto vanno al browser esterno', () => {
    expect(docLinkTarget('#pastiera')).toEqual({ kind: 'anchor', id: 'pastiera' })
    expect(docLinkTarget('https://ricette.example/pastiera')).toEqual({ kind: 'external', url: 'https://ricette.example/pastiera' })
    expect(docLinkTarget('http://esempio.it')).toEqual({ kind: 'external', url: 'http://esempio.it' })
    expect(docLinkTarget('mailto:chef@example.it')).toEqual({ kind: 'external', url: 'mailto:chef@example.it' })
  })

  it('/workspace/… e /box/… sono PERCORSI del computer dei bot: si mostrano, non si navigano', () => {
    expect(docLinkTarget('/workspace/ricettario/pastiera-napoletana.md')).toEqual({ kind: 'path', path: '/workspace/ricettario/pastiera-napoletana.md' })
    expect(docLinkTarget('/box/home/agent_carte/appunti.md')).toEqual({ kind: 'path', path: '/box/home/agent_carte/appunti.md' })
  })

  it('tutto il resto è testo, MAI navigazione: javascript:, file:, homun://app/x.md, relativi', () => {
    expect(docLinkTarget('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(docLinkTarget('file:///etc/passwd')).toEqual({ kind: 'none' })
    expect(docLinkTarget('homun://app/x.md')).toEqual({ kind: 'none' })
    expect(docLinkTarget('homun://app/')).toEqual({ kind: 'none' })
    expect(docLinkTarget('../x')).toEqual({ kind: 'none' })
    expect(docLinkTarget('pastiera-napoletana.md')).toEqual({ kind: 'none' })
    expect(docLinkTarget('')).toEqual({ kind: 'none' })
    expect(docLinkTarget('   ')).toEqual({ kind: 'none' })
  })
})

// l'indice vero del ricettario, coi suoi tre tipi di link (il testo della
// spec: [Pastiera napoletana](lib_f52c42f6) e
// [pastiera-napoletana.md](/workspace/ricettario/pastiera-napoletana.md))
const INDICE = `# Ricettario

## Dolci
- [Pastiera napoletana](lib_f52c42f6) — il classico della domenica.
- La ricetta completa sta in [pastiera-napoletana.md](/workspace/ricettario/pastiera-napoletana.md).
- Ispirazioni: [raccolta napoletana](https://ricette.example/pastiera).

## Salati
- [Pizza margherita](lib_altra) — la base di tutto.
`

describe('D6: il render dell\'indice — nessun <a> con href relativo, i clic fanno la cosa giusta', () => {
  it('nessun <a> con href RELATIVO nel DOM; lib_ chiede l\'apertura del documento giusto', () => {
    capture.els.length = 0
    const opened: string[] = []
    const html = renderHtml(createElement(DocumentBody, {
      markdown: INDICE,
      headingIds: ['dolci', 'salati'],
      onOpenDoc: (id: string) => { opened.push(id) },
      docExists: (id: string) => id !== 'lib_altra'
    }))
    // NESSUN anchor con href relativo (solo http(s) assoluti possono avere href)
    const tree = parseHtml(html)
    for (const a of findAll(tree, (n) => n.tag === 'a')) {
      const href = String(a.attrs?.href ?? '')
      expect(href === '' || /^https?:|^mailto:/.test(href)).toBe(true)
    }
    // il link lib_ è un BOTTONE che chiede l'apertura di QUEL documento
    const docBtn = capture.els.find((e) => e.props?.['data-testid'] === 'doc-link' && e.props?.['data-doc'] === 'lib_f52c42f6')
    expect(docBtn).toBeTruthy()
    ;(docBtn!.props as { onClick: (ev: unknown) => void }).onClick({ preventDefault: () => undefined })
    expect(opened).toEqual(['lib_f52c42f6'])
    // il documento che NON esiste resta testo col tooltip «documento non trovato»
    expect(html).toContain('documento non trovato')
    // il percorso /workspace è un chip col percorso VISIBILE, non un link
    expect(html).toContain('/workspace/ricettario/pastiera-napoletana.md')
    const pathChip = capture.els.find((e) => e.props?.['data-testid'] === 'doc-path')
    expect(pathChip).toBeTruthy()
    // nessuna emoji nella riga (icone lucide, mai emoji)
    expect(String(tree).match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)).toBeNull()
  })

  it('il link https apre il browser esterno SENZA navigare (window.open, preventDefault)', () => {
    capture.els.length = 0
    const opened: string[] = []
    const winOpen = vi.fn((url: string) => { opened.push(url) })
    const origOpen = (globalThis as { window?: { open?: unknown } }).window
    vi.stubGlobal('window', { ...(origOpen as object ?? {}), open: winOpen })
    try {
      renderHtml(createElement(DocumentBody, {
        markdown: '[raccolta](https://ricette.example/pastiera)',
        onOpenDoc: () => undefined,
        docExists: () => true
      }))
      const ext = capture.els.find((e) => e.type === 'a' && String(e.props?.href ?? '').startsWith('https://'))
      expect(ext).toBeTruthy()
      expect(ext!.props?.target).toBe('_blank')
      expect(ext!.props?.rel).toContain('noopener')
      const ev = { preventDefault: vi.fn() }
      ;(ext!.props as { onClick: (e: unknown) => void }).onClick(ev)
      expect(winOpen).toHaveBeenCalledTimes(1)
      expect(winOpen).toHaveBeenCalledWith('https://ricette.example/pastiera', '_blank', 'noopener')
      expect(ev.preventDefault).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('senza handler (uso interno/test) il render resta valido e nessun href relativo compare', () => {
    const html = renderHtml(createElement(DocumentBody, { markdown: INDICE }))
    const tree = parseHtml(html)
    for (const a of findAll(tree, (n) => n.tag === 'a')) {
      const href = String(a.attrs?.href ?? '')
      expect(href === '' || /^https?:|^mailto:/.test(href)).toBe(true)
    }
    expect(textOf(tree)).toContain('Pastiera napoletana')
  })
})
