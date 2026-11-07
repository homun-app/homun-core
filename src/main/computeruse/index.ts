// Computer use — mirror di CUGrokBotService (helper Swift dell'originale):
// screenshot (vision) + azioni input via AppleScript System Events.
// Permessi macOS richiesti: Screen Recording (screencapture) e Accessibility (eventi sintetici).
//
// Fase 2: il process è il daemon, non Electron — il scale factor dello schermo
// arriva da un provider iniettato (l'app passa electron.screen, il daemon un
// valore cache ottenuto via RPC verso la UI; default 2 = retina, coerente con
// lo screenshot "risoluzione nativa retina" di screencapture).
//
// Fase use-app (U1/U2/U4/U5): MAI più tasti alla finestra sbagliata.
// - type/key/click/double_click/right_click richiedono `app`: prima di eseguire
//   Homun ATTIVA quell'app e verifica che sia davvero in primo piano con
//   lsappinfo (che non richiede Accessibilità). Se davanti c'è Homun stesso
//   (per nome o per PID del processo) l'azione è rifiutata.
// - open_url apre un indirizzo http/https col comando `open` (array di
//   argomenti, mai shell) in un colpo solo.
// - gli errori di Accessibilità diventano UN risultato chiaro che dice al
//   modello di fermarsi e chiedere il permesso all'utente.
// - ogni risultato dice in quale app è finita l'azione.
// Tutto l'I/O passa da ComputerUseIO, iniettabile: i test e la sonda usano il
// desktop finto (fake.ts) e non toccano mai il Mac dove girano.
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeComputerUseIO } from './fake'

// ---- l'I/O di computer use, iniettabile (fase use-app) ----

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
}

export interface ComputerUseIO {
  /** esegue uno script AppleScript (osascript -e) */
  osascript(script: string, timeoutMs: number): Promise<ExecResult>
  /** esegue un binario con ARRAY di argomenti (open, lsappinfo, screencapture…) */
  execFile(file: string, args: string[], timeoutMs: number): Promise<ExecResult>
  readFileBytes(path: string): Promise<Buffer>
  removeFile(path: string): Promise<void>
}

const realIO: ComputerUseIO = {
  osascript: (script, timeoutMs) =>
    new Promise((resolve) => {
      execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? ''), code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0 })
      })
    }),
  execFile: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? ''), code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0 })
      })
    }),
  readFileBytes: (p) => readFile(p),
  removeFile: (p) => unlink(p).catch(() => undefined)
}

let injectedIO: ComputerUseIO | null = null
let autoIO: ComputerUseIO | null = null

/** Registra l'I/O da usare (i test iniettano il desktop finto); null torna a quello vero. */
export function setComputerUseIO(io: ComputerUseIO | null): void {
  injectedIO = io
}

/** L'I/O attivo: quello iniettato, altrimenti quello vero (o il finto della sonda). */
function io(): ComputerUseIO {
  if (injectedIO) return injectedIO
  if (!autoIO) {
    // SANDBOT_TEST_FAKE_COMPUTERUSE vale SOLO insieme a SANDBOT_TEST_USER_DATA:
    // il desktop finto della sonda, che registra le azioni al posto dello schermo
    autoIO = process.env.SANDBOT_TEST_FAKE_COMPUTERUSE === '1' && process.env.SANDBOT_TEST_USER_DATA
      ? createFakeComputerUseIO({ dir: process.env.SANDBOT_TEST_USER_DATA }).io
      : realIO
  }
  return autoIO
}

// ---- i due provider iniettati dal daemon (host-bridge) ----

let scaleFactorProvider: () => number = () => 2

/** Registra come ottenere il scale factor dello schermo primario. */
export function setScaleFactorProvider(fn: () => number): void {
  scaleFactorProvider = fn
}

let homunPidProvider: () => number | null = () => null

/**
 * Fase use-app (U1): il pid del processo di Homun (l'app Electron), per
 * riconoscere Homun in primo piano ANCHE quando si chiama "Electron" (build di
 * sviluppo). Il daemon lo inietta via RPC verso la UI.
 */
export function setHomunPidProvider(fn: () => number | null): void {
  homunPidProvider = fn
}

export interface UseAppInput {
  action: string
  x?: number
  y?: number
  text?: string
  key?: string        // combo tipo "cmd+c", "Return", "ctrl+shift+t"
  app?: string        // app di destinazione (obbligatoria per tastiera e mouse; browser per open_url)
  url?: string        // per open_url (solo http/https)
  windowId?: number   // futuro: cattura finestra specifica
}

/** Le azioni di tastiera e mouse: richiedono `app` e la verifica del primo piano. */
export const KEYBOARD_MOUSE_ACTIONS = ['type', 'key', 'click', 'double_click', 'right_click'] as const

function sh(script: string, timeoutMs = 10_000): Promise<ExecResult> {
  return io().osascript(script, timeoutMs)
}

/** Converte coordinate immagine (pixel, retina 2x) in punti schermo. */
function toScreenPoints(x?: number, y?: number): { x: number; y: number } | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null
  const scale = scaleFactorProvider() || 1
  return { x: Math.round(x / scale), y: Math.round(y / scale) }
}

/** Combo tasti → keystroke AppleScript. es. "cmd+c" → key "c" using command down */
function keyCombo(key: string): { script: string; error?: string } {
  const parts = key.split('+').map((p) => p.trim().toLowerCase())
  const main = parts.pop() as string
  const mods = parts
  const nameMap: Record<string, string> = {
    return: 'return', enter: 'return', esc: 'escape', escape: 'escape',
    tab: 'tab', space: 'space', delete: 'delete', backspace: 'delete',
    up: 'code 126', down: 'code 125', left: 'code 123', right: 'code 124',
    home: 'code 115', end: 'code 119', pageup: 'code 116', pagedown: 'code 117',
    f1: 'code 122', f2: 'code 120', f3: 'code 99', f4: 'code 118'
  }
  const mapped = nameMap[main]
  const isCode = Boolean(mapped?.startsWith('code'))
  const keyExpr = mapped ? (isCode ? mapped : `"${mapped}"`) : `"${main}"`
  const modList = mods
    .map((m) => ({ cmd: 'command down', command: 'command down', meta: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' })[m])
    .filter(Boolean)
  if (mods.some((m) => !({ cmd: 1, command: 1, meta: 1, ctrl: 1, control: 1, alt: 1, option: 1, shift: 1 })[m])) {
    return { script: '', error: `invalid modifier in "${key}" (use cmd/ctrl/alt/shift)` }
  }
  const using = modList.length ? ` using {${modList.join(', ')}}` : ''
  return { script: `tell application "System Events" to ${isCode ? `key ${keyExpr}` : `keystroke ${keyExpr}`}${using}` }
}

async function screenshot(): Promise<{ output: string; images: string[] }> {
  const file = join(tmpdir(), `sandbot-shot-${Date.now()}.png`)
  await io().execFile('screencapture', ['-x', '-m', file], 15_000)
  try {
    const buf = await io().readFileBytes(file)
    if (buf.length < 2000) {
      return { output: 'Screenshot empty or blocked: this app is probably missing the Screen Recording permission (System Settings → Privacy → Screen Recording).', images: [] }
    }
    // ridimensiona se enorme (>2.5MB) per non esplodere il contesto
    const b64 = buf.toString('base64')
    if (buf.length > 2_500_000) {
      return { output: `Screenshot taken (${Math.round(buf.length / 1024)}KB) but too large for the model: use a smaller window or a model with a larger vision context.`, images: [] }
    }
    return { output: `Screenshot taken (${Math.round(buf.length / 1024)}KB, native retina resolution — the coordinates you give are converted to screen points automatically).`, images: [b64] }
  } finally {
    await io().removeFile(file)
  }
}

export interface ComputerUseResult {
  output: string
  images: string[]
  error?: boolean
  /** U4: l'errore è la mancanza del permesso di Accessibilità (per il tetto del loop) */
  accessibilityError?: boolean
}

// ---- U4: un unico verdetto per l'Accessibilità mancante ----

/** I testi/codici con cui macOS dice che manca l'Accessibilità (anche in italiano). */
export function isAccessibilityError(stderr: string): boolean {
  const s = stderr.toLowerCase()
  if (s.includes('-25211') || s.includes('-1719')) return true
  return s.includes('not allowed assistive access') || s.includes('non ammette l’accesso di assistenza') || s.includes("non ammette l'accesso di assistenza")
}

export const ACCESSIBILITY_RESULT =
  'Homun needs the macOS Accessibility permission for clicks and typing. Tell the user to enable Homun in System Settings → Privacy & Security → Accessibility, then try again. Do not retry before the user confirms.'
export const HOMUN_SELF_RESULT = 'Homun never types or clicks into its own window.'
export const APP_REQUIRED_RESULT = '`app` is required: name the app that must receive this action (e.g. Safari).'

/** L'esito di errore di un'azione di tastiera/mouse quando manca l'Accessibilità. */
function accessibilityFailure(): ComputerUseResult {
  return { output: ACCESSIBILITY_RESULT, images: [], error: true, accessibilityError: true }
}

// ---- il nome dell'app: normalizzazione e riconoscimento di Homun ----

/** I nomi con cui il processo di Homun può presentarsi (l'app di sviluppo è "Electron"). */
const HOMUN_NAMES = new Set(['homun', 'homun.app', 'electron'])

function normalizedName(name: string): string {
  return name.trim().replace(/\.app$/i, '')
}

/** true se il nome è quello di Homun stesso (anche "Electron", l'app di sviluppo). */
export function isHomunAppName(name: string): boolean {
  return HOMUN_NAMES.has(normalizedAppNameKey(name))
}

function isHomunName(name: string): boolean {
  return isHomunAppName(name)
}

function normalizedAppNameKey(name: string): string {
  return normalizedName(name).toLowerCase()
}

/**
 * U1: l'app in primo piano, da lsappinfo (NON richiede Accessibilità).
 * `lsappinfo front` dà l'ASN; `lsappinfo info -only name -only pid <asn>` dà
 * nome e pid. null se il sistema non risponde.
 */
async function frontmostApp(): Promise<{ name: string; pid: number | null } | null> {
  const front = await io().execFile('lsappinfo', ['front'], 5_000)
  if (front.code !== 0) return null
  const asn = front.stdout.trim().split('\n')[0]?.trim().replace(/:+$/, '')
  if (!asn) return null
  const info = await io().execFile('lsappinfo', ['info', '-only', 'name', '-only', 'pid', asn], 5_000)
  if (info.code !== 0) return null
  const name = /^"([^"]*)"/m.exec(info.stdout)?.[1] ?? ''
  const pidRaw = Number(/pid\s*=\s*(\d+)/.exec(info.stdout)?.[1] ?? NaN)
  return { name, pid: Number.isFinite(pidRaw) ? pidRaw : null }
}

/** true se l'app davanti è Homun stesso: per nome, o per pid del processo. */
function isHomunFront(f: { name: string; pid: number | null }): boolean {
  if (f.name && isHomunName(f.name)) return true
  const pid = homunPidProvider()
  return pid !== null && f.pid !== null && f.pid === pid
}

/**
 * U1 (punto 1): attiva l'app come `open_app` (nome inglese, nomi localizzati
 * comuni, fallback Spotlight). Ritorna false se non è stata trovata.
 */
async function activateApp(input: string): Promise<boolean> {
  const raw = input.replace(/"/g, '').trim()
  const localized: Record<string, string> = {
    calcolatrice: 'Calculator', calculatrice: 'Calculator', rechner: 'Calculator',
    calendario: 'Calendar', note: 'Notes', anticipazioni: 'Preview', anteprima: 'Preview',
    impostazioni: 'System Settings', 'impostazioni di sistema': 'System Settings',
    'systemeinstellungen': 'System Settings', finder: 'Finder', terminale: 'Terminal',
    testo: 'TextEdit', promemoria: 'Reminders', memo: 'Stickies'
  }
  const candidates = [raw, localized[raw.toLowerCase()] ?? ''].filter(Boolean)
  for (const c of candidates) {
    const r = await io().execFile('open', ['-a', c], 10_000)
    if (r.code === 0) return true
  }
  // fallback Spotlight: cerca il bundle per nome visualizzato e apri per percorso
  const found = await io().execFile('mdfind', [`kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '*${raw}*'cd`], 10_000)
  const first = found.code === 0 ? found.stdout.split('\n').find((l) => l.trim().endsWith('.app')) : undefined
  if (first) {
    const r = await io().execFile('open', [first.trim()], 10_000)
    if (r.code === 0) return true
  }
  return false
}

/**
 * U1: attiva l'app e aspetta (max 2 s) che sia DAVVERO in primo piano.
 * La verifica è DOPO l'approvazione: è il momento in cui Homun torna davanti
 * perché l'utente ha cliccato la card. Rifiuta se davanti c'è Homun.
 */
async function ensureAppInFront(appName: string): Promise<{ ok: true; name: string } | { ok: false; result: ComputerUseResult }> {
  if (isHomunName(appName)) return { ok: false, result: { output: HOMUN_SELF_RESULT, images: [], error: true } }
  if (!(await activateApp(appName))) {
    return { ok: false, result: { output: `App "${appName}" not found (try the English name, e.g. Calculator, Notes). Nothing was executed.`, images: [], error: true } }
  }
  const deadline = Date.now() + 2_000
  let front: { name: string; pid: number | null } | null = null
  for (;;) {
    front = await frontmostApp()
    if (front) {
      if (isHomunFront(front)) return { ok: false, result: { output: HOMUN_SELF_RESULT, images: [], error: true } }
      if (front.name && sameApp(front.name, appName)) return { ok: true, name: front.name }
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 200))
  }
  const inFront = front?.name || 'unknown'
  return {
    ok: false,
    result: { output: `Not executed: the app in front is ${inFront}, not ${normalizedName(appName)}. Nothing was typed.`, images: [], error: true }
  }
}

/** Confronto di nomi app senza maiuscole e senza .app (Safari ≡ safari.app). */
function sameApp(a: string, b: string): boolean {
  return normalizedAppNameKey(a) === normalizedAppNameKey(b)
}

/** L'errore di osascript, ripulito: l'ultima riga dello stderr. */
function errTail(r: ExecResult): string {
  return r.stderr.trim().split('\n').pop() ?? ''
}

export async function executeUseApp(input: UseAppInput): Promise<ComputerUseResult> {
  switch (input.action) {
    case 'screenshot':
      return screenshot()
    case 'open_url': {
      const raw = String(input.url ?? '')
      let u: URL
      try {
        u = new URL(raw)
      } catch {
        return { output: `Invalid url "${raw.slice(0, 80)}": open_url accepts only http: and https: addresses.`, images: [], error: true }
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { output: `Scheme "${u.protocol}" is not allowed: open_url accepts only http: and https: addresses.`, images: [], error: true }
      }
      // l'URL passa COME È: execFile usa un array di argomenti, nessuna shell
      const args = input.app ? ['-a', input.app.replace(/"/g, '').trim(), raw] : [raw]
      const r = await io().execFile('open', args, 10_000)
      if (r.code !== 0) {
        return { output: `open_url failed: ${errTail(r)}`, images: [], error: true }
      }
      return { output: `Opened ${raw} in ${input.app ? normalizedName(input.app) : 'the default browser'}`, images: [] }
    }
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'type':
    case 'key': {
      // U1: l'app di destinazione è obbligatoria — i tasti NON vanno a chi
      // capita in primo piano (il difetto del turno Sora del 6/11)
      const appName = input.app !== undefined ? String(input.app) : ''
      if (!appName.trim()) return { output: APP_REQUIRED_RESULT, images: [], error: true }
      const front = await ensureAppInFront(normalizedName(appName))
      if (!front.ok) return front.result
      // U5: l'app che riceve l'azione, col nome vero restituito da lsappinfo
      const target = front.name
      if (input.action === 'type' || input.action === 'key') {
        if (input.action === 'type' && !input.text) return { output: 'Missing text', images: [], error: true }
        if (input.action === 'key' && !input.key) return { output: 'Missing key', images: [], error: true }
        let script: string
        if (input.action === 'type') {
          script = `tell application "System Events" to keystroke "${input.text!.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        } else {
          const combo = keyCombo(input.key!)
          if (combo.error) return { output: combo.error, images: [], error: true }
          script = combo.script
        }
        const r = await sh(script)
        if (r.code !== 0) {
          if (isAccessibilityError(r.stderr)) return accessibilityFailure()
          return { output: `${input.action === 'type' ? 'Type' : 'Key'} failed: ${errTail(r)}`, images: [], error: true }
        }
        return input.action === 'type'
          ? { output: `Typed ${input.text!.length} characters into ${target}`, images: [] }
          : { output: `Pressed ${input.key} in ${target}`, images: [] }
      }
      // click
      const p = toScreenPoints(input.x, input.y)
      if (!p) return { output: 'x and y are required (image pixel coordinates)', images: [], error: true }
      const btn = input.action === 'right_click' ? 'right click' : input.action === 'double_click' ? 'double click' : 'click'
      const r = await sh(`tell application "System Events" to ${btn} at {${p.x}, ${p.y}}`)
      if (r.code !== 0) {
        if (isAccessibilityError(r.stderr)) return accessibilityFailure()
        return { output: `Action failed (${errTail(r)}). If the permission is missing: System Settings → Privacy → Accessibility → add this app.`, images: [], error: true }
      }
      return { output: `${input.action} at (${p.x}, ${p.y}) in ${target}`, images: [] }
    }
    case 'open_app': {
      const raw = String(input.app ?? '')
      if (!raw.trim()) return { output: 'Missing app', images: [], error: true }
      // U1: mai attivare Homun stesso (la card dell'analisi è finita proprio lì)
      if (isHomunName(raw)) return { output: HOMUN_SELF_RESULT, images: [], error: true }
      if (!(await activateApp(raw))) {
        return { output: `App "${input.app}" not found (try the English name, e.g. Calculator, Notes)`, images: [], error: true }
      }
      await new Promise((res) => setTimeout(res, 800))
      // U5: chi c'è DAVVERO in primo piano dopo l'apertura
      const front = await frontmostApp()
      const inFront = front?.name && !isHomunFront(front) ? front.name : 'unknown'
      return { output: `App "${input.app}" activated; the app in front is now ${inFront}`, images: [] }
    }
    default:
      return { output: `Unknown action: ${input.action} (usage: screenshot, click, double_click, right_click, type, key, open_app, open_url)`, images: [], error: true }
  }
}
