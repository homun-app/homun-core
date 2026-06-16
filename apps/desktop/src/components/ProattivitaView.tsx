import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Link2,
  RefreshCw,
  User,
  Folder,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";
import type { ProactivitySuggestion, WorkspaceRecord } from "../lib/coreBridge";

const PERSONAL_SCOPE = "__personal__";

type ScopeFilter = "all" | "personal" | "projects";

interface ProattivitaViewProps {
  // Engaging a card: App owns the workspace/thread machinery, so it opens a chat
  // in the card's scope seeded with its context (the value of the dashboard).
  onOpenChat: (suggestion: ProactivitySuggestion) => void | Promise<void>;
}

export function ProattivitaView({ onOpenChat }: ProattivitaViewProps) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<ProactivitySuggestion[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    const [list, ws] = await Promise.all([
      coreBridge.suggestions(),
      coreBridge
        .workspaces()
        .catch(() => ({ workspaces: [] as WorkspaceRecord[], active_workspace_id: "" })),
    ]);
    setSuggestions(list.suggestions);
    setWorkspaces(ws.workspaces);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function scopeName(scope: string): string {
    if (scope === PERSONAL_SCOPE) return t("sidebar.personal");
    return workspaces.find((w) => w.id === scope)?.name ?? scope;
  }

  // Group pending cards by scope. The list arrives newest-first, so each group's
  // first card IS the latest/most-relevant — the zen default surfaces it; the rest
  // hide behind "+N altre".
  const groups = useMemo(() => {
    const filtered = suggestions.filter((s) => {
      if (filter === "personal") return s.scope === PERSONAL_SCOPE;
      if (filter === "projects") return s.scope !== PERSONAL_SCOPE;
      return true;
    });
    const map = new Map<string, ProactivitySuggestion[]>();
    for (const s of filtered) {
      const arr = map.get(s.scope) ?? [];
      arr.push(s);
      map.set(s.scope, arr);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === PERSONAL_SCOPE) return -1;
      if (b[0] === PERSONAL_SCOPE) return 1;
      return b[1].length - a[1].length;
    });
  }, [suggestions, filter]);

  function toggleScope(scope: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function act(
    s: ProactivitySuggestion,
    status: "accepted" | "dismissed",
    feedback: "liked" | "disliked",
  ) {
    setBusyId(s.id);
    await coreBridge.suggestionAct(s.id, status, feedback);
    setSuggestions((cur) => cur.filter((x) => x.id !== s.id));
    setBusyId(null);
  }

  async function open(s: ProactivitySuggestion) {
    setBusyId(s.id);
    // Engaging is a positive signal (accepted + liked); then App opens the chat.
    await coreBridge.suggestionAct(s.id, "accepted", "liked");
    setSuggestions((cur) => cur.filter((x) => x.id !== s.id));
    setBusyId(null);
    await onOpenChat(s);
  }

  const total = suggestions.length;

  return (
    <section className="proattiva-view">
      <header className="learning-header">
        <div>
          <p className="eyebrow">{t("proattivita.eyebrow")}</p>
          <h2>{t("proattivita.title")}</h2>
          <p className="lead-copy">
            {t("proattivita.lead")}
          </p>
        </div>
        <div className="learning-summary">
          <span>
            <strong>{total}</strong>
            {t("proattivita.pending")}
          </span>
        </div>
      </header>

      <div className="proattiva-toolbar">
        <div className="proattiva-filters">
          {(
            [
              ["all", t("proattivita.filterAll")],
              ["personal", t("sidebar.personal")],
              ["projects", t("proattivita.filterProjects")],
            ] as [ScopeFilter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`proattiva-chip ${filter === key ? "is-active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="proattiva-refresh" onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
          {t("proattivita.refresh")}
        </button>
      </div>

      {loading ? (
        <p className="proattiva-empty">{t("proattivita.loading")}</p>
      ) : groups.length === 0 ? (
        <div className="proattiva-empty">
          <Lightbulb size={20} aria-hidden="true" />
          <p>{t("proattivita.emptyHint")}</p>
        </div>
      ) : (
        groups.map(([scope, cards]) => {
          const isPersonal = scope === PERSONAL_SCOPE;
          const isOpen = expanded.has(scope);
          const visible = isOpen ? cards : cards.slice(0, 1);
          const hidden = cards.length - visible.length;
          return (
            <div key={scope} className="proattiva-group">
              <div className="proattiva-group-head">
                {isPersonal ? (
                  <User size={14} aria-hidden="true" />
                ) : (
                  <Folder size={14} aria-hidden="true" />
                )}
                <span className="proattiva-group-name">{scopeName(scope)}</span>
                <span className="proattiva-group-count">
                  · {cards.length} {cards.length === 1 ? t("proattivita.suggestion") : t("proattivita.suggestions")}
                </span>
              </div>

              {visible.map((s) => (
                <article key={s.id} className={`proattiva-card ${busyId === s.id ? "is-busy" : ""}`}>
                  <div className="proattiva-card-main">
                    <div className="proattiva-card-title-row">
                      <span className="proattiva-kind">{s.kind}</span>
                      <span className="proattiva-card-title">{s.title}</span>
                    </div>
                    <p className="proattiva-card-body">{s.body}</p>
                    {s.rationale && (
                      <div className="proattiva-card-why">
                        <Link2 size={13} aria-hidden="true" />
                        <span>{s.rationale}</span>
                      </div>
                    )}
                  </div>
                  <div className="proattiva-card-actions">
                    <button
                      type="button"
                      className="proattiva-btn proattiva-btn-primary"
                      disabled={busyId === s.id}
                      onClick={() => void open(s)}
                    >
                      <ArrowRight size={14} aria-hidden="true" />
                      {t("proattivita.openChat")}
                    </button>
                    <div className="proattiva-btn-row">
                      <button
                        type="button"
                        className="proattiva-btn"
                        title={t("proattivita.doneTitle")}
                        disabled={busyId === s.id}
                        onClick={() => void act(s, "accepted", "liked")}
                      >
                        <Check size={14} aria-hidden="true" />
                        {t("proattivita.done")}
                      </button>
                      <button
                        type="button"
                        className="proattiva-btn proattiva-btn-muted"
                        title={t("proattivita.notUsefulTitle")}
                        disabled={busyId === s.id}
                        onClick={() => void act(s, "dismissed", "disliked")}
                      >
                        <X size={14} aria-hidden="true" />
                        {t("proattivita.notUseful")}
                      </button>
                    </div>
                  </div>
                </article>
              ))}

              {hidden > 0 && (
                <button type="button" className="proattiva-more" onClick={() => toggleScope(scope)}>
                  <ChevronRight size={13} aria-hidden="true" />+{hidden}{" "}
                  {hidden === 1 ? t("proattivita.other") : t("proattivita.others")} {t("proattivita.in")} {scopeName(scope)}
                </button>
              )}
              {isOpen && cards.length > 1 && (
                <button type="button" className="proattiva-more" onClick={() => toggleScope(scope)}>
                  <ChevronDown size={13} aria-hidden="true" />
                  {t("proattivita.collapse")}
                </button>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
