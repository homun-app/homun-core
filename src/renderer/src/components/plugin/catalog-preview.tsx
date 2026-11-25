// C0 (fase linguaggio): pezzo di SkillsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — va in un file suo di components/plugin/.
// L'anteprima di una VOCE del catalogo (K3): nome e descrizione, fonte e
// licenza, l'elenco dei file che entreranno e le note per Homun; «Bot che la
// usano»; «Aggiungi» scarica la voce al COMMIT FISSATO; «‹ Indietro» chiude.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { ChevronLeft, Sparkles } from 'lucide-react'
import { api, useStore } from '../../store'
import type { SkillCatalogEntry, SkillCatalogPreview, SkillGithubUpdatePreview } from '../../../../shared/types'
import { humanizeSkillName } from '../../../../shared/skill-md'
import { skillCatalogDescription, type SkillCatalogInstallState } from '../../../../shared/skill-catalog'
import { SettingsGroup } from '../settings/SettingsGroup'
import { SettingsRow } from '../settings/SettingsRow'
import { Toggle } from '../Settings'
import { Button } from '../ui/button'
import { BACK, TILE, issueText } from './skill-bits'

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
    <div className="flex flex-col gap-block" data-testid="skills-catalog-preview">
      <button type="button" className={BACK} onClick={onClose} data-testid="skills-catalog-back">
        <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
      </button>
      {error && <p role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive" data-testid="skills-catalog-preview-error">{error}</p>}
      {!preview && !error && <p className="py-6 text-center text-small text-muted-foreground"><Trans>caricamento…</Trans></p>}
      {preview && (
        <div className="flex flex-col gap-block">
          <div className="flex items-center gap-row-gap">
            <span className={TILE} aria-hidden="true"><Sparkles className="size-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-title font-semibold" data-testid="skills-catalog-preview-title">{humanizeSkillName(entry.id)}</span>
              <span className="mt-0.5 block truncate text-small text-muted-foreground">
                <span className="font-mono" data-testid="skills-catalog-preview-source">{entry.source.repo}</span> · <span data-testid="skills-catalog-preview-commit" className="font-mono">{preview.commit.slice(0, 12)}</span>
              </span>
            </span>
          </div>
          <p className="text-small text-muted-foreground" data-testid="skills-catalog-preview-description">
            {skillCatalogDescription(entry, i18n.locale === 'en' ? 'en' : 'it')}
          </p>
          <p className="text-small text-muted-foreground" data-testid="skills-catalog-preview-license">
            <Trans>Licenza</Trans>: <span className="font-mono">{preview.license}</span>
          </p>
          {preview.invocation === 'user' && (
            <p className="rounded-surface bg-muted/60 px-3 py-2 text-small text-muted-foreground"><Trans>solo con /</Trans></p>
          )}
          {/* i file che entreranno (le esclusioni del catalogo sono già applicate) */}
          <div className="flex flex-col gap-1" data-testid="skills-catalog-preview-files">
            <p className="text-small text-muted-foreground"><Trans>File che entrano</Trans> ({preview.files.length})</p>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto scroll-thin rounded-surface bg-muted/40 px-3 py-2">
              {preview.files.map((f) => (
                <li key={f} className="truncate font-mono text-small text-muted-foreground">{f}</li>
              ))}
            </ul>
          </div>
          {/* K4: le note per Homun, in un riquadro piccolo, sola lettura */}
          {preview.homunNotes && (
            <div className="flex flex-col gap-1" data-testid="skills-catalog-preview-notes">
              <p className="text-small text-muted-foreground"><Trans>Adattamenti di Homun</Trans></p>
              <p className="max-h-40 overflow-y-auto scroll-thin whitespace-pre-wrap rounded-surface bg-muted/40 px-3 py-2 text-small text-muted-foreground">{preview.homunNotes}</p>
            </div>
          )}
          {!preview.valid && preview.issues.length > 0 && (
            <div className="flex flex-col gap-1 rounded-control bg-destructive/10 px-3 py-2" role="alert">
              {preview.issues.map((i, idx) => <p key={idx} className="text-small text-destructive">{issueText(i, i18n)}</p>)}
            </div>
          )}

          {/* «Aggiornamento disponibile»: il flusso di oggi (diff, versione vecchia conservata) */}
          {state === 'update' && installedFolder && (
            <SettingsGroup label={<Trans>Aggiornamento disponibile</Trans>}>
              {updateDiff === null ? (
                <div className="px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="skills-catalog-update-preview"
                    onClick={() => {
                      setUpdateNote('')
                      void api.skillsGithubUpdatePreview(installedFolder)
                        .then((r) => setUpdateDiff(r))
                        .catch((e: unknown) => setUpdateNote(e instanceof Error ? e.message : String(e)))
                    }}
                  >
                    <Trans>Controlla aggiornamenti</Trans>
                  </Button>
                  {updateNote && <p className="mt-2 text-small text-destructive">{updateNote}</p>}
                </div>
              ) : (
                <div className="flex flex-col gap-2 px-4 py-3 text-body" data-testid="skills-catalog-update-diff">
                  <p className="font-mono text-small text-muted-foreground">
                    {updateDiff.diff.oldCommit.slice(0, 8)} → {updateDiff.diff.newCommit.slice(0, 8)}
                  </p>
                  {updateDiff.diff.added.length > 0 && <p><Trans>File aggiunti: {updateDiff.diff.added.join(', ')}</Trans></p>}
                  {updateDiff.diff.removed.length > 0 && <p><Trans>File tolti: {updateDiff.diff.removed.join(', ')}</Trans></p>}
                  {updateDiff.diff.changed.length > 0 && <p><Trans>File cambiati: {updateDiff.diff.changed.join(', ')}</Trans></p>}
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="ghost" onClick={() => setUpdateDiff(null)}>
                      <Trans>Annulla</Trans>
                    </Button>
                    <Button
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
                    </Button>
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
            <Button
              variant="ghost"
              onClick={onClose}
              data-testid="skills-catalog-cancel"
            >
              <Trans>Annulla</Trans>
            </Button>
            <Button
              disabled={adding || !preview.valid}
              data-testid="skills-catalog-add"
              onClick={add}
            >
              <Trans>Aggiungi</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
