// Sidebar (fase 16b, S2): «chi ti risponde». Regola: chi ti risponde sta in
// fila; chi lavora per lui sta sotto, rientrato e più piccolo. In alto solo
// Cerca e Crea; il principale; le SQUADRE (una riga col grappolo del
// coordinatore, i membri si aprono con ▸/▾ e restano rientrati); i BOT
// singoli con le sezioni come titoletti; Libreria; in basso te e il bottone
// App. Niente bordi: le superfici si distinguono coi fondi (bg-muted per la
// selezione, angoli 14 px), i divisori tra le colonne restano sottili.
// STRETTA (76 px): trascinando il bordo destro sotto i 200 px o con ⌘\ —
// solo mascotte nello stesso ordine, contatore nero per chi ti aspetta,
// tooltip e aria-label «Nome, stato». La scelta si ricorda (localStorage).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Plus, Search, Library as LibraryIcon, LayoutGrid, ChevronRight } from 'lucide-react'
import { useStore } from '../store'
import { buildSidebarModel, collapsedVoices, teamOpenState, type SidebarModel, type SidebarTeam, type SidebarBot, type CollapsedVoice } from '../sidebar-utils'
import { avatarOf } from '../../../shared/avatar'
import type { Agent } from '../../../shared/types'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
// fase 16b (S3.3): la mezza riga d'attività dello stato breve dei membri
import { activityPhrase } from '../lib/activity'
import { i18n } from '../lib/i18n'
import type { UiTheme } from '../theme'
import { NewBotDialog, NewTeamDialog } from './BotDialogs'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuRadioGroup, DropdownMenuRadioItem
} from './ui/dropdown-menu'

/** La larghezza sotto cui la barra diventa STRETTA (S2). */
export const SIDEBAR_COLLAPSE_BELOW = 200
const WIDTH_KEY = 'sandbot:sidebar.width'
const COLLAPSED_KEY = 'sandbot:sidebar.collapsed'
const TEAM_OPEN_PREFIX = 'sandbot:sidebar.teamOpen.'

const readLS = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeLS = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage non disponibile: la scelta dura finché la finestra vive
  }
}
/** fase 16b correzioni (P3): riaprire una squadra cancella il ricordo della chiusura */
const removeLS = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    // come sopra: la scelta dura finché la finestra vive
  }
}

/** Titoletto semplice e grigio, niente maiuscole (S2). */
function Title({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pb-1 pt-3 text-[13px] text-muted-foreground">{children}</p>
}

/**
 * Il grappolo della squadra: la mascotte del coordinatore + i membri piccoli.
 * Nella barra LARGA i cerchietti sporgono a destra (c'è il testo accanto);
 * con narrow (fase 16b correzioni, P3) le stesse misure stanno in un BOX di
 * 40×40 — coordinatore davanti, cerchietti dei membri in basso a destra
 * sovrapposti alla mascotte ma DENTRO il box: la voce occupa la sua altezza
 * e non tocca la voce sotto.
 */
function TeamCluster({ team, size = 34, narrow = false }: { team: SidebarTeam; size?: number; narrow?: boolean }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const coordInfo = useBotInfo(team.coordinator?.id ?? null)
  // nel box da 40 px della barra stretta ci stanno due cerchietti e il +N;
  // nella barra larga i cerchietti sono tre (e possono sporgere a destra)
  const dots = team.members.slice(0, narrow ? 2 : 3)
  const extra = team.members.length - dots.length
  return (
    <span
      className="relative block shrink-0"
      style={narrow ? { width: 40, height: 40 } : { width: size + 8, height: size + 8 }}
    >
      {coordInfo ? (
        <span className="absolute left-0 top-0">
          <Bot family={coordInfo.avatar.family} color={coordInfo.avatar.color} state={coordInfo.state} size={size} track={false} dimmed={coordInfo.dimmed} />
        </span>
      ) : (
        <span className="absolute left-0 top-0 grid place-items-center rounded-full bg-muted" style={{ width: size, height: size }}>
          <span className="text-xs text-muted-foreground">{team.group.name.slice(0, 1)}</span>
        </span>
      )}
      <span className={`absolute bottom-0 right-0 flex items-center ${narrow ? '' : 'translate-x-[6px]'}`}>
        {dots.map((m, i) => {
          const av = avatarOf(m, agents, effectiveMain)
          return (
            <span
              key={m.id}
              className="size-3.5 rounded-full ring-2 ring-card"
              style={{ background: `var(--bot-${av.color})`, marginLeft: i === 0 ? 0 : -4 }}
            />
          )
        })}
        {extra > 0 && (
          <span className="ml-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-muted text-[9px] text-muted-foreground ring-2 ring-card">
            +{extra}
          </span>
        )}
      </span>
    </span>
  )
}

/** La riga del bot PRINCIPALE: mascotte 40 px, nome in grassetto, stato. */
function MainRow({ agent }: { agent: Agent }) {
  const { i18n } = useLingui()
  const info = useBotInfo(agent.id)
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const previews = useStore((s) => s.previews)
  if (!info) return null
  const preview = previews[agent.id] || info.statusText
  return (
    <button
      onClick={() => void select(agent.id)}
      className={`flex w-full items-center gap-3 rounded-[14px] px-2.5 py-2 text-left transition ${
        agent.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60'
      }`}
    >
      <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={40} track={false} dimmed={info.dimmed} label={agent.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold leading-tight">{agent.name}</span>
        <span className="block truncate text-[13px] text-muted-foreground">
          {typeof preview === 'string' ? preview : i18n.t(preview)}
        </span>
      </span>
      {agent.unread > 0 && <span className="size-2 shrink-0 rounded-full bg-foreground" aria-label={i18n.t(msg`non letto`)} />}
    </button>
  )
}

/** La riga UNA della squadra + i membri aperti, rientrati (S2). */
function TeamRows({ team }: { team: SidebarTeam }) {
  const { i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const openGroupId = useStore((s) => s.openGroupId)
  const openGroup = useStore((s) => s.openGroup)
  const select = useStore((s) => s.select)
  const coordInfo = useBotInfo(team.coordinator?.id ?? null)
  // fase 16b correzioni (P3): le squadre sono APERTE di default — si ricorda
  // solo la chiusura scelta dall'utente ('0'), riaprire cancella il ricordo
  const [open, setOpen] = useState(() => teamOpenState(readLS(`${TEAM_OPEN_PREFIX}${team.group.id}`)))
  // lo stato più importante: chi ti aspetta vince; poi il coordinatore al lavoro
  const waitingMember = [team.coordinator, ...team.members].find((a) => a && a.status === 'paused-for-approval')
  const coordBusy = coordInfo?.state === 'thinking' || coordInfo?.state === 'speaking' || coordInfo?.state === 'listening'
  const sub = waitingMember
    ? { cls: 'text-waiting font-semibold', text: i18n.t(msg`${waitingMember.name} ti aspetta`) }
    : coordBusy && team.coordinator
      ? { cls: 'text-muted-foreground', text: i18n.t(msg`${team.coordinator.name} scrive…`) }
      : {
          cls: 'text-muted-foreground',
          text: team.coordinator ? i18n.t(msg`Risponde ${team.coordinator.name}`) : i18n.t(msg`solo tu`)
        }
  return (
    <div>
      <div className={`flex items-center gap-2 rounded-[14px] pl-2 pr-1.5 text-left transition ${openGroupId === team.group.id ? 'bg-muted' : 'hover:bg-muted/60'}`}>
        <button
          className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
          onClick={() => openGroup(team.group.id)}
          title={team.group.description}
        >
          <TeamCluster team={team} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold leading-tight">{team.group.name}</span>
            <span className={`block truncate text-[13px] ${sub.cls}`}>{sub.text}</span>
          </span>
        </button>
        {team.members.length > 0 && (
          <button
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-expanded={open}
            aria-label={open ? i18n.t(msg`Chiudi i membri di ${team.group.name}`) : i18n.t(msg`Apri i membri di ${team.group.name}`)}
            onClick={() => {
              const next = !open
              setOpen(next)
              const key = `${TEAM_OPEN_PREFIX}${team.group.id}`
              if (next) removeLS(key)
              else writeLS(key, '0')
            }}
          >
            <ChevronRight className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col pl-7">
          {team.members.map((m) => (
            <MemberRow key={m.id} member={m} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Un membro della squadra, rientrato: mascotte 22 px, nome e stato breve. */
function MemberRow({ member }: { member: Agent }) {
  const info = useBotInfo(member.id)
  const activity = useStore((s) => s.activity[member.id])
  const openGroup = useStore((s) => s.openGroup)
  const select = useStore((s) => s.select)
  if (!info) return null
  const d: MessageDescriptor = (() => {
    switch (info.state) {
      case 'waiting':
        return msg`ti aspetta`
      case 'thinking':
        return msg`pensa…`
      case 'speaking':
        return msg`scrive…`
      case 'listening':
        return activityPhrase(activity)
      case 'happy':
        return msg`ha finito`
      default:
        return msg`fermo`
    }
  })()
  return (
    <button
      className="flex items-center gap-2.5 rounded-[14px] px-2 py-1.5 text-left transition hover:bg-muted/60"
      onClick={() => { openGroup(null); void select(member.id) }}
    >
      <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={22} track={false} dimmed={info.dimmed} />
      <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
      <span className={`shrink-0 text-xs ${info.state === 'waiting' ? 'text-waiting font-semibold' : 'text-muted-foreground'}`}>{i18n.t(d)}</span>
    </button>
  )
}

/** Un bot singolo: mascotte 36 px, nome e anteprima, senza bordi (S2). */
function BotRow({ bot }: { bot: SidebarBot }) {
  const { i18n } = useLingui()
  const info = useBotInfo(bot.agent.id)
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const previews = useStore((s) => s.previews)
  if (!info) return null
  const preview = previews[bot.agent.id] || info.statusText
  return (
    <button
      onClick={() => void select(bot.agent.id)}
      className={`flex w-full items-center gap-3 rounded-[14px] px-2.5 py-2 text-left transition ${
        bot.agent.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60'
      }`}
    >
      <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={36} track={false} dimmed={info.dimmed} label={bot.agent.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] leading-tight">{bot.agent.name}</span>
        <span className="block truncate text-[13px] text-muted-foreground">
          {typeof preview === 'string' ? preview : i18n.t(preview)}
        </span>
      </span>
      {bot.agent.unread > 0 && <span className="size-2 shrink-0 rounded-full bg-foreground" aria-label={i18n.t(msg`non letto`)} />}
    </button>
  )
}

/** La mascotte di una voce della barra stretta (hook nel componente, non in map). */
function VoiceMascot({ agentId, size }: { agentId: string; size: number }) {
  const info = useBotInfo(agentId)
  if (!info) return <span className="block rounded-full bg-muted" style={{ width: size, height: size }} />
  return <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={size} track={false} dimmed={info.dimmed} />
}

/** Il menu account di oggi, adattato: te + Tema/Impostazioni/Connetti app. */
function AccountMenu() {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const main = agents.find((a) => a.id === effectiveMain)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[14px] px-1.5 py-1.5 text-left transition hover:bg-muted/60 focus:outline-none">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-foreground">
          {main ? main.name.slice(0, 1).toUpperCase() : '·'}
        </span>
        <span className="min-w-0 text-sm">
          <span className="block truncate font-medium leading-tight">{main ? main.name : t`nessun bot`}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {main ? (main.model ? `${main.providerId ?? ''} · ${main.model}` : t`nessun modello`) : t`nessun bot`}
          </span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuItem onClick={() => { setSettingsTab('connettori'); setSettingsOpen(true) }}><Trans>Connetti app</Trans></DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setSettingsTab(null); setSettingsOpen(true) }}><Trans>Impostazioni</Trans></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Trans>Tema</Trans></DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as UiTheme)}>
              <DropdownMenuRadioItem value="system"><Trans>Sistema</Trans></DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light"><Trans>Chiaro</Trans></DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Trans>Scuro</Trans></DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** La barra STRETTA: solo mascotte nello stesso ordine, contatore e tooltip. */
function CollapsedColumn({ model, onExpand }: { model: SidebarModel; onExpand(): void }) {
  const { i18n } = useLingui()
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const openGroup = useStore((s) => s.openGroup)
  const openLibraryId = useStore((s) => s.openLibraryId)
  const openLibrary = useStore((s) => s.openLibrary)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const agents = useStore((s) => s.agents)
  const voices = collapsedVoices(model)
  const statusLabel = (st: CollapsedVoice['status']): string =>
    st === 'waiting' ? i18n.t(msg`ti aspetta`) : st === 'busy' ? i18n.t(msg`sta lavorando`) : i18n.t(msg`fermo`)
  let separated = false
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto scroll-thin px-2 pt-10">
      {voices.map((v) => {
        const newSection = v.kind !== 'main' && !separated
        if (newSection) separated = true
        return (
          <div key={v.key} className="contents">
            {newSection && <span className="my-1 h-px w-6 shrink-0 bg-border/60" aria-hidden="true" />}
            <button
              className="relative my-0.5 shrink-0"
              aria-label={`${v.name}, ${statusLabel(v.status)}`}
              title={`${v.name}, ${statusLabel(v.status)}`}
              onClick={() => {
                const team = model.teams.find((t) => `g${t.group.id}` === v.key)
                if (team) openGroup(team.group.id)
                else {
                  const agent = [model.main, ...model.bots.map((b) => b.agent)].find((a) => a?.id === v.key)
                  if (agent) { openGroup(null); void select(agent.id) }
                }
              }}
            >
              {v.kind === 'team' ? (
                <TeamCluster team={model.teams.find((t) => `g${t.group.id}` === v.key)!} narrow />
              ) : (
                <VoiceMascot agentId={v.key} size={v.kind === 'main' ? 42 : 34} />
              )}
              {v.counter > 0 && (
                <span className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground px-1 text-[11px] font-bold text-background">
                  {v.counter}
                </span>
              )}
            </button>
          </div>
        )
      })}
      <span className="my-1 h-px w-6 shrink-0 bg-border/60" aria-hidden="true" />
      <button
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label={i18n.t(msg`Libreria`)}
        title={i18n.t(msg`Libreria`)}
        onClick={() => (openLibraryId === null ? openLibrary('') : openLibrary(null))}
      >
        <LibraryIcon className="size-4" />
      </button>
      <div className="flex-1" />
      <button
        className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
        aria-label={i18n.t(msg`App`)}
        title={i18n.t(msg`App`)}
        onClick={() => { setSettingsTab('connettori'); setSettingsOpen(true) }}
      >
        <LayoutGrid className="size-4" />
      </button>
      <button
        className="mb-3 mt-1 grid size-9 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-foreground"
        aria-label={i18n.t(msg`Allarga la barra`)}
        title={i18n.t(msg`Allarga la barra (⌘\\)`)}
        onClick={onExpand}
      >
        {model.main ? model.main.name.slice(0, 1).toUpperCase() : '·'}
      </button>
    </div>
  )
}

export function Sidebar() {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const groups = useStore((s) => s.groups)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const openLibraryId = useStore((s) => s.openLibraryId)
  const openLibrary = useStore((s) => s.openLibrary)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [newTeamOpen, setNewTeamOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => readLS(COLLAPSED_KEY) === '1')
  const [width, setWidth] = useState(() => {
    const v = Number(readLS(WIDTH_KEY))
    return Number.isFinite(v) && v >= 220 && v <= 420 ? v : 264
  })
  const dragging = useRef(false)

  // ⌘\ apre/chiude la barra stretta; la scelta si ricorda
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault()
        setCollapsed((v) => {
          writeLS(COLLAPSED_KEY, v ? '0' : '1')
          return !v
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // trascinamento del bordo destro: sotto i 200 px la barra diventa stretta
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = width
    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      const next = startWidth + (ev.clientX - startX)
      if (next < SIDEBAR_COLLAPSE_BELOW) {
        setCollapsed(true)
        writeLS(COLLAPSED_KEY, '1')
      } else {
        setCollapsed(false)
        writeLS(COLLAPSED_KEY, '0')
        const clamped = Math.min(420, Math.max(220, next))
        setWidth(clamped)
        writeLS(WIDTH_KEY, String(clamped))
      }
    }
    const onUp = (): void => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const model = buildSidebarModel(agents, groups, mainAgentId, query)
  const noSection = model.bots.filter((b) => !b.section)
  const sections = [...new Set(model.bots.map((b) => b.section).filter((s): s is string => !!s))]

  return (
    <aside
      className="relative flex shrink-0 select-none flex-col border-r border-border/50 bg-card"
      style={{ width: collapsed ? 76 : width }}
    >
      {/* il bordo trascinabile */}
      {!collapsed && <div className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize" onMouseDown={startDrag} aria-hidden="true" />}

      {collapsed ? (
        <CollapsedColumn
          model={model}
          onExpand={() => {
            setCollapsed(false)
            writeLS(COLLAPSED_KEY, '0')
          }}
        />
      ) : (
        <>
          {/* in alto: solo Cerca e Crea (pt-10 per i traffic lights) */}
          <div className="flex items-center justify-end gap-2 px-3 pt-10 pb-1.5">
            <button
              className={`grid size-9 place-items-center rounded-full transition ${searchOpen ? 'bg-muted text-foreground' : 'bg-muted/60 text-muted-foreground hover:text-foreground'}`}
              aria-label={t`Cerca`}
              title={t`Cerca`}
              onClick={() => {
                setSearchOpen((v) => !v)
                if (searchOpen) setQuery('')
              }}
            >
              <Search className="size-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="grid size-9 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
                aria-label={t`Crea`}
                title={t`Crea`}
              >
                <Plus className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setNewBotOpen(true)}><Trans>Nuovo bot</Trans></DropdownMenuItem>
                <DropdownMenuItem onClick={() => setNewTeamOpen(true)}><Trans>Nuova squadra</Trans></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {searchOpen && (
            <div className="px-3 pb-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('')
                    setSearchOpen(false)
                  }
                }}
                placeholder={t`Cerca bot e squadre`}
                aria-label={t`Cerca bot e squadre`}
                className="w-full rounded-xl bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          <nav className="flex-1 space-y-0.5 overflow-y-auto scroll-thin px-2 pb-2">
            {model.main && <MainRow agent={model.main} />}
            {model.teams.length > 0 && <Title><Trans>Squadre</Trans></Title>}
            {model.teams.map((team) => (
              <TeamRows key={team.group.id} team={team} />
            ))}
            {(noSection.length > 0 || sections.length > 0) && <Title><Trans>Bot</Trans></Title>}
            {noSection.map((b) => (
              <BotRow key={b.agent.id} bot={b} />
            ))}
            {sections.map((sec) => (
              <div key={sec}>
                <Title>{sec}</Title>
                {model.bots.filter((b) => b.section === sec).map((b) => (
                  <BotRow key={b.agent.id} bot={b} />
                ))}
              </div>
            ))}
            {/* la Libreria resta in basso, sopra di te (16c la farà globale) */}
            <button
              className={`mt-2 flex w-full items-center gap-2.5 rounded-[14px] px-2.5 py-2 text-left text-sm transition ${
                openLibraryId !== null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
              onClick={() => (openLibraryId === null ? openLibrary('') : openLibrary(null))}
            >
              <LibraryIcon className="size-4" />
              <Trans>Libreria</Trans>
            </button>
          </nav>

          <div className="flex items-center gap-1.5 px-3 pb-3 pt-1">
            <AccountMenu />
            <button
              className="grid size-9 shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
              aria-label={t`App`}
              title={t`App`}
              onClick={() => { setSettingsTab('connettori'); setSettingsOpen(true) }}
            >
              <LayoutGrid className="size-4" />
            </button>
          </div>
        </>
      )}

      {newBotOpen && <NewBotDialog onClose={() => setNewBotOpen(false)} />}
      {newTeamOpen && <NewTeamDialog onClose={() => setNewTeamOpen(false)} />}
    </aside>
  )
}
