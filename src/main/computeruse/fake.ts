// Fase use-app: il DESKTOP FINTO di computer use — l'I/O alternativo che i
// test e la sonda (SANDBOT_TEST_FAKE_COMPUTERUSE=1, letta SOLO insieme a
// SANDBOT_TEST_USER_DATA) usano al posto di osascript/open/lsappinfo. Così
// nessun test e nessuna sonda tocca lo schermo del Mac dove girano.
//
// Il desktop è un piccolo stato in memoria: chi è in primo piano, quale pid
// ha, se `open -a X` sposta davvero il primo piano, se l'Accessibilità è
// negata. Ogni azione viene REGISTRATA (records + file JSONL nella cartella
// dati di test): la sonda dimostra che l'URL è stato aperto e che il testo è
// andato a Safari leggendo il registro, non guardando lo schermo.
//
// Con `dir` (modo sonda) lo stato si legge a OGNI azione dal file di controllo
// <dir>/fake-computeruse.json e il registro si appende a
// <dir>/fake-computeruse-log.jsonl: la sonda guida il desktop finto scrivendo
// il file, senza canali verso il processo del daemon.
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerUseIO, ExecResult } from './index'

export interface FakeDesktopState {
  /** l'app in primo piano (nome mostrato da lsappinfo) */
  frontmost: string
  /**
   * (modo sonda) token dello scenario: quando CAMBIA il valore letto dal file
   * di controllo, `frontmost` si applica di nuovo. Senza token, frontmost si
   * riapplicherebbe a OGNI azione e l'attivazione (`open -a X`) non
   * vincerebbe mai — la sonda scrive il file una volta per scenario.
   */
  scenario?: number | string
  /** pid per nome (default: uno stabile per nome; Homun/Electron → homunPid) */
  pids?: Record<string, number>
  /** il pid con cui il processo Homun/Electron si riconosce (default 4242) */
  homunPid?: number
  /** false = `open -a X` non sposta il primo piano (riattivazione impossibile) */
  activates?: boolean
  /**
   * (R2, modo sonda/unit test) l'app davanti CAMBIA in quest'altra fra il
   * controllo di lsappinfo e lo script con la guardia: l'azione non viene
   * eseguita né registrata (l'utente ha cliccato un'altra finestra nel
   * momento fra i due comandi — la corsa che R2 deve rendere innocua)
   */
  frontChangesTo?: string
  /** true = ogni osascript di input torna l'errore di Accessibilità */
  denyAccessibility?: boolean
  /** se impostato, osascript torna quest'errore (codice 1) invece della lista */
  osascriptError?: string
  /** le app installate: `open -a` di un nome fuori lista fallisce */
  installedApps?: string[]
}

export interface FakeRecord {
  op: 'open' | 'open_url' | 'type' | 'key' | 'click' | 'lsappinfo' | 'osascript' | 'screencapture'
  args?: string[]
  url?: string
  text?: string
  key?: string
  at?: [number, number]
  into?: string
  app?: string
}

export interface FakeDesktop {
  io: ComputerUseIO
  state: FakeDesktopState
  records: FakeRecord[]
}

/** Le app presenti nel desktop finto (i nomi inglesi, come li usa `open -a`).
 *  R3: anche i browser ammessi da open_url, così il finto può aprirli. */
export const FAKE_DEFAULT_APPS = [
  'Finder', 'Safari', 'Mail', 'Notes', 'Calendar', 'Terminal', 'TextEdit',
  'Reminders', 'Preview', 'Calculator', 'System Settings', 'Homun', 'Electron',
  'Google Chrome', 'Firefox', 'Microsoft Edge', 'Messages', 'Telegram',
  'WhatsApp', 'Slack', 'Discord', 'Spark', 'Airmail', 'MailMate', 'Thunderbird', 'Outlook',
  'Safari Technology Preview', 'Chromium', 'Arc', 'Brave Browser', 'Opera', 'Vivaldi', 'Orion', 'Zen'
]

/** Il testo dell'errore di Accessibilità che il finto restituisce (quello vero del -25211, in italiano). */
const FAKE_ACCESSIBILITY_STDERR = 'osascript: non ammette l’accesso di assistenza. (-25211)'

/** pid stabile per nome (i nomi di Homun prendono homunPid). */
function pidOf(name: string, state: FakeDesktopState): number {
  if (state.pids && name in state.pids) return state.pids[name]!
  if (name === 'Homun' || name === 'Electron') return state.homunPid ?? 4242
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 100000
  return 1000 + h
}

/** Il decoder dello script AppleScript che index.ts costruisce: keystroke/key
 *  code/click. R2: gli script con la guardia sono blocchi `tell … end tell`
 *  multilinea — le espressioni si riconoscono ovunque nello script. */
function decodeAppleScript(script: string, frontmost: string): FakeRecord {
  const into = frontmost
  let m = /(click|double click|right click) at \{(-?\d+), (-?\d+)\}/.exec(script)
  if (m) return { op: 'click', key: m[1] === 'click' ? undefined : m[1]!.replace(' ', '_'), at: [Number(m[2]), Number(m[3])], into }
  m = /keystroke "((?:[^"\\]|\\.)*)"( using \{[^\n]*\})?/.exec(script)
  if (m) {
    const text = m[1]!.replace(/\\(.)/g, '$1')
    return m[2] ? { op: 'key', key: text, into } : { op: 'type', text, into }
  }
  m = /key code (\d+)( using \{[^\n]*\})?/.exec(script)
  if (m) return { op: 'key', key: `code ${m[1]}`, into }
  return { op: 'osascript', into }
}

/**
 * Costruisce il desktop finto. Senza `dir` tutto vive in memoria (test unit);
 * con `dir` (sonda) lo stato si rilegge a ogni azione da
 * <dir>/fake-computeruse.json e le azioni si appendono al registro JSONL.
 */
export function createFakeComputerUseIO(init: Partial<FakeDesktopState> & { dir?: string } = {}): FakeDesktop {
  const state: FakeDesktopState = {
    frontmost: init.frontmost ?? 'Finder',
    pids: init.pids,
    homunPid: init.homunPid,
    activates: init.activates ?? true,
    denyAccessibility: init.denyAccessibility ?? false,
    installedApps: init.installedApps ?? FAKE_DEFAULT_APPS
  }
  const dir = init.dir
  const controlFile = dir ? join(dir, 'fake-computeruse.json') : null
  const logFile = dir ? join(dir, 'fake-computeruse-log.jsonl') : null
  /** modo sonda: il file di controllo vince su tutto ciò che dice; ma
   *  `frontmost` si applica solo a SCENARIO NUOVO (vedi FakeDesktopState).
   *  Uno scenario NUOVO è un desktop NUOVO: si riparte dai valori di
   *  costruzione, così le chiavi che il nuovo scenario non ripete (per
   *  esempio frontChangesTo) tornano ai default. */
  let lastScenario: number | string | undefined
  const syncIn = (): void => {
    if (!controlFile || !existsSync(controlFile)) return
    try {
      const v = JSON.parse(readFileSync(controlFile, 'utf8')) as Partial<FakeDesktopState>
      const scenarioChanged = v.scenario !== undefined && v.scenario !== lastScenario
      lastScenario = v.scenario
      if (scenarioChanged) {
        state.frontmost = init.frontmost ?? 'Finder'
        state.pids = init.pids
        state.homunPid = init.homunPid
        state.activates = init.activates ?? true
        state.frontChangesTo = undefined
        state.denyAccessibility = init.denyAccessibility ?? false
        state.osascriptError = undefined
        state.installedApps = init.installedApps ?? FAKE_DEFAULT_APPS
      }
      for (const [k, val] of Object.entries(v)) {
        if (k === 'frontmost' && !scenarioChanged) continue
        ;(state as unknown as Record<string, unknown>)[k] = val
      }
    } catch { /* controllo illeggibile: si tiene lo stato attuale */ }
  }
  const records: FakeRecord[] = []
  const record = (r: FakeRecord): void => {
    records.push(r)
    if (records.length > 1000) records.shift()
    if (logFile) {
      try { appendFileSync(logFile, JSON.stringify(r) + '\n') } catch { /* il registro è best-effort */ }
    }
  }
  // ASN finto stabile per nome: info risale al nome dall'ASN
  const asnOfName = new Map<string, string>()
  const nameOfAsn = new Map<string, string>()
  const asnFor = (name: string): string => {
    let asn = asnOfName.get(name)
    if (!asn) {
      asn = `ASN:0x0-0x${(asnOfName.size + 1).toString(16)}`
      asnOfName.set(name, asn)
      nameOfAsn.set(asn, name)
    }
    return asn
  }
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 })
  const fail = (stderr: string): ExecResult => ({ stdout: '', stderr, code: 1 })

  const io: ComputerUseIO = {
    async execFile(file, args) {
      syncIn()
      if (file === 'lsappinfo') {
        if (args[0] === 'front') {
          record({ op: 'lsappinfo', args: ['front'] })
          return ok(asnFor(state.frontmost) + '\n')
        }
        if (args[0] === 'info') {
          record({ op: 'lsappinfo', args: ['info', ...args.slice(1)] })
          const name = nameOfAsn.get(args[args.length - 1] ?? '') ?? state.frontmost
          const wantName = args.includes('name')
          const wantPid = args.includes('pid')
          const out: string[] = []
          if (wantName) out.push(`"${name}" ${args[args.length - 1]}: (in front)`)
          if (wantPid) out.push(`pid = ${pidOf(name, state)}`)
          return ok(out.join('\n') + '\n')
        }
        return ok('')
      }
      if (file === 'open') {
        const app = args[0] === '-a' ? args[1] : undefined
        const url = args.find((x) => x.startsWith('http://') || x.startsWith('https://'))
        const norm = (n: string): string => n.trim().replace(/\.app$/i, '').toLowerCase()
        const canonical = app === undefined ? undefined : (state.installedApps ?? []).find((n) => norm(n) === norm(app))
        if (app !== undefined && canonical === undefined) return fail(`Unable to find application named '${app}'`)
        if (url) record({ op: 'open_url', url, app, args: [...args] })
        else record({ op: 'open', args: [...args] })
        // il primo piano diventa il nome canonico installato (Safari, non safari.app)
        if (canonical && state.activates !== false) state.frontmost = canonical
        return ok('')
      }
      if (file === 'screencapture') {
        record({ op: 'screencapture', args: [...args] })
        return ok('')
      }
      if (file === 'mdfind') return ok('')
      return ok('')
    },
    async osascript(script) {
      syncIn()
      if (state.denyAccessibility) {
        record({ op: 'osascript' })
        return fail(FAKE_ACCESSIBILITY_STDERR)
      }
      if (state.osascriptError) {
        record({ op: 'osascript' })
        return fail(state.osascriptError)
      }
      // R2: il finto interpreta la guardia del primo piano nello script — se
      // il pid davanti non è quello atteso risponde con l'errore e NON
      // registra l'azione (niente è stato digitato né cliccato)
      const guard = /if \(unix id of p\) is not (\d+) then error "HOMUN_FRONT_MISMATCH:"/.exec(script)
      if (guard) {
        const frontNow = state.frontChangesTo ?? state.frontmost
        if (Number(guard[1]) !== pidOf(frontNow, state)) {
          return fail(`HOMUN_FRONT_MISMATCH:${frontNow}`)
        }
      }
      record(decodeAppleScript(script, state.frontmost))
      return ok('')
    },
    async readFileBytes() {
      return Buffer.alloc(0)
    },
    async removeFile() {
      /* il finto non scrive file */
    }
  }
  return { io, state, records }
}
