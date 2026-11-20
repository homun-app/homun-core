// M2 (fase beta12-correzioni): la finestra «Server MCP» — i server MCP hanno
// una finestra LORO, come le Skill, aperta dalla voce «Server MCP» nel menu
// dell'account (tra Skill e Impostazioni). Dentro: l'elenco dei server
// collegati e il form di aggiunta di oggi — ManualServers SPOSTATO qui da
// AppsWindow così com'era (si sposta, non si riscrive; gli aggiungo solo la
// mezza riga «usato da …» quando enabledFor esiste già); in fondo, piccolo,
// «Gateway, plugin e registro» apre «Per sviluppatori». Il resto dei tool da
// sviluppatore (chiave Composio, gateway, marketplace, registro) resta in
// AppsWindow › Per sviluppatori, che ora rimanda qui per i server manuali:
// ogni cosa sta in un posto solo. Come SkillsWindow: Dialog grande, Esc per
// chiudere, niente anello di focus all'apertura.
import { useEffect, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { api, useStore } from '../store'
import type { McpServerInfo, McpServerSecret } from '../../../shared/types'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
// E1 (fase mcp-env): le righe «Variabili» del form stdio
import { envRowsFromServer, saveEnvPayload, newEnvRow, envNameLooksSecret, type EnvRow } from '../lib/mcp-env'

/** La finestra «Server MCP» (dal menu dell'account; anche dalla card del bot e da «Per sviluppatori»). */
export function McpWindow(): React.ReactNode {
  const { i18n } = useLingui()
  const setMcpOpen = useStore((s) => s.setMcpOpen)
  // il rimando in fondo apre «Per sviluppatori» nella finestra App
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const setAppsOpenDevelopers = useStore((s) => s.setAppsOpenDevelopers)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) setMcpOpen(false) }}>
      <DialogContent
        className="flex max-h-[88vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-3xl bg-card p-0 shadow-soft sm:max-w-3xl"
        showCloseButton={false}
        data-testid="mcp-window"
        onOpenAutoFocus={(e) => {
          // come T5 di SkillsWindow: niente anello di focus all'apertura; il
          // focus della finestra arriva dal menu che l'ha aperta
          e.preventDefault()
        }}
      >
          <DialogTitle className="sr-only">{i18n._(msg`Server MCP`)}</DialogTitle>
          <div className="flex max-h-[88vh] flex-col">
            <div className="flex items-center gap-2 px-6 pt-5">
              <strong className="font-display text-lg"><Trans>Server MCP</Trans></strong>
              <span className="flex-1" />
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label={i18n._(msg`Chiudi`)}
                onClick={() => setMcpOpen(false)}
              >
                ✕
              </button>
            </div>
            {/* l'intestazione in parole semplici: chi usa già Cursor o Claude
                riconosce i suoi server */}
            <p className="px-6 pt-1 text-[13px] leading-snug text-muted-foreground">
              <Trans>Collegano Homun ai tuoi strumenti e ai servizi della tua azienda. Se usi già Cursor o Claude, sono gli stessi server: aggiungili qui con lo stesso comando o lo stesso indirizzo.</Trans>
            </p>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto scroll-thin px-6 pb-5">
              <ManualServers />
              {/* in fondo, piccolo: il resto dei tool da sviluppatore */}
              <p className="mt-6 text-center text-[12px] text-muted-foreground">
                <button
                  type="button"
                  className="underline-offset-2 transition hover:text-foreground hover:underline"
                  data-testid="mcp-window-developers"
                  onClick={() => { setMcpOpen(false); setAppsOpen(true); setAppsOpenDevelopers(true) }}
                >
                  <Trans>Gateway, plugin e registro</Trans> ›
                </button>
              </p>
            </div>
          </div>
      </DialogContent>
    </Dialog>
  )
}

/** Server MCP aggiunti a mano: il foglio di oggi, dentro un velo. */
export function ManualServersSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="no-drag fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto scroll-thin rounded-3xl bg-card p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <ManualServers />
      </div>
    </div>
  )
}

/** Server MCP aggiunti a mano (stdio o HTTP, con header/bearer salvati cifrati). */
function ManualServers() {
  const { t } = useLingui()
  const agents = useStore((s) => s.agents)
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [edit, setEdit] = useState<McpServerInfo | null>(null)
  // fase 5: bearer token del server manuale (salvato CIFRATO, mai nei settings)
  const [editBearer, setEditBearer] = useState('')
  // E1 (fase mcp-env): le righe Variabili del server stdio manuale
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [tests, setTests] = useState<Record<string, { ok: boolean; error?: string; tools?: string[] }>>({})

  const refresh = async () => {
    setServers(await api.mcpList())
  }
  useEffect(() => { void refresh() }, [])

  return (
    <div className="space-y-3">
      <strong className="block font-display text-lg"><Trans>Server MCP personalizzato</Trans></strong>
      <p className="text-xs text-muted-foreground"><Trans>Server MCP manuali (stdio o HTTP, con header/bearer salvati cifrati).</Trans></p>
      {servers.map((s) => (
        <div key={s.id} className="rounded-2xl bg-muted px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${s.enabled ? 'bg-chart-2' : 'bg-muted-foreground/40'}`} />
            <span className="text-sm">{s.name}</span>
            <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{s.transport}</span>
            <span className="flex-1 truncate text-xs text-muted-foreground">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</span>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={async () => {
              setTests((p) => ({ ...p, [s.id]: { ok: true, tools: ['test…'] } }))
              const r = await api.mcpTest(s.id)
              setTests((p) => ({ ...p, [s.id]: r }))
            }}><Trans>test</Trans></button>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setEdit(s); setEditBearer(''); setEnvRows(envRowsFromServer(s)) }}><Trans>modifica</Trans></button>
            <button className="text-xs text-muted-foreground hover:text-destructive" onClick={async () => { await api.mcpDelete(s.id); await refresh() }}><Trans>elimina</Trans></button>
          </div>
          {/* E1 (fase mcp-env): i NOMI delle variabili del server stdio — i
              valori segreti mai, solo •••• */}
          {(s.envSpec?.length ?? 0) > 0 && (
            <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground" data-testid="mcp-env-names">
              {s.envSpec!.map((v) => `${v.name} = ${v.secret ? '••••' : (s.envValues?.[v.name] ?? '')}`).join(', ')}
            </p>
          )}
          {/* M2: da quali bot è usato, quando il dato esiste già (enabledFor) */}
          {s.enabledFor && (
            <p className="mt-0.5 truncate pl-4 text-[11px] text-muted-foreground">
              {s.enabledFor.includes('*') ? t`usato da tutti i bot`
                : t`usato da: ${s.enabledFor.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(', ')}`}
            </p>
          )}
          {tests[s.id] && (
            <div className={`mt-2 text-xs ${tests[s.id].ok ? 'text-chart-2' : 'text-destructive'}`}>
              {tests[s.id].ok ? t`✓ ${tests[s.id].tools?.length ?? 0} tool: ${(tests[s.id].tools ?? []).join(', ').slice(0, 200)}` : t`✕ ${tests[s.id].error ?? ''}`}
            </div>
          )}
        </div>
      ))}
      {edit ? (
        <div className="space-y-2 rounded-2xl bg-muted p-3">
          <div className="grid grid-cols-2 gap-2">
            <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Nome (es. weather)`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <select className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as 'stdio' | 'http' })}>
              <option value="stdio">{t`stdio (comando locale)`}</option>
              <option value="http">{t`http (URL)`}</option>
            </select>
          </div>
          {edit.transport === 'stdio' ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Comando (es. node)`} value={edit.command ?? ''} onChange={(e) => setEdit({ ...edit, command: e.target.value })} />
                <input className="rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`Argomenti separati per spazio`} value={(edit.args ?? []).join(' ')} onChange={(e) => setEdit({ ...edit, args: e.target.value ? e.target.value.split(/\s+/) : [] })} />
              </div>
              {/* E1 (fase mcp-env): le VARIABILI del server — righe nome = valore
                  con interruttore «segreto»; i segreti si salvano CIFRATI e in
                  modifica si sostituiscono, non si leggono */}
              <div className="rounded-2xl bg-card p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium"><Trans>Variabili</Trans></span>
                  <button
                    type="button"
                    className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    data-testid="mcp-env-add"
                    onClick={() => setEnvRows((rows) => [...rows, newEnvRow()])}
                  >
                    <Trans>+ Variabile</Trans>
                  </button>
                </div>
                <div data-testid="mcp-env-rows" className="mt-1.5 space-y-1.5">
                  {envRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        className="w-2/5 rounded-lg bg-muted px-2 py-1 text-xs outline-none"
                        placeholder={t`Nome (es. MATTERMOST_URL)`}
                        value={row.name}
                        onChange={(e) => {
                          const name = e.target.value
                          setEnvRows((rows) => rows.map((r, j) => j === i ? { ...r, name, secret: name ? envNameLooksSecret(name) : r.secret } : r))
                        }}
                      />
                      <span className="text-xs text-muted-foreground">=</span>
                      <input
                        className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1 text-xs outline-none"
                        type={row.secret ? 'password' : 'text'}
                        placeholder={row.secret && row.saved ? t`salvato cifrato — scrivi per sostituire` : t`Valore`}
                        value={row.value}
                        onChange={(e) => setEnvRows((rows) => rows.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                      />
                      <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" title={t`Segreto (salvato cifrato)`}>
                        <input
                          type="checkbox"
                          data-testid="mcp-env-secret"
                          checked={row.secret}
                          onChange={(e) => setEnvRows((rows) => rows.map((r, j) => j === i ? { ...r, secret: e.target.checked } : r))}
                        />
                        <Trans>segreto</Trans>
                      </label>
                      <button
                        type="button"
                        className="shrink-0 rounded-full px-1.5 text-xs text-muted-foreground hover:text-destructive"
                        aria-label={t`Togli la variabile`}
                        data-testid="mcp-env-remove"
                        onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                  <Trans>Arrivano al comando come variabili d'ambiente. Quelle segrete si salvano cifrate: nell'elenco si vedono solo i nomi.</Trans>
                </p>
              </div>
            </>
          ) : (
            <>
              <input className="w-full rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none" placeholder={t`URL (es. http://localhost:3001/mcp)`} value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              <input
                className="w-full rounded-lg bg-card px-2.5 py-1.5 text-sm outline-none"
                type="password"
                placeholder={t`Bearer token (opzionale — salvato cifrato)`}
                value={editBearer}
                onChange={(e) => setEditBearer(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEdit(null)}><Trans>Annulla</Trans></button>
            <button
              className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
              onClick={async () => {
                // E1: le Variabili — la dichiarazione e i valori NON segreti
                // nella config, i SEGRETI solo nel parametro cifrato
                const env = saveEnvPayload(envRows)
                const withEnv = edit.transport === 'stdio' && env.envSpec.length ? { ...edit, envSpec: env.envSpec, envValues: env.envValues } : { ...edit, envSpec: undefined, envValues: undefined }
                const secret: McpServerSecret | undefined = edit.transport === 'http' && editBearer.trim()
                  ? { bearerToken: editBearer.trim() }
                  : edit.transport === 'stdio' && Object.keys(env.envSecrets).length ? { env: env.envSecrets } : undefined
                await api.mcpSave({ ...withEnv, id: edit.id || 'mcp_' + Date.now() }, secret)
                setEdit(null); setEditBearer(''); setEnvRows([])
                await refresh()
              }}
            >
              <Trans>Salva</Trans>
            </button>
          </div>
        </div>
      ) : (
        <button className="w-full rounded-2xl bg-muted px-3 py-2.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={() => { setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true }); setEditBearer(''); setEnvRows([newEnvRow()]) }}>
          <Trans>+ Aggiungi server MCP</Trans>
        </button>
      )}
    </div>
  )
}
