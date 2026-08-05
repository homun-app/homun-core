import { ChevronDown, SquareTerminal } from "lucide-react";
import { useMemo } from "react";
import { ACTIVITY_RE } from "../lib/markers";

export function parseActivitySteps(text: string): string[] {
  return Array.from(text.matchAll(ACTIVITY_RE), (match) => match[1].trim()).filter(
    (step) => step.length > 0,
  );
}

/** Compact, collapsible trace of the tool steps the assistant ran. */
export function MessageActivity({ text, live = false }: { text: string; live?: boolean }) {
  const steps = useMemo(() => parseActivitySteps(text), [text]);
  if (steps.length === 0) return null;
  const countLabel = `Activity \u00b7 ${steps.length} ${steps.length === 1 ? "passo" : "passi"}`;
  const collapsedLabel = live ? steps[steps.length - 1] : countLabel;
  return (
    <details className={`chat-operational-row msg-activity${live ? " live" : ""}`} open={live}>
      <summary>
        {live ? (
          <span className="msg-activity-dot" aria-hidden="true" />
        ) : (
          <SquareTerminal size={13} className="msg-activity-icon" />
        )}
        <span className="msg-activity-label">{collapsedLabel}</span>
        <ChevronDown size={13} className="msg-activity-caret" />
      </summary>
      <ol className="msg-activity-steps">
        {steps.map((step, index) => {
          const status = /^(?:\u23f3|\u21a9|\u23f9|\u{1f527})/u.test(step)
            ? "warn"
            : live && index === steps.length - 1
              ? "doing"
              : "done";
          return (
            <li key={`${index}-${step.slice(0, 24)}`} data-status={status}>
              {step.replace(/^(?:\p{Extended_Pictographic}|\ufe0f|\u200d|\s)+/u, "")}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
