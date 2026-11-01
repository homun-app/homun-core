// Fase 19a (V9): il confine di computer_act (computerActRisk, pura) e la
// validazione delle azioni (parseComputerActions + argv xdotool). Niente
// Docker, niente browser: il contesto è costruito a mano come lo raccoglie
// il daemon dai probe interni.
import { describe, expect, it } from 'vitest'
import {
  computerActRisk, parseComputerActions, computerActionXdotoolArgs,
  SNAPSHOT_BLOCKED_NOTE, CREDENTIAL_DENY_TEXT, USER_CONTROL_ERROR_TEXT,
  COMPUTER_ACTIONS_MAX, COMPUTER_TYPE_MAX_CHARS,
  type ComputerAction, type ComputerActContext, type FieldProbeInfo
} from '../browser-guard'

const SCREEN = { width: 1280, height: 960 }
/** il viewport del browser nella finestra: la pagina inizia a (8, 84). */
const VIEW = { offX: 8, offY: 84, width: 1280, height: 800 }
/** un pulsante «Acquista» al punto (600, 400) dello schermo → in pagina (592, 316). */
const CLICK_ACQUISTA = { role: 'button', name: 'Acquista ora', text: '', field: null }
const CLICK_LINK = { role: 'link', name: 'Vedi il menu', text: '', field: null }

const field = (over: Partial<FieldProbeInfo> = {}): FieldProbeInfo => ({
  type: 'text', autocomplete: '', name: '', id: '', placeholder: '', label: '', aria: '', title: '', origin: 'https://site.example', top: true,
  ...over
})

const ctx = (over: Partial<ComputerActContext> = {}): ComputerActContext => ({
  view: VIEW, click: null, activeField: null, challenge: false, userControl: false,
  ...over
})

const click = (x: number, y: number): ComputerAction => ({ kind: 'click', x, y })

describe('fase 19a (V9): computerActRisk — il confine di OGNI azione', () => {
  it('controllo dell\'utente in corso → error, NULLA viene eseguito', () => {
    const r = computerActRisk(click(600, 400), ctx({ userControl: true }))
    expect(r).toEqual({ kind: 'error', reason: USER_CONTROL_ERROR_TEXT })
    expect(USER_CONTROL_ERROR_TEXT).toMatch(/the user is controlling your screen/i)
  })

  it('sfida anti-bot nell\'ultimo snapshot noto → deny con la NOTA nuova', () => {
    const r = computerActRisk(click(600, 400), ctx({ challenge: true }))
    expect(r).toEqual({ kind: 'deny', reason: SNAPSHOT_BLOCKED_NOTE })
    // la nota nuova dice all'utente di chiamare request_takeover
    expect(SNAPSHOT_BLOCKED_NOTE).toContain('request_takeover')
    expect(SNAPSHOT_BLOCKED_NOTE).not.toContain('do NOT bypass it, report it to the user')
  })

  it('click su un pulsante «Acquista» DENTRO la pagina → ask (stessa regola di browser_click)', () => {
    const r = computerActRisk(click(600, 400), ctx({ click: CLICK_ACQUISTA }))
    expect(r.kind).toBe('ask')
    if (r.kind === 'ask') {
      expect(r.ask.kind).toBe('commit')
      expect(r.reason).toContain('Acquista ora')
    }
  })

  it('click su un link normale → free', () => {
    expect(computerActRisk(click(600, 400), ctx({ click: CLICK_LINK })).kind).toBe('free')
  })

  it('click FUORI dalla pagina (barra degli indirizzi, schede) → ammesso (free)', () => {
    // y=40 è sopra il viewport (la barra del browser), x=1279 oltre il viewport
    expect(computerActRisk(click(600, 40), ctx({ click: null })).kind).toBe('free')
    expect(computerActRisk(click(1300, 400), ctx({ click: null })).kind).toBe('free')
  })

  it('click DENTRO la pagina ma probe dell\'elemento fallito → ask, MAI free', () => {
    const r = computerActRisk(click(600, 400), ctx({ click: null }))
    expect(r.kind).toBe('ask')
    if (r.kind === 'ask') expect(r.ask?.kind).toBe('probe')
  })

  it('probe del viewport fallito → ask anche per un click qualunque', () => {
    const r = computerActRisk(click(600, 400), ctx({ view: null, click: CLICK_LINK }))
    expect(r.kind).toBe('ask')
  })

  it('type in un campo password (dal probe) → deny con CREDENTIAL_DENY_TEXT', () => {
    const r = computerActRisk({ kind: 'type', text: 'segretissima' }, ctx({ activeField: field({ type: 'password' }) }))
    expect(r).toEqual({ kind: 'deny', reason: CREDENTIAL_DENY_TEXT })
    // il testo nuovo cita request_takeover come alternativa senza login salvato
    expect(CREDENTIAL_DENY_TEXT).toContain('request_takeover')
  })

  it('type in un campo carta (autocomplete cc-*) → deny', () => {
    const r = computerActRisk({ kind: 'type', text: '4242' }, ctx({ activeField: field({ autocomplete: 'cc-number' }) }))
    expect(r.kind).toBe('deny')
  })

  it('type in un campo normale → free; probe fallito → ask', () => {
    expect(computerActRisk({ kind: 'type', text: 'ricerca' }, ctx({ activeField: field() })).kind).toBe('free')
    expect(computerActRisk({ kind: 'type', text: 'ricerca' }, ctx({ activeField: null })).kind).toBe('ask')
  })

  it('key Return su un modulo → ask (come browser_press_key); campo credenziali → deny', () => {
    const enter = computerActRisk({ kind: 'key', key: 'Return' }, ctx({ activeField: field() }))
    expect(enter.kind).toBe('ask')
    if (enter.kind === 'ask') expect(enter.ask.kind).toBe('enter')
    expect(computerActRisk({ kind: 'key', key: 'KP_Enter' }, ctx({ activeField: field() })).kind).toBe('ask')
    expect(computerActRisk({ kind: 'key', key: 'Return' }, ctx({ activeField: field({ type: 'password' }) })).kind).toBe('deny')
    // gli altri tasti sono liberi
    expect(computerActRisk({ kind: 'key', key: 'Tab' }, ctx({ activeField: field() })).kind).toBe('free')
  })

  it('move/down/up/scroll/wait → free (il confine sta nei click e nella digitazione)', () => {
    expect(computerActRisk({ kind: 'move', x: 1, y: 1 }, ctx()).kind).toBe('free')
    expect(computerActRisk({ kind: 'down', x: 1, y: 1 }, ctx()).kind).toBe('free')
    expect(computerActRisk({ kind: 'up', x: 1, y: 1 }, ctx()).kind).toBe('free')
    expect(computerActRisk({ kind: 'scroll', direction: 'down' }, ctx()).kind).toBe('free')
    expect(computerActRisk({ kind: 'wait', ms: 500 }, ctx()).kind).toBe('free')
  })
})

describe('fase 19a (V9): parseComputerActions — la validazione pura', () => {
  it('coordinate FUORI schermo → errore (con la geometria vera)', () => {
    expect(parseComputerActions([{ kind: 'click', x: 1280, y: 0 }], SCREEN)).toEqual({
      ok: false, error: 'actions[0]: (1280, 0) is outside the screen (1280x960)'
    })
    expect(parseComputerActions([{ kind: 'click', x: 0, y: 960 }], SCREEN).ok).toBe(false)
    expect(parseComputerActions([{ kind: 'move', x: -1, y: 10 }], SCREEN).ok).toBe(false)
  })

  it('senza geometria nota le coordinate restano controllate solo nella forma', () => {
    expect(parseComputerActions([{ kind: 'click', x: 4000, y: 4000 }], null).ok).toBe(true)
    expect(parseComputerActions([{ kind: 'click', x: -3, y: 0 }], null).ok).toBe(false)
  })

  it('key con SPAZI o caratteri di controllo → errore; sintassi xdotool valida → ok', () => {
    expect(parseComputerActions([{ kind: 'key', key: 'ctrl l' }], SCREEN).ok).toBe(false)
    expect(parseComputerActions([{ kind: 'key', key: 'ctrl+l\nrm' }], SCREEN).ok).toBe(false)
    for (const key of ['ctrl+l', 'Return', 'Tab', 'ctrl+shift+t', 'Escape', 'F11', 'alt+Left', 'KP_Enter']) {
      expect(parseComputerActions([{ kind: 'key', key }], SCREEN).ok, `key ${key}`).toBe(true)
    }
  })

  it('testo oltre 2000 caratteri → errore; al limite → ok', () => {
    expect(parseComputerActions([{ kind: 'type', text: 'x'.repeat(COMPUTER_TYPE_MAX_CHARS + 1) }], SCREEN).ok).toBe(false)
    expect(parseComputerActions([{ kind: 'type', text: 'x'.repeat(COMPUTER_TYPE_MAX_CHARS) }], SCREEN).ok).toBe(true)
  })

  it('più di 24 azioni → errore; 24 → ok', () => {
    const many = Array.from({ length: COMPUTER_ACTIONS_MAX + 1 }, () => ({ kind: 'wait', ms: 10 }))
    expect(parseComputerActions(many, SCREEN).ok).toBe(false)
    expect(parseComputerActions(many.slice(0, COMPUTER_ACTIONS_MAX), SCREEN).ok).toBe(true)
  })

  it('wait oltre 5 s e scroll fuori scala → errore; il default dello scroll è 3', () => {
    expect(parseComputerActions([{ kind: 'wait', ms: 5001 }], SCREEN).ok).toBe(false)
    expect(parseComputerActions([{ kind: 'scroll', direction: 'up', amount: 21 }], SCREEN).ok).toBe(false)
    const r = parseComputerActions([{ kind: 'scroll', direction: 'up' }], SCREEN)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.actions[0]).toEqual({ kind: 'scroll', direction: 'up', amount: 3 })
  })

  it('actions non-array o vuoto → errore; kind sconosciuto → errore', () => {
    expect(parseComputerActions('no', SCREEN).ok).toBe(false)
    expect(parseComputerActions([], SCREEN).ok).toBe(false)
    expect(parseComputerActions([{ kind: 'focus', application: 'x' }], SCREEN).ok).toBe(false)
  })
})

describe('fase 19a (V9): argv xdotool di ogni azione (il testo DOPO --)', () => {
  it('click/move/down/up con coordinate come argv separati', () => {
    expect(computerActionXdotoolArgs(click(10, 20))).toEqual(['mousemove', '--', '10', '20', 'click', '1'])
    expect(computerActionXdotoolArgs({ kind: 'click', x: 1, y: 2, button: 'right', double: true })).toEqual(
      ['mousemove', '--', '1', '2', 'click', '--repeat', '2', '--delay', '100', '3']
    )
    expect(computerActionXdotoolArgs({ kind: 'move', x: 5, y: 6 })).toEqual(['mousemove', '--', '5', '6'])
    expect(computerActionXdotoolArgs({ kind: 'down', x: 5, y: 6 })).toEqual(['mousemove', '--', '5', '6', 'mousedown', '1'])
    expect(computerActionXdotoolArgs({ kind: 'up', x: 5, y: 6 })).toEqual(['mousemove', '--', '5', '6', 'mouseup', '1'])
  })

  it('type: il testo è UN argomento dopo -- (niente shell, niente opzioni)', () => {
    expect(computerActionXdotoolArgs({ kind: 'type', text: 'ciao --click rm -rf /' })).toEqual(
      ['type', '--clearmodifiers', '--', 'ciao --click rm -rf /']
    )
    const args = computerActionXdotoolArgs({ kind: 'type', text: '$(reboot); x' })
    expect(args[args.length - 1]).toBe('$(reboot); x')
    expect(args.filter((a) => a === '--').length).toBe(1)
    expect(args.indexOf('--')).toBe(args.length - 2)
  })

  it('key: --clearmodifiers e il tasto come argomento', () => {
    expect(computerActionXdotoolArgs({ kind: 'key', key: 'ctrl+l' })).toEqual(['key', '--clearmodifiers', 'ctrl+l'])
  })

  it('scroll: bottone rotella 4-7 per direzione, tacche in --repeat, con o senza punto', () => {
    expect(computerActionXdotoolArgs({ kind: 'scroll', direction: 'down', amount: 2 })).toEqual(
      ['click', '--repeat', '2', '5']
    )
    expect(computerActionXdotoolArgs({ kind: 'scroll', direction: 'left' })).toEqual(['click', '--repeat', '3', '6'])
    expect(computerActionXdotoolArgs({ kind: 'scroll', direction: 'right' })).toEqual(['click', '--repeat', '3', '7'])
    expect(computerActionXdotoolArgs({ kind: 'scroll', direction: 'up', amount: 1, x: 100, y: 200 })).toEqual(
      ['mousemove', '--', '100', '200', 'click', '--repeat', '1', '4']
    )
  })

  it('wait non ha argv (l\'attesa la fa il daemon)', () => {
    expect(computerActionXdotoolArgs({ kind: 'wait', ms: 100 })).toEqual([])
  })
})
