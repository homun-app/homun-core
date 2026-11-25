// C0 (fase linguaggio): pezzo di SkillsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — va in un file suo di components/plugin/.
// L'editor delle skill: crea (folder null), modifica (folder) o mostra il
// dettaglio (embedded). Salvataggio con validazione S1 ed errori sul campo;
// «Bot che la usano»; File in sola lettura; Avanzate con versioni, Finder,
// esporta; Rimuovi rosso con conferma. PL1 (fase plugin): la pagina Plugin
// lo riusa per «Crea una skill».
import { useEffect, useMemo, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { ChevronLeft } from 'lucide-react'
import { api, useStore } from '../../store'
import type { SkillLibraryItem, SkillGithubUpdatePreview, SkillVersion } from '../../../../shared/types'
import { parseSkillMd } from '../../../../shared/skill-md'
import ReactMarkdown from 'react-markdown'
import { SettingsAdvanced } from '../settings/SettingsAdvanced'
import { SettingsGroup } from '../settings/SettingsGroup'
import { SettingsRow } from '../settings/SettingsRow'
import { Toggle } from '../Settings'
import { Button } from '../ui/button'
import { BACK, issueText } from './skill-bits'

/**
 * Il campo dell'editor (DS1): 36 px — la misura dei campi — col raggio dei
 * controlli e il testo di riga. Sta dentro le schede tenui dei gruppi di
 * impostazioni, dunque sul fondo della pagina (bg-background).
 */
const FIELD = 'h-control w-full rounded-control bg-background px-3 text-body outline-none placeholder:text-muted-foreground'
/** L'azione rossa che non riempie: testo (ghost) nel colore del distruttivo, anche al passaggio. */
const QUIET_RED = 'text-destructive hover:bg-destructive/10 hover:text-destructive'

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

  if (loading) return <p className="py-6 text-center text-small text-muted-foreground"><Trans>caricamento…</Trans></p>

  return (
    <div className="flex flex-col gap-block" data-testid={folder === null ? 'skill-editor-new' : 'skill-editor'}>
      {/* Indietro: torna all'elenco (dal foglio) o chiude il modulo (nuova) */}
      <div>
        <button type="button" className={BACK} onClick={onCancel} data-testid="skill-back">
          <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
        </button>
      </div>

      {/* nome, descrizione, istruzioni: editor semplice con anteprima markdown */}
      <SettingsGroup label={<Trans>Skill</Trans>}>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-small text-muted-foreground"><Trans>Nome</Trans></span>
            <input
              className={FIELD}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="skill-field-name"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-small text-muted-foreground"><Trans>Descrizione (cosa fa e quando usarla)</Trans></span>
            <textarea
              className="min-h-16 w-full resize-y rounded-control bg-background px-3 py-2 text-body outline-none"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="skill-field-description"
            />
          </label>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-small text-muted-foreground"><Trans>Istruzioni (markdown)</Trans></span>
              <button type="button" className="h-control-sm text-small text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline" onClick={() => setPreview(!preview)}>
                {preview ? t`modifica` : t`anteprima`}
              </button>
            </div>
            {preview ? (
              <div className="max-h-72 overflow-y-auto rounded-control bg-background px-3 py-2 text-body" data-testid="skill-body-preview">
                <ReactMarkdown>{body}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                className="min-h-40 w-full resize-y rounded-control bg-background px-3 py-2 font-mono text-small outline-none"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                data-testid="skill-field-body"
              />
            )}
          </div>
          {issues.length > 0 && (
            <div className="flex flex-col gap-1 rounded-control bg-destructive/10 px-3 py-2" data-testid="skill-field-errors" role="alert">
              {issues.map((i, idx) => <p key={idx} className="text-small text-destructive">{issueText(i, i18n)}</p>)}
            </div>
          )}
          {note && <p className="text-small text-muted-foreground">{note}</p>}
          <div className="flex justify-end">
            <Button
              onClick={() => void save()}
              data-testid="skill-save"
            >
              <Trans>Salva</Trans>
            </Button>
          </div>
        </div>
      </SettingsGroup>

      {/* K4 (fase skill · catalogo): le note per Homun della voce, in sola lettura */}
      {folder !== null && meta?.homunNotes && (
        <div className="flex flex-col gap-1" data-testid="skill-homun-notes">
          <p className="text-small text-muted-foreground"><Trans>Adattamenti di Homun</Trans></p>
          <p className="max-h-40 overflow-y-auto scroll-thin whitespace-pre-wrap rounded-surface bg-muted/40 px-3 py-2 text-small text-muted-foreground">{meta.homunNotes}</p>
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
              <p className="px-4 py-3 text-small text-muted-foreground"><Trans>Nessun file di supporto.</Trans></p>
            ) : fileOpen === null ? (
              <div className="divide-y divide-border/60">
                {meta.files.map((f) => (
                  <button key={f} type="button" className="flex min-h-row-text w-full items-center justify-between gap-3 px-4 py-2 text-left text-body transition hover:bg-muted/60" onClick={() => openFile(f)}>
                    <span className="truncate font-mono text-small">{f}</span>
                    <span className="shrink-0 text-small text-muted-foreground"><Trans>apri</Trans></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-small text-muted-foreground">{fileOpen}</span>
                  <button type="button" className="h-control-sm shrink-0 text-small text-muted-foreground transition hover:text-foreground" onClick={() => setFileOpen(null)}><Trans>chiudi</Trans></button>
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-control bg-background px-3 py-2 text-small text-muted-foreground" data-testid="skill-file-view">{fileText}</pre>
              </div>
            )}
          </SettingsGroup>

          {/* Avanzate: nome tecnico, origine, licenza, Finder, Esporta, versioni */}
          <SettingsAdvanced>
            <SettingsGroup>
              {meta.name !== meta.folder && (
                <SettingsRow title={<Trans>Nome tecnico</Trans>} control={<code className="max-w-[55%] truncate rounded-control bg-card px-2 py-1 text-small text-muted-foreground">{meta.name}</code>} />
              )}
              <SettingsRow title={<Trans>Nome cartella</Trans>} control={<code className="max-w-[55%] truncate rounded-control bg-card px-2 py-1 text-small text-muted-foreground">{meta.folder}</code>} />
              <SettingsRow
                title={<Trans>Origine</Trans>}
                control={
                  <span className="text-small text-muted-foreground">
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
                <SettingsRow title={<Trans>Licenza</Trans>} control={<span className="text-small text-muted-foreground">{parsedLicense}</span>} />
              )}
              <SettingsRow title={<Trans>Mostra nel Finder</Trans>} control={
                // aprire una cartella o esportare sono azioni da riga: testo, non pieno
                <Button variant="ghost" size="sm" onClick={() => { void api.skillsShowInFinder(folder) }}>
                  <Trans>Apri</Trans>
                </Button>
              } />
              <SettingsRow title={<Trans>Esporta</Trans>} description={<Trans>Copia la cartella in ~/Downloads/Homun/skills/</Trans>} control={
                <Button variant="ghost" size="sm" data-testid="skill-export" onClick={() => {
                  void api.skillsExport(folder).then((r) => setNote(r.path))
                }}>
                  <Trans>Esporta</Trans>
                </Button>
              } />
            </SettingsGroup>

            {/* Versioni precedenti (S5): data e origine, con Ripristina */}
            <SettingsGroup label={<Trans>Versioni precedenti</Trans>}>
              {!versions || versions.length === 0 ? (
                <p className="px-4 py-3 text-small text-muted-foreground"><Trans>Nessuna versione precedente.</Trans></p>
              ) : (
                <div className="divide-y divide-border/60">
                  {versions.map((v) => (
                    <div key={v.file} className="flex min-h-row-text items-center justify-between gap-3 px-4 py-2">
                      <span className="min-w-0 text-body">
                        {new Date(v.ts).toLocaleString()}
                        <span className="ml-2 text-small text-muted-foreground">
                          {v.origin === 'user' ? t`tu` : v.origin === 'github' ? t`GitHub` : v.by ? agentName(v.by) : t`bot`}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
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
                      </Button>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="skill-update-preview"
                      onClick={() => {
                        setUpdateNote('')
                        void api.skillsGithubUpdatePreview(folder)
                          .then((r) => setUpdatePreview(r))
                          .catch((e: unknown) => setUpdateNote(e instanceof Error ? e.message : String(e)))
                      }}
                    >
                      <Trans>Controlla aggiornamenti</Trans>
                    </Button>
                    {updateNote && <p className="mt-2 text-small text-destructive">{updateNote}</p>}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 px-4 py-3 text-body" data-testid="skill-update-diff">
                    <p className="font-mono text-small text-muted-foreground">
                      {updatePreview.diff.oldCommit.slice(0, 8)} → {updatePreview.diff.newCommit.slice(0, 8)}
                    </p>
                    {meta.source === 'user' && (
                      // l'ambra dei «attenzione» del tema (waiting), non un ambra scritto a mano per chiaro e scuro
                      <p className="rounded-control bg-waiting/10 px-3 py-2 text-small text-waiting">
                        <Trans>Questa skill è stata modificata: l'aggiornamento sovrascrive le modifiche (la versione attuale va nelle precedenti).</Trans>
                      </p>
                    )}
                    {updatePreview.diff.added.length > 0 && <p><Trans>File aggiunti: {updatePreview.diff.added.join(', ')}</Trans></p>}
                    {updatePreview.diff.removed.length > 0 && <p><Trans>File tolti: {updatePreview.diff.removed.join(', ')}</Trans></p>}
                    {updatePreview.diff.changed.length > 0 && <p><Trans>File cambiati: {updatePreview.diff.changed.join(', ')}</Trans></p>}
                    <div className="flex justify-end gap-2 pt-1">
                      <Button variant="ghost" onClick={() => setUpdatePreview(null)}>
                        <Trans>Annulla</Trans>
                      </Button>
                      <Button
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
                      </Button>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            )}

            <p className="text-small text-muted-foreground"><Trans>Le versioni precedenti si conservano in .versions/ (le ultime 10).</Trans></p>
          </SettingsAdvanced>

          {/* Rimuovi (rosso, con conferma) */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {confirmRemove ? (
              <Button
                variant="ghost"
                className={QUIET_RED}
                data-testid="skill-remove-confirm"
                onClick={() => { void api.skillsDelete(folder).then(() => { onDone(); onCancel() }) }}
              >
                <Trans>Rimuovi davvero</Trans>
              </Button>
            ) : (
              <Button
                variant="ghost"
                className={QUIET_RED}
                data-testid="skill-remove"
                onClick={() => setConfirmRemove(true)}
              >
                <Trans>Rimuovi</Trans>
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
