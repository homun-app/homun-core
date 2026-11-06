// Fase 16b (S3.3): gli strumenti li racconta la mascotte. Qui vivono le due
// funzioni pure che trasformano l'attività del bot in parole:
// - activityPhrase: la mezza riga presente («apre fibrapro.it…») o al passato
//   («Ha aperto fibrapro.it») dalle famiglie di tool, via cataloghi Lingui;
// - stepsOfTurn: il raggruppamento dei passaggi di un turno (le entry
//   tool-call/tool-result dopo il messaggio che ha aperto il turno), con ✓ per
//   i fatti e ○ per quello in corso.
// Mai testo del modello: i target arrivano dal registro (nome del file, host
// dell'URL), il testo dei comandi NON si mostra.
// V5 (prova vera): gli strumenti MCP dicono QUALE app e COSA — il blocco di
// Composio mostra le azioni coi nomi localizzati della card («Gmail · Elenca
// email»), gli meta strumenti di Composio la loro frase, gli altri server il
// NOME del server («Ha usato Linear»), mai il nome tecnico dello strumento.
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { TranscriptEntry } from '../../../shared/types'
import { composioToolkitName, composioToolkitOfSlug, localizedActionName } from '../../../shared/composio-names'

/** L'attività in corso di un bot, come la manda il daemon (store.activity). */
export interface BotActivity {
  tool: string
  target: string
  /** V5: il nome umano del server MCP (il daemon lo risolve); assente nei passaggi vecchi */
  app?: string
  /**
   * V5: gli argomenti COMPATTI (solo nomi, mai i valori) degli strumenti
   * meta di Composio — il blocco (tools[].tool_slug) e MANAGE_CONNECTIONS
   * (toolkits[].name/action) — perché la frase può dire cosa fa.
   */
  args?: string
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

/**
 * Fase 16b correzioni (P2): le famiglie di tool sono una TABELLA esportata —
 * nome del tool → frase presente/passata, più l'eventuale uso di host o file.
 * Solo nomi VERO del daemon (il test di coerenza in activity.test.ts lo
 * verifica contro le definizioni dei tool); dove il passato non era previsto,
 * si forma come per le famiglie esistenti. Il parametro si chiama SEMPRE
 * host/file: è il nome che finisce nel msgid Lingui (catalogo stabile).
 */
export interface ToolFamily {
  /** i nomi dei tool del daemon che usano questa famiglia */
  tools: readonly string[]
  /** la famiglia mostra l'host dell'URL o il nome del file nel testo */
  target?: 'host' | 'file'
  /** la frase presente; con target, l'host/il file risolto ('' se assente) */
  present: (host: string) => MessageDescriptor
  /** la frase passata; con target, l'host/il file risolto ('' se assente) */
  past: (host: string) => MessageDescriptor
}

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  {
    // i comandi NON mostrano mai il testo: solo «esegue un comando»
    tools: ['run-command'],
    present: () => msg`esegue un comando…`,
    past: () => msg`Ha eseguito un comando`
  },
  {
    // exa/tavily/web_search_exa: i nomi della catena di ricerca del daemon
    tools: ['web_search', 'exa', 'tavily', 'web_search_exa'],
    present: () => msg`cerca sul web…`,
    past: () => msg`Ha cercato sul web`
  },
  {
    tools: ['web_fetch'],
    target: 'host',
    present: (host) => (host ? msg`legge ${host}…` : msg`legge una pagina web…`),
    past: (host) => (host ? msg`Ha letto ${host}` : msg`Ha letto una pagina web`)
  },
  {
    // browser_navigate: il nome MCP vero usato dentro browser.ts
    tools: ['browser_open', 'browser_navigate'],
    target: 'host',
    present: (host) => (host ? msg`apre ${host}…` : msg`apre una pagina…`),
    past: (host) => (host ? msg`Ha aperto ${host}` : msg`Ha aperto una pagina`)
  },
  {
    tools: ['read-file'],
    target: 'file',
    present: (file) => (file ? msg`legge ${file}…` : msg`legge un file…`),
    past: (file) => (file ? msg`Ha letto ${file}` : msg`Ha letto un file`)
  },
  {
    tools: ['write-file'],
    target: 'file',
    present: (file) => (file ? msg`scrive ${file}…` : msg`scrive un file…`),
    past: (file) => (file ? msg`Ha scritto ${file}` : msg`Ha scritto un file`)
  },
  {
    tools: ['list-directory'],
    present: () => msg`guarda i file…`,
    past: () => msg`Ha guardato i file`
  },
  {
    tools: ['write_document', 'edit_document'],
    present: () => msg`scrive un documento…`,
    past: () => msg`Ha scritto un documento`
  },
  {
    tools: ['read_document'],
    present: () => msg`legge un documento…`,
    past: () => msg`Ha letto un documento`
  },
  {
    tools: ['visualize'],
    present: () => msg`fa un grafico…`,
    past: () => msg`Ha fatto un grafico`
  },
  {
    tools: ['save_to_library'],
    present: () => msg`salva nella Libreria…`,
    past: () => msg`Ha salvato nella Libreria`
  },
  {
    tools: ['recall_memory'],
    present: () => msg`ricorda…`,
    past: () => msg`Ha ricordato`
  },
  {
    tools: ['update_memory'],
    present: () => msg`prende nota…`,
    past: () => msg`Ha preso nota`
  },
  {
    tools: ['spawn_subagent', 'message_subagent'],
    present: () => msg`chiede a un aiutante…`,
    past: () => msg`Ha chiesto a un aiutante`
  },
  {
    tools: ['fill_credential'],
    present: () => msg`compila l'accesso…`,
    past: () => msg`Ha compilato l'accesso`
  }
]

const FAMILY_BY_TOOL = new Map<string, ToolFamily>(TOOL_FAMILIES.flatMap((f) => f.tools.map((t) => [t, f] as const)))

/** Il nome leggibile di uno slug di server (linear → Linear, il_mio_server → Il mio server). */
function readableServerName(slug: string): string {
  const words = slug.trim().replace(/[_\-.]+/g, ' ').trim()
  if (!words) return 'app'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * V5: il nome della prima azione del blocco, come nella card —
 * «Gmail · Elenca email» — con «+N» quando le azioni sono di più.
 */
function batchActionsLabel(slugs: readonly string[], lang: 'it' | 'en'): string | null {
  const named = slugs.filter((s) => typeof s === 'string' && s.trim())
  if (named.length === 0) return null
  const first = named[0]!
  const app = composioToolkitName(composioToolkitOfSlug(first))
  const action = localizedActionName(first, lang) ?? readableServerName(
    first.toLowerCase().split(/[_\-.]+/).filter(Boolean).slice(1).join(' ')
  )
  const label = `${app} · ${action}`
  return named.length > 1 ? `${label} +${named.length - 1}` : label
}

/** V5: gli slug delle azioni del blocco dagli argomenti compatti (tools[].tool_slug). */
function batchSlugsOf(argsJson: string | undefined): string[] {
  if (!argsJson) return []
  try {
    const parsed = JSON.parse(argsJson) as { tools?: unknown }
    if (!Array.isArray(parsed.tools)) return []
    return parsed.tools
      .map((t) => (t && typeof t === 'object' ? String((t as { tool_slug?: unknown }).tool_slug ?? '') : ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

/** V5: le voci di MANAGE_CONNECTIONS dagli argomenti (toolkits[].name/action). */
function manageEntriesOf(argsJson: string | undefined): Array<{ name: string; action: string }> {
  if (!argsJson) return []
  try {
    const parsed = JSON.parse(argsJson) as { toolkits?: unknown }
    if (!Array.isArray(parsed.toolkits)) return []
    return parsed.toolkits
      .map((t) => (t && typeof t === 'object' ? { name: String((t as { name?: unknown }).name ?? ''), action: String((t as { action?: unknown }).action ?? 'add') } : null))
      .filter((t): t is { name: string; action: string } => !!t)
  } catch {
    return []
  }
}

/** La famiglia di tool: verbo presente e passato (descriptor Lingui). */
function familyPhrase(
  tool: string,
  target: string,
  past: boolean,
  activity: BotActivity,
  lang: 'it' | 'en'
): MessageDescriptor {
  const row = FAMILY_BY_TOOL.get(tool)
  if (row) {
    const t = row.target === 'host' ? (hostOf(target) ?? '') : row.target === 'file' ? fileNameOf(target) : ''
    return (past ? row.past : row.present)(t)
  }
  // il resto del browser, azioni sulla pagina aperta (prefisso browser_)
  if (tool.startsWith('browser_')) {
    return past ? msg`Ha navigato` : msg`naviga…`
  }
  // il computer del bot (use-app e i tool di computer use)
  if (tool === 'use-app' || tool.startsWith('computer_')) {
    return past ? msg`Ha usato il computer` : msg`usa il computer…`
  }
  // V5: gli strumenti Composio del VECCHIO flusso SDK (composio__gmail__…) — l'app umana
  if (tool.startsWith('composio__')) {
    const app = composioToolkitName(tool.split('__')[1] ?? '')
    return past ? msg`Ha usato ${app}` : msg`usa ${app}…`
  }
  // i tool dei connettori MCP: mcp__<server>__<tool> — V5: QUALE app, COSA fa
  if (tool.startsWith('mcp__')) {
    const original = tool.split('__').slice(2).join('__')
    // il blocco di Composio (su qualunque server): le azioni come nella card
    if (original === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
      const label = batchActionsLabel(batchSlugsOf(activity.args), lang)
      if (label) return past ? msg`Ha usato ${label}` : msg`usa ${label}…`
      return past ? msg`Ha usato un’app` : msg`usa un’app…`
    }
    if (original === 'COMPOSIO_SEARCH_TOOLS' || original === 'COMPOSIO_GET_TOOL_SCHEMAS') {
      return past ? msg`Ha cercato lo strumento giusto` : msg`cerca lo strumento giusto…`
    }
    if (original === 'COMPOSIO_MANAGE_CONNECTIONS') {
      const entries = manageEntriesOf(activity.args)
      const firstAdd = entries.find((e) => e.action === 'add' && e.name)
      if (firstAdd) {
        const app = composioToolkitName(firstAdd.name)
        return past ? msg`Ha collegato ${app}` : msg`collega ${app}…`
      }
      return past ? msg`Ha controllato le app collegate` : msg`controlla le app collegate…`
    }
    // gli altri server MCP: il NOME del server («Ha usato Linear»), mai il
    // nome tecnico dello strumento (se il daemon ha passato solo lo slug, si
    // rende leggibile)
    const app = activity.app && activity.app !== target ? activity.app : readableServerName(target)
    return past ? msg`Ha usato ${app}` : msg`usa ${app}…`
  }
  return past ? msg`Ha lavorato` : msg`lavora…`
}

/**
 * activityPhrase (pura, testata): la frase della mezza riga. `tense`:
 * 'present' per «apre fibrapro.it…», 'past' per l'elenco dei passaggi
 * («Ha aperto fibrapro.it»). `lang` decide i nomi localizzati delle azioni
 * Composio (V5); i descriptor li traduce chi li mostra.
 */
export function activityPhrase(
  activity: BotActivity | null | undefined,
  tense: 'present' | 'past' = 'present',
  lang: 'it' | 'en' = 'it'
): MessageDescriptor {
  if (!activity || !activity.tool) {
    return tense === 'past' ? msg`Ha lavorato` : msg`lavora…`
  }
  return familyPhrase(activity.tool, activity.target ?? '', tense === 'past', activity, lang)
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
  /** V5: gli argomenti COMPATTI degli strumenti meta di Composio (solo nomi) */
  args?: string
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

/**
 * V5: gli argomenti COMPATTI di una chiamata agli strumenti meta di Composio
 * (il blocco e MANAGE_CONNECTIONS) — SOLO i nomi delle azioni e dei toolkit,
 * mai i valori (destinatari, testi) che non si mostrano. Vuoto per tutto il resto.
 */
export function composioArgsOf(tool: string, argsJson: string | undefined): string | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const original = tool.split('__').slice(2).join('__')
  if (original !== 'COMPOSIO_MULTI_EXECUTE_TOOL' && original !== 'COMPOSIO_MANAGE_CONNECTIONS') return undefined
  if (!argsJson) return undefined
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>
    if (original === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
      if (!Array.isArray(a.tools)) return undefined
      const slugs = a.tools
        .map((t) => (t && typeof t === 'object' ? String((t as { tool_slug?: unknown }).tool_slug ?? '') : ''))
        .filter(Boolean)
      return slugs.length ? JSON.stringify({ tools: slugs.map((s) => ({ tool_slug: s })) }) : undefined
    }
    if (!Array.isArray(a.toolkits)) return undefined
    const entries = a.toolkits
      .map((t) => (t && typeof t === 'object' ? { name: String((t as { name?: unknown }).name ?? ''), action: String((t as { action?: unknown }).action ?? 'add') } : null))
      .filter((t): t is { name: string; action: string } => !!t)
    return entries.length ? JSON.stringify({ toolkits: entries }) : undefined
  } catch {
    return undefined
  }
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
    // V5: i nomi (solo i nomi) degli strumenti meta di Composio, per la frase
    const stepArgs = composioArgsOf(e.content, meta.arguments)
    steps.push({
      tool: e.content,
      target: targetOfArguments(meta.arguments),
      done: meta.id !== undefined && doneAt.has(meta.id),
      at: e.createdAt,
      doneAt: meta.id !== undefined ? doneAt.get(meta.id) ?? null : null,
      ...(stepArgs ? { args: stepArgs } : {})
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

/**
 * P5 (fase pulizia): l'etichetta della durata del riquadro dei passaggi — un
 * turno sotto il secondo dice «< 1 s» (mai «0 s»); senza durata nota
 * (startedAt nullo) NON c'è tempo: null, e chi rende omette il «· X s».
 */
export function stepsDurationLabel(group: StepGroup, now: number): string | null {
  const secs = stepsDurationSeconds(group, now)
  if (secs === null) return null
  return secs === 0 ? '< 1 s' : `${secs} s`
}
