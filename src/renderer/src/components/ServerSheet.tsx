// Fase mcp-setup (M6): il foglio di un server MCP installato nella finestra
// App, rifatto nello stile delle Impostazioni — vale per TUTTI i server
// (registro, url, manuali, plugin). Testata con logo, nome umano, mezza riga
// «Server MCP · Pubblicato da …» e stato a destra; se serve, il modulo M3;
// gruppo «Bot che lo usano» con un interruttore per bot (lo stesso Toggle
// delle Impostazioni) e la voce «Tutti i bot»; «Avanzate» chiuso con
// l'indirizzo RISOLTO, il nome tecnico, la fonte e la versione; in fondo
// «Rimuovi» (rosso, con conferma). Via il pallino, il badge «REGISTRY», le
// caselle, «salva cifrato» e il paragrafo da sviluppatore: al suo posto, in
// Avanzate, una sola riga «I token stanno cifrati sul tuo Mac.»
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api, useStore } from '../store'
import type { McpServerConnectResult, McpServerSetupSpec } from '../../../shared/types'
import { fillTemplate } from '../../../shared/registry-vars'
import { serverRowStatus, type InstalledServerLike } from '../lib/apps-view'
import { SettingsAdvanced } from './settings/SettingsAdvanced'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'
import { Toggle } from './Settings'
import { ServerSetupModule } from './ServerSetup'

/** Il server come arriva dal foglio (McpServerInfo + i campi del template). */
export type ServerSheetInfo = InstalledServerLike & {
  transport?: string
  url?: string
  urlTemplate?: string
  vars?: Record<string, string>
  box?: { command?: string; args?: string[] } | null
  command?: string
  args?: string[]
  source?: { kind?: string; name?: string; version?: string } | null
}

/** La mezza riga della testata: «Server MCP · Pubblicato da mattermost». */
function publisherLine(sv: ServerSheetInfo): string | null {
  if (sv.source?.kind === 'registry' && sv.source.name) {
    // dal namespace del nome tecnico: io.github.mattermost/… → mattermost
    const ns = sv.source.name.includes('/') ? sv.source.name.slice(0, sv.source.name.indexOf('/')) : ''
    const user = ns.startsWith('io.github.') ? ns.slice('io.github.'.length) : ns.split('.').filter(Boolean).pop() ?? ''
    return user || null
  }
  return null
}

/** Il logo del foglio: l'iniziale del nome umano su fondo tenue. */
function ServerLogo({ name }: { name: string }): React.ReactNode {
  return (
    <span className="grid size-12 shrink-0 place-items-center rounded-[12px] bg-muted text-lg font-bold text-foreground/70">
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/**
 * Il foglio del server: stato, modulo, bot, Avanzate, Rimuovi. `onChanged` si
 * chiama dopo ogni modifica (la finestra App rilegge l'elenco).
 */
export function ServerSheet({ sv, onDone }: { sv: ServerSheetInfo; onDone(): void }): React.ReactNode {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [setup, setSetup] = useState<McpServerSetupSpec | null>(null)
  const [setupLoaded, setSetupLoaded] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [note, setNote] = useState('')

  // lo spec del modulo (M3): variabili e accesso; null = niente da chiedere
  useEffect(() => {
    let alive = true
    setSetupLoaded(false)
    void api.connectorsServerSetup(sv.id)
      .then((spec) => { if (alive) { setSetup(spec); setSetupLoaded(true) } })
      .catch(() => { if (alive) { setSetup(null); setSetupLoaded(true) } })
    return () => { alive = false }
  }, [sv.id])

  const needsReauth = Boolean(sv.needsReauth)
  const needsAuth = Boolean(sv.needsAuth)
  const status = serverRowStatus(sv as InstalledServerLike)

  const enabledFor = sv.enabledFor ?? []
  const allBots = enabledFor.includes('*')
  const setEnabledFor = async (ids: string[]): Promise<void> => {
    await api.connectorsSetEnabledFor('server', sv.id, ids)
    onDone()
  }
  const toggleBot = (agentId: string, on: boolean): void => {
    const others = agents.map((a) => a.id).filter((id) => id !== agentId)
    if (allBots) {
      // «tutti» + un bot spento = tutti GLI ALTRI (non solo quello cliccato)
      void setEnabledFor(on ? ['*'] : others)
      return
    }
    const next = on ? [...new Set([...enabledFor, agentId])] : enabledFor.filter((id) => id !== agentId)
    // riaccesi tutti a mano = tutti
    void setEnabledFor(next.length === agents.length ? ['*'] : next)
  }

  // l'indirizzo RISOLTO (non il template): i valori che ci sono, le graffe
  // restano SOLO quando mancano ancora
  const resolvedAddress = sv.transport === 'http'
    ? (sv.urlTemplate ? fillTemplate(sv.urlTemplate, sv.vars ?? {}) : (sv.url ?? ''))
    : [sv.box?.command ?? sv.command ?? '', ...(sv.box?.args ?? sv.args ?? [])].join(' ')

  return (
    <div className="space-y-4" data-testid="server-sheet">
      {/* la testata: logo, nome umano, mezza riga, stato */}
      <div className="flex items-center gap-3">
        <ServerLogo name={sv.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg font-medium">{sv.name}</span>
          <span className="block truncate text-[13px] text-muted-foreground">
            {publisherLine(sv)
              ? t`Server MCP · Pubblicato da ${publisherLine(sv)!}`
              : t`Server MCP`}
          </span>
        </span>
        {status === 'connected' && (
          <span className="shrink-0 rounded-full bg-chart-2/15 px-2.5 py-1 text-[12px] text-chart-2" data-testid="server-sheet-connected"><Trans>Connessa</Trans></span>
        )}
        {status === 'setup' && (
          <span className="shrink-0 rounded-full bg-amber-500/15 px-2.5 py-1 text-[12px] text-amber-600 dark:text-amber-400" data-testid="server-sheet-setup"><Trans>Da completare</Trans></span>
        )}
        {status === 'reconnect' && (
          <button
            className="shrink-0 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
            data-testid="server-sheet-reconnect"
            onClick={async () => {
              const r = await api.connectorsReconnectServer(sv.id).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
              setNote(r.ok ? (r.message ?? t`riconnesso`) : t`riconnessione non riuscita`)
              onDone()
            }}
          >
            <Trans>Ricollega</Trans>
          </button>
        )}
      </div>

      {/* il modulo M3, quando serve; collegato e senza coda: niente (R5 —
          lo stato in alto dice già «Connessa») */}
      {setupLoaded && setup && setup.needsSetup && (
        <ServerSetupModule
          spec={setup}
          onConnected={(_r: McpServerConnectResult) => onDone()}
          testid="server-sheet-setup"
        />
      )}
      {note && <p className="text-[12px] text-muted-foreground">{note}</p>}

      {/* Bot che lo usano: un interruttore per bot + «Tutti i bot» */}
      <SettingsGroup label={<Trans>Bot che lo usano</Trans>}>
        <SettingsRow
          title={<Trans>Tutti i bot</Trans>}
          control={
            <Toggle
              label={t`Tutti i bot`}
              checked={allBots}
              onChange={(v) => void setEnabledFor(v ? ['*'] : [])}
            />
          }
        />
        {agents.map((a) => {
          const on = allBots || enabledFor.includes(a.id)
          return (
            <SettingsRow
              key={a.id}
              title={a.name}
              control={<Toggle label={a.name} checked={on} onChange={(v) => toggleBot(a.id, v)} />}
            />
          )
        })}
      </SettingsGroup>

      {/* Avanzate: l'indirizzo RISOLTO, il nome tecnico, la fonte, la versione */}
      <SettingsAdvanced>
        <SettingsGroup>
          {sv.transport === 'http' && (
            <SettingsRow title={<Trans>Indirizzo</Trans>} control={<code className="max-w-[55%] truncate rounded bg-card px-2 py-1 text-[12px]">{resolvedAddress}</code>} />
          )}
          {sv.transport !== 'http' && (
            <SettingsRow title={<Trans>Comando</Trans>} control={<code className="max-w-[55%] truncate rounded bg-card px-2 py-1 text-[12px]">{resolvedAddress}</code>} />
          )}
          {sv.source?.name && sv.source.name !== sv.name && (
            <SettingsRow title={<Trans>Nome tecnico</Trans>} control={<code className="max-w-[55%] truncate rounded bg-card px-2 py-1 text-[11px] text-muted-foreground">{sv.source.name}</code>} />
          )}
          <SettingsRow
            title={<Trans>Fonte</Trans>}
            control={
              <span className="text-[13px] text-muted-foreground">
                {sv.source?.kind === 'registry' ? <Trans>registro MCP</Trans>
                  : sv.source?.kind === 'plugin' ? <Trans>plugin</Trans>
                  : sv.source?.kind === 'gateway' ? <Trans>gateway</Trans>
                  : <Trans>aggiunto da te</Trans>}
                {sv.source?.version ? ` · ${sv.source.version}` : ''}
              </span>
            }
          />
        </SettingsGroup>
        <p className="text-[13px] text-muted-foreground"><Trans>I token stanno cifrati sul tuo Mac.</Trans></p>
      </SettingsAdvanced>

      {/* Rimuovi (rosso, con conferma) — al posto di «Disinstalla» */}
      <div className="flex items-center justify-end gap-2 pt-1">
        {confirmRemove ? (
          <button
            className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
            onClick={async () => { await api.connectorsUninstallServer(sv.id); onDone() }}
          >
            <Trans>Rimuovi davvero</Trans>
          </button>
        ) : (
          <button
            className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
            onClick={() => setConfirmRemove(true)}
          >
            <Trans>Rimuovi</Trans>
          </button>
        )}
      </div>
    </div>
  )
}
