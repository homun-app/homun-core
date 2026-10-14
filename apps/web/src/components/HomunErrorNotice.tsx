/**
 * Shared inline error notice for Homun UI.
 * Always show engine/domain failures; never hide them behind demo data.
 * Il testo principale è copia di prodotto; il dettaglio tecnico (codice,
 * messaggio originale, codice del motore) vive in un blocco richiudibile,
 * chiuso di default, con copia come testo semplice.
 */

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  homunErrorDetailsText,
  homunErrorTechnicalDetails,
  homunErrorUserMessage,
  isHomunClientError,
} from "@/lib/homun-errors";
import "./homun-notices.css";

type Props = {
  error: unknown;
  className?: string;
  /** Lead-in naming what failed («Materiali non disponibili:»), before the mapped reason. */
  label?: string;
};

export function HomunErrorNotice({ error, className, label }: Props) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  if (error == null) {
    return null;
  }
  const details = homunErrorTechnicalDetails(error);
  const code = isHomunClientError(error) ? error.code : null;
  return (
    <div
      className={className ?? "homun-error-notice"}
      role="alert"
      data-error-code={code ?? undefined}
    >
      <p className="homun-error-notice__text">
        {label ? `${label} ` : ""}
        {homunErrorUserMessage(error)}
      </p>
      {details && (
        <details className="homun-error-notice__details" data-homun-error-details="">
          <summary>Dettagli tecnici</summary>
          <div className="homun-error-notice__detail-body">
            <dl className="homun-error-notice__detail-list">
              <div>
                <dt>codice</dt>
                <dd data-homun-error-detail="code">{details.code}</dd>
              </div>
              {details.message != null && (
                <div>
                  <dt>messaggio</dt>
                  <dd data-homun-error-detail="message">{details.message}</dd>
                </div>
              )}
              {details.engineCode != null && (
                <div>
                  <dt>codice motore</dt>
                  <dd data-homun-error-detail="engine-code">{details.engineCode}</dd>
                </div>
              )}
            </dl>
            <button
              type="button"
              className="homun-error-notice__copy"
              onClick={() => copyToClipboard(homunErrorDetailsText(details))}
            >
              {isCopied ? "Copiato" : "Copia"}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
