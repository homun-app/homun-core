// Test delle CREDENZIALI del browser (fase 14, punto 7): i controlli PURI di
// fill_credential (origine esatta, ref validi, tipo del campo), il TOTP
// sui vettori della RFC 6238, il vault esteso (login e contatti CIFRATI,
// list-credentials senza valori) e il FLUSSO completo col Playwright MCP
// FINTO (nessuna chiamata MCP senza approvazione; con l'approvazione
// browser_type riceve il valore; il result per il modello non contiene il
// valore né il codice di MCP; lo snapshot successivo che contiene il valore
// è REDATTO; il tool non c'è nei figli né nei turni di gruppo). Q2 (fase 14
// correzioni 2): dal finto FEDELE, dalla seconda navigazione i ref della
// pagina principale hanno il prefisso f<n> — il fill li ACCETTE (il prefisso
// non è un segnale di iframe), l'iframe lo scopre solo il probe (top:false).
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// cartelle temporanee SOLO con mkdtemp nella directory fissata
const TMP_BASE = TEST_TMP_BASE
// fase 17c: la lingua dell'interfaccia dei test è l'italiano (i testi erano italiani prima)
import { setSetting } from '../../store/db'
import { TEST_TMP_BASE } from '../../../test-tmp'
setSetting('ui.activeLanguage', 'it')

const TMP = mkdtempSync(join(TMP_BASE, 'sandbot-fill-test-'))
const { setDataDir, dataDir, getSetting } = await import('../../store/db')
setDataDir(TMP)

// il server MCP finto del repo (fedele allo 0.0.83 anche sul testo digitato)
process.env.SANDBOT_TEST_FAKE_BROWSER_MCP = resolve('scripts/fake-browser-mcp.mjs')

const cred = await import('../credentials')
const { runFillCredential } = await import('../fill')
const vault = await import('../../vault')
const browser = await import('../browser')
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
// Q2: il finto, come il VERO Playwright MCP, prefissa i ref (f<n>) dalla
// SECONDA navigazione della sessione — ogni test riparte da una sessione
// NUOVA (prima navigazione: ref e<n>), i test del prefisso fanno le due
// navigazioni loro
beforeEach(async () => {
  await browser.resetBrowserForTests()
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
  it('Q2: ref f<n>e<n> → ACCETTATO (il prefisso non dice iframe: dalla seconda navigazione lo hanno anche i campi del documento top)', () => {
    // nel Playwright MCP vero la STESSA pagina, riaperta, dà ref f1e5: è il
    // caso d'uso normale del login (apro il sito, clicco "Accedi"…). Il
    // controllo del formato resta, il campo iframe lo scopre solo il probe
    const r = cred.checkFillRef('f1e5', 'password')
    expect(r).toEqual({ ok: true, ref: 'f1e5' })
    expect(cred.checkFillRef('f12e34', 'username').ok).toBe(true)
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
    expect(r.output).toContain('with TOTP')
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
  // fase 17c correzioni (D3): la card riceve CODICI, non parole italiane
  it('i campi passati alla card sono i codici username/password/totp', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    let asked: string[] | null = null
    const r = await runFillCredential(
      { id: LOGIN.id, username_ref: 'e2', password_ref: 'e3', totp_ref: 'e4' },
      depsOf({ decision: 'allow-turn', asked: 0 }, {
        requestApproval: async (_login, _origin, fields) => {
          asked = fields
          return 'allow-turn'
        }
      })
    )
    expect(asked).toEqual(['username', 'password', 'totp'])
    expect(r.filled).toEqual({ username: true, password: true, totp: true })
  })

  it('SENZA approvazione NESSUNA chiamata a MCP (nessun browser_type)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'deny' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e2', password_ref: 'e3' }, depsOf(approvals))
    expect(approvals.asked).toBe(1)
    expect(r.output).toContain('cancelled by the user')
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
    expect(r.output).toBe('Filled username and password of "Portale ASPI" on https://app.example.test.')
    expect(r.output).not.toContain(LOGIN.username)
    expect(r.output).not.toContain(LOGIN.password)
    // i valori SONO arrivati al browser finto (il registro del modulo)
    expect(browser.filledValuesOf(AGENT)).toContain(LOGIN.username)
    expect(browser.filledValuesOf(AGENT)).toContain(LOGIN.password)
  })

  it('lo snapshot SUCCESSIVO che contiene il valore → [redacted:credential]', async () => {
    // il fill lascia il testo nei campi: lo snapshot del finto lo mostra, la
    // REDAZIONE lo oscura prima del modello (il fill lo fa il test STESSO:
    // con la sessione nuova per test niente dipende dall'ordine dei test)
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    await runFillCredential({ id: LOGIN.id, username_ref: 'e2', password_ref: 'e3' }, depsOf({ decision: 'allow-turn', asked: 0 }))
    const snap = await browser.callBrowserTool(AGENT, 'browser_snapshot', {})
    expect(snap.output).toContain('[redacted:credential]')
    expect(snap.output).not.toContain(LOGIN.username)
    expect(snap.output).not.toContain(LOGIN.password)
  })

  it('TOTP compilato al momento (6 cifre) e redatto pure lui', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, totp_ref: 'e4' }, depsOf(approvals))
    expect(r.output).toContain('code')
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
    expect(r.output).toContain('origin')
  })

  it('username_ref sul campo PASSWORD → rifiuto dal probe (campo vero)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'e3' }, depsOf(approvals))
    expect(approvals.asked).toBe(0)
    expect(r.denied).toBe(true)
    expect(r.output).toContain('password')
  })

  it('Q2: ref f<n>e<n> del documento TOP (seconda navigazione) → card e COMPILAZIONE', async () => {
    // come nel Playwright MCP vero: dalla SECONDA navigazione nella scheda i
    // ref della pagina PRINCIPALE escono col prefisso f (f1e2, f1e3…). Il
    // prefisso non è un segnale di iframe — il probe dice top:true, il tipo
    // e l'origine sono giusti: il fill passa e compila
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const r = await runFillCredential({ id: LOGIN.id, username_ref: 'f1e2', password_ref: 'f1e3' }, depsOf(approvals))
    expect(approvals.asked).toBe(1) // la card ARRIVA: i controlli sono passati
    expect(r.filled).toEqual({ username: true, password: true })
    expect(browser.filledValuesOf(AGENT)).toContain(LOGIN.username)
    expect(browser.filledValuesOf(AGENT)).toContain(LOGIN.password)
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

// ---- P3 (fase 14 correzioni): origine del FRAME del campo, verificata prima
// della card e subito prima di OGNI browser_type; TOTP prima di qualunque
// scrittura ----

describe('P3: l\'origine del campo si verifica nel probe (frame), prima della card e prima di ogni scrittura', () => {
  /** Il probe del finto, con origine/top sovrascrivibili per numero di chiamata. */
  const probeWithOverrides = (overrides: Array<{ origin?: string; top?: boolean }>) => {
    let n = 0
    return async (ref: string) => {
      const probe = await browser.probeFieldType(AGENT, ref)
      const o = overrides[Math.min(n, overrides.length - 1)]
      n++
      if (!probe.ok) return probe
      return { ok: true as const, info: { ...probe.info, ...(o?.origin !== undefined ? { origin: o.origin } : {}), ...(o?.top !== undefined ? { top: o.top } : {}) } }
    }
  }
  /** typeInto che conta le chiamate (per dire "zero browser_type"). */
  const countingTypeInto = () => {
    const calls: Array<{ ref: string; value: string }> = []
    return {
      calls,
      typeInto: async (ref: string, value: string) => {
        calls.push({ ref, value })
        return { ok: true as const }
      }
    }
  }

  it('cambio di origine fra la card e il fill → la pagina è cambiata, NESSUN browser_type', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const t = countingTypeInto()
    // i primi due probe (prima della card: e2 ed e3) sono a posto; dal terzo
    // (il ri-controllo prima di OGNI browser_type) l'origine è un'altra
    const r = await runFillCredential(
      { id: LOGIN.id, username_ref: 'e2', password_ref: 'e3' },
      depsOf({ decision: 'allow-turn', asked: 0 }, { probe: probeWithOverrides([{}, {}, { origin: 'https://evil.example.test' }]), typeInto: t.typeInto })
    )
    expect(t.calls).toHaveLength(0) // NESSUN browser_type
    expect(r.output).toContain('the page changed during the approval')
    expect(r.output).toContain('login not filled')
  })

  it('cambio di origine DOPO il primo campo → ci si ferma: compilato solo in parte', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const t = countingTypeInto()
    // e2 pre-card ok, e3 pre-card ok, ri-controllo e2 ok (username scritto),
    // ri-controllo e3: origine cambiata → STOP, la password non si scrive
    const r = await runFillCredential(
      { id: LOGIN.id, username_ref: 'e2', password_ref: 'e3' },
      depsOf({ decision: 'allow-turn', asked: 0 }, { probe: probeWithOverrides([{}, {}, {}, { origin: 'https://evil.example.test' }]), typeInto: t.typeInto })
    )
    expect(t.calls).toHaveLength(1) // solo lo username
    expect(r.output).toContain('the page changed during the approval')
    expect(r.output).toContain('only partially filled: username')
    expect(t.calls[0]!.value).toBe(LOGIN.username)
  })

  it('campo in un iframe con ref SENZA prefisso f → rifiutato da top:false (origine del frame)', async () => {
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/embedded' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const t = countingTypeInto()
    const r = await runFillCredential(
      { id: LOGIN.id, username_ref: 'e2' }, // e2 non ha prefisso: NESSUN segnale dal nome del ref — il rifiuto arriva SOLO dal probe
      depsOf(approvals, { typeInto: t.typeInto })
    )
    expect(approvals.asked).toBe(0) // rifiutato PRIMA della card
    expect(r.denied).toBe(true)
    expect(r.output).toContain('iframe')
    expect(t.calls).toHaveLength(0)
  })

  it('Q2: lo STESSO ref f<n>e<n> col probe top:false → rifiutato dal frame, ZERO browser_type', async () => {
    // il prefisso f non basta né blocca: il campo è dell'iframe lo decide il
    // PROBE (top) — qui lo stesso ref f1e2 del test Q2 del flusso, ma col
    // probe che dice top:false → rifiutato prima della card, niente scritture
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const approvals = { decision: 'allow-turn' as const, asked: 0 }
    const t = countingTypeInto()
    const probeTopFalse = async (ref: string) => {
      const probe = await browser.probeFieldType(AGENT, ref)
      return probe.ok ? { ok: true as const, info: { ...probe.info, top: false } } : probe
    }
    const r = await runFillCredential(
      { id: LOGIN.id, username_ref: 'f1e2' },
      depsOf(approvals, { probe: probeTopFalse, typeInto: t.typeInto })
    )
    expect(approvals.asked).toBe(0) // rifiutato PRIMA della card
    expect(r.denied).toBe(true)
    expect(r.output).toContain('iframe')
    expect(t.calls).toHaveLength(0) // NESSUN browser_type
  })

  it('totp_ref SENZA segreto nel login → errore PRIMA di scrivere qualunque campo (zero browser_type)', async () => {
    const noTotp = await vault.saveLogin({ label: 'Senza TOTP', origins: ['https://app.example.test'], username: 'utente2', password: 'pw2-finta' })
    await browser.callBrowserTool(AGENT, 'browser_open', { url: 'https://app.example.test/login' })
    const t = countingTypeInto()
    const r = await runFillCredential(
      { id: noTotp, username_ref: 'e2', password_ref: 'e3', totp_ref: 'e4' },
      depsOf({ decision: 'allow-turn', asked: 0 }, { typeInto: t.typeInto })
    )
    expect(r.output).toContain('TOTP')
    expect(t.calls).toHaveLength(0) // né utente né password: niente è stato scritto
    expect(r.filled).toBeUndefined()
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

// ---- P4 (fase 14 correzioni): il segreto TOTP si VALIDA al salvataggio ----

describe('P4: parseTotpSecret — base32 o URI otpauth, verificati PRIMA di cifrare', () => {
  it('base32 con spazi e minuscole → ok e NORMALIZZATO (maiuscole, senza spazi né padding)', () => {
    const r = cred.parseTotpSecret(' gezd gnbv gy3t qojq gezd gnbv gy3t qojq ')
    expect(r).toEqual({ ok: true, secret: TOTP_SECRET })
    // e il codice che ne esce è lo STESSO del segreto già normalizzato
    if (r.ok) expect(cred.totpCode(r.secret, 1_700_000_000_000)).toBe(cred.totpCode(TOTP_SECRET, 1_700_000_000_000))
  })

  it('URI otpauth://totp con secret → ok (il segreto si estrae e si normalizza)', async () => {
    const r = cred.parseTotpSecret('otpauth://totp/Portale:utente?secret=gezd%20gnbvgy3tqojqgezDGNBVGY3TQOJQ&issuer=Portale')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.secret).toBe(TOTP_SECRET)
    // via saveLogin: l'URI è ciò che i siti mostrano sotto il QR
    const id = await vault.saveLogin({ label: 'Da URI', origins: ['https://uri.example.test'], username: 'u', password: 'p', totp: `otpauth://totp/X?secret=${TOTP_SECRET}` })
    const l = await vault.getLoginForFill(id)
    expect(l.totp).toBe(TOTP_SECRET)
  })

  it('URI con digits=8 (o algorithm/period diversi) → errore chiaro "non supportato", MAI un codice sbagliato in silenzio', () => {
    for (const uri of [
      `otpauth://totp/X?secret=${TOTP_SECRET}&digits=8`,
      `otpauth://totp/X?secret=${TOTP_SECRET}&algorithm=SHA256`,
      `otpauth://totp/X?secret=${TOTP_SECRET}&period=60`,
      'otpauth://hotp/X?secret=ABC&counter=1'
    ]) {
      const r = cred.parseTotpSecret(uri)
      expect(r.ok, uri).toBe(false)
      if (!r.ok) expect(r.error).toContain('non supportat')
    }
  })

  it('stringa non base32 → rifiutata da saveLogin, e l\'errore NON contiene il valore', async () => {
    const notBase32 = 'questo-non-e-base32-!!!'
    const r = cred.parseTotpSecret(notBase32)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain(notBase32)
    await expect(vault.saveLogin({ label: 'Male', origins: ['https://male.example.test'], username: 'u', password: 'p', totp: notBase32 }))
      .rejects.toThrow(/base32/)
    // niente URI senza secret
    await expect(vault.saveLogin({ label: 'Male2', origins: ['https://male.example.test'], username: 'u', password: 'p', totp: 'otpauth://totp/X?issuer=Y' }))
      .rejects.toThrow(/secret/)
  })
})
