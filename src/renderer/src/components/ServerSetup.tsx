// Fase mcp-setup (M3): IL modulo di configurazione di un server MCP — uno
// solo, usato dalla card in chat (M4) e dal foglio della finestra App (M6),
// nello stile delle Impostazioni (SettingsGroup/SettingsRow/SettingsAdvanced).
// Le variabili OBBLIGATORIE non segrete sono righe di campo; l'accesso segue
// `auth`: OAuth di default col bottone «Accedi con <Nome>» (il token sta
// sotto «Avanzate», facoltativo), il token SUBITO quando l'header è
// obbligatorio. L'utente scrive SOLO il valore della variabile: «Bearer » lo
// mette il template del registro. I segreti non tornano mai all'interfaccia:
// un token salvato si mostra «•••• salvato · cambia».
import { useEffect, useMemo, useState } from 'react'
import { useLingui, Trans } from '@lingui/react/macro'
import { api } from '../store'
import type { McpServerConnectResult, McpServerSetupSpec } from '../../../shared/types'
import { hostValueError, varLabel, setupCanConnect } from '../../../shared/registry-vars'
import { SettingsAdvanced } from './settings/SettingsAdvanced'
import { SettingsGroup } from './settings/SettingsGroup'
import { SettingsRow } from './settings/SettingsRow'

/** L'etichetta di una variabile, tradotta (varLabel decide la forma). */
function FieldLabel({ name, serverName }: { name: string; serverName: string }): React.ReactNode {
  const { t } = useLingui()
  const label = varLabel(name, serverName)
  return 'addressOf' in label ? t`Indirizzo del server ${label.addressOf}` : label.plain
}

/** L'errore di validazione accanto al campo (M1.4), nella lingua attiva. */
function FieldError({ code }: { code: string }): React.ReactNode {
  if (code === 'empty' || code === 'vuoto') return <Trans>Inserisci un valore</Trans>
  if (code === '/') return <Trans>Niente «/»: serve il solo indirizzo, non un percorso</Trans>
  if (code === '@') return <Trans>Niente «@»: serve l'indirizzo del server, non un account</Trans>
  if (code === 'spazi') return <Trans>Niente spazi nell'indirizzo</Trans>
  return <Trans>Non valido</Trans>
}

/** L'esito sotto il pulsante (M3.3): la prova, il successo o l'errore umano. */
export function ConnectOutcome({ state, result }: { state: 'idle' | 'connecting' | 'ok' | 'error'; result: McpServerConnectResult | null }): React.ReactNode {
  const { t } = useLingui()
  if (state === 'connecting') return <p className="text-[13px] text-muted-foreground" data-testid="setup-connecting"><Trans>Provo a collegarmi…</Trans></p>
  if (state === 'ok') {
    return (
      <p className="text-[13px] text-chart-2" data-testid="setup-connected">
        {t`✓ Collegato · ${(result?.tools ?? []).length} strumenti`}
      </p>
    )
  }
  if (state === 'error' && result) {
    const reason = result.reason
    return (
      <div className="space-y-0.5" data-testid="setup-error">
        <p className="text-[13px] text-destructive">
          {reason === 'unreachable' ? <Trans>L'indirizzo non risponde: controllalo e riprova.</Trans>
            : reason === 'unauthorized' ? <Trans>Accesso rifiutato: il token non è valido.</Trans>
            : reason === 'not-mcp' ? <Trans>Questo non sembra un server MCP: controlla l'indirizzo.</Trans>
            : reason === 'oauth' ? <Trans>Questo server non permette l'accesso dal browser: usa un token di accesso.</Trans>
            : reason === 'needs-window' ? <Trans>Apri la finestra dell'app per autorizzare.</Trans>
            : reason === 'invalid-value' ? <Trans>Alcuni valori non vanno bene: correggili e riprova.</Trans>
            : <Trans>Non riesco a collegarmi: riprova.</Trans>}
        </p>
        {reason !== 'oauth' && reason !== 'invalid-value' && result.error && (
          <p className="text-[11px] text-muted-foreground">{result.error}</p>
        )}
      </div>
    )
  }
  return null
}

/** Un token salvato si mostra così: MAI il valore, solo «salvato · cambia». */
function SavedToken({ onChange }: { onChange(): void }): React.ReactNode {
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Trans>•••• salvato</Trans>
      <button type="button" className="underline underline-offset-2 transition hover:text-foreground" onClick={onChange}>
        <Trans>cambia</Trans>
      </button>
    </span>
  )
}

/** Il campo password del token (sotto Avanzate o subito, secondo auth). */
function TokenField({ spec, token, setToken }: { spec: McpServerSetupSpec; token: string; setToken(v: string): void }): React.ReactNode {
  const { t } = useLingui()
  const h = spec.tokenHeader
  if (!h) return null
  const desc = h.variableDescription ?? h.description
  return (
    <label className="block min-w-0">
      <span className="sr-only">{t`Token di accesso (facoltativo)`}</span>
      <input
        type="password"
        autoComplete="off"
        data-testid={`setup-token-${h.name.toLowerCase()}`}
        className="h-9 w-full rounded-[10px] bg-card px-2.5 text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-64"
        placeholder={t`Token di accesso (facoltativo)`}
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      {desc && <span className="mt-1 block max-w-md text-[12px] leading-snug text-muted-foreground">{desc}</span>}
    </label>
  )
}

/**
 * ServerSetupModule: il modulo vero. `spec` arriva dalla card (payload
 * costruito in codice) o dal foglio (RPC connectors:server-setup). Al
 * collegamento riuscito chiama onConnected (la card si chiude in una riga,
 * il foglio si aggiorna).
 */
export function ServerSetupModule({ spec, onConnected, testid = 'server-setup' }: {
  spec: McpServerSetupSpec
  onConnected?(r: McpServerConnectResult): void
  testid?: string
}): React.ReactNode {
  const { t } = useLingui()
  // i valori dei campi: i default del registro entrano già compilati
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const f of spec.variables) if (!f.isSecret && f.value) out[f.name] = f.value
    return out
  })
  const [token, setToken] = useState('')
  const [tokenEditing, setTokenEditing] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [state, setState] = useState<'idle' | 'connecting' | 'ok' | 'error'>('idle')
  const [result, setResult] = useState<McpServerConnectResult | null>(null)
  // l'errore di OAuth apre «Avanzate» (M3.3: usa un token di accesso)
  const [advancedForced, setAdvancedForced] = useState(false)
  useEffect(() => {
    if (result?.reason === 'oauth') setAdvancedForced(true)
  }, [result])

  const visibleVars = spec.variables.filter((f) => !f.isSecret || f.isRequired || f.value || f.saved)
  // quando il pulsante è attivo (puro, testato): i campi obbligatori pieni e
  // validi, il token quando è la via obbligatoria
  const tokenRequired = spec.auth === 'headers' && !!spec.tokenHeader && !spec.tokenHeader.saved
  const canConnect = useMemo(
    () => setupCanConnect(spec.variables, values, { tokenRequired, token, tokenSaved: spec.tokenHeader?.saved === true }),
    [spec, values, tokenRequired, token]
  )

  const connect = async (): Promise<void> => {
    // la validazione locale prima di tutto: l'errore accanto al campo
    const errs: Record<string, string> = {}
    for (const f of spec.variables) {
      if (f.isSecret) continue
      const v = (values[f.name] ?? '').trim()
      if (f.isRequired && !v) errs[f.name] = 'empty'
      else if (v && /host|url/i.test(f.name) && hostValueError(v)) errs[f.name] = hostValueError(v)!
    }
    setFieldErrors(errs)
    if (Object.keys(errs).length) {
      setState('error')
      setResult({ ok: false, reason: 'invalid-value', error: 'invalid values' })
      return
    }
    setState('connecting')
    setResult(null)
    try {
      const r = await api.connectorsServerConnect(spec.serverId, { vars: values, ...(token.trim() ? { token: token.trim() } : {}) })
      if (r.ok) {
        setState('ok')
        setResult(r)
        onConnected?.(r)
      } else {
        setState('error')
        setResult(r)
        if (r.fieldErrors) setFieldErrors(r.fieldErrors)
      }
    } catch (e) {
      setState('error')
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const buttonLabel = spec.auth === 'oauth'
    ? t`Accedi con ${spec.name}`
    : t`Collega`

  return (
    <div data-testid={testid} className="space-y-3">
      {visibleVars.length > 0 && (
        <SettingsGroup label={<Trans>Per farlo partire</Trans>}>
          {visibleVars.map((f) => (
            <SettingsRow
              key={f.name}
              title={<FieldLabel name={f.name} serverName={spec.name} />}
              description={f.description}
              control={
                <span className="flex w-full min-w-0 flex-col gap-1 @[420px]:w-64">
                  <input
                    data-testid={`setup-field-${f.name}`}
                    className="h-9 w-full rounded-[10px] bg-card px-2.5 text-sm outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    placeholder={f.placeholder ?? f.name}
                    value={values[f.name] ?? ''}
                    onChange={(e) => {
                      setValues((p) => ({ ...p, [f.name]: e.target.value }))
                      setFieldErrors((p) => ({ ...p, [f.name]: '' }))
                    }}
                    onBlur={(e) => {
                      // l'indirizzo incollato per intero si ripulisce (M1.4)
                      if (/host|url/i.test(f.name) && e.target.value.trim()) {
                        const cleaned = e.target.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
                        setValues((p) => ({ ...p, [f.name]: cleaned }))
                      }
                    }}
                  />
                  {fieldErrors[f.name] ? <span className="text-[12px] text-destructive"><FieldError code={fieldErrors[f.name]} /></span> : null}
                </span>
              }
            />
          ))}
        </SettingsGroup>
      )}

      <SettingsGroup label={<Trans>Accesso</Trans>}>
        {spec.auth === 'env' ? (
          <SettingsRow
            title={<Trans>Variabili d'ambiente</Trans>}
            description={<Trans>Si salvano cifrate sul tuo Mac quando premi Collega.</Trans>}
          />
        ) : spec.auth === 'oauth' ? (
          <SettingsRow
            title={<Trans>Con il tuo account</Trans>}
            description={<Trans>Si apre il browser per accedere: è la via più semplice.</Trans>}
          />
        ) : (
          <SettingsRow
            title={<Trans>Token di accesso</Trans>}
            description={spec.tokenHeader?.variableDescription ?? spec.tokenHeader?.description}
            control={
              spec.tokenHeader?.saved && !tokenEditing
                ? <SavedToken onChange={() => setTokenEditing(true)} />
                : <TokenField spec={spec} token={token} setToken={setToken} />
            }
          />
        )}
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="setup-connect"
              className="rounded-[10px] bg-foreground px-3.5 py-1.5 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
              disabled={!canConnect || state === 'connecting'}
              onClick={() => void connect()}
            >
              {buttonLabel}
            </button>
            <ConnectOutcome state={state} result={result} />
          </div>
          {/* OAuth: il token sta sotto «Avanzate», CHIUSO — un errore di OAuth
              (niente accesso dal browser) lo apre (M3.3) */}
          {spec.auth === 'oauth' && spec.tokenHeader && (
            <SettingsAdvanced key={advancedForced ? 'aperto' : 'chiuso'} defaultOpen={advancedForced}>
              {spec.tokenHeader.saved && !tokenEditing
                ? <SavedToken onChange={() => setTokenEditing(true)} />
                : <TokenField spec={spec} token={token} setToken={setToken} />}
            </SettingsAdvanced>
          )}
        </div>
      </SettingsGroup>
    </div>
  )
}
