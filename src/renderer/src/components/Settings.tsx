// Impostazioni — fase impostazioni (I5): UNO stile per tutte le pagine. La
// colonna di sezioni a sinistra prende le ICONE (lucide), il dialogo non
// dà il fuoco al primo bottone all'apertura (niente anello arancione: il
// fuoco va al titolo; con la tastiera l'anello resta, via :focus-visible),
// e ogni pagina usa gli stessi pezzi di components/settings/: titolo
// (SettingsPage), gruppo a scheda (SettingsGroup), riga nome/controllo
// (SettingsRow), «Avanzate» chiuso (SettingsAdvanced). Modelli e Approvazioni
// vivono nei loro file (I2/I4); la finestra «App» e la sezione «App e skill»
// restano come sono (I7).
import { useEffect, useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Blocks, Cpu, Gauge, KeyRound, Repeat, Settings as SettingsIcon, ShieldCheck, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, useStore } from '../store'
import { formatDate, formatTime } from '../lib/i18n'
import { SUPPORTED_UI_LANGUAGES, type UiLanguageSetting } from '../../../shared/ui-language'
import { describeTrigger } from '../../../shared/cron-human'
// fase 17c (C5/C6): lingua attiva per le descrizioni; fiducia e template dai codici
import { i18n } from '../lib/i18n'
import { VaultTab } from './VaultSettings'
import { choosePollTool, chooseQueryArgName } from '../../../shared/triggers'
import type { RoutineInfo, RoutineSuggestion, ConnectorInfo, McpServerInfo, RoutineTrigger, ThinkingSetting, WebSearchStatusRpc, WebSearchProviderStatusRpc, ModelUsageRow, ModelPrice, ModelPriceMap } from '../../../shared/types'
// fase 18b (K2): la selezione delle righe dell'editor dei prezzi (funzione pura)
import { priceEditorRows } from '../lib/price-editor'
// fase 16c (C3.4): i base URL noti e la prova «vale solo l'ultima»
import { isLocalKind } from '../../../main/agent/live-models'
// fase 16c correzioni (R5): la valuta nella lingua dell'interfaccia
import { fmtUsd as fmtUsdIn } from '../lib/fmt'
import type { UiTheme } from '../theme'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
// fase 18b (H5.3): il ModelPicker resta per il modello della ROUTINE (I1: qui
// serve ancora un campo a testo libero per un id non ancora in elenco)
import { ModelPicker, THINKING_LABELS } from './ui/ModelPicker'
// fase 16c (C4): la vista condivisa con la finestra «Collega app»
import { AppsView } from './AppsWindow'
// fase impostazioni (I2/I4/I5): le pagine nuove e i pezzi comuni
import { ModelsPage } from './settings/ModelsPage'
import { ApprovalsPage } from './settings/ApprovalsPage'
import { SettingsPage } from './settings/SettingsPage'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'
import { SettingsAdvanced } from './settings/SettingsAdvanced'

/** Le sezioni con i nomi e le icone per la UI (I5.4). */
const SECTIONS: Record<string, { label: MessageDescriptor; icon: LucideIcon }> = {
  generale: { label: msg`Generali`, icon: SettingsIcon },
  modelli: { label: msg`Modelli`, icon: Cpu },
  app: { label: msg`App e skill`, icon: Blocks },
  approvazioni: { label: msg`Approvazioni`, icon: ShieldCheck },
  vault: { label: msg`Cassaforte`, icon: KeyRound },
  routine: { label: msg`Routine`, icon: Repeat },
  uso: { label: msg`Uso e costi`, icon: Gauge }
}

/** RV3 (fase beta.2): le select gemelle di Generali (Finestra di consegna, Lingua). */
const SETTINGS_SELECT_CLS = 'h-9 rounded-[10px] bg-card px-2 text-sm outline-none'

/** La lingua attiva come UiLanguage (fase 17c, C6). */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

export function Settings() {
  const { i18n } = useLingui()
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const pendingTab = useStore((s) => s.settingsTab)
  // RV2 (fase beta.2): la scheda richiesta è già il valore INIZIALE (niente
  // primo fotogramma su «Generali» che poi salta); l'effetto sotto resta per
  // i cambi a finestra aperta e consuma il setting
  const initialTab = pendingTab ? (pendingTab in SECTIONS ? pendingTab : 'modelli') : 'generale'
  const [tab, setTab] = useState<string>(initialTab)


  // fase 7: un widget può chiedere di aprire una sezione precisa (es. il
  // provider durante l'onboarding): lo si applica UNA volta e si consuma.
  // RV2 (fase beta.2): la scheda richiesta è già il valore INIZIALE (niente
  // primo fotogramma su «Generali» che poi salta); l'effetto resta per i
  // cambi a finestra aperta e consuma il setting
  useEffect(() => {
    if (pendingTab) {
      setTab(pendingTab in SECTIONS ? pendingTab : 'modelli')
      setSettingsTab(null)
    }
  }, [pendingTab, setSettingsTab])

  return (
    <Dialog open onOpenChange={(o) => !o && setSettingsOpen(false)}>
      <DialogContent
        className="flex h-[min(760px,calc(100vh-48px))] w-[min(1080px,calc(100vw-48px))] max-w-[min(1080px,calc(100vw-48px))] gap-0 p-0"
        showCloseButton={false}
        // I5.5: niente anello arancione all'apertura — il fuoco automatico del
        // dialogo va al primo bottone («Generali») e l'anello si vede anche col
        // mouse; lo si previene e il fuoco passa al titolo della colonna
        onOpenAutoFocus={(e) => { e.preventDefault(); document.getElementById('sandbot-settings-title')?.focus() }}
      >
        <DialogTitle className="sr-only"><Trans>Impostazioni</Trans></DialogTitle>
        {/* fase 16c (C2) → I5.4: colonna di sezioni con ICONE, selezione su
            bg-muted, NESSUN bordo; l'anello del fuoco SOLO da tastiera
            (:focus-visible), mai al clic col mouse */}
        <nav className="w-52 shrink-0 space-y-0.5 overflow-y-auto scroll-thin p-3">
          <strong id="sandbot-settings-title" tabIndex={-1} className="block px-3 pb-3 pt-1 font-display text-lg outline-none">
            {i18n._(msg`Impostazioni`)}
          </strong>
          {(Object.keys(SECTIONS) as string[]).map((t) => {
            const Icon = SECTIONS[t]!.icon
            return (
              <button
                key={t}
                className={`flex w-full items-center gap-2.5 rounded-full px-3 py-2 text-left text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 ${tab === t ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setTab(t)}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{i18n.t(SECTIONS[t]!.label)}</span>
              </button>
            )
          })}
        </nav>
        {/* RV2 (fase beta.2): la ✕ sta FUORI dal contenitore che scorre — resta
            visibile a qualunque scorrimento, in OGNI scheda (prima era absolute
            DENTRO lo scroller e se ne andava col contenuto) */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* la ✕ tonda in alto a destra (Esc chiude, come sempre nel Dialog) */}
          <button
            className="absolute right-5 top-4 z-10 grid size-9 place-items-center rounded-full bg-muted text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label={i18n._(msg`Chiudi`)}
            onClick={() => setSettingsOpen(false)}
          >
            <X className="size-4" />
          </button>
          <div className="@container min-h-0 flex-1 overflow-y-auto scroll-thin">
            <div className="px-6 py-6">
              {tab === 'generale' && <GeneralTab />}
              {tab === 'modelli' && <ModelsPage />}
              {/* RV2: embedded — una sola ✕, quella delle Impostazioni */}
              {tab === 'app' && <AppsView embedded />}
              {tab === 'approvazioni' && <ApprovalsPage />}
              {tab === 'vault' && (
                <SettingsPage title={<Trans>Cassaforte</Trans>}>
                  <VaultTab />
                </SettingsPage>
              )}
              {tab === 'routine' && <RoutinesTab />}
              {tab === 'uso' && <UsageTab />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** I5.3: L'unico interruttore delle impostazioni (quello di «Mostra i passaggi»). */
export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean
  onChange(v: boolean): void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`relative h-6 w-10 shrink-0 rounded-full transition ${checked ? 'bg-foreground' : 'bg-muted-foreground/30'} ${disabled ? 'opacity-40' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={`absolute top-0.5 size-5 rounded-full bg-card transition-all ${checked ? 'right-0.5' : 'left-0.5'}`} />
    </button>
  )
}

/** I5.3: il campo numerico (look-around, pausa) — un campo VERO, non testo. */
function NumberField({ value, onChange, min, width, ariaLabel }: {
  value: number
  onChange(v: number): void
  min?: number
  width?: string
  ariaLabel: string
}) {
  return (
    <input
      type="number"
      min={min}
      aria-label={ariaLabel}
      className={`h-9 rounded-[10px] bg-card px-2.5 text-sm tabular-nums outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 ${width ?? 'w-20'}`}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

// ---- fase 6 → I5.6: Generali riordinata — Aspetto · All'avvio · Consegna ·
// Notifiche, e le cose da sviluppatore dietro «Avanzate» ----

function GeneralTab() {
  const { t, i18n } = useLingui()
  const agents = useStore((s) => s.agents)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const debugSteps = useStore((s) => s.debugSteps)
  const setDebugSteps = useStore((s) => s.setDebugSteps)
  const uiLanguage = useStore((s) => s.uiLanguage)
  const setUiLanguage = useStore((s) => s.setUiLanguage)
  const [atLogin, setAtLogin] = useState<{ enabled: boolean; requiresApproval: boolean; mechanism: 'agentService' | 'plist' }>({ enabled: false, requiresApproval: false, mechanism: 'plist' })
  const [busy, setBusy] = useState(false)
  // RV1 (fase beta.2): lo stato dell'aggiornamento arriva dallo store (lo
  // riempie App all'avvio); versione, canUpdate e canale vivono lì
  const updater = useStore((s) => s.updaterStatus)
  const appVersion = updater.current
  const canUpdate = updater.canUpdate
  // RP3 (fase rilascio di prova): il canale degli aggiornamenti (locale per
  // l'interruttore ottimistico, si sincronizza quando arriva lo stato)
  const [betaChannel, setBetaChannel] = useState(false)
  useEffect(() => { setBetaChannel(updater.channel === 'beta') }, [updater.channel])
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] = useState<'none' | 'available' | 'current' | 'error'>('none')
  const [tz, setTz] = useState('')
  const [winMode, setWinMode] = useState<'morning' | 'working'>('morning')
  const [morning, setMorning] = useState({ start: '08:30', end: '09:30' })
  const [working, setWorking] = useState({ start: '09:00', end: '19:00' })
  const [minAwayHours, setMinAwayHours] = useState(12)
  const [awayPauseDays, setAwayPauseDays] = useState(7)
  const [disabledNotifications, setDisabledNotifications] = useState<string[]>([])
  const [libStats, setLibStats] = useState<{ bytes: number; warn: boolean } | null>(null)

  useEffect(() => { void api.libraryStats().then(setLibStats).catch(() => undefined) }, [])
  useEffect(() => {
    void api.getLaunchAtLogin().then(setAtLogin)
    void api.settingsGet('userTimeZone', '').then(setTz)
    void api.settingsGet('deliveryWindow', { mode: 'morning', morning: { start: '08:30', end: '09:30' }, working: { start: '09:00', end: '19:00' } })
      .then((w) => {
        const cfg = w as { mode: 'morning' | 'working'; morning: { start: string; end: string }; working: { start: string; end: string } }
        setWinMode(cfg.mode)
        setMorning(cfg.morning)
        setWorking(cfg.working)
      })
    void api.settingsGet('minAwayHours', 12).then((v) => setMinAwayHours(Number(v) || 12))
    void api.settingsGet('awayPauseDays', 7).then((v) => setAwayPauseDays(Number(v) || 7))
    void api.settingsGet('notifications.disabledAgents', []).then((v) => setDisabledNotifications(Array.isArray(v) ? (v as string[]) : []))
  }, [])

  async function toggle(enabled: boolean) {
    setBusy(true)
    try {
      await api.setLaunchAtLogin(enabled)
      setAtLogin(await api.getLaunchAtLogin())
    } finally {
      setBusy(false)
    }
  }

  async function checkUpdates(): Promise<void> {
    setUpdateBusy(true)
    setUpdateResult('none')
    try {
      const r = await api.updaterCheck()
      setUpdateResult(r.available ? 'available' : r.error ? 'error' : 'current')
    } catch {
      setUpdateResult('error')
    } finally {
      setUpdateBusy(false)
    }
  }

  // RP3 (fase rilascio di prova): l'interruttore cambia il canale ORA, senza
  // riavvio — il main lo applica al updater e lo salva nel setting
  async function toggleBetaChannel(enabled: boolean): Promise<void> {
    setBetaChannel(enabled)
    try {
      await api.setUpdaterChannel(enabled ? 'beta' : 'stable')
    } catch {
      setBetaChannel(!enabled)
    }
  }

  const saveWindow = async (): Promise<void> => {
    await api.settingsSet('deliveryWindow', { mode: winMode, morning, working })
  }
  const toggleAgentNotification = async (agentId: string, off: boolean): Promise<void> => {
    const next = off ? disabledNotifications.filter((a) => a !== agentId) : [...disabledNotifications, agentId]
    setDisabledNotifications(next)
    await api.settingsSet('notifications.disabledAgents', next)
  }

  return (
    <SettingsPage title={<Trans>Generali</Trans>}>
      {/* ---- Aspetto ---- */}
      <SettingsGroup label={<Trans>Aspetto</Trans>}>
        <SettingsRow
          title={<Trans>Tema</Trans>}
          control={
            <span className="flex gap-1 rounded-full bg-card p-1">
              {([['system', msg`Sistema`], ['light', msg`Chiaro`], ['dark', msg`Scuro`]] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={`rounded-full px-3 py-1 text-xs outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 ${theme === value ? 'bg-foreground text-background' : 'text-muted-foreground'}`}
                  onClick={() => setTheme(value as UiTheme)}
                >
                  {i18n.t(label)}
                </button>
              ))}
            </span>
          }
        />
        {/* RV3 (fase beta.2): una select (le pillole vanno bene per 2–3 voci,
            le lingue cresceranno) — la STESSA della «Finestra di consegna».
            Le voci dall'elenco unico SUPPORTED_UI_LANGUAGES, scritte col
            ENDONIMO: gli endonimi non si traducono */}
        <SettingsRow
          title={<Trans>Lingua</Trans>}
          control={
            <select
              className={SETTINGS_SELECT_CLS}
              aria-label={t`Lingua`}
              data-testid="ui-language-select"
              value={uiLanguage}
              onChange={(e) => setUiLanguage(e.target.value as UiLanguageSetting)}
            >
              <option value="system">{t`Sistema`}</option>
              {SUPPORTED_UI_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.endonym}</option>
              ))}
            </select>
          }
        />
      </SettingsGroup>

      {/* ---- All'avvio ---- */}
      <SettingsGroup label={<Trans>All’avvio</Trans>}>
        <SettingsRow
          title={<Trans>Avvia all’accesso</Trans>}
          description={<Trans>I bot restano attivi anche a finestra chiusa.</Trans>}
          control={<Toggle label={t`Avvia all’accesso`} checked={atLogin.enabled} disabled={busy} onChange={(v) => void toggle(v)} />}
        />
        {atLogin.requiresApproval && (
          <SettingsRow
            title={<Trans>Per attivarlo, macOS chiede il tuo via</Trans>}
            description={<Trans>Apri Elementi login e attiva Homun.</Trans>}
            control={
              <button
                className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => void api.openLoginItemsSettings()}
              >
                <Trans>Apri Elementi login</Trans>
              </button>
            }
          />
        )}
        {/* RV1 (fase beta.2): data-testid per i test del render (niente DOM nel repo) */}
        <div data-testid="settings-update-row">
          <SettingsRow
            title={<Trans>Versione e aggiornamenti</Trans>}
            description={<span className="font-mono text-xs">{appVersion || '—'}</span>}
            control={
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {!canUpdate ? (
                  <Trans>Questa build non riceve aggiornamenti</Trans>
                ) : updater.needsMove ? (
                  // l'app va spostata in Applicazioni: il motivo e il bottone
                  // che RIPROPONE lo spostamento (gli aggiornamenti sono spenti
                  // per questa sessione, e «Controlla aggiornamenti» non può
                  // funzionare: il main risponde comunque needsMove, mai silenzio)
                  <>
                    <span className="text-waiting"><Trans>Per gli aggiornamenti sposta Homun in Applicazioni</Trans></span>
                    <button
                      className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      data-testid="move-to-applications"
                      onClick={() => { void api.moveToApplications() }}
                    >
                      <Trans>Sposta in Applicazioni</Trans>
                    </button>
                  </>
                ) : (
                  <>
                    {updateResult === 'current' && <span className="text-chart-2"><Trans>Aggiornato</Trans></span>}
                    {updateResult === 'available' && <span><Trans>Versione nuova disponibile</Trans></span>}
                    {updateResult === 'error' && <span><Trans>Controllo non riuscito</Trans></span>}
                    <button
                      className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
                      disabled={updateBusy}
                      onClick={() => void checkUpdates()}
                    >
                      <Trans>Controlla aggiornamenti</Trans>
                    </button>
                  </>
                )}
              </span>
            }
          />
        </div>
        {/* RP3 (fase rilascio di prova): il canale degli aggiornamenti, sotto
            «Controlla aggiornamenti» — le prerelease le vede solo chi le chiede */}
        <SettingsRow
          title={<Trans>Ricevi le versioni di prova</Trans>}
          description={<Trans>Sono versioni da far provare prima del rilascio: possono avere difetti.</Trans>}
          control={<Toggle label={t`Ricevi le versioni di prova`} checked={betaChannel} onChange={(v) => void toggleBetaChannel(v)} />}
        />
      </SettingsGroup>

      {/* ---- Consegna ---- */}
      <SettingsGroup label={<Trans>Consegna</Trans>}>
        <SettingsRow
          title={<Trans>Fuso orario</Trans>}
          control={
            <input
              className="h-9 w-44 rounded-[10px] bg-card px-2.5 text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              onBlur={() => void api.settingsSet('userTimeZone', tz.trim())}
            />
          }
        />
        <SettingsRow
          title={<Trans>Finestra di consegna</Trans>}
          description={<Trans>I messaggi non urgenti delle routine aspettano questa finestra.</Trans>}
          control={
            <span className="flex shrink-0 items-center gap-2">
              <select
                className={SETTINGS_SELECT_CLS}
                value={winMode}
                onChange={(e) => { setWinMode(e.target.value as 'morning' | 'working'); void saveWindow() }}
              >
                <option value="morning">{t`mattina`}</option>
                <option value="working">{t`orario lavorativo`}</option>
              </select>
              {winMode === 'morning' ? (
                <>
                  <input className="h-9 w-16 rounded-[10px] bg-card px-2 text-center text-sm tabular-nums outline-none" value={morning.start} onChange={(e) => setMorning({ ...morning, start: e.target.value })} onBlur={() => void saveWindow()} />
                  <span className="text-muted-foreground">–</span>
                  <input className="h-9 w-16 rounded-[10px] bg-card px-2 text-center text-sm tabular-nums outline-none" value={morning.end} onChange={(e) => setMorning({ ...morning, end: e.target.value })} onBlur={() => void saveWindow()} />
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">{t`lun–ven`}</span>
                  <input className="h-9 w-16 rounded-[10px] bg-card px-2 text-center text-sm tabular-nums outline-none" value={working.start} onChange={(e) => setWorking({ ...working, start: e.target.value })} onBlur={() => void saveWindow()} />
                  <span className="text-muted-foreground">–</span>
                  <input className="h-9 w-16 rounded-[10px] bg-card px-2 text-center text-sm tabular-nums outline-none" value={working.end} onChange={(e) => setWorking({ ...working, end: e.target.value })} onBlur={() => void saveWindow()} />
                </>
              )}
            </span>
          }
        />
      </SettingsGroup>

      {/* ---- Notifiche ---- */}
      <SettingsGroup label={<Trans>Notifiche</Trans>}>
        {agents.map((a) => {
          const off = disabledNotifications.includes(a.id)
          return (
            <SettingsRow
              key={a.id}
              title={a.name}
              description={off ? t`disattivate` : t`quando finisce o mi aspetta`}
              control={<Toggle label={a.name} checked={!off} onChange={(v) => void toggleAgentNotification(a.id, !v)} />}
            />
          )
        })}
        {agents.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground"><Trans>(nessun bot)</Trans></div>}
      </SettingsGroup>

      {/* fase 14 (punto 1): l'avviso della Libreria resta, in fondo */}
      {libStats?.warn && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <Trans>Libreria: {(libStats.bytes / 1024 / 1024 / 1024).toFixed(1)} GB — oltre i 2 GB consigliati. Valuta cosa cancellare dalla vista Libreria (nessun blocco automatico).</Trans>
        </p>
      )}

      {/* ---- Avanzate (I5.6): le cose da sviluppatore, chiuse ---- */}
      <SettingsAdvanced>
        <SettingsGroup>
          <SettingsRow
            title={<Trans>Mostra i passaggi in chat</Trans>}
            description={<Trans>Le chiamate e i risultati dei tool tornano come righe nella conversazione (per il debug).</Trans>}
            control={<Toggle label={t`Mostra i passaggi in chat`} checked={debugSteps} onChange={setDebugSteps} />}
          />
          <SettingsRow
            title={<Trans>Look-around al rientro</Trans>}
            description={<Trans>Dopo queste ore di assenza, il bot guarda cosa è cambiato.</Trans>}
            control={
              <span className="flex items-center gap-1.5">
                <NumberField ariaLabel={t`Look-around al rientro dopo (ore di assenza)`} min={1} value={minAwayHours}
                  onChange={(v) => {
                    // fase skill (S10.1): il valore si SALVA, non resta solo nello stato locale
                    setMinAwayHours(v)
                    void api.settingsSet('minAwayHours', v)
                  }} />
                <span className="text-xs text-muted-foreground"><Trans>ore</Trans></span>
              </span>
            }
          />
          <SettingsRow
            title={<Trans>Pausa delle routine</Trans>}
            description={<Trans>Dopo questi giorni di assenza, le routine si fermano.</Trans>}
            control={
              <span className="flex items-center gap-1.5">
                <NumberField ariaLabel={t`Pausa delle routine dopo (giorni di assenza)`} min={1} value={awayPauseDays}
                  onChange={(v) => {
                    // fase skill (S10.1): il valore si SALVA, non resta solo nello stato locale
                    setAwayPauseDays(v)
                    void api.settingsSet('awayPauseDays', v)
                  }} />
                <span className="text-xs text-muted-foreground"><Trans>giorni</Trans></span>
              </span>
            }
          />
        </SettingsGroup>
        <WebSearchSection />
      </SettingsAdvanced>
    </SettingsPage>
  )
}

/** I5.6 (da I2.5): la sezione «Ricerca web» — l'interruttore dei servizi senza
 *  chiave (You.com, Exa, Tavily), la nota sulla privacy e lo stato per provider. */
function WebSearchSection() {
  const { t } = useLingui()
  const [keyless, setKeyless] = useState<boolean | null>(null)
  const [status, setStatus] = useState<WebSearchStatusRpc | null>(null)

  const refresh = () => {
    void api.settingsGet<boolean>('webSearch.keyless', true).then(setKeyless).catch(() => setKeyless(null))
    void api.webSearchStatus().then(setStatus).catch(() => setStatus(null))
  }
  useEffect(refresh, [])

  const toggle = async (v: boolean): Promise<void> => {
    setKeyless(v)
    await api.settingsSet('webSearch.keyless', v)
    refresh()
  }

  const stateOf = (p: WebSearchProviderStatusRpc): { text: string; cls: string } => {
    if (p.cooldownUntil) {
      return {
        text: t`in raffreddamento fino a ${formatTime(p.cooldownUntil)}`,
        cls: 'text-destructive'
      }
    }
    if (p.lastError) {
      return { text: t`ultimo errore: ${p.lastError.kind}${p.lastError.status !== undefined ? t` (HTTP ${p.lastError.status})` : ''}`, cls: 'text-muted-foreground' }
    }
    return { text: t`disponibile`, cls: 'text-chart-2' }
  }

  return (
    <SettingsGroup label={<Trans>Ricerca web</Trans>}>
      <SettingsRow
        title={<Trans>Servizi di ricerca gratuiti</Trans>}
        description={
          <Trans>
            Le ricerche dei bot vengono inviate a questi servizi, secondo i loro termini d&apos;uso:{' '}
            <a className="text-primary hover:underline" href="https://you.com/acceptable-use-policy-may-2026" target="_blank" rel="noreferrer">You.com</a>
            {' · '}<a className="text-primary hover:underline" href="https://exa.ai/terms" target="_blank" rel="noreferrer">Exa</a>
            {' · '}<a className="text-primary hover:underline" href="https://docs.tavily.com/documentation/keyless" target="_blank" rel="noreferrer">Tavily</a>
          </Trans>
        }
        control={<Toggle label={t`Servizi di ricerca gratuiti`} checked={keyless ?? true} disabled={keyless === null} onChange={(v) => void toggle(v)} />}
      />
      {(status?.providers ?? []).length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/40 px-4 py-2.5">
          {(status?.providers ?? []).map((p) => (
            <span key={p.name} className={`text-xs ${stateOf(p).cls}`}>
              {p.label}: {stateOf(p).text}
            </span>
          ))}
        </div>
      )}
    </SettingsGroup>
  )
}

// ---- fase 18b (H6.2) → I5.7: Uso e costi — col TITOLO e i quattro numeri
// in riquadri separati, col costo in evidenza; le viste restano ----

/** Le finestre del periodo, calcolate in ora LOCALE nel renderer. */
type UsagePeriod = 'today' | '7d' | '30d' | 'month'

const PERIOD_LABELS: Record<UsagePeriod, MessageDescriptor> = {
  today: msg`Oggi`,
  '7d': msg`7 giorni`,
  '30d': msg`30 giorni`,
  month: msg`Questo mese`
}

/** L'inizio locale del periodo (ms epoch). */
function periodStart(p: UsagePeriod): number {
  const now = new Date()
  if (p === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (p === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return now.getTime() - (p === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000
}

/** Le etichette delle origini delle chiamate (le `source` di model_usage). */
const SOURCE_LABELS: Record<string, MessageDescriptor> = {
  turn: msg`turno`,
  group: msg`gruppo`,
  subagent: msg`sottoagente`,
  wake: msg`wake`,
  review: msg`review`,
  compaction: msg`compaction`,
  'quick-ask': msg`quick ask`,
  'routine-suggest': msg`suggerimento routine`
}

function UsageTab() {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const [period, setPeriod] = useState<UsagePeriod>('7d')
  const [view, setView] = useState<'model' | 'agent' | 'source'>('model')
  const [rows, setRows] = useState<ModelUsageRow[]>([])
  const [modelRows, setModelRows] = useState<ModelUsageRow[]>([])
  const [prices, setPrices] = useState<ModelPriceMap>({})
  const [loaded, setLoaded] = useState(false)

  const refresh = () => {
    const from = periodStart(period)
    setLoaded(false)
    void api.usageSummary(from, undefined, view).then((r) => { setRows(r); setLoaded(true) }).catch(() => { setRows([]); setLoaded(true) })
    void api.usageSummary(from, undefined, 'model').then(setModelRows).catch(() => setModelRows([]))
    void api.settingsGet<ModelPriceMap>('providers.modelPrices', {}).then(setPrices).catch(() => setPrices({}))
  }
  useEffect(refresh, [period, view])

  const fmtInt = (n: number): string => n.toLocaleString(i18n.locale === 'en' ? 'en' : 'it')
  const fmtUsd = (n: number): string => fmtUsdIn(n, i18n.locale)

  const totalCalls = rows.reduce((a, r) => a + r.calls, 0)
  const totalIn = rows.reduce((a, r) => a + r.input, 0)
  const totalOut = rows.reduce((a, r) => a + r.output, 0)
  const totalCost = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0)
  const anyUnknown = rows.some((r) => r.costUsd === null || r.costPartial)

  const costCell = (r: ModelUsageRow): { text: string; partial: boolean } => {
    if (r.costUsd !== null) return { text: fmtUsd(r.costUsd), partial: r.costPartial }
    if (isLocalKind(r.providerKind)) return { text: t`locale`, partial: false }
    return { text: '—', partial: false }
  }

  return (
    <SettingsPage title={<Trans>Uso e costi</Trans>}>
      {/* il periodo, come oggi */}
      <div className="flex flex-wrap items-center gap-1">
        {(Object.keys(PERIOD_LABELS) as UsagePeriod[]).map((p) => (
          <button
            key={p}
            className={`rounded-full px-2.5 py-1 text-xs outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 ${period === p ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setPeriod(p)}
          >
            {i18n.t(PERIOD_LABELS[p]!)}
          </button>
        ))}
      </div>

      {/* I5.7: i quattro numeri in riquadri separati, col costo in evidenza */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-2xl bg-muted/60 px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>chiamate</Trans></div>
          <div className="text-sm">{fmtInt(totalCalls)}</div>
        </div>
        <div className="rounded-2xl bg-muted/60 px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>token in</Trans></div>
          <div className="text-sm">{fmtInt(totalIn)}</div>
        </div>
        <div className="rounded-2xl bg-muted/60 px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>token out</Trans></div>
          <div className="text-sm">{fmtInt(totalOut)}</div>
        </div>
        <div className="rounded-2xl bg-foreground/90 px-3 py-2.5 text-background">
          <div className="text-[11px] uppercase tracking-wide text-background/70"><Trans>costo totale</Trans></div>
          <div className="font-display text-lg">{anyUnknown ? `≥ ${fmtUsd(totalCost)}` : fmtUsd(totalCost)}</div>
        </div>
      </div>
      {anyUnknown && (
        <p className="text-xs text-muted-foreground"><Trans>Il costo è un minimo: alcuni modelli non hanno un prezzo.</Trans></p>
      )}

      {/* le tre viste, come oggi */}
      <div className="flex w-fit items-center gap-1 rounded-full bg-muted p-1">
        {(['model', 'agent', 'source'] as const).map((v) => (
          <button
            key={v}
            className={`rounded-full px-2.5 py-1 text-xs outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 ${view === v ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setView(v)}
          >
            {v === 'model' ? t`per modello` : v === 'agent' ? t`per bot` : t`per origine`}
          </button>
        ))}
      </div>

      {/* la tabella, come oggi */}
      {!loaded ? (
        <p className="text-xs text-muted-foreground"><Trans>caricamento…</Trans></p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground"><Trans>Nessuna chiamata nel periodo.</Trans></p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-muted/60">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">{view === 'model' ? t`modello` : view === 'agent' ? t`bot` : t`origine`}</th>
                <th className="px-3 py-2 text-right"><Trans>chiamate</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>token in</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>token out</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>cache</Trans></th>
                <th className="px-3 py-2 text-right"><Trans>costo</Trans></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cost = costCell(r)
                const key = view === 'model' ? `${r.providerId}|${r.model}` : view === 'agent' ? (r.agentId ?? 'system') : r.source
                return (
                  <tr key={`${key}-${i}`} className="border-t border-border/30 first:border-0">
                    <td className="px-3 py-2 font-mono">
                      {view === 'model'
                        ? `${r.providerKind}:${r.model}`
                        : view === 'agent'
                          ? (r.agentName ?? t`Sistema`)
                          : (SOURCE_LABELS[r.source] ? i18n.t(SOURCE_LABELS[r.source]!) : r.source)}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.calls)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.input)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.output)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(r.cacheRead + r.cacheWrite)}</td>
                    <td className="px-3 py-2 text-right">
                      {cost.text}
                      {cost.partial && <span className="ml-1 text-[10px] text-muted-foreground">{t`parziale`}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <PriceSettings
        modelRows={modelRows}
        prices={prices}
        providers={providers}
        onSaved={refresh}
      />
    </SettingsPage>
  )
}

/**
 * Fase 18b (H6.2 → K2): i prezzi $/M dei modelli senza catalogo (salvano in
 * providers.modelPrices). Le righe le sceglie la funzione PURA priceEditorRows.
 */
function PriceSettings({ modelRows, prices, providers, onSaved }: {
  modelRows: ModelUsageRow[]
  prices: ModelPriceMap
  providers: ReturnType<typeof useStore.getState>['providers']
  onSaved(): void
}) {
  const target = priceEditorRows(modelRows, prices)

  if (target.length === 0) return null

  return (
    <SettingsGroup label={<Trans>Prezzi personalizzati</Trans>} footer={<Trans>Dollari per milione di token. Vale per le chiamate da qui in avanti, lo storico non cambia; svuota entrambi i campi per togliere un prezzo.</Trans>}>
      {target.map((r) => (
        <PriceRow
          key={`${r.providerId}|${r.model}`}
          providerId={r.providerId}
          model={r.model}
          label={providers.find((p) => p.id === r.providerId)?.name ?? r.providerKind}
          price={prices[r.providerId]?.[r.model]}
          onSaved={onSaved}
        />
      ))}
    </SettingsGroup>
  )
}

/** Fase 18b (K2): una riga dell'editor — svuotare ENTRAMBI i campi CANCELLA la voce. */
function PriceRow({ providerId, model, label, price, onSaved }: {
  providerId: string
  model: string
  label: string
  price?: ModelPrice
  onSaved(): void
}) {
  const { t } = useLingui()
  const [inVal, setInVal] = useState(price ? String(price.input) : '')
  const [outVal, setOutVal] = useState(price ? String(price.output) : '')

  const commit = async (): Promise<void> => {
    const all = await api.settingsGet<ModelPriceMap>('providers.modelPrices', {})
    // K2: entrambi i campi VUOTI → la voce si CANCELLA (un prezzo si può togliere)
    if (!inVal.trim() && !outVal.trim()) {
      const rest = { ...(all[providerId] ?? {}) }
      delete rest[model]
      await api.settingsSet('providers.modelPrices', { ...all, [providerId]: rest })
      onSaved()
      return
    }
    const cur = all[providerId]?.[model] ?? { input: 0, output: 0 }
    const num = (raw: string, old: number): number => {
      const n = Number(raw.replace(',', '.'))
      return raw.trim() && Number.isFinite(n) && n >= 0 ? n : old
    }
    const next = { input: num(inVal, cur.input), output: num(outVal, cur.output) }
    await api.settingsSet('providers.modelPrices', { ...all, [providerId]: { ...(all[providerId] ?? {}), [model]: next } })
    onSaved()
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-4 py-2.5 text-xs first:border-0">
      <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
      <span className="text-muted-foreground">{label}</span>
      <label className="flex items-center gap-1">
        <Trans>ingresso $/M</Trans>
        <input className="h-8 w-20 rounded-lg bg-card px-2 text-xs outline-none" type="text" value={inVal} onChange={(e) => setInVal(e.target.value)} onBlur={() => void commit()} aria-label={t`prezzo ingresso $/M`} />
      </label>
      <label className="flex items-center gap-1">
        <Trans>uscita $/M</Trans>
        <input className="h-8 w-20 rounded-lg bg-card px-2 text-xs outline-none" type="text" value={outVal} onChange={(e) => setOutVal(e.target.value)} onBlur={() => void commit()} aria-label={t`prezzo uscita $/M`} />
      </label>
    </div>
  )
}

// ---- fase 6: tab Routine (stile I5: titolo e gruppi, niente funzioni nuove) ----

type TriggerKind = 'schedule' | 'email' | 'calendar_event' | 'webhook' | 'connector_poll' | 'presence_return'

function kindOf(t: RoutineTrigger | null | undefined, legacySchedule?: string): TriggerKind {
  if (!t) return 'schedule'
  if (t.type === 'schedule') return 'schedule'
  if (t.type === 'connector_poll') return t.preset ?? 'connector_poll'
  return t.type
}

const KIND_LABEL: Record<TriggerKind, MessageDescriptor> = {
  schedule: msg`orario`,
  email: msg`email in arrivo`,
  calendar_event: msg`evento del calendario`,
  webhook: msg`webhook`,
  connector_poll: msg`poll di un connettore`,
  presence_return: msg`quando torni al computer`
}

function RoutinesTab() {
  const { t, i18n } = useLingui()
  const activeId = useStore((s) => s.activeId)
  const connectors = useStore((s) => s.connectors)
  const select = useStore((s) => s.select)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const openBotTab = useStore((s) => s.openBotTab)
  const [routines, setRoutines] = useState<RoutineInfo[]>([])
  const [editing, setEditing] = useState<RoutineInfo | null>(null)
  const [err, setErr] = useState('')
  const [suggestions, setSuggestions] = useState<RoutineSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  const [manualServers, setManualServers] = useState<McpServerInfo[]>([])

  const refresh = async () => {
    if (activeId) setRoutines(await api.listRoutines(activeId))
  }
  useEffect(() => { void refresh() }, [activeId])
  useEffect(() => {
    api.mcpList()
      .then((all) => setManualServers(all.filter((s) => s.enabled && !s.catalogId)))
      .catch(() => undefined)
  }, [])

  const pauseResume = async (r: RoutineInfo): Promise<void> => {
    // la ripresa dalla UI è un'azione dell'utente: nessuna card di approvazione
    await api.updateRoutine(r.id, r.enabled ? { enabled: 0 } : { enabled: 1 })
    await refresh()
  }

  return (
    <SettingsPage title={<Trans>Routine</Trans>}>
      <SettingsGroup label={<Trans>Del bot principale</Trans>}>
        {routines.map((r) => {
          const state = r.enabled ? t`attiva` : r.paused_for_away ? t`in pausa per assenza` : t`in pausa`
          const stateColor = r.enabled ? 'text-chart-2' : r.paused_for_away ? 'text-destructive' : 'text-muted-foreground'
          return (
            <div key={r.id} className="border-t border-border/40 px-4 py-3 first:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${r.enabled ? 'bg-chart-2' : r.paused_for_away ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
                <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{i18n.t(KIND_LABEL[kindOf(r.trigger)])}</span>
                <button
                  className="text-xs text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  title={t`Apri nel pannello del bot`}
                  onClick={() => {
                    void select(r.agent_id)
                    openBotTab('routines')
                    setSettingsOpen(false)
                  }}
                >
                  <Trans>nel bot ›</Trans>
                </button>
                <button className="text-xs text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => setEditing(r)}><Trans>modifica</Trans></button>
                <button className="text-xs text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => void pauseResume(r)}>
                  {r.enabled ? <Trans>metti in pausa</Trans> : <Trans>riattiva</Trans>}
                </button>
                <button className="text-xs text-muted-foreground outline-none transition hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={async () => { await api.deleteRoutine(r.id); await refresh() }}>
                  <Trans>elimina</Trans>
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{describeTrigger(r.trigger ?? null, r.schedule, uiLang())}</p>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                <span className={stateColor}>{state}</span>
                {r.next_run && <span>{t`prossima: ${formatDate(r.next_run)}`}</span>}
                {r.last_run && <span>{t`ultima: ${formatDate(r.last_run)}`}</span>}
              </div>
              {r.webhook_url && (
                <div className="mt-1 flex items-center gap-2 rounded-xl bg-card px-2 py-1.5">
                  <code className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{r.webhook_url}</code>
                  <button
                    className="text-[10px] text-primary hover:text-primary"
                    onClick={() => void navigator.clipboard?.writeText(
                      `curl -X POST ${r.webhook_url} -H "Authorization: Bearer ${r.trigger?.type === 'webhook' ? r.trigger.token : ''}" -d '{"test":1}'`
                    )}
                  >
                    <Trans>copia curl</Trans>
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {routines.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground"><Trans>(nessuna routine)</Trans></div>
        )}
      </SettingsGroup>

      {editing ? (
        <TriggerEditor
          agentId={activeId}
          routine={editing}
          connectors={connectors}
          manualServers={manualServers}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh() }}
        />
      ) : (
        <>
          <NewRoutinePicker
            agentId={activeId}
            connectors={connectors}
            manualServers={manualServers}
            onCreate={async (title, prompt, trigger, timezone, model) => {
              setErr('')
              try {
                await api.createRoutineTrigger(activeId!, title, prompt, trigger, timezone || undefined, model)
                await refresh()
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              }
            }}
            err={err}
          />
          <div className="space-y-2 pt-2">
            <button
              className="rounded-full bg-muted px-3 py-1.5 text-xs outline-none transition hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
              disabled={busy || !activeId}
              onClick={async () => {
                setBusy(true); setErr(''); setSuggestions([])
                try { setSuggestions(await api.suggestRoutines(activeId!)) }
                catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
                setBusy(false)
              }}
            >
              {busy ? t`analizzo…` : <Trans>✨ Suggerisci dal transcript</Trans>}
            </button>
            {suggestions.map((s, i) => (
              <div key={i} className="rounded-2xl bg-muted/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{s.title}</span>
                  <code className="rounded-full bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.schedule}</code>
                  <div className="flex-1" />
                  <button
                    className="rounded-full bg-card px-2 py-1 text-xs outline-none transition hover:bg-card/80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    onClick={async () => {
                      await api.createRoutine(activeId!, s.title, s.description, s.schedule)
                      setSuggestions(suggestions.filter((_, j) => j !== i))
                      await refresh()
                    }}
                  >
                    <Trans>Aggiungi</Trans>
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </SettingsPage>
  )
}

/** Bottone "+ routine" che apre l'editor con il tipo di trigger da scegliere. */
function NewRoutinePicker(props: {
  agentId: string | null
  connectors: ConnectorInfo[]
  manualServers: McpServerInfo[]
  onCreate(title: string, prompt: string, trigger: RoutineTrigger, timezone: string, model?: { providerId?: string | null; model?: string | null; thinking?: ThinkingSetting | null }): Promise<void>
  err: string
}) {
  const [kind, setKind] = useState<TriggerKind | null>(null)
  if (!kind) {
    return (
      <div className="space-y-2">
        <button
          className="flex w-full items-center gap-2 rounded-2xl bg-muted/60 px-4 py-2.5 text-left text-sm text-muted-foreground outline-none transition hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setKind('schedule')}
        >
          <Trans>+ Nuova routine</Trans>
        </button>
        {props.err && <p className="text-xs text-destructive">{props.err}</p>}
      </div>
    )
  }
  return (
    <TriggerEditor
      agentId={props.agentId}
      connectors={props.connectors}
      manualServers={props.manualServers}
      initialKind={kind}
      onCancel={() => setKind(null)}
      onSaved={() => setKind(null)}
      onCreate={props.onCreate}
    />
  )
}

/** L'editor dei trigger: campi comuni (titolo/prompt) + campi per tipo. */
function TriggerEditor(props: {
  agentId: string | null
  routine?: RoutineInfo
  initialKind?: TriggerKind
  connectors: ConnectorInfo[]
  manualServers: McpServerInfo[]
  onCancel(): void
  onSaved(): void
  onCreate?(title: string, prompt: string, trigger: RoutineTrigger, timezone: string, model?: { providerId?: string | null; model?: string | null; thinking?: ThinkingSetting | null }): Promise<void>
}) {
  const { t, i18n } = useLingui()
  const providers = useStore((s) => s.providers)
  const r = props.routine
  const [kind, setKind] = useState<TriggerKind>(props.initialKind ?? kindOf(r?.trigger, r?.schedule))
  const [title, setTitle] = useState(r?.title ?? '')
  const [prompt, setPrompt] = useState(r?.prompt ?? '')
  const [timezone, setTimezone] = useState(r?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // fase 18b (H7): il modello PROPRIo della routine (null = quello del bot)
  const [modelProvider, setModelProvider] = useState(r?.providerId ?? '')
  const [modelId, setModelId] = useState(r?.model ?? '')
  const [modelThinking, setModelThinking] = useState<ThinkingSetting>((r?.thinking as ThinkingSetting) ?? 'default')
  const [routineModels, setRoutineModels] = useState<import('../../../shared/types').ModelInfo[]>([])
  useEffect(() => {
    if (modelProvider) api.listModels(modelProvider).then(setRoutineModels).catch(() => setRoutineModels([]))
    else setRoutineModels([])
  }, [modelProvider])
  /** il modello della routine per la RPC (null = quello del bot) */
  const modelPatch = modelProvider
    ? { providerId: modelProvider, model: modelId, thinking: modelThinking !== 'default' ? modelThinking : null }
    : { providerId: null, model: null, thinking: null }

  // schedule
  const [cron, setCron] = useState(
    r?.trigger?.type === 'schedule'
      ? (r.trigger.kind === 'cron' ? r.trigger.cron : '')
      : (r?.schedule && kindOf(r.trigger) === 'schedule' ? r.schedule : r?.trigger ? '' : '0 9 * * *')
  )
  const [every, setEvery] = useState<'day' | 'weekday' | 'week' | 'month' | 'hour'>(
    r?.trigger?.type === 'schedule' && r.trigger.kind === 'every' ? r.trigger.every : 'day'
  )
  const [at, setAt] = useState(r?.trigger?.type === 'schedule' && r.trigger.kind === 'every' ? (r.trigger.at ?? '09:00') : '09:00')
  const [weekday, setWeekday] = useState(1)
  const [monthDay, setMonthDay] = useState(1)
  const [mode, setMode] = useState<'at' | 'around'>('at')
  // poll (email/calendar/generico)
  const [connectorId, setConnectorId] = useState('')
  const [tool, setTool] = useState('')
  const [idField, setIdField] = useState('')
  const [intervalMin, setIntervalMin] = useState(5)
  const [offsetMinutes, setOffsetMinutes] = useState(10)
  const [query, setQuery] = useState('')
  const [argsJson, setArgsJson] = useState('{}')
  const [confirmReadOnly, setConfirmReadOnly] = useState(r?.trigger?.type === 'connector_poll' ? !!r.trigger.userConfirmedReadOnly : false)

  // preset: il tool lo sceglie l'euristica dai tool del connettore connesso
  const presetConnectors = props.connectors.filter((c) => c.state.status === 'connected' && c.tools.length > 0)
  const autoTool = (preset: 'email' | 'calendar_event', cid: string): { tool: string | null; argName: string | null } => {
    const conn = presetConnectors.find((c) => c.id === (cid || (preset === 'email' ? 'gmail' : 'gcalendar')))
    if (!conn) return { tool: null, argName: null }
    const chosen = choosePollTool(
      conn.tools.map((t) => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations,
        inputProperties: undefined
      })),
      preset
    )
    const full = conn.tools.find((t) => t.name === chosen) ?? null
    return { tool: chosen, argName: chooseQueryArgName(full ? { name: full.name, description: full.description, annotations: full.annotations } : null) }
  }

  const buildTrigger = (): RoutineTrigger | null => {
    if (kind === 'schedule') {
      // il toggle "ogni…" svuota il cron: i due modi di dire l'orario
      return cron.trim()
        ? { type: 'schedule', kind: 'cron', cron: cron.trim() }
        : { type: 'schedule', kind: 'every', every, at, mode, ...(every === 'week' ? { weekday } : {}), ...(every === 'month' ? { monthDay } : {}) }
    }
    if (kind === 'webhook') return { type: 'webhook', token: r?.trigger?.type === 'webhook' ? r.trigger.token : '' }
    if (kind === 'presence_return') return { type: 'presence_return' }
    // email / calendar_event / connector_poll
    const cid = connectorId || (kind === 'email' ? 'gmail' : kind === 'calendar_event' ? 'gcalendar' : '')
    // fase 7 (residuo 0a): server manuale (non del catalogo) → serve la
    // conferma esplicita che il tool legge soltanto
    const isManual = props.manualServers.some((s) => s.id === cid)
    let args: Record<string, unknown>
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    } catch {
      return null // args non validi: il salvataggio lo segnala
    }
    if (kind === 'email' && query.trim()) {
      const { argName } = autoTool('email', cid)
      if (argName) args = { ...args, [argName]: query.trim() }
    }
    return {
      type: 'connector_poll',
      connectorId: cid,
      tool: tool.trim(),
      args,
      intervalMin: Math.max(2, Number(intervalMin) || 2),
      idField: idField.trim(),
      ...(kind === 'email' ? { preset: 'email' as const } : {}),
      ...(kind === 'calendar_event' ? { preset: 'calendar_event' as const, offsetMinutes: Math.max(0, Number(offsetMinutes) || 0) } : {}),
      ...(isManual ? { userConfirmedReadOnly: confirmReadOnly } : {})
    }
  }

  const save = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const trigger = buildTrigger()
      if (!trigger) throw new Error(t`Argomenti (args) non sono JSON valido`)
      if (props.onCreate) await props.onCreate(title.trim(), prompt.trim(), trigger, timezone.trim(), modelPatch)
      else await api.updateRoutineTrigger(r!.id, { title: title.trim(), prompt: prompt.trim(), trigger, timezone: timezone.trim(), ...modelPatch })
      props.onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // precompilazione dei preset alla scelta del tipo
  useEffect(() => {
    if (kind === 'email') {
      const { tool: t, argName } = autoTool('email', connectorId)
      if (t) setTool(t)
      setIdField((v) => v || 'messages[].id')
      void argName
    } else if (kind === 'calendar_event') {
      const { tool: t } = autoTool('calendar_event', connectorId)
      if (t) setTool(t)
      setIdField((v) => v || 'events[].id')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, connectorId])

  const inputCls = 'rounded-lg bg-card px-2 py-1.5 text-xs outline-none'
  const presetHint = (preset: 'email' | 'calendar_event'): string => {
    const { tool: chosen } = autoTool(preset, connectorId)
    return chosen
      ? t`tool scelto dal connettore: ${chosen}`
      : t`nessun tool riconosciuto nel connettore: configura tool e idField a mano`
  }

  return (
    <div className="space-y-2 rounded-2xl bg-muted/60 p-3">
      <div className="flex flex-wrap gap-1">
        {(Object.keys(KIND_LABEL) as TriggerKind[]).map((k) => (
          <button
            key={k}
            className={`rounded-full px-2 py-1 text-[11px] outline-none ${kind === k ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => setKind(k)}
          >
            {i18n.t(KIND_LABEL[k])}
          </button>
        ))}
      </div>
      <input className={`w-full ${inputCls} text-sm`} placeholder={t`Titolo (es. Riepilogo email del mattino)`} value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className={`w-full ${inputCls} text-sm`} placeholder={t`Cosa deve fare il Bot a ogni esecuzione`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      {/* fase skill (S7.4): il prompt può COMINCIARE con /nome — la skill si
          carica al momento dell'esecuzione, come nel compositore */}
      <p className="text-[11px] text-muted-foreground"><Trans>Può cominciare con /nome di una skill: il bot la caricherà a ogni esecuzione.</Trans></p>

      {kind === 'schedule' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <button className={`rounded-full px-2 py-1 ${cron !== '' ? 'bg-card text-foreground' : ''}`} onClick={() => { setCron('0 9 * * *') }}>{t`cron`}</button>
            <button className={`rounded-full px-2 py-1 ${cron === '' ? 'bg-card text-foreground' : ''}`} onClick={() => setCron('')}>{t`ogni…`}</button>
            {cron === '' && (
              <>
                <select className={inputCls} value={every} onChange={(e) => setEvery(e.target.value as typeof every)}>
                  <option value="day">{t`giorno`}</option>
                  <option value="weekday">{t`giorni feriali`}</option>
                  <option value="week">{t`settimana`}</option>
                  <option value="month">{t`mese`}</option>
                  <option value="hour">{t`ora`}</option>
                </select>
                {every === 'week' && (
                  <select className={inputCls} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                    {[msg`domenica`, msg`lunedì`, msg`martedì`, msg`mercoledì`, msg`giovedì`, msg`venerdì`, msg`sabato`].map((d, i) => (
                      <option key={i} value={i}>{i18n.t(d)}</option>
                    ))}
                  </select>
                )}
                {every === 'month' && (
                  <input className={`w-16 ${inputCls}`} type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))} />
                )}
                <input className={`w-20 ${inputCls}`} placeholder="HH:MM" value={at} onChange={(e) => setAt(e.target.value)} />
                <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as 'at' | 'around')}>
                  <option value="at">{t`preciso`}</option>
                  <option value="around">{t`circa (±15 min)`}</option>
                </select>
              </>
            )}
            {cron !== '' && <input className={`flex-1 font-mono ${inputCls}`} value={cron} onChange={(e) => setCron(e.target.value)} />}
          </div>
        </div>
      )}

      {(kind === 'email' || kind === 'calendar_event' || kind === 'connector_poll') && (
        <div className="space-y-2">
          {kind === 'connector_poll' && (
            <>
              <select className={`w-full ${inputCls}`} value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
                <option value="">{t`— connettore —`}</option>
                {presetConnectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {props.manualServers.map((s) => <option key={s.id} value={s.id}>{s.name} {t`(server manuale)`}</option>)}
              </select>
              {props.manualServers.some((s) => s.id === connectorId) && (
                // fase 7 (residuo 0a): readOnlyHint di un server manuale è
                // autodichiarato — serve la spunta esplicita dell'utente
                <label className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive/90">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmReadOnly}
                    onChange={(e) => setConfirmReadOnly(e.target.checked)}
                  />
                  <Trans>Confermo che questo tool legge soltanto e non modifica nulla (server aggiunto a mano: la dichiarazione «sola lettura» non è verificata)</Trans>
                </label>
              )}
            </>
          )}
          {(kind === 'email' || kind === 'calendar_event') && <p className="text-[11px] text-muted-foreground">{presetHint(kind)}</p>}
          {kind === 'email' && (
            <input className={`w-full ${inputCls}`} placeholder={t`Quando arriva un'e-mail che corrisponde a… (query)`} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {kind === 'calendar_event' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Trans>avvisa</Trans>
              <input className={`w-16 ${inputCls}`} type="number" min={0} value={offsetMinutes} onChange={(e) => setOffsetMinutes(Number(e.target.value))} />
              <Trans>minuti prima dell'evento</Trans>
            </label>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input className={`font-mono ${inputCls}`} placeholder={t`tool (mcp__…__…)`} value={tool} onChange={(e) => setTool(e.target.value)} />
            <input className={`font-mono ${inputCls}`} placeholder={t`idField (es. "messages[].id")`} value={idField} onChange={(e) => setIdField(e.target.value)} />
            <input className={inputCls} type="number" min={2} title={t`minuti tra i poll (minimo 2)`} value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))} />
            {kind === 'connector_poll' && (
              <input className={`font-mono ${inputCls}`} placeholder={t`args JSON, es. {"query":"x"}`} value={argsJson} onChange={(e) => setArgsJson(e.target.value)} />
            )}
          </div>
        </div>
      )}

      {kind === 'webhook' && (
        <p className="text-[11px] text-muted-foreground">
          <Trans>All'uscita trovi l'URL con il token da copiare: qualunque sistema può far scattare la routine con un POST.</Trans>
        </p>
      )}
      {kind === 'presence_return' && (
        <p className="text-[11px] text-muted-foreground"><Trans>La routine gira quando torni al computer dopo un'assenza lunga.</Trans></p>
      )}

      {/* fase 18b (H7): il modello della routine — «Quello del bot» (default)
          oppure provider + ModelPicker + ragionamento, come per i bot (H3) */}
      <div className="space-y-2 rounded-xl bg-card/60 px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t`modello`}</span>
          <select
            className={inputCls}
            value={modelProvider}
            onChange={(e) => { setModelProvider(e.target.value); setModelId(''); setModelThinking('default') }}
          >
            <option value="">{t`Quello del bot`}</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {modelProvider && (
            <ModelPicker
              className="min-w-44 flex-1"
              models={routineModels}
              value={modelId || null}
              placeholder={t`— modello —`}
              onChange={(m) => setModelId(m ?? '')}
            />
          )}
        </div>
        {(() => {
          // il ragionamento del modello della routine (come in H3)
          const chosen = routineModels.find((m) => m.id === modelId)
          const levels = chosen?.thinkingLevels ?? []
          if (levels.length === 0) return null
          const savedLevel = levels.includes(modelThinking) ? modelThinking : 'default'
          return (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t`ragionamento`}</span>
              <select
                className={inputCls}
                value={savedLevel}
                onChange={(e) => setModelThinking(e.target.value as ThinkingSetting)}
              >
                {(['default', ...levels] as ThinkingSetting[]).map((l) => (
                  <option key={l} value={l}>{i18n.t(THINKING_LABELS[l]!)}</option>
                ))}
              </select>
            </div>
          )
        })()}
        <p className="text-[11px] text-muted-foreground">
          <Trans>Vale solo per i turni di questa routine; il resto del bot non cambia.</Trans>
        </p>
      </div>

      <input className={`w-full ${inputCls}`} placeholder={t`Fuso orario (es. Europe/Rome)`} value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={props.onCancel}><Trans>Annulla</Trans></button>
        <button
          className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={busy || !title.trim() || !prompt.trim() || !props.agentId || (!!modelProvider && !modelId.trim())}
          onClick={() => void save()}
        >
          {r ? <Trans>Salva</Trans> : <Trans>Crea routine</Trans>}
        </button>
      </div>
    </div>
  )
}
