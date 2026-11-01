// Fase 19b (T1): il pannello «Computer» del bot — quattro schede accanto
// allo schermo: Schermo (come la 19a), Terminale (solo docker), File (sempre)
// e Attività (sempre). La scheda scelta si ricorda PER BOT nello store del
// renderer; alla prima apertura si parte da Attività, che funziona in ogni
// modalità. Le schede tengono la loro SESSIONE quando si passa dall'una
// all'altra (montate, nascoste col CSS): il terminale non si chiude cambiando
// scheda — si chiude chiudendo il pannello.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api, useStore, type ComputerTab } from '../store'
import { BotScreen } from './BotScreen'
import { ComputerTerminal } from './ComputerTerminal'
import { ComputerFiles } from './ComputerFiles'
import { ComputerActivity } from './ComputerActivity'

export function ComputerPanel({ agentId, onClose, embedded = false }: { agentId: string; onClose: () => void; embedded?: boolean }) {
  const { t } = useLingui()
  const panel = useStore((s) => s.computerPanel)
  const setPanel = useStore((s) => s.setComputerPanel)
  // quali schede esistono in questa modalità (Schermo: docker+rete; Terminale:
  // docker; File e Attività: sempre)
  const [hasScreen, setHasScreen] = useState(false)
  const [hasTerminal, setHasTerminal] = useState(false)
  useEffect(() => {
    void api.settingsGet<string>('sandbox.mode', 'host')
      .then(async (mode) => {
        const docker = mode === 'docker'
        setHasTerminal(docker)
        if (!docker) {
          setHasScreen(false)
          return
        }
        const network = await api.settingsGet<string>('sandbox.network', 'bridge')
        setHasScreen(network === 'bridge')
      })
      .catch(() => {
        setHasScreen(false)
        setHasTerminal(false)
      })
  }, [])

  const available = (tab: ComputerTab): boolean =>
    tab === 'files' || tab === 'activity' || (tab === 'screen' ? hasScreen : hasTerminal)
  // la scheda corrente: quella del pannello se valida qui, altrimenti Attività
  const tab: ComputerTab = available(panel.tab) ? panel.tab : 'activity'
  // le schede VISITATE restano montate (sessione viva), nascoste col CSS
  const [visited, setVisited] = useState<Set<ComputerTab>>(new Set([tab]))
  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)))
  }, [tab])

  const tabs: Array<{ id: ComputerTab; label: string; on: boolean }> = [
    { id: 'screen', label: t`Schermo`, on: hasScreen },
    { id: 'terminal', label: t`Terminale`, on: hasTerminal },
    { id: 'files', label: t`File`, on: true },
    { id: 'activity', label: t`Attività`, on: true }
  ]

  return (
    <section
      className={
        embedded
          ? // fase 16b (S4): dentro il pannello del bot, la scheda Computer si
            // allarga a 560 px e il contenuto riempie lo spazio
            'flex h-full min-h-[420px] flex-col'
          : 'mx-5 mt-3 flex max-h-[70vh] min-h-[420px] flex-col overflow-hidden rounded-xl border bg-card shadow-soft'
      }
    >
      <header className="flex items-center justify-between gap-3 px-1 py-2">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          <p className="mr-2 hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:inline">
            <Trans>Computer del bot</Trans>
          </p>
          {tabs.filter((x) => x.on).map((x) => (
            <button
              key={x.id}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${tab === x.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              onClick={() => setPanel(true, x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <button
          className="rounded-md px-2 py-1 text-muted-foreground transition hover:text-foreground"
          title={t`Chiudi`}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden">
        {/* ogni scheda visitata resta MONTATA: la sessione (terminale, anteprima)
            sopravvive al passaggio dall'una all'altra */}
        <div className={`h-full overflow-y-auto scroll-thin ${tab === 'screen' ? '' : 'hidden'}`} role="tabpanel" hidden={tab !== 'screen'}>
          {visited.has('screen') && <BotScreen agentId={agentId} inPanel />}
        </div>
        <div className={`h-full ${tab === 'terminal' ? '' : 'hidden'}`} role="tabpanel" hidden={tab !== 'terminal'}>
          {visited.has('terminal') && <ComputerTerminal agentId={agentId} />}
        </div>
        <div className={`h-full overflow-y-auto scroll-thin ${tab === 'files' ? '' : 'hidden'}`} role="tabpanel" hidden={tab !== 'files'}>
          {visited.has('files') && <ComputerFiles agentId={agentId} active={tab === 'files'} />}
        </div>
        <div className={`h-full overflow-y-auto scroll-thin ${tab === 'activity' ? '' : 'hidden'}`} role="tabpanel" hidden={tab !== 'activity'}>
          {visited.has('activity') && <ComputerActivity agentId={agentId} active={tab === 'activity'} />}
        </div>
      </div>
    </section>
  )
}
