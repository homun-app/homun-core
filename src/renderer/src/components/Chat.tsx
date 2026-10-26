import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, useStore } from '../store'
import type { TranscriptEntry } from '../../../shared/types'
import { ApprovalCard } from './ApprovalCard'

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
    <main className="flex min-w-0 flex-1 flex-col">
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
            className="rounded-lg px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Domanda effimera sul contesto (non entra nel transcript)"
            onClick={() => { setQuickOpen(!quickOpen); setQuickA('') }}
          >
            ⚡ Chiedi al volo
          </button>
        </div>
      </header>

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
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </div>
      </div>

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

function EntryRow({ entry }: { entry: TranscriptEntry }) {
  const reasoning = useStore((s) => s.reasoning[entry.id])
  switch (entry.kind) {
    case 'message':
      return entry.role === 'user' ? (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-md bg-sky-700/40 px-4 py-2.5 text-sm text-neutral-100 whitespace-pre-wrap">
            {entry.content}
          </div>
        </div>
      ) : (
        <div className="max-w-[92%] text-sm leading-relaxed text-neutral-100">
          {reasoning && (
            <details className="mb-2 rounded-lg border border-neutral-800/60 bg-neutral-900/40 px-3 py-1.5" open={!entry.content}>
              <summary className="cursor-pointer select-none text-xs text-neutral-500">Pensiero</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500">{reasoning}</pre>
            </details>
          )}
          <div className="prose-invert max-w-none prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-800 prose-code:text-neutral-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || (reasoning ? '' : '…')}</ReactMarkdown>
          </div>
        </div>
      )
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
      return <p className="text-center text-xs text-neutral-600">{entry.content}</p>
    default:
      return null
  }
}
