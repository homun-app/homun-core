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
// Fase 19a correzioni (L3): la sonda del punto per click/down/up chiede AL
// BROWSER dove sta il puntatore (cattura one-shot del mousemove + doppio
// mousemove di xdotool + lettura): il punto controllato e il punto colpito
// coincidono; la formula dell'offset resta solo come ripiego.
import { randomUUID } from 'node:crypto'
import {
  browserStateDir, dockerScreenCaptureArgv, dockerScreenGeometryArgv, dockerScreenDisplayReadArgv,
  dockerBrowserReadB64Argv, dockerBrowserRmFileArgv, dockerXdotoolArgv, BOX_CONTAINER
} from '../sandbox/docker-argv'
import { runDockerArgv, type ExecResult } from '../sandbox'
import { boxOwnerOf } from '../sandbox'
import {
  parseComputerActions, computerActionXdotoolArgs, type ComputerAction, type ComputerActContext,
  type ComputerClickProbe, type ActiveFocus, type FieldProbeInfo
} from './browser-guard'
import { evaluateInPage, elementAtPointFn, ACTIVE_FIELD_FN, probeViewportOffset, MOUSE_HIT_ARM_FN, MOUSE_HIT_READ_FN } from './browser'

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
 * Le dipendenze della sonda del punto (fase 19a correzioni, L3): iniettabili
 * per i test (docker e MCP FINTI), di default quelle vere del daemon —
 * evaluateInPage per la browser_evaluate interna, runDockerArgv per xdotool.
 */
export interface ComputerProbeDeps {
  evaluate?: (agentId: string, fn: string) => Promise<unknown>
  execArgv?: (argv: string[]) => Promise<ExecResult>
  sleep?: (ms: number) => Promise<void>
}

/** L'attesa tra il doppio mousemove e la lettura della sonda (L3: 150 ms). */
export const MOUSE_PROBE_WAIT_MS = 150

/**
 * Il contesto di UNA azione per computerActRisk (V6 + correzioni L3/L6):
 * offset del viewport (calcolato UNA volta per chiamata dal loop, resta solo
 * come RIPIEGO della formula), la sonda del PUNTO per click/down/up, il fuoco
 * attivo per type e key, la sfida nell'ultimo snapshot noto e il controllo
 * dell'utente in corso. `desktop` serve alla sonda per muovere il puntatore
 * con xdotool come 1001.
 */
export async function computerActContextOf(
  agentId: string,
  action: ComputerAction,
  view: Awaited<ReturnType<typeof probeViewportOffset>>,
  opts: { challenge: boolean; userControl: boolean; desktop: DesktopInfo; probe?: ComputerProbeDeps }
): Promise<ComputerActContext> {
  const evaluate = opts.probe?.evaluate ?? evaluateInPage
  let click: ComputerClickProbe | null = null
  if (action.kind === 'click' || action.kind === 'down' || action.kind === 'up') {
    click = await probeClickPoint(agentId, action.x, action.y, view, opts.desktop, opts.probe, evaluate)
  }
  let activeField: ActiveFocus | null = null
  if (action.kind === 'type' || action.kind === 'key') {
    activeField = normaliseFocus(await evaluate(agentId, ACTIVE_FIELD_FN))
  }
  return { view, click, activeField, challenge: opts.challenge, userControl: opts.userControl }
}

/**
 * La sonda del PUNTO (L3), per OGNI click, down e up: chiede AL BROWSER dove
 * sta il puntatore invece di fidarsi della formula dell'offset.
 * 1. browser_evaluate installa la cattura one-shot del mousemove;
 * 2. xdotool (come 1001, stesso argv della 19a) porta il puntatore sul punto
 *    con un DOPPIO mousemove — il primo a x−1 (o x+1 se x = 0) garantisce
 *    l'evento anche se il puntatore era già sul punto;
 * 3. attesa di 150 ms;
 * 4. la lettura di window.__sbHit decide:
 *    - C'È l'evento → le SUE coordinate (esatte) costruiscono l'elemento con
 *      la funzione di L4; se lì sotto c'è un frame → frame;
 *    - NON c'è → la formula di L2 col viewport: punto fuori → outside; punto
 *      dentro con un IFRAME/FRAME/EMBED/OBJECT sotto → frame; tutto il resto
 *      → unknown (il puntatore sta sopra qualcosa che non è la pagina: menu
 *      contestuale nativo, popup del browser).
 * Così la sonda sposta il puntatore DOVE poi cliccherà davvero: il click
 * successivo non ha distanza tra il punto controllato e il punto colpito.
 */
async function probeClickPoint(
  agentId: string,
  x: number,
  y: number,
  view: Awaited<ReturnType<typeof probeViewportOffset>>,
  desktop: DesktopInfo,
  probe: ComputerProbeDeps | undefined,
  evaluate: (agentId: string, fn: string) => Promise<unknown>
): Promise<ComputerClickProbe | null> {
  // 1. la cattura one-shot (un fallimento qui si comporta come nessun evento)
  await evaluate(agentId, MOUSE_HIT_ARM_FN)
  // 2. il doppio mousemove di xdotool,argv puri come 1001 (nessuna shell)
  const x1 = x === 0 ? x + 1 : x - 1
  const exec = probe?.execArgv ?? runDockerArgv
  await exec(dockerXdotoolArgv(desktop.display, desktop.xauthority, [
    'mousemove', '--', String(x1), String(y),
    'mousemove', '--', String(x), String(y)
  ]))
  // 3. l'attesa dell'evento
  await (probe?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(MOUSE_PROBE_WAIT_MS)
  // 4. la lettura: le coordinate dell'evento sono QUELLE della pagina
  const hit = await evaluate(agentId, MOUSE_HIT_READ_FN)
  const h = hit && typeof hit === 'object' && !Array.isArray(hit) ? hit as Record<string, unknown> : null
  if (h && Number.isFinite(Number(h.x)) && Number.isFinite(Number(h.y))) {
    return elementProbe(agentId, Number(h.x), Number(h.y), evaluate)
  }
  // nessun evento: il RIPIEGO della formula di L2 (offset del viewport)
  if (!view) return { kind: 'unknown' }
  const px = x - view.offX
  const py = y - view.offY
  if (px < 0 || py < 0 || px >= view.width || py >= view.height) return { kind: 'outside' }
  // punto dentro la pagina ma senza evento: un frame è un frame; qualunque
  // altra cosa è probe fallito (il puntatore NON era sulla pagina)
  const raw = await elementProbe(agentId, px, py, evaluate)
  return raw?.kind === 'frame' ? raw : { kind: 'unknown' }
}

/** Il probe dell'elemento in un punto (L4): frame, elemento col controllo vero, o null se fallito. */
async function elementProbe(
  agentId: string,
  px: number,
  py: number,
  evaluate: (agentId: string, fn: string) => Promise<unknown>
): Promise<ComputerClickProbe | null> {
  const raw = await evaluate(agentId, elementAtPointFn(Math.round(px), Math.round(py)))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'frame') return { kind: 'frame' }
  if (o.kind !== 'element') return null
  return {
    kind: 'element',
    role: String(o.role ?? 'generic'),
    name: String(o.name ?? ''),
    text: String(o.text ?? ''),
    field: normaliseField(o.field)
  }
}

/**
 * Il fuoco attivo grezzo del probe → ActiveFocus (L6): campo (input, textarea
 * o contenteditable), elemento non campo { element: { role, name, text } },
 * pagina ({ page: true } per body/html). null resta SOLO per il probe fallito.
 */
function normaliseFocus(raw: unknown): ActiveFocus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.page === true) return { kind: 'page' }
  if (o.element && typeof o.element === 'object' && !Array.isArray(o.element)) {
    const e = o.element as Record<string, unknown>
    return { kind: 'element', role: String(e.role ?? 'generic'), name: String(e.name ?? ''), text: String(e.text ?? '') }
  }
  const field = normaliseField(raw)
  return field ? { kind: 'field', field } : null
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
