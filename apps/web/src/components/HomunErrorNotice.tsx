/**
 * Shared inline error notice for Homun UI.
 * Always show engine/domain failures; never hide them behind demo data.
 */

import { homunErrorUserMessage, isHomunClientError } from "@/lib/homun-errors";

type Props = {
  error: unknown;
  className?: string;
};

export function HomunErrorNotice({ error, className }: Props) {
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
      {homunErrorUserMessage(error)}
    </p>
  );
}
