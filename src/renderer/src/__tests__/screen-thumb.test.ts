// SV2 (fase schermo-vivo) — l'anteprima dal vivo nella card «Computer»:
// la tabella dei casi di thumbShouldConnect (funzione PURA), il controller
// della connessione con l'RFB FINTO (collega/scollega sui fatti, MAI due
// connessioni, sola lettura con NESSUN input, ultima immagine per 60 s) e il
// render statico del componente (il riquadro di oggi, il bottone «Stacca» che
// NON apre la scheda, il contenitore del canvas senza puntatore).
import './render-helper-install'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderHtml, setStoreStateForRender, parseHtml, findAll } from './render-helper'
import { dialogPassThroughMock } from './render-helper'

vi.mock('../components/ui/dialog', () => dialogPassThroughMock())
vi.mock('../components/ComputerPanel', () => ({ ComputerPanel: () => null }))

import type { ThumbFacts, ThumbRfb } from '../components/screen-thumb'

const {
  thumbShouldConnect,
  ScreenThumbController,
  THUMB_LAST_IMAGE_MS,
  THUMB_RETRY_MS,
  THUMB_QUALITY_LEVEL,
  THUMB_COMPRESSION_LEVEL
} = await import('../components/screen-thumb')
const { ScreenThumb } = await import('../components/ScreenThumb')
const { useStore } = await import('../store')

// ---- i fatti di comodo ----

const ALL: ThumbFacts = {
  browserRunning: true,
  activityTabVisible: true,
  windowVisible: true,
  computerTabOpen: false,
  pipOpen: false
}

const factsWith = (over: Partial<ThumbFacts>): ThumbFacts => ({ ...ALL, ...over })

// ---- l'RFB finto ----

class FakeRfb implements ThumbRfb {
  static instances: FakeRfb[] = []
  viewOnly = false
  scaleViewport = false
  clipViewport = true
  focusOnClick = true
  qualityLevel = 6
  compressionLevel = 2
  disconnected = false
  listeners: Record<string, Array<(e: { detail?: { clean?: boolean } }) => void>> = {}
  constructor(
    public el: unknown,
    public url: string,
    public opts: unknown
  ) {
    FakeRfb.instances.push(this)
  }
  addEventListener(type: 'connect' | 'disconnect', listener: (e: { detail?: { clean?: boolean } }) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }
  disconnect(): void {
    this.disconnected = true
  }
  emit(type: 'connect' | 'disconnect'): void {
    for (const l of this.listeners[type] ?? []) l({ detail: {} })
  }
}

/** L'orologio e i timer manuali del controller. */
function manualClock(): { now: () => number; schedule: (fn: () => void, ms: number) => () => void; advance: (ms: number) => void } {
  let t = 0
  const timers: Array<{ fn: () => void; at: number; dead: boolean }> = []
  const schedule = (fn: () => void, ms: number) => {
    const timer = { fn, at: t + ms, dead: false }
    timers.push(timer)
    return () => {
      timer.dead = true
    }
  }
  const advance = (ms: number) => {
    t += ms
    for (const timer of [...timers]) {
      if (!timer.dead && timer.at <= t) {
        timer.dead = true
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
    }
  }
  return { now: () => t, schedule, advance }
}

interface Harness {
  controller: InstanceType<typeof ScreenThumbController>
  rfb: () => FakeRfb | undefined
  phases: Array<{ phase: string; image: string | null }>
  advance: (ms: number) => void
}

/** Il controller con TUTTE le dipendenze finte e l'immagine catturabile. */
function makeHarness(over: { openScreen?: () => Promise<{ url: string } | null>; image?: string | null } = {}): Harness {
  FakeRfb.instances = []
  const clock = manualClock()
  const phases: Array<{ phase: string; image: string | null }> = []
  let element: unknown = { el: true }
  let image = over.image === undefined ? 'data:image/png;base64,frame' : over.image
  const controller = new ScreenThumbController({
    openScreen: over.openScreen ?? (async () => ({ url: 'ws://127.0.0.1:1/screen/cap' })),
    createRfb: async (el, url, wsProtocols) => new FakeRfb(el, url, wsProtocols),
    captureImage: () => image,
    element: () => element,
    schedule: clock.schedule,
    onPhase: (phase, lastImage) => phases.push({ phase, image: lastImage })
  })
  return {
    controller,
    rfb: () => FakeRfb.instances[FakeRfb.instances.length - 1],
    phases,
    advance: clock.advance
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// ---- la tabella dei casi (funzione PURA) ----

describe('SV2: thumbShouldConnect — la tabella dei casi', () => {
  it('si collega SOLO se tutte le condizioni valgono', () => {
    expect(thumbShouldConnect(ALL)).toBe(true)
  })
  it('browser spento → NO', () => {
    expect(thumbShouldConnect(factsWith({ browserRunning: false }))).toBe(false)
  })
  it('scheda Attività non visibile → NO', () => {
    expect(thumbShouldConnect(factsWith({ activityTabVisible: false }))).toBe(false)
  })
  it('finestra nascosta → NO', () => {
    expect(thumbShouldConnect(factsWith({ windowVisible: false }))).toBe(false)
  })
  it('scheda Computer aperta → NO (la stessa cosa in grande basta una volta)', () => {
    expect(thumbShouldConnect(factsWith({ computerTabOpen: true }))).toBe(false)
  })
  it('finestra PiP di quel bot aperta → NO', () => {
    expect(thumbShouldConnect(factsWith({ pipOpen: true }))).toBe(false)
  })
})

// ---- il controller con l'RFB finto ----

describe('SV2: il controller dell\'anteprima (RFB finto)', () => {
  beforeEach(() => {
    FakeRfb.instances = []
  })

  it('fatti tutti veri → apre la peek e configura l\'RFB in SOLA LETTURA senza input', async () => {
    const opened: string[] = []
    const h = makeHarness({ openScreen: async () => { const url = `ws://x/${opened.length}`; opened.push(url); return { url } } })
    h.controller.onFacts(ALL)
    await flush()
    const rfb = h.rfb()!
    expect(rfb).toBeInstanceOf(FakeRfb)
    expect(rfb.url).toBe('ws://x/0')
    expect(rfb.opts).toEqual(['binary'])
    // NESSUN input al box: sola lettura, niente focus al clic, niente clip
    expect(rfb.viewOnly).toBe(true)
    expect(rfb.scaleViewport).toBe(true)
    expect(rfb.clipViewport).toBe(false)
    expect(rfb.focusOnClick).toBe(false)
    // l'anteprima è piccola: qualità bassa, compressione alta (valori nel REPORT)
    expect(rfb.qualityLevel).toBe(THUMB_QUALITY_LEVEL)
    expect(rfb.qualityLevel).toBeLessThan(6)
    expect(rfb.compressionLevel).toBe(THUMB_COMPRESSION_LEVEL)
    expect(rfb.compressionLevel).toBeGreaterThan(2)
    rfb.emit('connect')
    expect(h.phases[h.phases.length - 1]).toEqual({ phase: 'connected', image: null })
  })

  it('la finestra diventa INVISIBILE → disconnect; torna visibile → riapre con capability NUOVA', async () => {
    let n = 0
    const h = makeHarness({ openScreen: async () => ({ url: `ws://x/${n++}` }) })
    h.controller.onFacts(ALL)
    await flush()
    const first = h.rfb()!
    first.emit('connect')
    // la finestra si nasconde: la connessione cade SUBITO
    h.controller.onFacts(factsWith({ windowVisible: false }))
    expect(first.disconnected).toBe(true)
    expect(h.phases[h.phases.length - 1]!.phase).not.toBe('connected')
    // torna visibile: si riapre con una capability nuova (url diverso)
    h.controller.onFacts(ALL)
    await flush()
    const second = h.rfb()!
    expect(second.url).toBe('ws://x/1')
    expect(second.disconnected).toBe(false)
  })

  it('il browser si SPENGE → disconnect e ultima immagine VELATA per 60 s, poi il riquadro di oggi', async () => {
    const h = makeHarness()
    h.controller.onFacts(ALL)
    await flush()
    h.rfb()!.emit('connect')
    // il browser si chiude: la connessione cade (evento disconnect dell'RFB)
    h.rfb()!.emit('disconnect')
    const last = h.phases[h.phases.length - 1]!
    expect(last.phase).toBe('last')
    expect(last.image).toBe('data:image/png;base64,frame')
    // a 59 s c'è ancora, a 60 s non c'è più (mai un'immagine vecchia come dal vivo)
    h.advance(THUMB_LAST_IMAGE_MS - 1_000)
    expect(h.phases[h.phases.length - 1]!.phase).toBe('last')
    h.advance(1_000)
    expect(h.phases[h.phases.length - 1]).toEqual({ phase: 'idle', image: null })
  })

  it('MAI due connessioni: la vecchia si chiude PRIMA che la nuova apra; durante l\'apertura non se ne apre un\'altra', async () => {
    let n = 0
    let release: (() => void) | null = null
    const h = makeHarness({
      openScreen: () => new Promise((resolve) => { release = () => resolve({ url: `ws://x/${n++}` }) })
    })
    h.controller.onFacts(ALL)
    // l'apertura è in volo: un secondo onFacts NON apre una seconda peek
    h.controller.onFacts(ALL)
    release!()
    await flush()
    expect(FakeRfb.instances).toHaveLength(1)
    // i fatti cadono e tornano mentre è collegato: la prima si chiude, poi la seconda
    h.rfb()!.emit('connect')
    h.controller.onFacts(factsWith({ computerTabOpen: true }))
    expect(FakeRfb.instances[0]!.disconnected).toBe(true)
    h.controller.onFacts(ALL)
    release!() // l'apertura della seconda peek (la promise è di nuovo in attesa)
    await flush()
    expect(FakeRfb.instances).toHaveLength(2)
    expect(FakeRfb.instances.filter((r) => !r.disconnected)).toHaveLength(1)
  })

  it('openScreen che torna null (browser spento) → nessun RFB, nessun riprovino', async () => {
    const h = makeHarness({ openScreen: async () => null })
    h.controller.onFacts(ALL)
    await flush()
    expect(FakeRfb.instances).toHaveLength(0)
    expect(h.phases[h.phases.length - 1]!.phase).toBe('idle')
    // gli stessi fatti di nuovo non riaprono niente (aspetta lo stato del browser)
    h.controller.onFacts(ALL)
    await flush()
    expect(FakeRfb.instances).toHaveLength(0)
  })

  it('destroy chiude la connessione e ferma il timer dell\'ultima immagine', async () => {
    const h = makeHarness()
    h.controller.onFacts(ALL)
    await flush()
    h.rfb()!.emit('connect')
    h.rfb()!.emit('disconnect')
    expect(h.phases[h.phases.length - 1]!.phase).toBe('last')
    h.controller.destroy()
    expect(h.phases[h.phases.length - 1]!.phase).toBe('idle')
    // il timer è cancellato: il tempo passa e non arriva niente
    const before = h.phases.length
    h.advance(THUMB_LAST_IMAGE_MS * 2)
    expect(h.phases.length).toBe(before)
  })
})

// ---- SV3: tre fallimenti fermano i tentativi; l'evento screen li riapre ----

describe('SV3: il costo resta basso — stop dopo 3 fallimenti, un evento screen li riapre', () => {
  /** L'arnese dei fallimenti: openScreen che riuscisce ma l'RFB cade SUBITO
   * (disconnect senza connect), oppure openScreen che rifiuta. */
  function failingHarness(mode: 'rfb-drops' | 'open-throws'): {
    h: Harness
    attempts: () => number
  } {
    let attempts = 0
    const clock = manualClock()
    FakeRfb.instances = []
    const phases: Array<{ phase: string; image: string | null }> = []
    const controller = new ScreenThumbController({
      openScreen: async () => {
        attempts++
        if (mode === 'open-throws') throw new Error('rpc error')
        return { url: `ws://x/${attempts}` }
      },
      createRfb: async (el, url, wsProtocols) => new FakeRfb(el, url, wsProtocols),
      captureImage: () => null,
      element: () => ({}),
      schedule: clock.schedule,
      onPhase: (phase, image) => phases.push({ phase, image })
    })
    return {
      h: {
        controller,
        rfb: () => FakeRfb.instances[FakeRfb.instances.length - 1],
        phases,
        advance: clock.advance
      },
      attempts: () => attempts
    }
  }

  it('tre tentativi FALLITI di fila fermano i tentativi (RFB che cade prima di connettersi)', async () => {
    const { h, attempts } = failingHarness('rfb-drops')
    h.controller.onFacts(ALL)
    await flush()
    h.rfb()!.emit('disconnect') // 1° fallimento
    await flush()
    h.advance(THUMB_RETRY_MS + 10)
    await flush()
    h.rfb()!.emit('disconnect') // 2° fallimento
    await flush()
    h.advance(THUMB_RETRY_MS + 10)
    await flush()
    h.rfb()!.emit('disconnect') // 3° fallimento: BASTA
    await flush()
    expect(attempts()).toBe(3)
    // il tempo passa: nessun quarto tentativo (niente cicli di riconnessione)
    h.advance(THUMB_RETRY_MS * 5)
    await flush()
    expect(attempts()).toBe(3)
    expect(h.phases[h.phases.length - 1]!.phase).toBe('idle') // il riquadro di oggi
  })

  it('tre openScreen che RIFIUTANO di fila fermano i tentativi', async () => {
    const { h, attempts } = failingHarness('open-throws')
    h.controller.onFacts(ALL)
    await flush()
    h.advance(THUMB_RETRY_MS + 10)
    await flush()
    h.advance(THUMB_RETRY_MS + 10)
    await flush()
    expect(attempts()).toBe(3)
    h.advance(THUMB_RETRY_MS * 5)
    await flush()
    expect(attempts()).toBe(3)
  })

  it('un evento screen NUOVO riapre i tentativi dopo lo stop', async () => {
    const { h, attempts } = failingHarness('rfb-drops')
    h.controller.onFacts(ALL)
    await flush()
    for (let i = 0; i < 3; i++) {
      h.rfb()!.emit('disconnect')
      await flush()
      h.advance(THUMB_RETRY_MS + 10)
      await flush()
    }
    expect(attempts()).toBe(3)
    // arriva l'evento `screen` con lo stato FRESCO del browser (il daemon lo
    // emette a OGNI cambio di stato): i tentativi si riaprono, coi fatti nuovi
    h.controller.browserStateChanged(true)
    await flush()
    expect(attempts()).toBe(4)
  })

  it('lo stop NON si riapre da solo: servono i fatti veri o l\'evento screen', async () => {
    const { h, attempts } = failingHarness('rfb-drops')
    h.controller.onFacts(ALL)
    await flush()
    for (let i = 0; i < 3; i++) {
      h.rfb()!.emit('disconnect')
      await flush()
      h.advance(THUMB_RETRY_MS + 10)
      await flush()
    }
    expect(attempts()).toBe(3)
    // onFacts con gli stessi fatti NON riapre (il controller è stopped)
    h.controller.onFacts(ALL)
    await flush()
    expect(attempts()).toBe(3)
    // e con i fatti FALSI ancora meno
    h.controller.onFacts(factsWith({ browserRunning: false }))
    h.advance(THUMB_RETRY_MS * 3)
    await flush()
    expect(attempts()).toBe(3)
  })

  it('l\'evento screen con browser SPENTO non riapre niente (mai fatti stantii)', async () => {
    let attempts = 0
    const clock = manualClock()
    FakeRfb.instances = []
    const phases: Array<{ phase: string; image: string | null }> = []
    const controller = new ScreenThumbController({
      openScreen: async () => { attempts++; return { url: `ws://x/${attempts}` } },
      createRfb: async (el, url, wsProtocols) => new FakeRfb(el, url, wsProtocols),
      captureImage: () => 'data:image/png;base64,frame',
      element: () => ({}),
      schedule: clock.schedule,
      onPhase: (phase, image) => phases.push({ phase, image })
    })
    controller.onFacts(ALL)
    await flush()
    FakeRfb.instances[0]!.emit('connect')
    FakeRfb.instances[0]!.emit('disconnect') // cade
    await flush()
    // il browser SI SPEGNE: l'evento screen con false aggiorna i fatti e non
    // riapre MAI, anche se l'ultimo render diceva ancora «running»
    controller.browserStateChanged(false)
    clock.advance(THUMB_RETRY_MS * 5)
    await flush()
    expect(attempts).toBe(1) // NESSUNA riapertura
    // e l'ULTIMA IMMAGINE resta (velata): la fase non torna al riquadro
    expect(phases[phases.length - 1]!.phase).toBe('last')
  })

  it('MAI due peek per lo stesso bot dalla stessa finestra: una connessione viva alla volta', async () => {
    let n = 0
    const clock = manualClock()
    FakeRfb.instances = []
    const phases: Array<{ phase: string; image: string | null }> = []
    const controller = new ScreenThumbController({
      openScreen: async () => ({ url: `ws://x/${n++}` }),
      createRfb: async (el, url, wsProtocols) => new FakeRfb(el, url, wsProtocols),
      captureImage: () => null,
      element: () => ({}),
      schedule: clock.schedule,
      onPhase: (phase, image) => phases.push({ phase, image })
    })
    controller.onFacts(ALL)
    await flush()
    controller.onFacts(factsWith({ windowVisible: false }))
    controller.onFacts(ALL)
    await flush()
    controller.onFacts(ALL) // nessuna seconda apertura se c'è già
    await flush()
    expect(FakeRfb.instances).toHaveLength(2)
    expect(FakeRfb.instances.filter((r) => !r.disconnected)).toHaveLength(1)
  })
})

// ---- il componente: render statico + handler catturati ----

// le props degli elementi resi si catturano mockando il runtime JSX (come in
// right-panel-model.test.ts): così si «clicca» il bottone «Stacca» invocando
// il VERO handler
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

describe('SV2: ScreenThumb nel render statico della card', () => {
  beforeEach(() => {
    setStoreStateForRender(useStore, { panelTab: 'activity', pipAgentId: null })
  })

  const renderThumb = (props: Record<string, unknown> = {}) => {
    capture.els.length = 0
    const html = renderHtml(createElement(ScreenThumb, { agentId: 'bot-1', browserRunning: false, ...props }))
    return parseHtml(html)
  }

  it('browser spento: il riquadro di OGGI (h-24) e NESSUN 16:10', () => {
    const tree = renderThumb()
    const zone = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-computer-thumb')[0]!
    expect(zone).toBeTruthy()
    expect(zone.attrs['style']).toBeUndefined() // niente aspect-ratio da spenti
    expect(zone.attrs['class']).toContain('bg-black/85')
  })

  it('il contenitore del canvas NON riceve il puntatore (nessun input al box)', () => {
    const tree = renderThumb()
    const zone = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-computer-thumb')[0]!
    const holder = (zone.children ?? []).find((c) => c.tag === 'div')
    expect(holder).toBeTruthy()
    expect((holder!.attrs['style'] ?? '')).toContain('pointer-events:none')
  })

  it('il bottone «Stacca» c\'è, con aria-label e titolo, visibile al passaggio e da tastiera', () => {
    const tree = renderThumb()
    const btn = findAll(tree, (n) => n.attrs['data-testid'] === 'bot-computer-thumb-detach')[0]!
    expect(btn).toBeTruthy()
    expect(btn.attrs['aria-label']).toBe('Stacca')
    expect(btn.attrs['title']).toBe('Stacca in una finestra')
    // il bottone è raggiungibile da tastiera (focus visibile) e compare al passaggio
    expect(btn.attrs['class']).toContain('focus-visible:opacity-100')
    expect(btn.attrs['class']).toContain('group-hover:opacity-100')
  })

  it('il clic sul bottone «Stacca» NON apre la scheda Computer: ferma la propagazione e chiama solo onDetach', () => {
    const detached: string[] = []
    let stopped = false
    renderThumb({ onDetach: () => detached.push('bot-1') })
    // il VERO handler del bottone, catturato dal runtime JSX
    const btn = capture.els.filter((e) => (e.props as Record<string, unknown>)['data-testid'] === 'bot-computer-thumb-detach')[0]!
    expect(btn).toBeTruthy()
    ;(btn.props.onClick as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => { stopped = true } })
    expect(stopped).toBe(true)
    expect(detached).toEqual(['bot-1'])
    // il sorgente della card: il clic sulla CARD apre la scheda Computer (come
    // oggi), il bottone dentro ferma la propagazione — la sonda SV6 lo prova dal vivo
    const src = readFileSync(fileURLToPath(new URL('../components/RightPanel.tsx', import.meta.url)), 'utf8')
    expect(src).toMatch(/onClick=\{\(\) => openBotTab\('computer'\)\}/)
    expect(useStore.getState().panelTab).toBe('activity') // nessuno ha aperto niente
  })

  it('nessuna immagine salvata da nessuna parte: né localStorage né storage', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/screen-thumb.ts', import.meta.url)), 'utf8')
    const src2 = readFileSync(fileURLToPath(new URL('../components/ScreenThumb.tsx', import.meta.url)), 'utf8')
    expect(src).not.toContain('localStorage')
    expect(src2).not.toContain('localStorage')
    // al riavvio dell'app non c'è nessuna immagine: la fase iniziale è il riquadro
    expect(src).toMatch(/phase: ThumbPhase = 'idle'/)
  })
})
