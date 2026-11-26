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
//
// Fase design (DS4): la barra ai token di DS1. La spec: «righe text-body,
// metadati text-caption, titoli di gruppo text-caption grigi, stesse
// altezze». Le MISURE non sono scritte qui: sono i nomi dei token di
// styles.css (h-row, gap-row-gap, text-caption…), e la guardia di DS6 non
// lascia riscriverle. Quel che STA QUI è l'ANATOMIA della riga, quella sì
// decisa una volta per tutte (vedi ROW e SLOT, più sotto): la struttura è
// ciò che tiene la barra ordinata, i token ciò che la tengono uguale al
// resto dell'app. Quel che non cambia: la logica, gli handler, i testid, i
// testi, la testata di DS3 (la riga dei 52 con i semafori).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Plus, Search, Library as LibraryIcon, LayoutGrid, ChevronRight, Activity as ActivityIcon, PanelLeftClose, PanelLeftOpen, ShieldCheck, MoreHorizontal, Puzzle } from 'lucide-react'
import { useStore, useResolvedModel, api } from '../store'
import {
  buildSidebarModel, collapsedVoices, teamOpenState, teamAutoOpens, orderRows, cutRows, memberCut,
  timeAgoShort, rowStateOf, SIDEBAR_ROW_LIMIT, TEAM_MEMBER_LIMIT,
  type SidebarModel, type SidebarTeam, type SidebarBot, type CollapsedVoice, type RowState
} from '../sidebar-utils'
// P6 (fase uso-permessi): il segno di stato condiviso con le card della chat
import { StateSign, rowStateName } from './StateSign'
// fase 16b correzioni 2 (Q1): il massimo del trascinamento e i limiti della barra
import { sidebarMaxFor, SIDEBAR_MIN, AUTO_RAIL_BELOW, type LayoutResult } from '../layout'
// fase design (DS3): la cornice — lo spazio dei semafori (SIDEBAR_HEAD_PAD) e l'altezza della riga in cima alla colonna (h-col-head)
import { SIDEBAR_HEAD_PAD } from '../../../shared/window-frame'
import { avatarOf } from '../../../shared/avatar'
import type { Agent } from '../../../shared/types'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
import { botStateFor, isStreaming, type BotState } from '../bot/bot-state'
import { i18n } from '../lib/i18n'
// fase design (DS4): la fusione delle classi che conosce i token di DS1 (l'ultima vince)
import { cn } from '../lib/utils'
import type { UiTheme } from '../theme'
import { NewBotDialog } from './BotDialogs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
// fase design (DS4): il bottone UNICO dell'interfaccia (i comandi con un'etichetta: «Ripristina», quelli del dialogo)
import { Button } from './ui/button'
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
      className="no-drag grid size-control-sm place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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

/**
 * Fase design (DS4), R3 (b20-ritocchi): LE RIGHE della barra. Le misure sono
 * i token di DS1 (styles.css); qui si decide l'ANATOMIA, che è sempre la
 * stessa:
 *
 *   [respiro 8] [slot 20: il segno] [8] [nome …] [metadati] [azioni]
 *
 * LO SLOT DA 20 è la regola che tiene i NOMI sulla stessa ascissa. Davanti a
 * un nome può esserci un'icona di 20, la mascotte di 20, il robottino di 20 o
 * il pallino di 8: ogni segno sta nel rettangolo di 20 e il testo parte
 * sempre a 8 px dal suo bordo (gap-2): cambia il segno, non dove comincia a
 * leggere l'occhio.
 *
 * L'ALTEZZA la decide la FAMIGLIA, non il contenuto: la voce della barra è
 * alta 36 (h-row-nav — R3: era 52, un errore della spec di fase-design: i 52
 * valgono per le righe delle LISTE nelle pagine, con icona grande e due righe
 * di testo, non per una barra di navigazione; Claude, ChatGPT e Linear stanno
 * fra 32 e 36). Fissa, senza respiro verticale — il contenuto sta centrato.
 *
 * Il NOME VINCE SUL TEMPO: il tempo non si tronca mai — o c'è intero o
 * sparisce — e il nome tronca solo quando resta solo (NameLine, più sotto).
 * Il testo delle righe è text-body; i metadati — il tempo, «la tua chat», i
 * conteggi — text-caption: si leggono come informazioni accanto al nome, non
 * come nomi.
 */
const ROW = 'flex h-row-nav w-full items-center gap-2 rounded-control px-2 text-left text-body transition'
/** La riga di SOLO testo («Mostra tutti (N)», «Altri N»): 36 come le altre, grigia, e lo stesso andamento della riga con lo slot. */
const ROW_TEXT = 'flex h-row-nav w-full items-center gap-2 rounded-control px-2 text-left text-body text-muted-foreground transition hover:bg-muted/60'
/** Il posto del segno davanti al nome: 20 per 20, col segno centrato dentro. */
const SLOT = 'grid size-5 shrink-0 place-items-center'
/**
 * Le righe che hanno ANCHE bottoni a destra (la squadra con la freccia e il
 * «⋯», i bot e i membri col «⋯») sono in TRE parti:
 *  - l'involucro (ROW_SHELL): l'altezza, il fondo, il raggio, il menu col
 *    tasto destro;
 *  - il corpo (ROW_BODY), cioè il bottone del nome: si STIRA sull'altezza
 *    dell'involucro (self-stretch) — il clic prende tutta la riga, non solo
 *    la striscia del testo;
 *  - la casella delle azioni (ROW_ACTIONS): i bottoni in coda.
 */
const ROW_SHELL = 'group flex h-row-nav items-center gap-1 rounded-control px-2 transition'
const ROW_BODY = 'flex min-w-0 flex-1 self-stretch items-center gap-2 text-left text-body'
/**
 * La casella dei bottoni in coda a una riga. VISTO DAL VIVO (barra da 264):
 * «›» e «⋯» da 32 occupavano 72 px, e col tempo fisso al nome di «Weekend
 * Torino» ne restavano 64 — usciva «Weeken…» accanto a un tempo intero: la
 * gerarchia al contrario. Ora ogni bottone OCCUPA 16 e DISEGNA 32 (-mx-2:
 * otto px in meno per lato, presi dal respiro della riga e dallo spazio che
 * ha davanti), e qui fra un bottone e l'altro ci sono 16 px: due caselle da
 * 16 con 16 in mezzo mettono i cerchi TANGENTI, i centri a 32 px, e tutti e
 * due restano cliccabili per intero. (Con i 4 px dell'involucro si
 * coprirebbero per 12: la «›» resterebbe cliccabile per 20 px su 32.)
 * La coppia scende così a 52 px, il «⋯» da solo a 20.
 */
const ROW_ACTIONS = 'flex shrink-0 items-center gap-4'
/** I metadati a destra del nome. Non si restringono mai: o ci stanno o non ci sono (vedi NameLine). */
const META = 'shrink-0 text-caption text-muted-foreground'
/**
 * Un CONTEGGIO che avvisa («3 ti aspettano»): ambra come il pallino
 * dell'icona. È un segnale, non un metadato: grigio non direbbe più niente
 * (per le squadre è l'unico segno che qualcuno aspetta te).
 */
const COUNT = 'shrink-0 text-caption font-medium tabular-nums text-waiting'
/**
 * Un bottone di SOLO icona dentro le righe: tondo, DISEGNA 32 (il bersaglio),
 * con l'icona di 16 — la stessa figura delle icone della testata (DS3).
 * Porta -mx-2: nella riga OCCUPA 16; gli altri 16 li disegna sopra lo
 * spazio che la riga ha attorno. Il perché sta su ROW_ACTIONS.
 */
const ROW_BUTTON = '-mx-2 grid size-control-sm shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground'
/**
 * Una voce della ROTAIa (la barra chiusa, 76 px): lo stesso bottone tondo da
 * 32, con l'icona di 16, il robottino o il cerchio del bot centrati dentro.
 * `relative` perché sul suo angolo può stare un conteggio (BADGE).
 */
const RAIL_BUTTON = 'relative grid size-control-sm shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground'
/**
 * Il CONTEGGIO sull'angolo di una voce della rotaia (le richieste da
 * approvare in ambra, i non letti in primo piano). Una pallina da 20: la
 * cifra è text-caption — 12 px, la misura più piccola che l'interfaccia
 * concede — e in 20 ci sta, in meno no. Mai più stretta della cifra: un
 * numero spezzato non si legge.
 *
 * Sta sullo spigolo del bottone (8 px fuori: il suo centro è lo spigolo
 * stesso), non addentato su di lui. Col bottone a 32 e l'icona a 16 lo
 * spigolo dell'icona è a 8 px da quello del bottone: la pallina copre
 * dell'icona solo il suo angolo, 4 per 4 — com'era con il bottone da 36.
 */
const BADGE = 'absolute -right-2 -top-2 grid h-5 min-w-5 place-items-center rounded-full px-1 text-caption font-semibold tabular-nums text-background'

/**
 * Fase design (DS4): IL TITOLO DI GRUPPO («Team», «Bot», le sezioni dei
 * bot): text-caption grigio, peso 500 — si legge come un'intestazione, non
 * come un titolo (i titoli sono più grandi e stanno altrove).
 *
 * La riga è alta 32 (h-control-sm) FISSA, anche quando non ha l'azione: il
 * «+» della squadra è un bottone da 32, e se la riga crescesse solo quando
 * c'è lui, «Team» starebbe ad altre distanze dalle righe rispetto a «Bot».
 * Per lo stesso motivo i margini si leggono attorno alla RIGA, non al testo
 * (che sta nel mezzo di essa): 16 sopra (mt-block) e 4 sotto (mb-1), cioè 12
 * fra il testo del titolo e la prima riga — la distanza che DS1 dà fra un
 * titolo di sezione e il suo contenuto.
 *
 * In orizzontale il testo comincia dove cominciano le ICONE delle righe (24
 * dal bordo della barra: 8 dell'elenco, 8 del respiro, 8 fra lo slot e
 * l'icona che vi è centrata): è il filo che si vede. Il «+» a destra chiude
 * dove chiudono i bottoni in coda alle righe: anche lui occupa 16 e disegna
 * 32, e siccome il suo cerchio sporge di 8 sul lato del testo, dal testo lo
 * tengono 16 (gap-4) — ne restano 8 fra un titolo troncato e il cerchio.
 * Niente maiuscoletto: lo vietano le regole, e a 12 px non servirebbe.
 */
function Title({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-1 mt-block flex h-control-sm items-center gap-4 pl-4 pr-2">
      <p className="min-w-0 flex-1 truncate text-caption font-medium text-muted-foreground">{children}</p>
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
      <span className={SLOT}>
        <Plus className="size-5" />
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
      <span className={SLOT}>
        {/* il pallino sta sull'angolo dell'ICONA (16), non dello slot (32):
            per questo l'icona ha la sua casella, di 16, relativa */}
        <span className="relative grid size-5 place-items-center">
          <ShieldCheck className="size-5" />
          {count > 0 && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-waiting" aria-hidden="true" />}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate"><Trans>Da approvare</Trans></span>
      {/* il conteggio resta AMBRA: non è un metadato qualunque, è il segnale
          «c'è chi aspetta te» — lo stesso del pallino sull'icona. Perde il
          corpo grosso (600): a 12 px conta il colore, non il peso */}
      {count > 0 && <span className={COUNT}>{count}</span>}
    </button>
  )
}

/**
 * Il robottino piccolo della squadra: famiglia e colore del coordinatore — e
 * lo stato AGGREGATO della squadra (R2): respira ~2 s e ha i tre puntini blu
 * se lavora; occhi più grandi e pallino arancio con l'onda se aspetta te (lo
 * stato waiting del Bot); un saltello solo se finito; respiro lento se fermo.
 * Tutto con i keyframes che la mascotte usa già. Nella barra LARGA è alto 20
 * come ogni avatar di riga (R3 b20-ritocchi); nella ROTAIa resta 16.
 */
function TeamRobot({ team, size = 20 }: { team: SidebarTeam; size?: number }) {
  const { i18n } = useLingui()
  const coordInfo = useBotInfo(team.coordinator?.id ?? null)
  if (!coordInfo) {
    // senza il coordinatore non c'è mascotte: al suo posto un cerchio neutro
    // con l'iniziale. 20, non meno: la lettera è text-caption (12 px), la
    // misura più piccola che l'interfaccia concede, e in 14 non ci starebbe
    return <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-caption font-medium text-muted-foreground">{team.group.name.slice(0, 1)}</span>
  }
  const botState: BotState =
    team.state === 'aspetta-te' ? 'waiting' : team.state === 'finito' ? 'happy' : 'idle'
  return (
    <span className={`side-robot side-robot--${team.state}`} role="img" aria-label={i18n.t(rowStateName(team.state))}>
      <Bot family={coordInfo.avatar.family} color={coordInfo.avatar.color} state={botState} size={size} track={false} dimmed={coordInfo.dimmed} />
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

/**
 * Il pallino del colore del bot: decorativo, 8 px (aria-hidden). R5
 * (b20-ritocchi): usa la PALETTE DEI PUNTINI (--bot-dot-*), non quella della
 * mascotte — la tinta è quella del bot, la luminosità è tarata per tema
 * perché su 8 px il contrasto si vede (≥ 3:1 sul fondo della riga).
 */
function ColorDot({ agent }: { agent: Agent }) {
  const agents = useStore((s) => s.agents)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const av = avatarOf(agent, agents, mainAgentId ?? agents[0]?.id ?? null)
  return (
    <span
      data-testid="bot-dot-color"
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ background: `var(--bot-dot-${av.color})` }}
    />
  )
}

/**
 * La riga del bot PRINCIPALE: l'unica con la mascotte (22 px, nello slot da
 * 32 come ogni altro segno) e «la tua chat» a destra. L'anteprima e lo stato
 * vivono nel suggerimento. Il nome pesa 500 — è il titolo di riga, come i
 * nomi delle squadre aperte: i 600 di prima sono dei titoli veri (dialoghi,
 * sezioni), non dei nomi in un elenco.
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
      className={`${ROW} ${agent.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60'}`}
      title={tip}
    >
      <span className={SLOT}>
        <Bot family={info.avatar.family} color={info.avatar.color} state={state} size={20} track={false} dimmed={info.dimmed} label={agent.name} />
      </span>
      <NameLine time={<span className={META}><Trans>la tua chat</Trans></span>}>
        <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
      </NameLine>
    </button>
  )
}

/**
 * Il tempo dell'ultima attività, a destra del nome. Non si restringe e non
 * si tronca: o c'è intero o non c'è (il come sta su NameLine).
 */
function RowTime({ at, now }: { at: number | null; now: number }): React.ReactNode {
  return <span className={`${META} tabular-nums`}>{i18n.t(timeAgoShort(at, now))}</span>
}

/**
 * LA RIGA DEL NOME — fase design (DS4), dal vivo: in una barra da 264
 * «Weekend Torino» usciva «Weeken…» col tempo intero accanto. È la gerarchia
 * al contrario: il nome è la cosa principale, il tempo è secondario. Qui il
 * NOME VINCE SUL TEMPO. La riga ha due pezzi:
 *
 *   [ciò che deve restare: il nome, e ciò che gli sta attaccato] [il tempo]
 *
 * La riga VA A CAPO (flex-wrap) e ne mostra UNA SOLA (alta una riga di
 * text-body, con overflow-hidden). Andare a capo si decide sulle larghezze
 * PIENE dei pezzi: se il nome intero e il tempo non ci stanno insieme, il
 * tempo passa alla riga sotto — e non si vede. Così non esiste «ad…»: il
 * tempo non si tronca mai, sparisce. Il nome tronca, ma SOLO quando è lui
 * da solo a non starci — cioè quando il tempo se n'è già andato.
 *
 * PERCHÉ «ciò che deve restare» è flex-auto e non flex-1: la decisione di
 * andare a capo confronta la BASE di ogni pezzo. Con flex-1 la base è zero:
 * la riga crederebbe di avere tutto lo spazio, il tempo ci «starebbe»
 * sempre, e a cedere sarebbe il nome. Con flex-auto la base è la larghezza
 * vera del nome — che però può stringersi (min-w-0) quando resta solo.
 *
 * Fuori da questa riga restano due cose: il SEGNO di stato (è un segnale,
 * non un metadato: non sparisce mai) e il campo della rinomina (è alto 32:
 * non sta in una riga che taglia a 20).
 */
const ROW_LINE = 'flex h-5 min-w-0 flex-1 flex-wrap items-center gap-2 overflow-hidden'
const ROW_HEAD = 'flex min-w-0 flex-auto items-center gap-2'

/** `children` è ciò che deve restare (il nome, e il conteggio che gli sta attaccato); `time` è ciò che sparisce per primo. */
function NameLine({ children, time }: { children: React.ReactNode; time?: React.ReactNode }): React.ReactNode {
  return (
    <span className={ROW_LINE}>
      <span className={ROW_HEAD}>{children}</span>
      {time}
    </span>
  )
}

/**
 * K2 (fase team-bot): la rinomina IN LINEA — il nome della riga diventa un
 * campo; Invio salva, Esc (e la sfocatura) annullano. Ci arriva dal
 * «Rinomina» del menu della riga e dal doppio clic sul nome (K3).
 */
function InlineName({ name, testid, onCommit, onCancel }: { name: string; testid: string; onCommit(v: string): void; onCancel(): void }) {
  const [v, setV] = useState(name)
  return (
    <input
      data-testid={testid}
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(v.trim() || name)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCancel()}
      // fase design (DS4): un campo da 32 (h-control-sm), come ogni controllo
      // piccolo. Fondo CARD col bordo, non fondo muted: la riga che si rinomina
      // è quasi sempre quella attiva, che ha già il fondo muted — il campo ci
      // spariva dentro e restava il solo cursore a dire che si stava scrivendo
      className="no-drag h-control-sm min-w-0 flex-1 rounded-control border border-input bg-card px-2 text-body outline-none"
    />
  )
}

/**
 * K2 (fase team-bot): il menu della riga per bot e team — si apre col
 * bottone «⋯» (visibile al passaggio del mouse, gruppo `group` sulla riga) e
 * con il TASTO DESTRO sulla riga stessa (onContextMenu del contenitore, che
 * comanda questo stato `open`). Voci: Rinomina · Archivia · Elimina; per i
 * team anche «Apri impostazioni del team» (autonomia e membri). Il bot
 * PRINCIPALE non lo riceve mai.
 */
function RowMenu(props: {
  open: boolean
  onOpenChange(v: boolean): void
  agentId?: string
  groupId?: number
  onRename(): void
  onArchive(): void
  onDelete(): void
  /** solo per i team: autonomia e membri */
  onSettings?: () => void
}) {
  const { t } = useLingui()
  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          data-testid="row-more"
          {...(props.agentId !== undefined ? { 'data-agent': props.agentId } : {})}
          {...(props.groupId !== undefined ? { 'data-group': String(props.groupId) } : {})}
          className={cn(ROW_BUTTON, 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
          aria-label={t`Altre azioni`}
          title={t`Altre azioni`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
        {props.onSettings && (
          <>
            <DropdownMenuItem onClick={props.onSettings}><Trans>Apri impostazioni del team</Trans></DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={props.onRename}><Trans>Rinomina</Trans></DropdownMenuItem>
        <DropdownMenuItem onClick={props.onArchive}><Trans>Archivia</Trans></DropdownMenuItem>
        {/* la variante del pezzo, non le classi a mano: il menu sa già come si
            vede una voce distruttiva (rossa, ed evidenziata in rosso quando la
            si scorre col puntatore o con la tastiera). Prima stavano qui
            `text-destructive` e la variante focus: della stessa cosa — e focus:
            in questa base non si scrive (B5: l'anello del fuoco solo da tastiera) */}
        <DropdownMenuItem variant="destructive" onClick={props.onDelete}><Trans>Elimina</Trans></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * K2 (fase team-bot): la conferma chiara dell'eliminazione — cosa si
 * cancella e cosa RESTA, la casella (solo per i team, spenta di default) per
 * portare via anche i bot creati per quel team. Chi conferma passa dallo
 * stesso percorso del menu: l'avviso «Eliminato · Annulla» per 10 secondi e
 * il recupero di 30 giorni.
 */
function DeleteConfirmDialog({ target, onClose }: { target: { kind: 'bot'; id: string; name: string } | { kind: 'team'; id: number; name: string }; onClose(): void }) {
  const [alsoMembers, setAlsoMembers] = useState(false)
  const isTeam = target.kind === 'team'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" data-testid="delete-confirm">
        <DialogHeader>
          <DialogTitle className="text-title">
            {isTeam ? <Trans>Elimina il team {target.name}?</Trans> : <Trans>Elimina {target.name}?</Trans>}
          </DialogTitle>
          <DialogDescription className="text-left text-small">
            {isTeam
              ? <Trans>Si cancellano la timeline del team e le sue impostazioni. I bot restano.</Trans>
              : <Trans>Si cancellano la sua chat, la memoria e le routine. I documenti nella Libreria restano.</Trans>}
          </DialogDescription>
        </DialogHeader>
        {isTeam && (
          // una riga-cella da 36, come un campo: il raggio dei controlli (le superfici da 14 sono delle schede)
          <label className="flex h-control cursor-pointer items-center gap-3 rounded-control bg-muted px-3 text-body">
            <input
              type="checkbox"
              checked={alsoMembers}
              data-testid="delete-confirm-members"
              onChange={(e) => setAlsoMembers(e.target.checked)}
            />
            <Trans>Elimina anche i bot creati per questo team</Trans>
          </label>
        )}
        <DialogFooter>
          {/* fase design (DS4): i bottoni del pezzo unico (Button), 36, text-body
              — prima erano due bottoni scritti a mano. «Elimina» è la variante
              distruttiva del sistema: piena, non un velo rosso su fondo chiaro */}
          <Button variant="secondary" data-testid="delete-confirm-cancel" onClick={onClose}>
            <Trans>Annulla</Trans>
          </Button>
          <Button
            variant="destructive"
            data-testid="delete-confirm-ok"
            onClick={() => {
              const s = useStore.getState()
              if (isTeam) void s.groupDeleteWithUndo((target as { id: number }).id, alsoMembers)
              else void s.deleteAgentWithUndo((target as { id: string }).id)
              onClose()
            }}
          >
            <Trans>Elimina</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
      // S3 (fase isolamento-suite): nome e id, per l'ordine fisso a parità
      id: m.id,
      name: m.name,
      member: m,
      waiting: states[m.id] === 'waiting',
      // M4 (fase beta12-correzioni): chi lavora adesso conta per l'ordine
      works: states[m.id] === 'thinking' || states[m.id] === 'speaking' || states[m.id] === 'listening',
      lastAt: lastSendAt[m.id] ?? m.createdAt
    }))
  )
  // K2 (fase team-bot): il menu della riga del team («⋯» e tasto destro),
  // la rinomina in linea e la conferma dell'eliminazione
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const commitRename = (v: string): void => {
    setRenaming(false)
    if (v && v !== team.group.name) {
      void api.groupUpdate(team.group.id, { name: v }).catch(() => undefined)
      useStore.setState({ groups: useStore.getState().groups.map((g) => (g.id === team.group.id ? { ...g, name: v } : g)) })
    }
  }
  const cut = memberCut(members, allMembers)
  const tip = team.group.description
    ? `${team.group.name} · ${team.group.description}`
    : team.group.name
  return (
    <div>
      <div
        className={cn(ROW_SHELL, openGroupId === team.group.id ? 'bg-muted' : 'hover:bg-muted/60')}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
      >
        <button
          className={ROW_BODY}
          onClick={() => {
            // K3 (fase team-bot): il clic sul nome apre la chat E i membri di
            // un team non attivo; sul team GIÀ attivo apre/chiude i membri
            // (la freccia resta la scorciatoia di sempre, lo stato si salva
            // come oggi in sandbot:sidebar.teamOpen.<id>)
            if (openGroupId !== team.group.id) {
              openGroup(team.group.id)
              setOpen(true)
              writeLS(`${TEAM_OPEN_PREFIX}${team.group.id}`, '1')
            } else {
              const next = !open
              setOpen(next)
              writeLS(`${TEAM_OPEN_PREFIX}${team.group.id}`, next ? '1' : '0')
            }
          }}
          title={tip}
        >
          <span className={SLOT}><TeamRobot team={team} /></span>
          {renaming
            ? <InlineName name={team.group.name} testid="team-rename" onCommit={commitRename} onCancel={() => setRenaming(false)} />
            : (
              <NameLine time={<RowTime at={team.lastAt} now={now} />}>
                <span
                  className={cn('min-w-0 flex-1 truncate', (open || openGroupId === team.group.id) && 'font-medium')}
                  onDoubleClick={() => setRenaming(true)}
                >{team.group.name}</span>
                {/* il conteggio di chi aspetta sta col NOME, non col tempo:
                    sparisce il tempo, mai lui (a 8 px dal nome, come prima) */}
                {team.waitingCount > 0 && (
                  <span className={COUNT} aria-label={i18n.t(msg`${team.waitingCount} ti aspettano`)}>{team.waitingCount}</span>
                )}
              </NameLine>
            )}
          {/* mentre si rinomina il campo prende il posto della riga del nome; il tempo gli resta accanto, com'era */}
          {renaming && <RowTime at={team.lastAt} now={now} />}
        </button>
        <span className={ROW_ACTIONS}>
          {team.members.length > 0 && (
            // la freccia gira col BOTTONE (tondo: girato non si vede), così
            // l'icona porta la sua misura scritta in lettere, come vuole la guardia
            <button
              className={cn(ROW_BUTTON, open && 'rotate-90')}
              aria-expanded={open}
              aria-label={open ? i18n.t(msg`Chiudi i membri di ${team.group.name}`) : i18n.t(msg`Apri i membri di ${team.group.name}`)}
              onClick={() => {
                const next = !open
                setOpen(next)
                writeLS(`${TEAM_OPEN_PREFIX}${team.group.id}`, next ? '1' : '0')
              }}
            >
              <ChevronRight className="size-4" />
            </button>
          )}
          <RowMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            groupId={team.group.id}
            onRename={() => setRenaming(true)}
            onArchive={() => void useStore.getState().groupArchive(team.group.id)}
            onDelete={() => setDeleting(true)}
            onSettings={() => openGroup(team.group.id)}
          />
        </span>
      </div>
      {deleting && <DeleteConfirmDialog target={{ kind: 'team', id: team.group.id, name: team.group.name }} onClose={() => setDeleting(false)} />}
      {open && (
        <div className="flex flex-col pl-5">
          {cut.visible.map(({ member }) => (
            <MemberRow key={member.id} member={member} state={states[member.id] ?? 'idle'} lastAt={lastSendAt[member.id] ?? member.createdAt} now={now} />
          ))}
          {members.length > TEAM_MEMBER_LIMIT && (
            <button
              className={ROW_TEXT}
              aria-expanded={allMembers}
              onClick={() => {
                const next = !allMembers
                setAllMembers(next)
                writeLS(`${SECTION_OPEN_PREFIX}members.${team.group.id}`, next ? '1' : '0')
              }}
            >
              <TextRowSlot />
              <span className="min-w-0 flex-1 truncate">{allMembers ? i18n.t(msg`Meno`) : i18n.t(msg`Altri ${cut.hidden}`)}</span>
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
  // K2 (fase team-bot): menu, rinomina in linea e conferma dell'eliminazione
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const preview = previews[member.id]
  const rs = rowStateOf(state)
  const tip = [typeof preview === 'string' ? preview : preview ? i18n.t(preview) : '', i18n.t(rowStateName(rs))].filter(Boolean).join(' · ')
  const commitRename = (v: string): void => {
    setRenaming(false)
    if (v && v !== member.name) {
      void api.updateAgent(member.id, { name: v }).catch(() => undefined)
      useStore.setState({ agents: useStore.getState().agents.map((a) => (a.id === member.id ? { ...a, name: v } : a)) })
    }
  }
  return (
    <div
      className={cn(ROW_SHELL, 'hover:bg-muted/60')}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
    >
      <button
        className={ROW_BODY}
        onClick={() => { openGroup(null); void select(member.id) }}
        title={tip || member.name}
      >
        <span className={SLOT}><ColorDot agent={member} /></span>
        {renaming
          ? <InlineName name={member.name} testid="member-rename" onCommit={commitRename} onCancel={() => setRenaming(false)} />
          : (
            <NameLine time={rs === 'fermo' ? <RowTime at={lastAt} now={now} /> : undefined}>
              <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setRenaming(true)}>{member.name}</span>
            </NameLine>
          )}
        {/* mentre si rinomina il tempo resta accanto al campo, com'era */}
        {renaming && rs === 'fermo' && <RowTime at={lastAt} now={now} />}
        {/* il segno di stato è un SEGNALE: non sparisce mai, e sta fuori dalla riga che va a capo */}
        {rs !== 'fermo' && <StateSign state={rs} className="shrink-0" />}
      </button>
      <span className={ROW_ACTIONS}>
        <RowMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          agentId={member.id}
          onRename={() => setRenaming(true)}
          onArchive={() => void useStore.getState().archiveAgent(member.id)}
          onDelete={() => setDeleting(true)}
        />
      </span>
      {deleting && <DeleteConfirmDialog target={{ kind: 'bot', id: member.id, name: member.name }} onClose={() => setDeleting(false)} />}
    </div>
  )
}

/** Un bot singolo: pallino del colore, nome, segno o tempo (tavola 6). */
function BotRow({ bot, now }: { bot: SidebarBot; now: number }) {
  const info = useBotInfo(bot.agent.id)
  const select = useStore((s) => s.select)
  const activeId = useStore((s) => s.activeId)
  const openGroupId = useStore((s) => s.openGroupId)
  const previews = useStore((s) => s.previews)
  // K2 (fase team-bot): menu della riga, rinomina in linea, conferma
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  if (!info) return null
  const preview = previews[bot.agent.id]
  const tip = [
    typeof preview === 'string' ? preview : preview ? i18n.t(preview) : i18n.t(info.statusText),
    i18n.t(rowStateName(rowStateOf(bot.state, bot.childWaiting)))
  ].filter(Boolean).join(' · ')
  const rs = rowStateOf(bot.state, bot.childWaiting)
  const commitRename = (v: string): void => {
    setRenaming(false)
    if (v && v !== bot.agent.name) {
      void api.updateAgent(bot.agent.id, { name: v }).catch(() => undefined)
      useStore.setState({ agents: useStore.getState().agents.map((a) => (a.id === bot.agent.id ? { ...a, name: v } : a)) })
    }
  }
  return (
    <div
      className={cn(ROW_SHELL, bot.agent.id === activeId && openGroupId === null ? 'bg-muted' : 'hover:bg-muted/60')}
      onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true) }}
    >
      <button
        onClick={() => void select(bot.agent.id)}
        className={ROW_BODY}
        title={tip}
      >
        <span className={SLOT}><ColorDot agent={bot.agent} /></span>
        {renaming
          ? <InlineName name={bot.agent.name} testid="bot-rename" onCommit={commitRename} onCancel={() => setRenaming(false)} />
          : (
            <NameLine time={rs === 'fermo' ? <RowTime at={bot.lastAt} now={now} /> : undefined}>
              <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setRenaming(true)}>{bot.agent.name}</span>
            </NameLine>
          )}
        {/* mentre si rinomina il tempo resta accanto al campo, com'era */}
        {renaming && rs === 'fermo' && <RowTime at={bot.lastAt} now={now} />}
        {/* il segno di stato è un SEGNALE: non sparisce mai, e sta fuori dalla riga che va a capo */}
        {rs !== 'fermo' && <StateSign state={rs} className="shrink-0" />}
      </button>
      <span className={ROW_ACTIONS}>
        <RowMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          agentId={bot.agent.id}
          onRename={() => setRenaming(true)}
          onArchive={() => void useStore.getState().archiveAgent(bot.agent.id)}
          onDelete={() => setDeleting(true)}
        />
      </span>
      {deleting && <DeleteConfirmDialog target={{ kind: 'bot', id: bot.agent.id, name: bot.agent.name }} onClose={() => setDeleting(false)} />}
    </div>
  )
}

/**
 * Lo slot VUOTO delle righe di solo testo. Una riga come «Mostra tutti (N)»
 * non ha un segno davanti, ma il suo testo deve cominciare dove cominciano i
 * NOMI delle righe sopra — è parte del loro elenco, non un'etichetta. Il
 * modo per averlo senza scrivere una misura a mano (52 px di padding non
 * sono nella scala) è lo stesso slot delle altre righe, vuoto.
 */
function TextRowSlot(): React.ReactNode {
  return <span className="grid size-5 shrink-0" aria-hidden="true" />
}

/** «Mostra tutti (N)» / «Mostra tutte (N)» — l'espansione della sezione
 *  (espansa, il bottone diventa «Meno» e la richiude). */
function ShowAllRow({ hidden, feminine, expanded, onToggle }: { hidden: number; feminine: boolean; expanded: boolean; onToggle(): void }) {
  const { i18n } = useLingui()
  const total = hidden + SIDEBAR_ROW_LIMIT
  return (
    <button
      className={ROW_TEXT}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <TextRowSlot />
      <span className="min-w-0 flex-1 truncate">
        {expanded
          ? i18n.t(msg`Meno`)
          : feminine
            ? i18n.t(msg`Mostra tutte (${total})`)
            : i18n.t(msg`Mostra tutti (${total})`)}
      </span>
    </button>
  )
}

/**
 * K2 (fase team-bot): la sezione «Archiviati» in fondo alla barra — chiusa
 * di default, col conteggio; dentro, i bot e i team archiviati (col loro
 * «Ripristina») e la sottosezione «Eliminati» (recuperabili per 30 giorni).
 */
function ArchivedSection({ model }: { model: SidebarModel }) {
  const open = useStore((s) => s.sidebarArchivedOpen)
  const setOpen = useStore((s) => s.setSidebarArchivedOpen)
  const r = model.removed
  const total = r.archivedTeams.length + r.archivedBots.length + r.deletedTeams.length + r.deletedBots.length
  if (total === 0) return null
  // fase design (DS4): le righe di «Archiviati» sono di solo testo (40), col
  // nome dove comincia il testo del titolo sotto cui stanno (48 px dal bordo
  // della barra: 32 di rientro più il respiro di 8 della riga)
  const restoreRow = (kind: 'agent' | 'group', id: string | number, name: string, deleted: boolean): React.ReactNode => (
    <div key={`${kind}-${id}`} className="flex h-row-nav items-center gap-2 rounded-control px-2 text-left text-body text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <Button variant="ghost" size="sm" data-testid={`archived-restore-${kind}-${id}`}
        onClick={() => {
          const s = useStore.getState()
          if (kind === 'group') void (deleted ? s.groupRestore(Number(id)) : s.groupUnarchive(Number(id)))
          else void (deleted ? s.restoreAgent(String(id)) : s.unarchiveAgent(String(id)))
        }}
      >
        <Trans>Ripristina</Trans>
      </Button>
    </div>
  )
  return (
    // «Archiviati» è un TITOLO DI GRUPPO in fondo alla barra (si apre e si
    // chiude come un gruppo): la stessa riga da 32, lo stesso testo, le
    // stesse distanze di «Team» e «Bot»
    <div className="mb-1 mt-block">
      <button
        className="flex h-control-sm w-full items-center gap-2 rounded-control pl-4 pr-2 text-left text-caption font-medium text-muted-foreground transition hover:text-foreground"
        aria-expanded={open}
        data-testid="archived-section"
        onClick={() => setOpen(!open)}
      >
        {/* la freccia gira nella sua casella: l'icona porta la misura scritta in lettere */}
        <span className={cn('grid size-4 shrink-0 place-items-center transition-transform', open && 'rotate-90')}>
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
        <Trans>Archiviati</Trans>
        <span className="tabular-nums">{total}</span>
      </button>
      {open && (
        <div className="flex flex-col pl-8">
          {r.archivedTeams.map((t) => restoreRow('group', t.id, t.name, false))}
          {r.archivedBots.map((a) => restoreRow('agent', a.id, a.name, false))}
          {(r.deletedTeams.length + r.deletedBots.length) > 0 && (
            <p className="flex h-control-sm items-center px-2 text-caption font-medium text-muted-foreground"><Trans>Eliminati</Trans></p>
          )}
          {r.deletedTeams.map((t) => restoreRow('group', t.id, t.name, true))}
          {r.deletedBots.map((a) => restoreRow('agent', a.id, a.name, true))}
        </div>
      )}
    </div>
  )
}

/**
 * K2 (fase team-bot): l'avviso dell'eliminazione — «Eliminato · <nome>» col
 * bottone «Annulla», per 10 secondi (lo spegne il timer dello store). Sta
 * in fondo alla barra, larga o stretta che sia.
 *
 * Fase design (DS4): una riga da 36 (h-control) col bottone da 32, text-body.
 * Sta sopra il blocco dell'account e non lo copre, in larga e in rotaia: 64
 * px dal fondo (bottom-16: la riga di 52 dell'account più il suo margine di
 * 12, in larga) e 16 ancora (mb-4) — 80 in tutto; in rotaia il blocco è alto
 * 68, e l'avviso gli resta 12 px sopra. Il bottone è INVERTITO
 * (chiaro su scuro): Button non ha questa variante, e qui si scrive a mano
 * con le sue stesse misure (32, pillola, text-body 500).
 *
 * In ROTAIa non può stare nella barra: 76 px meno i margini fanno 60, e il
 * solo bottone «Annulla» a 14 px ne misura circa 70 (prima, a 12 px, circa
 * 58: usciva già di qualche pixel). Largo quanto la ricerca sospesa (240),
 * sopra l'area accanto: si legge per intero e sparisce dopo 10 secondi.
 */
function RemovedUndoPill({ narrow = false }: { narrow?: boolean }) {
  const undo = useStore((s) => s.removedUndo)
  if (!undo) return null
  return (
    <div
      data-testid="removed-undo"
      className={cn('absolute bottom-16 left-2 z-40 mb-4 flex h-control items-center gap-2 rounded-surface bg-foreground pl-3 pr-1 text-background shadow-soft', narrow ? 'w-60' : 'right-2')}
    >
      <span className="min-w-0 flex-1 truncate text-body"><Trans>Eliminato</Trans> · {undo.name}</span>
      <button
        className="h-control-sm shrink-0 rounded-full bg-background/15 px-3 text-body font-medium transition hover:bg-background/25"
        onClick={() => void useStore.getState().undoRemoved()}
      >
        <Trans>Annulla</Trans>
      </button>
    </div>
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
      className={cn(RAIL_BUTTON, approvalsOpen && 'bg-muted text-foreground')}
      data-testid="rail-approvals"
      aria-label={count > 0 ? i18n.t(msg`Da approvare, ${count} richieste`) : i18n.t(msg`Da approvare`)}
      onClick={() => setApprovalsOpen(!approvalsOpen)}
    >
      <ShieldCheck className="size-4" />
      {count > 0 && (
        <span className={`${BADGE} bg-waiting`}>
          {count}
        </span>
      )}
    </button>
  )
}

/** PL1 (fase plugin): la voce «Plugin» della barra — la casa unica di
 *  connettori, server MCP e skill (tavola 8). Sta tra «Da approvare» e
 *  «Attività», con l'icona lucide Puzzle; apre la pagina che copre l'area
 *  centrale (la apre openPlugin, che chiude le altre viste: regola B1). */
function PluginRow() {
  const pluginOpen = useStore((s) => s.pluginOpen)
  const openPlugin = useStore((s) => s.openPlugin)
  return (
    <button
      className={`${ROW} ${pluginOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
      data-testid="sidebar-plugin"
      onClick={() => openPlugin()}
    >
      <span className={SLOT}>
        <Puzzle className="size-5" />
      </span>
      <span className="min-w-0 flex-1 truncate"><Trans>Plugin</Trans></span>
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
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null
  const main = agents.find((a) => a.id === effectiveMain)
  // fase 16c correzioni (R4): il modello mostrato è quello RISOLTO, dal
  // selettore UNICO («Come gli altri» compreso)
  const resolved = useResolvedModel(main?.id ?? null)
  // U3 (fase pulizia · ritocchi): una voce che APRE una finestra (App, Skill,
  // Impostazioni) lo segna qui, e alla chiusura il menu NON riprende il focus
  // sul suo trigger: il focus è della finestra (il campo di ricerca).
  // B5 (fase b20-bug): sul trigger non c'è più la variante `focus:` davanti a
  // `outline-none` — toglieva l'anello anche alla TASTIERA. Ci pensa la regola
  // unica di styles.css: al clic nessun anello, con Tab quello nativo, come le
  // righe qui accanto.
  const openedWindow = useRef(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="account-menu-trigger"
        className={
          props?.triggerClassName ??
          'flex min-w-0 flex-1 self-stretch items-center gap-row-gap rounded-control px-2 text-left transition hover:bg-muted/60'
        }
      >
        {/* fase design (DS4). In rotaia il bottone È il cerchio (da 32, con la
            sola iniziale, text-body). Nel resto della barra è una riga come le
            altre: il cerchio dell'iniziale (24, lettera text-caption) sta
            nello slot da 32, così nome e modello cominciano dove cominciano i
            nomi delle righe sopra; il bottone si stira sull'altezza della riga
            di 52 in cui sta, e il clic prende tutto */}
        {props?.rail ? (
          <span className="text-body font-medium text-foreground">
            {main ? main.name.slice(0, 1).toUpperCase() : '·'}
          </span>
        ) : (
          <span className={SLOT}>
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-caption font-medium text-foreground">
              {main ? main.name.slice(0, 1).toUpperCase() : '·'}
            </span>
          </span>
        )}
        {!props?.rail && (
          <span className="min-w-0 text-body">
            <span className="block truncate font-medium">{main ? main.name : t`nessun bot`}</span>
            <span className="block truncate text-caption text-muted-foreground">
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
        {/* PL1 (fase plugin): «Collega app», «Skill» e «Server MCP» non ci
            sono più — la casa è la pagina «Plugin» della barra; dal menu
            restano Impostazioni e il resto */}
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

/**
 * Il cerchio 22 px del bot nella ROTAIa: colore del bot + iniziale.
 *
 * Fase design (DS4): il diametro resta 22 — è «il cerchio del bot», non una
 * misura della barra — ma 22 non è sulla scala, quindi non si scrive in una
 * classe libera: sta nello stile in linea, come la larghezza della barra e
 * la misura della mascotte (che sono numeri, non classi). La lettera è
 * text-caption (12 px): la misura più piccola che l'interfaccia concede, e
 * in 22 ci sta. `data-size` resta: lo leggono le sonde.
 */
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
        className="grid shrink-0 place-items-center rounded-full text-caption font-semibold text-background"
        style={{ width: 22, height: 22, background: `var(--bot-dot-${av.color})` }}
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
  // PL1 (fase plugin): la voce della rotaia — anche nella barra stretta
  const pluginOpen = useStore((s) => s.pluginOpen)
  const openPlugin = useStore((s) => s.openPlugin)
  const voices = collapsedVoices(model)
  const stateName = (st: RowState): string => i18n.t(rowStateName(st))
  return (
    <>
      {/* fase 16b correzioni 2 (Q3): in rotaia i semafori occupano la cima —
          la fascia di trascinamento finisce dove inizia la prima voce. Fase
          design (DS3): è la riga di 52 di OGNI colonna; qui dentro non ci
          stanno icone (il bottone della barra resta sopra le colonne, da
          fuori: la rotaia è 76 px) */}
      <div data-col-head="barra" className="drag-region h-col-head shrink-0" aria-hidden="true" />
      {/* fase design (DS4): ogni voce della rotaia è un bottone tondo da 32
          (RAIL_BUTTON) — l'icona di 16, il robottino, o il cerchio del bot
          (22) CENTRATI dentro. Prima le icone stavano in 36 e i cerchi in
          niente: ora ogni voce ha la stessa zona di clic e lo stesso passo
          (32 più 6 di gap-1.5) */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto scroll-thin px-2 pt-2">
        {/* le voci fisse come icone, nell'ordine della barra larga — il «+»
            apre SUBITO il dialogo «Nuovo» (B2 fase beta.4) */}
        <button
          className={RAIL_BUTTON}
          aria-label={i18n.t(msg`Crea`)}
          title={i18n.t(msg`Crea`)}
          onClick={onNewBot}
        >
          <Plus className="size-4" />
        </button>
        {model.main && (
          <button
            className={RAIL_BUTTON}
            aria-label={`${model.main.name}, ${i18n.t(msg`la tua chat`)}` }
            title={model.main.name}
            onClick={() => { openGroup(null); void select(model.main!.id) }}
          >
            <RailBotCircle agent={model.main} state={states[model.main.id] ?? 'idle'} />
          </button>
        )}
        <RailApprovals />
        {/* PL1 (fase plugin): anche nella barra stretta, tra «Da approvare»
            e «Attività» — al posto del vecchio bottone «App» in fondo */}
        <button
          className={cn(RAIL_BUTTON, pluginOpen && 'bg-muted text-foreground')}
          data-testid="rail-plugin"
          aria-label={i18n.t(msg`Plugin`)}
          title={i18n.t(msg`Plugin`)}
          onClick={() => openPlugin()}
        >
          <Puzzle className="size-4" />
        </button>
        <button
          className={cn(RAIL_BUTTON, activityOpen && 'bg-muted text-foreground')}
          aria-label={i18n.t(msg`Attività`)}
          title={i18n.t(msg`Attività`)}
          onClick={() => setActivityOpen(!activityOpen)}
        >
          <ActivityIcon className="size-4" />
        </button>
        <button
          className={RAIL_BUTTON}
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
            className={RAIL_BUTTON}
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
              <TeamRobot team={model.teams.find((t) => `g${t.group.id}` === v.key)!} size={16} />
            ) : (
              <RailBotCircle agent={model.bots.find((b) => b.agent.id === v.key)!.agent} state={states[v.key] ?? 'idle'} />
            )}
            {v.counter > 0 && (
              <span className={`${BADGE} bg-foreground`}>
                {v.counter}
              </span>
            )}
          </button>
        ))}
        <span className="my-1 h-px w-6 shrink-0 bg-border/60" aria-hidden="true" />
        {/* R7: la lente di Cerca — apre la ricerca sospesa in alto a sinistra */}
        <button
          className={cn(RAIL_BUTTON, searchOpen && 'bg-muted text-foreground')}
          aria-label={i18n.t(msg`Cerca`)}
          title={i18n.t(msg`Cerca`)}
          onClick={onSearch}
        >
          <Search className="size-4" />
        </button>
        <div className="flex-1" />
        {/* PL1 (fase plugin): il vecchio bottone «App» della rotaia non c'è
            più — la pagina «Plugin» sta tra le voci fisse qui sopra */}
        {/* fase 16b correzioni 2 (Q3): la riga dell'utente, con 16 di margine
            sotto — lo stesso centro verticale della pillola della chat. Fase
            design (DS4): alta 52 come la testata (h-col-head: prima 60), così
            in cima e in fondo alla rotaia c'è la stessa riga, e il bottone
            dell'account è da 32 come ogni voce */}
        <div className="mb-4 flex h-col-head shrink-0 items-center justify-center">
          <AccountMenu
            rail
            triggerClassName="grid size-control-sm shrink-0 place-items-center rounded-full bg-muted text-body font-medium text-foreground transition hover:bg-muted/70"
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
          {/* fase 16b correzioni 2 (Q3): Cerca e Crea sulla riga in cima; fase
              design (DS3): la testata è la riga di 52 di OGNI colonna, la
              fascia di trascinamento, e sul suo centro stanno i semafori di
              macOS: il bottone della barra è la PRIMA icona, a 12 px dai
              semafori (SIDEBAR_HEAD_PAD: la stessa costante che legge il
              main); Cerca e Crea restano allineati a destra. Le icone stanno
              in bottoni da 32 (size-control-sm) */}
          <div data-col-head="barra" className="drag-region flex h-col-head shrink-0 items-center gap-2 px-3" style={{ paddingLeft: SIDEBAR_HEAD_PAD }}>
            <SidebarToggleButton layout={layout} />
            <span className="flex-1" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <button
                className={`no-drag grid size-control-sm place-items-center rounded-full transition ${searchOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
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
                className="no-drag grid size-control-sm place-items-center rounded-full text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                aria-label={t`Crea`}
                title={t`Crea`}
                onClick={() => setNewBotOpen(true)}
              >
                <Plus className="size-4" />
              </button>
            </div>
          </div>
          {searchOpen && (
            // fase design (DS4): il campo è un controllo — 36 di altezza, il
            // raggio dei controlli, text-body — e sta tra gli STESSI bordi del
            // fondo delle righe (8 px dai lembi della barra): campo e riga
            // attiva sono due superfici uguali, e si vede
            <div className="px-2 pb-2">
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
                className="no-drag h-control w-full rounded-control bg-muted px-3 text-body outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          {/* Le voci fisse in cima, nell'ordine della tavola 6: Nuovo, Bot (la
              tua chat), Da approvare, Plugin, Attività, Libreria. pt-1: 4 px
              di respiro fra la testata e la prima riga. Il respiro laterale è
              px-2 qui e px-2 su ogni riga: 8 + 8 */}
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
            {/* PL1 (fase plugin): la voce «Plugin» tra «Da approvare» e
                «Attività» (tavola 8) — la casa unica dei collegamenti */}
            <PluginRow />
            <button
              className={`${ROW} ${
                activityOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
              onClick={() => { setActivityOpen(!activityOpen); if (!activityOpen) openLibrary(null) }}
            >
              <span className={SLOT}>
                <ActivityIcon className="size-5" />
              </span>
              <span className="min-w-0 flex-1 truncate"><Trans>Attività</Trans></span>
            </button>
            <button
              className={`${ROW} ${
                openLibraryId !== null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
              }`}
              onClick={() => { openLibraryId === null ? openLibrary('') : openLibrary(null); if (openLibraryId === null) setActivityOpen(false) }}
            >
              <span className={SLOT}>
                <LibraryIcon className="size-5" />
              </span>
              <span className="min-w-0 flex-1 truncate"><Trans>Libreria</Trans></span>
            </button>

            {model.teams.length > 0 && (
              <Title action={
                /* B2 (fase beta.4): la squadra NASCE IN CHAT, non da un menu —
                   il «+» della tavola 6 apre il dialogo «Nuovo» del BOT.
                   R2 (fase linguaggio-ritocchi): il suo nome è «Nuovo bot»,
                   non «Crea» come il + della riga di ricerca — due controlli
                   visibili con lo stesso nome li prende il controllo dei
                   duplicati della galleria */
                <button
                  className={ROW_BUTTON}
                  aria-label={t`Nuovo bot`}
                  title={t`Nuovo bot`}
                  onClick={() => setNewBotOpen(true)}
                >
                  <Plus className="size-4" />
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

            {/* K2 (fase team-bot): «Archiviati» in fondo — chiusa di default */}
            <ArchivedSection model={model} />
          </nav>

          {/* fase barra-sobria (R1): in fondo CHI SEI, il modello e
              l'ingranaggio — tutto nell'AccountMenu (tavola 6). Fase design
              (DS4): alta come la testata (h-col-head), l'ultima riga della
              griglia dei 52 */}
          <div className="mb-3 flex h-col-head shrink-0 items-center px-2">
            <AccountMenu />
          </div>
        </>
      )}

      {/* K2 (fase team-bot): l'avviso «Eliminato · Annulla» (10 secondi); in
          rotaia è largo come la ricerca sospesa: nella barra non ci starebbe */}
      <RemovedUndoPill narrow={collapsed} />

      {/* fase 16c correzioni (R7): la ricerca della rotaia, sospesa in alto a
          sinistra (sopra le voci); filtra le voci come nella barra larga. Fase
          design (DS4): il campo è lo stesso controllo della barra larga (36,
          raggio dei controlli, text-body); sta 12 px sotto la riga dei 52 */}
      {collapsed && searchOpen && (
        <div className="absolute left-2 top-16 z-30 w-60">
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
            className="no-drag h-control w-full rounded-control bg-card px-3 text-body shadow-soft outline-none placeholder:text-muted-foreground"
          />
        </div>
      )}

      {newBotOpen && <NewBotDialog onClose={() => setNewBotOpen(false)} />}
    </aside>
  )
}
