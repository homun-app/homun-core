// Test della NOTA SUL LOGIN nel result del browser (fase 19a, correzioni 3,
// M5): la parte PURA (loginFormNote — origine esatta come checkFillOrigin,
// testi inglesi ALLA LETTERA, mai valori del vault, label neutralizzata) e la
// parte del MANAGER col Playwright MCP FINTO (scripts/fake-browser-mcp.mjs,
// che risponde anche alla sonda LOGIN_FORM_FN): la nota in fondo al result
// dopo una riga vuota, UNA volta sola per pagina, la sfida che vince, la
// sonda fallita che non aggiunge niente, i FIGLI senza nota e il controllo
// utente attivo senza nota. Nessun Docker, nessuna rete reale.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// la temporanea della suite: mkdtemp nella directory voluta (mai $TMPDIR)
const TMP = mkdtempSync(join('/var/folders/nb/r6fbsdsn3z58bkbb9w55nn780000gn/T', 'sandbot-login-note-'))
const { setDataDir } = await import('../../store/db')
setDataDir(TMP)

// il server MCP finto del repo (fedele anche sulla sonda del form di login)
process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = resolve('scripts/fake-browser-mcp.mjs')

// il controllo utente attivo si simula QUI: userControlActive vive nelle
// connessioni ws dello schermo del daemon (screen.ts); il resto del modulo
// resta quello VERO (browserHoldMs, screenBrowserClosed)
const control = vi.hoisted(() => ({ active: false }))
vi.mock('../screen', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  userControlActive: () => control.active
}))

const cred = await import('../credentials')
const browser = await import('../browser')
const vault = await import('../../vault')
const { createAgent } = await import('../../store/db')
const { setVaultKeychainRunner } = vault
// fase rilascio — correzioni (K1): il backend delle chiavi master FINTO
// (come registra il daemon): senza, il vault resta bloccato
const { setMasterKeyStorage } = await import('../../../daemon/master-keys')
setMasterKeyStorage({
  isEncryptionAvailable: () => true,
  encryptString: async (plain: string) => Buffer.from('FAKE:' + plain),
  decryptString: async (enc: Buffer) => enc.toString().replace(/^FAKE:/, '')
})


// keychain finto come vault-keychain.test.ts (chiave mai negli argv)
const fakeKeychain = (): import('../../../daemon/keychain').SecurityRunner => {
  const store = new Map<string, string>()
  return async (args: string[], input?: string) => {
    if (args[0] === 'find-generic-password') {
      const svc = args[args.indexOf('-s') + 1]
      const v = store.get(svc!)
      return v ? { out: v + '\n', err: '', code: 0 } : { out: '', err: 'not found', code: 1 }
    }
    if (args[0] === '-i') {
      const line = String(input ?? '').split('\n')[0] ?? ''
      const svc = line.split(' -s ')[1]?.split(' ')[0]
      const val = line.split(' -w ')[1]?.split(' ')[0]
      if (svc && val) {
        store.set(svc, val)
        return { out: '', err: '', code: 0 }
      }
      return { out: '', err: 'no', code: 1 }
    }
    return { out: '', err: 'no', code: 1 }
  }
}

const AGENT = 'agent_note'
const LOGIN_PAGE = 'https://app.example.test/login'
const NOTE_NONE_APPTEST =
  'This page has a sign-in form and no login is saved for https://app.example.test. If you need to sign in, call request_takeover: the user signs in on your screen. Never ask for the password in chat.'

beforeAll(async () => {
  setVaultKeychainRunner(fakeKeychain())
  vault.setSafeStorage(null)
  await browser.resetBrowserForTests()
})
beforeEach(async () => {
  control.active = false
  await browser.resetBrowserForTests()
})
afterAll(async () => {
  await browser.resetBrowserForTests()
  delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
  rmSync(TMP, { recursive: true, force: true })
})

// ---- M5.1: la parte PURA (loginFormNote) ----

describe('M5.1: loginFormNote — la nota del form di login (puro, testi alla lettera)', () => {
  const saved = [{ id: 'login_a1', label: 'Portale ASPI', origins: ['https://app.example.com'] }]

  it('login ESATTO → nota «saved» con label e id, e dice fill_credential', () => {
    expect(cred.loginFormNote('https://app.example.com/login?x=1', saved))
      .toBe('This page has a sign-in form and a login is saved for https://app.example.com: "Portale ASPI" (login_a1). To sign in, use fill_credential with that id.')
  })

  it('NESSUN login → nota «no login» con request_takeover e il divieto della password in chat', () => {
    expect(cred.loginFormNote('https://ordini.example.com/login', []))
      .toBe('This page has a sign-in form and no login is saved for https://ordini.example.com. If you need to sign in, call request_takeover: the user signs in on your screen. Never ask for the password in chat.')
  })

  it('sottodominio, porta diversa o login di un ALTRO sito → nota «no login» (origine esatta, come checkFillOrigin)', () => {
    expect(cred.loginFormNote('https://evil.app.example.com/login', saved)).toContain('no login is saved for https://evil.app.example.com')
    expect(cred.loginFormNote('https://app.example.com:8443/login', saved)).toContain('no login is saved')
    expect(cred.loginFormNote('https://example.org/login', saved)).toContain('no login is saved')
    // nemmeno un dominio SIMILE al login passa (anti-phishing)
    expect(cred.loginFormNote('https://app.example.com.evil.test/login', saved)).toContain('no login is saved')
  })

  it('http o URL non valido → null (niente nota)', () => {
    expect(cred.loginFormNote('http://app.example.com/login', saved)).toBeNull()
    expect(cred.loginFormNote('non un url', saved)).toBeNull()
    expect(cred.loginFormNote('', saved)).toBeNull()
  })

  it('DUE login per la stessa origine → il PRIMO', () => {
    const two = [
      { id: 'login_p1', label: 'Primo', origins: ['https://app.example.com'] },
      { id: 'login_p2', label: 'Secondo', origins: ['https://app.example.com'] }
    ]
    const note = cred.loginFormNote('https://app.example.com/login', two)
    expect(note).toContain('(login_p1)')
    expect(note).not.toContain('login_p2')
  })

  it('label con a capo → NEUTRALIZZATA (una riga sola, troncata)', () => {
    const note = cred.loginFormNote('https://app.example.com/login', [
      { id: 'login_n1', label: 'Portale\nASPI\r\ndi prova', origins: ['https://app.example.com'] }
    ])
    expect(note).toContain('"Portale ASPI di prova"')
    expect(note).not.toMatch(/[\r\n]/)
    // la neutralizzazione tronca come i testi che tornano al modello (previewOf)
    const long = cred.loginFormNote('https://app.example.com/login', [
      { id: 'login_n2', label: 'Lungo '.repeat(40), origins: ['https://app.example.com'] }
    ])
    expect(long).toContain('…')
    expect(long!.length).toBeLessThan(300)
  })

  it("l'hash dell'URL non cambia l'origine", () => {
    expect(cred.loginFormNote('https://app.example.com/login#sezione', saved))
      .toBe(cred.loginFormNote('https://app.example.com/login', saved))
  })
})

// ---- M5.3: il manager (runBrowserTool col MCP finto) ----

describe('M5.3: la nota del login nel result del browser (col MCP finto)', () => {
  it("pagina col form e vault VUOTO → nota in fondo (dopo una riga vuota) e meta.loginForm = 'none'", async () => {
    const r = await browser.callBrowserTool(AGENT, 'browser_open', { url: LOGIN_PAGE })
    expect(r.meta.browserPage).toBe(true)
    expect(r.output.endsWith('\n\n' + NOTE_NONE_APPTEST)).toBe(true)
    expect(r.output.split('This page has a sign-in form').length - 1).toBe(1) // UNA volta sola
    expect(r.meta.loginForm).toBe('none')
    expect(r.meta.challenge).toBeUndefined()
  })

  it('secondo snapshot della STESSA URL → niente nota (e niente meta.loginForm)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: LOGIN_PAGE })
    const snap = await browser.callBrowserTool(AGENT, 'browser_snapshot', {})
    expect(snap.output).not.toContain('sign-in form')
    expect(snap.meta.loginForm).toBeUndefined()
    // vale anche RIAPRENDO la stessa URL con un hash diverso (l’URL senza hash è quella)
    const again = await browser.callBrowserTool(AGENT, 'browser_open', { url: LOGIN_PAGE + '#sezione' })
    expect(again.output).not.toContain('sign-in form')
    expect(again.meta.loginForm).toBeUndefined()
  })

  it('nuova URL → la nota TORNA', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: LOGIN_PAGE })
    const other = await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/login' })
    expect(other.output).toContain('This page has a sign-in form and no login is saved for https://spa.example.')
    expect(other.meta.loginForm).toBe('none')
  })

  it("pagina col form e login SALVATO per quell'origine → nota «saved» con label e id", async () => {
    const id = await vault.saveLogin({ label: 'Portale finto', origins: ['https://spa.example'], username: 'utente@example.test', password: 'Finta-Password-7!' })
    const r = await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/login' })
    expect(r.output.endsWith(`\n\nThis page has a sign-in form and a login is saved for https://spa.example: "Portale finto" (${id}). To sign in, use fill_credential with that id.`)).toBe(true)
    expect(r.meta.loginForm).toBe('saved')
    // la nota non contiene MAI i valori del vault
    expect(r.output).not.toContain('utente@example.test')
    expect(r.output).not.toContain('Finta-Password-7!')
  })

  it('pagina con la SFIDA anti-bot → solo SNAPSHOT_BLOCKED_NOTE, niente nota del login', async () => {
    const r = await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://protetto.example/login' })
    expect(r.output).toContain('Page blocked by an anti-bot check')
    expect(r.output).not.toContain('sign-in form')
    expect(r.meta.challenge).toBe(true)
    expect(r.meta.loginForm).toBeUndefined()
  })

  it('sonda FALLITA → nessuna nota e NESSUN errore', async () => {
    const r = await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://sonda.example/login-fallita' })
    expect(r.output).toContain('- Page URL: https://sonda.example/login-fallita')
    expect(r.output).not.toContain('sign-in form')
    expect(r.meta.browserError).toBeUndefined()
    expect(r.meta.loginForm).toBeUndefined()
  })

  it('agente FIGLIO → nessuna nota (non ha né fill_credential né request_takeover)', async () => {
    createAgent('Figlio della nota', '', { createdBy: AGENT, parentId: AGENT, id: 'sub_note01' })
    const r = await browser.callBrowserTool('sub_note01', 'browser_open', { url: LOGIN_PAGE })
    expect(r.output).not.toContain('sign-in form')
    expect(r.meta.loginForm).toBeUndefined()
  })

  it('controllo utente ATTIVO → nessuna nota (è l’utente che sta accedendo)', async () => {
    control.active = true
    const blocked = await browser.callBrowserTool(AGENT, 'browser_open', { url: LOGIN_PAGE })
    expect(blocked.output).not.toContain('sign-in form')
    expect(blocked.meta.loginForm).toBeUndefined()
    // appena il controllo finisce, sulla STESSA pagina (che non ha ancora
    // ricevuto la nota) la nota arriva: il blocco era il controllo utente
    control.active = false
    const after = await browser.callBrowserTool(AGENT, 'browser_open', { url: LOGIN_PAGE })
    expect(after.output).toContain('sign-in form')
    expect(after.meta.loginForm).toBe('none')
  })

  it('pagina SENZA campo password → nessuna nota (la sonda dice false)', async () => {
    const r = await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/offerte' })
    expect(r.output).not.toContain('sign-in form')
    expect(r.meta.loginForm).toBeUndefined()
  })
})
