// Sidebar — fase barra-sobria (tavola 6): la barra per MOLTI progetti.
// Testo e pochi segni: in alto le voci fisse (Nuovo, Bot con «la tua chat»,
// Da approvare, Attività, Libreria — che salgono dal fondo); le SQUADRE col
// robottino piccolo 16 px che vive gli stati della mascotte (R2) e si aprono
// da sole SOLO se attive o se aspettano te, i membri rientrati col pallino
// dell'8 px; i BOT fuori squadra col pallino del loro colore. NIENTE
// anteprima sotto il nome: l'anteprima e lo stato vivono nel suggerimento
// (title). Ogni sezione mostra le prime 4, poi «Mostra tutti (N)»; dentro le
// squadre al massimo 2 membri più «Altri N» (stati salvati come teamOpen).
// In fondo chi sei e il modello (AccountMenu). STRETTA (76 px): le voci
// fisse come icone, le squadre col robottino, i bot come cerchio 22 px col
// colore e l'iniziale, suggerimenti col nome. Ridimensionare, rotaia e
// bottone accanto ai semafori restano quelli di oggi (layoutFor/⌘\).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Plus, Search, Library as LibraryIcon, LayoutGrid, ChevronRight, Activity as ActivityIcon, PanelLeftClose, PanelLeftOpen, ShieldCheck } from 'lucide-react'
import { useStore, useResolvedModel } from '../store'
import {
  buildSidebarModel, collapsedVoices, teamOpenState, teamAutoOpens, orderRows, cutRows, memberCut,
  timeAgoShort, rowStateOf, SIDEBAR_ROW_LIMIT, TEAM_MEMBER_LIMIT,
  type SidebarModel, type SidebarTeam, type SidebarBot, type CollapsedVoice, type RowState
} from '../sidebar-utils'
// P6 (fase uso-permessi): il segno di stato condiviso con le card della chat
import { StateSign, rowStateName } from './StateSign'
// fase 16b correzioni 2 (Q1): il massimo del trascinamento e i limiti della barra
import { sidebarMaxFor, SIDEBAR_MIN, AUTO_RAIL_BELOW, TRAFFIC_LIGHT_INSET, type LayoutResult } from '../layout'
import { avatarOf } from '../../../shared/avatar'
import type { Agent } from '../../../shared/types'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { botStateFor, isStreaming, type BotState } from '../bot/bot-state'
import { i18n } from '../lib/i18n'
import type { UiTheme } from '../theme'
import { NewBotDialog } from './BotDialogs'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuRadioGroup, DropdownMenuRadioItem
} from './ui/dropdown-menu'

/**
 * U2 (fase prima-release): il bottone della barra laterale, SEMPRE nello
 * stesso punto nella fascia dei semafori (App lo rende sopra le colonne):
 * PanelLeftClose da larga, PanelLeftOpen da stretta, ⌘\ fa lo stesso. In
 * rotaia FORZATA (finestra sotto AUTO_RAIL_BELOW) resta visibile ma
 * disabilitato, col perché nel tooltip.
 */
export function SidebarToggleButton({ layout }: { layout: LayoutResult }) {
  const { t } = useLingui()
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const windowWidth = useStore((s) => s.windowWidth)
  const collapsed = layout.sidebar === 'rail'
  const forced = collapsed && windowWidth < AUTO_RAIL_BELOW
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  const label = collapsed
    ? forced
      ? t`Allarga la finestra per aprire la barra`
      : t`Apri la barra (⌘\\)`
    : t`Chiudi la barra (⌘\\)`
  return (
    <button
      data-testid="sidebar-toggle"
      className="no-drag grid size-9 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      disabled={forced}
      onClick={() => setSidebarCollapsed(!collapsed)}
    >
      <Icon className="size-4" />
    </button>
  )
}

/** La larghezza sotto cui la barra diventa STRETTA (S2). */
export const SIDEBAR_COLLAPSE_BELOW = 200
const TEAM_OPEN_PREFIX = 'sandbot:sidebar.teamOpen.'
const SECTION_OPEN_PREFIX = 'sandbot:sidebar.sectionOpen.'

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

/** Titoletto semplice e grigio, niente maiuscole (S2). */
/** Tavola 6: la riga sobria — 13,5 px, alta 30, raggio 8, padding 6/10. */
const ROW = 'flex w-full min-h-[30px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition'

function Title({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between pr-1">
      <p className="px-2.5 pb-1 pt-3.5 text-xs text-muted-foreground">{children}</p>
      {action}
    </div>
  )
}

/**
 * R1 (fase barra-sobria): «Nuovo», la prima voce fissa della tavola 6. Apre
 * SUBITO il dialogo (come il «+» della riga della ricerca, B2 fase beta.4).
 */
function NewRow({ onNewBot }: { onNewBot(): void }) {
  const { t } = useLingui()
  return (
    <button
      className={`${ROW} text-muted-foreground hover:bg-muted/60 hover:text-foreground`}
      aria-label={t`Nuovo`}
      title={t`Nuovo`}
      onClick={onNewBot}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <Plus className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate"><Trans>Nuovo</Trans></span>
    </button>
  )
}

/**
 * A2 (fase centro-autorizzazioni): la voce fissa «Da approvare», in alto
 * sopra «Squadre» (tavola 4). Con 0 richieste la voce resta, senza pallino
 * e senza numero; il conteggio conta TUTTE le richieste pendenti (anche i
 * «Rimanda», che restano in attesa nel bot). R1: resta terza, dopo Bot.
 */
function ApprovalsRow() {
  const { i18n } = useLingui()
  const count = useStore((s) => s.approvalsAll.length)
  const approvalsOpen = useStore((s) => s.approvalsOpen)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  return (
    <button
      className={`${ROW} ${
        approvalsOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
      }`}
      data-testid="sidebar-approvals"
      aria-label={count > 0 ? i18n.t(msg`Da approvare, ${count} richieste`) : i18n.t(msg`Da approvare`)}
      onClick={() => setApprovalsOpen(!approvalsOpen)}
    >
      <span className="relative grid size-4 shrink-0 place-items-center">
        <ShieldCheck className="size-4" />
        {count > 0 && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-waiting" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1 truncate"><Trans>Da approvare</Trans></span>
      {count > 0 && <span className="shrink-0 text-xs font-semibold tabular-nums text-waiting">{count}</span>}
    </button>
  )
}

/**
 * Il robottino piccolo della squadra: 16 px, famiglia e colore del
 * coordinatore — e lo stato AGGREGATO della squadra (R2): respira ~2 s e ha
 * i tre puntini blu se lavora; occhi più grandi e pallino arancio con l'onda
 * se aspetta te (lo stato waiting del Bot); un saltello solo se finito;
 * respiro lento se fermo. Tutto con i keyframes che la mascotte usa già.
 */
function TeamRobot({ team }: { team: SidebarTeam }) {
  const { i18n } = useLingui()
  const coordInfo = useBotInfo(team.coordinator?.id ?? null)
  if (!coordInfo) {
    return <span className="grid size-4 shrink-0 place-items-center rounded-full bg-muted text-[8px] text-muted-foreground">{team.group.name.slice(0, 1)}</span>
  }
  const botState: BotState =
    team.state === 'aspetta-te' ? 'waiting' : team.state === 'finito' ? 'happy' : 'idle'
  return (
    <span className={`side-robot side-robot--${team.state}`} role="img" aria-label={i18n.t(rowStateName(team.state))}>
      <Bot family={coordInfo.avatar.family} color={coordInfo.avatar.color} state={botState} size={16} track={false} dimmed={coordInfo.dimmed} />
      {team.state === 'lavora' && (
        <span className="side-robot-dots" aria-hidden="true">
          <span className="side-robot-dot" style={{ animationDelay: '0s' }} />
          <span className="side-robot-dot" style={{ animationDelay: '.15s' }} />
          <span className="side-robot-dot" style={{ animationDelay: '.3s' }} />
        </span>
      )}
    </span>
  )
}

/** Il pallino del colore del bot: decorativo, 8 px (aria-hidden). */
function ColorDot({ agent }: { agent: Agent }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const av = avatarOf(agent, agents, mainAgentId ?? agents[0]?.id ?? null)
  return (
    <span
      data-testid="bot-dot-color"
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ background: `var(--bot-${av.color})` }}
    />
  )
}

/**
 * La riga del bot PRINCIPALE: l'unica con la mascotte (22 px) e «la tua
 * chat» a destra. L'anteprima e lo stato vivono nel suggerimento.
 */
function MainRow({ agent, childWaiting, preview, state }: { agent: Agent; childWaiting: boolean; preview: string; state: BotState }) {
  const { i18n } = useLingui()
  const info = useBotInfo(agent.id)
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  if (!info) return null
  const tip = [preview || i18n.t(info.statusText), i18n.t(rowStateName(rowStateOf(state, childWaiting)))].filter(Boolean).join(' · ')
  return (
    <button
      onClick={() => void select(agent.id)}
      className={`flex w-full min-h-[34px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${
        agent.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60'
      }`}
      title={tip}
    >
      <Bot family={info.avatar.family} color={info.avatar.color} state={state} size={22} track={false} dimmed={info.dimmed} label={agent.name} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{agent.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground"><Trans>la tua chat</Trans></span>
    </button>
  )
}

/** Il lato destro della riga: il SEGNO di stato (R2), o il tempo se fermo. */
function RightSide({ state, childWaiting = false, lastAt, now }: { state: BotState; childWaiting?: boolean; lastAt: number | null; now: number }) {
  const rs = rowStateOf(state, childWaiting)
  if (rs !== 'fermo') return <StateSign state={rs} />
  const d = timeAgoShort(lastAt, now)
  return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{i18n.t(d)}</span>
}

/** La riga UNA della squadra + i membri aperti, rientrati (tavola 6). */
function TeamRows({ team, states, lastSendAt, now }: { team: SidebarTeam; states: Record<string, BotState>; lastSendAt: Record<string, number>; now: number }) {
  const { i18n } = useLingui()
  const openGroupId = useStore((s) => s.openGroupId)
  const openGroup = useStore((s) => s.openGroup)
  // R1: le squadre sono CHIUSE di default — si aprono da sole solo l'attiva
  // o quella che aspetta te; l'utente comanda col suo stato salvato
  const [open, setOpen] = useState(() => teamOpenState(readLS(`${TEAM_OPEN_PREFIX}${team.group.id}`), teamAutoOpens(team, openGroupId)))
  const [allMembers, setAllMembers] = useState(() => readLS(`${SECTION_OPEN_PREFIX}members.${team.group.id}`) === '1')
  const members = orderRows(
    team.members.map((m) => ({
      member: m,
      waiting: states[m.id] === 'waiting',
      // M4 (fase beta12-correzioni): chi lavora adesso conta per l'ordine
      works: states[m.id] === 'thinking' || states[m.id] === 'speaking' || states[m.id] === 'listening',
      lastAt: lastSendAt[m.id] ?? m.createdAt
    }))
  )
  const cut = memberCut(members, allMembers)
  const tip = team.group.description
    ? `${team.group.name} · ${team.group.description}`
    : team.group.name
  return (
    <div>
      <div className={`flex items-center gap-1 rounded-lg pl-2.5 pr-1 text-left transition ${openGroupId === team.group.id ? 'bg-muted' : 'hover:bg-muted/60'}`}>
        <button
          className="flex min-h-[30px] min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          onClick={() => openGroup(team.group.id)}
          title={tip}
        >
          <TeamRobot team={team} />
          <span className={`min-w-0 flex-1 truncate text-[13.5px] ${open || openGroupId === team.group.id ? 'font-semibold' : ''}`}>{team.group.name}</span>
          {team.waitingCount > 0 && (
            <span className="shrink-0 text-xs font-semibold tabular-nums text-waiting" aria-label={i18n.t(msg`${team.waitingCount} ti aspettano`)}>{team.waitingCount}</span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{i18n.t(timeAgoShort(team.lastAt, now))}</span>
        </button>
        {team.members.length > 0 && (
          <button
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-expanded={open}
            aria-label={open ? i18n.t(msg`Chiudi i membri di ${team.group.name}`) : i18n.t(msg`Apri i membri di ${team.group.name}`)}
            onClick={() => {
              const next = !open
              setOpen(next)
              writeLS(`${TEAM_OPEN_PREFIX}${team.group.id}`, next ? '1' : '0')
            }}
          >
            <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col pl-5">
          {cut.visible.map(({ member }) => (
            <MemberRow key={member.id} member={member} state={states[member.id] ?? 'idle'} lastAt={lastSendAt[member.id] ?? member.createdAt} now={now} />
          ))}
          {members.length > TEAM_MEMBER_LIMIT && (
            <button
              className="rounded-lg px-2 py-1 pl-[26px] text-left text-[12.5px] text-muted-foreground transition hover:bg-muted/60"
              aria-expanded={allMembers}
              onClick={() => {
                const next = !allMembers
                setAllMembers(next)
                writeLS(`${SECTION_OPEN_PREFIX}members.${team.group.id}`, next ? '1' : '0')
              }}
            >
              {allMembers ? i18n.t(msg`Meno`) : i18n.t(msg`Altri ${cut.hidden}`)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Un membro della squadra, rientrato: pallino 8 px, nome, segno o tempo. */
function MemberRow({ member, state, lastAt, now }: { member: Agent; state: BotState; lastAt: number; now: number }) {
  const openGroup = useStore((s) => s.openGroup)
  const select = useStore((s) => s.select)
  const previews = useStore((s) => s.previews)
  const preview = previews[member.id]
  const tip = [typeof preview === 'string' ? preview : preview ? i18n.t(preview) : '', i18n.t(rowStateName(rowStateOf(state)))].filter(Boolean).join(' · ')
  return (
    <button
      className="flex min-h-[28px] items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[13.5px] transition hover:bg-muted/60"
      onClick={() => { openGroup(null); void select(member.id) }}
      title={tip || member.name}
    >
      <ColorDot agent={member} />
      <span className="min-w-0 flex-1 truncate">{member.name}</span>
      <RightSide state={state} lastAt={lastAt} now={now} />
    </button>
  )
}

/** Un bot singolo: pallino del colore, nome, segno o tempo (tavola 6). */
function BotRow({ bot, now }: { bot: SidebarBot; now: number }) {
  const info = useBotInfo(bot.agent.id)
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const previews = useStore((s) => s.previews)
  if (!info) return null
  const preview = previews[bot.agent.id]
  const tip = [
    typeof preview === 'string' ? preview : preview ? i18n.t(preview) : i18n.t(info.statusText),
    i18n.t(rowStateName(rowStateOf(bot.state, bot.childWaiting)))
  ].filter(Boolean).join(' · ')
  return (
    <button
      onClick={() => void select(bot.agent.id)}
      className={`${ROW} ${
        bot.agent.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60'
      }`}
      title={tip}
    >
      <ColorDot agent={bot.agent} />
      <span className="min-w-0 flex-1 truncate">{bot.agent.name}</span>
      <RightSide state={bot.state} childWaiting={bot.childWaiting} lastAt={bot.lastAt} now={now} />
    </button>
  )
}

/** «Mostra tutti (N)» / «Mostra tutte (N)» — l'espansione della sezione
 *  (espansa, il bottone diventa «Meno» e la richiude). */
function ShowAllRow({ hidden, feminine, expanded, onToggle }: { hidden: number; feminine: boolean; expanded: boolean; onToggle(): void }) {
  const { i18n } = useLingui()
  const total = hidden + SIDEBAR_ROW_LIMIT
  return (
    <button
      className="rounded-lg py-1 pl-[26px] pr-2.5 text-left text-[12.5px] text-muted-foreground transition hover:bg-muted/60"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? i18n.t(msg`Meno`)
        : feminine
          ? i18n.t(msg`Mostra tutte (${total})`)
          : i18n.t(msg`Mostra tutti (${total})`)}
    </button>
  )
}

/** La mascotte di una voce della barra stretta (hook nel componente, non in map). */
function VoiceMascot({ agentId, size }: { agentId: string; size: number }) {
  const info = useBotInfo(agentId)
  if (!info) return <span className="block rounded-full bg-muted" style={{ width: size, height: size }} />
  return <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={size} track={false} dimmed={info.dimmed} />
}

/**
 * Il menu account di oggi, adattato: te + Collega app/Skill/Impostazioni/Tema
 * (fase skill · sfoglia, B1: «Skill» vive QUI, sotto «Collega app»).
 * Fase 16c correzioni (R7): in ROTAI lo stesso menu pende dal bottone in
 * fondo. U2 (fase prima-release): la voce che allargava la barra è uscita
 * dal menu — allargare ha il suo bottone fisso accanto ai semafori.
 * Fase barra-sobria (R1): nel fondo della barra larga c'è SOLO questo —
 * «Collega app» resta nel menu (il bottone App dedicato resta in rotaia).
 */
/** A2: la voce «Da approvare» della barra stretta, col numero delle richieste. */
function RailApprovals() {
  const { i18n } = useLingui()
  const count = useStore((s) => s.approvalsAll.length)
  const approvalsOpen = useStore((s) => s.approvalsOpen)
  const setApprovalsOpen = useStore((s) => s.setApprovalsOpen)
  return (
    <button
      className={`relative grid size-9 shrink-0 place-items-center rounded-full transition ${approvalsOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      data-testid="rail-approvals"
      aria-label={count > 0 ? i18n.t(msg`Da approvare, ${count} richieste`) : i18n.t(msg`Da approvare`)}
      onClick={() => setApprovalsOpen(!approvalsOpen)}
    >
      <ShieldCheck className="size-4" />
      {count > 0 && (
        <span className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-waiting px-1 text-[11px] font-bold text-background">
          {count}
        </span>
      )}
    </button>
  )
}

/** rail: il menu pende dal bottone in fondo della barra STRETTA (trigger ridotto all'iniziale, allineamento a destra). */
function AccountMenu(props?: { rail?: boolean; triggerClassName?: string }) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  // M2 (fase beta12-correzioni): la finestra «Server MCP»
  const setMcpOpen = useStore((s) => s.setMcpOpen)
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const main = agents.find((a) => a.id === effectiveMain)
  // fase 16c correzioni (R4): il modello mostrato è quello RISOLTO, dal
  // selettore UNICO («Come gli altri» compreso)
  const resolved = useResolvedModel(main?.id ?? null)
  // U3 (fase pulizia · ritocchi): una voce che APRE una finestra (App, Skill,
  // Impostazioni) lo segna qui, e alla chiusura il menu NON riprende il focus
  // sul suo trigger: il focus è della finestra (il campo di ricerca).
  const openedWindow = useRef(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="account-menu-trigger"
        className={
          props?.triggerClassName ??
          'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-muted/60 focus:outline-none'
        }
      >
        {/* in rotaia solo l'iniziale (come il vecchio bottone), nel resto
            della barra la riga nome + modello risolto */}
        <span className={`grid shrink-0 place-items-center rounded-full bg-muted font-semibold text-foreground ${props?.rail ? 'size-9 text-sm' : 'size-6 text-[11px]'}`}>
          {main ? main.name.slice(0, 1).toUpperCase() : '·'}
        </span>
        {!props?.rail && (
          <span className="min-w-0 text-[13.5px]">
            <span className="block truncate font-medium leading-tight">{main ? main.name : t`nessun bot`}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {main ? (resolved ? `${resolved.providerId} · ${resolved.model}` : t`nessun modello`) : t`nessun bot`}
            </span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align={props?.rail ? 'end' : 'start'}
        className="w-56"
        onCloseAutoFocus={(e) => { if (openedWindow.current) { openedWindow.current = false; e.preventDefault() } }}
      >
        <DropdownMenuItem onClick={() => { openedWindow.current = true; setAppsOpen(true) }}><Trans>Collega app</Trans></DropdownMenuItem>
        {/* fase skill · sfoglia (B1): «Skill» sta QUI nel menu, sotto Collega
            app — non più come bottone nella barra accanto ad App */}
        <DropdownMenuItem data-testid="menu-skills" onClick={() => { openedWindow.current = true; setSkillsOpen(true) }}><Trans>Skill</Trans></DropdownMenuItem>
        {/* M2 (fase beta12-correzioni): «Server MCP» tra Skill e
            Impostazioni — la finestra sua, come le Skill */}
        <DropdownMenuItem data-testid="menu-mcp" onClick={() => { openedWindow.current = true; setMcpOpen(true) }}><Trans>Server MCP</Trans></DropdownMenuItem>
        <DropdownMenuItem onClick={() => { openedWindow.current = true; setSettingsOpen(true) }}><Trans>Impostazioni</Trans></DropdownMenuItem>
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

/** Il cerchio 22 px del bot nella ROTAIa: colore del bot + iniziale. */
function RailBotCircle({ agent, state }: { agent: Agent; state: BotState }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const av = avatarOf(agent, agents, mainAgentId ?? agents[0]?.id ?? null)
  const { i18n } = useLingui()
  return (
    <span className="relative grid shrink-0 place-items-center">
      <span
        data-testid="rail-bot-circle"
        data-size="22"
        className="grid size-[22px] place-items-center rounded-full text-[10px] font-bold text-background"
        style={{ background: `var(--bot-${av.color})` }}
        aria-hidden="true"
      >
        {agent.name.slice(0, 1).toUpperCase()}
      </span>
      {rowStateOf(state) !== 'fermo' && (
        <StateSign state={rowStateOf(state)} testid="rail-state-sign" className="rail-sign absolute -bottom-1 -right-1 rounded-full bg-card ring-2 ring-card" />
      )}
    </span>
  )
}

/**
 * La barra STRETTA (fase barra-sobria): le voci fisse come ICONE (Nuovo, il
 * bot principale, Da approvare, Attività, Libreria), le squadre col
 * robottino a 16 px, i bot come cerchio 22 px nel loro colore con
 * l'iniziale; il segno di stato in piccolo sull'angolo, i suggerimenti col
 * nome. In fondo Cerca, App e il menu account (come oggi).
 */
function CollapsedColumn({
  model,
  states,
  onSearch,
  searchOpen,
  onNewBot
}: {
  model: SidebarModel
  states: Record<string, BotState>
  onSearch(): void
  searchOpen: boolean
  onNewBot(): void
}) {
  const { i18n } = useLingui()
  const select = useStore((s) => s.select)
  const openGroup = useStore((s) => s.openGroup)
  const setActivityOpen = useStore((s) => s.setActivityOpen)
  const activityOpen = useStore((s) => s.activityOpen)
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const voices = collapsedVoices(model)
  const stateName = (st: RowState): string => i18n.t(rowStateName(st))
  return (
    <>
      {/* fase 16b correzioni 2 (Q3): in rotaia i semafori occupano la cima —
          la fascia di trascinamento finisce dove inizia la prima voce */}
      <div className="drag-region h-12 shrink-0" aria-hidden="true" />
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto scroll-thin px-2 pt-2">
        {/* le voci fisse come icone, nell'ordine della barra larga — il «+»
            apre SUBITO il dialogo «Nuovo» (B2 fase beta.4) */}
        <button
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label={i18n.t(msg`Crea`)}
          title={i18n.t(msg`Crea`)}
          onClick={onNewBot}
        >
          <Plus className="size-4" />
        </button>
        {model.main && (
          <button
            className="relative my-0.5 shrink-0"
            aria-label={`${model.main.name}, ${i18n.t(msg`la tua chat`)}` }
            title={model.main.name}
            onClick={() => { openGroup(null); void select(model.main!.id) }}
          >
            <RailBotCircle agent={model.main} state={states[model.main.id] ?? 'idle'} />
          </button>
        )}
        <RailApprovals />
        <button
          className={`grid size-9 shrink-0 place-items-center rounded-full transition ${activityOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          aria-label={i18n.t(msg`Attività`)}
          title={i18n.t(msg`Attività`)}
          onClick={() => setActivityOpen(!activityOpen)}
        >
          <ActivityIcon className="size-4" />
        </button>
        <button
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label={i18n.t(msg`Libreria`)}
          title={i18n.t(msg`Libreria`)}
          onClick={() => { const s = useStore.getState(); s.openLibraryId === null ? s.openLibrary('') : s.openLibrary(null) }}
        >
          <LibraryIcon className="size-4" />
        </button>
        <span className="my-1 h-px w-6 shrink-0 bg-border/60" aria-hidden="true" />
        {voices.filter((v) => v.kind !== 'main').map((v: CollapsedVoice) => (
          <button
            key={v.key}
            className="relative my-0.5 shrink-0"
            aria-label={`${v.name}, ${stateName(v.status)}`}
            title={v.name}
            onClick={() => {
              const team = model.teams.find((t) => `g${t.group.id}` === v.key)
              if (team) openGroup(team.group.id)
              else {
                const agent = model.bots.map((b) => b.agent).find((a) => a.id === v.key)
                if (agent) { openGroup(null); void select(agent.id) }
              }
            }}
          >
            {v.kind === 'team' ? (
              <TeamRobot team={model.teams.find((t) => `g${t.group.id}` === v.key)!} />
            ) : (
              <RailBotCircle agent={model.bots.find((b) => b.agent.id === v.key)!.agent} state={states[v.key] ?? 'idle'} />
            )}
            {v.counter > 0 && (
              <span className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground px-1 text-[11px] font-bold text-background">
                {v.counter}
              </span>
            )}
          </button>
        ))}
        <span className="my-1 h-px w-6 shrink-0 bg-border/60" aria-hidden="true" />
        {/* R7: la lente di Cerca — apre la ricerca sospesa in alto a sinistra */}
        <button
          className={`grid size-9 shrink-0 place-items-center rounded-full transition ${searchOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          aria-label={i18n.t(msg`Cerca`)}
          title={i18n.t(msg`Cerca`)}
          onClick={onSearch}
        >
          <Search className="size-4" />
        </button>
        <div className="flex-1" />
        <button
          className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
          aria-label={i18n.t(msg`App`)}
          title={i18n.t(msg`App`)}
          onClick={() => setAppsOpen(true)}
        >
          <LayoutGrid className="size-4" />
        </button>
        {/* fase 16b correzioni 2 (Q3): la riga dell'utente, alta 60 con 16 di
            margine sotto — lo stesso centro verticale della pillola della chat */}
        <div className="mb-4 flex h-[60px] shrink-0 items-center justify-center">
          <AccountMenu
            rail
            triggerClassName="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold text-foreground transition hover:bg-muted/70 focus:outline-none"
          />
        </div>
      </div>
    </>
  )
}

export function Sidebar({ layout }: { layout: LayoutResult }) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const groups = useStore((s) => s.groups)
  const mainAgentId = useStore((s) => s.mainAgentId)
  // AH2 (fase aiutanti): il bot con un FIGLIO fermo su una card è «in attesa
  // di te» — i subagents si conoscono per il bot APERTO (chi lo guarda)
  const activeId = useStore((s) => s.activeId)
  const subagents = useStore((s) => s.subagents)
  const openLibraryId = useStore((s) => s.openLibraryId)
  const openLibrary = useStore((s) => s.openLibrary)
  const activityOpen = useStore((s) => s.activityOpen)
  const setActivityOpen = useStore((s) => s.setActivityOpen)
  const previews = useStore((s) => s.previews)
  const turnEnds = useStore((s) => s.turnEnds)
  const lastDeltaAt = useStore((s) => s.lastDeltaAt)
  const typingAgentId = useStore((s) => s.typingAgentId)
  const nowTick = useStore((s) => s.nowTick)
  const lastSendAt = useStore((s) => s.lastSendAt)
  // fase 16b correzioni 2 (Q1): le preferenze vivono nello store (localStorage
  // lì); la barra resa è quella di layoutFor — la rotaia automatica sotto
  // AUTO_RAIL_BELOW non tocca la preferenza dell'utente
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [newBotOpen, setNewBotOpen] = useState(false)
  const collapsed = layout.sidebar === 'rail'
  // fase 16c correzioni (R7): la rotaia è FORZATA quando la finestra scende
  // sotto AUTO_RAIL_BELOW — da forzata non si allarga (bottone disabilitato,
  // bordo senza trascinamento)
  const windowWidth = useStore((s) => s.windowWidth)
  const railForced = windowWidth < AUTO_RAIL_BELOW
  const dragging = useRef(false)
  // R1: le sezioni espanse («Mostra tutti») si ricordano come teamOpen
  const [sectionsOpen, setSectionsOpen] = useState<Record<string, boolean>>({})
  const sectionOpen = (key: string): boolean => sectionsOpen[key] ?? readLS(`${SECTION_OPEN_PREFIX}${key}`) === '1'
  const toggleSection = (key: string): void => {
    const next = !sectionOpen(key)
    setSectionsOpen((s) => ({ ...s, [key]: next }))
    writeLS(`${SECTION_OPEN_PREFIX}${key}`, next ? '1' : '0')
  }

  // ⌘\ apre/chiude la barra stretta; la scelta si ricorda
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && (e.key === '\\' || e.code === 'Backslash')) {
        e.preventDefault()
        const s = useStore.getState()
        s.setSidebarCollapsed(!s.sidebarCollapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // trascinamento del bordo destro: sotto i 200 px la barra diventa stretta;
  // il massimo è sidebarMaxFor (Q1 regola 3) — barra + pannello docked +
  // CHAT_MIN non superano mai la finestra
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    // U2: il bordo si trascina anche in rotaia — l'ancora è la larghezza RESA
    // (la rotaia è 76 px), così «oltre la soglia» è dove sta il puntatore
    const startWidth = collapsed ? layout.sidebarWidth : useStore.getState().sidebarWidth
    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return
      const next = startWidth + (ev.clientX - startX)
      if (next < SIDEBAR_COLLAPSE_BELOW) {
        setSidebarCollapsed(true)
      } else {
        setSidebarCollapsed(false)
        const s = useStore.getState()
        const max = sidebarMaxFor(s.windowWidth, s.rightPanel, s.openGroupId !== null ? 'members' : s.panelTab)
        setSidebarWidth(Math.min(max, Math.max(SIDEBAR_MIN, next)))
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

  // AH2: l'insieme dei bot con un figlio che aspetta l'utente (pendingApprovals)
  const waitingOnChildren = new Set<string>(
    activeId && subagents.some((s) => (s.pendingApprovals?.length ?? 0) > 0) ? [activeId] : []
  )
  // R1 (fase barra-sobria): gli stati della mascotte risolti UNA volta per
  // tutte (la stessa funzione pura di useBotInfo) — il modello ordina per
  // «prima chi aspetta te» e le righe disegnano il segno giusto
  const now = nowTick || Date.now()
  const states: Record<string, BotState> = {}
  for (const a of agents) {
    states[a.id] = botStateFor({
      status: a.status,
      streaming: isStreaming(lastDeltaAt[a.id], now),
      userTyping: typingAgentId === a.id,
      turnEnd: turnEnds[a.id] ?? null,
      now
    })
  }
  const lastSendAtMap: Record<string, number> = lastSendAt
  const model = buildSidebarModel(agents, groups, mainAgentId, query, waitingOnChildren, { states, lastSendAt: lastSendAtMap })
  const orderedBots = orderRows(model.bots)
  const noSection = cutRows(orderRows(orderedBots.filter((b) => !b.section)), sectionOpen('bots'))
  const sections = [...new Set(model.bots.map((b) => b.section).filter((s): s is string => !!s))]
  const teamsCut = cutRows(model.teams, sectionOpen('teams'))
  const mainPreview = model.main ? previews[model.main.id] : undefined

  return (
    <aside
      className="relative flex shrink-0 select-none flex-col border-r border-border/50 bg-card"
      style={{ width: layout.sidebarWidth }}
    >
      {/* U2: il bordo trascinabile c'è SEMPRE, tranne in rotaia FORZATA
          (sotto AUTO_RAIL_BELOW allargare non si può): da stretta,
          trascinarlo oltre la soglia allarga la barra */}
      {!(collapsed && railForced) && <div className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize" onMouseDown={startDrag} aria-hidden="true" />}

      {collapsed ? (
        <CollapsedColumn
          model={model}
          states={states}
          searchOpen={searchOpen}
          onSearch={() => {
            setSearchOpen((v) => !v)
            if (searchOpen) setQuery('')
          }}
          onNewBot={() => setNewBotOpen(true)}
        />
      ) : (
        <>
          {/* fase 16b correzioni 2 (Q3): Cerca e Crea sulla riga comune (y
              12–48, centro 30) dentro la fascia di trascinamento di 60 px;
              allineati a destra — a sinistra restano i semafori di macOS.
              K4 (fase rilascio — correzioni): il loro spazio è la STESSA
              costante (TRAFFIC_LIGHT_INSET) che lascia libero la riga del
              rinnovo in cima alla finestra. Ricerca: resta nel punto di oggi. */}
          <div className="drag-region h-[60px] shrink-0">
            <div className="mt-3 flex h-9 items-center justify-end gap-2 px-3" style={{ paddingLeft: TRAFFIC_LIGHT_INSET }}>
              <button
                className={`no-drag grid size-8 place-items-center rounded-lg transition ${searchOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
                aria-label={t`Cerca`}
                title={t`Cerca`}
                onClick={() => {
                  setSearchOpen((v) => !v)
                  if (searchOpen) setQuery('')
                }}
              >
                <Search className="size-4" />
              </button>
              {/* B2 (fase beta.4): il «+» apre SUBITO il dialogo «Nuovo» (come
                  la voce Nuovo della barra, che la tavola 6 mette in cima) */}
              <button
                className="no-drag grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                aria-label={t`Crea`}
                title={t`Crea`}
                onClick={() => setNewBotOpen(true)}
              >
                <Plus className="size-4" />
              </button>
            </div>
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
                placeholder={t`Cerca bot e team`}
                aria-label={t`Cerca bot e team`}
                className="no-drag w-full rounded-xl bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          {/* pt-1 (Q3): il primo contenuto parte a 64 px come il primo messaggio.
              Le voci fisse in cima, nell'ordine della tavola 6: Nuovo, Bot (la
              tua chat), Da approvare, Attività, Libreria (salgono dal fondo) */}
          <nav className="flex-1 space-y-px overflow-y-auto scroll-thin px-2 pb-2 pt-1">
            <NewRow onNewBot={() => setNewBotOpen(true)} />
            {model.main && (
              <MainRow
                agent={model.main}
                childWaiting={model.mainWaiting}
                preview={typeof mainPreview === 'string' ? mainPreview : mainPreview ? i18n.t(mainPreview) : ''}
                state={states[model.main.id] ?? 'idle'}
              />
            )}
            <ApprovalsRow />
            <button
              className={`${ROW} ${
                activityOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
              onClick={() => { setActivityOpen(!activityOpen); if (!activityOpen) openLibrary(null) }}
            >
              <span className="grid size-4 shrink-0 place-items-center">
                <ActivityIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate"><Trans>Attività</Trans></span>
            </button>
            <button
              className={`${ROW} ${
                openLibraryId !== null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
              onClick={() => { openLibraryId === null ? openLibrary('') : openLibrary(null); if (openLibraryId === null) setActivityOpen(false) }}
            >
              <span className="grid size-4 shrink-0 place-items-center">
                <LibraryIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate"><Trans>Libreria</Trans></span>
            </button>

            {model.teams.length > 0 && (
              <Title action={
                /* B2 (fase beta.4): la squadra NASCE IN CHAT, non da un menu —
                   il «+» della tavola 6 apre il dialogo «Nuovo» del BOT */
                <button
                  className="mr-1 grid size-6 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  aria-label={t`Crea`}
                  title={t`Crea`}
                  onClick={() => setNewBotOpen(true)}
                >
                  <Plus className="size-3.5" />
                </button>
              }><Trans>Team</Trans></Title>
            )}
            {teamsCut.visible.map((team) => (
              <TeamRows key={team.group.id} team={team} states={states} lastSendAt={lastSendAtMap} now={now} />
            ))}
            {model.teams.length > SIDEBAR_ROW_LIMIT && (
              <ShowAllRow hidden={teamsCut.hidden} feminine expanded={sectionOpen('teams')} onToggle={() => toggleSection('teams')} />
            )}

            {(orderedBots.length > 0 || sections.length > 0) && <Title><Trans>Bot</Trans></Title>}
            {noSection.visible.map((b) => (
              <BotRow key={b.agent.id} bot={b} now={now} />
            ))}
            {orderedBots.filter((b) => !b.section).length > SIDEBAR_ROW_LIMIT && (
              <ShowAllRow hidden={noSection.hidden} feminine={false} expanded={sectionOpen('bots')} onToggle={() => toggleSection('bots')} />
            )}
            {sections.map((sec) => {
              const rows = orderRows(model.bots.filter((b) => b.section === sec))
              const cut = cutRows(rows, sectionOpen(`section.${sec}`))
              return (
                <div key={sec}>
                  <Title>{sec}</Title>
                  {cut.visible.map((b) => (
                    <BotRow key={b.agent.id} bot={b} now={now} />
                  ))}
                  {rows.length > SIDEBAR_ROW_LIMIT && (
                    <ShowAllRow hidden={cut.hidden} feminine={false} expanded={sectionOpen(`section.${sec}`)} onToggle={() => toggleSection(`section.${sec}`)} />
                  )}
                </div>
              )
            })}
          </nav>

          {/* fase barra-sobria (R1): in fondo CHI SEI, il modello e
              l'ingranaggio — tutto nell'AccountMenu (tavola 6) */}
          <div className="mb-3 flex h-[52px] shrink-0 items-center px-2">
            <AccountMenu />
          </div>
        </>
      )}

      {/* fase 16c correzioni (R7): la ricerca della rotaia, sospesa in alto a
          sinistra (sopra le voci); filtra le voci come nella barra larga */}
      {collapsed && searchOpen && (
        <div className="absolute left-2 top-14 z-30 w-60">
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
            placeholder={t`Cerca bot e team`}
            aria-label={t`Cerca bot e team`}
            className="no-drag w-full rounded-xl bg-card px-3 py-2 text-sm shadow-soft outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}

      {newBotOpen && <NewBotDialog onClose={() => setNewBotOpen(false)} />}
    </aside>
  )
}
