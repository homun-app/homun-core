import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Paperclip, Plug, PanelRight } from 'lucide-react'
import { api, useStore } from '../store'
import { agentMessageDisplay } from '../../../shared/agent-message'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import { ApprovalCard } from './ApprovalCard'
import { WidgetCard } from './WidgetCard'
import { DraftCard } from './DraftCard'
import { ConnectorCard } from './ConnectorCard'
import { McpServerCard, PluginCard } from './ConnectorCards13'
import { RuleProposalCard } from './RuleProposalCard'
import { TaskCard } from './TaskCard'
import { SubagentCard } from './SubagentCard'
import { DocumentCard, ChartCard, FillCard, SecureInputCard, ContactCard } from './LibraryCards'
import { LibraryPanel } from './LibraryPanel'
import { MemoryPanel } from './MemoryPanel'
import { SkillsPanel } from './SkillsPanel'
import { Bot } from '../bot/Bot'
import { useBotInfo } from '../bot/use-bot'

export function Chat() {
  const agents = useStore((s) => s.agents)
  const activeId = useStore((s) => s.activeId)
  const entries = useStore((s) => s.entries)
  const send = useStore((s) => s.send)
  const interrupt = useStore((s) => s.interrupt)
  const setTyping = useStore((s) => s.setTyping)
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQ, setQuickQ] = useState('')
  const [quickA, setQuickA] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  // fase 3: il ragionamento del modello è nascosto di default (§3bis L2)
  const [showReasoning, setShowReasoning] = useState(false)
  // fase 16 (U5): pannelli Memoria e Skill (ora nello store: li apre anche il pannello destro)
  const memoryOpen = useStore((s) => s.memoryOpen)
  const skillsOpen = useStore((s) => s.skillsOpen)
  const setMemoryOpen = useStore((s) => s.setMemoryOpen)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  const rightPanel = useStore((s) => s.rightPanel)
  const setRightPanel = useStore((s) => s.setRightPanel)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  // fase 8 (§3bis L7): task aperto nella vista del sotto-transcript
  const openTaskId = useStore((s) => s.openTaskId)
  const setOpenTask = useStore((s) => s.openTask)
  const scrollRef = useRef<HTMLDivElement>(null)

  const agent = agents.find((a) => a.id === activeId)
  const info = useBotInfo(activeId)
  const busy = agent?.status === 'thinking' || agent?.status === 'running' || agent?.status === 'paused-for-approval'
  // il colore del bot per le bolle utente e i bottoni (token, mai un colore CSS)
  const color = info ? `var(--bot-${info.avatar.color})` : 'var(--foreground)'

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])

  const sendNow = () => {
    if (!text.trim()) return
    void send(text, images.length ? images : undefined)
    setText('')
    setImages([])
    setTyping(null)
  }

  if (!agent || !info) {
    return <main className="flex flex-1 items-center justify-center text-muted-foreground">Nessun agente</main>
  }

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 pt-9 pb-3">
        {/* mascotte 40 px con track + nome + testo di stato (U3) */}
        <div className="flex min-w-0 items-center gap-3">
          <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={40} dimmed={info.dimmed} label={agent.name} />
          <div className="min-w-0">
            <h1 className="truncate font-display text-lg leading-tight">{agent.name}</h1>
            <p className="truncate text-xs text-muted-foreground">{info.statusText}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground xl:inline">
            {agent.providerId ? `${agent.providerId} · ${agent.model ?? ''}` : 'configura modello → Impostazioni'}
          </span>
          <button
            className={`rounded-lg px-2 py-1 text-xs transition ${memoryOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            title="Memoria del bot (fatti e regole ricordati)"
            onClick={() => { setMemoryOpen(!memoryOpen); setSkillsOpen(false) }}
          >
            🗂 Memoria
          </button>
          <button
            className={`rounded-lg px-2 py-1 text-xs transition ${skillsOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            title="Skill del bot (procedure riutilizzabili)"
            onClick={() => { setSkillsOpen(!skillsOpen); setMemoryOpen(false) }}
          >
            🛠 Skill
          </button>
          <button
            className={`rounded-lg px-2 py-1 text-xs transition ${showReasoning ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            title="Mostra/nascondi il ragionamento del modello e gli eventi di turno"
            onClick={() => setShowReasoning(!showReasoning)}
          >
            🧠 Ragionamento
          </button>
          <button
            className={`rounded-lg px-2 py-1 text-xs transition ${quickOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            title="Domanda effimera sul contesto (non entra nel transcript)"
            onClick={() => { setQuickOpen(!quickOpen); setQuickA('') }}
          >
            ⚡ Chiedi al volo
          </button>
          <button
            className={`rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground ${rightPanel ? '' : 'opacity-50'}`}
            title={rightPanel ? 'Nascondi il pannello destro' : 'Mostra il pannello destro'}
            onClick={() => setRightPanel(!rightPanel)}
          >
            <PanelRight className="size-4" />
          </button>
        </div>
      </header>

      {memoryOpen && activeId && <MemoryPanel agentId={activeId} onClose={() => setMemoryOpen(false)} />}
      {skillsOpen && activeId && <SkillsPanel agentId={activeId} onClose={() => setSkillsOpen(false)} />}

      {quickOpen && (
        <div className="mx-5 mt-3 rounded-xl border border-border bg-card px-4 py-3 shadow-soft">
          <div className="flex gap-2">
            <input
              autoFocus
              className="flex-1 rounded-lg bg-muted px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
              placeholder={`Chiedi qualcosa a ${agent.name} senza inquinare la conversazione…`}
              value={quickQ}
              onChange={(e) => setQuickQ(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && quickQ.trim() && activeId) {
                  setQuickBusy(true); setQuickA('')
                  try { setQuickA(await api.quickAsk(activeId, quickQ.trim())) }
                  catch (err) { setQuickA('Errore: ' + (err instanceof Error ? err.message : String(err))) }
                  setQuickBusy(false)
                }
              }}
            />
          </div>
          {quickBusy && <p className="mt-2 text-xs text-muted-foreground">pensando…</p>}
          {quickA && <p className="mt-2 whitespace-pre-wrap text-sm">{quickA}</p>}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-5 py-6">
        {entries.length === 0 && (
          <p className="mt-16 text-center text-sm text-muted-foreground">
            Manda un messaggio a {agent.name} per iniziare.
          </p>
        )}
        <div className="mx-auto max-w-3xl space-y-3">
          {/*
            fase 8 (§3bis L7): la chat principale mostra SOLO le entry senza
            meta.taskId — le entry dei task vivono nella vista del sotto-transcript.
            fase 10 (§3): anche le entry dei turni di GRUPPO (meta.groupId) stanno
            fuori dalla chat diretta — si vedono nella vista gruppo; restano
            visibili i messaggi all'utente e le card, che groupId non lo portano
          */}
          {entries.filter((e) => !e.meta?.taskId && !e.meta?.groupId).map((e) => (
            <EntryRow key={e.id} entry={e} showReasoning={showReasoning} />
          ))}
          {/* indicatore "sta pensando…" con la mascotte 28 px in stato thinking */}
          {info.state === 'thinking' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Bot family={info.avatar.family} color={info.avatar.color} state="thinking" size={28} track={false} />
              sta pensando…
            </div>
          )}
        </div>
      </div>

      {/* fase 8 (§3bis L7): vista del sotto-transcript del task aperto */}
      {openTaskId !== null && <TaskPanel onClose={() => setOpenTask(null)} />}

      {/* fase 12 (punto 7): vista del transcript del sottoagente aperto */}
      <SubagentPanel />

      {/* fase 10: vista del gruppo aperto (messaggi, membri, scrittura come utente) */}
      <GroupPanel />

      {/* fase 14: la Libreria (documenti, grafici, file) */}
      <LibraryPanel />

      {/* composer come Lovable (rounded-2xl border bg-card shadow-soft) */}
      <footer className="p-4">
        <form
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-soft"
          onSubmit={(e) => { e.preventDefault(); sendNow() }}
        >
          <button
            type="button"
            className="relative grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title="Allega immagine (per modelli vision)"
            onClick={async () => {
              const img = await api.pickImage()
              if (img) setImages([...images, img])
            }}
          >
            <Paperclip className="size-4" />
            {images.length > 0 && (
              <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-primary text-[10px] text-primary-foreground">{images.length}</span>
            )}
          </button>
          <textarea
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder={`Scrivi a ${agent.name}…`}
            rows={Math.min(6, text.split('\n').length)}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setTyping(e.target.value ? agent.id : null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendNow()
              }
            }}
          />
          {/* Connetti app: apre Impostazioni → connettori */}
          <button
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground transition hover:text-foreground"
            title="Connetti app"
            onClick={() => { setSettingsTab('connettori'); setSettingsOpen(true) }}
          >
            <Plug className="size-4" />
          </button>
          {busy ? (
            <button
              type="button"
              className="h-11 shrink-0 rounded-xl bg-muted px-4 text-sm text-foreground transition hover:bg-accent"
              onClick={interrupt}
            >
              Ferma
            </button>
          ) : (
            <button
              type="submit"
              className="h-11 shrink-0 rounded-xl px-4 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
              style={{ background: color }}
              disabled={!text.trim()}
            >
              Invia
            </button>
          )}
        </form>
      </footer>
    </main>
  )
}

function EntryRow({ entry, showReasoning }: { entry: TranscriptEntry; showReasoning: boolean }) {
  const reasoning = useStore((s) => s.reasoning[entry.id])
  // il colore del bot della chat in cui l'entry vive (bolle utente)
  const activeId = useStore((s) => s.activeId)
  const info = useBotInfo(activeId)
  const color = info ? `var(--bot-${info.avatar.color})` : 'var(--foreground)'
  switch (entry.kind) {
    case 'message':
      // fase 7: messaggio di un ALTRO bot (initiator AGENT) — entry distinta
      // "Da <nome>", mai mostrato come scritto dall'utente
      if (entry.role === 'user' && entry.meta?.initiator === 'AGENT') {
        return (
          <div className="max-w-[75%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Da {String(entry.meta?.fromAgentName ?? 'altro bot')}
            </p>
            <p className="whitespace-pre-wrap">{agentMessageDisplay(entry.content)}</p>
          </div>
        )
      }
      // fase 7: il messaggio di kickstart iniettato dal sistema (TEMPLATE_IMPORT)
      // non è scritto dall'utente: riga espandibile "Configurazione da template"
      if (entry.role === 'user' && entry.meta?.initiator === 'TEMPLATE_IMPORT') {
        return (
          <details className="rounded-lg border border-border bg-card/60 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground">
              Configurazione da template: {String(entry.meta?.templateName ?? '')}
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {entry.content}
            </pre>
          </details>
        )
      }
      // fase 8 (§3bis L7): il summary di chiusura di un task (TASK_DONE) non è
      // scritto dall'utente: riga espandibile col report
      if (entry.role === 'user' && entry.meta?.initiator === 'TASK_DONE') {
        return (
          <details className="rounded-lg border border-border bg-card/60 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground">
              Report del task: {String(entry.meta?.taskTitle ?? '')} ({String(entry.meta?.taskRef ?? '')})
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
              {entry.content}
            </pre>
          </details>
        )
      }
      return entry.role === 'user' ? (
        // bolla utente a destra col colore del bot, testo text-background (come Lovable)
        <div className="flex justify-end">
          <div
            className="max-w-[75%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-background"
            style={{ background: color }}
          >
            {entry.content}
          </div>
        </div>
      ) : (
        // messaggi assistant pre-fase 3 (transcript storici)
        <div className="max-w-[75%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm leading-relaxed">
          <div className="max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || '…'}</ReactMarkdown>
          </div>
        </div>
      )
    case 'thinking': {
      // fase 3 (§3bis L2): testo libero del modello = ragionamento interno,
      // mai mostrato in chat a meno che l'utente non attivi il toggle
      if (!showReasoning) return null
      return (
        <details className="rounded-lg border border-border bg-card/60 px-3 py-1.5" open={!entry.content}>
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">Ragionamento</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
            {entry.content || reasoning || '…'}
          </pre>
        </details>
      )
    }
    case 'summary': {
      // fase 4: riepilogo dei turni più vecchi (compaction) — dettaglio
      // interno, visibile solo col toggle "mostra ragionamento"
      if (!showReasoning) return null
      return (
        <details className="rounded-lg border border-border bg-card/60 px-3 py-1.5">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">Riepilogo turni precedenti</summary>
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
      // fase 6: trattenuto nell'outbox (turno automatico non urgent, in
      // attesa della finestra di consegna) — invisibile finché non consegnato
      if (meta.held) return null
      // fase 7 (correzione A2): delega a un altro bot — entry "A <nome>"
      // specchiata al "Da <nome>" dei messaggi ricevuti
      if (meta.agentSend && meta.toAgentName) {
        return (
          <div className="max-w-[75%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              A {meta.toAgentName}
            </p>
            <p className="whitespace-pre-wrap">{entry.content}</p>
          </div>
        )
      }
      // fase 7: widget di sistema che porta alle impostazioni del provider
      // (onboarding fermo): il bottone apre le Impostazioni, niente turno
      if (message?.type === 'widget' && (entry.meta as Record<string, unknown>)?.onboardingProvider) {
        return <ProviderWidgetCard entry={entry} />
      }
      if (message?.type === 'widget') return <WidgetCard entry={entry} />
      if (message?.type === 'draft') return <DraftCard entry={entry} />
      if (message?.type === 'connector') return <ConnectorCard entry={entry} />
      // fase 13: proposte di server del registro e di plugin (installano SOLO dal click)
      if (message?.type === 'mcp-server') return <McpServerCard entry={entry} />
      if (message?.type === 'plugin') return <PluginCard entry={entry} />
      // fase 8 (§3bis L5): regola di auto-review proposta dal bot — si salva
      // solo al click dell'utente
      if (message?.type === 'rule') return <RuleProposalCard entry={entry} />
      // fase 8 (§3bis L7): card del task (unica riga del task in chat principale)
      if (message?.type === 'task') return <TaskCard entry={entry} />
      // fase 12 (punto 7): card del sottoagente (unica riga del figlio in chat)
      if (message?.type === 'subagent') return <SubagentCard entry={entry} />
      // fase 14: documenti e grafici in libreria, fill dei login, modulo
      // sicuro, contatto da salvare
      if (message?.type === 'document') return <DocumentCard entry={entry} />
      if (message?.type === 'chart') return <ChartCard entry={entry} />
      if (message?.type === 'fill') return <FillCard entry={entry} />
      if (message?.type === 'secure-input') return <SecureInputCard entry={entry} />
      if (message?.type === 'contact') return <ContactCard entry={entry} />
      return (
        // bolla del bot a sinistra su bg-muted (come Lovable)
        <div className="max-w-[75%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm leading-relaxed">
          <div className="max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
          </div>
          {meta.fallback && <p className="mt-1 text-[10px] text-muted-foreground">risposta di ripiego</p>}
          {message?.type === 'text' && message.urgent && <p className="mt-1 text-[10px] text-destructive/80">urgente</p>}
        </div>
      )
    }
    case 'tool-call': {
      const args = entry.meta?.arguments as string | undefined
      return (
        <details className="group rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
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
      return (
        <details className="rounded-lg border border-border bg-card/60 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">
            risultato {entry.meta?.error ? '⚠ errore' : ''}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
            {entry.content}
          </pre>
        </details>
      )
    case 'approval':
      return <ApprovalCard entry={entry} />
    case 'notice':
      return <p className="text-center text-xs text-destructive/90">{entry.content}</p>
    case 'event':
      // gli esiti di turno (meta.turnEnd) sono dettaglio interno: visibili
      // solo col toggle "mostra ragionamento"
      if (entry.meta?.turnEnd && !showReasoning) return null
      return <p className="text-center text-xs text-muted-foreground">{entry.content}</p>
    default:
      return null
  }
}

/**
 * Fase 7 (onboarding): widget di sistema che porta alle impostazioni del
 * provider — il bottone apre le Impostazioni (la ripresa dell'onboarding la
 * fa il daemon quando un provider viene salvato), niente turno del modello.
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

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-sm font-medium">{widget.prompt}</p>
      {widget.helpText && <p className="mt-1 text-xs text-muted-foreground">{widget.helpText}</p>}
      {responded ? (
        <p className="mt-3 text-xs text-muted-foreground">✓ Appena il provider è a posto preparo i tuoi bot.</p>
      ) : (
        <button
          className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          onClick={() => {
            setTab('provider')
            setSettingsOpen(true)
            if (activeId) widgetRespond(entry.id, 'open-provider-settings')
          }}
        >
          Apri le impostazioni del provider
        </button>
      )}
    </div>
  )
}

/**
 * Fase 10: la vista del gruppo — i messaggi con il nome dell'autore, le righe
 * di sistema discrete (chiusura della catena, tetti), l'elenco dei membri e il
 * campo per scrivere come utente (le @menzioni funzionano: le legge il daemon).
 */
function GroupPanel() {
  const groups = useStore((s) => s.groups)
  const openGroupId = useStore((s) => s.openGroupId)
  const groupMessages = useStore((s) => s.groupMessages)
  const openGroup = useStore((s) => s.openGroup)
  const sendGroupMessage = useStore((s) => s.sendGroupMessage)
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const group = groups.find((g) => g.id === openGroupId)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [groupMessages.length])

  if (openGroupId === null) return null
  if (!group) {
    return (
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/95">
        <button className="text-sm text-muted-foreground transition hover:text-foreground" onClick={() => openGroup(null)}>
          Gruppo non più disponibile — chiudi
        </button>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-border px-5 pt-8 pb-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Gruppo</p>
          <h2 className="truncate font-display text-lg">{group.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            Tu + {group.members.map((m) => m.name + (m.coordinator ? ' (coord.)' : '')).join(', ')}
          </p>
        </div>
        <button className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground" onClick={() => openGroup(null)}>
          ✕
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-2">
          {groupMessages.length === 0 && (
            <p className="mt-16 text-center text-sm text-muted-foreground">Nessun messaggio nel gruppo.</p>
          )}
          {groupMessages.map((m) =>
            m.authorKind === 'system' ? (
              <p key={m.id} className="text-center text-xs text-muted-foreground">{m.text}</p>
            ) : m.authorKind === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[75%] rounded-2xl rounded-br-md bg-foreground px-4 py-2.5 text-sm text-background whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="max-w-[75%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 text-sm">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {m.authorName}
                  {group.members.find((mem) => mem.agentId === m.authorId)?.coordinator ? ' · coordinatore' : ''}
                </p>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            )
          )}
        </div>
      </div>
      <footer className="p-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-soft">
          <textarea
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            placeholder={`Scrivi nel gruppo (usa @nome per chiamare un bot, @tutti per tutti)`}
            rows={Math.min(4, text.split('\n').length)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (text.trim()) {
                  sendGroupMessage(text)
                  setText('')
                }
              }
            }}
          />
          <button
            className="h-11 rounded-xl bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
            disabled={!text.trim()}
            onClick={() => {
              if (text.trim()) {
                sendGroupMessage(text)
                setText('')
              }
            }}
          >
            Invia
          </button>
        </div>
      </footer>
    </div>
  )
}

/**
 * Fase 8 (§3bis L7): vista del sotto-transcript di un task — le entry con
 * meta.taskId, con le stesse card della chat principale (widget e approval si
 * rispondono da qui). Il task non vede la conversazione principale e viceversa.
 */
function TaskPanel({ onClose }: { onClose: () => void }) {
  const entries = useStore((s) => s.entries)
  const tasks = useStore((s) => s.tasks)
  const openTaskId = useStore((s) => s.openTaskId)
  const cancelTask = useStore((s) => s.cancelTask)
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
    <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-border px-5 pt-8 pb-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Task</p>
          <h2 className="font-display text-lg">{task?.title ?? `#${openTaskId}`}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`rounded-lg px-2 py-1 text-xs transition ${showReasoning ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            onClick={() => setShowReasoning(!showReasoning)}
          >
            🧠 Ragionamento
          </button>
          {open && (
            <button
              className="rounded-lg bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-accent"
              onClick={() => cancelTask(openTaskId)}
            >
              Interrompi task
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
            <p className="mt-16 text-center text-sm text-muted-foreground">Il task non ha ancora attività.</p>
          )}
          {taskEntries.map((e) => (
            <EntryRow key={e.id} entry={e} showReasoning={showReasoning} />
          ))}
        </div>
      </div>
    </div>
  )
}


/**
 * Fase 12 (punto 7): la vista del transcript di un FIGLIO — le sue entry
 * (caricate con l'id del figlio, aggiornate dagli eventi), le card di
 * approvazione funzionano con l'id del figlio e in fondo summary e report.
 */
function SubagentPanel() {
  const openSubagentId = useStore((s) => s.openSubagentId)
  const openSubagent = useStore((s) => s.openSubagent)
  const subagents = useStore((s) => s.subagents)
  const subEntries = useStore((s) => s.subEntries)
  const [showReasoning, setShowReasoning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sub = subagents.find((x) => x.id === openSubagentId)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [subEntries.length])

  if (openSubagentId === null) return null
  const open = sub?.status === 'queued' || sub?.status === 'running'

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-border px-5 pt-8 pb-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Sottoagente</p>
          <h2 className="truncate font-display text-lg">{sub?.title ?? openSubagentId}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`rounded-lg px-2 py-1 text-xs transition ${showReasoning ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            onClick={() => setShowReasoning(!showReasoning)}
          >
            🧠 Ragionamento
          </button>
          <button className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground" onClick={() => openSubagent(null)}>
            ✕
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {subEntries.length === 0 && (
            <p className="mt-16 text-center text-sm text-muted-foreground">Il sottoagente non ha ancora attività.</p>
          )}
          {subEntries.map((e) => (
            <EntryRow key={e.id} entry={e} showReasoning={showReasoning} />
          ))}
          {sub && (sub.summary || sub.reportPath) && (
            <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {sub.status === 'done' ? 'Consegnato' : sub.status === 'failed' ? 'Fallito' : 'Esito'}
              </p>
              {sub.summary && <p className="mt-1 whitespace-pre-wrap">{sub.summary}</p>}
              {sub.reportPath && <p className="mt-1 font-mono text-xs text-muted-foreground">report: {sub.reportPath}</p>}
            </div>
          )}
        </div>
      </div>
      {open && (
        <p className="border-t border-border px-5 py-2 text-center text-[11px] text-muted-foreground">
          {sub?.agentStatus === 'paused-for-approval' ? 'In attesa di conferma: rispondi alle card qui sopra.' : 'Al lavoro: le card di approvazione del figlio compaiono qui.'}
        </p>
      )}
    </div>
  )
}
