// PL2 (fase plugin): la scheda di un plugin (tavola 9) — clic su una riga di
// «I tuoi» e si apre LA scheda: Panoramica · Autorizzazioni · Account e bot
// (per le skill: Panoramica e Bot, nell'editor già riusato dalla pagina).
// I selettori delle Autorizzazioni scrivono le regole per strumento che
// ESISTONO GIÀ (permissions: always_allow / needs_approval / blocked,
// shared/permissions-tools) — nessun modello nuovo — e gli strumenti
// dell'insieme fisso (invii, pagamenti) mostrano il lucchetto e non offrono
// «Consenti sempre». MAI dati inventati: un campo che non c'è non si mostra.
import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Lock, ChevronLeft, MoreHorizontal } from 'lucide-react'
import { api, useStore, type PluginCardTab } from '../store'
import { i18n } from '../lib/i18n'
import type { McpServerInfo, PermissionsConfig, ConnectorInfo } from '../../../shared/types'
import type { CatalogRowView } from '../lib/apps-view'
import { stateLabelOf, stradaOfServer, stradaLabel, pluginStateOfServer, cardGrayLineOf } from '../lib/plugins-view'
import { classifyPluginTool, type FixedAskKind, type ToolGroup } from '../../../shared/tool-classify'
import { toolRuleOf, withToolRule } from '../../../shared/permissions-tools'
import { serverCommandLine } from '../lib/mcp-row'
// il prefisso STABILE degli strumenti (mcp__<toolSlug>__…): lo stesso punto
// che legge il sistema (modulo puro di main/mcp)
import { toolSlugOf } from '../../../main/mcp/slug'
// A4 (fase approvazioni-chiare): il nome e la descrizione senza il prefisso
// interno [MCP:<nome>] (mcpToolPresentation, la funzione unica della UI)
import { mcpToolPresentation } from '../../../shared/tool-names'
import { logoUrlForName } from '../lib/app-logos'
// PP1 (fase plugin-pulita): l'invaso unico — «Rimuovi» e le autorizzazioni lunghe si raggiungono scorrendo
import { PluginShell } from './plugin/PluginShell'
// PP2 (fase plugin-pulita): il segreto si cambia dove vive il server — le righe «Account» e «variabili segrete»
import { ServerAccountRow } from './plugin/ServerSecretRows'
import { SECRET_EDIT_INITIAL, secretEditReducer, type SecretEditState, type ServerSecretNames } from '../lib/plugin-secret'
import { Toggle } from './Settings'
import { AppLogo, GatewayAccountsSection } from './AppsWindow'
// PP4 (fase plugin-pulita): la scheda a filo — righe e schede come testo, niente riquadri
import { FlatList, FlatRow } from './ui/flat-list'
import { UnderlineTabs } from './ui/underline-tabs'
// X2 (fase sicurezza-beta16): l'errore dell'ultima prova si mostra tagliato a 300
import { clipErrorText } from '../../../main/mcp/error-category'

/** La lingua attiva. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

/** Uno strumento come lo mostra la scheda. */
interface CardTool {
  full: string
  name: string
  description: string
  group: ToolGroup
  fixedAsk: FixedAskKind | null
}

/** I dati iniziali (per i test senza effect; nel prodotto si caricano dall'api). */
export interface PluginCardInitial {
  tools?: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }>
  permissions?: PermissionsConfig
  /** PP2: i NOMI dei segreti dei server (mcp:secret-names), per id */
  secretNames?: Record<string, ServerSecretNames>
  /** PP2: lo stato di partenza dell'editor del segreto (per rendere il campo aperto nei test) */
  secretEdit?: SecretEditState
  /** PP2: la scheda interna di partenza (nei test senza clic) */
  tab?: PluginCardTab
  /** PP4: la conferma di Rimuovi già aperta (per rendere «Rimuovi davvero» nei test) */
  confirmRemove?: boolean
}

export function PluginCard({ app, server, initial, initialTab, directEnabledFor, onConnect, onClose, onChanged }: {
  /** il connettore del catalogo (diretto o Composio) */
  app?: { row: CatalogRowView }
  /** il server MCP installato (manuale, registro, npm, plugin) */
  server?: McpServerInfo
  initial?: PluginCardInitial
  /** PL2: l'enabledFor del server diretto (dal pannello, per i toggle per bot) */
  directEnabledFor?: string[] | null
  /** PP2: la scheda interna su cui aprirsi (il rimando della Cassaforte chiede «Account e bot») */
  initialTab?: PluginCardTab
  /** PL4: collega con la prima strada disponibile (la propone apps:connect) */
  onConnect?(row: CatalogRowView): void
  onClose(): void
  onChanged(): void
}): ReactNode {
  const { t } = useLingui()
  const lang = uiLang()
  const agents = useStore((s) => s.agents)
  const connectors = useStore((s) => s.connectors)
  const composio = useStore((s) => s.composio)
  const composioGateway = useStore((s) => s.composioGateway)
  const [tab, setTab] = useState<PluginCardTab>(initialTab ?? initial?.tab ?? 'overview')
  const [tools, setTools] = useState<CardTool[] | null>(initial?.tools ? toolsOf(initial.tools, server) : null)
  const [perms, setPerms] = useState<PermissionsConfig | null>(initial?.permissions ?? null)
  const [confirmRemove, setConfirmRemove] = useState(initial?.confirmRemove ?? false)
  // PP2: l'editor del segreto (reducer puro: il valore non resta dopo il salvataggio) e i NOMI dei segreti salvati
  const [secretEdit, dispatchSecret] = useReducer(secretEditReducer, initial?.secretEdit ?? SECRET_EDIT_INITIAL)
  const [secretNames, setSecretNames] = useState<Record<string, ServerSecretNames> | null>(initial?.secretNames ?? null)

  const isServer = server !== undefined
  const name = isServer ? server.name : app!.row.app.name
  const logoUrl = isServer ? logoUrlForName(server.name) : null

  // i dati di Panoramica: onesti, solo ciò che c'è
  const directConnector = !isServer && app!.row.app.directId ? connectors.find((c) => c.id === app!.row.app.directId) ?? null : null
  const gatewayApp = !isServer && app!.row.app.composioSlug
    ? composioGateway?.connected.find((a) => a.slug === app!.row.app.composioSlug) ?? null
    : null
  const keyApp = !isServer && app!.row.app.composioSlug
    ? composio?.connected.find((a) => a.slug === app!.row.app.composioSlug) ?? null
    : null

  // gli strumenti: dal connettore diretto (annotations comprese) o dal server
  useEffect(() => {
    let alive = true
    if (initial?.tools || initial?.permissions) return
    void api.getPermissions().then((p) => { if (alive) setPerms(p) }).catch(() => undefined)
    if (isServer) {
      void api.mcpTools(server.id)
        .then((list) => { if (alive) setTools(toolsOf(list, server)) })
        .catch(() => { if (alive) setTools([]) })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // PP2: i NOMI dei segreti (mai i valori) arrivano dal daemon; se non arrivano la riga si affida alla config
  const reloadSecretNames = (): void => {
    void api.mcpSecretNames()
      .then((list) => setSecretNames(Object.fromEntries(list.map((n) => [n.id, n]))))
      .catch(() => setSecretNames({}))
  }
  useEffect(() => {
    if (initial?.secretNames) return
    reloadSecretNames()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id])

  const groups = useMemo(() => groupTools(tools ?? []), [tools])

  /** La scelta di un selettore: scrive la regola per strumento (senza
   *  updater: il valore del render è quello che l'handler ha letto). */
  const setRule = (full: string, mode: PermissionsConfig['default']): void => {
    const cfg = perms ?? { default: 'needs_approval' as const, rules: [] }
    const next = withToolRule(cfg, full, mode)
    setPerms(next)
    void api.setPermissions(next).then(() => onChanged()).catch(() => undefined)
  }
  /** La scelta del selettore di GRUPPO: vale per TUTTI gli strumenti del
   *  gruppo. A4 (fase approvazioni-chiare): «Consenti sempre» non si può per
   *  l'insieme fisso (il daemon la rifiuta) — quegli strumenti restano a
   *  «Chiedi»; «Chiedi» e «Blocca» valgono anche per loro. */
  const setGroupRule = (group: ToolGroup, mode: PermissionsConfig['default']): void => {
    let cfg = perms ?? { default: 'needs_approval' as const, rules: [] }
    for (const tool of (tools ?? []).filter((x) => x.group === group)) {
      if (tool.fixedAsk && mode === 'always_allow') continue
      cfg = withToolRule(cfg, tool.full, mode)
    }
    setPerms(cfg)
    void api.setPermissions(cfg).then(() => onChanged()).catch(() => undefined)
  }

  const state = isServer
    ? stateLabelOf(pluginStateOfServer(server), lang)
    : stateLabelOf(app!.row.connected === 'reconnect' ? 'expired' : 'active', lang)

  /** V4 (fase stato-vivo): Riaccendi — il server spento NON dall'utente si
   *  riaccende e parte il test U5 di mcp:save (che se fallisce lascia il
   *  server ACCESO con «non parte · Vedi perché»: non si rispegne da solo). */
  const reenableServer = (): void => {
    if (!server) return
    const { disabledReason: _r, ...rest } = server
    void api.mcpSave({ ...rest, enabled: true }).then(() => onChanged()).catch(() => undefined)
  }

  // ---- V5 (fase stato-vivo): l'interruttore Attivo in cima alla scheda ----
  // Server MCP: scrive enabled — OFF scrive disabledReason 'user' (la parola
  // dell'utente: migrazioni e riparazioni non lo toccano), ON toglie il
  // motivo e parte il test U5 di mcp:save (se fallisce resta ACCESO con
  // «non parte · Vedi perché», non si rispegne da solo). Connettore
  // Composio: l'enabled della VOCE, senza scollegare l'account.
  const composioSlug = !isServer && app!.row.app.composioSlug ? app!.row.app.composioSlug : null
  const composioDisabled = new Set(composio?.disabled ?? [])
  const activeChecked = isServer
    ? server.enabled !== false
    : composioSlug !== null
      ? !composioDisabled.has(composioSlug)
      : null
  const setActive = (next: boolean): void => {
    if (isServer) {
      const { disabledReason: _r, ...rest } = server
      void api.mcpSave(next ? { ...rest, enabled: true } : { ...rest, enabled: false, disabledReason: 'user' })
        .then(() => onChanged())
        .catch(() => undefined)
    } else if (composioSlug !== null) {
      void api.composioSetConnectorEnabled(composioSlug, next).then(() => onChanged()).catch(() => undefined)
    }
  }

  // ---- PP4 (fase plugin-pulita): la scheda a filo, come la lista ----
  // lo stato in parole SOLO quando non va (com'è la lista); quando non va, la
  // scheda dice anche PERCHÉ (l'errore dell'ultima prova, com'è — tagliato)
  const serverState = isServer ? pluginStateOfServer(server) : 'active'
  const stateOk = isServer ? serverState === 'active' : app!.row.connected === 'connected'
  const stateTone = serverState === 'off-homun' || serverState === 'off-user' ? 'text-muted-foreground' : 'text-destructive'
  const why = isServer && serverState === 'broken' && server.stateError ? clipErrorText(server.stateError) : ''
  // l'esito di «Prova la connessione» (menu ⋯): resta finché non se ne fa un altro
  const [lastTest, setLastTest] = useState<{ ok: boolean; tools?: string[]; error?: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const runTest = (): void => {
    if (!server) return
    void api.mcpTest(server.id)
      .then((r) => { setLastTest({ ok: r.ok, tools: r.tools, error: r.error }); onChanged() })
      .catch((e) => { setLastTest({ ok: false, error: e instanceof Error ? e.message : String(e) }) })
  }
  const canReconnect = isServer
    ? server.auth?.kind === 'oauth' || server.needsReauth === true
    : app!.row.connected === 'reconnect' && onConnect !== undefined
  const reconnect = (): void => {
    if (isServer) void api.connectorsReconnectServer(server.id).then(() => onChanged()).catch(() => undefined)
    else if (onConnect) onConnect(app!.row)
  }
  /** Rimuovi / Scollega: la strada giusta per ogni tipo di plugin (con la conferma: `confirmRemove`). */
  const remove = async (): Promise<void> => {
    if (isServer) {
      if (server.catalogId || server.source) await api.connectorsUninstallServer(server.id).catch(() => undefined)
      else await api.mcpDelete(server.id).catch(() => undefined)
    } else if (gatewayApp) {
      await api.composioGatewayRemove(app!.row.app.composioSlug!).catch(() => undefined)
    } else if (keyApp) {
      await api.composioDisconnect(app!.row.app.composioSlug!).catch(() => undefined)
    } else if (app!.row.app.directId) {
      await api.connectorsDisconnect(app!.row.app.directId).catch(() => undefined)
    }
    onChanged()
    onClose()
  }
  // l'interruttore in testata: server MCP e connettori Composio; per lo spento da Homun prende il suo posto «Riaccendi» (com'è la lista)
  const reenable = isServer && state.action === 'reenable'
  const showToggle = activeChecked !== null && !reenable

  return (
    <PluginShell
      testId="plugin-card"
      size="md"
      z={30}
      columnClassName="px-6 py-5"
      header={(
        // la testata (PP4): indietro · logo 40 · nome + riga grigia · a destra l'interruttore senza etichetta e il menu ⋯
        <div className="flex items-center gap-3" data-testid="plugin-card-head">
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={t`Torna ai plugin`}
            onClick={onClose}
          >
            <ChevronLeft className="size-4" />
          </button>
          {logoUrl
            ? <img src={logoUrl} alt="" className="size-10 shrink-0 rounded-[11px] object-cover dark:bg-white" />
            : <AppLogo logo={app?.row.app.logo ?? null} name={name} className="size-10 text-base" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-medium">{name}</span>
            <span className="block truncate text-[13px] text-muted-foreground" data-testid="plugin-card-gray">{cardGrayLineOf(isServer ? { server } : { app: { name: app!.row.app.name, via: app!.row.app.via } }, lang)}</span>
            {!stateOk && (
              <span className={`block text-[13px] ${stateTone}`} data-testid="plugin-card-state">{state.label}</span>
            )}
            {why !== '' && <span className="block truncate text-[12px] text-muted-foreground" title={why} data-testid="plugin-card-why">{why}</span>}
            {lastTest !== null && (
              <span className={`block truncate text-[12px] ${lastTest.ok ? 'text-chart-2' : 'text-destructive'}`} title={lastTest.error ?? ''} data-testid="plugin-card-test-result">
                {lastTest.ok ? t`collegato · ${(lastTest.tools ?? []).length} strumenti` : clipErrorText(lastTest.error ?? '')}
              </span>
            )}
          </span>
          {/* PL4: non collegata — Connetti propone la PRIMA strada disponibile
              (la decisione sta in apps:connect, come la riga del catalogo) */}
          {!isServer && app!.row.connected === null && onConnect && (
            <button
              type="button"
              className="h-8 shrink-0 rounded-full bg-muted px-4 text-[13px] text-foreground transition hover:bg-accent"
              data-testid={`plugin-card-connect-${app!.row.app.id}`}
              onClick={() => onConnect(app!.row)}
            >
              <Trans>Connetti</Trans>
            </button>
          )}
          {/* V5 (fase stato-vivo): l'interruttore — senza etichetta accanto (PP4; l'aria-label sì) */}
          {showToggle && <Toggle checked={activeChecked} onChange={setActive} label={t`Attivo`} testId="plugin-card-active" />}
          {/* V4 (fase stato-vivo): spento da Homun → Riaccendi, che accende e
              testa; spento dall'utente non si propone niente (è la sua parola) */}
          {reenable && (
            <button
              type="button"
              className="h-8 shrink-0 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition hover:opacity-90"
              data-testid="plugin-card-reenable"
              onClick={reenableServer}
            >
              <Trans>Riaccendi</Trans>
            </button>
          )}
          {/* il menu ⋯: Prova la connessione · Ricollega (OAuth) · Rimuovi/Scollega con conferma.
              Sta SEMPRE nel DOM (nascosto quando chiuso): le sonde lo aprono col clic, i test lo leggono senza clic */}
          <div className="relative">
            <button
              type="button"
              className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t`Altre azioni`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="plugin-card-menu-trigger"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MoreHorizontal className="size-4" />
            </button>
            <div
              role="menu"
              aria-label={t`Altre azioni`}
              className={`absolute right-0 top-full z-30 mt-1.5 flex w-64 flex-col gap-0.5 rounded-2xl bg-card p-1.5 shadow-soft ${menuOpen ? '' : 'hidden'}`}
              data-testid="plugin-card-menu"
            >
              {isServer && (
                <button type="button" role="menuitem" className={MENU_ITEM} data-testid="plugin-card-test" onClick={() => { setMenuOpen(false); runTest() }}>
                  <Trans>Prova la connessione</Trans>
                </button>
              )}
              {canReconnect && (
                <button type="button" role="menuitem" className={MENU_ITEM} data-testid="plugin-card-reconnect" onClick={() => { setMenuOpen(false); reconnect() }}>
                  <Trans>Ricollega</Trans>
                </button>
              )}
              {confirmRemove ? (
                <>
                  <button type="button" role="menuitem" className={`${MENU_ITEM} text-destructive`} data-testid="plugin-card-remove-confirm" onClick={() => { setMenuOpen(false); void remove() }}>
                    {isServer ? <Trans>Rimuovi davvero</Trans> : <Trans>Scollega davvero</Trans>}
                  </button>
                  <button type="button" role="menuitem" className={MENU_ITEM} data-testid="plugin-card-remove-cancel" onClick={() => { setMenuOpen(false); setConfirmRemove(false) }}>
                    <Trans>Annulla</Trans>
                  </button>
                </>
              ) : (
                <button type="button" role="menuitem" className={`${MENU_ITEM} text-destructive`} data-testid="plugin-card-remove" onClick={() => setConfirmRemove(true)}>
                  {isServer ? <Trans>Rimuovi</Trans> : <Trans>Scollega</Trans>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      toolbar={(
        // le schede interne come testo (PP4)
        <UnderlineTabs<PluginCardTab>
          tabs={[['overview', t`Panoramica`], ['permissions', t`Autorizzazioni`], ['accounts', t`Account e bot`]]}
          value={tab}
          onChange={setTab}
          label={t`Schede del plugin`}
          testId="plugin-card-tabs"
        />
      )}
    >
      {/* i pannelli stanno TUTTI nel DOM (nascosti quando inattivi): le
          sonde aprono la scheda col clic, i test leggono senza clic */}
      {/* --- PANORAMICA: i fatti a filo, in due colonne quando c'è spazio --- */}
      <Overview
        app={app?.row}
        server={server}
        directConnector={directConnector}
        via={!isServer ? app!.row.app.via : undefined}
        composioSlug={app?.row.app.composioSlug}
        hidden={tab !== 'overview'}
      />

      {/* --- AUTORIZZAZIONI: una tabella a filo --- */}
      <div className="space-y-6" hidden={tab !== 'permissions'} data-testid="plugin-permissions">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          <Trans>Scegli cosa i bot possono fare da soli. Le regole valgono per tutti i bot che usano questo plugin.</Trans>
        </p>
        {tools === null && <p className="text-sm text-muted-foreground"><Trans>caricamento…</Trans></p>}
        {tools !== null && tools.length === 0 && (
          <p className="text-sm text-muted-foreground"><Trans>Nessuno strumento elencato.</Trans></p>
        )}
        {(['read', 'write', 'other'] as const).map((g) => {
          const list = groups[g]
          if (list.length === 0) return null
          const label = g === 'read' ? t`Sola lettura` : g === 'write' ? t`Scrittura` : t`Altro`
          return (
            <section key={g} data-testid={`plugin-group-${g}`}>
              <FlatList>
                {/* la riga d'intestazione: nome del gruppo · N, il selettore del gruppo a destra */}
                <div className="flex items-center justify-between gap-3 py-2" data-testid={`plugin-group-head-${g}`}>
                  <h3 className="text-[13px] text-muted-foreground">
                    {label} <span>· {list.length}</span>
                  </h3>
                  <GroupSelect
                    testid={`plugin-group-select-${g}`}
                    fixed={list.every((x) => x.fixedAsk !== null)}
                    value={groupValueOf(perms, list)}
                    onChange={(mode) => setGroupRule(g, mode)}
                  />
                </div>
                {/* le azioni: nome, descrizione su una riga troncata, selettore a destra — nessun fondo */}
                {list.map((tool) => (
                  <FlatRow
                    key={tool.full}
                    testId={`plugin-tool-${tool.name}`}
                    title={(
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[14px]">{tool.name}</span>
                        {tool.fixedAsk && (
                          <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label={t`azione dell'insieme fisso: chiede sempre`} />
                        )}
                      </span>
                    )}
                    subtitle={tool.description ? <span title={tool.description}>{tool.description}</span> : undefined}
                    trailing={(
                      <GroupSelect
                        testid={`plugin-tool-select-${tool.name}`}
                        fixed={tool.fixedAsk !== null}
                        value={perms ? toolRuleOf(perms, tool.full) : 'needs_approval'}
                        onChange={(mode) => setRule(tool.full, mode)}
                      />
                    )}
                  />
                ))}
              </FlatList>
            </section>
          )
        })}
        {/* la frase F8 (vera nel codice: liftContaminatedAllow) */}
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          <Trans>Le scelte: Consenti sempre · Chiedi · Blocca. Dopo che un bot ha letto contenuti non fidati, le azioni di scrittura tornano a chiedere anche se le hai consentite.</Trans>
        </p>
      </div>

      {/* --- ACCOUNT E BOT: riga Account (con PP2), poi i bot a filo --- */}
      <div className="space-y-6" hidden={tab !== 'accounts'} data-testid="plugin-accounts">
        {isServer ? (
          <ServerAccountRow
            server={server}
            names={secretNames?.[server.id] ?? null}
            state={secretEdit}
            onAction={dispatchSecret}
            onChanged={() => { onChanged(); reloadSecretNames() }}
          />
        ) : (
          <div>
            <h3 className="text-[13px] text-muted-foreground"><Trans>Account</Trans></h3>
            <FlatList className="mt-1">
              {gatewayApp === null && (
                <FlatRow
                  title={keyApp ? t`con la chiave di progetto` : t`con il tuo account`}
                  subtitle={!stateOk ? <span className={stateTone}>{state.label}</span> : undefined}
                />
              )}
            </FlatList>
            {!isServer && gatewayApp && (
              <GatewayAccountsSection app={gatewayApp} appName={name} onChanged={onChanged} />
            )}
          </div>
        )}

        {/* i bot che lo usano: l'interruttore per bot (enabledFor) — «Tutti i bot» e un bot per riga */}
        <div>
          <h3 className="text-[13px] text-muted-foreground"><Trans>Bot che lo usano</Trans></h3>
          {isServer ? (
            <BotRows serverId={server.id} enabledFor={server.enabledFor} agents={agents} onChanged={onChanged} className="mt-1" />
          ) : app!.row.app.via === 'direct' && app!.row.app.directId ? (
            <BotRows serverId={app!.row.app.directId} enabledFor={directEnabledFor} agents={agents} onChanged={onChanged} className="mt-1" />
          ) : (
            <FlatList className="mt-1">
              <FlatRow title={<Trans>Tutti i bot</Trans>} />
            </FlatList>
          )}
        </div>

        {/* Rimuovi in fondo come testo rosso (PP1: ora si raggiunge scorrendo) — e anche nel menu ⋯ */}
        <div className="flex justify-end border-t border-border/50 pt-3">
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
            data-testid="plugin-card-remove-bottom"
            onClick={() => { if (confirmRemove) void remove(); else setConfirmRemove(true) }}
          >
            {confirmRemove ? (isServer ? <Trans>Rimuovi davvero</Trans> : <Trans>Scollega davvero</Trans>) : (isServer ? <Trans>Rimuovi</Trans> : <Trans>Scollega</Trans>)}
          </button>
        </div>
      </div>
    </PluginShell>
  )
}

// ---- i pezzi piccoli ----

/** Le voci del menu ⋯ della testata. */
const MENU_ITEM = 'rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted'

/**
 * «Bot che lo usano» A FILO (PP4): la prima riga «Tutti i bot» con
 * l'interruttore, poi UN bot per riga — nome a sinistra, interruttore a
 * destra. Scrive enabledFor del server (server MCP o connettore diretto).
 */
function BotRows({ serverId, enabledFor: raw, agents, onChanged, className }: {
  serverId: string
  enabledFor: string[] | null | undefined
  agents: Array<{ id: string; name: string }>
  onChanged(): void
  className?: string
}): ReactNode {
  const { t } = useLingui()
  const enabledFor = raw ?? ['*']
  const all = enabledFor.includes('*')
  const save = (ids: string[]): void => {
    void api.connectorsSetEnabledFor('server', serverId, ids).then(() => onChanged())
  }
  return (
    <FlatList className={className} testId="plugin-card-bots">
      <FlatRow title={<Trans>Tutti i bot</Trans>} trailing={<Toggle label={t`Tutti i bot`} checked={all} onChange={(v) => save(v ? ['*'] : [])} />} />
      {agents.map((a) => (
        <FlatRow
          key={a.id}
          title={a.name}
          trailing={(
            <Toggle
              label={a.name}
              checked={all || enabledFor.includes(a.id)}
              disabled={all}
              onChange={(v) => {
                // da «tutti»: spegnere UN bot lascia TUTTI GLI ALTRI (come
                // ServerSheet); il resto aggiunge/toglie l'id scelto
                if (all) { save(v ? ['*'] : agents.map((x) => x.id).filter((id) => id !== a.id)); return }
                const ids = enabledFor.filter((id) => id !== '*')
                save(v ? [...ids, a.id] : ids.filter((id) => id !== a.id))
              }}
            />
          )}
        />
      ))}
    </FlatList>
  )
}

/** Il selettore a tre scelte (l'insieme fisso ne ha due: mai «Consenti sempre»).
 *  A4 (fase approvazioni-chiare): col valore «Misto» quando le regole del
 *  gruppo differiscono — sceglierne uno vale per tutti. */
function GroupSelect({ testid, fixed, value, onChange }: {
  testid: string
  fixed: boolean
  value: PermissionsConfig['default'] | typeof GROUP_VALUE_MIXED
  onChange(mode: PermissionsConfig['default']): void
}): ReactNode {
  const { t } = useLingui()
  const options: Array<[PermissionsConfig['default'] | typeof GROUP_VALUE_MIXED, string]> = fixed
    ? [['needs_approval', t`Chiedi`], ['blocked', t`Blocca`]]
    : [['always_allow', t`Consenti sempre`], ['needs_approval', t`Chiedi`], ['blocked', t`Blocca`]]
  if (value === GROUP_VALUE_MIXED) options.unshift([GROUP_VALUE_MIXED, t`Misto`])
  return (
    <select
      className="shrink-0 rounded-full bg-card px-2.5 py-1 text-[12px] outline-none"
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.target.value as PermissionsConfig['default'])}
    >
      {options.map(([mode, label]) => (
        <option key={mode} value={mode} disabled={mode === GROUP_VALUE_MIXED}>{label}</option>
      ))}
    </select>
  )
}

/** Gli strumenti di un server/lista → le righe della scheda (nome completo
 *  mcp__<toolSlug>__<tool>, lo stesso prefisso del sistema). */
function toolsOf(list: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }>, server?: McpServerInfo): CardTool[] {
  return list.map((tool) => {
    const full = server && !tool.name.startsWith('mcp__') ? `mcp__${toolSlugOf(server)}__${tool.name}` : tool.name
    const { group, fixedAsk } = classifyPluginTool(full, tool.annotations)
    // A4: nome e descrizione come li vede l'UTENTE (mcpToolPresentation) —
    // senza prefisso mcp__<slug>__ e senza il tag [MCP:<nome>]: restano al modello
    const shown = mcpToolPresentation(full, tool.description)
    return { full, name: shown.name, description: shown.description, group, fixedAsk }
  })
}

/** Le tre liste della divisione. */
function groupTools(tools: CardTool[]): Record<ToolGroup, CardTool[]> {
  const out: Record<ToolGroup, CardTool[]> = { read: [], write: [], other: [] }
  for (const tool of tools) out[tool.group].push(tool)
  return out
}

/** il valore «Misto» del selettore di gruppo: le regole del gruppo differiscono */
export const GROUP_VALUE_MIXED = 'mixed'

/** Il valore del selettore di gruppo: la regola comune, o «Misto» se differiscono. */
function groupValueOf(perms: PermissionsConfig | null, list: CardTool[]): PermissionsConfig['default'] | typeof GROUP_VALUE_MIXED {
  if (!perms || list.length === 0) return 'needs_approval'
  const modes = new Set(list.filter((x) => !x.fixedAsk).map((x) => toolRuleOf(perms, x.full)))
  if (modes.size === 1) return [...modes][0]!
  return GROUP_VALUE_MIXED
}

// ---- Panoramica: i fatti, a filo — mai inventati ----

/**
 * Un gruppo di fatti della Panoramica (PP4): l'etichetta grigia e il valore.
 * Una colonna di default (etichetta sopra il valore); due sopra i 560px del
 * contenitore (etichetta a sinistra, valore a destra). Filetto in alto.
 */
function FactGroup({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-x-8 border-t border-border/50 py-3 @[560px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <div className="mt-1 min-w-0 space-y-0.5 text-[14px] @[560px]:mt-0">{children}</div>
    </div>
  )
}

/** La Panoramica: la descrizione in testa (quando c'è) e i fatti in tre gruppi — Provenienza · Sicurezza · Dati — senza riquadri. */
function Overview({ app, server, directConnector, via, composioSlug, hidden }: {
  app?: CatalogRowView
  server?: McpServerInfo
  directConnector: ConnectorInfo | null
  via?: 'direct' | 'composio'
  composioSlug?: string
  hidden: boolean
}): ReactNode {
  const { t } = useLingui()
  const lang = uiLang()
  // PROVENIENZA: da dove arriva e con che strada
  const provenance: ReactNode[] = []
  // SICUREZZA: dove gira e chi vede i segreti
  const security: ReactNode[] = []
  // DATI: dove vanno — SOLO quando c'è un fatto da dire (mai inventato)
  const data: ReactNode[] = []
  if (server) {
    const strada = stradaOfServer(server)
    provenance.push(<p key="s">{stradaLabel(strada, stradaOrigin(server), lang)}</p>)
    const cmd = serverCommandLine(server) || server.url || ''
    if (cmd) provenance.push(<p key="c" className="truncate font-mono text-[12px] text-muted-foreground" title={cmd}>{cmd}</p>)
    if (server.source?.kind === 'npm') {
      provenance.push(<p key="v" className="text-[12px] text-muted-foreground">{t`versione fissata ${server.source.version}`}</p>)
    }
    security.push(<p key="w">{server.source?.kind === 'npm' || server.box ? t`gira nel computer isolato` : t`gira sul tuo Mac`}</p>)
    if (server.url) {
      const host = hostOf(server.url)
      if (host) data.push(<p key="h">{t`i dati vanno a ${host}`}</p>)
    }
    if (server.egress) {
      data.push(<p key="e" className="text-[12px] text-muted-foreground">{t`rete: solo ${server.egress.allowHosts.join(', ')}`}</p>)
    }
  } else if (via === 'direct') {
    provenance.push(<p key="s">{t`MCP diretto di ${app!.app.name}`}</p>)
    if (directConnector?.mcpUrl) {
      const host = hostOf(directConnector.mcpUrl)
      if (host) provenance.push(<p key="h" className="font-mono text-[12px] text-muted-foreground">{host}</p>)
    }
    if (composioSlug) provenance.push(<p key="a" className="text-[12px] text-muted-foreground">{t`Alternativa: tramite Composio`}</p>)
    security.push(<p key="l">{t`login con il tuo account`}</p>)
    security.push(<p key="n">{t`nessun intermediario`}</p>)
    if (directConnector?.mcpUrl) {
      const host = hostOf(directConnector.mcpUrl)
      if (host) data.push(<p key="h">{t`i dati vanno solo a ${host}`}</p>)
    }
  } else {
    provenance.push(<p key="s">{t`tramite Composio`}</p>)
    if (app?.app.directId) provenance.push(<p key="a" className="text-[12px] text-muted-foreground">{t`Alternativa: MCP diretto`}</p>)
    security.push(<p key="h">{t`i login e le azioni passano dai server di Composio`}</p>)
  }
  security.push(<p key="t">{t`i segreti stanno cifrati sul tuo Mac`}</p>)
  return (
    <div className="@container" hidden={hidden} data-testid="plugin-overview">
      <div className="space-y-6">
        {/* la descrizione, quando c'è: in testa, 14px */}
        {app?.tagline && <p className="text-[14px] leading-relaxed">{app.tagline}</p>}
        <div>
          <FactGroup label={t`Provenienza`}>{provenance}</FactGroup>
          <FactGroup label={t`Sicurezza`}>{security}</FactGroup>
          {data.length > 0 && <FactGroup label={t`Dati`}>{data}</FactGroup>}
        </div>
      </div>
    </div>
  )
}

/** L'origine onesta del server, dal source (il nome del registro, il pacchetto npm, il plugin). */
function stradaOrigin(server: McpServerInfo): string | undefined {
  const src = server.source
  if (!src) return undefined
  if (src.kind === 'registry') return src.name
  if (src.kind === 'npm') return `${src.package}@${src.version}`
  if (src.kind === 'plugin') return src.plugin
  if (src.kind === 'gateway') return src.preset
  return undefined
}

/** L'host di un URL (per la riga onesta dei dati). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
