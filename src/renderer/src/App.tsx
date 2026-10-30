import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { RightPanel } from './components/RightPanel'
import { Settings } from './components/Settings'
import { api } from './store'

/** Minimo intervallo tra due segnali 'active' (il daemon ne scarta uno ogni 30 s). */
const ACTIVE_EVERY_MS = 30_000
/** Minimo intervallo tra due segnali 'typing' (evita una RPC per tasto). */
const TYPING_EVERY_MS = 5_000

export function App() {
  const init = useStore((s) => s.init)
  const settingsOpen = useStore((s) => s.settingsOpen)

  useEffect(() => {
    void init()
  }, [init])

  // fase 6 (§3ter T2): segnali di presenza al daemon — 'active' su focus e
  // input da tastiera/mouse (al massimo uno ogni 30 s), 'typing' quando si
  // scrive nel campo della chat. Il daemon calcola l'ultimo momento di
  // presenza e al rientro fa partire il look-around del bot principale.
  useEffect(() => {
    let lastActive = 0
    let lastTyping = 0
    const sendActive = (): void => {
      const now = Date.now()
      if (now - lastActive < ACTIVE_EVERY_MS) return
      lastActive = now
      void api.presenceSignal('active').catch(() => undefined)
    }
    const sendTyping = (): void => {
      const now = Date.now()
      if (now - lastTyping < TYPING_EVERY_MS) return
      lastTyping = now
      void api.presenceSignal('typing').catch(() => undefined)
    }
    const onKey = (e: KeyboardEvent): void => {
      sendActive()
      if (e.key.length === 1 || e.key === 'Backspace') sendTyping()
    }
    window.addEventListener('focus', sendActive)
    window.addEventListener('mousemove', sendActive)
    window.addEventListener('keydown', onKey)
    sendActive()
    return () => {
      window.removeEventListener('focus', sendActive)
      window.removeEventListener('mousemove', sendActive)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // fase 16 (U4): la shell a 3 colonne di Lovable — sidebar, chat, pannello destro
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <Chat />
      <RightPanel />
      {settingsOpen && <Settings />}
    </div>
  )
}
