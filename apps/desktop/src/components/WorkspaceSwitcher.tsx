import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FolderPlus,
  Layers,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  coreBridge,
  type WorkspaceRecord,
  type WorkspacesSnapshot,
} from "../lib/coreBridge";

// The base personal workspace ("Predefinito"): always present, can't be deleted.
const BASE_WORKSPACE_ID = "local-workspace";

// A project (workspace) is the isolation boundary: switching it re-scopes tasks,
// memory, capabilities and connected accounts (ADR 0009). Because every view
// caches data for the active workspace, the simplest correct way to apply a
// switch app-wide is a full reload after the gateway flips the active id.
export function WorkspaceSwitcher() {
  const [snapshot, setSnapshot] = useState<WorkspacesSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    coreBridge
      .workspaces()
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch(() => {
        // gateway offline — switcher stays hidden rather than showing a stub
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setCreating(false);
        setEditingId(null);
      }
    }
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!snapshot) return null;

  const active =
    snapshot.workspaces.find((w) => w.id === snapshot.active_workspace_id) ??
    ({ id: snapshot.active_workspace_id, name: "Progetto" } as WorkspaceRecord);

  async function handleSelect(id: string) {
    if (id === snapshot?.active_workspace_id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await coreBridge.selectWorkspace(id);
      window.location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // Create needs only a name — a folder is optional (like the existing projects)
  // and can be linked later. No surprise native dialog on the critical path.
  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const snap = await coreBridge.createWorkspace(name, "");
      const created = snap.workspaces.find((w) => w.name === name);
      if (created) {
        await coreBridge.selectWorkspace(created.id);
        window.location.reload();
      } else {
        setSnapshot(snap);
        setCreating(false);
        setNewName("");
        setBusy(false);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function handleRename(id: string) {
    const name = editName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await coreBridge.renameWorkspace(id, name));
      setEditingId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLinkFolder(id: string) {
    const folder = await coreBridge.pickFolder();
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await coreBridge.setWorkspaceFolder(id, folder));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    setError(null);
    try {
      const snap = await coreBridge.deleteWorkspace(id);
      // Deleting the active project re-scopes the whole app → reload.
      if (id === snapshot?.active_workspace_id) {
        window.location.reload();
        return;
      }
      setSnapshot(snap);
      setEditingId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-switcher" ref={containerRef}>
      <button
        className="workspace-switcher-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <Layers size={16} />
        <span className="workspace-switcher-name">{active.name}</span>
        {busy ? <Loader2 size={15} className="spin" /> : <ChevronDown size={15} />}
      </button>

      {open && (
        <div className="workspace-switcher-menu" role="listbox">
          {snapshot.workspaces.map((workspace) => {
            const isActive = workspace.id === snapshot.active_workspace_id;
            const isBase = workspace.id === BASE_WORKSPACE_ID;
            const isEditing = editingId === workspace.id;
            return (
              <div key={workspace.id} className="workspace-switcher-row">
                {isEditing ? (
                  <div className="workspace-switcher-edit">
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRename(workspace.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <div className="workspace-switcher-edit-actions">
                      <button
                        className="link-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void handleLinkFolder(workspace.id)}
                        title={workspace.folder ?? "Nessuna cartella collegata"}
                      >
                        {workspace.folder ? "Cambia cartella" : "Collega cartella"}
                      </button>
                      {!isBase && (
                        <button
                          className="link-button danger"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDelete(workspace.id)}
                        >
                          Elimina
                        </button>
                      )}
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy || !editName.trim()}
                        onClick={() => void handleRename(workspace.id)}
                      >
                        Salva
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      className="workspace-switcher-item"
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => void handleSelect(workspace.id)}
                    >
                      <span>{workspace.name}</span>
                      {isActive && <Check size={15} />}
                    </button>
                    <button
                      className="workspace-switcher-edit-btn"
                      type="button"
                      aria-label={`Modifica ${workspace.name}`}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(workspace.id);
                        setEditName(workspace.name);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {error && (
            <p className="workspace-switcher-error" role="alert">
              {error}
            </p>
          )}

          {creating ? (
            <div className="workspace-switcher-create">
              <input
                autoFocus
                placeholder="Nome progetto"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              <button
                className="primary-button"
                type="button"
                disabled={busy || !newName.trim()}
                onClick={() => void handleCreate()}
              >
                Crea
              </button>
            </div>
          ) : (
            <button
              className="workspace-switcher-item workspace-switcher-new"
              type="button"
              onClick={() => {
                setCreating(true);
                setEditingId(null);
              }}
            >
              <FolderPlus size={15} />
              <span>Nuovo progetto</span>
            </button>
          )}
          {!creating && (
            <p className="workspace-switcher-hint">
              <Trash2 size={11} /> Usa la matita per rinominare, collegare una cartella o
              eliminare un progetto.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
