import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
// fase 16b (S5): la squadra è una vista di prima classe, al posto della chat
import { TeamChat } from './components/TeamChat'
import { RightPanel } from './components/RightPanel'
import { Settings } from './components/Settings'
import { LibraryPanel } from './components/LibraryPanel'
// fase 16c (C5/C4): la vista Attività e la finestra «Collega app»
import { ActivityPanel } from './components/ActivityPanel'
import { AppsWindow } from './components/AppsWindow'
import { SkillsWindow } from './components/SkillsWindow'
import { api } from './store'
// fase 16b correzioni 2 (Q1): il layout a tre colonne è UNA funzione pura
import { layoutFor, TRAFFIC_LIGHT_INSET } from './layout'

/** Minimo intervallo tra due segnali 'active' (il daemon ne scarta uno ogni 30 s). */
const ACTIVE_EVERY_MS = 30_000
/** Minimo intervallo tra due segnali 'typing' (evita una RPC per tasto). */
const TYPING_EVERY_MS = 5_000
/** Debounce del listener resize (Q1): il layout si ricalcola una volta sola. */
const RESIZE_DEBOUNCE_MS = 100

// fase rilascio (A8): la riga UNA VOLTA del passaggio da Homun 2 — le
// conversazioni e i bot di Homun 2 NON vengono importati; la cartella si può
// aprire nel Finder. Niente si legge e niente si tocca là dentro.
// FASE RILASCIO — CORREZIONI (K4): la riga sta nella zona del titolo, dove
// i semafori di macOS coprono l'inizio — lascia libero il loro spazio
// (TRAFFIC_LIGHT_INSET, la stessa costante della testata della Sidebar), è
// una fascia di trascinamento (i bottoni no), il percorso completo diventa
// «nella cartella di Homun 2» (il percorso lo apre già «Mostra nel Finder»)
// e a finestra stretta sta su UNA riga, troncata, col testo intero nel title.
function LegacyHomun2Notice() {
  const { t } = useLingui()
  const [dir, setDir] = useState<string | null>(null)
  useEffect(() => {
    void api.legacyHomun2().then((r) => setDir(r ? r.dir : null)).catch(() => setDir(null))
  }, [])
  if (!dir) return null
  const text = t`Homun è stato rinnovato. Le conversazioni e i bot di Homun 2 non sono stati importati: restano sul tuo Mac nella cartella di Homun 2.`
  return (
    <div
      className="drag-region flex items-center justify-between gap-3 border-b bg-muted py-2 pr-4 text-xs text-muted-foreground"
      style={{ paddingLeft: TRAFFIC_LIGHT_INSET }}
    >
      <p className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </p>
      <span className="flex shrink-0 items-center gap-2">
        <button
          className="no-drag rounded-full bg-foreground px-3 py-1 text-[11px] text-background"
          title={dir}
          onClick={() => void api.revealInFinder(dir)}
        >
          <Trans>Mostra nel Finder</Trans>
        </button>
        <button
          className="no-drag rounded-full px-2 py-1 text-[11px] hover:text-foreground"
          title={t`Non mostrare più`}
          onClick={() => {
            setDir(null)
            void api.legacyHomun2Dismiss()
          }}
        >
          ✕
        </button>
      </span>
    </div>
  )
}

export function App() {
  const init = useStore((s) => s.init)
  const settingsOpen = useStore((s) => s.settingsOpen)
  // fase 16c (C4): la finestra «Collega app»
  const appsOpen = useStore((s) => s.appsOpen)
  // fase skill (S4): la finestra «Skill» (libreria unica)
  const skillsOpen = useStore((s) => s.skillsOpen)

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

  // fase 16c correzioni (R7.3): ⌘, apre le Impostazioni, lo standard di macOS
  // (l'app non ha un menu di Electron: la scorciatoia vive qui nel renderer;
  // Esc chiude come sempre, la gestisce il Dialog)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

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
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <LegacyHomun2Notice />
      <div className="relative flex min-h-0 flex-1">
      <Sidebar layout={layout} />
      <div className="relative flex min-w-0 flex-1">
        {openGroupId === null ? <Chat /> : <TeamChat />}
        <LibraryPanel />
        <ActivityPanel />
      </div>
      <RightPanel layout={layout} />
      {settingsOpen && <Settings />}
      {appsOpen && <AppsWindow />}
      {skillsOpen && <SkillsWindow />}
      </div>
    </div>
  )
}
