// Fase impostazioni (I4): la pagina Approvazioni in tre modi — «Chiedi»,
// «Automatico» (l'auto-revisione di oggi, col suo modello e le sue regole) e
// «Non chiedere» (ask → allow tranne le esclusioni fisse, con CONFERMA che
// dichiara le due differenze da Rakazo: i blocchi restano blocchi e le bozze
// verso l'esterno restano da confermare). Poi «Consensi salvati» con i nomi
// umani, e le regole per strumento sotto «Avanzate» (I4.5: nome umano in
// testa, nome tecnico piccolo sotto; message_user nei default).
//
// Fase design (DS4, Impostazioni): la pagina passa al sistema. I tre modi sono
// il segmento unico (SettingsSegments: largo quanto la scheda, un radiogroup —
// lo era già, ma con tre pillole scritte a mano); le azioni sono Button (chi
// toglie una regola è un bottone solo-icona con un nome accessibile: prima un
// «✕» senza nome); i campi sono Input; le intestazioni dei gruppi di consensi
// sono l'intestazione di gruppo del sistema, text-caption grigia 500 (prima in
// MAIUSCOLETTO); la conferma di «Non chiedere» è una scheda rounded-surface col
// titolo text-title. Ciò che leggono test e sonde non cambia: UN radiogroup
// con tre bottoni su questa pagina, i testid dei gruppi, i <code> dei nomi
// tecnici. `initial` sono i dati di partenza, per i test senza effect (nel
// prodotto si carica dall'api, come prima).
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { X } from 'lucide-react'
import { api, useStore } from '../../store'
import { useBotInfo } from '../../bot/use-bot'
import { Bot } from '../../bot/Bot'
import type { ApprovalsMode, AutoReviewSettings, PermissionMode } from '../../../../shared/types'
import { DEFAULT_AUTO_REVIEW, approvalsModeOf } from '../../../../shared/types'
import { toolDisplayName } from '../../../../shared/tool-names'
// fase use-app (U3): i consensi di use-app si chiamano per APP o per HOST
import { grantDisplayName, groupGrantsByBot, grantKindOf, type GrantLike } from '../../lib/approval-app'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { SettingsPage } from './SettingsPage'
import { SettingsGroup } from './SettingsGroup'
import { SettingsRow, SettingsSegments, FIELD_ROW_CLS, FOCUS_RING, ROSSA_AL_PASSAGGIO } from './SettingsRow'
import { SettingsAdvanced } from './SettingsAdvanced'

const MODES: ReadonlyArray<{ id: ApprovalsMode; label: MessageDescriptor }> = [
  { id: 'ask', label: msg`Chiedi` },
  { id: 'auto', label: msg`Automatico` },
  { id: 'never', label: msg`Non chiedere` }
]

const MODE_SENTENCES: Record<ApprovalsMode, MessageDescriptor> = {
  ask: msg`Il bot chiede prima di ogni azione che cambia qualcosa: inviare, scrivere, eseguire comandi. Leggere non chiede.`,
  // RW (fase revisore sulla richiesta): il giudice di Rakazo — passa ciò che
  // serve a ciò che hai chiesto, chiede ciò che va oltre e non si annulla
  auto: msg`Un modello controlla ogni azione: fa passare quello che serve a ciò che hai chiesto e ti chiede quando va oltre e non si annulla facilmente (scrivere a qualcuno, pagare, cancellare, pubblicare). Le tue regole vengono prima.`,
  never: msg`Ogni azione parte senza aspettare.`
}

/** Una concessione salvata, come arriva da grantsList. */
type GrantRow = { id: number; tool: string; target: string; createdAt: number; scope?: 'readOnly' | null; expiresAt?: number | null }

/** I dati di partenza (per i test senza effect; nel prodotto si caricano dall'api). */
export interface ApprovalsPageInitial {
  mode?: ApprovalsMode
  cfg?: AutoReviewSettings
  grants?: GrantRow[] | null
}

/** Un link-bottone dentro una riga (il rimando «Cambia in Modelli ›»): testo in primo piano, sottolineato al passaggio. */
const LINK_BOTTONE = cn('rounded-control px-1.5 py-1 text-body text-primary transition hover:underline', FOCUS_RING)

/** U7: l'intestazione di un gruppo di consensi — il bot (mascotte e nome), o «Tutti i bot» per le righe NULL. */
function GrantBotHeader({ agentId }: { agentId: string | null }) {
  const agents = useStore((s) => s.agents)
  const info = useBotInfo(agentId ?? '')
  if (agentId === null) {
    return (
      <p className="px-4 pb-1 pt-3 text-caption font-medium text-muted-foreground" data-testid="grants-bot-all">
        <Trans>Tutti i bot</Trans>
      </p>
    )
  }
  return (
    <p className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-caption font-medium text-muted-foreground">
      {info ? <Bot family={info.avatar.family} color={info.avatar.color} state={info.state} size={16} label={undefined} /> : null}
      {agents.find((a) => a.id === agentId)?.name ?? agentId}
    </p>
  )
}

/** U7: il tipo del consenso in chiaro («comando», «app», «sito», «strumento»). */
function grantKindLabelOf(tool: string, locale: 'it' | 'en'): string {
  const kind = grantKindOf(tool)
  if (locale === 'en') return kind === 'comando' ? 'command' : kind === 'app' ? 'app' : kind === 'sito' ? 'site' : 'tool'
  return kind
}

export function ApprovalsPage({ initial }: { initial?: ApprovalsPageInitial }) {
  const { t, i18n } = useLingui()
  const permissions = useStore((s) => s.permissions)
  const refreshPermissions = useStore((s) => s.refreshPermissions)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const prefill = useStore((s) => s.autoreviewPrefill)
  const [mode, setMode] = useState<ApprovalsMode | null>(initial?.mode ?? null)
  const [cfg, setCfg] = useState<AutoReviewSettings | null>(initial?.cfg ?? null)
  const [pendingNever, setPendingNever] = useState(false)
  const [newAllow, setNewAllow] = useState('')
  const [newBlock, setNewBlock] = useState('')
  const [grants, setGrants] = useState<GrantRow[] | null>(initial?.grants ?? null)

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

  if (mode === null || !cfg || !permissions) return <p className="text-small text-muted-foreground"><Trans>caricamento…</Trans></p>

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
    <SettingsPage>
      {/* ---- I4.2 · Quando chiedere ---- */}
      <SettingsGroup label={<Trans>Quando chiedere</Trans>}>
        <div className="px-4 py-row-pad">
          {/* il segmento dei tre modi: largo quanto la scheda, alto 36 (sta in una pagina, non in una riga).
              «Non chiedere» non si salva al clic: chiede la conferma (qui sotto) */}
          <SettingsSegments<ApprovalsMode>
            size="md"
            fill
            label={t`Quando chiedere`}
            value={mode}
            onChange={(m) => {
              if (m === 'never' && mode !== 'never') setPendingNever(true)
              else void saveMode(m)
            }}
            options={MODES.map((m) => ({ value: m.id, label: i18n.t(m.label) }))}
          />
          <p className="mt-3 text-small text-muted-foreground">{i18n.t(MODE_SENTENCES[mode])}</p>
          {/* AH5 (fase aiutanti): accanto a «Chiedi», la riga che dice cosa
              cambia nel computer dei bot */}
          {mode === 'ask' && (
            <p className="mt-1 text-small text-muted-foreground">
              <Trans>Nel computer dei bot i comandi girano senza chiedere: è isolato dal Mac.</Trans>
            </p>
          )}
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
                  <button type="button" className={LINK_BOTTONE} onClick={() => setSettingsTab('modelli')}>
                    <Trans>Cambia in Modelli ›</Trans>
                  </button>
                </span>
              }
            />
            <RuleList
              title={msg`Continua da solo quando…`}
              hint={msg`Le regole servono per allargare ciò che passa da solo, non sono necessarie: anche senza, il revisore fa passare quello che serve a ciò che hai chiesto.`}
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
        {grants === null && <div className="flex min-h-row items-center px-4 text-body text-muted-foreground">…</div>}
        {grants?.length === 0 && <div className="flex min-h-row items-center px-4 text-body text-muted-foreground"><Trans>(nessun consenso salvato)</Trans></div>}
        {/* U7 (fase prima-release): i consensi raggruppati per BOT (nome e
            mascotte), col gruppo «Tutti i bot» per quelli di oggi (NULL) */}
        {grants !== null && groupGrantsByBot(grants as GrantLike[]).map((group) => (
          <div key={group.agentId ?? '__tutti__'} data-testid="grants-bot-group">
            <GrantBotHeader agentId={group.agentId} />
            {group.grants.map((g) => (
              <SettingsRow
                key={g.id}
                title={grantDisplayName(g, i18n.locale === 'en' ? 'en' : 'it')}
                description={
                  <span>
                    {/* U7: la parola in monospazio e il tipo in chiaro */}
                    {g.tool === 'run-command' ? <code className="font-mono text-caption">{g.target}</code> : <code className="font-mono text-caption">{g.tool}{g.target !== '*' ? ` · ${g.target}` : ''}</code>}
                    <span className="ml-2 text-caption text-muted-foreground">{grantKindLabelOf(g.tool, i18n.locale === 'en' ? 'en' : 'it')}</span>
                    {g.expiresAt != null && (
                      <span className="ml-2 text-caption text-muted-foreground">
                        <Trans>Scade: {new Date(g.expiresAt).toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' })}</Trans>
                      </span>
                    )}
                  </span>
                }
                control={
                  // quieta: grigia finché non ci si passa sopra (è lei che toglie, senza conferma)
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn('bg-card', ROSSA_AL_PASSAGGIO)}
                    onClick={() => { void api.grantRevoke(g.id).then(loadGrants).catch(() => undefined) }}
                  >
                    <Trans>Revoca</Trans>
                  </Button>
                }
              />
            ))}
          </div>
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
              description={<code className="font-mono text-caption">{r.tool}{r.pattern !== '*' ? ` · ${r.pattern}` : ''}</code>}
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
          <div className="flex w-full max-w-md flex-col gap-block rounded-surface bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <strong className="block text-title font-semibold"><Trans>Non chiedere più?</Trans></strong>
            <p className="text-body text-muted-foreground">
              <Trans>
                Il bot agirà senza chiederti niente, anche per inviare o cancellare. Restano solo le protezioni fisse:
                le azioni bloccate restano bloccate e le bozze verso l’esterno restano da confermare.
              </Trans>
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingNever(false)}>
                <Trans>Annulla</Trans>
              </Button>
              <Button onClick={() => { setPendingNever(false); void saveMode('never') }}>
                <Trans>Non chiedere più</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  )
}

/** Il selettore dei tre modi di una regola (Consenti sempre / Chiedi / Blocca): una pillola da 32, la misura dei controlli in riga. */
export function ModeSelect({ value, onChange }: { value: PermissionMode; onChange(v: PermissionMode): Promise<void> | void }) {
  const { t } = useLingui()
  return (
    <Select
      className={cn(FIELD_ROW_CLS, 'w-auto shrink-0 rounded-full')}
      value={value}
      onChange={(e) => void onChange(e.target.value as PermissionMode)}
    >
      <option value="always_allow">{t`Consenti sempre`}</option>
      <option value="needs_approval">{t`Chiedi approvazione`}</option>
      <option value="blocked">{t`Blocca`}</option>
    </Select>
  )
}

/** Le due liste di regole dell'Automatico, dentro la scheda: non sono mai le prime (sopra c'è sempre la riga del modello), e portano il filetto in cima. */
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
    <div className="border-t border-border/40 px-4 py-row-pad">
      <div className="text-body font-medium">{i18n.t(title)}</div>
      <div className="mt-0.5 text-small text-muted-foreground">{i18n.t(hint)}</div>
      <ul className="mt-2 flex flex-col gap-1">
        {rules.length === 0 && <li className="text-small text-muted-foreground"><Trans>(nessuna regola)</Trans></li>}
        {rules.map((r, i) => (
          <li key={`${r}-${i}`} className="flex items-center gap-2 text-body">
            <span className="min-w-0 flex-1">{r}</span>
            {/* un bottone solo-icona, ma con un nome: prima era un «✕» senza */}
            <Button variant="ghost" icon size="sm" aria-label={t`Rimuovi`} onClick={() => onRemove(i)}>
              <X className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <Input
          className={cn(FIELD_ROW_CLS, 'min-w-0 flex-1')}
          placeholder={t`es. comandi ls e cat dentro la home del bot`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(); setValue('') } }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!value.trim()}
          onClick={() => { onAdd(); setValue('') }}
        >
          <Trans>Aggiungi</Trans>
        </Button>
      </div>
    </div>
  )
}
