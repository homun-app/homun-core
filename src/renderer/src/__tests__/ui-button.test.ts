// Fase design (DS2): Button — il bottone UNICO dell'interfaccia, al posto delle
// pillole scritte a mano pagina per pagina («Aggiungi», «Riprova», le icone
// delle testate). Quattro varianti, due altezze (32 / 36 px), due forme
// (pillola o rettangolo) scelte UNA volta per tipo, il solo-icona quadrato.
// Qui si prova la vista resa in node: classi dei token di DS1 (e, col CSS
// compilato da styles.css, nessuna classe morta), l'anello del fuoco solo da
// tastiera, le prop che passano, il clic VERO (capture.els, come
// ui-flat.test.ts), asChild e la className del chiamante che vince.
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { renderHtml, parseHtml, textOf, findAll, type HtmlNode } from './render-helper'
import { compileRenderer, deadClasses } from './tailwind-compile'

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

const { Button, buttonVariants } = await import('../components/ui/button')

const classes = (node: HtmlNode): string[] => (node.attrs.class ?? '').split(/\s+/).filter((t) => t !== '')
const has = (node: HtmlNode, cls: string): boolean => classes(node).includes(cls)
const first = (root: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode => findAll(root, pred)[0]!
const render = (props: Record<string, unknown>, ...children: ReactNode[]): string => renderHtml(createElement(Button, props as never, ...children))
const tree = (html: string): HtmlNode => parseHtml(html)
const buttons = (html: string): HtmlNode[] => findAll(tree(html), (n) => n.tag === 'button')
const button = (html: string): HtmlNode => buttons(html)[0]!
const of = (props: Record<string, unknown>, ...children: ReactNode[]): string[] => classes(button(render(props, ...children)))

beforeEach(() => { capture.els.length = 0 })

/** Ciò che rende riconoscibile ogni variante: fondo, colore del testo, il passaggio del mouse. */
const FIRME: Record<string, string[]> = {
  primary: ['bg-foreground', 'text-background', 'hover:opacity-90'],
  secondary: ['bg-muted', 'text-foreground', 'hover:bg-muted/70'],
  ghost: ['text-muted-foreground', 'hover:bg-muted', 'hover:text-foreground'],
  destructive: ['bg-destructive', 'text-destructive-foreground', 'hover:opacity-90']
}
const VARIANTI = Object.keys(FIRME)

/** Le classi uguali per tutti i bottoni, qualunque variante, taglia e forma. */
const BASE = [
  'inline-flex', 'shrink-0', 'cursor-pointer', 'items-center', 'justify-center', 'gap-2', 'whitespace-nowrap', 'font-medium', 'transition',
  'disabled:pointer-events-none', 'disabled:opacity-50',
  // il testo è il default dell'interfaccia (14/20) e le icone 16 px
  'text-body', '[&_svg]:size-4', '[&_svg]:shrink-0',
  'outline-none', 'focus-visible:ring-2', 'focus-visible:ring-ring', 'focus-visible:ring-offset-2', 'focus-visible:ring-offset-background'
]

describe('DS2: Button — le varianti', () => {
  it.each([...VARIANTI, 'default'])('%s: le sue classi di fondo e colore, e nessuna delle altre varianti', (variante) => {
    const props = variante === 'default' ? {} : { variant: variante }
    const firma = FIRME[variante === 'default' ? 'primary' : variante]!
    const cls = of(props, 'Salva')
    for (const own of firma) expect(cls, own).toContain(own)
    for (const other of VARIANTI) {
      if (firma === FIRME[other]) continue
      for (const token of FIRME[other]!) {
        if (!firma.includes(token)) expect(cls, `${variante} non ha ${token} (è di ${other})`).not.toContain(token)
      }
    }
    // primary e destructive sono PIENI, secondary ha un fondo; ghost da fermo non ha nessun colore di fondo
    const fondi = cls.filter((c) => /^bg-/.test(c))
    expect(fondi.sort()).toEqual((variante === 'ghost' ? [] : [firma[0]!]).sort())
  })

  it('le classi di base sono uguali per tutte le varianti, anche col solo-icona', () => {
    for (const variant of VARIANTI) {
      for (const icon of [false, true]) {
        const cls = of({ variant, icon, 'aria-label': 'x' }, createElement(X))
        for (const b of BASE) expect(cls, `${variant}${icon ? ' icona' : ''}: ${b}`).toContain(b)
      }
    }
  })

  it('nessuna classe morta: ogni classe che Button può mettere nell’HTML ha la sua regola nel CSS compilato da styles.css', async () => {
    // in node un nome sbagliato non si vede: h-controlsm starebbe nell'HTML e non farebbe nulla
    const tutte = new Set<string>()
    for (const variant of VARIANTI) {
      for (const size of ['sm', 'md']) {
        for (const icon of [false, true]) {
          for (const shape of [undefined, 'pill', 'control']) {
            const cls = of({ variant, size, icon, shape, 'aria-label': 'x' }, ...(icon ? [createElement(X)] : ['x']))
            for (const c of cls) tutte.add(c)
          }
        }
      }
    }
    expect(tutte.size).toBeGreaterThan(30)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, tutte)).toEqual([])
    // il controllo non è vuoto: un nome sbagliato lo vede
    expect(deadClasses(css, [...tutte, 'h-controlsm'])).toEqual(['h-controlsm'])
  })
})

describe('DS2: Button — taglia e forma', () => {
  it('due altezze: sm 32 px col respiro laterale di 12 px; md (il default) 36 px con 16 — e nessun respiro verticale: l’altezza è la misura', () => {
    const sm = of({ size: 'sm' }, 'x')
    expect(sm).toContain('h-control-sm')
    expect(sm).toContain('px-3')
    expect(sm).not.toContain('h-control')
    expect(sm).not.toContain('px-4')
    for (const props of [{}, { size: 'md' }]) {
      const md = of(props, 'x')
      expect(md).toContain('h-control')
      expect(md).toContain('px-4')
      expect(md).not.toContain('h-control-sm')
      expect(md).not.toContain('px-3')
    }
    expect(sm.concat(of({}, 'x')).filter((c) => /^py-|^pt-|^pb-/.test(c))).toEqual([])
  })

  it('la forma si decide UNA volta per tipo: primary è una pillola (rounded-full), secondary, ghost e destructive sono rettangolari (rounded-control)', () => {
    for (const props of [{}, { variant: 'primary' }]) {
      expect(of(props, 'x')).toContain('rounded-full')
      expect(of(props, 'x')).not.toContain('rounded-control')
    }
    for (const variant of ['secondary', 'ghost', 'destructive']) {
      expect(of({ variant }, 'x')).toContain('rounded-control')
      expect(of({ variant }, 'x')).not.toContain('rounded-full')
    }
  })

  it('la forma data da fuori vince sulla scelta di tipo: resta una classe di raggio sola', () => {
    const piatto = of({ shape: 'control' }, 'x')
    expect(piatto).toContain('rounded-control')
    expect(piatto).not.toContain('rounded-full')
    const pillola = of({ variant: 'secondary', shape: 'pill' }, 'x')
    expect(pillola).toContain('rounded-full')
    expect(pillola).not.toContain('rounded-control')
  })

  it('solo icona: quadrato quanto alto (w- = h-), nessun respiro laterale; sm è 32 per 32', () => {
    const md = of({ icon: true, 'aria-label': 'Chiudi' }, createElement(X))
    expect(md).toContain('w-control')
    expect(md).toContain('h-control')
    expect(md.filter((c) => /^p[xytrbl]?-/.test(c))).toEqual([])
    // dentro c'è l'svg e nient'altro (né etichette, né spazi)
    const btn = button(render({ icon: true, 'aria-label': 'Chiudi' }, createElement(X)))
    expect(btn.children.map((c) => c.tag)).toEqual(['svg'])
    const sm = of({ icon: true, size: 'sm' }, createElement(X))
    expect(sm).toContain('w-control-sm')
    expect(sm).toContain('h-control-sm')
    expect(sm).not.toContain('w-control')
  })

  it('solo icona: ghost è tondo come le icone delle testate; primary resta la pillola; secondary e destructive restano rettangolari', () => {
    const icona = (props: Record<string, unknown>): string[] => of({ icon: true, ...props }, createElement(X))
    expect(icona({ variant: 'ghost' })).toContain('rounded-full')
    expect(icona({ variant: 'ghost' })).not.toContain('rounded-control')
    expect(icona({})).toContain('rounded-full')
    for (const variant of ['secondary', 'destructive']) {
      expect(icona({ variant })).toContain('rounded-control')
      expect(icona({ variant })).not.toContain('rounded-full')
    }
    // e anche qui la forma data vince
    expect(icona({ variant: 'ghost', shape: 'control' })).toContain('rounded-control')
    expect(icona({ variant: 'ghost', shape: 'control' })).not.toContain('rounded-full')
  })
})

describe('DS2: Button — fuoco, stato, attributi', () => {
  it('l’anello del fuoco SOLO da tastiera: le classi dell’anello sono tutte focus-visible:, nessuna classe focus: (scatterebbe anche al clic)', () => {
    for (const variant of VARIANTI) {
      const cls = of({ variant }, 'x')
      expect(cls.filter((c) => c.startsWith('focus-visible:')).sort(), variant).toEqual([
        'focus-visible:ring-2', 'focus-visible:ring-offset-2', 'focus-visible:ring-offset-background', 'focus-visible:ring-ring'
      ])
      expect(cls.filter((c) => c.split(':').includes('focus')), variant).toEqual([])
      // l'outline nativo è spento: l'anello lo fa il ring, solo da tastiera
      expect(cls).toContain('outline-none')
    }
  })

  it('disabled passa attraverso al <button>', () => {
    expect(button(render({ disabled: true }, 'Salva')).attrs.disabled).toBe('')
    expect(button(render({}, 'Salva')).attrs.disabled).toBeUndefined()
  })

  it('type="button" di default: senza tipo un bottone dentro un form (il campo di scrittura) INVIA; il tipo dato da fuori resta il suo', () => {
    expect(button(render({}, 'x')).attrs.type).toBe('button')
    expect(button(render({ type: 'submit' }, 'x')).attrs.type).toBe('submit')
    expect(button(render({ type: 'reset' }, 'x')).attrs.type).toBe('reset')
  })

  it('le altre prop passano attraverso al <button> (nome accessibile, testid, titolo…)', () => {
    const btn = button(render({ 'aria-label': 'Aggiungi', 'data-testid': 'plugin-add', title: 'Plugin', tabIndex: 0, form: 'composer' }, 'x'))
    expect(btn.attrs['aria-label']).toBe('Aggiungi')
    expect(btn.attrs['data-testid']).toBe('plugin-add')
    expect(btn.attrs.title).toBe('Plugin')
    expect(btn.attrs.tabindex).toBe('0')
    expect(btn.attrs.form).toBe('composer')
    expect(textOf(btn)).toBe('x')
  })

  it('il clic chiama il VERO onClick del chiamante, con il suo evento', () => {
    const onClick = vi.fn()
    render({ onClick, 'data-testid': 'bottone' }, 'Salva')
    const captured = capture.els.find((e) => e.type === 'button' && e.props['data-testid'] === 'bottone')!
    const event = { type: 'click' }
    ;(captured.props.onClick as (e: unknown) => void)(event)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(event)
  })
})

describe('DS2: Button — asChild e className', () => {
  it('asChild: rende il FIGLIO (un link resta un link) con le classi del bottone; nessun bottone intorno, nessun tipo che non gli spetta', () => {
    const html = render({ asChild: true }, createElement('a', { href: '/plugin', className: 'mt-2' }, 'Apri'))
    expect(buttons(html)).toEqual([])
    const link = first(tree(html), (n) => n.tag === 'a')
    expect(link.attrs.href).toBe('/plugin')
    expect(link.attrs.type).toBeUndefined()
    expect(textOf(link)).toBe('Apri')
    for (const cls of ['bg-foreground', 'text-background', 'rounded-full', 'h-control', 'text-body', 'mt-2']) {
      expect(has(link, cls), cls).toBe(true)
    }
  })

  it('asChild con un <button> figlio: riceve il type="button" di default, come il bottone suo', () => {
    expect(button(render({ asChild: true }, createElement('button', null, 'x'))).attrs.type).toBe('button')
  })

  it('className del chiamante viene DOPO le classi del bottone e vince su ciò che sovrascrive (forma, altezza, respiro, colori): una classe sola per cosa', () => {
    const cls = of({ className: 'rounded-control h-control-sm px-3 bg-destructive text-destructive-foreground mt-2' }, 'x')
    expect(cls.indexOf('mt-2')).toBeGreaterThan(cls.indexOf('hover:opacity-90'))
    for (const c of ['rounded-control', 'h-control-sm', 'px-3', 'bg-destructive', 'text-destructive-foreground', 'mt-2']) {
      expect(cls, c).toContain(c)
    }
    for (const c of ['rounded-full', 'h-control', 'px-4', 'bg-foreground', 'text-background']) {
      expect(cls, `non più ${c}`).not.toContain(c)
    }
    // ciò che il chiamante non tocca resta
    expect(cls).toContain('text-body')
    expect(cls).toContain('hover:opacity-90')
  })

  it('className può cambiare la taglia del testo: text-caption vince su text-body, il colore della variante resta', () => {
    const cls = of({ className: 'text-caption' }, 'x')
    expect(cls).toContain('text-caption')
    expect(cls).not.toContain('text-body')
    expect(cls).toContain('text-background')
  })

  it('buttonVariants da solo dà le classi del bottone, con la forma di tipo e quella data', () => {
    const variantOf = (props: Record<string, unknown>): string[] => (buttonVariants(props as never) ?? '').split(/\s+/)
    expect(variantOf({ variant: 'primary' })).toContain('rounded-full')
    expect(variantOf({ variant: 'secondary' })).toContain('rounded-control')
    expect(variantOf({ variant: 'ghost', icon: true })).toContain('rounded-full')
    expect(variantOf({ variant: 'primary', shape: 'control' })).toContain('rounded-control')
    expect(variantOf({ variant: 'secondary', size: 'sm' })).toContain('h-control-sm')
    expect(variantOf({ className: 'mt-2' })).toContain('mt-2')
  })
})

describe('K2 (fase conversione-chat): Button link — il bottone di PAROLE', () => {
  it('niente riquadro: in linea, senza altezza, respiro e peso suoi — e SENZA taglia: prende quella del testo in cui sta', () => {
    const cls = of({ variant: 'link' }, 'chiudi')
    for (const k of ['inline', 'h-auto', 'px-0', 'font-normal', 'whitespace-normal']) expect(cls, k).toContain(k)
    for (const k of ['inline-flex', 'h-control', 'h-control-sm', 'px-3', 'px-4', 'font-medium', 'whitespace-nowrap']) expect(cls, k).not.toContain(k)
    expect(cls.filter((c) => /^text-(?:caption|small|body|reading|title|page|xs|sm|base|lg|xl)$/.test(c))).toEqual([])
  })

  it('nel colore dei link, sottolineato al passaggio; mai un fondo', () => {
    const cls = of({ variant: 'link' }, 'x')
    for (const k of ['text-primary', 'underline-offset-2', 'hover:underline']) expect(cls, k).toContain(k)
    expect(cls.filter((c) => c.startsWith('bg-'))).toEqual([])
  })

  it('le quattro varianti a riquadro restano com’erano: il testo è il corpo (14/20), con o senza icona', () => {
    for (const variant of VARIANTI) for (const icon of [false, true]) expect(of({ variant, icon, 'aria-label': 'x' }, ...(icon ? [createElement(X)] : ['x']))).toContain('text-body')
  })

  it('asChild veste un link: resta un <a> con le classi del bottone di parole — nessun bottone intorno', () => {
    const html = render({ variant: 'link', asChild: true }, createElement('a', { href: 'https://example.it', 'data-testid': 'link' }, 'repository'))
    expect(buttons(html)).toHaveLength(0)
    const a = first(tree(html), (n) => n.attrs['data-testid'] === 'link')
    expect(a.tag).toBe('a')
    for (const k of ['text-primary', 'inline', 'h-auto']) expect(classes(a), k).toContain(k)
  })

  it('nessuna classe morta', async () => {
    const tutte = new Set<string>()
    for (const size of ['sm', 'md']) for (const c of of({ variant: 'link', size }, 'x')) tutte.add(c)
    const css = await compileRenderer([...tutte])
    expect(deadClasses(css, [...tutte])).toEqual([])
  })
})
