// Fase 16c (C4): «Collega app e skill» (tavola 6). UNA finestra che si apre
// dal bottone App della barra, da Impostazioni › App e skill (la STESSA
// vista, AppsView) e dalle card dei connettori in chat. Cerca nel catalogo,
// nelle collegate e nelle skill; con 2+ caratteri e nessun risultato cerca
// anche nel registro MCP (RPC di sola lettura). Filtri a pillola per
// categoria, «Consigliate per te» (ordine fisso, max 4), «Collegate» su due
// colonne con i nomi dei bot, la riga delle skill e le opzioni avanzate
// (Marketplace, Gateway, URL CIMD) chiuse in fondo. Niente bordi: fondi tenui.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Search, X, LayoutGrid } from 'lucide-react'
import { api, useStore } from '../store'
import { pickLang } from '../../../shared/localized'
import { i18n } from '../lib/i18n'
import type { ConnectorInfo, McpServerInfo, McpServerSecret, AppsRegistryResult, SecretKind } from '../../../shared/types'
import { SECRET_KIND_FOR_NEEDS } from '../../../shared/types'
import { appsViewModel, taglineOf, type AppsFilter, type InstalledServerLike, type InstalledPluginLike, type ConnectedRow } from '../lib/apps-view'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

/** La lingua attiva come UiLanguage. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

const FILTER_LABELS: Record<AppsFilter, MessageDescriptor> = {
  all: msg`Tutte`,
  connected: msg`Collegate`,
  'mail-calendar': msg`Posta e calendario`,
  documents: msg`Documenti`,
  development: msg`Sviluppo`,
  communication: msg`Comunicazione`,
  skills: msg`Skill`
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

/** Il dettaglio di un connettore del catalogo: tool on/off, istruzioni, Scollega (ciò che faceva ConnectorTile). */
function ConnectorDetail({ c, onDone }: { c: ConnectorInfo; onDone(): void }) {
  const { t, i18n } = useLingui()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [instructions, setInstructions] = useState(c.state.instructions)

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
      {c.state.error && <p className="text-[11px] text-destructive/80">{c.state.error}</p>}
      {c.state.status !== 'connected' && c.notes && (
        <p className="line-clamp-3 text-[11px] text-muted-foreground">{pickLang(c.notes, uiLang())}</p>
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

// ---- la vista vera e propria (tavola 6) ----

/**
 * AppsView: la vista condivisa dalla finestra «Collega app» e da Impostazioni
 * › App e skill. `embedded` toglie la testata (nelle Impostazioni c'è già il
 * titolo della sezione).
 */
export function AppsView({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useLingui()
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const agents = useStore((s) => s.agents)
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const [filter, setFilter] = useState<AppsFilter>('all')
  const [query, setQuery] = useState('')
  const [installed, setInstalled] = useState<{ servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null>(null)
  const [registry, setRegistry] = useState<AppsRegistryResult[] | null>(null)
  // fase 16c correzioni (R1): la ricerca nel registro fallita non è «nessun
  // risultato» — riga d'errore con Riprova, mai il silenzio
  const [registryFailed, setRegistryFailed] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [detail, setDetail] = useState<ConnectedRow | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)

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

  // la ricerca nel registro parte con 2+ caratteri e NESSUN risultato nel catalogo
  const runRegistrySearch = (q: string, alive: () => boolean): void => {
    void api.connectorsSearchRegistry(q)
      .then((rows) => { if (alive()) { setRegistry(rows); setRegistryFailed(false) } })
      .catch(() => { if (alive()) { setRegistry(null); setRegistryFailed(true) } })
  }
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || catalogMatch(connectors, q)) { setRegistry(null); setRegistryFailed(false); return }
    let alive = true
    const timer = setTimeout(() => runRegistrySearch(q, () => alive), 350)
    return () => { alive = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, connectors])

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
      lang: uiLang()
    }),
    [connectors, installed, agents, skillsByOwner, filter, query]
  )

  const filters: AppsFilter[] = ['all', 'mail-calendar', 'documents', 'development', ...(model.hasCommunication ? (['communication'] as AppsFilter[]) : []), 'skills']
  const totalSkills = model.skills.reduce((a, s) => a + s.skills.length, 0) + (installed?.plugins.reduce((a, p) => a + p.skills.length, 0) ?? 0)
  const pill = (id: AppsFilter): ReactNode => (
    <button
      key={id}
      className={`h-8 rounded-full px-3.5 text-[13px] transition ${filter === id ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-accent'}`}
      onClick={() => setFilter(id)}
    >
      {i18n.t(FILTER_LABELS[id])}
    </button>
  )

  const botsHalfLine = (label: ConnectedRow['botsLabel']): string => {
    if (label.all) return t`Tutti i bot`
    const names = label.names.join(', ')
    return label.extra > 0 ? `${names} +${label.extra}` : names
  }

  return (
    <div className={embedded ? 'space-y-5 pr-12' : 'space-y-5'}>
      {/* testata (solo finestra): pila delle icone + N collegate + ✕ */}
      {!embedded && (
        <div className="flex items-center gap-3">
          <h2 className="flex-1 font-display text-2xl">{i18n._(msg`Collega app`)}</h2>
          <button
            className="flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
            onClick={() => setFilter('connected')}
          >
            <span className="flex">
              {model.connected.slice(0, 3).map((c, i) => (
                <span key={c.key} className={`grid size-6 place-items-center rounded-lg bg-muted text-[11px] font-bold ${i > 0 ? '-ml-1.5' : ''}`}>{c.name.slice(0, 1)}</span>
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

      {/* cerca + server personalizzato */}
      <div className="flex flex-wrap gap-3">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-muted px-4 text-sm text-muted-foreground">
          <Search className="size-4 shrink-0" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            placeholder={t`Cerca tra app e skill`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button className="h-11 rounded-full bg-muted px-4 text-sm transition hover:bg-accent" onClick={() => setManualOpen(true)}>
          <Trans>Server MCP personalizzato</Trans>
        </button>
      </div>

      {/* filtri a pillola */}
      <div className="flex flex-wrap gap-1.5">
        {filters.map(pill)}
      </div>

      {/* Consigliate per te — R8.1: SOLO con la pillola Tutte e nessuna
          ricerca; con una categoria o una ricerca si vede tutto lì sotto,
          senza doppioni */}
      {filter === 'all' && !query && model.featured.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between">
            <strong className="text-[15px] font-medium"><Trans>Consigliate per te</Trans></strong>
            <button className="text-xs text-muted-foreground transition hover:text-foreground" onClick={() => setFilter('all')}><Trans>Vedi tutte</Trans></button>
          </div>
          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-x-8">
            {model.featured.map((f) => (
              <div key={f.id} className="flex items-center gap-3 rounded-[14px] px-1 py-1.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">{f.logo}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{f.name}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{f.tagline}</span>
                </span>
                <ConnectButton id={f.id} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* il catalogo (filtro Tutte o categoria) */}
      {(filter === 'all' || ['mail-calendar', 'documents', 'development', 'communication'].includes(filter)) && (
        <section className="space-y-1">
          {/* R8.1: la lista sotto le consigliate esclude quelle voci → «Altre app» */}
          {filter === 'all' && !query && model.featured.length > 0 && <strong className="text-[15px] font-medium"><Trans>Altre app</Trans></strong>}
          {model.catalogRows.length === 0 && query && registry === null && !registryFailed && (
            <p className="py-2 text-sm text-muted-foreground"><Trans>Cerco nel registro…</Trans></p>
          )}
          {model.catalogRows.length === 0 && query && registryFailed && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Trans>Non riesco a cercare nel registro</Trans>
              <button className="text-primary hover:underline" onClick={() => runRegistrySearch(query.trim(), () => true)}><Trans>Riprova</Trans></button>
            </div>
          )}
          {model.catalogRows.length === 0 && !query && (
            <p className="py-2 text-sm text-muted-foreground"><Trans>Nessuna app in questa categoria.</Trans></p>
          )}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 sm:gap-x-8">
            {model.catalogRows.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-[14px] px-1 py-1.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">{c.logo}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{c.name}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{taglineOf(c.tagline, uiLang())}</span>
                </span>
                <ConnectButton id={c.id} />
              </div>
            ))}
          </div>
          {/* i risultati «dal registro» (ricerche a vuoto nel catalogo) */}
          {registry !== null && registry.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-[13px] text-muted-foreground"><Trans>Dal registro MCP (server di terzi, non verificati da noi):</Trans></p>
              {registry.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-[14px] bg-muted/60 px-3 py-2">
                  <LayoutGrid className="size-4 shrink-0 text-muted-foreground" />
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
          )}
        </section>
      )}

      {/* Collegate: due colonne (tavola 6) */}
      {(filter === 'connected' || filter === 'all' || query) && (
        <section>
          <strong className="text-[15px] font-medium"><Trans>Collegate</Trans></strong>
          {model.connected.length === 0 && (
            <p className="py-2 text-sm text-muted-foreground"><Trans>Nessuna app collegata: comincia dalle consigliate.</Trans></p>
          )}
          <div className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            {model.connected.map((row) => (
              <button
                key={row.key}
                className="flex items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
                onClick={() => setDetail(row)}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">{row.logo}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{row.name}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{botsHalfLine(row.botsLabel)}</span>
                </span>
                {row.status === 'reconnect' ? (
                  <span className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs text-background"><Trans>Ricollega</Trans></span>
                ) : (
                  <span className="shrink-0 text-sm text-chart-2"><Trans>Collegata</Trans></span>
                )}
              </button>
            ))}
            {/* la riga delle skill dei bot */}
            <button
              className="flex items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
              onClick={() => setSkillsOpen(true)}
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">✦</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]"><Trans>Skill dei bot</Trans></span>
                <span className="block truncate text-[13px] text-muted-foreground">
                  <Trans>{totalSkills} skill · se ne vuoi una nuova, chiedila a un bot</Trans>
                </span>
              </span>
              <span className="shrink-0 text-sm text-muted-foreground"><Trans>Gestisci ›</Trans></span>
            </button>
          </div>
        </section>
      )}

      {/* Opzioni avanzate, chiuse in fondo */}
      <details className="pt-1" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-[13px] text-muted-foreground transition hover:text-foreground"><Trans>Opzioni avanzate ▸</Trans></summary>
        <div className="mt-3 space-y-5">
          <MarketplaceTab />
          <GatewayTab />
          <ClientMetadataUrlRow />
        </div>
      </details>

      {manualOpen && <ManualServersSheet onClose={() => setManualOpen(false)} />}
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
        />
      )}
    </div>
  )
}

/** Il catalogo ha almeno una voce che risponde alla query? (la ricerca nel registro parte solo a vuoto) */
function catalogMatch(connectors: ConnectorInfo[], query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return connectors.some((c) => `${c.name} ${c.id}`.toLowerCase().includes(q.split(/\s+/)[0] ?? q))
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
function ConnectedDetailSheet({ row, installed, connectors, onClose, onChanged }: {
  row: ConnectedRow
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  connectors: ConnectorInfo[]
  onClose(): void
  onChanged(): void
}) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [confirm, setConfirm] = useState(false)
  const connector = connectors.find((c) => c.id === row.id)
  const server = row.source === 'server' ? installed?.servers.find((s) => s.id === row.id) : undefined
  const plugin = row.source === 'plugin' ? installed?.plugins.find((p) => p.name === row.id) : undefined
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        {connector && <ConnectorDetail c={connector} onDone={onChanged} />}
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

/** La finestra «Collega app» (dal bottone App della barra e dalle card in chat). */
export function AppsWindow() {
  const { i18n } = useLingui()
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  return (
    <Dialog open onOpenChange={(o) => !o && setAppsOpen(false)}>
      <DialogContent className="flex max-h-[88vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl" showCloseButton={false}>
        <DialogTitle className="sr-only">{i18n._(msg`Collega app`)}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-8">
          <AppsView />
        </div>
      </DialogContent>
    </Dialog>
  )
}
