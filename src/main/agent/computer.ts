// Il COMPUTER USE NEL BOX (fase 19a, V6): computer_observe e computer_act sul
// desktop del bot (il display Xvfb del browser principale, con Chromium
// headful). Le azioni diventano argv di xdotool passati a `docker exec -u
// 1001` con DISPLAY/XAUTHORITY del desktop — senza shell; il testo di `type`
// viaggia come argomento dopo `--`. La cattura è `import -window root` di
// ImageMagick su un file nella cartella di 1001, letto in base64 e cancellato
// (come copyBrowserScreenshot: il PNG binario nel canale stdout di una stringa
// JS si corromperebbe).
//
// Il CONFINE (decisione 3) sta nel loop, che per OGNI azione chiama
// computerActRisk (browser-guard, pura) col contesto raccolto qui dai probe
// INTERNI browser_evaluate (mai esposti al modello). Questo modulo è il
// braccio: prepara (validazione + geometria), sonda e esegue.
import { randomUUID } from 'node:crypto'
import {
  browserStateDir, dockerScreenCaptureArgv, dockerScreenGeometryArgv, dockerScreenDisplayReadArgv,
  dockerBrowserReadB64Argv, dockerBrowserRmFileArgv, dockerXdotoolArgv, BOX_CONTAINER
} from '../sandbox/docker-argv'
import { runDockerArgv } from '../sandbox'
import { boxOwnerOf } from '../sandbox'
import {
  parseComputerActions, computerActionXdotoolArgs, type ComputerAction, type ComputerActContext,
  type FieldProbeInfo
} from './browser-guard'
import { evaluateInPage, elementAtPointFn, ACTIVE_FIELD_FN, probeViewportOffset } from './browser'

/** Il desktop del bot: display + Xauthority del proprietario (null = nessuno schermo). */
export interface DesktopInfo {
  owner: string
  display: string
  xauthority: string
}

/**
 * Il display del bot (V6): il numero scelto da -displayfd sta nel file display
 * della cartella del proprietario (lo scrive il wrapper del desktop); la
 lettura gira COME 1001. In modalità test (MCP finto) non c'è desktop.
 */
export async function desktopInfoOf(agentId: string): Promise<DesktopInfo | null> {
  const owner = boxOwnerOf(agentId)
  const r = await runDockerArgv(dockerScreenDisplayReadArgv(BOX_CONTAINER, owner), { timeoutMs: 10_000 })
  const n = r.exitCode === 0 ? r.stdout.trim() : ''
  if (!/^\d+$/.test(n)) return null
  return { owner, display: `:${n}`, xauthority: `${browserStateDir(owner)}/Xauthority` }
}

/** La geometria dello schermo del bot ("1280 960" da xdotool getdisplaygeometry). */
export async function screenGeometry(info: DesktopInfo): Promise<{ width: number; height: number } | null> {
  const r = await runDockerArgv(dockerScreenGeometryArgv(info.display, info.xauthority), { timeoutMs: 10_000 })
  const m = /^(\d+)\s+(\d+)$/.exec(r.exitCode === 0 ? r.stdout.trim() : '')
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/** La cattura dello schermo in base64 (PNG): file di 1001 → base64 → cancellazione. */
export async function captureScreen(info: DesktopInfo): Promise<string | null> {
  const name = `screen-${randomUUID().slice(0, 8)}.png`
  const shot = await runDockerArgv(dockerScreenCaptureArgv(info.display, info.xauthority, info.owner, name), { timeoutMs: 30_000 })
  if (shot.exitCode !== 0) return null
  const src = `${browserStateDir(info.owner)}/${name}`
  const read = await runDockerArgv(dockerBrowserReadB64Argv(BOX_CONTAINER, src), { timeoutMs: 30_000 })
  if (read.exitCode !== 0 || !read.stdout.trim()) return null
  await runDockerArgv(dockerBrowserRmFileArgv(BOX_CONTAINER, src), { timeoutMs: 15_000 }).catch(() => undefined)
  return read.stdout.trim()
}

/** computer_observe (V6): dimensioni dello schermo più l'immagine. */
export async function computerObserve(agentId: string): Promise<
  { ok: true; width: number; height: number; image: string } | { ok: false; error: string }
> {
  const info = await desktopInfoOf(agentId)
  if (!info) return { ok: false, error: 'The bot has no screen open: it starts when you open a page in your browser.' }
  const geometry = await screenGeometry(info)
  const image = await captureScreen(info)
  if (!geometry || !image) {
    return { ok: false, error: 'The screen of the bot could not be captured (is the desktop running?).' }
  }
  return { ok: true, width: geometry.width, height: geometry.height, image }
}

/**
 * La preparazione di computer_act (V6): validazione PURA delle azioni (forma,
 * coordinate DENTRO lo schermo vero, tasto, testo, numero) e geometria. Il
 * contesto di ogni azione (probe) si raccoglie a parte, un'azione per volta.
 */
export async function computerPrepareAct(
  agentId: string,
  input: Record<string, unknown>
): Promise<
  | { ok: true; actions: ComputerAction[]; screenSize: { width: number; height: number } | null }
  | { ok: false; error: string }
> {
  const info = await desktopInfoOf(agentId)
  if (!info) return { ok: false, error: 'The bot has no screen open: it starts when you open a page in your browser.' }
  const geometry = await screenGeometry(info)
  const parsed = parseComputerActions(input.actions, geometry)
  if (!parsed.ok) return parsed
  return { ok: true, actions: parsed.actions, screenSize: geometry }
}

/**
 * Il contesto di UNA azione per computerActRisk (V6): offset del viewport
 * (calcolato UNA volta per chiamata dal loop), l'elemento sotto il punto per i
 * click, il campo attivo per type e key, la sfida nell'ultimo snapshot noto e
 * il controllo dell'utente in corso.
 */
export async function computerActContextOf(
  agentId: string,
  action: ComputerAction,
  view: Awaited<ReturnType<typeof probeViewportOffset>>,
  opts: { challenge: boolean; userControl: boolean }
): Promise<ComputerActContext> {
  let click: ComputerActContext['click'] = null
  if (action.kind === 'click' && view) {
    const px = action.x - view.offX
    const py = action.y - view.offY
    const raw = await evaluateInPage(agentId, elementAtPointFn(px, py))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>
      click = {
        role: String(o.role ?? 'generic'),
        name: String(o.name ?? ''),
        text: String(o.text ?? ''),
        field: normaliseField(o.field)
      }
    }
  }
  let activeField: FieldProbeInfo | null = null
  if (action.kind === 'type' || action.kind === 'key') {
    activeField = normaliseField(await evaluateInPage(agentId, ACTIVE_FIELD_FN))
  }
  return { view, click, activeField, challenge: opts.challenge, userControl: opts.userControl }
}

/** Il campo grezzo del probe → FieldProbeInfo (null se non è un campo leggibile). */
function normaliseField(raw: unknown): FieldProbeInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  return {
    type: String(o.type ?? ''), autocomplete: String(o.autocomplete ?? ''),
    name: String(o.name ?? ''), id: String(o.id ?? ''),
    placeholder: String(o.placeholder ?? ''), label: String(o.label ?? ''),
    aria: String(o.aria ?? ''), title: String(o.title ?? ''),
    origin: String(o.origin ?? ''), top: o.top === true
  }
}

/**
 * L'ESECUZIONE di un'azione (V6): argv di xdotool via docker exec come 1001
 * con DISPLAY/XAUTHORITY (nessuna shell); `wait` è l'attesa del daemon. Il
 * confine (computerActRisk) sta a monte, nel loop: qui si esegue e basta.
 */
export async function computerExecAction(agentId: string, info: DesktopInfo, action: ComputerAction): Promise<string | null> {
  if (action.kind === 'wait') {
    await new Promise((r) => setTimeout(r, Math.min(action.ms, 5000)))
    return null
  }
  const args = computerActionXdotoolArgs(action)
  if (!args.length) return null
  const r = await runDockerArgv(dockerXdotoolArgv(info.display, info.xauthority, args), { timeoutMs: 15_000 })
  if (r.exitCode !== 0) return `xdotool failed: ${r.stderr || `exit ${r.exitCode}`}`
  return null
}
