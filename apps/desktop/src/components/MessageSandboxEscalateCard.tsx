import { ShieldCheck, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";

/** ADR 0023: a shell command failed under the Seatbelt workspace sandbox;
 * approving re-runs it unsandboxed with full access. */
export function SandboxEscalateCard({
  command,
  cwd,
  messageId,
  threadId,
}: {
  command: string;
  cwd: string;
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
      const result = await coreBridge.runEscalate(command, cwd, { threadId, messageId });
      if (!result.ok) {
        setStatus("error");
        setNote(result.summary || t("chat.failed"));
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
          <strong>Command ran with full access</strong>
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
        <SquareTerminal size={15} />
        <strong>This command was blocked by the workspace sandbox. Run it with full access?</strong>
      </div>
      <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", marginTop: 4 }}>
        {command}
      </code>
      <p className="set-hint" style={{ fontSize: 12 }}>
        It will run outside the sandbox with full access to your machine. Only approve commands you trust.
      </p>
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run()}
        >
          <SquareTerminal size={14} />
          <span style={{ marginLeft: 6 }}>
            {status === "running" ? "Running…" : "Run without sandbox"}
          </span>
        </button>
      </div>
    </div>
  );
}
