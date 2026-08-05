import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";

/** In-chat card to grant the assistant access to a folder so the user
 * authorizes and sees the result without leaving the conversation. */
export function FsAuthorizeCard({
  path,
  op,
  messageId,
  threadId,
}: {
  path: string;
  op: string;
  messageId?: string;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [output, setOutput] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.fsAuthorize(path, op, { threadId, messageId });
      if (!result.ok) {
        setStatus("error");
        setNote(result.summary || t("chat.authorizationFailed"));
        return;
      }
      setOutput(result.output ?? "");
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  if (status === "done") {
    return (
      <div className="cmp-confirm">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={15} />
          <strong>Access granted to {path}</strong>
        </div>
        {output && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              marginTop: 8,
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {output}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="cmp-confirm">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ShieldCheck size={15} />
        <strong>Grant access to this folder?</strong>
      </div>
      <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", marginTop: 4 }}>
        {path}
      </code>
      <p className="set-hint" style={{ fontSize: 12 }}>
        I will be able to read files and folders inside. You manage it also from Settings → Computer.
      </p>
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run()}
        >
          <ShieldCheck size={14} />
          <span style={{ marginLeft: 6 }}>
            {status === "running"
              ? "Autorizzo…"
              : op === "read"
                ? "Autorizza e leggi"
                : "Autorizza ed elenca"}
          </span>
        </button>
      </div>
    </div>
  );
}
