import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FolderPlus, Layers, Loader2 } from "lucide-react";
import {
  coreBridge,
  type WorkspaceRecord,
  type WorkspacesSnapshot,
} from "../lib/coreBridge";

// A project (workspace) is the isolation boundary: switching it re-scopes tasks,
// memory, capabilities and connected accounts (ADR 0009). Because every view
// caches data for the active workspace, the simplest correct way to apply a
// switch app-wide is a full reload after the gateway flips the active id.
export function WorkspaceSwitcher() {
  const [snapshot, setSnapshot] = useState<WorkspacesSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
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

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const snap = await coreBridge.createWorkspace(name);
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
          {snapshot.workspaces.map((workspace) => (
            <button
              key={workspace.id}
              className="workspace-switcher-item"
              type="button"
              role="option"
              aria-selected={workspace.id === snapshot.active_workspace_id}
              onClick={() => void handleSelect(workspace.id)}
            >
              <span>{workspace.name}</span>
              {workspace.id === snapshot.active_workspace_id && <Check size={15} />}
            </button>
          ))}

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
              onClick={() => setCreating(true)}
            >
              <FolderPlus size={15} />
              <span>Nuovo progetto</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
