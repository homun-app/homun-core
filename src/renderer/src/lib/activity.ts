// Fase 16b (S3.3): gli strumenti li racconta la mascotte. Qui vivono le due
// funzioni pure che trasformano l'attività del bot in parole:
// - activityPhrase: la mezza riga presente («apre fibrapro.it…») o al passato
//   («Ha aperto fibrapro.it») dalle famiglie di tool, via cataloghi Lingui;
// - stepsOfTurn: il raggruppamento dei passaggi di un turno (le entry
//   tool-call/tool-result dopo il messaggio che ha aperto il turno), con ✓ per
//   i fatti e ○ per quello in corso.
// Mai testo del modello: i target arrivano dal registro (nome del file, host
// dell'URL), il testo dei comandi NON si mostra.
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { TranscriptEntry } from '../../../shared/types'

/** L'attività in corso di un bot, come la manda il daemon (store.activity). */
export interface BotActivity {
  tool: string
  target: string
}

/** Il nome del file dal target (mai il percorso intero). */
export function fileNameOf(target: string): string {
  const t = target.trim()
  if (!t) return ''
  const parts = t.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? t
}

/** L'host di un URL (null se il target non è un URL valido). */
export function hostOf(target: string): string | null {
  const t = target.trim()
  if (!t || !/^https?:\/\//i.test(t)) return null
  try {
    return new URL(t).host
  } catch {
    return null
  }
}

/** La famiglia di tool: verbo presente e passato (descriptor Lingui). */
function familyPhrase(tool: string, target: string, past: boolean): MessageDescriptor {
  const host = hostOf(target)
  const file = fileNameOf(target)
  // i comandi NON mostrano mai il testo: solo «esegue un comando»
  if (tool === 'run-command' || tool === 'run_command') {
    return past ? msg`Ha eseguito un comando` : msg`esegue un comando…`
  }
  if (tool === 'web_search' || tool === 'web-search') {
    return past ? msg`Ha cercato sul web` : msg`cerca sul web…`
  }
  if (tool === 'web_fetch' || tool === 'web-fetch') {
    if (host) return past ? msg`Ha letto ${host}` : msg`legge ${host}…`
    return past ? msg`Ha letto una pagina web` : msg`legge una pagina web…`
  }
  if (tool === 'browser_navigate' || tool === 'browser_open' || tool === 'browser_navigate_to') {
    if (host) return past ? msg`Ha aperto ${host}` : msg`apre ${host}…`
    return past ? msg`Ha aperto una pagina` : msg`apre una pagina…`
  }
  if (tool.startsWith('browser_')) {
    return past ? msg`Ha navigato` : msg`naviga…`
  }
  if (tool === 'read-file' || tool === 'read_file') {
    if (file) return past ? msg`Ha letto ${file}` : msg`legge ${file}…`
    return past ? msg`Ha letto un file` : msg`legge un file…`
  }
  if (tool === 'write-file' || tool === 'write_file' || tool === 'edit-file' || tool === 'edit_file') {
    if (file) return past ? msg`Ha scritto ${file}` : msg`scrive ${file}…`
    return past ? msg`Ha scritto un file` : msg`scrive un file…`
  }
  if (tool === 'list-dir' || tool === 'list_dir' || tool === 'search_files') {
    return past ? msg`Ha guardato i file` : msg`guarda i file…`
  }
  if (tool === 'save_document' || tool === 'save-document') {
    return past ? msg`Ha scritto un documento` : msg`scrive un documento…`
  }
  if (tool === 'save_chart' || tool === 'save-chart') {
    return past ? msg`Ha fatto un grafico` : msg`fa un grafico…`
  }
  // il computer del bot (use-app e i tool di computer use)
  if (tool === 'use-app' || tool === 'computer' || tool.startsWith('computer_')) {
    return past ? msg`Ha usato il computer` : msg`usa il computer…`
  }
  // i tool dei connettori MCP: mcp__<connettore>__<tool>
  if (tool.startsWith('mcp__')) {
    return past ? msg`Ha usato un’app` : msg`usa un’app…`
  }
  return past ? msg`Ha lavorato` : msg`lavora…`
}

/**
 * activityPhrase (pura, testata): la frase della mezza riga. `tense`:
 * 'present' per «apre fibrapro.it…», 'past' per l'elenco dei passaggi
 * («Ha aperto fibrapro.it»). I descriptor li traduce chi li mostra.
 */
export function activityPhrase(
  activity: BotActivity | null | undefined,
  tense: 'present' | 'past' = 'present'
): MessageDescriptor {
  if (!activity || !activity.tool) {
    return tense === 'past' ? msg`Ha lavorato` : msg`lavora…`
  }
  return familyPhrase(activity.tool, activity.target ?? '', tense === 'past')
}

// ---- il raggruppamento dei passaggi per turno ----

/** Un passo del turno: la chiamata, il suo bersaglio, ✓/○ e quando è finito. */
export interface TurnStep {
  tool: string
  target: string
  done: boolean
  at: number
  /** quando è arrivato il risultato (null se il passo è in corso) */
  doneAt: number | null
}

export interface StepGroup {
  steps: TurnStep[]
  startedAt: number | null
  /** l'ultimo risultato ricevuto (null se nessun passo è finito) */
  endedAt: number | null
}

/** Il bersaglio utile dagli argomenti della chiamata (url, path, file…). */
export function targetOfArguments(argsJson: string | undefined): string {
  if (!argsJson) return ''
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>
    for (const key of ['url', 'path', 'file_path', 'file', 'name', 'destination', 'query']) {
      const v = a[key]
      if (typeof v === 'string' && v) return v
    }
  } catch {
    // argomenti non JSON: niente bersaglio
  }
  return ''
}

const isOpener = (e: TranscriptEntry): boolean =>
  e.kind === 'message' && e.role === 'user'

/**
 * stepsOfTurn (pura, testata): i passaggi del turno, cioè le entry tool-call
 * e tool-result DOPO l'ultimo messaggio dell'utente o del sistema che ha
 * aperto il turno. Con upto = 'open' vale tutto il turno in corso (la
 * mascotte mentre lavora); con { entryId } i passaggi del turno che ha
 * prodotto quel messaggio (la «ⓘ» accanto alla risposta).
 * Una chiamata senza risultato (ancora) è il passo in corso (○).
 */
export function stepsOfTurn(entries: TranscriptEntry[], upto: 'open' | { entryId: number }): StepGroup {
  // il confine superiore: l'entry data, o tutto il transcript per il turno aperto
  let endExclusive = entries.length
  if (upto !== 'open') {
    const i = entries.findIndex((e) => e.id === upto.entryId)
    if (i === -1) return { steps: [], startedAt: null, endedAt: null }
    endExclusive = i + 1
  }
  // l'apertura del turno: l'ultimo messaggio utente/sistema prima del confine
  let startExclusive = 0
  for (let i = endExclusive - 1; i >= 0; i--) {
    if (isOpener(entries[i]!)) {
      startExclusive = i + 1
      break
    }
  }
  const window = entries.slice(startExclusive, endExclusive)
  const steps: TurnStep[] = []
  // quando è arrivato il risultato di ogni chiamata (l'ULTIMO vince: il
  // tempo misurato è quello dell'ultimo risultato, non della chiamata)
  const doneAt = new Map<unknown, number>()
  for (const e of window) {
    if (e.kind === 'tool-result') {
      const callId = (e.meta as { callId?: unknown } | null)?.callId
      if (callId !== undefined) doneAt.set(callId, e.createdAt)
    }
  }
  for (const e of window) {
    if (e.kind !== 'tool-call') continue
    const meta = (e.meta ?? {}) as { id?: unknown; arguments?: string }
    steps.push({
      tool: e.content,
      target: targetOfArguments(meta.arguments),
      done: meta.id !== undefined && doneAt.has(meta.id),
      at: e.createdAt,
      doneAt: meta.id !== undefined ? doneAt.get(meta.id) ?? null : null
    })
  }
  let endedAt: number | null = null
  for (const st of steps) if (st.doneAt !== null) endedAt = Math.max(endedAt ?? 0, st.doneAt)
  return {
    steps,
    startedAt: steps.length ? steps[0]!.at : null,
    endedAt
  }
}

/** I secondi tra inizio e fine dei passaggi (null se non ancora misurabili). */
export function stepsDurationSeconds(group: StepGroup, now: number): number | null {
  if (group.startedAt === null) return null
  const end = group.endedAt ?? now
  return Math.max(0, Math.round((end - group.startedAt) / 1000))
}
