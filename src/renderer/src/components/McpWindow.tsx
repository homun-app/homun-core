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
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { PlugZap, Pencil, Trash2, X, Terminal, Globe, KeyRound } from 'lucide-react'
import { api, useStore } from '../store'
import type { McpServerInfo, McpServerSecret } from '../../../shared/types'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
// E1 (fase mcp-env): le righe «Variabili» del form stdio
import { envRowsFromServer, saveEnvPayload, newEnvRow, envNameLooksSecret, type EnvRow } from '../lib/mcp-env'
// U2 (fase mcp-ui): l'elenco di import raggruppato per origine
import { groupImportRows, importRowKey, type ImportGroupUi, type ImportScanRow, type ImportSkipRow, type ImportSource } from '../lib/mcp-import-groups'

/**
 * U1 (fase mcp-ui): il bottone ICONA delle azioni per riga — 28×28, rounded-lg,
 * grigio, più scuro al passaggio (elimina rosso). NESSUN testo visibile:
 * l'etichetta tradotta sta in aria-label e title (l'accessibilità resta).
 */
function IconButton({ label, danger, testid, onClick, children }: {
  label: string
  danger?: boolean
  testid?: string
  onClick(): void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <button
      type="button"
      className={`grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted ${danger ? 'hover:text-destructive' : 'hover:text-foreground'}`}
      aria-label={label}
      title={label}
      {...(testid ? { 'data-testid': testid } : {})}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/**
 * U1/U5 (fase mcp-ui): il risultato del test di connessione nella riga — un
 * PALLINO (verde «N strumenti», rosso con l'errore leggibile) col messaggio
 * completo nel suggerimento. Niente testo che allarga la riga: l'etichetta è
 * troncata, il messaggio intero sta nel title.
 */
function RowTestStatus({ test }: { test: { ok: boolean; error?: string; tools?: string[]; pending?: boolean } }): React.ReactNode {
  const { t } = useLingui()
  const n = test.tools?.length ?? 0
  const tip = test.pending ? t`test in corso…` : test.ok ? t`${n} strumenti: ${(test.tools ?? []).join(', ')}` : (test.error ?? '')
  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1.5"
      data-testid="mcp-row-status"
      title={tip}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${test.pending ? 'bg-muted-foreground/50' : test.ok ? 'bg-chart-2' : 'bg-destructive'}`} />
      {!test.pending && (
        <span className={`max-w-48 truncate text-[11px] ${test.ok ? 'text-chart-2' : 'text-destructive'}`}>
          {test.ok ? <Plural value={n} one="# strumento" other="# strumenti" /> : (test.error ?? '')}
        </span>
      )}
    </span>
  )
}

/** La finestra «Server MCP» (dal menu dell'account; anche dalla card del bot e da «Per sviluppatori»). */
export function McpWindow(): React.ReactNode {
  const { i18n } = useLingui()
  const setMcpOpen = useStore((s) => s.setMcpOpen)
  // il rimando in fondo apre «Per sviluppatori» nella finestra App
  const setAppsOpen = useStore((s) => s.setAppsOpen)
  const setAppsOpenDevelopers = useStore((s) => s.setAppsOpenDevelopers)
  // U3: porta DIRETTAMENTE alla sezione Gateway (niente giro a vuoto)
  const setAppsDevelopersScrollTo = useStore((s) => s.setAppsDevelopersScrollTo)
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
                  onClick={() => {
                    // U3: un foglio solo — questa si chiude, «Per sviluppatori»
                    // si apre GIÀ sulla sezione Gateway (scroll diretto)
                    setMcpOpen(false)
                    setAppsDevelopersScrollTo('gateway')
                    setAppsOpen(true)
                    setAppsOpenDevelopers(true)
                  }}
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

/**
 * U2 (fase mcp-ui): l'elenco di «Importa da Cursor, Claude o ZCode» —
 * RAGGRUPPATO per origine (icona quando c'è, altrimenti l'iniziale in un
 * cerchio; il nome dell'app e il percorso del file in piccolo grigio,
 * troncato; i gruppi vuoti nascosti). Ogni riga, alta ~44 px con spazio tra
 * le righe: casella, icona del tipo (Terminal per il comando locale, Globe
 * per l'indirizzo), nome, sotto il comando o l'host troncato; a destra
 * l'icona KeyRound col conteggio dei segreti («1 segreto» / «2 segreti») e
 * «anche in <origine>» per i doppioni esatti. I già presenti sono spenti e
 * non selezionabili. In fondo: «N selezionati», «Annulla», «Importa N».
 * Componente PRESENTAZIONALE (esportata per i test di render).
 */
export function ImportList({ groups, skipped = [], picks, onPicks, onImport, onCancel }: {
  groups: ImportGroupUi[]
  /** U7: le voci col formato non capito, SALTATE col motivo */
  skipped?: ImportSkipRow[]
  picks: Record<string, boolean>
  onPicks(next: Record<string, boolean>): void
  onImport(): void
  onCancel(): void
}): React.ReactNode {
  const { t } = useLingui()
  // U7: le otto app (i nomi propri non si tradiscono, il resto sì)
  const label = (s: ImportSource): string =>
    s === 'cursor' ? t`Cursor`
      : s === 'claude' ? t`Claude Desktop`
        : s === 'zcode' ? t`ZCode`
          : s === 'claude-code' ? t`Claude Code`
            : s === 'codex' ? t`Codex`
              : s === 'windsurf' ? t`Windsurf`
                : s === 'gemini' ? t`Gemini CLI`
                  : t`VS Code`
  /** U7: il motivo del salto, nella lingua dell'interfaccia */
  const skipReason = (r: ImportSkipRow['reason']): string =>
    r === 'env-in-command' ? t`comando con una variabile non risolta`
      : r === 'env-in-url' ? t`indirizzo con una variabile non risolta`
        : r === 'header-var' ? t`header con una variabile non risolta`
          : t`formato non capito`
  const allRows = groups.flatMap((g) => g.rows)
  const n = allRows.filter((r) => !r.existing && picks[importRowKey(r)] === true).length
  return (
    <div className="space-y-3 rounded-2xl bg-muted p-4" data-testid="mcp-import-list">
      {groups.map((g) => (
        <section key={g.source} data-testid={`mcp-import-group-${g.source}`} className="space-y-2">
          <header className="flex items-center gap-2 pt-1">
            {/* niente logo ufficiale nel repo: l'iniziale in un cerchio */}
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-card text-[11px] font-medium text-muted-foreground" aria-hidden="true">
              {label(g.source).slice(0, 1)}
            </span>
            <span className="shrink-0 text-[13px] font-medium">{label(g.source)}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={g.sourcePath}>{g.sourcePath}</span>
          </header>
          {g.rows.map((r) => (
            <label key={importRowKey(r)} data-testid="mcp-import-row" className={`flex min-h-11 items-center gap-2.5 rounded-xl bg-card/70 px-3 ${r.existing ? 'opacity-60' : ''}`}>
              <input
                type="checkbox"
                className="shrink-0"
                data-testid="mcp-import-check"
                checked={picks[importRowKey(r)] === true}
                disabled={r.existing}
                onChange={(e) => onPicks({ ...picks, [importRowKey(r)]: e.target.checked })}
              />
              {r.transport === 'stdio'
                ? <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                : <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{r.name}</span>
                <span className="block truncate text-xs text-muted-foreground" title={r.detail}>{r.detail}</span>
              </span>
              {r.alsoIn.length > 0 && (
                <span className="shrink-0 text-[11px] text-muted-foreground" data-testid="mcp-import-also">
                  {t`anche in ${r.alsoIn.map(label).join(', ')}`}
                </span>
              )}
              {r.secretCount > 0 && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" data-testid="mcp-import-secrets">
                  <KeyRound className="size-3.5" aria-hidden="true" />
                  <Plural value={r.secretCount} one="# segreto" other="# segreti" />
                </span>
              )}
              {r.existing && <span className="shrink-0 text-[11px] text-muted-foreground">{t`già collegato`}</span>}
            </label>
          ))}
          {/* U7: le voci col formato non capito, SALTATE col motivo (senza casella) */}
          {skipped.filter((k) => k.source === g.source).map((k) => (
            <p key={`skip:${k.source}:${k.name}`} data-testid="mcp-import-skipped" className="min-h-6 rounded-xl px-3 py-1 text-[11px] text-muted-foreground/70">
              {k.name} — {t`non importato`}: {skipReason(k.reason)}
            </p>
          ))}
        </section>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <Plural value={n} one="# selezionato" other="# selezionati" />
        </span>
        <button className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={onCancel}><Trans>Annulla</Trans></button>
        <button
          className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
          disabled={n === 0}
          data-testid="mcp-import-apply"
          onClick={onImport}
        >
          {t`Importa ${n}`}
        </button>
      </div>
    </div>
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
  // E2 (fase mcp-env): l'import da Cursor/Claude/ZCode — la scansione parte
  // SOLO al clic del bottone (i file si leggono nel main, solo allora).
  // U2 (fase mcp-ui): l'elenco è RAGGRUPPATO per origine (ImportList)
  const [importRows, setImportRows] = useState<ImportScanRow[] | null>(null)
  // U7: le voci saltate col motivo (collegato all'elenco)
  const [importSkipped, setImportSkipped] = useState<ImportSkipRow[]>([])
  const [importPicks, setImportPicks] = useState<Record<string, boolean>>({})

  const refresh = async () => {
    setServers(await api.mcpList())
  }
  useEffect(() => { void refresh() }, [])

  /**
   * U5 (fase mcp-ui): il test di connessione di un server — parte da solo
   * dopo ogni import/aggiunta/modifica e anche dal bottone icona (U1); la
   * riga mostra il pallino «in corso» finché non risponde.
   */
  const runTest = async (id: string) => {
    setTests((p) => ({ ...p, [id]: { ok: true, pending: true } }))
    const r = await api.mcpTest(id).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    setTests((p) => ({ ...p, [id]: r as { ok: boolean; error?: string; tools?: string[] } }))
  }

  /**
   * U2: la conferma dell'import — le voci SPISTATE diventano server manuali
   * (i doppioni non si sovrascrivono, i segreti vanno cifrati nel main).
   * U5: ogni server CREATO riceve subito il test di connessione (il pallino
   * della riga, verde «N strumenti» o rosso con l'errore).
   */
  const applyImport = async (): Promise<Array<{ name: string; outcome: string }>> => {
    if (!importRows) return []
    const groups = groupImportRows(importRows, servers.map((s) => s.name))
    const picks = groups
      .flatMap((g) => g.rows)
      .filter((r) => !r.existing && importPicks[importRowKey(r)] === true)
      .map((r) => ({ source: r.source, name: r.name }))
    const outcomes = await api.mcpImportApply(picks).catch(() => [] as Array<{ name: string; outcome: string }>)
    setImportRows(null)
    setImportPicks({})
    const list = await api.mcpList().catch(() => servers)
    setServers(list)
    for (const o of outcomes) {
      if (o.outcome !== 'created') continue
      const created = list.find((s) => s.name === o.name)
      // U7: i server «da compilare» (needsAuth) non si testano: aspettano i
      // valori dell'utente (lo stesso vale per la nota del daemon)
      if (created && !created.needsAuth) void runTest(created.id)
    }
    return outcomes
  }

  return (
    <div className="space-y-3">
      <strong className="block font-display text-lg"><Trans>Server MCP personalizzato</Trans></strong>
      <p className="text-xs text-muted-foreground"><Trans>Server MCP manuali (stdio o HTTP, con header/bearer salvati cifrati).</Trans></p>
      {servers.map((s) => (
        <div key={s.id} data-testid="mcp-server-row" className="rounded-2xl bg-muted px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${s.enabled ? 'bg-chart-2' : 'bg-muted-foreground/40'}`} />
            <span className="shrink-0 text-sm">{s.name}</span>
            <span className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{s.transport}</span>
            {/* U7: le variabili riferite importate «da compilare» */}
            {s.needsAuth && (
              <span className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground" data-testid="mcp-needs-fill">{t`da compilare`}</span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</span>
            {/* U1: il risultato del test come PALLINO nella riga (U5: parte da solo) */}
            {tests[s.id] && <RowTestStatus test={tests[s.id]!} />}
            {/* U1: test, modifica ed elimina come ICONE (niente testo visibile) */}
            <IconButton label={t`Test della connessione`} testid="mcp-test-button" onClick={() => { void runTest(s.id) }}>
              <PlugZap className="size-4" />
            </IconButton>
            <IconButton label={t`Modifica il server`} testid="mcp-edit-button" onClick={() => { setEdit(s); setEditBearer(''); setEnvRows(envRowsFromServer(s)) }}>
              <Pencil className="size-4" />
            </IconButton>
            <IconButton label={t`Elimina il server`} testid="mcp-delete-button" danger onClick={async () => { await api.mcpDelete(s.id); await refresh() }}>
              <Trash2 className="size-4" />
            </IconButton>
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
                        className="grid size-6 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-destructive"
                        aria-label={t`Togli la variabile`}
                        title={t`Togli la variabile`}
                        data-testid="mcp-env-remove"
                        onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}
                      >
                        <X className="size-3.5" />
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
                const id = edit.id || 'mcp_' + Date.now()
                await api.mcpSave({ ...withEnv, id }, secret)
                setEdit(null); setEditBearer(''); setEnvRows([])
                await refresh()
                // U5: dopo l'aggiunta (o la modifica) il test parte da solo
                // (U7: mai per i server «da compilare»)
                if (edit.enabled && !edit.needsAuth) void runTest(id)
              }}
            >
              <Trans>Salva</Trans>
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <button className="w-full rounded-2xl bg-muted px-3 py-2.5 text-sm text-muted-foreground transition hover:text-foreground" onClick={() => { setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true }); setEditBearer(''); setEnvRows([newEnvRow()]) }}>
            <Trans>+ Aggiungi server MCP</Trans>
          </button>
          {/* E2 (fase mcp-env): i file di Cursor/Claude/ZCode si leggono SOLO
              al clic di questo bottone, nel main; l'elenco che torna non ha
              MAI valori segreti e niente è spuntato di default */}
          <button
            className="w-full rounded-2xl bg-muted px-3 py-2.5 text-sm text-muted-foreground transition hover:text-foreground"
            data-testid="mcp-import-button"
            onClick={async () => {
              const scan = await api.mcpImportScan().catch(() => ({ rows: [] as ImportScanRow[], skipped: [] as ImportSkipRow[] }))
              setImportRows(scan.rows as ImportScanRow[])
              setImportSkipped((scan.skipped ?? []) as ImportSkipRow[])
              setImportPicks({})
            }}
          >
            <Trans>Importa da altre app</Trans>
          </button>
          {importRows && (
            importRows.length === 0 ? (
              <div className="rounded-2xl bg-muted p-4" data-testid="mcp-import-list">
                <p className="text-xs text-muted-foreground"><Trans>Nessun server trovato nelle altre app.</Trans></p>
              </div>
            ) : (
              <ImportList
                groups={groupImportRows(importRows, servers.map((s) => s.name))}
                skipped={importSkipped}
                picks={importPicks}
                onPicks={setImportPicks}
                onCancel={() => { setImportRows(null); setImportPicks({}) }}
                onImport={() => { void applyImport() }}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}
