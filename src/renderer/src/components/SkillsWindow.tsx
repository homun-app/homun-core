// Fase skill (S4/S5/S6): la finestra «Skill» — la LIBRERIA UNICA al posto
// della copia per bot. Come la finestra App: Dialog grande, stile delle
// Impostazioni (SettingsGroup, SettingsRow, SettingsAdvanced, Toggle); il
// foglio del dettaglio segue il modello di ServerSheet. Ci si arriva dalla
// riga «Skill · N» della finestra App, dal pannello Skill della chat (rimando
// filtrato sul bot) e dalla voce nel menu in basso (B1).
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
//   sfoglia    (fase skill · catalogo, K2) la terza sezione: il CATALOGO
//              CURATO che vive nel repo (src/shared/skill-catalog) — niente
//              rete per l'elenco, titoletti per categoria, filtri a pillola e
//              righe con fonte e «Aggiunta». Prima mostrava i pacchetti dei
//              marketplace: i plugin restano in Collega app › Marketplace.
//              L'anteprima (K3) scarica la voce al COMMIT FISSATO e mostra
//              fonte, licenza, i file che entreranno e gli «Adattamenti di
//              Homun»; «Aggiornamento disponibile» usa il flusso di oggi.
//   ritocchi   (fase skill · Sfoglia, T1–T5) un solo campo di ricerca (il
//              campo in alto filtra ANCHE il catalogo), il contenuto della
//              finestra è un @container (le righe col controllo a destra),
//              «‹ Indietro» in alto nell'anteprima (UN solo «Annulla»),
//              focus d'apertura sul campo.
import { useEffect, useMemo, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import ReactMarkdown from 'react-markdown'
import { ChevronLeft } from 'lucide-react'
import { api, useStore } from '../store'
import type {
  SkillLibraryItem, SkillGithubUpdatePreview, SkillVersion,
  SkillCatalogEntry, SkillCatalogPreview
} from '../../../shared/types'
import { humanizeSkillName, parseSkillMd } from '../../../shared/skill-md'
import {
  skillCatalogDescription,
  type SkillCatalogInstallState
} from '../../../shared/skill-catalog'
import { SettingsAdvanced } from './settings/SettingsAdvanced'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'
import { Toggle } from './Settings'

function issueText(i: { uiId: string; values?: Record<string, string | number> }, i18n: { _(m: unknown, values?: Record<string, unknown>): string }): string {
  return i18n._({ id: i.uiId }, i.values)
}

export function PluginDetail({ name, plugins, onClose }: { name: string; plugins: Array<{ plugin: string; skills: Array<{ name: string; description: string }> }>; onClose(): void }): React.ReactNode {
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
 * PL1 (fase plugin): esportato — la pagina Plugin lo riusa per «Crea una skill».
 */
export function SkillEditor({ folder, onDone, onCancel, embedded = false }: {
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

      {/* K4 (fase skill · catalogo): le note per Homun della voce, in sola lettura */}
      {folder !== null && meta?.homunNotes && (
        <div className="space-y-1" data-testid="skill-homun-notes">
          <p className="text-[13px] text-muted-foreground"><Trans>Adattamenti di Homun</Trans></p>
          <p className="max-h-40 overflow-y-auto scroll-thin whitespace-pre-wrap rounded-xl bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">{meta.homunNotes}</p>
        </div>
      )}

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

/**
 * L'anteprima di una VOCE del catalogo (K3): nome e descrizione, fonte e
 * licenza, l'elenco dei file che entreranno e le note per Homun nel riquadro
 * «Adattamenti di Homun»; «Bot che la usano» (predefinito «Tutti i bot», e
 * quando è acceso i toggle dei singoli si SPENGONO e si DISATTIVANO).
 * «Aggiungi» scarica la voce al COMMIT FISSATO; «‹ Indietro» chiude (lo
 * staging scade da solo col TTL). Se la voce installata ha un commit diverso
 * da quello del catalogo («Aggiornamento disponibile»), l'aggiornamento usa
 * il flusso di oggi: diff vecchio → nuovo, versione vecchia conservata.
 */
export function CatalogPreview({ entry, state, installedFolder, onClose, onChanged }: {
  entry: SkillCatalogEntry
  state: SkillCatalogInstallState
  installedFolder: string | null
  onClose(): void
  onChanged(): void
}): React.ReactNode {
  const { i18n, t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [preview, setPreview] = useState<SkillCatalogPreview | null>(null)
  const [error, setError] = useState('')
  const [enabledFor, setEnabledFor] = useState<string[]>(['*'])
  const [adding, setAdding] = useState(false)
  // lo staging vive nel daemon sotto un id OPACO (mai path al renderer)
  const [previewId, setPreviewId] = useState<string | null>(null)
  // «Aggiorna» (flusso di oggi): anteprima del diff, poi applica
  const [updateDiff, setUpdateDiff] = useState<{ id: string; diff: SkillGithubUpdatePreview } | null>(null)
  const [updateNote, setUpdateNote] = useState('')

  useEffect(() => {
    setError('')
    setPreview(null)
    setPreviewId(null)
    setUpdateDiff(null)
    setUpdateNote('')
    void api.skillsCatalogPreview(entry.id)
      .then((r) => { setPreviewId(r.previewId); setPreview(r.preview) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [entry.id])

  const allBots = enabledFor.includes('*')
  const toggleBot = (agentId: string, on: boolean): void => {
    if (allBots) { setEnabledFor(on ? ['*'] : [agentId]); return }
    const next = on ? [...new Set([...enabledFor, agentId])] : enabledFor.filter((x) => x !== agentId)
    setEnabledFor(next.length === agents.length ? ['*'] : next)
  }

  const add = (): void => {
    if (!preview || !previewId) return
    setAdding(true)
    void api.skillsCatalogInstall(previewId, enabledFor)
      .then(() => {
        onChanged()
        onClose()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAdding(false))
  }

  return (
    <div className="space-y-4" data-testid="skills-catalog-preview">
      <button type="button" className="flex items-center gap-1 text-[13px] text-muted-foreground transition hover:text-foreground" onClick={onClose} data-testid="skills-catalog-back">
        <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
      </button>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive" data-testid="skills-catalog-preview-error">{error}</p>}
      {!preview && !error && <p className="py-6 text-center text-sm text-muted-foreground"><Trans>caricamento…</Trans></p>}
      {preview && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="grid size-12 shrink-0 place-items-center rounded-[12px] bg-muted text-lg">✦</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg font-medium" data-testid="skills-catalog-preview-title">{humanizeSkillName(entry.id)}</span>
              <span className="block truncate text-[13px] text-muted-foreground">
                <span className="font-mono" data-testid="skills-catalog-preview-source">{entry.source.repo}</span> · <span data-testid="skills-catalog-preview-commit" className="font-mono">{preview.commit.slice(0, 12)}</span>
              </span>
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground" data-testid="skills-catalog-preview-description">
            {skillCatalogDescription(entry, i18n.locale === 'en' ? 'en' : 'it')}
          </p>
          <p className="text-[12px] text-muted-foreground" data-testid="skills-catalog-preview-license">
            <Trans>Licenza</Trans>: <span className="font-mono">{preview.license}</span>
          </p>
          {preview.invocation === 'user' && (
            <p className="rounded-xl bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground"><Trans>solo con /</Trans></p>
          )}
          {/* i file che entreranno (le esclusioni del catalogo sono già applicate) */}
          <div className="space-y-1" data-testid="skills-catalog-preview-files">
            <p className="text-[13px] text-muted-foreground"><Trans>File che entrano</Trans> ({preview.files.length})</p>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto scroll-thin rounded-xl bg-muted/40 px-3 py-2">
              {preview.files.map((f) => (
                <li key={f} className="truncate font-mono text-[11px] text-muted-foreground">{f}</li>
              ))}
            </ul>
          </div>
          {/* K4: le note per Homun, in un riquadro piccolo, sola lettura */}
          {preview.homunNotes && (
            <div className="space-y-1" data-testid="skills-catalog-preview-notes">
              <p className="text-[13px] text-muted-foreground"><Trans>Adattamenti di Homun</Trans></p>
              <p className="max-h-40 overflow-y-auto scroll-thin whitespace-pre-wrap rounded-xl bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">{preview.homunNotes}</p>
            </div>
          )}
          {!preview.valid && preview.issues.length > 0 && (
            <div className="space-y-1 rounded-lg bg-destructive/10 px-3 py-2" role="alert">
              {preview.issues.map((i, idx) => <p key={idx} className="text-[12px] text-destructive">{issueText(i, i18n)}</p>)}
            </div>
          )}

          {/* «Aggiornamento disponibile»: il flusso di oggi (diff, versione vecchia conservata) */}
          {state === 'update' && installedFolder && (
            <SettingsGroup label={<Trans>Aggiornamento disponibile</Trans>}>
              {updateDiff === null ? (
                <div className="px-4 py-3">
                  <button
                    type="button"
                    className="rounded-full px-3 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    data-testid="skills-catalog-update-preview"
                    onClick={() => {
                      setUpdateNote('')
                      void api.skillsGithubUpdatePreview(installedFolder)
                        .then((r) => setUpdateDiff(r))
                        .catch((e: unknown) => setUpdateNote(e instanceof Error ? e.message : String(e)))
                    }}
                  >
                    <Trans>Controlla aggiornamenti</Trans>
                  </button>
                  {updateNote && <p className="mt-2 text-[12px] text-destructive">{updateNote}</p>}
                </div>
              ) : (
                <div className="space-y-2 px-4 py-3 text-[13px]" data-testid="skills-catalog-update-diff">
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {updateDiff.diff.oldCommit.slice(0, 8)} → {updateDiff.diff.newCommit.slice(0, 8)}
                  </p>
                  {updateDiff.diff.added.length > 0 && <p><Trans>File aggiunti: {updateDiff.diff.added.join(', ')}</Trans></p>}
                  {updateDiff.diff.removed.length > 0 && <p><Trans>File tolti: {updateDiff.diff.removed.join(', ')}</Trans></p>}
                  {updateDiff.diff.changed.length > 0 && <p><Trans>File cambiati: {updateDiff.diff.changed.join(', ')}</Trans></p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setUpdateDiff(null)}>
                      <Trans>Annulla</Trans>
                    </button>
                    <button
                      type="button"
                      className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background hover:opacity-90"
                      data-testid="skills-catalog-update-apply"
                      onClick={() => {
                        void api.skillsGithubUpdateApply(updateDiff.id, installedFolder).then(() => {
                          setUpdateDiff(null)
                          setUpdateNote(t`aggiornata`)
                          onChanged()
                          void api.skillsCatalogPreview(entry.id).then((r) => setPreview(r.preview)).catch(() => undefined)
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

          <SettingsGroup label={<Trans>Bot che la usano</Trans>}>
            <SettingsRow
              title={<Trans>Tutti i bot</Trans>}
              control={<Toggle label={t`Tutti i bot`} checked={allBots} onChange={(v) => setEnabledFor(v ? ['*'] : [])} />}
            />
            {agents.map((a) => (
              <SettingsRow
                key={a.id}
                title={a.name}
                control={<Toggle label={a.name} checked={allBots ? false : enabledFor.includes(a.id)} disabled={allBots} onChange={(v) => toggleBot(a.id, v)} />}
              />
            ))}
          </SettingsGroup>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-full px-4 py-1.5 text-xs text-muted-foreground transition hover:text-foreground"
              onClick={onClose}
              data-testid="skills-catalog-cancel"
            >
              <Trans>Annulla</Trans>
            </button>
            <button
              type="button"
              className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
              disabled={adding || !preview.valid}
              data-testid="skills-catalog-add"
              onClick={add}
            >
              <Trans>Aggiungi</Trans>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
