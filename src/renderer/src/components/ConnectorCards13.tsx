// Card della proposta di server MCP del registro (fase 13, punto 2) e del
// plugin di marketplace (punto 4): il bot PROPONE, l'installazione parte SOLO
// dal click dell'utente su Aggiungi/Installa — mai "sempre", mai dal modello.
// Tutto il contenuto lo ha costruito il CODICE del daemon (nome, fiducia,
// come gira, cosa serve, componenti non importate): del modello c'è solo
// `reason`. La proposta nata in un turno contaminato mostra l'avviso in cima.
//
// Fase mcp-setup (M4): dopo «Aggiungi» la card stessa diventa il MODULO di
// configurazione (M3) quando manca qualcosa — il bot non manda l'utente nelle
// Impostazioni. Lo stato si legge dal SERVER (non dalla card): alla riapertura
// la card torna modulo finché il collegamento non riesce, poi si chiude in
// «✓ <Nome> collegato · N strumenti».
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
// fase 17c (C5): fiducia, runtime e disabledReason arrivano come CODICI dal
// daemon — qui si mostrano nella lingua attiva (fallback sul campo grezzo per
// le card salvate prima della 17c)
import { api } from '../store'
import type { McpServerSetupSpec, TranscriptEntry } from '../../../shared/types'
import { CardShell } from './DecidedRow'
import { ServerSetupModule } from './ServerSetup'

type McpServerMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'mcp-server' }
>
type PluginMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'plugin' }
>

/** Il runtime di un server del plugin dal CODICE runtimeKind (fase 17c, C5); fallback sul label salvato (card vecchie). */
function RuntimeOf({ sv }: { sv: { name: string; runtimeKind?: string; runtimeDetail?: string; runtimeLabel?: string } }) {
  const { t } = useLingui()
  if (sv.runtimeKind === 'unsupported') return <>{t`non supportato: valore in argv (${sv.runtimeDetail ?? ''})`}</>
  if (sv.runtimeKind === 'remote') return <>{t`remoto (${sv.runtimeDetail ?? ''})`}</>
  if (sv.runtimeKind === 'box') return <>{t`nel box: ${sv.runtimeDetail ?? ''}`}</>
  return <>{sv.runtimeLabel ?? ''}</>
}

/** L'avviso per le proposte nate dopo letture esterne (punto 3). */
function UntrustedBanner({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p className="mb-2 rounded-lg bg-destructive/15 px-2 py-1 text-[11px] text-destructive">
      <Trans>Proposta fatta dopo aver letto contenuti esterni: controlla che sia quello che volevi</Trans>
    </p>
  )
}

/** Lo spec del modulo della card, dal payload `setup` costruito in codice (M1/M3). */
function specOfCard(message: McpServerMessage): McpServerSetupSpec | null {
  if (!message.setup || !message.serverId) return null
  const s = message.setup
  return {
    serverId: message.serverId,
    name: message.name,
    transport: 'http',
    variables: s.urlVariables.map((v) => ({
      name: v.name,
      ...(v.description ? { description: v.description } : {}),
      ...(v.placeholder ? { placeholder: v.placeholder } : {}),
      isRequired: v.isRequired,
      isSecret: v.isSecret,
      ...(v.default !== undefined ? { value: v.default } : {})
    })),
    auth: s.auth,
    ...(s.tokenHeader
      ? {
          tokenHeader: {
            name: s.tokenHeader.name,
            valueTemplate: s.tokenHeader.valueTemplate,
            ...(s.tokenHeader.description ? { description: s.tokenHeader.description } : {}),
            variable: s.tokenHeader.variable,
            ...(s.tokenHeader.variableDescription ? { variableDescription: s.tokenHeader.variableDescription } : {}),
            saved: false
          }
        }
      : {}),
    needsSetup: true
  }
}

export function McpServerCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as McpServerMessage
  const [status, setStatus] = useState<'pending' | 'installing' | 'installed' | 'error'>(
    entry.meta?.status === 'installed' ? 'installed' : entry.meta?.status === 'error' ? 'error' : 'pending'
  )
  const [error, setError] = useState<string>('')
  // fase mcp-setup (M4): lo spec VERO del modulo (dal server) dopo «Aggiungi»
  const [spec, setSpec] = useState<McpServerSetupSpec | null>(null)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [toolsCount, setToolsCount] = useState<number | null>(null)
  if (message.type !== 'mcp-server') return null

  // lo stato si legge dal SERVER, non dalla card (M4.4): una card già
  // «installata» torna modulo finché il collegamento non riesce
  useEffect(() => {
    if (status !== 'installed' || !message.serverId) return
    let alive = true
    void api.connectorsServerSetup(message.serverId)
      .then((s) => {
        if (!alive) return
        setSpec(s)
        setConnected(s ? !s.needsSetup && s.stateStatus !== 'needs_auth' && s.stateStatus !== 'error' : true)
      })
      .catch(() => { if (alive) setConnected(true) })
    return () => { alive = false }
  }, [status, message.serverId])

  const add = async (): Promise<void> => {
    setStatus('installing')
    try {
      const r = await api.connectorsResolveMcpServer(entry.agentId, entry.id, 'add')
      if (r.ok) {
        setStatus('installed')
        // il modulo vero dal server (M4.2), se c'è qualcosa da completare
        if (message.serverId) {
          try {
            const s = await api.connectorsServerSetup(message.serverId)
            setSpec(s)
            setConnected(s ? !s.needsSetup && s.stateStatus !== 'needs_auth' && s.stateStatus !== 'error' : true)
          } catch { setConnected(true) }
        } else {
          setConnected(true)
        }
      } else {
        setError(r.error ?? t`errore`)
        setStatus('error')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const trust =
    message.trustKind === 'verified-domain'
      ? t`Pubblicato da ${message.trustDetail ?? ''} (dominio verificato)`
      : message.trustKind === 'github-account'
        ? t`Pubblicato da ${message.trustDetail ?? ''} su GitHub`
        : message.trustKind === 'unverified'
          ? t`non verificato`
          : message.trust
  // M4.1: dove gira e accesso, senza segnaposto e senza «serve: una chiave»
  const hasUrlVars = (message.setup?.urlVariables ?? []).some((v) => v.isRequired)
  const where =
    message.runtime.kind === 'remote'
      ? hasUrlVars
        ? t`Dove gira: sul server ${message.name} che indichi tu`
        : t`remoto (${message.runtime.host})`
      : t`nel box: ${message.runtime.command}`
  const access =
    message.setup
      ? message.setup.auth === 'oauth'
        ? t`Accesso: con il tuo account (si apre il browser)`
        : t`Accesso: con un token`
      : message.needs.kind === 'oauth'
        ? t`Accesso: con il tuo account (si apre il browser)`
        : message.needs.kind === 'key'
          ? t`Accesso: con un token`
          : null

  const cardSpec = spec ?? specOfCard(message)

  // dopo il collegamento riuscito la card si chiude in UNA riga (M4.3)
  if (status === 'installed' && connected === true) {
    return (
      <CardShell testid="mcp-server-card">
        <p className="text-sm text-chart-2" data-testid="mcp-card-connected">
          {toolsCount !== null
            ? t`✓ ${message.name} collegato · ${toolsCount} strumenti`
            : t`✓ ${message.name} collegato`}
        </p>
      </CardShell>
    )
  }

  return (
    <CardShell>
      <UntrustedBanner show={message.untrusted === true} />
      <div className="flex items-center gap-2 text-sm text-foreground">
        {message.logo ? (
          <img src={message.logo} alt="" className="size-5 shrink-0 rounded-[6px] object-cover dark:bg-white" />
        ) : null}
        <span className="font-medium"><Trans>Aggiungi server MCP: {message.name}</Trans></span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{trust} · {where}</p>
      {access && <p className="mt-0.5 text-xs text-muted-foreground">{access}</p>}
      {message.siteUrl && (
        <a className="mt-0.5 block truncate text-[11px] text-primary hover:underline" href={message.siteUrl} target="_blank" rel="noreferrer">{message.siteUrl}</a>
      )}
      {message.reason && <p className="mt-1 text-sm text-foreground">{message.reason}</p>}
      {message.thirdPartyWarning && (
        <p className="mt-1 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          <Trans>Server di terzi: può leggere e fare quello che gli permettono i suoi strumenti</Trans>
        </p>
      )}
      {/* dopo «Aggiungi» con configurazione da fare, la card DIVENTA il modulo (M4.2) */}
      {status === 'installed' && connected === false && cardSpec ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium"><Trans>Ultimo passo: collega {message.name}</Trans></p>
          <ServerSetupModule
            spec={cardSpec}
            testid="mcp-card-setup"
            onConnected={(r) => {
              setConnected(true)
              setToolsCount((r.tools ?? []).length)
            }}
          />
        </div>
      ) : message.disabledReason ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {message.disabledReason === 'host-mode' ? <Trans>si installa solo nel computer dei bot (modalità docker)</Trans> : message.disabledReason} — <button className="text-muted-foreground underline hover:text-foreground" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>No</Trans></button>
        </p>
      ) : status === 'installed' ? (
        <p className="mt-2 text-xs text-chart-2"><Trans>✓ Aggiunto — il bot ha ricevuto l'esito</Trans></p>
      ) : status === 'error' ? (
        <p className="mt-2 text-xs text-destructive">✕ {error} — <button className="underline" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>chiudi</Trans></button></p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
            disabled={status === 'installing'}
            onClick={() => void add()}
          >
            {status === 'installing' ? <Trans>Aggiungo…</Trans> : <Trans>Aggiungi</Trans>}
          </button>
          <button
            className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            disabled={status === 'installing'}
            onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}
          >
            <Trans>No</Trans>
          </button>
        </div>
      )}
    </CardShell>
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

  // fase 17c (C5): fiducia dal codice official, fallback sul campo grezzo
  const pluginTrust = message.official === true ? t`marketplace ufficiale` : message.official === false ? t`marketplace aggiunto da te` : message.trust
  // fase 17c (C5): il runtime di ogni server dal codice runtimeKind
  const serversList = message.servers.map((sv, i) => (
    <span key={sv.name}>
      {i > 0 ? ', ' : ''}{sv.name} (<RuntimeOf sv={sv} />)
    </span>
  ))

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
    <CardShell>
      <UntrustedBanner show={message.untrusted === true} />
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className="font-medium"><Trans>Installa plugin: {message.name}</Trans></span>
        <span className="text-xs text-muted-foreground">{message.marketplace}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>fiducia: {pluginTrust} · commit {message.sha12}{message.repoUrl && <> · <a className="text-primary hover:underline" href={message.repoUrl} target="_blank" rel="noreferrer">{t`repository`}</a></>}</Trans>
      </p>
      {message.skills.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground"><Trans>skill: {message.skills.join(', ')}</Trans></p>
      )}
      {message.servers.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          <Trans>server: {serversList}</Trans>
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
            className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
            disabled={status === 'installing'}
            onClick={() => void install()}
          >
            {status === 'installing' ? <Trans>Installo…</Trans> : <Trans>Installa</Trans>}
          </button>
          <button
            className="rounded-[10px] px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            disabled={status === 'installing'}
            onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}
          >
            <Trans>No</Trans>
          </button>
        </div>
      )}
    </CardShell>
  )
}
