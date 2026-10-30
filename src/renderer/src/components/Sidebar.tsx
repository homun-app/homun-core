// Sidebar (fase 16, U4): ricerca e "+", lista dei bot con la loro mascotte
// (36 px, track=false, stato di U3), gruppi con le mascotte dei membri
// sovrapposte, Libreria e in fondo il menu account adattato a un'app locale.
// Le sezioni restano intestazioni della lista; i sottoagenti non compaiono
// (come prima).
import { useState } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { Plus, Library as LibraryIcon } from 'lucide-react'
import { useStore } from '../store'
import { filterSidebar } from '../sidebar-utils'
import { avatarOf } from '../../../shared/avatar'
import type { Agent, GroupInfo } from '../../../shared/types'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import type { UiTheme } from '../theme'
import { NewBotDialog } from './BotDialogs'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuRadioGroup, DropdownMenuRadioItem
} from './ui/dropdown-menu'

/** Una riga della lista dei bot: mascotte con lo stato di U3, nome, anteprima, pillole. */
function AgentRow({ a }: { a: Agent }) {
  const { t, i18n } = useLingui()
  const info = useBotInfo(a.id)
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const agents = useStore((s) => s.agents)
  const tasks = useStore((s) => s.tasks)
  const subagents = useStore((s) => s.subagents)
  const activity = useStore((s) => s.activity[a.id])
  const previews = useStore((s) => s.previews)
  if (!info) return null
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  // fase 8/12: gli indicatori già esistenti (task in corso, sottoagenti al
  // lavoro), resi come piccole pillole
  const workingTasks = tasks.filter((tk) => tk.agentId === a.id && tk.status === 'working').length
  const runningSubagents = subagents.filter((x) => x.parentId === a.id && x.status === 'running').length
  // fase 17a: anteprima e stato possono essere descriptor (si traducono qui)
  const preview = previews[a.id] || info.statusText
  return (
    <button
      onClick={() => void select(a.id)}
      className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition ${
        a.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60'
      }`}
    >
      <span className="relative shrink-0">
        <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={36} track={false} dimmed={info.dimmed} label={a.name} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{a.name}</span>
          {a.id === effectiveMain && (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title={t`Bot principale: coordina gli altri bot`}>
              <Trans>Principale</Trans>
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {typeof preview === 'string' ? preview : i18n.t(preview)}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {workingTasks > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Plural value={workingTasks} one="# task" other="# task" />
            </span>
          )}
          {runningSubagents > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Plural value={runningSubagents} one="# sottoagente" other="# sottoagenti" />
            </span>
          )}
          {/* stato live — nome del tool e target, mai testo del modello */}
          {activity && (
            <span className="max-w-full truncate rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title={`${activity.tool} ${activity.target}`}>
              <Trans>sta facendo {activity.tool}{activity.target ? ` · ${activity.target}` : ''}</Trans>
            </span>
          )}
        </span>
      </span>
      {a.unread > 0 && (
        <span className="shrink-0 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{a.unread}</span>
      )}
    </button>
  )
}

/** Un gruppo della sidebar: le mascotte dei membri sovrapposte (max 3, 20 px). */
function GroupRow({ g }: { g: GroupInfo }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const openGroupId = useStore((s) => s.openGroupId)
  const openGroup = useStore((s) => s.openGroup)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  return (
    <button
      onClick={() => openGroup(g.id)}
      className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition ${
        g.id === openGroupId ? 'bg-muted' : 'hover:bg-muted/60'
      }`}
      title={g.description}
    >
      <span className="flex shrink-0 items-center -space-x-1.5">
        {g.members.slice(0, 3).map((m) => {
          const a = agents.find((x) => x.id === m.agentId)
          if (!a) return null
          const av = avatarOf(a, agents, effectiveMain)
          return (
            <span key={m.agentId} className="rounded-full ring-2 ring-card">
              <Bot family={av.family} color={av.color} state="idle" size={20} track={false} />
            </span>
          )
        })}
        {g.members.length > 3 && (
          <span className="grid size-5 place-items-center rounded-full bg-muted text-[9px] text-muted-foreground ring-2 ring-card">
            +{g.members.length - 3}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{g.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {g.members.map((m) => m.name).join(', ') || <Trans>solo tu</Trans>}
        </span>
      </span>
    </button>
  )
}

/** Il menu account di Lovable, adattato a un'app locale (niente account/piano/updater). */
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
  const info = useBotInfo(main?.id)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-xl border-t border-border px-4 py-3 text-left transition hover:bg-muted/60 focus:outline-none">
        {info && (
          <span className="shrink-0 rounded-full ring-1 ring-border">
            <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={26} track={false} />
          </span>
        )}
        <span className="min-w-0 text-sm">
          <span className="block font-medium leading-tight">Homun</span>
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

export function Sidebar() {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const groups = useStore((s) => s.groups)
  const openLibraryId = useStore((s) => s.openLibraryId)
  const openLibrary = useStore((s) => s.openLibrary)
  const [query, setQuery] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  // la ricerca filtra bot e gruppi per nome (funzione pura, testata)
  const { agents: shown, groups: shownGroups } = filterSidebar(agents, groups, query)
  // i bot senza sezione stanno insieme; quelli con sezione sotto il suo titolo
  const noSection = shown.filter((a) => !a.section)
  const sections = [...new Set(shown.map((a) => a.section).filter((s): s is string => !!s))]

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
      {/* pt-10: spazio per i traffic lights della titlebar nascosta */}
      <div className="flex items-center gap-2 px-3 pt-10 pb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t`Cerca`}
          aria-label={t`Cerca bot e gruppi`}
          className="min-w-0 flex-1 rounded-xl bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          onClick={() => setNewOpen(true)}
          aria-label={t`Nuovo bot`}
          title={t`Nuovo bot`}
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-foreground text-background transition hover:opacity-90"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto scroll-thin px-2">
        {noSection.map((a) => (
          <AgentRow key={a.id} a={a} />
        ))}
        {sections.map((sec) => (
          <div key={sec} className="mt-3">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{sec}</p>
            {shown.filter((a) => a.section === sec).map((a) => (
              <AgentRow key={a.id} a={a} />
            ))}
          </div>
        ))}
        {/* i gruppi sotto i bot, con le mascotte dei membri al posto di un'icona */}
        {shownGroups.length > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><Trans>Gruppi</Trans></p>
            {shownGroups.map((g) => (
              <GroupRow key={g.id} g={g} />
            ))}
          </div>
        )}
        {/* la Libreria dei prodotti dei bot (documenti, grafici, file) */}
        <button
          className={`mt-2 flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm transition ${
            openLibraryId !== null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
          }`}
          onClick={() => (openLibraryId === null ? openLibrary('') : openLibrary(null))}
        >
          <LibraryIcon className="size-4" />
          <Trans>Libreria</Trans>
        </button>
      </nav>
      <AccountMenu />
      {newOpen && <NewBotDialog onClose={() => setNewOpen(false)} />}
    </aside>
  )
}
