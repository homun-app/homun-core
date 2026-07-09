import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  coreBridge,
  type ProjectBriefingData,
  type ProjectBriefingItem,
} from "../lib/coreBridge";

const COLLAPSED_KEY = "homun.projectContext.collapsed";

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(COLLAPSED_KEY);
  // Default collapsed; treat "false" explicitly as expanded.
  return raw !== "false";
}

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? null;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

/** ADR 0022 (Piano UI A5) — Project context panel: what the agent STABLY knows
 *  about the active project (objective/brief/open-loops/decisions/goals), with
 *  cross-chat provenance. Self-hides for Personal/non-project chats. */
export function ProjectContextPanel({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const [briefing, setBriefing] = useState<ProjectBriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsed());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    coreBridge
      .projectBriefing(threadId)
      .then((value) => {
        if (!cancelled) setBriefing(value);
      })
      .catch(() => {
        if (!cancelled) setBriefing(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // localStorage unavailable — keep in-memory state only.
      }
      return next;
    });
  };

  if (loading || !briefing || !briefing.is_project) return null;

  const objectiveLine = firstLine(briefing.objective);
  const hasGoals = briefing.goals.length > 0;
  const hasBrief = Boolean(briefing.brief?.body);
  const hasLoops = briefing.open_loops.length > 0;
  const hasDecisions = briefing.decisions.length > 0;
  const hasAny =
    Boolean(objectiveLine) || hasGoals || hasBrief || hasLoops || hasDecisions;
  if (!hasAny) return null;

  const pillLabel = objectiveLine ?? t("projectContext.title");

  return (
    <div className={`project-context-panel${collapsed ? " collapsed" : " expanded"}`}>
      <button
        className="pcp-pill"
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? t("projectContext.title") : undefined}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span className="pcp-pill-icon">🎯</span>
        <span className="pcp-pill-label">{collapsed ? truncate(pillLabel, 60) : t("projectContext.title")}</span>
      </button>

      {!collapsed && (
        <div className="pcp-body">
          {/* The plain objective text is owned by the working island (.wi-goal),
              fused into the same card directly below this panel — rendering it
              here too would duplicate it. This panel only falls back to a goals
              list when no objective is set. */}
          {!objectiveLine && hasGoals && (
            <section className="pcp-section">
              <h4 className="pcp-section-title">{t("projectContext.objective")}</h4>
              <ul className="pcp-list">
                {briefing.goals.map((goal) => (
                  <li key={goal.reference}>
                    <ProvenancedItem item={goal} learnedLabel={t("projectContext.learnedInChat")} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hasBrief && (
            <section className="pcp-section">
              <h4 className="pcp-section-title">{t("projectContext.brief")}</h4>
              <p className="pcp-brief">{truncate(briefing.brief!.body, 400)}</p>
            </section>
          )}

          {hasLoops && (
            <section className="pcp-section">
              <h4 className="pcp-section-title">{t("projectContext.openLoops")}</h4>
              <ul className="pcp-list">
                {briefing.open_loops.map((item) => (
                  <li key={item.reference}>
                    <ProvenancedItem item={item} learnedLabel={t("projectContext.learnedInChat")} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hasDecisions && (
            <section className="pcp-section">
              <h4 className="pcp-section-title">{t("projectContext.decisions")}</h4>
              <ul className="pcp-list">
                {briefing.decisions.map((item) => (
                  <li key={item.reference}>
                    <ProvenancedItem item={item} learnedLabel={t("projectContext.learnedInChat")} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ProvenancedItem({
  item,
  learnedLabel,
}: {
  item: ProjectBriefingItem;
  learnedLabel: string;
}) {
  const crossChat = item.thread_id !== null;
  return (
    <span className="pcp-item">
      <span className="pcp-item-text">{item.text}</span>
      {crossChat && <span className="pcp-provenance" title={learnedLabel}>{learnedLabel}</span>}
    </span>
  );
}
