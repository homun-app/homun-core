/** The same persisted materials consumed by the work's execution tools. */
import { useCallback, useEffect, useRef, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { getEngineMaterialContent, type EngineMaterial } from "@/lib/engine-projects-client";
import {
  archiveLibraryMaterial,
  loadEngineMaterialLibrary,
  uploadEngineMaterialFiles,
} from "@/lib/engine-material-library";
import { subscribeMaterialChanges, type MaterialFailure } from "@/lib/project-materials-lifecycle";
import { isHomunClientError } from "@/lib/homun-errors";
import { materialOptionLabel } from "@/lib/engine-material-selection";
import { ConversationSelectField } from "./ConversationSelect";
import { Search, FileText, Upload, FolderPlus, RefreshCw } from "lucide-react";
import "./engine-documents.css";
import "./engine-library.css";

type Project = { id: string; name: string };

export function EngineMaterials({ projects }: { projects: Project[] }) {
  const [materials, setMaterials] = useState<EngineMaterial[] | null>(null);
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [failures, setFailures] = useState<MaterialFailure[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const generation = useRef(0);
  const live = useRef(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const projectKey = JSON.stringify(projects.map((p) => p.id).sort());
  const targetProject = projects.some((p) => p.id === project) ? project : "";

  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const items = await loadEngineMaterialLibrary(JSON.parse(projectKey) as string[]);
      if (live.current && generation.current === current) {
        setMaterials(items);
        setError(null);
      }
    } catch (cause) {
      if (live.current && generation.current === current) {
        setMaterials(null);
        setOpened(null);
        setError(cause);
      }
    }
  }, [projectKey]);

  useEffect(() => {
    live.current = true;
    setMaterials(null);
    setOpened(null);
    const stop = subscribeMaterialChanges(() => {
      void reload();
    });
    void reload();
    return () => {
      live.current = false;
      stop();
    };
  }, [reload]);

  function invalidateDenied(cause: unknown) {
    if (isHomunClientError(cause) && ["permission_denied", "unauthorized"].includes(cause.code)) {
      generation.current++;
      setMaterials(null);
      setOpened(null);
      setArchiving(null);
      setError(cause);
    }
  }

  async function upload(selected: File[]) {
    if (!targetProject || !selected.length || busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    setFailures([]);
    try {
      const outcome = await uploadEngineMaterialFiles(targetProject, selected);
      if (live.current) {
        setFailures(outcome.failures);
        outcome.failures.forEach((failure) => invalidateDenied(failure.error));
        setNotice(
          `${outcome.addedIds.length - outcome.existing} file aggiunti · ${outcome.existing} già presenti · ${outcome.failed} non caricati.`,
        );
      }
    } catch (cause) {
      if (live.current) {
        setError(cause);
        invalidateDenied(cause);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function archive(material: EngineMaterial) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await archiveLibraryMaterial(material);
      if (live.current) {
        setOpened(null);
        setArchiving(null);
        setNotice("Materiale archiviato. Non sarà più proposto per nuovi lavori.");
      }
    } catch (cause) {
      if (live.current) {
        setError(cause);
        invalidateDenied(cause);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const visible = (materials ?? []).filter(
    (m) =>
      (!targetProject || m.project_id === targetProject) &&
      `${m.title} ${m.origin_name ?? ""} ${m.relative_path ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <section className="cw-workspace cw-documents cw-engine-library" aria-label="Materiali">
      <div className="section-label">
        MATERIALI DEI PROGETTI ({materials?.length ?? 0})
      </div>
      <p className="ph-card-subtitle" style={{ marginBottom: "16px" }}>
        I file dei tuoi progetti, disponibili anche nelle conversazioni e negli strumenti del
        lavoro.
      </p>
      <div className="cw-documents__filters">
        <label>
          <Search size={14} />
          <input
            aria-label="Cerca materiali"
            placeholder="Cerca nome o percorso…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <ConversationSelectField
          aria-label="Progetto dei materiali"
          value={targetProject}
          disabled={busy}
          onChange={(e) => {
            setProject(e.target.value);
            setOpened(null);
          }}
        >
          <option value="">Tutti i progetti</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </ConversationSelectField>
      </div>
      <div className="cs-actions" style={{ marginBottom: "16px" }}>
        <button
          type="button"
          className="ph-btn-promote"
          disabled={!targetProject || busy}
          onClick={() => files.current?.click()}
        >
          <Upload size={13} /> Aggiungi file
        </button>
        <button
          type="button"
          className="ph-btn-promote"
          disabled={!targetProject || busy}
          onClick={() => folder.current?.click()}
        >
          <FolderPlus size={13} /> Aggiungi cartella
        </button>
        <button type="button" className="cs-link" disabled={busy} onClick={() => void reload()}>
          <RefreshCw size={13} /> Aggiorna
        </button>
      </div>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(selected);
        }}
      />
      <input
        ref={folder}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: "" }}
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          e.target.value = "";
          void upload(selected);
        }}
      />
      {!projects.length ? (
        <p>Crea prima un progetto nelle impostazioni dello spazio per raccogliere i materiali.</p>
      ) : (
        !targetProject && (
          <p className="cw-hint">
            Scegli un progetto per aggiungere file. I lavori di quel progetto potranno selezionarli
            senza caricarli di nuovo.
          </p>
        )
      )}
      {busy && <p role="status">Salvataggio nel motore…</p>}
      {notice && <p role="status">{notice}</p>}
      {failures.map((failure, i) => (
        <div key={i}>
          <p>{failure.fileName}</p>
          <HomunErrorNotice error={failure.error} />
        </div>
      ))}
      <HomunErrorNotice error={error} />
      {materials === null && !error && <p role="status">Carico i materiali…</p>}
      {materials !== null && !visible.length && <p>Nessun materiale con questi filtri.</p>}
      <div className="cw-documents__list">
        {visible.map((material) => (
          <article className="cw-document" key={material.id}>
            <header>
              <FileText size={16} />
              <button
                className="cs-link"
                type="button"
                onClick={() => setOpened(opened === material.id ? null : material.id)}
              >
                {material.title}
              </button>
              <small>
                {projects.find((p) => p.id === material.project_id)?.name} ·{" "}
                {materialOptionLabel(material)}
              </small>
            </header>
            {material.relative_path && <p className="cw-hint">{material.relative_path}</p>}
            {opened === material.id && (
              <MaterialContent key={`${material.id}:${material.version}`} material={material} />
            )}
            {archiving === material.id ? (
              <div className="cs-actions">
                <span>Archiviare questo materiale?</span>
                <button
                  className="cw-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void archive(material)}
                >
                  Conferma archiviazione
                </button>
                <button
                  className="cs-link"
                  type="button"
                  disabled={busy}
                  onClick={() => setArchiving(null)}
                >
                  Annulla
                </button>
              </div>
            ) : (
              <button
                className="cs-link"
                type="button"
                disabled={busy}
                onClick={() => setArchiving(material.id)}
              >
                Archivia
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function MaterialContent({ material }: { material: EngineMaterial }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    getEngineMaterialContent({ materialId: material.id })
      .then((content) => {
        if (active)
          setText(content.text || "Nessun estratto testuale disponibile per questo file.");
      })
      .catch((cause) => {
        if (active) setError(cause);
      });
    return () => {
      active = false;
    };
  }, [material.id]);
  return (
    <>
      <HomunErrorNotice error={error} />
      {text === null && !error ? (
        <p role="status">Leggo il contenuto…</p>
      ) : (
        text !== null && <pre className="cw-document__content">{text}</pre>
      )}
    </>
  );
}
