// B5 (fase b20-bug): l'anello del fuoco SOLO da tastiera — il marcatore.
//
// MISURATO DAL VIVO (sonda CDP sull'app, Chromium di Electron 45, macOS con
// «Navigazione con tastiera» SPENTA): l'anello arancione è l'outline NATIVO
// di Chromium, quello che sta su `:focus-visible`, nel colore d'accento di
// sistema. Un clic VERO sulla riga di un bot NON lo mostra (:focus-visible è
// falso). Lo mostra il TASTO premuto subito dopo, qualunque sia: per
// l'euristica di Chromium, se l'utente usa la tastiera l'elemento che ha il
// fuoco diventa :focus-visible — anche se il fuoco glielo aveva dato il
// mouse. Così: clic sulla riga, poi Esc, ⌘K, uno Shift… e la riga cliccata
// si accende. L'utente lo vede come «l'anello compare al clic».
//
// Il CSS da solo non può rimediare (quando l'anello si vede l'elemento È
// :focus-visible, ed è l'unico segnale che il CSS riceve). Questo modulino
// scrive su <html> DA DOVE ARRIVA IL FUOCO (data-focus-from) e styles.css lo
// legge in due punti — la regola unica e la variante `focus-visible` di
// Tailwind (la guardia è in __tests__/focus-ring-guard.test.ts):
//   - pointerdown viene PRIMA del fuoco del clic  → 'pointer';
//   - un tasto che da tastiera sposta o attiva il fuoco viene PRIMA dello
//     spostamento → 'keyboard';
//   - qualunque ALTRO tasto (un modificatore, una scorciatoia, una lettera)
//     non cambia la modalità: non ha spostato il fuoco.
// Senza DOM (niente jsdom nel repo): un documento finto su EventTarget di Node.
import { describe, expect, it } from 'vitest'
import { installFocusFrom } from '../focus-from'

/** Un documento finto: <html> col suo dataset e i listener registrati. */
class FakeDocument extends EventTarget {
  readonly documentElement = { dataset: {} as Record<string, string | undefined> }
  readonly registered: Array<{ type: string; capture: boolean }> = []

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.registered.push({ type, capture: typeof options === 'object' && options !== null ? options.capture === true : options === true })
    super.addEventListener(type, listener, options)
  }
}

function setup(): { doc: FakeDocument; marker: () => string | undefined } {
  const doc = new FakeDocument()
  const dispose = installFocusFrom(doc as unknown as Document)
  expect(dispose, 'installFocusFrom restituisce la funzione che toglie i listener').toBeTypeOf('function')
  return { doc, marker: () => doc.documentElement.dataset.focusFrom }
}

function fire(doc: FakeDocument, type: string): void {
  doc.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
}

/** Un tasto premuto, come lo vede il documento (Node non ha KeyboardEvent). */
function key(doc: FakeDocument, k: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}): void {
  doc.dispatchEvent(
    Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), {
      key: k,
      shiftKey: mods.shiftKey === true,
      ctrlKey: mods.ctrlKey === true,
      altKey: mods.altKey === true,
      metaKey: mods.metaKey === true
    })
  )
}

/** Un clic vero: pointerdown, poi il fuoco passa all'elemento. */
const click = (doc: FakeDocument): void => fire(doc, 'pointerdown')

describe('B5 — il marcatore data-focus-from su <html>', () => {
  it('prima di qualunque input il marcatore è keyboard: il fuoco iniziale e l’autoFocus sono da tastiera', () => {
    const { marker } = setup()
    expect(marker()).toBe('keyboard')
  })

  it('un pointerdown scrive pointer: il clic che segue non mostra l’anello', () => {
    const { doc, marker } = setup()
    click(doc)
    expect(marker()).toBe('pointer')
  })

  it('DOPO UN CLIC un tasto qualunque lascia pointer (misurato: è lì che Chromium accende la riga cliccata)', () => {
    const { doc, marker } = setup()
    click(doc)
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape', 'k', 'a', 'Delete', 'Backspace', 'F1', 'Dead', 'Unidentified']) {
      key(doc, k)
      expect(marker(), `dopo «${k}» resta pointer`).toBe('pointer')
    }
  })

  it('dopo un clic una scorciatoia lascia pointer, anche coi tasti della navigazione (⌘K, ⌥←, Ctrl+Invio, ⌘↓)', () => {
    const { doc, marker } = setup()
    click(doc)
    for (const [k, mods] of [
      ['k', { metaKey: true }],
      ['ArrowLeft', { altKey: true }],
      ['Enter', { ctrlKey: true }],
      ['ArrowDown', { metaKey: true }],
      ['Tab', { ctrlKey: true }],
      ['Home', { ctrlKey: true }]
    ] as const) {
      key(doc, k, mods)
      expect(marker(), `dopo «${JSON.stringify(mods)}+${k}» resta pointer`).toBe('pointer')
    }
  })

  it('Tab riporta keyboard (lo spostamento del fuoco viene dopo il keydown)', () => {
    const { doc, marker } = setup()
    click(doc)
    key(doc, 'Tab')
    expect(marker()).toBe('keyboard')
  })

  it('Shift+Tab pure (va indietro)', () => {
    const { doc, marker } = setup()
    click(doc)
    key(doc, 'Tab', { shiftKey: true })
    expect(marker()).toBe('keyboard')
  })

  it('gli altri tasti che da tastiera spostano o attivano il fuoco: frecce, Home, End, PageUp, PageDown, Invio, Spazio', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ']) {
      const { doc, marker } = setup()
      click(doc)
      key(doc, k)
      expect(marker(), `dopo «${k}»`).toBe('keyboard')
    }
  })

  it('da keyboard non si torna indietro con la tastiera: un tasto qualunque la lascia', () => {
    const { doc, marker } = setup()
    for (const k of ['Shift', 'k', 'Escape', 'Tab']) key(doc, k)
    expect(marker()).toBe('keyboard')
  })

  it('alternanza completa: clic → pointer, Tab → keyboard, clic → pointer, Esc → pointer, frecce → keyboard', () => {
    const { doc, marker } = setup()
    click(doc)
    expect(marker()).toBe('pointer')
    key(doc, 'Tab')
    expect(marker()).toBe('keyboard')
    click(doc)
    key(doc, 'Escape')
    expect(marker(), 'dopo un clic Esc non riaccende l’anello').toBe('pointer')
    key(doc, 'ArrowDown')
    expect(marker()).toBe('keyboard')
  })

  it('gli altri eventi non contano (click, mouseup, keyup, wheel): solo il PREMERE dice da dove arriva l’input', () => {
    const { doc, marker } = setup()
    for (const type of ['click', 'mouseup', 'keyup', 'wheel', 'mousemove', 'contextmenu', 'focusin']) fire(doc, type)
    expect(marker(), 'senza premere resta keyboard').toBe('keyboard')
    click(doc)
    for (const type of ['click', 'mouseup', 'keyup', 'wheel', 'mousemove', 'contextmenu', 'focusin', 'scroll']) fire(doc, type)
    expect(marker(), 'dopo un clic resta pointer finché la tastiera non sposta il fuoco').toBe('pointer')
  })

  it('ascolta in CATTURA sul documento: l’evento arriva prima dei gestori dei componenti, anche dove uno ferma la propagazione', () => {
    const { doc } = setup()
    expect(doc.registered).toEqual([
      { type: 'pointerdown', capture: true },
      { type: 'keydown', capture: true }
    ])
  })

  it('dispose() toglie i listener: il marcatore non cambia più', () => {
    const doc = new FakeDocument()
    const dispose = installFocusFrom(doc as unknown as Document)
    dispose()
    expect(doc.registered.length).toBe(2)
    click(doc)
    key(doc, 'Tab')
    expect(doc.documentElement.dataset.focusFrom, 'resta il valore che c’era').toBe('keyboard')
  })
})
