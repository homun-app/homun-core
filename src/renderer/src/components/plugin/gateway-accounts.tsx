// C0 (fase linguaggio): pezzo di AppsWindow.tsx (smontato: non era più una
// finestra, nessuno la montava) — un file per cosa in components/plugin/.
// CA2 (fase composio-account): gli account di un'app Composio collegata nel
// dettaglio — una riga per account (alias, email in grigio, «Da ricollegare»
// per i non attivi) con «Rinomina» e «Togli» (con conferma), e sotto
// «Aggiungi un altro account». DS4: a filo come il resto della scheda (PP4).
import { useState, type ReactNode } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { Plus } from 'lucide-react'
import { api, useStore } from '../../store'
import { i18n } from '../../lib/i18n'
import type { ComposioGatewayAppInfo } from '../../../../shared/types'
import { gatewayAccountRows, accountLimitMessage } from '../../lib/apps-view'
import { FlatList, FlatRow } from '../ui/flat-list'
import { Button } from '../ui/button'

/** La lingua attiva come UiLanguage. */
function uiLang(): 'it' | 'en' {
  return i18n.locale === 'en' ? 'en' : 'it'
}

export function GatewayAccountsSection({ app, appName, onChanged }: {
  app: ComposioGatewayAppInfo
  appName: string
  onChanged(): void
}): ReactNode {
  const { t } = useLingui()
  const rows = gatewayAccountRows(app)
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [limitCount, setLimitCount] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [addAlias, setAddAlias] = useState('')

  if (rows.length === 0) return null

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; accountCount?: number }>): Promise<void> => {
    setBusy(true)
    setError('')
    setLimitCount(null)
    try {
      const r = await fn()
      if (!r.ok) {
        if (r.error === 'account-limit') setLimitCount(r.accountCount ?? 5)
        else setError(r.error ?? 'error')
      } else {
        onChanged()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Il campo di un nome scritto sul posto (rinomina, aggiunta): 32 px, sta in una riga. */
  const nameField = 'h-control-sm w-40 rounded-control bg-card px-2 text-body outline-none placeholder:text-muted-foreground'
  const togli = 'text-destructive hover:text-destructive'

  return (
    <div className="flex flex-col gap-block" data-testid="app-accounts">
      <FlatList>
        {rows.map((row) => (
          <div key={row.key} data-testid={`app-account-${row.key}`}>
            <FlatRow
              title={row.alias}
              subtitle={row.reconnect
                ? <>{row.email ? <>{row.email}{' · '}</> : null}<Trans>Da ricollegare</Trans></>
                : row.email}
              trailing={renaming?.key === row.key ? (
                <>
                  <input
                    autoFocus
                    className={nameField}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ key: row.key, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renaming.value.trim() && !busy) {
                        void run(() => api.composioGatewayRenameAccount(app.slug, row.key, renaming.value))
                        setRenaming(null)
                      }
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                  />
                  <Button
                    size="sm"
                    disabled={busy || !renaming.value.trim()}
                    onClick={() => {
                      void run(() => api.composioGatewayRenameAccount(app.slug, row.key, renaming.value))
                      setRenaming(null)
                    }}
                  >
                    <Trans>Salva</Trans>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                    <Trans>Annulla</Trans>
                  </Button>
                </>
              ) : removing === row.key ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={togli}
                    disabled={busy}
                    onClick={() => {
                      void run(() => api.composioGatewayRemoveAccount(app.slug, row.key))
                      setRemoving(null)
                    }}
                  >
                    <Trans>Togli davvero</Trans>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                    <Trans>Annulla</Trans>
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenaming({ key: row.key, value: row.alias })}>
                    <Trans>Rinomina</Trans>
                  </Button>
                  <Button variant="ghost" size="sm" className={togli} disabled={busy} onClick={() => setRemoving(row.key)}>
                    <Trans>Togli</Trans>
                  </Button>
                </>
              )}
            />
          </div>
        ))}
        {/* CA2: «Aggiungi un altro account» — nome facoltativo, login come oggi.
            La riga è un bottone: 40 px (riga di solo testo), con l'icona al
            posto del «+» scritto a mano */}
        {adding ? (
          <div className="flex items-center gap-2 py-row-pad">
            <input
              autoFocus
              className={nameField}
              placeholder={t`lavoro, personale…`}
              value={addAlias}
              onChange={(e) => setAddAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAdding(false); setAddAlias('') }
              }}
            />
            {/* i bottoni alla misura del campo (32): la riga sta in piedi, tutta sulla stessa linea */}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void run(() => api.composioGatewayConnect(app.slug, appName, { another: true, alias: addAlias }))
                setAdding(false)
                setAddAlias('')
              }}
            >
              <Trans>Collega</Trans>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setAddAlias('') }}>
              <Trans>Annulla</Trans>
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="flex min-h-row-text w-full cursor-pointer items-center gap-row-gap py-row-pad text-body text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => setAdding(true)}
            data-testid="app-add-account"
          >
            <span className="grid size-8 shrink-0 place-items-center" aria-hidden="true"><Plus className="size-4" /></span>
            <Trans>Aggiungi un altro account</Trans>
          </button>
        )}
      </FlatList>
      {limitCount !== null && (
        <p className="text-small text-muted-foreground" data-testid="app-account-limit">{accountLimitMessage(limitCount, appName, uiLang())}</p>
      )}
      {error && <p className="text-small text-destructive">{error}</p>}
    </div>
  )
}
