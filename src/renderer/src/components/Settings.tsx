// Impostazioni: provider (modelli personalizzati), modello per agente, permessi, routine.
import { useEffect, useState } from 'react'
import { api, useStore } from '../store'
import type { ProviderConfig, ProviderKind, ModelInfo, Agent, RoutineInfo, RoutineSuggestion } from '../../../shared/types'

const KINDS: ProviderKind[] = [
  'ollama', 'lmstudio', 'openai', 'anthropic', 'mistral', 'openrouter', 'zai', 'xai', 'deepseek', 'groq', 'openai-compatible'
]

export function Settings() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const refreshProviders = useStore((s) => s.refreshProviders)
  const refreshPermissions = useStore((s) => s.refreshPermissions)
  const [tab, setTab] = useState<'provider' | 'agenti' | 'permessi' | 'routine' | 'mcp'>('provider')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSettingsOpen(false)}>
      <div
        className="flex h-[560px] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1 border-b border-neutral-800 px-4 pt-4 pb-2">
          {(['provider', 'agenti', 'permessi', 'routine', 'mcp'] as const).map((t) => (
            <button
              key={t}
              className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}
              onClick={() => setTab(t)}
            >
              {t}
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
          {tab === 'mcp' && <McpTab />}
        </div>
      </div>
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
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})

  useEffect(() => {
    for (const p of providers) {
      if (!models[p.id]) {
        api.listModels(p.id).then((ms: ModelInfo[]) => setModels((prev) => ({ ...prev, [p.id]: ms }))).catch(() => {})
      }
    }
  }, [providers])

  async function patch(a: Agent, p: Partial<Agent>) {
    await api.updateAgent(a.id, p)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">Scegli con quale modello pensa ciascun bot.</p>
      {agents.map((a) => (
        <div key={a.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-100">{a.name}</span>
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
        </div>
      ))}
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

function RoutinesTab() {
  const activeId = useStore((s) => s.activeId)
  const [routines, setRoutines] = useState<RoutineInfo[]>([])
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('0 9 * * *')
  const [suggestions, setSuggestions] = useState<RoutineSuggestion[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const refresh = async () => {
    if (activeId) setRoutines(await api.listRoutines(activeId))
  }
  useEffect(() => { void refresh() }, [activeId])

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Le routine sono attività ricorrenti che il Bot esegue su una pianificazione (cron: "m h g mese settimana", es. <code>0 9 * * *</code> = ogni giorno alle 9).
      </p>

      {routines.map((r) => (
        <div key={r.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${r.enabled ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
            <span className="text-sm text-neutral-100">{r.title}</span>
            <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">{r.schedule}</code>
            <div className="flex-1" />
            <button
              className="text-xs text-neutral-400 hover:text-neutral-200"
              onClick={async () => { await api.updateRoutine(r.id, { enabled: r.enabled ? 0 : 1 }); await refresh() }}
            >
              {r.enabled ? 'disabilita' : 'abilita'}
            </button>
            <button
              className="text-xs text-neutral-500 hover:text-red-400"
              onClick={async () => { await api.deleteRoutine(r.id); await refresh() }}
            >
              elimina
            </button>
          </div>
          <p className="mt-1 text-xs text-neutral-500">{r.prompt}</p>
          {r.last_run && <p className="mt-1 text-[10px] text-neutral-600">ultima esecuzione: {new Date(r.last_run).toLocaleString('it-IT')}</p>}
        </div>
      ))}

      <div className="space-y-2 rounded-xl border border-neutral-700 bg-neutral-900 p-3">
        <input
          className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
          placeholder="Titolo (es. Riepilogo email del mattino)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <input
          className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none"
          placeholder="Cosa deve fare il Bot a ogni esecuzione"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex gap-2">
          <input
            className="w-36 rounded-lg bg-neutral-800 px-2.5 py-1.5 font-mono text-xs outline-none"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          />
          <button
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            disabled={!title.trim() || !prompt.trim() || !activeId}
            onClick={async () => {
              await api.createRoutine(activeId!, title.trim(), prompt.trim(), schedule.trim())
              setTitle(''); setPrompt('')
              await refresh()
            }}
          >
            Aggiungi routine
          </button>
          <div className="flex-1" />
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
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
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
    </div>
  )
}

function McpTab() {
  const [servers, setServers] = useState<import('../../../shared/types').McpServerInfo[]>([])
  const [secrets, setSecrets] = useState<string[]>([])
  const [edit, setEdit] = useState<import('../../../shared/types').McpServerInfo | null>(null)
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string; tools?: string[] }>>({})
  const [secName, setSecName] = useState('')
  const [secValue, setSecValue] = useState('')

  const refresh = async () => {
    setServers(await api.mcpList())
    setSecrets(await api.vaultList())
  }
  useEffect(() => { void refresh() }, [])

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <p className="text-xs text-neutral-500">Server MCP: i loro tool diventano disponibili al bot come <code>mcp__&lt;server&gt;__&lt;tool&gt;</code> (ogni chiamata chiede approvazione).</p>
        {servers.map((s) => (
          <div key={s.id} className="rounded-xl border border-neutral-800 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-neutral-600'}`} />
              <span className="text-sm text-neutral-100">{s.name}</span>
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{s.transport}</span>
              <span className="flex-1 truncate text-xs text-neutral-600">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</span>
              <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={async () => {
                setTests((p) => ({ ...p, [s.id]: { ok: true, tools: ['test…'] } }))
                const r = await api.mcpTest(s.id)
                setTests((p) => ({ ...p, [s.id]: r }))
              }}>test</button>
              <button className="text-xs text-neutral-400 hover:text-neutral-200" onClick={() => setEdit(s)}>modifica</button>
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
              <input className="w-full rounded-lg bg-neutral-800 px-2.5 py-1.5 text-sm outline-none" placeholder="URL (es. http://localhost:3001/mcp)" value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button className="rounded-lg px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200" onClick={() => setEdit(null)}>Annulla</button>
              <button className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500" onClick={async () => { await api.mcpSave({ ...edit, id: edit.id || 'mcp_' + Date.now() }); setEdit(null); await refresh() }}>Salva</button>
            </div>
          </div>
        ) : (
          <button className="w-full rounded-xl border border-dashed border-neutral-700 px-3 py-2.5 text-sm text-neutral-500 hover:border-neutral-500 hover:text-neutral-300" onClick={() => setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true })}>
            + Aggiungi server MCP
          </button>
        )}
      </div>

      <div className="space-y-2 border-t border-neutral-800 pt-3">
        <p className="text-xs text-neutral-500">Vault credenziali (AES-256-GCM, chiave master in safeStorage): il bot vede i nomi col tool <code>list-credentials</code> e li usa scrivendo <code>{'{{secret:NOME}}'}</code> nei comandi — i valori non compaiono mai nel transcript.</p>
        {secrets.map((n) => (
          <div key={n} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2">
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
