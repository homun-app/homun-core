// Fase app (A1): la finestra «App» — UNA lista curata, senza parole tecniche.
// Dall'alto in basso: ricerca, «Collegate» (con stato e «da ricollegare»),
// «Tutte le app» (curate prima, Composio dopo, vedi A3) e «Skill dei bot».
// Ogni riga: logo, nome, una frase, l'ETICHETTA DI PROVENIENZA (A7) e Collega.
// La parola «MCP» non compare MAI nella vista principale: marketplace dei
// plugin, gateway, OAuth/CIMD, server manuali e risultati del registro stanno
// nel foglio «Per sviluppatori», aperto dal link piccolo in fondo.
// Fase app (A2): la card «Più di mille app con Composio» finché Composio non
// è attivo; il foglio di attivazione ha tre passi (cos'è, incolla la chiave,
// prova). La chiave va nel sealed store del daemon: la UI riceve SOLO hasKey
// e le ultime 4 cifre.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Search, X } from 'lucide-react'
import { api, useStore } from '../store'
import { pickLang } from '../../../shared/localized'
import { i18n } from '../lib/i18n'
import { localizedActionName } from '../../../shared/composio-names'
import { CURATED_COMPOSIO_SLUGS } from '../../../shared/types'
import type { ConnectorInfo, McpServerInfo, McpServerSecret, AppsRegistryResult, SecretKind, ComposioCatalogRow, ComposioConnectedApp } from '../../../shared/types'
import { SECRET_KIND_FOR_NEEDS } from '../../../shared/types'
import { appsViewModel, taglineOf, type AppsFilter, type InstalledServerLike, type InstalledPluginLike, type ConnectedRow } from '../lib/apps-view'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

/** La lingua attiva come UiLanguage. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

// ---- le viste di oggi (restilizzate: fondi tenui, niente bordi) ----

const STATUS_DOT: Record<string, string> = {
  not_connected: 'bg-muted-foreground/40',
  connected: 'bg-chart-2',
  needs_auth: 'bg-destructive',
  error: 'bg-destructive'
}
const STATUS_LABEL: Record<string, MessageDescriptor> = {
  not_connected: msg`non connesso`,
  connected: msg`connesso`,
  needs_auth: msg`da autorizzare`,
  error: msg`errore`
}

/** A7: l'etichetta piccola sulla provenienza dei dati di ogni app. */
export function ProvenanceTag({ via }: { via: 'direct' | 'composio' }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${via === 'composio' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
      {via === 'composio'
        ? <Trans>Tramite Composio: login e azioni passano dai suoi server</Trans>
        : <Trans>Diretta: il permesso resta sul tuo Mac</Trans>}
    </span>
  )
}

/** Il logo di una riga: immagine (data: URL) o l'iniziale su un cerchio. */
function AppLogo({ logo, name, className = 'size-10 text-base' }: { logo: string | null; name: string; className?: string }) {
  if (logo && logo.startsWith('data:')) {
    return <img src={logo} alt="" className={`shrink-0 rounded-[11px] object-cover ${className}`} />
  }
  const emoji = logo && !logo.startsWith('data:') && logo.length <= 4 ? logo : null
  return (
    <span className={`grid ${className} shrink-0 place-items-center rounded-[11px] bg-muted font-bold ${emoji ? '' : 'text-foreground/70'}`}>
      {emoji ?? name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Il dettaglio di un connettore del catalogo: tool on/off, istruzioni, Scollega (ciò che faceva ConnectorTile). */
function ConnectorDetail({ c, onDone, onComposio }: { c: ConnectorInfo; onDone(): void; onComposio(slug: string, name: string): void }) {
  const { t, i18n } = useLingui()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [instructions, setInstructions] = useState(c.state.instructions)
  const composio = useStore((s) => s.composio)
  // A3: «Collega tramite Composio» come alternativa secondaria nel dettaglio
  // della curata (solo se Composio è attivo e quel toolkit non è collegato)
  const composioSlug = CURATED_COMPOSIO_SLUGS[c.id]
  const composioConnected = composio?.connected.find((a) => a.slug === composioSlug)

  const toggleTool = async (tool: string, disabled: boolean): Promise<void> => {
    const next = disabled
      ? c.state.disabledTools.filter((x) => x !== tool)
      : [...c.state.disabledTools, tool]
    await api.connectorsSetTools(c.id, next)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base">{c.logo}</span>
        <span className="text-sm font-medium">{c.name}</span>
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.state.status]}`} title={c.state.error ?? i18n.t(STATUS_LABEL[c.state.status] ?? msg`errore`)} />
        <span className="text-[10px] uppercase text-muted-foreground">{i18n.t(STATUS_LABEL[c.state.status] ?? msg`errore`)}</span>
        <div className="flex-1" />
        {c.state.status === 'connected' ? (
          <button
            className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await api.connectorsDisconnect(c.id) } finally { setBusy(false) }
              onDone()
            }}
          >
            <Trans>Scollega</Trans>
          </button>
        ) : (
          <button
            className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await api.connectorsConnect(c.id) } finally { setBusy(false) }
            }}
          >
            {busy ? <Trans>autorizza nel browser…</Trans> : c.state.status === 'needs_auth' ? <Trans>riconnetti</Trans> : <Trans>connetti</Trans>}
          </button>
        )}
      </div>
      <ProvenanceTag via="direct" />
      {c.state.error && <p className="text-[11px] text-destructive/80">{c.state.error}</p>}
      {c.state.status !== 'connected' && c.notes && (
        <p className="line-clamp-3 text-[11px] text-muted-foreground">{pickLang(c.notes, uiLang())}</p>
      )}
      {/* A3: l'alternativa secondaria «Collega tramite Composio» */}
      {composioSlug && composio?.active && (
        <div className="rounded-2xl bg-muted px-3 py-2.5">
          {composioConnected ? (
            <p className="text-[11px] text-muted-foreground">
              <Trans>Collegata anche tramite Composio: scollegala dalla riga di Composio in «Collegate».</Trans>
            </p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground"><Trans>Oppure collega {c.name} tramite Composio (più app, un account):</Trans></p>
              <button
                className="mt-1.5 rounded-full bg-card px-3 py-1 text-xs transition hover:bg-card/80"
                onClick={() => onComposio(composioSlug, c.name)}
              >
                <Trans>Collega tramite Composio</Trans>
              </button>
            </>
          )}
        </div>
      )}
      {/* client OAuth statico (Google): credenziali cifrate, guida in docs/google-oauth.md */}
      {c.clientRegistration === 'static' && c.state.status !== 'connected' && (
        <div className="space-y-1 rounded-2xl bg-muted p-3">
          {c.hasStaticCredentials ? (
            <p className="text-[11px] text-muted-foreground"><Trans>Client OAuth configurato ✓</Trans></p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                <Trans>Serve un client OAuth tuo (tipo «Desktop app»):</Trans>{' '}
                <a className="text-primary hover:underline" href={c.docsUrl} target="_blank" rel="noreferrer">{t`guida`}</a>
              </p>
              <div className="flex gap-1">
                <input className="min-w-0 flex-1 rounded-lg bg-card px-2 py-1 text-xs outline-none" placeholder="client_id" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                <input className="min-w-0 flex-1 rounded-lg bg-card px-2 py-1 text-xs outline-none" type="password" placeholder="client_secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
                <button
                  className="rounded-full bg-card px-3 py-1 text-xs transition hover:bg-card/80 disabled:opacity-40"
                  disabled={!clientId.trim() || !clientSecret.trim()}
                  onClick={() => void api.connectorsSaveStaticClient(c.id, clientId.trim(), clientSecret.trim())}
                >
                  <Trans>salva</Trans>
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2 rounded-2xl bg-muted p-3">
          <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setOpen(!open)}>
            {open ? <Trans>chiudi i tool</Trans> : <Trans>tool</Trans>}
          </button>
          {c.tools.length === 0 && <p className="text-[11px] text-muted-foreground"><Trans>nessun tool elencato</Trans></p>}
          {c.tools.map((t2) => {
            const disabled = c.state.disabledTools.includes(t2.name)
            return (
              <label key={t2.name} className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-foreground" checked={!disabled} onChange={() => void toggleTool(t2.name, disabled)} />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px]">{t2.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{t2.description}</span>
                </span>
              </label>
            )
          })}
          <div>
            <p className="mb-1 text-[11px] text-muted-foreground"><Trans>Istruzioni personalizzate (vanno nel prompt del bot quando il connettore è attivo)</Trans></p>
            <textarea
              className="w-full resize-none rounded-lg bg-card px-2 py-1.5 text-xs outline-none"
              rows={3}
              placeholder={t`es. Usa questo account solo per lavoro; le email in italiano vanno riassunte in bulleted list…`}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => void api.connectorsSetInstructions(c.id, instructions)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** Il dettaglio di un server MCP installato: per quali bot, chiavi, disinstalla (ciò che faceva InstalledTab). */
function ServerDetail({ sv, onDone }: { sv: InstalledServerLike & { needsAuth?: { kind?: string; keys?: string[] } | null; transport?: string; url?: string; command?: string; args?: string[]; box?: { command?: string; args?: string[] } }; onDone(): void }) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [values, setValues] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const needs = sv.needsAuth as { kind?: string; keys?: string[] } | null | undefined
  const keys = needs?.keys?.join(', ') ?? ''
  const enabledForEditor = (current: string[] | undefined): ReactNode => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground"><Trans>per bot:</Trans></span>
      {agents.map((a) => {
        const on = current?.includes('*') || current?.includes(a.id)
        return (
          <label key={a.id} className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3 accent-foreground"
              checked={on}
              onChange={() => {
                const next = current?.includes('*') ? [] : [...(current ?? [])]
                const i = next.indexOf(a.id)
                if (i >= 0) next.splice(i, 1)
                else next.push(a.id)
                void api.connectorsSetEnabledFor('server', sv.id, next).then(() => onDone())
              }}
            />
            {a.name}
          </label>
        )
      })}
    </div>
  )
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${needs ? 'bg-destructive' : 'bg-chart-2'}`} />
        <span className="text-sm font-medium">{sv.name}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{sv.source?.kind ?? t`manuale`}</span>
        <div className="flex-1" />
        <button
          className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
          onClick={async () => { await api.connectorsUninstallServer(sv.id); onDone() }}
        >
          <Trans>Disinstalla</Trans>
        </button>
      </div>
      <p className="truncate text-xs text-muted-foreground">{sv.transport === 'http' ? (sv.url ?? '') : `${sv.box?.command ?? sv.command ?? ''} ${(sv.box?.args ?? sv.args ?? []).join(' ')}`}</p>
      {sv.needsReauth && (
        <button
          className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
          onClick={async () => {
            const r = await api.connectorsReconnectServer(sv.id).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
            setMsg(r.ok ? (r.message ?? t`riconnesso`) : t`riconnessione non riuscita`)
            onDone()
          }}
        >
          <Trans>Ricollega</Trans>
        </button>
      )}
      {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
      {enabledForEditor(sv.enabledFor ?? undefined)}
      {needs?.keys?.length ? (
        <div className="space-y-1 rounded-2xl bg-muted p-3">
          <p className="text-[11px] text-destructive/80">
            {needs.kind === 'key' ? <Trans>serve: {keys} (header)</Trans> : needs.kind === 'env' ? <Trans>serve: {keys} (variabile d'ambiente)</Trans> : <Trans>serve: {keys} (impostazione del plugin)</Trans>}
          </p>
          {needs.keys.map((k) => (
            <input
              key={k}
              className="min-w-0 flex-1 rounded-lg bg-card px-2 py-1 text-xs outline-none"
              type="password"
              placeholder={k}
              value={values[`${sv.id}:${k}`] ?? ''}
              onChange={(e) => setValues((p) => ({ ...p, [`${sv.id}:${k}`]: e.target.value }))}
            />
          ))}
          <button
            className="rounded-full bg-card px-3 py-1 text-xs transition hover:bg-card/80"
            onClick={async () => {
              const vals: Record<string, string> = {}
              for (const k of needs.keys ?? []) if (values[`${sv.id}:${k}`]?.trim()) vals[k] = values[`${sv.id}:${k}`]!.trim()
              await api.connectorsSaveServerValues(sv.id, SECRET_KIND_FOR_NEEDS[needs.kind as keyof typeof SECRET_KIND_FOR_NEEDS] as SecretKind, vals)
              setValues({})
              onDone()
            }}
          >
            <Trans>salva cifrato</Trans>
          </button>
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        <Trans>Server del registro pubblico. Chiavi, header e variabili stanno cifrati: si compilano qui, MAI in chat.</Trans>
      </p>
    </div>
  )
}

/** Server MCP aggiunti a mano: il form di oggi, dentro un foglio. */
export function ManualServersSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <ManualServers />
      </div>
    </div>
  )
}

/** Server MCP aggiunti a mano (stdio o HTTP, con header/bearer salvati cifrati). */
function ManualServers() {
  const { t } = useLingui()
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [edit, setEdit] = useState<McpServerInfo | null>(null)
  // fase 5: bearer token del server manuale (salvato CIFRATO, mai nei settings)
  const [editBearer, setEditBearer] = useState('')
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string; tools?: string[] }>>({})

  const refresh = async () => {
    setServers(await api.mcpList())
  }
  useEffect(() => { void refresh() }, [])

  return (
    <div className="space-y-3">
      <strong className="block font-display text-lg"><Trans>Server MCP personalizzato</Trans></strong>
      <p className="text-xs text-muted-foreground"><Trans>Server MCP manuali (stdio o HTTP, con header/bearer salvati cifrati).</Trans></p>
      {servers.map((s) => (
        <div key={s.id} className="rounded-2xl bg-muted px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.enabled ? 'bg-chart-2' : 'bg-muted-foreground/40'}`} />
            <span className="text-sm">{s.name}</span>
            <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{s.transport}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</span>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={async () => {
              setTests((p) => ({ ...p, [s.id]: { ok: true, tools: ['test…'] } }))
              const r = await api.mcpTest(s.id)
              setTests((p) => ({ ...p, [s.id]: r }))
            }}><Trans>test</Trans></button>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setEdit(s); setEditBearer('') }}><Trans>modifica</Trans></button>
            <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.mcpDelete(s.id); await refresh() }}><Trans>elimina</Trans></button>
          </div>
          {tests[s.id] && (
            <div className={`mt-2 text-xs ${tests[s.id].ok ? 'text-chart-2' : 'text-destructive'}`}>
              {tests[s.id].ok ? t`✓ ${tests[s.id].tools?.length ?? 0} tool: ${(tests[s.id].tools ?? []).join(', ').slice(0, 200)}` : t`✕ ${tests[s.id].error ?? ''}`}
            </div>
          )}
        </div>
      ))}
      {edit ? (
        <div className="space-y-2 rounded-2xl bg-muted p-3">
          <div className="grid grid-cols-2 gap-2">
            <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. weather)`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <select className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as 'stdio' | 'http' })}>
              <option value="stdio">{t`stdio (comando locale)`}</option>
              <option value="http">{t`http (URL)`}</option>
            </select>
          </div>
          {edit.transport === 'stdio' ? (
            <div className="grid grid-cols-2 gap-2">
              <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Comando (es. node)`} value={edit.command ?? ''} onChange={(e) => setEdit({ ...edit, command: e.target.value })} />
              <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Argomenti separati da spazio`} value={(edit.args ?? []).join(' ')} onChange={(e) => setEdit({ ...edit, args: e.target.value ? e.target.value.split(/\s+/) : [] })} />
            </div>
          ) : (
            <>
              <input className="w-full rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`URL (es. http://localhost:3001/mcp)`} value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              <input
                className="w-full rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none"
                type="password"
                placeholder={t`Bearer token (opzionale — salvato cifrato)`}
                value={editBearer}
                onChange={(e) => setEditBearer(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEdit(null)}><Trans>Annulla</Trans></button>
            <button
              className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              onClick={async () => {
                const secret: McpServerSecret | undefined = edit.transport === 'http' && editBearer.trim() ? { bearerToken: editBearer.trim() } : undefined
                await api.mcpSave({ ...edit, id: edit.id || 'mcp_' + Date.now() }, secret)
                setEdit(null); setEditBearer('')
                await refresh()
              }}
            >
              <Trans>Salva</Trans>
            </button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-2xl bg-muted px-3 py-2.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={() => { setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true }); setEditBearer('') }}>
          <Trans>+ Aggiungi server MCP</Trans>
        </button>
      )}
    </div>
  )
}

/** Scheda Marketplace (restilizzata): elenco, aggiungi (owner/repo o URL git), rimuovi. */
function MarketplaceTab() {
  const { t } = useLingui()
  const [list, setList] = useState<Array<{ name: string; source: string; kind: string; official: boolean }> | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => setList(await api.marketplaceList())
  useEffect(() => { void refresh() }, [])
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <Trans>Plugin nel formato di Claude Code. Predefinito: <code>anthropics/claude-plugins-official</code> (puoi rimuoverlo). Di un plugin Homun importa SOLO skill e server MCP; hook, bin/ e comandi non girano mai.</Trans>
      </p>
      {(list ?? []).map((m) => (
        <div key={m.source} className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2">
          <span className="text-sm">{m.name}</span>
          {m.official && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"><Trans>marketplace ufficiale</Trans></span>}
          <span className="flex-1 truncate text-xs text-muted-foreground">{m.source}</span>
          <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.marketplaceRemove(m.source); await refresh() }}><Trans>rimuovi</Trans></button>
        </div>
      ))}
      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 rounded-full bg-muted px-3 py-1.5 text-xs outline-none"
          placeholder={t`owner/repo di GitHub oppure URL git https`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={!input.trim()}
          onClick={async () => {
            setError('')
            try {
              await api.marketplaceAdd(input.trim())
              setInput('')
              await refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          <Trans>aggiungi</Trans>
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** Scheda Gateway (restilizzata): un server MCP remoto di aggregazione, preset come dati, chiavi cifrate. */
function GatewayTab() {
  const { t } = useLingui()
  const [presets, setPresets] = useState<Array<{ id: string; name: string; auth: string; headerName?: string; help: string }> | null>(null)
  const [warning, setWarning] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    void api.connectorsGatewayPresets().then((r) => { setPresets(r.presets); setWarning(r.warning) }).catch(() => setPresets([]))
  }, [])
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{warning || t`Un gateway custodisce l'accesso a tutte le app che colleghi lì: è un servizio di terzi`}</p>
      <div className="flex flex-wrap gap-1">
        {(presets ?? []).map((p) => (
          <button
            key={p.id}
            className="rounded-full bg-muted px-2.5 py-1 text-[11px] transition hover:bg-accent"
            onClick={() => { setName(p.name); setUrl(''); setToken('') }}
            title={p.help}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="space-y-2 rounded-2xl bg-muted p-3">
        <div className="grid grid-cols-2 gap-2">
          <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. Composio)`} value={name} onChange={(e) => setName(e.target.value)} />
          <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`URL https del server MCP`} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <input className="w-full rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" type="password" placeholder={t`chiave / token Bearer (salvata cifrata)`} value={token} onChange={(e) => setToken(e.target.value)} />
        {(presets ?? []).find((p) => p.name === name)?.help && (
          <p className="text-[11px] text-muted-foreground">{presets!.find((p) => p.name === name)!.help}</p>
        )}
        <button
          className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={!name.trim() || !url.trim().startsWith('https://') || !token.trim()}
          onClick={async () => {
            setError('')
            const preset = (presets ?? []).find((p) => p.name === name)
            try {
              await api.connectorsAddGateway({
                name: name.trim(), url: url.trim(),
                auth: preset?.auth === 'bearer' ? 'bearer' : 'headers',
                ...(preset ? { preset: preset.id } : {}),
                ...(preset?.headerName ? { headerName: preset.headerName, headers: { [preset.headerName]: token.trim() } } : { headers: { Authorization: `Bearer ${token.trim()}` } })
              })
              setName(''); setUrl(''); setToken('')
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          <Trans>aggiungi gateway</Trans>
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}

/** L'URL del Client ID Metadata Document (CIMD), la riga di oggi restilizzata. */
function ClientMetadataUrlRow() {
  const { t } = useLingui()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    void api.settingsGet<string>('connectors.oauth.clientMetadataUrl', '').then(setUrl).catch(() => setUrl(''))
  }, [])
  if (url === null) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-muted px-3 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>OAuth</Trans></span>
      <span className="text-[11px] text-muted-foreground"><Trans>Se ospiti un documento dei metadati del client (CIMD, es. su GitHub Pages, https e con percorso), incollalo qui; vuoto = registrazione dinamica (DCR).</Trans></span>
      <input
        className="min-w-0 flex-1 rounded-full bg-card px-3 py-1.5 text-xs outline-none"
        placeholder={t`https://utente.github.io/sandbot/client.json`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => void api.connectorsSetClientMetadataUrl(url.trim())}
      />
    </div>
  )
}

// ---- fase app (A2): l'attivazione guidata di Composio ----

/** La card in cima a «Tutte le app» finché Composio non è attivo. */
function ComposioActivationCard({ onOpen }: { onOpen(): void }) {
  return (
    <div className="rounded-2xl bg-muted p-4" data-testid="composio-card">
      <strong className="block font-display text-[15px]"><Trans>Più di mille app con Composio</Trans></strong>
      <p className="mt-1 text-[13px] text-muted-foreground">
        <Trans>Collega Gmail, Slack, HubSpot e molte altre con un account Composio gratuito</Trans>
      </p>
      <button
        className="mt-2.5 rounded-full bg-foreground px-4 py-1.5 text-[13px] font-medium text-background transition hover:opacity-90"
        onClick={onOpen}
      >
        <Trans>Attiva</Trans>
      </button>
    </div>
  )
}

/**
 * Il foglio di attivazione (A2): tre passi con un'azione chiara ciascuno.
 * La chiave resta in memoria nel daemon finché la prova non riesce; poi va
 * nello store cifrato e da lì NON torna più al renderer.
 */
function ComposioActivationSheet({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { t } = useLingui()
  const refreshComposio = useStore((s) => s.refreshComposio)
  const [step, setStep] = useState(1)
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState('')
  const [status, setStatus] = useState<'idle' | 'ok' | 'invalid-key' | 'unreachable' | 'consumer-key' | 'error'>('idle')

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestError('')
    setStatus('idle')
    try {
      await api.composioSetKey(key.trim())
      const r = await api.composioTest()
      if (r.ok) {
        // «Composio attivo» resta visibile: la lista si riempie intanto (gli
        // eventi aggiornano la finestra), il foglio si chiude con Fatto
        setStatus('ok')
        await refreshComposio()
      } else {
        setStatus(r.reason ?? 'error')
        if (r.error && r.reason === undefined) setTestError(r.error)
      }
    } catch (e) {
      setStatus('error')
      setTestError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  const stepBox = 'rounded-2xl bg-muted p-4'
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="composio-activation">
        <strong className="block font-display text-lg"><Trans>Più di mille app con Composio</Trans></strong>

        {/* passo 1: cos'è */}
        <div className={`mt-3 ${stepBox}`}>
          <p className="text-[13px] leading-relaxed text-foreground/80">
            <Trans>Composio è un servizio di terzi: i login e le azioni delle app collegate tramite Composio passano dai suoi server, non restano solo sul tuo Mac.</Trans>
          </p>
          <p className="mt-1 text-[13px] text-foreground/80"><Trans>Ha un piano gratuito.</Trans></p>
          <div className="mt-2 flex items-center gap-2">
            <a
              className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              href="https://composio.dev"
              target="_blank"
              rel="noreferrer"
            >
              <Trans>Apri Composio</Trans>
            </a>
            <button className="rounded-full bg-card px-3.5 py-1.5 text-xs transition hover:bg-card/80" onClick={() => setStep(2)}>
              <Trans>Avanti</Trans>
            </button>
          </div>
        </div>

        {/* passo 2: incolla la chiave */}
        {step >= 2 && (
          <div className={`mt-3 ${stepBox}`}>
            <p className="text-[13px] font-medium"><Trans>Incolla la chiave</Trans></p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              <Trans>Dove la trovo? Copia la chiave API dalle impostazioni del tuo progetto su Composio (composio.dev → Settings → API Keys).</Trans>
            </p>
            <div className="mt-2 flex gap-1">
              <input
                className="min-w-0 flex-1 rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none"
                type="password"
                placeholder={t`chiave API di Composio`}
                value={key}
                onChange={(e) => { setKey(e.target.value); setStatus('idle'); setTestError('') }}
                autoFocus
              />
              <button
                className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                disabled={key.trim().length < 8}
                onClick={() => setStep(3)}
              >
                <Trans>Avanti</Trans>
              </button>
            </div>
          </div>
        )}

        {/* passo 3: prova */}
        {step >= 3 && (
          <div className={`mt-3 ${stepBox}`}>
            <p className="text-[13px] font-medium"><Trans>Prova</Trans></p>
            <p className="mt-1 text-[11px] text-muted-foreground"><Trans>Homun crea il client e chiede a Composio l'elenco delle app: se riesce, la chiave viene salvata cifrata sul tuo Mac.</Trans></p>
            <button
              className="mt-2 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
              disabled={testing || key.trim().length < 8}
              onClick={() => void runTest()}
            >
              {testing ? t`provo…` : <Trans>Prova la chiave</Trans>}
            </button>
            {status === 'ok' && <p className="mt-2 text-[13px] text-chart-2" data-testid="composio-active"><Trans>Composio attivo</Trans></p>}
            {status === 'invalid-key' && <p className="mt-2 text-[13px] text-destructive"><Trans>Chiave non valida: controllala e riprova.</Trans></p>}
            {status === 'unreachable' && <p className="mt-2 text-[13px] text-destructive"><Trans>Composio non raggiungibile: controlla la connessione e riprova.</Trans></p>}
            {status === 'consumer-key' && (
              <p className="mt-2 text-[13px] text-destructive">
                <Trans>Questa è una chiave di Composio «For You» (inizia con ck_). Homun usa la chiave di un progetto Composio: su composio.dev apri il pannello per sviluppatori, crea un progetto e copia la sua chiave API da Settings → API Keys (inizia con ak_).</Trans>
              </p>
            )}
            {status === 'error' && testError && <p className="mt-2 text-[13px] text-destructive">{testError}</p>}
            {status !== 'ok' && status !== 'idle' && (
              <p className="mt-1 text-[11px] text-muted-foreground"><Trans>La chiave non è stata salvata.</Trans></p>
            )}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            {status === 'ok' ? <Trans>Fatto</Trans> : <Trans>Chiudi</Trans>}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A4: il foglio d'attesa del login nel browser (annullabile), con la provenienza (A7). */
function ComposioWaitingSheet({ pending, onDone }: { pending: { slug: string; name: string; since: number }; onDone(): void }) {
  const composio = useStore((s) => s.composio)
  const refreshComposio = useStore((s) => s.refreshComposio)
  // il pending arriva allo store con l'evento {type:'connectors'}: PRIMA di
  // vederlo non si chiude (gara col montaggio), dopo sì — appena sparisce o
  // cambia slug il flusso è finito (login completato, annullato o fallito)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => { void refreshComposio() }, 2000)
    return () => clearInterval(timer)
  }, [refreshComposio])
  useEffect(() => {
    if (!composio) return
    if (composio.pending?.slug === pending.slug) {
      if (!seen) setSeen(true)
      return
    }
    if (composio.pending) { onDone(); return }
    if (seen) onDone()
  }, [composio, pending.slug, seen, onDone])
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4">
      <div className="w-full max-w-md rounded-3xl bg-card p-5 shadow-soft" data-testid="composio-waiting">
        <strong className="block font-display text-lg">{pending.name}</strong>
        <p className="mt-2 text-sm text-muted-foreground"><Trans>In attesa del login nel browser…</Trans></p>
        <p className="mt-2 rounded-2xl bg-muted px-3 py-2 text-[11px] text-muted-foreground">
          <Trans>Tramite Composio: login e azioni passano dai suoi server</Trans>
        </p>
        <div className="mt-4 flex justify-end">
          <button
            className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            onClick={async () => {
              await api.composioDisconnect(pending.slug).catch(() => undefined)
              await refreshComposio()
              onDone()
            }}
          >
            <Trans>Annulla</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}

/** A4: il dettaglio di un'app Composio (collegata o da collegare). */
function ComposioAppSheet({ app, row, onClose, onWaiting }: {
  app: ComposioConnectedApp | null
  row: { slug: string; name: string; tagline: string | null; logo: string | null; connectable: 'yes' | 'no-auth' | 'developer-config' } | null
  onClose(): void
  onWaiting(slug: string, name: string): void
}) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = app?.name ?? row?.name ?? ''
  const logo = row?.logo ?? null
  const tagline = row?.tagline ?? null
  const connectable = row?.connectable ?? 'yes'

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await api.composioConnect(app?.slug ?? row!.slug)
      if (r.started) onWaiting(app?.slug ?? row!.slug, name)
      else if (r.developerConfig) setError(t`Questa app su Composio va configurata dallo sviluppatore: per ora non si può collegare da Homun.`)
      else setError(t`Composio non è attivo: attivalo con la tua chiave per collegare altre app.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="composio-app-sheet">
        <div className="flex items-center gap-3">
          <AppLogo logo={logo} name={name} />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium">{name}</span>
            {tagline && <span className="block truncate text-[13px] text-muted-foreground">{tagline}</span>}
          </span>
        </div>
        <div className="mt-2"><ProvenanceTag via="composio" /></div>
        {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
        {connectable === 'developer-config' && !app && (
          <p className="mt-2 rounded-2xl bg-muted px-3 py-2 text-[13px] text-muted-foreground">
            <Trans>Questa app su Composio va configurata dallo sviluppatore: per ora non si può collegare da Homun.</Trans>
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1" />
          {app ? (
            <>
              {app.status === 'RECONNECT' && (
                <button
                  className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void connect()}
                >
                  <Trans>Ricollega</Trans>
                </button>
              )}
              <button
                className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api.composioDisconnect(app.slug)
                    await refreshComposio()
                    onClose()
                  } finally { setBusy(false) }
                }}
              >
                <Trans>Scollega</Trans>
              </button>
            </>
          ) : (
            connectable !== 'developer-config' && (
              <button
                className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                disabled={busy}
                onClick={() => void connect()}
              >
                {busy ? t`autorizza nel browser…` : <Trans>Collega</Trans>}
              </button>
            )
          )}
        </div>
        {app && (
          <>
            <p className="mt-3 text-[11px] text-muted-foreground">
              {app.status === 'ACTIVE'
                ? t`${app.toolsCount} azioni disponibili ai bot abilitati`
                : t`non più attiva: ricollega per riavere le sue azioni`}
            </p>
            {/* R4 (ritocchi): le azioni del toolkit col nome nella lingua della
                UI (ri-localizzato qui dallo slug: cambia al volo con la
                lingua); lo slug tecnico resta nel title della riga */}
            {app.status === 'ACTIVE' && app.tools.length > 0 && (
              <div className="mt-2 max-h-40 overflow-y-auto scroll-thin rounded-2xl bg-muted p-2.5" data-testid="composio-actions-table">
                {app.tools.map((tool) => {
                  const local = localizedActionName(tool.slug, uiLang()) ?? tool.name
                  return (
                    <p key={tool.slug} className="truncate px-1 py-0.5 text-[12px]" title={`${tool.slug}${local !== tool.name ? ` — ${tool.name}` : ''}`}>
                      {local}
                    </p>
                  )
                })}
              </div>
            )}
            {/* per quali bot (enabledFor per toolkit, predefinito tutti) */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground"><Trans>per bot:</Trans></span>
              {agents.map((a) => (
                <ComposioBotToggle
                  key={a.id}
                  slug={app.slug}
                  agentId={a.id}
                  agentName={a.name}
                  enabledFor={app.enabledFor}
                  allIds={agents.map((x) => x.id)}
                  onDone={() => void refreshComposio()}
                />
              ))}
            </div>
          </>
        )}
        {app && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            <Trans>Scollegare NON cancella l'account su Composio: si gestisce da composio.dev.</Trans>
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            <Trans>Chiudi</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}

/** La casella per bot di un toolkit Composio (enabledFor, predefinito tutti). */
function ComposioBotToggle({ slug, agentId, agentName, enabledFor, allIds, onDone }: {
  slug: string
  agentId: string
  agentName: string
  enabledFor: string[]
  allIds: string[]
  onDone(): void
}) {
  const all = enabledFor.includes('*') || enabledFor.length === 0
  const on = all || enabledFor.includes(agentId)
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <input
        type="checkbox"
        className="h-3 w-3 accent-foreground"
        checked={on}
        onChange={async () => {
          // dal default «tutti» il primo scatto OFF tiene SOLO gli altri bot
          const current = all ? allIds.filter((id) => id !== agentId) : (on ? enabledFor.filter((id) => id !== agentId) : [...enabledFor, agentId])
          await api.connectorsSetEnabledFor('composio', slug, current).catch(() => undefined)
          onDone()
        }}
      />
      {agentName}
    </label>
  )
}

// ---- A1/A9: il foglio «Per sviluppatori» ----

/**
 * Il foglio «Per sviluppatori»: tutto ciò che ESCE dalla vista principale —
 * marketplace dei plugin, gateway (Composio Tool Router, Zapier, Pipedream),
 * riga OAuth/CIMD, server MCP manuali e ricerca nel registro MCP. Lì restano
 * identici a oggi.
 */
function DevelopersSheet({ onClose }: { onClose(): void }) {
  const { t } = useLingui()
  const [query, setQuery] = useState('')
  const [registry, setRegistry] = useState<AppsRegistryResult[] | null>(null)
  const [registryFailed, setRegistryFailed] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setRegistry(null); setRegistryFailed(false); return }
    let alive = true
    const timer = setTimeout(() => {
      setSearching(true)
      void api.connectorsSearchRegistry(q)
        .then((rows) => { if (alive) { setRegistry(rows); setRegistryFailed(false) } })
        .catch(() => { if (alive) { setRegistry(null); setRegistryFailed(true) } })
        .finally(() => { if (alive) setSearching(false) })
    }, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="developers-sheet">
        <strong className="block font-display text-lg"><Trans>Per sviluppatori</Trans></strong>
        <p className="mt-1 text-xs text-muted-foreground"><Trans>Server personalizzati, plugin, gateway e registro: chi sa cos'è un server MCP lo trova qui.</Trans></p>
        <div className="mt-4 space-y-6">
          <ManualServers />
          <GatewayTab />
          <MarketplaceTab />
          <ClientMetadataUrlRow />
          <div className="space-y-2">
            <p className="text-[13px] font-medium"><Trans>Cerca nel registro MCP</Trans></p>
            <input
              className="w-full rounded-full bg-muted px-3.5 py-2 text-sm outline-none"
              placeholder={t`cerca nel registro (2+ lettere)`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {searching && <p className="text-xs text-muted-foreground"><Trans>Cerco nel registro…</Trans></p>}
            {registryFailed && <p className="text-xs text-muted-foreground"><Trans>Non riesco a cercare nel registro</Trans></p>}
            {registry !== null && registry.length === 0 && !searching && <p className="text-xs text-muted-foreground"><Trans>Nessun server trovato.</Trans></p>}
            {(registry ?? []).map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-[14px] bg-muted/60 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{r.description}</span>
                </span>
                <a className="shrink-0 text-xs text-primary hover:underline" href="https://github.com/modelcontextprotocol/registry" target="_blank" rel="noreferrer">
                  <Trans>il registro ›</Trans>
                </a>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            <Trans>Chiudi</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- la vista vera e propria (A1) ----

/**
 * AppsView: la vista condivisa dalla finestra «App» e da Impostazioni › App e
 * skill. `embedded` toglie la testata (nelle Impostazioni c'è già il titolo
 * della sezione).
 */
export function AppsView({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useLingui()
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const composio = useStore((s) => s.composio)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const agents = useStore((s) => s.agents)
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const [filter, setFilter] = useState<AppsFilter>('all')
  const [query, setQuery] = useState('')
  const [installed, setInstalled] = useState<{ servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null>(null)
  // fase app: le righe del catalogo Composio (ricerca LOCALE nel daemon)
  const [composioRows, setComposioRows] = useState<ComposioCatalogRow[] | null>(null)
  const [activationOpen, setActivationOpen] = useState(false)
  const [developersOpen, setDevelopersOpen] = useState(false)
  const [detail, setDetail] = useState<ConnectedRow | null>(null)
  const [composioDetail, setComposioDetail] = useState<{ app: ComposioConnectedApp | null; row: { slug: string; name: string; tagline: string | null; logo: string | null; connectable: 'yes' | 'no-auth' | 'developer-config' } | null } | null>(null)
  const [waitingFor, setWaitingFor] = useState<{ slug: string; name: string } | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)

  const refreshInstalled = async (): Promise<void> => {
    try {
      const r = await api.connectorsInstalled() as unknown as { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] }
      setInstalled({ servers: r.servers, plugins: r.plugins })
    } catch {
      setInstalled({ servers: [], plugins: [] })
    }
  }
  useEffect(() => {
    void refreshConnectors()
    void refreshInstalled()
  }, [refreshConnectors])

  // il catalogo Composio: solo se attivo; la query viaggia al daemon (ricerca
  // locale sulla cache, curate già escluse)
  useEffect(() => {
    if (!composio?.active) { setComposioRows(null); return }
    let alive = true
    const timer = setTimeout(() => {
      void api.composioCatalog(query)
        .then((r) => { if (alive) setComposioRows(r.rows) })
        .catch(() => { if (alive) setComposioRows([]) })
    }, query ? 250 : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [composio?.active, query])

  // A4: il registro MCP non si cerca qui — solo nel foglio sviluppatori

  const [skillsByOwner, setSkillsByOwner] = useState<Array<{ ownerId: string; ownerName: string; skills: string[] }>>([])
  useEffect(() => {
    let alive = true
    void Promise.all(agents.map(async (a) => {
      const skills = await api.listSkills(a.id).catch(() => [])
      return { ownerId: a.id, ownerName: a.name, skills: skills.map((s) => s.name) }
    })).then((rows) => { if (alive) setSkillsByOwner(rows) })
    return () => { alive = false }
  }, [agents])

  const model = useMemo(
    () => appsViewModel({
      catalog: connectors,
      connectors,
      installed,
      agents,
      skillsByOwner,
      filter,
      query,
      lang: uiLang(),
      composio,
      composioRows: composioRows ?? []
    }),
    [connectors, installed, agents, skillsByOwner, filter, query, composio, composioRows]
  )

  const botsHalfLine = (label: ConnectedRow['botsLabel']): string => {
    if (label.all) return t`Tutti i bot`
    const names = label.names.join(', ')
    return label.extra > 0 ? `${names} +${label.extra}` : names
  }

  // la ricerca senza risultati (A1): Composio spento → la riga che lo attiva;
  // acceso → «Nessuna app trovata»
  const nothingFound =
    query.trim().length > 0 &&
    model.connected.length === 0 &&
    model.catalogRows.length === 0 &&
    model.composioApps.length === 0 &&
    model.featured.length === 0 &&
    composioRows !== null // il catalogo Composio è stato interrogato (o è vuoto)

  return (
    <div className={embedded ? 'space-y-5 pr-12' : 'space-y-5'}>
      {/* testata (solo finestra): pila delle icone + N collegate + ✕ */}
      {!embedded && (
        <div className="flex items-center gap-3">
          <h2 className="flex-1 font-display text-2xl">{i18n._(msg`App`)}</h2>
          <button
            className="flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
            onClick={() => setFilter('connected')}
          >
            <span className="flex">
              {model.connected.slice(0, 3).map((c, i) => (
                <AppLogo key={c.key} logo={c.logo} name={c.name} className={`size-6 text-[11px] ${i > 0 ? '-ml-1.5' : ''}`} />
              ))}
            </span>
            <Trans>{model.connectedCount} collegate ›</Trans>
          </button>
          <button
            className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
            aria-label={t`Chiudi`}
            onClick={() => setAppsOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* 1. la ricerca */}
      <label className="flex h-11 items-center gap-2.5 rounded-full bg-muted px-4 text-sm text-muted-foreground">
        <Search className="size-4 shrink-0" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
          placeholder={t`Cerca tra app e skill`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {/* 2. «Collegate» (con stato e «da ricollegare») */}
      <section>
        <strong className="text-[15px] font-medium"><Trans>Collegate</Trans></strong>
        {model.connected.length === 0 && !query && (
          <p className="py-2 text-sm text-muted-foreground"><Trans>Nessuna app collegata: comincia dalle consigliate.</Trans></p>
        )}
        <div className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {model.connected.map((row) => (
            <button
              key={row.key}
              className="flex items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
              onClick={() => (row.source === 'composio' ? openComposioDetail(row) : setDetail(row))}
            >
              <AppLogo logo={row.logo} name={row.name} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">{row.name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{botsHalfLine(row.botsLabel)}</span>
                <ProvenanceTag via={row.via} />
              </span>
              {row.status === 'reconnect' ? (
                <span className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs text-background"><Trans>Ricollega</Trans></span>
              ) : (
                <span className="shrink-0 text-sm text-chart-2"><Trans>Collegata</Trans></span>
              )}
            </button>
          ))}
          {/* 4. la riga delle skill dei bot */}
          <button
            className="flex items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
            onClick={() => setSkillsOpen(true)}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">✦</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px]"><Trans>Skill dei bot</Trans></span>
              <span className="block truncate text-[13px] text-muted-foreground">
                <Trans>{model.skills.reduce((a, s) => a + s.skills.length, 0) + (installed?.plugins.reduce((a, p) => a + p.skills.length, 0) ?? 0)} skill · se ne vuoi una nuova, chiedila a un bot</Trans>
              </span>
            </span>
            <span className="shrink-0 text-sm text-muted-foreground"><Trans>Gestisci ›</Trans></span>
          </button>
        </div>
      </section>

      {/* 3. «Tutte le app»: la card di attivazione, le consigliate, le curate e le Composio */}
      <section className="space-y-1">
        <strong className="text-[15px] font-medium"><Trans>Tutte le app</Trans></strong>
        {/* A2: la card in cima finché Composio non è attivo */}
        {!composio?.active && !activationOpen && (
          <div className="mt-2">
            <ComposioActivationCard onOpen={() => setActivationOpen(true)} />
          </div>
        )}
        {/* le consigliate (solo senza ricerca) */}
        {!query && model.featured.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-[13px] text-muted-foreground"><Trans>Consigliate per te</Trans></p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-x-8">
              {model.featured.map((f) => (
                <div key={f.id} className="flex items-center gap-3 rounded-[14px] px-1 py-1.5">
                  <AppLogo logo={null} name={f.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px]">{f.name}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">{f.tagline}</span>
                    <ProvenanceTag via="direct" />
                  </span>
                  <ConnectButton id={f.id} />
                </div>
              ))}
            </div>
          </div>
        )}
        {/* le curate (dirette) */}
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-x-8">
          {model.catalogRows.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-[14px] px-1 py-1.5">
              <AppLogo logo={null} name={c.name} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">{c.name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{taglineOf(c.tagline, uiLang())}</span>
                <ProvenanceTag via="direct" />
              </span>
              <ConnectButton id={c.id} />
            </div>
          ))}
          {/* le app Composio (dopo le curate, ordine del daemon) */}
          {model.composioApps.map((a) => (
            <div key={`composio:${a.slug}`} className="flex items-center gap-3 rounded-[14px] px-1 py-1.5" data-testid={`composio-row-${a.slug}`}>
              <AppLogo logo={a.logo} name={a.name} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">{a.name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{a.tagline ?? ''}</span>
                <ProvenanceTag via="composio" />
              </span>
              <button
                className="h-8 shrink-0 rounded-full bg-muted px-4 text-[13px] transition hover:bg-accent disabled:opacity-50"
                disabled={a.connectable === 'developer-config'}
                title={a.connectable === 'developer-config' ? t`Questa app su Composio va configurata dallo sviluppatore: per ora non si può collegare da Homun.` : undefined}
                onClick={() => setComposioDetail({ app: null, row: a })}
              >
                <Trans>Collega</Trans>
              </button>
            </div>
          ))}
        </div>
        {/* la ricerca senza risultati (A1) */}
        {nothingFound && (
          composio?.active ? (
            <p className="py-2 text-sm text-muted-foreground"><Trans>Nessuna app trovata</Trans></p>
          ) : (
            <div className="flex items-center justify-between gap-2 py-2 text-sm text-muted-foreground">
              <Trans>Non c'è?</Trans>
              <button
                className="rounded-full bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background transition hover:opacity-90"
                onClick={() => setActivationOpen(true)}
              >
                <Trans>Attiva più app con Composio</Trans>
              </button>
            </div>
          )
        )}
      </section>

      {/* A1/A9: il link piccolo in fondo al foglio «Per sviluppatori» */}
      <button
        className="text-[12px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
        onClick={() => setDevelopersOpen(true)}
        data-testid="developers-link"
      >
        <Trans>Per sviluppatori: server personalizzati, plugin, registro</Trans>
      </button>

      {activationOpen && (
        <ComposioActivationSheet
          onClose={() => setActivationOpen(false)}
          onDone={() => { setActivationOpen(false); void refreshComposio() }}
        />
      )}
      {developersOpen && <DevelopersSheet onClose={() => setDevelopersOpen(false)} />}
      {waitingFor && (
        <ComposioWaitingSheet
          pending={{ slug: waitingFor.slug, name: waitingFor.name, since: Date.now() }}
          onDone={() => { setWaitingFor(null); void refreshComposio() }}
        />
      )}
      {composioDetail && (
        <ComposioAppSheet
          app={composioDetail.app}
          row={composioDetail.row}
          onClose={() => setComposioDetail(null)}
          onWaiting={(slug, name) => { setComposioDetail(null); setWaitingFor({ slug, name }) }}
        />
      )}
      {skillsOpen && <SkillsSheet onClose={() => setSkillsOpen(false)} />}
      {detail && (
        <ConnectedDetailSheet
          row={detail}
          installed={installed}
          connectors={connectors}
          onClose={() => setDetail(null)}
          onChanged={() => {
            void refreshConnectors()
            void refreshInstalled()
          }}
          onWaiting={(slug, name) => { setDetail(null); setWaitingFor({ slug, name }) }}
        />
      )}
    </div>
  )

  /** A4: il dettaglio di un'app Composio collegata, dalla riga di «Collegate». */
  function openComposioDetail(row: ConnectedRow): void {
    const app = composio?.connected.find((a) => a.slug === row.composioSlug) ?? null
    setComposioDetail({ app, row: { slug: row.composioSlug ?? row.id, name: row.name, tagline: null, logo: row.logo.startsWith('data:') ? row.logo : null, connectable: 'yes' } })
  }
}

/** Il bottone Collega di una voce del catalogo (il flusso OAuth di oggi). */
function ConnectButton({ id }: { id: string }) {
  const { t } = useLingui()
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="h-8 shrink-0 rounded-full bg-muted px-4 text-[13px] transition hover:bg-accent disabled:opacity-50"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try { await api.connectorsConnect(id) } finally { setBusy(false) }
      }}
    >
      {busy ? t`autorizza nel browser…` : <Trans>Collega</Trans>}
    </button>
  )
}

/** Il foglio del dettaglio di una voce collegata (ciò che facevano ConnectorTile e InstalledTab). */
function ConnectedDetailSheet({ row, installed, connectors, onClose, onChanged, onWaiting }: {
  row: ConnectedRow
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  connectors: ConnectorInfo[]
  onClose(): void
  onChanged(): void
  /** fase app: il dettaglio di una curata può aprire il collegamento Composio */
  onWaiting(slug: string, name: string): void
}) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [confirm, setConfirm] = useState(false)
  const [composioVia, setComposioVia] = useState<{ slug: string; name: string } | null>(null)
  const connector = connectors.find((c) => c.id === row.id)
  const server = row.source === 'server' ? installed?.servers.find((s) => s.id === row.id) : undefined
  const plugin = row.source === 'plugin' ? installed?.plugins.find((p) => p.name === row.id) : undefined
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        {connector && <ConnectorDetail c={connector} onDone={onChanged} onComposio={(slug, name) => setComposioVia({ slug, name })} />}
        {server && <ServerDetail sv={server as never} onDone={onChanged} />}
        {plugin && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{plugin.name}</span>
              <span className="text-xs text-muted-foreground">{plugin.marketplace} · {plugin.sha12}</span>
              <div className="flex-1" />
              {confirm ? (
                <button className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10" onClick={async () => { await api.pluginsUninstall(plugin.name, plugin.marketplace); onChanged(); onClose() }}>
                  <Trans>Disinstalla davvero</Trans>
                </button>
              ) : (
                <button className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10" onClick={() => setConfirm(true)}>
                  <Trans>Disinstalla</Trans>
                </button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground"><Trans>{plugin.skills.length} skill · {plugin.servers.length} server</Trans></p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground"><Trans>per bot:</Trans></span>
              {agents.map((a) => {
                const cur = plugin.enabledFor ?? []
                const on = cur.includes('*') || cur.includes(a.id)
                return (
                  <label key={a.id} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-foreground"
                      checked={on}
                      onChange={() => {
                        const next = cur.includes('*') ? [] : [...cur]
                        const i = next.indexOf(a.id)
                        if (i >= 0) next.splice(i, 1)
                        else next.push(a.id)
                        void api.connectorsSetEnabledFor('plugin', plugin.name, next).then(onChanged)
                      }}
                    />
                    {a.name}
                  </label>
                )
              })}
            </div>
          </div>
        )}
        {!connector && !server && !plugin && <p className="text-sm text-muted-foreground">{t`voce non trovata`}</p>}
        <div className="mt-4 flex justify-end">
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            <Trans>Chiudi</Trans>
          </button>
        </div>
        {composioVia && (
          <ComposioAppSheet
            app={null}
            row={{ slug: composioVia.slug, name: composioVia.name, tagline: null, logo: null, connectable: 'yes' }}
            onClose={() => setComposioVia(null)}
            onWaiting={(slug, name) => { setComposioVia(null); onWaiting(slug, name) }}
          />
        )}
      </div>
    </div>
  )
}

/** Il foglio delle skill di TUTTI i bot, raggruppate per bot (con eliminazione). */
function SkillsSheet({ onClose }: { onClose(): void }) {
  const agents = useStore((s) => s.agents)
  const [rows, setRows] = useState<Array<{ agentId: string; skills: Array<{ name: string; description: string }> }> | null>(null)
  const load = async (): Promise<void> => {
    const out = []
    for (const a of agents) {
      const skills = await api.listSkills(a.id).catch(() => [])
      out.push({ agentId: a.id, skills })
    }
    setRows(out)
  }
  useEffect(() => { void load() }, [agents])
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <strong className="block font-display text-lg"><Trans>Skill dei bot</Trans></strong>
        <p className="mt-1 text-xs text-muted-foreground"><Trans>Se ne vuoi una nuova, chiedila a un bot in chat.</Trans></p>
        {rows === null ? (
          <p className="mt-3 text-sm text-muted-foreground"><Trans>caricamento…</Trans></p>
        ) : rows.every((r) => r.skills.length === 0) ? (
          <p className="mt-3 text-sm text-muted-foreground"><Trans>Nessuna skill: i bot le creano in chat con update_skill.</Trans></p>
        ) : (
          <div className="mt-3 space-y-3">
            {rows.map((r) => {
              const agent = agents.find((a) => a.id === r.agentId)
              if (r.skills.length === 0) return null
              return (
                <div key={r.agentId}>
                  <p className="text-[13px] text-muted-foreground">{agent?.name ?? r.agentId}</p>
                  {r.skills.map((s) => (
                    <div key={s.name} className="flex items-center gap-2 rounded-[12px] bg-muted px-3 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{s.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{s.description}</span>
                      </span>
                      <button
                        className="shrink-0 text-xs text-muted-foreground transition hover:text-destructive"
                        onClick={async () => { await api.deleteSkill(r.agentId, s.name); void load() }}
                      >
                        <Trans>elimina</Trans>
                      </button>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            <Trans>Chiudi</Trans>
          </button>
        </div>
      </div>
    </div>
  )
}

/** La finestra «App» (dal bottone App della barra e dalle card in chat). */
export function AppsWindow() {
  const { i18n } = useLingui()
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  return (
    <Dialog open onOpenChange={(o) => !o && setAppsOpen(false)}>
      <DialogContent className="flex max-h-[88vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl" showCloseButton={false}>
        <DialogTitle className="sr-only">{i18n._(msg`App`)}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-8">
          <AppsView />
        </div>
      </DialogContent>
    </Dialog>
  )
}
