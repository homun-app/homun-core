// PL1 (fase plugin): la pagina «Plugin» — LA CASA UNICA di connettori,
// server MCP e skill (tavola 8 della tela). Copre l'area centrale come
// Libreria e Attività (regola B1: decide il render condizionale di App);
// la voce «Plugin» sta nella barra tra «Da approvare» e «Attività», e dal
// menu dell'account sono uscite «Collega app», «Skill» e «Server MCP».
// I PEZZI delle finestre di oggi si riusano, non si riscrivono: le righe e
// i flussi di connessione di AppsWindow (AppRow + useConnectFlows), il
// foglio del dettaglio app, il ServerSheet dei server, ManualServers con
// il form e l'import di McpWindow, l'editor SkillEditor di SkillsWindow,
// il contenuto «Per sviluppatori» (gateway, marketplace, registro, chiave)
// che qui sta in fondo alla pagina dentro «Avanzate».
// La riga grigia «tipo · strada · origine» e lo stato con l'azione vengono
// dal modello puro lib/plugins-view: mai dati inventati.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { BadgeCheck, ChevronDown, Puzzle, Search, ChevronLeft } from 'lucide-react'
import { api, useStore, type PluginPoint } from '../store'
import { i18n } from '../lib/i18n'
import { loadAppCatalog, appCategoryLabel, type AppCategoryId } from '../../../shared/app-catalog'
import type { SkillLibraryItem } from '../../../shared/types'
import { appsCatalogModel, type AppsFilter, type InstalledServerLike, type InstalledPluginLike, type ConnectedRow, type CatalogRowView } from '../lib/apps-view'
import { yourPlugins, grayLineOf, stateLabelOf, type PluginSegment, type YourPluginRow } from '../lib/plugins-view'
import { humanizeSkillName } from '../../../shared/skill-md'
import {
  AppRow, AppLogo, FilterPill, useConnectFlows, AppDetailSheet,
  ConnectedDetailSheet, DevelopersContent
} from './AppsWindow'
import { ServerSheet } from './ServerSheet'
import { ManualServers } from './McpWindow'
import { SkillEditor } from './SkillsWindow'
import { logoUrlForName } from '../lib/app-logos'

/** La lingua attiva come 'it' | 'en'. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

/** La vista interna della pagina: l'elenco, i server MCP, l'editor di una skill. */
type PluginView = 'list' | 'mcp' | 'skill-new'

/**
 * La pagina Plugin. Il punto chiesto da un rimando (`pluginAt`) si consuma
 * qui: la card «Apri Server MCP» arriva ai server MCP, il suggerimento del
 * pannello all'app giusta, la riga Skill alle skill del bot.
 */
export function PluginPanel(): ReactNode {
  const { t } = useLingui()
  const lang = uiLang()
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const composio = useStore((s) => s.composio)
  const composioGateway = useStore((s) => s.composioGateway)
  const refreshComposioGateway = useStore((s) => s.refreshComposioGateway)
  const agents = useStore((s) => s.agents)
  const skillsFilterAgent = useStore((s) => s.skillsFilterAgent)
  const setSkillsFilterAgent = useStore((s) => s.setSkillsFilterAgent)
  const setPluginOpen = useStore((s) => s.setPluginOpen)

  const [seg, setSeg] = useState<PluginSegment>('all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<PluginView>('list')
  const [category, setCategory] = useState<AppsFilter>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [installed, setInstalled] = useState<{ servers: InstalledServerLike[]; plugins: InstalledPluginLike[] } | null>(null)
  const [skills, setSkills] = useState<SkillLibraryItem[] | null>(null)
  // i fogli del dettaglio (i pezzi riusati di oggi)
  const [appDetailId, setAppDetailId] = useState<string | null>(null)
  const [linkedDetail, setLinkedDetail] = useState<ConnectedRow | null>(null)
  const [skillDetail, setSkillDetail] = useState<string | null>(null)
  // «Crea con il bot»: la chat con una richiesta precompilata (il meccanismo
  // di fase pagine G4 — composerPrefill — consumato dal composer di Chat)
  const setComposerPrefill = useStore((s) => s.setComposerPrefill)

  const refreshInstalled = async (): Promise<void> => {
    try {
      const r = await api.connectorsInstalled() as unknown as { servers: InstalledServerLike[]; plugins: InstalledPluginLike[] }
      setInstalled({ servers: r.servers, plugins: r.plugins })
    } catch {
      setInstalled({ servers: [], plugins: [] })
    }
  }
  const reloadSkills = (): void => {
    void api.skillsLibrary().then((r) => setSkills(r.library)).catch(() => setSkills([]))
  }
  useEffect(() => {
    void refreshConnectors()
    void refreshComposioGateway()
    void refreshInstalled()
    reloadSkills()
  }, [refreshConnectors, refreshComposioGateway])

  // il modello del catalogo: le stesse righe, gli stessi filtri di oggi
  const staticReady = useMemo(
    () => new Set(connectors.filter((c) => c.clientRegistration === 'static' && c.hasStaticCredentials).map((c) => c.id)),
    [connectors]
  )
  const apps = useMemo(() => loadAppCatalog({ staticClientsReady: staticReady }), [staticReady])
  const catalogFilter: AppsFilter = seg === 'connectors' ? category : 'all'
  const model = useMemo(
    () => appsCatalogModel({ apps, connectors, composio, composioGateway, filter: catalogFilter, query, lang }),
    [apps, connectors, composio, composioGateway, catalogFilter, query, lang]
  )

  // le righe di «I tuoi»: connettori collegati, server MCP, plugin, skill
  const yourRows = useMemo(
    () => yourPlugins({
      connectedApps: model.connectedRows,
      composio,
      composioGateway,
      installed,
      skills,
      agents,
      query: seg === 'connectors' ? '' : query
    }),
    [model, composio, composioGateway, installed, skills, agents, query, seg]
  )

  const flows = useConnectFlows(model.rows)

  // il punto di un rimando si consuma QUI (una volta sola all'apertura)
  const pluginAt = useStore((s) => s.pluginAt)
  useEffect(() => {
    const at = pluginAt as PluginPoint | null
    if (!at) return
    useStore.setState({ pluginAt: null })
    if (at.kind === 'mcp') { setView('mcp'); setSeg('all') }
    else if (at.kind === 'skill-new') { setView('skill-new'); setSeg('skills') }
    else if (at.kind === 'segment') { setView('list'); setSeg(at.seg) }
    else if (at.kind === 'app') { setView('list'); setSeg('connectors'); setAppDetailId(at.appId) }
    else if (at.kind === 'server') {
      setView('list')
      const sv = installed?.servers.find((s) => s.id === at.serverId)
      if (sv) setLinkedDetail({ kind: 'connected', key: `server:${sv.id}`, source: 'server', id: sv.id, name: sv.name, logo: '', botsLabel: { all: true, names: [], extra: 0 }, status: 'connected', via: 'direct' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginAt])

  /** Il clic su una riga di «I tuoi»: ogni riga apre la sua scheda (i pezzi di oggi). */
  const openRow = (row: YourPluginRow): void => {
    const target = row.open
    if (target.kind === 'app') {
      setSeg('connectors')
      setAppDetailId(target.appId)
    } else if (target.kind === 'server') {
      const sv = installed?.servers.find((s) => s.id === target.serverId)
      if (sv) setLinkedDetail({
        kind: 'connected', key: `server:${sv.id}`, source: 'server', id: sv.id, name: sv.name, logo: '',
        botsLabel: { all: true, names: [], extra: 0 }, status: 'connected', via: 'direct'
      })
    } else if (target.kind === 'plugin') {
      const p = installed?.plugins.find((x) => x.name === target.name)
      if (p) setLinkedDetail({
        kind: 'connected', key: `plugin:${p.marketplace}/${p.name}`, source: 'plugin', id: p.name, name: p.name, logo: '',
        botsLabel: { all: true, names: [], extra: 0 }, status: 'connected', via: 'direct'
      })
    } else {
      setSkillDetail(target.folder)
    }
  }

  const appDetail = appDetailId ? (model.rows.find((r) => r.app.id === appDetailId) ?? null) : null
  const rowGrid = 'grid grid-cols-1 gap-1.5 lg:grid-cols-2 lg:gap-x-8'
  const segments: Array<[PluginSegment, string]> = [
    ['all', t`Tutto`],
    ['connectors', t`Connettori`],
    ['skills', t`Skill`],
    ['connected', t`Collegati · ${yourRows.length}`]
  ]

  // ---- le viste interne: i server MCP (form e import di oggi), l'editor ----
  if (view === 'mcp') {
    return (
      <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background px-8 py-6" data-testid="plugin-page">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <div className="flex items-center gap-2">
            <button
              className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t`Torna ai plugin`}
              onClick={() => setView('list')}
            >
              <ChevronLeft className="size-4" />
            </button>
            <h1 className="font-display text-2xl"><Trans>Server MCP</Trans></h1>
          </div>
          <div className="min-h-0 flex-1">
            <ManualServers />
          </div>
        </div>
      </div>
    )
  }
  if (view === 'skill-new') {
    return (
      <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background px-8 py-6" data-testid="plugin-page">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <div className="flex items-center gap-2">
            <button
              className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label={t`Torna ai plugin`}
              onClick={() => setView('list')}
            >
              <ChevronLeft className="size-4" />
            </button>
            <h1 className="font-display text-2xl"><Trans>Crea una skill</Trans></h1>
          </div>
          <div className="min-h-0 flex-1">
            <SkillEditor folder={null} onDone={() => { reloadSkills() }} onCancel={() => setView('list')} />
          </div>
        </div>
      </div>
    )
  }

  // ---- la pagina: testata, ricerca, segmenti, Aggiungi ----
  return (
    <div className="no-drag absolute inset-0 z-20 flex flex-col bg-background px-8 py-6" data-testid="plugin-page">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label={t`Torna alla chat`}
            onClick={() => { setSkillsFilterAgent(null); setPluginOpen(false) }}
          >
            <ChevronLeft className="size-4" />
          </button>
          <Puzzle className="size-5 text-muted-foreground" aria-hidden="true" />
          <h1 className="font-display text-2xl"><Trans>Plugin</Trans></h1>
        </div>
        <p className="text-sm text-muted-foreground">
          <Trans>Connettori, server MCP e skill: tutto quello che dà capacità ai tuoi bot, in un posto.</Trans>
        </p>

        {/* la ricerca e i segmenti (tavola 8) */}
        <label className="flex h-10 items-center gap-2.5 rounded-full bg-muted px-4 text-sm text-muted-foreground">
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            data-testid="plugin-search"
            placeholder={t`Cerca tra plugin e skill`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-segments">
          {segments.map(([s, label]) => (
            <FilterPill key={s} active={seg === s} onClick={() => setSeg(s)}>{label}</FilterPill>
          ))}
          <span className="flex-1" />
          {/* il menu «Aggiungi ▾» con i sei percorsi di oggi */}
          <div className="relative">
            <button
              className="flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              data-testid="plugin-add"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((o) => !o)}
            >
              <Trans>Aggiungi</Trans> <ChevronDown className="size-3.5" />
            </button>
            {/* il menu sta SEMPRE nel DOM (nascosto quando chiuso): le sonde
                lo aprono col clic, i test lo leggono senza clic */}
            <div
              className={`absolute right-0 top-full z-30 mt-1.5 flex w-72 flex-col gap-0.5 rounded-2xl bg-card p-1.5 shadow-soft ${addOpen ? '' : 'hidden'}`}
              data-testid="plugin-add-menu"
            >
                <button
                  className="rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted"
                  onClick={() => { setAddOpen(false); setView('mcp') }}
                >
                  <span className="block"><Trans>Importa da altre app</Trans></span>
                  <span className="block text-[11px] text-muted-foreground"><Trans>Cursor, Codex, ZCode…</Trans></span>
                </button>
                <button
                  className="rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted"
                  onClick={() => { setAddOpen(false); setView('mcp') }}
                >
                  <Trans>Server MCP personalizzato</Trans>
                </button>
                <button
                  className="rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted"
                  data-testid="plugin-add-skill-import"
                  onClick={() => { setAddOpen(false); setSeg('skills') }}
                >
                  <Trans>Importa skill</Trans> <span className="text-[11px] text-muted-foreground"><Trans>(cartella SKILL.md)</Trans></span>
                </button>
                <div className="my-1 h-px bg-border/60" aria-hidden="true" />
                <button
                  className="rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted"
                  onClick={() => { setAddOpen(false); setView('skill-new') }}
                >
                  <Trans>Crea una skill</Trans>
                </button>
                <button
                  className="rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted"
                  onClick={() => {
                    setAddOpen(false)
                    setPluginOpen(false)
                    // la richiesta precompilata nella chat (il meccanismo G4)
                    setComposerPrefill(t`Crea una skill che `)
                  }}
                >
                  <Trans>Crea con il bot</Trans>
                </button>
                <div className="my-1 h-px bg-border/60" aria-hidden="true" />
                <button
                  className="rounded-xl px-3 py-2 text-left text-[13px] transition hover:bg-muted"
                  onClick={() => { setAddOpen(false); document.getElementById('plugin-advanced')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
                >
                  <Trans>Aggiungi un marketplace</Trans>
                </button>
              </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin pb-6">
          {/* --- TUTTO: I tuoi · Consigliati · Categorie --- */}
          {seg === 'all' && (
            <>
              <section className="mt-2" data-testid="plugin-yours">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-[15px] font-medium"><Trans>I tuoi</Trans></h2>
                  <button className="text-[12px] text-muted-foreground transition hover:text-foreground" onClick={() => setSeg('connected')}>
                    <Trans>Vedi i collegati →</Trans>
                  </button>
                </div>
                {yourRows.length === 0 ? (
                  <p className="py-3 text-sm text-muted-foreground">
                    <Trans>Nulla di collegato: comincia dai consigliati qui sotto.</Trans>
                  </p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {yourRows.map((row) => (
                      <YourRow key={row.key} row={row} lang={lang} onOpen={() => openRow(row)} />
                    ))}
                  </div>
                )}
              </section>

              {model.featured.length > 0 && !query && (
                <section className="mt-6">
                  <h2 className="text-[15px] font-medium"><Trans>Consigliati per il tuo lavoro</Trans></h2>
                  <div className={`mt-2 ${rowGrid}`}>
                    {model.featured.map((r) => (
                      <AppRow
                        key={r.app.id}
                        row={r}
                        flow={flows.flowOf(r)}
                        onConnect={(x) => void flows.connect(x)}
                        onCancel={(x) => void flows.cancel(x)}
                        onConflictResolve={(x) => void flows.onConflictResolve(x)}
                        onOpen={(x) => setAppDetailId(x.app.id)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {!query && (
                <section className="mt-6" data-testid="plugin-categories">
                  <h2 className="text-[15px] font-medium"><Trans>Categorie</Trans></h2>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {model.categoriesPresent.map((c) => (
                      <button
                        key={c}
                        className="rounded-full bg-muted px-3 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground"
                        data-testid={`plugin-category-${c}`}
                        onClick={() => { setCategory(c as AppCategoryId); setSeg('connectors') }}
                      >
                        {appCategoryLabel(c, lang)}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {/* --- CONNETTORI: il catalogo di oggi (righe e flussi riusati) --- */}
          {seg === 'connectors' && (
            <section className="mt-2" data-testid="plugin-connectors">
              <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-connector-filters">
                <FilterPill active={category === 'all'} onClick={() => setCategory('all')}><Trans>Tutte</Trans></FilterPill>
                {model.categoriesPresent.map((c) => (
                  <FilterPill key={c} active={category === c} onClick={() => setCategory(c)}>{appCategoryLabel(c, lang)}</FilterPill>
                ))}
              </div>
              <div className={`mt-3 ${rowGrid}`}>
                {(model.grid ?? model.rows).map((r) => (
                  <AppRow
                    key={r.app.id}
                    row={r}
                    flow={flows.flowOf(r)}
                    onConnect={(x) => void flows.connect(x)}
                    onCancel={(x) => void flows.cancel(x)}
                    onConflictResolve={(x) => void flows.onConflictResolve(x)}
                    onOpen={(x) => setAppDetailId(x.app.id)}
                  />
                ))}
              </div>
              {(model.grid ?? model.rows).length === 0 && (
                <p className="py-3 text-sm text-muted-foreground"><Trans>Nessuna app trovata. Prova con un altro nome.</Trans></p>
              )}
            </section>
          )}

          {/* --- SKILL: la libreria di oggi, in casa (PL5 le completa) --- */}
          {seg === 'skills' && (
            <section className="mt-2 space-y-1.5" data-testid="plugin-skills">
              {skillsFilterAgent && (
                <button
                  type="button"
                  className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground"
                  onClick={() => setSkillsFilterAgent(null)}
                >
                  {agents.find((a) => a.id === skillsFilterAgent)?.name ?? skillsFilterAgent} ✕
                </button>
              )}
              {yourRows.filter((r) => r.kind === 'skill').length === 0 && (
                <p className="py-3 text-sm text-muted-foreground"><Trans>Nessuna skill. Creane una, importala, o chiedi a un bot di salvarne una.</Trans></p>
              )}
              {yourRows.filter((r) => r.kind === 'skill').map((row) => (
                <YourRow key={row.key} row={row} lang={lang} onOpen={() => openRow(row)} />
              ))}
            </section>
          )}

          {/* --- COLLEGATI: l'elenco completo (la tabella arriva in PL3) --- */}
          {seg === 'connected' && (
            <section className="mt-2 space-y-1.5" data-testid="plugin-connected">
              {yourRows.map((row) => (
                <YourRow key={row.key} row={row} lang={lang} onOpen={() => openRow(row)} />
              ))}
            </section>
          )}

          {/* --- AVANZATE: gateway, marketplace, registro, chiave (per sviluppatori) --- */}
          <section className="mt-8" id="plugin-advanced" data-testid="plugin-advanced">
            <div className="rounded-3xl bg-muted/40 p-5">
              <DevelopersContent scrollTo={null} />
            </div>
          </section>

          {/* la frase della strada più diretta (tavola 8, in fondo) */}
          <p className="mt-6 text-center text-[12px] leading-relaxed text-muted-foreground">
            <Trans>Prima la strada più diretta. Per ogni servizio Homun usa, in quest'ordine: il server del fornitore, un server verificato nel computer isolato, e Composio solo per i servizi che non ne hanno uno.</Trans>
          </p>
        </div>
      </div>

      {/* i fogli riusati di oggi */}
      {appDetail && (
        <AppDetailSheet
          row={appDetail}
          installed={installed}
          onClose={() => setAppDetailId(null)}
          onChanged={() => { void refreshConnectors(); void refreshInstalled(); reloadSkills() }}
          onConnect={(r) => { setAppDetailId(null); void flows.connect(r) }}
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
      {skillDetail !== null && (
        <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={() => setSkillDetail(null)}>
          <div className="@container max-h-[85vh] w-full max-w-2xl overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="plugin-skill-detail">
            <SkillEditor folder={skillDetail} onDone={() => reloadSkills()} onCancel={() => setSkillDetail(null)} embedded />
          </div>
        </div>
      )}
    </div>
  )
}

/** Una riga di «I tuoi»: logo, nome, verificato se lo è, la riga grigia
 *  «tipo · strada · origine» e a destra lo stato con l'azione. */
function YourRow({ row, lang, onOpen }: {
  row: YourPluginRow
  lang: 'it' | 'en'
  onOpen(): void
}): ReactNode {
  const { t } = useLingui()
  const st = stateLabelOf(row.state, lang)
  const url = row.kind === 'server' || row.kind === 'plugin' ? logoUrlForName(row.name) : null
  const bots =
    row.bots.all ? t`Tutti i bot`
    : row.bots.names.length === 0 ? t`nessun bot`
    : row.bots.extra > 0 ? t`${row.bots.names.join(', ')} +${row.bots.extra}`
    : row.bots.names.join(', ')
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-[14px] px-1 py-2 text-left transition hover:bg-muted/60"
      data-testid={`plugin-row-${row.key}`}
      onClick={onOpen}
    >
      {url
        ? <img src={url} alt="" className="size-10 shrink-0 rounded-[11px] object-cover dark:bg-white" />
        : <AppLogo logo={row.logo} name={row.kind === 'skill' ? humanizeSkillName(row.name) : row.name} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[15px]">{row.kind === 'skill' ? humanizeSkillName(row.name) : row.name}</span>
          {row.verified && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground" title={t`verificato`}>
              <BadgeCheck className="size-3.5" aria-hidden="true" />
              <Trans>verificato</Trans>
            </span>
          )}
        </span>
        {/* la riga grigia: tipo · strada · origine */}
        <span className="block truncate text-[13px] text-muted-foreground" data-testid={`plugin-gray-${row.key}`}>{grayLineOf(row, lang)}</span>
        <span className="block truncate text-[11px] text-muted-foreground/80">{bots}</span>
      </span>
      {/* lo stato con l'azione (tavola 8) */}
      <span className={`shrink-0 text-[13px] ${row.state === 'active' ? 'text-chart-2' : row.state === 'broken' || row.state === 'invalid' ? 'text-destructive' : 'text-foreground'}`}>
        {st.label}{st.action === 'why' ? ` · ${t`Vedi perché`}` : st.action === 'reconnect' ? ` · ${t`Ricollega`}` : st.action === 'setup' ? ` · ${t`Completa`}` : ''}
      </span>
    </button>
  )
}
