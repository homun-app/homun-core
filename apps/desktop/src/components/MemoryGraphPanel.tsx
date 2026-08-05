import { GitMerge, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ForceGraph2D from "react-force-graph-2d";
import {
  coreBridge,
  type AppEvent,
  type MemoryGraph,
  type MemoryGraphNode,
  type MemoryHygieneSuggestion,
  type MemoryWikiPage,
  type ProjectSubdir,
} from "../lib/coreBridge";
import { wsSubscription } from "../lib/wsSubscription";
import { MarkdownEditor } from "./MarkdownEditor";
import { RichMessage } from "./RichMessage";

// Navigable visual graph of the project's memory: project at the centre, decisions
// linked to the files they affect and the alternatives they rejected, plus facts and
// preferences. Rendered with react-force-graph-2d (canvas + continuous d3-force):
// zoom/pan/drag, hover highlights neighbours, click inspects. Data from /api/memory/graph.
const GRAPH_KIND_STYLE: Record<string, { fill: string; r: number; label: string }> = {
  project: { fill: "#6366f1", r: 16, label: "Space" },
  decision: { fill: "#0ea5e9", r: 11, label: "Decision" },
  file: { fill: "#10b981", r: 8, label: "File" },
  alternative: { fill: "#fb7185", r: 7, label: "Rejected alternative" },
  fact: { fill: "#f59e0b", r: 8, label: "Fact" },
  preference: { fill: "#a78bfa", r: 8, label: "Preference" },
  wiki: { fill: "#0d9488", r: 10, label: "Wiki page" },
  entity: { fill: "#94a3b8", r: 8, label: "Entity" },
  // Entity ontology (G1): one colour per type so the personal graph reads at a
  // glance - people pink, organizations teal, events orange, places green...
  "entity:person": { fill: "#ec4899", r: 9, label: "Person" },
  "entity:organization": { fill: "#14b8a6", r: 8, label: "Organization" },
  "entity:place": { fill: "#84cc16", r: 8, label: "Place" },
  "entity:event": { fill: "#f97316", r: 9, label: "Event" },
  "entity:topic": { fill: "#eab308", r: 8, label: "Interest" },
  "entity:tool": { fill: "#64748b", r: 7, label: "Tool" },
  "entity:project": { fill: "#818cf8", r: 8, label: "Project" },
  // Code graph (project map): functions/methods, files, docs, rationale.
  "entity:code_symbol": { fill: "#0ea5e9", r: 7, label: "Function" },
  "entity:code_file": { fill: "#10b981", r: 9, label: "File" },
  "entity:code_doc": { fill: "#94a3b8", r: 7, label: "Document" },
  "entity:code_rationale": { fill: "#a78bfa", r: 7, label: "Note" },
};

function graphStyleKey(node: { kind: string; entity_type?: string }): string {
  if (node.kind === "entity" && node.entity_type) {
    const key = `entity:${node.entity_type}`;
    if (GRAPH_KIND_STYLE[key]) return key;
  }
  return node.kind;
}

export function MemoryGraphPanel({
  threadId,
  workspace,
  controlledMode,
  layoutSignal,
}: {
  threadId?: string;
  workspace?: string;
  /** When set, the parent drives graph/wiki (top-level tabs) and the internal
   *  toggle is hidden. */
  controlledMode?: "graph" | "wiki";
  /** External geometry signal from the Workbench shell (fullscreen / dock width). */
  layoutSignal?: string;
}) {
  const { t } = useTranslation();
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeFirst, setMergeFirst] = useState<string | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{
    survivor: MemoryGraphNode;
    absorbed: MemoryGraphNode;
    reason: string;
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const [hygieneSuggestions, setHygieneSuggestions] = useState<MemoryHygieneSuggestion[]>([]);
  const [ignoredSuggestionKeys, setIgnoredSuggestionKeys] = useState<Set<string>>(new Set());
  const [buildingGraph, setBuildingGraph] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [subdirs, setSubdirs] = useState<ProjectSubdir[]>([]);
  const [internalMode, setInternalMode] = useState<"graph" | "wiki">("graph");
  const mode = controlledMode ?? internalMode;
  const setMode = setInternalMode;
  const [wiki, setWiki] = useState<MemoryWikiPage[] | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingWiki, setSavingWiki] = useState(false);
  // viewBox tracks the container's pixel size (centred at origin) so the graph FILLS
  // the panel and adapts when it's expanded/fullscreen - no fixed-aspect letterboxing.
  const [size, setSize] = useState({ w: 760, h: 600 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // react-force-graph imperative handle (zoom / zoomToFit / centerAt).
  const fgRef = useRef<any>(null);
  // Theme-aware node-label colour, captured from the panel's computed style.
  const labelColorRef = useRef<string>("#1e293b");

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Canvas can't use CSS vars: capture the panel's inherited text colour so node
    // labels stay legible in both light and dark themes.
    labelColorRef.current = getComputedStyle(el).color || "#1e293b";
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mode === "wiki" && wiki === null) {
      coreBridge
        .memoryWiki(threadId, workspace)
        .then(setWiki)
        .catch(() => setWiki([]));
    }
  }, [mode, wiki, threadId, workspace]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    // Reset the wiki too so it RE-loads for the new scope: its load is guarded by
    // `wiki === null`, so without this, switching workspace kept the stale (often
    // empty) wiki - the "0 pagine" bug even when the project has decisions.
    setWiki(null);
    coreBridge
      .memoryGraph(threadId, workspace)
      .then((g) => {
        setGraph(g);
        setMergeFirst(null);
        return coreBridge
          .memoryHygieneSuggestions(threadId, workspace)
          .then(setHygieneSuggestions)
          .catch(() => setHygieneSuggestions([]));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [threadId, workspace]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!graph?.workspace) return;
    try {
      const raw = window.localStorage.getItem(`homun.memory.ignore.${graph.workspace}`);
      setIgnoredSuggestionKeys(new Set(raw ? JSON.parse(raw) : []));
    } catch {
      setIgnoredSuggestionKeys(new Set());
    }
  }, [graph?.workspace]);

  // Transparent project map: on opening a project graph, ensure its code map is
  // fresh (built behind the scenes if missing/stale). Show a neutral "building"
  // state and reload when the gateway signals the graph is ready. Never "Graphify".
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    setTooLarge(false);
    setSubdirs([]);
    coreBridge
      .ensureProjectGraph(workspace)
      .then((building) => {
        if (active) setBuildingGraph(building);
      })
      .catch(() => {});
    // One event transport: project_graph.* rides the unified WS, wrapped by the gateway
    // in an `app.event` envelope (publish_app_event is the single producer - it fans the
    // very same event to the WS registry and to the legacy NDJSON channel, so nothing is
    // lost by dropping the latter). The socket is a process-lifetime singleton connected
    // by App at boot; here we only add and drop a handler, never touch the connection.
    const unsubscribe = wsSubscription.subscribe((msg) => {
      if (msg.type !== "app.event") return;
      const event = msg.event as AppEvent;
      if (event.workspace !== workspace) return;
      if (event.type === "project_graph.ready") {
        setBuildingGraph(false);
        setTooLarge(false);
        reload();
      } else if (event.type === "project_graph.too_large") {
        // Huge repo: don't auto-map - offer to map a subfolder instead.
        setBuildingGraph(false);
        setTooLarge(true);
        coreBridge.projectGraphSubdirs(workspace).then((s) => {
          if (active) setSubdirs(s);
        });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspace, reload]);

  // Map a chosen subtree of a huge repo, then show the building state.
  const mapSubdir = (name: string) => {
    if (!workspace) return;
    setTooLarge(false);
    setBuildingGraph(true);
    coreBridge.ensureProjectGraph(workspace, name).catch(() => {});
  };

  // Lookups + force-graph data. react-force-graph owns the layout (continuous
  // d3-force): we hand it nodes (colour/size by ontology) and links, and it settles
  // them, supporting zoom/pan/drag natively. graphData is rebuilt only when the graph
  // changes (so node positions persist across hover/select state changes).
  const nodeById = useMemo(() => {
    const map = new Map<string, MemoryGraphNode>();
    if (graph) for (const node of graph.nodes) map.set(node.id, node);
    return map;
  }, [graph]);
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (graph)
      for (const e of graph.edges) {
        map.set(e.source, (map.get(e.source) ?? new Set()).add(e.target));
        map.set(e.target, (map.get(e.target) ?? new Set()).add(e.source));
      }
    return map;
  }, [graph]);
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    return {
      nodes: graph.nodes.map((n) => {
        const style = GRAPH_KIND_STYLE[graphStyleKey(n)] ?? GRAPH_KIND_STYLE.entity;
        const isRoot = n.kind === "project";
        const deg = degree.get(n.id) ?? 0;
        return {
          id: n.id,
          label: n.label,
          kind: n.kind,
          color: style.fill,
          // Node AREA scales with connections: hubs (many edges) read big, isolated
          // facts stay small. The scope root is the biggest and pinned at centre.
          val: isRoot ? 9 : 1 + deg * 0.7,
          // Anchor the root at the origin so everything orbits it (hub-and-spoke).
          ...(isRoot ? { fx: 0, fy: 0 } : {}),
        };
      }),
      links: graph.edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
    };
  }, [graph]);

  const fitMemoryGraph = useCallback(
    (duration = 320, padding = 44, options: { reheat?: boolean } = {}) => {
      const graphApi = fgRef.current;
      if (!graphApi || mode !== "graph") return;
      if (options.reheat) graphApi.d3ReheatSimulation?.();
      graphApi.zoomToFit?.(duration, padding);
    },
    [mode],
  );

  useEffect(() => {
    const graphApi = fgRef.current;
    if (!graphApi || mode !== "graph") return;
    const linkForce = graphApi.d3Force?.("link");
    linkForce?.distance?.((link: any) => (link.label === "nel progetto" ? 48 : 34));
    linkForce?.strength?.((link: any) => (link.label === "nel progetto" ? 0.95 : 0.72));
    graphApi.d3Force?.("charge")?.strength?.(-46);
    graphApi.d3ReheatSimulation?.();
  }, [graphData, mode]);

  useEffect(() => {
    if (mode !== "graph" || !graph || size.w <= 0 || size.h <= 0) return undefined;
    let firstFrame = 0;
    let secondFrame = 0;
    const resizeFitTimer = window.setTimeout(() => {
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(() => {
          fitMemoryGraph(360, 44, { reheat: true });
        });
      });
    }, 100);
    return () => {
      window.clearTimeout(resizeFitTimer);
      if (firstFrame) window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [fitMemoryGraph, graph, layoutSignal, mode, size.h, size.w]);

  const selectedNode = selected ? nodeById.get(selected) ?? null : null;
  const relationCountFor = (nodeId: string) =>
    graph?.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId).length ?? 0;
  const suggestionKey = (suggestion: MemoryHygieneSuggestion) =>
    `${suggestion.survivor_ref}|${suggestion.absorbed_ref}`;
  const visibleHygieneSuggestions = hygieneSuggestions.filter(
    (suggestion) => !ignoredSuggestionKeys.has(suggestionKey(suggestion)),
  );
  const ignoreSuggestion = (suggestion: MemoryHygieneSuggestion, persist: boolean) => {
    const key = suggestionKey(suggestion);
    setIgnoredSuggestionKeys((current) => {
      const next = new Set(current);
      next.add(key);
      if (persist && graph?.workspace) {
        window.localStorage.setItem(
          `homun.memory.ignore.${graph.workspace}`,
          JSON.stringify([...next]),
        );
      }
      return next;
    });
  };
  const isMergeableNode = (
    node: MemoryGraphNode | null | undefined,
  ): node is MemoryGraphNode => node?.kind === "entity" && node.id.startsWith("entity:");
  const proposeMerge = useCallback(
    (survivorId: string, absorbedId: string, reason: string) => {
      if (survivorId === absorbedId) return;
      const survivor = nodeById.get(survivorId);
      const absorbed = nodeById.get(absorbedId);
      if (!isMergeableNode(survivor) || !isMergeableNode(absorbed)) return;
      setPendingMerge({ survivor, absorbed, reason });
    },
    [nodeById],
  );
  const confirmMerge = useCallback(() => {
    if (!pendingMerge) return;
    setMerging(true);
    coreBridge
      .mergeMemoryEntities(
        pendingMerge.survivor.id,
        pendingMerge.absorbed.id,
        pendingMerge.reason,
      )
      .then(() => {
        setPendingMerge(null);
        setMergeFirst(null);
        setSelected(null);
        setWiki(null);
        reload();
      })
      .catch((error) => setError(String(error)))
      .finally(() => setMerging(false));
  }, [pendingMerge, reload]);
  const selectedEdges = useMemo(() => {
    if (!graph || !selected) return [];
    return graph.edges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => {
        const otherId = e.source === selected ? e.target : e.source;
        return { label: e.label, other: nodeById.get(otherId)?.label ?? otherId };
      });
  }, [graph, selected, nodeById]);

  if (loading) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>{t("chat.loadingMemory")}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} />
        <p>Memory unavailable: {error}</p>
        <button type="button" className="ghost-button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }
  if (tooLarge && (!graph || graph.nodes.length <= 1)) {
    return (
      <div className="workbench-empty project-map-picker">
        <Share2 size={28} />
        <p>{t("chat.largeProjectPickFolder")}</p>
        {subdirs.length === 0 ? (
          <p className="muted">{t("chat.noCodeSubfolders")}</p>
        ) : (
          <div className="project-map-subdirs">
            {subdirs.slice(0, 24).map((s) => (
              <button key={s.name} className="project-map-subdir" onClick={() => mapSubdir(s.name)}>
                <span className="name">{s.name}</span>
                <span className="count">{s.code_files} file</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (!graph || graph.nodes.length <= 1) {
    return (
      <div className="workbench-empty">
        <Share2 size={28} className={buildingGraph ? "spin" : undefined} />
        <p>
          {buildingGraph
            ? t("chat.mappingProject")
            : t("chat.noMemoryForProject")}
        </p>
      </div>
    );
  }

  return (
    <div className="memory-graph">
      <div className="memory-graph-toolbar">
        {!controlledMode && (
          <div className="memory-graph-modes">
            <button type="button" className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
              {t("chat.graph")}
            </button>
            <button type="button" className={mode === "wiki" ? "active" : ""} onClick={() => setMode("wiki")}>
              {t("chat.wiki")}
            </button>
          </div>
        )}
        <span className="memory-graph-count">
          {mode === "graph"
            ? t("chat.graphCount", { nodes: graph.nodes.length, edges: graph.edges.length })
            : t("chat.wikiPagesCount", { count: wiki?.length ?? 0 })}
        </span>
        {mode === "graph" && (
          <div className="memory-graph-zoom">
            <button
              type="button"
              className={mergeMode ? "active" : ""}
              onClick={() => {
                setMergeMode((value) => !value);
                setMergeFirst(null);
              }}
              aria-label="Merge entities"
              title="Merge entities"
            >
              <GitMerge size={14} />
            </button>
            <button type="button" onClick={() => fgRef.current?.zoom((fgRef.current?.zoom() ?? 1) * 1.3, 300)} aria-label="Zoom +">
              +
            </button>
            <button type="button" onClick={() => fgRef.current?.zoom((fgRef.current?.zoom() ?? 1) * 0.77, 300)} aria-label="Zoom -">
              -
            </button>
            <button type="button" onClick={() => fitMemoryGraph(400, 50)} aria-label={t("chat.fitToView")}>
              ⟲
            </button>
          </div>
        )}
      </div>
      {mode === "wiki" ? (
        <div className="memory-wiki">
          {wiki === null ? (
            <p className="memory-wiki-empty">{t("chat.loadingWiki")}</p>
          ) : wiki.length === 0 ? (
            <p className="memory-wiki-empty">{t("chat.noWikiPagesYet")}</p>
          ) : (
            wiki.map((page) =>
              editingPath === page.path ? (
                <article className="memory-wiki-page" key={page.path}>
                  <MarkdownEditor value={editBody} onChange={setEditBody} />
                  <div className="memory-wiki-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={savingWiki}
                      onClick={() => {
                        setSavingWiki(true);
                        coreBridge
                          .saveMemoryWiki({ thread: threadId, workspace }, page.path, editBody)
                          .then(() => {
                            setEditingPath(null);
                            setWiki(null);
                          })
                          .catch(() => {})
                          .finally(() => setSavingWiki(false));
                      }}
                    >
                      {savingWiki ? t("chat.saving") : t("common.save")}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setEditingPath(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </article>
              ) : (
                <article className="memory-wiki-page" key={page.path}>
                  <div className="memory-wiki-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setEditingPath(page.path);
                        setEditBody(page.body);
                      }}
                    >
                      {t("common.edit")}
                    </button>
                  </div>
                  <RichMessage text={page.body} />
                </article>
              ),
            )
          )}
        </div>
      ) : (
        <>
          {(mergeMode || visibleHygieneSuggestions.length > 0) && (
            <div className="memory-hygiene-panel">
              {mergeMode && (
                <span className="memory-hygiene-status">
                  <GitMerge size={14} />
                  {mergeFirst
                    ? `Selected: ${nodeById.get(mergeFirst)?.label ?? "entity"}`
                    : "Merge mode"}
                </span>
              )}
              {visibleHygieneSuggestions.slice(0, 4).map((suggestion) => (
                <span
                  key={`${suggestion.survivor_ref}-${suggestion.absorbed_ref}`}
                  className="memory-hygiene-suggestion"
                >
                  <button
                    type="button"
                    onClick={() =>
                      proposeMerge(
                        suggestion.survivor_ref,
                        suggestion.absorbed_ref,
                        suggestion.reason,
                      )
                    }
                  >
                    <GitMerge size={13} />
                    {suggestion.survivor_label} ← {suggestion.absorbed_label}
                  </button>
                  {suggestion.safe_auto_merge && <strong>safe</strong>}
                  <button type="button" onClick={() => ignoreSuggestion(suggestion, false)}>
                    Ignore
                  </button>
                  <button type="button" onClick={() => ignoreSuggestion(suggestion, true)}>
                    Never
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="memory-graph-canvas" ref={canvasRef}>
            {graph?.truncated && (
              <div className="memory-graph-truncated">
                {t("chat.graphTruncated", {
                  shown: graph.nodes.length.toLocaleString("en-US"),
                  total: (graph.total_nodes ?? graph.nodes.length).toLocaleString("en-US"),
                })}
              </div>
            )}
            <ForceGraph2D
              ref={fgRef}
              width={size.w}
              height={size.h}
              graphData={graphData}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={4}
              nodeVal={(n: any) => n.val}
              cooldownTicks={140}
              onEngineStop={() => fitMemoryGraph(400, 60)}
              onNodeClick={(n: any) => {
                if (mergeMode) {
                  const node = nodeById.get(n.id);
                  if (!isMergeableNode(node)) return;
                  if (!mergeFirst) {
                    setMergeFirst(n.id);
                    setSelected(n.id);
                    return;
                  }
                  proposeMerge(mergeFirst, n.id, "merged from graph selection");
                  return;
                }
                setSelected(n.id);
                // Focus: centre + zoom onto the clicked node and its neighbourhood.
                if (typeof n.x === "number" && typeof n.y === "number") {
                  fgRef.current?.centerAt(n.x, n.y, 600);
                  fgRef.current?.zoom(2.4, 600);
                }
              }}
              onNodeDragEnd={(n: any) => {
                if (!mergeMode || typeof n.x !== "number" || typeof n.y !== "number") return;
                const nodes = fgRef.current?.graphData?.().nodes ?? [];
                let nearest: { id: string; d: number } | null = null;
                for (const candidate of nodes) {
                  if (candidate.id === n.id) continue;
                  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") continue;
                  const dx = candidate.x - n.x;
                  const dy = candidate.y - n.y;
                  const d = dx * dx + dy * dy;
                  if (!nearest || d < nearest.d) nearest = { id: candidate.id, d };
                }
                if (nearest && nearest.d < 900) {
                  proposeMerge(nearest.id, n.id, "merged by graph drag");
                }
              }}
              onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
              onBackgroundClick={() => setSelected(null)}
              linkDirectionalParticles={(l: any) => {
                const s = typeof l.source === "object" ? l.source.id : l.source;
                const t = typeof l.target === "object" ? l.target.id : l.target;
                return hoverId && (s === hoverId || t === hoverId) ? 4 : 0;
              }}
              linkDirectionalParticleWidth={2.2}
              linkDirectionalParticleSpeed={0.006}
              nodeColor={(n: any) => {
                if (!hoverId) return n.color;
                if (n.id === hoverId || neighbors.get(hoverId)?.has(n.id)) return n.color;
                return "rgba(148,163,184,0.22)";
              }}
              linkColor={(l: any) => {
                const s = typeof l.source === "object" ? l.source.id : l.source;
                const t = typeof l.target === "object" ? l.target.id : l.target;
                const active =
                  (hoverId && (s === hoverId || t === hoverId)) ||
                  (selected && (s === selected || t === selected));
                if (active) return "#475569";
                return hoverId ? "rgba(203,213,225,0.18)" : "#cbd5e1";
              }}
              linkWidth={(l: any) => {
                const s = typeof l.source === "object" ? l.source.id : l.source;
                const t = typeof l.target === "object" ? l.target.id : l.target;
                return (hoverId && (s === hoverId || t === hoverId)) ||
                  (selected && (s === selected || t === selected))
                  ? 1.8
                  : 0.7;
              }}
              linkLineDash={(l: any) => (l.label === "scartata" ? [4, 3] : null)}
              nodeCanvasObjectMode={() => "after"}
              nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                // Label only the hubs and the hovered/selected node, so the canvas stays
                // legible instead of a wall of overlapping text.
                const important = node.kind === "project" || node.id === selected || node.id === hoverId;
                if (!important) return;
                const text = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
                const fontSize = 12 / globalScale;
                ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillStyle = labelColorRef.current;
                // Offset past the node's radius (radius = sqrt(val) * nodeRelSize).
                const off = (Math.sqrt(node.val ?? 1) * 4 + 3) / globalScale;
                ctx.fillText(text, node.x + off, node.y);
              }}
            />
            {selectedNode && (
              <div className="memory-graph-detail">
                <div
                  className="memory-graph-detail-kind"
                  style={{ color: GRAPH_KIND_STYLE[graphStyleKey(selectedNode)]?.fill }}
                >
                  {GRAPH_KIND_STYLE[graphStyleKey(selectedNode)]?.label ?? selectedNode.kind}
                </div>
                <div className="memory-graph-detail-title">{selectedNode.label}</div>
                {selectedNode.detail && <p className="memory-graph-detail-body">{selectedNode.detail}</p>}
                {selectedEdges.length > 0 && (
                  <ul className="memory-graph-detail-links">
                    {selectedEdges.map((link, i) => (
                      <li key={i}>
                        <span className="memory-graph-link-label">{link.label}</span> {link.other}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="memory-graph-detail-actions">
                  {["decision", "fact", "preference", "entity"].includes(selectedNode.kind) && (
                    <button
                      type="button"
                      className="ghost-button danger"
                      onClick={() => {
                        coreBridge
                          .decideMemory(selectedNode.id, "delete")
                          .then(() => {
                            setSelected(null);
                            setWiki(null);
                            reload();
                          })
                          .catch(() => {});
                      }}
                    >
                      {t("chat.deleteFromMemory")}
                    </button>
                  )}
                  <button type="button" className="ghost-button" onClick={() => setSelected(null)}>
                    {t("common.close")}
                  </button>
                </div>
              </div>
            )}
            {pendingMerge && (
              <div className="memory-graph-detail memory-merge-preview">
                <div className="memory-graph-detail-kind">
                  <GitMerge size={14} /> Merge
                </div>
                <div className="memory-graph-detail-title">
                  {pendingMerge.survivor.label} ← {pendingMerge.absorbed.label}
                </div>
                <p className="memory-graph-detail-body">
                  {pendingMerge.reason}
                  {pendingMerge.survivor.detail ? `\n${pendingMerge.survivor.detail}` : ""}
                  {pendingMerge.absorbed.detail ? `\n${pendingMerge.absorbed.detail}` : ""}
                  {`\n${relationCountFor(pendingMerge.survivor.id)} + ${relationCountFor(
                    pendingMerge.absorbed.id,
                  )} links`}
                </p>
                <div className="memory-graph-detail-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={merging}
                    onClick={confirmMerge}
                  >
                    {merging ? "Merging..." : "Merge"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={merging}
                    onClick={() => setPendingMerge(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="memory-graph-legend">
            {[
              "decision",
              "fact",
              "preference",
              "wiki",
              "entity:person",
              "entity:organization",
              "entity:place",
              "entity:event",
              "entity:topic",
            ].map((kind) => (
              <span key={kind}>
                <i style={{ background: GRAPH_KIND_STYLE[kind].fill }} />
                {GRAPH_KIND_STYLE[kind].label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
