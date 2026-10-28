// Test PURI del browser-guard (fase 11b, punto 2 + correzioni I3/I5/I6/I7):
// parser dei ref dello snapshot (ruolo, nome e testo in linea), validazione
// dei ref (solo ^[A-Za-z0-9]+$ presente nello snapshot), classificazione del
// rischio a PAROLE INTERE su qualunque ruolo (tabella IT/EN, password e carta
// deny, press_key Enter ask), il montaggio del result delle azioni (compose),
// troncamento, sfida anti-bot, URL dal result MCP e riconoscimento delle
// pagine costruite in JavaScript. Nessun Docker, nessuna rete, nessun Electron.
import { describe, expect, it } from 'vitest'
import {
  refInfo, browserActionRisk, truncateSnapshot, snapshotChallenge, browserPageUrl,
  composeBrowserResult, COMMIT_WORDS, CREDENTIAL_FIELD_WORDS, SNAPSHOT_MAX_CHARS,
  CREDENTIAL_DENY_TEXT, INVALID_REF_DENY_TEXT
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
  it('ruolo, nome e testo dell\'elemento col ref GIUSTO', () => {
    expect(refInfo(SNAP, 'e8')).toEqual({ role: 'button', name: 'Conferma prenotazione', text: '' })
    expect(refInfo(SNAP, 'e6')).toEqual({ role: 'textbox', name: 'Numero carta', text: '' })
    expect(refInfo(SNAP, 'e2')).toEqual({ role: 'link', name: 'Vedi il menu', text: '' })
    expect(refInfo(SNAP, 'e10')).toEqual({ role: 'button', name: 'Sign up now', text: '' })
  })
  it('il TESTO IN LINEA dopo i due punti, anche senza nome (riga vera I6)', () => {
    expect(refInfo('- generic [ref=e5] [cursor=pointer]: Paga ora', 'e5'))
      .toEqual({ role: 'generic', name: '', text: 'Paga ora' })
    // il nome con i due punti resta il NOME: il testo si prende DOPO il ref
    expect(refInfo('- textbox "Customer name:" [ref=f5e5]', 'f5e5'))
      .toEqual({ role: 'textbox', name: 'Customer name:', text: '' })
    expect(refInfo('- button " Login" [ref=f6e21] [cursor=pointer]', 'f6e21'))
      .toEqual({ role: 'button', name: ' Login', text: '' })
  })
  it('ref SCONOSCIUTO o snapshot mancante → null (e i prefissi non ingannano)', () => {
    expect(refInfo(SNAP, 'e99')).toBeNull()
    expect(refInfo(SNAP, '')).toBeNull()
    expect(refInfo(null, 'e8')).toBeNull()
    // e8 NON deve matchare e80: il token è delimitato
    expect(refInfo(SNAP + '\n- textbox "Altro" [ref=e80]', 'e8')).toEqual({ role: 'button', name: 'Conferma prenotazione', text: '' })
  })
  it('i caratteri strani nel ref non iniettano regex (vengono sanificati)', () => {
    expect(refInfo(SNAP, 'e.*')).toBeNull()
    expect(refInfo(SNAP, 'e]')).toBeNull()
  })
})

describe('I5: il ref deve essere ESATTAMENTE un ref dello snapshot', () => {
  const risk = (tool: string, args: Record<string, unknown>, snap: string | null = SNAP) =>
    browserActionRisk(tool, args, refInfo(snap, String(args.ref ?? '')))
  it('selettori e composizioni → DENY, mai ripuliti né passati a MCP', () => {
    for (const bad of ['[e5]', 'e5 >> css=#pay', '#pay', 'text=Paga', 'e.*', 'e 5', 'e5,', 'css=button']) {
      const r = risk('browser_click', { ref: bad })
      expect(r.kind, `ref ${JSON.stringify(bad)}`).toBe('deny')
      if (r.kind === 'deny') expect(r.reason).toBe(INVALID_REF_DENY_TEXT)
    }
    // click SENZA ref e type senza ref: stesso deny
    expect(risk('browser_click', {}).kind).toBe('deny')
    expect(risk('browser_type', { text: 'x' }).kind).toBe('deny')
  })
  it('browser_snapshot col ref segue la STESSA regola; senza ref resta libero', () => {
    expect(risk('browser_snapshot', { ref: '#pay' }).kind).toBe('deny')
    expect(risk('browser_snapshot', { ref: 'e99' }).kind).toBe('ask') // valido ma non presente
    expect(risk('browser_snapshot', {}).kind).toBe('free') // snapshot intero: nessun ref
  })
  it('ref ben formato e presente → ok (f5e44 come nei formati reali)', () => {
    expect(risk('browser_click', { ref: 'e2' }, '- link "Vedi il menu" [ref=e2]').kind).toBe('free')
    expect(risk('browser_click', { ref: 'f5e44' }, '- button "Submit order" [ref=f5e44]').kind).toBe('ask') // parola intera
  })
})

describe('browserActionRisk: la tabella IT ed EN (ask / deny / free) a parole intere', () => {
  const risk = (tool: string, args: Record<string, unknown>, snap: string | null, ref: string) =>
    browserActionRisk(tool, args, refInfo(snap, ref))

  it('click su elementi di invio o impegno → ASK (IT ed EN, case-insensitive, QUALUNQUE ruolo)', () => {
    for (const [ref, name] of [['e8', 'Conferma prenotazione'], ['e10', 'Sign up now']] as const) {
      const r = risk('browser_click', { ref }, SNAP, ref)
      expect(r.kind, name).toBe('ask')
      if (r.kind === 'ask') expect(r.reason).toContain(name)
    }
    // la lista in costante copre IT ed EN: ogni voce chiede su un pulsante omonimo
    for (const word of COMMIT_WORDS) {
      const snap = `- button "${word}" [ref=b1]`
      const r = risk('browser_click', { ref: 'b1' }, snap, 'b1')
      expect(r.kind, `voce ${word}`).toBe('ask')
    }
  })
  it('I6: la regola vale per OGNI ruolo cliccato, col nome E col testo in linea', () => {
    // generic senza nome, testo "Paga ora" dopo i due punti (riga vera)
    expect(risk('browser_click', { ref: 'e5' }, '- generic [ref=e5] [cursor=pointer]: Paga ora', 'e5').kind).toBe('ask')
    // le frasi multi-parola, nel nome e nel testo
    expect(risk('browser_click', { ref: 'g1' }, '- generic [ref=g1]: procedi al pagamento', 'g1').kind).toBe('ask')
    expect(risk('browser_click', { ref: 'g2' }, '- generic [ref=g2]: place order now', 'g2').kind).toBe('ask')
    // un ruolo che NON è button/link ora è controllato anche per il click
    expect(risk('browser_click', { ref: 'c1' }, '- cell "Conferma ordine" [ref=c1]', 'c1').kind).toBe('ask')
  })
  it('I6: PAROLA INTERA — sottostringhe di altre parole non contano', () => {
    expect(risk('browser_click', { ref: 'f1' }, '- link "Facebook" [ref=f1]', 'f1').kind).toBe('free')
    expect(risk('browser_click', { ref: 'b1' }, '- border [ref=b1]', 'b1').kind).toBe('free')
    expect(risk('browser_click', { ref: 'b2' }, '- button "borders" [ref=b2]', 'b2').kind).toBe('free')
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
  it('I6: browser_press_key con Invio → ASK; gli altri tasti restano free', () => {
    for (const key of ['Enter', 'NumpadEnter']) {
      const r = risk('browser_press_key', { key }, null, '')
      expect(r.kind, key).toBe('ask')
      if (r.kind === 'ask') expect(r.reason).toContain('Invio può inviare il modulo')
    }
    expect(risk('browser_press_key', { key: 'Tab' }, null, '').kind).toBe('free')
    expect(risk('browser_press_key', { key: 'Escape' }, null, '').kind).toBe('free')
    expect(risk('browser_press_key', { key: 'Control+a' }, null, '').kind).toBe('free')
  })
  it('browser_type con submit: true → ASK (anche su campi normali)', () => {
    const r = risk('browser_type', { ref: 'e4', text: 'Fabio', submit: true }, SNAP, 'e4')
    expect(r.kind).toBe('ask')
  })
  it('browser_type su password o carta → DENY, per OGNI ruolo in cui si scrive (parola intera)', () => {
    for (const [ref, name] of [['e6', 'Numero carta']] as const) {
      const r = risk('browser_type', { ref, text: '4242' }, SNAP, ref)
      expect(r.kind, name).toBe('deny')
      if (r.kind === 'deny') expect(r.reason).toBe(CREDENTIAL_DENY_TEXT)
    }
    // la lista in costante: ogni voce nega su un campo omonimo
    for (const word of CREDENTIAL_FIELD_WORDS) {
      const snap = `- textbox "${word}" [ref=c1]`
      const r = risk('browser_type', { ref: 'c1', text: 'x' }, snap, 'c1')
      expect(r.kind, `voce ${word}`).toBe('deny')
    }
    // I6: il deny vale per OGNI ruolo in cui si scrive, non solo textbox
    expect(risk('browser_type', { ref: 's1', text: '123' }, '- spinbutton "CVV" [ref=s1]', 's1').kind).toBe('deny')
    expect(risk('browser_type', { ref: 'c2', text: '4242' }, '- combobox "Card number" [ref=c2]', 'c2').kind).toBe('deny')
    expect(risk('browser_type', { ref: 's2', text: 'x' }, '- searchbox "Cerca nel sito" [ref=s2]', 's2').kind).toBe('free')
  })
  it('I6: PAROLA INTERA anche sui campi — "pin" NON è dentro "opinione" o "Shipping"', () => {
    expect(risk('browser_type', { ref: 'a1', text: 'Via Roma 1' }, '- textbox "Shipping address" [ref=a1]', 'a1').kind).toBe('free')
    expect(risk('browser_type', { ref: 'a2', text: 'Bello' }, '- textbox "La tua opinione" [ref=a2]', 'a2').kind).toBe('free')
    expect(risk('browser_type', { ref: 'a3', text: '1234' }, '- textbox "PIN" [ref=a3]', 'a3').kind).toBe('deny')
    // IT ed EN, maiuscole comprese
    expect(risk('browser_type', { ref: 'p', text: 'x' }, '- textbox "Password" [ref=p]', 'p').kind).toBe('deny')
    expect(risk('browser_type', { ref: 'p', text: 'x' }, '- textbox "Codice di sicurezza" [ref=p]', 'p').kind).toBe('deny')
  })
  it('le righe VERE viste dal revisore (I6)', () => {
    expect(risk('browser_click', { ref: 'f5e44' }, '- button "Submit order" [ref=f5e44]', 'f5e44').kind).toBe('ask')
    expect(risk('browser_type', { ref: 'f5e5', text: 'Fabio' }, '- textbox "Customer name:" [ref=f5e5]', 'f5e5').kind).toBe('free')
    expect(risk('browser_type', { ref: 'f6e20', text: 'hunter2' }, '- textbox "Password" [ref=f6e20]', 'f6e20').kind).toBe('deny')
    expect(risk('browser_click', { ref: 'f6e21' }, '- button " Login" [ref=f6e21] [cursor=pointer]', 'f6e21').kind).toBe('free')
  })
  it('ref ben formato ma SCONOSCIUTO (non nell\'ultimo snapshot) → ASK, anche senza snapshot', () => {
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

describe('I3: composeBrowserResult, il montaggio del result delle azioni', () => {
  // il result VERO di un'azione di Playwright MCP 0.0.83: lo snapshot è un LINK
  const ACTION = [
    '### Ran Playwright code',
    "await page.getByRole('link', { name: 'Vedi il menu' }).click();",
    '### Page',
    '- Page URL: https://quotes.toscrape.com/js/',
    '- Page Title: Quotes to Scrape',
    '### Snapshot',
    '- [Snapshot](.browser/output/page-2026-10-28T17-40-19-670Z.yml)'
  ].join('\n')
  const SNAPSHOT = '- heading "Quotes to Scrape" [ref=e1]\n- link "Login" [ref=e2]'
  it('righe di pagina dal result dell\'azione + snapshot INLINE chiesto a parte', () => {
    const out = composeBrowserResult(ACTION, SNAPSHOT)
    expect(out).toContain('- Page URL: https://quotes.toscrape.com/js/')
    expect(out).toContain('- Page Title: Quotes to Scrape')
    expect(out).toContain('[ref=e2]')
    // MAI il codice eseguito, il link al file né i path del box
    expect(out).not.toContain('### Ran Playwright code')
    expect(out).not.toContain('getByRole')
    expect(out).not.toContain('.browser/output')
    expect(out).not.toContain('[Snapshot]')
  })
  it('le sezioni ### Error e ### Modal state passano (con il loro corpo), ### Events no', () => {
    const action = [
      '### Ran Playwright code', 'await x();',
      '### Error', 'Timeout 30000ms exceeded.', 'waiting for locator "x"',
      '### Events', '- consoleerrored (ecc.)',
      '### Modal state', '- dialog "Sei sicuro?"'
    ].join('\n')
    const out = composeBrowserResult(action, '')
    expect(out).toContain('### Error')
    expect(out).toContain('Timeout 30000ms exceeded.')
    expect(out).toContain('### Modal state')
    expect(out).toContain('- dialog "Sei sicuro?"')
    expect(out).not.toContain('Events')
    expect(out).not.toContain('await x()')
  })
  it('la riga - HTTP status passa; senza snapshot resta la sola pagina', () => {
    const out = composeBrowserResult('- Page URL: https://x.example/a\n- HTTP status: 404', '')
    expect(out).toBe('- Page URL: https://x.example/a\n- HTTP status: 404')
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

describe('I7: il passaggio da web_fetch al browser (pagine SPA vere)', () => {
  it('la pagina "quotes/js" ridotta (2 script, uno inline grande) → true', () => {
    const html = '<html><head><title>Quotes to Scrape</title>' +
      '<script src="/jquery.min.js"></script>' +
      `<script>var data = ${'q'.repeat(3000)}</script>` +
      '</head><body><a href="/login">Login</a></body></html>'
    expect(looksJsBuiltPage(html, '# Quotes to Scrape [Login]')).toBe(true)
  })
  it('un bundle Vite (div root VUOTO + un solo script module) → true', () => {
    const html = '<html><body><div id="root"></div><script type="module" src="/assets/index-B2x.js"></script></body></html>'
    expect(looksJsBuiltPage(html, '')).toBe(true)
  })
  it('Next/Nuxt con contenitore di mount vuoto, anche con altro testo', () => {
    const next = '<html><body><div id="__next"></div><script src="/bundle.js"></script></body></html>'
    expect(looksJsBuiltPage(next, 'Caricamento…')).toBe(true)
  })
  it('un articolo con 3 script di analytics e 3.000 caratteri di testo → false', () => {
    const html = '<html><body><article>' + 'Testo dell\'articolo. '.repeat(130) + '</article>' +
      '<script src="/analytics1.js"></script><script src="/analytics2.js"></script><script src="/analytics3.js"></script></body></html>'
    expect(looksJsBuiltPage(html, 'Testo dell\'articolo. '.repeat(130))).toBe(false)
  })
  it('niente script o tanto testo → false; noscript basta da solo', () => {
    expect(looksJsBuiltPage('<html><body><p>Solo testo, nessuno script qui.</p></body></html>', 'Solo testo, nessuno script qui.')).toBe(false)
    expect(looksJsBuiltPage('<script src="/a.js"></script>', 'x'.repeat(600))).toBe(false)
    expect(looksJsBuiltPage('<noscript>Serve JavaScript</noscript><script src="/a.js"></script>', 'Benvenuto')).toBe(true)
    expect(JS_PAGE_HINT).toContain('browser_open')
  })
})
