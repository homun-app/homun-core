// Fase catalogo app (P3–P7): la finestra «App» — UN elenco unico, senza la
// riga «Composio», senza il campo slug e senza la card «Più di mille app».
// Il catalogo è CURATO nel repo (shared/app-catalog): l'app non chiama nessuna
// API per sfogliarlo. In alto la testata con i loghi delle prime 4 app connesse
// e «N connesse ›»; poi ricerca, pillole (Tutte · Connesse · categorie), la
// sezione «Connesse», «Consigliate per te» e una sezione per categoria con
// «Visualizza tutto». Ogni riga: logo, nome, tagline e Connetti in UN passo
// (apps:connect decide la strada). La provenienza sta nel foglio del dettaglio,
// non sulle righe. Composio è un ACCOUNT, non un'app: in fondo una riga
// discreta «Account Composio · connesso». Il mercato dei plugin, i gateway, i
// server manuali e la chiave di progetto stanno nel foglio «Per sviluppatori».
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Search, X } from 'lucide-react'
import { api, useStore } from '../store'
import { i18n } from '../lib/i18n'
import { loadAppCatalog, appCategoryLabel, appTaglineOf, type AppCatalogRow, type AppCategoryId } from '../../../shared/app-catalog'
import type { McpServerInfo, McpServerSecret, AppsRegistryResult } from '../../../shared/types'
import { appsViewModel, appsCatalogModel, botsToggleState, type AppsFilter, type InstalledServerLike, type InstalledPluginLike, type ConnectedRow, type CatalogRowView } from '../lib/apps-view'
import { mcpToolPresentation } from '../../../shared/tool-names'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'
import { Toggle } from './Settings'
import { catalogLogoUrl } from '../lib/app-logos'
import { ServerSheet } from './ServerSheet'
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

/** A7: l'etichetta piccola sulla provenienza dei dati (sta nel dettaglio, non sulle righe). */
export function ProvenanceTag({ via }: { via: 'direct' | 'composio' }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${via === 'composio' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
      {via === 'composio'
        ? <Trans>Tramite Composio: login e azioni passano dai suoi server</Trans>
        : <Trans>Diretta: il permesso resta sul tuo Mac</Trans>}
    </span>
  )
}

/** Il logo di una riga: il file del catalogo, un data: URL, un'emoji o l'iniziale su un fondo tenue. */
function AppLogo({ logo, name, className = 'size-10 text-base' }: { logo: string | null; name: string; className?: string }) {
  const url = catalogLogoUrl(logo)
  if (url || logo?.startsWith('data:')) {
    // nel tema scuro una piastrella chiara dietro il logo: i marchi neri su
    // fondo trasparente (Apaleo, FreshBooks…) altrimenti spariscono; i loghi
    // pieni la coprono del tutto e restano identici
    return <img src={url ?? logo!} alt="" className={`shrink-0 rounded-[11px] object-cover dark:bg-white ${className}`} />
  }
  const emoji = logo && logo.length <= 4 ? logo : null
  return (
    <span className={`grid ${className} shrink-0 place-items-center rounded-[11px] bg-muted font-bold ${emoji ? '' : 'text-foreground/70'}`}>
      {emoji ?? name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Il dettaglio di un server MCP installato: il foglio M6 (ServerSheet). */
function ServerDetail({ sv, onDone }: { sv: InstalledServerLike & Record<string, unknown>; onDone(): void }): ReactNode {
  return <ServerSheet sv={sv as never} onDone={onDone} />
}

/** Server MCP aggiunti a mano: il form di oggi, dentro un foglio. */
export function ManualServersSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
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
              <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Argomenti separati per spazio`} value={(edit.args ?? []).join(' ')} onChange={(e) => setEdit({ ...edit, args: e.target.value ? e.target.value.split(/\s+/) : [] })} />
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

// ---- fase app (A2): l'attivazione guidata di Composio (solo «Per sviluppatori») ----

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
  const [status, setStatus] = useState<'idle' | 'ok' | 'invalid-key' | 'unreachable' | 'consumer-key' | 'gateway-active' | 'error'>('idle')

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
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
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
            {status === 'gateway-active' && (
              <div className="mt-2 rounded-2xl bg-card px-3 py-2 text-[13px]">
                <p><Trans>Composio è già collegato con il login. Le due strade non possono stare insieme: disattivo il login e uso la chiave di progetto?</Trans></p>
                <button
                  className="mt-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
                  onClick={async () => {
                    await api.connectorsDisconnect('composio').catch(() => undefined)
                    await runTest()
                  }}
                >
                  <Trans>Disattiva il login e riprova</Trans>
                </button>
              </div>
            )}
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
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      {/* U2: @container, come il dettaglio app */}
      <div className="@container max-h-[85vh] w-full max-w-2xl overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="developers-sheet">
        <strong className="block font-display text-lg"><Trans>Per sviluppatori</Trans></strong>
        <p className="mt-1 text-xs text-muted-foreground"><Trans>Server personalizzati, plugin, gateway e registro: chi sa cos'è un server MCP lo trova qui.</Trans></p>
        <div className="mt-4 space-y-6">
          {/* fase Composio OAuth (C6): la strada della CHIAVE resta, ma solo
              qui — per la maggior parte delle persone c'è il «Connetti» delle
              app dell'elenco; le due strade non insieme */}
          <ComposioKeySection />
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

/** C6: la strada della chiave di progetto, solo nel foglio sviluppatori. */
function ComposioKeySection() {
  const { t } = useLingui()
  const composio = useStore((s) => s.composio)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const [open, setOpen] = useState(false)
  if (composio?.active) {
    return (
      <div className="space-y-1">
        <p className="text-[13px] font-medium"><Trans>Chiave di progetto Composio (sviluppatori)</Trans></p>
        <p className="text-xs text-muted-foreground"><Trans>Attiva con la chiave ak_ del tuo progetto.</Trans></p>
        <button
          className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
          onClick={async () => {
            await api.composioDisable().catch(() => undefined)
            await refreshComposio()
          }}
        >
          <Trans>Disattiva la chiave</Trans>
        </button>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <p className="text-[13px] font-medium"><Trans>Chiave di progetto Composio (sviluppatori)</Trans></p>
      <p className="text-xs text-muted-foreground">
        <Trans>Per la maggior parte delle persone è meglio «Accedi con Composio» nella vista principale: un clic nel browser, niente chiavi. La chiave ak_ di un progetto la usano gli sviluppatori.</Trans>
      </p>
      <button
        className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
        onClick={() => setOpen(true)}
      >
        {t`Usa la chiave di progetto`}
      </button>
      {open && (
        <ComposioActivationSheet
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); void refreshComposio() }}
        />
      )}
    </div>
  )
}

// ---- fase catalogo app (P3): le pillole e la riga di un'app ----

/** Una pillola dei filtri (Tutte · Connesse · categorie · Altro ▾). */
function FilterPill({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      className={`rounded-full px-3 py-1 text-[12px] transition ${active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Le fasi visibili della riga durante «Connetti» in un passo (P4). */
export type AppFlowKind = 'direct' | 'login' | 'app' | 'failed' | 'conflict'

/**
 * La riga di un'app dell'elenco unico: logo, nome, tagline (o lo stato del
 * flusso) e a destra Connetti / Connessa / Ricollega / l'attesa con Annulla.
 * NIENTE etichetta di provenienza: quella sta nel foglio del dettaglio. Il
 * clic sulla riga apre il dettaglio; il clic sul bottone collega.
 */
function AppRow({ row, flow, onConnect, onCancel, onConflictResolve, onOpen }: {
  row: CatalogRowView
  flow: AppFlowKind | null
  onConnect(row: CatalogRowView): void
  onCancel(row: CatalogRowView): void
  onConflictResolve(row: CatalogRowView): void
  onOpen(row: CatalogRowView): void
}) {
  const { t } = useLingui()
  const stop = (e: { stopPropagation(): void }): void => e.stopPropagation()
  const statusLine =
    flow === 'login' ? t`Accedi a Composio nel browser…`
    : flow === 'app' ? t`Completa il login di ${row.app.name} nel browser…`
    : row.tagline
  return (
    <div
      className={`flex cursor-pointer items-center gap-3 rounded-[14px] px-1 py-1.5 text-left transition hover:bg-muted/60 ${flow === 'conflict' ? 'flex-wrap' : ''}`}
      data-testid={`app-row-${row.app.id}`}
      onClick={() => onOpen(row)}
    >
      <AppLogo logo={row.app.logo} name={row.app.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{row.app.name}</span>
        {statusLine !== null && (
          <span className={`block truncate text-[13px] ${flow === 'login' || flow === 'app' ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
            {statusLine}
          </span>
        )}
      </span>
      {flow === null && row.connected === 'connected' && (
        <span className="shrink-0 text-sm text-chart-2"><Trans>Connessa</Trans></span>
      )}
      {flow === null && row.connected === 'reconnect' && (
        <button
          className="h-8 shrink-0 rounded-full bg-muted px-4 text-[13px] transition hover:bg-accent"
          data-testid={`app-connect-${row.app.id}`}
          onClick={(e) => { stop(e); onConnect(row) }}
        >
          <Trans>Ricollega</Trans>
        </button>
      )}
      {flow === null && row.connected === null && (
        <button
          className="h-8 shrink-0 rounded-full bg-muted px-4 text-[13px] transition hover:bg-accent"
          data-testid={`app-connect-${row.app.id}`}
          onClick={(e) => { stop(e); onConnect(row) }}
        >
          <Trans>Connetti</Trans>
        </button>
      )}
      {flow === 'direct' && <span className="shrink-0 text-[13px] text-muted-foreground">{t`autorizza nel browser…`}</span>}
      {(flow === 'login' || flow === 'app') && (
        <button
          className="shrink-0 text-[13px] text-muted-foreground transition hover:text-foreground"
          data-testid={`app-cancel-${row.app.id}`}
          onClick={(e) => { stop(e); onCancel(row) }}
        >
          <Trans>Annulla</Trans>
        </button>
      )}
      {flow === 'failed' && (
        <>
          <span className="shrink-0 text-[13px] text-destructive"><Trans>Non riuscito</Trans></span>
          <button className="h-8 shrink-0 rounded-full bg-muted px-4 text-[13px] transition hover:bg-accent" onClick={(e) => { stop(e); onConnect(row) }}>
            <Trans>Riprova</Trans>
          </button>
        </>
      )}
      {flow === 'conflict' && (
        <div className="w-full rounded-2xl bg-muted px-3 py-2 text-[13px]" onClick={stop} data-testid={`app-conflict-${row.app.id}`}>
          <p><Trans>Composio è già attivo con la chiave di progetto (sviluppatori). Le due strade non possono stare insieme: disattivo la chiave e collego con il login?</Trans></p>
          <div className="mt-1.5 flex gap-2">
            <button
              className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              onClick={() => onConflictResolve(row)}
            >
              <Trans>Disattiva la chiave e collega</Trans>
            </button>
            <button className="rounded-full px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground" onClick={() => onCancel(row)}>
              <Trans>Annulla</Trans>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- la vista vera e propria ----

/**
 * AppsView: la vista condivisa dalla finestra «App» e da Impostazioni › App e
 * skill. La testata (titolo, riepilogo «N connesse ›») c'è sempre; con
 * `embedded` (Impostazioni) la ✕ NO — lì chiude quella del dialogo (RV2).
 */
export function AppsView({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useLingui()
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const composio = useStore((s) => s.composio)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const composioGateway = useStore((s) => s.composioGateway)
  const refreshComposioGateway = useStore((s) => s.refreshComposioGateway)
  const agents = useStore((s) => s.agents)
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const [filter, setFilter] = useState<AppsFilter>('all')
  const [query, setQuery] = useState('')
  const [installed, setInstalled] = useState<{ servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null>(null)
  const [developersOpen, setDevelopersOpen] = useState(false)
  // fase skill (S4): la riga «Skill · N» apre la finestra «Skill» (negozio)
  const openSkillsWindow = useStore((s) => s.setSkillsOpen)
  const [skillsCount, setSkillsCount] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [linkedDetail, setLinkedDetail] = useState<ConnectedRow | null>(null)
  // fase pagine (G4): il suggerimento «Collega <App>» apre la finestra DIRETTAMENTE
  // sul dettaglio di quell'app (appsOpenApp si consuma qui)
  const appsOpenApp = useStore((s) => s.appsOpenApp)
  useEffect(() => {
    if (!appsOpenApp) return
    setDetailId(appsOpenApp)
    useStore.setState({ appsOpenApp: null })
  }, [appsOpenApp])
  const [accountOpen, setAccountOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  // P4: le righe con un flusso in corso, per id ('login' → 'app' da sole)
  const [connecting, setConnecting] = useState<Record<string, 'direct' | 'login' | 'app' | 'conflict'>>({})
  // il server Composio del catalogo è collegato col login (l'ACCOUNT è attivo)
  const gatewayConnected = connectors.find((c) => c.id === 'composio')?.state.status === 'connected'

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

  // fase skill (S2): il conteggio della riga «Skill · N» — la libreria unica
  // più le skill dei plugin, UNA chiamata
  useEffect(() => {
    let alive = true
    void api.skillsLibrary()
      .then((r) => { if (alive) setSkillsCount(r.library.length + r.plugins.reduce((a, g) => a + g.skills.length, 0)) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  // l'elenco unico delle app: le curate static sono «pronte» solo col client salvato
  const staticReady = useMemo(
    () => new Set(connectors.filter((c) => c.clientRegistration === 'static' && c.hasStaticCredentials).map((c) => c.id)),
    [connectors]
  )
  const apps = useMemo(() => loadAppCatalog({ staticClientsReady: staticReady }), [staticReady])

  const model = useMemo(
    () => appsCatalogModel({ apps, connectors, composio, composioGateway, filter, query, lang: uiLang() }),
    [apps, connectors, composio, composioGateway, filter, query]
  )
  const linked = useMemo(
    () => appsViewModel({ connectors, installed, agents, filter, query, lang: uiLang() }),
    [connectors, installed, agents, filter, query]
  )

  // mentre un flusso è in corsa (o un collegamento è in attesa) si rilegge lo
  // stato ogni 2 s: gli eventi {type:'connectors'} arrivano, il polling chiude
  const flowBusy = Object.keys(connecting).length > 0 || Boolean(composioGateway?.pending)
  useEffect(() => {
    if (!flowBusy) return
    const timer = setInterval(() => {
      void refreshConnectors()
      void refreshComposioGateway()
    }, 2000)
    return () => clearInterval(timer)
  }, [flowBusy, refreshConnectors, refreshComposioGateway])

  // una riga COLLEGATA chiude il suo flusso; il login riuscito promuove «app»
  useEffect(() => {
    setConnecting((prev) => {
      let changed = false
      const next: typeof prev = {}
      for (const [id, phase] of Object.entries(prev)) {
        const row = model.rows.find((r) => r.app.id === id)
        if (row?.connected === 'connected') { changed = true; continue }
        if (phase === 'login' && gatewayConnected) { next[id] = 'app'; changed = true; continue }
        next[id] = phase
      }
      return changed ? next : prev
    })
  }, [model, gatewayConnected])

  /** La fase visibile di una riga (null = stato fermo: Connetti/Connessa/Ricollega). */
  const flowOf = (row: CatalogRowView): AppFlowKind | null => {
    const phase = connecting[row.app.id]
    if (!phase) return null
    if (phase === 'conflict') return 'conflict'
    if (phase === 'direct') return 'direct'
    const slug = row.app.composioSlug
    const pending = composioGateway?.pending
    // solo il collegamento FATTO chiude il flusso: uno stato «da ricollegare»
    // arrivato a metà flusso non deve spezzare l'attesa visibile all'utente
    if (row.connected === 'connected') return null
    if (phase === 'login' && !gatewayConnected) return 'login'
    if (slug && pending?.slug === slug && pending.failed) return 'failed'
    return 'app'
  }

  const connect = async (row: CatalogRowView): Promise<void> => {
    const r = await api.appsConnect(row.app.id).catch((): Awaited<ReturnType<typeof api.appsConnect>> => ({ started: false, reason: 'unknown-app' }))
    if (r.started) setConnecting((p) => ({ ...p, [row.app.id]: r.phase ?? 'direct' }))
    else if (r.conflict) setConnecting((p) => ({ ...p, [row.app.id]: 'conflict' }))
    void refreshConnectors()
    void refreshComposioGateway()
  }
  const cancel = async (row: CatalogRowView): Promise<void> => {
    setConnecting((p) => {
      const next = { ...p }
      delete next[row.app.id]
      return next
    })
    await api.appsCancelConnect(row.app.id).catch(() => undefined)
    void refreshConnectors()
    void refreshComposioGateway()
  }
  const onConflictResolve = async (row: CatalogRowView): Promise<void> => {
    await api.composioDisable().catch(() => undefined)
    await refreshComposio()
    await connect(row)
  }

  const openDetail = (row: CatalogRowView): void => setDetailId(row.app.id)
  const detail = detailId ? (model.rows.find((r) => r.app.id === detailId) ?? null) : null

  const botsHalfLine = (label: ConnectedRow['botsLabel']): string => {
    if (label.all) return t`Tutti i bot`
    const names = label.names.join(', ')
    return label.extra > 0 ? `${names} +${label.extra}` : names
  }

  // le pillole: al massimo 5 categorie in riga, le altre dentro «Altro ▾»
  const MAX_CATEGORY_PILLS = 5
  const visibleCategories = model.categoriesPresent.slice(0, MAX_CATEGORY_PILLS)
  const overflowCategories = model.categoriesPresent.slice(MAX_CATEGORY_PILLS)
  const browsing = filter === 'all' && !query.trim()
  // P3: due colonne sopra i 1024 px — a 900 (la finestra minima) diventa UNA
  const rowGrid = 'grid grid-cols-1 gap-1.5 lg:grid-cols-2 lg:gap-x-8'

  const renderRow = (row: CatalogRowView): ReactNode => (
    <AppRow
      key={row.app.id}
      row={row}
      flow={flowOf(row)}
      onConnect={(r) => void connect(r)}
      onCancel={(r) => void cancel(r)}
      onConflictResolve={(r) => void onConflictResolve(r)}
      onOpen={openDetail}
    />
  )

  return (
    <div className={embedded ? 'space-y-5 pr-12' : 'space-y-5'}>
      {/* testata: pila dei loghi + N connesse (nelle Impostazioni c'è già la
          ✕ del dialogo: embedded NON ne disegna una seconda — RV2) */}
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-display text-2xl">{i18n._(msg`App`)}</h2>
        {/* V11 (prova vera): «0 connesse ›» non si mostra; «1 connessa ›» / «N connesse ›» col plurale */}
        {model.connectedCount > 0 && (
          <button
            className="flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
            data-testid="connected-summary"
            onClick={() => setFilter('connected')}
          >
            <span className="flex">
              {model.connectedRows.slice(0, 4).map((r, i) => (
                <AppLogo key={r.app.id} logo={r.app.logo} name={r.app.name} className={`size-6 text-[11px] ${i > 0 ? '-ml-1.5' : ''}`} />
              ))}
            </span>
            <Plural value={model.connectedCount} one="# connessa ›" other="# connesse ›" />
          </button>
        )}
        {/* la ✕ chiude la FINESTRA «App»; nelle Impostazioni (embedded) non esiste */}
        {!embedded && (
          <button
            className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground"
            aria-label={t`Chiudi`}
            onClick={() => setAppsOpen(false)}
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* 1. la ricerca */}
      <label className="flex h-11 items-center gap-2.5 rounded-full bg-muted px-4 text-sm text-muted-foreground">
        <Search className="size-4 shrink-0" />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
          data-testid="apps-search"
          placeholder={t`Cerca tra app e skill`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {/* 2. le pillole: Tutte · Connesse · le categorie con almeno un'app · Altro ▾ */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="app-filters">
        <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}><Trans>Tutte</Trans></FilterPill>
        <FilterPill active={filter === 'connected'} onClick={() => setFilter('connected')}><Trans>Connesse</Trans></FilterPill>
        {visibleCategories.map((c) => (
          <FilterPill key={c} active={filter === c} onClick={() => setFilter(c)}>{appCategoryLabel(c, uiLang())}</FilterPill>
        ))}
        {overflowCategories.length > 0 && (
          <div className="relative">
            <FilterPill
              active={filter !== 'all' && filter !== 'connected' && overflowCategories.includes(filter as AppCategoryId)}
              onClick={() => setOverflowOpen((o) => !o)}
            >
              <Trans>Altro ▾</Trans>
            </FilterPill>
            {overflowOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 flex flex-col gap-0.5 rounded-2xl bg-card p-1.5 shadow-soft">
                {overflowCategories.map((c) => (
                  <button
                    key={c}
                    className={`rounded-full px-3 py-1 text-left text-[12px] transition hover:bg-muted ${filter === c ? 'text-foreground' : 'text-muted-foreground'}`}
                    onClick={() => { setFilter(c); setOverflowOpen(false) }}
                  >
                    {appCategoryLabel(c, uiLang())}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. UNA sola sezione «Connesse» (V10 della prova vera): le app connesse
          del catalogo, i server e i plugin installati e, in fondo, la riga
          «Skill dei bot». Niente sezione «Collegate» separata: due titoli per
          la stessa cosa, e il primo diceva il falso con Gmail collegata. */}
      {(filter === 'all' || filter === 'connected') && (linked.connected.length > 0 || !query) && (
        <section data-testid="connected-section">
          <strong className="text-[15px] font-medium"><Trans>Connesse</Trans></strong>
          {/* il testo vuoto SOLO se non c'è nessuna app, nessun server e nessun plugin */}
          {model.connectedCount === 0 && linked.connected.length === 0 && !query && (
            <p className="py-2 text-sm text-muted-foreground"><Trans>Nessuna app connessa: comincia dalle consigliate.</Trans></p>
          )}
          <div className={`mt-2 ${rowGrid}`}>
            {(browsing || filter === 'connected') && model.connectedRows.map(renderRow)}
            {linked.connected.map((row) => (
              <button
                key={row.key}
                className="flex items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
                onClick={() => setLinkedDetail(row)}
                data-testid={`server-row-${row.id}`}
              >
                <AppLogo logo={row.logo} name={row.name} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{row.name}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{botsHalfLine(row.botsLabel)}</span>
                  {/* R4: un server MCP di terzi NON è un connettore diretta —
                      il badge neutro dice cosa è, come la mezza riga del foglio */}
                  {row.source === 'server'
                    ? <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" data-testid="server-row-mcp-tag"><Trans>Server MCP</Trans></span>
                    : <ProvenanceTag via={row.via} />}
                </span>
                {row.status === 'setup' ? (
                  // fase mcp-setup (M6.1): mai partito — la configurazione manca
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-600 dark:text-amber-400" data-testid="server-status-setup"><Trans>Da completare</Trans></span>
                ) : row.status === 'reconnect' ? (
                  <span className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs text-background"><Trans>Ricollega</Trans></span>
                ) : (
                  <span className="shrink-0 text-sm text-chart-2"><Trans>Connessa</Trans></span>
                )}
              </button>
            ))}
            {/* fase skill (S4): la riga «Skill · N» apre la finestra «Skill» */}
            {!query && (
              <button
                className="flex items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
                data-testid="apps-skills-row"
                onClick={() => openSkillsWindow(true)}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">✦</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]"><Trans>Skill · {skillsCount}</Trans></span>
                  <span className="block truncate text-[13px] text-muted-foreground">
                    <Trans>la libreria dei bot: chi le usa, le versioni, l'import da GitHub</Trans>
                  </span>
                </span>
                <span className="shrink-0 text-sm text-muted-foreground"><Trans>Gestisci ›</Trans></span>
              </button>
            )}
          </div>
        </section>
      )}

      {/* 4. l'elenco unico (P3): consigliate e sezioni per categoria (le
          connesse stanno tutte nella sezione UNICA qui sopra, V10) */}
      <section className="space-y-4">
        {browsing && model.featured.length > 0 && (
          <div>
            <p className="mb-1 text-[13px] text-muted-foreground"><Trans>Consigliate per te</Trans></p>
            <div className={rowGrid}>{model.featured.map(renderRow)}</div>
          </div>
        )}
        {browsing && model.sections.map((s) => (
          <div key={s.category}>
            <div className="mb-1 flex items-baseline justify-between">
              <p className="text-[13px] text-muted-foreground">{appCategoryLabel(s.category, uiLang())}</p>
              {s.total > s.rows.length && (
                <button
                  className="text-[12px] text-muted-foreground transition hover:text-foreground"
                  data-testid={`view-all-${s.category}`}
                  onClick={() => setFilter(s.category)}
                >
                  <Trans>Visualizza tutto</Trans>
                </button>
              )}
            </div>
            <div className={rowGrid}>{s.rows.map(renderRow)}</div>
          </div>
        ))}
        {model.grid && filter !== 'connected' && (model.grid.length > 0 ? (
          <div className={rowGrid}>{model.grid.map(renderRow)}</div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground"><Trans>Nessuna app trovata. Prova con un altro nome.</Trans></p>
        ))}
      </section>

      {/* P6: l'account di Composio, una riga discreta in fondo */}
      {gatewayConnected && (
        <button
          className="flex items-center gap-2 rounded-full bg-muted/60 px-3 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground"
          data-testid="composio-account-row"
          onClick={() => setAccountOpen(true)}
        >
          <span className="grid size-5 place-items-center rounded-full bg-card text-[11px]">🌐</span>
          <span><Trans>Account Composio · connesso</Trans></span>
          <span>›</span>
        </button>
      )}

      {/* A1/A9: il link piccolo in fondo al foglio «Per sviluppatori» */}
      <button
        className="text-[12px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
        onClick={() => setDevelopersOpen(true)}
        data-testid="developers-link"
      >
        <Trans>Per sviluppatori: server personalizzati, plugin, registro</Trans>
      </button>

      {developersOpen && <DevelopersSheet onClose={() => setDevelopersOpen(false)} />}
      {accountOpen && (
        <ComposioAccountSheet
          onClose={() => setAccountOpen(false)}
          onChanged={() => { void refreshConnectors(); void refreshComposioGateway() }}
        />
      )}
      {detail && (
        <AppDetailSheet
          row={detail}
          installed={installed}
          onClose={() => setDetailId(null)}
          onChanged={() => { void refreshConnectors(); void refreshInstalled(); void refreshComposio(); void refreshComposioGateway() }}
          onConnect={(r) => { setDetailId(null); void connect(r) }}
        />
      )}
      {linkedDetail && (
        <ConnectedDetailSheet
          row={linkedDetail}
          installed={installed}
          onClose={() => setLinkedDetail(null)}
          onChanged={() => { void refreshConnectors(); void refreshInstalled() }}
        />
      )}
    </div>
  )
}

// ---- fase catalogo app (P5): il foglio del dettaglio di un'app ----

/**
 * Il dettaglio di un'app dell'elenco: logo grande, nome, descrizione,
 * categoria, la riga di PROVENIENZA (diretta o tramite Composio), lo stato,
 * l'account Composio se c'è, Scollega con conferma e quali bot la usano.
 * Niente slug, niente nomi di strumenti.
 */
/**
 * P4 (fase pulizia): «per bot» del dettaglio di un'app DIRETTA — «Tutti i
 * bot» acceso con i bot spenti e disattivati quando la scelta vale per tutti
 * (stessa resa e stessi componenti dell'anteprima della finestra Skill). Ciò
 * che si salva NON cambia significato: assente o ['*'] = tutti, gli id scelti
 * = quei bot, lista vuota = nessuno (serversForAgent).
 */
function BotTogglesForApp({ directId, enabledFor, agents, onChanged }: {
  directId: string
  enabledFor: string[] | null | undefined
  agents: Array<{ id: string; name: string }>
  onChanged(): void
}): ReactNode {
  const { t } = useLingui()
  const st = botsToggleState(enabledFor, agents)
  const save = (ids: string[]): void => {
    void api.connectorsSetEnabledFor('server', directId, ids).then(onChanged)
  }
  return (
    <div className="mt-3" data-testid="app-bots-toggles">
      <SettingsGroup label={<Trans>Bot che lo usano</Trans>}>
        <SettingsRow
          title={<Trans>Tutti i bot</Trans>}
          control={
            <Toggle
              label={t`Tutti i bot`}
              checked={st.all}
              onChange={(v) => save(v ? ['*'] : [])}
            />
          }
        />
        {st.bots.map((b) => (
          <SettingsRow
            key={b.id}
            title={b.name}
            control={
              <Toggle
                label={b.name}
                checked={b.checked}
                disabled={b.disabled}
                onChange={(v) => {
                  const ids = (enabledFor ?? []).filter((id) => id !== '*')
                  save(v ? [...ids, b.id] : ids.filter((id) => id !== b.id))
                }}
              />
            }
          />
        ))}
      </SettingsGroup>
    </div>
  )
}

function AppDetailSheet({ row, installed, onClose, onChanged, onConnect }: {
  row: CatalogRowView
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  onClose(): void
  onChanged(): void
  onConnect(row: CatalogRowView): void
}) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const composio = useStore((s) => s.composio)
  const composioGateway = useStore((s) => s.composioGateway)
  // V13 (prova vera): i dati del connettore DIRETTO — strumenti disattivati e
  // istruzioni tornano raggiungibili dal dettaglio (la sezione «Avanzate»)
  const connectors = useStore((s) => s.connectors)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // V13: la sezione richiudibile «Avanzate», chiusa di default
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const app = row.app
  const directConnector = app.directId ? connectors.find((c) => c.id === app.directId) ?? null : null
  const [instructions, setInstructions] = useState(directConnector?.state.instructions ?? '')

  // dove sta il collegamento di quest'app (la stessa regola dell'elenco)
  const gatewayApp = app.composioSlug ? (composioGateway?.connected.find((a) => a.slug === app.composioSlug) ?? null) : null
  const keyApp = app.composioSlug ? (composio?.connected.find((a) => a.slug === app.composioSlug) ?? null) : null
  // le curate static non ancora pronte mostrano il client OAuth nel dettaglio? No:
  // con il marchio su Composio la strada è una sola; la configurazione del client
  // resta una questione da «Per sviluppatori» (docs/google-oauth.md).

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (gatewayApp) await api.composioGatewayRemove(app.composioSlug!)
      else if (keyApp) await api.composioDisconnect(app.composioSlug!)
      else if (app.directId) await api.connectorsDisconnect(app.directId)
      onChanged()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      {/* U2: @container — «Bot che lo usano» col toggle sulla riga del nome */}
      <div className="@container max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid={`app-detail-${app.id}`}>
        <div className="flex items-center gap-3">
          <AppLogo logo={app.logo} name={app.name} className="size-14 text-xl" />
          <span className="min-w-0 flex-1">
            <span className="block text-lg font-medium">{app.name}</span>
            <span className="block text-[13px] text-muted-foreground">{appCategoryLabel(app.category, uiLang())}</span>
          </span>
        </div>
        <div className="mt-2"><ProvenanceTag via={app.via} /></div>
        {/* V11 (prova vera): la descrizione si mostra SOLO nella lingua attiva
            (tagline curata o descrizione inglese solo in inglese — la regola
            di P2 vale anche qui); niente nota per sviluppatori */}
        {appTaglineOf(app, uiLang()) && <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{appTaglineOf(app, uiLang())}</p>}
        {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
        {row.connected === 'connected' && <p className="mt-3 text-sm text-chart-2"><Trans>Connessa</Trans></p>}
        {row.connected === 'reconnect' && <p className="mt-3 text-sm text-muted-foreground"><Trans>Non più attiva: ricollega per riavere le sue azioni.</Trans></p>}
        {/* V11 (prova vera): MAI l'id tecnico dell'account — l'email quando
            `list` la dà (user_info.email), altrimenti nulla */}
        {gatewayApp?.email && (
          <p className="mt-1 text-[11px] text-muted-foreground">{gatewayApp.email}</p>
        )}
        {/* P4 (fase pulizia): «per bot» sta SOTTO lo stato e SOPRA i bottoni —
            per le app Composio la scelta per singola app NON esiste (il server
            vale per tutti i bot): testo «Tutti i bot», senza casella; la
            casella resta dove funziona davvero (connettori diretti e server) */}
        {row.connected && app.via === 'composio' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground"><Trans>per bot:</Trans></span>
            <span className="text-[11px] text-muted-foreground"><Trans>Tutti i bot</Trans></span>
          </div>
        )}
        {row.connected && app.via === 'direct' && app.directId && (
          <BotTogglesForApp
            directId={app.directId}
            enabledFor={installed?.servers.find((s) => s.id === app.directId)?.enabledFor}
            agents={agents}
            onChanged={onChanged}
          />
        )}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1" />
          {row.connected ? (
            confirm ? (
              <button
                className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                <Trans>Scollega davvero</Trans>
              </button>
            ) : (
              <button
                className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                onClick={() => setConfirm(true)}
              >
                <Trans>Scollega</Trans>
              </button>
            )
          ) : (
            <button
              className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={() => onConnect(row)}
            >
              {row.connected === 'reconnect' ? <Trans>Ricollega</Trans> : <Trans>Connetti</Trans>}
            </button>
          )}
          <button className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={onClose}>
            <Trans>Chiudi</Trans>
          </button>
        </div>
        {app.via === 'composio' && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            <Trans>Scollegare NON cancella l'account su Composio: si gestisce da composio.dev.</Trans>
          </p>
        )}
        {/* V13 (prova vera): le funzioni perse col vecchio dettaglio dei
            connettori — strumenti attivabili/disattivabili e istruzioni — in
            una sezione richiudibile «Avanzate», chiusa di default, SOLO per
            le app DIRETTE (gli strumenti delle app Composio sono del server
            Composio). Il form del client OAuth statico resta fuori. */}
        {app.via === 'direct' && directConnector && (
          <div className="mt-3 rounded-2xl bg-muted p-3" data-testid="app-advanced">
            <button
              className="flex w-full items-center justify-between text-xs text-muted-foreground transition hover:text-foreground"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <span className="font-medium"><Trans>Avanzate</Trans></span>
              <span>{advancedOpen ? '▾' : '▸'}</span>
            </button>
            {advancedOpen && (
              <div className="mt-2 space-y-2">
                {directConnector.tools.length === 0 && (
                  <p className="text-[11px] text-muted-foreground"><Trans>nessun tool elencato</Trans></p>
                )}
                {directConnector.tools.map((t2) => {
                  const disabled = directConnector.state.disabledTools.includes(t2.name)
                  return (
                    <label key={t2.name} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                        checked={!disabled}
                        onChange={() => {
                          const next = disabled
                            ? directConnector.state.disabledTools.filter((x) => x !== t2.name)
                            : [...directConnector.state.disabledTools, t2.name]
                          void api.connectorsSetTools(directConnector.id, next).then(onChanged)
                        }}
                      />
                      <span className="min-w-0">
                        {/* P4: il nome senza prefisso mcp__ e la descrizione
                            senza «[MCP:…]» — il prefisso resta al modello */}
                        <span className="block truncate font-mono text-[11px]">{mcpToolPresentation(t2.name, t2.description).name}</span>
                        <span className="block text-[10px] text-muted-foreground">{mcpToolPresentation(t2.name, t2.description).description}</span>
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
                    onBlur={() => void api.connectorsSetInstructions(directConnector.id, instructions)}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- fase catalogo app (P6): Composio come ACCOUNT, non come app ----

/**
 * Il foglio piccolo dell'account Composio (riga discreta in fondo alla
 * finestra App): una frase su cos'è (servizio di terzi, piano gratuito),
 * «Gestisci su Composio» e Disattiva con la conferma e il testo di oggi.
 */
function ComposioAccountSheet({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const [confirmOff, setConfirmOff] = useState(false)
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      {/* U2: @container, come il dettaglio app */}
      <div className="@container max-h-[85vh] w-full max-w-md overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="composio-account-sheet">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">🌐</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium"><Trans>Account Composio</Trans></span>
            <span className="block truncate text-[13px] text-muted-foreground"><Trans>Le app dell'elenco che passano da qui</Trans></span>
          </span>
          <span className="h-2 w-2 rounded-full bg-chart-2" />
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          <Trans>Composio è un servizio di terzi: i login e le azioni delle app che colleghi lì passano dai suoi server, non restano solo sul tuo Mac. Ha un piano gratuito.</Trans>
        </p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          <Trans>Le app collegate fuori da Homun non si vedono qui: </Trans>
          <a className="text-primary hover:underline" href="https://dashboard.composio.dev/~/org/connect/apps" target="_blank" rel="noreferrer"><Trans>gestiscile su Composio</Trans></a>.
        </p>
        <div className="mt-4 flex items-center justify-between">
          {confirmOff ? (
            <button
              className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
              onClick={async () => {
                await api.connectorsDisconnect('composio').catch(() => undefined)
                onChanged()
                onClose()
              }}
            >
              <Trans>Disattiva davvero</Trans>
            </button>
          ) : (
            <button
              className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
              onClick={() => setConfirmOff(true)}
            >
              <Trans>Disattiva</Trans>
            </button>
          )}
          <a
            className="rounded-full bg-card px-3.5 py-1.5 text-xs transition hover:bg-card/80"
            href="https://dashboard.composio.dev/~/org/connect/apps"
            target="_blank"
            rel="noreferrer"
          >
            <Trans>Gestisci su Composio</Trans>
          </a>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          <Trans>Disattivare toglie il server e revoca il token sul tuo Mac: le app collegate restano sul tuo account Composio, le togli da</Trans>{' '}
          <a className="text-primary hover:underline" href="https://dashboard.composio.dev/~/org/connect/apps" target="_blank" rel="noreferrer"><Trans>dashboard.composio.dev</Trans></a>.
        </p>
      </div>
    </div>
  )
}

/** Il foglio del dettaglio di un server o plugin collegato (ciò che restava di ConnectorTile e InstalledTab). */
function ConnectedDetailSheet({ row, installed, onClose, onChanged }: {
  row: ConnectedRow
  installed: { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null
  onClose(): void
  onChanged(): void
}) {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [confirm, setConfirm] = useState(false)
  const server = row.source === 'server' ? installed?.servers.find((s) => s.id === row.id) : undefined
  const plugin = row.source === 'plugin' ? installed?.plugins.find((p) => p.name === row.id) : undefined
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      {/* R2: @container — senza, le righe del foglio (SettingsRow) non vedono
          la larghezza del contenitore e l'interruttore scende SOTTO il nome;
          il foglio è largo abbastanza per la riga unica, come le Impostazioni */}
      <div className="@container max-h-[85vh] w-full max-w-lg overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
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
        {!server && !plugin && <p className="text-sm text-muted-foreground">{t`voce non trovata`}</p>}
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
      <DialogContent
        className="flex max-h-[88vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          // U3 (fase pulizia · ritocchi), come T5 nella finestra Skill: niente
          // anello all'apertura — Radix focalizzerebbe la ✕ in alto; il focus
          // va al campo di ricerca, che non ha anello (con Tab resta, è
          // focus-visible), nel frame dopo. Aperta dal menu dell'account, il
          // menu NON riprende il focus: lo decide AccountMenu (openedWindow)
          e.preventDefault()
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="apps-search"]')?.focus())
        }}
      >
        <DialogTitle className="sr-only">{i18n._(msg`App`)}</DialogTitle>
        {/* U2 (fase pulizia · ritocchi): @container sul contenitore del
            contenuto, in UN punto solo come T2 nella finestra Skill — le righe
            SettingsRow vedono la larghezza e mettono il controllo a destra */}
        <div className="@container min-h-0 flex-1 overflow-y-auto scroll-thin p-8" data-testid="apps-content">
          <AppsView />
        </div>
      </DialogContent>
    </Dialog>
  )
}
