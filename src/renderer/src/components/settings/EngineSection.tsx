// Fase box-container (BX4) + OB3 (fase onboarding-b): la riga «Computer dei
// bot» nelle Impostazioni › Generali: il motore in uso (o quello che
// l'Automatico ha scelto), lo stato in parole semplici — «Pronto (Apple
// container)», «Spento — Accendi», «Manca il kernel di Linux» — e il
// selettore Automatico / Apple container / Docker. «Accendi» usa
// `container system start --disable-kernel-install` (il kernel NON si
// scarica mai di nascosto); il kernel si installa SOLO col consenso
// esplicito. OB3: con `not-installed` il bottone «Installa» avvia la
// STESSA preparazione della guida (box:setup-start) e mostra la STESSA
// lista d'avanzamento (BoxSetupProgress, il componente condiviso); il
// link alle release resta come «Dettagli»; con la preparazione in corso
// o in errore, la stessa lista con Riprova o Annulla.
import { useEffect, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { api, useStore } from '../../store'
import type { EngineStatusInfo } from '../../../../shared/types'
import { BoxSetupProgress } from '../BoxSetupProgress'
import { boxSetupActive } from '../../lib/box-setup-rows'

export const APPLE_CONTAINER_RELEASES_URL = 'https://github.com/apple/container/releases'

/**
 * Lo stato in PAROLE della riga (pura): prima il motore SCELTO (docker può
 * essere la scelta anche su un Mac che regge Apple), poi gli stati del
 * motore Apple con la loro azione. OB3: not-installed ora ha l'azione
 * «Installa» — la preparazione di OB1 (download, verifica, finestra di
 * Apple, servizio, kernel, immagine).
 */
export function engineStatusText(st: EngineStatusInfo): { text: MessageDescriptor; action: 'start' | 'kernel' | 'install' | 'install-link' | null } {
  // il motore DI DUTY è docker: le sue parole, e non si tocca apple
  if (st.chosen === 'docker') {
    return st.dockerRunning
      ? { text: msg`Pronto (Docker)`, action: null }
      : { text: msg`Docker non risponde: aprilo e riprova`, action: null }
  }
  // apple-container (scelto dall'auto PRONTO, o scelto esplicito), o NESSUN
  // motore (auto senza docker): le parole le dice lo STATO del motore Apple,
  // mai «pronto» se il servizio è spento o il kernel manca
  switch (st.appleState) {
    case 'ready':
      return { text: msg`Pronto (Apple container)`, action: null }
    case 'stopped':
      return { text: msg`Spento`, action: 'start' }
    case 'kernel-missing':
      return { text: msg`Manca il kernel di Linux`, action: 'kernel' }
    case 'not-installed':
      return { text: msg`Da installare: serve macOS 26 o successivo`, action: 'install' }
    default:
      return { text: msg`Serve macOS 26 o successivo, con chip Apple`, action: null }
  }
}

/** L'etichetta del selettore (pura). */
export function engineChoiceLabel(id: 'auto' | 'apple-container' | 'docker'): MessageDescriptor {
  switch (id) {
    case 'auto': return msg`Automatico`
    case 'apple-container': return msg`Apple container`
    case 'docker': return msg`Docker`
  }
}

export function EngineSection() {
  const { i18n } = useLingui()
  const [st, setSt] = useState<EngineStatusInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // OB3: lo stato della preparazione (RPC + evento box-setup, senza ricaricare)
  const boxSetup = useStore((s) => s.boxSetup)
  const boxSetupStart = useStore((s) => s.boxSetupStart)
  const boxSetupCancel = useStore((s) => s.boxSetupCancel)
  const boxSetupRetry = useStore((s) => s.boxSetupRetry)
  const boxSetupOpenInstaller = useStore((s) => s.boxSetupOpenInstaller)
  // OB5: «Disinstalla lo strumento di Apple» (visibile solo se installato)
  const [uninstalling, setUninstalling] = useState(false)
  const containerInstalled = st !== null && st.appleState !== 'not-installed' && st.appleState !== 'unsupported'

  const load = (): void => {
    void api.boxEngineStatus().then(setSt).catch(() => undefined)
  }
  useEffect(load, [])

  const choose = (engine: 'auto' | 'apple-container' | 'docker'): void => {
    setBusy(true)
    setError(null)
    void api
      .boxEngineSet(engine)
      .then(setSt)
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const runEngine = (what: 'start' | 'kernel'): void => {
    setBusy(true)
    setError(null)
    // il kernel si installa SOLO dopo il SÌ esplicito (la riga lo chiede)
    if (what === 'kernel' && !window.confirm(i18n._(msg`Installare il kernel di Linux raccomandato? Verrà scaricato da Apple (circa 1 GB).`))) {
      setBusy(false)
      return
    }
    const done = (r: { ok: boolean; error?: string }): void => {
      if (!r.ok) setError(r.error ?? 'error')
      setBusy(false)
      load()
    }
    const p = what === 'start' ? api.boxEngineStart() : api.boxEngineKernelInstall()
    void p.then(done).catch(() => {
      setBusy(false)
      load()
    })
  }

  const runUninstall = (): void => {
    // il dialogo di conferma, IN PAROLE (la spec lo fissa)
    if (!window.confirm(i18n._(msg`Toglie container da /usr/local. Ti chiederà la password del Mac. I computer dei bot vengono rimossi.`))) return
    setUninstalling(true)
    setError(null)
    void api.boxEngineUninstall()
      .then((r) => { if (!r.ok) setError(r.error ?? 'error') })
      .catch(() => setError('error'))
      .finally(() => { setUninstalling(false); load() })
  }

  const status = st ? engineStatusText(st) : null
  // OB3: la lista d'avanzamento si mostra quando la preparazione CORRE (o è
  // ferma su un errore da riprovare) — a ready basta la riga del motore
  const showProgress = boxSetup !== null && (boxSetupActive(boxSetup.phase) || boxSetup.phase === 'error')
  return (
    <section className="mt-6" data-testid="engine-section">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {i18n._(msg`Computer dei bot`)}
      </h3>
      <div className="rounded-2xl border bg-card p-1">
        <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5">
          <div className="min-w-0" data-testid="engine-status-text">
            <p className="truncate text-sm">
              {status ? i18n._(status.text) : i18n._(msg`Sto guardando…`)}
            </p>
            {st?.setting === 'auto' && (
              <p className="text-xs text-muted-foreground">
                {i18n._(msg`Motore scelto in automatico`)}
              </p>
            )}
          </div>
          {status?.action === 'start' && (
            <button
              className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
              disabled={busy}
              onClick={() => runEngine('start')}
            >
              {i18n._(msg`Accendi`)}
            </button>
          )}
          {status?.action === 'kernel' && (
            <button
              className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
              disabled={busy}
              onClick={() => runEngine('kernel')}
            >
              {i18n._(msg`Installa il kernel`)}
            </button>
          )}
          {/* OB3: «Installa» avvia la STESSA preparazione della guida */}
          {status?.action === 'install' && (
            <button
              className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
              disabled={busy}
              data-testid="engine-install"
              onClick={() => { void boxSetupStart() }}
            >
              {i18n._(msg`Installa`)}
            </button>
          )}
        </div>
        {st?.appleState === 'not-installed' && (
          <div className="border-b border-border/40 px-3 py-2.5 text-xs text-muted-foreground" data-testid="engine-install-hint">
            <p>
              {i18n._(msg`Il computer dei bot senza Docker usa Apple container: lo installa Apple col suo pacchetto firmato (chiede la password del Mac).`)}{' '}
              <a className="underline" href={APPLE_CONTAINER_RELEASES_URL} target="_blank" rel="noreferrer">
                {i18n._(msg`Dettagli`)}
              </a>
            </p>
          </div>
        )}
        {/* OB3: la lista d'avanzamento della preparazione, la STESSA della guida */}
        {showProgress && boxSetup && (
          <div className="border-b border-border/40 px-3 py-3">
            <BoxSetupProgress
              state={boxSetup}
              onOpenInstaller={() => { void boxSetupOpenInstaller() }}
              onCancel={() => { void boxSetupCancel() }}
            />
            {boxSetup.phase === 'error' && boxSetup.error && (
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="m-0 min-w-0 text-xs text-destructive" data-testid="engine-setup-error">{boxSetup.error.message}</p>
                <button
                  className="shrink-0 rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  data-testid="engine-setup-retry"
                  onClick={() => { void boxSetupRetry() }}
                >
                  {i18n._(msg`Riprova`)}
                </button>
              </div>
            )}
          </div>
        )}
        {containerInstalled && (
          <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5">
            <p className="min-w-0 text-xs text-muted-foreground" data-testid="engine-uninstall-hint">
              {i18n._(msg`Lo strumento di Apple si può togliere: chiede la password del Mac e rimuove i computer dei bot.`)}
            </p>
            <button
              className="shrink-0 rounded-full px-3 py-1.5 text-xs text-destructive outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
              disabled={uninstalling}
              data-testid="engine-uninstall"
              onClick={() => runUninstall()}
            >
              {i18n._(msg`Disinstalla lo strumento di Apple`)}
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">{i18n._(msg`Motore`)}</p>
          <span className="flex gap-1 rounded-full bg-card p-1">
            {(['auto', 'apple-container', 'docker'] as const).map((id) => (
              <button
                key={id}
                className={`rounded-full px-3 py-1 text-xs outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                  (st?.setting ?? 'auto') === id ? 'bg-foreground text-background' : 'text-muted-foreground'
                }`}
                disabled={busy}
                onClick={() => choose(id)}
              >
                {i18n._(engineChoiceLabel(id))}
              </button>
            ))}
          </span>
        </div>
        {error && (
          <p className="px-3 pb-2 pt-1 text-xs text-destructive" data-testid="engine-error">
            {error.slice(0, 200)}
          </p>
        )}
      </div>
    </section>
  )
}
