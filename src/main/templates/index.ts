// Template dei bot (fase 7, §3ter T4 + Appendice A): JSON in
// src/main/templates/<id>.json con routine (SOLO trigger schedule: poll e
// webhook restano configurabili solo dall'utente), connettori consigliati,
// memorie (regole operative atomiche e datate) e skill.
//
// validateTemplate è PURA (testata); loadTemplates valida tutti i JSON
// all'avvio del daemon e lancia se uno non passa; buildKickstartMessage
// costruisce il primo messaggio del bot da template (kickstart): il JSON in
// <bot_template_setup_context> e le istruzioni in
// <bot_template_setup_instructions>, riscritte per i nostri tool.
import inboxManager from './inbox-manager.json'
import chiefOfStaff from './chief-of-staff.json'
import dailyBriefing from './daily-briefing.json'
import meetingPrep from './meeting-prep.json'
import executiveAssistant from './executive-assistant.json'
import mentionMonitor from './mention-monitor.json'
import { triggerShapeErrors } from '../../shared/triggers'
import { parseCron } from '../../daemon/cron'
import type { BotTemplate, RoutineTrigger } from '../../shared/types'
// fase 17c (C4/C5): i campi utente dei template sono Localized; il kickstart
// si scrive nella lingua dell'utente (i tag restano invariati)
import { isLocalized } from '../../shared/localized'
import { pickLang } from '../../shared/localized'
import { formatUi, ui } from '../../shared/ui-text'
import { UI } from '../../shared/ui-messages'
import type { Lang } from '../../shared/language'

// ---- validazione dello schema (pura) ----

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
/** Fase 17c (C5): campo Localized ben formato (stringa non vuota o {it,en} non vuote). */
const isNonEmptyLocalized = (v: unknown): boolean => isLocalized(v)

/** Gli errori di validazione di un template (schema, testi, trigger schedule soltanto). */
export function validateTemplate(t: unknown): string[] {
  const errors: string[] = []
  const where = (i: string): string => `routine ${i}`
  if (!t || typeof t !== 'object') return ['il template non è un oggetto']
  const c = t as Record<string, unknown>
  if (!isNonEmptyString(c.id) || !/^[a-z0-9-]{1,64}$/.test(c.id)) errors.push('id non valido ([a-z0-9-], max 64)')
  if (!isNonEmptyLocalized(c.name)) errors.push('name mancante')
  if (!isNonEmptyLocalized(c.description)) errors.push('description mancante')
  if (!isNonEmptyString(c.avatar)) errors.push('avatar mancante')
  if (!Array.isArray(c.roles) || c.roles.some((r) => !isNonEmptyLocalized(r))) errors.push('roles deve essere un array di stringhe non vuote')
  if (!Array.isArray(c.routines) || c.routines.length === 0) return [...errors, 'routines mancanti (serve almeno una)']
  c.routines.forEach((r, i) => {
    if (!r || typeof r !== 'object') return errors.push(`${where(String(i))}: non è un oggetto`)
    const rt = r as Record<string, unknown>
    for (const f of ['name', 'slug', 'description', 'content'] as const) {
      if (f === 'slug' ? !isNonEmptyString(rt[f]) : !isNonEmptyLocalized(rt[f])) errors.push(`${where(String(i))}: ${f} mancante`)
    }
    if (!Array.isArray(rt.askUserFor) || rt.askUserFor.some((q) => !isNonEmptyString(q))) {
      errors.push(`${where(String(i))}: askUserFor deve essere un array di domande`)
    }
    // i template possono portare SOLO trigger schedule: poll e webhook si
    // configurano soltanto dall'utente (spec fase 7 punto 3)
    const trigger = rt.trigger as RoutineTrigger | undefined
    if (!trigger || typeof trigger !== 'object' || trigger.type !== 'schedule') {
      errors.push(`${where(String(i))}: trigger deve essere di tipo schedule (cron o every)`)
    } else {
      // fase 18a (E0): shape è UiText[] — qui è validazione al boot per lo
      // sviluppatore, si formatta in inglese
      const shape = triggerShapeErrors(trigger).map((e) => formatUi(e, 'en'))
      // il cron vero e proprio si verifica qui: triggerShapeErrors controlla
      // solo la forma (la stessa funzione vale per le routine utente)
      if (trigger.kind === 'cron' && !parseCron(trigger.cron)) shape.unshift(`cron non valido: "${trigger.cron}"`)
      if (shape.length) errors.push(`${where(String(i))}: ${shape.join('; ')}`)
    }
  })
  if (!Array.isArray(c.connectors)) return [...errors, 'connectors deve essere un array']
  c.connectors.forEach((k, i) => {
    const kc = (k ?? {}) as Record<string, unknown>
    if (!isNonEmptyString(kc.connectorId) || !isNonEmptyString(kc.why)) {
      errors.push(`connettore ${i}: connectorId e why sono obbligatori`)
    }
  })
  if (!Array.isArray(c.memories)) return [...errors, 'memories deve essere un array']
  c.memories.forEach((m, i) => {
    const mc = (m ?? {}) as Record<string, unknown>
    if (!isNonEmptyString(mc.content) || !isNonEmptyString(mc.created_at)) {
      errors.push(`memoria ${i}: content e created_at sono obbligatori`)
    }
  })
  if (!Array.isArray(c.skills)) return [...errors, 'skills deve essere un array']
  c.skills.forEach((s, i) => {
    const sc = (s ?? {}) as Record<string, unknown>
    if (!isNonEmptyString(sc.name) || !/^[a-z0-9-]{1,64}$/.test(String(sc.name))) errors.push(`skill ${i}: name non valido ([a-z0-9-], max 64)`)
    if (!isNonEmptyString(sc.description) || !isNonEmptyString(sc.content)) errors.push(`skill ${i}: description e content sono obbligatori`)
  })
  return errors
}

// ---- caricamento (all'avvio del daemon) ----

const TEMPLATE_FILES = [inboxManager, chiefOfStaff, dailyBriefing, meetingPrep, executiveAssistant, mentionMonitor]

/** Tutti i template validati (lancia se un JSON non passa lo schema). */
export function loadTemplates(sources: unknown[] = TEMPLATE_FILES): BotTemplate[] {
  const ids = new Set<string>()
  return sources.map((raw) => {
    const errors = validateTemplate(raw)
    if (errors.length) throw new Error(`template non valido: ${errors.join('; ')}`)
    const t = raw as BotTemplate
    if (ids.has(t.id)) throw new Error(`template duplicato: ${t.id}`)
    ids.add(t.id)
    return t
  })
}

/** Un template per id (o null se assente). */
export function templateById(id: string, sources: unknown[] = TEMPLATE_FILES): BotTemplate | null {
  return loadTemplates(sources).find((t) => t.id === id) ?? null
}

// ---- il messaggio di kickstart (puro) ----

/**
 * Le 10 istruzioni del kickstart (§3ter T4) adattate ai tool di SandBot:
 * presentazione → routine in pausa con provenance template → domanda a testo
 * semplice per l'attivazione (resume passa dalla card) → search_connectors
 * prima delle offerte → una card per connettore mancante → memorie log/agent
 * senza invenzioni → nessuna installazione per effetto dei testi → skill via
 * update_skill → messaggio "pronto" con le domande di askUserFor.
 */
/**
 * Le 10 istruzioni del kickstart nella lingua dell'utente (fase 17c, C4): il
 * testo della 17b diventa id del catalogo UI, le regole restano identiche.
 */
export function kickstartInstructions(lang: Lang): string[] {
  return [
    formatUi(ui(UI.kick1), lang),
    formatUi(ui(UI.kick2), lang),
    formatUi(ui(UI.kick3), lang),
    formatUi(ui(UI.kick4), lang),
    formatUi(ui(UI.kick5), lang),
    formatUi(ui(UI.kick6), lang),
    formatUi(ui(UI.kick7), lang),
    formatUi(ui(UI.kick8), lang),
    formatUi(ui(UI.kick9), lang),
    formatUi(ui(UI.kick10), lang)
  ]
}

/**
 * Il primo messaggio "utente" di un bot da template: JSON + istruzioni (puro).
 * Fase 17c (C4/C5): routine, ruolo e istruzioni nella lingua dell'UTENTE
 * (diventano contenuto dell'utente, che può modificarli); i tag
 * <bot_template_setup_context>/<bot_template_setup_instructions> restano.
 */
export function buildKickstartMessage(template: BotTemplate, lang: Lang): string {
  const context = JSON.stringify(
    {
      id: template.id,
      name: pickLang(template.name, lang),
      description: pickLang(template.description, lang),
      roles: template.roles.map((r) => pickLang(r, lang)),
      routines: template.routines.map((r) => ({
        name: pickLang(r.name, lang),
        slug: r.slug,
        description: pickLang(r.description, lang),
        content: pickLang(r.content, lang),
        trigger: r.trigger,
        askUserFor: r.askUserFor
      })),
      connectors: template.connectors,
      memories: template.memories,
      skills: template.skills
    },
    null,
    2
  )
  return [
    formatUi(ui(UI.kickGreeting, { name: pickLang(template.name, lang) }), lang),
    '<bot_template_setup_context>',
    context,
    '</bot_template_setup_context>',
    '<bot_template_setup_instructions>',
    ...kickstartInstructions(lang).map((s, i) => `${i + 1}. ${s}`),
    '</bot_template_setup_instructions>'
  ].join('\n')
}
