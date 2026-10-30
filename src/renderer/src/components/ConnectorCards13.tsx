// Card della proposta di server MCP del registro (fase 13, punto 2) e del
// plugin di marketplace (punto 4): il bot PROPONE, l'installazione parte SOLO
// dal click dell'utente su Aggiungi/Installa — mai "sempre", mai dal modello.
// Tutto il contenuto lo ha costruito il CODICE del daemon (nome, fiducia,
// come gira, cosa serve, componenti non importate): del modello c'è solo
// `reason`. La proposta nata in un turno contaminato mostra l'avviso in cima.
import { useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api } from '../store'
import type { TranscriptEntry } from '../../../shared/types'

type McpServerMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'mcp-server' }
>
type PluginMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'plugin' }
>

/** L'avviso per le proposte nate dopo letture esterne (punto 3). */
function UntrustedBanner({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p className="mb-2 rounded-lg bg-destructive/15 px-2 py-1 text-[11px] text-destructive">
      <Trans>Proposta fatta dopo aver letto contenuti esterni: controlla che sia quello che volevi</Trans>
    </p>
  )
}

export function McpServerCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as McpServerMessage
  const [status, setStatus] = useState<'pending' | 'installing' | 'installed' | 'error'>(
    entry.meta?.status === 'installed' ? 'installed' : entry.meta?.status === 'error' ? 'error' : 'pending'
  )
  const [error, setError] = useState<string>('')
  if (message.type !== 'mcp-server') return null

  const add = async (): Promise<void> => {
    setStatus('installing')
    try {
      const r = await api.connectorsResolveMcpServer(entry.agentId, entry.id, 'add')
      if (r.ok) setStatus('installed')
      else {
        setError(r.error ?? t`errore`)
        setStatus('error')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const needs =
    message.needs.kind === 'oauth'
      ? t`accesso con il tuo account (OAuth)`
      : message.needs.kind === 'key'
        ? t`una chiave (${message.needs.header}): la inserisci tu nelle Impostazioni`
        : message.needs.vars.length
          ? t`variabili d'ambiente: ${message.needs.vars.filter((v) => v.required).map((v) => v.name).join(', ')} (le compili tu nelle Impostazioni)`
          : t`nessuna credenziale`
  const runtime =
    message.runtime.kind === 'remote'
      ? t`remoto (${message.runtime.host})`
      : t`nel box: ${message.runtime.command}`

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <UntrustedBanner show={message.untrusted === true} />
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="font-medium"><Trans>Aggiungi server MCP: {message.name}</Trans></span>
        {message.publisher && <span className="text-xs text-muted-foreground">{message.publisher}</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground"><Trans>fiducia: {message.trust} · come gira: {runtime}</Trans></p>
      {message.siteUrl && (
        <a className="mt-0.5 block truncate text-[11px] text-primary hover:underline" href={message.siteUrl} target="_blank" rel="noreferrer">{message.siteUrl}</a>
      )}
      <p className="mt-1 text-xs text-muted-foreground"><Trans>serve: {needs}</Trans></p>
      {message.thirdPartyWarning && (
        <p className="mt-1 rounded-lg bg-destructive/15 px-2 py-1 text-[11px] text-destructive">
          <Trans>Server pubblicato da terzi: può leggere e fare quello che gli permettono i suoi strumenti</Trans>
        </p>
      )}
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {message.disabledReason ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {message.disabledReason} — <button className="text-muted-foreground underline hover:text-foreground" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>No</Trans></button>
        </p>
      ) : status === 'installed' ? (
        <p className="mt-2 text-xs text-chart-2"><Trans>✓ Aggiunto — il bot ha ricevuto l'esito</Trans></p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-destructive">✕ {error} — <button className="underline" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>chiudi</Trans></button></p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            disabled={status === 'installing'}
            onClick={() => void add()}
          >
            {status === 'installing' ? <Trans>Aggiungo…</Trans> : <Trans>Aggiungi</Trans>}
          </button>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            disabled={status === 'installing'}
            onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}
          >
            <Trans>No</Trans>
          </button>
        </div>
      )}
    </div>
  )
}

export function PluginCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as PluginMessage
  const [status, setStatus] = useState<'pending' | 'installing' | 'installed' | 'error'>(
    entry.meta?.status === 'installed' ? 'installed' : entry.meta?.status === 'error' ? 'error' : 'pending'
  )
  const [error, setError] = useState<string>('')
  if (message.type !== 'plugin') return null

  const install = async (): Promise<void> => {
    setStatus('installing')
    try {
      const r = await api.pluginsResolve(entry.agentId, entry.id, 'install')
      if (r.ok) setStatus('installed')
      else {
        setError(r.error ?? t`errore`)
        setStatus('error')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <UntrustedBanner show={message.untrusted === true} />
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="font-medium"><Trans>Installa plugin: {message.name}</Trans></span>
        <span className="text-xs text-muted-foreground">{message.marketplace}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>fiducia: {message.trust} · commit {message.sha12}{message.repoUrl && <> · <a className="text-primary hover:underline" href={message.repoUrl} target="_blank" rel="noreferrer">{t`repository`}</a></>}</Trans>
      </p>
      {message.skills.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground"><Trans>skill: {message.skills.join(', ')}</Trans></p>
      )}
      {message.servers.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          <Trans>server: {message.servers.map((sv) => `${sv.name} (${sv.runtimeLabel})`).join(', ')}</Trans>
        </p>
      )}
      {message.settings.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground"><Trans>da configurare: {message.settings.map((st) => st.key).join(', ')} (Impostazioni)</Trans></p>
      )}
      {message.ignored.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground"><Trans>Non importati (non girano in Homun): {message.ignored.join(', ')}</Trans></p>
      )}
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {status === 'installed' ? (
        <p className="mt-2 text-xs text-chart-2"><Trans>✓ Installato — il bot ha ricevuto l'esito</Trans></p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-destructive">✕ {error} — <button className="underline" onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>chiudi</Trans></button></p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            disabled={status === 'installing'}
            onClick={() => void install()}
          >
            {status === 'installing' ? <Trans>Installo…</Trans> : <Trans>Installa</Trans>}
          </button>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            disabled={status === 'installing'}
            onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}
          >
            <Trans>No</Trans>
          </button>
        </div>
      )}
    </div>
  )
}
