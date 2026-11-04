// Fase impostazioni (I4): la pagina Approvazioni in tre modi — «Chiedi»,
// «Automatico» (l'auto-revisione di oggi, col suo modello e le sue regole) e
// «Non chiedere» (ask → allow tranne le esclusioni fisse, con CONFERMA che
// dichiara le due differenze da Rakazo: i blocchi restano blocchi e le bozze
// verso l'esterno restano da confermare). Poi «Consensi salvati» con i nomi
// umani, e le regole per strumento sotto «Avanzate» (I4.5: nome umano in
// testa, nome tecnico piccolo sotto; message_user nei default).
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { api, useStore } from '../../store'
import type { ApprovalsMode, AutoReviewSettings, PermissionMode } from '../../../../shared/types'
import { DEFAULT_AUTO_REVIEW, approvalsModeOf } from '../../../../shared/types'
import { toolDisplayName } from '../../../../shared/tool-names'
import { SettingsPage } from './SettingsPage'
import { SettingsGroup } from './SettingsGroup'
import { SettingsRow } from './SettingsRow'
import { SettingsAdvanced } from './SettingsAdvanced'

const MODES: ReadonlyArray<{ id: ApprovalsMode; label: MessageDescriptor }> = [
  { id: 'ask', label: msg`Chiedi` },
  { id: 'auto', label: msg`Automatico` },
  { id: 'never', label: msg`Non chiedere` }
]

const MODE_SENTENCES: Record<ApprovalsMode, MessageDescriptor> = {
  ask: msg`Il bot chiede prima di ogni azione che cambia qualcosa: inviare, scrivere, eseguire comandi. Leggere non chiede.`,
  auto: msg`Un modello controlla ogni azione contro le tue regole: quelle semplici passano, per le altre il bot chiede.`,
  never: msg`Ogni azione parte senza aspettare.`
}

export function ApprovalsPage() {
  const { t, i18n } = useLingui()
  const permissions = useStore((s) => s.permissions)
  const refreshPermissions = useStore((s) => s.refreshPermissions)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const prefill = useStore((s) => s.autoreviewPrefill)
  const [mode, setMode] = useState<ApprovalsMode | null>(null)
  const [cfg, setCfg] = useState<AutoReviewSettings | null>(null)
  const [pendingNever, setPendingNever] = useState(false)
  const [newAllow, setNewAllow] = useState('')
  const [newBlock, setNewBlock] = useState('')
  const [grants, setGrants] = useState<Array<{ id: number; tool: string; target: string; createdAt: number; scope?: 'readOnly' | null }> | null>(null)

  const loadGrants = (): void => {
    void api.grantsList().then(setGrants).catch(() => setGrants([]))
  }
  useEffect(() => { loadGrants() }, [])
  useEffect(() => {
    void Promise.all([
      api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW),
      api.settingsGet<ApprovalsMode | undefined>('approvals.mode', undefined)
    ])
      .then(([c, m]) => {
        const cfgIn = { ...DEFAULT_AUTO_REVIEW, ...c }
        setCfg(cfgIn)
        // I4.1: senza approvals.mode (dati di ieri) il modo nasce da enabled
        setMode(approvalsModeOf(cfgIn, m))
      })
      .catch(() => { setCfg({ ...DEFAULT_AUTO_REVIEW }); setMode('ask') })
  }, [])
  useEffect(() => {
    if (prefill) {
      setNewAllow(prefill)
      useStore.setState({ autoreviewPrefill: null })
    }
  }, [prefill])

  if (mode === null || !cfg || !permissions) return <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>

  /** I4.1: il modo si scrive in approvals.mode e autoReview.enabled ne è derivato */
  const saveMode = async (m: ApprovalsMode): Promise<void> => {
    const nextCfg = { ...cfg, enabled: m === 'auto' }
    setMode(m)
    setCfg(nextCfg)
    await api.settingsSet('approvals.mode', m)
    await api.settingsSet('autoReview', nextCfg)
  }
  const saveCfg = (next: AutoReviewSettings): void => {
    setCfg(next)
    void api.settingsSet('autoReview', next)
  }

  return (
    <SettingsPage title={<Trans>Approvazioni</Trans>}>
      {/* ---- I4.2 · Quando chiedere ---- */}
      <SettingsGroup label={<Trans>Quando chiedere</Trans>}>
        <div className="px-4 py-3">
          <div className="flex flex-wrap gap-1 rounded-full bg-card p-1" role="radiogroup" aria-label={t`Quando chiedere`}>
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={mode === m.id}
                className={`flex-1 rounded-full px-3 py-1.5 text-center text-sm transition ${mode === m.id ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => {
                  if (m.id === 'never' && mode !== 'never') setPendingNever(true)
                  else void saveMode(m.id)
                }}
              >
                {i18n.t(m.label)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">{i18n.t(MODE_SENTENCES[mode])}</p>
        </div>

        {/* Automatico: il modello del revisore e le regole di oggi */}
        {mode === 'auto' && (
          <>
            <SettingsRow
              title={<Trans>Modello delle approvazioni</Trans>}
              description={
                cfg.providerId && cfg.model
                  ? `${cfg.model}`
                  : t`Nessuno: senza, Automatico chiede sempre.`
              }
              control={
                <span className="flex items-center gap-3">
                  <button
                    className="text-sm text-primary transition hover:underline"
                    onClick={() => setSettingsTab('modelli')}
                  >
                    <Trans>Cambia in Modelli ›</Trans>
                  </button>
                </span>
              }
            />
            <RuleList
              title={msg`Continua da solo quando…`}
              hint={msg`Se una regola corrisponde (e nessuna regola di fermata), il revisore può approvare l’azione o l’invio della bozza.`}
              rules={cfg.allowRules}
              value={newAllow}
              setValue={setNewAllow}
              onAdd={() => saveCfg({ ...cfg, allowRules: [...cfg.allowRules, newAllow.trim()] })}
              onRemove={(i) => saveCfg({ ...cfg, allowRules: cfg.allowRules.filter((_, j) => j !== i) })}
            />
            <RuleList
              title={msg`Fermati e chiedimi sempre quando…`}
              hint={msg`Una di queste regole vince sempre sulle altre: l’azione diventa una card.`}
              rules={cfg.blockRules}
              value={newBlock}
              setValue={setNewBlock}
              onAdd={() => saveCfg({ ...cfg, blockRules: [...cfg.blockRules, newBlock.trim()] })}
              onRemove={(i) => saveCfg({ ...cfg, blockRules: cfg.blockRules.filter((_, j) => j !== i) })}
            />
          </>
        )}
      </SettingsGroup>

      {/* ---- I4.4 · Consensi salvati ---- */}
      <SettingsGroup
        label={<Trans>Consensi salvati</Trans>}
        footer={<Trans>«Consenti sempre» dati nelle card. Le letture di un server valgono solo per i tool che restano dichiarati in sola lettura.</Trans>}
      >
        {grants === null && <div className="px-4 py-3 text-sm text-muted-foreground">…</div>}
        {grants?.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground"><Trans>(nessun consenso salvato)</Trans></div>}
        {grants?.map((g) => (
          <SettingsRow
            key={g.id}
            title={grantName(g, i18n.locale === 'en' ? 'en' : 'it')}
            description={<code className="font-mono text-[11px]">{g.tool}{g.target !== '*' ? ` · ${g.target}` : ''}</code>}
            control={
              <button
                className="rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground transition hover:text-destructive"
                onClick={() => { void api.grantRevoke(g.id).then(loadGrants).catch(() => undefined) }}
              >
                <Trans>Revoca</Trans>
              </button>
            }
          />
        ))}
      </SettingsGroup>

      {/* ---- I4.5 · Regole per strumento (Avanzate) ---- */}
      <SettingsAdvanced label={<Trans>Regole per strumento</Trans>}>
        <SettingsGroup>
          <SettingsRow
            title={<Trans>Politica predefinita</Trans>}
            description={<Trans>Vale per gli strumenti senza una regola loro.</Trans>}
            control={
              <ModeSelect
                value={permissions.default}
                onChange={async (v) => {
                  await api.setPermissions({ ...permissions, default: v })
                  await refreshPermissions()
                }}
              />
            }
          />
          {permissions.rules.map((r, i) => (
            <SettingsRow
              key={`${r.tool}|${r.pattern}|${i}`}
              title={toolDisplayName(r.tool, i18n.locale === 'en' ? 'en' : 'it')}
              description={<code className="font-mono text-[11px]">{r.tool}{r.pattern !== '*' ? ` · ${r.pattern}` : ''}</code>}
              control={
                <ModeSelect
                  value={r.mode}
                  onChange={async (v) => {
                    const rules = [...permissions.rules]
                    rules[i] = { ...r, mode: v }
                    await api.setPermissions({ ...permissions, rules })
                    await refreshPermissions()
                  }}
                />
              }
            />
          ))}
        </SettingsGroup>
      </SettingsAdvanced>

      {/* ---- I4.2 · la conferma di «Non chiedere» ---- */}
      {pendingNever && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={() => setPendingNever(false)}>
          <div className="w-full max-w-md space-y-3 rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <strong className="block font-display text-lg"><Trans>Non chiedere più?</Trans></strong>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Il bot agirà senza chiederti niente, anche per inviare o cancellare. Restano solo le protezioni fisse:
                le azioni bloccate restano bloccate e le bozze verso l’esterno restano da confermare.
              </Trans>
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition hover:text-foreground"
                onClick={() => setPendingNever(false)}
              >
                <Trans>Annulla</Trans>
              </button>
              <button
                className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background transition hover:opacity-90"
                onClick={() => { setPendingNever(false); void saveMode('never') }}
              >
                <Trans>Non chiedere più</Trans>
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  )
}

/** Il nome umano di un consenso salvato (le letture di un server MCP come oggi). */
function grantName(g: { tool: string; target: string; scope?: 'readOnly' | null }, lang: 'it' | 'en'): string {
  if (g.scope === 'readOnly' && /^mcp__[^_]+__\*$/.test(g.tool)) {
    const server = g.tool.slice(5, -3)
    return lang === 'en' ? `Reads of ${server}` : `Letture di ${server}`
  }
  return toolDisplayName(g.tool, lang)
}

/** Il selettore dei tre modi di una regola (Consenti sempre / Chiedi / Blocca). */
function ModeSelect({ value, onChange }: { value: PermissionMode; onChange(v: PermissionMode): Promise<void> | void }) {
  const { t } = useLingui()
  return (
    <select
      className="h-9 shrink-0 rounded-full bg-card px-2.5 text-sm outline-none"
      value={value}
      onChange={(e) => void onChange(e.target.value as PermissionMode)}
    >
      <option value="always_allow">{t`Consenti sempre`}</option>
      <option value="needs_approval">{t`Chiedi approvazione`}</option>
      <option value="blocked">{t`Blocca`}</option>
    </select>
  )
}

/** Le due liste di regole dell'Automatico (stile di oggi, dentro la scheda). */
function RuleList({ title, hint, rules, onAdd, onRemove, value, setValue }: {
  title: MessageDescriptor
  hint: MessageDescriptor
  rules: string[]
  onAdd(): void
  onRemove(i: number): void
  value: string
  setValue(v: string): void
}) {
  const { t, i18n } = useLingui()
  return (
    <div className="border-t border-border/40 px-4 py-3">
      <div className="text-sm">{i18n.t(title)}</div>
      <div className="mt-0.5 text-[13px] text-muted-foreground">{i18n.t(hint)}</div>
      <ul className="mt-2 space-y-1">
        {rules.length === 0 && <li className="text-xs text-muted-foreground"><Trans>(nessuna regola)</Trans></li>}
        {rules.map((r, i) => (
          <li key={`${r}-${i}`} className="flex items-start gap-2 text-xs">
            <span className="flex-1">{r}</span>
            <button className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onRemove(i)}>✕</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1.5 text-xs outline-none"
          placeholder={t`es. comandi ls e cat dentro la home del bot`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(); setValue('') } }}
        />
        <button
          className="rounded-full bg-card px-3 py-1.5 text-xs transition hover:bg-card/80 disabled:opacity-40"
          disabled={!value.trim()}
          onClick={() => { onAdd(); setValue('') }}
        >
          <Trans>Aggiungi</Trans>
        </button>
      </div>
    </div>
  )
}
