// Pannello destro (fase 16b, S4 → fase pagine G3): il pannello del BOT a Due
// schede — Attività · Libreria (catture 12 e 13). In cima la mascotte grande
// SOSPESA e il nome: cliccandoli si apre il foglio «Impostazioni del bot» con
// le sezioni di oggi (Profilo, Routine come elenco completo, Avanzate) —
// Profilo e Avanzate non spariscono. Attività, dall'alto: i Suggerimenti
// proattivi (G4, da regole e mai dal modello), il Computer del bot (card con
// anteprima e stato, clic = la scheda di oggi a 560 px), le prossime 3
// routine e gli Ultimi lavori di oggi. Libreria: quello che QUESTO bot (e i
// suoi sottoagenti) ha prodotto, con le pillole Tutti / Pagine / Media,
// raggruppato per giorno e «Mostra altro». Le larghezze restano quelle della
// 16b-correzioni-2 (pannello 340, Computer 560, layoutFor); con una SQUADRA
// aperta il pannello mostra «Membri» come prima.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatDate, phraseIn } from '../lib/i18n'
import { X, Plus, Link2, Repeat, PencilLine, Monitor } from 'lucide-react'
import { api, useStore, useResolvedModel } from '../store'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
// fase pagine (G4): i suggerimenti, da regole e non dal modello
import { botSuggestions, type BotSuggestion } from '../lib/bot-suggestions'
// fase catalogo app: l'elenco unico per la regola «Collega <App>»
import { loadAppCatalog } from '../../../shared/app-catalog'
import type { GroupInfo, LibraryItemInfo, RoutineInfo, ThinkingSetting, Agent, AgentAvatar, ScreenStatus } from '../../../shared/types'
import { ChangeAvatarDialog } from './BotDialogs'
// fase 16b correzioni 2 (Q1): il risultato di layoutFor
import type { LayoutResult } from '../layout'
// fase 19b (T1) → fase 16b (S4): il pannello «Computer» vive QUI come scheda
import { ComputerPanel } from './ComputerPanel'
import { ModelSelect } from './ui/ModelSelect'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

/** L'etichetta ✕ del pannello, sulla riga comune (fase 16b correzioni 2, Q3). */
function PanelClose({ onClose }: { onClose(): void }) {
  const { i18n } = useLingui()
  return (
    <button
      className="no-drag grid size-9 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
      aria-label={i18n.t(msg`Chiudi il pannello`)}
      title={i18n.t(msg`Chiudi il pannello`)}
      onClick={onClose}
    >
      <X className="size-4" />
    </button>
  )
}

/** La fascia alta del pannello: trascinamento della finestra + ✕ a y 12 (Q3). */
function PanelTopBand({ onClose }: { onClose(): void }) {
  return (
    <div className="drag-region absolute inset-x-0 top-0 z-10 flex h-[60px] flex-col">
      <div className="mt-3 flex h-9 items-center justify-end px-4">
        <PanelClose onClose={onClose} />
      </div>
    </div>
  )
}

const TASK_LABEL: Record<string, MessageDescriptor> = {
  working: msg`in corso`,
  needs_input: msg`attende te`,
  done: msg`completato`,
  failed: msg`non riuscito`,
  cancelled: msg`annullato`
}

/** Le due schede del pannello (G3); Computer si apre dalla card di Attività. */
type PanelTab = 'activity' | 'library' | 'computer'

const TAB_LABEL: Record<'activity' | 'library', MessageDescriptor> = {
  activity: msg`Attività`,
  library: msg`Libreria`
}

/** Riga chiave/valore senza bordi, come il mockup (S4). */
function KvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  )
}

/** Titoletto piccolo e grigio delle sezioni (mockup 7). */
function SmallTitle({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-4 text-xs font-semibold text-muted-foreground">{children}</p>
}

/** Profilo: descrizione, righe chiave/valore, Cambia aspetto, Ultimi lavori. */
function ProfileTab({ onAvatar }: { onAvatar(): void }) {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const agents = useStore((s) => s.agents)
  const providers = useStore((s) => s.providers)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const mainModel = useStore((s) => s.mainModel)
  const groups = useStore((s) => s.groups)
  const tasks = useStore((s) => s.tasks)
  const openTask = useStore((s) => s.openTask)
  const setMemoryOpen = useStore((s) => s.setMemoryOpen)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  const setSkillsFilterAgent = useStore((s) => s.setSkillsFilterAgent)
  const [memories, setMemories] = useState<number | null>(null)
  const [skills, setSkills] = useState<number | null>(null)
  const agent = agents.find((a) => a.id === activeId)
  useEffect(() => {
    setMemories(null)
    setSkills(null)
    if (!activeId) return
    void api.listMemories(activeId).then((m) => setMemories(m.length)).catch(() => setMemories(0))
    // fase skill (S2): il conteggio viene dalla libreria unica (una chiamata)
    void api.skillsLibrary()
      .then((r) => setSkills(r.library.filter((sk) => sk.enabledFor.includes('*') || sk.enabledFor.includes(activeId)).length))
      .catch(() => setSkills(0))
  }, [activeId])
  // fase 16c correzioni (R4): il modello risolto passa dal selettore UNICO
  const resolved = useResolvedModel(agent?.id ?? null)
  if (!agent) return null
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const coordinates = groups.filter((g) => g.coordinatorId === agent.id)
  const recent = tasks.filter((tk) => tk.agentId === agent.id).slice(-5).reverse()
  return (
    <div className="space-y-2">
      <p className="text-sm leading-relaxed text-foreground/80">{agent.description || <Trans>Nessuna descrizione.</Trans>}</p>
      <div className="mt-2">
        <KvRow label={i18n.t(msg`Modello`)}>
          {resolved
            ? `${providers.find((p) => p.id === resolved.providerId)?.name ?? resolved.providerId} · ${resolved.model}`
            : <span className="text-muted-foreground"><Trans>da scegliere</Trans></span>}
        </KvRow>
        <KvRow label={i18n.t(msg`Memoria`)}>
          <button className="transition hover:text-foreground" onClick={() => { setMemoryOpen(true); setSkillsOpen(false) }}>
            <Trans>{memories === null ? '…' : `${memories} note`} ›</Trans>
          </button>
        </KvRow>
        {/* fase skill (S4): il pannello diventa un RIMANDO alla finestra
            «Skill» filtrata sul bot */}
        <KvRow label={i18n.t(msg`Skill`)}>
          <button
            className="transition hover:text-foreground"
            data-testid="rightpanel-skills"
            onClick={() => { setSkillsFilterAgent(activeId); setSkillsOpen(true); setMemoryOpen(false) }}
          >
            <Trans>{skills === null ? '…' : `${skills}`} ›</Trans>
          </button>
        </KvRow>
        <KvRow label={i18n.t(msg`Ruolo`)}>
          {agent.id === effectiveMain
            ? <Trans>Principale</Trans>
            : coordinates.length > 0
              ? <Trans>Coordina «{coordinates[0]!.name}»</Trans>
              : <span className="text-muted-foreground">—</span>}
        </KvRow>
      </div>
      <button className="mt-2 rounded-full bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-accent" onClick={onAvatar}>
        <Trans>Cambia aspetto</Trans>
      </button>
      <div className="mt-4">
        <p className="mb-1.5 text-[13px] text-muted-foreground"><Trans>Ultimi lavori</Trans></p>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground"><Trans>Nessun task.</Trans></p>
        ) : (
          <div className="space-y-1">
            {recent.map((tk) => (
              <button
                key={tk.id}
                className="flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-sm transition hover:bg-muted/60"
                onClick={() => openTask(tk.id)}
              >
                <span className="min-w-0 flex-1 truncate">{tk.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{i18n.t(TASK_LABEL[tk.status] ?? msg`${tk.status}`)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Routine del bot: nome, quando gira, prossima esecuzione, pausa/riprendi, +. */
function RoutinesTab() {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const [routines, setRoutines] = useState<RoutineInfo[] | null>(null)
  const load = (): void => {
    if (activeId) api.listRoutines(activeId).then(setRoutines).catch(() => setRoutines([]))
  }
  useEffect(() => {
    setRoutines(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])
  if (routines === null) return <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
  return (
    <div className="space-y-1">
      <button
        className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-border py-2 text-xs text-muted-foreground transition hover:text-foreground"
        onClick={() => { setSettingsTab('routine'); setSettingsOpen(true) }}
      >
        <Plus className="size-3.5" /> <Trans>Nuova routine</Trans>
      </button>
      {routines.length === 0 ? (
        <p className="text-sm text-muted-foreground"><Trans>Nessuna routine.</Trans></p>
      ) : (
        routines.map((r) => (
          <div key={r.id} className="rounded-[14px] bg-muted/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
              <button
                className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] text-foreground transition hover:bg-accent"
                onClick={() => { void api.updateRoutine(r.id, { enabled: r.enabled ? 0 : 1 }).then(load).catch(() => undefined) }}
              >
                {r.enabled ? <Trans>metti in pausa</Trans> : <Trans>riprendi</Trans>}
              </button>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {r.enabled
                ? (r.next_run
                    ? <Trans>prossima {formatDate(r.next_run, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</Trans>
                    : <Trans>attiva</Trans>)
                : <Trans>in pausa</Trans>}
            </p>
          </div>
        ))
      )}
    </div>
  )
}

/** Avanzate: ciò che oggi sta nelle Impostazioni › Bot, niente di inventato. */
function AdvancedTab() {
  const { t, i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const agents = useStore((s) => s.agents)
  const providers = useStore((s) => s.providers)
  const mainModel = useStore((s) => s.mainModel)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const setMainAgent = useStore((s) => s.setMainAgent)
  const agent = agents.find((a) => a.id === activeId)
  const [notifOff, setNotifOff] = useState<boolean | null>(null)
  const [section, setSection] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setConfirmDelete(false)
    setSection(agent?.section ?? '')
    setNotifOff(null)
    void api.settingsGet<string[]>('notifications.disabledAgents', []).then((v) => setNotifOff(v.includes(activeId ?? ''))).catch(() => setNotifOff(false))
  }, [activeId, agent?.section])
  // fase 16c correzioni (R4): il modello risolto passa dal selettore UNICO;
  // followsMain viene da lì (vale anche per il provider proprio sparito, R3.6:
  // finché l'utente non sceglie, il pannello mostra «Come gli altri»)
  const resolved = useResolvedModel(agent?.id ?? null)
  if (!agent) return null
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const followsMain = resolved?.followsMain === true
  const patch = (p: Partial<Agent>): void => {
    void api.updateAgent(agent.id, p).catch((e) => console.error('updateAgent:', e instanceof Error ? e.message : e))
  }
  const toggleNotif = (off: boolean): void => {
    setNotifOff(off)
    void api.settingsGet<string[]>('notifications.disabledAgents', [])
      .then((all) => {
        const next = off ? [...new Set([...all, agent.id])] : all.filter((x) => x !== agent.id)
        return api.settingsSet('notifications.disabledAgents', next)
      })
      .catch(() => undefined)
  }
  return (
    <div className="space-y-1 text-sm">
      <SmallTitle><Trans>Notifiche</Trans></SmallTitle>
      <button
        className="flex w-full items-center justify-between rounded-[12px] px-2.5 py-2 transition hover:bg-muted/60"
        onClick={() => toggleNotif(!notifOff)}
      >
        <span className="text-left"><Trans>Quando finisce o mi aspetta</Trans></span>
        <span className={`relative h-6 w-10 rounded-full transition ${notifOff ? 'bg-muted' : 'bg-foreground'}`}>
          <span className={`absolute top-0.5 size-5 rounded-full bg-card transition-all ${notifOff ? 'left-0.5' : 'right-0.5'}`} />
        </span>
      </button>

      <SmallTitle><Trans>Modello e ragionamento</Trans></SmallTitle>
      {/* fase impostazioni (I6): UN solo ModelSelect al posto di select dei
          provider + ModelPicker; «Come gli altri · <modello principale>» è la
          prima voce (salva null/null, come sempre) e il ragionamento sta nel
          «⋯» della riga (I1.4) */}
      <ModelSelect
        value={followsMain || !agent.providerId || !agent.model
          ? null
          : { providerId: agent.providerId, model: agent.model }}
        onChange={(r) => patch(r ? { providerId: r.providerId, model: r.model } : { providerId: null, model: null })}
        allowFollowMain
        thinking={agent.thinking ?? 'default'}
        onThinking={(level) => patch({ thinking: level })}
        // «Come gli altri»: i livelli del ragionamento vengono dal modello
        // principale risolto (il ⋯ resta offerto anche seguendo)
        followModel={followsMain && resolved ? { providerId: resolved.providerId, model: resolved.model } : null}
        aria-label={t`Modello del bot`}
      />

      <SmallTitle><Trans>Istruzioni</Trans></SmallTitle>
      <textarea
        data-testid="bot-instructions"
        className="min-h-24 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
        placeholder={t`Descrizione / ruolo del bot (va nel system prompt)`}
        defaultValue={agent.description}
        onBlur={(e) => { if (e.target.value !== agent.description) patch({ description: e.target.value }) }}
      />

      <SmallTitle><Trans>Sezione</Trans></SmallTitle>
      <input
        className="w-full rounded-[10px] bg-muted px-3 py-2 text-sm outline-none"
        placeholder={t`Progetto (titolo nella barra)`}
        value={section}
        onChange={(e) => setSection(e.target.value)}
        onBlur={() => { if (section !== (agent.section ?? '')) patch({ section }) }}
      />

      <div className="mt-5 space-y-2">
        {agent.id !== effectiveMain && (
          <button className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm transition hover:bg-accent" onClick={() => void setMainAgent(agent.id)}>
            <Trans>Rendi principale</Trans>
          </button>
        )}
        {confirmDelete ? (
          <div className="space-y-1.5">
            <p className="text-xs text-destructive"><Trans>Elimina {agent.name} con le sue chat, memorie e routine?</Trans></p>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-[12px] bg-destructive/10 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/20"
                onClick={async () => {
                  await api.deleteAgent(agent.id).catch(() => undefined)
                  const rest = await api.listAgents()
                  if (rest[0]) void useStore.getState().select(rest[0].id)
                }}
              >
                <Trans>Elimina bot</Trans>
              </button>
              <button className="flex-1 rounded-[12px] bg-muted px-3 py-2 text-sm transition hover:bg-accent" onClick={() => setConfirmDelete(false)}>
                <Trans>Annulla</Trans>
              </button>
            </div>
          </div>
        ) : (
          <button className="w-full rounded-[12px] bg-muted px-3 py-2 text-sm text-muted-foreground transition hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trans>Elimina bot</Trans>
          </button>
        )}
      </div>
    </div>
  )
}

// ---- fase pagine (G4): i suggerimenti ----

/** Il setting dove vivono i suggerimenti ignorati: { [agentId]: [id…] }. */
const DISMISS_SETTING = 'suggestions.dismissed'

const SUGGESTION_ICON: Record<BotSuggestion['icon'], typeof Link2> = {
  link: Link2,
  repeat: Repeat,
  edit: PencilLine
}

/**
 * I suggerimenti proattivi di Attività: le regole di botSuggestions sullo
 * stato già disponibile (mai il modello, mai testo di terzi). Ogni riga ha la
 * sua ✕: il suggerimento non torna per quel bot (setting suggestions.dismissed).
 */
function SuggestionsBlock({ agentId }: { agentId: string }) {
  const { i18n } = useLingui()
  const entries = useStore((s) => s.entries)
  const agents = useStore((s) => s.agents)
  const connectors = useStore((s) => s.connectors)
  const composio = useStore((s) => s.composio)
  const composioGateway = useStore((s) => s.composioGateway)
  const openAppsOn = useStore((s) => s.openAppsOn)
  const setComposerPrefill = useStore((s) => s.setComposerPrefill)
  const openBotSheet = useStore((s) => s.openBotSheet)
  const setRightPanel = useStore((s) => s.setRightPanel)
  // P3 (fase pagine · ritocchi): la lingua dell'UTENTE per il testo
  // precompilato della routine (può differire da quella dell'interfaccia)
  const activeLanguage = useStore((s) => s.activeLanguage)
  const [userLang, setUserLang] = useState<'it' | 'en' | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [installed, setInstalled] = useState<Array<{ id: string; enabledFor?: string[] | null; needsAuth?: unknown; needsReauth?: boolean }> | null>(null)

  useEffect(() => {
    let alive = true
    setDismissed([])
    setInstalled(null)
    setUserLang(null)
    void api.settingsGet<Record<string, string[]>>(DISMISS_SETTING, {})
      .then((v) => { if (alive) setDismissed(v[agentId] ?? []) })
      .catch(() => undefined)
    // P3: l'ultima lingua rilevata da un messaggio umano (currentUserLanguage
    // del daemon); null → vale la lingua dell'interfaccia
    void api.settingsGet<string | null>('agent.userLanguage', null)
      .then((v) => { if (alive) setUserLang(v === 'it' || v === 'en' ? v : null) })
      .catch(() => undefined)
    void api.connectorsInstalled()
      .then((r) => { if (alive) setInstalled((r as { servers: Array<{ id: string; enabledFor?: string[] | null; needsAuth?: unknown; needsReauth?: boolean }> }).servers) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [agentId])

  // le app del catalogo con il loro stato per QUESTO bot (la stessa regola
  // della finestra App: collegata diretta o dentro l'account Composio)
  const apps = useMemo(() => {
    const staticReady = new Set(connectors.filter((c) => c.clientRegistration === 'static' && c.hasStaticCredentials).map((c) => c.id))
    const catalog = loadAppCatalog({ staticClientsReady: staticReady })
    const directState = new Map(connectors.map((c) => [c.id, c.state.status]))
    const gateway = new Map((composioGateway?.connected ?? []).map((a) => [a.slug, a]))
    const key = new Map((composio?.connected ?? []).map((a) => [a.slug, a]))
    const serverById = new Map((installed ?? []).map((s) => [s.id, s]))
    return catalog.map((app) => {
      let connectedForBot = false
      const server = app.directId ? serverById.get(app.directId) : undefined
      if (server) {
        const enabled = server.enabledFor == null || server.enabledFor.includes('*') || server.enabledFor.includes(agentId)
        connectedForBot = enabled && !server.needsAuth && !server.needsReauth
      } else if (app.directId && directState.get(app.directId) === 'connected') {
        // collegata senza righe per-bot: vale per tutti i bot
        connectedForBot = true
      }
      const slug = app.composioSlug
      if (!connectedForBot && slug) {
        const g = gateway.get(slug)
        const k = key.get(slug)
        connectedForBot = g?.status === 'ACTIVE' || k?.status === 'ACTIVE'
      }
      return { id: app.id, name: app.name, connectedForBot }
    })
  }, [connectors, composio, composioGateway, installed, agentId])

  const suggestions = useMemo(() => botSuggestions({
    messages: entries
      .filter((e) => e.kind === 'message' && e.role === 'user')
      .map((e) => ({
        text: e.content,
        at: e.createdAt,
        initiator: e.meta?.initiator as string | undefined,
        fromAgentId: e.meta?.fromAgentId as string | undefined
      })),
    apps,
    agentDescription: agents.find((a) => a.id === agentId)?.description ?? '',
    turns: entries.filter((e) => e.kind === 'message' && e.role === 'user' && !e.meta?.initiator && !e.meta?.fromAgentId).length,
    dismissed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [entries, apps, agents, agentId, dismissed])

  const dismiss = (id: string): void => {
    setDismissed((d) => [...d, id])
    void api.settingsGet<Record<string, string[]>>(DISMISS_SETTING, {})
      .then((all) => api.settingsSet(DISMISS_SETTING, { ...all, [agentId]: [...new Set([...(all[agentId] ?? []), id])] }))
      .catch(() => undefined)
  }
  /**
   * P3: il testo precompilato della routine segue la lingua dell'UTENTE (o,
   * in mancanza, quella dell'interfaccia): «Fai di questo una routine: …» /
   * «Make this a routine: …». Quando la lingua coincide con quella attiva
   * basta il msg macro; quando DIFFERISCE si legge la frase dal catalogo di
   * quella lingua (i18n.t traduce sempre nella lingua attiva) — il msgid è
   * quello del macro, così i due testi non possono divergere.
   */
  const makeRoutinePrefill = async (request: string): Promise<void> => {
    const lang = userLang ?? activeLanguage
    const phrase = msg`Fai di questo una routine: ${request}`
    const text = lang === activeLanguage
      ? i18n.t(phrase)
      : await phraseIn(lang, phrase.id!, { request })
    setComposerPrefill(text)
    setRightPanel(false)
  }
  const run = (s: BotSuggestion): void => {
    if (s.action.kind === 'connect-app') openAppsOn(s.action.appId)
    else if (s.action.kind === 'create-routine') void makeRoutinePrefill(s.action.request)
    else openBotSheet('description')
  }
  if (suggestions.length === 0) return null
  /** P3: il testo della riga lo costruisce la UI da action.kind (+ il nome
   * dell'app del catalogo), nella lingua dell'interfaccia — il modello puro
   * non porta più etichette fisse. */
  const labelOf = (s: BotSuggestion): string => {
    if (s.action.kind === 'connect-app') {
      // il nome come ESPRESSIONE del template: il segnaposto resta {0} (il
      // msgid condiviso con la UI di oggi) invece di uno nominato che il
      // catalogo non ha
      const { appId } = s.action
      return i18n.t(msg`Collega ${apps.find((a) => a.id === appId)?.name ?? ''}`)
    }
    return s.action.kind === 'create-routine'
      ? i18n.t(msg`Crea una routine`)
      : i18n.t(msg`Descrivi cosa fa questo bot`)
  }
  return (
    <div data-testid="bot-suggestions" className="mb-4 space-y-1.5">
      {suggestions.map((s) => {
        const Icon = SUGGESTION_ICON[s.icon] ?? Link2
        return (
          <div key={s.id} className="flex items-center gap-2 rounded-[14px] bg-muted/60 py-2 pl-3 pr-1.5" data-testid="bot-suggestion">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <button
              className="min-w-0 flex-1 truncate text-left text-sm transition hover:text-foreground"
              onClick={() => run(s)}
            >
              {labelOf(s)}
            </button>
            <button
              className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition hover:bg-muted hover:text-foreground"
              aria-label={i18n.t(msg`Ignora il suggerimento`)}
              title={i18n.t(msg`Ignora il suggerimento`)}
              data-testid="bot-suggestion-dismiss"
              onClick={() => dismiss(s.id)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ---- fase pagine (G3): la scheda Attività ----

/** Il giorno locale di un timestamp (per i gruppi della Libreria del bot). */
function dayKeyOf(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** La card del Computer: anteprima piccola dello schermo e stato; clic = la scheda di oggi (560 px). */
function ComputerCard({ agentId }: { agentId: string }) {
  const { i18n } = useLingui()
  const openBotTab = useStore((s) => s.openBotTab)
  const screenStatus = useStore((s) => s.screenStatus[agentId])
  const [status, setStatus] = useState<ScreenStatus | null>(null)
  useEffect(() => {
    let alive = true
    setStatus(null)
    void api.screenStatus(agentId).then((s) => { if (alive) setStatus(s) }).catch(() => undefined)
    return () => { alive = false }
  }, [agentId, screenStatus])
  const browser = status?.browser ?? screenStatus?.browser ?? 'stopped'
  // running e in uso → Acceso; running a riposo → In sospensione; spento → Spento
  const label = browser === 'running' ? (status?.held ?? screenStatus?.held) ? i18n.t(msg`Acceso`) : i18n.t(msg`In sospensione`) : i18n.t(msg`Spento`)
  const dot = browser === 'stopped' ? 'bg-muted-foreground/40' : (status?.held ?? screenStatus?.held) ? 'bg-chart-2' : 'bg-waiting'
  return (
    <button
      className="w-full overflow-hidden rounded-[16px] bg-muted/60 text-left transition hover:bg-muted"
      data-testid="bot-computer-card"
      onClick={() => openBotTab('computer')}
    >
      {/* l'anteprima piccola dello schermo: il riquadro del desktop del bot */}
      <span className="block h-24 w-full bg-black/85 px-3 pb-3 pt-2" aria-hidden="true">
        <span className="flex h-full flex-col justify-end gap-1.5 rounded-[8px] bg-white/5 p-2">
          <span className="h-1.5 w-3/5 rounded-full bg-white/20" />
          <span className="h-1.5 w-4/5 rounded-full bg-white/10" />
          <span className="h-1.5 w-2/5 rounded-full bg-white/10" />
        </span>
      </span>
      <span className="flex items-center gap-2 px-3 py-2">
        <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm"><Trans>Computer</Trans></span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="bot-computer-status">
          <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
          {label}
        </span>
      </span>
    </button>
  )
}

/** Attività (G3), dall'alto: Suggerimenti, Computer, le prossime 3 routine, i lavori di oggi. */
function ActivityTab({ agentId }: { agentId: string }) {
  const { i18n } = useLingui()
  const tasks = useStore((s) => s.tasks)
  const openTask = useStore((s) => s.openTask)
  const openBotSheet = useStore((s) => s.openBotSheet)
  const [routines, setRoutines] = useState<RoutineInfo[] | null>(null)
  useEffect(() => {
    let alive = true
    setRoutines(null)
    void api.listRoutines(agentId)
      .then((r) => { if (alive) setRoutines(r) })
      .catch(() => { if (alive) setRoutines([]) })
    return () => { alive = false }
  }, [agentId])
  const next3 = (routines ?? [])
    .filter((r) => r.enabled && r.next_run)
    .sort((a, b) => (a.next_run ?? 0) - (b.next_run ?? 0))
    .slice(0, 3)
  const today = dayKeyOf(Date.now())
  const todayTasks = tasks.filter((t) => t.agentId === agentId && dayKeyOf(t.createdAt) === today).slice(-5).reverse()
  return (
    <div>
      <SuggestionsBlock agentId={agentId} />
      <ComputerCard agentId={agentId} />
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-muted-foreground"><Trans>Routine</Trans></p>
          <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => openBotSheet('routines')}>
            <Trans>Tutte</Trans> ›
          </button>
        </div>
        {routines === null ? (
          <p className="mt-1 text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
        ) : next3.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground"><Trans>Nessuna routine in programma.</Trans></p>
        ) : (
          <div className="mt-1 space-y-1">
            {next3.map((r) => (
              <div key={r.id} className="rounded-[12px] px-2.5 py-1.5 text-sm transition hover:bg-muted/60">
                <p className="truncate">{r.title}</p>
                <p className="text-xs text-muted-foreground">
                  <Trans>prossima {formatDate(r.next_run!, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</Trans>
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4">
        <p className="text-[13px] text-muted-foreground"><Trans>Ultimi lavori</Trans></p>
        {todayTasks.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground"><Trans>Oggi ancora niente.</Trans></p>
        ) : (
          <div className="mt-1 space-y-1">
            {todayTasks.map((tk) => (
              <button
                key={tk.id}
                className="flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-sm transition hover:bg-muted/60"
                onClick={() => openTask(tk.id)}
              >
                <span className="min-w-0 flex-1 truncate">{tk.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{i18n.t(TASK_LABEL[tk.status] ?? msg`${tk.status}`)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- fase pagine (G3): la scheda Libreria del bot ----

/** Il filtro a pillola della Libreria del bot. */
type BotLibraryFilter = 'all' | 'pages' | 'media'

const FILTER_LABEL: Record<BotLibraryFilter, MessageDescriptor> = {
  all: msg`Tutti`,
  pages: msg`Pagine`,
  media: msg`Media`
}

/** Le due etichette fisse dei gruppi per giorno (poi la data formattata). */
const DAY_TODAY = msg`Oggi`
const DAY_YESTERDAY = msg`Ieri`

/** Le voci per giorno: «Oggi», «Ieri», poi la data. */
function dayGroups(items: LibraryItemInfo[]): Array<{ key: string; label: MessageDescriptor | string; items: LibraryItemInfo[] }> {
  const byDay = new Map<number, LibraryItemInfo[]>()
  for (const i of items) {
    const k = dayKeyOf(i.updatedAt)
    byDay.set(k, [...(byDay.get(k) ?? []), i])
  }
  const today = dayKeyOf(Date.now())
  const yesterday = dayKeyOf(Date.now() - 86_400_000)
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([k, its]) => ({
      key: String(k),
      label: k === today ? DAY_TODAY : k === yesterday ? DAY_YESTERDAY : formatDate(k),
      items: its.sort((a, b) => b.updatedAt - a.updatedAt)
    }))
}

/** La Libreria del bot: i suoi elementi (e dei suoi sottoagenti), per giorno. */
function BotLibraryTab({ agentId }: { agentId: string }) {
  const { i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const openPage = useStore((s) => s.openPage)
  const openLibrary = useStore((s) => s.openLibrary)
  const [items, setItems] = useState<LibraryItemInfo[] | null>(null)
  const [filter, setFilter] = useState<BotLibraryFilter>('all')
  const [more, setMore] = useState<Record<string, number>>({})
  useEffect(() => {
    let alive = true
    setItems(null)
    setMore({})
    void api.libraryList(undefined, undefined)
      .then((all) => { if (alive) setItems(all) })
      .catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [agentId])
  // i sottoagenti di questo bot firmano con il loro id: le loro voci stanno qui
  const authors = useMemo(() => new Set([agentId, ...agents.filter((a) => a.parentId === agentId).map((a) => a.id)]), [agents, agentId])
  const shown = useMemo(() => {
    const mine = (items ?? []).filter((i) => authors.has(i.authorAgentId))
    // Grafici dentro Tutti; Pagine = documenti; Media = file (immagini comprese)
    if (filter === 'pages') return mine.filter((i) => i.kind === 'document')
    if (filter === 'media') return mine.filter((i) => i.kind === 'file')
    return mine
  }, [items, authors, filter])
  const groups = useMemo(() => dayGroups(shown), [shown])
  const kindOf = (i: LibraryItemInfo): string =>
    i.kind === 'document' ? i18n.t(msg`Pagina`) : i.kind === 'chart' ? i18n.t(msg`Grafico`) : i18n.t(msg`File`)
  return (
    <div data-testid="bot-library">
      <div className="flex gap-1" data-testid="bot-library-filters">
        {(Object.keys(FILTER_LABEL) as BotLibraryFilter[]).map((f) => (
          <button
            key={f}
            className={`h-8 rounded-full px-3 text-sm transition ${filter === f ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => { setFilter(f); setMore({}) }}
          >
            {i18n.t(FILTER_LABEL[f])}
          </button>
        ))}
      </div>
      {items === null ? (
        <p className="mt-3 text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
      ) : shown.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          <Trans>Le pagine, i grafici e i file di questo bot finiscono qui.</Trans>
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((g) => {
            const limit = 5 + (more[g.key] ?? 0)
            const rows = g.items.slice(0, limit)
            return (
              <div key={g.key}>
                <p className="mb-1 text-[13px] text-muted-foreground">{typeof g.label === 'string' ? g.label : i18n.t(g.label)}</p>
                <div className="space-y-1">
                  {rows.map((i) => (
                    <button
                      key={i.id}
                      className="flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left text-sm transition hover:bg-muted/60"
                      onClick={() => (i.kind === 'document' ? openPage(i.id, 'chat') : openLibrary(i.id))}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {i.title}
                        {i.kind === 'document' && <span className="ml-1.5 text-xs text-muted-foreground">v{i.currentVersion}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{kindOf(i)}</span>
                    </button>
                  ))}
                  {g.items.length > limit && (
                    <button
                      className="w-full rounded-[12px] px-2.5 py-1 text-left text-xs text-muted-foreground transition hover:text-foreground"
                      onClick={() => setMore((m) => ({ ...m, [g.key]: (m[g.key] ?? 0) + 5 }))}
                    >
                      <Trans>Mostra altro</Trans>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- fase pagine (G3): il foglio «Impostazioni del bot» ----

/**
 * Il foglio con le sezioni di oggi — Profilo, Routine (elenco completo) e
 * Avanzate — che si apre cliccando il nome o la mascotte. focus: 'routines'
 * scorre alla sezione, 'description' mette a fuoco le Istruzioni (G4).
 */
function BotSettingsSheet({ agentId, avatar, onClose }: { agentId: string; avatar: AgentAvatar; onClose(): void }) {
  const { i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const focus = useStore((s) => s.botSheetFocus)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const name = agents.find((a) => a.id === agentId)?.name ?? ''
  useEffect(() => {
    if (!focus) return
    const t = setTimeout(() => {
      if (focus === 'routines') contentRef.current?.querySelector('[data-testid="bot-sheet-routines"]')?.scrollIntoView({ block: 'start' })
      else if (focus === 'description') {
        const el = contentRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="bot-instructions"]')
        el?.focus()
        el?.scrollIntoView({ block: 'center' })
      }
    }, 150)
    return () => clearTimeout(t)
  }, [focus])
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogTitle>{i18n.t(msg`Impostazioni del bot`)}</DialogTitle>
        <div ref={contentRef} className="max-h-[70vh] overflow-y-auto scroll-thin pr-1">
          <p className="mb-2 font-display text-lg">{name}</p>
          <section>
            <p className="mb-1 text-xs font-semibold text-muted-foreground"><Trans>Profilo</Trans></p>
            <ProfileTab onAvatar={() => setAvatarOpen(true)} />
          </section>
          <section data-testid="bot-sheet-routines" className="mt-4 scroll-mt-4">
            <p className="mb-1 text-xs font-semibold text-muted-foreground"><Trans>Routine</Trans></p>
            <RoutinesTab />
          </section>
          <section className="mt-4">
            <p className="mb-1 text-xs font-semibold text-muted-foreground"><Trans>Avanzate</Trans></p>
            <AdvancedTab />
          </section>
        </div>
        {avatarOpen && <ChangeAvatarDialog agentId={agentId} current={avatar} onClose={() => setAvatarOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/** Il pannello del bot: mascotte sospesa (clic = Impostazioni), schede, contenuto. */
function BotPanel({ layout, onClose }: { layout: LayoutResult; onClose(): void }) {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const info = useBotInfo(activeId)
  const computerPanel = useStore((s) => s.computerPanel)
  // fase 16b correzioni 2 (Q1): la scheda aperta vive nello store — è lei che
  // dice a layoutFor quanto dev'essere largo il pannello (Computer = wide)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const [tab, setTab] = useState<PanelTab>(() => {
    const t = useStore.getState().panelTab
    return t === 'members' ? 'activity' : t
  })
  const tabRequest = useStore((s) => s.botPanelTabRequest)
  const clearTabRequest = useStore((s) => s.clearBotPanelTabRequest)
  const botSheetOpen = useStore((s) => s.botSheetOpen)
  const openBotSheet = useStore((s) => s.openBotSheet)
  const closeBotSheet = useStore((s) => s.closeBotSheet)
  const asideRef = useRef<HTMLElement>(null)
  // G2 (fase 0.3.1001 grafica): aprendo, il focus va al primo controllo del
  // pannello (la ✕) — come già faceva l'overlay, anche quando è docked
  useEffect(() => {
    asideRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])
  // «Guarda lo schermo» delle card e la TakeoverCard aprono il pannello sulla
  // scheda Computer (S4); le Impostazioni › Bot aprono il foglio (Routine)
  useEffect(() => {
    if (computerPanel.open) setTab('computer')
  }, [computerPanel.open])
  useEffect(() => {
    if (tabRequest) {
      setTab(tabRequest === 'computer' ? 'computer' : 'activity')
      clearTabRequest()
    }
  }, [tabRequest, clearTabRequest])
  useEffect(() => {
    setPanelTab(tab)
  }, [tab, setPanelTab])
  if (!info) return null
  const overlay = layout.panel === 'overlay'
  return (
    <aside
      ref={asideRef}
      data-testid="bot-panel"
      className={
        overlay
          ? // Q1: il pannello galleggia sopra la chat — ombra morbida, nessun bordo
            'absolute bottom-0 right-0 top-0 z-10 flex flex-col bg-card shadow-soft'
          : 'relative flex shrink-0 flex-col border-l border-border/50 bg-card transition-[width]'
      }
      style={{ width: layout.panelWidth }}
    >
      <PanelTopBand onClose={onClose} />
      {/* la mascotte grande sospesa e il nome: UN bottone, apre le
          Impostazioni del bot (G3) */}
      <div className="flex flex-col items-center px-6 pt-14">
        <div className="flex flex-col items-center">
          <button
            className="flex flex-col items-center"
            data-testid="bot-settings-trigger"
            aria-label={i18n.t(msg`Impostazioni del bot`)}
            title={i18n.t(msg`Impostazioni del bot`)}
            onClick={() => openBotSheet()}
          >
            <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={110} dimmed={info.dimmed} label={info.agent.name} />
            <span aria-hidden="true" className="mt-1 h-2 w-16 rounded-full bg-foreground/10" />
            <h2 className="mt-3 font-display text-[26px] leading-tight">{info.agent.name}</h2>
          </button>
        </div>
        {/* fase pagine (G3): le due schede — Attività · Libreria */}
        <div role="tablist" className="mt-3 flex gap-1">
          {(Object.keys(TAB_LABEL) as Array<'activity' | 'library'>).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              data-testid={`bot-tab-${id}`}
              className={`h-8 rounded-full px-3 text-sm transition ${tab === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab(id)}
            >
              {i18n.t(TAB_LABEL[id])}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin px-5 pb-5 pt-4">
        {tab === 'activity' && activeId && <ActivityTab agentId={activeId} />}
        {tab === 'library' && activeId && <BotLibraryTab agentId={activeId} />}
        {tab === 'computer' && activeId && (
          <ComputerPanel agentId={activeId} onClose={() => setTab('activity')} embedded />
        )}
      </div>
      {botSheetOpen && activeId && <BotSettingsSheet agentId={activeId} avatar={info.avatar} onClose={closeBotSheet} />}
    </aside>
  )
}

/** Il pannello della SQUADRA: Membri (S4). */
function MembersPanel({ layout, group, onClose }: { layout: LayoutResult; group: GroupInfo; onClose(): void }) {
  const { i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const groupUpdate = useStore((s) => s.groupUpdate)
  const groupDelete = useStore((s) => s.groupDelete)
  const [description, setDescription] = useState(group.description)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  // G2 (fase 0.3.1001 grafica): anche il pannello dei membri docked prende il
  // focus sul primo controllo all'apertura, come l'overlay
  useEffect(() => {
    asideRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])
  useEffect(() => setDescription(group.description), [group.id, group.description])
  const memberAgent = (id: string): Agent | undefined => agents.find((a) => a.id === id)
  const notIn = agents.filter((a) => !a.parentId && !group.members.some((m) => m.agentId === a.id))
  const overlay = layout.panel === 'overlay'
  return (
    <aside
      ref={asideRef}
      className={
        overlay
          ? 'absolute bottom-0 right-0 top-0 z-10 flex flex-col bg-card shadow-soft'
          : 'relative flex shrink-0 flex-col border-l border-border/50 bg-card transition-[width]'
      }
      style={{ width: layout.panelWidth }}
    >
      <PanelTopBand onClose={onClose} />
      <div className="flex-1 overflow-y-auto scroll-thin px-5 pb-5 pt-14">
        <h2 className="font-display text-[22px]">{group.name}</h2>
        <p className="mt-3 text-[13px] text-muted-foreground"><Trans>Membri</Trans></p>
        <div className="mt-1 space-y-1">
          {group.members.map((m) => {
            const a = memberAgent(m.agentId)
            const coord = m.agentId === group.coordinatorId
            return (
              <div key={m.agentId} className="flex items-center gap-2.5 rounded-[14px] px-2 py-1.5 text-sm transition hover:bg-muted/60">
                <span className="min-w-0 flex-1 truncate">
                  {m.name}
                  {coord && <span className="ml-1.5 text-xs text-muted-foreground">· <Trans>coordinatore</Trans></span>}
                </span>
                {group.members.length > 1 && !coord && (
                  <button
                    className="shrink-0 text-xs text-muted-foreground transition hover:text-destructive"
                    onClick={() => { setBusy(true); void groupUpdate(group.id, { removeMemberIds: [m.agentId] }).finally(() => setBusy(false)) }}
                  >
                    <Trans>Togli</Trans>
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <p className="mb-1 mt-4 text-[13px] text-muted-foreground"><Trans>Chi risponde</Trans></p>
        <select
          className="w-full rounded-[10px] bg-muted px-2.5 py-2 text-sm outline-none"
          value={group.coordinatorId ?? ''}
          disabled={busy}
          aria-label={i18n.t(msg`Coordinatore`)}
          onChange={(e) => { setBusy(true); void groupUpdate(group.id, { coordinatorId: e.target.value }).finally(() => setBusy(false)) }}
        >
          {group.members.map((m) => (
            <option key={m.agentId} value={m.agentId}>{m.name}</option>
          ))}
        </select>
        {notIn.length > 0 && group.members.length < 6 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-border py-2 text-xs text-muted-foreground transition hover:text-foreground">
              <Plus className="size-3.5" /> <Trans>Aggiungi un bot</Trans>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {notIn.map((a) => (
                <DropdownMenuItem key={a.id} onClick={() => { setBusy(true); void groupUpdate(group.id, { addMemberIds: [a.id] }).finally(() => setBusy(false)) }}>
                  {a.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <p className="mb-1 mt-4 text-[13px] text-muted-foreground"><Trans>Descrizione</Trans></p>
        <textarea
          className="min-h-20 w-full rounded-[12px] bg-muted px-3 py-2 text-sm outline-none"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => { if (description !== group.description) void groupUpdate(group.id, { description }) }}
        />
        {confirmDelete ? (
          <div className="mt-6 space-y-1.5">
            <p className="text-xs text-destructive"><Trans>Eliminare la squadra «{group.name}» e i suoi messaggi? I bot restano.</Trans></p>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-[12px] bg-destructive/10 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/20"
                onClick={() => void groupDelete(group.id)}
              >
                <Trans>Elimina squadra</Trans>
              </button>
              <button className="flex-1 rounded-[12px] bg-muted px-3 py-2 text-sm transition hover:bg-accent" onClick={() => setConfirmDelete(false)}>
                <Trans>Annulla</Trans>
              </button>
            </div>
          </div>
        ) : (
          <button className="mt-6 w-full rounded-[12px] bg-muted px-3 py-2 text-sm text-muted-foreground transition hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trans>Elimina squadra</Trans>
          </button>
        )}
      </div>
    </aside>
  )
}

export function RightPanel({ layout }: { layout: LayoutResult }) {
  const rightPanel = useStore((s) => s.rightPanel)
  const setRightPanel = useStore((s) => s.setRightPanel)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const closeBotSheet = useStore((s) => s.closeBotSheet)
  const openGroupId = useStore((s) => s.openGroupId)
  const groups = useStore((s) => s.groups)
  // fase 16b correzioni 2 (Q1): chiudere torna alla prima scheda, così
  // layoutFor non resta sul wide del Computer
  // G2 (fase 0.3.1001 grafica): il focus torna al bottone PanelRight della
  // fascia alta, che con la chiusura ricompare (✕, Esc e velo passano qui)
  const close = (): void => {
    setPanelTab('activity')
    closeBotSheet()
    setRightPanel(false)
    useStore.getState().requestPanelFocusRestore()
  }
  // il pannello in overlay si chiude anche con Esc (con la ✕ e col clic fuori
  // ci sono già); se un altro gestore ha già consumato l'Esc (menu,
  // autocompletamento @, pagina aperta) qui non si fa niente
  useEffect(() => {
    if (layout.panel !== 'overlay') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.panel, setRightPanel, setPanelTab])
  if (!rightPanel) return null
  const group = groups.find((g) => g.id === openGroupId)
  const body = group ? (
    <MembersPanel layout={layout} group={group} onClose={close} />
  ) : (
    <BotPanel layout={layout} onClose={close} />
  )
  // M6 (fase 0.3.1001): l'overlay è un VERO foglio sovrapposto — velo visibile
  // sulla chat (niente testo leggibile coperto a metà), Esc e clic sul velo
  // chiudono, il focus resta dentro il pannello, aria-modal
  if (layout.panel === 'overlay') {
    return <OverlaySheet onClose={close}>{body}</OverlaySheet>
  }
  return body
}

/**
 * M6: il foglio sovrapposto del pannello. Velo che oscura la chat sottostante,
 * dialogo aria-modal, focus intrappolato dentro (Tab si ricicla) e primo
 * controllo messo a fuoco all'apertura.
 */
function OverlaySheet({ onClose, children }: { onClose(): void; children: React.ReactNode }) {
  const { i18n } = useLingui()
  const rootRef = useRef<HTMLDivElement>(null)
  // all'apertura il focus ENTRA nel foglio (il bottone ✕ del pannello)
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>('button')
    first?.focus()
  }, [])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || !rootRef.current) return
    const focusables = Array.from(
      rootRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null)
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t(msg`Pannello del bot`)}
      className="absolute inset-0 z-40"
      onKeyDown={onKeyDown}
    >
      <div className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px]" aria-hidden="true" onClick={onClose} />
      {children}
    </div>
  )
}
