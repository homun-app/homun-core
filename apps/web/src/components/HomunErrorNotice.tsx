/**
 * Shared inline error notice for Homun UI.
 * Always show engine/domain failures; never hide them behind demo data.
 * Il testo principale è copia di prodotto dal catalogo condiviso, nella lingua
 * corrente (cambia lingua → cambia l'errore già mostrato); il dettaglio
 * tecnico (codice, reason, messaggio originale, codice del motore) vive in un
 * blocco richiudibile, chiuso di default, con copia come testo semplice.
 */

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useLanguage } from "@/hooks/use-language";
import { t } from "@/lib/i18n";
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
  // Lingua come dipendenza di rendering: gli errori già a schermo si aggiornano.
  useLanguage();
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
          <summary>{t("errorDetails.title")}</summary>
          <div className="homun-error-notice__detail-body">
            <dl className="homun-error-notice__detail-list">
              <div>
                <dt>{t("errorDetails.code")}</dt>
                <dd data-homun-error-detail="code">{details.code}</dd>
              </div>
              {details.reason != null && (
                <div>
                  <dt>{t("errorDetails.reason")}</dt>
                  <dd data-homun-error-detail="reason">{details.reason}</dd>
                </div>
              )}
              {details.message != null && (
                <div>
                  <dt>{t("errorDetails.message")}</dt>
                  <dd data-homun-error-detail="message">{details.message}</dd>
                </div>
              )}
              {details.engineCode != null && (
                <div>
                  <dt>{t("errorDetails.engineCode")}</dt>
                  <dd data-homun-error-detail="engine-code">{details.engineCode}</dd>
                </div>
              )}
            </dl>
            <button
              type="button"
              className="homun-error-notice__copy"
              onClick={() => copyToClipboard(homunErrorDetailsText(details))}
            >
              {isCopied ? t("common.copied") : t("common.copy")}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
