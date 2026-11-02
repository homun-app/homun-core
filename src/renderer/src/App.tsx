import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
// fase 16b (S5): la squadra è una vista di prima classe, al posto della chat
import { TeamChat } from './components/TeamChat'
import { RightPanel } from './components/RightPanel'
import { Settings } from './components/Settings'
import { LibraryPanel } from './components/LibraryPanel'
import { api } from './store'
// fase 16b correzioni 2 (Q1): il layout a tre colonne è UNA funzione pura
import { layoutFor } from './layout'

/** Minimo intervallo tra due segnali 'active' (il daemon ne scarta uno ogni 30 s). */
const ACTIVE_EVERY_MS = 30_000
/** Minimo intervallo tra due segnali 'typing' (evita una RPC per tasto). */
const TYPING_EVERY_MS = 5_000
/** Debounce del listener resize (Q1): il layout si ricalcola una volta sola. */
const RESIZE_DEBOUNCE_MS = 100

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

  // fase 16b correzioni 2 (Q1): la larghezza della finestra nello store, con
  // un listener resize appena debounced — la chat non scende mai sotto
  // CHAT_MIN, prima cede il pannello poi la barra (vedi layout.ts)
  const setWindowWidth = useStore((s) => s.setWindowWidth)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => setWindowWidth(window.innerWidth), RESIZE_DEBOUNCE_MS)
    }
    setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => {
      if (t) clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [setWindowWidth])

  // fase 16 (U4): la shell a 3 colonne; fase 16b (S5): al centro la chat del
  // bot OPPURE la squadra selezionata; la Libreria copre l'area centrale.
  // correzioni 2 (Q1): Sidebar e RightPanel ricevono lo STESSO layout — con
  // il pannello in overlay la radice resta relative e overflow-hidden: per
  // costruzione niente sporge
  const openGroupId = useStore((s) => s.openGroupId)
  const windowWidth = useStore((s) => s.windowWidth)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const rightPanel = useStore((s) => s.rightPanel)
  // «members» quando la squadra è aperta: il pannello non è mai wide
  const panelTab = useStore((s) => (s.openGroupId !== null ? ('members' as const) : s.panelTab))
  const layout = layoutFor({ windowWidth, sidebarCollapsedByUser: sidebarCollapsed, sidebarWidthPref: sidebarWidth, panelOpen: rightPanel, panelTab })
  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar layout={layout} />
      <div className="relative flex min-w-0 flex-1">
        {openGroupId === null ? <Chat /> : <TeamChat />}
        <LibraryPanel />
      </div>
      <RightPanel layout={layout} />
      {settingsOpen && <Settings />}
    </div>
  )
}
