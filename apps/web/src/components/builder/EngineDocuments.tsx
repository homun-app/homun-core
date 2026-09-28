/** Engine documents library: every reviewed result, searchable and downloadable. */
import { useEffect, useMemo, useState } from "react";
import type { EngineArtifact } from "@/lib/engine-domain-client";
import { listEngineArtifacts } from "@/lib/engine-domain-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationSelectField } from "./ConversationSelect";
import { FileText, Download, Search } from "lucide-react";
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
    <section className="cw-workspace cw-documents" aria-label={t("documents.title")}>
      <div className="section-label">
        {t("documents.title").toUpperCase()} ({docs?.length ?? 0})
      </div>
      <div className="cw-documents__filters">
        <label>
          <Search size={14} />
          <input
            aria-label={t("documents.search_placeholder")}
            placeholder={t("documents.search_placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <ConversationSelectField
          aria-label={t("documents.filter_project")}
          value={project}
          onChange={(event) => setProject(event.target.value)}
        >
          <option value="">{t("documents.filter_project")}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </ConversationSelectField>
      </div>
      {docs !== null && filtered.length === 0 && (
        <div className="homun-empty-state">
          <div className="homun-empty-state__icon">
            <FileText size={20} />
          </div>
          <h3 className="homun-empty-state__title">
            {docs.length === 0 ? "Nessun documento prodotto" : "Nessun documento trovato"}
          </h3>
          <p className="homun-empty-state__description">
            {docs.length === 0
              ? "I documenti e i report finali generati dagli agenti durante le conversazioni appariranno qui."
              : "Nessun documento corrisponde ai termini di ricerca impostati."}
          </p>
        </div>
      )}
      <div className="cw-documents__list">
        {filtered.map((doc) => (
          <article key={doc.id} className="cw-document" data-open={openId === doc.id}>
            <header>
              <FileText size={18} />
              <button type="button" className="cs-link" onClick={() => setOpenId(openId === doc.id ? null : doc.id)}>
                {doc.title}
              </button>
              <small>
                {doc.work_title} · {new Date(doc.created_at).toLocaleDateString("it-IT")}
              </small>
            </header>
            {openId === doc.id && (
              <>
                <pre className="cw-document__content">{doc.content}</pre>
                <button
                  type="button"
                  className="ph-btn-promote"
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([doc.content], { type: "text/markdown;charset=utf-8" }));
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = `${doc.title.replace(/[^\w\d-]+/g, "-").toLowerCase()}.md`;
                    anchor.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={14} /> Scarica
                </button>
              </>
            )}
          </article>
        ))}
      </div>
      <HomunErrorNotice error={error} />
    </section>
  );
}
