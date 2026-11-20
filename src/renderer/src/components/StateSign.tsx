// P6 (fase uso-permessi): IL SEGNO DI STATO condiviso — la barra lo usa dal
// R2 della fase barra-sobria e ora anche gli stati in CHAT parlano come lei:
// card dell'aiutante, card dei task e righe di stato del turno rendono lo
// STESSO componente (lavora / aspetta te / finito / fermo), con gli stessi
// colori, le stesse animazioni («riduci movimento» compreso) e nessuna emoji.
import { useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { RowState } from '../sidebar-utils'

/** Il nome dello stato della riga, per i suggerimenti e gli aria-label (R2). */
export function rowStateName(state: RowState): MessageDescriptor {
  switch (state) {
    case 'lavora':
      return msg`lavora`
    case 'aspetta-te':
      return msg`aspetta te`
    case 'finito':
      return msg`finito`
    default:
      return msg`fermo`
  }
}

/**
 * R2 (fase barra-sobria): IL SEGNO DI STATO a destra delle righe — gli stati
 * presi dalla mascotte, con i SUOI keyframes (styles.css: bot-dot, bot-wave,
 * bot-hop), solo scalati. lavora: tre puntini blu che saltellano (ritardi
 * 0/.15/.3); aspetta te: pallino arancio con l'onda; finito: arco verde con
 * UN saltello; fermo: nessun segno, solo il tempo. aria-label col nome.
 */
export function StateSign({ state, className, testid }: { state: RowState; className?: string; testid?: string }) {
  const { i18n } = useLingui()
  if (state === 'fermo') return null
  return (
    <span
      className={`side-sign ${className ?? ''}`}
      data-testid={testid}
      data-state={state}
      role="img"
      aria-label={i18n.t(rowStateName(state))}
    >
      {state === 'lavora' && (
        <span className="side-dots" aria-hidden="true">
          <span className="side-dot" style={{ animationDelay: '0s' }} />
          <span className="side-dot" style={{ animationDelay: '.15s' }} />
          <span className="side-dot" style={{ animationDelay: '.3s' }} />
        </span>
      )}
      {state === 'aspetta-te' && (
        <span className="side-wait" aria-hidden="true">
          <span className="side-wait-wave" />
          <span className="side-wait-dot" />
        </span>
      )}
      {state === 'finito' && (
        <svg className="side-done" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
          <path d="M2 2 Q7 8 12 2" stroke="var(--guide-good)" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        </svg>
      )}
    </span>
  )
}
