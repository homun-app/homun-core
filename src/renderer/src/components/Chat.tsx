// Chat (fase 16b, S3): niente testata. Al centro in alto un'etichetta sospesa
// (mascotte 24 px + nome); in alto a destra il bottone tondo del pannello del
// bot. I chip di oggi escono dalla testata: Memoria e Skill nel Profilo del
// pannello, Ragionamento nel campo di scrittura, Chiedi al volo con ⌘K,
// Computer nella scheda del pannello. Le voci tool-call/tool-result NON
// compaiono più: mentre il bot lavora lo racconta la MASCOTTE con la mezza
// riga d'attività (activityPhrase) e col popover dei passaggi; dopo il turno
// li rimette solo la voce di debug di Impostazioni › Generali. U1 (fase
// prima-release): sotto il messaggio resta il solo «Copia» con la spunta.
//
// Fase design (DS4, Chat): la pagina passa al sistema di DS1.
//  - LA COLONNA. Il transcript scorre in un contenitore largo quanto l'area
//    (la barra di scorrimento sta sul bordo) e DENTRO il contenuto è centrato
//    alla larghezza di lettura (PageColumn reading: 720 px, l'area meno i
//    margini se è più stretta). Il campo di scrittura sta in una PageColumn
//    reading sua: stessa larghezza, stesso centro.
//  - I MESSAGGI in text-reading; la bolla dell'utente al massimo all'85%.
//  - LO STESSO MARKDOWN per ogni testo di bot: BotMarkdown (DocumentMarkdown).
//  - LE RIGHE DI SISTEMA con Notice (components/ui/notice): prima erano
//    scritte a mano, una per tipo, ognuna con le sue misure.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import {
  Paperclip, PanelRight, ArrowUp, Square, Copy, Check, Brain, ScrollText,
  X, Circle, CircleAlert, TriangleAlert, Info, Wrench, History, Cpu, LayoutTemplate, FileText, SquareTerminal, ChevronRight,
  type LucideIcon
} from 'lucide-react'
import { api, useStore, useResolvedModel } from '../store'
// fase 17c (C2): il testo di notice/eventi/system dal meta.ui (lingua attiva)
import { uiTextOf, uiTextOfTools } from '../lib/ui-text'
// M2 (fase 0.3.1001): l'apertura di un turno con initiator è una riga di sistema
// B2 (fase b20-bug): le righe invisibili (ragionamento, fine turno) non contano per raccogliere gli avvisi
import { chatRowHidden, type ChatRowView } from '../lib/chat-rows'
import { openingRowFor } from '../lib/opening-rows'
// R1 (fase app — ritocchi): le notice in chat non sono tutte errori
import { noticeSeverity, type NoticeSeverity } from '../lib/notice-severity'
// RV4 (fase beta.2): la stessa notice consecutiva si mostra una volta; il
// bottone della notice apre il selettore del bot quando c'è un provider
import { groupRepeatedNotices } from '../lib/notice-rows'
import { modelNoticeTarget } from '../lib/model-notice'
import { i18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { GROUP_CHAIN_CLOSED_TEXT, GROUP_RATE_LIMIT_TEXT, GROUP_HOURLY_CAP_TEXT, parseCoordinatorNowText, parseMemberNoModelText } from '../../../main/agent/group-turns'
// B1 (fase b20-bug): dei testi per il MODELLO la chat mostra solo il contenuto dell'involucro
import { agentMessageDisplay, modelEnvelopeDisplay, modelEnvelopes } from '../../../shared/agent-message'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload, ThinkingSetting } from '../../../shared/types'
import { ApprovalCard } from './ApprovalCard'
// A3 (fase centro-autorizzazioni): il riquadro delle richieste in cima alla chat
// A3 (fase approvazioni-chiare): il riquadro in cima resta SOLO per le
// richieste di ALTRI bot o squadre; la richiesta di QUESTO bot sta sopra il
// campo di scrittura (ComposerApproval)
import { ApprovalsBannerElsewhere } from './ApprovalsBanner'
import { ComposerApproval } from './ComposerApproval'
import { WidgetCard } from './WidgetCard'
import { AgentSendRow, type DelegationStatus } from './AgentSendRow'
import { delegationRowState, formatDelegationClock } from '../lib/delegation-status'
import { RoutineCreatedRow } from './RoutineCreatedRow'
import { DraftCard } from './DraftCard'
import { ConnectorCard } from './ConnectorCard'
import { McpServerCard, PluginInstallProposal, McpWindowCard, EnablePluginCard } from './ConnectorCards13'
import { RuleProposalCard } from './RuleProposalCard'
import { TaskCard } from './TaskCard'
import { SubagentCard } from './SubagentCard'
// P5 (fase uso-permessi): il brief del figlio come card «Compito affidato da <bot>»
import { BriefCard } from './BriefCard'
// P6 (fase uso-permessi): la riga di stato del turno col SEGNO della barra
import { StateSign } from './StateSign'
import { parseSubagentBrief } from '../../../shared/agent-message'
// fase chat-limiti (CL3): la galleria delle foto mostrate dal tool show_images
import { ImageGalleryCard } from './ImageGalleryCard'
import { DocumentCard, ChartCard, FillCard, SecureInputCard, ContactCard } from './LibraryCards'
// fase pagine (G2): la pagina aperta al posto del transcript (il compositore resta sospeso)
import { PageView } from './PageView'
// fase 19a (V4/V5): la card della presa di controllo chiesta dal bot
import { TakeoverCard } from './TakeoverCard'
import { MemoryPanel } from './MemoryPanel'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'
// fase 16b (S3.3): la mezza riga d'attività e i passaggi del turno
import { activityPhrase, stepsOfTurn, stepsDurationLabel, type StepGroup } from '../lib/activity'
// fase risposta (R3): la riga di lavoro dal testo a metà turno
import { narrationStatusLine } from '../../../shared/narration'
// P6 (fase pulizia): il layout (pannello docked/overlay) per il limite dei menu
import type { LayoutResult } from '../layout'
import { THINKING_LABELS } from './ui/ModelPicker'
// M1 (fase beta12-correzioni): il layout a più righe del composer (la misura
// del textarea e l'isteresi). Il suo raggio dinamico non c'è più: fra i tre
// raggi di DS1 il campo di scrittura è una superficie, sempre (lib/composer.ts)
import { composerMultiFromMeasure, composerLayout, nextComposerMulti, CHAT_COMPOSER_SINGLE_ROW_PX } from '../lib/composer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'
// fase design (DS4): i pezzi del sistema
import { BotMarkdown } from './DocumentMarkdown'
import { PageColumn } from './ui/page-shell'
import { Notice } from './ui/notice'
import { Button, buttonVariants } from './ui/button'
// le righe che si apriscono (SystemRow, SystemText) e la card dell'esito di un figlio
import { CardShell, SystemRow, SystemText } from './DecidedRow'

/**
 * La bolla di un messaggio del bot (DS4): la stessa per tutti — la risposta
 * in diretta, i messaggi storici, quelli di un altro bot, quelli dei pannelli.
 * La larghezza la decide chi la mette: al massimo l'85% della colonna quando
 * sta in una riga flex (BOLLA_BOT_LARGA), tutta quella del suo involucro
 * quando è già dentro un limite (la riga «Da <nome>»).
 * min-w-0: in una riga flex il contenuto lungo non impone la sua larghezza
 * (una tabella o un blocco di codice larghi scorrono dentro, non allargano).
 */
const BOLLA_BOT = 'min-w-0 rounded-surface bg-muted px-4 py-2 text-reading'
/** La bolla in una riga flex: quanto il testo, fino all'85% della colonna. */
const BOLLA_BOT_LARGA = 'max-w-[85%]'

/**
 * Un avviso (notice) parla con la sua SEVERITÀ (lib/notice-severity): info
 * grigia, warning ambra, errore rossa. Il tono è quello di Notice, il segno
 * un'icona lucide: le due tabelle hanno la stessa chiave, così una severità
 * nuova non può restare senza tono o senza segno (lo dice il compilatore).
 */
const TONO: Record<NoticeSeverity, 'neutral' | 'warning' | 'destructive'> = { info: 'neutral', warning: 'warning', error: 'destructive' }
const SEGNO: Record<NoticeSeverity, LucideIcon> = { info: Info, warning: TriangleAlert, error: CircleAlert }

/** Il popover dei passaggi: «N passaggi · Xs» e l'elenco fatto-da-fare (S3.3).
 *  correzioni 2 (Q4): chi lo posiziona lo aggancia al suo bordo (pt-1 dentro
 *  il wrapper, così il passaggio col mouse non lo chiude) e resta nella
 *  finestra anche a 900×600 — max la larghezza meno il margine.
 *  Fase design (DS4): i segni sono icone lucide da 16 (prima i glifi ✓ e ○). */
export function StepsPopover({ group, live }: { group: StepGroup; live: boolean }) {
  const { i18n } = useLingui()
  const lang = i18n.locale === 'en' ? 'en' : 'it'
  const duration = stepsDurationLabel(group, Date.now())
  return (
    <div data-testid="steps-popover" className="w-72 max-w-[calc(100vw-1.5rem)] rounded-surface bg-card p-3 text-small shadow-soft">
      <p className="mb-1.5 text-caption text-muted-foreground">
        <Plural value={group.steps.length} one="# passo" other="# passaggi" />
        {/* P5: sotto il secondo «< 1 s», senza durata nota niente tempo (mai «0 s») */}
        {duration !== null && <> · {duration}</>}
      </p>
      {group.steps.length === 0 && <p className="text-muted-foreground">{i18n.t(msg`ancora nessun passo`)}</p>}
      <div className="space-y-1">
        {group.steps.map((st, i) => (
          <p key={i} className={`flex items-center gap-1.5 ${st.done ? 'text-foreground/80' : 'text-muted-foreground'}`}>
            {/* lo slot è un quadrato da 16: il segno sta sul centro della riga */}
            <span className="grid size-4 shrink-0 place-items-center">
              {st.done ? <Check className="size-4" /> : <Circle className="size-4" />}
            </span>
            <span className="min-w-0 truncate">{i18n.t(activityPhrase({ tool: st.tool, target: st.target, ...(st.args ? { args: st.args } : {}) }, 'past', lang))}</span>
          </p>
        ))}
      </div>
      {!live && <p className="mt-1.5 text-caption text-muted-foreground">{i18n.t(msg`i passaggi del turno`)}</p>}
    </div>
  )
}

/**
 * V4 (prova vera): il confine INFERIORE del popover — il bordo superiore
 * della casella di scrittura, o della finestra se non si trova.
 */
function popoverLowerLimit(): number {
  const composer = document.querySelector('form textarea')?.closest('form')
  const top = composer?.getBoundingClientRect().top
  return typeof top === 'number' ? Math.min(top, window.innerHeight) : window.innerHeight
}

/**
 * V4 (prova vera): il contenitore del popover dei passaggi — si apre verso
 * l'ALTO quando sotto l'ancora non c'è spazio per la sua altezza (misurato
 * con getBoundingClientRect fino al bordo superiore della casella di
 * scrittura, o della finestra): `bottom-full` invece di `top-full`, così il
 * riquadro non finisce mai sotto la casella, dove non si legge.
 */
function PopoverBox({ up, setUp, align, children }: {
  up: boolean
  setUp(fn: (v: boolean) => boolean): void
  align: 'left' | 'right'
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const height = el.getBoundingClientRect().height
    const anchor = el.parentElement?.getBoundingClientRect()
    if (!anchor) return
    const spaceBelow = popoverLowerLimit() - anchor.bottom
    // la direzione dipende solo da ancora e altezza, non da quella attuale:
    // `v !== (spaceBelow < height)` la invertiva a ogni render (su↔giù senza
    // fine) proprio quando doveva aprirsi verso l'alto
    const wantUp = spaceBelow < height
    setUp((v) => (v === wantUp ? v : wantUp))
  })
  return (
    <div
      ref={ref}
      className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} z-10 ${up ? 'bottom-full pb-1' : 'top-full pt-1'}`}
    >
      {children}
    </div>
  )
}

/**
 * Fase risposta (R3): la riga di lavoro — l'ultima riga del testo che il
 * modello ha scritto nella chiamata con strumenti del turno APERTO, ripulita
 * e tagliata a 60 caratteri. Solo nei turni di chat privata: l'apertura è un
 * messaggio utente senza initiator (routine, risvegli e gruppi non la
 * mostrano). Mai un messaggio: sostituisce «pensa…» finché arriva il passo.
 */
function narrationLineOfTurn(entries: TranscriptEntry[], liveEntryId: number | null): string {
  const end = entries.length
  let start = 0
  for (let i = end - 1; i >= 0; i--) {
    const e = entries[i]!
    // l'apertura del turno: l'ultimo messaggio utente DIRETTO in chat
    // privata (niente initiator, gruppo o task: routine, risvegli di sistema
    // e turni di gruppo non narrano)
    if (e.kind === 'message' && e.role === 'user') {
      if (e.meta?.initiator || e.meta?.groupId || e.meta?.taskId) return ''
      start = i + 1
      break
    }
  }
  for (let i = end - 1; i >= start; i--) {
    const e = entries[i]!
    // la entry che STA trasmettendo in diretta non entra: la mostra la bolla
    // (R6); la riga di lavoro è il testo delle chiamate CON strumenti, fermo
    if (e.id === liveEntryId) continue
    if (e.kind === 'thinking' && e.content.trim() && !e.meta?.groupId && !e.meta?.taskId) {
      return narrationStatusLine(e.content)
    }
  }
  return ''
}

/** La mascotte che racconta il lavoro: mezza riga + popover dei passaggi. */
function ActivityRow({ agentId }: { agentId: string }) {
  const { i18n } = useLingui()
  const info = useBotInfo(agentId)
  const activity = useStore((s) => s.activity[agentId])
  const entries = useStore((s) => s.entries)
  const liveEntryId = useStore((st) => st.liveReply[agentId]?.entryId ?? null)
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  if (!info) return null
  const group = stepsOfTurn(entries, 'open')
  // fase risposta (R3): la riga di lavoro del testo a metà turno, quando non
  // c'è un'attività di strumento da raccontare (la entry in diretta non conta:
  // la mostra già la bolla di R6)
  const narration = !activity ? narrationLineOfTurn(entries, liveEntryId) : ''
  const phrase: MessageDescriptor = info.state === 'thinking' && !activity && !narration
    ? msg`pensa…`
    : activityPhrase(activity, 'present', i18n.locale === 'en' ? 'en' : 'it')
  return (
    <div className="relative flex flex-col items-start">
      <div className="flex items-center gap-3">
        <button
          className="flex flex-col items-center"
          aria-expanded={open}
          aria-label={i18n.t(msg`Cosa sta facendo ${info.agent.name}`)}
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <Bot
            family={info.avatar.family}
            color={info.avatar.color}
            state={info.state === 'thinking' ? 'thinking' : info.state === 'waiting' ? 'waiting' : 'speaking'}
            size={34}
            track={false}
          />
          {/* l'ombra morbida ovale sotto la mascotte (mai un riquadro) */}
          <span aria-hidden="true" className="mt-1 h-1.5 w-7 rounded-full bg-foreground/10" />
        </button>
        {/* la mezza riga d'attività è una seconda riga grigia (text-small) */}
        <span aria-live="polite" className="text-small text-muted-foreground">
          {narration || i18n.t(phrase)}
        </span>
      </div>
      {open && (
        <PopoverBox up={up} setUp={setUp} align="left">
          <StepsPopover group={group} live />
        </PopoverBox>
      )}
    </div>
  )
}

/**
 * Fase risposta (R6): la bolla provvisoria della risposta in diretta — il
 * testo della chiamata in corso, con lo stile di una risposta del bot. A fine
 * chiamata la entry promossa la sostituisce senza salto (stesso testo), o
 * sparisce (chiamata con strumenti: il testo va nella riga di lavoro).
 */
function LiveReplyBubble({ agentId }: { agentId: string }) {
  const live = useStore((s) => s.liveReply[agentId])
  if (!live?.text) return null
  return (
    <div className="flex justify-start">
      <div className={cn(BOLLA_BOT, BOLLA_BOT_LARGA)}>
        <BotMarkdown text={live.text} />
      </div>
    </div>
  )
}

/** U1 (fase prima-release): per quanto tempo la spunta del «Copia» resta accesa. */
const COPY_FEEDBACK_MS = 1500

/** Le azioni al passaggio su un messaggio del bot: solo «Copia» (i bottoni
 *  di citazione e di passaggi, U1 fase prima-release, non avevano un uso
 *  chiaro). «Copia» risponde: l'icona diventa una spunta per
 *  COPY_FEEDBACK_MS col tooltip «Copiato»; se il clipboard fallisce, la
 *  spunta non compare.
 *  Fase design (DS4): il bottone è quello del sistema (Button, ghost, 32 px:
 *  un'icona in una riga) con l'icona a 16. */
function MessageActions({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void navigator.clipboard?.writeText(entry.content).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
      },
      () => undefined // il clipboard ha detto no: niente spunta
    )
  }
  const Icon = copied ? Check : Copy
  return (
    <div className="flex items-center self-end opacity-0 transition group-hover:opacity-100">
      <Button variant="ghost" size="sm" icon data-testid="message-copy" title={copied ? t`Copiato` : t`Copia`} aria-label={copied ? t`Copiato` : t`Copia`} onClick={onCopy}>
        <Icon className="size-4" />
      </Button>
    </div>
  )
}

export function Chat({ layout }: { layout?: LayoutResult }) {
  const { t, i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const activeId = useStore((s) => s.activeId)
  const entries = useStore((s) => s.entries)
  const send = useStore((s) => s.send)
  const interrupt = useStore((s) => s.interrupt)
  const setTyping = useStore((s) => s.setTyping)
  const debugSteps = useStore((s) => s.debugSteps)
  // G4 (fase pagine): la precompilazione del compositore (suggerimento «Crea una routine»)
  const composerPrefill = useStore((s) => s.composerPrefill)
  const setComposerPrefill = useStore((s) => s.setComposerPrefill)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const memoryOpen = useStore((s) => s.memoryOpen)
  const pluginOpen = useStore((s) => s.pluginOpen)
  const setMemoryOpen = useStore((s) => s.setMemoryOpen)
  const rightPanel = useStore((s) => s.rightPanel)
  const setRightPanel = useStore((s) => s.setRightPanel)
  const openTaskId = useStore((s) => s.openTaskId)
  const setOpenTask = useStore((s) => s.openTask)
  // G2 (fase 0.3.1001 grafica): il pannello si chiude (✕, Esc, velo) → il
  // focus torna al bottone PanelRight che ricompare
  const panelFocusRestore = useStore((s) => s.panelFocusRestore)
  const panelBtnRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (panelFocusRestore > 0) panelBtnRef.current?.focus()
  }, [panelFocusRestore])
  const scrollRef = useRef<HTMLDivElement>(null)
  // P6 (fase pulizia): la colonna della chat è il limite dei menu del
  // compositore (collisionBoundary) — a finestra stretta col pannello aperto
  // il menu «Ragiona» non deve coprire il pannello del profilo. Col pannello
  // in OVERLAY la colonna VISIBILE finisce dove comincia il pannello: la
  // sentinella qui sotto copre esattamente quell'area
  const chatColumnRef = useRef<HTMLElement>(null)
  const chatVisibleRef = useRef<HTMLDivElement>(null)
  const reasonMenuRef = useRef<HTMLDivElement>(null)

  const agent = agents.find((a) => a.id === activeId)
  // fase locale (L4.3): la riga discreta serve quando il bot GIra sull'Integrato
  // (modello proprio, o «come gli altri» col principale Integrato)
  const mainModel = useStore((s) => s.mainModel)
  const onLocalModel =
    agent?.providerId === 'homun-local' ||
    (!agent?.providerId && mainModel?.providerId === 'homun-local')
  const info = useBotInfo(activeId)
  const busy = agent?.status === 'thinking' || agent?.status === 'running' || agent?.status === 'paused-for-approval'
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  // M1 (fase beta12-correzioni): da due righe in su la pillola del composer
  // diventa un riquadro arrotondato — lo decide la MISURA del textarea
  // (scrollHeight contro l'altezza della riga unica), così il testo lungo
  // che va a capo da solo conta come lo \n esplicito
  // con l'isteresi di nextComposerMulti: il campo a tutta larghezza non deve
  // riportare indietro il layout appena il testo ci sta su una riga
  const [multiState, setMultiState] = useState({ multi: false, enteredAt: 0 })
  const multiRow = multiState.multi
  useEffect(() => {
    const ta = composerRef.current
    const measured = ta ? composerMultiFromMeasure(ta.scrollHeight, CHAT_COMPOSER_SINGLE_ROW_PX) : false
    setMultiState((prev) => nextComposerMulti(prev, text, measured))
  }, [text])
  const layoutCls = composerLayout(multiRow)
  // fase skill (S7): le skill visibili a QUESTO bot (libreria + plugin) per
  // l'elenco `/` del compositore; il highlight della selezione.
  // K2 (fase skill ritocchi): l'elenco arriva dal RPC skills:invocable — la
  // STESSA selezione del loop (skill usabili e visibili, plugin col nome
  // <plugin>--<skill>), senza il filtro duplicato nel renderer. Si ricarica
  // anche quando la finestra Skill si CHIUDE (può aver salvato, importato o
  // rimosso: un evento in più non serve, la ricarica basta).
  const [botSkills, setBotSkills] = useState<Array<{ name: string; description: string }>>([])
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  useEffect(() => {
    setBotSkills([])
    if (!activeId) return
    let alive = true
    void api.skillsInvocable(activeId)
      .then((r) => {
        if (!alive) return
        setBotSkills(r.map((sk) => ({ name: sk.name, description: sk.description })))
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [activeId, pluginOpen])
  // l'elenco `/` si apre SOLO quando il messaggio comincia con / e resta su
  // una riga (la query è tutto ciò che segue); filtra nome e descrizione
  const slashQuery = /^\/([^\n]*)$/.exec(text)?.[1] ?? null
  const slashOptions = useMemo(() => {
    if (slashQuery === null || !botSkills.length) return []
    const q = slashQuery.trim().toLowerCase()
    return botSkills
      .filter((sk) => !q || sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q))
      .slice(0, 8)
  }, [slashQuery, botSkills])
  useEffect(() => { setSlashOpen(slashOptions.length > 0); setSlashIndex(0) }, [slashOptions.length])
  const insertSkill = (name: string): void => {
    setText(`/${name} `)
    setSlashOpen(false)
  }
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQ, setQuickQ] = useState('')
  const [quickA, setQuickA] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  // fase 3 (§3bis L2): il ragionamento è nascosto di default; il toggle vive
  // nel menu «Ragiona» del composer (16b, S3.1/S3.4)
  const [showReasoning, setShowReasoning] = useState(false)

  /**
   * P6 (fase pulizia): il menu «Ragiona» resta DENTRO la colonna visibile
   * della chat. Il collisionBoundary di Radix ferma l'asse verticale, ma lo
   * shift orizzontale non lo fa (mainAxis only): appena il menu è posizionato
   * il contenuto si ritaglia sulla colonna — col pannello in overlay a 900 px
   * non copre mai il pannello del profilo.
   */
  const clampReasonMenu = (): void => {
    const el = reasonMenuRef.current
    const col = chatVisibleRef.current ?? chatColumnRef.current
    if (!el || !col) return
    const m = el.getBoundingClientRect()
    const c = col.getBoundingClientRect()
    const pad = 8
    let dx = 0
    if (m.right > c.right - pad) dx = c.right - pad - m.right
    else if (m.left < c.left + pad) dx = c.left + pad - m.left
    if (dx !== 0) el.style.transform = `${el.style.transform} translateX(${Math.round(dx)}px)`
  }
  const clampReasonMenuSoon = (): void => {
    requestAnimationFrame(() => requestAnimationFrame(clampReasonMenu))
    setTimeout(clampReasonMenu, 60)
  }
  // fase 18b (H4.3 → K3): l'avviso per i modelli senza visione.
  // Fase 16c correzioni (R4): provider e modello del bot passano dal
  // selettore resolvedModelOf — anche un bot «Come gli altri» (null/null)
  // vede le immagini del PRINCIPALE e ne ha i livelli di «Ragiona»
  const [noVision, setNoVision] = useState(false)
  const resolvedModel = useResolvedModel(agent?.id ?? null)
  const visionProviderId = resolvedModel?.providerId ?? null
  const visionModel = resolvedModel?.model ?? null
  useEffect(() => {
    setNoVision(false)
    if (!visionProviderId || !visionModel) return
    void api.modelCapabilities(visionProviderId, visionModel)
      .then((caps) => setNoVision(caps.vision === false))
      .catch(() => setNoVision(false))
  }, [visionProviderId, visionModel])
  // i livelli di ragionamento del modello risolto (S3.4)
  const [levels, setLevels] = useState<ThinkingSetting[]>([])
  useEffect(() => {
    setLevels([])
    if (!resolvedModel) return
    void api.listModels(resolvedModel.providerId)
      .then((ms) => setLevels(ms.find((m) => m.id === resolvedModel.model)?.thinkingLevels ?? []))
      .catch(() => setLevels([]))
  }, [resolvedModel])

  // Chiedi al volo con ⌘K (S3.1): la finestra è quella di oggi
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && (e.key === 'k' || e.code === 'KeyK')) {
        e.preventDefault()
        setQuickOpen((v) => !v)
        setQuickA('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // draft recovery: il testo non inviato sopravvive al cambio agente/riavvio
  const draftKey = activeId ? `sandbot:draft:${activeId}` : null
  useEffect(() => {
    if (!draftKey) return
    const saved = localStorage.getItem(draftKey) ?? ''
    setText(saved)
    setTyping(saved ? activeId : null)
  }, [draftKey, activeId, setTyping])
  useEffect(() => {
    if (draftKey) {
      if (text) localStorage.setItem(draftKey, text)
      else localStorage.removeItem(draftKey)
    }
  }, [draftKey, text])

  // fase pagine (G4): la precompilazione del compositore (il suggerimento
  // «Crea una routine» scrive la richiesta nel campo, pronta da inviare)
  useEffect(() => {
    if (composerPrefill === null) return
    setText(composerPrefill)
    setComposerPrefill(null)
    if (activeId) setTyping(activeId)
    composerRef.current?.focus()
  }, [composerPrefill, setComposerPrefill, activeId, setTyping])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])

  const sendNow = () => {
    if (!text.trim()) return
    // fase pagine (G2/G6): scritto dalla pagina aperta → al modello arriva
    // la riga di contesto (il testo in chat resta questo). Ritocchi (P1): si
    // manda SOLO l'identità — il titolo lo risolve il daemon sulla libreria
    const page = useStore.getState().openPageInfo
    const readingPage = page && page.version > 0
      ? { id: page.id, version: page.version }
      : undefined
    void send(text, images.length ? images : undefined, readingPage)
    setText('')
    setImages([])
    setTyping(null)
  }

  if (!agent || !info) {
    return <main className="flex flex-1 items-center justify-center text-muted-foreground"><Trans>Nessun agente</Trans></main>
  }
  // B2: cosa si vede in chat — decide sia le righe nascoste sia il raggruppamento degli avvisi
  const rowView: ChatRowView = { showReasoning, debugSteps }

  // fase 16b correzioni 2 (Q2): il testo del selettore «Ragiona» — calcolato
  // una volta, resta l'etichetta (e il tooltip) anche quando il trigger
  // mostra solo l'icona
  const levelLabel = THINKING_LABELS[agent.thinking ?? 'default']
  const reasonLabel = i18n.t(msg`Ragiona: ${levelLabel ? i18n.t(levelLabel) : (agent.thinking ?? 'default')}`)

  return (
    <main ref={chatColumnRef} className="relative flex min-w-0 flex-1 flex-col">
      {/* P6: il limite VISIBLE dei menu del compositore (v. chatVisibleRef) */}
      <div
        ref={chatVisibleRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{ right: layout?.panel === 'overlay' ? layout.panelWidth : 0 }}
      />
      {/* fase 16b correzioni 2 (Q3): la fascia alta — trascina la finestra —
          con UNA riga di controlli: pillola del bot al centro e bottone del
          pannello a destra. Fase design (DS3): alta 52 come la testata di
          OGNI colonna (h-col-head, letta dalla sonda), i controlli da 32
          (size-control-sm). La pillola tronca il nome quando la chat è al minimo (Q4).
          G3 (fase 0.3.1001 grafica): la pillola è un BOTTONE che apre/chiude
          il pannello destro (no-drag; lo spazio attorno resta fascia di
          trascinamento). G2: a pannello APERTO il bottone PanelRight sparisce
          — resta la ✕ del pannello — ma il posto w-9 resta occupato, così la
          pillola al centro non salta di posizione */}
      {/* R2 (b20-ritocchi): la fascia porta il VELO (styles.css: .col-head-velo)
          — sfondo della colonna velato, sfocatura e sfumatura sul bordo basso.
          Il transcript le scorre SOTTO, come le barre di macOS; il primo
          messaggio, a scorrimento zero, resta sotto la fascia (pt-16 più giù) */}
      <div data-col-head="chat" className="col-head-velo drag-region absolute inset-x-0 top-0 z-10 flex h-col-head">
        {/* w-full: la testata è una riga flex, e una sua figlia è larga quanto
            il contenuto — senza, lo flex-1 che centra la pillola non aveva
            spazio e la pillola restava a sinistra (difetto di DS3, visto dal
            vivo; lo fissa __tests__/ds4-chat.test.ts) */}
        <div className="flex h-full w-full min-w-0 items-center gap-3 px-4">
          <span className="w-8 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 justify-center">
            <button
              type="button"
              className="no-drag flex h-control-sm min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full bg-card/95 pl-1.5 pr-4 text-left shadow-soft transition hover:bg-card"
              aria-expanded={rightPanel}
              /* R2 (fase linguaggio-ritocchi): il nome accessibile della pillola
                 è il NOME DEL BOT che mostra; «Mostra il pannello del bot» è
                 dell'ICONA accanto, e due controlli visibili con lo stesso
                 nome li prende il controllo dei duplicati della galleria */
              onClick={() => setRightPanel(!rightPanel)}
            >
              <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={24} track={false} dimmed={info.dimmed} />
              <span className="truncate text-body font-medium">{agent.name}</span>
            </button>
          </span>
          {rightPanel ? (
            <span className="w-8 shrink-0" aria-hidden="true" />
          ) : (
            <button
              ref={panelBtnRef}
              className="no-drag grid size-control-sm shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
              aria-label={t`Mostra il pannello del bot`}
              title={t`Mostra il pannello del bot`}
              onClick={() => setRightPanel(true)}
            >
              <PanelRight className="size-4" />
            </button>
          )}
        </div>
      </div>

      {memoryOpen && activeId && <MemoryPanel agentId={activeId} onClose={() => setMemoryOpen(false)} />}

      {/* Chiedi al volo (⌘K): la finestra di oggi, sospesa sotto l'etichetta.
          Fase design (DS4): una superficie (rounded-surface), larga 576 e mai
          più dell'area meno il margine (involucro da inset-x-6, così non ci
          vogliono misure libere); il campo è un campo dei token (36 px,
          rounded-control, text-body) e «chiudi» è un bottone da 32 */}
      {quickOpen && (
        <div className="absolute inset-x-6 top-16 z-10 flex justify-center">
          <div className="w-144 max-w-full rounded-surface bg-card p-4 shadow-soft">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                className="h-control min-w-0 flex-1 rounded-control bg-muted px-3 text-body outline-none placeholder:text-muted-foreground"
                placeholder={t`Chiedi qualcosa a ${agent.name} senza inquinare la conversazione…`}
                value={quickQ}
                onChange={(e) => setQuickQ(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && quickQ.trim() && activeId) {
                    setQuickBusy(true); setQuickA('')
                    try { setQuickA(await api.quickAsk(activeId, quickQ.trim())) }
                    catch (err) { setQuickA(t`Errore: ${err instanceof Error ? err.message : String(err)}`) }
                    setQuickBusy(false)
                  }
                }}
              />
              <Button variant="ghost" size="sm" icon aria-label={t`Chiudi`} onClick={() => { setQuickOpen(false); setQuickA('') }}>
                <X className="size-4" />
              </Button>
            </div>
            {quickBusy && <p className="mt-2 text-small text-muted-foreground"><Trans>pensando…</Trans></p>}
            {quickA && <p className="mt-2 whitespace-pre-wrap text-body">{quickA}</p>}
          </div>
        </div>
      )}

      {/* fase pagine (G2): il transcript resta MONTATO (stessa posizione di
          scorrimento al ritorno); la pagina aperta gli passa SOPRA, il
          compositore resta sospeso in basso */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* A3 (fase approvazioni-chiare): in cima SOLO le richieste di ALTRI
            bot o squadre, ridotte («+N altrove») — quella di QUESTO bot sta
            sopra il campo di scrittura, dove guarda l'utente */}
        <ApprovalsBannerElsewhere excludeBotId={agent.id} />
        {/* Fase design (DS4): LA COLONNA DI LETTURA, fatta a mano come fa
            PageShell (qui il guscio non si usa: la testata della chat è
            sospesa sul transcript, non in flusso sopra).
            – il contenitore che scorre è largo quanto l'AREA (niente respiro
              laterale qui: la barra di scorrimento sta sul bordo destro) e
              riserva la sua barra su tutti e due i lati (scrollbar-gutter:
              stable both-edges: la barra di scroll-thin OCCUPA 6 px, non è a
              sovrapposizione — riservati da un lato solo il contenuto sarebbe
              3 px fuori centro);
            – DENTRO, il contenuto è centrato alla larghezza di lettura
              (PageColumn reading: min(720, area − 12 − 2·margine), margine 32
              o 24 sotto i 900 px di area);
            – il CONTENITORE DI QUERY è questo involucro, largo quanto l'area
              e antenato del solo transcript — NON <main>: un contenitore di
              query porta con sé la containment di layout, e <main> diventerebbe
              il contenitore di riferimento dei position:fixed (l'immagine
              grande della galleria resterebbe chiusa nella colonna) e un
              contesto d'impilamento (la pagina aperta finirebbe sotto il
              pannello in overlay: oggi gli sta sopra). Per la stessa ragione
              PageView sta FUORI dall'involucro. */}
        <div className="@container flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]"
          >
            {/* pt-16 = 64: la testata sospesa (52, col-head) + il respiro di 12
                (row-pad) fra lei e la prima riga; pb-4: 16 prima del campo */}
            <PageColumn width="reading" className="flex flex-col gap-3 pb-4 pt-16">
              {entries.length === 0 && (
                <p className="mt-16 text-center text-small text-muted-foreground">
                  <Trans>Manda un messaggio a {agent.name} per iniziare.</Trans>
                </p>
              )}
              {/*
                fase 8/10: solo le entry senza meta.taskId e senza meta.groupId.
                fase 16b (S3.3): le tool-call/tool-result NON compaiono (le racconta
                la mascotte); la voce di debug le rimette
              */}
              {/* RV4: la stessa notice consecutiva senza altro in mezzo si mostra
                  UNA volta, col contatore discreto — le altre entry passano tali */}
              {/* B2 (fase b20-bug): l'avviso che torna uguale dopo ogni apertura
                  automatica si raccoglie in una riga sola col conteggio, con UNA
                  riga di apertura davanti (lead) */}
              {groupRepeatedNotices(
                entries.filter((e) => !e.meta?.taskId && !e.meta?.groupId && !chatRowHidden(e, rowView))
              ).map((g) => (
                <Fragment key={g.entry.id}>
                  {g.lead && <EntryRow entry={g.lead} showReasoning={showReasoning} debugSteps={debugSteps} />}
                  <EntryRow entry={g.entry} repeat={g.repeat} showReasoning={showReasoning} debugSteps={debugSteps} />
                </Fragment>
              ))}
              {/* fase risposta (R6): la risposta in diretta, bolla provvisoria */}
              <LiveReplyBubble agentId={agent.id} />
              {/* fase 16b (S3.3): mentre lavora, la mascotte con la mezza riga */}
              {busy && <ActivityRow agentId={agent.id} />}
            </PageColumn>
          </div>
        </div>
        <PageView />
      </div>

      {/* fase 8 (§3bis L7): vista del sotto-transcript del task aperto */}
      {openTaskId !== null && <TaskPanel onClose={() => setOpenTask(null)} />}

      {/* fase 12 (punto 7): vista del transcript del sottoagente aperto */}
      <SubagentPanel />

      {/* il campo di scrittura (S3.4). correzioni 2 (Q2): il footer è un
          @container — sotto i 560 px «Ragiona: …» diventa un bottone tondo
          con l'icona, il campo non scende mai sotto 120 px e allega/invia
          restano DENTRO anche con la chat al minimo.
          Fase design (DS4): il campo sta in una PageColumn reading, la STESSA
          del transcript (stessa larghezza, stesso centro). px-1.5 sull'involucro
          della colonna — non sul contenitore, così le query misurano l'area
          come nel transcript — perché il corpo che scorre riserva 6 px di barra
          per lato: le due colonne hanno la stessa larghezza utile. */}
      <footer className="@container shrink-0 pb-4">
        <div className="px-1.5">
          <PageColumn width="reading" className="flex flex-col">
            {/* A3 (fase approvazioni-chiare): la richiesta in attesa di QUESTO
                bot, agganciata in basso sopra il campo (come i permessi degli
                strumenti per sviluppatori): resta visibile scorrendo e il campo
                resta usabile */}
            <ComposerApproval botId={agent.id} />
            {/* fase skill (S7.1): l'elenco delle skill quando il messaggio comincia con / */}
            {slashOpen && slashOptions.length > 0 && (
              <div className="mb-2 overflow-hidden rounded-surface bg-card p-1.5 shadow-soft" data-testid="slash-picker">
                {slashOptions.map((sk, i) => (
                  <button
                    key={sk.name}
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-control px-3 py-1.5 text-left ${i === slashIndex ? 'bg-muted' : ''}`}
                    onMouseEnter={() => setSlashIndex(i)}
                    onClick={() => insertSkill(sk.name)}
                  >
                    <span className="font-mono text-body text-foreground">/{sk.name}</span>
                    <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">{sk.description.replace(/\s+/g, ' ').slice(0, 120)}</span>
                  </button>
                ))}
              </div>
            )}
            {/* fase locale (L4.3): stato dell'INTERFACCIA, mai del prompt — una
                riga fissa e discreta quando questo bot gira sul modello integrato */}
            {onLocalModel && (
              <p className="mb-1.5 text-center text-caption text-muted-foreground">
                <Trans>modello integrato · più lento</Trans>
              </p>
            )}
            {/* Fase design (DS4): il campo è una superficie (rounded-surface) a
                una riga come a dieci — i raggi sono tre, e la pillola di M1 con
                i suoi angoli da 24 px non esiste più (lib/composer.ts); resta
                il LAYOUT a più righe. I controlli sono quelli del sistema:
                l'icona (graffetta) in un bottone da 32, le azioni da 36 */}
            <form
              className={`flex items-end gap-2 rounded-surface bg-card py-2 pl-2 pr-2 shadow-soft ${layoutCls.form}`}
              onSubmit={(e) => { e.preventDefault(); sendNow() }}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon
                className="relative"
                aria-label={noVision ? t`Allega immagine — questo modello non vede le immagini` : t`Allega immagine`}
                title={noVision ? t`Allega immagine — questo modello non vede le immagini` : t`Allega immagine`}
                onClick={async () => {
                  const img = await api.pickImage()
                  if (img) setImages([...images, img])
                }}
              >
                <Paperclip className="size-4" />
                {images.length > 0 && (
                  // il conteggio delle immagini allegate: un badge (text-caption) sull'angolo
                  <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-foreground text-caption text-background">{images.length}</span>
                )}
              </Button>
              {/* fase sfoglia veloce (V3): a UNA riga il campo è alto quanto i
                  bottoni (36 px: py-2 attorno a una riga da 20 px — l'interlinea
                  che text-body porta con sé), così testo e segnaposto stanno
                  sulla linea centrale di graffetta, Ragiona e Invia; a capo
                  cresce verso l'alto (il form resta items-end) */}
              <textarea
                ref={composerRef}
                className={`max-h-40 min-h-control min-w-30 flex-1 resize-none bg-transparent py-2 pr-5 pl-3 text-body outline-none placeholder:text-muted-foreground ${layoutCls.field}`}
                placeholder={t`Scrivi a ${agent.name}`}
                rows={Math.min(6, text.split('\n').length)}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setTyping(e.target.value ? agent.id : null)
                }}
                onKeyDown={(e) => {
                  // fase skill (S7.1): l'elenco `/` si attraversa con le frecce,
                  // Invio SCEGLIE e Esc chiude — solo finché è aperto
                  if (slashOpen && slashOptions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setSlashIndex((i) => (i + 1) % slashOptions.length)
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSlashIndex((i) => (i - 1 + slashOptions.length) % slashOptions.length)
                      return
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      insertSkill(slashOptions[slashIndex]!.name)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setSlashOpen(false)
                      return
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendNow()
                  }
                }}
              />
              {/* Ragiona: <livello> — il selettore che stava nel chip (S3.4).
                  Q2: sotto i 560 px di contenitore resta solo l'icona (Brain), il
                  testo vive in aria-label e tooltip; il menu è identico.
                  Fase design (DS4): le classi sono quelle di Button (ghost, 36) */}
              <DropdownMenu onOpenChange={(open) => { if (open) clampReasonMenuSoon() }}>
                <DropdownMenuTrigger
                  className={cn(buttonVariants({ variant: 'ghost', size: 'md' }), layoutCls.push)}
                  aria-label={t`Livello di ragionamento`}
                  title={reasonLabel}
                >
                  <span className="@max-pill:hidden">{reasonLabel}</span>
                  <Brain className="hidden size-4 @max-pill:block" aria-hidden="true" />
                </DropdownMenuTrigger>
                {/* P6: il menu resta DENTRO la colonna VISIBILE della chat — a
                    900 px col pannello in overlay non lo copre, a 1100 docked resta
                    nella colonna */}
                <DropdownMenuContent
                  ref={reasonMenuRef}
                  align="end"
                  collisionBoundary={chatVisibleRef.current ?? chatColumnRef.current}
                >
                  {(['default', ...levels] as ThinkingSetting[]).map((l) => (
                    <DropdownMenuItem key={l} onClick={() => { void api.updateAgent(agent.id, { thinking: l }).catch(() => undefined) }}>
                      {i18n.t(THINKING_LABELS[l] ?? msg`${l}`)}
                    </DropdownMenuItem>
                  ))}
                  {/* la spunta sta nello spazio che la voce riserva a sinistra
                      (pl-8): la voce non si sposta quando è scelta */}
                  <DropdownMenuItem onClick={() => setShowReasoning(!showReasoning)}>
                    <span className="pointer-events-none absolute top-1/2 left-2 grid size-4 -translate-y-1/2 place-items-center" aria-hidden="true">
                      {showReasoning ? <Check className="size-4" /> : null}
                    </span>
                    {i18n.t(msg`Mostra il ragionamento in chat`)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {busy ? (
                <Button type="button" icon aria-label={t`Ferma`} title={t`Ferma`} onClick={interrupt}>
                  <Square className="size-4" />
                </Button>
              ) : (
                <Button type="submit" icon aria-label={t`Invia`} title={t`Invia`} disabled={!text.trim()}>
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </form>
            {noVision && (
              <p className="mt-1.5 text-center text-caption text-muted-foreground">
                <Trans>Questo modello non vede le immagini</Trans>
              </p>
            )}
          </PageColumn>
        </div>
      </footer>
    </main>
  )
}

/** fase skill (S7.2): il corpo della bolla utente — con l'etichetta compatta
 *  /nome quando il messaggio invoca una skill, poi il resto del testo. */
function UserBubbleBody({ entry }: { entry: TranscriptEntry }): React.ReactNode {
  const invoked = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t\n]+([\s\S]*))?$/.exec(entry.content)
  if (!invoked) return uiTextOf(entry)
  return (
    <>
      <span className="mb-1 inline-block rounded-full bg-black/10 px-2 py-0.5 font-mono text-caption dark:bg-white/10">/{invoked[1]}</span>
      {invoked[2] ?? ''}
    </>
  )
}

/**
 * B1 (fase b20-bug): un messaggio di un altro bot (o del padre, nel pannello
 * di un figlio) — «Da <nome>» e il contenuto, con lo stesso markdown delle
 * risposte del bot. Della regola per il modello non resta nulla:
 * agentMessageDisplay mostra solo il contenuto dell'involucro, di qualunque
 * versione sia la regola salvata.
 * Fase design (DS4): chi parla sta SOPRA, in text-small grigio (non più
 * dentro la bolla); la bolla è quella di ogni messaggio di bot.
 * w-fit: larga quanto il testo, fino all'85% della colonna (com'è la bolla
 * delle risposte: un blocco nudo qui era sempre largo al massimo).
 */
function BotToBotRow({ name, content, testid }: { name: string; content: string; testid: string }) {
  return (
    <div className={cn('w-fit min-w-0', BOLLA_BOT_LARGA)} data-testid={testid}>
      <p className="mb-1 text-small text-muted-foreground">
        <Trans>Da {name}</Trans>
      </p>
      <div className={BOLLA_BOT}>
        <BotMarkdown text={agentMessageDisplay(content)} />
      </div>
    </div>
  )
}

/**
 * B1 (fase b20-bug): l'apertura di un turno in un pannello (task in
 * background, figlio) che non ha una riga sua — il testo per il modello in un
 * dettaglio chiuso, senza involucri né regole.
 */
function OpeningDetailsRow({ text }: { text: string }) {
  return (
    <details data-testid="chat-opening-details">
      <SystemRow icon={ScrollText}>
        <Trans>Istruzioni del turno</Trans>
      </SystemRow>
      <SystemText text={text} />
    </details>
  )
}

/**
 * D2 (fase deleghe): la riga della delega col suo STATO — «In coda per <bot>
 * · parte alle HH:MM» con Annulla finché il job è in coda, «Consegnato»
 * quando parte, niente riga di stato quando il risultato è arrivato (o la
 * delega è annullata). Lo stato dei job arriva dal refresh coalescente dello
 * store (delegationStatuses), l'ora dal fuso dell'utente.
 */
function AgentSendDelegationRow({ entry }: { entry: TranscriptEntry }) {
  const { i18n } = useLingui()
  const entries = useStore((s) => s.entries)
  const statuses = useStore((s) => s.delegationStatuses)
  const cancelDelegation = useStore((s) => s.cancelDelegation)
  const meta = (entry.meta ?? {}) as { toAgentName?: unknown; delegationQueued?: { jobId: number; runAt: number } }
  const name = String(meta.toAgentName ?? '')
  const queued = meta.delegationQueued
  let status: DelegationStatus | undefined
  if (queued) {
    const jobStatus = statuses[String(queued.jobId)]
    const state = jobStatus === undefined ? 'queued' : delegationRowState(entry, jobStatus, entries)
    if (state === 'queued') status = { state: 'queued', runAt: queued.runAt }
    else if (state === 'delivered') status = { state: 'delivered' }
  }
  return (
    <AgentSendRow
      name={name}
      content={entry.content}
      status={status}
      cancel={status?.state === 'queued' && queued ? () => { void cancelDelegation(queued.jobId) } : undefined}
      clock={status?.state === 'queued' && queued ? formatDelegationClock(queued.runAt, i18n.locale) : undefined}
    />
  )
}

/**
 * B1 (fase b20-bug): `modelOpenings` nei pannelli di un task e di un figlio —
 * lì nessun messaggio lo scrive l'utente: ogni entry «utente» senza initiator
 * è un'apertura per il modello (il brief, un messaggio del padre) e non è
 * mai una bolla dell'utente.
 */
function EntryRow({ entry, repeat = 1, showReasoning, debugSteps, modelOpenings = false }: { entry: TranscriptEntry; repeat?: number; showReasoning: boolean; debugSteps: boolean; modelOpenings?: boolean }) {
  const { t } = useLingui()
  const reasoning = useStore((s) => s.reasoning[entry.id])
  // B2: ciò che la chat non mostra affatto (la lista è in chat-rows.ts, condivisa col raggruppamento)
  if (chatRowHidden(entry, { showReasoning, debugSteps })) return null
  switch (entry.kind) {
    case 'message': {
      // M2 (fase 0.3.1001): una entry utente CON un qualsiasi initiator non è
      // un fumetto dell'utente — è una riga di sistema breve (il testo per il
      // modello resta nel transcript, visibile solo nei dettagli chiusi)
      const opening = openingRowFor(entry)
      // fase 7: messaggio di un ALTRO bot (initiator AGENT) — riga «Da <nome>»
      if (opening.kind === 'agent') {
        return <BotToBotRow name={String(entry.meta?.fromAgentName ?? 'altro bot')} content={entry.content} testid="chat-from-bot" />
      }
      // fase 7/8: kickstart dei template e report dei task — righe espandibili
      // (B1: del testo per il modello si mostra il contenuto, mai la regola)
      if (opening.kind === 'details') {
        // l'icona dice che cosa si apre: il modello di un template, il report di un task
        const Icon = opening.template ? LayoutTemplate : FileText
        return (
          <details>
            <SystemRow icon={Icon}>
              {opening.template
                ? <Trans>Configurazione da template: {String(entry.meta?.templateName ?? '')}</Trans>
                : <Trans>Report del task: {String(entry.meta?.taskTitle ?? '')} ({String(entry.meta?.taskRef ?? '')})</Trans>}
            </SystemRow>
            <SystemText text={modelEnvelopeDisplay(entry.content)} className="max-h-60" />
          </details>
        )
      }
      // M2: routine, giro al rientro, risvegli di sistema — riga breve col
      // testo del modello chiuso nei dettagli
      if (opening.kind === 'system') {
        // B2 (fase b20-bug): l'icona è lucide (mai emoji); la riga è Notice (DS4)
        const Icon = opening.icon
        return (
          <details>
            <SystemRow icon={Icon}>{i18n.t(opening.label)}</SystemRow>
            <SystemText text={modelEnvelopeDisplay(uiTextOf(entry))} />
          </details>
        )
      }
      // B2 (fase beta.4): il prompt NASCOSTO della presentazione del bot nuovo
      // non compare in chat: la domanda arriva come card ask_user (chatRowHidden)
      // P5 (fase uso-permessi): il brief di apertura del sottoagente è una card
      // «Compito affidato da <bot>» (titolo, prime righe, mostra tutto) — mai
      // la bola scura dell'utente con il XML grezzo
      if (entry.role === 'user') {
        const brief = parseSubagentBrief(entry.content)
        if (brief) return <BriefCard entry={entry} />
      }
      // B1 (fase b20-bug): nei pannelli, un'apertura per il modello senza
      // initiator — il messaggio del padre è «Da <padre>», il resto un dettaglio
      if (modelOpenings && entry.role === 'user') {
        const envelopes = modelEnvelopes(entry.content)
        const fromParent = envelopes.find((b) => b.tag === 'messaggio_dal_padre')
        if (fromParent) return <BotToBotRow name={fromParent.attrs.nome ?? ''} content={entry.content} testid="chat-from-parent" />
        if (envelopes.length > 0) return <OpeningDetailsRow text={modelEnvelopeDisplay(entry.content)} />
      }
      // B3 (fase beta.4): la risposta a una domanda NON si ripete come bolla
      // utente separata — resta la riga della card, riapribile (chatRowHidden)
      return entry.role === 'user' ? (
        // Fase design (DS4): testo text-reading come i messaggi del bot, al
        // massimo l'85% della colonna (prima 75%), raggio di superficie.
        // min-w-0 + wrap-anywhere: in una riga flex una parola lunghissima (un
        // indirizzo) non impone la sua larghezza — va a capo DENTRO la bolla
        // bolla utente a destra — NEUTRA (G1, fase 0.3.1001 grafica): colore
        // fisso della chat, mai il colore del bot (che resta a mascotte,
        // pillola e avatar); si ritocca dai token --bubble-user in styles.css
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] rounded-surface bg-[var(--bubble-user)] px-4 py-2 text-reading wrap-anywhere text-[var(--bubble-user-foreground)] whitespace-pre-wrap">
            {/* fase skill (S7.2): un messaggio che comincia con /nome mostra
                l'etichetta compatta della skill, poi il resto del testo */}
            <UserBubbleBody entry={entry} />
          </div>
        </div>
      ) : (
        // messaggi assistant pre-fase 3 (transcript storici)
        <div className={cn(BOLLA_BOT, BOLLA_BOT_LARGA)}>
          <BotMarkdown text={entry.content || '…'} />
        </div>
      )
    }
    case 'thinking': {
      // fase 3 (§3bis L2): il ragionamento resta interno, col toggle
      return (
        <details open={!entry.content}>
          <SystemRow icon={Brain}><Trans>Ragionamento</Trans></SystemRow>
          <SystemText text={entry.content || reasoning || '…'} />
        </details>
      )
    }
    case 'summary': {
      // fase 4: riepilogo dei turni più vecchi (compaction)
      return (
        <details>
          <SystemRow icon={History}><Trans>Riepilogo turni precedenti</Trans></SystemRow>
          <SystemText text={entry.content || '…'} className="max-h-48" />
        </details>
      )
    }
    case 'send-message': {
      // fase 3: l'UNICO contenuto visibile del bot — text | widget | draft
      const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
      const message = meta.message as SendMessagePayload | undefined
      // fase 6: trattenuto nell'outbox — invisibile finché non consegnato (chatRowHidden)
      // B3 (fase beta.4): delega a un altro bot — UNA riga sola, apribile
      // (prima era una bolla piena, refusi del modello compresi); D2 (fase
      // deleghe): sotto, la riga di stato se la delega è IN CODA
      if (meta.agentSend && meta.toAgentName) {
        return <AgentSendDelegationRow entry={entry} />
      }
      // fase 3: la card delle domande (anche quella del focus dell'onboarding, OA4)
      if (message?.type === 'widget') return <WidgetCard entry={entry} />
      if (message?.type === 'draft') return <DraftCard entry={entry} />
      if (message?.type === 'connector') return <ConnectorCard entry={entry} />
      // fase 13: proposte di server del registro e di plugin
      if (message?.type === 'mcp-server') return <McpServerCard entry={entry} />
      if (message?.type === 'plugin') return <PluginInstallProposal entry={entry} />
      // M3 (fase beta12-correzioni): il rimando alla finestra «Server MCP»
      if (message?.type === 'mcp-window') return <McpWindowCard entry={entry} />
      // V6 (fase stato-vivo): la scheda per accendere un plugin spento
      if (message?.type === 'enable-plugin') return <EnablePluginCard entry={entry} />
      // fase 8: regola di auto-review proposta dal bot
      if (message?.type === 'rule') return <RuleProposalCard entry={entry} />
      // fase 8/12/14: task, sottoagenti, documenti, fill, modulo sicuro, contatti
      if (message?.type === 'task') return <TaskCard entry={entry} />
      if (message?.type === 'subagent') return <SubagentCard entry={entry} />
      // fase chat-limiti (CL3): la galleria delle foto di una pagina letta
      if (message?.type === 'images') return <ImageGalleryCard entry={entry} />
      if (message?.type === 'document') return <DocumentCard entry={entry} />
      if (message?.type === 'chart') return <ChartCard entry={entry} />
      if (message?.type === 'fill') return <FillCard entry={entry} />
      if (message?.type === 'secure-input') return <SecureInputCard entry={entry} />
      if (message?.type === 'contact') return <ContactCard entry={entry} />
      // fase 19a (V5): il bot chiede all'utente di prendere il controllo
      if (message?.type === 'takeover-request') return <TakeoverCard entry={entry} />
      return (
        // la bolla del bot (DS4: BOLLA_BOT), azioni al passaggio (S3.2)
        <div className="group flex items-end gap-1.5">
          <div className={cn(BOLLA_BOT, BOLLA_BOT_LARGA)}>
            <BotMarkdown text={entry.content} />
            {meta.fallback && <p className="mt-2 text-small text-muted-foreground"><Trans>risposta di ripiego</Trans></p>}
            {message?.type === 'text' && message.urgent && <p className="mt-2 text-small text-destructive"><Trans>urgente</Trans></p>}
          </div>
          <MessageActions entry={entry} />
        </div>
      )
    }
    case 'tool-call': {
      // fase 16b (S3.3): le righe degli strumenti NON compaiono più — la voce
      // di debug (Impostazioni › Generali) le rimette com'erano
      const args = entry.meta?.arguments as string | undefined
      return (
        <details>
          {/* il nome dello strumento in monospazio; il segno è l'icona lucide (DS4: prima il glifo ⚙) */}
          <SystemRow icon={Wrench}>
            <span className="font-mono text-foreground">{entry.content}</span>
          </SystemRow>
          <SystemText text={args ?? ''} className="max-h-48" />
        </details>
      )
    }
    case 'tool-result':
      return (
        <details>
          <SystemRow icon={SquareTerminal} tone={entry.meta?.error ? 'destructive' : 'neutral'}>
            {t`risultato`}
            {/* l'errore lo dice l'icona lucide (DS4: prima il glifo ⚠), nello stesso tono rosso della riga */}
            {entry.meta?.error ? (
              <>
                {' '}<TriangleAlert className="inline-block size-4 align-text-bottom" aria-hidden="true" />{' '}{t`errore`}
              </>
            ) : null}
          </SystemRow>
          <SystemText text={entry.content} className="max-h-64" />
        </details>
      )
    case 'approval':
      return <ApprovalCard entry={entry} />
    case 'notice':
      // fase 16b (S6): gli errori del modello con una via d'uscita portano il
      // bottone che li risolve; le notice informative restano righe
      return <NoticeRow entry={entry} repeat={repeat} />
    case 'event': {
      // la riga discreta del riepilogo pubblicato nella squadra (S1.2)
      if (entry.meta?.summaryMessageId !== undefined && typeof entry.meta?.groupId === 'number') {
        return <SummaryPostedRow entry={entry} />
      }
      // gli esiti di turno (meta.turnEnd) sono dettaglio interno (chatRowHidden)
      // B3 (fase beta.4): «Routine creata (in pausa)» col bottone «Attiva»
      if (entry.meta?.automation && (entry.meta.automation as { action?: unknown }).action === 'create') {
        return <RoutineCreatedRow entry={entry} />
      }
      // un evento: una riga di sistema senza icona (DS4)
      return <Notice>{uiTextOf(entry)}</Notice>
    }
    default:
      return null
  }
}

/**
 * Le righe degli avvisi del modello, con l'azione che li risolve (S6).
 * RV4 (fase beta.2): «Scegli un modello» apre il selettore del BOT della
 * chat (lo stesso del foglio «Impostazioni del bot») quando c'è almeno un
 * provider attivo; senza provider resta Impostazioni › Modelli, dove prima
 * va aggiunto un provider. La notice ripetuta porta un contatore discreto.
 * B2 (fase b20-bug): l'avviso della risposta vuota ha «Riprova» — lo stesso
 * turno, un'altra volta (turn:retry legge dal meta dell'avviso ciò che il
 * loop ha salvato); l'avviso ripetuto dice «· N volte».
 *
 * Fase design (DS4): UNA riga per tutte — Notice (components/ui/notice).
 * Prima c'erano quattro forme scritte a mano (il riquadro della memoria, quel
 * del modello, la riga colorata al centro, il banner rosso), ognuna con le
 * sue misure. Quel che cambia da una all'altra ora sono soltanto tre cose
 * che Notice già sa portare: il TONO e l'ICONA (dalla severità di
 * lib/notice-severity: info grigia, warning ambra, errore rossa — R1), il
 * testo (con o senza il nome dello strumento in parole, P2) e l'AZIONE,
 * che è il bottone del sistema (Button, ghost, 32: un'azione dentro una
 * riga è testo). Le condizioni sono quelle di sempre, testid e handler
 * compresi: cambia solo come si vede.
 */
function NoticeRow({ entry, repeat = 1 }: { entry: TranscriptEntry; repeat?: number }) {
  const { t } = useLingui()
  // OA5 (fase onboarding-a): la riga sotto un messaggio rimasto in attesa —
  // neutra, col bottone che apre il passo model della guida
  const needModel = (entry.meta?.ui as { id?: string } | undefined)?.id === 'notice.needModel'
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const providers = useStore((s) => s.providers)
  const openBotModel = useStore((s) => s.openBotModel)
  const uiId = (entry.meta?.ui as { id?: string } | undefined)?.id
  // fase chat-limiti (CL7): la riga della memoria in quarantena — il bottone
  // apre la sezione Memoria SU QUELLA voce
  const memoryQuarantined = uiId === 'notice.memoryQuarantined'
  const openMemoryNote = useStore((s) => s.openMemoryNote)
  // fase use-app (U4): manca l'Accessibilità → il bottone apre la pagina
  // giusta delle Impostazioni di sistema
  const accessibility = uiId === 'notice.computerAccessibility'
  // fase 16b correzioni (P6): anche l'avviso «configura prima un provider e
  // un modello» ha la via d'uscita — stesso bottone «Scegli un modello»
  // B2: la risposta vuota — «Riprova» (solo se l'avviso porta ciò che serve: le
  // entry salvate prima della fase non ce l'hanno, e il bottone non si mostra)
  const retryPayload = (entry.meta as { retry?: unknown } | null)?.retry
  const emptyReply = uiId === 'notice.modelEmpty' && typeof retryPayload === 'object' && retryPayload !== null
  const withAction =
    accessibility || uiId === 'notice.modelError' || uiId === 'notice.modelNotResponding' || uiId === 'notice.configureProviderFirst' || emptyReply
  const fallback = uiId === 'notice.modelFallback' || uiId === 'notice.modelFallbackRoute' || uiId === 'notice.modelRouteCooled'

  // il conteggio «· N volte» solo agli avvisi ripetuti (una volta sola non si conta)
  const volte = repeat > 1 ? repeat : undefined
  // il tono è la severità della notice (R1): mai rossa per default
  const severity = noticeSeverity(uiId)
  const Icon = SEGNO[severity]

  if (memoryQuarantined) {
    const memoryId = String((entry.meta as { memoryId?: unknown } | undefined)?.memoryId ?? '')
    return (
      <Notice
        icon={<Brain className="size-4" />}
        repeat={volte}
        action={
          <Button variant="ghost" size="sm" data-testid="memory-quarantined-open" onClick={() => openMemoryNote(memoryId)}>
            <Trans>Apri Memoria</Trans>
          </Button>
        }
      >
        {uiTextOf(entry)}
      </Notice>
    )
  }
  if (needModel) {
    return (
      <Notice
        icon={<Cpu className="size-4" />}
        repeat={volte}
        action={
          <Button
            variant="ghost"
            size="sm"
            data-testid="need-model-choose"
            onClick={() => {
              // riapre la guida al passo model (se era saltato); se non si può
              // (guida finita e modello perso dopo), le Impostazioni dei modelli
              void api.onboardingReopen('model').then((r) => {
                if (!r) { setSettingsTab('modelli'); setSettingsOpen(true) }
              }).catch(() => { setSettingsTab('modelli'); setSettingsOpen(true) })
            }}
          >
            <Trans>Scegli un modello</Trans>
          </Button>
        }
      >
        {uiTextOf(entry)}
      </Notice>
    )
  }
  if (!withAction && !fallback) {
    // P2 (fase pulizia): il valore {tool} della notice in parole (Bloccato dai
    // permessi: Creare un bot), mai il nome tecnico
    return (
      <Notice icon={<Icon className="size-4" />} tone={TONO[severity]} repeat={volte}>
        {uiTextOfTools(entry)}
      </Notice>
    )
  }
  return (
    <Notice
      icon={<Icon className="size-4" />}
      tone={TONO[severity]}
      repeat={volte}
      action={
        <>
          {withAction && (accessibility ? (
            <Button variant="ghost" size="sm" onClick={() => { void api.openAccessibilitySettings().catch(() => undefined) }}>
              <Trans>Apri Accessibilità</Trans>
            </Button>
          ) : emptyReply ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="notice-retry"
              onClick={() => {
                // B2: lo stesso turno, un'altra volta (un secondo clic non accoda un doppione: lo decide il daemon)
                void api.turnRetry(entry.agentId, entry.id).catch(() => undefined)
              }}
            >
              <Trans>Riprova</Trans>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              data-testid="notice-choose-model"
              onClick={() => {
                // RV4: col provider che c'è, si sceglie il modello del BOT qui in
                // chat; senza provider, prima va aggiunto uno (Impostazioni › Modelli)
                if (modelNoticeTarget(providers) === 'bot') openBotModel()
                else { setSettingsTab('modelli'); setSettingsOpen(true) }
              }}
            >
              <Trans>Scegli un modello</Trans>
            </Button>
          ))}
          {/* il nome che leggono gli aid: sta in coda alla riga, DOPO il conteggio e
              l'azione, così «testo · N volte» resta tutto di seguito */}
          <span className="sr-only">{t`errore del modello`}</span>
        </>
      }
    >
      {uiTextOf(entry)}
    </Notice>
  )
}

/** «Ho pubblicato il riepilogo nella squadra «X»» — cliccabile verso la squadra. */
function SummaryPostedRow({ entry }: { entry: TranscriptEntry }) {
  const openGroup = useStore((s) => s.openGroup)
  const groupId = entry.meta?.groupId as number
  return (
    <Notice>
      <button
        className="inline-flex max-w-full items-center gap-1 text-left underline underline-offset-2 transition hover:text-foreground"
        onClick={() => openGroup(groupId)}
      >
        {uiTextOf(entry)}
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      </button>
    </Notice>
  )
}

/**
 * L'impalcatura dei due pannelli che coprono la chat — il sotto-transcript di
 * un task in background e quello di un figlio (DS4). Fanno ciò che fa la
 * chat, e con le stesse misure: la testata sta in flusso (questi pannelli
 * coprono la fascia di trascinamento della chat: sono no-drag, perché le fasce
 * ignorano lo z-index — un clic su di loro servirebbe a trascinare la
 * finestra), il transcript scorre in un contenitore largo quanto l'area e
 * DENTRO è centrato alla larghezza di lettura (PageColumn reading): la stessa
 * colonna, lo stesso centro della chat sotto. Il perché del contenitore di
 * query — qui, non su <main> — sta al transcript della chat.
 * Il titolo è text-title: è il titolo di un pannello, non di pagina (il
 * carattere dei documenti è solo del titolo di pagina e dei titoli dei
 * documenti).
 */
function PanelFrame({ label, title, actions, scrollRef, foot, children }: {
  label: React.ReactNode
  title: React.ReactNode
  /** i controlli a destra: portano ciascuno il suo nome accessibile */
  actions: React.ReactNode
  scrollRef: React.Ref<HTMLDivElement>
  /** la riga ferma in fondo (lo stato del turno), già in una sua PageColumn */
  foot?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      {/* pt-8: sotto sta la testata sospesa della chat; il pannello la copre
          col suo velo, il titolo comincia più giù di lei. px-1.5: la stessa
          larghezza utile del transcript (che riserva 6 px di barra per lato) */}
      <header className="shrink-0 px-1.5 pt-8 pb-3">
        <PageColumn width="reading">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-small text-muted-foreground">{label}</p>
              <h2 className="truncate text-title font-semibold">{title}</h2>
            </div>
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          </div>
        </PageColumn>
      </header>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable_both-edges]">
          <PageColumn width="reading" className="flex flex-col gap-3 py-4">{children}</PageColumn>
        </div>
      </div>
      {foot !== undefined && <div className="shrink-0 py-2">{foot}</div>}
    </div>
  )
}

/** «Chiudi» di un pannello: un'icona lucide in un bottone da 32 (DS4: prima il glifo ✕). */
function PanelClose({ onClick }: { onClick: () => void }) {
  const { t } = useLingui()
  return (
    <Button variant="ghost" size="sm" icon aria-label={t`Chiudi`} title={t`Chiudi`} onClick={onClick}>
      <X className="size-4" />
    </Button>
  )
}

/** L'interruttore «Ragionamento» di un pannello: acceso è un bottone secondario, spento è testo. */
function ReasoningToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Button variant={on ? 'secondary' : 'ghost'} size="sm" aria-pressed={on} onClick={onToggle}>
      <Trans>Ragionamento</Trans>
    </Button>
  )
}

/** Il messaggio di un pannello senza righe (DS4): una seconda riga grigia, come il vuoto della chat. */
function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="mt-16 text-center text-small text-muted-foreground">{children}</p>
}

/**
 * Fase 8 (§3bis L7): la vista del sotto-transcript del task in background
 * aperto. Le righe sono quelle della chat (EntryRow), con `modelOpenings`:
 * lì nessun messaggio lo scrive l'utente.
 */
function TaskPanel({ onClose }: { onClose: () => void }) {
  const entries = useStore((s) => s.entries)
  const tasks = useStore((s) => s.tasks)
  const openTaskId = useStore((s) => s.openTaskId)
  const cancelTask = useStore((s) => s.cancelTask)
  const debugSteps = useStore((s) => s.debugSteps)
  const [showReasoning, setShowReasoning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const task = tasks.find((t) => t.id === openTaskId)
  const taskEntries = entries.filter((e) => e.meta?.taskId === openTaskId)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [taskEntries.length])

  if (openTaskId === null) return null
  const open = task?.status === 'working' || task?.status === 'needs_input'

  return (
    <PanelFrame
      label={<Trans>Task</Trans>}
      title={task?.title ?? `#${openTaskId}`}
      scrollRef={scrollRef}
      actions={
        <>
          <ReasoningToggle on={showReasoning} onToggle={() => setShowReasoning(!showReasoning)} />
          {open && (
            <Button variant="secondary" size="sm" onClick={() => cancelTask(openTaskId)}>
              <Trans>Interrompi task</Trans>
            </Button>
          )}
          <PanelClose onClick={onClose} />
        </>
      }
    >
      {taskEntries.length === 0 && <PanelEmpty><Trans>Il task non ha ancora attività.</Trans></PanelEmpty>}
      {taskEntries.map((e) => (
        <EntryRow key={e.id} entry={e} showReasoning={showReasoning} debugSteps={debugSteps} modelOpenings />
      ))}
    </PanelFrame>
  )
}

/**
 * Fase 12 (punto 7): la vista del transcript di un FIGLIO. In fondo, mentre
 * lavora, la riga di stato del turno col SEGNO della barra (P6, fase
 * uso-permessi) — una riga di sistema (Notice).
 */
function SubagentPanel() {
  const { t } = useLingui()
  const openSubagentId = useStore((s) => s.openSubagentId)
  const openSubagent = useStore((s) => s.openSubagent)
  const subagents = useStore((s) => s.subagents)
  const subEntries = useStore((s) => s.subEntries)
  const debugSteps = useStore((s) => s.debugSteps)
  const [showReasoning, setShowReasoning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sub = subagents.find((x) => x.id === openSubagentId)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [subEntries.length])

  if (openSubagentId === null) return null
  const open = sub?.status === 'queued' || sub?.status === 'running'
  const waiting = sub?.agentStatus === 'paused-for-approval'

  return (
    <PanelFrame
      label={<Trans>Sottoagente</Trans>}
      title={sub?.title ?? openSubagentId}
      scrollRef={scrollRef}
      actions={<><ReasoningToggle on={showReasoning} onToggle={() => setShowReasoning(!showReasoning)} /><PanelClose onClick={() => openSubagent(null)} /></>}
      foot={
        open ? (
          <PageColumn width="reading">
            <Notice icon={<StateSign state={waiting ? 'aspetta-te' : 'lavora'} />}>
              {waiting ? t`aspetta te: rispondi alle card qui sopra.` : t`Al lavoro: le card di approvazione del figlio compaiono qui.`}
            </Notice>
          </PageColumn>
        ) : undefined
      }
    >
      {subEntries.length === 0 && <PanelEmpty><Trans>Il sottoagente non ha ancora attività.</Trans></PanelEmpty>}
      {subEntries.map((e) => (
        <EntryRow key={e.id} entry={e} showReasoning={showReasoning} debugSteps={debugSteps} modelOpenings />
      ))}
      {/* l'esito del figlio è una card (DS4): etichetta text-small, il testo del figlio col markdown di tutti i bot */}
      {sub && (sub.summary || sub.reportPath) && (
        <CardShell>
          <p className="text-small text-muted-foreground">
            {sub.status === 'done' ? t`Consegnato` : sub.status === 'failed' ? t`Fallito` : t`Esito`}
          </p>
          {sub.summary && (
            <div className="mt-1">
              <BotMarkdown text={sub.summary} />
            </div>
          )}
          {sub.reportPath && <p className="mt-2 font-mono text-small wrap-anywhere text-muted-foreground">{t`report: ${sub.reportPath}`}</p>}
        </CardShell>
      )}
    </PanelFrame>
  )
}

/**
 * Fase 17c (C2, MU): la traduzione delle righe di sistema del gruppo. Fase
 * 16b (S1.1): riconosce anche la riga del cambio di coordinatore. Usata dalla
 * vista squadra.
 */
export function groupSystemText(text: string): string {
  // gli id vivono nel catalogo UI condiviso (src/shared/ui-messages.ts)
  if (text === GROUP_CHAIN_CLOSED_TEXT) return i18n._('group.chainClosed')
  if (text === GROUP_RATE_LIMIT_TEXT) return i18n._('group.rateLimit')
  if (text === GROUP_HOURLY_CAP_TEXT) return i18n._('group.hourlyCap')
  const coord = parseCoordinatorNowText(text)
  if (coord !== null) return i18n._('group.nowCoordinates', { name: coord })
  // fase 16c correzioni (R3): il membro senza modello (giro saltato, motivo visibile)
  const noModel = parseMemberNoModelText(text)
  if (noModel !== null) return i18n._('group.memberNoModel', { name: noModel })
  return text
}

