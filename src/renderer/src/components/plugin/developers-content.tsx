// C0 (fase linguaggio): pezzo di AppsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — un file per cosa in components/plugin/.
// PL1 (fase plugin): il CONTENUTO «Per sviluppatori» — tutto ciò che ESCE
// dalla vista principale: gateway (Composio Tool Router, Zapier, Pipedream),
// marketplace dei plugin, riga OAuth/CIMD, ricerca nel registro MCP e chiave
// di progetto Composio. U3: l'ordine è Gateway, Plugin, Registro; DS4: è una
// sezione come le altre, i blocchi a 16 px l'uno dall'altro.
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Plus } from 'lucide-react'
import { api, useStore } from '../../store'
import { i18n } from '../../lib/i18n'
import type { AppsRegistryResult } from '../../../../shared/types'
import { accountLimitMessage } from '../../lib/apps-view'
import { FlatList, FlatRow } from '../ui/flat-list'
import { Section } from '../ui/section'
import { Button, buttonVariants } from '../ui/button'

/**
 * Il campo di testo delle finestre dei plugin (DS1): 36 px di altezza —
 * l'altezza è la MISURA (h-), non padding più testo, così un campo e un
 * Button affiancati si allineano sempre — col raggio dei controlli, il testo
 * di riga e il fondo della scheda (sta dentro i pannelli tenui).
 */
const FIELD = 'h-control min-w-0 rounded-control bg-card px-3 text-body outline-none placeholder:text-muted-foreground'

/** La lingua attiva come UiLanguage. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

function MarketplaceTab() {
  const { t } = useLingui()
  const [list, setList] = useState<Array<{ name: string; source: string; kind: string; official: boolean }> | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => setList(await api.marketplaceList())
  useEffect(() => { void refresh() }, [])
  const marketplaces = list ?? []
  return (
    <div className="flex flex-col gap-block">
      <p className="text-small text-muted-foreground">
        <Trans>Plugin nel formato di Claude Code. Predefinito: <code>anthropics/claude-plugins-official</code> (puoi rimuoverlo). Di un plugin Homun importa SOLO skill e server MCP; hook, bin/ e comandi non girano mai.</Trans>
      </p>
      {/* l'elenco solo quando ha righe: una lista vuota in una colonna con lo
          scarto fra i blocchi farebbe uno spazio a vuoto in fondo */}
      {marketplaces.length > 0 && (
        <FlatList>
          {marketplaces.map((m) => (
            <FlatRow
              key={m.source}
              title={(
                <span className="flex items-center gap-2">
                  <span className="truncate">{m.name}</span>
                  {m.official && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-caption text-primary"><Trans>marketplace ufficiale</Trans></span>}
                </span>
              )}
              subtitle={m.source}
              trailing={(
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:text-destructive"
                  onClick={async () => { await api.marketplaceRemove(m.source); await refresh() }}
                >
                  <Trans>rimuovi</Trans>
                </Button>
              )}
            />
          ))}
        </FlatList>
      )}
      <div className="flex items-center gap-2">
        <input
          className={`${FIELD} flex-1`}
          placeholder={t`owner/repo di GitHub oppure URL git https`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button
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
        </Button>
      </div>
      {error && <p className="text-small text-destructive">{error}</p>}
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
  const chosen = (presets ?? []).find((p) => p.name === name)
  return (
    <div className="flex flex-col gap-block">
      <p className="text-small text-muted-foreground">{warning || t`Un gateway custodisce l'accesso a tutte le app che colleghi lì: è un servizio di terzi`}</p>
      {/* i preset: scelte che COMPILANO il modulo qui sotto — secondarie, non
          l'azione che fa andare avanti (quella è «aggiungi gateway») */}
      <div className="flex flex-wrap gap-2">
        {(presets ?? []).map((p) => (
          <Button
            key={p.id}
            variant="secondary"
            size="sm"
            title={p.help}
            onClick={() => { setName(p.name); setUrl(''); setToken('') }}
          >
            {p.name}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-surface bg-muted p-4">
        <div className="grid grid-cols-2 gap-3">
          <input className={FIELD} placeholder={t`Nome (es. Composio)`} value={name} onChange={(e) => setName(e.target.value)} />
          <input className={FIELD} placeholder={t`URL https del server MCP`} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <input className={`${FIELD} w-full`} type="password" placeholder={t`chiave / token Bearer (salvata cifrata)`} value={token} onChange={(e) => setToken(e.target.value)} />
        {chosen?.help && <p className="text-small text-muted-foreground">{chosen.help}</p>}
        <div>
          <Button
            disabled={!name.trim() || !url.trim().startsWith('https://') || !token.trim()}
            onClick={async () => {
              setError('')
              try {
                await api.connectorsAddGateway({
                  name: name.trim(), url: url.trim(),
                  auth: chosen?.auth === 'bearer' ? 'bearer' : 'headers',
                  ...(chosen ? { preset: chosen.id } : {}),
                  ...(chosen?.headerName ? { headerName: chosen.headerName, headers: { [chosen.headerName]: token.trim() } } : { headers: { Authorization: `Bearer ${token.trim()}` } })
                })
                setName(''); setUrl(''); setToken('')
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            <Trans>aggiungi gateway</Trans>
          </Button>
        </div>
        {error && <p className="text-small text-destructive">{error}</p>}
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
    <div className="rounded-surface bg-muted p-4">
      <p className="text-body font-medium"><Trans>OAuth</Trans></p>
      <p className="mt-1 text-small text-muted-foreground"><Trans>Se ospiti un documento dei metadati del client (CIMD, es. su GitHub Pages, https e con percorso), incollalo qui; vuoto = registrazione dinamica (DCR).</Trans></p>
      <input
        className={`${FIELD} mt-3 w-full`}
        placeholder={t`https://utente.github.io/sandbot/client.json`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => void api.connectorsSetClientMetadataUrl(url.trim())}
      />
    </div>
  )
}

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

  // ogni passo è un pannello tenue: i tre passi si leggono come altrettanti
  // momenti, e dentro ciascuno le righe stanno a 12 px (gap-3)
  const stepBox = 'rounded-surface bg-muted p-4'
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-reading overflow-y-auto scroll-thin rounded-surface bg-card p-6 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="composio-activation">
        {/* il titolo del dialogo: text-title, in Figtree — il Bricolage (font-display) è solo del titolo di pagina */}
        <strong className="block text-title font-semibold"><Trans>Più di mille app con Composio</Trans></strong>

        {/* passo 1: cos'è */}
        <div className={`mt-6 ${stepBox}`}>
          <p className="text-body">
            <Trans>Composio è un servizio di terzi: i login e le azioni delle app collegate tramite Composio passano dai suoi server, non restano solo sul tuo Mac.</Trans>
          </p>
          <p className="mt-1 text-body"><Trans>Ha un piano gratuito.</Trans></p>
          <div className="mt-3 flex items-center gap-2">
            {/* un link VESTITO da bottone pieno (la via principale): le classi di Button, da sole */}
            <a
              className={buttonVariants({ size: 'sm' })}
              href="https://composio.dev"
              target="_blank"
              rel="noreferrer"
            >
              <Trans>Apri Composio</Trans>
            </a>
            <Button variant="secondary" size="sm" onClick={() => setStep(2)}>
              <Trans>Avanti</Trans>
            </Button>
          </div>
        </div>

        {/* passo 2: incolla la chiave */}
        {step >= 2 && (
          <div className={`mt-4 ${stepBox}`}>
            <p className="text-body font-medium"><Trans>Incolla la chiave</Trans></p>
            <p className="mt-1 text-small text-muted-foreground">
              <Trans>Dove la trovo? Copia la chiave API dalle impostazioni del tuo progetto su Composio (composio.dev → Settings → API Keys).</Trans>
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                className={`${FIELD} flex-1`}
                type="password"
                placeholder={t`chiave API di Composio`}
                value={key}
                onChange={(e) => { setKey(e.target.value); setStatus('idle'); setTestError('') }}
                autoFocus
              />
              <Button
                variant="secondary"
                disabled={key.trim().length < 8}
                onClick={() => setStep(3)}
              >
                <Trans>Avanti</Trans>
              </Button>
            </div>
          </div>
        )}

        {/* passo 3: prova */}
        {step >= 3 && (
          <div className={`mt-4 ${stepBox}`}>
            <p className="text-body font-medium"><Trans>Prova</Trans></p>
            <p className="mt-1 text-small text-muted-foreground"><Trans>Homun crea il client e chiede a Composio l'elenco delle app: se riesce, la chiave viene salvata cifrata sul tuo Mac.</Trans></p>
            <Button
              className="mt-3"
              disabled={testing || key.trim().length < 8}
              onClick={() => void runTest()}
            >
              {testing ? t`provo…` : <Trans>Prova la chiave</Trans>}
            </Button>
            {status === 'ok' && <p className="mt-3 text-small text-chart-2" data-testid="composio-active"><Trans>Composio attivo</Trans></p>}
            {status === 'invalid-key' && <p className="mt-3 text-small text-destructive"><Trans>Chiave non valida: controllala e riprova.</Trans></p>}
            {status === 'unreachable' && <p className="mt-3 text-small text-destructive"><Trans>Composio non raggiungibile: controlla la connessione e riprova.</Trans></p>}
            {status === 'gateway-active' && (
              <div className="mt-3 rounded-surface bg-card p-3 text-body">
                <p><Trans>Composio è già collegato con il login. Le due strade non possono stare insieme: disattivo il login e uso la chiave di progetto?</Trans></p>
                <Button
                  className="mt-2"
                  onClick={async () => {
                    await api.connectorsDisconnect('composio').catch(() => undefined)
                    await runTest()
                  }}
                >
                  <Trans>Disattiva il login e riprova</Trans>
                </Button>
              </div>
            )}
            {status === 'consumer-key' && (
              <p className="mt-3 text-small text-destructive">
                <Trans>Questa è una chiave di Composio «For You» (inizia con ck_). Homun usa la chiave di un progetto Composio: su composio.dev apri il pannello per sviluppatori, crea un progetto e copia la sua chiave API da Settings → API Keys (inizia con ak_).</Trans>
              </p>
            )}
            {status === 'error' && testError && <p className="mt-3 text-small text-destructive">{testError}</p>}
            {status !== 'ok' && status !== 'idle' && (
              <p className="mt-1 text-small text-muted-foreground"><Trans>La chiave non è stata salvata.</Trans></p>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {status === 'ok' ? <Trans>Fatto</Trans> : <Trans>Chiudi</Trans>}
          </Button>
        </div>
      </div>
    </div>
  )
}

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

  const found = registry ?? []
  return (
    <Section size="title" title={<Trans>Per sviluppatori</Trans>}>
      <p className="text-small text-muted-foreground"><Trans>Server personalizzati, plugin, gateway e registro: chi sa cos'è un server MCP lo trova qui.</Trans></p>
      {/* U3: il GATEWAY per primo (è qui che porta il link della finestra
          «Server MCP»), poi i plugin, poi il registro */}
      <div id="developers-gateway" data-testid="developers-gateway" className="scroll-mt-4">
        <GatewayTab />
      </div>
      <div id="developers-marketplace" className="scroll-mt-4">
        <MarketplaceTab />
      </div>
      <ClientMetadataUrlRow />
      <Section size="body" title={<Trans>Cerca nel registro MCP</Trans>}>
        {/* la ricerca: 36 px come tutti i campi (prima era una pillola più bassa) */}
        <input
          className={`${FIELD} w-full bg-muted`}
          placeholder={t`cerca nel registro (2+ lettere)`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {searching && <p className="text-small text-muted-foreground"><Trans>Cerco nel registro…</Trans></p>}
        {registryFailed && <p className="text-small text-muted-foreground"><Trans>Non riesco a cercare nel registro</Trans></p>}
        {registry !== null && registry.length === 0 && !searching && <p className="text-small text-muted-foreground"><Trans>Nessun server trovato.</Trans></p>}
        {found.length > 0 && (
          <FlatList>
            {found.map((r) => (
              <FlatRow
                key={r.id}
                title={r.name}
                subtitle={r.description}
                trailing={(
                  <a className="shrink-0 text-small text-primary hover:underline" href="https://github.com/modelcontextprotocol/registry" target="_blank" rel="noreferrer">
                    <Trans>il registro ›</Trans>
                  </a>
                )}
              />
            ))}
          </FlatList>
        )}
      </Section>
      {/* fase Composio OAuth (C6): la strada della CHIAVE resta, ma solo
          qui — per la maggior parte delle persone c'è il «Connetti» delle
          app dell'elenco; le due strade non insieme */}
      <ComposioKeySection />
      {footer}
    </Section>
  )
}

function ComposioKeySection() {
  const { t } = useLingui()
  const composio = useStore((s) => s.composio)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const [open, setOpen] = useState(false)
  if (composio?.active) {
    return (
      <Section size="body" title={<Trans>Chiave di progetto Composio (sviluppatori)</Trans>}>
        <p className="text-small text-muted-foreground"><Trans>Attiva con la chiave ak_ del tuo progetto.</Trans></p>
        <div>
          {/* spegnere non è l'azione che fa andare avanti: testo rosso, non un bottone pieno */}
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={async () => {
              await api.composioDisable().catch(() => undefined)
              await refreshComposio()
            }}
          >
            <Trans>Disattiva la chiave</Trans>
          </Button>
        </div>
      </Section>
    )
  }
  return (
    <Section size="body" title={<Trans>Chiave di progetto Composio (sviluppatori)</Trans>}>
      <p className="text-small text-muted-foreground">
        <Trans>Per la maggior parte delle persone è meglio «Accedi con Composio» nella vista principale: un clic nel browser, niente chiavi. La chiave ak_ di un progetto la usano gli sviluppatori.</Trans>
      </p>
      <div>
        <Button onClick={() => setOpen(true)}>
          {t`Usa la chiave di progetto`}
        </Button>
        {open && (
          <ComposioActivationSheet
            onClose={() => setOpen(false)}
            onDone={() => { setOpen(false); void refreshComposio() }}
          />
        )}
      </div>
    </Section>
  )
}
