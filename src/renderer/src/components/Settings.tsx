// Impostazioni: provider (modelli personalizzati), modello per agente, permessi, routine, connettori, generale.
import { useEffect, useState, type ReactNode } from 'react'
import { api, useStore } from '../store'
import { describeTrigger } from '../../../shared/cron-human'
import { choosePollTool, chooseQueryArgName } from '../../../shared/triggers'
import type { ProviderConfig, ProviderKind, ModelInfo, Agent, RoutineInfo, RoutineSuggestion, ConnectorInfo, McpServerInfo, McpServerSecret, RoutineTrigger, TemplateInfo, AutoReviewSettings } from '../../../shared/types'
import { DEFAULT_AUTO_REVIEW } from '../../../shared/types'
// fase 10 (residuo 0d): i default per kind (modulo puro, nessuna dipendenza node)
import { modelDefaultsFor } from '../../../main/agent/model-defaults'

const KINDS: ProviderKind[] = [
  'ollama', 'lmstudio', 'anthropic', 'mistral', 'openrouter', 'zai', 'xai', 'deepseek', 'groq', 'openai-compatible'
]

export function Settings() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const pendingTab = useStore((s) => s.settingsTab)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const refreshPermissions = useStore((s) => s.refreshPermissions)
  const [tab, setTab] = useState<'provider' | 'agenti' | 'permessi' | 'routine' | 'connettori' | 'autoreview' | 'generale'>('provider')

  // fase 7: un widget può chiedere di aprire un tab preciso (es. il provider
  // durante l'onboarding): lo si applica una volta e si consuma
  useEffect(() => {
    if (pendingTab) {
      setTab(pendingTab as typeof tab)
      setSettingsTab(null)
    }
  }, [pendingTab, setSettingsTab])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSettingsOpen(false)}>
      <div
        className="flex h-[560px] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 border-b border-neutral-800 px-4 pt-4 pb-2">
          {(['provider', 'agenti', 'permessi', 'routine', 'connettori', 'autoreview', 'generale'] as const).map((t) => (
            <button
              key={t}
              className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
              onClick={() => setTab(t)}
            >
              {t === 'connettori' ? 'connetti app' : t === 'autoreview' ? 'approvazione automatica' : t}
            </button>
          ))}
          <div className="flex-1" />
          <button className="rounded-md px-2 py-1 text-neutral-500 hover:text-neutral-200" onClick={() => setSettingsOpen(false)}>
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin p-4">
          {tab === 'provider' && <ProvidersTab onChanged={refreshProviders} />}
          {tab === 'agenti' && <AgentsTab />}
          {tab === 'permessi' && <PermissionsTab onChanged={refreshPermissions} />}
          {tab === 'routine' && <RoutinesTab />}
          {tab === 'connettori' && <ConnectorsTab />}
          {tab === 'autoreview' && <AutoReviewTab />}
          {tab === 'generale' && <GeneralTab />}
        </div>
      </div>
    </div>
  )
}

// ---- fase 8 (§3bis L5): auto-review delle approvazioni ----

function AutoReviewTab() {
  const providers = useStore((s) => s.providers)
  const prefill = useStore((s) => s.autoreviewPrefill)
  const [cfg, setCfg] = useState<AutoReviewSettings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [newAllow, setNewAllow] = useState('')
  const [newBlock, setNewBlock] = useState('')

  useEffect(() => {
    void api.settingsGet<AutoReviewSettings>('autoReview', DEFAULT_AUTO_REVIEW).then(setCfg)
  }, [])
  // fase 8: "Crea regola da questa azione" arriva con un testo precompilato
  useEffect(() => {
    if (prefill) {
      setNewAllow(prefill)
      useStore.setState({ autoreviewPrefill: null })
    }
  }, [prefill])
  // i modelli del provider scelto (per il revisore)
  useEffect(() => {
    if (cfg?.providerId) void api.listModels(cfg.providerId).then(setModels).catch(() => setModels([]))
    else setModels([])
  }, [cfg?.providerId])

  if (!cfg) return <p className="text-xs text-neutral-500">caricamento…</p>
  const save = (next: AutoReviewSettings): void => {
    setCfg(next)
    void api.settingsSet('autoReview', next)
  }
  const inputCls = 'flex-1 rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none'

  const RuleList = ({ title, hint, rules, onAdd, onRemove, value, setValue }: {
    title: string
    hint: string
    rules: string[]
    onAdd(): void
    onRemove(i: number): void
    value: string
    setValue(v: string): void
  }) => (
    <div className="rounded-xl border border-neutral-800 px-3 py-2.5">
      <div className="text-sm text-neutral-100">{title}</div>
      <div className="mt-0.5 text-[11px] text-neutral-500">{hint}</div>
      <ul className="mt-2 space-y-1">
        {rules.length === 0 && <li className="text-xs text-neutral-600">(nessuna regola)</li>}
        {rules.map((r, i) => (
          <li key={`${r}-${i}`} className="flex items-start gap-2 text-xs text-neutral-200">
            <span className="flex-1">{r}</span>
            <button className="shrink-0 text-neutral-500 hover:text-red-400" onClick={() => onRemove(i)}>✕</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          className={inputCls}
          placeholder="es. comandi ls e cat dentro la home del bot"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(); setValue('') } }}
        />
        <button
          className="rounded-lg bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
          disabled={!value.trim()}
          onClick={() => { onAdd(); setValue('') }}
        >
          Aggiungi
        </button>
      </div>
    </div>
  )

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Un modello piccolo rivede le azioni che chiedono approvazione secondo queste regole e può lasciarle passare da solo.
        Sta dopo il gate dei permessi e non cambia mai i divieti: le azioni che modificano il comportamento futuro del bot, i comandi che eseguono altri comandi e i turni aperti da altri bot o da eventi esterni chiedono comunque.
      </p>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-800 px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-neutral-300"
          checked={cfg.enabled}
          onChange={(e) => save({ ...cfg, enabled: e.target.checked })}
        />
        <span>
          <span className="block text-sm text-neutral-100">Approvazione automatica</span>
          <span className="block text-xs text-neutral-500">Al massimo 20 azioni approvate per turno; un dubbio del revisore diventa sempre una card.</span>
        </span>
      </label>
      <div className="flex gap-2">
        <select
          className="rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none"
          value={cfg.providerId ?? ''}
          onChange={(e) => save({ ...cfg, providerId: e.target.value || null, model: null })}
        >
          <option value="">provider del revisore…</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          className="rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none"
          value={cfg.model ?? ''}
          disabled={!cfg.providerId}
          onChange={(e) => save({ ...cfg, model: e.target.value || null })}
        >
          <option value="">modello… (vuoto = default del provider)</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
        </select>
      </div>
      <RuleList
        title="⚡ Continua da solo quando l'azione rispetta queste regole"
        hint="Se una regola corrisponde (e nessuna regola di fermata), il revisore può approvare l'azione o l'invio della bozza."
        rules={cfg.allowRules}
        value={newAllow}
        setValue={setNewAllow}
        onAdd={() => save({ ...cfg, allowRules: [...cfg.allowRules, newAllow.trim()] })}
        onRemove={(i) => save({ ...cfg, allowRules: cfg.allowRules.filter((_, j) => j !== i) })}
      />
      <RuleList
        title="⛔ Fermati e chiedimi sempre quando…"
        hint="Una di queste regole vince sempre sulle altre: l'azione diventa una card."
        rules={cfg.blockRules}
        value={newBlock}
        setValue={setNewBlock}
        onAdd={() => save({ ...cfg, blockRules: [...cfg.blockRules, newBlock.trim()] })}
        onRemove={(i) => save({ ...cfg, blockRules: cfg.blockRules.filter((_, j) => j !== i) })}
      />
    </div>
  )
}

// ---- fase 5: "Connetti app" — catalogo con stato + server MCP manuali ----

const STATUS_DOT: Record<string, string> = {
  not_connected: 'bg-neutral-600',
  connected: 'bg-emerald-500',
  needs_auth: 'bg-amber-500',
  error: 'bg-red-500'
}
const STATUS_LABEL: Record<string, string> = {
  not_connected: 'non connesso',
  connected: 'connesso',
  needs_auth: 'da autorizzare',
  error: 'errore'
}

/**
 * Fase 13: Connettori con QUATTRO schede — App (catalogo, come prima),
 * Installati (server del registro/plugin/gateway con enabledFor per bot),
 * Marketplace (elenco, aggiungi/rimuovi) e Gateway (modulo del punto 7).
 */
function ConnectorsTab() {
  const connectors = useStore((s) => s.connectors)
  const refreshConnectors = useStore((s) => s.refreshConnectors)
  const [sub, setSub] = useState<'app' | 'installati' | 'marketplace' | 'gateway'>('app')
  useEffect(() => { void refreshConnectors() }, [refreshConnectors])
  const subBtn = (id: typeof sub, label: string): ReactNode => (
    <button
      key={id}
      className={`rounded-lg px-2.5 py-1 text-xs ${sub === id ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
      onClick={() => setSub(id)}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">{subBtn('app', 'App')}{subBtn('installati', 'Installati')}{subBtn('marketplace', 'Marketplace')}{subBtn('gateway', 'Gateway')}</div>
      {sub === 'app' && (
        <>
          <p className="text-xs text-neutral-500">
            Le app si collegano come server MCP con OAuth: i loro tool diventano <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
            I token stanno cifrati nel Keychain. Il bot può proporre un'app in chat, ma la connessione parte solo dal tuo click.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {connectors.map((c) => (
              <ConnectorTile key={c.id} c={c} />
            ))}
          </div>
          <ManualServers />
          <ClientMetadataUrlRow />
        </>
      )}
      {sub === 'installati' && <InstalledTab />}
      {sub === 'marketplace' && <MarketplaceTab />}
      {sub === 'gateway' && <GatewayTab />}
    </div>
  )
}

/**
 * Fase 13 (punto 6.2): URL del Client ID Metadata Document (CIMD) ospitato
 * dall'utente — vuoto = Dynamic Client Registration. Una riga che spiega.
 */
function ClientMetadataUrlRow() {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    void api.settingsGet<string>('connectors.oauth.clientMetadataUrl', '').then(setUrl).catch(() => setUrl(''))
  }, [])
  if (url === null) return null
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">OAuth</span>
      <span className="text-[11px] text-neutral-500">Se ospiti un documento dei metadati del client (CIMD, es. su GitHub Pages, https e con percorso), incollalo qui; vuoto = registrazione dinamica (DCR).</span>
      <input
        className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none"
        placeholder="https://utente.github.io/sandbot/client.json"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onBlur={() => void api.connectorsSetClientMetadataUrl(url.trim())}
      />
    </div>
  )
}

/** Scheda Installati: server del registro/plugin/gateway con fonte, fiducia, stato, enabledFor, disinstalla. */
function InstalledTab() {
  const [data, setData] = useState<{ servers: McpServerInfo[]; plugins: Array<{ name: string; marketplace: string; sha12: string; skills: Array<{ name: string }>; servers: string[]; enabledFor: string[]; updateAvailable?: boolean }> } | null>(null)
  const agents = useStore((s) => s.agents)
  const [values, setValues] = useState<Record<string, string>>({})
  const refresh = async (): Promise<void> => { setData(await api.connectorsInstalled() as { servers: McpServerInfo[]; plugins: Array<{ name: string; marketplace: string; sha12: string; skills: Array<{ name: string }>; servers: string[]; enabledFor: string[]; updateAvailable?: boolean }> }) }
  useEffect(() => { void refresh() }, [])
  if (data === null) return <p className="text-xs text-neutral-600">installati…</p>

  const enabledForEditor = (kind: 'server' | 'plugin', id: string, current: string[] | undefined): ReactNode => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-neutral-500">per bot:</span>
      {agents.map((a) => {
        const on = current?.includes('*') || current?.includes(a.id)
        return (
          <label key={a.id} className="flex items-center gap-1 text-[11px] text-neutral-400">
            <input
              type="checkbox"
              className="h-3 w-3 accent-neutral-300"
              checked={on}
              onChange={() => {
                const next = current?.includes('*') ? [] : [...(current ?? [])]
                const i = next.indexOf(a.id)
                if (i >= 0) next.splice(i, 1)
                else next.push(a.id)
                void api.connectorsSetEnabledFor(kind, id, next).then(refresh)
              }}
            />
            {a.name}
          </label>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Server del registro pubblico e plugin installati. Chiavi, header e variabili stanno cifrati: si compilano qui, MAI in chat.
      </p>
      {data.servers.length === 0 && data.plugins.length === 0 && <p className="text-xs text-neutral-600">nessun server o plugin installato</p>}
      {data.servers.map((sv) => {
        const src = sv.source as { kind?: string; name?: string; plugin?: string; preset?: string } | undefined
        const needs = sv.needsAuth as { kind?: string; keys?: string[] } | undefined
        return (
          <div key={sv.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${needs ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              <span className="text-sm text-neutral-100">{sv.name}</span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{src?.kind ?? 'manuale'}</span>
              {sv.trustLabel && <span className="text-[10px] text-neutral-500">{sv.trustLabel}</span>}
              <span className="flex-1 truncate text-xs text-neutral-600">{sv.transport === 'http' ? sv.url : `${sv.box?.command ?? ''} ${(sv.box?.args ?? []).join(' ')}`}</span>
              <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.connectorsUninstallServer(sv.id); await refresh() }}>disinstalla</button>
            </div>
            {enabledForEditor('server', sv.id, sv.enabledFor)}
            {needs?.keys?.length ? (
              <div className="mt-2 space-y-1 border-t border-neutral-800 pt-2">
                <p className="text-[11px] text-amber-500/80">serve: {needs.keys.join(', ')} {needs.kind === 'key' ? '(header)' : needs.kind === 'env' ? '(variabile d&rsquo;ambiente)' : '(impostazione del plugin)'}</p>
                {needs.keys.map((k) => (
                  <div key={k} className="flex gap-1">
                    <input
                      className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2 py-1 text-xs outline-none"
                      type="password"
                      placeholder={k}
                      value={values[`${sv.id}:${k}`] ?? ''}
                      onChange={(e) => setValues((p) => ({ ...p, [`${sv.id}:${k}`]: e.target.value }))}
                    />
                  </div>
                ))}
                <button
                  className="rounded-lg bg-neutral-700 px-2 py-1 text-xs text-white hover:bg-neutral-600"
                  onClick={async () => {
                    const vals: Record<string, string> = {}
                    for (const k of needs.keys ?? []) if (values[`${sv.id}:${k}`]?.trim()) vals[k] = values[`${sv.id}:${k}`]!.trim()
                    await api.connectorsSaveServerValues(sv.id, needs.kind === 'key' ? 'headers' : needs.kind === 'env' ? 'env' : 'userConfig', vals)
                    setValues({})
                    await refresh()
                  }}
                >
                  salva cifrato
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
      {data.plugins.map((p) => (
        <div key={`${p.marketplace}/${p.name}`} className="rounded-xl border border-neutral-800 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-100">{p.name}</span>
            <span className="text-xs text-neutral-500">{p.marketplace} · {p.sha12}</span>
            <span className="flex-1" />
            <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.pluginsUninstall(p.name, p.marketplace); await refresh() }}>disinstalla</button>
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-600">{p.skills.length} skill · {p.servers.length} server{p.updateAvailable ? ' · nuova versione disponibile (aggiorna = nuova card in chat)' : ''}</p>
          {enabledForEditor('plugin', p.name, p.enabledFor)}
        </div>
      ))}
    </div>
  )
}

/** Scheda Marketplace: elenco dei marketplace registrati, aggiungi (owner/repo o URL git) o rimuovi. Il BOT non può. */
function MarketplaceTab() {
  const [list, setList] = useState<Array<{ name: string; source: string; kind: string; official: boolean }> | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const refresh = async (): Promise<void> => setList(await api.marketplaceList())
  useEffect(() => { void refresh() }, [])
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Plugin nel formato di Claude Code. Predefinito: <code>anthropics/claude-plugins-official</code> (puoi rimuoverlo).
        Di un plugin SandBot importa SOLO skill e server MCP; hook, bin/ e comandi non girano mai.
      </p>
      {(list ?? []).map((m) => (
        <div key={m.source} className="flex items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2">
          <span className="text-sm text-neutral-100">{m.name}</span>
          {m.official && <span className="rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] text-sky-300">marketplace ufficiale</span>}
          <span className="flex-1 truncate text-xs text-neutral-600">{m.source}</span>
          <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.marketplaceRemove(m.source); await refresh() }}>rimuovi</button>
        </div>
      ))}
      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs outline-none"
          placeholder="owner/repo di GitHub oppure URL git https"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          className="rounded-lg bg-neutral-700 px-2.5 py-1.5 text-xs text-white hover:bg-neutral-600 disabled:opacity-40"
          disabled={!input.trim()}
          onClick={async () => {
            setError('')
            try {
              await api.marketplaceAdd(input.trim())
              setInput('')
              await refresh()
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          aggiungi
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

/** Scheda Gateway (punto 7): un server MCP remoto di aggregazione, preset come dati, chiavi cifrate. */
function GatewayTab() {
  const [presets, setPresets] = useState<Array<{ id: string; name: string; auth: string; headerName?: string; help: string }> | null>(null)
  const [warning, setWarning] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    void api.connectorsGatewayPresets().then((r) => { setPresets(r.presets); setWarning(r.warning) }).catch(() => setPresets([]))
  }, [])
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">{warning || "Un gateway custodisce l'accesso a tutte le app che colleghi lì: è un servizio di terzi"}</p>
      <div className="flex flex-wrap gap-1">
        {(presets ?? []).map((p) => (
          <button
            key={p.id}
            className="rounded-lg border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-sky-700 hover:text-sky-300"
            onClick={() => { setName(p.name); setUrl(''); setToken('') }}
            title={p.help}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="space-y-2 rounded-xl border border-neutral-800 p-3">
        <div className="grid grid-cols-2 gap-2">
          <input className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Nome (es. Composio)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="URL https del server MCP" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" type="password" placeholder="chiave / token Bearer (salvata cifrata)" value={token} onChange={(e) => setToken(e.target.value)} />
        {(presets ?? []).find((p) => p.name === name)?.help && (
          <p className="text-[11px] text-neutral-500">{presets!.find((p) => p.name === name)!.help}</p>
        )}
        <button
          className="rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          disabled={!name.trim() || !url.trim().startsWith('https://') || !token.trim()}
          onClick={async () => {
            setError('')
            const preset = (presets ?? []).find((p) => p.name === name)
            try {
              // il preset dice SOLO nome header e testo d'aiuto (dati, nessuna chiamata API)
              await api.connectorsAddGateway({
                name: name.trim(), url: url.trim(),
                auth: preset?.auth === 'bearer' ? 'bearer' : 'headers',
                ...(preset ? { preset: preset.id } : {}),
                ...(preset?.headerName ? { headerName: preset.headerName, headers: { [preset.headerName]: token.trim() } } : { headers: { Authorization: `Bearer ${token.trim()}` } })
              })
              setName(''); setUrl(''); setToken('')
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          aggiungi gateway
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    </div>
  )
}

function ConnectorTile({ c }: { c: ConnectorInfo }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [instructions, setInstructions] = useState(c.state.instructions)

  const toggleTool = async (tool: string, disabled: boolean): Promise<void> => {
    const next = disabled
      ? c.state.disabledTools.filter((t) => t !== tool)
      : [...c.state.disabledTools, tool]
    await api.connectorsSetTools(c.id, next)
  }

  return (
    <div className="rounded-xl border border-neutral-800 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-base">{c.logo}</span>
        <span className="text-sm text-neutral-100">{c.name}</span>
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.state.status]}`} title={c.state.error ?? STATUS_LABEL[c.state.status]} />
        <span className="text-[10px] uppercase text-neutral-500">{STATUS_LABEL[c.state.status]}</span>
        <div className="flex-1" />
        {c.state.status === 'connected' ? (
          <>
            <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={() => setOpen(!open)}>
              {open ? 'chiudi' : 'tool'}
            </button>
            <button
              className="text-xs text-neutral-500 hover:text-red-400"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try { await api.connectorsDisconnect(c.id) } finally { setBusy(false) }
              }}
            >
              disconnetti
            </button>
          </>
        ) : (
          <button
            className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await api.connectorsConnect(c.id) } finally { setBusy(false) }
            }}
          >
            {busy ? 'autorizza nel browser…' : c.state.status === 'needs_auth' ? 'riconnetti' : 'connetti'}
          </button>
        )}
      </div>
      {c.state.error && <p className="mt-1 text-[11px] text-amber-500/80">{c.state.error}</p>}
      {c.state.status !== 'connected' && c.notes && (
        <p className="mt-1 line-clamp-2 text-[11px] text-neutral-600">{c.notes}</p>
      )}

      {/* client OAuth statico (Google): credenziali cifrate, guida in docs/google-oauth.md */}
      {c.clientRegistration === 'static' && c.state.status !== 'connected' && (
        <div className="mt-2 space-y-1 border-t border-neutral-800 pt-2">
          {c.hasStaticCredentials ? (
            <p className="text-[11px] text-neutral-500">Client OAuth configurato ✓</p>
          ) : (
            <>
              <p className="text-[11px] text-neutral-500">
                Serve un client OAuth tuo (tipo "Desktop app"):{' '}
                <a className="text-sky-400 hover:underline" href={c.docsUrl} target="_blank" rel="noreferrer">guida</a>{' '}
                · docs/google-oauth.md
              </p>
              <div className="flex gap-1">
                <input
                  className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2 py-1 text-xs outline-none"
                  placeholder="client_id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
                <input
                  className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2 py-1 text-xs outline-none"
                  type="password"
                  placeholder="client_secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                <button
                  className="rounded-lg bg-neutral-700 px-2 py-1 text-xs text-white hover:bg-neutral-600 disabled:opacity-40"
                  disabled={!clientId.trim() || !clientSecret.trim()}
                  onClick={() => void api.connectorsSaveStaticClient(c.id, clientId.trim(), clientSecret.trim())}
                >
                  salva
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-2 border-t border-neutral-800 pt-2">
          {/* tool del connettore: interruttore per ognuno (i disattivati non sono offerti al modello) */}
          {c.tools.length === 0 && <p className="text-[11px] text-neutral-600">nessun tool elencato</p>}
          {c.tools.map((t) => {
            const disabled = c.state.disabledTools.includes(t.name)
            return (
              <label key={t.name} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 accent-neutral-300"
                  checked={!disabled}
                  onChange={() => void toggleTool(t.name, disabled)}
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px] text-neutral-300">{t.name}</span>
                  <span className="block text-[10px] text-neutral-600">{t.description}</span>
                </span>
              </label>
            )
          })}
          {/* istruzioni personalizzate: iniettate nel system prompt quando il connettore è attivo */}
          <div>
            <p className="mb-1 text-[11px] text-neutral-500">Istruzioni personalizzate (vanno nel prompt del bot quando il connettore è attivo)</p>
            <textarea
              className="w-full resize-none rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none"
              rows={3}
              placeholder="es. Usa questo account solo per lavoro; le email in italiano vanno riassunte in bulleted list…"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              onBlur={() => void api.connectorsSetInstructions(c.id, instructions)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** Server MCP aggiunti a mano: restano nella stessa vista "Connetti app". */
function ManualServers() {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [secrets, setSecrets] = useState<string[]>([])
  const [edit, setEdit] = useState<McpServerInfo | null>(null)
  // fase 5: bearer token del server manuale (salvato CIFRATO, mai nei settings)
  const [editBearer, setEditBearer] = useState('')
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string; tools?: string[] }>>({})
  const [secName, setSecName] = useState('')
  const [secValue, setSecValue] = useState('')

  const refresh = async () => {
    setServers(await api.mcpList())
    setSecrets(await api.vaultList())
  }
  useEffect(() => { void refresh() }, [])

  return (
    <div className="space-y-3 border-t border-neutral-800 pt-3">
      <p className="text-xs text-neutral-500">Server MCP manuali (stdio o HTTP, con header/bearer salvati cifrati).</p>
      {servers.map((s) => (
        <div key={s.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
            <span className="text-sm text-neutral-100">{s.name}</span>
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{s.transport}</span>
            {s.auth && <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-sky-400">{s.auth.kind}</span>}
            <span className="flex-1 truncate text-xs text-neutral-600">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</span>
            <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={async () => {
              setTests((p) => ({ ...p, [s.id]: { ok: true, tools: ['test…'] } }))
              const r = await api.mcpTest(s.id)
              setTests((p) => ({ ...p, [s.id]: r }))
            }}>test</button>
            <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={() => { setEdit(s); setEditBearer('') }}>modifica</button>
            <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.mcpDelete(s.id); await refresh() }}>elimina</button>
          </div>
          {tests[s.id] && (
            <div className={`mt-2 text-xs ${tests[s.id].ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {tests[s.id].ok ? `✓ ${tests[s.id].tools?.length ?? 0} tool: ${tests[s.id].tools?.join(', ').slice(0, 200)}` : `✕ ${tests[s.id].error}`}
            </div>
          )}
        </div>
      ))}
      {edit ? (
        <div className="space-y-2 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
          <div className="grid grid-cols-2 gap-2">
            <input className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Nome (es. weather)" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <select className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as 'stdio' | 'http' })}>
              <option value="stdio">stdio (comando locale)</option>
              <option value="http">http (URL)</option>
            </select>
          </div>
          {edit.transport === 'stdio' ? (
            <div className="grid grid-cols-2 gap-2">
              <input className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Comando (es. node)" value={edit.command ?? ''} onChange={(e) => setEdit({ ...edit, command: e.target.value })} />
              <input className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Argomenti separati da spazio" value={(edit.args ?? []).join(' ')} onChange={(e) => setEdit({ ...edit, args: e.target.value ? e.target.value.split(/\s+/) : [] })} />
            </div>
          ) : (
            <>
              <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="URL (es. http://localhost:3001/mcp)" value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              <input
                className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
                type="password"
                placeholder="Bearer token (opzionale — salvato cifrato)"
                value={editBearer}
                onChange={(e) => setEditBearer(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200" onClick={() => setEdit(null)}>Annulla</button>
            <button
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
              onClick={async () => {
                const secret: McpServerSecret | undefined = edit.transport === 'http' && editBearer.trim() ? { bearerToken: editBearer.trim() } : undefined
                await api.mcpSave({ ...edit, id: edit.id || 'mcp_' + Date.now() }, secret)
                setEdit(null); setEditBearer('')
                await refresh()
              }}
            >
              Salva
            </button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-xl border border-dashed border-neutral-700 px-3 py-2.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-300" onClick={() => { setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true }); setEditBearer('') }}>
          + Aggiungi server MCP
        </button>
      )}

      <div className="space-y-2 border-t border-neutral-800 pt-3">
        <p className="text-xs text-neutral-500">Vault credenziali (AES-256-GCM, chiave master in safeStorage): il bot vede i nomi col tool <code>list-credentials</code> e li usa scrivendo <code>{'{{secret:NOME}}'}</code> nei comandi — i valori non compaiono mai nel transcript.</p>
        {secrets.map((n) => (
          <div key={n} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-2 py-2">
            <span className="text-sm text-neutral-200">🔐 {n}</span>
            <div className="flex-1" />
            <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.vaultDelete(n); await refresh() }}>elimina</button>
          </div>
        ))}
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="Nome (es. api_key_github)" value={secName} onChange={(e) => setSecName(e.target.value)} />
          <input className="min-w-0 flex-1 rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" type="password" placeholder="Valore" value={secValue} onChange={(e) => setSecValue(e.target.value)} />
          <button className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40" disabled={!secName.trim() || !secValue} onClick={async () => { await api.vaultStore(secName.trim(), secValue); setSecName(''); setSecValue(''); await refresh() }}>Salva</button>
        </div>
      </div>
    </div>
  )
}

// Il runtime dei bot vive in un daemon separato: può partire all'accesso del
// Mac e sopravvivere alla finestra chiusa (LaunchAgent con riavvio sui crash).
// Fase 6: fuso orario, finestre di consegna, rientro/pausa per assenza e
// notifiche per agente.
function GeneralTab() {
  const agents = useStore((s) => s.agents)
  const [atLogin, setAtLogin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tz, setTz] = useState('')
  const [winMode, setWinMode] = useState<'morning' | 'working'>('morning')
  const [morning, setMorning] = useState({ start: '08:30', end: '09:30' })
  const [working, setWorking] = useState({ start: '09:00', end: '19:00' })
  const [minAwayHours, setMinAwayHours] = useState(12)
  const [awayPauseDays, setAwayPauseDays] = useState(7)
  const [disabledNotifications, setDisabledNotifications] = useState<string[]>([])

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

  const inputCls = 'rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none'
  const saveWindow = async (): Promise<void> => {
    await api.settingsSet('deliveryWindow', { mode: winMode, morning, working })
  }
  const toggleAgentNotification = async (agentId: string, off: boolean): Promise<void> => {
    const next = off ? disabledNotifications.filter((a) => a !== agentId) : [...disabledNotifications, agentId]
    setDisabledNotifications(next)
    await api.settingsSet('notifications.disabledAgents', next)
  }

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-800 px-4 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-neutral-300"
          checked={atLogin}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="space-y-1">
          <span className="block text-sm text-neutral-100">Avvia all'accesso</span>
          <span className="block text-xs text-neutral-500">
            Il daemon dei Bot parte quando accedi al Mac e resta attivo con la finestra chiusa
            (LaunchAgent con riavvio automatico dopo un crash). Puoi disattivarlo qui.
          </span>
        </span>
      </label>

      <div className="space-y-2 rounded-xl border border-neutral-800 px-4 py-3">
        <p className="text-sm text-neutral-100">Consegna e presenza</p>
        <label className="flex items-center justify-between text-xs text-neutral-400">
          Fuso orario
          <input
            className={`w-44 ${inputCls}`}
            placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            onBlur={() => void api.settingsSet('userTimeZone', tz.trim())}
          />
        </label>
        <div className="flex items-center justify-between gap-2 text-xs text-neutral-400">
          <span>Finestra di consegna</span>
          <div className="flex items-center gap-2">
            <select
              className={inputCls}
              value={winMode}
              onChange={(e) => { setWinMode(e.target.value as 'morning' | 'working'); void saveWindow() }}
            >
              <option value="morning">mattina</option>
              <option value="working">orario lavorativo</option>
            </select>
            {winMode === 'morning' ? (
              <>
                <input className={`w-16 ${inputCls}`} value={morning.start} onChange={(e) => setMorning({ ...morning, start: e.target.value })} onBlur={() => void saveWindow()} />
                <span>–</span>
                <input className={`w-16 ${inputCls}`} value={morning.end} onChange={(e) => setMorning({ ...morning, end: e.target.value })} onBlur={() => void saveWindow()} />
              </>
            ) : (
              <>
                <span>lun–ven</span>
                <input className={`w-16 ${inputCls}`} value={working.start} onChange={(e) => setWorking({ ...working, start: e.target.value })} onBlur={() => void saveWindow()} />
                <span>–</span>
                <input className={`w-16 ${inputCls}`} value={working.end} onChange={(e) => setWorking({ ...working, end: e.target.value })} onBlur={() => void saveWindow()} />
              </>
            )}
          </div>
        </div>
        <p className="text-[10px] text-neutral-600">I messaggi non urgenti delle routine aspettano questa finestra (o l'apertura della chat del bot).</p>
        <label className="flex items-center justify-between text-xs text-neutral-400">
          Look-around al rientro dopo (ore di assenza)
          <input className={`w-16 ${inputCls}`} type="number" min={1} value={minAwayHours}
            onChange={(e) => setMinAwayHours(Number(e.target.value))}
            onBlur={() => void api.settingsSet('minAwayHours', Math.max(1, Number(minAwayHours) || 12))} />
        </label>
        <label className="flex items-center justify-between text-xs text-neutral-400">
          Pausa delle routine dopo (giorni di assenza)
          <input className={`w-16 ${inputCls}`} type="number" min={1} value={awayPauseDays}
            onChange={(e) => setAwayPauseDays(Number(e.target.value))}
            onBlur={() => void api.settingsSet('awayPauseDays', Math.max(1, Number(awayPauseDays) || 7))} />
        </label>
      </div>

      <div className="space-y-2 rounded-xl border border-neutral-800 px-4 py-3">
        <p className="text-sm text-neutral-100">Notifiche per agente</p>
        {agents.map((a) => {
          const off = disabledNotifications.includes(a.id)
          return (
            <label key={a.id} className="flex items-center justify-between text-xs text-neutral-400">
              <span className="text-neutral-300">{a.name}</span>
              <button
                className={`rounded-lg px-2 py-1 text-[11px] ${off ? 'bg-neutral-800 text-neutral-500' : 'bg-emerald-800/50 text-emerald-300'}`}
                onClick={() => void toggleAgentNotification(a.id, off)}
              >
                {off ? 'disattivate' : 'attivate'}
              </button>
            </label>
          )
        })}
      </div>
    </div>
  )
}

// ---- fase 9 (punto 1): modelli del provider (predefinito, riserva, auto-review) ----

interface ModelOverrides { defaultModel?: string; fallbackModel?: string; autoReviewModel?: string }

/**
 * I tre modelli configurabili per provider: il predefinito va ai bot nuovi
 * (onboarding e template), la riserva rileva i turni quando il principale non
 * risponde, il revisore giudica le approvazioni automatiche. Salvati nel
 * setting 'providers.modelDefaults' (chiave = id del provider).
 * Fase 10 (residuo 0d): senza override il selettore mostra il default
 * EFFETTIVO del provider (es. "predefinito: kimi-k3:cloud").
 */
function ModelDefaultsRow({ p }: { p: ProviderConfig }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [saved, setSaved] = useState<ModelOverrides>({})

  useEffect(() => {
    void api.settingsGet<Record<string, ModelOverrides> | undefined>('providers.modelDefaults', undefined)
      .then((all) => setSaved(all?.[p.id] ?? {}))
      .catch(() => setSaved({}))
    void api.listModels(p.id).then(setModels).catch(() => setModels([]))
  }, [p.id])

  const save = async (patch: ModelOverrides): Promise<void> => {
    const next = { ...saved, ...patch }
    setSaved(next)
    const all = await api.settingsGet<Record<string, ModelOverrides>>('providers.modelDefaults', {})
    await api.settingsSet('providers.modelDefaults', { ...all, [p.id]: next })
  }

  const effective = modelDefaultsFor(p)
  const effLabel = (role: keyof ModelOverrides, fallback: string): string => {
    const eff = effective[role]
    return eff ? `${fallback}: ${eff}` : `${fallback}…`
  }
  const options = (value: string | undefined, label: string): ReactNode => (
    <>
      <option value="">{label}</option>
      {/* il valore salvato potrebbe non essere nell'elenco (es. modelli cloud non ancora tirati): resta visibile */}
      {value && !(models ?? []).some((m) => m.id === value) && <option value={value}>{value}</option>}
      {(models ?? []).map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
    </>
  )
  const sel = 'rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none'

  if (models === null) return <div className="mt-2 text-xs text-neutral-600">modelli…</div>
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">modelli</span>
      <select className={sel} value={saved.defaultModel ?? ''} onChange={(e) => void save({ defaultModel: e.target.value || undefined })}>
        {options(saved.defaultModel, saved.defaultModel ? 'predefinito…' : effLabel('defaultModel', 'predefinito'))}
      </select>
      <select className={sel} value={saved.fallbackModel ?? ''} onChange={(e) => void save({ fallbackModel: e.target.value || undefined })}>
        {options(saved.fallbackModel, saved.fallbackModel ? 'riserva…' : effLabel('fallbackModel', 'riserva'))}
      </select>
      <select className={sel} value={saved.autoReviewModel ?? ''} onChange={(e) => void save({ autoReviewModel: e.target.value || undefined })}>
        {options(saved.autoReviewModel, saved.autoReviewModel ? 'auto-review…' : effLabel('autoReviewModel', 'auto-review'))}
      </select>
    </div>
  )
}

/**
 * Fase 11 (punto 2): campo "chiave per la ricerca web" del provider Ollama.
 * Il valore va SOLO nel vault sigillato: la UI non lo rilegge mai, chiede al
 * daemon se la chiave è impostata (booleano).
 */
function WebSearchKeyRow({ p }: { p: ProviderConfig }) {
  const [set, setSet] = useState<boolean | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.webSearchKeySet(p.id).then(setSet).catch(() => setSet(null))
  }, [p.id])

  const save = async (key: string | null): Promise<void> => {
    setBusy(true)
    try {
      await api.setWebSearchKey(p.id, key)
      setSet(await api.webSearchKeySet(p.id))
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">ricerca web</span>
      <input
        className="w-56 rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none"
        type="password"
        placeholder={set ? 'chiave salvata (scrivi per sostituirla)' : 'chiave per la ricerca web di Ollama'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="rounded-lg bg-neutral-700 px-2.5 py-1.5 text-xs hover:bg-neutral-600 disabled:opacity-50"
        disabled={busy || !value.trim()}
        onClick={() => void save(value.trim())}
      >
        Salva chiave
      </button>
      {set && (
        <button
          className="rounded-lg border border-neutral-600 px-2.5 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
          disabled={busy}
          onClick={() => void save(null)}
        >
          Rimuovi
        </button>
      )}
      <span className={`text-xs ${set ? 'text-emerald-400' : 'text-neutral-500'}`}>
        {set === null ? '' : set ? 'ricerca web attiva (chiave nel vault)' : 'ricerca web non attiva'}
      </span>
    </div>
  )
}

function ProvidersTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const providers = useStore((s) => s.providers)
  const [edit, setEdit] = useState<ProviderConfig | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string; models?: ModelInfo[] }>>({})

  async function scan() {
    await api.discoverProviders()
    await onChanged()
  }

  async function test(id: string) {
    setTesting(id)
    const r = await api.testProvider(id)
    setTestResult((p) => ({ ...p, [id]: r }))
    setTesting(null)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-neutral-500">Provider locali e cloud — chiunque parli OpenAI-compatible funziona.</p>
        <button className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700" onClick={() => void scan()}>
          Scansiona locale (Ollama / LM Studio)
        </button>
      </div>

      {providers.map((p) => (
        <div key={p.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-sm text-neutral-100">{p.name}</span>
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{p.kind}</span>
            <span className="flex-1 truncate text-xs text-neutral-600">{p.baseUrl}</span>
            <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={() => setEdit(p)}>modifica</button>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-200"
              onClick={() => void test(p.id)}
              disabled={testing === p.id}
            >
              {testing === p.id ? 'test…' : 'test'}
            </button>
            <button
              className="text-xs text-neutral-500 hover:text-red-400"
              onClick={async () => {
                await api.deleteProvider(p.id)
                await onChanged()
              }}
            >
              elimina
            </button>
          </div>
          {testResult[p.id] && (
            <div className={`mt-2 text-xs ${testResult[p.id].ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult[p.id].ok
                ? `✓ ${(testResult[p.id].models?.length ?? 0)} modelli disponibili`
                : `✕ ${testResult[p.id].error}`}
            </div>
          )}
          <ModelDefaultsRow p={p} />
          {p.kind === 'ollama' && <WebSearchKeyRow p={p} />}
        </div>
      ))}

      {edit ? (
        <ProviderForm
          initial={edit}
          onSave={async (p) => {
            await api.saveProvider(p)
            setEdit(null)
            await onChanged()
          }}
          onCancel={() => setEdit(null)}
        />
      ) : (
        <button
          className="w-full rounded-xl border border-dashed border-neutral-700 px-3 py-2.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
          onClick={() =>
            setEdit({ id: '', name: '', kind: 'openai-compatible', baseUrl: 'https://', apiKey: '', enabled: true })
          }
        >
          + Aggiungi provider
        </button>
      )}
    </div>
  )
}

function ProviderForm({ initial, onSave, onCancel }: { initial: ProviderConfig; onSave: (p: ProviderConfig) => Promise<void>; onCancel: () => void }) {
  const [p, setP] = useState(initial)
  return (
    <div className="space-y-2 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
      <div className="grid grid-cols-2 gap-2">
        <input
          className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
          placeholder="Nome (es. Z.ai)"
          value={p.name}
          onChange={(e) => setP({ ...p, name: e.target.value })}
        />
        <select
          className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
          value={p.kind}
          onChange={(e) => setP({ ...p, kind: e.target.value as ProviderKind })}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>
      <input
        className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
        placeholder="Base URL (es. https://api.z.ai)"
        value={p.baseUrl}
        onChange={(e) => setP({ ...p, baseUrl: e.target.value })}
      />
      <input
        className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
        placeholder="API key (vuoto per locali)"
        type="password"
        value={p.apiKey}
        onChange={(e) => setP({ ...p, apiKey: e.target.value })}
      />
      <div className="flex justify-end gap-2 pt-1">
        <button className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200" onClick={onCancel}>
          Annulla
        </button>
        <button
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
          onClick={() => void onSave({ ...p, id: p.id || p.kind + '_' + Date.now() })}
        >
          Salva
        </button>
      </div>
    </div>
  )
}

function AgentsTab() {
  const agents = useStore((s) => s.agents)
  const providers = useStore((s) => s.providers)
  const mainAgentId = useStore((s) => s.mainAgentId)
  const setMainAgent = useStore((s) => s.setMainAgent)
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})
  // fase 7: catalogo dei template (creazione bot col kickstart)
  const [templates, setTemplates] = useState<TemplateInfo[]>([])

  useEffect(() => {
    for (const p of providers) {
      if (!models[p.id]) {
        api.listModels(p.id).then((ms: ModelInfo[]) => setModels((prev) => ({ ...prev, [p.id]: ms }))).catch(() => {})
      }
    }
  }, [providers])
  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => undefined)
  }, [])

  // fase 9 (punto 1): il rifiuto della capability "tools" (o qualunque errore
  // di agents:update) si mostra sotto la riga del bot, non si perde in console
  const [agentError, setAgentError] = useState<Record<string, string>>({})
  async function patch(a: Agent, p: Partial<Agent>) {
    try {
      await api.updateAgent(a.id, p)
      setAgentError((prev) => ({ ...prev, [a.id]: '' }))
    } catch (e) {
      setAgentError((prev) => ({ ...prev, [a.id]: e instanceof Error ? e.message : String(e) }))
    }
  }

  // fase 7: senza setting mainAgentId il principale è il primo agente
  const effectiveMain = mainAgentId ?? agents[0]?.id ?? null

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">Scegli con quale modello pensa ciascun bot.</p>
      {agents.map((a) => (
        <div key={a.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-100">{a.name}</span>
            {a.id === effectiveMain ? (
              <span className="rounded bg-sky-800/60 px-1.5 py-0.5 text-[10px] text-sky-200" title="Punto di contatto principale dell'utente: coordina gli altri bot">
                ★ principale
              </span>
            ) : (
              <button
                className="rounded px-1.5 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                title="Rendi questo bot il punto di contatto principale dell'utente"
                onClick={() => void setMainAgent(a.id)}
              >
                Rendi principale
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
              value={a.providerId ?? ''}
              onChange={async (e) => {
                const pid = e.target.value || null
                await patch(a, { providerId: pid, model: null })
              }}
            >
              <option value="">— provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none disabled:opacity-40"
              disabled={!a.providerId}
              value={a.model ?? ''}
              onChange={async (e) => void patch(a, { model: e.target.value || null })}
            >
              <option value="">— modello —</option>
              {(models[a.providerId ?? ''] ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
              ))}
            </select>
          </div>
          <input
            className="mt-2 w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
            placeholder="Descrizione / ruolo del bot (va nel system prompt)"
            defaultValue={a.description}
            onBlur={async (e) => void patch(a, { description: e.target.value })}
          />
          {agentError[a.id] ? (
            <div className="mt-1.5 text-xs text-red-400">✕ {agentError[a.id]}</div>
          ) : null}
        </div>
      ))}

      {templates.length > 0 && (
        <div className="space-y-2 border-t border-neutral-800 pt-3">
          <p className="text-xs text-neutral-500">
            Crea un bot da template: parte con un messaggio di configurazione che crea routine (in pausa), memorie e domande di attivazione.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {templates.map((t) => (
              <button
                key={t.id}
                className="rounded-xl border border-neutral-800 px-3 py-2 text-left hover:border-neutral-600"
                onClick={async () => {
                  try {
                    await api.createAgentFromTemplate(t.id)
                  } catch (e) {
                    console.error('createAgentFromTemplate:', e instanceof Error ? e.message : e)
                  }
                }}
                title={t.description}
              >
                <span className="mr-1">{t.avatar}</span>
                <span className="text-sm text-neutral-100">{t.name}</span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PermissionsTab({ onChanged }: { onChanged: () => Promise<void> }) {
  const permissions = useStore((s) => s.permissions)
  if (!permissions) return null
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Regole per tool: consenti sempre / chiedi / blocca. "Consenti sempre" nelle card salva una standing grant.
      </p>
      <div className="rounded-xl border border-neutral-800 px-3 py-2.5">
        <label className="flex items-center justify-between text-sm">
          <span className="text-neutral-300">Politica predefinita</span>
          <select
            className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
            value={permissions.default}
            onChange={async (e) => {
              await api.setPermissions({ ...permissions, default: e.target.value as typeof permissions.default })
              await onChanged()
            }}
          >
            <option value="always_allow">Consenti sempre</option>
            <option value="needs_approval">Chiedi approvazione</option>
            <option value="blocked">Blocca</option>
          </select>
        </label>
      </div>
      {permissions.rules.map((r, i) => (
        <div key={i} className="flex items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2.5">
          <span className="w-36 font-mono text-xs text-neutral-300">{r.tool}</span>
          <span className="w-24 font-mono text-xs text-neutral-600">{r.pattern}</span>
          <div className="flex-1" />
          <select
            className="rounded-lg bg-neutral-800 px-2.5 py-1.5 text-xs outline-none"
            value={r.mode}
            onChange={async (e) => {
              const rules = [...permissions.rules]
              rules[i] = { ...r, mode: e.target.value as typeof r.mode }
              await api.setPermissions({ ...permissions, rules })
              await onChanged()
            }}
          >
            <option value="always_allow">Consenti sempre</option>
            <option value="needs_approval">Chiedi approvazione</option>
            <option value="blocked">Blocca</option>
          </select>
        </div>
      ))}
    </div>
  )
}

// ---- fase 6: tab Routine con trigger in linguaggio naturale, prossima
// esecuzione, stato (attiva / in pausa / in pausa per assenza) e editor dei
// tipi di trigger (schedule, email, calendar_event, webhook, poll avanzato) ----

type TriggerKind = 'schedule' | 'email' | 'calendar_event' | 'webhook' | 'connector_poll' | 'presence_return'

function kindOf(t: RoutineTrigger | null | undefined, legacySchedule?: string): TriggerKind {
  if (!t) return 'schedule'
  if (t.type === 'schedule') return 'schedule'
  if (t.type === 'connector_poll') return t.preset ?? 'connector_poll'
  return t.type
}

const KIND_LABEL: Record<TriggerKind, string> = {
  schedule: 'orario',
  email: 'email in arrivo',
  calendar_event: 'evento del calendario',
  webhook: 'webhook',
  connector_poll: 'poll di un connettore',
  presence_return: 'quando torni al computer'
}

function RoutinesTab() {
  const activeId = useStore((s) => s.activeId)
  const connectors = useStore((s) => s.connectors)
  const [routines, setRoutines] = useState<RoutineInfo[]>([])
  const [editing, setEditing] = useState<RoutineInfo | null>(null)
  const [err, setErr] = useState('')
  const [suggestions, setSuggestions] = useState<RoutineSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  // fase 7 (residuo 0a): i server MCP manuali sono ammessi come fonte dei
  // poll (con conferma esplicita di sola lettura)
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
    await api.updateRoutineTrigger(r.id, r.enabled ? { enabled: 0 } : { enabled: 1, paused_for_away: 0 })
    await refresh()
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Le routine sono attività automatiche del Bot: su orario (cron o "ogni giorno alle 9, circa"),
        su un'email in arrivo, prima di un evento del calendario, da un webhook o quando torni al computer.
        I loro messaggi non urgenti aspettano la finestra di consegna.
      </p>

      {routines.map((r) => {
        const state = r.enabled ? 'attiva' : r.paused_for_away ? 'in pausa per assenza' : 'in pausa'
        const stateColor = r.enabled ? 'text-emerald-500' : r.paused_for_away ? 'text-amber-500' : 'text-neutral-500'
        return (
          <div key={r.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${r.enabled ? 'bg-emerald-500' : r.paused_for_away ? 'bg-amber-500' : 'bg-neutral-600'}`} />
              <span className="text-sm text-neutral-100">{r.title}</span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{KIND_LABEL[kindOf(r.trigger)]}</span>
              <div className="flex-1" />
              <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={() => setEditing(r)}>modifica</button>
              <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={() => void pauseResume(r)}>
                {r.enabled ? 'metti in pausa' : 'riattiva'}
              </button>
              <button className="text-xs text-neutral-500 hover:text-red-400" onClick={async () => { await api.deleteRoutine(r.id); await refresh() }}>
                elimina
              </button>
            </div>
            <p className="mt-1 text-xs text-neutral-500">{describeTrigger(r.trigger ?? null, r.schedule)}</p>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-neutral-600">
              <span className={stateColor}>{state}</span>
              {r.next_run && <span>prossima: {new Date(r.next_run).toLocaleString('it-IT')}</span>}
              {r.last_run && <span>ultima: {new Date(r.last_run).toLocaleString('it-IT')}</span>}
            </div>
            {r.webhook_url && (
              <div className="mt-1 flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1.5">
                <code className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">{r.webhook_url}</code>
                <code className="hidden truncate text-[10px] text-neutral-600" title={`Authorization: Bearer ${r.trigger?.type === 'webhook' ? r.trigger.token : ''}`}>
                  {r.trigger?.type === 'webhook' ? r.trigger.token.slice(0, 10) + '…' : ''}
                </code>
                <button
                  className="text-[10px] text-sky-400 hover:text-sky-300"
                  onClick={() => void navigator.clipboard?.writeText(
                    `curl -X POST ${r.webhook_url} -H "Authorization: Bearer ${r.trigger?.type === 'webhook' ? r.trigger.token : ''}" -d '{"test":1}'`
                  )}
                >
                  copia curl
                </button>
              </div>
            )}
          </div>
        )
      })}

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
            onCreate={async (title, prompt, trigger, timezone) => {
              setErr('')
              try {
                await api.createRoutineTrigger(activeId!, title, prompt, trigger, timezone || undefined)
                await refresh()
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e))
              }
            }}
            err={err}
          />
          <div className="space-y-2 border-t border-neutral-800 pt-2">
            <button
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-40"
              disabled={busy || !activeId}
              onClick={async () => {
                setBusy(true); setErr(''); setSuggestions([])
                try { setSuggestions(await api.suggestRoutines(activeId!)) }
                catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
                setBusy(false)
              }}
            >
              {busy ? 'analizzo…' : '✨ Suggerisci dal transcript'}
            </button>
            {suggestions.map((s, i) => (
              <div key={i} className="rounded-lg border border-neutral-800 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-neutral-100">{s.title}</span>
                  <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">{s.schedule}</code>
                  <div className="flex-1" />
                  <button
                    className="rounded-md bg-emerald-700/60 px-2 py-1 text-xs text-white hover:bg-emerald-600/60"
                    onClick={async () => {
                      await api.createRoutine(activeId!, s.title, s.description, s.schedule)
                      setSuggestions(suggestions.filter((_, j) => j !== i))
                      await refresh()
                    }}
                  >
                    Aggiungi
                  </button>
                </div>
                <p className="mt-1 text-xs text-neutral-500">{s.description}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Bottone "+ routine" che apre l'editor con il tipo di trigger da scegliere. */
function NewRoutinePicker(props: {
  agentId: string | null
  connectors: ConnectorInfo[]
  manualServers: McpServerInfo[]
  onCreate(title: string, prompt: string, trigger: RoutineTrigger, timezone: string): Promise<void>
  err: string
}) {
  const [kind, setKind] = useState<TriggerKind | null>(null)
  if (!kind) {
    return (
      <div className="space-y-2">
        <button
          className="w-full rounded-xl border border-dashed border-neutral-700 px-3 py-2.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-300"
          onClick={() => setKind('schedule')}
        >
          + Nuova routine
        </button>
        {props.err && <p className="text-xs text-red-400">{props.err}</p>}
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
  onCreate?(title: string, prompt: string, trigger: RoutineTrigger, timezone: string): Promise<void>
}) {
  const r = props.routine
  const [kind, setKind] = useState<TriggerKind>(props.initialKind ?? kindOf(r?.trigger, r?.schedule))
  const [title, setTitle] = useState(r?.title ?? '')
  const [prompt, setPrompt] = useState(r?.prompt ?? '')
  const [timezone, setTimezone] = useState(r?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // schedule
  // schedule: il toggle è "cron" se c'è un'espressione, "ogni…" se vuota
  // (le routine every hanno la colonna schedule vuota)
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
  // fase 7 (residuo 0a): conferma esplicita per i poll su server NON del catalogo
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
      if (!trigger) throw new Error('Argomenti (args) non sono JSON valido')
      if (props.onCreate) await props.onCreate(title.trim(), prompt.trim(), trigger, timezone.trim())
      else await api.updateRoutineTrigger(r!.id, { title: title.trim(), prompt: prompt.trim(), trigger, timezone: timezone.trim() })
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

  const inputCls = 'rounded-lg bg-neutral-800 px-2 py-1.5 text-xs outline-none'
  const presetHint = (preset: 'email' | 'calendar_event'): string => {
    const { tool: t } = autoTool(preset, connectorId)
    return t
      ? `tool scelto dal connettore: ${t}`
      : 'nessun tool riconosciuto nel connettore: configura tool e idField a mano'
  }

  return (
    <div className="space-y-2 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
      <div className="flex gap-1">
        {(Object.keys(KIND_LABEL) as TriggerKind[]).map((k) => (
          <button
            key={k}
            className={`rounded-lg px-2 py-1 text-[11px] ${kind === k ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
            onClick={() => setKind(k)}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <input className={`w-full ${inputCls} text-sm`} placeholder="Titolo (es. Riepilogo email del mattino)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className={`w-full ${inputCls} text-sm`} placeholder="Cosa deve fare il Bot a ogni esecuzione" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      {kind === 'schedule' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <button className={`rounded-lg px-2 py-1 ${cron !== '' ? 'bg-neutral-700' : ''}`} onClick={() => { setCron('0 9 * * *') }}>cron</button>
            <button className={`rounded-lg px-2 py-1 ${cron === '' ? 'bg-neutral-700' : ''}`} onClick={() => setCron('')}>ogni…</button>
            {cron === '' && (
              <>
                <select className={inputCls} value={every} onChange={(e) => setEvery(e.target.value as typeof every)}>
                  <option value="day">giorno</option>
                  <option value="weekday">giorni feriali</option>
                  <option value="week">settimana</option>
                  <option value="month">mese</option>
                  <option value="hour">ora</option>
                </select>
                {every === 'week' && (
                  <select className={inputCls} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                    {['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'].map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </select>
                )}
                {every === 'month' && (
                  <input className={`w-16 ${inputCls}`} type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))} />
                )}
                <input className={`w-20 ${inputCls}`} placeholder="HH:MM" value={at} onChange={(e) => setAt(e.target.value)} />
                <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as 'at' | 'around')}>
                  <option value="at">preciso</option>
                  <option value="around">circa (±15 min)</option>
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
                <option value="">— connettore —</option>
                {presetConnectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {props.manualServers.map((s) => <option key={s.id} value={s.id}>{s.name} (server manuale)</option>)}
              </select>
              {props.manualServers.some((s) => s.id === connectorId) && (
                // fase 7 (residuo 0a): readOnlyHint di un server manuale è
                // autodichiarato — serve la spunta esplicita dell'utente
                <label className="flex items-start gap-2 rounded-lg border border-amber-800/50 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200/90">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={confirmReadOnly}
                    onChange={(e) => setConfirmReadOnly(e.target.checked)}
                  />
                  Confermo che questo tool legge soltanto e non modifica nulla (server aggiunto a mano: la dichiarazione "sola lettura" non è verificata)
                </label>
              )}
            </>
          )}
          {(kind === 'email' || kind === 'calendar_event') && <p className="text-[11px] text-neutral-500">{presetHint(kind)}</p>}
          {kind === 'email' && (
            <input className={`w-full ${inputCls}`} placeholder="Quando arriva un'e-mail che corrisponde a… (query)" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          {kind === 'calendar_event' && (
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              avvisa
              <input className={`w-16 ${inputCls}`} type="number" min={0} value={offsetMinutes} onChange={(e) => setOffsetMinutes(Number(e.target.value))} />
              minuti prima dell'evento
            </label>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input className={`font-mono ${inputCls}`} placeholder="tool (mcp__…__…)" value={tool} onChange={(e) => setTool(e.target.value)} />
            <input className={`font-mono ${inputCls}`} placeholder='idField (es. "messages[].id")' value={idField} onChange={(e) => setIdField(e.target.value)} />
            <input className={inputCls} type="number" min={2} title="minuti tra i poll (minimo 2)" value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))} />
            {kind === 'connector_poll' && (
              <input className={`font-mono ${inputCls}`} placeholder='args JSON, es. {"query":"x"}' value={argsJson} onChange={(e) => setArgsJson(e.target.value)} />
            )}
          </div>
        </div>
      )}

      {kind === 'webhook' && (
        <p className="text-[11px] text-neutral-500">
          All'uscita trovi l'URL con il token da copiare: qualunque sistema può far scattare la routine con un POST.
        </p>
      )}
      {kind === 'presence_return' && (
        <p className="text-[11px] text-neutral-500">La routine gira quando torni al computer dopo un'assenza lunga.</p>
      )}

      <input className={`w-full ${inputCls}`} placeholder="Fuso orario (es. Europe/Rome)" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200" onClick={props.onCancel}>Annulla</button>
        <button
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          disabled={busy || !title.trim() || !prompt.trim() || !props.agentId}
          onClick={() => void save()}
        >
          {r ? 'Salva' : 'Crea routine'}
        </button>
      </div>
    </div>
  )
}
