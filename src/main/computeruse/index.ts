// Computer use — mirror di CUGrokBotService (helper Swift dell'originale):
// screenshot (vision) + azioni input via AppleScript System Events.
// Permessi macOS richiesti: Screen Recording (screencapture) e Accessibility (eventi sintetici).
//
// Fase 2: il process è il daemon, non Electron — il scale factor dello schermo
// arriva da un provider iniettato (l'app passa electron.screen, il daemon un
// valore cache ottenuto via RPC verso la UI; default 2 = retina, coerente con
// lo screenshot "risoluzione nativa retina" di screencapture).
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let scaleFactorProvider: () => number = () => 2

/** Registra come ottenere il scale factor dello schermo primario. */
export function setScaleFactorProvider(fn: () => number): void {
  scaleFactorProvider = fn
}

export interface UseAppInput {
  action: string
  x?: number
  y?: number
  text?: string
  key?: string        // combo tipo "cmd+c", "Return", "ctrl+shift+t"
  app?: string        // per open_app
  windowId?: number   // futuro: cattura finestra specifica
}

function sh(script: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? ''), code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0 })
    })
  })
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
  await new Promise<void>((resolve) => {
    execFile('screencapture', ['-x', '-m', file], { timeout: 15_000 }, () => resolve())
  })
  try {
    const buf = await readFile(file)
    if (buf.length < 2000) {
      return { output: 'Screenshot empty or blocked: this app is probably missing the Screen Recording permission (System Settings → Privacy → Screen Recording).', images: [] }
    }
    // ridimensiona se enorme (>2.5MB) per non esplodere il contesto
    let b64 = buf.toString('base64')
    if (buf.length > 2_500_000) {
      await unlink(file).catch(() => undefined)
      return { output: `Screenshot taken (${Math.round(buf.length / 1024)}KB) but too large for the model: use a smaller window or a model with a larger vision context.`, images: [] }
    }
    void b64
    return { output: `Screenshot taken (${Math.round(buf.length / 1024)}KB, native retina resolution — the coordinates you give are converted to screen points automatically).`, images: [b64] }
  } finally {
    await unlink(file).catch(() => undefined)
  }
}

export interface ComputerUseResult {
  output: string
  images: string[]
  error?: boolean
}

export async function executeUseApp(input: UseAppInput): Promise<ComputerUseResult> {
  switch (input.action) {
    case 'screenshot':
      return screenshot()
    case 'click':
    case 'double_click':
    case 'right_click': {
      const p = toScreenPoints(input.x, input.y)
      if (!p) return { output: 'x and y are required (image pixel coordinates)', images: [], error: true }
      const btn = input.action === 'right_click' ? 'right click' : input.action === 'double_click' ? 'double click' : 'click'
      const r = await sh(`tell application "System Events" to ${btn} at {${p.x}, ${p.y}}`)
      if (r.code !== 0) {
        return { output: `Action failed (${r.stderr.trim().split('\n').pop()}). If the permission is missing: System Settings → Privacy → Accessibility → add this app.`, images: [], error: true }
      }
      return { output: `${input.action} at (${p.x}, ${p.y}) screen points executed`, images: [] }
    }
    case 'type': {
      if (!input.text) return { output: 'Missing text', images: [], error: true }
      const escaped = input.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const r = await sh(`tell application "System Events" to keystroke "${escaped}"`)
      if (r.code !== 0) return { output: `Type failed: ${r.stderr.trim().split('\n').pop()}`, images: [], error: true }
      return { output: `Typed ${input.text.length} characters`, images: [] }
    }
    case 'key': {
      if (!input.key) return { output: 'Missing key', images: [], error: true }
      const { script, error } = keyCombo(input.key)
      if (error) return { output: error, images: [], error: true }
      const r = await sh(script)
      if (r.code !== 0) return { output: `Key failed: ${r.stderr.trim().split('\n').pop()}`, images: [], error: true }
      return { output: `Pressed ${input.key}`, images: [] }
    }
    case 'open_app': {
      if (!input.app) return { output: 'Missing app', images: [], error: true }
      const raw = input.app.replace(/"/g, '').trim()
      // nomi localizzati comuni → nome bundle (es. Calcolatrice → Calculator)
      const localized: Record<string, string> = {
        calcolatrice: 'Calculator', calculatrice: 'Calculator', rechner: 'Calculator',
        calendario: 'Calendar', note: 'Notes', anticipazioni: 'Preview', anteprima: 'Preview',
        impostazioni: 'System Settings', 'impostazioni di sistema': 'System Settings',
        'systemeinstellungen': 'System Settings', finder: 'Finder', terminale: 'Terminal',
        testo: 'TextEdit', promemoria: 'Reminders', memo: 'Stickies'
      }
      const candidates = [raw, localized[raw.toLowerCase()] ?? '']
        .filter(Boolean)
      const tryOpen = (name: string) =>
        new Promise<boolean>((resolve) => {
          execFile('open', ['-a', name], { timeout: 10_000 }, (err) => resolve(!err))
        })
      let opened = false
      for (const c of candidates) {
        opened = opened || (await tryOpen(c))
        if (opened) break
      }
      if (!opened) {
        // fallback Spotlight: cerca il bundle per nome visualizzato e apri per percorso
        const found = await new Promise<string>((resolve) => {
          execFile('mdfind', [`kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '*${raw}*'cd`], { timeout: 10_000 }, (err, stdout) => {
            const first = String(stdout ?? '').split('\n').find((l) => l.trim().endsWith('.app'))
            resolve(err || !first ? '' : first.trim())
          })
        })
        if (found) {
          opened = await new Promise<boolean>((resolve) => {
            execFile('open', [found], { timeout: 10_000 }, (err) => resolve(!err))
          })
        }
      }
      if (!opened) return { output: `App "${input.app}" not found (try the English name, e.g. Calculator, Notes)`, images: [], error: true }
      await new Promise((res) => setTimeout(res, 800))
      return { output: `App "${input.app}" activated`, images: [] }
    }
    default:
      return { output: `Unknown action: ${input.action} (usage: screenshot, click, double_click, right_click, type, key, open_app)`, images: [], error: true }
  }
}
