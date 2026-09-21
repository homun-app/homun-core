/**
 * Settings → Memoria: list / add / rectify / delete / export approved engine notes (F3.5a).
 * Slice C: backend status (sqlite vs Mem0 local) + recall search.
 */

import { useEffect, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  addEngineMemory,
  deleteEngineMemory,
  exportEngineMemories,
  fetchEngineMemoryStatus,
  listEngineMemories,
  recallEngineMemories,
  rectifyEngineMemory,
  type EngineMemoryNote,
  type EngineMemoryStatus,
} from "@/lib/engine-memory-client";

type Props = {
  actorId: string;
  projectId?: string | null;
};

export function ConversationMemorySettingsSection({ actorId, projectId = null }: Props) {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.memory;
  const [notes, setNotes] = useState<EngineMemoryNote[]>([]);
  const [draft, setDraft] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallHits, setRecallHits] = useState<EngineMemoryNote[]>([]);
  const [backend, setBackend] = useState<EngineMemoryStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function refresh() {
    const [items, memStatus] = await Promise.all([
      listEngineMemories(projectId ? { projectId } : {}),
      fetchEngineMemoryStatus(),
    ]);
    setNotes(items);
    setBackend(memStatus);
  }

  useEffect(() => {
    if (!engineReady) {
      setNotes([]);
      setBackend(null);
      return;
    }
    void refresh().catch((cause: unknown) => setError(cause));
  }, [engineReady, status.connection, projectId]);

  async function onAdd() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await addEngineMemory({
        text,
        actorId,
        projectId,
      });
      setDraft("");
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(memoryId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await deleteEngineMemory({ memoryId, actorId });
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function onRectify(memoryId: string) {
    const text = editText.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await rectifyEngineMemory({ memoryId, text, actorId });
      setEditingId(null);
      setEditText("");
      setInfo("Ricordo rettificato");
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const exported = await exportEngineMemories(projectId ? { projectId } : {});
      const blob = new Blob([JSON.stringify({ memories: exported }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `homun-memories${projectId ? `-${projectId}` : ""}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setInfo(`Export · ${exported.length} ricordi`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function onRecall() {
    const q = recallQuery.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const hits = await recallEngineMemories({
        query: q,
        ...(projectId ? { projectId } : {}),
      });
      setRecallHits(hits);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (status.connection !== "connected") {
    return (
      <>
        <h3>Memoria</h3>
        <p>Collega l’app locale per salvare ricordi approvati.</p>
      </>
    );
  }

  if (!engineReady) {
    return (
      <>
        <h3>Memoria</h3>
        <p>La memoria non è ancora disponibile in questa versione.</p>
      </>
    );
  }

  return (
    <>
      <h3>Memoria approvata</h3>
      <p>
        Solo ricordi che decidi tu di salvare. Nessuna cattura automatica dai messaggi. Isolati per
        progetto quando impostato. Non ricostruiscono il piano.
      </p>
      {backend ? (
        <p className="cv-settings-note" role="status">
          Backend: <code>{backend.backend}</code>
          {backend.ok ? "" : " (non ok)"} — {backend.detail}
        </p>
      ) : null}
      {error != null ? <HomunErrorNotice error={error} /> : null}
      {info ? <p className="cv-settings-note">{info}</p> : null}
      <label>
        Nuovo ricordo
        <textarea
          rows={3}
          value={draft}
          maxLength={2000}
          placeholder="Es. Il cliente preferisce i listini in PDF"
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button type="button" className="cw-primary" disabled={busy || !draft.trim()} onClick={() => void onAdd()}>
        Salva ricordo
      </button>
      <button type="button" className="cw-secondary" disabled={busy} onClick={() => void onExport()}>
        Esporta JSON
      </button>

      <div className="cv-settings-card">
        <strong>Cerca (recall)</strong>
        <p>
          Substring sul ledger, oppure ricerca semantica se Mem0 locale (Ollama+Qdrant) è attivo.
        </p>
        <label>
          Query
          <input
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
            placeholder="Es. Acme PDF"
            aria-label="Query recall memoria"
          />
        </label>
        <button
          type="button"
          className="cw-secondary"
          disabled={busy || !recallQuery.trim()}
          onClick={() => void onRecall()}
        >
          Cerca
        </button>
        {recallHits.length > 0 ? (
          <ul className="cv-settings-memory-list">
            {recallHits.map((note) => (
              <li key={note.id}>
                <p>{note.text}</p>
                <small>
                  {note.status}
                  {note.project_id ? ` · ${note.project_id}` : ""}
                </small>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {notes.length === 0 ? (
        <div className="cv-settings-card">Nessun ricordo salvato.</div>
      ) : (
        <ul className="cv-settings-memory-list">
          {notes.map((note) => (
            <li key={note.id} className="cv-settings-card">
              {editingId === note.id ? (
                <>
                  <label>
                    Rettifica
                    <textarea
                      rows={3}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      aria-label="Testo rettifica memoria"
                    />
                  </label>
                  <button
                    type="button"
                    className="cw-primary"
                    disabled={busy || !editText.trim()}
                    onClick={() => void onRectify(note.id)}
                  >
                    Salva rettifica
                  </button>
                  <button
                    type="button"
                    className="cw-secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(null);
                      setEditText("");
                    }}
                  >
                    Annulla
                  </button>
                </>
              ) : (
                <>
                  <p>{note.text}</p>
                  <small>
                    {note.status}
                    {note.project_id ? ` · ${note.project_id}` : ""}
                  </small>
                  <button
                    type="button"
                    className="cw-secondary"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(note.id);
                      setEditText(note.text);
                    }}
                  >
                    Rettifica
                  </button>
                  <button
                    type="button"
                    className="cw-secondary"
                    disabled={busy}
                    onClick={() => void onDelete(note.id)}
                  >
                    Elimina
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
