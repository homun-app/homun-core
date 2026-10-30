// Card della proposta di server MCP del registro (fase 13, punto 2) e del
// plugin di marketplace (punto 4): il bot PROPONE, l'installazione parte SOLO
// dal click dell'utente su Aggiungi/Installa — mai "sempre", mai dal modello.
// Tutto il contenuto lo ha costruito il CODICE del daemon (nome, fiducia,
// come gira, cosa serve, componenti non importate): del modello c'è solo
// `reason`. La proposta nata in un turno contaminato mostra l'avviso in cima.
import { useState } from 'react'
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
      Proposta fatta dopo aver letto contenuti esterni: controlla che sia quello che volevi
    </p>
  )
}

export function McpServerCard({ entry }: { entry: TranscriptEntry }) {
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
        setError(r.error ?? 'errore')
        setStatus('error')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const needs =
    message.needs.kind === 'oauth'
      ? 'accesso con il tuo account (OAuth)'
      : message.needs.kind === 'key'
        ? `una chiave (${message.needs.header}): la inserisci tu nelle Impostazioni`
        : message.needs.vars.length
          ? `variabili d'ambiente: ${message.needs.vars.filter((v) => v.required).map((v) => v.name).join(', ')} (le compili tu nelle Impostazioni)`
          : 'nessuna credenziale'
  const runtime =
    message.runtime.kind === 'remote'
      ? `remoto (${message.runtime.host})`
      : `nel box: ${message.runtime.command}`

  return (
    <div className="max-w-[75%] rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 shadow-soft">
      <UntrustedBanner show={message.untrusted === true} />
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="font-medium">Aggiungi server MCP: {message.name}</span>
        {message.publisher && <span className="text-xs text-muted-foreground">{message.publisher}</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">fiducia: {message.trust} · come gira: {runtime}</p>
      {message.siteUrl && (
        <a className="mt-0.5 block truncate text-[11px] text-primary hover:underline" href={message.siteUrl} target="_blank" rel="noreferrer">{message.siteUrl}</a>
      )}
      <p className="mt-1 text-xs text-muted-foreground">serve: {needs}</p>
      {message.thirdPartyWarning && (
        <p className="mt-1 rounded-lg bg-destructive/15 px-2 py-1 text-[11px] text-destructive">
          Server pubblicato da terzi: può leggere e fare quello che gli permettono i suoi strumenti
        </p>
      )}
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {message.disabledReason ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {message.disabledReason} — <button className="text-muted-foreground underline hover:text-foreground" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}>No</button>
        </p>
      ) : status === 'installed' ? (
        <p className="mt-2 text-xs text-chart-2">✓ Aggiunto — il bot ha ricevuto l'esito</p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-destructive">✕ {error} — <button className="underline" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}>chiudi</button></p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            disabled={status === 'installing'}
            onClick={() => void add()}
          >
            {status === 'installing' ? 'Aggiungo…' : 'Aggiungi'}
          </button>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            disabled={status === 'installing'}
            onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}
          >
            No
          </button>
        </div>
      )}
    </div>
  )
}

export function PluginCard({ entry }: { entry: TranscriptEntry }) {
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
        setError(r.error ?? 'errore')
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
        <span className="font-medium">Installa plugin: {message.name}</span>
        <span className="text-xs text-muted-foreground">{message.marketplace}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        fiducia: {message.trust} · commit {message.sha12}
        {message.repoUrl && <> · <a className="text-primary hover:underline" href={message.repoUrl} target="_blank" rel="noreferrer">repository</a></>}
      </p>
      {message.skills.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">skill: {message.skills.join(', ')}</p>
      )}
      {message.servers.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          server: {message.servers.map((s) => `${s.name} (${s.runtimeLabel})`).join(', ')}
        </p>
      )}
      {message.settings.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">da configurare: {message.settings.map((s) => s.key).join(', ')} (Impostazioni)</p>
      )}
      {message.ignored.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">Non importati (non girano in Homun): {message.ignored.join(', ')}</p>
      )}
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {status === 'installed' ? (
        <p className="mt-2 text-xs text-chart-2">✓ Installato — il bot ha ricevuto l'esito</p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-destructive">✕ {error} — <button className="underline" onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}>chiudi</button></p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            disabled={status === 'installing'}
            onClick={() => void install()}
          >
            {status === 'installing' ? 'Installo…' : 'Installa'}
          </button>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            disabled={status === 'installing'}
            onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}
          >
            No
          </button>
        </div>
      )}
    </div>
  )
}
