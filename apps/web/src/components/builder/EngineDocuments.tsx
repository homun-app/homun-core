/** Engine documents library: every reviewed result, searchable and downloadable. */
import { useEffect, useMemo, useState } from "react";
import type { EngineArtifact } from "@/lib/engine-domain-client";
import { listEngineArtifacts } from "@/lib/engine-domain-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { FileText, Download, Search, ArrowRight, X } from "lucide-react";
import { t } from "@/lib/i18n";
import "./engine-documents.css";

type ProjectOption = { id: string; name: string };

export function EngineDocuments({ projects }: { projects: ProjectOption[] }) {
  const [docs, setDocs] = useState<EngineArtifact[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listEngineArtifacts()
      .then((items) => { if (active) setDocs(items); })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const items = docs ?? [];
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((doc) => {
      if (project && doc.project_id !== project) return false;
      if (!needle) return true;
      return `${doc.title} ${doc.work_title} ${doc.content}`.toLocaleLowerCase().includes(needle);
    });
  }, [docs, query, project]);

  return (
    <section className="ph-body cw-documents-refined" aria-label={t("documents.title")}>
      <div className="ph-work-group">
        <div className="ph-doc-header-row">
          <div className="ph-work-group__label" style={{ margin: 0 }}>
            <FileText size={11} />
            <span>DOCUMENTI PRODOTTI</span>
            <span className="ph-work-group__count">{filtered.length}</span>
          </div>

          <div className="ph-doc-filters-minimal">
            <div className="ph-doc-search-box">
              <Search size={12} className="ph-doc-search-icon" />
              <input
                type="text"
                className="ph-doc-search-input"
                aria-label={t("documents.search_placeholder")}
                placeholder="Cerca..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="ph-doc-search-clear"
                  onClick={() => setQuery("")}
                  title="Azzera ricerca"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {projects.length > 0 && (
              <select
                className="ph-doc-select"
                aria-label={t("documents.filter_project")}
                value={project}
                onChange={(event) => setProject(event.target.value)}
              >
                <option value="">Tutti i progetti</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {docs !== null && filtered.length === 0 && (
          <div className="ph-overview-empty">
            <span>
              {docs.length === 0
                ? "Nessun documento prodotto. I documenti e i report finali generati dagli agenti appariranno qui."
                : "Nessun documento corrisponde ai termini di ricerca impostati."}
            </span>
          </div>
        )}

        <div className="ph-work-list">
          {filtered.map((doc) => {
            const isOpen = openId === doc.id;
            return (
              <div key={doc.id} className="ph-doc-item">
                <div
                  className="ph-work-row"
                  onClick={() => setOpenId(isOpen ? null : doc.id)}
                >
                  <div className="ph-work-row__left">
                    <span className="ph-work-row__dot" />
                    <div>
                      <div className="ph-work-row__title">{doc.title}</div>
                      <div className="ph-work-row__meta">
                        {doc.work_title} · {new Date(doc.created_at).toLocaleDateString("it-IT")}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button"
                      className="ph-doc-action-btn"
                      title="Scarica Markdown"
                      onClick={(e) => {
                        e.stopPropagation();
                        const url = URL.createObjectURL(
                          new Blob([doc.content], { type: "text/markdown;charset=utf-8" })
                        );
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = `${doc.title.replace(/[^\w\d-]+/g, "-").toLowerCase()}.md`;
                        anchor.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      <Download size={13} />
                    </button>
                    <span className="ph-work-row__action">
                      {isOpen ? "Chiudi" : "Apri"} <ArrowRight size={12} />
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div className="ph-doc-expanded-preview">
                    <pre className="ph-doc-content-pre">{doc.content}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <HomunErrorNotice error={error} />
    </section>
  );
}
