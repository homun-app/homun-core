// Fase 19a correzioni (L3/L4/L6): le FUNZIONI DI PAGINA della sonda del punto
// e del fuoco attivo, eseguite in un DOM FINTO (niente jsdom: gli oggetti
// implementano solo ciò che le funzioni toccano), e la SEQUENZA della sonda in
// computer.ts con docker e MCP FINTI: cattura → doppio mousemove → attesa →
// lettura → elemento, PRIMA dell'esecuzione dell'azione. Niente Docker, solo
// 127.0.0.1 niente rete.
import { describe, expect, it, afterEach } from 'vitest'
import { elementAtPointFn, ACTIVE_FIELD_FN, MOUSE_HIT_ARM_FN, MOUSE_HIT_READ_FN } from '../browser'
import { computerActContextOf, computerExecAction, MOUSE_PROBE_WAIT_MS, type DesktopInfo } from '../computer'
import { computerActRisk, type ComputerClickProbe } from '../browser-guard'
import { setDockerRunnerForTests } from '../../sandbox'
import type { ViewportOffset } from '../browser'

// ---- il DOM finto: solo le proprietà che le funzioni di pagina toccano ----

interface FakeEl {
  tagName: string
  attrs: Record<string, string>
  innerText?: string
  children?: FakeEl[]
  parent?: FakeEl
  shadowRoot?: { elementFromPoint: (x: number, y: number) => FakeEl | null }
  labels?: Array<{ textContent: string }>
  control?: FakeEl
  type?: string
  value?: string
  autocomplete?: string
  name?: string
  id?: string
  placeholder?: string
  title?: string
  isContentEditable?: boolean
}

const el = (tagName: string, over: Partial<FakeEl> = {}): FakeEl => ({ tagName, attrs: {}, ...over })

/** il closest finto: implementa i selettori del CONTROL_CLOSEST di L4. */
function fakeClosest(target: FakeEl, selector: string): FakeEl | null {
  const matches = (e: FakeEl): boolean =>
    selector.split(',').map((s) => s.trim()).some((s) => {
      if (s === 'a[href]') return e.tagName === 'a' && e.attrs.href !== undefined
      if (s === 'button') return e.tagName === 'button'
      if (s === 'input') return e.tagName === 'input'
      if (s === 'select') return e.tagName === 'select'
      if (s === 'textarea') return e.tagName === 'textarea'
      if (s === 'summary') return e.tagName === 'summary'
      if (s === 'label') return e.tagName === 'label'
      const role = /^\[role=([^\]]+)\]$/.exec(s)
      if (role) return e.attrs.role === role[1]
      if (s === '[onclick]') return e.attrs.onclick !== undefined
      const tabindex = /^\[tabindex\]:not\(\[tabindex="-1"\]\)$/.exec(s)
      if (tabindex) return e.attrs.tabindex !== undefined && e.attrs.tabindex !== '-1'
      return false
    })
  let cur: FakeEl | undefined = target
  while (cur) {
    if (matches(cur)) return cur
    cur = cur.parent
  }
  return null
}

/**legge gli attributi con la semantica di getAttribute (null se assenti). */
const attr = (e: FakeEl) => (n: string): string | null => (e.attrs && Object.prototype.hasOwnProperty.call(e.attrs, n) ? e.attrs[n]! : null)

/** Un elemento finto come lo vede la funzione di pagina (con closest incluso). */
const asPageEl = (e: FakeEl): Record<string, unknown> => {
  const o: Record<string, unknown> = {
    tagName: e.tagName,
    getAttribute: attr(e),
    // nel DOM vero innerText e textContent coincidono per il testo che serve
    innerText: e.innerText ?? '',
    textContent: e.innerText ?? '',
    title: e.attrs.title ?? e.title ?? '',
    closest: (sel: string) => {
      const found = fakeClosest(e, sel)
      return found ? asPageEl(found) : null
    }
  }
  // le proprietà riflesse degli attributi, come nel DOM vero (el.type di un
  // input, el.value, el.title…)
  if (e.type !== undefined) o.type = e.type
  else if (e.attrs.type !== undefined) o.type = e.attrs.type
  if (e.value !== undefined) o.value = e.value
  else if (e.attrs.value !== undefined) o.value = e.attrs.value
  if (e.attrs.autocomplete !== undefined) o.autocomplete = e.attrs.autocomplete
  if (e.attrs.name !== undefined) o.name = e.attrs.name
  if (e.attrs.id !== undefined) o.id = e.attrs.id
  if (e.attrs.placeholder !== undefined) o.placeholder = e.attrs.placeholder
  if (e.labels !== undefined) o.labels = e.labels
  if (e.control !== undefined) o.control = asPageEl(e.control)
  if (e.shadowRoot !== undefined) o.shadowRoot = { elementFromPoint: (x: number, y: number) => { const f = e.shadowRoot!.elementFromPoint(x, y); return f ? asPageEl(f) : null } }
  if (e.isContentEditable !== undefined) o.isContentEditable = e.isContentEditable
  return o
}

interface FakeDoc {
  elementFromPoint: (x: number, y: number) => FakeEl | null
  byId: Record<string, FakeEl>
  /** 'body'/'html' = il fuoco è l'elemento pagina STESSO (identità con document.body) */
  activeElement?: FakeEl | 'body' | 'html'
}

const fakeDoc = (over: Partial<FakeDoc> = {}): Record<string, unknown> => {
  // gli stessi oggetti per activeElement e document.body/documentElement:
  // la funzione di pagina li confronta PER IDENTITÀ
  const body = asPageEl(el('body'))
  const docEl = asPageEl(el('html'))
  return {
    elementFromPoint: (x: number, y: number) => {
      const f = (over.elementFromPoint ?? (() => null))(x, y)
      return f ? asPageEl(f) : null
    },
    getElementById: (id: string) => {
      const f = over.byId?.[id]
      return f ? asPageEl(f) : null
    },
    activeElement: over.activeElement === 'body' ? body : over.activeElement === 'html' ? docEl : over.activeElement ? asPageEl(over.activeElement) : null,
    body,
    documentElement: docEl
  }
}

/** Esegue una funzione di pagina (stringa) nel DOM finto: ritorno + listener registrati. */
function runPageFn(src: string, doc: Partial<FakeDoc>, win?: Record<string, unknown>): { ret: Record<string, unknown> | null; listeners: Array<{ type: string; handler: (e: { clientX: number; clientY: number }) => void; opts: unknown }> } {
  const listeners: Array<{ type: string; handler: (e: { clientX: number; clientY: number }) => void; opts: unknown }> = []
  const addEventListener = (type: string, handler: (e: { clientX: number; clientY: number }) => void, opts: unknown): void => {
    listeners.push({ type, handler, opts })
  }
  const factory = new Function(
    'document', 'location', 'window', 'addEventListener',
    `"use strict"; return (${src});`
  )
  const fn = factory(fakeDoc(doc), { origin: 'https://site.example' }, win ?? {}, addEventListener)
  const ret = fn()
  return { ret: ret && typeof ret === 'object' ? (ret as Record<string, unknown>) : null, listeners }
}

/** Il ritorno di una funzione di pagina come oggetto (o null). */
const pageObj = (src: string, doc: Partial<FakeDoc>, win?: Record<string, unknown>): Record<string, unknown> | null => {
  const { ret } = runPageFn(src, doc, win)
  return ret && typeof ret === 'object' ? (ret as Record<string, unknown>) : null
}

// ---- L4: elementAtPointFn nel DOM finto ----

describe('fase 19a correzioni L4: elementAtPointFn risale al controllo VERO', () => {
  it('input type=submit value="Acquista" (innerText vuoto) → button «Acquista», non più nome vuoto', () => {
    const submit = el('input', { attrs: { type: 'submit', value: 'Acquista' } })
    const { ret } = runPageFn(elementAtPointFn(10, 20), { elementFromPoint: () => submit })
    expect(ret?.kind).toBe('element')
    expect(ret?.role).toBe('button')
    expect(ret?.name).toBe('Acquista')
    expect(ret?.field).toMatchObject({ type: 'submit' })
  })

  it('svg circle dentro un button aria-label="Acquista" → il NOME del bottone, non quello del circle', () => {
    const button = el('button', { attrs: { 'aria-label': 'Acquista' } })
    const circle = el('circle', { parent: button })
    const { ret } = runPageFn(elementAtPointFn(5, 5), { elementFromPoint: () => circle })
    expect(ret?.kind).toBe('element')
    expect(ret?.role).toBe('button')
    expect(ret?.name).toBe('Acquista')
  })

  it('<span>Paga ora</span> dentro un <button> → il testo del bottone (closest)', () => {
    const button = el('button', { innerText: 'Paga ora' })
    const span = el('span', { parent: button, innerText: 'Paga ora' })
    const { ret } = runPageFn(elementAtPointFn(5, 5), { elementFromPoint: () => span })
    expect(ret?.role).toBe('button')
    expect(ret?.name).toBe('Paga ora')
    expect(ret?.text).toBe('Paga ora')
  })

  it('link «Dettagli» → link col suo nome', () => {
    const a = el('a', { attrs: { href: '/x' }, innerText: 'Dettagli' })
    const { ret } = runPageFn(elementAtPointFn(1, 1), { elementFromPoint: () => a })
    expect(ret?.role).toBe('link')
    expect(ret?.name).toBe('Dettagli')
  })

  it('il nome nell\'ordine di L4: aria-labelledby, value/alt dell\'input immagine, alt dell\'img, title', () => {
    // aria-labelledby vince sul title
    const labelled = el('button', { attrs: { title: 'sbagliato', 'aria-labelledby': 'lbl1' }, title: 'sbagliato' })
    const { ret: r1 } = runPageFn(elementAtPointFn(0, 0), {
      elementFromPoint: () => labelled, byId: { lbl1: el('span', { innerText: '  Prenota ora  ' }) }
    })
    expect(r1?.name).toBe('Prenota ora')
    // input image: value prima, poi alt
    const img1 = el('input', { attrs: { type: 'image', value: 'Paga', alt: 'carta' } })
    const { ret: r2 } = runPageFn(elementAtPointFn(0, 0), { elementFromPoint: () => img1 })
    expect(r2?.name).toBe('Paga')
    const img2 = el('input', { attrs: { type: 'image', alt: 'Paga con carta' } })
    const { ret: r3 } = runPageFn(elementAtPointFn(0, 0), { elementFromPoint: () => img2 })
    expect(r3?.name).toBe('Paga con carta')
    // alt di un'img che è essa stessa il controllo trovato (niente closest)
    const img = el('img', { attrs: { alt: 'Vai alle offerte' } })
    const { ret: r4 } = runPageFn(elementAtPointFn(0, 0), { elementFromPoint: () => img })
    expect(r4?.role).toBe('generic')
    expect(r4?.name).toBe('Vai alle offerte')
  })

  it('tutto troncato a 120 caratteri', () => {
    const long = el('button', { innerText: 'A'.repeat(300) })
    const { ret } = runPageFn(elementAtPointFn(0, 0), { elementFromPoint: () => long })
    expect((ret?.name as string).length).toBe(120)
    expect((ret?.text as string).length).toBe(120)
  })

  it('il ruolo: esplicito vince; select → combobox; textarea e input di testo → textbox; il resto generic', () => {
    const withRole = el('div', { attrs: { role: 'button' }, innerText: 'Vai' })
    expect(pageObj(elementAtPointFn(0, 0), { elementFromPoint: () => withRole })?.role).toBe('button')
    const select = el('select')
    expect(pageObj(elementAtPointFn(0, 0), { elementFromPoint: () => select })?.role).toBe('combobox')
    const search = el('input', { attrs: { type: 'search' } })
    expect(pageObj(elementAtPointFn(0, 0), { elementFromPoint: () => search })?.role).toBe('textbox')
    const checkbox = el('input', { attrs: { type: 'checkbox' } })
    expect(pageObj(elementAtPointFn(0, 0), { elementFromPoint: () => checkbox })?.role).toBe('generic')
  })

  it('shadow DOM aperto: si scende col shadowRoot.elementFromPoint fino al controllo dentro', () => {
    const innerButton = el('button', { attrs: { 'aria-label': 'Acquista' } })
    const host = el('div', { shadowRoot: { elementFromPoint: () => innerButton } })
    const { ret } = runPageFn(elementAtPointFn(9, 9), { elementFromPoint: () => host })
    expect(ret?.kind).toBe('element')
    expect(ret?.role).toBe('button')
    expect(ret?.name).toBe('Acquista')
  })

  it('IFRAME/FRAME/EMBED/OBJECT sotto il punto → { kind: "frame" }', () => {
    for (const tag of ['iframe', 'frame', 'embed', 'object']) {
      const frame = el(tag)
      const { ret } = runPageFn(elementAtPointFn(3, 3), { elementFromPoint: () => frame })
      expect(ret, tag).toEqual({ kind: 'frame' })
    }
  })

  it('una label usa anche il nome del suo control; il campo si legge sul CONTROLLO trovato', () => {
    // label «Acquista» col checkbox: il nome è il testo della label
    const label = el('label', { innerText: 'Acquista', control: el('input', { attrs: { type: 'checkbox' } }) })
    const { ret } = runPageFn(elementAtPointFn(2, 2), { elementFromPoint: () => label })
    expect(ret?.role).toBe('label')
    expect(ret?.name).toBe('Acquista')
    // label VUOTA col control che ha un nome: si usa quello del control
    const empty = el('label', { control: el('input', { attrs: { type: 'submit', value: 'Acquista' } }) })
    const { ret: r2 } = runPageFn(elementAtPointFn(2, 2), { elementFromPoint: () => empty })
    expect(r2?.name).toBe('Acquista')
    // il campo è del controllo (input), non dell'elemento profondo (span)
    const input = el('input', { attrs: { type: 'text', name: 'q', autocomplete: 'off' } })
    const span = el('span', { parent: input })
    const { ret: r3 } = runPageFn(elementAtPointFn(4, 4), { elementFromPoint: () => span })
    expect(r3?.field).toMatchObject({ type: 'text', name: 'q', autocomplete: 'off', origin: 'https://site.example' })
  })

  it('nessun elemento sotto il punto → null', () => {
    const { ret } = runPageFn(elementAtPointFn(0, 0), { elementFromPoint: () => null })
    expect(ret).toBeNull()
  })
})

// ---- L6: ACTIVE_FIELD_FN nel DOM finto ----

describe('fase 19a correzioni L6: ACTIVE_FIELD_FN vede anche i non-campo', () => {
  it('input/textarea → il campo, come prima', () => {
    const input = el('input', {
      attrs: { type: 'password', name: 'pwd', autocomplete: 'current-password' },
      labels: [{ textContent: 'Password' }]
    })
    const { ret } = runPageFn(ACTIVE_FIELD_FN, { activeElement: input })
    expect(ret).toMatchObject({ type: 'password', autocomplete: 'current-password', label: 'Password', origin: 'https://site.example', top: true })
  })

  it('contenteditable → campo di testo con le stesse informazioni', () => {
    const editable = el('div', { isContentEditable: true, attrs: { 'aria-label': 'Note' } })
    const { ret } = runPageFn(ACTIVE_FIELD_FN, { activeElement: editable })
    expect(ret).toMatchObject({ aria: 'Note', origin: 'https://site.example' })
  })

  it('bottone/link focalizzato → { element: { role, name, text } } con la logica di L4', () => {
    const button = el('button', { attrs: { 'aria-label': 'Acquista' }, innerText: 'svg' })
    const { ret } = runPageFn(ACTIVE_FIELD_FN, { activeElement: button })
    expect(ret?.element).toEqual({ role: 'button', name: 'Acquista', text: 'svg' })
    const link = el('a', { attrs: { href: '/' }, innerText: 'Dettagli' })
    const { ret: r2 } = runPageFn(ACTIVE_FIELD_FN, { activeElement: link })
    expect(r2?.element).toEqual({ role: 'link', name: 'Dettagli', text: 'Dettagli' })
    // un input focalizzato resta un CAMPO (anche submit): il ramo element è
    // per gli elementi che NON sono campi
    const submit = el('input', { attrs: { type: 'submit', value: 'Acquista ora' } })
    const { ret: r3 } = runPageFn(ACTIVE_FIELD_FN, { activeElement: submit })
    expect(r3?.element).toBeUndefined()
    expect(r3).toMatchObject({ type: 'submit' })
  })

  it('body/html → { page: true } (null resta SOLO per il probe fallito)', () => {
    expect(runPageFn(ACTIVE_FIELD_FN, { activeElement: 'body' }).ret).toEqual({ page: true })
    expect(runPageFn(ACTIVE_FIELD_FN, { activeElement: 'html' }).ret).toEqual({ page: true })
  })
})

// ---- L3: la cattura one-shot del mousemove ----

describe('fase 19a correzioni L3: la cattura one-shot del mousemove', () => {
  it('MOUSE_HIT_ARM_FN installa la cattura (capture, UNA volta per documento, tiene l\'ULTIMO evento) e MOUSE_HIT_READ_FN legge le coordinate esatte', () => {
    const win: Record<string, unknown> = {}
    const { listeners } = runPageFn(MOUSE_HIT_ARM_FN, {}, win)
    expect(win.__sbHit).toBeNull()
    expect(listeners.length).toBe(1)
    expect(listeners[0]!.type).toBe('mousemove')
    expect(listeners[0]!.opts).toEqual({ capture: true })
    // il mousemove vero di xdotool arriva con clientX/clientY esatti
    // verifica: con due eventi vale l'ULTIMO (il punto vero), mai il primo
    const handler = (listeners[0] as unknown as { handler: (e: { clientX: number; clientY: number }) => void }).handler
    handler({ clientX: 379, clientY: 225 })
    handler({ clientX: 380, clientY: 225 })
    expect(win.__sbHit).toEqual({ x: 380, y: 225 })
    // un secondo armo nello stesso documento azzera ma NON aggiunge listener
    expect(runPageFn(MOUSE_HIT_ARM_FN, {}, win).listeners.length).toBe(0)
    expect(win.__sbHit).toBeNull()
    handler({ clientX: 380, clientY: 225 })
    // e la lettura è la SOLA cosa che fa MOUSE_HIT_READ_FN
    expect(pageObj(MOUSE_HIT_READ_FN, {}, win)).toEqual({ x: 380, y: 225 })
  })
})

// ---- L3: la SEQUENZA della sonda in computer.ts, con docker e MCP finti ----

const DESKTOP: DesktopInfo = { owner: 'agent_x', display: ':42', xauthority: '/browser/agent_x/Xauthority' }
const VIEW: ViewportOffset = { offX: 0, offY: 87, width: 1279, height: 872 }

afterEach(() => setDockerRunnerForTests(null))

describe('fase 19a correzioni L3: computerActContextOf — cattura → doppio mousemove → lettura, prima dell\'azione', () => {
  it('l\'ordine delle chiamate con docker e MCP finti, e le coordinate dell\'evento costruiscono l\'elemento', async () => {
    const calls: string[] = []
    setDockerRunnerForTests(async (argv) => {
      calls.push(`docker ${argv.slice(argv.indexOf('xdotool') >= 0 ? argv.indexOf('xdotool') : 0).join(' ')}`)
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    })
    const evaluate = async (_agentId: string, fn: string): Promise<unknown> => {
      calls.push(`eval ${fn.slice(0, 46)}`)
      if (fn === MOUSE_HIT_ARM_FN) return 1
      if (fn === MOUSE_HIT_READ_FN) return { x: 380, y: 225 } // evento vero: pagina (380,225)
      if (fn.startsWith('() => { const cut')) {
        return { kind: 'element', role: 'button', name: 'Acquista ora', text: '', field: null }
      }
      return null
    }
    const ctx = await computerActContextOf('agent_x', { kind: 'click', x: 380, y: 312 }, VIEW, {
      challenge: false, userControl: false, desktop: DESKTOP,
      probe: {
        evaluate,
        sleep: async (ms) => { calls.push(`sleep ${ms}`) }
      }
    })
    // cattura → mousemove DOPPIO (0,0 nella barra delle schede, poi 380) → attesa → lettura → elemento
    expect(calls).toEqual([
      `eval ${MOUSE_HIT_ARM_FN.slice(0, 46)}`,
      'docker xdotool mousemove -- 0 0 mousemove -- 380 312',
      `sleep ${MOUSE_PROBE_WAIT_MS}`,
      `eval ${MOUSE_HIT_READ_FN.slice(0, 46)}`,
      `eval ${'() => { const cut = (s) => String(s == null ? '.slice(0, 46)}`
    ])
    expect(MOUSE_PROBE_WAIT_MS).toBe(150)
    // l'elemento è costruito con le coordinate dell'EVENTO, non della formula
    expect(ctx.click).toEqual({ kind: 'element', role: 'button', name: 'Acquista ora', text: '', field: null })
    // l'esecuzione dell'azione arriva DOPO tutta la sonda (il confine sta a monte)
    const err = await computerExecAction('agent_x', DESKTOP, { kind: 'click', x: 380, y: 312 })
    expect(err).toBeNull()
    expect(calls[5]).toBe('docker xdotool mousemove -- 380 312 click 1')
    expect(calls.slice(0, 5).every((c) => c.startsWith('docker') === false || c.includes('mousemove -- 0 0'))).toBe(true)
  })

  it('il pre-spostamento sta nella barra delle schede: (0,0), o (1,0) se il punto è (0,0)', async () => {
    const moves: string[] = []
    setDockerRunnerForTests(async (argv) => {
      const i = argv.indexOf('xdotool')
      if (i >= 0) moves.push(argv.slice(i + 1).join(' '))
      return { stdout: '', stderr: '', exitCode: 0, signal: null }
    })
    const evaluate = async (_agentId: string, fn: string): Promise<unknown> =>
      fn === MOUSE_HIT_ARM_FN ? 1 : null // niente evento: si va di formula
    for (const [x, y] of [[0, 10], [0, 0], [301, 287]] as const) {
      await computerActContextOf('agent_x', { kind: 'click', x, y }, VIEW, {
        challenge: false, userControl: false, desktop: DESKTOP,
        probe: { evaluate, sleep: async () => undefined }
      })
    }
    // verifica: MAI x−1 dentro la pagina (l'evento del pixel accanto ingannava la sonda sul bordo)
    expect(moves).toEqual([
      'mousemove -- 0 0 mousemove -- 0 10',
      'mousemove -- 1 0 mousemove -- 0 0',
      'mousemove -- 0 0 mousemove -- 301 287'
    ])
  })

  it('SENZA evento e punto fuori dal viewport → outside (formula di L2)', async () => {
    const evaluate = async (_agentId: string, fn: string): Promise<unknown> =>
      fn === MOUSE_HIT_ARM_FN ? 1 : null
    const ctx = await computerActContextOf('agent_x', { kind: 'click', x: 600, y: 40 }, VIEW, {
      challenge: false, userControl: false, desktop: DESKTOP,
      probe: { evaluate, sleep: async () => undefined }
    })
    expect(ctx.click).toEqual({ kind: 'outside' })
  })

  it('senza evento, punto DENTRO: un frame è frame, qualunque altra cosa è unknown', async () => {
    const mkEvaluate = (element: unknown) => async (_agentId: string, fn: string): Promise<unknown> => {
      if (fn === MOUSE_HIT_ARM_FN) return 1
      if (fn === MOUSE_HIT_READ_FN) return null
      return element
    }
    const frame = await computerActContextOf('agent_x', { kind: 'click', x: 300, y: 200 }, VIEW, {
      challenge: false, userControl: false, desktop: DESKTOP,
      probe: { evaluate: mkEvaluate({ kind: 'frame' }), sleep: async () => undefined }
    })
    expect(frame.click).toEqual({ kind: 'frame' })
    const elementAnyway = await computerActContextOf('agent_x', { kind: 'click', x: 300, y: 200 }, VIEW, {
      challenge: false, userControl: false, desktop: DESKTOP,
      probe: { evaluate: mkEvaluate({ kind: 'element', role: 'button', name: 'X', text: '', field: null }), sleep: async () => undefined }
    })
    // niente evento → il puntatore NON era sulla pagina: l'elemento non conta
    expect(elementAnyway.click).toEqual({ kind: 'unknown' })
    const nullProbe = await computerActContextOf('agent_x', { kind: 'click', x: 300, y: 200 }, VIEW, {
      challenge: false, userControl: false, desktop: DESKTOP,
      probe: { evaluate: mkEvaluate(null), sleep: async () => undefined }
    })
    expect(nullProbe.click).toEqual({ kind: 'unknown' })
  })

  it('senza evento e VIEW nulla → unknown; down e up passano dalla STESSA sonda, move no', async () => {
    const evaluate = async (_agentId: string, fn: string): Promise<unknown> =>
      fn === MOUSE_HIT_ARM_FN ? 1 : null
    const opts = { challenge: false, userControl: false, desktop: DESKTOP, probe: { evaluate, sleep: async () => undefined } }
    const noView = await computerActContextOf('agent_x', { kind: 'click', x: 300, y: 200 }, null, opts)
    expect(noView.click).toEqual({ kind: 'unknown' })
    // down e up: la sonda parte (cattura installata), move mai
    let armed = 0
    const evalCounting = async (_agentId: string, fn: string): Promise<unknown> => {
      if (fn === MOUSE_HIT_ARM_FN) { armed++; return 1 }
      return null
    }
    const optsCounting = { challenge: false, userControl: false, desktop: DESKTOP, probe: { evaluate: evalCounting, sleep: async () => undefined } }
    await computerActContextOf('agent_x', { kind: 'down', x: 300, y: 200 }, VIEW, optsCounting)
    await computerActContextOf('agent_x', { kind: 'up', x: 300, y: 200 }, VIEW, optsCounting)
    expect(armed).toBe(2)
    await computerActContextOf('agent_x', { kind: 'move', x: 300, y: 200 }, VIEW, optsCounting)
    expect(armed).toBe(2)
  })

  it('type/key: il fuoco attivo passa da normaliseFocus (campo, elemento, pagina, null)', async () => {
    const evaluate = async (_agentId: string, fn: string): Promise<unknown> => {
      if (fn !== ACTIVE_FIELD_FN) throw new Error('la sonda del punto non serve a type/key')
      return { type: 'text', name: 'q', autocomplete: '', id: '', placeholder: '', label: '', aria: '', title: '', origin: 'https://site.example', top: true }
    }
    const ctx = await computerActContextOf('agent_x', { kind: 'type', text: 'ciao' }, VIEW, {
      challenge: false, userControl: false, desktop: DESKTOP, probe: { evaluate }
    })
    expect(ctx.activeField?.kind).toBe('field')
    expect(ctx.activeField && ctx.activeField.kind === 'field' ? ctx.activeField.field.name : '').toBe('q')
  })
})

// ---- L4: dal DOM finto al VERDETTO del confine (i casi della spec) ----

describe('fase 19a correzioni L4: il RefInfo costruito dal probe decide il verdetto', () => {
  /** Il verdetto di un click sull'elemento finto passato a elementFromPoint. */
  const verdictAt = (target: FakeEl | null): { kind: string; ask?: { kind?: string }; reason?: string } => {
    const { ret } = runPageFn(elementAtPointFn(5, 5), { elementFromPoint: () => target })
    const click: ComputerClickProbe | null = ret?.kind === 'element'
      ? { kind: 'element', role: String(ret.role), name: String(ret.name), text: String(ret.text), field: null }
      : ret?.kind === 'frame' ? { kind: 'frame' } : null
    const r = computerActRisk({ kind: 'click', x: 5, y: 5 }, {
      view: VIEW, click, activeField: null, challenge: false, userControl: false
    })
    return r as { kind: string; ask?: { kind?: string }; reason?: string }
  }

  it('input type=submit value="Acquista" → ask commit (prima era FREE: innerText vuoto)', () => {
    const v = verdictAt(el('input', { attrs: { type: 'submit', value: 'Acquista' } }))
    expect(v.kind).toBe('ask')
    expect(v.ask?.kind).toBe('commit')
    expect(v.reason).toContain('Acquista')
  })

  it('svg circle in un bottone aria-label="Acquista" → ask commit (prima era FREE)', () => {
    const button = el('button', { attrs: { 'aria-label': 'Acquista' } })
    const v = verdictAt(el('circle', { parent: button }))
    expect(v.kind).toBe('ask')
    expect(v.ask?.kind).toBe('commit')
  })

  it('<span>Paga ora</span> dentro un <button> → ask commit', () => {
    const button = el('button', { innerText: 'Paga ora' })
    const v = verdictAt(el('span', { parent: button, innerText: 'Paga ora' }))
    expect(v.kind).toBe('ask')
    expect(v.ask?.kind).toBe('commit')
  })

  it('link «Dettagli» → free', () => {
    const v = verdictAt(el('a', { attrs: { href: '/d' }, innerText: 'Dettagli' }))
    expect(v.kind).toBe('free')
  })
})
