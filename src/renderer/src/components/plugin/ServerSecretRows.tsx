// PP2 (fase plugin-pulita): le righe del SEGRETO nella scheda del plugin —
// la riga «Account» di un server e, per un server stdio con variabili
// segrete, la riga che le conta. Prima «token aziendale» era solo testo e
// l'editor che sapeva sostituire il segreto stava in un altro posto (il form
// «Server MCP personalizzato») e rimandava TUTTA la config. Qui: «Cambia
// token» apre un campo password sul posto, «Salva» manda solo il segreto
// (mcp:replace-secret) e la riga mostra l'esito del test; le intestazioni e
// le variabili hanno un campo per OGNI nome salvato — i nomi si vedono, i
// valori mai — e si sostituiscono solo quelli scritti; OAuth ha «Ricollega»
// sempre, come azione della riga. Lo stato è il reducer PURO di
// lib/plugin-secret: il valore scritto non resta dopo il salvataggio.
//
// Fase design (DS4): ai token. Il titolo «Account» è una sezione come le
// altre della scheda; le azioni delle righe sono testo (Button ghost) — anche
// «Ricollega», che prima era l'unica pillola piena della riga: un'azione DENTRO
// una riga è testo, l'azione che fa andare avanti è solo «Salva» dell'editor;
// i campi sono alti 36 col raggio dei controlli (erano una pillola corta).
import { useLingui, Trans } from '@lingui/react/macro'
import { api } from '../../store'
import type { McpServerInfo } from '../../../../shared/types'
// PP4 (fase plugin-pulita): le righe a filo — la scheda non usa più i pezzi delle Impostazioni
import { FlatList, FlatRow } from '../ui/flat-list'
import { Section } from '../ui/section'
import { Button } from '../ui/button'
import {
  accountKindOf, secretPayloadOf, submitSecret,
  type SecretEditAction, type SecretEditState, type SecretEditResult, type SecretKind, type ServerSecretNames
} from '../../lib/plugin-secret'

/**
 * Il campo password dell'editor: 36 px (la misura dei campi), il raggio dei
 * controlli, il testo di riga, sul fondo della scheda (sta sotto la riga, a
 * filo: il fondo lo separa da lei).
 */
const FIELD = 'h-control w-full rounded-control bg-card px-3 text-body outline-none disabled:opacity-60'

/** L'esito del salvataggio come testo (la riga lo colora: bene, male, neutro). */
function ResultText({ result }: { result: SecretEditResult }): React.ReactNode {
  if (result.outcome === 'ok') return <span className="text-small text-chart-2" data-testid="plugin-secret-result"><Trans>collegato</Trans></span>
  if (result.outcome === 'fail' || result.outcome === 'error') {
    return <span className="text-small text-destructive" data-testid="plugin-secret-result">{result.reason}</span>
  }
  return <span className="text-small" data-testid="plugin-secret-result"><Trans>salvato</Trans></span>
}

/**
 * I campi dell'editor: uno per nome (il token è uno e nei testid si chiama
 * «token»). Password, vuoti (il valore vecchio non si legge mai), con
 * «Salva» (cliccabile solo con qualcosa di scritto) e «Annulla». Invio
 * salva, Esc annulla.
 */
function SecretFields({ kind, names, state, onAction, onSave }: {
  kind: SecretKind
  names: string[]
  state: SecretEditState
  onAction(action: SecretEditAction): void
  onSave(): void
}): React.ReactNode {
  const { t } = useLingui()
  const canSave = !state.saving && Object.keys(secretPayloadOf(kind, state.values)).length > 0
  // i campi stanno SOTTO la riga, nella sua stessa voce di lista (nessun filetto in mezzo)
  return (
    <div className="flex w-full flex-col gap-2 pb-3">
      {names.map((name) => (
        <label key={name} className="block">
          {kind !== 'bearer' && <span className="mb-1 block font-mono text-small text-muted-foreground">{name}</span>}
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className={FIELD}
            data-testid={kind === 'bearer' ? 'plugin-token-input' : `plugin-${kind}-input-${name}`}
            aria-label={kind === 'bearer' ? t`Nuovo token` : name}
            placeholder={kind === 'bearer' ? t`Nuovo token — sostituisce quello salvato` : t`Nuovo valore — sostituisce quello salvato`}
            value={state.values[name] ?? ''}
            disabled={state.saving}
            onChange={(e) => onAction({ type: 'type', name, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) onSave()
              if (e.key === 'Escape') onAction({ type: 'cancel' })
            }}
          />
        </label>
      ))}
      <div className="flex items-center gap-2">
        <Button
          data-testid={`plugin-${kind === 'bearer' ? 'token' : kind}-save`}
          disabled={!canSave}
          onClick={onSave}
        >
          <Trans>Salva</Trans>
        </Button>
        <Button variant="ghost" data-testid={`plugin-${kind === 'bearer' ? 'token' : kind}-cancel`} disabled={state.saving} onClick={() => onAction({ type: 'cancel' })}>
          <Trans>Annulla</Trans>
        </Button>
      </div>
    </div>
  )
}

/**
 * Le righe dell'account di un SERVER (i connettori del catalogo hanno le
 * loro, nella scheda): «Account» con la sua azione e, quando un server stdio
 * ha delle variabili segrete salvate, «variabili segrete: N» con la sua — A
 * FILO (PP4). L'editor si apre sotto la sua riga, nella stessa voce.
 */
export function ServerAccountRow({ server, names, state, onAction, onChanged }: {
  server: McpServerInfo
  /** i NOMI dei segreti salvati (mcp:secret-names); null finché non arrivano */
  names?: ServerSecretNames | null
  state: SecretEditState
  onAction(action: SecretEditAction): void
  onChanged(): void
}): React.ReactNode {
  const { t } = useLingui()
  const kind = accountKindOf(server, names)
  // «Ricollega» è l'azione di OAuth — sempre, non solo con needsReauth — e resta anche dove il daemon lo chiede per un server non OAuth (com'era in fondo alla scheda)
  const reconnect = kind === 'oauth' || server.needsReauth === true
  // i nomi si sanno solo quando sono arrivati: finché non ci sono, le intestazioni non si aprono
  const headerNames = names?.headers ?? []
  const envNames = server.transport === 'stdio' ? (names?.env ?? []) : []
  const save = (): void => { void submitSecret({ id: server.id, kind: state.kind, values: state.values, api, dispatch: onAction, onChanged }) }
  const title =
    kind === 'oauth' ? t`con il tuo account`
      : kind === 'bearer' ? t`token aziendale`
        : kind === 'headers' ? (names ? t`intestazioni: ${headerNames.length}` : t`intestazioni`)
          : t`nessun account`
  const result = state.result !== null && state.result.kind !== 'env' ? state.result : null
  return (
    <Section title={<Trans>Account</Trans>} testId="plugin-account-rows">
      <FlatList>
        <div>
          <FlatRow
            title={title}
            subtitle={result !== null ? <ResultText result={result} /> : undefined}
            trailing={reconnect ? (
              <Button variant="ghost" size="sm" data-testid="plugin-reconnect" onClick={() => { void api.connectorsReconnectServer(server.id).then(onChanged).catch(() => undefined) }}>
                <Trans>Ricollega</Trans>
              </Button>
            ) : kind === 'bearer' ? (
              <Button variant="ghost" size="sm" data-testid="plugin-token-change" onClick={() => onAction({ type: 'open', kind: 'bearer' })}>
                <Trans>Cambia token</Trans>
              </Button>
            ) : kind === 'headers' ? (
              <Button variant="ghost" size="sm" data-testid="plugin-headers-change" disabled={!names} onClick={() => onAction({ type: 'open', kind: 'headers' })}>
                <Trans>Cambia</Trans>
              </Button>
            ) : undefined}
          />
          {state.kind === 'bearer' && <SecretFields kind="bearer" names={['token']} state={state} onAction={onAction} onSave={save} />}
          {state.kind === 'headers' && headerNames.length > 0 && <SecretFields kind="headers" names={headerNames} state={state} onAction={onAction} onSave={save} />}
        </div>
        {envNames.length > 0 && (
          <div>
            <FlatRow
              testId="plugin-env-row"
              title={t`variabili segrete: ${envNames.length}`}
              subtitle={state.result !== null && state.result.kind === 'env' ? <ResultText result={state.result} /> : undefined}
              trailing={state.kind === 'env' ? undefined : (
                <Button variant="ghost" size="sm" data-testid="plugin-env-change" onClick={() => onAction({ type: 'open', kind: 'env' })}>
                  <Trans>Cambia</Trans>
                </Button>
              )}
            />
            {state.kind === 'env' && <SecretFields kind="env" names={envNames} state={state} onAction={onAction} onSave={save} />}
          </div>
        )}
      </FlatList>
    </Section>
  )
}
