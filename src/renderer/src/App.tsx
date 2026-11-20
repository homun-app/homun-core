import { useEffect, useRef, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { useStore } from './store'
import { Sidebar, SidebarToggleButton } from './components/Sidebar'
import { Chat } from './components/Chat'
// fase 16b (S5): la squadra è una vista di prima classe, al posto della chat
import { TeamChat } from './components/TeamChat'
// Q2 (fase squadra): la coda «Da approvare» della squadra (tavola 2)
import { ApprovalsQueue } from './components/ApprovalsQueue'
// A2 (fase centro-autorizzazioni): il centro «Da approvare» (tavola 4)
import { ApprovalsCenter } from './components/ApprovalsCenter'
import { RightPanel } from './components/RightPanel'
import { Settings } from './components/Settings'
// OA2 (fase onboarding-a): la guida a passi del primo avvio, a tutta finestra
import { GuideView } from './components/GuideView'
import { LibraryPanel } from './components/LibraryPanel'
// fase 16c (C5/C4): la vista Attività e la finestra «Collega app»
import { ActivityPanel } from './components/ActivityPanel'
import { AppsWindow } from './components/AppsWindow'
import { SkillsWindow } from './components/SkillsWindow'
import { api } from './store'
// fase 16b correzioni 2 (Q1): il layout a tre colonne è UNA funzione pura
import { layoutFor, TRAFFIC_LIGHT_INSET } from './layout'
// OAC1 (fase guida): la finestra mostra la guida quando è APERTA (guideOpen),
// non quando «serve» — e col needed senza stato resta in caricamento
import { guideWindowState } from './lib/guide-window'
// G6 (fase guida): all'arrivo in chat la mascotte VOLA dalla scena al
// pannello del bot (FLIP via Web Animations); se non si può, semplice dissolvenza
import { flyStashedMascotTo } from './lib/guide-arrival'

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
  // OA1 (fase onboarding-a): finché il daemon non dice lo stato del primo
  // avvio, la finestra CARICA — niente chat vuota, niente «Bot» da sola.
  // OAC1 (fase guida): la GUIDA si vede quando è APERTA (guideOpen: lo dice
  // lo stato, anche per chi ha già scritto e l'ha riaperta da Impostazioni);
  // col needed ma stato non ancora nato si resta sullo splash (niente lampo
  // della shell vuota)
  const onboardingStatus = useStore((s) => s.onboarding)
  const onboardingKnown = onboardingStatus !== null
  const guideView = guideWindowState(onboardingStatus)
  // G6: il passaggio guida → shell è l'ARRIVO: la mascotte parcheggiata dalla
  // guida vola al suo posto (due frame: il tempo della shell in campo)
  const prevGuideView = useRef(guideView)
  useEffect(() => {
    const was = prevGuideView.current
    prevGuideView.current = guideView
    if (was !== 'guide' || guideView !== 'shell') return
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => flyStashedMascotTo()))
    return () => cancelAnimationFrame(raf)
  }, [guideView])

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

  // A4 (fase centro-autorizzazioni): il fuoco della finestra al daemon — le
  // notifiche delle richieste spariscono quando l'utente guarda l'app (ci
  // pensano il riquadro e la barra), tornano quando la copre
  useEffect(() => {
    const signal = (): void => { void api.presenceWindowFocus(document.hasFocus()).catch(() => undefined) }
    window.addEventListener('focus', signal)
    window.addEventListener('blur', signal)
    signal()
    return () => {
      window.removeEventListener('focus', signal)
      window.removeEventListener('blur', signal)
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
  // Q2 (fase squadra): la coda «Da approvare» copre l'area centrale Solo quando è APERTA
  const approvalsQueueOpen = useStore((s) => s.approvalsQueueOpen)
  // A2 (fase centro-autorizzazioni): il centro «Da approvare» copre l'area centrale quando è aperto
  const approvalsOpen = useStore((s) => s.approvalsOpen)
  const layout = layoutFor({ windowWidth, sidebarCollapsedByUser: sidebarCollapsed, sidebarWidthPref: sidebarWidth, panelOpen: rightPanel, panelTab })
  if (!onboardingKnown || guideView === 'loading') return <BootSplash />
  if (guideView === 'guide') return <GuideView />
  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <LegacyHomun2Notice />
      <div className="relative flex min-h-0 flex-1">
      {/* U2 (fase prima-release): il bottone della barra, FISSO accanto ai
          semafori nella STESSA posizione da larga e da stretta (sopra le
          colonne: da rotaia la barra è 76 px e il bottone non ci starebbe) */}
      <div className="absolute left-0 top-0 z-30" style={{ paddingLeft: TRAFFIC_LIGHT_INSET, paddingTop: 12 }}>
        <SidebarToggleButton layout={layout} />
      </div>
      <Sidebar layout={layout} />
      <div className="relative flex min-w-0 flex-1">
        {openGroupId === null ? <Chat layout={layout} /> : <TeamChat />}
        {/* Q2 (fase squadra): la coda copre l'area centrale quando è aperta */}
        {openGroupId !== null && approvalsQueueOpen && <ApprovalsQueue />}
        {/* B1 (fase beta10-correzioni): il centro copre l'area centrale SOLO
            quando è aperto — reso senza condizione restava per sempre sopra la
            chat e la finestra non si usava più (select, squadra, Libreria e
            Attività chiudono approvalsOpen: qui è l'UNICO punto che decide) */}
        {approvalsOpen && <ApprovalsCenter />}
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

/**
 * OA1 (fase onboarding-a): il caricamento del primo avvio. Il daemon sta
 * decidendo se serve la guida (e, se è il caso, creando il bot principale):
 * la finestra non mostra né la chat vuota né un «Bot» prematuro. Stile della
 * finestra App di oggi: fondo tenue, niente bordi.
 * OBV6.2 (fase onboarding-b-dal-vivo): al mount lo splash mette un
 * MARCATORE che RESTA (documentElement.dataset.bootSplashSeen) — la sonda
 * G8-1a controlla il marcatore invece di inseguire lo splash, che dura
 * pochissimo: era una gara di tempi della sonda, non un difetto del prodotto.
 */
function BootSplash() {
  useEffect(() => {
    document.documentElement.dataset.bootSplashSeen = '1'
  }, [])
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-5 bg-muted/40 text-foreground" data-testid="boot-splash">
      <div className="flex h-16 w-16 animate-pulse items-center justify-center rounded-[18px] bg-muted text-2xl font-display" aria-hidden>🧚</div>
      <div className="flex flex-col items-center gap-2">
        <p className="font-display text-xl">Homun</p>
        <p className="text-xs text-muted-foreground">
          <Trans>Preparo tutto…</Trans>
        </p>
      </div>
    </div>
  )
}
