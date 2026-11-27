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
//
// K2 (fase conversione-chat): le quattro card (server MCP, finestra Server
// MCP, plugin da accendere, plugin da installare) sono LOGICA — i dati e i
// clic — sopra ProposalCard, l'oggetto del catalogo (a sua volta sopra
// ChatCard, il guscio): testata, righe, perché, stato e azioni sono suoi
// slot; il testo è Text, le azioni dentro una frase sono il bottone link.
// Qui non si disegna più niente: stessi testi, azioni e testid di prima.
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
// fase 17c (C5): fiducia, runtime e disabledReason arrivano come CODICI dal
// daemon — qui si mostrano nella lingua attiva (fallback sul campo grezzo per
// le card salvate prima della 17c)
import { X } from 'lucide-react'
import { api, useStore } from '../store'
import { stradaOfServer, stradaLabel } from '../lib/plugins-view'
import { logoUrlForName } from '../lib/app-logos'
import { Icon } from './ui/icon'
import { Notice } from './ui/notice'
import { ChatCard } from './ui/chat-card'
import { ProposalCard } from './ui/proposal-card'
import { Text } from './ui/text'
import { i18n } from '../lib/i18n'
import { erroreDiPropostaMeta, errorePropostaDi } from '../lib/ui-text'
import { TechDetails } from './ui/tech-details'
import type { McpServerSetupSpec, TranscriptEntry } from '../../../shared/types'
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

/** V6: lo stato salvato dall'ultima decisione (la entry aggiornata lo riporta alla riapertura). */
type StatoPlugin = 'pending' | 'activating' | 'activated' | 'failed' | 'declined'

/** Il runtime di un server del plugin dal CODICE runtimeKind (fase 17c, C5);
 *  fallback sul label salvato (card vecchie). */
function RuntimeOf({ sv }: { sv: { name: string; runtimeKind?: string; runtimeDetail?: string; runtimeLabel?: string } }) {
  const { t } = useLingui()
  if (sv.runtimeKind === 'unsupported') return <>{t`non supportato: valore in argv (${sv.runtimeDetail ?? ''})`}</>
  if (sv.runtimeKind === 'remote') return <>{t`remoto (${sv.runtimeDetail ?? ''})`}</>
  if (sv.runtimeKind === 'box') return <>{t`nel box: ${sv.runtimeDetail ?? ''}`}</>
  return <>{sv.runtimeLabel ?? ''}</>
}

/** L'avviso in cima per le proposte nate dopo letture esterne (punto 3): la fascia rossa di Notice. */
function UntrustedBanner(): ReactNode {
  return (
    <Notice tone="destructive" fill>
      <Trans>Proposta fatta dopo aver letto contenuti esterni: controlla che sia quello che volevi</Trans>
    </Notice>
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

/**
 * La riga dell'errore nelle card di proposta: il segno, la FRASE in italiano,
 * e «chiudi» (il bottone di parole). K3 (fase conversione-chat): il testo
 * tecnico del daemon (inglese) sta chiuso nei «Dettagli tecnici» sotto.
 */
function RigaErrore({ errore, onChiudi }: { errore: { frase: string; tecnico: string | null }; onChiudi: () => void }): ReactNode {
  return (
    <>
      <Text size="small" tone="destructive">
        <Icon icon={X} className="inline-block align-text-bottom" /> {errore.frase} — <Button variant="link" onClick={onChiudi}><Trans>chiudi</Trans></Button>
      </Text>
      {errore.tecnico !== null && <TechDetails testo={errore.tecnico} />}
    </>
  )
}

export function McpServerCard({ entry }: { entry: TranscriptEntry }) {
  const { t } = useLingui()
  const message = (entry.meta?.message ?? {}) as McpServerMessage
  const [status, setStatus] = useState<'pending' | 'installing' | 'installed' | 'error'>(
    entry.meta?.status === 'installed' ? 'installed' : entry.meta?.status === 'error' ? 'error' : 'pending'
  )
  // K3: l'errore del click, diviso in frase da mostrare e testo tecnico (ui-text: errorePropostaDi)
  const [error, setError] = useState<{ frase: string; tecnico: string | null } | null>(null)
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

  const rifiuta = (): void => { void api.connectorsResolveMcpServer(entry.agentId, entry.id, 'no').catch(() => undefined) }

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
        setError(errorePropostaDi(r.error ?? t`errore`, r.code))
        setStatus('error')
      }
    } catch (e) {
      setError(errorePropostaDi(e instanceof Error ? e.message : String(e), undefined))
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
  // ha salvato nell'entry (la riapertura della chat). K3: all'utente la FRASE
  // del catalogo (dal codice, o «Non riuscito»), il testo tecnico nei dettagli
  const errore = error ?? erroreDiPropostaMeta(entry.meta)

  // dopo il collegamento riuscito la card si chiude in UNA riga (M4.3)
  if (status === 'installed' && connected === true) {
    return (
      // il guscio da solo: la card chiusa non è più una proposta, è una riga d'esito
      <ChatCard testId="mcp-server-card">
        <Text tone="ok">
          {toolsCount !== null
            ? t`✓ ${message.name} collegato · ${toolsCount} strumenti`
            : t`✓ ${message.name} collegato`}
        </Text>
      </ChatCard>
    )
  }

  // la coda della card — una sola alla volta, in quest'ordine (M4.2): il
  // modulo da completare · il motivo per cui qui non si installa · l'esito ·
  // l'errore · le azioni
  const modulo = status === 'installed' && connected === false && cardSpec ? cardSpec : null
  let coda: { slot: 'configurazione' | 'stato' | 'azioni'; nodo: ReactNode }
  if (modulo) {
    coda = { slot: 'configurazione', nodo: (
      <>
        <Text weight="medium"><Trans>Ultimo passo: collega {message.name}</Trans></Text>
        <ServerSetupModule
          spec={modulo}
          testid="mcp-card-setup"
          onConnected={(r) => {
            setConnected(true)
            setToolsCount((r.tools ?? []).length)
          }}
        />
      </>
    ) }
  } else if (message.disabledReason) {
    coda = { slot: 'stato', nodo: (
      <Text size="small" tone="muted">
        {message.disabledReason === 'host-mode' ? <Trans>si installa solo nel computer dei bot (modalità docker)</Trans> : message.disabledReason} — <Button variant="link" onClick={rifiuta}><Trans>No</Trans></Button>
      </Text>
    ) }
  } else if (status === 'installed') {
    coda = { slot: 'stato', nodo: <Text size="small" tone="ok"><Trans>✓ Aggiunto — il bot ha ricevuto l'esito</Trans></Text> }
  } else if (status === 'error') {
    coda = { slot: 'stato', nodo: <RigaErrore errore={errore} onChiudi={rifiuta} /> }
  } else {
    coda = { slot: 'azioni', nodo: (
      <>
        <Button disabled={status === 'installing'} onClick={() => void add()}>
          {status === 'installing' ? <Trans>Aggiungo…</Trans> : <Trans>Aggiungi</Trans>}
        </Button>
        <Button variant="ghost" disabled={status === 'installing'} onClick={rifiuta}>
          <Trans>No</Trans>
        </Button>
      </>
    ) }
  }

  return (
    <ProposalCard
      avviso={message.untrusted === true ? <UntrustedBanner /> : undefined}
      logo={message.logo || undefined}
      titolo={<Trans>Aggiungi server MCP: {message.name}</Trans>}
      righe={<>
        <Text size="small" tone="muted">{trust} · {where}</Text>
        {access && <Text size="small" tone="muted">{access}</Text>}
        {/* E4 (fase mcp-env): i metadati del pacchetto npm e la RETE che avrà:
            versione FISSATA, autore, pubblicazione, download settimanali, gli
            host dichiarati e il computer isolato */}
        {message.npmMeta && (
          <Text size="small" tone="muted" testId="mcp-card-npm-meta">
            {t`versione ${message.npmMeta.version} · di ${message.npmMeta.author ?? message.publisher ?? message.name}`
              + (message.npmMeta.publishedAt ? ' · ' + t`pubblicato il ${new Date(message.npmMeta.publishedAt).toLocaleDateString()}` : '')
              + ' · ' + t`download settimanali: ${message.npmMeta.weeklyDownloads.toLocaleString()}`}
          </Text>
        )}
        {message.allowHosts && message.allowHosts.length > 0 && (
          <Text size="small" tone="muted" testId="mcp-card-allow-hosts">
            {t`Rete: solo ${message.allowHosts.join(', ')} · gira nel computer isolato`}
          </Text>
        )}
        {message.siteUrl && (
          <Text size="small" tone="muted" truncate>
            <Button variant="link" asChild>
              <a href={message.siteUrl} target="_blank" rel="noreferrer">{message.siteUrl}</a>
            </Button>
          </Text>
        )}
      </>}
      perché={<>
        {message.reason && <Text>{message.reason}</Text>}
        {message.thirdPartyWarning && (
          // l'ambra è il token --waiting (contrasto ≥ 4,5:1 in chiaro e in scuro)
          <Text size="small" tone="waiting">
            <Trans>Server di terzi: può leggere e fare quello che gli permettono i suoi strumenti</Trans>
          </Text>
        )}
      </>}
      configurazione={coda.slot === 'configurazione' ? coda.nodo : undefined}
      stato={coda.slot === 'stato' ? coda.nodo : undefined}
      azioni={coda.slot === 'azioni' ? coda.nodo : undefined}
    />
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
    <ProposalCard
      testId="mcp-window-card"
      titolo={message.service
        ? t`${message.service} non è tra le app del catalogo, ma si può collegare con un server MCP`
        : t`Si può collegare con un server MCP`}
      righe={<Text size="small" tone="muted"><Trans>Se lo usi già in Cursor o Claude è lo stesso server: si aggiunge con lo stesso comando o lo stesso indirizzo.</Trans></Text>}
      perché={message.reason ? <Text>{message.reason}</Text> : undefined}
      azioni={<Button data-testid="mcp-window-card-open" onClick={() => openPlugin({ kind: 'mcp' })}><Trans>Apri Server MCP</Trans></Button>}
    />
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
  const [status, setStatus] = useState<StatoPlugin>(() => {
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
    <ProposalCard
      testId="enable-plugin-card"
      logo={logo}
      nome={message.name}
      titolo={message.name}
      sottotitolo={<span data-testid="enable-plugin-gray">{gray}</span>}
      perché={message.reason ? <Text>{message.reason}</Text> : undefined}
      stato={status === 'activating' ? <Text size="small" tone="muted"><Trans>Attivazione…</Trans></Text>
        : status === 'activated' ? (
          <Text size="small" tone="ok" testId="enable-plugin-active">
            <Trans>Attivo · {toolsCount ?? 0} strumenti</Trans>
          </Text>
        )
        : status === 'failed' ? (
          <Text size="small" tone="destructive" testId="enable-plugin-failed">
            <Trans>Non parte</Trans>
            {' · '}
            <Button variant="link" onClick={() => openPlugin({ kind: 'server', serverId: message.pluginId })}>
              <Trans>Vedi perché</Trans>
            </Button>
          </Text>
        )
        : status === 'declined' ? <Text size="small" tone="muted"><Trans>Non ora</Trans></Text>
        : undefined}
      azioni={status === 'pending' ? (
        <>
          <Button data-testid="enable-plugin-activate" onClick={() => decide('enable')}>
            <Trans>Attiva</Trans>
          </Button>
          <Button variant="ghost" data-testid="enable-plugin-not-now" onClick={() => decide('not-now')}>
            <Trans>Non ora</Trans>
          </Button>
        </>
      ) : undefined}
    />
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
  // K3: come la card del server — la frase da mostrare e il testo tecnico
  const [error, setError] = useState<{ frase: string; tecnico: string | null } | null>(null)
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
        setError(errorePropostaDi(r.error ?? t`errore`, r.code))
        setStatus('error')
      }
    } catch (e) {
      setError(errorePropostaDi(e instanceof Error ? e.message : String(e), undefined))
      setStatus('error')
    }
  }
  const rifiuta = (): void => { void api.pluginsResolve(entry.agentId, entry.id, 'no').catch(() => undefined) }

  // K2: il motivo dell'errore, come nella card del server (il click, o l'entry salvata); K3: la frase del catalogo, il testo nei dettagli
  const errore = error ?? erroreDiPropostaMeta(entry.meta)

  return (
    <ProposalCard
      avviso={message.untrusted === true ? <UntrustedBanner /> : undefined}
      titolo={<Trans>Installa plugin: {message.name}</Trans>}
      nota={<Text size="caption" tone="muted">{message.marketplace}</Text>}
      righe={<>
        <Text size="small" tone="muted">
          <Trans>fiducia: {pluginTrust} · commit {message.sha12}{message.repoUrl && <> · <Button variant="link" asChild><a href={message.repoUrl} target="_blank" rel="noreferrer">{t`repository`}</a></Button></>}</Trans>
        </Text>
        {message.skills.length > 0 && (
          <Text size="small" tone="muted"><Trans>skill: {message.skills.join(', ')}</Trans></Text>
        )}
        {message.servers.length > 0 && (
          <Text size="small" tone="muted">
            <Trans>server: {serversList}</Trans>
          </Text>
        )}
        {message.settings.length > 0 && (
          <Text size="small" tone="muted"><Trans>da configurare: {message.settings.map((st) => st.key).join(', ')} (Impostazioni)</Trans></Text>
        )}
        {message.ignored.length > 0 && (
          <Text size="small" tone="muted"><Trans>Non importati (non girano in Homun): {message.ignored.join(', ')}</Trans></Text>
        )}
      </>}
      perché={message.reason ? <Text>{message.reason}</Text> : undefined}
      stato={status === 'installed' ? (
        <Text size="small" tone="ok"><Trans>✓ Installato — il bot ha ricevuto l'esito</Trans></Text>
      ) : status === 'error' ? (
        <RigaErrore errore={errore} onChiudi={rifiuta} />
      ) : undefined}
      azioni={status !== 'installed' && status !== 'error' ? (
        <>
          <Button disabled={status === 'installing'} onClick={() => void install()}>
            {status === 'installing' ? <Trans>Installo…</Trans> : <Trans>Installa</Trans>}
          </Button>
          <Button variant="ghost" disabled={status === 'installing'} onClick={rifiuta}>
            <Trans>No</Trans>
          </Button>
        </>
      ) : undefined}
    />
  )
}
