// C0 (fase linguaggio): l'elenco di import dei server MCP dalle altre app
// (Cursor, Claude, Zcode, Claude Code, Codex, Windsurf, Gemini CLI, VS Code),
// estratto da McpWindow.tsx in un file suo — la pagina Plugin lo usa attraverso
// ManualServers (components/plugin/manual-servers.tsx), e l'export smette di
// servire solo ai test. U2: raggruppato per origine con intestazione (logo
// dell'app, nome, percorso in grigio), caselle da spuntare (nessuna di
// default), i doppioni «già collegati» disattivati, il conteggio dei segreti
// senza MAI i valori, le voci saltate col motivo e il fondo «N selezionati /
// Annulla / Importa N». K4: il logo della FONTE quando il file c'è nel repo.
import { useLingui, Trans, Plural } from '@lingui/react/macro'
import { Terminal, Globe, KeyRound } from 'lucide-react'
import { importRowKey, type ImportGroupUi, type ImportSkipRow, type ImportSource } from '../../lib/mcp-import-groups'
// K4 (fase team-bot): il logo VERO dell'app quando il file c'è nel repo
import { logoUrlForName, LOGO_CLASS, LOGO_TILE_CLASS } from '../../lib/app-logos'
import { FlatList } from '../ui/flat-list'
import { Button } from '../ui/button'

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
  // U7: le otto app (i nomi propri non si traducono, il resto sì)
  const label = (s: ImportSource): string =>
    s === 'cursor' ? t`Cursor`
      : s === 'claude' ? t`Claude Desktop`
        : s === 'zcode' ? t`ZCode`
          : s === 'claude-code' ? t`Claude Code`
            : s === 'codex' ? t`Codex`
              : s === 'windsurf' ? t`Windsurf`
                : s === 'gemini' ? t`Gemini CLI`
                  : t`VS Code`
  // K4 (fase team-bot): il logo della FONTE quando il file c'è nel repo
  // (oggi solo Gemini CLI → gemini.svg; le altre restano con l'iniziale)
  const SOURCE_LOGO: Partial<Record<ImportSource, string>> = { gemini: 'gemini' }
  /** U7: il motivo del salto, nella lingua dell'interfaccia */
  const skipReason = (r: ImportSkipRow['reason']): string =>
    r === 'env-in-command' ? t`comando con una variabile non risolta`
      : r === 'env-in-url' ? t`indirizzo con una variabile non risolta`
        : r === 'header-var' ? t`header con una variabile non risolta`
          : t`formato non capito`
  const allRows = groups.flatMap((g) => g.rows)
  const n = allRows.filter((r) => !r.existing && picks[importRowKey(r)] === true).length
  return (
    <div className="flex flex-col gap-3 rounded-surface bg-muted p-4" data-testid="mcp-import-list">
      {groups.map((g) => (
        <section key={g.source} data-testid={`mcp-import-group-${g.source}`} className="flex flex-col gap-2">
          {/* la testa del gruppo: il logo dell'app (32, come i loghi delle righe) o l'iniziale, il nome, il percorso in grigio */}
          <header className="flex items-center gap-row-gap py-1">
            {logoUrlForName(SOURCE_LOGO[g.source] ?? null)
              ? <img src={logoUrlForName(SOURCE_LOGO[g.source] ?? null)!} alt="" data-testid="mcp-import-source-logo" className={`${LOGO_CLASS} size-8`} />
              : <span className={`grid size-8 place-items-center ${LOGO_TILE_CLASS} text-body`} aria-hidden="true">
                  {label(g.source).slice(0, 1)}
                </span>}
            <span className="shrink-0 text-body font-medium">{label(g.source)}</span>
            <span className="min-w-0 flex-1 truncate text-small text-muted-foreground" title={g.sourcePath}>{g.sourcePath}</span>
          </header>
          <FlatList>
            {g.rows.map((r) => (
              // la riga È l'etichetta della casella: un clic ovunque la spunta
              <label key={importRowKey(r)} data-testid="mcp-import-row" className={`flex min-h-row cursor-pointer items-center gap-row-gap py-row-pad ${r.existing ? 'opacity-60' : ''}`}>
                {/* la casa da 32 tiene casella e tipo di server (comando locale o indirizzo): il testo della riga
                    comincia dove comincia il nome del gruppo, sotto il suo logo */}
                <span className="flex size-8 shrink-0 items-center justify-between">
                  <input
                    type="checkbox"
                    className="shrink-0 accent-foreground"
                    data-testid="mcp-import-check"
                    checked={picks[importRowKey(r)] === true}
                    disabled={r.existing}
                    onChange={(e) => onPicks({ ...picks, [importRowKey(r)]: e.target.checked })}
                  />
                  {r.transport === 'stdio'
                    ? <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    : <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">{r.name}</span>
                  <span className="mt-0.5 block truncate text-small text-muted-foreground" title={r.detail}>{r.detail}</span>
                </span>
                {r.alsoIn.length > 0 && (
                  <span className="shrink-0 text-small text-muted-foreground" data-testid="mcp-import-also">
                    {t`anche in ${r.alsoIn.map(label).join(', ')}`}
                  </span>
                )}
                {r.secretCount > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-small text-muted-foreground" data-testid="mcp-import-secrets">
                    <KeyRound className="size-4 shrink-0" aria-hidden="true" />
                    <Plural value={r.secretCount} one="# segreto" other="# segreti" />
                  </span>
                )}
                {r.existing && <span className="shrink-0 text-small text-muted-foreground">{t`già collegato`}</span>}
              </label>
            ))}
            {/* U7: le voci col formato non capito, SALTATE col motivo (senza casella) */}
            {skipped.filter((k) => k.source === g.source).map((k) => (
              <p key={`skip:${k.source}:${k.name}`} data-testid="mcp-import-skipped" className="py-2 text-small text-muted-foreground">
                {k.name} — {t`non importato`}: {skipReason(k.reason)}
              </p>
            ))}
          </FlatList>
        </section>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">
          <Plural value={n} one="# selezionato" other="# selezionati" />
        </span>
        <Button variant="ghost" onClick={onCancel}><Trans>Annulla</Trans></Button>
        <Button
          disabled={n === 0}
          data-testid="mcp-import-apply"
          onClick={onImport}
        >
          {t`Importa ${n}`}
        </Button>
      </div>
    </div>
  )
}
