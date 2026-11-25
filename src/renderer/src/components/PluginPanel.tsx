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
//
// Fase design (DS4): la pagina passa al sistema. Cosa cambia, e perché:
//  - IL GUSCIO è PageShell (PluginShell non c'è più): il corpo che scorre è
//    largo quanto l'area — la barra di scorrimento sta sul bordo della
//    finestra, non attaccata alla colonna — e solo DENTRO il contenuto è
//    centrato alla larghezza scelta. La testata è PageHeader: la riga dei
//    52 px uguale a quella di ogni colonna, indietro · icona · titolo di
//    pagina (text-page) · «Aggiungi».
//  - LE LARGHEZZE sono quelle di DS1: 880 (page) per la pagina e le viste
//    interne, 1120 (wide) solo sul segmento «Collegati», dove c'è la
//    tabella. Testata e barra degli strumenti sono le stesse: cambia la
//    sola colonna (width è una prop dello stesso guscio: niente salto).
//  - LA BARRA DEGLI STRUMENTI è una riga sola alta 40, come in ogni pagina:
//    i segmenti a sinistra (la loro sottolineatura corre fino alla ricerca)
//    e la ricerca a destra. Prima erano due righe scritte qui (una pillola
//    larga quanto la colonna, poi i segmenti): ogni pagina aveva la sua
//    testata di altezza diversa.
//  - «COLLEGATI» è la tabella unica (DataTable): intestazioni text-caption
//    grigie in tono normale, righe da 52, filetti, e NIENTE A CAPO nelle
//    celle — il valore intero sta nel suggerimento. Prima: maiuscoletto, e
//    il testo andava a capo («Tutti i / bot», «tramite / Composio»).
//  - LE SEZIONI sono Section: il titolo è un'etichetta (text-caption grigio)
//    e lo scarto fra una sezione e l'altra lo decide la pagina una volta
//    (gap-section), non ogni sezione per conto suo (mt-8 ovunque).
//  - LE SCADE non vanno mai a capo: se non entrano scorrono da sole. Il
//    catalogo delle skill e i filtri di «Collegati» chiedevano flex-wrap, e
//    a 1280 le categorie finivano su due righe.
//  - I SEGNI scritti a mano (✦, ✕) sono icone lucide: nell'interfaccia ci
//    sono solo icone.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { BadgeCheck, ChevronDown, Puzzle, Search, Sparkles, X } from 'lucide-react'
import { api, useStore, type PluginCardTab, type PluginPoint } from '../store'
import { i18n } from '../lib/i18n'
import { loadAppCatalog, appCategoryLabel, type AppCategoryId } from '../../../shared/app-catalog'
import type { McpServerInfo, SkillLibraryItem, SkillCatalogEntry } from '../../../shared/types'
import { appsCatalogModel, type AppsFilter, type InstalledPluginLike, type CatalogRowView } from '../lib/apps-view'
import { yourPlugins, grayLineOf, stateLabelOf, stradaLabel, stradaColumnWidth, connectedTable, daSistemareCount, type PluginSegment, type YourPluginRow, type ConnectedFilter, type ConnectedTableRow } from '../lib/plugins-view'
import type { PermissionsConfig } from '../../../shared/types'
import { humanizeSkillName } from '../../../shared/skill-md'
import { Toggle } from './Settings'
import { AppRow, AppLogo, useConnectFlows, DevelopersContent } from './AppsWindow'
// Fase design (DS2): il guscio di OGNI pagina a tutta area e la sua testata — al posto di PluginShell
import { PageShell } from './ui/page-shell'
import { PageHeader } from './ui/page-header'
// PP4 (fase plugin-pulita): righe a filo e schede come testo — meno contenitori, un solo segnale di stato
import { FlatList, FlatRow } from './ui/flat-list'
import { UnderlineTabs } from './ui/underline-tabs'
// Fase design (DS2): la tabella unica, la sezione, il bottone unico
import { DataTable, Cell, CellStack, type DataTableColumn } from './ui/data-table'
import { Section } from './ui/section'
import { Button } from './ui/button'
// PL2 (fase plugin): la scheda del plugin (tavola 9) — clic su una riga
import { PluginCard } from './PluginCard'
import { ManualServers } from './plugin/manual-servers'
// PL5 → C0 (fase linguaggio): l'editor, il dettaglio delle skill di plugin e
// l'anteprima del catalogo — riusati, ognuno nel suo file di plugin/
import { SkillEditor } from './plugin/skill-editor'
import { PluginDetail } from './plugin/plugin-detail'
import { CatalogPreview } from './plugin/catalog-preview'
import { SKILL_CATEGORIES, searchSkillCatalog, skillCatalogDescription, skillCatalogInstallState, type SkillCategoryId } from '../../../shared/skill-catalog'
import { humanizeSkillName as humanize } from '../../../shared/skill-md'
import { logoUrlForName, LOGO_CLASS } from '../lib/app-logos'

/** La lingua attiva come 'it' | 'en'. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

/** La vista interna della pagina: l'elenco, i server MCP, l'editor di una skill. */
type PluginView = 'list' | 'mcp' | 'skill-new' | 'skill-import'

/** I dati iniziali (per i test senza effect; nel prodotto si caricano dall'api). */
export interface PluginPanelInitial {
  installed?: { servers: McpServerInfo[]; plugins: InstalledPluginLike[] }
  usage?: Array<{ tool: string; last: number; week: number }>
  perms?: PermissionsConfig
  skills?: SkillLibraryItem[]
  /** PL5: le skill dei plugin */
  pluginSkills?: Array<{ plugin: string; skills: Array<{ name: string; description: string }> }>
  /** PL5: il catalogo skill (nei test senza effect) */
  skillCatalog?: SkillCatalogEntry[]
  /** PL6: le righe dell'import skill (nei test senza effect) */
  importRows?: Array<{ name: string; description: string; sources: string[]; valid: boolean; existing: boolean; files: string[] }>
  /** la vista di partenza (nei test senza clic) */
  view?: PluginView
  /** il segmento di partenza (nei test senza clic; nei prodotti decide pluginAt) */
  seg?: PluginSegment
  /** PP2: la scheda aperta fin dal primo render (nei test senza effect; nei prodotti decide pluginAt) */
  card?: { appId?: string; serverId?: string; tab?: PluginCardTab }
}

/** Le voci del menu «Aggiungi», scritte a mano: il raggio è quello delle celle selezionate (8 px), il testo di riga. */
const MENU_ITEM = 'rounded-control px-3 py-2 text-left text-body transition hover:bg-muted'
/** Il filetto che divide i gruppi del menu «Aggiungi». */
const MENU_DIVIDER = <div className="my-1 h-px bg-border/60" aria-hidden="true" />

/**
 * Le sette colonne di «Collegati» (tavola 10), per la tabella unica.
 *
 * LE LARGHEZZE. Le due colonne col testo lungo e variabile — il nome col
 * comando, l'ultimo uso — crescono e si dividono lo spazio che resta; le
 * altre sono fisse e larghe quanto il loro valore più lungo CHE SI VEDE
 * SPESSO: il badge più lungo («nel computer isolato»), «accesso scaduto»,
 * «Tutti i bot», «1 sempre · 1 blocca». Ciò che capita più raramente (un
 * accesso scaduto da Homun detto per intero, l'elenco dei bot, una email)
 * si tronca, col valore intero nel suggerimento: è la regola della tabella
 * (niente a capo), non una misura tirata.
 *
 * PERCHÉ questi numeri: al minimo la tabella è 940 px (620 fissi + 160 × 2).
 * Ci sta senza scorrere in una finestra di 1280 con la barra di sinistra
 * alla sua larghezza di default (264: l'area è 1016, il contenuto 940).
 * Sotto — e la finestra di default è 1200, o la barra si può allargare —
 * scorre DENTRO la tabella, mai nella pagina; quel che esce è la coda
 * dell'ultimo uso, che cresce per ultimo.
 *
 * I COLORI: nome e stato sono testo di riga (chi va bene è grigio, chi non
 * va è rosso: PP4, un solo segnale); account, permessi, bot e ultimo uso
 * sono dettagli, la riga grigia piccola (text-small).
 */
function connectedColumns(lang: 'it' | 'en', rows: ReadonlyArray<ConnectedTableRow>): Array<DataTableColumn<ConnectedTableRow>> {
  // R4 (b20-ritocchi): la colonna è larga quanto la pillola più lunga PRESENTE
  const stradaWidth = stradaColumnWidth(rows.map((r) => stradaLabel(r.row.gray.strada, r.row.gray.origin, lang)))
  return [
    {
      id: 'collegamento',
      grow: true,
      header: <Trans>Collegamento</Trans>,
      cell: (r) => (
        <CellStack
          leading={<RowLogo row={r.row} name={r.row.name} className="size-8 text-body" />}
          primary={r.row.name}
          secondary={r.countLabel ?? undefined}
          // R4: il nome del comando nella riga, il percorso intero al passaggio
          secondaryTitle={r.row.countTitle}
        />
      )
    },
    {
      id: 'strada',
      width: stradaWidth,
      header: <Trans>Strada</Trans>,
      cell: (r) => {
        const label = stradaLabel(r.row.gray.strada, r.row.gray.origin, lang)
        return (
          // R4 (b20-ritocchi): la pillola mostra il nome INTERO e non trona MAI.
          // E niente «inline-block»: col token --spacing-block la classe genera
          // ANCHE inline-size: var(--spacing-block) = 16 px, e la pillola si
          // schiacciava a una «s» in un cerchio (la colonna, non lei, è larga
          // quanto serve)
          <Cell>
            <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-caption ${stradaBadgeClass(r.row.gray.strada)}`} title={label}>{label}</span>
          </Cell>
        )
      }
    },
    { id: 'account', width: 96, header: <Trans>Account</Trans>, cell: (r) => <Cell secondary>{r.row.accountLabel || '—'}</Cell> },
    {
      id: 'stato',
      width: 136,
      header: <Trans>Stato</Trans>,
      // PP4: lo stato in parole solo quando non va è per le righe; qui c'è la colonna — ma il verde non serve: chi va bene è grigio, chi non va è rosso
      cell: (r) => {
        const label = stateLabelOf(r.row.state, lang).label
        return (
          <Cell>
            <span className={r.daSistemare ? 'text-destructive' : 'text-muted-foreground'} title={label}>{label}</span>
          </Cell>
        )
      }
    },
    { id: 'permessi', width: 132, header: <Trans>Permessi</Trans>, cell: (r) => <Cell secondary>{permBriefOf(r.perms)}</Cell> },
    // (fuori dal componente non c'è t: la traduzione passa da i18n._, come in permBriefOf e useBriefOf)
    { id: 'bot', width: 96, header: <Trans>Bot</Trans>, cell: (r) => <Cell secondary>{r.row.bots.all ? i18n._(msg`Tutti i bot`) : r.row.bots.names.length > 0 ? r.row.bots.names.join(', ') : '—'}</Cell> },
    { id: 'ultimo-uso', grow: true, header: <Trans>Ultimo uso</Trans>, cell: (r) => <Cell secondary>{useBriefOf(r.usage)}</Cell> }
  ]
}

/**
 * La pagina Plugin. Il punto chiesto da un rimando (`pluginAt`) si consuma
 * qui: la card «Apri Server MCP» arriva ai server MCP, il suggerimento del
 * pannello all'app giusta, la riga Skill alle skill del bot.
 */
export function PluginPanel({ initial }: { initial?: PluginPanelInitial }): ReactNode {
  const { t } = useLingui()
  const lang = uiLang()
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const composio = useStore((s) => s.composio)
  const refreshComposio = useStore((s) => s.refreshComposio)
  const composioGateway = useStore((s) => s.composioGateway)
  const refreshComposioGateway = useStore((s) => s.refreshComposioGateway)
  const agents = useStore((s) => s.agents)
  const skillsFilterAgent = useStore((s) => s.skillsFilterAgent)
  const setSkillsFilterAgent = useStore((s) => s.setSkillsFilterAgent)
  const setPluginOpen = useStore((s) => s.setPluginOpen)

  const [seg, setSeg] = useState<PluginSegment>(initial?.seg ?? 'all')
  const [query, setQuery] = useState('')
  const [view, setView] = useState<PluginView>(initial?.view ?? 'list')
  const [category, setCategory] = useState<AppsFilter>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [installed, setInstalled] = useState<{ servers: McpServerInfo[]; plugins: InstalledPluginLike[] } | null>(initial?.installed ?? null)
  const [skills, setSkills] = useState<SkillLibraryItem[] | null>(initial?.skills ?? null)
  // PL5: le skill dei plugin e il catalogo (Sfoglia) — la ricerca e le categorie valgono anche per loro
  const [pluginSkills, setPluginSkills] = useState<Array<{ plugin: string; skills: Array<{ name: string; description: string }> }> | null>(initial?.pluginSkills ?? null)
  // PL6: l'import delle skill dalle altre app — la scansione parte SOLO al
  // clic del bottone (mai all'avvio); il clic del menù chiama la scan
  const [importRows, setImportRows] = useState<Array<{ name: string; description: string; sources: string[]; valid: boolean; existing: boolean; files: string[] }> | null>(initial?.importRows ?? null)
  const [importPicks, setImportPicks] = useState<Record<string, boolean>>({})
  const [importMode, setImportMode] = useState<'copy' | 'link'>('copy')
  const [importDirs, setImportDirs] = useState<Array<{ source: string; dir: string }>>([])
  const [catalog, setCatalog] = useState<SkillCatalogEntry[] | null>(initial?.skillCatalog ?? null)
  const [catalogId, setCatalogId] = useState<string | null>(null)
  const [skillCatFilter, setSkillCatFilter] = useState<'all' | SkillCategoryId>('all')
  // PL3: l'uso dall'INDICE (mai i transcript) e le regole per i «permessi in breve»
  const [usage, setUsage] = useState<Array<{ tool: string; last: number; week: number }> | null>(initial?.usage ?? null)
  const [perms, setPerms] = useState<PermissionsConfig | null>(initial?.perms ?? null)
  const [connFilter, setConnFilter] = useState<ConnectedFilter>('all')
  const [onlyDaSistemare, setOnlyDaSistemare] = useState(false)
  // PL2: la scheda del plugin (tavola 9) — si ricordano gli ID e gli oggetti
  // si cercano a OGNI render (vivi: un toggle che cambia enabledFor si vede)
  const [card, setCard] = useState<{ appId?: string; serverId?: string; tab?: PluginCardTab } | null>(initial?.card ?? null)
  // A4 (fase approvazioni-chiare): «Per sviluppatori» in fondo — CHIUSO di default
  const [developersOpen, setDevelopersOpen] = useState(false)
  const [skillDetail, setSkillDetail] = useState<string | null>(null)
  // «Crea con il bot»: la chat con una richiesta precompilata (il meccanismo
  // di fase pagine G4 — composerPrefill — consumato dal composer di Chat)
  const setComposerPrefill = useStore((s) => s.setComposerPrefill)

  /** PL6: la scansione delle skill delle altre app — SOLO qui, al clic. */
  const runImportScan = async (): Promise<void> => {
    const scan = await api.skillsImportScan(importDirs.length ? importDirs : undefined).catch(() => ({ rows: [] as never[] }))
    setImportRows(scan.rows)
    setImportPicks({})
  }

  const refreshInstalled = async (): Promise<void> => {
    try {
      const r = await api.connectorsInstalled() as unknown as { servers: McpServerInfo[]; plugins: InstalledPluginLike[] }
      setInstalled({ servers: r.servers, plugins: r.plugins })
    } catch {
      setInstalled({ servers: [], plugins: [] })
    }
  }
  const reloadSkills = (): void => {
    void api.skillsLibrary().then((r) => { setSkills(r.library); setPluginSkills(r.plugins) }).catch(() => { setSkills([]); setPluginSkills([]) })
  }
  useEffect(() => {
    void refreshConnectors()
    void refreshComposioGateway()
    void refreshInstalled()
    reloadSkills()
    // PL3: l'aggregato indicizzato dell'uso + le regole scritte
    void api.pluginsUsage().then(setUsage).catch(() => setUsage([]))
    void api.getPermissions().then(setPerms).catch(() => setPerms(null))
    // PL5: il catalogo curato (nessuna rete, arriva dal repo)
    void api.skillsCatalog().then(setCatalog).catch(() => setCatalog([]))
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
      pluginSkills,
      agents,
      query: seg === 'connectors' ? '' : query
    }),
    [model, composio, composioGateway, installed, skills, agents, query, seg]
  )
  // le righe di «Collegati» (PL3): le stesse di «I tuoi», coi filtri della tabella
  const connectedRows = useMemo(
    () => connectedTable({ rows: yourRows, usage: usage ?? [], perms, filter: connFilter, onlyDaSistemare }),
    [yourRows, usage, perms, connFilter, onlyDaSistemare]
  )
  // le righe del catalogo: con una ricerca o un filtro è UNA griglia, altrimenti l'elenco (Connesse, poi le sezioni)
  const catalogList = model.grid ?? model.rows

  const flows = useConnectFlows(model.rows)

  // PL5: le righe del catalogo skill (la ricerca del campo in alto filtra anche questo)
  const catalogRows = useMemo(() => {
    const found = searchSkillCatalog(catalog ?? [], query, lang)
    return skillCatFilter === 'all' ? found : found.filter((e) => e.category === skillCatFilter)
  }, [catalog, query, lang, skillCatFilter])
  const catalogEntrySel = catalogId !== null ? (catalog ?? []).find((e) => e.id === catalogId) ?? null : null

  // il punto di un rimando si consuma QUI (una volta sola all'apertura)
  const pluginAt = useStore((s) => s.pluginAt)
  useEffect(() => {
    const at = pluginAt as PluginPoint | null
    if (!at) return
    useStore.setState({ pluginAt: null })
    if (at.kind === 'mcp') { setView('mcp'); setSeg('all') }
    else if (at.kind === 'skill-new') { setView('skill-new'); setSeg('skills') }
    else if (at.kind === 'segment') { setView('list'); setSeg(at.seg) }
    else if (at.kind === 'app') {
      setView('list'); setSeg('connectors')
      setCard({ appId: at.appId })
    }
    else if (at.kind === 'server') {
      setView('list')
      // PP2: la scheda interna chiesta dal rimando (la Cassaforte: «Account e bot»), altrimenti la Panoramica
      setCard({ serverId: at.serverId, ...(at.tab ? { tab: at.tab } : {}) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginAt])

  /** Il clic su una riga di «I tuoi»: ogni riga apre la sua scheda (PL2).
   *  PP4: `tab` è la scheda interna su cui aprirla — le azioni «Ricollega» e
   *  «Completa» della riga portano dove si fa, «Account e bot». */
  const openRow = (row: YourPluginRow, tab?: PluginCardTab): void => {
    const target = row.open
    if (target.kind === 'app') {
      setSeg('connectors')
      setCard({ appId: target.appId, ...(tab ? { tab } : {}) })
    } else if (target.kind === 'server') {
      setCard({ serverId: target.serverId, ...(tab ? { tab } : {}) })
    } else if (target.kind === 'plugin') {
      // il plugin mostra i suoi pezzi: la riga porta al suo server principale
      // quando c'è, altrimenti resta nell'elenco (onesto)
      const sv = installed?.servers.find((s) => s.source?.kind === 'plugin' && s.source.plugin === target.name)
      if (sv) setCard({ serverId: sv.id })
    } else {
      setSkillDetail(target.folder)
    }
  }
  /**
   * V5 (fase stato-vivo): l'interruttore Attivo di una riga — il server MCP
   * scrive enabled (OFF scrive disabledReason 'user', la parola
   * dell'utente; ON toglie il motivo e il test U5 parte da mcp:save, se
   * fallisce resta acceso con «non parte · Vedi perché»), il connettore
   * Composio scrive l'enabled della VOCE senza scollegare l'account, la
   * skill di libreria il suo enabled (spenta non entra nel prompt di nessun
   * bot). I plugin del marketplace passano dai loro server.
   */
  const toggleActive = (row: YourPluginRow, next: boolean): void => {
    const saveServer = (srv: McpServerInfo): void => {
      const { disabledReason: _r, ...rest } = srv
      void api.mcpSave(next ? { ...rest, enabled: true } : { ...rest, enabled: false, disabledReason: 'user' })
        .then(() => refreshInstalled())
        .catch(() => undefined)
    }
    const open = row.open
    if (open.kind === 'server') {
      const srv = installed?.servers.find((x) => x.id === open.serverId)
      if (srv) saveServer(srv)
    } else if (open.kind === 'app') {
      if (row.composioSlug) {
        void api.composioSetConnectorEnabled(row.composioSlug, next)
          .then(() => refreshComposio())
          .catch(() => undefined)
      } else {
        // connettore DIRETTO: l'interruttore è quello del suo server
        const srv = installed?.servers.find((x) => x.catalogId === open.appId)
        if (srv) saveServer(srv)
      }
    } else if (open.kind === 'skill' && row.gray.strada === 'skill') {
      void api.skillsSetEnabled(open.folder, next)
        .then(() => reloadSkills())
        .catch(() => undefined)
    }
  }
  // gli oggetti VIVI della scheda (cercati a ogni render: i toggle si vedono)
  const cardApp = card?.appId ? model.rows.find((r) => r.app.id === card.appId) ?? null : null
  const cardServer = card?.serverId ? installed?.servers.find((s) => s.id === card.serverId) ?? null : null
  // PP4: i segmenti in testa sono testo (UnderlineTabs): Tutto · Connettori · Skill · Collegati
  const segments: Array<[PluginSegment, string]> = [
    ['all', t`Tutto`],
    ['connectors', t`Connettori`],
    ['skills', t`Skill`],
    ['connected', t`Collegati · ${yourRows.length}`]
  ]
  // le skill di «I tuoi» (PL5): la libreria e quelle dei plugin
  const skillRows = useMemo(() => yourRows.filter((r) => r.kind === 'skill'), [yourRows])

  /** «Indietro» delle viste interne: alla lista (lo stesso bottone di PageHeader in ognuna). */
  const backToList = { onClick: () => setView('list'), label: t`Torna ai plugin` }

  // ---- le viste interne: i server MCP (form e import di oggi), l'editor ----
  // Fase design: tutte nello stesso guscio della pagina (PageShell), alla
  // larghezza di pagina: la riga dei 52 in cima è quella di ogni colonna.
  if (view === 'mcp') {
    return (
      <PageShell
        width="page"
        testId="plugin-page"
        z={20}
        header={<PageHeader back={backToList} title={<Trans>Server MCP</Trans>} />}
        contentClassName="pb-6"
      >
        <ManualServers />
      </PageShell>
    )
  }
  if (view === 'skill-import') {
    const rows = importRows ?? []
    const picked = rows.filter((r) => !r.existing && r.valid && importPicks[r.name] === true)
    return (
      <PageShell
        width="page"
        testId="plugin-page"
        z={20}
        header={<PageHeader back={{ onClick: () => { setView('list'); setSeg('skills'); setImportRows(null) }, label: t`Torna ai plugin` }} title={<Trans>Importa skill</Trans>} />}
        description={<Trans>Le cartelle con SKILL.md delle altre app che trovo sul tuo Mac. Si importano SOLO file di testo: nessuno script viene eseguito.</Trans>}
        contentClassName="pb-6"
      >
        <div className="flex flex-col gap-block" data-testid="plugin-skill-import">
          {importRows === null && <p className="text-small text-muted-foreground"><Trans>cerco…</Trans></p>}
          {importRows !== null && rows.length === 0 && (
            <div className="rounded-surface bg-muted p-4" data-testid="plugin-skill-import-empty">
              <p className="text-small text-muted-foreground"><Trans>Nessuna skill trovata nelle altre app.</Trans></p>
            </div>
          )}
          {rows.length > 0 && (
            <FlatList>
              {rows.map((r) => (
                // la riga È l'etichetta della casella: un clic ovunque la spunta (min-h-row: 52, come ogni riga con un'icona)
                <label
                  key={r.name}
                  className={`flex min-h-row cursor-pointer items-center gap-row-gap py-row-pad ${r.existing || !r.valid ? 'opacity-60' : ''}`}
                  data-testid="plugin-skill-import-row"
                >
                  <input
                    type="checkbox"
                    className="shrink-0 accent-foreground"
                    data-testid="plugin-skill-import-check"
                    checked={importPicks[r.name] === true}
                    disabled={r.existing || !r.valid}
                    onChange={(e) => setImportPicks({ ...importPicks, [r.name]: e.target.checked })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium">{r.name}</span>
                    <span className="mt-0.5 block truncate text-small text-muted-foreground">{r.description || '—'}</span>
                  </span>
                  <span className="shrink-0 text-caption text-muted-foreground">{r.sources.join(', ')}</span>
                  {r.existing && <span className="shrink-0 text-caption text-muted-foreground">{t`già presente`}</span>}
                </label>
              ))}
            </FlatList>
          )}
          {/* la cartella scelta dall'utente */}
          <Button
            variant="secondary"
            className="w-full"
            data-testid="plugin-skill-import-folder"
            onClick={async () => {
              const dir = await api.skillsImportPickFolder().catch(() => null)
              if (!dir) return
              const next = [...importDirs, { source: 'folder', dir }]
              setImportDirs(next)
              const scan = await api.skillsImportScan(next).catch(() => ({ rows: [] as never[] }))
              setImportRows(scan.rows)
            }}
          >
            <Trans>Scegli una cartella…</Trans>
          </Button>
          {/* copia oppure usa la cartella originale (sola lettura) */}
          <div className="flex flex-col gap-2 rounded-surface bg-muted p-4" data-testid="plugin-skill-import-mode">
            <label className="flex items-center gap-2 text-body">
              <input type="radio" name="plugin-skill-import-mode" className="shrink-0 accent-foreground" checked={importMode === 'copy'} onChange={() => setImportMode('copy')} />
              <span><Trans>Copia nella libreria di Homun</Trans></span>
            </label>
            <label className="flex items-center gap-2 text-body">
              <input type="radio" name="plugin-skill-import-mode" className="shrink-0 accent-foreground" checked={importMode === 'link'} onChange={() => setImportMode('link')} />
              <span><Trans>Usa la cartella originale</Trans> <span className="text-small text-muted-foreground"><Trans>(sola lettura: cambia con l'originale)</Trans></span></span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">{t`${picked.length} selezionate`}</span>
            <Button
              disabled={picked.length === 0}
              data-testid="plugin-skill-import-apply"
              onClick={async () => {
                const out = await api.skillsImportApply({
                  picks: picked.map((r) => ({ sources: r.sources, name: r.name })),
                  mode: importMode,
                  ...(importDirs.length ? { extraDirs: importDirs } : {})
                }).catch(() => [])
                void out
                setImportRows(null)
                setImportDirs([])
                reloadSkills()
                setView('list')
                setSeg('skills')
              }}
            >
              {t`Importa ${picked.length}`}
            </Button>
          </div>
        </div>
      </PageShell>
    )
  }

  if (view === 'skill-new') {
    return (
      <PageShell
        width="page"
        testId="plugin-page"
        z={20}
        header={<PageHeader back={backToList} title={<Trans>Crea una skill</Trans>} />}
        contentClassName="pb-6"
      >
        <SkillEditor folder={null} onDone={() => { reloadSkills() }} onCancel={() => setView('list')} />
      </PageShell>
    )
  }

  // ---- la pagina: testata, descrizione, barra degli strumenti, Aggiungi ----
  return (
    <>
    <PageShell
      // larga quanto la tabella SOLO su «Collegati»: negli altri segmenti la colonna è quella di pagina
      width={seg === 'connected' ? 'wide' : 'page'}
      testId="plugin-page"
      z={20}
      header={(
        <PageHeader
          back={{ onClick: () => { setSkillsFilterAgent(null); setPluginOpen(false) }, label: t`Torna alla chat` }}
          icon={<Puzzle className="size-5" />}
          title={<Trans>Plugin</Trans>}
          actions={(
            // il menu «Aggiungi ▾» con i sei percorsi di oggi — in testata, a
            // destra del titolo: PP4, l'unico bottone PIENO della pagina. La
            // fascia dei 52 trascina la finestra: bottone e menu portano no-drag
            <div className="no-drag relative">
              <Button
                size="sm"
                className="no-drag"
                aria-expanded={addOpen}
                data-testid="plugin-add"
                onClick={() => setAddOpen((o) => !o)}
              >
                <Trans>Aggiungi</Trans> <ChevronDown className="size-4" />
              </Button>
              {/* il menu sta SEMPRE nel DOM (nascosto quando chiuso): le sonde
                  lo aprono col clic, i test lo leggono senza clic */}
              <div
                className={`absolute right-0 top-full z-30 mt-1.5 flex w-72 flex-col gap-0.5 rounded-surface bg-card p-1 shadow-soft ${addOpen ? '' : 'hidden'}`}
                data-testid="plugin-add-menu"
              >
                <button className={MENU_ITEM} onClick={() => { setAddOpen(false); setView('mcp') }}>
                  <span className="block"><Trans>Importa da altre app</Trans></span>
                  <span className="block text-small text-muted-foreground"><Trans>Cursor, Codex, ZCode…</Trans></span>
                </button>
                <button className={MENU_ITEM} data-testid="plugin-add-mcp" onClick={() => { setAddOpen(false); setView('mcp') }}>
                  <Trans>Server MCP personalizzato</Trans>
                </button>
                <button className={MENU_ITEM} data-testid="plugin-add-skill-import" onClick={() => { setAddOpen(false); setView('skill-import'); void runImportScan() }}>
                  <span className="block"><Trans>Importa skill</Trans></span>
                  <span className="block text-small text-muted-foreground"><Trans>Cursor, Codex, ZCode, Claude Code…</Trans></span>
                </button>
                {MENU_DIVIDER}
                <button className={MENU_ITEM} onClick={() => { setAddOpen(false); setView('skill-new') }}>
                  <Trans>Crea una skill</Trans>
                </button>
                <button
                  className={MENU_ITEM}
                  onClick={() => {
                    setAddOpen(false)
                    setPluginOpen(false)
                    // la richiesta precompilata nella chat (il meccanismo G4)
                    setComposerPrefill(t`Crea una skill che `)
                  }}
                >
                  <Trans>Crea con il bot</Trans>
                </button>
                {MENU_DIVIDER}
                <button
                  className={MENU_ITEM}
                  onClick={() => { setAddOpen(false); setDevelopersOpen(true); document.getElementById('plugin-advanced')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
                >
                  <Trans>Aggiungi un marketplace</Trans>
                </button>
              </div>
            </div>
          )}
        />
      )}
      description={<Trans>Connettori, server MCP e skill: tutto quello che dà capacità ai tuoi bot, in un posto.</Trans>}
      toolbar={(
        <>
          {/* i segmenti (tavola 8) — PP4: sono testo. Prendono lo spazio che
              la ricerca lascia: la loro sottolineatura corre fino a lei, e se
              non entrano scorrono da sole (mai a capo) */}
          <div data-testid="plugin-segments" className="min-w-0 flex-1">
            <UnderlineTabs<PluginSegment> tabs={segments} value={seg} onChange={setSeg} label={t`Visualizza`} />
          </div>
          {/* la ricerca: un campo, 36 px come tutti (prima una pillola alta 40) */}
          <label className="flex h-control w-72 shrink-0 items-center gap-2 rounded-control bg-muted px-4 text-body text-muted-foreground">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              className="min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground"
              data-testid="plugin-search"
              placeholder={t`Cerca tra plugin e skill`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </>
      )}
      contentClassName="flex flex-col gap-section pb-6"
    >
      {/* --- TUTTO: I tuoi · Consigliati · Categorie --- (PP4: righe a filo; fase
          design: il titolo di sezione è un'etichetta grigia e le sezioni stanno a 32 px) --- */}
      {seg === 'all' && (
        <>
          <Section
            title={<Trans>I tuoi</Trans>}
            // -mr-3: il testo dell'azione finisce sul bordo destro del contenuto (il bottone ha il suo respiro interno)
            action={<Button variant="ghost" size="sm" className="-mr-3" onClick={() => setSeg('connected')}><Trans>Vedi i collegati →</Trans></Button>}
            testId="plugin-yours"
          >
            {yourRows.length === 0 ? (
              <p className="text-small text-muted-foreground">
                <Trans>Nulla di collegato: comincia dai consigliati qui sotto.</Trans>
              </p>
            ) : (
              <FlatList>
                {yourRows.map((row) => (
                  <YourRow key={row.key} row={row} lang={lang} onOpen={openRow} onToggleActive={toggleActive} />
                ))}
              </FlatList>
            )}
          </Section>

          {model.featured.length > 0 && !query && (
            <Section title={<Trans>Consigliati per il tuo lavoro</Trans>}>
              <FlatList>
                {model.featured.map((r) => (
                  <AppRow
                    key={r.app.id}
                    row={r}
                    flow={flows.flowOf(r)}
                    failure={flows.failureOf(r)}
                    onConnect={(x) => void flows.connect(x)}
                    onCancel={(x) => void flows.cancel(x)}
                    onConflictResolve={(x) => void flows.onConflictResolve(x)}
                    onOpen={(x) => setCard({ appId: x.app.id })}
                  />
                ))}
              </FlatList>
            </Section>
          )}

          {!query && (
            <Section title={<Trans>Categorie</Trans>} testId="plugin-categories">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {model.categoriesPresent.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="text-body text-muted-foreground transition hover:text-foreground"
                    data-testid={`plugin-category-${c}`}
                    onClick={() => { setCategory(c as AppCategoryId); setSeg('connectors') }}
                  >
                    {appCategoryLabel(c, lang)}
                  </button>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {/* --- CONNETTORI: il catalogo di oggi (righe e flussi riusati) --- */}
      {seg === 'connectors' && (
        <Section testId="plugin-connectors">
          {/* le categorie su UNA riga: se non entrano scorrono da sole (prima andavano a capo: «Posta e / calendario») */}
          <UnderlineTabs<AppsFilter>
            tabs={[['all', t`Tutte`], ...model.categoriesPresent.map((c) => [c, appCategoryLabel(c, lang)] as const)]}
            value={category}
            onChange={setCategory}
            label={t`Categorie`}
            testId="plugin-connector-filters"
          />
          {catalogList.length > 0 ? (
            <FlatList>
              {catalogList.map((r) => (
                <AppRow
                  key={r.app.id}
                  row={r}
                  flow={flows.flowOf(r)}
                  failure={flows.failureOf(r)}
                  onConnect={(x) => void flows.connect(x)}
                  onCancel={(x) => void flows.cancel(x)}
                  onConflictResolve={(x) => void flows.onConflictResolve(x)}
                  onOpen={(x) => setCard({ appId: x.app.id })}
                />
              ))}
            </FlatList>
          ) : (
            <p className="text-small text-muted-foreground"><Trans>Nessuna app trovata. Prova con un altro nome.</Trans></p>
          )}
        </Section>
      )}

      {/* --- SKILL (PL5): la libreria, le skill dei plugin e il catalogo, in casa --- */}
      {seg === 'skills' && (
        <Section testId="plugin-skills">
          {skillsFilterAgent && (
            <div>
              {/* il filtro per bot che arriva dal pannello: una pillola che si toglie */}
              <button
                type="button"
                className="inline-flex h-control-sm cursor-pointer items-center gap-2 rounded-full bg-muted px-3 text-body text-muted-foreground transition hover:text-foreground"
                onClick={() => setSkillsFilterAgent(null)}
              >
                {agents.find((a) => a.id === skillsFilterAgent)?.name ?? skillsFilterAgent}
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          )}
          {skillRows.length === 0 && (
            <p className="text-small text-muted-foreground"><Trans>Nessuna skill. Creane una, importala, o chiedi a un bot di salvarne una.</Trans></p>
          )}
          {skillRows.length > 0 && (
            <FlatList>
              {skillRows.map((row) => (
                <YourRow key={row.key} row={row} lang={lang} onOpen={openRow} onToggleActive={toggleActive} />
              ))}
            </FlatList>
          )}

          {/* il catalogo CURATO di oggi (K2), con le sue categorie: la
              ricerca del campo in alto filtra anche questo (T1) */}
          <Section title={<Trans>Sfoglia</Trans>} testId="plugin-skills-catalog">
            <UnderlineTabs<'all' | SkillCategoryId>
              tabs={[['all', t`Tutte`], ...SKILL_CATEGORIES.map((c) => [c, t`${skillCategoryLabel(c)}`] as const)]}
              value={skillCatFilter}
              onChange={setSkillCatFilter}
              label={t`Categorie delle skill`}
            />
            {(catalogRows.length === 0)
              ? <p className="text-small text-muted-foreground"><Trans>Nessuna skill trovata</Trans></p>
              : SKILL_CATEGORIES.filter((c) => catalogRows.some((e) => e.category === c)).map((c) => (
                <Section key={c} title={t`${skillCategoryLabel(c)}`}>
                  <FlatList>
                    {catalogRows.filter((e) => e.category === c).map((entry) => {
                      const state = skillCatalogInstallState(entry, skills ?? [])
                      return (
                        <FlatRow
                          key={entry.id}
                          clickable
                          onClick={() => setCatalogId(entry.id)}
                          // una voce del catalogo non ha un logo: la piastrella tenue con la sua icona
                          leading={<span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground" aria-hidden="true"><Sparkles className="size-4" /></span>}
                          title={humanize(entry.id)}
                          subtitle={skillCatalogDescription(entry, lang)}
                          trailing={
                            <>
                              {state !== 'available' && <span className="rounded-full border border-border/50 px-2 py-0.5 text-caption text-muted-foreground"><Trans>Aggiunta</Trans></span>}
                              {state === 'update' && <span className="text-caption text-waiting"><Trans>Aggiornamento disponibile</Trans></span>}
                            </>
                          }
                        />
                      )
                    })}
                  </FlatList>
                </Section>
              ))}
          </Section>
        </Section>
      )}

      {/* --- COLLEGATI (tavola 10): la tabella con le sette colonne --- */}
      {seg === 'connected' && (
        <Section testId="plugin-connected">
          {/* i filtri: per strada e «Da sistemare · N» — come testo (PP4), su una riga */}
          <UnderlineTabs<ConnectedFilter | 'da-sistemare'>
            tabs={[
              ['all', t`Tutte le strade`],
              ['direct', t`MCP diretto`],
              ['composio', t`Composio`],
              ['mac', t`Sul Mac`],
              ['box', t`Nel computer isolato`],
              ['da-sistemare', t`Da sistemare · ${daSistemareCount(yourRows)}`]
            ]}
            value={onlyDaSistemare ? 'da-sistemare' : connFilter}
            onChange={(f) => {
              if (f === 'da-sistemare') setOnlyDaSistemare(true)
              else { setConnFilter(f); setOnlyDaSistemare(false) }
            }}
            label={t`Filtra per strada`}
            testId="plugin-connected-filters"
          />
          <DataTable<ConnectedTableRow>
            columns={connectedColumns(lang, connectedRows)}
            rows={connectedRows}
            rowKey={(r) => r.row.key}
            onRowClick={(r) => openRow(r.row)}
            rowTestId={(r) => `plugin-connected-row-${r.row.key}`}
            testId="plugin-connected-table"
          />
          {connectedRows.length === 0 && (
            <p className="text-small text-muted-foreground"><Trans>Nessun collegamento con questi filtri.</Trans></p>
          )}
          <p className="text-caption text-muted-foreground">
            <Trans>Cliccando una riga si apre la sua scheda. «Da sistemare» raccoglie quelli che non partono o hanno l'accesso scaduto, così non restano rotti in silenzio.</Trans>
          </p>
        </Section>
      )}

      {/* --- AVANZATE: gateway, marketplace, registro, chiave (per
          sviluppatori) — A4: CHIUSA di default, una riga che si apre.
          PP4: a filo, come il resto della pagina (niente riquadro) --- */}
      <section id="plugin-advanced" data-testid="plugin-advanced" className="border-t border-border/50 pt-3">
        {developersOpen ? (
          // il contenuto porta già il suo titolo e la sua introduzione
          <DevelopersContent scrollTo={null} />
        ) : (
          <button
            type="button"
            className="flex w-full cursor-pointer items-center justify-between gap-3 py-2 text-left text-small text-muted-foreground transition hover:text-foreground"
            data-testid="plugin-developers-toggle"
            aria-expanded={false}
            onClick={() => setDevelopersOpen(true)}
          >
            <Trans>Per sviluppatori</Trans>
            <span className="text-caption text-muted-foreground"><Trans>gateway, marketplace, registro, chiave</Trans></span>
          </button>
        )}
      </section>

      {/* la frase della strada più diretta (tavola 8, in fondo) */}
      <p className="text-center text-caption text-muted-foreground">
        <Trans>Prima la strada più diretta. Per ogni servizio Homun usa, in quest'ordine: il server del fornitore, un server verificato nel computer isolato, e Composio solo per i servizi che non ne hanno uno.</Trans>
      </p>
    </PageShell>

    {/* PL2: la scheda del plugin (tavola 9) — FUORI dal corpo che scorre: copre la pagina, non scorre con lei.
        Fase design: è un guscio suo (PageShell, z-30 sopra la pagina), FRATELLO di questo — mai dentro */}
      {(cardApp ?? cardServer) && card && (
        <PluginCard
          app={cardApp ? { row: cardApp } : undefined}
          server={cardServer ?? undefined}
          initialTab={card.tab}
          directEnabledFor={cardApp?.app.directId ? installed?.servers.find((s) => s.id === cardApp.app.directId)?.enabledFor ?? null : null}
          onConnect={cardApp ? (r) => { setCard(null); void flows.connect(r) } : undefined}
          onClose={() => setCard(null)}
          onChanged={() => { void refreshConnectors(); void refreshComposioGateway(); void refreshInstalled(); reloadSkills() }}
        />
      )}
      {/* i fogli (fase design: la larghezza è quella di lettura, 720 — la misura dei documenti; il raggio quello delle superfici) */}
      {skillDetail !== null && (
        <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={() => setSkillDetail(null)}>
          <div className="@container max-h-[85vh] w-full max-w-reading overflow-y-auto scroll-thin rounded-surface bg-card p-6 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="plugin-skill-detail">
            {/* PL5: la skill di un plugin è in sola lettura (si aggiorna col plugin) */}
            {(pluginSkills ?? []).some((g) => g.skills.some((x) => x.name === skillDetail))
              ? <PluginDetail name={skillDetail} plugins={pluginSkills ?? []} onClose={() => setSkillDetail(null)} />
              : <SkillEditor folder={skillDetail} onDone={() => reloadSkills()} onCancel={() => setSkillDetail(null)} embedded />}
          </div>
        </div>
      )}
      {catalogEntrySel && (
        <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={() => setCatalogId(null)}>
          <div className="@container max-h-[85vh] w-full max-w-reading overflow-y-auto scroll-thin rounded-surface bg-card p-6 shadow-soft" onClick={(e) => e.stopPropagation()} data-testid="plugin-skill-catalog-preview">
            <CatalogPreview
              entry={catalogEntrySel}
              state={skillCatalogInstallState(catalogEntrySel, skills ?? [])}
              installedFolder={(skills ?? []).find((x) => x.origin?.catalogId === catalogEntrySel.id)?.folder ?? null}
              onClose={() => setCatalogId(null)}
              onChanged={() => reloadSkills()}
            />
          </div>
        </div>
      )}
    </>
  )
}

/** L'etichetta della categoria del catalogo skill (i testi sono del catalogo). */
function skillCategoryLabel(c: SkillCategoryId): string {
  return c === 'writing' ? 'Scrittura' : c === 'work' ? 'Lavoro' : c === 'thinking' ? 'Pensiero' : c === 'research' ? 'Ricerca' : 'Carriera'
}

/** Il colore del badge della strada (tavola 10: una tinta per strada). */
function stradaBadgeClass(strada: string): string {
  if (strada === 'direct') return 'bg-chart-2/15 text-chart-2'
  if (strada === 'composio') return 'bg-primary/10 text-primary'
  if (strada === 'box-npm') return 'bg-muted text-foreground'
  if (strada === 'mac') return 'bg-muted text-muted-foreground'
  return 'bg-muted text-muted-foreground'
}

/** «6 sempre · 8 chiedi · 1 blocca» dalle regole specifiche (null = «—»). */
function permBriefOf(perms: { always: number; ask: number; blocked: number } | null): string {
  if (!perms) return '—'
  const parts: string[] = []
  if (perms.always > 0) parts.push(`${perms.always} ${i18n._(msg`sempre`)}`)
  if (perms.ask > 0) parts.push(`${perms.ask} ${i18n._(msg`chiedi`)}`)
  if (perms.blocked > 0) parts.push(`${perms.blocked} ${i18n._(msg`blocca`)}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/** «oggi 9:12 · 48 questa settimana» (o «mai»). */
function useBriefOf(usage: { last: number; week: number } | null): string {
  if (!usage) return i18n._(msg`mai`)
  const d = new Date(usage.last)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const when = sameDay ? `${i18n._(msg`oggi`)} ${time}` : d.toLocaleDateString()
  return `${when} · ${usage.week} ${i18n._(msg`questa settimana`)}`
}

/**
 * Il logo di una riga di plugin, a filo come la riga: il file del repo
 * cercato PER NOME (server e plugin non ne dichiarano uno: «Mattermost» →
 * mattermost.svg), altrimenti il logo dichiarato dal catalogo o l'iniziale.
 * La misura la dà chi lo rende — 32 nelle righe (DS1); il raggio sta in
 * lib/app-logos. Prima qui c'era un 20 px col raggio scritto a mano.
 */
function RowLogo({ row, name, className }: { row: Pick<YourPluginRow, 'kind' | 'name' | 'logo'>; name: string; className: string }): ReactNode {
  const url = row.kind === 'server' || row.kind === 'plugin' ? logoUrlForName(row.name) : null
  if (url) return <img src={url} alt="" className={`${LOGO_CLASS} ${className}`} />
  return <AppLogo logo={row.logo} name={name} className={className} />
}

/**
 * Una riga di «I tuoi» — A FILO (PP4, FlatRow): logo da 32, nome (verificato
 * se lo è), UNA riga grigia «tipo · strada · origine», e a destra il segnale.
 * V5 (fase stato-vivo): l'interruttore Attivo c'è per i server MCP, i
 * connettori (Composio e diretti col loro server) e le skill di LIBRERIA
 * (spento scrive disabledReason 'user' / l'enabled della voce).
 *
 * PP4 — UN solo segnale di stato per riga:
 *  - quando tutto va: nessuna parola (niente «attivo» verde); l'interruttore
 *    resta, senza l'etichetta accanto (l'aria-label sì);
 *  - quando qualcosa non va: la parola — rossa, o neutra per lo spento — con
 *    la sua azione (Vedi perché · Ricollega · Completa · Riaccendi), AL POSTO
 *    dell'interruttore quando l'azione è quella giusta (riaccendere,
 *    ricollegare, completare); «Vedi perché» lo lascia (spegnere è un'altra cosa);
 *  - spento dall'utente: «spento» in grigio e l'interruttore spento.
 * «Tutti i bot» non si scrive: i bot si nominano solo quando l'accesso è
 * ristretto («Solo Ricerca, Scrittura», o «nessun bot»). Esportata per i test.
 */
export function YourRow({ row, lang, onOpen, onToggleActive }: {
  row: YourPluginRow
  lang: 'it' | 'en'
  /** apre la scheda; `tab` la scheda interna («Ricollega» e «Completa» portano a «Account e bot») */
  onOpen(row: YourPluginRow, tab?: PluginCardTab): void
  onToggleActive(row: YourPluginRow, next: boolean): void
}): ReactNode {
  const { t } = useLingui()
  const st = stateLabelOf(row.state, lang)
  const shown = row.kind === 'skill' ? humanizeSkillName(row.name) : row.name
  // V5: chi ha l'interruttore Attivo — i server, i connettori (Composio e
  // diretti col loro server), le skill di LIBRERIA (quelle dei plugin si
  // aggiornano col plugin); i plugin del marketplace passano dai server
  const togglable = row.kind === 'server' || row.kind === 'connector' || (row.kind === 'skill' && row.gray.strada === 'skill')
  const showToggle = togglable && (row.state === 'active' || row.state === 'off-user' || row.state === 'broken' || row.state === 'invalid')
  const activeChecked = row.state !== 'off-user' && row.state !== 'off-homun'
  // i bot solo quando l'accesso è ristretto
  const bots =
    row.bots.all ? null
    : row.bots.names.length === 0 ? t`nessun bot`
    : row.bots.extra > 0 ? t`Solo ${row.bots.names.join(', ')} +${row.bots.extra}`
    : t`Solo ${row.bots.names.join(', ')}`
  const actionLabel = st.action === 'why' ? t`Vedi perché` : st.action === 'reconnect' ? t`Ricollega` : st.action === 'setup' ? t`Completa` : st.action === 'reenable' ? t`Riaccendi` : ''
  const onAction = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (st.action === 'reenable') onToggleActive(row, true)
    else if (st.action === 'reconnect' || st.action === 'setup') onOpen(row, 'accounts')
    else onOpen(row)
  }
  return (
    <FlatRow
      clickable
      testId={`plugin-row-${row.key}`}
      onClick={() => onOpen(row)}
      leading={<RowLogo row={row} name={shown} className="size-8 text-body" />}
      title={(
        <span className="flex items-center gap-1.5">
          <span className="truncate">{shown}</span>
          {row.verified && (
            <span className="flex shrink-0 items-center gap-0.5 text-caption text-muted-foreground" title={t`verificato`}>
              <BadgeCheck className="size-4" aria-hidden="true" />
              <Trans>verificato</Trans>
            </span>
          )}
        </span>
      )}
      subtitle={(
        <>
          {/* la riga grigia: tipo · strada · origine */}
          <span data-testid={`plugin-gray-${row.key}`}>{grayLineOf(row, lang)}</span>
          {bots !== null && <span className="block">{bots}</span>}
        </>
      )}
      trailing={(
        <>
          {row.state !== 'active' && (
            <span
              className={`text-small ${row.state === 'off-homun' || row.state === 'off-user' ? 'text-muted-foreground' : 'text-destructive'}`}
              data-testid={`plugin-state-${row.key}`}
            >
              {st.label}
              {st.action !== null && (
                <>
                  {' · '}
                  <button type="button" className="underline-offset-2 hover:underline" data-testid={`plugin-action-${row.key}`} onClick={onAction}>
                    {actionLabel}
                  </button>
                </>
              )}
            </span>
          )}
          {/* l'interruttore: il click NON apre la scheda (senza etichetta accanto: PP4) */}
          {showToggle && (
            <span onClick={(e: React.MouseEvent) => e.stopPropagation()}>
              <Toggle checked={activeChecked} onChange={(v) => onToggleActive(row, v)} label={t`Attivo`} testId={`plugin-active-${row.key}`} />
            </span>
          )}
        </>
      )}
    />
  )
}
