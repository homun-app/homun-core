// PL7 (fase plugin): i PEZZI della vecchia finestra «Server MCP» — la
// finestra non esiste più (la casa è la pagina «Plugin»): qui resta
// ManualServers (l'elenco dei server col test, il form stdio/http con le
// variabili e l'import); l'elenco di import è in plugin/import-list.tsx.
//
// Fase design (DS4): ai token, nella vista «Server MCP» della pagina.
//  - I SERVER sono righe a filo come quelle di «I tuoi» (FlatRow): prima ogni
//    server era un riquadro tondo col suo fondo, con il nome, il comando, le
//    variabili e i bot su righe scritte a mano. Ora: logo 32 (o l'iniziale),
//    il nome, e SOTTO le righe grigie (comando, variabili, bot) — la stessa
//    casa della lista, così un server si riconosce in tutta la pagina.
//  - LE AZIONI per riga restano ICONE (U1: nessun testo visibile, il nome
//    accessibile) e sono Button ghost solo-icona: 32 px, tondi. Erano scritte
//    qui a mano, 28 px, con un raggio loro.
//  - I CAMPI sono alti 36 col raggio dei controlli (erano più bassi, e col
//    testo più piccolo di quello dell'interfaccia); i bottoni sono Button.
//  - IL BADGE del tipo di server non è più in maiuscoletto (DS1: nessun
//    maiuscoletto): «stdio», «http», nel testo dei badge.
//  - L'IMPORT è un pannello (racchiude ciò che è stato TROVATO e si sceglie)
//    con gruppi a filo: il logo dell'app a 32, poi le righe.
import { useEffect, useState } from 'react'
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { PlugZap, Pencil, Trash2, X } from 'lucide-react'
import { api, useStore } from '../store'
import type { McpServerInfo, McpServerSecret } from '../../../shared/types'
import { serverCommandLine } from '../lib/mcp-row'
import { cn } from '../lib/utils'
// E1 (fase mcp-env): le righe «Variabili» del form stdio
import { envRowsFromServer, saveEnvPayload, newEnvRow, envNameLooksSecret, type EnvRow } from '../lib/mcp-env'
// U2 (fase mcp-ui): l'elenco di import raggruppato per origine
import { groupImportRows, importRowKey, type ImportGroupUi, type ImportScanRow, type ImportSkipRow, type ImportSource } from '../lib/mcp-import-groups'
// K4 (fase team-bot): il logo VERO dell'app quando il file c'è nel repo
import { logoUrlForName, LOGO_CLASS, LOGO_TILE_CLASS } from '../lib/app-logos'
// X2 (fase sicurezza-beta16): l'errore del test si mostra tagliato a 300
import { clipErrorText } from '../../../main/mcp/error-category'
// C0 (fase linguaggio): l'elenco di import in un file suo, sempre di plugin/
import { ImportList } from './plugin/import-list'
import { FlatList, FlatRow } from './ui/flat-list'
import { Section } from './ui/section'
import { Button } from './ui/button'

/**
 * Il campo di testo del form di un server (DS1): 36 px — la misura dei campi
 * — col raggio dei controlli e il testo di riga. Sta sui pannelli tenui del
 * form, dunque sul fondo della scheda; dentro il pannello delle variabili
 * (che è già chiaro) si dice bg-muted.
 */
const FIELD = 'h-control min-w-0 rounded-control bg-card px-3 text-body outline-none placeholder:text-muted-foreground'

/**
 * U1 (fase mcp-ui): il bottone ICONA delle azioni per riga — grigio, più
 * scuro al passaggio (elimina: rosso). NESSUN testo visibile: l'etichetta
 * tradotta sta in aria-label e title (l'accessibilità resta).
 * Fase design (DS4): è un Button ghost solo-icona — tondo, 32 px, il
 * controllo piccolo di righe e fasce. Il colore lo porta la variante ghost.
 */
function IconButton({ label, danger, testid, onClick, children }: {
  label: string
  danger?: boolean
  testid?: string
  onClick(): void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon
      aria-label={label}
      title={label}
      {...(testid ? { 'data-testid': testid } : {})}
      className={danger ? 'hover:text-destructive' : undefined}
      onClick={onClick}
    >
      {children}
    </Button>
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
  // X2 (fase sicurezza-beta16): l'errore completo resta SOLO qui nella UI,
  // tagliato a 300 e come testo — mai al bot, mai HTML
  const error = test.error ? clipErrorText(test.error) : ''
  const tip = test.pending ? t`test in corso…` : test.ok ? t`${n} strumenti: ${(test.tools ?? []).join(', ')}` : error
  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1.5"
      data-testid="mcp-row-status"
      title={tip}
    >
      <span className={`size-2 shrink-0 rounded-full ${test.pending ? 'bg-muted-foreground/50' : test.ok ? 'bg-chart-2' : 'bg-destructive'}`} />
      {!test.pending && (
        <span className={`max-w-48 truncate text-small ${test.ok ? 'text-chart-2' : 'text-destructive'}`}>
          {test.ok ? <Plural value={n} one="# strumento" other="# strumenti" /> : error}
        </span>
      )}
    </span>
  )
}

export function ManualServers() {
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
   * U2: la conferma dell'import — le voci SPIATE diventano server manuali
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
    <Section size="body" title={<Trans>Server MCP personalizzato</Trans>}>
      <p className="text-small text-muted-foreground"><Trans>Server MCP manuali (stdio o HTTP, con header/bearer salvati cifrati).</Trans></p>
      {servers.length > 0 && (
        <FlatList>
          {servers.map((s) => (
            <FlatRow
              key={s.id}
              testId="mcp-server-row"
              leading={logoUrlForName(s.name)
                // K4: il logo dell'app quando c'è (per nome: «Mattermost»); se manca, l'iniziale sulla piastrella tenue
                ? <img src={logoUrlForName(s.name)!} alt="" data-testid="mcp-server-logo" className={`${LOGO_CLASS} size-8`} />
                : <span className={`grid size-8 place-items-center ${LOGO_TILE_CLASS} text-body`} aria-hidden="true">{s.name.slice(0, 1).toUpperCase()}</span>}
              title={(
                <span className="flex items-center gap-2">
                  {/* acceso o spento: il pallino davanti al nome */}
                  <span className={`size-2 shrink-0 rounded-full ${s.enabled ? 'bg-chart-2' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">{s.transport}</span>
                  {/* U7: le variabili riferite importate «da compilare» */}
                  {s.needsAuth && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground" data-testid="mcp-needs-fill">{t`da compilare`}</span>
                  )}
                </span>
              )}
              subtitle={(
                <>
                  <span className="block truncate" data-testid="mcp-row-command">{serverCommandLine(s)}</span>
                  {/* E1 (fase mcp-env): i NOMI delle variabili del server stdio — i
                      valori segreti mai, solo •••• */}
                  {(s.envSpec?.length ?? 0) > 0 && (
                    <span className="block truncate" data-testid="mcp-env-names">
                      {s.envSpec!.map((v) => `${v.name} = ${v.secret ? '••••' : (s.envValues?.[v.name] ?? '')}`).join(', ')}
                    </span>
                  )}
                  {/* M2: da quali bot è usato, quando il dato esiste già (enabledFor) */}
                  {s.enabledFor && (
                    <span className="block truncate">
                      {s.enabledFor.includes('*') ? t`usato da tutti i bot`
                        : t`usato da: ${s.enabledFor.map((id) => agents.find((a) => a.id === id)?.name ?? id).join(', ')}`}
                    </span>
                  )}
                </>
              )}
              trailing={(
                <>
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
                </>
              )}
            />
          ))}
        </FlatList>
      )}
      {edit ? (
        <div className="flex flex-col gap-3 rounded-surface bg-muted p-4">
          <div className="grid grid-cols-2 gap-3">
            <input className={FIELD} placeholder={t`Nome (es. weather)`} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <select className={FIELD} value={edit.transport} onChange={(e) => setEdit({ ...edit, transport: e.target.value as 'stdio' | 'http' })}>
              <option value="stdio">{t`stdio (comando locale)`}</option>
              <option value="http">{t`http (URL)`}</option>
            </select>
          </div>
          {edit.transport === 'stdio' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <input className={FIELD} placeholder={t`Comando (es. node)`} value={edit.command ?? ''} onChange={(e) => setEdit({ ...edit, command: e.target.value })} />
                <input className={FIELD} placeholder={t`Argomenti separati per spazio`} value={(edit.args ?? []).join(' ')} onChange={(e) => setEdit({ ...edit, args: e.target.value ? e.target.value.split(/\s+/) : [] })} />
              </div>
              {/* E1 (fase mcp-env): le VARIABILI del server — righe nome = valore
                  con interruttore «segreto»; i segreti si salvano CIFRATI e in
                  modifica si sostituiscono, non si leggono */}
              <div className="rounded-surface bg-card p-3">
                <div className="flex items-center justify-between">
                  <span className="text-body font-medium"><Trans>Variabili</Trans></span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mr-3"
                    data-testid="mcp-env-add"
                    onClick={() => setEnvRows((rows) => [...rows, newEnvRow()])}
                  >
                    <Trans>+ Variabile</Trans>
                  </Button>
                </div>
                <div data-testid="mcp-env-rows" className="mt-2 flex flex-col gap-2">
                  {envRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        className={`${FIELD} w-2/5 bg-muted`}
                        placeholder={t`Nome (es. MATTERMOST_URL)`}
                        value={row.name}
                        onChange={(e) => {
                          const name = e.target.value
                          setEnvRows((rows) => rows.map((r, j) => j === i ? { ...r, name, secret: name ? envNameLooksSecret(name) : r.secret } : r))
                        }}
                      />
                      <span className="text-small text-muted-foreground">=</span>
                      <input
                        className={cn(FIELD, 'min-w-0 flex-1 bg-muted')}
                        type={row.secret ? 'password' : 'text'}
                        placeholder={row.secret && row.saved ? t`salvato cifrato — scrivi per sostituire` : t`Valore`}
                        value={row.value}
                        onChange={(e) => setEnvRows((rows) => rows.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                      />
                      <label className="flex shrink-0 items-center gap-1 text-small text-muted-foreground" title={t`Segreto (salvato cifrato)`}>
                        <input
                          type="checkbox"
                          className="shrink-0 accent-foreground"
                          data-testid="mcp-env-secret"
                          checked={row.secret}
                          onChange={(e) => setEnvRows((rows) => rows.map((r, j) => j === i ? { ...r, secret: e.target.checked } : r))}
                        />
                        <Trans>segreto</Trans>
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon
                        className="-mr-2 hover:text-destructive"
                        aria-label={t`Togli la variabile`}
                        title={t`Togli la variabile`}
                        data-testid="mcp-env-remove"
                        onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-small text-muted-foreground">
                  <Trans>Arrivano al comando come variabili d'ambiente. Quelle segrete si salvano cifrate: nell'elenco si vedono solo i nomi.</Trans>
                </p>
              </div>
            </>
          ) : (
            <>
              <input className={`${FIELD} w-full`} placeholder={t`URL (es. http://localhost:3001/mcp)`} value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              <input
                className={`${FIELD} w-full`}
                type="password"
                placeholder={t`Bearer token (opzionale — salvato cifrato)`}
                value={editBearer}
                onChange={(e) => setEditBearer(e.target.value)}
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEdit(null)}><Trans>Annulla</Trans></Button>
            <Button
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
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-block">
          {/* aggiungere un server è l'azione di questa vista; l'import è la seconda strada */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => { setEdit({ id: '', name: '', transport: 'stdio', command: '', args: [], enabled: true }); setEditBearer(''); setEnvRows([newEnvRow()]) }}>
              <Trans>+ Aggiungi server MCP</Trans>
            </Button>
            {/* E2 (fase mcp-env): i file di Cursor/Claude/ZCode si leggono SOLO
                al clic di questo bottone, nel main; l'elenco che torna non ha
                MAI valori segreti e niente è spuntato di default */}
            <Button
              variant="secondary"
              data-testid="mcp-import-button"
              onClick={async () => {
                const scan = await api.mcpImportScan().catch(() => ({ rows: [] as ImportScanRow[], skipped: [] as ImportSkipRow[] }))
                setImportRows(scan.rows as ImportScanRow[])
                setImportSkipped((scan.skipped ?? []) as ImportSkipRow[])
                setImportPicks({})
              }}
            >
              <Trans>Importa da altre app</Trans>
            </Button>
          </div>
          {importRows && (
            importRows.length === 0 ? (
              <div className="rounded-surface bg-muted p-4" data-testid="mcp-import-list">
                <p className="text-small text-muted-foreground"><Trans>Nessun server trovato nelle altre app.</Trans></p>
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
    </Section>
  )
}
