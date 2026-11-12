// Fase box-container (BX4): la riga «Computer dei bot» nelle Impostazioni ›
// Generali: il motore in uso (o quello che l'Automatico ha scelto), lo stato
// in parole semplici — «Pronto (Apple container)», «Spento — Accendi», «Da
// installare: serve macOS 26 o successivo», «Manca il kernel di Linux» — e
// il selettore Automatico / Apple container / Docker. «Accendi» usa
// `container system start --disable-kernel-install` (il kernel NON si
// scarica mai di nascosto); il kernel si installa SOLO col consenso
// esplicito. Installare Apple container lo fa l'utente col pacchetto di
// Apple: qui c'è il link alle release e l'avviso della password del Mac.
import { useEffect, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { api } from '../../store'
import type { EngineStatusInfo } from '../../../../shared/types'

export const APPLE_CONTAINER_RELEASES_URL = 'https://github.com/apple/container/releases'

/**
 * Lo stato in PAROLE della riga (pura): prima il motore SCELTO (docker può
 * essere la scelta anche su un Mac che regge Apple), poi gli stati del
 * motore Apple con la loro azione.
 */
export function engineStatusText(st: EngineStatusInfo): { text: MessageDescriptor; action: 'start' | 'kernel' | 'install-link' | null } {
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
      return { text: msg`Da installare: serve macOS 26 o successivo`, action: 'install-link' }
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

  const status = st ? engineStatusText(st) : null
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
        </div>
        {st?.appleState === 'not-installed' && (
          <div className="border-b border-border/40 px-3 py-2.5 text-xs text-muted-foreground" data-testid="engine-install-hint">
            <p>
              {i18n._(msg`Il computer dei bot senza Docker usa Apple container: lo installa Apple col suo pacchetto firmato (chiede la password del Mac).`)}{' '}
              <a className="underline" href={APPLE_CONTAINER_RELEASES_URL} target="_blank" rel="noreferrer">
                {i18n._(msg`Le release su GitHub`)}
              </a>
            </p>
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
