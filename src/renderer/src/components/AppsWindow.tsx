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
//
// Fase design (DS4, la pagina Plugin): la finestra non c'è più da PL7 — qui
// restano i PEZZI che la pagina riusa (la riga del catalogo, il logo, i flussi
// «Connetti», gli account Composio e il contenuto «Per sviluppatori») e
// passano ai token di DS1. Le regole che questa pagina segue, scritte una volta:
//   - le righe sono FlatRow a filo (anche gli account e i risultati del
//     registro: prima erano riquadri tenui dentro la scheda — «un muro di
//     contenitori»);
//   - le azioni dentro una riga sono TESTO (Button ghost); l'azione che fa
//     andare avanti un modulo è l'unica piena (primary);
//   - i campi sono alti 36 (h-control), col raggio dei controlli e il testo
//     di riga: prima ogni campo aveva la sua altezza (py-1.5, h-9) e il suo
//     raggio. Il campo delle finestre dei plugin sta qui in FIELD perché il
//     pezzo di sistema (components/ui/input) non è ancora ai token: quando lo
//     sarà, questo file lo userà e la costante esce.
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Plus } from 'lucide-react'
import { api, useStore } from '../store'
import { i18n } from '../lib/i18n'
import type { AppsRegistryResult, ComposioGatewayAppInfo, ComposioGatewayStatusInfo } from '../../../shared/types'
import { gatewayAccountRows, accountLimitMessage, type CatalogRowView } from '../lib/apps-view'
// B3 (fase b20-bug): il flusso «Connetti» è PURO (tempo massimo, esiti in riga) — qui solo il cablaggio
import { createAppConnectFlows, type AppConnectFlows, type AppFlowFailure, type AppFlowKind } from '../lib/app-connect-flow'
// PP4 (fase plugin-pulita): la riga del catalogo è a filo
import { FlatList, FlatRow } from './ui/flat-list'
import { Section } from './ui/section'
import { Button, buttonVariants } from './ui/button'
import { catalogLogoUrl, LOGO_CLASS, LOGO_TILE_CLASS } from '../lib/app-logos'

export type { AppFlowFailure, AppFlowKind }

/**
 * Il campo di testo delle finestre dei plugin (DS1): 36 px di altezza —
 * l'altezza è la MISURA (h-), non padding più testo, così un campo e un
 * Button affiancati si allineano sempre — col raggio dei controlli, il testo
 * di riga e il fondo della scheda (sta dentro i pannelli tenui). Il colore
 * del testo lo eredita; il segnaposto è grigio.
 */
const FIELD = 'h-control min-w-0 rounded-control bg-card px-3 text-body outline-none placeholder:text-muted-foreground'

/** La lingua attiva come UiLanguage. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

/**
 * Il logo di una riga o di una testata: il file del catalogo (o un data: URL)
 * oppure, quando manca, l'iniziale su una piastrella tenue.
 *
 * La MISURA la dà chi lo rende, con `className`: size-8 nelle righe e size-10
 * nelle testate di scheda (DS1), e la taglia dell'iniziale. Il raggio e il
 * fondo del tema scuro sono di lib/app-logos, in un posto solo: prima ogni
 * file che rendeva un logo scriveva il suo (rounded-[11px], rounded-[9px],
 * rounded-[5px]).
 *
 * Fase design (DS1): niente più emoji al posto del logo — nell'interfaccia ci
 * sono solo icone. Chi non ha un file di logo mostra l'iniziale.
 */
export function AppLogo({ logo, name, className = 'size-10 text-reading' }: { logo: string | null; name: string; className?: string }) {
  const url = catalogLogoUrl(logo)
  if (url || logo?.startsWith('data:')) {
    return <img src={url ?? logo!} alt="" className={`${LOGO_CLASS} ${className}`} />
  }
  return (
    <span className={`grid place-items-center ${LOGO_TILE_CLASS} ${className}`}>
      {name.slice(0, 1).toUpperCase()}
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
 *
 * Fase design (DS4): è una sezione come le altre — il titolo (text-title: è
 * il titolo di ciò che si apre sotto la riga «Per sviluppatori»), l'angolo
 * in alto dove si va a finire con lo scorrimento, e i blocchi a 16 px l'uno
 * dall'altro. I blocchi CON un titolo sono sezioni a loro volta (testo di
 * riga, grigio): stanno dentro, non prendono lo scarto delle sezioni (32).
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

/**
 * Le fasi visibili della riga durante «Connetti» in un passo (P4).
 * B3 (fase b20-bug): anche `starting` (dal clic alla risposta) e `failed` col
 * motivo — mai una riga muta né in attesa per sempre. Il tipo e la logica
 * vivono in lib/app-connect-flow (pura).
 */

/**
 * PL1 (fase plugin): il motore dei flussi «Connetti in un passo» delle app,
 * ESTRATTO da AppsView così la pagina Plugin lo riusa senza riscriverlo —
 * le fasi per riga (starting/direct/login/app/conflict/failed), il polling
 * mentre un flusso è in corsa, la promozione login → app quando il gateway si
 * collega e la chiusura quando la riga diventa collegata. `rows` sono le righe
 * del modello del catalogo (appsCatalogModel().rows), per riconoscere la riga
 * di un flusso in corsa.
 * B3 (fase b20-bug): la logica è PURA (lib/app-connect-flow): qui solo il
 * cablaggio con l'api e lo store. Dal clic la riga è «in avvio»; la risposta
 * dice se il collegamento è partito oppure perché no (motivo + «Riprova»);
 * senza risposta entro APP_CONNECT_MAX_MS la riga si sblocca con un avviso.
 * `maxMs` accorcia quel tempo (i test).
 */
export function useConnectFlows(rows: CatalogRowView[], options: { maxMs?: number } = {}): {
  gatewayConnected: boolean
  composioGateway: ComposioGatewayStatusInfo | null
  flowOf(row: CatalogRowView): AppFlowKind | null
  /** B3: il motivo quando flowOf è 'failed' (null negli altri stati) */
  failureOf(row: CatalogRowView): AppFlowFailure | null
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
  const gatewayConnected = connectors.find((c) => c.id === 'composio')?.state.status === 'connected'
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  // niente promesse orfane: una rilettura che rifiuta non è un errore dell'utente
  const reread = (): void => {
    void refreshConnectors().catch(() => undefined)
    void refreshComposioGateway().catch(() => undefined)
  }

  // B3: il flusso PURO, una volta per montaggio (orologio e timer sono quelli del browser)
  const flowsRef = useRef<AppConnectFlows | null>(null)
  if (flowsRef.current === null) {
    flowsRef.current = createAppConnectFlows({
      appsConnect: (id) => api.appsConnect(id),
      appsCancelConnect: (id) => api.appsCancelConnect(id),
      changed: () => redraw(),
      refreshed: reread,
      ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {})
    })
  }
  const flows = flowsRef.current

  const view = (row: CatalogRowView) => flows.viewOf(row.app.id, {
    connected: row.connected,
    ...(row.app.composioSlug ? { composioSlug: row.app.composioSlug } : {}),
    gatewayConnected,
    pending: composioGateway?.pending,
    published: composioGateway?.appConnect
  })

  // mentre un flusso è in corsa (o un collegamento è in attesa) si rilegge lo
  // stato ogni 2 s: gli eventi {type:'connectors'} arrivano, il polling chiude
  const flowBusy = flows.hasPending() || Boolean(composioGateway?.pending)
  useEffect(() => {
    if (!flowBusy) return
    const timer = setInterval(() => {
      void refreshConnectors().catch(() => undefined)
      void refreshComposioGateway().catch(() => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [flowBusy, refreshConnectors, refreshComposioGateway])

  // una riga COLLEGATA chiude il suo flusso (e con lei il polling)
  useEffect(() => {
    if (flows.dropClosed(...rows.filter((r) => r.connected === 'connected').map((r) => r.app.id))) redraw()
  }, [rows, flows])

  // allo smontaggio nessun timer del flusso resta acceso
  useEffect(() => () => flows.dispose(), [flows])

  const onConflictResolve = async (row: CatalogRowView): Promise<void> => {
    await api.composioDisable().catch(() => undefined)
    await refreshComposio()
    await flows.connect(row)
  }
  return {
    gatewayConnected,
    composioGateway,
    flowOf: (row) => view(row).kind,
    failureOf: (row) => view(row).failure,
    connect: (row) => flows.connect(row),
    cancel: (row) => flows.cancel(row),
    onConflictResolve,
    refresh: reread
  }
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
 * B3 (fase b20-bug): in avvio lo dice; quando non è partito mostra il motivo
 * per esteso (sotto la riga) con «Riprova» — mai muta, mai senza uscita. Il
 * contenitore porta `data-flow` (lo stato) per le sonde.
 *
 * Fase design (DS4): le azioni della riga sono testo (Button ghost, 32 px:
 * l'altezza delle righe) — prima erano pillole scritte a mano; lo stato in
 * parole è la riga grigia (text-small), rossa quando non è partito. Ciò che
 * sta SOTTO la riga (il motivo per esteso, il conflitto) comincia sotto il
 * nome, alla stessa ascissa: FlatRow mette il testo dopo lo slot del logo
 * (32) e lo scarto fra logo e testo (12) — qui la stessa casa vuota, perché
 * 44 px non sono nella scala delle spaziature (pl-11 era scritto a mano).
 */
export function AppRow({ row, flow, failure, onConnect, onCancel, onConflictResolve, onOpen }: {
  row: CatalogRowView
  flow: AppFlowKind | null
  /** B3: il motivo quando `flow` è 'failed' (negli altri stati non si guarda) */
  failure?: AppFlowFailure | null
  onConnect(row: CatalogRowView): void
  onCancel(row: CatalogRowView): void
  onConflictResolve(row: CatalogRowView): void
  onOpen(row: CatalogRowView): void
}): ReactNode {
  const { t } = useLingui()
  const stop = (e: { stopPropagation(): void }): void => e.stopPropagation()
  const statusLine =
    flow === 'login' ? t`Accedi a Composio nel browser…`
    : flow === 'app' ? t`Completa il login di ${row.app.name} nel browser…`
    : row.tagline
  const failed = flow === 'failed' ? failure ?? null : null
  /** Ciò che sta sotto la riga: la casa vuota del logo, poi il testo alla stessa ascissa del nome. */
  const underRow = 'flex gap-row-gap pb-3'
  const logoRoom = <span className="size-8 shrink-0" aria-hidden="true" />
  return (
    <div data-testid={`app-state-${row.app.id}`} data-flow={flow ?? 'idle'} {...(failed ? { 'data-flow-reason': failed.reason } : {})}>
      <FlatRow
        clickable
        testId={`app-row-${row.app.id}`}
        onClick={() => onOpen(row)}
        leading={<AppLogo logo={row.app.logo} name={row.app.name} className="size-8 text-body" />}
        title={row.app.name}
        subtitle={statusLine ?? undefined}
        trailing={
          <>
            {flow === null && row.connected === 'reconnect' && (
              <Button variant="ghost" size="sm" data-testid={`app-connect-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                <Trans>Ricollega</Trans>
              </Button>
            )}
            {flow === null && row.connected === null && (
              <Button variant="ghost" size="sm" data-testid={`app-connect-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                <Trans>Connetti</Trans>
              </Button>
            )}
            {flow === 'starting' && (
              <span className="text-small text-muted-foreground" data-testid={`app-status-${row.app.id}`}>
                {t`Avvio del collegamento…`}
              </span>
            )}
            {flow === 'direct' && <span className="text-small text-muted-foreground">{t`autorizza nel browser…`}</span>}
            {(flow === 'login' || flow === 'app') && (
              <Button variant="ghost" size="sm" data-testid={`app-cancel-${row.app.id}`} onClick={(e) => { stop(e); onCancel(row) }}>
                <Trans>Annulla</Trans>
              </Button>
            )}
            {flow === 'failed' && (
              <>
                <span className="text-small text-destructive" data-testid={`app-status-${row.app.id}`}>
                  {failed?.reason === 'not-connectable'
                    ? <Trans>Non si può collegare</Trans>
                    : failed?.reason === 'timeout'
                      ? <Trans>Nessuna risposta</Trans>
                      : <Trans>Non riuscito</Trans>}
                </span>
                <Button variant="ghost" size="sm" data-testid={`app-retry-${row.app.id}`} onClick={(e) => { stop(e); onConnect(row) }}>
                  <Trans>Riprova</Trans>
                </Button>
              </>
            )}
          </>
        }
      />
      {/* B3: il motivo per esteso, sotto la riga (la mezza riga si tronca: un motivo non si taglia) */}
      {flow === 'failed' && failed && (
        <div className={`${underRow} flex-wrap items-baseline gap-y-1`} onClick={stop} data-testid={`app-error-${row.app.id}`}>
          {logoRoom}
          <p className="min-w-0 flex-1 basis-64 text-small text-foreground/80">{failed.text}</p>
          {failed.detail && (
            <p className="min-w-0 flex-1 basis-64 truncate text-caption text-muted-foreground" title={failed.detail} data-testid={`app-error-detail-${row.app.id}`}>
              {failed.detail}
            </p>
          )}
        </div>
      )}
      {flow === 'conflict' && (
        <div className={`${underRow} flex-wrap items-center`} onClick={stop} data-testid={`app-conflict-${row.app.id}`}>
          {logoRoom}
          <p className="min-w-0 flex-1 text-small">
            <Trans>Composio è già attivo con la chiave di progetto (sviluppatori). Le due strade non possono stare insieme: disattivo la chiave e collego con il login?</Trans>
          </p>
          <Button variant="secondary" size="sm" onClick={() => onConflictResolve(row)}>
            <Trans>Disattiva la chiave e collega</Trans>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onCancel(row)}>
            <Trans>Annulla</Trans>
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * CA2 (fase composio-account): gli account di un'app Composio collegata nel
 * dettaglio — una riga per account (alias, email in grigio, «Da ricollegare»
 * per i non attivi) con «Rinomina» e «Togli» (con conferma), e sotto
 * «Aggiungi un altro account»: chiede un nome facoltativo («lavoro,
 * personale…») e apre il login come oggi. Il limite di account del server si
 * dice in parole semplici, mai l'errore grezzo.
 *
 * Fase design (DS4): a filo come il resto della scheda (PP4) — prima ogni
 * account era un riquadro tenue. Il nome dell'account è il titolo di riga,
 * l'email la riga grigia; le azioni sono testo. «Rinomina» e l'aggiunta
 * aprono il loro campo nella riga stessa (in altezza 32: sta in una riga da
 * 52), e il campo dell'aggiunta è l'UNICO input della sezione finché è
 * aperto — le sonde lo trovano come primo input di «app-accounts».
 */
export function GatewayAccountsSection({ app, appName, onChanged }: {
  app: ComposioGatewayAppInfo
  appName: string
  onChanged(): void
}): ReactNode {
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

  /** Il campo di un nome scritto sul posto (rinomina, aggiunta): 32 px, sta in una riga. */
  const nameField = 'h-control-sm w-40 rounded-control bg-card px-2 text-body outline-none placeholder:text-muted-foreground'
  const togli = 'text-destructive hover:text-destructive'

  return (
    <div className="flex flex-col gap-block" data-testid="app-accounts">
      <FlatList>
        {rows.map((row) => (
          <div key={row.key} data-testid={`app-account-${row.key}`}>
            <FlatRow
              title={row.alias}
              subtitle={row.reconnect
                ? <>{row.email ? <>{row.email}{' · '}</> : null}<Trans>Da ricollegare</Trans></>
                : row.email}
              trailing={renaming?.key === row.key ? (
                <>
                  <input
                    autoFocus
                    className={nameField}
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
                  <Button
                    size="sm"
                    disabled={busy || !renaming.value.trim()}
                    onClick={() => {
                      void run(() => api.composioGatewayRenameAccount(app.slug, row.key, renaming.value))
                      setRenaming(null)
                    }}
                  >
                    <Trans>Salva</Trans>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                    <Trans>Annulla</Trans>
                  </Button>
                </>
              ) : removing === row.key ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={togli}
                    disabled={busy}
                    onClick={() => {
                      void run(() => api.composioGatewayRemoveAccount(app.slug, row.key))
                      setRemoving(null)
                    }}
                  >
                    <Trans>Togli davvero</Trans>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                    <Trans>Annulla</Trans>
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenaming({ key: row.key, value: row.alias })}>
                    <Trans>Rinomina</Trans>
                  </Button>
                  <Button variant="ghost" size="sm" className={togli} disabled={busy} onClick={() => setRemoving(row.key)}>
                    <Trans>Togli</Trans>
                  </Button>
                </>
              )}
            />
          </div>
        ))}
        {/* CA2: «Aggiungi un altro account» — nome facoltativo, login come oggi.
            La riga è un bottone: 40 px (riga di solo testo), con l'icona al
            posto del «+» scritto a mano */}
        {adding ? (
          <div className="flex items-center gap-2 py-row-pad">
            <input
              autoFocus
              className={nameField}
              placeholder={t`lavoro, personale…`}
              value={addAlias}
              onChange={(e) => setAddAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAdding(false); setAddAlias('') }
              }}
            />
            {/* i bottoni alla misura del campo (32): la riga sta in piedi, tutta sulla stessa linea */}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void run(() => api.composioGatewayConnect(app.slug, appName, { another: true, alias: addAlias }))
                setAdding(false)
                setAddAlias('')
              }}
            >
              <Trans>Collega</Trans>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setAddAlias('') }}>
              <Trans>Annulla</Trans>
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="flex min-h-row-text w-full cursor-pointer items-center gap-row-gap py-row-pad text-body text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => setAdding(true)}
            data-testid="app-add-account"
          >
            <span className="grid size-8 shrink-0 place-items-center" aria-hidden="true"><Plus className="size-4" /></span>
            <Trans>Aggiungi un altro account</Trans>
          </button>
        )}
      </FlatList>
      {limitCount !== null && (
        <p className="text-small text-muted-foreground" data-testid="app-account-limit">{accountLimitMessage(limitCount, appName, uiLang())}</p>
      )}
      {error && <p className="text-small text-destructive">{error}</p>}
    </div>
  )
}
