import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";

/** A pending write action the model proposed, carried in the message text.
 * `kind` routes execution to the right backend: Composio vs an MCP server tool. */
export interface ComposioPendingAction {
  tool: string;
  arguments: unknown;
  kind?: "composio" | "mcp";
}

const COMPOSIO_FIELD_LABELS: Record<string, string> = {
  recipient_email: "Recipient",
  recipientemail: "Recipient",
  to: "Recipient",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Body",
  message: "Body",
  is_html: "HTML",
  attachment: "Attachment",
  // Calendar / events
  summary: "Title",
  title: "Title",
  description: "Description",
  location: "Location",
  start_datetime: "Start",
  end_datetime: "End",
  start_time: "Start",
  end_time: "End",
  start: "Start",
  end: "End",
  due_date: "Due date",
  date: "Date",
  attendees: "Attendees",
  timezone: "Time zone",
};

/** Opaque machine identifiers: the model needs them, but showing them to the user
 * in a confirm card is noise. Hidden from the card, still sent in the arguments. */
const OPAQUE_FIELD_KEYS = new Set([
  "id",
  "event_id",
  "calendar_id",
  "message_id",
  "thread_id",
  "draft_id",
  "user_id",
  "connected_account_id",
  "connection_id",
  "entity_id",
  "resource_id",
  "file_id",
]);

/** "GMAIL_SEND_EMAIL" -> "Send email · Gmail"; "mcp__fs__read_file" -> "read file · fs". */
export function humanizeToolName(slug: string): string {
  // MCP tools are namespaced `mcp__{server}__{tool}` -> "tool · server".
  if (slug.startsWith("mcp__")) {
    const rest = slug.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2).replace(/[_-]+/g, " ").trim();
      return `${tool || rest} · ${server}`;
    }
  }
  const parts = slug.split("_").filter(Boolean);
  if (parts.length === 0) return slug;
  const toolkit = parts[0].charAt(0) + parts[0].slice(1).toLowerCase();
  const action = parts.slice(1).map((w) => w.toLowerCase()).join(" ");
  if (!action) return toolkit;
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} · ${toolkit}`;
}

function humanizeFieldKey(key: string): string {
  return (
    COMPOSIO_FIELD_LABELS[key.toLowerCase()] ??
    key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function ComposioConfirmCard({
  action,
  messageId,
  threadId,
}: {
  action: ComposioPendingAction;
  messageId?: string;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);
  // Editable copy of the proposed arguments.
  const initial =
    action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)
      ? (action.arguments as Record<string, unknown>)
      : {};
  const [args, setArgs] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const title = humanizeToolName(action.tool);

  const setField = (key: string, value: unknown) =>
    setArgs((prev) => ({ ...prev, [key]: value }));

  const isMcp = action.kind === "mcp";
  const run = async (scope: "once" | "always") => {
    setStatus("running");
    setNote(null);
    try {
      const result = isMcp
        ? await coreBridge.mcpExecute(action.tool, args, scope, { threadId, messageId })
        : await coreBridge.composioExecute(action.tool, args, scope, { threadId, messageId });
      if (!result.ok) {
        // The backend replied but the action failed: never show a green "done".
        setStatus("error");
        setNote(result.summary || t("chat.actionFailed"));
        return;
      }
      setStatus("done");
      setNote(
        scope !== "always"
          ? "Done."
          : isMcp
            ? "Fatto. Questo server non chiederà più conferma."
            : `Done. From now on «${title}» will run without asking.`,
      );
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
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

  // Show only meaningful fields; opaque ids are still sent, just hidden.
  const keys = Object.keys(args).filter((k) => !OPAQUE_FIELD_KEYS.has(k.toLowerCase()));
  const hiddenIdCount = Object.keys(args).length - keys.length;
  // Flag destructive actions so the user cannot approve a data-loss op blindly.
  const destructive = action.tool
    .toUpperCase()
    .split("_")
    .some((part) =>
      [
        "DELETE",
        "REMOVE",
        "TRASH",
        "CANCEL",
        "CLEAR",
        "DROP",
        "PURGE",
        "REVOKE",
        "UNSEND",
        "DESTROY",
      ].includes(part),
    );
  return (
    <div className={`cmp-confirm${destructive ? " destructive" : ""}`}>
      <div className="cmp-confirm-head">
        {destructive ? <AlertTriangle size={15} /> : <ShieldCheck size={15} />}
        <strong>{destructive ? t("chat.confirmDestructiveAction") : t("chat.confirmAction")}</strong>
        <span className="cmp-confirm-name">{title}</span>
      </div>
      {destructive && (
        <p className="cmp-confirm-warn">
          {t("chat.destructiveWarning", {
            service: humanizeToolName(action.tool).split(" · ")[1] ?? t("chat.aLinkedService"),
          })}
        </p>
      )}
      <div className="cmp-confirm-fields">
        {keys.length === 0 && (
          <p className="cmp-confirm-empty">
            {hiddenIdCount > 0
              ? t("chat.actsOnIdentifiedItem")
              : t("chat.noParameters")}
          </p>
        )}
        {keys.map((key) => {
          const value = args[key];
          const label = humanizeFieldKey(key);
          if (typeof value === "boolean") {
            return (
              <label key={key} className="cmp-field-check">
                <input
                  type="checkbox"
                  checked={value}
                  disabled={status === "running"}
                  onChange={(e) => setField(key, e.target.checked)}
                />
                <span>{label}</span>
              </label>
            );
          }
          const isObject = value !== null && typeof value === "object";
          const str = isObject ? JSON.stringify(value, null, 2) : String(value ?? "");
          const multiline = isObject || str.length > 60 || /body|message|text/i.test(key);
          return (
            <div key={key} className="cmp-field">
              <label>{label}</label>
              {multiline ? (
                <textarea
                  className="set-input"
                  rows={isObject ? 4 : 5}
                  value={str}
                  disabled={status === "running"}
                  onChange={(e) => {
                    if (isObject) {
                      try {
                        setField(key, JSON.parse(e.target.value));
                      } catch {
                        setField(key, e.target.value);
                      }
                    } else {
                      setField(key, e.target.value);
                    }
                  }}
                />
              ) : (
                <input
                  className="set-input"
                  value={str}
                  disabled={status === "running"}
                  onChange={(e) => setField(key, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {status === "error" && <p className="cmp-confirm-err">{t("chat.failed")}: {note}</p>}
      <div className="cmp-confirm-actions">
        <button
          className="set-btn primary"
          type="button"
          disabled={status === "running"}
          onClick={() => void run("once")}
        >
          {status === "running" ? "Running…" : "Run once"}
        </button>
        <button
          className="set-btn"
          type="button"
          disabled={status === "running"}
          onClick={() => void run("always")}
          title={isMcp ? "Non chiedere più per questo server MCP" : `Do not ask again for ${title}`}
        >
          {isMcp ? "Consenti sempre questo server" : "Esegui sempre"}
        </button>
      </div>
      <p className="cmp-confirm-note">
        {isMcp
          ? '"Consenti sempre" non chiederà più conferma per nessuna azione di questo server MCP — anche da remoto su Telegram/WhatsApp.'
          : '"Run always" disables confirmation everywhere for this tool — including remote su Telegram/WhatsApp.'}
      </p>
    </div>
  );
}
