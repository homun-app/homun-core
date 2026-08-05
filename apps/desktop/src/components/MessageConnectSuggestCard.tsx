import {
  Check,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  Plug,
  Puzzle,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { connectComposioToolkit } from "../lib/composioConnect";
import { coreBridge, type McpRegistryServer } from "../lib/coreBridge";

/** One clickable suggestion in an in-chat connect-card. */
export interface ConnectSuggestItem {
  kind: "mcp" | "skill" | "composio";
  name: string;
  description?: string;
  official?: boolean;
  /** Present for kind==="mcp": the full normalized registry server to connect. */
  server?: McpRegistryServer;
  /** Present for kind==="skill"|"composio": catalog/toolkit slug. */
  slug?: string;
  /** Set by the backend rewrite once the user connected this item. */
  connected?: boolean;
}

export interface ConnectSuggest {
  need: string;
  items: ConnectSuggestItem[];
}

/** In-chat connect-cards: turns `suggest_capabilities` results into clickable
 * actions so the user adds a capability from the conversation. */
export function ConnectSuggestCard({
  suggest,
  messageId,
  threadId,
}: {
  suggest: ConnectSuggest;
  messageId?: string;
  threadId?: string;
}) {
  return (
    <div className="cmp-confirm" style={{ gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Plug size={15} />
        <strong>Connect a capability for "{suggest.need}"</strong>
      </div>
      <p className="set-hint" style={{ fontSize: 12, margin: 0 }}>
        I do not have this tool yet. Choose what to connect below — you manage it
        also from Settings.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {suggest.items.map((item, index) => (
          <ConnectSuggestRow
            key={`${item.kind}-${item.slug ?? item.server?.id ?? item.name}-${index}`}
            item={item}
            messageId={messageId}
            threadId={threadId}
          />
        ))}
      </div>
    </div>
  );
}

const CONNECT_KIND_META: Record<
  ConnectSuggestItem["kind"],
  { icon: typeof Plug; label: string; cta: string }
> = {
  mcp: { icon: Plug, label: "MCP server", cta: "Connect" },
  skill: { icon: Puzzle, label: "Skills", cta: "Install" },
  composio: { icon: Cloud, label: "Cloud service", cta: "Link" },
};

/** A single connectable suggestion. MCP servers with required params expand an
 * inline form; skills install directly; Composio opens OAuth consent. */
function ConnectSuggestRow({
  item,
  messageId,
  threadId,
}: {
  item: ConnectSuggestItem;
  messageId?: string;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "opened" | "error">(
    item.connected ? "done" : "idle",
  );
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const meta = CONNECT_KIND_META[item.kind];
  const Icon = meta.icon;
  const inputs = item.kind === "mcp" ? (item.server?.inputs ?? []) : [];
  const hasInputs = inputs.length > 0;
  const missingRequired = inputs.some(
    (i) => i.required && !(values[i.key] ?? i.default ?? "").trim(),
  );

  const markConnected = async () => {
    const ref = item.kind === "mcp" ? item.server?.id : item.slug;
    if (!ref) return;
    try {
      await coreBridge.connectMark({ kind: item.kind, ref, ctx: { threadId, messageId } });
    } catch {
      /* persistence is best-effort; the connect itself already succeeded */
    }
  };

  const connectMcp = async () => {
    const server = item.server;
    if (!server) return;
    setStatus("running");
    setNote(null);
    try {
      const env: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const extraArgs: string[] = [];
      for (const input of server.inputs) {
        const value = (values[input.key] ?? input.default ?? "").trim();
        if (!value) continue;
        if (input.target === "env") env[input.key] = value;
        else if (input.target === "header") headers[input.key] = value;
        else extraArgs.push(value);
      }
      const result =
        server.transport === "http"
          ? await coreBridge.mcpConnect({
              name: server.name,
              url: server.url ?? undefined,
              headers,
            })
          : await coreBridge.mcpConnect({
              name: server.name,
              command: server.command,
              args: [...server.args, ...extraArgs],
              env,
            });
      setNote(
        result.discovery_error
          ? `Connected with warning: ${result.discovery_error}`
          : t("chat.toolsAvailable", { count: result.tools_cached }),
      );
      setStatus("done");
      await markConnected();
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const installSkills = async () => {
    if (!item.slug) return;
    setStatus("running");
    setNote(null);
    try {
      await coreBridge.catalogInstall({ slug: item.slug });
      setStatus("done");
      setNote(t("chat.skillInstalledRetry"));
      await markConnected();
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const linkComposio = async () => {
    if (!item.slug) return;
    setStatus("running");
    setNote(`Opening authorization for ${item.name}…`);
    const ok = await connectComposioToolkit(item.slug, {
      onStatus: (s) => {
        if (s === "connecting") {
          setNote(`Authorize ${item.name} in the browser: I detect automatically when it is done…`);
        }
      },
    });
    if (ok) {
      setStatus("done");
      setNote(t("chat.connectedName", { name: item.name }));
      await markConnected();
    } else {
      setStatus("error");
      setNote(t("chat.connectionNotCompleted"));
    }
  };

  // MCP with required params expands the form first; otherwise act immediately.
  const onPrimary = () => {
    if (item.kind === "mcp") {
      if (hasInputs && !expanded) {
        setExpanded(true);
        return;
      }
      void connectMcp();
    } else if (item.kind === "skill") {
      void installSkills();
    } else {
      void linkComposio();
    }
  };

  const done = status === "done";
  const opened = status === "opened";

  return (
    <div
      className="conn-tool"
      style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="conn-tool-main" style={{ minWidth: 0 }}>
          <span className="conn-tool-name" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon size={13} />
            {item.name}
            {item.official && (
              <span className="set-badge green" style={{ marginLeft: 4 }} title={t("chat.officialServer")}>
                <ShieldCheck size={11} /> Ufficiale
              </span>
            )}
            <span className="mdl-tag" style={{ marginLeft: 2 }}>
              {meta.label}
            </span>
          </span>
          {item.description && <span className="conn-tool-desc">{item.description}</span>}
        </div>
        {done ? (
          <span className="set-badge green" title={t("chat.linked")}>
            <Check size={12} /> {t("chat.linked")}
          </span>
        ) : (
          <button
            className="set-btn primary"
            type="button"
            disabled={status === "running"}
            onClick={onPrimary}
          >
            {status === "running"
              ? "…"
              : item.kind === "mcp" && hasInputs && !expanded
                ? t("chat.configure")
                : meta.cta}
          </button>
        )}
      </div>

      {expanded && item.kind === "mcp" && !done && (
        <div className="mdl-field" style={{ gap: 8, marginTop: 2 }}>
          {inputs.map((input) => (
            <div key={input.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label className="mdl-field-label">
                {input.label}
                {input.required ? " *" : " (optional)"}
                {input.secret && ` · ${t("chat.secret")}`}
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="set-input"
                  type={input.secret && !reveal[input.key] ? "password" : "text"}
                  placeholder={input.default ?? input.key}
                  value={values[input.key] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [input.key]: e.target.value }))
                  }
                />
                {input.secret && (
                  <button
                    className="set-btn"
                    type="button"
                    title={reveal[input.key] ? t("chat.hide") : t("chat.show")}
                    onClick={() =>
                      setReveal((prev) => ({ ...prev, [input.key]: !prev[input.key] }))
                    }
                  >
                    {reveal[input.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="cmp-confirm-actions">
            <button
              className="set-btn primary"
              type="button"
              disabled={status === "running" || missingRequired}
              onClick={() => void connectMcp()}
            >
              {status === "running" ? t("chat.connecting") : t("chat.connect")}
            </button>
            {item.server?.homepage && (
              <a
                href={item.server.homepage}
                target="_blank"
                rel="noreferrer"
                className="set-hint"
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
              >
                {t("chat.projectPage")} <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      )}

      {note && (
        <p className={`set-hint${status === "error" ? " error" : ""}`} style={{ fontSize: 12, margin: 0 }}>
          {opened && <ExternalLink size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />}
          {note}
        </p>
      )}
    </div>
  );
}
