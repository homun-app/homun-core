// Test PURI del browser-guard (fase 11b, punto 2): parser dei ref dello
// snapshot, classificazione del rischio delle azioni (tabella IT/EN, password
// e carta deny, ref sconosciuto ask), troncamento dello snapshot, sfida
// anti-bot, URL dal result MCP e riconoscimento delle pagine costruite in
// JavaScript. Nessun Docker, nessuna rete, nessun Electron.
import { describe, expect, it } from 'vitest'
import {
  refInfo, browserActionRisk, truncateSnapshot, snapshotChallenge, browserPageUrl,
  COMMIT_BUTTON_NAMES, CREDENTIAL_FIELD_NAMES, SNAPSHOT_MAX_CHARS, CREDENTIAL_DENY_TEXT
} from '../browser-guard'
import { looksJsBuiltPage, JS_PAGE_HINT } from '../web-guard'

const SNAP = [
  '- heading "Prenotazione cena" [ref=e1]',
  '- textbox "Nome" [ref=e4]',
  '- textbox "Numero carta" [ref=e6]',
  '- button "Conferma prenotazione" [ref=e8]',
  '- link "Vedi il menu" [ref=e2]',
  '- button "Sign up now" [ref=e10]'
].join('\n')

describe('refInfo: il parser dei ref dell\'ultimo snapshot', () => {
  it('ruolo e nome dell\'elemento col ref GIUSTO', () => {
    expect(refInfo(SNAP, 'e8')).toEqual({ role: 'button', name: 'Conferma prenotazione' })
    expect(refInfo(SNAP, 'e6')).toEqual({ role: 'textbox', name: 'Numero carta' })
    expect(refInfo(SNAP, 'e2')).toEqual({ role: 'link', name: 'Vedi il menu' })
    expect(refInfo(SNAP, 'e10')).toEqual({ role: 'button', name: 'Sign up now' })
  })
  it('ref SCONOSCIUTO o snapshot mancante → null (e i prefissi non ingannano)', () => {
    expect(refInfo(SNAP, 'e99')).toBeNull()
    expect(refInfo(SNAP, '')).toBeNull()
    expect(refInfo(null, 'e8')).toBeNull()
    // e8 NON deve matchare e80: il token è delimitato
    expect(refInfo(SNAP + '\n- textbox "Altro" [ref=e80]', 'e8')).toEqual({ role: 'button', name: 'Conferma prenotazione' })
  })
  it('i caratteri strani nel ref non iniettano regex (vengono sanificati)', () => {
    expect(refInfo(SNAP, 'e.*')).toBeNull()
    // "e8]" si sanifica in "e8": nessuna regex, solo il token pulito
    expect(refInfo(SNAP, 'e8]')).toEqual({ role: 'button', name: 'Conferma prenotazione' })
    expect(refInfo(SNAP, 'e]')).toBeNull()
  })
})

describe('browserActionRisk: la tabella IT ed EN (ask / deny / free)', () => {
  const risk = (tool: string, args: Record<string, unknown>, snap: string | null, ref: string) =>
    browserActionRisk(tool, args, refInfo(snap, ref))

  it('click su pulsante/link di invio o impegno → ASK (IT ed EN, case-insensitive)', () => {
    for (const [ref, name] of [['e8', 'Conferma prenotazione'], ['e10', 'Sign up now']] as const) {
      const r = risk('browser_click', { ref }, SNAP, ref)
      expect(r.kind, name).toBe('ask')
      if (r.kind === 'ask') expect(r.reason).toContain(name)
    }
    // la lista in costante copre IT ed EN: ogni parola chiede su un pulsante omonimo
    for (const word of COMMIT_BUTTON_NAMES) {
      const snap = `- button "${word}" [ref=b1]`
      const r = risk('browser_click', { ref: 'b1' }, snap, 'b1')
      expect(r.kind, `parola ${word}`).toBe('ask')
    }
  })
  it('click su link/pulsanti NON di invio e navigazione → FREE', () => {
    expect(risk('browser_click', { ref: 'e2' }, SNAP, 'e2').kind).toBe('free') // "Vedi il menu"
    expect(risk('browser_open', { url: 'https://x.example' }, null, '').kind).toBe('free')
    expect(risk('browser_snapshot', {}, null, '').kind).toBe('free')
    expect(risk('browser_back', {}, null, '').kind).toBe('free')
    expect(risk('browser_screenshot', {}, null, '').kind).toBe('free')
    // la digitazione in un campo NORMALE (es. ricerca) è free
    expect(risk('browser_type', { ref: 'e4', text: 'Fabio' }, SNAP, 'e4').kind).toBe('free')
  })
  it('browser_type con submit: true → ASK (anche su campi normali)', () => {
    const r = risk('browser_type', { ref: 'e4', text: 'Fabio', submit: true }, SNAP, 'e4')
    expect(r.kind).toBe('ask')
  })
  it('browser_type su password o carta → DENY (il bot non scrive MAI credenziali o pagamenti)', () => {
    for (const [ref, name] of [['e6', 'Numero carta']] as const) {
      const r = risk('browser_type', { ref, text: '4242' }, SNAP, ref)
      expect(r.kind, name).toBe('deny')
      if (r.kind === 'deny') expect(r.reason).toBe(CREDENTIAL_DENY_TEXT)
    }
    // la lista in costante: ogni parola nega su un textbox omonimo
    for (const word of CREDENTIAL_FIELD_NAMES) {
      const snap = `- textbox "${word}" [ref=c1]`
      const r = risk('browser_type', { ref: 'c1', text: 'x' }, snap, 'c1')
      expect(r.kind, `parola ${word}`).toBe('deny')
    }
    // IT ed EN, maiuscole comprese
    expect(risk('browser_type', { ref: 'p', text: 'x' }, '- textbox "Password" [ref=p]', 'p').kind).toBe('deny')
    expect(risk('browser_type', { ref: 'p', text: 'x' }, '- textbox "CVV code" [ref=p]', 'p').kind).toBe('deny')
  })
  it('ref SCONOSCIUTO (non nell\'ultimo snapshot) → ASK, anche senza snapshot', () => {
    const r = risk('browser_click', { ref: 'e42' }, SNAP, 'e42')
    expect(r.kind).toBe('ask')
    if (r.kind === 'ask') expect(r.reason).toContain('non presente nell\'ultimo snapshot')
    expect(risk('browser_click', { ref: 'e8' }, null, 'e8').kind).toBe('ask')
    expect(risk('browser_type', { ref: 'x', text: 'a' }, null, 'x').kind).toBe('ask')
  })
  it('browser_select su un menu noto → free (non è un invio)', () => {
    expect(risk('browser_select', { ref: 'e4', values: ['2'] }, SNAP, 'e4').kind).toBe('free')
  })
})

describe('troncamento dello snapshot (20.000 caratteri per result)', () => {
  it('breve resta così; lungo si taglia con la nota per restringere', () => {
    expect(truncateSnapshot('corto')).toEqual({ text: 'corto', truncated: false })
    const lungo = 'x'.repeat(SNAPSHOT_MAX_CHARS + 1000)
    const r = truncateSnapshot(lungo)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS + 100)
    expect(r.text).toContain('snapshot lungo: usa browser_snapshot con ref o depth')
  })
})

describe('sfida anti-bot nello snapshot e URL dal result', () => {
  it('snapshot con firma di sfida → challenge (il browser NON aggira i blocchi)', () => {
    expect(snapshotChallenge('- text "Just a moment..."')).toBe(true)
    expect(snapshotChallenge('- text "Verify you are human"')).toBe(true)
    // una pagina VERA con un modulo reCAPTCHA e contenuto NON è una sfida
    expect(snapshotChallenge('- heading "Trattoria" [ref=e1]\n- text "Menu, orari, prenotazioni online e molto altro testo di contenuto reale della pagina del ristorante."'.repeat(3))).toBe(false)
  })
  it("l'URL corrente si prende dalla riga Page URL del result MCP", () => {
    expect(browserPageUrl('Page URL: https://spa.example/prenota\n- button "x" [ref=e1]')).toBe('https://spa.example/prenota')
    expect(browserPageUrl('- naviga\n  Page URL: https://x.example/a')).toBe('https://x.example/a')
    expect(browserPageUrl('nessuna url qui')).toBeNull()
  })
})

describe('il passaggio da web_fetch al browser (decisione in codice)', () => {
  const SHELL = (n: number) => Array.from({ length: n }, (_, i) => `<script src="/_${i}.js"></script>`).join('')
  it('pochissimo testo + molti script = pagina costruita in JavaScript', () => {
    expect(looksJsBuiltPage(SHELL(6), 'Caricamento…')).toBe(true)
    expect(looksJsBuiltPage(SHELL(1), 'Testo lungo ' + 'x'.repeat(1000))).toBe(false)
    expect(looksJsBuiltPage(SHELL(8), ' '.repeat(600))).toBe(true) // dopo l'estrazione resta poco
    expect(JS_PAGE_HINT).toContain('browser_open')
  })
})
