// Chat (fase 16b, S3): niente testata. Al centro in alto un'etichetta sospesa
// (mascotte 24 px + nome); in alto a destra il bottone tondo del pannello del
// bot. I chip di oggi escono dalla testata: Memoria e Skill nel Profilo del
// pannello, Ragionamento nel campo di scrittura, Chiedi al volo con ⌘K,
// Computer nella scheda del pannello. Le voci tool-call/tool-result NON
// compaiono più: mentre il bot lavora lo racconta la MASCOTTE con la mezza
// riga d'attività (activityPhrase) e col popover dei passaggi; dopo il turno
// restano dietro la «ⓘ» del messaggio (o in Impostazioni › Generali, con la
// voce di debug che rimette le righe di una volta).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Paperclip, PanelRight, ArrowUp, Square, Copy, Quote, Info, Brain } from 'lucide-react'
import { api, useStore, useResolvedModel } from '../store'
// fase 17c (C2): il testo di notice/eventi/system dal meta.ui (lingua attiva)
import { uiTextOf, uiTextOfTools } from '../lib/ui-text'
// M2 (fase 0.3.1001): l'apertura di un turno con initiator è una riga di sistema
import { openingRowFor } from '../lib/opening-rows'
// R1 (fase app — ritocchi): le notice in chat non sono tutte errori
import { noticeSeverity } from '../lib/notice-severity'
import { i18n, formatTime } from '../lib/i18n'
import { GROUP_CHAIN_CLOSED_TEXT, GROUP_RATE_LIMIT_TEXT, GROUP_HOURLY_CAP_TEXT, parseCoordinatorNowText, parseMemberNoModelText } from '../../../main/agent/group-turns'
import { agentMessageDisplay } from '../../../shared/agent-message'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload, ThinkingSetting } from '../../../shared/types'
import { ApprovalCard } from './ApprovalCard'
import { WidgetCard } from './WidgetCard'
import { DraftCard } from './DraftCard'
import { ConnectorCard } from './ConnectorCard'
import { McpServerCard, PluginCard } from './ConnectorCards13'
import { RuleProposalCard } from './RuleProposalCard'
import { TaskCard } from './TaskCard'
import { SubagentCard } from './SubagentCard'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu'

/** Il popover dei passaggi: «N passaggi · Xs» e l'elenco ✓/○ (S3.3).
 *  correzioni 2 (Q4): chi lo posiziona lo aggancia al suo bordo (pt-1 dentro
 *  il wrapper, così il passaggio col mouse non lo chiude) e resta nella
 *  finestra anche a 900×600 — max la larghezza meno il margine. */
export function StepsPopover({ group, live }: { group: StepGroup; live: boolean }) {
  const { i18n } = useLingui()
  const lang = i18n.locale === 'en' ? 'en' : 'it'
  const duration = stepsDurationLabel(group, Date.now())
  return (
    <div data-testid="steps-popover" className="w-72 max-w-[calc(100vw-1.5rem)] rounded-[14px] bg-card p-3 text-[13px] shadow-soft">
      <p className="mb-1.5 text-xs text-muted-foreground">
        <Plural value={group.steps.length} one="# passo" other="# passaggi" />
        {/* P5: sotto il secondo «< 1 s», senza durata nota niente tempo (mai «0 s») */}
        {duration !== null && <> · {duration}</>}
      </p>
      {group.steps.length === 0 && <p className="text-muted-foreground">{i18n.t(msg`ancora nessun passo`)}</p>}
      <div className="space-y-1">
        {group.steps.map((st, i) => (
          <p key={i} className={`flex gap-1.5 ${st.done ? 'text-foreground/80' : 'text-muted-foreground'}`}>
            <span className="shrink-0">{st.done ? '✓' : '○'}</span>
            <span className="min-w-0 truncate">{i18n.t(activityPhrase({ tool: st.tool, target: st.target, ...(st.args ? { args: st.args } : {}) }, 'past', lang))}</span>
          </p>
        ))}
      </div>
      {!live && <p className="mt-1.5 text-[11px] text-muted-foreground">{i18n.t(msg`i passaggi del turno`)}</p>}
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
        <span aria-live="polite" className="text-sm text-muted-foreground">
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
      <div className="max-w-[75%] rounded-[22px] bg-muted px-4 py-2.5 text-sm leading-relaxed">
        <div className="max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.text}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

/** Le azioni al passaggio su un messaggio del bot: cita, copia, ⓘ passaggi. */
function MessageActions({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const setQuote = useStore((s) => s.setQuote)
  const [steps, setSteps] = useState(false)
  const quote = entry.content.slice(0, 160)
  return (
    // il riquadro dei passaggi vive dentro questa riga: aperto, la riga resta
    // visibile anche senza il mouse sopra il messaggio (prima spariva aperto)
    <div className={`relative flex flex-col items-center self-end transition ${steps ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
      <div className="flex items-center gap-0.5 text-muted-foreground">
        <button
          className="grid size-7 place-items-center rounded-full transition hover:bg-muted hover:text-foreground"
          title={t`Rispondi citando`}
          aria-label={t`Rispondi citando`}
          onClick={() => setQuote(quote)}
        >
          <Quote className="size-3.5" />
        </button>
        <button
          className="grid size-7 place-items-center rounded-full transition hover:bg-muted hover:text-foreground"
          title={t`Copia`}
          aria-label={t`Copia`}
          onClick={() => void navigator.clipboard?.writeText(entry.content).catch(() => undefined)}
        >
          <Copy className="size-3.5" />
        </button>
        <button
          className="grid size-7 place-items-center rounded-full transition hover:bg-muted hover:text-foreground"
          title={t`Passaggi del turno`}
          aria-label={t`Passaggi del turno`}
          aria-expanded={steps}
          onClick={() => setSteps((v) => !v)}
        >
          <Info className="size-3.5" />
        </button>
      </div>
      {steps && <StepsPopoverBox entry={entry} />}
    </div>
  )
}

/** Il popover dei passaggi agganciato a un messaggio del turno finito —
 *  correzioni 2 (Q4): ancorato a destra alle azioni, dentro la finestra.
 *  V4 (prova vera): verso l'ALTO quando sotto non c'è spazio, come quello
 *  della mascotte (PopoverBox). */
function StepsPopoverBox({ entry }: { entry: TranscriptEntry }) {
  const entries = useStore((s) => s.entries)
  const [up, setUp] = useState(false)
  return (
    <PopoverBox up={up} setUp={setUp} align="right">
      <StepsPopover group={stepsOfTurn(entries, { entryId: entry.id })} live={false} />
    </PopoverBox>
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
  const quote = useStore((s) => s.quote)
  const setQuote = useStore((s) => s.setQuote)
  // fase pagine (G2): la pagina aperta copre il transcript, non il compositore;
  // G4: la precompilazione del compositore (suggerimento «Crea una routine»)
  const openPageInfo = useStore((s) => s.openPageInfo)
  const composerPrefill = useStore((s) => s.composerPrefill)
  const setComposerPrefill = useStore((s) => s.setComposerPrefill)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const memoryOpen = useStore((s) => s.memoryOpen)
  const skillsOpen = useStore((s) => s.skillsOpen)
  const setMemoryOpen = useStore((s) => s.setMemoryOpen)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  const rightPanel = useStore((s) => s.rightPanel)
  const setRightPanel = useStore((s) => s.setRightPanel)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
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
  }, [activeId, skillsOpen])
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

  // «rispondi citando»: la citazione finisce nel campo (S3.2)
  useEffect(() => {
    if (quote && activeId) {
      setText((cur) => `${cur ? cur + '\n' : ''}> ${quote.replace(/\n/g, '\n> ')}\n`)
      setQuote(null)
      setTyping(activeId)
    }
  }, [quote, activeId, setQuote, setTyping])

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
      {/* fase 16b correzioni 2 (Q3): la fascia alta di 60 px — trascina la
          finestra — con UNA riga di controlli (y 12–48, centro 30): pillola
          del bot al centro e bottone del pannello a destra. La pillola tronca
          il nome quando la chat è al minimo (Q4).
          G3 (fase 0.3.1001 grafica): la pillola è un BOTTONE che apre/chiude
          il pannello destro (no-drag; lo spazio attorno resta fascia di
          trascinamento). G2: a pannello APERTO il bottone PanelRight sparisce
          — resta la ✕ del pannello — ma il posto w-9 resta occupato, così la
          pillola al centro non salta di posizione */}
      <div className="drag-region absolute inset-x-0 top-0 z-10 flex h-[60px] flex-col">
        <div className="mt-3 flex h-9 items-center gap-3 px-4">
          <span className="w-9 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 justify-center">
            <button
              type="button"
              className="no-drag flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-full bg-card/95 py-1.5 pl-1.5 pr-4 text-left shadow-soft transition hover:bg-card"
              aria-expanded={rightPanel}
              aria-label={rightPanel ? t`Nascondi il pannello del bot` : t`Mostra il pannello del bot`}
              title={rightPanel ? t`Nascondi il pannello del bot` : t`Mostra il pannello del bot`}
              onClick={() => setRightPanel(!rightPanel)}
            >
              <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={24} track={false} dimmed={info.dimmed} />
              <span className="truncate text-[15px] font-medium">{agent.name}</span>
            </button>
          </span>
          {rightPanel ? (
            <span className="w-9 shrink-0" aria-hidden="true" />
          ) : (
            <button
              ref={panelBtnRef}
              className="no-drag grid size-9 shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
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

      {/* Chiedi al volo (⌘K): la finestra di oggi, sospesa sotto l'etichetta */}
      {quickOpen && (
        <div className="absolute left-1/2 top-16 z-10 w-[36rem] max-w-[80%] -translate-x-1/2 rounded-[18px] bg-card p-4 shadow-soft">
          <div className="flex gap-2">
            <input
              autoFocus
              className="flex-1 rounded-full bg-muted px-4 py-2 text-sm outline-none placeholder:text-muted-foreground"
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
            <button
              className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t`Chiudi`}
              onClick={() => { setQuickOpen(false); setQuickA('') }}
            >
              ✕
            </button>
          </div>
          {quickBusy && <p className="mt-2 text-xs text-muted-foreground"><Trans>pensando…</Trans></p>}
          {quickA && <p className="mt-2 whitespace-pre-wrap text-sm">{quickA}</p>}
        </div>
      )}

      {/* fase pagine (G2): il transcript resta MONTATO (stessa posizione di
          scorrimento al ritorno); la pagina aperta gli passa SOPRA, il
          compositore resta sospeso in basso */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 pb-4 pt-16">
          {entries.length === 0 && (
            <p className="mt-16 text-center text-sm text-muted-foreground">
              <Trans>Manda un messaggio a {agent.name} per iniziare.</Trans>
            </p>
          )}
          <div className="mx-auto max-w-3xl space-y-3">
            {/*
              fase 8/10: solo le entry senza meta.taskId e senza meta.groupId.
              fase 16b (S3.3): le tool-call/tool-result NON compaiono (le racconta
              la mascotte); la voce di debug le rimette
            */}
            {entries.filter((e) => !e.meta?.taskId && !e.meta?.groupId).map((e) => (
              <EntryRow key={e.id} entry={e} showReasoning={showReasoning} debugSteps={debugSteps} />
            ))}
            {/* fase risposta (R6): la risposta in diretta, bolla provvisoria */}
            <LiveReplyBubble agentId={agent.id} />
            {/* fase 16b (S3.3): mentre lavora, la mascotte con la mezza riga */}
            {busy && <ActivityRow agentId={agent.id} />}
          </div>
        </div>
        <PageView />
      </div>

      {/* fase 8 (§3bis L7): vista del sotto-transcript del task aperto */}
      {openTaskId !== null && <TaskPanel onClose={() => setOpenTask(null)} />}

      {/* fase 12 (punto 7): vista del transcript del sottoagente aperto */}
      <SubagentPanel />

      {/* il campo di scrittura: una pillola sospesa (S3.4). correzioni 2 (Q2):
          il footer è un @container — sotto i 560 px «Ragiona: …» diventa un
          bottone tondo con l'icona, il campo non scende mai sotto 120 px e
          allega/invia restano DENTRO la pillola anche con la chat al minimo */}
      <footer className="@container px-6 pb-4">
        {/* fase skill (S7.1): l'elenco delle skill quando il messaggio comincia con / */}
        {slashOpen && slashOptions.length > 0 && (
          <div className="mx-auto mb-2 max-w-3xl overflow-hidden rounded-2xl bg-card p-1.5 shadow-soft" data-testid="slash-picker">
            {slashOptions.map((sk, i) => (
              <button
                key={sk.name}
                type="button"
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left ${i === slashIndex ? 'bg-muted' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => insertSkill(sk.name)}
              >
                <span className="font-mono text-xs text-foreground">/{sk.name}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{sk.description.replace(/\s+/g, ' ').slice(0, 120)}</span>
              </button>
            ))}
          </div>
        )}
        {/* fase locale (L4.3): stato dell'INTERFACCIA, mai del prompt — una
            riga fissa e discreta quando questo bot gira sul modello integrato */}
        {onLocalModel && (
          <p className="mx-auto mb-1.5 max-w-3xl text-center text-[11px] text-muted-foreground/80">
            <Trans>modello integrato · più lento</Trans>
          </p>
        )}
        <form
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-full bg-card py-2 pl-2 pr-2 shadow-soft"
          onSubmit={(e) => { e.preventDefault(); sendNow() }}
        >
          <button
            type="button"
            className="relative grid size-9 shrink-0 place-items-center rounded-full bg-muted/60 text-muted-foreground transition hover:text-foreground"
            aria-label={noVision ? t`Allega immagine — questo modello non vede le immagini` : t`Allega immagine`}
            title={noVision ? t`Allega immagine — questo modello non vede le immagini` : t`Allega immagine`}
            onClick={async () => {
              const img = await api.pickImage()
              if (img) setImages([...images, img])
            }}
          >
            <Paperclip className="size-4" />
            {images.length > 0 && (
              <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-foreground text-[10px] text-background">{images.length}</span>
            )}
          </button>
          {/* fase sfoglia veloce (V3): a UNA riga il campo è alto quanto i
              bottoni (36 px: py-2 attorno a una riga da 20 px, leading-5),
              così testo e segnaposto stanno sulla linea centrale di graffetta,
              Ragiona e Invia; a capo cresce verso l'alto (il form resta items-end) */}
          <textarea
            ref={composerRef}
            className="max-h-40 min-h-9 min-w-[120px] flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground"
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
          {/* Ragiona: <livello> ▾ — il selettore che stava nel chip (S3.4).
              Q2: sotto i 560 px di contenitore resta solo l'icona (Brain), il
              testo vive in aria-label e tooltip; il menu è identico */}
          <DropdownMenu onOpenChange={(open) => { if (open) clampReasonMenuSoon() }}>
            <DropdownMenuTrigger
              className="grid h-9 shrink-0 place-items-center rounded-full px-3 text-[13px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
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
              <DropdownMenuItem onClick={() => setShowReasoning(!showReasoning)}>
                {showReasoning ? '✓ ' : ''}{i18n.t(msg`Mostra il ragionamento in chat`)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {busy ? (
            <button
              type="button"
              className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90"
              aria-label={t`Ferma`}
              title={t`Ferma`}
              onClick={interrupt}
            >
              <Square className="size-4" />
            </button>
          ) : (
            <button
              type="submit"
              className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90 disabled:opacity-40"
              aria-label={t`Invia`}
              title={t`Invia`}
              disabled={!text.trim()}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </form>
        {noVision && (
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground">
            <Trans>Questo modello non vede le immagini</Trans>
          </p>
        )}
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
      <span className="mb-1 inline-block rounded-full bg-black/10 px-2 py-0.5 font-mono text-[11px] dark:bg-white/10">/{invoked[1]}</span>
      {invoked[2] ?? ''}
    </>
  )
}

function EntryRow({ entry, showReasoning, debugSteps }: { entry: TranscriptEntry; showReasoning: boolean; debugSteps: boolean }) {
  const { t } = useLingui()
  const reasoning = useStore((s) => s.reasoning[entry.id])
  switch (entry.kind) {
    case 'message': {
      // M2 (fase 0.3.1001): una entry utente CON un qualsiasi initiator non è
      // un fumetto dell'utente — è una riga di sistema breve (il testo per il
      // modello resta nel transcript, visibile solo nei dettagli chiusi)
      const opening = openingRowFor(entry)
      // fase 7: messaggio di un ALTRO bot (initiator AGENT) — riga «Da <nome>»
      if (opening.kind === 'agent') {
        return (
          <div className="max-w-[75%] rounded-[22px] bg-muted px-4 py-2.5 text-sm">
            <p className="mb-1 text-xs text-muted-foreground">
              <Trans>Da {String(entry.meta?.fromAgentName ?? 'altro bot')}</Trans>
            </p>
            <p className="whitespace-pre-wrap">{agentMessageDisplay(entry.content)}</p>
          </div>
        )
      }
      // fase 7/8: kickstart dei template e report dei task — righe espandibili
      if (opening.kind === 'details') {
        return (
          <details className="rounded-[14px] bg-muted/60 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground">
              {opening.template
                ? <Trans>Configurazione da template: {String(entry.meta?.templateName ?? '')}</Trans>
                : <Trans>Report del task: {String(entry.meta?.taskTitle ?? '')} ({String(entry.meta?.taskRef ?? '')})</Trans>}
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {entry.content}
            </pre>
          </details>
        )
      }
      // M2: routine, giro al rientro, risvegli di sistema — riga breve col
      // testo del modello chiuso nei dettagli
      if (opening.kind === 'system') {
        return (
          <details className="rounded-[14px] bg-muted/40 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-center text-xs text-muted-foreground">
              {opening.icon} {i18n.t(opening.label)}
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {uiTextOf(entry)}
            </pre>
          </details>
        )
      }
      return entry.role === 'user' ? (
        // bolla utente a destra — NEUTRA (G1, fase 0.3.1001 grafica): colore
        // fisso della chat, mai il colore del bot (che resta a mascotte,
        // pillola e avatar); si ritocca dai token --bubble-user in styles.css
        <div className="flex justify-end">
          <div className="max-w-[75%] rounded-[22px] bg-[var(--bubble-user)] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-[var(--bubble-user-foreground)]">
            {/* fase skill (S7.2): un messaggio che comincia con /nome mostra
                l'etichetta compatta della skill, poi il resto del testo */}
            <UserBubbleBody entry={entry} />
          </div>
        </div>
      ) : (
        // messaggi assistant pre-fase 3 (transcript storici)
        <div className="max-w-[75%] rounded-[22px] bg-muted px-4 py-2.5 text-sm leading-relaxed">
          <div className="max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || '…'}</ReactMarkdown>
          </div>
        </div>
      )
    }
    case 'thinking': {
      // fase 3 (§3bis L2): il ragionamento resta interno, col toggle
      if (!showReasoning) return null
      return (
        <details className="rounded-[14px] bg-muted/60 px-3 py-1.5" open={!entry.content}>
          <summary className="cursor-pointer select-none text-xs text-muted-foreground"><Trans>Ragionamento</Trans></summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
            {entry.content || reasoning || '…'}
          </pre>
        </details>
      )
    }
    case 'summary': {
      // fase 4: riepilogo dei turni più vecchi (compaction)
      if (!showReasoning) return null
      return (
        <details className="rounded-[14px] bg-muted/60 px-3 py-1.5">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground"><Trans>Riepilogo turni precedenti</Trans></summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
            {entry.content || '…'}
          </pre>
        </details>
      )
    }
    case 'send-message': {
      // fase 3: l'UNICO contenuto visibile del bot — text | widget | draft
      const meta = (entry.meta ?? {}) as Partial<SendMessageMeta>
      const message = meta.message as SendMessagePayload | undefined
      // fase 6: trattenuto nell'outbox — invisibile finché non consegnato
      if (meta.held) return null
      // fase 7 (correzione A2): delega a un altro bot — riga «A <nome>»
      if (meta.agentSend && meta.toAgentName) {
        return (
          <div className="max-w-[75%] rounded-[22px] bg-muted px-4 py-2.5 text-sm">
            <p className="mb-1 text-xs text-muted-foreground">
              <Trans>A {meta.toAgentName}</Trans>
            </p>
            <p className="whitespace-pre-wrap">{entry.content}</p>
          </div>
        )
      }
      // fase 7: widget di sistema che porta alle impostazioni del provider
      if (message?.type === 'widget' && (entry.meta as Record<string, unknown>)?.onboardingProvider) {
        return <ProviderWidgetCard entry={entry} />
      }
      if (message?.type === 'widget') return <WidgetCard entry={entry} />
      if (message?.type === 'draft') return <DraftCard entry={entry} />
      if (message?.type === 'connector') return <ConnectorCard entry={entry} />
      // fase 13: proposte di server del registro e di plugin
      if (message?.type === 'mcp-server') return <McpServerCard entry={entry} />
      if (message?.type === 'plugin') return <PluginCard entry={entry} />
      // fase 8: regola di auto-review proposta dal bot
      if (message?.type === 'rule') return <RuleProposalCard entry={entry} />
      // fase 8/12/14: task, sottoagenti, documenti, fill, modulo sicuro, contatti
      if (message?.type === 'task') return <TaskCard entry={entry} />
      if (message?.type === 'subagent') return <SubagentCard entry={entry} />
      if (message?.type === 'document') return <DocumentCard entry={entry} />
      if (message?.type === 'chart') return <ChartCard entry={entry} />
      if (message?.type === 'fill') return <FillCard entry={entry} />
      if (message?.type === 'secure-input') return <SecureInputCard entry={entry} />
      if (message?.type === 'contact') return <ContactCard entry={entry} />
      // fase 19a (V5): il bot chiede all'utente di prendere il controllo
      if (message?.type === 'takeover-request') return <TakeoverCard entry={entry} />
      return (
        // la bolla del bot: tenue, angoli 22 px, azioni al passaggio (S3.2)
        <div className="group flex items-end gap-1.5">
          <div className="max-w-[75%] rounded-[22px] bg-muted px-4 py-2.5 text-sm leading-relaxed">
            <div className="max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
            </div>
            {meta.fallback && <p className="mt-1 text-[10px] text-muted-foreground"><Trans>risposta di ripiego</Trans></p>}
            {message?.type === 'text' && message.urgent && <p className="mt-1 text-[10px] text-destructive/80"><Trans>urgente</Trans></p>}
          </div>
          <MessageActions entry={entry} />
        </div>
      )
    }
    case 'tool-call': {
      // fase 16b (S3.3): le righe degli strumenti NON compaiono più — la voce
      // di debug (Impostazioni › Generali) le rimette com'erano
      if (!debugSteps) return null
      const args = entry.meta?.arguments as string | undefined
      return (
        <details className="rounded-[14px] bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            <span className="font-mono text-foreground">⚙ {entry.content}</span>
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
            {args}
          </pre>
        </details>
      )
    }
    case 'tool-result':
      if (!debugSteps) return null
      return (
        <details className="rounded-[14px] bg-muted/60 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">
            {t`risultato`} {entry.meta?.error ? t`⚠ errore` : ''}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
            {entry.content}
          </pre>
        </details>
      )
    case 'approval':
      return <ApprovalCard entry={entry} />
    case 'notice':
      // fase 16b (S6): gli errori del modello con una via d'uscita sono un
      // banner col bottone che li risolve; le notice informative restano righe
      return <NoticeRow entry={entry} />
    case 'event': {
      // la riga discreta del riepilogo pubblicato nella squadra (S1.2)
      if (entry.meta?.summaryMessageId !== undefined && typeof entry.meta?.groupId === 'number') {
        return <SummaryPostedRow entry={entry} />
      }
      // gli esiti di turno (meta.turnEnd) sono dettaglio interno
      if (entry.meta?.turnEnd && !showReasoning) return null
      return <p className="text-center text-xs text-muted-foreground">{uiTextOf(entry)}</p>
    }
    default:
      return null
  }
}

/** Il banner degli errori del modello, con l'azione che li risolve (S6). */
function NoticeRow({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const uiId = (entry.meta?.ui as { id?: string } | undefined)?.id
  // fase use-app (U4): manca l'Accessibilità → il bottone apre la pagina
  // giusta delle Impostazioni di sistema
  const accessibility = uiId === 'notice.computerAccessibility'
  // fase 16b correzioni (P6): anche l'avviso «configura prima un provider e
  // un modello» ha la via d'uscita — stesso bottone «Scegli un modello»
  const withAction = accessibility || uiId === 'notice.modelError' || uiId === 'notice.modelNotResponding' || uiId === 'notice.configureProviderFirst'
  const fallback = uiId === 'notice.modelFallback' || uiId === 'notice.modelFallbackRoute' || uiId === 'notice.modelRouteCooled'
  if (!withAction && !fallback) {
    // R1 (fase app — ritocchi): le notice non sono tutte errori — info grigia
    // come le righe di sistema, warning ambra (token --waiting ≥ 4,5:1), solo
    // gli errori restano rossi
    const severity = noticeSeverity(uiId)
    // P2 (fase pulizia): il valore {tool} della notice in parole (Bloccato dai
    // permessi: Creare un bot), mai il nome tecnico
    const text = uiTextOfTools(entry)
    if (severity === 'error') {
      return <p className="text-center text-xs text-destructive/90">{text}</p>
    }
    if (severity === 'warning') {
      return <p className="text-center text-xs text-waiting">{text}</p>
    }
    return <p className="text-center text-xs text-muted-foreground">{text}</p>
  }
  return (
    <div className="flex items-center gap-3 rounded-[14px] bg-destructive/10 px-4 py-2.5 text-sm text-foreground">
      <span className="min-w-0 flex-1">{uiTextOf(entry)}</span>
      {withAction && (
        accessibility ? (
          <button
            className="shrink-0 rounded-full bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-accent"
            onClick={() => { void api.openAccessibilitySettings().catch(() => undefined) }}
          >
            <Trans>Apri Accessibilità</Trans>
          </button>
        ) : (
          <button
            className="shrink-0 rounded-full bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-accent"
            onClick={() => { setSettingsTab('modelli'); setSettingsOpen(true) }}
          >
            <Trans>Scegli un modello</Trans>
          </button>
        )
      )}
      <span className="sr-only">{t`errore del modello`}</span>
    </div>
  )
}

/** «Ho pubblicato il riepilogo nella squadra «X»» — cliccabile verso la squadra. */
function SummaryPostedRow({ entry }: { entry: TranscriptEntry }) {
  const openGroup = useStore((s) => s.openGroup)
  const groupId = entry.meta?.groupId as number
  return (
    <p className="text-center text-xs text-muted-foreground">
      <button
        className="underline-offset-2 transition hover:text-foreground hover:underline"
        onClick={() => openGroup(groupId)}
      >
        {uiTextOf(entry)} ›
      </button>
    </p>
  )
}

/**
 * Fase 7 (onboarding): widget di sistema che porta alle impostazioni del
 * provider — il bottone apre le Impostazioni, niente turno del modello.
 * Fase locale (L4): TRE strade (cloud consigliato, Ollama se trovato,
 * Integrato se la macchina è idonea): i bottoni arrivano dal widget, ognuno
 * apre le Impostazioni → modelli (l'Integrato sulla sua scheda).
 */
function ProviderWidgetCard({ entry }: { entry: TranscriptEntry }) {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setTab = useStore((s) => s.setSettingsTab)
  const widgetRespond = useStore((s) => s.widgetRespond)
  const meta = (entry.meta ?? {}) as Partial<SendMessageMeta> & { respondedValue?: string | string[] }
  const widget = meta.message as Extract<SendMessagePayload, { type: 'widget' }> | undefined
  const activeId = useStore((s) => s.activeId)
  if (!widget) return null
  const responded = meta.respondedValue !== undefined
  const options = widget.options ?? [{ label: '', value: 'open-provider-settings', style: 'primary' }]

  return (
    <div className="max-w-[75%] rounded-[18px] bg-muted p-4">
      <p className="text-sm font-medium">{widget.prompt}</p>
      {widget.helpText && <p className="mt-1 text-xs text-muted-foreground">{widget.helpText}</p>}
      {responded ? (
        <p className="mt-3 text-xs text-muted-foreground"><Trans>✓ Appena il provider è a posto preparo i tuoi bot.</Trans></p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              className={
                o.style === 'primary'
                  ? 'rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90'
                  : 'rounded-full bg-card px-3 py-1.5 text-xs transition hover:bg-accent'
              }
              onClick={() => {
                setTab('modelli')
                setSettingsOpen(true)
                if (activeId) widgetRespond(entry.id, o.value)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Fase 8 (§3bis L7): vista del sotto-transcript di un task — le entry con
 * meta.taskId, con le stesse card della chat principale.
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
    // verifica impostazioni: sopra la fascia di trascinamento (60 px) della chat
    // la testata cadrebbe dentro la fascia: no-drag (Electron ignora lo z-index)
    <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center justify-between px-5 pt-8 pb-3">
        <div>
          <p className="text-[13px] text-muted-foreground"><Trans>Task</Trans></p>
          <h2 className="truncate font-display text-lg">{task?.title ?? `#${openTaskId}`}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`rounded-full px-3 py-1.5 text-xs transition ${showReasoning ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            onClick={() => setShowReasoning(!showReasoning)}
          >
            <Trans>Ragionamento</Trans>
          </button>
          {open && (
            <button className="rounded-full bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-accent" onClick={() => cancelTask(openTaskId)}>
              <Trans>Interrompi task</Trans>
            </button>
          )}
          <button className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {taskEntries.length === 0 && (
            <p className="mt-16 text-center text-sm text-muted-foreground"><Trans>Il task non ha ancora attività.</Trans></p>
          )}
          {taskEntries.map((e) => (
            <EntryRow key={e.id} entry={e} showReasoning={showReasoning} debugSteps={debugSteps} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Fase 12 (punto 7): la vista del transcript di un FIGLIO.
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

  return (
    // verifica impostazioni: sopra la fascia di trascinamento (60 px) della chat
    // la testata cadrebbe dentro la fascia: no-drag (Electron ignora lo z-index)
    <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center justify-between px-5 pt-8 pb-3">
        <div className="min-w-0">
          <p className="text-[13px] text-muted-foreground"><Trans>Sottoagente</Trans></p>
          <h2 className="truncate font-display text-lg">{sub?.title ?? openSubagentId}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`rounded-full px-3 py-1.5 text-xs transition ${showReasoning ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            onClick={() => setShowReasoning(!showReasoning)}
          >
            <Trans>Ragionamento</Trans>
          </button>
          <button className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground" onClick={() => openSubagent(null)}>
            ✕
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {subEntries.length === 0 && (
            <p className="mt-16 text-center text-sm text-muted-foreground"><Trans>Il sottoagente non ha ancora attività.</Trans></p>
          )}
          {subEntries.map((e) => (
            <EntryRow key={e.id} entry={e} showReasoning={showReasoning} debugSteps={debugSteps} />
          ))}
          {sub && (sub.summary || sub.reportPath) && (
            <div className="rounded-[18px] bg-muted p-4 text-sm">
              <p className="text-xs text-muted-foreground">
                {sub.status === 'done' ? t`Consegnato` : sub.status === 'failed' ? t`Fallito` : t`Esito`}
              </p>
              {sub.summary && <p className="mt-1 whitespace-pre-wrap">{sub.summary}</p>}
              {sub.reportPath && <p className="mt-1 font-mono text-xs text-muted-foreground">{t`report: ${sub.reportPath}`}</p>}
            </div>
          )}
        </div>
      </div>
      {open && (
        <p className="px-5 py-2 text-center text-[11px] text-muted-foreground">
          {sub?.agentStatus === 'paused-for-approval' ? t`In attesa di conferma: rispondi alle card qui sopra.` : t`Al lavoro: le card di approvazione del figlio compaiono qui.`}
        </p>
      )}
    </div>
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

/** L'ora HH:MM nella lingua attiva (le righe «dopo la decisione» di S6). */
export function decisionTime(at: number): string {
  return formatTime(at)
}
