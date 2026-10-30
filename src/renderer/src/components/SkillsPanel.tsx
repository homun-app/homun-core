// Sezione "Skill" della vista dell'agente (fase 4): elenco delle skill con
// descrizione, visualizzazione delle istruzioni complete ed eliminazione.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api } from '../store'
import type { SkillInfo } from '../../../shared/types'

export function SkillsPanel({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { t } = useLingui()
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = () => {
    setLoading(true)
    void api.listSkills(agentId).then((ss) => setSkills(ss)).finally(() => setLoading(false))
  }
  useEffect(reload, [agentId])

  const remove = (name: string) => {
    void api.deleteSkill(agentId, name).then(reload)
  }

  return (
    <div className="mx-6 mt-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground"><Trans>🛠 Skill di questo bot</Trans></h2>
        <button className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>✕</button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Procedure riutilizzabili che il bot carica con il tool skill(). Crearle o aggiornarle richiede la tua approvazione.</Trans>
      </p>
      {loading && <p className="mt-2 text-xs text-muted-foreground">…</p>}
      {!loading && skills.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground"><Trans>Nessuna skill: chiedi al bot di crearne una con update_skill.</Trans></p>
      )}
      <div className="mt-2 space-y-2">
        {skills.map((s) => (
          <div key={s.name} className="rounded-lg border border-border bg-muted px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-foreground">{s.name}</span>
              <span className="flex-1 truncate text-xs text-muted-foreground">{s.description}</span>
              <button
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setOpen(open === s.name ? null : s.name)}
              >
                {open === s.name ? t`richiudi` : t`istruzioni`}
              </button>
              <button
                className="rounded px-1.5 py-0.5 text-[11px] text-destructive/80 hover:bg-muted hover:text-red-300"
                onClick={() => remove(s.name)}
              >
                <Trans>Elimina</Trans>
              </button>
            </div>
            {open === s.name && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {s.content || t`(vuota)`}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
