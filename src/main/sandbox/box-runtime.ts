// CC2 (fase computer-card): lo STATO DEL BOX — il computer Linux dove
// girano i comandi, i file e il browser del bot — tenuto in memoria dal
// daemon e mostrato dalla card «Computer». Tre fatti distinti: QUESTO
// modulo tiene lo stato del BOX; `activity` dice cosa fa il bot adesso;
// `screen` se il browser è aperto. La card li mette insieme (CC3).
//
// Chi lo aggiorna:
// - ensureBoxContainer RIUSCITO → running (un fatto che già sappiamo,
//   nessuno spawn in più); se FALLISCE non si indovina: si LEGGE;
// - gli stop ESPLICITI (box:image-remove, box:box-files-remove, lo stop
//   del motore e la disinstallazione) → stopped o missing;
// - la LETTURA refreshBoxRuntime() con le reads del motore: Apple UN solo
//   `ls -a --format json` col parse puro (status.state della fixture vera);
//   Docker il ps di oggi più l'inspect -f {{.State.Running}}. Si esegue
//   all'avvio del daemon, alla RPC box:runtime e ogni 60 s SOLO mentre c'è
//   almeno un client UI connesso — MAI un polling a vuoto con l'app chiusa.
//
// L'evento `box` parte SOLO se lo stato cambia. La lettura caduta NON si
// indovina: stato unknown, alla prossima lettura si vede com'è davvero.
import { activeBoxEngine } from './engine'
import { BOX_CONTAINER, dockerContainerRunningArgv } from './docker-argv'
import type { BoxRuntime, SandbotEvent } from '../../shared/types'

/** La rilettura periodica dello stato (solo con la UI connessa). */
export const BOX_RUNTIME_REFRESH_MS = 60_000

/** Il risultato di un argv del motore (la forma del runner di index.ts). */
export interface BoxRuntimeRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface BoxRuntimeDeps {
  /** evento push alla UI (il broadcast del daemon). */
  emit: (e: SandbotEvent) => void
  /** il runner degli argv del motore (runDockerRaw nel daemon, finto nei test). */
  run: (argv: string[], opts?: { timeoutMs?: number }) => Promise<BoxRuntimeRunResult>
  /** la modalità sandbox è 'box'? Fuori dalla modalità box non si legge NIENTE. */
  boxMode: () => boolean
  /** orologio iniettabile (test con orologio finto); default Date.now. */
  now?: () => number
}

let deps: Required<BoxRuntimeDeps> = {
  emit: () => undefined,
  run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
  boxMode: () => false,
  now: () => Date.now()
}

/** Lo stato in memoria (unknown finché la prima lettura non lo cambia). */
let runtime: BoxRuntime = { state: 'unknown', since: 0 }

/** Quando è stata fatta l'ultima lettura (il tick la spazia di 60 s; -∞ = mai). */
let lastRefreshAt = Number.NEGATIVE_INFINITY

/** Il daemon registra qui le sue dipendenze (come initScreen). */
export function initBoxRuntime(d: BoxRuntimeDeps): void {
  deps = { ...d, now: d.now ?? (() => Date.now()) }
}

/** Lo stato attuale del box (in memoria, nessuno spawn). */
export function boxRuntime(): BoxRuntime {
  return runtime
}

/**
 * Cambia lo stato del box. L'evento `box` parte SOLO se lo stato cambia:
 * due ensure di fila (o due letture uguali) fanno UN evento, non due.
 */
export function setBoxRuntime(state: BoxRuntime['state']): void {
  if (runtime.state === state) return
  runtime = { state, since: deps.now() }
  deps.emit({ type: 'box', runtime })
}

/** Solo per i test: azzera lo stato in memoria. */
export function resetBoxRuntimeForTests(): void {
  runtime = { state: 'unknown', since: 0 }
  lastRefreshAt = Number.NEGATIVE_INFINITY
}

/**
 * La LETTURA dello stato del box, col motore di turno: Apple UN solo
 * `ls -a --format json` (il parse puro delle reads, status.state); Docker
 * il ps di oggi per l'esistenza più l'inspect -f {{.State.Running}}. La
 * lettura caduta NON si indovina: stato unknown. Fuori dalla modalità box
 * non si legge niente (l'evento resta com'è).
 */
export async function refreshBoxRuntime(): Promise<BoxRuntime> {
  lastRefreshAt = deps.now()
  if (!deps.boxMode()) return runtime
  const engine = activeBoxEngine()
  const ps = await deps.run(engine.argv.ps(BOX_CONTAINER), { timeoutMs: 15_000 }).catch(() => null)
  if (!ps || ps.exitCode !== 0) {
    setBoxRuntime('unknown')
    return runtime
  }
  // Apple: TUTTO dall'elenco (stato del box compreso) — un solo spawn
  if (engine.reads?.boxState) {
    setBoxRuntime(engine.reads.boxState(ps.stdout, BOX_CONTAINER))
    return runtime
  }
  // Docker (e i motori senza reads): l'esistenza dal ps di oggi, il GIRA
  // dall'inspect -f {{.State.Running}}
  const exists = engine.reads?.psExists(ps.stdout, BOX_CONTAINER) ?? ps.stdout.trim().split('\n').includes(BOX_CONTAINER)
  if (!exists) {
    setBoxRuntime('missing')
    return runtime
  }
  const ins = await deps.run(dockerContainerRunningArgv(BOX_CONTAINER), { timeoutMs: 15_000 }).catch(() => null)
  if (!ins || ins.exitCode !== 0) {
    setBoxRuntime('unknown')
    return runtime
  }
  setBoxRuntime(ins.stdout.trim() === 'true' ? 'running' : 'stopped')
  return runtime
}

/**
 * Il tick del daemon (ogni 30 s): rilegge lo stato del box ogni 60 s SOLO
 * mentre c'è almeno un client UI connesso. Senza UI nessuna lettura, mai —
 * l'app chiusa non accende polling.
 */
export async function tickBoxRuntime(now: number, uiConnected: boolean): Promise<void> {
  if (!uiConnected) return
  if (now - lastRefreshAt < BOX_RUNTIME_REFRESH_MS) return
  await refreshBoxRuntime().catch(() => undefined)
}
