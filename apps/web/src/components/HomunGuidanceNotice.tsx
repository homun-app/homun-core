/**
 * Shared inline guidance notice: a recovered, non-error state the person
 * should act on (for example repeating an action after a state refresh).
 * Distinct from HomunErrorNotice on purpose: nothing failed just now.
 */

import "./homun-notices.css";

type Props = {
  message: string | null;
  className?: string;
};

export function HomunGuidanceNotice({ message, className }: Props) {
  if (message == null) {
    return null;
  }
  return (
    <p className={className ?? "homun-guidance-notice"} role="status">
      {message}
    </p>
  );
}
