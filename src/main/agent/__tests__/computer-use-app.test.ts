// Fase use-app (U1, U2, U4, U5): executeUseApp col DESKTOP FINTO — tutto
// l'I/O (osascript, open, lsappinfo, screencapture) passa da un'interfaccia
// iniettata; qui nessun tasto e nessun clic arriva al Mac dove girano i test.
//
// U1: ogni azione di tastiera e mouse ha un'app di destinazione; prima di
//     eseguire Homun la riattiva e verifica che sia DAVVERO in primo piano
//     (lsappinfo, senza Accessibilità); mai dentro Homun stesso (nome o pid).
// U2: open_url apre l'indirizzo con `open` (array di argomenti, mai shell),
//     solo http/https.
// U4: gli errori di Accessibilità diventano UN risultato chiaro.
// U5: ogni risultato dice in quale app è finita l'azione.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  executeUseApp, setComputerUseIO, setHomunPidProvider, setScaleFactorProvider,
  ACCESSIBILITY_RESULT, HOMUN_SELF_RESULT, APP_REQUIRED_RESULT, isAccessibilityError,
  KEYBOARD_MOUSE_ACTIONS
} from '../../computeruse'
import { createFakeComputerUseIO, type FakeDesktop } from '../../computeruse/fake'

let desk: FakeDesktop

beforeEach(() => {
  desk = createFakeComputerUseIO({ frontmost: 'Finder', homunPid: 4242 })
  setComputerUseIO(desk.io)
  setHomunPidProvider(() => 4242)
  setScaleFactorProvider(() => 2)
})
afterEach(() => {
  setComputerUseIO(null)
  setHomunPidProvider(() => null)
})

describe('U1 — app di destinazione obbligatoria e verifica del primo piano', () => {
  it('le azioni di tastiera e mouse sono proprio queste cinque', () => {
    expect([...KEYBOARD_MOUSE_ACTIONS].sort()).toEqual(['click', 'double_click', 'key', 'right_click', 'type'])
  })

  it('app giusta già in primo piano → eseguita, e il testo finisce in quell’app', async () => {
    desk.state.frontmost = 'Safari'
    const r = await executeUseApp({ action: 'type', text: 'ciao', app: 'Safari' })
    expect(r.error).toBeFalsy()
    expect(r.output).toBe('Typed 4 characters into Safari')
    expect(desk.records.filter((x) => x.op === 'type')).toEqual([{ op: 'type', text: 'ciao', into: 'Safari' }])
  })

  it('Homun davanti dopo l’approvazione → Homun riattiva l’app, POI esegue', async () => {
    desk.state.frontmost = 'Homun'
    const r = await executeUseApp({ action: 'type', text: 'https://sora.chatgpt.com', app: 'Safari' })
    expect(r.error).toBeFalsy()
    expect(r.output).toBe('Typed 24 characters into Safari')
    const ops = desk.records.map((x) => x.op)
    // prima l'attivazione (open -a Safari), poi la digitazione
    expect(ops.indexOf('open')).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf('open')).toBeLessThan(ops.indexOf('type'))
    expect(desk.records.find((x) => x.op === 'open')).toEqual({ op: 'open', args: ['-a', 'Safari'] })
    expect(desk.records.find((x) => x.op === 'type')).toEqual({ op: 'type', text: 'https://sora.chatgpt.com', into: 'Safari' })
  })

  it('riattivazione impossibile (resta davanti un’altra app) → NON eseguita, col messaggio', async () => {
    desk.state.frontmost = 'Mail'
    desk.state.activates = false
    const r = await executeUseApp({ action: 'type', text: 'ciao', app: 'Safari' })
    expect(r.error).toBe(true)
    expect(r.output).toBe('Not executed: the app in front is Mail, not Safari. Nothing was typed.')
    expect(desk.records.some((x) => x.op === 'type')).toBe(false)
  }, 10_000)

  it('riattivazione impossibile e davanti resta HOMUN → rifiutata (mai tasti dentro Homun)', async () => {
    desk.state.frontmost = 'Homun'
    desk.state.activates = false
    const r = await executeUseApp({ action: 'key', key: 'cmd+a', app: 'Safari' })
    expect(r.error).toBe(true)
    expect(r.output).toBe(HOMUN_SELF_RESULT)
    expect(desk.records.some((x) => x.op === 'key')).toBe(false)
  })

  it('Homun si riconosce dal PID anche quando il processo si chiama Electron (app di sviluppo)', async () => {
    desk.state.frontmost = 'Electron'
    desk.state.pids = { Electron: 4242 }
    desk.state.activates = false
    const r = await executeUseApp({ action: 'click', x: 10, y: 10, app: 'Safari' })
    expect(r.error).toBe(true)
    expect(r.output).toBe(HOMUN_SELF_RESULT)
    expect(desk.records.some((x) => x.op === 'click')).toBe(false)
  })

  it('app = Homun → rifiutata senza nemmeno attivarla', async () => {
    for (const app of ['Homun', 'homun', 'Homun.app']) {
      desk.records.length = 0
      const r = await executeUseApp({ action: 'type', text: 'x', app })
      expect(r.error).toBe(true)
      expect(r.output).toBe(HOMUN_SELF_RESULT)
      expect(desk.records).toEqual([])
    }
  })

  it('app mancante → errore chiaro per OGNI azione di tastiera e mouse, niente eseguito', async () => {
    for (const action of KEYBOARD_MOUSE_ACTIONS) {
      const r = await executeUseApp({ action, text: 'x', key: 'Return', x: 1, y: 1 })
      expect(r.error).toBe(true)
      expect(r.output).toBe(APP_REQUIRED_RESULT)
    }
    expect(desk.records).toEqual([])
    expect(APP_REQUIRED_RESULT).toBe('`app` is required: name the app that must receive this action (e.g. Safari).')
  })

  it('la verifica del primo piano usa lsappinfo, mai osascript (niente Accessibilità per guardare)', async () => {
    desk.state.frontmost = 'Safari'
    await executeUseApp({ action: 'type', text: 'ciao', app: 'Safari' })
    const beforeType = desk.records.slice(0, desk.records.findIndex((x) => x.op === 'type'))
    expect(beforeType.some((x) => x.op === 'lsappinfo')).toBe(true)
    expect(beforeType.some((x) => x.op === 'osascript')).toBe(false)
  })

  it('il nome dell’app si confronta senza badare a maiuscole e .app', async () => {
    desk.state.frontmost = 'Safari'
    const r = await executeUseApp({ action: 'type', text: 'ok', app: 'safari.app' })
    expect(r.error).toBeFalsy()
    expect(r.output).toBe('Typed 2 characters into Safari')
  })
})

describe('U2 — open_url', () => {
  it('apre http/https nel browser predefinito con `open <url>` (array di argomenti, nessuna shell)', async () => {
    const r = await executeUseApp({ action: 'open_url', url: 'https://sora.chatgpt.com' })
    expect(r.error).toBeFalsy()
    expect(r.output).toBe('Opened https://sora.chatgpt.com in the default browser')
    expect(desk.records).toEqual([{ op: 'open_url', url: 'https://sora.chatgpt.com', args: ['https://sora.chatgpt.com'] }])
  })

  it('con app sceglie il browser: `open -a Safari <url>`', async () => {
    const r = await executeUseApp({ action: 'open_url', url: 'http://127.0.0.1:8080/x', app: 'Safari' })
    expect(r.error).toBeFalsy()
    expect(r.output).toBe('Opened http://127.0.0.1:8080/x in Safari')
    expect(desk.records).toEqual([{ op: 'open_url', url: 'http://127.0.0.1:8080/x', app: 'Safari', args: ['-a', 'Safari', 'http://127.0.0.1:8080/x'] }])
  })

  it('rifiuta file:, javascript:, data: e gli indirizzi malformati — senza aprire nulla', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://x.example', 'sora.chatgpt.com', '']) {
      const r = await executeUseApp({ action: 'open_url', url })
      expect(r.error, url).toBe(true)
      expect(r.output, url).toContain('only http: and https:')
    }
    expect(desk.records).toEqual([])
  })

  it('un argomento con spazi o caratteri di shell resta UN argomento (nessuna interpolazione)', async () => {
    const url = 'https://x.example/a b?q=$(id)&r=`id`'
    await executeUseApp({ action: 'open_url', url })
    expect(desk.records).toEqual([{ op: 'open_url', url, args: [url] }])
  })
})

describe('U4 — Accessibilità mancante: un risultato unico', () => {
  it('riconosce -25211, -1719 e i testi inglese/italiano', () => {
    expect(isAccessibilityError('osascript: non ammette l’accesso di assistenza (-25211)')).toBe(true)
    expect(isAccessibilityError('System Events got an error: osascript is not allowed assistive access. (-25211)')).toBe(true)
    expect(isAccessibilityError('execution error: System Events got an error: Application isn’t running. (-1719)')).toBe(true)
    expect(isAccessibilityError('osascript non ammette l\'accesso di assistenza')).toBe(true)
    expect(isAccessibilityError('execution error: syntax error (-2741)')).toBe(false)
    expect(isAccessibilityError('')).toBe(false)
  })

  it('un click negato dall’Accessibilità → il testo unico, con la bandierina per il loop', async () => {
    desk.state.frontmost = 'Safari'
    desk.state.denyAccessibility = true
    const r = await executeUseApp({ action: 'click', x: 1500, y: 1098, app: 'Safari' })
    expect(r.error).toBe(true)
    expect(r.accessibilityError).toBe(true)
    expect(r.output).toBe(ACCESSIBILITY_RESULT)
    expect(ACCESSIBILITY_RESULT).toBe(
      'Homun needs the macOS Accessibility permission for clicks and typing. Tell the user to enable Homun in System Settings → Privacy & Security → Accessibility, then try again. Do not retry before the user confirms.'
    )
  })

  it('anche type e key negati danno lo stesso testo; un altro errore resta com’era', async () => {
    desk.state.frontmost = 'Safari'
    desk.state.denyAccessibility = true
    const t = await executeUseApp({ action: 'type', text: 'x', app: 'Safari' })
    const k = await executeUseApp({ action: 'key', key: 'Return', app: 'Safari' })
    expect(t.output).toBe(ACCESSIBILITY_RESULT)
    expect(k.output).toBe(ACCESSIBILITY_RESULT)
    desk.state.denyAccessibility = false
    desk.state.osascriptError = 'execution error: syntax error (-2741)'
    const o = await executeUseApp({ action: 'type', text: 'x', app: 'Safari' })
    expect(o.error).toBe(true)
    expect(o.accessibilityError).toBeFalsy()
    expect(o.output).toBe('Type failed: execution error: syntax error (-2741)')
  })
})

describe('U5 — il risultato dice dove è finita l’azione', () => {
  it('type, key e i click nominano l’app; le coordinate sono in punti schermo', async () => {
    desk.state.frontmost = 'Safari'
    expect((await executeUseApp({ action: 'type', text: 'https://sora.chatgpt.com\n', app: 'Safari' })).output).toBe('Typed 25 characters into Safari')
    expect((await executeUseApp({ action: 'key', key: 'cmd+l', app: 'Safari' })).output).toBe('Pressed cmd+l in Safari')
    expect((await executeUseApp({ action: 'click', x: 1290, y: 148, app: 'Safari' })).output).toBe('click at (645, 74) in Safari')
    expect((await executeUseApp({ action: 'double_click', x: 20, y: 40, app: 'Safari' })).output).toBe('double_click at (10, 20) in Safari')
    expect((await executeUseApp({ action: 'right_click', x: 20, y: 40, app: 'Safari' })).output).toBe('right_click at (10, 20) in Safari')
  })

  it('open_app riporta l’app DAVVERO in primo piano dopo l’apertura', async () => {
    const r = await executeUseApp({ action: 'open_app', app: 'Safari' })
    expect(r.error).toBeFalsy()
    expect(r.output).toBe('App "Safari" activated; the app in front is now Safari')
    // se un'altra app resta davanti il risultato lo dice, senza mentire
    desk.state.activates = false
    desk.state.frontmost = 'Mail'
    const r2 = await executeUseApp({ action: 'open_app', app: 'Safari' })
    expect(r2.output).toBe('App "Safari" activated; the app in front is now Mail')
  })
})

// ---- U2/U3: la descrizione di use-app che legge il modello ----

describe('U2/U3 — lo schema e la descrizione di use-app', () => {
  it('open_url è nell\'enum con la proprietà url; la descrizione dice di usare open_url per le pagine e `app` per tastiera e mouse', async () => {
    const { toolDefs } = await import('../tools')
    const def = toolDefs.find((t) => t.name === 'use-app')!
    expect(def).toBeTruthy()
    const params = def.parameters as { properties: Record<string, { enum?: string[]; description?: string }> }
    expect(params.properties.action!.enum).toContain('open_url')
    expect(params.properties.url).toBeTruthy()
    // il testo per il modello: open_url al posto di digitare gli indirizzi…
    expect(def.description).toContain('open_url')
    expect(def.description).toContain('instead of typing an address')
    // …e l'app di destinazione obbligatoria per tastiera e mouse
    expect(def.description).toContain('REQUIRES `app`')
    expect(params.properties.app!.description).toContain('REQUIRED for type/key/click')
  })
})
