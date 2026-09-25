import { useMemo, useState } from "react";
import { Bot, CheckCircle2, Clock, XCircle, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { t } from "@/lib/i18n";
import { extractDelegations, type DelegationItem } from "@/lib/engine-delegation-parser";
import "./engine-delegation-list.css";

export { extractDelegations, type DelegationItem };

export function EngineDelegationList({
  observations,
}: {
  observations?: Array<{ tool?: string; message?: string; result?: unknown }> | undefined;
}) {
  const delegations = useMemo(() => extractDelegations(observations), [observations]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  if (delegations.length === 0) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="cw-delegation-list" aria-label={t("delegation.title")}>
      <div className="cw-delegation-header">
        <div className="cw-delegation-title">
          <Bot size={16} />
          <span>{t("delegation.title")}</span>
        </div>
        <span className="cw-delegation-badge">
          {delegations.length}
        </span>
      </div>

      <div className="cw-delegation-items">
        {delegations.map((item) => {
          const isExpanded = expandedIds.has(item.delegationId);

          return (
            <div key={item.delegationId} className="cw-delegation-card">
              <div className="cw-delegation-card-top">
                <span className="cw-delegation-id">{item.delegationId}</span>
                <span className={`cw-delegation-status cw-delegation-status--${item.status}`}>
                  {item.status === "completed" && <CheckCircle2 size={12} />}
                  {item.status === "running" && <Clock size={12} />}
                  {item.status === "cancelled" && <XCircle size={12} />}
                  {item.status === "failed" && <AlertCircle size={12} />}
                  {item.status === "completed" && t("delegation.completed")}
                  {item.status === "running" && t("delegation.running")}
                  {item.status === "cancelled" && t("delegation.cancelled")}
                  {item.status === "failed" && t("delegation.failed")}
                </span>
              </div>

              {item.task && (
                <div className="cw-delegation-task">
                  <strong>{t("delegation.task_label")}:</strong> {item.task}
                </div>
              )}

              {item.schemaError && (
                <div className="cw-delegation-schema-error" role="alert" style={{ color: "#cf222e", marginTop: 4 }}>
                  <AlertCircle size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
                  <strong>{t("delegation.schema_error")}:</strong> {item.schemaError}
                </div>
              )}

              {item.structuredOutput && (
                <div className="cw-delegation-structured">
                  <div style={{ fontWeight: 600, marginBottom: 4, color: "#2d5a32" }}>
                    {t("delegation.structured_output")}:
                  </div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(item.structuredOutput, null, 2)}
                  </pre>
                </div>
              )}

              {item.result && (
                <div>
                  <button
                    type="button"
                    className="cw-delegation-details-toggle"
                    onClick={() => toggleExpand(item.delegationId)}
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp size={12} style={{ display: "inline", verticalAlign: "middle" }} />{" "}
                        {t("delegation.hide_details")}
                      </>
                    ) : (
                      <>
                        <ChevronDown size={12} style={{ display: "inline", verticalAlign: "middle" }} />{" "}
                        {t("delegation.show_details")}
                      </>
                    )}
                  </button>

                  {isExpanded && (
                    <div className="cw-delegation-raw">
                      <strong>{t("delegation.result_label")}:</strong>
                      <p style={{ margin: "4px 0 0 0" }}>{item.result}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
