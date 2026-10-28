import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, useStore } from '../store'
import { agentMessageDisplay } from '../../../shared/agent-message'
import type { TranscriptEntry, SendMessageMeta, SendMessagePayload } from '../../../shared/types'
import { ApprovalCard } from './ApprovalCard'
import { WidgetCard } from './WidgetCard'
import { DraftCard } from './DraftCard'
import { ConnectorCard } from './ConnectorCard'
import { RuleProposalCard } from './RuleProposalCard'
import { TaskCard } from './TaskCard'
import { SubagentCard } from './SubagentCard'
import { MemoryPanel } from './MemoryPanel'
import { SkillsPanel } from './SkillsPanel'

export function Chat() {
  const agents = useStore((s) => s.agents)
  const activeId = useStore((s) => s.activeId)
  const entries = useStore((s) => s.entries)
  const send = useStore((s) => s.send)
  const interrupt = useStore((s) => s.interrupt)
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQ, setQuickQ] = useState('')
  const [quickA, setQuickA] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  // fase 3: il ragionamento del modello è nascosto di default (§3bis L2)
  const [showReasoning, setShowReasoning] = useState(false)
  // fase 4: sezioni memoria e skill della vista dell'agente
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  // fase 8 (§3bis L7): task aperto nella vista del sotto-transcript
  const openTaskId = useStore((s) => s.openTaskId)
  const setOpenTask = useStore((s) => s.openTask)
  const scrollRef = useRef<HTMLDivElement>(null)

  const agent = agents.find((a) => a.id === activeId)
  const busy = agent?.status === 'thinking' || agent?.status === 'running' || agent?.status === 'paused-for-approval'

  // draft recovery: il testo non inviato sopravvive al cambio agente/riavvio
  const draftKey = activeId ? `sandbot:draft:${activeId}` : null
  useEffect(() => {
    if (draftKey) setText(localStorage.getItem(draftKey) ?? '')
  }, [draftKey])
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
  }

  if (!agent) {
    return <main className="flex flex-1 items-center justify-center text-neutral-600">Nessun agente</main>
  }

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 pt-9 pb-3">
        <div>
          <h1 className="text-base font-semibold text-neutral-100">{agent.name}</h1>
          <p className="text-xs text-neutral-500">{agent.description || 'Agente SandBot'}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-600">
            {agent.providerId ? `${agent.providerId} · ${agent.model ?? ''}` : 'configura modello → Impostazioni'}
          </span>
          <button
            className={`rounded-lg px-2 py-1 text-xs ${memoryOpen ? 'bg-neutral-700 text-neutral-200' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
            title="Memoria del bot (fatti e regole ricordati)"
            onClick={() => { setMemoryOpen(!memoryOpen); setSkillsOpen(false) }}
          >
            🗂 Memoria
          </button>
          <button
            className={`rounded-lg px-2 py-1 text-xs ${skillsOpen ? 'bg-neutral-700 text-neutral-200' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
            title="Skill del bot (procedure riutilizzabili)"
            onClick={() => { setSkillsOpen(!skillsOpen); setMemoryOpen(false) }}
          >
            🛠 Skill
          </button>
          <button
            className={`rounded-lg px-2 py-1 text-xs ${showReasoning ? 'bg-neutral-700 text-neutral-200' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
            title="Mostra/nascondi il ragionamento del modello e gli eventi di turno"
            onClick={() => setShowReasoning(!showReasoning)}
          >
            🧠 Ragionamento
          </button>
          <button
            className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Domanda effimera sul contesto (non entra nel transcript)"
            onClick={() => { setQuickOpen(!quickOpen); setQuickA('') }}
          >
            ⚡ Chiedi al volo
          </button>
        </div>
      </header>

      {memoryOpen && activeId && <MemoryPanel agentId={activeId} onClose={() => setMemoryOpen(false)} />}
      {skillsOpen && activeId && <SkillsPanel agentId={activeId} onClose={() => setSkillsOpen(false)} />}

      {quickOpen && (
        <div className="mx-6 mt-3 rounded-xl border border-sky-800/50 bg-sky-950/20 px-4 py-3">
          <div className="flex gap-2">
            <input
              autoFocus
              className="flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm outline-none"
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
          {quickBusy && <p className="mt-2 text-xs text-neutral-500">pensando…</p>}
          {quickA && <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-200">{quickA}</p>}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
        {entries.length === 0 && (
          <p className="mt-16 text-center text-sm text-neutral-600">
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
        </div>
      </div>

      {/* fase 8 (§3bis L7): vista del sotto-transcript del task aperto */}
      {openTaskId !== null && <TaskPanel onClose={() => setOpenTask(null)} />}

      {/* fase 12 (punto 7): vista del transcript del sottoagente aperto */}
      <SubagentPanel />

      {/* fase 10: vista del gruppo aperto (messaggi, membri, scrittura come utente) */}
      <GroupPanel />

      <footer className="border-t border-neutral-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <button
            className="h-11 shrink-0 rounded-xl bg-neutral-800 px-3 text-sm text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
            title="Allega immagine (per modelli vision)"
            onClick={async () => {
              const img = await api.pickImage()
              if (img) setImages([...images, img])
            }}
          >
            📎{images.length > 0 && <span className="ml-1 text-xs text-sky-400">{images.length}</span>}
          </button>
          <textarea
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm outline-none focus:border-neutral-600"
            placeholder={`Invia un messaggio a ${agent.name}`}
            rows={Math.min(6, text.split('\n').length)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendNow()
              }
            }}
          />
          {busy ? (
            <button
              className="h-11 rounded-xl bg-neutral-800 px-4 text-sm text-neutral-300 hover:bg-neutral-700"
              onClick={interrupt}
            >
              Interrompi
            </button>
          ) : (
            <button
              className="h-11 rounded-xl bg-sky-600 px-4 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              disabled={!text.trim()}
              onClick={sendNow}
            >
              Invia
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}

function EntryRow({ entry, showReasoning }: { entry: TranscriptEntry; showReasoning: boolean }) {
  const reasoning = useStore((s) => s.reasoning[entry.id])
  switch (entry.kind) {
    case 'message':
      // fase 7: messaggio di un ALTRO bot (initiator AGENT) — entry distinta
      // "Da <nome>", mai mostrato come scritto dall'utente
      if (entry.role === 'user' && entry.meta?.initiator === 'AGENT') {
        return (
          <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-violet-800/50 bg-violet-950/20 px-4 py-2.5 text-sm text-neutral-100">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet-300/80">
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
          <details className="rounded-lg border border-neutral-800/60 bg-neutral-900/40 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-xs text-neutral-500">
              Configurazione da template: {String(entry.meta?.templateName ?? '')}
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500">
              {entry.content}
            </pre>
          </details>
        )
      }
      // fase 8 (§3bis L7): il summary di chiusura di un task (TASK_DONE) non è
      // scritto dall'utente: riga espandibile col report
      if (entry.role === 'user' && entry.meta?.initiator === 'TASK_DONE') {
        return (
          <details className="rounded-lg border border-sky-900/50 bg-sky-950/10 px-3 py-1.5">
            <summary className="cursor-pointer select-none text-xs text-sky-300/70">
              Report del task: {String(entry.meta?.taskTitle ?? '')} ({String(entry.meta?.taskRef ?? '')})
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500">
              {entry.content}
            </pre>
          </details>
        )
      }
      return entry.role === 'user' ? (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-sky-700/40 px-4 py-2.5 text-sm text-neutral-100 whitespace-pre-wrap">
            {entry.content}
          </div>
        </div>
      ) : (
        // messaggi assistant pre-fase 3 (transcript storici)
        <div className="max-w-[92%] text-sm leading-relaxed text-neutral-100">
          <div className="prose-invert max-w-none prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-800 prose-code:text-neutral-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || '…'}</ReactMarkdown>
          </div>
        </div>
      )
    case 'thinking': {
      // fase 3 (§3bis L2): testo libero del modello = ragionamento interno,
      // mai mostrato in chat a meno che l'utente non attivi il toggle
      if (!showReasoning) return null
      return (
        <details className="rounded-lg border border-neutral-800/60 bg-neutral-900/40 px-3 py-1.5" open={!entry.content}>
          <summary className="cursor-pointer select-none text-xs text-neutral-500">Ragionamento</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500">
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
        <details className="rounded-lg border border-neutral-800/60 bg-neutral-900/40 px-3 py-1.5">
          <summary className="cursor-pointer select-none text-xs text-neutral-500">Riepilogo turni precedenti</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500">
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
          <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-violet-800/50 bg-violet-950/20 px-4 py-2.5 text-sm text-neutral-100">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet-300/80">
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
      // fase 8 (§3bis L5): regola di auto-review proposta dal bot — si salva
      // solo al click dell'utente
      if (message?.type === 'rule') return <RuleProposalCard entry={entry} />
      // fase 8 (§3bis L7): card del task (unica riga del task in chat principale)
      if (message?.type === 'task') return <TaskCard entry={entry} />
      // fase 12 (punto 7): card del sottoagente (unica riga del figlio in chat)
      if (message?.type === 'subagent') return <SubagentCard entry={entry} />
      return (
        <div className="max-w-[92%] text-sm leading-relaxed text-neutral-100">
          <div className="prose-invert max-w-none prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-800 prose-code:text-neutral-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
          </div>
          {meta.fallback && <p className="mt-1 text-[10px] text-neutral-600">risposta di ripiego</p>}
          {message?.type === 'text' && message.urgent && <p className="mt-1 text-[10px] text-amber-500/80">urgente</p>}
        </div>
      )
    }
    case 'tool-call': {
      const args = entry.meta?.arguments as string | undefined
      return (
        <details className="group rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-400">
          <summary className="cursor-pointer select-none">
            <span className="font-mono text-neutral-300">⚙ {entry.content}</span>
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] text-neutral-500">
            {args}
          </pre>
        </details>
      )
    }
    case 'tool-result':
      return (
        <details className="rounded-lg border border-neutral-800/60 bg-neutral-900/40 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-neutral-500">
            risultato {entry.meta?.error ? '⚠ errore' : ''}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] text-neutral-400">
            {entry.content}
          </pre>
        </details>
      )
    case 'approval':
      return <ApprovalCard entry={entry} />
    case 'notice':
      return <p className="text-center text-xs text-orange-400/80">{entry.content}</p>
    case 'event':
      // gli esiti di turno (meta.turnEnd) sono dettaglio interno: visibili
      // solo col toggle "mostra ragionamento"
      if (entry.meta?.turnEnd && !showReasoning) return null
      return <p className="text-center text-xs text-neutral-600">{entry.content}</p>
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
    <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-sky-800/50 bg-sky-950/20 px-4 py-3">
      <p className="text-sm font-medium text-neutral-100">{widget.prompt}</p>
      {widget.helpText && <p className="mt-1 text-xs text-neutral-400">{widget.helpText}</p>}
      {responded ? (
        <p className="mt-3 text-xs text-neutral-500">✓ Appena il provider è a posto preparo i tuoi bot.</p>
      ) : (
        <button
          className="mt-3 rounded-lg border border-sky-500 bg-sky-700/70 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600"
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
 * Fase 10: la vista del gruppo — i messaggi con il nome dell'autore (i bot in
 * violetto come i messaggi tra agenti, l'utente a destra), le righe di sistema
 * discrete (chiusura della catena, tetti), l'elenco dei membri e il campo per
 * scrivere come utente (le @menzioni funzionano: le legge il daemon). UI
 * minima: niente ricerca estetica, verrà ridisegnata dopo.
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
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/95">
        <button className="text-sm text-neutral-400 hover:text-neutral-200" onClick={() => openGroup(null)}>
          Gruppo non più disponibile — chiudi
        </button>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-950/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-violet-300/80">Gruppo</p>
          <h2 className="truncate text-base font-semibold text-neutral-100">{group.name}</h2>
          <p className="truncate text-xs text-neutral-500">
            Tu + {group.members.map((m) => m.name + (m.coordinator ? ' (coord.)' : '')).join(', ')}
          </p>
        </div>
        <button className="rounded-md px-2 py-1 text-neutral-500 hover:text-neutral-200" onClick={() => openGroup(null)}>
          ✕
        </button>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-2">
          {groupMessages.length === 0 && (
            <p className="mt-16 text-center text-sm text-neutral-600">Nessun messaggio nel gruppo.</p>
          )}
          {groupMessages.map((m) =>
            m.authorKind === 'system' ? (
              <p key={m.id} className="text-center text-xs text-neutral-600">{m.text}</p>
            ) : m.authorKind === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-sky-700/40 px-4 py-2.5 text-sm text-neutral-100 whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="max-w-[85%] rounded-2xl rounded-bl-md border border-violet-800/50 bg-violet-950/20 px-4 py-2.5 text-sm text-neutral-100">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet-300/80">
                  {m.authorName}
                  {group.members.find((mem) => mem.agentId === m.authorId)?.coordinator ? ' · coordinatore' : ''}
                </p>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            )
          )}
        </div>
      </div>
      <footer className="border-t border-neutral-800 px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm outline-none focus:border-neutral-600"
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
            className="h-11 rounded-xl bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
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
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-950/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-sky-300/80">Task</p>
          <h2 className="text-base font-semibold text-neutral-100">{task?.title ?? `#${openTaskId}`}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`rounded-lg px-2 py-1 text-xs ${showReasoning ? 'bg-neutral-700 text-neutral-200' : 'text-neutral-400 hover:bg-neutral-800'}`}
            onClick={() => setShowReasoning(!showReasoning)}
          >
            🧠 Ragionamento
          </button>
          {open && (
            <button
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
              onClick={() => cancelTask(openTaskId)}
            >
              Interrompi task
            </button>
          )}
          <button className="rounded-md px-2 py-1 text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {taskEntries.length === 0 && (
            <p className="mt-16 text-center text-sm text-neutral-600">Il task non ha ancora attività.</p>
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
 * UI minima, come il resto: si ridisegnerà dopo.
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
    <div className="absolute inset-0 z-20 flex flex-col bg-neutral-950/95 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-teal-300/80">Sottoagente</p>
          <h2 className="truncate text-base font-semibold text-neutral-100">{sub?.title ?? openSubagentId}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            className={`rounded-lg px-2 py-1 text-xs ${showReasoning ? 'bg-neutral-700 text-neutral-200' : 'text-neutral-400 hover:bg-neutral-800'}`}
            onClick={() => setShowReasoning(!showReasoning)}
          >
            🧠 Ragionamento
          </button>
          <button className="rounded-md px-2 py-1 text-neutral-500 hover:text-neutral-200" onClick={() => openSubagent(null)}>
            ✕
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {subEntries.length === 0 && (
            <p className="mt-16 text-center text-sm text-neutral-600">Il sottoagente non ha ancora attività.</p>
          )}
          {subEntries.map((e) => (
            <EntryRow key={e.id} entry={e} showReasoning={showReasoning} />
          ))}
          {sub && (sub.summary || sub.reportPath) && (
            <div className="rounded-xl border border-teal-900/50 bg-teal-950/10 px-4 py-3 text-sm">
              <p className="text-[10px] font-medium uppercase tracking-wide text-teal-300/80">
                {sub.status === 'done' ? 'Consegnato' : sub.status === 'failed' ? 'Fallito' : 'Esito'}
              </p>
              {sub.summary && <p className="mt-1 whitespace-pre-wrap text-neutral-200">{sub.summary}</p>}
              {sub.reportPath && <p className="mt-1 font-mono text-xs text-neutral-500">report: {sub.reportPath}</p>}
            </div>
          )}
        </div>
      </div>
      {open && (
        <p className="border-t border-neutral-800 px-6 py-2 text-center text-[11px] text-neutral-600">
          {sub?.agentStatus === 'paused-for-approval' ? 'In attesa di conferma: rispondi alle card qui sopra.' : 'Al lavoro: le card di approvazione del figlio compaiono qui.'}
        </p>
      )}
    </div>
  )
}
