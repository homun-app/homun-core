// OB1 (fase onboarding-b): la preparazione del computer del bot — il
// riduttore PURO boxSetupNext (tutte le transizioni, la ripresa da ogni
// fase, l'annullamento), la partenza dallo stato del motore, la verifica
// (dimensione, sha256, pkgutil, spctl: UNO solo che fallisce → errore, file
// cancellato, NESSUN open), gli override di prova ignorati nell'app
// impacchettata e lo spazio insufficiente. L'esecutore gira con dipendenze
// INIETTABILI: nessuno spawn, nessuna rete (il fetch è finto).
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_TMP_BASE } from '../../test-tmp'
import type { AppleEngineState } from '../../main/sandbox/engine'
import type { SandbotEvent } from '../../shared/types'
import {
  boxSetupNext, boxSetupStartFrom, boxSetupResumeFrom, boxSetupNeededBytes,
  boxSetupRunConfig, createBoxSetup, parsePkgutilCheckSignature, INITIAL_BOX_SETUP,
  type BoxSetupState, type BoxSetupEvent, type BoxSetupDeps
} from '../box-setup'

const st = (patch: Partial<BoxSetupState>): BoxSetupState => ({ ...INITIAL_BOX_SETUP, ...patch })
const next = (state: BoxSetupState, event: BoxSetupEvent): BoxSetupState => boxSetupNext(state, event)
const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// ---- il riduttore (PURO) ----

describe('OB1 boxSetupNext: le transizioni della macchina a stati', () => {
  it('started: da idle alla fase decisa, con startedAt e campi puliti', () => {
    const s = next(INITIAL_BOX_SETUP, { type: 'started', phase: 'checking-space', at: 123 })
    expect(s.phase).toBe('checking-space')
    expect(s.startedAt).toBe(123)
    expect(s.error).toBeNull()
    expect(s.bytes).toBeNull()
  })

  it('il percorso intero: spazio → download → verifica → Installer → installato → servizio → kernel → immagine → ready', () => {
    let s = next(INITIAL_BOX_SETUP, { type: 'started', phase: 'checking-space', at: 1 })
    s = next(s, { type: 'space-ok' })
    expect(s.phase).toBe('downloading')
    s = next(s, { type: 'download-begin', total: 1000 })
    s = next(s, { type: 'download-progress', bytes: 500, total: 1000 })
    expect(s).toMatchObject({ phase: 'downloading', bytes: 500, total: 1000 })
    s = next(s, { type: 'download-done' })
    expect(s.phase).toBe('verifying')
    s = next(s, { type: 'installer-opened' })
    expect(s.phase).toBe('awaiting-installer')
    s = next(s, { type: 'installed' })
    expect(s.phase).toBe('starting-service')
    s = next(s, { type: 'service-ok' })
    expect(s.phase).toBe('installing-kernel')
    s = next(s, { type: 'kernel-ok' })
    expect(s.phase).toBe('building-image')
    s = next(s, { type: 'image-building', buildPhase: 'LOAD' })
    expect(s.buildPhase).toBe('LOAD')
    s = next(s, { type: 'image-ok' })
    expect(s.phase).toBe('ready')
    expect(s.error).toBeNull()
  })

  it('ogni fallimento → error con la fase di colpa e il codice', () => {
    const started = st({ phase: 'checking-space' })
    expect(next(started, { type: 'space-no', message: 'x' })).toMatchObject({ phase: 'error', error: { phase: 'checking-space', code: 'no-space' } })
    expect(next(st({ phase: 'downloading' }), { type: 'download-fail', message: 'x' })).toMatchObject({ phase: 'error', error: { code: 'download' } })
    for (const [ev, code] of [
      [{ type: 'verify-fail', code: 'size', message: 'x' }, 'size'],
      [{ type: 'verify-fail', code: 'sha256', message: 'x' }, 'sha256'],
      [{ type: 'verify-fail', code: 'signature', message: 'x' }, 'signature'],
      [{ type: 'verify-fail', code: 'gatekeeper', message: 'x' }, 'gatekeeper']
    ] as Array<[BoxSetupEvent, string]>) {
      expect(next(st({ phase: 'verifying' }), ev)).toMatchObject({ phase: 'error', error: { phase: 'verifying', code } })
    }
    expect(next(st({ phase: 'starting-service' }), { type: 'service-fail', message: 'x' })).toMatchObject({ error: { code: 'service' } })
    expect(next(st({ phase: 'installing-kernel' }), { type: 'kernel-fail', message: 'x' })).toMatchObject({ error: { code: 'kernel' } })
    expect(next(st({ phase: 'building-image' }), { type: 'image-fail', message: 'x' })).toMatchObject({ error: { code: 'image' } })
  })

  it('annullamento: dalle fasi che corrono sì, da awaiting-installer/ready/idle no', () => {
    for (const phase of ['checking-space', 'downloading', 'verifying', 'starting-service', 'installing-kernel', 'building-image'] as const) {
      expect(next(st({ phase }), { type: 'cancel' }).phase).toBe('cancelled')
    }
    for (const phase of ['idle', 'awaiting-installer', 'ready', 'cancelled'] as const) {
      expect(next(st({ phase }), { type: 'cancel' }).phase).toBe(phase)
    }
  })

  it('retry: da error (e da cancelled) si torna a idle', () => {
    expect(next(st({ phase: 'error', error: { phase: 'verifying', code: 'sha256', message: 'x' } }), { type: 'retry' }).phase).toBe('idle')
    expect(next(st({ phase: 'cancelled' }), { type: 'retry' }).phase).toBe('idle')
  })

  it('un evento fuori dalla sua fase non cambia nulla', () => {
    const s = st({ phase: 'verifying' })
    expect(next(s, { type: 'download-progress', bytes: 1, total: 2 })).toBe(s)
    expect(next(s, { type: 'service-ok' })).toBe(s)
    expect(next(s, { type: 'space-ok' })).toBe(s)
    const d = st({ phase: 'downloading' })
    expect(next(d, { type: 'installed' })).toBe(d)
  })
})

// ---- la partenza dallo stato del motore (PURa) ----

describe('OB1 boxSetupStartFrom: da dove si comincia', () => {
  it('not-installed → spazio e download; stopped → servizio; kernel-missing → kernel', () => {
    expect(boxSetupStartFrom('not-installed', false)).toBe('checking-space')
    expect(boxSetupStartFrom('stopped', false)).toBe('starting-service')
    expect(boxSetupStartFrom('kernel-missing', false)).toBe('installing-kernel')
  })

  it('ready senza immagine → immagine; ready con immagine → ready subito; unsupported → niente', () => {
    expect(boxSetupStartFrom('ready', false)).toBe('building-image')
    expect(boxSetupStartFrom('ready', true)).toBe('ready')
    expect(boxSetupStartFrom('unsupported', false)).toBeNull()
  })
})

// ---- la ripresa dopo un riavvio (PURa) ----

describe('OB1 boxSetupResumeFrom: il riavvio non rifà una fase già fatta', () => {
  const f: AppleEngineState = 'not-installed'
  it('idle/ready/error/cancelled → niente da riprendere', () => {
    expect(boxSetupResumeFrom(st({ phase: 'idle' }), f, false)).toBeNull()
    expect(boxSetupResumeFrom(st({ phase: 'ready' }), f, false)).toBeNull()
    expect(boxSetupResumeFrom(st({ phase: 'error' }), f, false)).toBeNull()
    expect(boxSetupResumeFrom(st({ phase: 'cancelled' }), f, false)).toBeNull()
  })

  it('le fasi in corso si riprendono: il download riparte dallo stato del motore, le altre da sé', () => {
    expect(boxSetupResumeFrom(st({ phase: 'checking-space' }), 'not-installed', false)).toBe('checking-space')
    expect(boxSetupResumeFrom(st({ phase: 'downloading' }), 'not-installed', false)).toBe('checking-space')
    expect(boxSetupResumeFrom(st({ phase: 'verifying' }), 'not-installed', false)).toBe('checking-space')
    expect(boxSetupResumeFrom(st({ phase: 'awaiting-installer' }), 'not-installed', false)).toBe('awaiting-installer')
    expect(boxSetupResumeFrom(st({ phase: 'starting-service' }), 'stopped', false)).toBe('starting-service')
    expect(boxSetupResumeFrom(st({ phase: 'installing-kernel' }), 'kernel-missing', false)).toBe('installing-kernel')
    expect(boxSetupResumeFrom(st({ phase: 'building-image' }), 'ready', false)).toBe('building-image')
  })

  it('la ripresa decide COL MOTORE di adesso: installato mentre scaricava → servizio', () => {
    expect(boxSetupResumeFrom(st({ phase: 'downloading' }), 'stopped', false)).toBe('starting-service')
  })
})

// ---- la stima dello spazio (PURa, numeri calcolati) ----

describe('OB1 boxSetupNeededBytes: la stima in byte', () => {
  it('pacchetto + installazione + kernel + immagine: nessun numero inventato', () => {
    const n = boxSetupNeededBytes()
    // pacchetto scaricato E installato (circa la stessa dimensione),
    // kernel ~1 GB (il consenso di BX4 lo dice), immagine+cache 1,5 GB
    // (BOX_BUILD_ESTIMATED_BYTES, dal REPORT di box-container)
    expect(n).toBe(169_630_704 * 2 + 1_000_000_000 + 1_500_000_000)
    expect(n).toBeGreaterThan(2_500_000_000)
    expect(n).toBeLessThan(3_500_000_000)
  })
})

// ---- gli override di prova ----

describe('OB1 boxSetupRunConfig: gli override SANDBOT_TEST_* e l\'app impacchettata', () => {
  const env = {
    SANDBOT_TEST_PKG_URL: 'http://127.0.0.1:9/finto.pkg',
    SANDBOT_TEST_PKG_SHA256: 'f'.repeat(64),
    SANDBOT_TEST_PKG_SIZE: '42',
    SANDBOT_TEST_OPEN: '/bin/finto-open',
    SANDBOT_TEST_PKGUTIL: '/bin/finto-pkgutil',
    SANDBOT_TEST_SPCTL: '/bin/finto-spctl'
  }

  it('senza env: le costanti vere e i comandi di sistema (OBR1: percorsi ASSOLUTI)', () => {
    const c = boxSetupRunConfig({}, false)
    expect(c.url).toBe('https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg')
    expect(c.sizeBytes).toBe(169_630_704)
    expect(c.sha256).toBe('b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97')
    expect(c.openCmd).toBe('/usr/bin/open')
    expect(c.pkgutilPath).toBe('/usr/sbin/pkgutil')
    expect(c.spctlPath).toBe('/usr/sbin/spctl')
  })

  it('con env (non impacchettata): gli override vincono', () => {
    const c = boxSetupRunConfig(env, false)
    expect(c.url).toBe('http://127.0.0.1:9/finto.pkg')
    expect(c.sha256).toBe('f'.repeat(64))
    expect(c.sizeBytes).toBe(42)
    expect(c.openCmd).toBe('/bin/finto-open')
    expect(c.pkgutilPath).toBe('/bin/finto-pkgutil')
    expect(c.spctlPath).toBe('/bin/finto-spctl')
  })

  it('IMPACCHETTATA: le variabili SANDBOT_TEST_* sono IGNORATE — le costanti non si toccano', () => {
    const c = boxSetupRunConfig(env, true)
    expect(c.url).toBe('https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg')
    expect(c.sha256).toBe('b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97')
    expect(c.sizeBytes).toBe(169_630_704)
    expect(c.openCmd).toBe('/usr/bin/open')
    expect(c.pkgutilPath).toBe('/usr/sbin/pkgutil')
    expect(c.spctlPath).toBe('/usr/sbin/spctl')
  })

  it('una dimensione d\'env assurda si ignora (mai una costante rotta)', () => {
    expect(boxSetupRunConfig({ SANDBOT_TEST_PKG_SIZE: 'non-un-numero' }, false).sizeBytes).toBe(169_630_704)
    expect(boxSetupRunConfig({ SANDBOT_TEST_PKG_SIZE: '-4' }, false).sizeBytes).toBe(169_630_704)
  })
})

// ---- l'esecutore, con dipendenze finte ----

/** Un body finto di fetch: i byte in uno stream web, come un server vero. */
const fakeFetch = (bytes: Uint8Array, opts: { status?: number; length?: number } = {}) =>
  async (): Promise<Response> => {
    const status = opts.status ?? 200
    const body = new ReadableStream({
      start(c) { c.enqueue(bytes); c.close() }
    })
    return new Response(body, { status, headers: { 'content-length': String(opts.length ?? bytes.length) } })
  }

/** L'output OK di pkgutil --check-signature (firmato, catena fidata, foglia). */
const PKGUTIL_OK = [
  'Package "container-1.7.1-installer-signed.pkg":',
  '   Status: signed by a developer certificate issued by Apple for distribution',
  '   Notarization: trusted by the Apple notary service',
  '   Certificate Chain:',
  '    1. Developer ID Installer: Apple Inc. (TEAMIDFAKE)',
  '       SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '    2. Developer ID Certification Authority',
  '    3. Apple Root CA'
].join('\n')

// ---- OBR3: le uscite di pkgutil, scritte a mano sul formato vero ----

/** i pacchetti firmati da Apple STESSA: «signed Apple Software», foglia «Software Signing» */
const PKGUTIL_APPLE = [
  'Package "container-1.7.1-installer-signed.pkg":',
  '   Status: signed Apple Software',
  '   Certificate Chain:',
  '    1. Software Signing',
  '       Expires: 2030-06-01 00:00:00 +0000',
  '       SHA256 fingerprint: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  '    2. Apple Code Signing Certification Authority',
  '       Expires: 2036-06-01 00:00:00 +0000',
  '    3. Apple Root CA',
  '       Expires: 2040-06-01 00:00:00 +0000'
].join('\n')

/** Developer ID SENZA la riga della notarizzazione */
const PKGUTIL_DEVID_NO_NOTARY = PKGUTIL_OK.replace('   Notarization: trusted by the Apple notary service\n', '')

/** la riga inventata di una volta NON è la notarizzazione di pkgutil */
const PKGUTIL_OLD_TRUSTED = PKGUTIL_OK.replace('   Notarization: trusted by the Apple notary service', '   Status: Trusted by the Apple notary service')

interface Harness {
  deps: BoxSetupDeps
  dir: string
  settings: Map<string, unknown>
  events: SandbotEvent[]
  opened: string[]
  cliCalls: string[][]
  /** le righe del log del daemon (OBR3: qui finisce la foglia del certificato) */
  logs: string[]
  containerAppears: () => void
}

/** L'arnese di prova: dipendenze fintissime, nessuno spawn, nessuna rete. */
const harness = (over: {
  bytes?: Uint8Array
  sha256?: string
  sizeBytes?: number
  pkgutilOut?: string
  pkgutilExit?: number
  spctlExit?: number
  freeBytes?: number | null
  fetch?: typeof fetch
  engineState?: AppleEngineState
  hasImage?: boolean
  buildOk?: boolean
} = {}): Harness => {
  const dir = mkdtempSync(join(TEST_TMP_BASE, 'sandbot-box-setup-test-'))
  const settings = new Map<string, unknown>()
  const events: SandbotEvent[] = []
  const opened: string[] = []
  const cliCalls: string[][] = []
  const logs: string[] = []
  let installed = false
  const bytes = over.bytes ?? new Uint8Array(8).fill(7)
  const pkgutilPath = '/bin/finto-pkgutil'
  const spctlPath = '/bin/finto-spctl'
  const h: Harness = {
    dir, settings, events, opened, cliCalls, logs,
    containerAppears: () => { installed = true },
    deps: {
      now: () => 1_000,
      getSetting: <T,>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
      setSetting: (key: string, value: unknown) => { settings.set(key, value) },
      emit: (e: SandbotEvent) => { events.push(e) },
      downloadsDir: () => dir,
      freeBytes: () => over.freeBytes ?? 500_000_000_000,
      fetch: over.fetch ?? fakeFetch(bytes),
      runCli: async (file, argv) => {
        cliCalls.push([file, ...argv])
        if (argv[0] === '--version') {
          return installed ? { stdout: 'container 1.7.1', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'not found', exitCode: 127 }
        }
        if (file === pkgutilPath) {
          return { stdout: over.pkgutilOut ?? PKGUTIL_OK, stderr: '', exitCode: over.pkgutilExit ?? 0 }
        }
        if (file === spctlPath) {
          return { stdout: '', stderr: over.spctlExit === 0 ? '' : 'rejected', exitCode: over.spctlExit ?? 0 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      containerCli: () => '/bin/finto-container',
      engineState: async () => over.engineState ?? 'not-installed',
      hasBoxImage: async () => over.hasImage ?? false,
      buildBoxImage: async () => over.buildOk ?? true,
      openInstaller: async (pkgPath: string) => { opened.push(pkgPath); return { ok: true } },
      log: (line: string) => { logs.push(line) },
      timings: { pollInstallerMs: 5, downloadTimeoutMs: 60_000, networkRetryDelayMs: 5 },
      runConfig: () => ({
        url: 'http://127.0.0.1:9/finto.pkg',
        sha256: over.sha256 ?? shaOf(bytes),
        sizeBytes: over.sizeBytes ?? bytes.length,
        openCmd: 'open',
        pkgutilPath,
        spctlPath
      })
    }
  }
  return h
}

/** attende che lo stato del controller soddisfi la condizione (o scade). */
const waitForState = async (ctl: { state(): BoxSetupState }, ok: (s: BoxSetupState) => boolean, ms = 5_000): Promise<BoxSetupState> => {
  const deadline = Date.now() + ms
  for (;;) {
    const s = ctl.state()
    if (ok(s)) return s
    if (Date.now() > deadline) throw new Error(`stato non raggiunto: ${s.phase}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('OB1 createBoxSetup: l\'esecutore, dal download al ready', () => {
  it('il percorso intero: download → verifica → Installer aperto UNA volta → installato → servizio → kernel → immagine → ready', async () => {
    const h = harness()
    const ctl = createBoxSetup(h.deps)
    // la CLI compare DOPO l'open (come l'Installer finto che installa)
    void ctl.start().then(() => undefined)
    const fin = await waitForState(ctl, (s) => s.phase === 'awaiting-installer')
    expect(fin.phase).toBe('awaiting-installer')
    h.containerAppears()
    const ready = await waitForState(ctl, (s) => s.phase === 'ready' || s.phase === 'error')
    expect(ready.phase).toBe('ready')
    // l'Installer è stato aperto col pacchetto VERIFICATO, UNA volta sola
    expect(h.opened).toHaveLength(1)
    // il servizio e il kernel: gli argv di oggi, SULLA CLI di Apple
    const flat = h.cliCalls.map((c) => c.join(' '))
    expect(flat.some((c) => c === '/bin/finto-container system start --disable-kernel-install')).toBe(true)
    expect(flat.some((c) => c === '/bin/finto-container system kernel set --recommended')).toBe(true)
    // pkgutil e spctl coi percorsi overrideati, SUL pacchetto scaricato
    expect(flat.some((c) => c.startsWith('/bin/finto-pkgutil --check-signature'))).toBe(true)
    expect(flat.some((c) => c.startsWith('/bin/finto-spctl --assess --type install'))).toBe(true)
    // dopo l'installazione il pacchetto si CANCELLA
    expect(existsSync(join(h.dir, 'finto.pkg'))).toBe(false)
    // lo stato è persistito e l'evento è partito
    expect((h.settings.get('box.setup') as BoxSetupState).phase).toBe('ready')
    expect(h.events.some((e) => e.type === 'box-setup' && e.setup.phase === 'ready')).toBe(true)
    expect(h.events.some((e) => e.type === 'box-setup' && e.setup.phase === 'downloading' && e.setup.bytes === 8)).toBe(true)
  })

  it('dimensione sbagliata → errore in parole, file cancellato, NESSUN open', async () => {
    const h = harness({ sizeBytes: 999_999 })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.phase).toBe('error')
    expect(fin.error?.code).toBe('size')
    expect(fin.error?.message).toMatch(/dimensione|size/i)
    expect(h.opened).toHaveLength(0)
    expect(existsSync(join(h.dir, 'finto.pkg'))).toBe(false)
    expect(existsSync(join(h.dir, 'finto.pkg.part'))).toBe(false)
  })

  it('sha256 sbagliato → errore, file cancellato, NESSUN open', async () => {
    const h = harness({ sha256: '0'.repeat(64) })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.phase).toBe('error')
    expect(fin.error?.code).toBe('sha256')
    expect(h.opened).toHaveLength(0)
  })

  it('pkgutil KO → errore di firma, NESSUN open', async () => {
    const h = harness({ pkgutilOut: '   Status: no signature', pkgutilExit: 1 })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.error?.code).toBe('signature')
    expect(h.opened).toHaveLength(0)
  })

  it('spctl KO → errore di Gatekeeper, NESSUN open', async () => {
    const h = harness({ spctlExit: 3 })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.error?.code).toBe('gatekeeper')
    expect(h.opened).toHaveLength(0)
  })

  it('spazio insufficiente → errore coi GB calcolati, NESSUN download', async () => {
    const h = harness({ freeBytes: 2_000_000_000 })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.phase).toBe('error')
    expect(fin.error?.code).toBe('no-space')
    expect(fin.error?.message).toMatch(/GB/)
    expect(h.cliCalls.length).toBe(0)
    expect(h.opened).toHaveLength(0)
  })

  it('annullare durante il download: .part conservato, stato cancelled', async () => {
    // un fetch che continua a mandare byte senza finire mai: si ferma SOLO
    // con l'annullamento (il controllo dell'abort è tra un pezzo e l'altro)
    let iv: ReturnType<typeof setInterval> | null = null
    const slow: typeof fetch = async () => new Response(
      new ReadableStream({
        start(c) {
          iv = setInterval(() => { try { c.enqueue(new Uint8Array(64)) } catch { if (iv) clearInterval(iv) } }, 15)
        },
        cancel() { if (iv) clearInterval(iv) }
      }),
      { status: 200, headers: { 'content-length': '4096' } }
    )
    const h = harness({ fetch: slow })
    const ctl = createBoxSetup(h.deps)
    const p = ctl.start()
    await waitForState(ctl, (s) => s.phase === 'downloading' && (s.bytes ?? 0) > 0)
    const fin = await ctl.cancel()
    expect(fin.phase).toBe('cancelled')
    await p
    expect(existsSync(join(h.dir, 'finto.pkg.part'))).toBe(true)
  })

  it('retry: dall\'errore si riparte e si arriva all\'attesa dell\'Installer', async () => {
    const h = harness({ spctlExit: 3 })
    const ctl = createBoxSetup(h.deps)
    expect((await ctl.start()).phase).toBe('error')
    // la prova dopo: spctl ora risponde OK (la condizione era passeggera)
    const orig = h.deps.runCli
    h.deps.runCli = async (file, argv, timeoutMs) => {
      if (file === '/bin/finto-spctl') return { stdout: '', stderr: '', exitCode: 0 }
      return orig(file, argv, timeoutMs)
    }
    void ctl.retry().then(() => undefined)
    const fin = await waitForState(ctl, (s) => s.phase === 'awaiting-installer')
    expect(fin.phase).toBe('awaiting-installer')
    h.containerAppears()
    await waitForState(ctl, (s) => s.phase === 'ready')
  })

  it('la ripresa del riavvio su awaiting-installer: stesso punto, NESSUN open automatico', async () => {
    const h = harness()
    const ctl = createBoxSetup(h.deps)
    void ctl.start().then(() => undefined)
    await waitForState(ctl, (s) => s.phase === 'awaiting-installer')
    expect(h.opened).toHaveLength(1)
    // «riavvio»: un controller NUOVO sugli stessi setting persistiti — la
    // CLI ora c'è (l'utente ha installato mentre l'app era chiusa)
    const ctl2 = createBoxSetup({ ...h.deps, runCli: async (file, argv) => {
      h.cliCalls.push([file, ...argv])
      if (argv[0] === '--version') return { stdout: 'container 1.7.1', stderr: '', exitCode: 0 }
      if (file === '/bin/finto-pkgutil') return { stdout: PKGUTIL_OK, stderr: '', exitCode: 0 }
      return { stdout: '', stderr: '', exitCode: 0 }
    } })
    await ctl2.resumeAtBoot()
    expect(ctl2.state().phase).toBe('ready')
    // il secondo controller NON ha riaperto l'Installer da solo: 1 open in tutto
    expect(h.opened).toHaveLength(1)
    h.containerAppears()
    await Promise.resolve(ctl.start()).catch(() => undefined)
  })
})

// ---- OBR3: la firma — «signed Apple Software» non deve bloccare ----

describe('OBR3 parsePkgutilCheckSignature: i due stati di Apple e la notarizzazione (puro)', () => {
  it('«signed Apple Software» → firmato E fidato (basta lo stato), foglia «Software Signing»', () => {
    expect(parsePkgutilCheckSignature(PKGUTIL_APPLE)).toEqual({ signed: true, trusted: true, leaf: 'Software Signing' })
  })

  it('Developer ID CON «Notarization: trusted by the Apple notary service» → firmato e fidato, foglia col Team ID', () => {
    expect(parsePkgutilCheckSignature(PKGUTIL_OK)).toEqual({
      signed: true, trusted: true, leaf: 'Developer ID Installer: Apple Inc. (TEAMIDFAKE)'
    })
  })

  it('Developer ID SENZA notarizzazione → firmato ma NON fidato', () => {
    const p = parsePkgutilCheckSignature(PKGUTIL_DEVID_NO_NOTARY)
    expect(p.signed).toBe(true)
    expect(p.trusted).toBe(false)
    expect(p.leaf).toBe('Developer ID Installer: Apple Inc. (TEAMIDFAKE)')
  })

  it('«no signature» → né firmato né fidato (nemmeno con una riga di notarizzazione accanto)', () => {
    expect(parsePkgutilCheckSignature('Package "x.pkg":\n   Status: no signature')).toMatchObject({ signed: false, trusted: false })
    expect(parsePkgutilCheckSignature('Package "x.pkg":\n   Status: no signature\n   Notarization: trusted by the Apple notary service'))
      .toMatchObject({ signed: false, trusted: false })
  })

  it('qualunque altro stato (non fidato, scaduto, revocato) → né firmato né fidato', () => {
    for (const status of [
      'signed by untrusted certificate',
      'signed by a certificate that has since expired',
      'signed by a certificate that has since been revoked',
      'signed by a certificate trusted by macOS'
    ]) {
      const p = parsePkgutilCheckSignature(`Package "x.pkg":\n   Status: ${status}\n   Notarization: trusted by the Apple notary service`)
      expect(p.signed, status).toBe(false)
      expect(p.trusted, status).toBe(false)
    }
  })

  it('la riga inventata «Status: Trusted by the Apple notary service» NON vale: serve la riga Notarization', () => {
    const p = parsePkgutilCheckSignature(PKGUTIL_OLD_TRUSTED)
    expect(p.signed).toBe(true)
    expect(p.trusted).toBe(false)
  })

  it('lo stato si legge SOLO sulla riga «Status:»: un nome di pacchetto con quelle parole non firma nulla', () => {
    const p = parsePkgutilCheckSignature('Package "Status: signed Apple Software.pkg":\n   Status: no signature')
    expect(p).toMatchObject({ signed: false, trusted: false })
  })

  it('uscita vuota → niente', () => {
    expect(parsePkgutilCheckSignature('')).toEqual({ signed: false, trusted: false, leaf: null })
  })
})

describe('OBR3 createBoxSetup: la verifica coi due stati, spctl sempre obbligatorio, la foglia nel log', () => {
  it('«signed Apple Software»: la verifica PASSA, l\'Installer si apre e la foglia va nel log', async () => {
    const h = harness({ pkgutilOut: PKGUTIL_APPLE })
    const ctl = createBoxSetup(h.deps)
    void ctl.start().then(() => undefined)
    const fin = await waitForState(ctl, (s) => s.phase === 'awaiting-installer' || s.phase === 'error')
    expect(fin.phase).toBe('awaiting-installer')
    expect(h.opened).toHaveLength(1)
    expect(h.logs).toContain('[box-setup] pacchetto firmato da: Software Signing')
    // spctl è stato chiamato comunque: resta obbligatorio
    expect(h.cliCalls.some((c) => c[0] === '/bin/finto-spctl' && c.slice(1, 4).join(' ') === '--assess --type install')).toBe(true)
    h.containerAppears()
    await waitForState(ctl, (s) => s.phase === 'ready')
  })

  it('Developer ID notarizzato: la foglia (nome e Team ID) va nel log', async () => {
    const h = harness()
    const ctl = createBoxSetup(h.deps)
    void ctl.start().then(() => undefined)
    await waitForState(ctl, (s) => s.phase === 'awaiting-installer')
    expect(h.logs).toContain('[box-setup] pacchetto firmato da: Developer ID Installer: Apple Inc. (TEAMIDFAKE)')
    h.containerAppears()
    await waitForState(ctl, (s) => s.phase === 'ready')
  })

  it('«signed Apple Software» ma spctl KO → errore di Gatekeeper, NESSUN open', async () => {
    const h = harness({ pkgutilOut: PKGUTIL_APPLE, spctlExit: 3 })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.phase).toBe('error')
    expect(fin.error?.code).toBe('gatekeeper')
    expect(h.opened).toHaveLength(0)
  })

  it('Developer ID SENZA notarizzazione → errore di firma, file cancellato, NESSUN open', async () => {
    const h = harness({ pkgutilOut: PKGUTIL_DEVID_NO_NOTARY })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.phase).toBe('error')
    expect(fin.error?.code).toBe('signature')
    expect(h.opened).toHaveLength(0)
    expect(existsSync(join(h.dir, 'finto.pkg.part'))).toBe(false)
  })

  it('uno stato diverso (certificato non fidato) → errore di firma anche se pkgutil esce 0', async () => {
    const h = harness({ pkgutilOut: 'Package "finto.pkg":\n   Status: signed by untrusted certificate\n   Certificate Chain:\n    1. Qualcuno' })
    const ctl = createBoxSetup(h.deps)
    const fin = await ctl.start()
    expect(fin.error?.code).toBe('signature')
    expect(h.opened).toHaveLength(0)
  })
})

describe('OB1 createBoxSetup: il download riprende dal .part', () => {
  it('un .part già sul disco si allunga col Range, non si ricomincia', async () => {
    const bytes = new Uint8Array(200).fill(9)
    const h = harness({ bytes })
    writeFileSync(join(h.dir, 'finto.pkg.part'), Buffer.alloc(50, 9))
    const ranges: string[] = []
    ;(h.deps as { fetch?: typeof fetch }).fetch = (async (url: unknown, init?: RequestInit) => {
      ranges.push(String((init?.headers as Record<string, string>)?.range ?? ''))
      return new Response(
        new ReadableStream({ start(c) { c.enqueue(new Uint8Array(150).fill(9)); c.close() } }),
        { status: 206, headers: { 'content-length': '150' } }
      )
    }) as typeof fetch
    const ctl = createBoxSetup(h.deps)
    void ctl.start().then(() => undefined)
    await waitForState(ctl, (s) => s.phase === 'awaiting-installer')
    expect(ranges[0]).toBe('bytes=50-')
    // verificato: il .part è diventato il pacchetto, con TUTTI i byte
    expect(statSync(join(h.dir, 'finto.pkg')).size).toBe(200)
    h.containerAppears()
    await waitForState(ctl, (s) => s.phase === 'ready')
  })
})
