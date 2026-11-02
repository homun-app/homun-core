// Pannello destro (fase 16b, S4): il pannello del BOT a schede —
// Profilo · Computer · Routine · Avanzate. In cima la mascotte grande SOSPESA
// (niente riquadro, solo l'ombra ovale sotto) e il nome in font-display; le
// schede sono testo, la selezionata su pillola bg-muted. Con la scheda
// Computer il pannello si allarga a 560 px (uno schermo utilizzabile) e torna
// alla larghezza normale sulle altre. Con una SQUADRA aperta il pannello
// mostra «Membri»: elenco, coordinatore, aggiungi/togli, descrizione,
// eliminazione. La Libreria è uscita dal pannello (16c la farà globale).
// correzioni 2 (Q1): la larghezza la decide layoutFor — quando la chat non
// può restare ≥ CHAT_MIN il pannello galleggia in OVERLAY sopra di essa
// (ombra morbida, nessun bordo, si chiude con Esc, con la ✕ o clicando
// fuori) invece di tagliarsi oltre il bordo della finestra.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { formatDate } from '../lib/i18n'
import { X, Plus } from 'lucide-react'
import { api, useStore } from '../store'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import type { GroupInfo, LibraryItemInfo, ModelInfo, RoutineInfo, ThinkingSetting, Agent } from '../../../shared/types'
import { ChangeAvatarDialog } from './BotDialogs'
// fase 16b correzioni 2 (Q1): il risultato di layoutFor
import type { LayoutResult } from '../layout'
// fase 19b (T1) → fase 16b (S4): il pannello «Computer» vive QUI come scheda
import { ComputerPanel } from './ComputerPanel'
import { ModelPicker, THINKING_LABELS } from './ui/ModelPicker'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

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

type PanelTab = 'profile' | 'computer' | 'routines' | 'advanced'

const TAB_LABEL: Record<PanelTab, MessageDescriptor> = {
  profile: msg`Profilo`,
  computer: msg`Computer`,
  routines: msg`Routine`,
  advanced: msg`Avanzate`
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

/** Titoletto piccolo e grigio delle sezioni di Avanzate (mockup 7). */
function SmallTitle({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-4 text-xs font-semibold text-muted-foreground">{children}</p>
}

/** Profilo: descrizione, righe chiave/valore, Cambia aspetto, Ultimi lavori. */
function ProfileTab({ onAvatar }: { onAvatar(): void }) {
  const { i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const groups = useStore((s) => s.groups)
  const tasks = useStore((s) => s.tasks)
  const openTask = useStore((s) => s.openTask)
  const setMemoryOpen = useStore((s) => s.setMemoryOpen)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  const [memories, setMemories] = useState<number | null>(null)
  const [skills, setSkills] = useState<number | null>(null)
  const agent = agents.find((a) => a.id === activeId)
  useEffect(() => {
    setMemories(null)
    setSkills(null)
    if (!activeId) return
    void api.listMemories(activeId).then((m) => setMemories(m.length)).catch(() => setMemories(0))
    void api.listSkills(activeId).then((s) => setSkills(s.length)).catch(() => setSkills(0))
  }, [activeId])
  if (!agent) return null
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const coordinates = groups.filter((g) => g.coordinatorId === agent.id)
  const recent = tasks.filter((tk) => tk.agentId === agent.id).slice(-5).reverse()
  return (
    <div className="space-y-2">
      <p className="text-sm leading-relaxed text-foreground/80">{agent.description || <Trans>Nessuna descrizione.</Trans>}</p>
      <div className="mt-2">
        <KvRow label={i18n.t(msg`Modello`)}>
          {agent.providerId ? `${agent.providerId} · ${agent.model ?? ''}` : <span className="text-muted-foreground"><Trans>da scegliere</Trans></span>}
        </KvRow>
        <KvRow label={i18n.t(msg`Memoria`)}>
          <button className="transition hover:text-foreground" onClick={() => { setMemoryOpen(true); setSkillsOpen(false) }}>
            <Trans>{memories === null ? '…' : `${memories} note`} ›</Trans>
          </button>
        </KvRow>
        <KvRow label={i18n.t(msg`Skill`)}>
          <button className="transition hover:text-foreground" onClick={() => { setSkillsOpen(true); setMemoryOpen(false) }}>
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
  const mainAgentId = useStore((s) => s.mainAgentId)
  const setMainAgent = useStore((s) => s.setMainAgent)
  const agent = agents.find((a) => a.id === activeId)
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})
  const [notifOff, setNotifOff] = useState<boolean | null>(null)
  const [section, setSection] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => {
    setConfirmDelete(false)
    setSection(agent?.section ?? '')
    setNotifOff(null)
    void api.settingsGet<string[]>('notifications.disabledAgents', []).then((v) => setNotifOff(v.includes(activeId ?? ''))).catch(() => setNotifOff(false))
  }, [activeId, agent?.section])
  useEffect(() => {
    for (const p of providers) {
      if (!models[p.id]) {
        api.listModels(p.id).then((ms: ModelInfo[]) => setModels((prev) => ({ ...prev, [p.id]: ms }))).catch(() => undefined)
      }
    }
  }, [providers, models])
  if (!agent) return null
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const chosen = (models[agent.providerId ?? ''] ?? []).find((m) => m.id === agent.model)
  const levels = chosen?.thinkingLevels ?? []
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
      <div className="flex gap-2">
        <select
          className="min-w-0 flex-1 rounded-[10px] bg-muted px-2.5 py-2 text-sm outline-none"
          value={agent.providerId ?? ''}
          onChange={(e) => patch({ providerId: e.target.value || null, model: null })}
          aria-label={t`Provider`}
        >
          <option value="">{t`— provider —`}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="min-w-0 flex-1">
          <ModelPicker
            models={models[agent.providerId ?? ''] ?? []}
            value={agent.model}
            placeholder={t`— modello —`}
            disabled={!agent.providerId}
            onChange={(m) => patch({ model: m })}
          />
        </div>
      </div>
      {levels.length > 0 && (
        <select
          className="mt-2 w-full rounded-[10px] bg-muted px-2.5 py-2 text-sm outline-none"
          value={levels.includes((agent.thinking ?? 'default') as ThinkingSetting) ? agent.thinking ?? 'default' : 'default'}
          onChange={(e) => patch({ thinking: e.target.value as ThinkingSetting })}
          aria-label={t`Ragionamento`}
        >
          {(['default', ...levels] as ThinkingSetting[]).map((l) => (
            <option key={l} value={l}>{i18n.t(THINKING_LABELS[l] ?? msg`${l}`)}</option>
          ))}
        </select>
      )}

      <SmallTitle><Trans>Istruzioni</Trans></SmallTitle>
      <textarea
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

/** Il pannello del bot: mascotte sospesa, schede, contenuto. */
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
    return t === 'members' ? 'profile' : t
  })
  const [avatarOpen, setAvatarOpen] = useState(false)
  const tabRequest = useStore((s) => s.botPanelTabRequest)
  const clearTabRequest = useStore((s) => s.clearBotPanelTabRequest)
  // «Guarda lo schermo» delle card e la TakeoverCard aprono il pannello sulla
  // scheda Computer (S4); le Impostazioni › Bot rimandano ad Avanzate
  useEffect(() => {
    if (computerPanel.open) setTab('computer')
  }, [computerPanel.open])
  useEffect(() => {
    if (tabRequest) {
      setTab(tabRequest)
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
      className={
        overlay
          ? // Q1: il pannello galleggia sopra la chat — ombra morbida, nessun bordo
            'absolute bottom-0 right-0 top-0 z-10 flex flex-col bg-card shadow-soft'
          : 'relative flex shrink-0 flex-col border-l border-border/50 bg-card transition-[width]'
      }
      style={{ width: layout.panelWidth }}
    >
      <PanelTopBand onClose={onClose} />
      {/* la mascotte grande sospesa: niente riquadro, solo l'ombra ovale */}
      <div className="flex flex-col items-center px-6 pt-14">
        <div className="flex flex-col items-center">
          <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={110} dimmed={info.dimmed} label={info.agent.name} />
          <span aria-hidden="true" className="mt-1 h-2 w-16 rounded-full bg-foreground/10" />
        </div>
        <h2 className="mt-3 font-display text-[26px] leading-tight">{info.agent.name}</h2>
        {/* fase 16b correzioni (P5): le quattro pillole stanno dentro i 340 px
            del pannello (292 utilizzabili col padding interno) — testo 14 px e
            padding 8 px: misurate 288 px sul font Figtree, senza scorrimento */}
        <div role="tablist" className="mt-3 flex gap-1">
          {(Object.keys(TAB_LABEL) as PanelTab[]).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`h-8 rounded-full px-2 text-sm transition ${tab === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab(id)}
            >
              {i18n.t(TAB_LABEL[id])}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin px-5 pb-5 pt-4">
        {tab === 'profile' && <ProfileTab onAvatar={() => setAvatarOpen(true)} />}
        {tab === 'computer' && activeId && (
          <ComputerPanel agentId={activeId} onClose={() => setTab('profile')} embedded />
        )}
        {tab === 'routines' && <RoutinesTab />}
        {tab === 'advanced' && <AdvancedTab />}
      </div>
      {avatarOpen && activeId && (
        <ChangeAvatarDialog agentId={activeId} current={info.avatar} onClose={() => setAvatarOpen(false)} />
      )}
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
  useEffect(() => setDescription(group.description), [group.id, group.description])
  const memberAgent = (id: string): Agent | undefined => agents.find((a) => a.id === id)
  const notIn = agents.filter((a) => !a.parentId && !group.members.some((m) => m.agentId === a.id))
  const overlay = layout.panel === 'overlay'
  return (
    <aside
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
  const openGroupId = useStore((s) => s.openGroupId)
  const groups = useStore((s) => s.groups)
  // fase 16b correzioni 2 (Q1): chiudere torna alla scheda Profilo, come
  // quando il pannello si riapre — così layoutFor non resta sul wide
  const close = (): void => {
    setPanelTab('profile')
    setRightPanel(false)
  }
  // il pannello in overlay si chiude anche con Esc (con la ✕ e col clic fuori
  // ci sono già); se un altro gestore ha già consumato l'Esc (menu,
  // autocompletamento @) qui non si fa niente
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
  // Q1: quando galleggia, un velo invisibile copre il resto della finestra —
  // un clic fuori chiude il pannello; la chat lì sotto resta larga tutto lo
  // spazio (il pannello non la spinge)
  if (layout.panel === 'overlay') {
    return (
      <div className="absolute inset-0 z-40">
        <div className="absolute inset-0" aria-hidden="true" onClick={close} />
        {body}
      </div>
    )
  }
  return body
}
