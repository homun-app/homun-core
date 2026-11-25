// GC2 (fase onboarding-b): le pillole dei modelli del pannello con chiave della
// guida — max 4, il consigliato per primo, e il trigger «Altri modelli…» del
// ModelPicker che NON mostra mai il valore scelto. C0 (fase linguaggio): file
// suo, estratto da GuideModelStep.tsx — l'import del passo lo rende usato dal
// prodotto (prima l'export serviva solo ai test).
import { useLingui, Trans } from '@lingui/react/macro'
import { ModelPicker } from './ui/ModelPicker'
import { guideModelPills } from '../lib/guide-model-pills'
import type { ModelInfo, ProviderKind } from '../../../shared/types'

export function GuideModelPills({ kind, models, selected, onSelect, pickerLabel }: {
  kind: string
  models: readonly string[]
  selected: string | null
  onSelect(id: string): void
  pickerLabel: string
}) {
  const pills = guideModelPills(kind, models, selected)
  const pillCls = 'max-w-full min-h-[44px] truncate rounded-full px-4 py-2 text-small font-semibold transition'
  return (
    <>
      {pills.map((m) => (
        <button
          key={m}
          type="button"
          data-testid={`guide-model-${m}`}
          aria-pressed={selected === m}
          className={`${pillCls} ${selected === m ? 'bg-foreground text-background' : 'bg-background text-foreground hover:bg-accent'}`}
          onClick={() => onSelect(m)}
        >
          {m}
        </button>
      ))}
      <ModelPicker
        pillTrigger={{ label: pickerLabel }}
        className={`${pillCls} bg-background text-foreground hover:bg-accent`}
        models={models.map((id): ModelInfo => ({ id, source: 'live', vision: false, tools: true, thinkingLevels: [], cost: null, costSource: null, local: false }))}
        value={selected}
        onChange={(id) => { if (id) onSelect(id) }}
      />
    </>
  )
}
