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
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api, useStore } from '../store'
import { i18n } from '../lib/i18n'
import type { AppsRegistryResult, ComposioGatewayAppInfo, ComposioGatewayStatusInfo } from '../../../shared/types'
import { botsToggleState, gatewayAccountRows, accountLimitMessage, type CatalogRowView } from '../lib/apps-view'
// PP4 (fase plugin-pulita): la riga del catalogo è a filo
import { FlatRow } from './ui/flat-list'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'
import { Toggle } from './Settings'
import { catalogLogoUrl } from '../lib/app-logos'

/** La lingua attiva come UiLanguage. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
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
export function AppLogo({ logo, name, className = 'size-10 text-base' }: { logo: string | null; name: string; className?: string }) {
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
 * gateway (Composio Tool Router, Zapier, Pipedream), marketplace dei plugin,
 * riga OAuth/CIMD e ricerca nel registro MCP.
 * U3 (fase mcp-ui): le sezioni in ordine Gateway, Plugin, Registro; il link
 * «Gateway, plugin e registro» della finestra «Server MCP» apre il foglio
 * SCORRENDO alla sezione Gateway (scrollTo); i server MCP manuali restano
 * nella finestra «Server MCP» — qui solo UNA riga piccola in fondo, non un
 * blocco in evidenza: niente giro a vuoto tra i due fogli.
 * PL1 (fase plugin): il CONTENUTO vive in DevelopersContent (esportata) —
 * la pagina Plugin lo incorpora in «Avanzate»; il foglio resta il wrapper
 * di oggi finché le finestre esistono.
 */
export function DevelopersContent({ scrollTo, footer }: { scrollTo?: 'gateway' | 'marketplace' | null; footer?: ReactNode }): ReactNode {
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

  // U3: aperto da «Server MCP», il foglio arriva GIÀ sulla sezione Gateway
  useEffect(() => {
    if (scrollTo !== 'gateway' && scrollTo !== 'marketplace') return
    document.getElementById(`developers-${scrollTo}`)?.scrollIntoView({ block: 'start' })
  }, [scrollTo])

  return (
    <>
      <strong className="block font-display text-lg"><Trans>Per sviluppatori</Trans></strong>
      <p className="mt-1 text-xs text-muted-foreground"><Trans>Server personalizzati, plugin, gateway e registro: chi sa cos'è un server MCP lo trova qui.</Trans></p>
      <div className="mt-4 space-y-6">
        {/* U3: il GATEWAY per primo (è qui che porta il link della finestra
            «Server MCP»), poi i plugin, poi il registro */}
        <div id="developers-gateway" data-testid="developers-gateway" className="scroll-mt-4">
          <GatewayTab />
        </div>
        <div id="developers-marketplace" className="scroll-mt-4">
          <MarketplaceTab />
        </div>
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
        {/* fase Composio OAuth (C6): la strada della CHIAVE resta, ma solo
            qui — per la maggior parte delle persone c'è il «Connetti» delle
            app dell'elenco; le due strade non insieme */}
        <ComposioKeySection />
      </div>
      {footer}
    </>
  )
}

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
export function FilterPill({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
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
 * PL1 (fase plugin): il motore dei flussi «Connetti in un passo» delle app,
 * ESTRATTO da AppsView così la pagina Plugin lo riusa senza riscriverlo —
 * le fasi per riga (direct/login/app/conflict), il polling mentre un flusso
 * è in corsa, la promozione login → app quando il gateway si collega e la
 * chiusura quando la riga diventa collegata. `rows` sono le righe del
 * modello del catalogo (appsCatalogModel().rows), per riconoscere la riga
 * di un flusso in corsa.
 */
export function useConnectFlows(rows: CatalogRowView[]): {
  connecting: Record<string, 'direct' | 'login' | 'app' | 'conflict'>
  gatewayConnected: boolean
  composioGateway: ComposioGatewayStatusInfo | null
  flowOf(row: CatalogRowView): AppFlowKind | null
  connect(row: CatalogRowView): Promise<void>
  cancel(row: CatalogRowView): Promise<void>
  onConflictResolve(row: CatalogRowView): Promise<void>
  refresh(): void
} {
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const composioGateway = useStore((s) => s.composioGateway)
  const refreshComposioGateway = useStore((s) => s.refreshComposioGateway)
  const [connecting, setConnecting] = useState<Record<string, 'direct' | 'login' | 'app' | 'conflict'>>({})
  const gatewayConnected = connectors.find((c) => c.id === 'composio')?.state.status === 'connected'

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
        const row = rows.find((r) => r.app.id === id)
        if (row?.connected === 'connected') { changed = true; continue }
        if (phase === 'login' && gatewayConnected) { next[id] = 'app'; changed = true; continue }
        next[id] = phase
      }
      return changed ? next : prev
    })
  }, [rows, gatewayConnected])

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
  const refresh = (): void => {
    void refreshConnectors()
    void refreshComposioGateway()
  }
  return { connecting, gatewayConnected, composioGateway, flowOf, connect, cancel, onConflictResolve, refresh }
}

/**
 * La riga di un'app dell'elenco unico: logo, nome, tagline (o lo stato del
 * flusso) e a destra Connetti / Ricollega / l'attesa con Annulla.
 * NIENTE etichetta di provenienza: quella sta nel foglio del dettaglio. Il
 * clic sulla riga apre il dettaglio; il clic sul bottone collega.
 * PL1 (fase plugin): esportata — la pagina Plugin la riusa com'è.
 * PP4 (fase plugin-pulita): la riga è A FILO (FlatRow), il logo da 32px, e
 * quando è collegata non lo dice in parole («Connessa» era un segnale in
 * più: lo stato in parole resta solo quando qualcosa non va).
 */
export function AppRow({ row, flow, onConnect, onCancel, onConflictResolve, onOpen }: {
  row: CatalogRowView
  flow: AppFlowKind | null
  onConnect(row: CatalogRowView): void
  onCancel(row: CatalogRowView): void
  onConflictResolve(row: CatalogRowView): void
  onOpen(row: CatalogRowView): void
}): ReactNode {
  const { t } = useLingui()
  const stop = (e: { stopPropagation(): void }): void => e.stopPropagation()
  const quiet = 'rounded-full px-3.5 py-1.5 text-[13px] text-foreground transition hover:bg-muted'
  const statusLine =
    flow === 'login' ? t`Accedi a Composio nel browser…`
    : flow === 'app' ? t`Completa il login di ${row.app.name} nel browser…`
    : row.tagline
  return (
    <div>
      <FlatRow
        clickable
        testId={`app-row-${row.app.id}`}
        onClick={() => onOpen(row)}
        leading={<AppLogo logo={row.app.logo} name={row.app.name} className="size-8 text-sm" />}
        title={row.app.name}
        subtitle={statusLine ?? undefined}
        trailing={
          <>
            {flow === null && row.connected === 'reconnect' && (
              <button type="button" className={quiet} data-testid={`app-connect-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                <Trans>Ricollega</Trans>
              </button>
            )}
            {flow === null && row.connected === null && (
              <button type="button" className={quiet} data-testid={`app-connect-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                <Trans>Connetti</Trans>
              </button>
            )}
            {flow === 'direct' && <span className="text-[13px] text-muted-foreground">{t`autorizza nel browser…`}</span>}
            {(flow === 'login' || flow === 'app') && (
              <button type="button" className={quiet} data-testid={`app-cancel-${row.app.id}`} onClick={(e) => { stop(e); onCancel(row) }}>
                <Trans>Annulla</Trans>
              </button>
            )}
            {flow === 'failed' && (
              <>
                <span className="text-[13px] text-destructive"><Trans>Non riuscito</Trans></span>
                <button type="button" className={quiet} onClick={(e) => { stop(e); onConnect(row) }}>
                  <Trans>Riprova</Trans>
                </button>
              </>
            )}
          </>
        }
      />
      {flow === 'conflict' && (
        <div className="flex flex-wrap items-center gap-2 pb-3 text-[13px]" onClick={stop} data-testid={`app-conflict-${row.app.id}`}>
          <p className="min-w-0 flex-1">
            <Trans>Composio è già attivo con la chiave di progetto (sviluppatori). Le due strade non possono stare insieme: disattivo la chiave e collego con il login?</Trans>
          </p>
          <button
            type="button"
            className="rounded-full bg-muted px-3.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent"
            onClick={() => onConflictResolve(row)}
          >
            <Trans>Disattiva la chiave e collega</Trans>
          </button>
          <button type="button" className="rounded-full px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground" onClick={() => onCancel(row)}>
            <Trans>Annulla</Trans>
          </button>
        </div>
      )}
    </div>
  )
}

// ---- la vista vera e propria ----

export function BotTogglesForApp({ directId, enabledFor, agents, onChanged }: {
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

/**
 * CA2 (fase composio-account): gli account di un'app Composio collegata nel
 * dettaglio della finestra App — una riga per account (alias in grassetto,
 * email in grigio, «Da ricollegare» per i non attivi) con «Rinomina» e
 * «Togli» (con conferma), e sotto «Aggiungi un altro account»: chiede un
 * nome facoltativo («lavoro, personale…») e apre il login come oggi. Il
 * limite di account del server si dice in parole semplici, mai l'errore
 * grezzo. Stile della finestra di oggi: niente bordi, fondi tenui.
 */
export function GatewayAccountsSection({ app, appName, onChanged }: {
  app: ComposioGatewayAppInfo
  appName: string
  onChanged(): void
}) {
  const { t } = useLingui()
  const rows = gatewayAccountRows(app)
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [limitCount, setLimitCount] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [addAlias, setAddAlias] = useState('')

  if (rows.length === 0) return null

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; accountCount?: number }>): Promise<void> => {
    setBusy(true)
    setError('')
    setLimitCount(null)
    try {
      const r = await fn()
      if (!r.ok) {
        if (r.error === 'account-limit') setLimitCount(r.accountCount ?? 5)
        else setError(r.error ?? 'error')
      } else {
        onChanged()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-1.5" data-testid="app-accounts">
      {rows.map((row) => (
        <div key={row.key} className="rounded-xl bg-muted/60 px-3 py-2" data-testid={`app-account-${row.key}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold">{row.alias}</span>
            {row.email && <span className="truncate text-[12px] text-muted-foreground">{row.email}</span>}
            {row.reconnect && <span className="text-[11px] text-muted-foreground"><Trans>Da ricollegare</Trans></span>}
            <span className="flex-1" />
            {renaming?.key === row.key ? (
              <span className="flex items-center gap-1.5">
                <input
                  autoFocus
                  className="w-32 rounded-lg bg-card px-2 py-1 text-xs outline-none"
                  value={renaming.value}
                  onChange={(e) => setRenaming({ key: row.key, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && renaming.value.trim() && !busy) {
                      void run(() => api.composioGatewayRenameAccount(app.slug, row.key, renaming.value))
                      setRenaming(null)
                    }
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
                <button
                  className="rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  disabled={busy || !renaming.value.trim()}
                  onClick={() => {
                    void run(() => api.composioGatewayRenameAccount(app.slug, row.key, renaming.value))
                    setRenaming(null)
                  }}
                >
                  <Trans>Salva</Trans>
                </button>
                <button className="rounded-full px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground" onClick={() => setRenaming(null)}>
                  <Trans>Annulla</Trans>
                </button>
              </span>
            ) : removing === row.key ? (
              <span className="flex items-center gap-1.5">
                <button
                  className="rounded-full px-2.5 py-1 text-[11px] text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    void run(() => api.composioGatewayRemoveAccount(app.slug, row.key))
                    setRemoving(null)
                  }}
                >
                  <Trans>Togli davvero</Trans>
                </button>
                <button className="rounded-full px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground" onClick={() => setRemoving(null)}>
                  <Trans>Annulla</Trans>
                </button>
              </span>
            ) : (
              <span className="flex items-center gap-2 text-[11px]">
                <button className="text-muted-foreground transition hover:text-foreground" disabled={busy} onClick={() => setRenaming({ key: row.key, value: row.alias })}>
                  <Trans>Rinomina</Trans>
                </button>
                <button className="text-destructive transition hover:opacity-70" disabled={busy} onClick={() => setRemoving(row.key)}>
                  <Trans>Togli</Trans>
                </button>
              </span>
            )}
          </div>
        </div>
      ))}
      {/* CA2: «Aggiungi un altro account» — nome facoltativo, login come oggi */}
      <div className="rounded-xl bg-muted/40 px-3 py-2">
        {adding ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              autoFocus
              className="w-40 rounded-lg bg-card px-2 py-1 text-xs outline-none"
              placeholder={t`lavoro, personale…`}
              value={addAlias}
              onChange={(e) => setAddAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAdding(false); setAddAlias('') }
              }}
            />
            <button
              className="rounded-full bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                void run(() => api.composioGatewayConnect(app.slug, appName, { another: true, alias: addAlias }))
                setAdding(false)
                setAddAlias('')
              }}
            >
              <Trans>Collega</Trans>
            </button>
            <button className="rounded-full px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground" onClick={() => { setAdding(false); setAddAlias('') }}>
              <Trans>Annulla</Trans>
            </button>
          </div>
        ) : (
          <button
            className="text-[12px] text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => setAdding(true)}
            data-testid="app-add-account"
          >
            + <Trans>Aggiungi un altro account</Trans>
          </button>
        )}
      </div>
      {limitCount !== null && (
        <p className="text-[12px] text-muted-foreground" data-testid="app-account-limit">{accountLimitMessage(limitCount, appName, uiLang())}</p>
      )}
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  )
}
