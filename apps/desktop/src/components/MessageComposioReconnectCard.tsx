import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { connectComposioToolkit } from "../lib/composioConnect";

export function ComposioReconnectCard({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);

  const reconnect = async () => {
    setStatus("running");
    setNote(t("chat.openingReconnection", { name }));
    const ok = await connectComposioToolkit(slug, {
      onStatus: (s) => {
        if (s === "connecting") {
          setNote(`Authorize ${name} in the browser: I detect automatically when it is done…`);
        }
      },
    });
    if (ok) {
      setStatus("done");
      setNote(t("chat.reconnectedName", { name }));
    } else {
      setStatus("error");
      setNote(t("chat.reconnectionNotCompleted"));
    }
  };

  if (status === "done") {
    return (
      <div className="cmp-confirm done">
        <ShieldCheck size={15} />
        <span>{note}</span>
      </div>
    );
  }
  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>{t("chat.linkExpired")}</strong>
        <span className="cmp-confirm-name">{name}</span>
      </div>
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void reconnect()}
        >
          {status === "running" ? t("chat.opening") : t("chat.reconnectName", { name })}
        </button>
      </div>
      {note && (status === "running" || status === "error") && (
        <p className={`cmp-confirm-note ${status === "error" ? "error" : ""}`}>{note}</p>
      )}
    </div>
  );
}
