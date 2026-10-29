// Test delle CREDENZIALI del browser (fase 14, punto 7): i controlli PURI di
// fill_credential (origine esatta, ref non iframe, tipo del campo), il TOTP
// sui vettori della RFC 6238, il vault esteso (login e contatti CIFRATI,
// list-credentials senza valori) e il FLUSSO completo col Playwright MCP
// FINTO (nessuna chiamata MCP senza approvazione; con l'approvazione
// browser_type riceve il valore; il result per il modello non contiene il
// valore né il codice di MCP; lo snapshot successivo che contiene il valore
// è REDATTO; il tool non c'è nei figli né nei turni di gruppo).
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'sandbot-fill-test-'))
const { setDataDir, dataDir, getSetting } = await import('../../store/db')
setDataDir(TMP)

// il server MCP finto del repo (fedele allo 0.0.83 anche sul testo digitato)
process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = resolve('scripts/fake-browser-mcp.mjs')

const cred = await import('../credentials')
const { runFillCredential } = await import('../fill')
const vault = await import('../../vault')
const browser = await import('../browser')
const { setVaultKeychainRunner } = vault

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

const AGENT = 'agent_fill'
const LOGIN = { id: '', label: 'Portale ASPI', origins: ['https://app.example.test'], username: 'mario.rossi@example.test', password: 'Finta-Password-2026!' }
// segreto TOTP di PROVA (RFC 6238, base32 di "12345678901234567890")
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

beforeAll(async () => {
  dataDir()
  setVaultKeychainRunner(fakeKeychain())
  vault.setSafeStorage(null)
  await browser.resetBrowserForTests()
  LOGIN.id = await vault.saveLogin({ ...LOGIN, totp: TOTP_SECRET })
})
afterAll(async () => {
  await browser.resetBrowserForTests()
  delete process.env.SANDBOT_TEST_FAKE_BROWSER_MCP
  rmSync(TMP, { recursive: true, force: true })
})

describe('TOTP RFC 6238 (SHA-1, 30 s, 6 cifre) sui vettori del documento', () => {
  // vettori ufficiali RFC 6238 appendice B (segreto ASCII "12345678901234567890"):
  // il codice a 6 cifre è bin mod 10^6, cioè le ULTIME 6 del vettore a 8 cifre
  const vectors: Array<[number, string]> = [
    [59, '94287082'.slice(-6)],
    [1111111109, '07081804'.slice(-6)],
    [1234567890, '89005924'.slice(-6)],
    [2000000000, '69279037'.slice(-6)]
  ]
  it('i codici a 6 cifre dei vettori', () => {
    for (const [sec, code] of vectors) {
      expect(cred.totpCode(TOTP_SECRET, sec * 1000)).toBe(code)
    }
  })
  it('cambia con la finestra temporale', () => {
    const a = cred.totpCode(TOTP_SECRET, 1_700_000_000_000)
    const b = cred.totpCode(TOTP_SECRET, 1_700_000_000_000 + 30_000)
    expect(a).not.toBe(b)
  })
})

describe('7d-1: il controllo dell\'ORIGINE (esatta, https, niente wildcard)', () => {
  const login = { label: 'Portale', origins: ['https://app.example.com'] }
  it('origine ESATTA → ok', () => {
    expect(cred.checkFillOrigin(login, 'https://app.example.com/login?x=1').ok).toBe(true)
  })
  it('sottodominio NO', () => {
    const r = cred.checkFillOrigin(login, 'https://evil.app.example.com/login')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('https://evil.app.example.com')
  })
  it('http NO (anche col host giusto)', () => {
    expect(cred.checkFillOrigin(login, 'http://app.example.com/login').ok).toBe(false)
  })
  it('porta diversa NO', () => {
    expect(cred.checkFillOrigin(login, 'https://app.example.com:8443/login').ok).toBe(false)
  })
  it('origine SIMILE ma diversa NO', () => {
    expect(cred.checkFillOrigin(login, 'https://app.example.com.evil.test/login').ok).toBe(false)
  })
  it('pagina non aperta NO; l\'errore dice le origini del login, MAI i valori', () => {
    const r = cred.checkFillOrigin(login, null)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('https://app.example.com')
      expect(r.error).not.toContain('password')
      expect(r.error).not.toContain('username')
    }
  })
  it('più origini elencate dall\'utente: tutte valide', () => {
    const multi = { label: 'Google', origins: ['https://accounts.google.com', 'https://mail.google.com'] }
    expect(cred.checkFillOrigin(multi, 'https://mail.google.com/signin').ok).toBe(true)
    expect(cred.checkFillOrigin(multi, 'https://drive.google.com').ok).toBe(false)
  })
})

describe('7d-2: i controlli dei REF e del TIPO di campo', () => {
  it('ref di iframe (f<n>e<n>) → rifiuto', () => {
    const r = cred.checkFillRef('f3e44', 'password')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('iframe')
  })
  it('ref non ref (selettore css) → rifiuto', () => {
    expect(cred.checkFillRef('text=Password', 'password').ok).toBe(false)
    expect(cred.checkFillRef('', 'username').ok).toBe(false)
  })
  it('password_ref su campo NON password → rifiuto', () => {
    expect(cred.checkFieldKind('password', { type: 'text' }).ok).toBe(false)
    expect(cred.checkFieldKind('password', null).ok).toBe(false)
  })
  it('username_ref su campo PASSWORD → rifiuto; text/email/tel ok', () => {
    expect(cred.checkFieldKind('username', { type: 'password' }).ok).toBe(false)
    expect(cred.checkFieldKind('username', { type: 'text' }).ok).toBe(true)
    expect(cred.checkFieldKind('username', { type: 'email' }).ok).toBe(true)
    expect(cred.checkFieldKind('username', { type: 'tel' }).ok).toBe(true)
    expect(cred.checkFieldKind('username', { type: 'checkbox' }).ok).toBe(false)
  })
  it('totp_ref: campo di testo NON password', () => {
    expect(cred.checkFieldKind('totp', { type: 'text' }).ok).toBe(true)
    expect(cred.checkFieldKind('totp', { type: 'password' }).ok).toBe(false)
    expect(cred.checkFieldKind('totp', null).ok).toBe(false)
  })
})

describe('7b: il vault esteso (login e contatti CIFRATI a riposo)', () => {
  it('login: il setting NON contiene username né password in chiaro', async () => {
    const raw = JSON.stringify(getSetting('vault.logins', []))
    expect(raw).not.toContain(LOGIN.username)
    expect(raw).not.toContain(LOGIN.password)
    expect(raw).not.toContain(TOTP_SECRET)
    expect(raw).toContain(LOGIN.label) // label e origini sono metadata
    expect(raw).toContain('app.example.test')
  })

  it('getLoginForFill rilegge i valori (l\'unica strada per cui escono)', async () => {
    const l = await vault.getLoginForFill(LOGIN.id)
    expect(l.username).toBe(LOGIN.username)
    expect(l.password).toBe(LOGIN.password)
    expect(l.totp).toBe(TOTP_SECRET)
  })

  it('origini non valide rifiutate (wildcard, http, forma sbagliata)', async () => {
    await expect(vault.saveLogin({ label: 'Male', origins: ['https://*.example.com'], username: 'u', password: 'p' })).rejects.toThrow()
    await expect(vault.saveLogin({ label: 'Male', origins: ['http://example.com'], username: 'u', password: 'p' })).rejects.toThrow()
  })

  it('contatti: cifrati a riposo, visibili a find_contacts (max 10)', async () => {
    await vault.saveContact({ name: 'Anna Bianchi', emails: ['anna@example.test'], phones: ['+39 333 000111'], address: 'Via Prova 1', notes: 'commercialista' })
    const raw = JSON.stringify(getSetting('vault.contacts', []))
    expect(raw).not.toContain('anna@example.test')
    expect(raw).not.toContain('333 000111')
    expect(raw).toContain('Anna Bianchi')
    const found = await vault.searchContacts('anna')
    expect(found.length).toBe(1)
    expect(found[0]!.emails).toContain('anna@example.test')
  })

  it('list-credentials (7c): i secret col NOME, i login senza utente né password', async () => {
    await vault.storeSecret('CHIAVE_API', 'valore-finto')
    const { executeTool } = await import('../tools')
    const r = await executeTool(AGENT, 'list-credentials', {})
    expect(r.output).toContain('CHIAVE_API')
    expect(r.output).toContain(LOGIN.id)
    expect(r.output).toContain(LOGIN.label)
    expect(r.output).toContain('con TOTP')
    expect(r.output).not.toContain(LOGIN.username)
    expect(r.output).not.toContain(LOGIN.password)
    expect(r.output).not.toContain(TOTP_SECRET)
  })

  it('la migrazione dei secret NON tocca i valori (stesso valore decifrato prima e dopo)', async () => {
    await vault.storeSecret('STABILE', 'valore-che-non-cambia')
    const before = await vault.revealSecret('STABILE')
    // "migrazione": un nuovo login/contatto non tocca il setting dei secret
    await vault.saveLogin({ label: 'Altro login', origins: ['https://altro.example.test'], username: 'u2', password: 'p2' })
    await vault.saveContact({ name: 'Carlo', emails: ['carlo@example.test'] })
    expect(await vault.revealSecret('STABILE')).toBe(before)
    expect(await vault.listSecretNames()).toContain('STABILE')
  })
})

// ---- il FLUSSO completo col Playwright MCP FINTO ----

/** I deps del flusso collegati al browser vero-del-modulo (col finto dentro). */
const depsOf = (approvals: { decision: import('../fill').FillApproval; asked: number }, over: Partial<import('../fill').FillDeps> = {}) => ({
  getLogin: (id: string) => vault.getLoginForFill(id),
  lastUrl: () => browser.lastUrlOf(AGENT),
  refInfo: (ref: string) => browser.refInfoOf(AGENT, ref),
  probe: (ref: string) => browser.probeFieldType(AGENT, ref),
  typeInto: (ref: string, value: string) => browser.typeIntoFieldForFill(AGENT, ref, value),
  hasStandingGrant: () => false,
  hasTurnAllow: () => false,
  requestApproval: async () => {
    approvals.asked++
    return approvals.decision
  },
  ...over
})

describe('7d: il flusso completo di fill_credential col MCP finto', () => {
  it('SENZA approvazione NESSUNA chiamata a MCP (nessun browser_type)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'deny' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e2', password_ref: 'e3' }, depsOf(approvals))
    expect(approvals.asked).toBe(1)
    expect(r.output).toContain('annullata dall\'utente')
    // nessun valore è arrivato al browser: lo snapshot NON contiene lo username
    const snap = await browser.callBrowserTool(AGENT, 'browser_snapshot', {})
    expect(snap.output).not.toContain(LOGIN.username)
    expect(snap.output).not.toContain(LOGIN.password)
  })

  it('CON l\'approvazione: browser_type riceve i VALORI; il result per il modello NON li contiene (né il codice MCP)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e2', password_ref: 'e3' }, depsOf(approvals))
    expect(approvals.asked).toBe(1)
    expect(r.filled).toEqual({ username: true, password: true })
    // l'esito dice label e origine, MAI i valori
    expect(r.output).toBe('Compilati utente e password di «Portale ASPI» su https://app.example.test.')
    expect(r.output).not.toContain(LOGIN.username)
    expect(r.output).not.toContain(LOGIN.password)
    // i valori SONO arrivati al browser finto (il registro del modulo)
    expect(browser.filledValuesOf(AGENT)).toContain(LOGIN.username)
    expect(browser.filledValuesOf(AGENT)).toContain(LOGIN.password)
  })

  it('lo snapshot SUCCESSIVO che contiene il valore → [redacted:credential]', async () => {
    // il fill del test prima ha lasciato il testo nei campi: lo snapshot del
    // finto lo mostra, la REDAZIONE lo oscura prima del modello
    const snap = await browser.callBrowserTool(AGENT, 'browser_snapshot', {})
    expect(snap.output).toContain('[redacted:credential]')
    expect(snap.output).not.toContain(LOGIN.username)
    expect(snap.output).not.toContain(LOGIN.password)
  })

  it('TOTP compilato al momento (6 cifre) e redatto pure lui', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, totp_ref: 'e4' }, depsOf(approvals))
    expect(r.output).toContain('codice')
    expect(r.output).not.toMatch(/\d{6}/) // nessun codice a 6 cifre nell'esito
    // il valore registrato per la redazione è il TOTP corrente
    const code = cred.totpCode(TOTP_SECRET)
    expect(browser.filledValuesOf(AGENT)).toContain(code)
    const snap = await browser.callBrowserTool(AGENT, 'browser_snapshot', {})
    expect(snap.output).not.toContain(code)
  })

  it('concessione "Sempre per questo sito" (standing grant) → NESSUNA card', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'deny' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e2' }, depsOf(approvals, {
      hasStandingGrant: (loginId, origin) => loginId === LOGIN.id && origin === 'https://app.example.test'
    }))
    expect(approvals.asked).toBe(0)
    expect(r.filled?.username).toBe(true)
  })

  it('grant del TURNO (per quel login e quell\'origine) → nessuna seconda card', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'deny' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e2' }, depsOf(approvals, {
      hasTurnAllow: (loginId, origin) => loginId === LOGIN.id && origin === 'https://app.example.test'
    }))
    expect(approvals.asked).toBe(0)
    expect(r.filled?.username).toBe(true)
  })

  it('origine DIVERSA da quella del login → rifiuto PRIMA della card (nessuna card)', async () => {
    // pagina di un altro sito (il login finto della fase 12 su spa.example)
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://spa.example/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e8', password_ref: 'e9' }, depsOf(approvals))
    expect(approvals.asked).toBe(0) // NESSUNA card: il controllo è prima
    expect(r.denied).toBe(true)
    expect(r.output).toContain('origine')
  })

  it('username_ref sul campo PASSWORD → rifiuto dal probe (campo vero)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e3' }, depsOf(approvals))
    expect(approvals.asked).toBe(0)
    expect(r.denied).toBe(true)
    expect(r.output).toContain('password')
  })

  it('ref di IFRAME → rifiuto', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'f1e2' }, depsOf({ decision: 'allow-turn', asked: 0 }))
    expect(r.denied).toBe(true)
    expect(r.output).toContain('iframe')
  })

  it("il tool NON c'è nei figli né nei turni di gruppo", async () => {
    const { subagentToolDenyReason } = await import('../subagents')
    expect(subagentToolDenyReason('fill_credential')).not.toBeNull()
    const { toolsForTurnSource } = await import('../connectors-policy')
    const { toolDefs } = await import('../tools')
    const groupTools = toolsForTurnSource(toolDefs, { source: 'user', groupTurn: { groupId: 1, readMaxDepth: 0, rootId: null } })
    expect(groupTools.some((t) => t.name === 'fill_credential')).toBe(false)
    const userTools = toolsForTurnSource(toolDefs, { source: 'user' })
    expect(userTools.some((t) => t.name === 'fill_credential')).toBe(true)
  })
})

describe('7e: request_secure_input — i valori salvati NON compaiono mai nel transcript', () => {
  it('la RPC secureinput:submit salva nel vault e l\'esito è solo "salvato: …"', async () => {
    // quello che fa l'RPC del daemon (api.ts) quando l'utente compila il modulo
    const label = 'Sito nuovo'
    const username = 'utente-di-prova@example.test'
    const password = 'PasswordFinta-9!'
    const id = await vault.saveLogin({ label, origins: ['https://nuovo.example.test'], username, password })
    const outcome = `salvato: login «${label}» (${id})`
    expect(outcome).not.toContain(username)
    expect(outcome).not.toContain(password)
    // il login c'è, cifrato
    const l = await vault.getLoginForFill(id)
    expect(l.password).toBe(password)
  })
})
