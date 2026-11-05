// Fase skill (S4/S5/S6): la finestra «Skill» — la LIBRERIA UNICA al posto
// della copia per bot. Come la finestra App: Dialog grande, stile delle
// Impostazioni (SettingsGroup, SettingsRow, SettingsAdvanced, Toggle); il
// foglio del dettaglio segue il modello di ServerSheet. Ci si arriva dalla
// riga «Skill · N» della finestra App, dal pannello Skill della chat (rimando
// filtrato sul bot) e dalla voce nella barra accanto ad App.
//
//   elenco     ricerca, filtri (Tutte · Mie · Create dai bot · Importate ·
//              Da plugin), nome umanizzato + descrizione + origine + «Bot
//              che la usano» in breve; in testa «+ Nuova skill» e «Da GitHub»;
//   dettaglio  nome, descrizione e istruzioni modificabili con anteprima
//              markdown (renderer già nell'app), salvataggio con validazione
//              S1 ed errori sul campo, gruppo «Bot che la usano», «File» in
//              sola lettura, «Avanzate» (nome tecnico, origine, licenza,
//              Mostra nel Finder, Esporta, Versioni precedenti), «Rimuovi»;
//   plugin     in sola lettura («si aggiorna aggiornando il plugin»);
//   importate  modificabili: diventano source 'user' con origin conservato;
//              «Aggiorna da GitHub» avvisa che sovrascrive le modifiche.
import { useEffect, useMemo, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import ReactMarkdown from 'react-markdown'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { ChevronLeft, Plus, Upload, Search, Sparkles } from 'lucide-react'
import { api, useStore } from '../store'
import type {
  SkillLibraryItem, SkillGithubPreview, SkillGithubPreviewItem, SkillGithubUpdatePreview, SkillVersion
} from '../../../shared/types'
import { humanizeSkillName, parseSkillMd } from '../../../shared/skill-md'
import { SettingsAdvanced } from './settings/SettingsAdvanced'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'
import { Toggle } from './Settings'

type Filter = 'all' | 'mine' | 'bot' | 'github' | 'plugin'

/** L'etichetta breve dell'origine (K4: l'importata MODIFICATA si dichiara). */
function SourceTag({ item }: { item: SkillLibraryItem }): React.ReactNode {
  const { t } = useLingui()
  const label = item.importedModified
    ? t`importata · modificata`
    : item.source === 'user' ? t`tua`
    : item.source === 'bot' ? t`creata da un bot`
    : item.source === 'github' ? t`da GitHub`
    : t`migrata`
  return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{label}</span>
}

/** «Bot che la usano» in breve: Tutti · il nome del bot · N bot. */
function botsBrief(enabledFor: string[], agentName: (id: string) => string, t: (s: string) => string): string {
  if (enabledFor.includes('*')) return t('tutti i bot')
  if (enabledFor.length === 0) return t('nessun bot')
  if (enabledFor.length === 1) return agentName(enabledFor[0]!)
  return `${enabledFor.length} bot`
}

/** La finestra «Skill» (dal bottone della barra, dalla finestra App, dal pannello della chat). */
export function SkillsWindow(): React.ReactNode {
  const { i18n, t } = useLingui()
  const agents = useStore((s) => s.agents)
  const setSkillsOpen = useStore((s) => s.setSkillsOpen)
  const filterAgent = useStore((s) => s.skillsFilterAgent)
  const setFilterAgent = useStore((s) => s.setSkillsFilterAgent)
  const [data, setData] = useState<{ library: SkillLibraryItem[]; plugins: Array<{ plugin: string; skills: Array<{ name: string; description: string }> }> } | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [detail, setDetail] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const reload = (): void => {
    void api.skillsLibrary().then(setData).catch(() => setData({ library: [], plugins: [] }))
  }
  useEffect(reload, [])
  // il filtro bot del pannello della chat vale per la PRIMA apertura
  useEffect(() => {
    if (filterAgent && data) {
      const hit = data.library.some((s) => s.enabledFor.includes(filterAgent) || s.enabledFor.includes('*'))
      if (hit) setFilter('all')
    }
  }, [filterAgent, data])

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const library = useMemo(() => {
    const rows = data?.library ?? []
    const q = query.trim().toLowerCase()
    return rows.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false
      if (filter === 'mine') return s.source === 'user' || s.source === 'migrated'
      if (filter === 'bot') return s.source === 'bot'
      // K4: anche l'importata MODIFICATA resta un'importata (source user + origin)
      if (filter === 'github') return s.source === 'github' || s.importedModified === true
      if (filter === 'plugin') return false
      return true
    })
  }, [data, query, filter])
  const pluginRows = useMemo(() => {
    if (filter !== 'all' && filter !== 'plugin') return []
    const q = query.trim().toLowerCase()
    return (data?.plugins ?? []).flatMap((g) => g.skills.map((s) => ({ ...s, plugin: g.plugin })))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [data, query, filter])
  // con il filtro sul bot (dal pannello della chat) si vedono le sue skill
  const visibleLibrary = useMemo(() => {
    if (!filterAgent || filter === 'plugin') return library
    return library.filter((s) => s.enabledFor.includes(filterAgent) || s.enabledFor.includes('*'))
  }, [library, filterAgent, filter])

  const filters: Array<[Filter, string]> = [
    ['all', i18n._(msg`Tutte`)],
    ['mine', i18n._(msg`Mie`)],
    ['bot', i18n._(msg`Create dai bot`)],
    ['github', i18n._(msg`Importate`)],
    ['plugin', i18n._(msg`Da plugin`)]
  ]

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { setSkillsOpen(false); setFilterAgent(null) } }}>
      <DialogContent
        className="flex max-h-[88vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-3xl bg-card p-0 shadow-soft sm:max-w-3xl"
        showCloseButton={false}
        data-testid="skills-window"
      >
          <DialogTitle className="sr-only">{i18n._(msg`Skill`)}</DialogTitle>
          <div className="flex max-h-[88vh] flex-col">
            <div className="flex items-center gap-2 px-6 pt-5">
              <Sparkles className="size-5 text-muted-foreground" aria-hidden="true" />
              <strong className="font-display text-lg"><Trans>Skill</Trans></strong>
              <span className="flex-1" />
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
                data-testid="skills-new"
                onClick={() => { setCreating(true); setDetail(null); setImporting(false) }}
              >
                <Plus className="size-3.5" /><Trans>Nuova skill</Trans>
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full bg-muted px-3.5 py-1.5 text-xs text-foreground transition hover:bg-muted/70"
                data-testid="skills-from-github"
                onClick={() => { setImporting(true); setDetail(null); setCreating(false) }}
              >
                <Upload className="size-3.5" /><Trans>Da GitHub</Trans>
              </button>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={t`Chiudi`}
                onClick={() => { setSkillsOpen(false); setFilterAgent(null) }}
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-6 pb-6 pt-4">
              {creating && <SkillEditor folder={null} onDone={() => { setCreating(false); reload() }} onCancel={() => setCreating(false)} />}
              {importing && <GithubImport onDone={() => { setImporting(false); reload() }} onCancel={() => setImporting(false)} />}
              {detail !== null && !creating && !importing && (
                data?.library.find((s) => s.folder === detail)
                  ? <SkillDetailSheet folder={detail} onDone={() => { reload() }} onClose={() => setDetail(null)} />
                  : <PluginDetail name={detail} plugins={data?.plugins ?? []} onClose={() => setDetail(null)} />
              )}
              {detail === null && !creating && !importing && (
                <>
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 flex-1 items-center gap-2 rounded-full bg-muted px-3">
                      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <input
                        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                        placeholder={t`Cerca skill`}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        data-testid="skills-search"
                      />
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="skills-filters">
                    {filters.map(([f, label]) => (
                      <button
                        key={f}
                        type="button"
                        className={`rounded-full px-3 py-1 text-[12px] transition ${filter === f ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}
                        onClick={() => setFilter(f)}
                      >
                        {label}
                      </button>
                    ))}
                    {filterAgent && (
                      <button
                        type="button"
                        className="rounded-full bg-muted px-3 py-1 text-[12px] text-muted-foreground"
                        onClick={() => setFilterAgent(null)}
                      >
                        <Trans>{agentName(filterAgent)}</Trans> ✕
                      </button>
                    )}
                  </div>
                  <div className="mt-4 space-y-1.5" data-testid="skills-list">
                    {(data?.library.length ?? 0) === 0 && (data?.plugins.length ?? 0) === 0 && (
                      <p className="py-6 text-center text-sm text-muted-foreground" data-testid="skills-empty">
                        <Trans>Nessuna skill. Scrivine una, importala da GitHub, o chiedi a un bot di salvare come skill un lavoro che ha appena fatto.</Trans>
                      </p>
                    )}
                    {visibleLibrary.map((s) => (
                      <button
                        key={s.folder}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition hover:bg-muted/60"
                        onClick={() => setDetail(s.folder)}
                        data-testid={`skills-row-${s.name}`}
                      >
                        <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">✦</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[15px]">{humanizeSkillName(s.name)}</span>
                            <SourceTag item={s} />
                            {!s.valid && <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive"><Trans>non valida</Trans></span>}
                          </span>
                          <span className="block truncate text-[13px] text-muted-foreground">{s.description.replace(/\s+/g, ' ')}</span>
                        </span>
                        <span className="shrink-0 text-[12px] text-muted-foreground">{botsBrief(s.enabledFor, agentName, (x) => i18n._(msg`${x}`))}</span>
                      </button>
                    ))}
                    {pluginRows.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-[14px] px-2 py-2 text-left transition hover:bg-muted/60"
                        onClick={() => setDetail(s.name)}
                      >
                        <span className="grid size-10 shrink-0 place-items-center rounded-[11px] bg-muted text-base">🧩</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[15px]">{humanizeSkillName(s.name)}</span>
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"><Trans>plugin</Trans></span>
                          </span>
                          <span className="block truncate text-[13px] text-muted-foreground">{s.description.replace(/\s+/g, ' ')}</span>
                        </span>
                        <span className="shrink-0 text-[12px] text-muted-foreground"><Trans>plugin {s.plugin}</Trans></span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
      </DialogContent>
    </Dialog>
  )
}

/** Un problema S1 tradotto nella lingua dell'interfaccia. */
function issueText(i: { uiId: string; values?: Record<string, string | number> }, i18n: { _(m: unknown, values?: Record<string, unknown>): string }): string {
  return i18n._({ id: i.uiId }, i.values)
}

/** Il foglio del dettaglio di una skill della libreria (modello ServerSheet). */
function SkillDetailSheet({ folder, onDone, onClose }: { folder: string; onDone(): void; onClose(): void }): React.ReactNode {
  return <SkillEditor folder={folder} onDone={onDone} onCancel={onClose} embedded />
}

/** Il dettaglio di una skill di PLUGIN: sola lettura. */
function PluginDetail({ name, plugins, onClose }: { name: string; plugins: Array<{ plugin: string; skills: Array<{ name: string; description: string }> }>; onClose(): void }): React.ReactNode {
  const { i18n } = useLingui()
  const group = plugins.find((g) => g.skills.some((s) => s.name === name))
  const skill = group?.skills.find((s) => s.name === name)
  return (
    <div className="space-y-4" data-testid="skill-plugin-detail">
      <button type="button" className="flex items-center gap-1 text-[13px] text-muted-foreground transition hover:text-foreground" onClick={onClose}>
        <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
      </button>
      <div className="flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-[12px] bg-muted text-lg">🧩</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-lg font-medium">{humanizeSkillName(name)}</span>
          <span className="block truncate text-[13px] text-muted-foreground">{skill?.description}</span>
        </span>
      </div>
      <p className="rounded-xl bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
        <Trans>Viene dal plugin {group?.plugin}: si aggiorna aggiornando il plugin.</Trans>
      </p>
      <SettingsAdvanced label={i18n._(msg`Istruzioni`)}>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
          {i18n._(msg`(le istruzioni complete le vede il bot col tool skill)`)}
        </pre>
      </SettingsAdvanced>
    </div>
  )
}

/**
 * L'editor: crea (folder null), modifica (folder) o mostra il dettaglio
 * (embedded, dentro il foglio). Salvataggio con validazione S1 ed errori sul
 * campo; «Bot che la usano»; File in sola lettura; Avanzate con versioni,
 * Finder, esporta; Rimuovi rosso con conferma.
 */
function SkillEditor({ folder, onDone, onCancel, embedded = false }: {
  folder: string | null
  onDone(): void
  onCancel(): void
  embedded?: boolean
}): React.ReactNode {
  const { i18n, t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [loading, setLoading] = useState(folder !== null)
  const [md, setMd] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown> | undefined>(undefined)
  const [enabledFor, setEnabledFor] = useState<string[]>(['*'])
  const [meta, setMeta] = useState<SkillLibraryItem | null>(null)
  const [issues, setIssues] = useState<Array<{ english: string; uiId: string; values?: Record<string, string | number> }>>([])
  const [note, setNote] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [preview, setPreview] = useState(false)
  const [versions, setVersions] = useState<SkillVersion[] | null>(null)
  const [fileOpen, setFileOpen] = useState<string | null>(null)
  const [fileText, setFileText] = useState('')
  const [updatePreview, setUpdatePreview] = useState<{ id: string; diff: SkillGithubUpdatePreview } | null>(null)
  const [updateNote, setUpdateNote] = useState('')
  // la licenza (se c'è) letta dal markdown corrente, senza riparsare a ogni render
  const parsedLicense = useMemo(() => {
    const parsed = parseSkillMd(md)
    return parsed.ok ? parsed.skill.license : undefined
  }, [md])

  useEffect(() => {
    if (folder === null) return
    setLoading(true)
    void Promise.all([api.skillsGet(folder), api.skillsLibrary(), api.skillsVersions(folder)])
      .then(([text, lib, vers]) => {
        setMd(text)
        const item = lib.library.find((s) => s.folder === folder) ?? null
        setMeta(item)
        setEnabledFor(item?.enabledFor ?? ['*'])
        setVersions(vers)
        // K2: una skill non valida (formato rotto o nome ≠ cartella) resta
        // visibile nella finestra COL MOTIVO, come le importate non valide
        setIssues(item && !item.valid ? item.issues : [])
        const parsed = parseSkillMd(text)
        if (parsed.ok) {
          setName(parsed.skill.name)
          setDescription(parsed.skill.description)
          setBody(parsed.skill.body)
          setFrontmatter(parsed.skill.frontmatter)
        }
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [folder])

  // il nome si PROPONE dalla descrizione (nuova skill), correggibile
  useEffect(() => {
    if (folder !== null || name) return
    const slug = description.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
    if (slug && name !== slug) setName(slug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description])

  const save = async (): Promise<void> => {
    setNote('')
    const r = await api.skillsSave({
      ...(folder !== null ? { folder } : {}),
      name,
      description,
      body,
      ...(frontmatter ? { frontmatter } : {}),
      ...(folder === null ? { enabledFor } : {})
    })
    if (!r.ok) {
      setIssues(r.issues)
      return
    }
    setIssues([])
    setNote(t`salvata`)
    onDone()
    if (folder === null) {
      onCancel()
    } else {
      // il salvataggio conserva la versione precedente: l'elenco si rilegge
      void api.skillsVersions(folder).then(setVersions).catch(() => undefined)
    }
  }

  const allBots = enabledFor.includes('*')
  const toggleBot = (agentId: string, on: boolean): void => {
    const others = agents.map((a) => a.id).filter((id) => id !== agentId)
    if (allBots) {
      void api.skillsSetEnabledFor(folder!, on ? ['*'] : others).then(onDone)
      return
    }
    const next = on ? [...new Set([...enabledFor, agentId])] : enabledFor.filter((id) => id !== agentId)
    const final = next.length === agents.length ? ['*'] : next
    setEnabledFor(final)
    void api.skillsSetEnabledFor(folder!, final).then(onDone)
  }

  const openFile = (f: string): void => {
    void api.skillsReadFile(folder!, f).then((text) => { setFileText(text ?? ''); setFileOpen(f) })
  }

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id

  if (loading) return <p className="py-6 text-center text-sm text-muted-foreground"><Trans>caricamento…</Trans></p>

  return (
    <div className="space-y-4" data-testid={folder === null ? 'skill-editor-new' : 'skill-editor'}>
      {/* Indietro: torna all'elenco (dal foglio) o chiude il modulo (nuova) */}
      <button type="button" className="flex items-center gap-1 text-[13px] text-muted-foreground transition hover:text-foreground" onClick={onCancel} data-testid="skill-back">
        <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
      </button>

      {/* nome, descrizione, istruzioni: editor semplice con anteprima markdown */}
      <SettingsGroup label={<Trans>Skill</Trans>}>
        <div className="space-y-3 px-4 py-3.5">
          <label className="block">
            <span className="mb-1 block text-[13px] text-muted-foreground"><Trans>Nome</Trans></span>
            <input
              className="h-9 w-full rounded-lg bg-background px-3 text-sm outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="skill-field-name"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] text-muted-foreground"><Trans>Descrizione (cosa fa e quando usarla)</Trans></span>
            <textarea
              className="min-h-16 w-full resize-y rounded-lg bg-background px-3 py-2 text-sm outline-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="skill-field-description"
            />
          </label>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground"><Trans>Istruzioni (markdown)</Trans></span>
              <button type="button" className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setPreview(!preview)}>
                {preview ? t`modifica` : t`anteprima`}
              </button>
            </div>
            {preview ? (
              <div className="max-h-72 overflow-y-auto rounded-lg bg-background px-3 py-2 text-sm" data-testid="skill-body-preview">
                <ReactMarkdown>{body}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                className="min-h-40 w-full resize-y rounded-lg bg-background px-3 py-2 font-mono text-[12px] leading-relaxed outline-none"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                data-testid="skill-field-body"
              />
            )}
          </div>
          {issues.length > 0 && (
            <div className="space-y-1 rounded-lg bg-destructive/10 px-3 py-2" data-testid="skill-field-errors" role="alert">
              {issues.map((i, idx) => <p key={idx} className="text-[12px] text-destructive">{issueText(i, i18n)}</p>)}
            </div>
          )}
          {note && <p className="text-[12px] text-muted-foreground">{note}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              onClick={() => void save()}
              data-testid="skill-save"
            >
              <Trans>Salva</Trans>
            </button>
          </div>
        </div>
      </SettingsGroup>

      {folder !== null && meta && (
        <>
          {/* Bot che la usano: Tutti i bot + un interruttore per bot */}
          <SettingsGroup label={<Trans>Bot che la usano</Trans>}>
            <SettingsRow
              title={<Trans>Tutti i bot</Trans>}
              control={<Toggle label={t`Tutti i bot`} checked={allBots} onChange={(v) => { const next = v ? ['*'] : []; setEnabledFor(next); void api.skillsSetEnabledFor(folder, next).then(onDone) }} />}
            />
            {agents.map((a) => (
              <SettingsRow
                key={a.id}
                title={a.name}
                control={<Toggle label={a.name} checked={allBots || enabledFor.includes(a.id)} onChange={(v) => toggleBot(a.id, v)} />}
              />
            ))}
          </SettingsGroup>

          {/* File: elenco in sola lettura, apribile in un riquadro di testo */}
          <SettingsGroup label={<Trans>File</Trans>}>
            {meta.files.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted-foreground"><Trans>Nessun file di supporto.</Trans></p>
            ) : fileOpen === null ? (
              <div className="divide-y divide-border/60">
                {meta.files.map((f) => (
                  <button key={f} type="button" className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px] transition hover:bg-muted/60" onClick={() => openFile(f)}>
                    <span className="truncate font-mono text-[12px]">{f}</span>
                    <span className="text-[11px] text-muted-foreground"><Trans>apri</Trans></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2 px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="truncate font-mono text-[12px] text-muted-foreground">{fileOpen}</span>
                  <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setFileOpen(null)}><Trans>chiudi</Trans></button>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-muted-foreground" data-testid="skill-file-view">{fileText}</pre>
              </div>
            )}
          </SettingsGroup>

          {/* Avanzate: nome tecnico, origine, licenza, Finder, Esporta, versioni */}
          <SettingsAdvanced>
            <SettingsGroup>
              {meta.name !== meta.folder && (
                <SettingsRow title={<Trans>Nome tecnico</Trans>} control={<code className="max-w-[55%] truncate rounded bg-card px-2 py-1 text-[11px] text-muted-foreground">{meta.name}</code>} />
              )}
              <SettingsRow title={<Trans>Nome cartella</Trans>} control={<code className="max-w-[55%] truncate rounded bg-card px-2 py-1 text-[11px] text-muted-foreground">{meta.folder}</code>} />
              <SettingsRow
                title={<Trans>Origine</Trans>}
                control={
                  <span className="text-[13px] text-muted-foreground">
                    {meta.source === 'github' && meta.origin
                      ? <Trans>GitHub · {meta.origin.repo} @ {meta.origin.commit.slice(0, 8)} · {meta.origin.path}</Trans>
                      : meta.source === 'bot' && meta.createdBy
                        ? <Trans>creata da {agentName(meta.createdBy)}</Trans>
                        : meta.source === 'migrated' ? <Trans>migrata dalla libreria per bot</Trans>
                        : <Trans>tua</Trans>}
                  </span>
                }
              />
              {parsedLicense && (
                <SettingsRow title={<Trans>Licenza</Trans>} control={<span className="text-[13px] text-muted-foreground">{parsedLicense}</span>} />
              )}
              <SettingsRow title={<Trans>Mostra nel Finder</Trans>} control={
                <button type="button" className="rounded-full px-3 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={() => { void api.skillsShowInFinder(folder) }}>
                  <Trans>Apri</Trans>
                </button>
              } />
              <SettingsRow title={<Trans>Esporta</Trans>} description={<Trans>Copia la cartella in ~/Downloads/Homun/skills/</Trans>} control={
                <button type="button" className="rounded-full px-3 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground" data-testid="skill-export" onClick={() => {
                  void api.skillsExport(folder).then((r) => setNote(r.path))
                }}>
                  <Trans>Esporta</Trans>
                </button>
              } />
            </SettingsGroup>

            {/* Versioni precedenti (S5): data e origine, con Ripristina */}
            <SettingsGroup label={<Trans>Versioni precedenti</Trans>}>
              {!versions || versions.length === 0 ? (
                <p className="px-4 py-3 text-[13px] text-muted-foreground"><Trans>Nessuna versione precedente.</Trans></p>
              ) : (
                <div className="divide-y divide-border/60">
                  {versions.map((v) => (
                    <div key={v.file} className="flex items-center justify-between px-4 py-2">
                      <span className="text-[13px]">
                        {new Date(v.ts).toLocaleString()}
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          {v.origin === 'user' ? t`tu` : v.origin === 'github' ? t`GitHub` : v.by ? agentName(v.by) : t`bot`}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        data-testid="skill-restore"
                        onClick={() => {
                          void api.skillsRestoreVersion(folder, v.file).then(() => {
                            setNote(t`versione ripristinata`)
                            onDone()
                            void api.skillsGet(folder).then((text) => {
                              setMd(text)
                              const parsed = parseSkillMd(text)
                              if (parsed.ok) {
                                setName(parsed.skill.name)
                                setDescription(parsed.skill.description)
                                setBody(parsed.skill.body)
                                setFrontmatter(parsed.skill.frontmatter)
                              }
                            })
                            void api.skillsVersions(folder).then(setVersions)
                          })
                        }}
                      >
                        <Trans>Ripristina</Trans>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </SettingsGroup>

            {/* Aggiorna da GitHub (le importate; anche se poi modificate, con avviso) */}
            {meta.origin && (
              <SettingsGroup label={<Trans>Aggiorna da GitHub</Trans>}>
                {updatePreview === null ? (
                  <div className="px-4 py-3">
                    <button
                      type="button"
                      className="rounded-full px-3 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      data-testid="skill-update-preview"
                      onClick={() => {
                        setUpdateNote('')
                        void api.skillsGithubUpdatePreview(folder)
                          .then((r) => setUpdatePreview(r))
                          .catch((e: unknown) => setUpdateNote(e instanceof Error ? e.message : String(e)))
                      }}
                    >
                      <Trans>Controlla aggiornamenti</Trans>
                    </button>
                    {updateNote && <p className="mt-2 text-[12px] text-destructive">{updateNote}</p>}
                  </div>
                ) : (
                  <div className="space-y-2 px-4 py-3 text-[13px]" data-testid="skill-update-diff">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {updatePreview.diff.oldCommit.slice(0, 8)} → {updatePreview.diff.newCommit.slice(0, 8)}
                    </p>
                    {meta.source === 'user' && (
                      <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
                        <Trans>Questa skill è stata modificata: l'aggiornamento sovrascrive le modifiche (la versione attuale va nelle precedenti).</Trans>
                      </p>
                    )}
                    {updatePreview.diff.added.length > 0 && <p><Trans>File aggiunti: {updatePreview.diff.added.join(', ')}</Trans></p>}
                    {updatePreview.diff.removed.length > 0 && <p><Trans>File tolti: {updatePreview.diff.removed.join(', ')}</Trans></p>}
                    {updatePreview.diff.changed.length > 0 && <p><Trans>File cambiati: {updatePreview.diff.changed.join(', ')}</Trans></p>}
                    <div className="flex justify-end gap-2 pt-1">
                      <button type="button" className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setUpdatePreview(null)}>
                        <Trans>Annulla</Trans>
                      </button>
                      <button
                        type="button"
                        className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background hover:opacity-90"
                        data-testid="skill-update-apply"
                        onClick={() => {
                          void api.skillsGithubUpdateApply(updatePreview.id, folder).then(() => {
                            setUpdatePreview(null)
                            setNote(t`aggiornata da GitHub`)
                            onDone()
                          }).catch((e: unknown) => setUpdateNote(e instanceof Error ? e.message : String(e)))
                        }}
                      >
                        <Trans>Aggiorna</Trans>
                      </button>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            )}

            <p className="text-[13px] text-muted-foreground"><Trans>Le versioni precedenti si conservano in .versions/ (le ultime 10).</Trans></p>
          </SettingsAdvanced>

          {/* Rimuovi (rosso, con conferma) */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {confirmRemove ? (
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                data-testid="skill-remove-confirm"
                onClick={() => { void api.skillsDelete(folder).then(() => { onDone(); onCancel() }) }}
              >
                <Trans>Rimuovi davvero</Trans>
              </button>
            ) : (
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
                data-testid="skill-remove"
                onClick={() => setConfirmRemove(true)}
              >
                <Trans>Rimuovi</Trans>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** L'import da GitHub (S6): URL → anteprima → scelta → Aggiungi. */
function GithubImport({ onDone, onCancel }: { onDone(): void; onCancel(): void }): React.ReactNode {
  const { i18n, t } = useLingui()
  const agents = useStore((s) => s.agents)
  // i nomi GIÀ in libreria (per proporre <name>-2 ai conflitti) si rileggono
  // a OGNI anteprima: nel frattempo possono essere cambiate
  const [existing, setExisting] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [importId, setImportId] = useState<string | null>(null)
  const [preview, setPreview] = useState<SkillGithubPreview | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [enabledFor, setEnabledFor] = useState<string[]>(['*'])

  const run = (): void => {
    setError('')
    setLoading(true)
    void api.skillsLibrary().then((r) => setExisting(r.library.map((x) => x.name))).catch(() => undefined)
    void api.skillsGithubPreview(url.trim())
      .then((r) => {
        setImportId(r.id)
        setPreview(r.preview)
        const initial: Record<string, boolean> = {}
        for (const s of r.preview.skills) initial[s.path] = s.valid
        setChecked(initial)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  const allBots = enabledFor.includes('*')
  const toggleBot = (agentId: string, on: boolean): void => {
    if (allBots) { setEnabledFor(on ? ['*'] : [agentId]); return }
    const next = on ? [...new Set([...enabledFor, agentId])] : enabledFor.filter((id) => id !== agentId)
    setEnabledFor(next.length === agents.length ? ['*'] : next)
  }

  const add = (): void => {
    if (!importId || !preview) return
    const choices = preview.skills
      .filter((s) => checked[s.path])
      .map((s) => ({ path: s.path, ...(renames[s.path] ? { name: renames[s.path]! } : {}) }))
    void api.skillsGithubAdd(importId, choices, enabledFor)
      .then((rows) => {
        onDone()
        // K5: il nome scelto invalido salta quella riga e si mostra qui
        const bad = rows.filter((r) => r.error)
        if (bad.length) setError(bad.map((r) => `${r.path}: ${r.error?.english ?? ''}`).join(' · '))
        else onCancel()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="space-y-4" data-testid="skills-github">
      <button type="button" className="flex items-center gap-1 text-[13px] text-muted-foreground transition hover:text-foreground" onClick={onCancel}>
        <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
      </button>
      <strong className="block font-display text-lg"><Trans>Da GitHub</Trans></strong>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (url.trim()) run() }}
      >
        <input
          className="h-9 flex-1 rounded-full bg-muted px-4 text-sm outline-none"
          placeholder={t`https://github.com/owner/repo`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          data-testid="skills-github-url"
        />
        <button
          type="submit"
          className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={!url.trim() || loading}
          data-testid="skills-github-preview-btn"
        >
          {loading ? t`…` : t`Anteprima`}
        </button>
      </form>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert" data-testid="skills-github-error">{error}</p>}
      {preview && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground" data-testid="skills-github-repo">
            <Trans>{preview.repo} @ {preview.commit.slice(0, 8)}</Trans>
          </p>
          <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-[13px] text-amber-600 dark:text-amber-400">
            <Trans>Solo istruzioni: gli script inclusi non vengono eseguiti.</Trans>
          </p>
          <div className="space-y-1.5">
            {preview.skills.map((s) => (
              <div key={s.path} className={`rounded-[14px] px-3 py-2 ${s.valid ? 'bg-muted/60' : 'bg-muted/30 opacity-60'}`} data-testid={`skills-github-item-${s.name}`}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked[s.path] === true && s.valid}
                    disabled={!s.valid}
                    onChange={(e) => setChecked({ ...checked, [s.path]: e.target.checked })}
                    className="h-3.5 w-3.5 accent-foreground"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{s.name}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{s.description.replace(/\s+/g, ' ')}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    <Trans>{s.fileCount} file</Trans>{s.license ? ` · ${s.license}` : ''}
                  </span>
                </label>
                {!s.valid && s.issues.length > 0 && (
                  <ul className="mt-1 pl-6">
                    {s.issues.map((i, idx) => <li key={idx} className="text-[11px] text-destructive">{issueText(i, i18n)}</li>)}
                  </ul>
                )}
                {s.valid && checked[s.path] && existing.includes(s.name) && (
                  <label className="mt-1.5 flex items-center gap-2 pl-6">
                    <span className="text-[11px] text-muted-foreground"><Trans>Nome già presente: salva come</Trans></span>
                    <input
                      className="h-7 flex-1 rounded-lg bg-background px-2 font-mono text-[11px] outline-none"
                      value={renames[s.path] ?? proposeName(s.name, existing)}
                      onChange={(e) => setRenames({ ...renames, [s.path]: e.target.value })}
                      data-testid={`skills-github-rename-${s.name}`}
                    />
                  </label>
                )}
              </div>
            ))}
          </div>
          <SettingsGroup label={<Trans>Bot che la usano</Trans>}>
            <SettingsRow
              title={<Trans>Tutti i bot</Trans>}
              control={<Toggle label={t`Tutti i bot`} checked={allBots} onChange={(v) => setEnabledFor(v ? ['*'] : [])} />}
            />
            {agents.map((a) => (
              <SettingsRow key={a.id} title={a.name} control={<Toggle label={a.name} checked={allBots || enabledFor.includes(a.id)} onChange={(v) => toggleBot(a.id, v)} />} />
            ))}
          </SettingsGroup>
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              onClick={add}
              data-testid="skills-github-add"
            >
              <Trans>Aggiungi</Trans>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Il nome proposto per un conflitto: <name>-2, -3… mai sovrascritture silenziose. */
function proposeName(name: string, existing: string[]): string {
  for (let i = 2; ; i++) {
    const candidate = `${name}-${i}`
    if (!existing.includes(candidate)) return candidate
  }
}
