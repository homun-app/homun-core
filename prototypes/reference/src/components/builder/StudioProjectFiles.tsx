import { useRef, useState } from "react";
import { ChevronRight, FileText, Folder, FolderPlus, LockKeyhole, Upload, X } from "lucide-react";
import { addLocalFiles, effectiveFileAccess, type ProjectFile } from "@/lib/studio-files";
import type { ProjectGrant, SpaceUser } from "./StudioAccess";
export function StudioProjectFiles({
  items,
  onChange,
  users,
  grants,
  bots,
  members,
  onSharing,
}: {
  items: ProjectFile[];
  onChange: (items: ProjectFile[]) => void;
  users: SpaceUser[];
  grants: Record<string, ProjectGrant>;
  bots: { id: string; name: string }[];
  members: string[];
  onSharing: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const node = items.find((item) => item.id === selected);
  const principals = [
    ...users
      .filter((u) => u.role !== "owner")
      .map((u) => ({
        id: `person:${u.id}`,
        name: u.name,
        kind: "Persona",
        eligible:
          u.status === "active" && !!grants[u.id]?.documents && grants[u.id]?.level !== "none",
        reason:
          u.status !== "active"
            ? "Persona non attiva"
            : "Abilita documenti nella condivisione del progetto",
      })),
    ...bots.map((bot) => ({
      id: `bot:${bot.id}`,
      name: bot.name,
      kind: "Bot",
      eligible: members.includes(bot.id),
      reason: "Non partecipa al progetto",
    })),
  ];
  const eligible = principals.filter((p) => p.eligible).map((p) => p.id);
  const effective = node ? effectiveFileAccess(node.id, items, eligible) : [];
  const parentAccess = node?.parentId
    ? effectiveFileAccess(node.parentId, items, eligible)
    : eligible;
  const crumbs: ProjectFile[] = [];
  let current = items.find((i) => i.id === folderId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    crumbs.unshift(current);
    current = items.find((i) => i.id === current!.parentId);
  }
  function upload(files: File[]) {
    if (!files.length) return;
    onChange(addLocalFiles(items, folderId, files));
    setNotice(`${files.length} file aggiunti alla sessione locale. Nessun caricamento esterno.`);
  }
  function change(patch: Partial<ProjectFile>) {
    if (node) onChange(items.map((i) => (i.id === node.id ? { ...i, ...patch } : i)));
  }
  function create() {
    const name = folderName.trim();
    if (!name) return;
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setNotice("Usa un nome senza separatori di percorso.");
      return;
    }
    if (items.some((i) => i.parentId === folderId && i.name === name)) {
      setNotice("Questo nome è già presente nella cartella.");
      return;
    }
    onChange([
      ...items,
      {
        id: crypto.randomUUID(),
        parentId: folderId,
        name,
        kind: "folder",
        size: 0,
        access: "inherit",
        allowed: [],
      },
    ]);
    setCreating(false);
    setFolderName("");
    setNotice("Cartella creata. Eredita gli accessi della posizione corrente.");
  }
  return (
    <section className="st-paper st-project-section st-project-files">
      <div className="st-section-head" style={{ marginTop: 0 }}>
        <div>
          <h2>File e cartelle</h2>
          <p className="st-muted" style={{ marginTop: 8 }}>
            Materiali del progetto, con accessi per persone e bot.
          </p>
        </div>
        <div className="st-file-actions">
          <button
            className="st-btn"
            onClick={() => {
              setCreating(!creating);
              setNotice("");
            }}
          >
            <FolderPlus size={15} />
            Nuova cartella
          </button>
          <button className="st-btn" onClick={() => directoryInput.current?.click()}>
            <Folder size={15} />
            Importa cartella
          </button>
          <button className="st-btn dark" onClick={() => fileInput.current?.click()}>
            <Upload size={15} />
            Aggiungi file
          </button>
        </div>
      </div>
      <input
        className="sr-only"
        ref={fileInput}
        type="file"
        multiple
        aria-label="File da aggiungere al progetto"
        onChange={(e) => {
          upload(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <input
        className="sr-only"
        ref={directoryInput}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        aria-label="Cartella da importare nel progetto"
        onChange={(e) => {
          upload(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <div className="st-file-path">
        <button
          onClick={() => {
            setFolderId(null);
            setSelected(null);
          }}
        >
          Materiali
        </button>
        {crumbs.map((c) => (
          <span key={c.id}>
            <ChevronRight size={13} />
            <button
              onClick={() => {
                setFolderId(c.id);
                setSelected(null);
              }}
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>
      {creating && (
        <form
          className="st-folder-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <label>
            Nome cartella
            <input
              autoFocus
              required
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Es. Documenti riservati"
            />
          </label>
          <button className="st-btn dark">Crea cartella</button>
          <button type="button" className="st-btn" onClick={() => setCreating(false)}>
            Annulla
          </button>
        </form>
      )}
      {notice && (
        <p role="status" className="st-soft-note">
          {notice}
        </p>
      )}
      <div className="st-files-layout">
        <div className="st-files-list">
          {items
            .filter((i) => i.parentId === folderId)
            .sort((a, b) =>
              a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
            )
            .map((item) => (
              <div className="st-file-row" key={item.id}>
                <button
                  className="st-file-name"
                  onClick={() => {
                    if (item.kind === "folder") {
                      setFolderId(item.id);
                      setSelected(null);
                    } else setSelected(item.id);
                  }}
                >
                  {item.kind === "folder" ? <Folder size={20} /> : <FileText size={20} />}
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.kind === "folder"
                        ? `${items.filter((i) => i.parentId === item.id).length} elementi`
                        : `${Math.max(1, Math.ceil(item.size / 1024))} KB · file locale`}
                    </small>
                  </span>
                </button>
                <button
                  className="st-file-permissions"
                  aria-label={`Accessi a ${item.name}`}
                  onClick={() => setSelected(item.id)}
                >
                  <LockKeyhole size={14} />
                  {item.access === "restricted" ? "Limitati" : "Ereditati"}
                </button>
              </div>
            ))}
          {!items.some((i) => i.parentId === folderId) && (
            <div className="st-empty">
              <Folder size={28} />
              <h3 style={{ marginTop: 16 }}>Questa cartella è vuota.</h3>
              <p>Aggiungi i file che servono alla squadra.</p>
            </div>
          )}
        </div>
        {node && (
          <aside className="st-file-access">
            <div className="st-section-head" style={{ marginTop: 0 }}>
              <h3>Accessi al {node.kind === "folder" ? "contenuto" : "file"}</h3>
              <button aria-label="Chiudi accessi file" onClick={() => setSelected(null)}>
                <X size={16} />
              </button>
            </div>
            <p className="st-file-selected">{node.name}</p>
            <label>
              Modalità di accesso
              <select
                value={node.access}
                onChange={(e) =>
                  change({
                    access: e.target.value as ProjectFile["access"],
                    allowed: e.target.value === "restricted" ? effective : [],
                  })
                }
              >
                <option value="inherit">
                  Eredita da {node.parentId ? "cartella" : "progetto"}
                </option>
                <option value="restricted">Limita a persone e bot scelti</option>
              </select>
            </label>
            <p className="st-muted">
              Il proprietario mantiene l’accesso. Un elemento può restringere gli accessi, senza
              ampliare quelli della cartella o del progetto.
            </p>
            <div className="st-file-principals">
              {principals.map((p) => (
                <label key={p.id}>
                  <input
                    type="checkbox"
                    checked={effective.includes(p.id)}
                    disabled={node.access === "inherit" || !parentAccess.includes(p.id)}
                    onChange={(e) =>
                      change({
                        allowed: e.target.checked
                          ? [...node.allowed, p.id]
                          : node.allowed.filter((id) => id !== p.id),
                      })
                    }
                  />
                  <span>
                    {p.name}
                    <small>
                      {p.kind} ·{" "}
                      {!p.eligible
                        ? p.reason
                        : !parentAccess.includes(p.id)
                          ? "Escluso dalla cartella superiore"
                          : effective.includes(p.id)
                            ? "Può accedere"
                            : "Nessun accesso"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <button className="st-text-link" onClick={onSharing}>
              Gestisci condivisione del progetto <ChevronRight size={13} />
            </button>
            <p className="st-muted" style={{ marginTop: 16 }}>
              {node.kind === "folder" ? "Le restrizioni si applicano anche ai discendenti. " : ""}
              Configurazione demo: il motore dovrà applicare queste regole a lettura, ricerca e uso
              da parte dei bot.
            </p>
          </aside>
        )}
      </div>
      <p className="st-muted" style={{ marginTop: 18 }}>
        File mantenuti nella memoria di questa pagina fino al ricaricamento. Nessun contenuto viene
        inviato, indicizzato o elaborato. Importare una cartella non crea una sincronizzazione con
        il disco.
      </p>
    </section>
  );
}
