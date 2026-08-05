import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";

/** Escalates a blocked read-only write by changing the persisted sandbox mode. */
export function SandboxReadOnlyCard({ target }: { target: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "switching" | "switched" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const switchToWorkspace = async () => {
    setStatus("switching");
    setNote(null);
    try {
      await coreBridge.setRuntimeSettings({ sandbox_mode: "workspace-write" });
      setStatus("switched");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  if (status === "switched") {
    return (
      <div className="cmp-confirm">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={15} />
          <strong>{t("chat.sandboxReadOnlySwitchedTitle")}</strong>
        </div>
        <p className="set-hint" style={{ fontSize: 12 }}>
          {t("chat.sandboxReadOnlySwitchedHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="cmp-confirm">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <AlertTriangle size={15} />
        <strong>{t("chat.sandboxReadOnlyTitle")}</strong>
      </div>
      <p className="set-hint" style={{ fontSize: 12 }}>
        {target
          ? t("chat.sandboxReadOnlyDesc", { target })
          : t("chat.sandboxReadOnlyDescNoTarget")}
      </p>
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "switching"}
          onClick={() => void switchToWorkspace()}
        >
          <span>
            {status === "switching"
              ? t("chat.sandboxReadOnlySwitching")
              : t("chat.sandboxReadOnlySwitch")}
          </span>
        </button>
        <button
          className="set-btn"
          type="button"
          disabled={status === "switching"}
          onClick={() => setDismissed(true)}
        >
          <span>{t("chat.sandboxReadOnlyKeep")}</span>
        </button>
      </div>
    </div>
  );
}
