// Fase 19b (T2.4): la scheda TERMINALE del pannello «Computer» — una shell
// interattiva vera nel box, con la STESSA identità dei comandi del bot. Il
// client è xterm.js (@xterm/xterm 6.0.0 + @xterm/addon-fit 0.11.0, MIT) che
// parla col ponte WebSocket del daemon (/term/<capability>, frame binari):
// term.onData → frame kind 0 (UTF-8), fit + onResize → frame kind 1, i byte
// in arrivo → term.write. La codifica dei frame sta in shared/terminal-frames.
// Stati visibili: «Connessione…», connesso, «Sessione chiusa» con «Riapri»,
// chiusa per inattività (codice 4002) con «Riapri», errore con «Riprova» —
// mai un riquadro nero muto: entro 15 s la sessione è connessa o si vede
// l'errore. La sessione vive finché il pannello è aperto: cambiare scheda non
// chiude nulla (il pannello tiene le schede montate).
import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../store'
import { ipcErrorMessage } from '../lib/ipc-error'
import { encodeTerminalInput, encodeTerminalResize } from '../../../shared/terminal-frames'

/** Se entro 15 s non si è connessi: errore, mai un riquadro nero muto. */
const CONNECT_TIMEOUT_MS = 15_000

/** Il codice con cui il daemon chiude una sessione inattiva da 30 minuti. */
const IDLE_CLOSE_CODE = 4002

type Phase = 'idle' | 'opening' | 'connecting' | 'connected' | 'closed' | 'idle-closed' | 'error'

export function ComputerTerminal({ agentId }: { agentId: string }) {
  const { t } = useLingui()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const holder = useRef<HTMLDivElement | null>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const opening = useRef(false)
  const phaseRef = useRef<Phase>(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  /** Il tema di Homun: i token del tema chiaro/scuro, carattere monospace di sistema. */
  const themeOf = () => {
    const css = getComputedStyle(document.documentElement)
    const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
    return {
      background: v('--card', '#fff'),
      foreground: v('--foreground', '#111'),
      cursor: v('--foreground', '#111'),
      selectionBackground: v('--muted', '#ccc')
    }
  }

  const disconnect = () => {
    try {
      ws.current?.close()
    } catch {
      /* già chiusa */
    }
    ws.current = null
  }

  const open = async () => {
    if (opening.current) return
    opening.current = true
    disconnect()
    setError('')
    setPhase('opening')
    if (!term.current && holder.current) {
      const xterm = new Terminal({
        theme: themeOf(),
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        convertEol: false
      })
      const addon = new FitAddon()
      xterm.loadAddon(addon)
      xterm.open(holder.current)
      term.current = xterm
      fit.current = addon
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const { url } = await api.terminalOpen(agentId)
      setPhase('connecting')
      const xterm = term.current
      const socket = new WebSocket(url, ['binary'])
      socket.binaryType = 'arraybuffer'
      ws.current = socket
      socket.onopen = () => {
        if (timer) clearTimeout(timer)
        setPhase('connected')
        term.current?.focus()
      }
      socket.onmessage = (e) => {
        const data = e.data
        if (data instanceof ArrayBuffer) term.current?.write(new Uint8Array(data))
        else if (data instanceof Blob) void data.arrayBuffer().then((b) => term.current?.write(new Uint8Array(b)))
      }
      socket.onclose = (e) => {
        if (timer) clearTimeout(timer)
        if (ws.current !== socket) return // una sessione NUOVA ha già preso il posto
        ws.current = null
        const was = phaseRef.current
        if (e.code === IDLE_CLOSE_CODE) setPhase('idle-closed')
        else if (was === 'connected' || was === 'connecting') setPhase('closed')
      }
      socket.onerror = () => {
        // onclose segue sempre: qui si segna soltanto il Guasto se eravamo in corso
        if (phaseRef.current === 'connecting') setError(t`Il terminale non risponde.`)
      }
      if (xterm) {
        xterm.onData((data) => {
          if (ws.current === socket && socket.readyState === WebSocket.OPEN) socket.send(encodeTerminalInput(data))
        })
        xterm.onResize(({ cols, rows }) => {
          if (ws.current === socket && socket.readyState === WebSocket.OPEN) socket.send(encodeTerminalResize(cols, rows))
        })
      }
      // se entro 15 s non si apre: errore, mai un riquadro nero muto
      timer = setTimeout(() => {
        if (ws.current === socket) {
          disconnect()
          setPhase('error')
          setError(t`Il terminale non risponde.`)
        }
      }, CONNECT_TIMEOUT_MS)
    } catch (e) {
      setPhase('error')
      setError(ipcErrorMessage(e))
    } finally {
      opening.current = false
    }
  }

  // alla prima montatura della scheda: la sessione parte SUBITO
  useEffect(() => {
    void open()
    return () => {
      // chiudere il pannello chiude la sessione (il daemon manda EOF e SIGHUP)
      disconnect()
      term.current?.dispose()
      term.current = null
      fit.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  // sul resize del pannello si richiama fit; il nuovo size parte come frame 1
  useEffect(() => {
    const el = holder.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        try {
          fit.current?.fit()
        } catch {
          /* il contenitore non è ancora pronto */
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const statusLine = () => {
    switch (phase) {
      case 'opening':
      case 'connecting':
        return <Trans>Connessione al terminale…</Trans>
      case 'connected':
        return <Trans>Shell del bot — stessa identità dei suoi comandi.</Trans>
      case 'closed':
        return <Trans>Sessione chiusa.</Trans>
      case 'idle-closed':
        return <Trans>Sessione chiusa per inattività.</Trans>
      default:
        return null
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-1.5">
        <p className="min-w-0 truncate text-xs text-muted-foreground">{statusLine()}</p>
        <div className="flex shrink-0 items-center gap-2">
          {(phase === 'closed' || phase === 'idle-closed') && (
            <button
              className="rounded-lg bg-muted px-3 py-1 text-xs font-medium text-foreground transition hover:bg-accent"
              onClick={() => void open()}
            >
              <Trans>Riapri</Trans>
            </button>
          )}
        </div>
      </div>
      {/* il terminale vive qui (xterm): nero su chiaro col tema di Homun */}
      <div ref={holder} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
      {phase === 'error' && (
        <div className="border-t border-border px-4 py-4 text-center">
          <p className="text-sm text-destructive/90">{error || t`Errore di connessione.`}</p>
          <button
            className="mt-3 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            onClick={() => void open()}
          >
            <Trans>Riprova</Trans>
          </button>
        </div>
      )}
    </div>
  )
}
