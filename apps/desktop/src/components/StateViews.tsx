// One consistent look for the empty / loading / error blocks that every view used to
// hand-roll (drawer-empty, workbench-empty, notif-empty, proattiva-empty, memview-empty…).
// Converging them here (regola madre: converge, don't duplicate) keeps the whole app
// coherent and lets a single style change land everywhere. Views pass their own icon and
// copy; the layout, spacing, and typography are shared.
import { type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

/** A centered empty block: icon + title (+ optional description + action). Use `compact`
 *  inside small panels/popovers where the tall default padding would look heavy. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  card,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  /** Dashed placeholder card (bordered box) instead of a plain centered block — for panels
   *  like an empty template gallery or approvals list. */
  card?: boolean;
}) {
  return (
    <div
      className={`state-view state-empty${compact ? " state-compact" : ""}${card ? " state-card" : ""}`}
    >
      {icon && <div className="state-icon">{icon}</div>}
      <p className="state-title">{title}</p>
      {description && <p className="state-desc">{description}</p>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/** A centered loading block: a spinner + optional label. `role=status` so assistive tech
 *  announces it without stealing focus. */
export function LoadingState({ label, compact }: { label?: ReactNode; compact?: boolean }) {
  return (
    <div
      className={`state-view state-loading${compact ? " state-compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="state-spin" size={compact ? 16 : 22} aria-hidden="true" />
      {label && <p className="state-desc">{label}</p>}
    </div>
  );
}

/** A centered error block: a warning glyph + message (+ optional retry). `role=alert` so it
 *  is announced immediately. */
export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel,
  compact,
}: {
  title?: ReactNode;
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`state-view state-error${compact ? " state-compact" : ""}`}
      role="alert"
    >
      <AlertTriangle className="state-icon" size={compact ? 18 : 22} aria-hidden="true" />
      {title && <p className="state-title">{title}</p>}
      <p className="state-desc">{message}</p>
      {onRetry && (
        <button type="button" className="state-retry" onClick={onRetry}>
          {retryLabel ?? "Retry"}
        </button>
      )}
    </div>
  );
}
