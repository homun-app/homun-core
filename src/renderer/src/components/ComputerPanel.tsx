// Fase 19b (T1): il pannello «Computer» del bot — quattro schede accanto
// allo schermo: Schermo (come la 19a), Terminale (solo docker), File (sempre)
// e Attività (sempre). La scheda scelta si ricorda PER BOT nello store del
// renderer; alla prima apertura si parte da Attività, che funziona in ogni
// modalità. Le schede tengono la loro SESSIONE quando si passa dall'una
// all'altra (montate, nascoste col CSS): il terminale non si chiude cambiando
// scheda — si chiude chiudendo il pannello.
//
// Fase design (DS4): DENTRO il pannello del bot la scheda è una colonna nel
// modo di PageShell, senza però lo scorrimento di colonna del pannello:
//   - la radice è un figlio diretto del pannello e riempie lo spazio che resta
//     (min-h-0 flex-1). Prima aveva un'altezza minima di 420 px DENTRO lo
//     scorrimento del pannello: in una finestra bassa (900×640) scorreva tutto
//     il pannello, sotto la testa fissa;
//   - la riga delle sotto-schede sta FERMA in testa, alla larghezza del
//     contenuto del pannello (px-1.5 + PageColumn: gli stessi 6 + 24 px per
//     lato della testa);
//   - le aree che scorrono (file, attività) sono LARGHE QUANTO IL PANNELLO —
//     la barra sta sul bordo — col margine DENTRO: lo schema del pannello
//     (RightPanel), ripetuto qua.
// Le sotto-schede sono un interruttore a segmenti (Button: la scelta
// «secondary», le altre «ghost») e NON UnderlineTabs: hanno sopra, a due
// passi, le schede a sottolineatura del pannello, e due righe uguali si
// leggerebbero come una sola. Le righe di Docker sono Notice del sistema.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { TriangleAlert, X } from 'lucide-react'
import { api, useStore, type ComputerTab } from '../store'
// fase rilascio (A7): docker trovato e avviato?
export const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/'
import { BotScreen } from './BotScreen'
import { ComputerTerminal } from './ComputerTerminal'
import { ComputerFiles } from './ComputerFiles'
import { ComputerActivity } from './ComputerActivity'
import { Button } from './ui/button'
import { Notice } from './ui/notice'
import { PageColumn } from './ui/page-shell'
import { cn } from '../lib/utils'

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
        // BX1: 'box' è il valore nuovo; 'docker' il valore storico (letto uguale)
        const box = mode === 'box' || mode === 'docker'
        setHasTerminal(box)
        if (!box) {
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

  // fase rilascio (A7): docker mancante o fermo → una riga in parole, non un
  // errore tecnico (vale solo in modalità docker: in host non serve)
  const [dockerMode, setDockerMode] = useState(false)
  const [dockerOk, setDockerOk] = useState(true)
  const [dockerBusy, setDockerBusy] = useState(false)
  // M10 (fase 0.3.1001): prefisso dei nomi del box di prova non valido
  const [prefixInvalid, setPrefixInvalid] = useState(false)
  const readDockerStatus = (retry: boolean): void => {
    setDockerBusy(true)
    void (retry ? api.boxDockerRetry() : api.boxDockerStatus())
      .then((r: { installed: boolean; running: boolean; path: string; testPrefixInvalid?: boolean }) => {
        setDockerMode(true)
        setDockerOk(r.installed && r.running)
        setPrefixInvalid(r.testPrefixInvalid === true)
      })
      .catch(() => undefined)
      .finally(() => setDockerBusy(false))
  }
  useEffect(() => {
    void api.settingsGet<string>('sandbox.mode', 'host').then((mode) => {
      if (mode === 'box' || mode === 'docker') readDockerStatus(false)
      else setDockerMode(false)
    }).catch(() => setDockerMode(false))
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
          ? // fase 16b (S4): dentro il pannello del bot la scheda si allarga a
            // 560 px e il contenuto riempie lo spazio che resta (DS4: è un
            // figlio diretto del pannello, vedi in cima)
            'flex min-h-0 flex-1 flex-col'
          : // fuori dal pannello (oggi nessuno la rende così): una scheda che
            // galleggia, alta dai 420 px ai sette decimi del contenitore
            'mx-5 mt-3 flex max-h-7/10 min-h-105 flex-col overflow-hidden rounded-surface border bg-card shadow-soft'
      }
    >
      {/* fase 16b correzioni (P5): in modalità embedded (dentro il pannello del
          bot) NIENTE titolo «COMPUTER DEL BOT» e NIENTE ✕ — la chiusura è
          quella tonda del pannello del bot; restano solo le schede interne.
          Fase design (DS4): la riga è ferma e sta alla larghezza del contenuto
          del pannello (px-1.5 + PageColumn); alta 40, come la barra degli
          strumenti delle pagine. Niente overflow-x-auto qui: l'anello del
          fuoco dei bottoni sporge di 4 px e verrebbe tagliato (e le quattro
          voci ci stanno sempre, a 560 px) */}
      <header className={cn('flex shrink-0 items-center gap-3 border-b border-border/50 px-1.5', !embedded && 'justify-between py-2')}>
        <PageColumn className="flex min-h-10 min-w-0 items-center gap-1">
          {!embedded && (
            <p className="mr-2 hidden text-caption font-medium text-muted-foreground sm:inline">
              <Trans>Computer del bot</Trans>
            </p>
          )}
          {tabs.filter((x) => x.on).map((x) => (
            // sotto-schede: un bottone ciascuna, col solo testo (le sonde le
            // cercano per testo esatto fra i «button» del pannello)
            <Button key={x.id} variant={tab === x.id ? 'secondary' : 'ghost'} size="sm" onClick={() => setPanel(true, x.id)}>
              {x.label}
            </Button>
          ))}
        </PageColumn>
        {!embedded && (
          <Button variant="ghost" size="sm" icon title={t`Chiudi`} onClick={onClose}>
            <X className="size-4" />
          </Button>
        )}
      </header>

      {/* fase rilascio (A7): Docker Desktop serve per schermo e terminale */}
      {dockerMode && !dockerOk && (
        <div className="shrink-0 border-b border-border/50 px-1.5 py-1">
          <PageColumn>
            <Notice
              icon={<TriangleAlert className="size-4" aria-hidden="true" />}
              action={(
                <Button size="sm" disabled={dockerBusy} onClick={() => readDockerStatus(true)}>
                  <Trans>Riprova</Trans>
                </Button>
              )}
            >
              <Trans>Per il computer dei bot serve Docker Desktop: installalo e aprilo, poi Riprova.</Trans>{' '}
              <a className="underline" href={DOCKER_DESKTOP_URL} target="_blank" rel="noreferrer">
                <Trans>docker.com</Trans>
              </a>
            </Notice>
          </PageColumn>
        </div>
      )}

      {/* M10 (fase 0.3.1001): prefisso dei nomi del box di prova non valido —
          la riga Docker lo dice; la sandbox non parte mai coi nomi dell'utente */}
      {dockerMode && prefixInvalid && (
        <div className="shrink-0 border-b border-border/50 px-1.5 py-1">
          <PageColumn>
            <Notice tone="destructive" icon={<TriangleAlert className="size-4" aria-hidden="true" />}>
              <Trans>Prefisso di prova non valido: correggi SANDBOT_TEST_BOX_PREFIX (deve partire per «sbtest») o toglierla, poi riavvia.</Trans>
            </Notice>
          </PageColumn>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
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
