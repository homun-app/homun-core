/**
 * Shared inline error notice for Homun UI.
 * Always show engine/domain failures; never hide them behind demo data.
 */

import { homunErrorUserMessage, isHomunClientError } from "@/lib/homun-errors";
import "./homun-notices.css";

type Props = {
  error: unknown;
  className?: string;
  /** Lead-in naming what failed («Materiali non disponibili:»), before the mapped reason. */
  label?: string;
};

export function HomunErrorNotice({ error, className, label }: Props) {
  if (error == null) {
    return null;
  }
  const code = isHomunClientError(error) ? error.code : null;
  return (
    <p
      className={className ?? "homun-error-notice"}
      role="alert"
      data-error-code={code ?? undefined}
    >
      {label ? `${label} ` : ""}
      {homunErrorUserMessage(error)}
    </p>
  );
}
