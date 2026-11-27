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
// Fase design (DS4): le quattro card (server MCP, finestra Server MCP, plugin
// da accendere, plugin da installare) ai token di DS1 — misure di testo,
// distanze, il logo a 32 e i bottoni del sistema; la logica non cambia.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
// fase 17c (C5): fiducia, runtime e disabledReason arrivano come CODICI dal
// daemon — qui si mostrano nella lingua attiva (fallback sul campo grezzo per
// le card salvate prima della 17c)
import { X } from 'lucide-react'
import { api, useStore } from '../store'
import { stradaOfServer, stradaLabel } from '../lib/plugins-view'
import { logoUrlForName } from '../lib/app-logos'
import { AppLogo } from './ui/app-logo'
import { i18n } from '../lib/i18n'
import { erroreOfMeta } from '../lib/ui-text'
import type { McpServerSetupSpec, TranscriptEntry } from '../../../shared/types'
import { CardShell } from './DecidedRow'
import { Button } from './ui/button'
import { ServerSetupModule } from './ServerSetup'

type McpServerMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'mcp-server' }
>
type PluginMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'plugin' }
>
type McpWindowMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'mcp-window' }
>

/** V6 (fase stato-vivo): il payload della scheda offer_enable_plugin. */
type EnablePluginMessage = Extract<
  import('../../../shared/types').SendMessagePayload,
  { type: 'enable-plugin' }
>

/** Il runtime di un server del plugin dal CODICE runtimeKind (fase 17c, C5);
 *  fallback sul label salvato (card vecchie). */
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
    <p className="mb-3 rounded-control bg-destructive/15 px-3 py-2 text-small text-destructive">
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
  const [error, setError] = useState<string | null>(null)
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
  // N3 (fase mcp-egress-sicurezza): il runtime box-npm è ARGV — si mostra
  // command + args uniti, mai una stringa sola lasciata dal mittente
  const hasUrlVars = (message.setup?.urlVariables ?? []).some((v) => v.isRequired)
  const where =
    message.runtime.kind === 'remote'
      ? hasUrlVars
        ? t`Dove gira: sul server ${message.name} che indichi tu`
        : t`remoto (${message.runtime.host})`
      : t`nel box: ${[message.runtime.command, ...message.runtime.args].join(' ')}`
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
  // K2: il motivo dell'errore — quello del click, oppure quello che il daemon
  // ha salvato nell'entry (la riapertura della chat); senza, la frase di ripiego
  const motivo = error ?? erroreOfMeta(entry.meta) ?? t`Non riuscito`

  // dopo il collegamento riuscito la card si chiude in UNA riga (M4.3)
  if (status === 'installed' && connected === true) {
    return (
      <CardShell testid="mcp-server-card">
        <p className="text-body text-chart-2 wrap-anywhere" data-testid="mcp-card-connected">
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
      <div className="flex min-w-8 items-center gap-2">
        {message.logo ? (
          <img src={message.logo} alt="" className="size-8 shrink-0 rounded-control object-cover dark:bg-white" />
        ) : null}
        <span className="min-w-0 wrap-anywhere text-body font-medium text-foreground"><Trans>Aggiungi server MCP: {message.name}</Trans></span>
      </div>
      <p className="mt-2 wrap-anywhere text-small text-muted-foreground">{trust} · {where}</p>
      {access && <p className="mt-1 wrap-anywhere text-small text-muted-foreground">{access}</p>}
      {/* E4 (fase mcp-env): i metadati del pacchetto npm e la RETE che avrà:
          versione FISSATA, autore, pubblicazione, download settimanali, gli
          host dichiarati e il computer isolato */}
      {message.npmMeta && (
        <p className="mt-1 wrap-anywhere text-small text-muted-foreground" data-testid="mcp-card-npm-meta">
          {t`versione ${message.npmMeta.version} · di ${message.npmMeta.author ?? message.publisher ?? message.name}`
            + (message.npmMeta.publishedAt ? ' · ' + t`pubblicato il ${new Date(message.npmMeta.publishedAt).toLocaleDateString()}` : '')
            + ' · ' + t`download settimanali: ${message.npmMeta.weeklyDownloads.toLocaleString()}`}
        </p>
      )}
      {message.allowHosts && message.allowHosts.length > 0 && (
        <p className="mt-1 wrap-anywhere text-small text-muted-foreground" data-testid="mcp-card-allow-hosts">
          {t`Rete: solo ${message.allowHosts.join(', ')} · gira nel computer isolato`}
        </p>
      )}
      {message.siteUrl && (
        <a className="mt-1 block truncate text-small text-primary hover:underline" href={message.siteUrl} target="_blank" rel="noreferrer">{message.siteUrl}</a>
      )}
      {message.reason && <p className="mt-2 wrap-anywhere text-body text-foreground">{message.reason}</p>}
      {message.thirdPartyWarning && (
        // l'ambra è il token --waiting (contrasto ≥ 4,5:1 in chiaro e in scuro)
        <p className="mt-2 text-small text-waiting">
          <Trans>Server di terzi: può leggere e fare quello che gli permettono i suoi strumenti</Trans>
        </p>
      )}
      {/* dopo «Aggiungi» con configurazione da fare, la card DIVENTA il modulo (M4.2) */}
      {status === 'installed' && connected === false && cardSpec ? (
        <div className="mt-3 space-y-2">
          <p className="text-body font-medium"><Trans>Ultimo passo: collega {message.name}</Trans></p>
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
        <p className="mt-3 wrap-anywhere text-small text-muted-foreground">
          {message.disabledReason === 'host-mode' ? <Trans>si installa solo nel computer dei bot (modalità docker)</Trans> : message.disabledReason} — <button className="text-muted-foreground underline hover:text-foreground" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>No</Trans></button>
        </p>
      ) : status === 'installed' ? (
        <p className="mt-3 text-small text-chart-2"><Trans>✓ Aggiunto — il bot ha ricevuto l'esito</Trans></p>
      ) : status === 'error' ? (
        <p className="mt-3 wrap-anywhere text-small text-destructive">
          <X className="inline-block size-4 align-text-bottom" aria-hidden="true" /> {motivo} — <button className="underline" onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>chiudi</Trans></button>
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={status === 'installing'} onClick={() => void add()}>
            {status === 'installing' ? <Trans>Aggiungo…</Trans> : <Trans>Aggiungi</Trans>}
          </Button>
          <Button variant="ghost" disabled={status === 'installing'} onClick={() => void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined)}>
            <Trans>No</Trans>
          </Button>
        </div>
      )}
    </CardShell>
  )
}

/**
 * M3 (fase beta12-correzioni): la card «Apri Server MCP» — quando un
 * connettore non c'è da nessuna parte il bot la emette invece di dire
 * «non si può». La card NON collega niente e NON aggiunge server: un solo
 * bottone che apre la finestra «Server MCP» (M2); l'aggiunta resta un gesto
 * dell'utente, che magari il server lo usa già in Cursor o Claude.
 */
export function McpWindowCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  // PL1 (fase plugin): il bottone apre la pagina «Plugin» DIRETTAMENTE nel
  // punto dei server MCP (il form e l'import di oggi), non più la finestra
  const openPlugin = useStore((s) => s.openPlugin)
  const message = (entry.meta?.message ?? {}) as McpWindowMessage
  if (message.type !== 'mcp-window') return null
  return (
    <CardShell testid="mcp-window-card">
      <div className="flex min-w-8 items-center gap-2">
        <span className="min-w-0 wrap-anywhere text-body font-medium text-foreground">
          {message.service
            ? t`${message.service} non è tra le app del catalogo, ma si può collegare con un server MCP`
            : t`Si può collegare con un server MCP`}
        </span>
      </div>
      <p className="mt-2 text-small text-muted-foreground">
        <Trans>Se lo usi già in Cursor o Claude è lo stesso server: si aggiunge con lo stesso comando o lo stesso indirizzo.</Trans>
      </p>
      {message.reason && <p className="mt-2 wrap-anywhere text-body text-foreground">{message.reason}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button data-testid="mcp-window-card-open" onClick={() => openPlugin({ kind: 'mcp' })}>
          <Trans>Apri Server MCP</Trans>
        </Button>
      </div>
    </CardShell>
  )
}

/**
 * V6 (fase stato-vivo): la scheda per accendere un plugin PRESENTE ma SPENTO
 * (tool offer_enable_plugin) — logo, nome, la riga grigia PL1 di «I tuoi»,
 * la frase del bot (già ripulita come X2 dal loop) e i bottoni Attiva /
 * Non ora. La scheda È la richiesta: niente da approvare. «Attiva» fa
 * quello che fa l'interruttore V5 (accende, toglie il motivo, lancia il
 * test): «Attivazione…» → «Attivo · N strumenti» (e il daemon accoda il
 * turno di ripresa) oppure «Non parte · Vedi perché» (nessuna ripresa).
 */
export function EnablePluginCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as EnablePluginMessage
  const [status, setStatus] = useState<'pending' | 'activating' | 'activated' | 'failed' | 'declined'>(() => {
    const st = entry.meta?.status
    return st === 'activated' || st === 'failed' || st === 'declined' ? st : 'pending'
  })
  const [toolsCount, setToolsCount] = useState<number | null>((entry.meta?.toolsCount as number | undefined) ?? null)
  // la entry arriva AGGIORNATA dal daemon (stato e conteggio): si segue
  useEffect(() => {
    const n = (entry.meta?.toolsCount as number | undefined) ?? null
    if (n !== null) setToolsCount(n)
    const st = entry.meta?.status
    if (st === 'activated' || st === 'failed' || st === 'declined') setStatus(st)
  }, [entry.meta?.status, entry.meta?.toolsCount])
  if (message.type !== 'enable-plugin') return null
  // la riga grigia PL1: «Server MCP · <strada>» (onesto: senza fonte non si inventa)
  const openPlugin = useStore((st) => st.openPlugin)
  const lang = i18n.locale === 'en' ? ('en' as const) : ('it' as const)
  const strada = stradaOfServer({ id: message.pluginId, name: message.name })
  const gray = `Server MCP · ${stradaLabel(strada, undefined, lang)}`
  const logo = logoUrlForName(message.name)
  const decide = (decision: 'enable' | 'not-now'): void => {
    if (status !== 'pending') return
    setStatus(decision === 'enable' ? 'activating' : 'declined')
    void api.pluginsEnableCard(entry.agentId, entry.id, decision)
      .then((r) => {
        if (r.status === 'activated') {
          setStatus('activated')
          if (typeof r.toolsCount === 'number') setToolsCount(r.toolsCount)
        } else if (r.status === 'failed') {
          setStatus('failed')
        }
      })
      .catch(() => {
        // il click non è partito: la scheda torna cliccabile
        setStatus('pending')
      })
  }
  return (
    <CardShell testid="enable-plugin-card">
      <div className="flex items-center gap-3">
        {logo
          ? <img src={logo} alt="" className="size-8 shrink-0 rounded-control object-cover dark:bg-white" />
          : <AppLogo logo={null} name={message.name} className="size-8 text-reading" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-foreground">{message.name}</span>
          <span className="block truncate text-small text-muted-foreground" data-testid="enable-plugin-gray">{gray}</span>
        </span>
      </div>
      {message.reason && <p className="mt-2 wrap-anywhere text-body text-foreground">{message.reason}</p>}
      {status === 'pending' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button data-testid="enable-plugin-activate" onClick={() => decide('enable')}>
            <Trans>Attiva</Trans>
          </Button>
          <Button variant="ghost" data-testid="enable-plugin-not-now" onClick={() => decide('not-now')}>
            <Trans>Non ora</Trans>
          </Button>
        </div>
      )}
      {status === 'activating' && <p className="mt-3 text-small text-muted-foreground"><Trans>Attivazione…</Trans></p>}
      {status === 'activated' && (
        <p className="mt-3 text-small text-chart-2" data-testid="enable-plugin-active">
          <Trans>Attivo · {toolsCount ?? 0} strumenti</Trans>
        </p>
      )}
      {status === 'failed' && (
        <p className="mt-3 text-small text-destructive" data-testid="enable-plugin-failed">
          <Trans>Non parte</Trans>
          {' · '}
          <button className="underline" onClick={() => openPlugin({ kind: 'server', serverId: message.pluginId })}>
            <Trans>Vedi perché</Trans>
          </button>
        </p>
      )}
      {status === 'declined' && <p className="mt-3 text-small text-muted-foreground"><Trans>Non ora</Trans></p>}
    </CardShell>
  )
}

/**
 * C0 (fase linguaggio): era «PluginCard» — due componenti con lo stesso nome
 * (questa e la scheda della pagina Plugin) si cercano male. Il nome nuovo
 * dice cosa fa: la PROPOSTA DI INSTALLARE un plugin di marketplace che il bot
 * lascia in chat («Installa plugin: …»). La scheda della pagina resta PluginCard.
 */
export function PluginInstallProposal({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as PluginMessage
  const [status, setStatus] = useState<'pending' | 'installing' | 'installed' | 'error'>(
    entry.meta?.status === 'installed' ? 'installed' : entry.meta?.status === 'error' ? 'error' : 'pending'
  )
  const [error, setError] = useState<string | null>(null)
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

  // K2: il motivo dell'errore, come nella card del server (il click, o l'entry salvata)
  const motivo = error ?? erroreOfMeta(entry.meta) ?? t`Non riuscito`

  return (
    <CardShell>
      <UntrustedBanner show={message.untrusted === true} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 wrap-anywhere text-body font-medium text-foreground"><Trans>Installa plugin: {message.name}</Trans></span>
        <span className="text-caption text-muted-foreground">{message.marketplace}</span>
      </div>
      <p className="mt-2 wrap-anywhere text-small text-muted-foreground">
        <Trans>fiducia: {pluginTrust} · commit {message.sha12}{message.repoUrl && <> · <a className="text-primary hover:underline" href={message.repoUrl} target="_blank" rel="noreferrer">{t`repository`}</a></>}</Trans>
      </p>
      {message.skills.length > 0 && (
        <p className="mt-1 wrap-anywhere text-small text-muted-foreground"><Trans>skill: {message.skills.join(', ')}</Trans></p>
      )}
      {message.servers.length > 0 && (
        <p className="mt-1 wrap-anywhere text-small text-muted-foreground">
          <Trans>server: {serversList}</Trans>
        </p>
      )}
      {message.settings.length > 0 && (
        <p className="mt-1 wrap-anywhere text-small text-muted-foreground"><Trans>da configurare: {message.settings.map((st) => st.key).join(', ')} (Impostazioni)</Trans></p>
      )}
      {message.ignored.length > 0 && (
        <p className="mt-1 wrap-anywhere text-small text-muted-foreground"><Trans>Non importati (non girano in Homun): {message.ignored.join(', ')}</Trans></p>
      )}
      {message.reason && <p className="mt-2 wrap-anywhere text-body text-foreground">{message.reason}</p>}
      {status === 'installed' ? (
        <p className="mt-3 text-small text-chart-2"><Trans>✓ Installato — il bot ha ricevuto l'esito</Trans></p>
      ) : status === 'error' ? (
        <p className="mt-3 wrap-anywhere text-small text-destructive">
          <X className="inline-block size-4 align-text-bottom" aria-hidden="true" /> {motivo} — <button className="underline" onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}><Trans>chiudi</Trans></button>
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={status === 'installing'} onClick={() => void install()}>
            {status === 'installing' ? <Trans>Installo…</Trans> : <Trans>Installa</Trans>}
          </Button>
          <Button variant="ghost" disabled={status === 'installing'} onClick={() => void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined)}>
            <Trans>No</Trans>
          </Button>
        </div>
      )}
    </CardShell>
  )
}
