import { AlertCircle, FileText, Globe2, HardDrive, ShieldCheck, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApprovelItem, ComputerSession, ComputerSurfaceKind } from "../types";

const surfaceIcons: Record<ComputerSurfaceKind, typeof Globe2> = {
  browser: Globe2,
  shell: SquareTerminal,
  files: FileText,
  logs: HardDrive,
};

export function InlineApprovelPanel({
  approvals,
  busyId,
  onApprove,
  onReject,
  session,
}: {
  approvals: ApprovelItem[];
  busyId: string | null;
  onApprove: (
    approvalId: string,
    options?: {
      scope?: "once" | "always";
      browser_visibility?: "auto" | "visible" | "headless";
    },
  ) => void;
  onReject: (approvalId: string) => void;
  session: ComputerSession;
}) {
  const { t } = useTranslation();
  const approval = approvals[0];
  const scopeOptions = approval?.scopeOptions ?? ["once"];
  const browserVisibilityOptions = approval?.browserVisibilityOptions ?? [];
  const [scope, setScope] = useState<"once" | "always">(scopeOptions[0] ?? "once");
  const [browserVisibility, setBrowserVisibility] = useState<"auto" | "visible" | "headless">(
    approval?.defaultBrowserVisibility ?? "auto",
  );

  useEffect(() => {
    setScope(scopeOptions[0] ?? "once");
    setBrowserVisibility(approval?.defaultBrowserVisibility ?? "auto");
  }, [approval?.id]);

  if (!approval) {
    return null;
  }

  const waitingSteps = session.timeline
    .filter((item) => item.status === "waiting")
    .slice(0, 4);
  const summary = approval.action.startsWith("prompt_plan")
    ? "You approve only the next step of the plan. Login, purchase, send and payment stay blocked until you give an explicit confirmation for that single action."
    : approval.reason;
  const busy = busyId === approval.id;
  return (
    <article className="inline-approval-panel" aria-label={t("chat.confirmRequest")}>
      <header>
        <span className={`approval-dot ${approval.risk}`}>
          <AlertCircle size={15} />
        </span>
        <div>
          <strong>{t("chat.approvalRequired")}</strong>
          <small>{approval.risk === "high" ? t("chat.highRisk") : t("chat.controlledAction")}</small>
        </div>
      </header>

      <p>{summary}</p>

      {waitingSteps.length > 0 && (
        <div className="approval-plan-preview">
          <span>{t("chat.aboutToDo")}</span>
          {waitingSteps.map((step) => {
            const Icon = surfaceIcons[step.surface];
            return (
              <div key={step.id}>
                <Icon size={14} />
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </div>
            );
          })}
        </div>
      )}

      <div className="approval-safety-note">
        <ShieldCheck size={15} />
        <span>Raw data not exposed. No irreversible external action without confirmation.</span>
      </div>

      <div className="approval-scope-note">
        <span>Confirmation scope</span>
        <div className="approval-scope-options" aria-label="Confirmation scope">
          {scopeOptions.map((option) => (
            <button
              key={option}
              aria-pressed={scope === option}
              type="button"
              onClick={() => setScope(option)}
            >
              {option === "always" ? "Always for these URLs" : "Just this time"}
            </button>
          ))}
        </div>
        <small>
          {scope === "always"
            ? "Save a local rule for the domains involved in this task."
            : "Applies only to this task execution."}
        </small>
      </div>

      {browserVisibilityOptions.length > 0 && (
        <div className="approval-scope-note">
          <span>Browser</span>
          <div className="approval-scope-options" aria-label={t("chat.browserMode")}>
            {browserVisibilityOptions.map((option) => (
              <button
                key={option}
                aria-pressed={browserVisibility === option}
                type="button"
                onClick={() => setBrowserVisibility(option)}
              >
                {option === "auto" ? "Auto" : option === "visible" ? "Visibile" : "Headless"}
              </button>
            ))}
          </div>
          <small>Auto follows the system choice; visible shows the local computer.</small>
        </div>
      )}

      <footer>
        <button
          className="secondary-button"
          disabled={busy}
          type="button"
          onClick={() => onReject(approval.id)}
        >
          Reject
        </button>
        <button
          className="primary-button"
          disabled={busy}
          type="button"
          onClick={() =>
            onApprove(approval.id, {
              scope,
              ...(browserVisibilityOptions.length
                ? { browser_visibility: browserVisibility }
                : {}),
            })
          }
        >
          {busy ? "Continuo..." : "Approve e continua"}
        </button>
      </footer>
    </article>
  );
}
