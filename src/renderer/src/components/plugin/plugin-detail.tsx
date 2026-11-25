// C0 (fase linguaggio): pezzo di SkillsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — va in un file suo di components/plugin/.
// Il dettaglio di una skill che viene da un plugin, in sola lettura.
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { ChevronLeft, Puzzle } from 'lucide-react'
import { humanizeSkillName } from '../../../../shared/skill-md'
import { SettingsAdvanced } from '../settings/SettingsAdvanced'
import { BACK, TILE } from './skill-bits'

export function PluginDetail({ name, plugins, onClose }: { name: string; plugins: Array<{ plugin: string; skills: Array<{ name: string; description: string }> }>; onClose(): void }): React.ReactNode {
  const { i18n } = useLingui()
  const group = plugins.find((g) => g.skills.some((s) => s.name === name))
  const skill = group?.skills.find((s) => s.name === name)
  return (
    <div className="flex flex-col gap-block" data-testid="skill-plugin-detail">
      <button type="button" className={BACK} onClick={onClose}>
        <ChevronLeft className="size-4" /><Trans>Indietro</Trans>
      </button>
      <div className="flex items-center gap-row-gap">
        <span className={TILE} aria-hidden="true"><Puzzle className="size-5" /></span>
        <span className="min-w-0 flex-1">
          {/* il nome è il titolo del foglio (text-title: titoli di dialoghi e schede) */}
          <span className="block truncate text-title font-semibold">{humanizeSkillName(name)}</span>
          <span className="mt-0.5 block truncate text-small text-muted-foreground">{skill?.description}</span>
        </span>
      </div>
      <p className="rounded-surface bg-muted/60 px-3 py-2 text-small text-muted-foreground">
        <Trans>Viene dal plugin {group?.plugin}: si aggiorna aggiornando il plugin.</Trans>
      </p>
      <SettingsAdvanced label={i18n._(msg`Istruzioni`)}>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-surface bg-muted/60 px-3 py-2 text-small text-muted-foreground">
          {i18n._(msg`(le istruzioni complete le vede il bot col tool skill)`)}
        </pre>
      </SettingsAdvanced>
    </div>
  )
}
