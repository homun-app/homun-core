import { useEffect, useMemo, useState } from "react";
import { Brain, Check, ChevronDown, Download, Search, Sparkles, Trash2, X } from "lucide-react";

import {
  coreBridge,
  type CoreMemoryDashboard,
  type CoreMemoryItem,
  type CoreMemoryScope,
} from "../lib/coreBridge";
import { MemoryGraphPanel } from "./ChatView";

// The memory "brain": filter by project, search, scrub a per-month timeline (height =
// how much was learned), then inspect the period — list (with delete) + the graph/wiki
// of how the project's information connects.

const TYPE_LABELS: Record<string, string> = {
  decision: "Decisioni",
  fact: "Fatti",
  preference: "Preferenze",
  episode: "Conversazioni",
};
const TYPE_COLORS: Record<string, string> = {
  decision: "#0ea5e9",
  fact: "#f59e0b",
  preference: "#a78bfa",
  episode: "#94a3b8",
};
const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

// created_at is stored either as "unix:<seconds>" or an ISO/sql timestamp.
function parseCreatedAt(raw: string): Date | null {
  if (!raw) return null;
  if (raw.startsWith("unix:")) {
    const n = Number(raw.slice(5));
    return Number.isFinite(n) ? new Date(n * 1000) : null;
  }
  const d = new Date(raw.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}
function monthKey(raw: string): string {
  const d = parseCreatedAt(raw);
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "";
}
function dayLabel(raw: string): string {
  const d = parseCreatedAt(raw);
  return d
    ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`
    : "—";
}

export function MemoryView({ embedded = false }: { embedded?: boolean } = {}) {
  const [items, setItems] = useState<CoreMemoryItem[] | null>(null);
  const [scopes, setScopes] = useState<CoreMemoryScope[]>([]);
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  // Full-width tabs (Info list / Grafo / Wiki) so each gets the whole pane — the old
  // side-by-side list+graph squeezed the graph into a tiny column.
  const [memTab, setMemTab] = useState<"info" | "graph" | "wiki">("info");
  // Memory at-a-glance counts + export (moved here from the old "Dati" section).
  const [dashboard, setDashboard] = useState<CoreMemoryDashboard | null>(null);
  const [exporting, setExporting] = useState(false);

  const reload = () => {
    coreBridge
      .memoryItems()
      .then(({ items, scopes }) => {
        setItems(items);
        setScopes(scopes);
      })
      .catch(() => {
        setItems([]);
        setScopes([]);
      });
  };
  useEffect(() => {
    coreBridge.memoryDashboard().then(setDashboard).catch(() => setDashboard(null));
  }, []);

  const exportMemory = () => {
    setExporting(true);
    coreBridge
      .exportLocalData()
      .then((data) => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `homun-memoria-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      })
      .catch(() => {})
      .finally(() => setExporting(false));
  };
  useEffect(() => {
    reload();
  }, []);

  const all = items ?? [];
  // Selector from the server's scope list (includes folder-backed projects even
  // with zero memory, e.g. a code project), falling back to scopes seen in items.
  const workspaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of all) map.set(it.workspace_id, it.workspace_label);
    for (const s of scopes) map.set(s.workspace_id, s.workspace_label);
    return Array.from(map, ([id, label]) => ({ id, label }));
  }, [all, scopes]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(
      (it) =>
        (workspaceFilter === "all" || it.workspace_id === workspaceFilter) &&
        (typeFilter === "all" || it.memory_type === typeFilter) &&
        (!q || it.text.toLowerCase().includes(q)),
    );
  }, [all, workspaceFilter, typeFilter, search]);

  const timeline = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of filtered) {
      const month = monthKey(it.created_at);
      if (month) counts.set(month, (counts.get(month) || 0) + 1);
    }
    return Array.from(counts, ([month, count]) => ({ month, count })).sort((a, b) =>
      a.month < b.month ? 1 : -1,
    );
  }, [filtered]);
  const maxCount = Math.max(1, ...timeline.map((t) => t.count));

  const visible = useMemo(() => {
    const base = selectedMonth
      ? filtered.filter((it) => monthKey(it.created_at) === selectedMonth)
      : filtered;
    return [...base].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [filtered, selectedMonth]);

  const decide = (reference: string, action: "confirm" | "reject" | "delete") => {
    setBusy(true);
    coreBridge
      .decideMemory(reference, action)
      .then(reload)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const graphWorkspace = workspaceFilter !== "all" ? workspaceFilter : undefined;

  return (
    <div className="memview">
      <header className="memview-head">
        {!embedded && (
          <div className="memview-title">
            <Brain size={20} /> Memoria
          </div>
        )}
        <div className="memview-filters">
          <label className="set-select memview-select">
            <select
              value={workspaceFilter}
              onChange={(e) => {
                setWorkspaceFilter(e.target.value);
                setSelectedMonth(null);
              }}
            >
              <option value="all">Tutti i progetti</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="chev" />
          </label>
          <label className="set-select memview-select">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">Tutti i tipi</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="chev" />
          </label>
          <label className="memview-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca nella memoria…"
            />
          </label>
          <button
            type="button"
            className="set-btn memview-consolidate"
            disabled={consolidating}
            title={
              workspaceFilter === "all"
                ? "Fonde i frammenti ed elimina il rumore della memoria personale"
                : "Fonde i frammenti ed elimina il rumore per questo progetto"
            }
            onClick={() => {
              setConsolidating(true);
              setReport(null);
              coreBridge
                .consolidateMemory(workspaceFilter === "all" ? undefined : workspaceFilter)
                .then((r) => {
                  setReport(`Fusi ${r.merged} · rimossi ${r.dropped}`);
                  reload();
                })
                .catch(() => setReport("Consolidamento non riuscito"))
                .finally(() => setConsolidating(false));
            }}
          >
            <Sparkles size={13} />
            {consolidating ? "Consolido…" : "Consolida"}
          </button>
          {report && <span className="memview-report">{report}</span>}
          <button
            type="button"
            className="set-btn"
            disabled={exporting}
            title="Scarica memorie, entità e relazioni in un file JSON"
            onClick={exportMemory}
          >
            <Download size={13} />
            {exporting ? "Esporto…" : "Esporta"}
          </button>
        </div>
      </header>

      {dashboard && (
        <div className="set-stats memview-stats">
          <span>
            <strong>{dashboard.total_memories}</strong> memorie
          </span>
          <span className="sep">·</span>
          <span>
            <strong>{dashboard.total_entities}</strong> entità
          </span>
          <span className="sep">·</span>
          <span>
            <strong>{dashboard.total_relations}</strong> relazioni
          </span>
          <span className="sep">·</span>
          <span>
            <strong>{dashboard.total_wiki_pages}</strong> pagine wiki
          </span>
        </div>
      )}

      <div className="set-seg memview-tabs" role="tablist">
        {(
          [
            ["info", "Info"],
            ["graph", "Grafo"],
            ["wiki", "Wiki"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={memTab === key}
            className={`set-seg-item ${memTab === key ? "active" : ""}`}
            onClick={() => setMemTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {memTab === "info" && (
        <div className="memview-info">
          <div className="memview-timeline" role="group" aria-label="Timeline">
            {timeline.length === 0 ? (
              <span className="memview-empty">Nessuna informazione</span>
            ) : (
              timeline.map((t) => {
                const [y, mo] = t.month.split("-");
                const label = `${MONTHS[parseInt(mo, 10) - 1] ?? mo} ${y.slice(2)}`;
                return (
                  <button
                    key={t.month}
                    type="button"
                    className={`memview-bar ${selectedMonth === t.month ? "active" : ""}`}
                    onClick={() => setSelectedMonth(selectedMonth === t.month ? null : t.month)}
                    title={`${t.count} info · ${t.month}`}
                  >
                    <span className="memview-bar-count">{t.count}</span>
                    <span
                      className="memview-bar-fill"
                      style={{ height: `${Math.max(6, (t.count / maxCount) * 100)}%` }}
                    />
                    <span className="memview-bar-label">{label}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="memview-list-head">
            {visible.length} info{selectedMonth ? ` · ${selectedMonth}` : ""}
          </div>
          <div className="set-line-list memview-list">
            {visible.map((it) => (
              <div className="set-line-item memview-item" key={it.reference}>
                <span
                  className="set-dot memview-dot"
                  style={{ background: TYPE_COLORS[it.memory_type] ?? "#94a3b8" }}
                />
                <div className="memview-item-body">
                  <div className="memview-item-text">
                    {it.text}
                    {it.certainty === "considered" && (
                      <span className="set-tag amber memview-chip">valutato</span>
                    )}
                    {it.certainty === "intended" && (
                      <span className="set-tag brand memview-chip">intenzione</span>
                    )}
                  </div>
                  <div className="memview-item-meta">
                    {TYPE_LABELS[it.memory_type] ?? it.memory_type} · {it.workspace_label} ·{" "}
                    {dayLabel(it.created_at)}
                  </div>
                </div>
                <div className="memview-actions">
                  {it.status === "candidate" && (
                    <>
                      <button
                        type="button"
                        className="memview-confirm"
                        title="Conferma (da usare)"
                        disabled={busy}
                        onClick={() => decide(it.reference, "confirm")}
                      >
                        <Check size={15} />
                      </button>
                      <button
                        type="button"
                        className="memview-reject"
                        title="Rifiuta"
                        disabled={busy}
                        onClick={() => decide(it.reference, "reject")}
                      >
                        <X size={15} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="memview-del"
                    title="Elimina dalla memoria"
                    disabled={busy}
                    onClick={() => decide(it.reference, "delete")}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
            {visible.length === 0 && (
              <p className="memview-empty">Nessuna informazione per i filtri scelti.</p>
            )}
          </div>
        </div>
      )}

      {(memTab === "graph" || memTab === "wiki") && (
        <div className="memview-explore">
          {graphWorkspace ? (
            <MemoryGraphPanel
              workspace={graphWorkspace}
              controlledMode={memTab === "graph" ? "graph" : "wiki"}
            />
          ) : (
            <div className="memview-graph-hint">
              <Brain size={30} />
              <p>
                Seleziona un progetto per vedere il <strong>grafo</strong> e la <strong>wiki</strong>{" "}
                di come le informazioni si connettono — come un cervello.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
