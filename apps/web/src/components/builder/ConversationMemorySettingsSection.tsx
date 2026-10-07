/**
 * Settings → Memoria Approvata Gerarchica (F3.5a):
 * Split between General Space Memory (brand guidelines, company policies)
 * and Project Memory (isolated project constraints and deliverables).
 * Includes recall search (semantic/substring), in-place rectification, and promotion tools.
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
  memoryScopeLabel,
  type EngineMemoryNote,
  type EngineMemoryStatus,
} from "@/lib/engine-memory-client";
import { listEngineProjects, type EngineProject } from "@/lib/engine-projects-client";
import {
  Brain,
  Globe,
  FolderGit2,
  Search,
  Plus,
  ArrowUpRight,
  Edit2,
  Trash2,
  Download,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { SettingsCustomSelect } from "./SettingsCustomSelect";
import { ConversationMemoryReviewModal } from "./ConversationMemoryReviewModal";

type Props = {
  actorId: string;
  projectId?: string | null;
};

export function ConversationMemorySettingsSection({ actorId, projectId: initialProjectId = null }: Props) {
  const status = useEngineStatus();
  const engineReady = status.connection === "connected" && status.capabilities?.features.memory;

  // Level selection: "space" vs "project"
  const [activeLevel, setActiveLevel] = useState<"space" | "project">(
    initialProjectId ? "project" : "space",
  );
  const [projects, setProjects] = useState<EngineProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId || "");

  const [notes, setNotes] = useState<EngineMemoryNote[]>([]);
  const [draft, setDraft] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallHits, setRecallHits] = useState<EngineMemoryNote[]>([]);
  const [backend, setBackend] = useState<EngineMemoryStatus | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Determine current effective project ID based on level
  const effectiveProjectId = activeLevel === "project" ? (selectedProjectId || null) : null;

  async function refresh() {
    try {
      const [items, memStatus, projs] = await Promise.all([
        listEngineMemories(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
        fetchEngineMemoryStatus(),
        listEngineProjects().catch(() => [] as EngineProject[]),
      ]);
      setNotes(items);
      setBackend(memStatus);
      setProjects(projs);
      const firstProj = projs[0];
      if (firstProj && !selectedProjectId) {
        setSelectedProjectId(firstProj.id);
      }
    } catch (cause) {
      setError(cause);
    }
  }

  useEffect(() => {
    if (!engineReady) {
      setNotes([]);
      setBackend(null);
      return;
    }
    void refresh();
  }, [engineReady, status.connection, activeLevel, selectedProjectId]);

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
        projectId: effectiveProjectId,
      });
      setDraft("");
      setInfo(
        activeLevel === "space"
          ? "Ricordo salvato nella Memoria Generale dello Spazio."
          : `Ricordo salvato nella Memoria del Progetto.`,
      );
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
      setInfo("Ricordo eliminato.");
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
      setInfo("Ricordo rettificato.");
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  // Promote project memory to space-wide general memory
  async function onPromoteToSpace(note: EngineMemoryNote) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await addEngineMemory({
        text: note.text,
        actorId,
        projectId: null,
      });
      setInfo(`Regola promossa a Memoria Generale dello Spazio!`);
      if (activeLevel === "space") await refresh();
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
      const exported = await exportEngineMemories(
        effectiveProjectId ? { projectId: effectiveProjectId } : {},
      );
      const blob = new Blob([JSON.stringify({ memories: exported }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `homun-memoria-${activeLevel}${effectiveProjectId ? `-${effectiveProjectId}` : ""}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setInfo(`Export completato: ${exported.length} ricordi scaricati.`);
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
        ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
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
      <div className="space-y-3">
        <h3>Memoria Approvata & Vincoli</h3>
        <p>Collega l’applicazione desktop Homun per visualizzare e gestire i ricordi approvati.</p>
      </div>
    );
  }

  if (!engineReady) {
    return (
      <div className="space-y-3">
        <h3>Memoria Approvata & Vincoli</h3>
        <p>La memoria non è ancora disponibile in questa versione del motore.</p>
      </div>
    );
  }

  const selectedProjName = projects.find((p) => p.id === selectedProjectId)?.name ?? selectedProjectId;

  return (
    <div className="space-y-5" aria-label="Gestione memoria approvata">
      {/* Intestazione */}
      <div className="flex items-center justify-between">
        <div>
          <h3>Memoria Approvata & Vincoli Cognitivi</h3>
          <p className="text-xs text-[#9db3ad]">
            Solo principi esplicitamente approvati dall'utente. Nessuna cattura automatica silenziosa.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setReviewOpen(true)}
            className="cv-unified-btn is-subtle text-xs flex items-center gap-1.5"
            title="Analizza e pulisci memorie ridondanti"
          >
            <Sparkles size={13} className="text-amber-500" />
            <span>Revisione Duplicati</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onExport()}
            className="cv-unified-btn is-subtle text-xs"
            title="Esporta memoria in formato JSON"
          >
            <Download size={13} />
            <span>Esporta JSON</span>
          </button>
        </div>
      </div>

      <ConversationMemoryReviewModal
        isOpen={reviewOpen}
        onClose={() => setReviewOpen(false)}
        actorId={actorId}
        projectId={effectiveProjectId}
        onMemoriesUpdated={() => void refresh()}
      />

      <HomunErrorNotice error={error} />
      {info && (
        <p className="p-2.5 rounded-lg bg-[#dcebd9] border border-[#b7d6b3] text-xs text-[#235940] font-medium">
          {info}
        </p>
      )}

      {/* Livello Gerarchico: Generale dello Spazio vs Singolo Progetto */}
      <div className="flex flex-col sm:flex-row gap-1.5 p-1 bg-[#edf2e7] rounded-xl border border-[rgba(104,122,89,0.15)]">
        <button
          type="button"
          onClick={() => setActiveLevel("space")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-xs font-medium transition-all ${
            activeLevel === "space"
              ? "bg-[#203c32] text-white shadow-sm font-semibold"
              : "text-[#556c5e] hover:text-[#1c2d22] hover:bg-white/50"
          }`}
        >
          <Globe size={14} />
          <span>Memoria Generale dello Spazio (Aziendale)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveLevel("project")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg text-xs font-medium transition-all ${
            activeLevel === "project"
              ? "bg-[#203c32] text-white shadow-sm font-semibold"
              : "text-[#556c5e] hover:text-[#1c2d22] hover:bg-white/50"
          }`}
        >
          <FolderGit2 size={14} />
          <span>Memoria per Singolo Progetto</span>
        </button>
      </div>

      {/* Banner Esplicativo Livello Attivo */}
      <div className="p-4 rounded-xl bg-[#dcebd9] border border-[#b7d6b3] flex items-start gap-3.5">
        <div className="w-8 h-8 rounded-lg bg-[#203c32] text-white flex items-center justify-center shrink-0 mt-0.5">
          <Brain size={18} />
        </div>
        <div className="space-y-1">
          <strong className="text-xs font-bold text-[#1c2d22] block">
            {activeLevel === "space"
              ? "Ambito Globale: Regole Non Negoziabili per Tutti gli Agenti"
              : `Ambito Circoscritto: Regole per ${selectedProjName || "il Progetto"}`}
          </strong>
          <p className="text-xs text-[#235940] leading-relaxed">
            {activeLevel === "space"
              ? "Queste note rappresentano la bussola dell'azienda: tono di voce aziendale, convenzioni di sicurezza e direttive applicate in qualsiasi conversazione o progetto."
              : "I vincoli specifici di questo progetto non inquinano gli altri progetti. Se una regola diventa un principio generale, puoi promuoverla con un click."}
          </p>
        </div>
      </div>

      {/* Selettore Progetto (quando attivo il livello di progetto) */}
      {activeLevel === "project" && (
        <div className="p-3.5 rounded-xl bg-white border border-[#dce4d5] flex items-center justify-between gap-4">
          <label className="text-xs font-semibold text-[#263832] flex items-center gap-2 shrink-0">
            <FolderGit2 size={14} className="text-[#203c32]" />
            <span>Seleziona Progetto:</span>
          </label>
          <div className="w-72">
            <SettingsCustomSelect
              value={selectedProjectId}
              onChange={setSelectedProjectId}
              options={
                projects.length === 0
                  ? [{ value: "", label: "Nessun progetto trovato" }]
                  : projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                      icon: <FolderGit2 size={13} className="text-[#203c32]" />,
                    }))
              }
              placeholder="Scegli un progetto..."
            />
          </div>
        </div>
      )}

      {/* Modulo Aggiunta Ricordo */}
      <div className="p-4 rounded-xl bg-[#edf2e7] border border-[rgba(104,122,89,0.12)] space-y-3">
        <strong className="text-xs font-bold text-[#1c2d22] block">
          Aggiungi Nuova Regola Approvata (
          {activeLevel === "space" ? "Spazio Globale" : selectedProjName}
          )
        </strong>
        <textarea
          rows={2}
          value={draft}
          maxLength={2000}
          placeholder={
            activeLevel === "space"
              ? "Es. Utilizzare sempre lingua italiana nei documenti ufficiali e citare le fonti normative..."
              : "Es. Il cliente richiede consegne in PDF protetto e validazione tramite firma digitale..."
          }
          onChange={(e) => setDraft(e.target.value)}
          className="w-full text-xs"
        />
        <button
          type="button"
          disabled={busy || !draft.trim()}
          onClick={() => void onAdd()}
          className="cv-unified-btn is-primary text-xs"
        >
          <Plus size={13} />
          <span>Salva Regola in Memoria</span>
        </button>
      </div>

      {/* Ricerca / Recall */}
      <div className="p-4 rounded-xl bg-[#edf2e7] border border-[rgba(104,122,89,0.12)] space-y-3">
        <div className="flex items-center justify-between">
          <strong className="text-xs font-bold text-[#1c2d22] flex items-center gap-1.5">
            <Search size={14} className="text-[#203c32]" />
            <span>Verifica & Ricerca (Recall Semantico / Substring)</span>
          </strong>
          {backend && (
            <span className="text-[10.5px] font-mono text-[#647a6d]">
              Backend: <code>{backend.backend}</code> {backend.ok ? "✓" : "(!)"}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <input
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
            placeholder="Cerca tra i ricordi memorizzati (es. PDF, sicurezza, policy)..."
            className="flex-1 text-xs"
            aria-label="Query recall memoria"
          />
          <button
            type="button"
            disabled={busy || !recallQuery.trim()}
            onClick={() => void onRecall()}
            className="cv-unified-btn is-subtle text-xs"
          >
            Cerca
          </button>
        </div>

        {recallHits.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[#dce4d5]">
            <span className="text-[11px] font-semibold text-[#203c32]">Risultati trovati ({recallHits.length}):</span>
            {recallHits.map((h) => (
              <div key={`hit-${h.id}`} className="p-2.5 rounded-lg bg-white border border-[#dce4d5] text-xs text-[#1c2d22]">
                <p>{h.text}</p>
                <span className="text-[10px] text-[#647a6d] block mt-1">
                  {memoryScopeLabel(h)} · {h.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Elenco Ricordi Memorizzati */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-[#647a6d]">
          <span>
            Ricordi approvati ({notes.length}) — {activeLevel === "space" ? "Spazio Globale" : selectedProjName}
          </span>
        </div>

        {notes.length === 0 ? (
          <div className="p-8 rounded-xl bg-white border border-[#dce4d5] text-center text-xs text-[#647a6d]">
            Nessun ricordo registrato in questo ambito. Salva una regola o un vincolo con il modulo sopra.
          </div>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="cv-settings-card flex flex-col gap-2">
              {editingId === note.id ? (
                <div className="space-y-2">
                  <textarea
                    rows={3}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="w-full text-xs"
                    aria-label="Testo rettifica memoria"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy || !editText.trim()}
                      onClick={() => void onRectify(note.id)}
                      className="cv-unified-btn is-primary text-xs"
                    >
                      Salva Rettifica
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null);
                        setEditText("");
                      }}
                      className="cv-unified-btn is-subtle text-xs"
                    >
                      Annulla
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xs text-[#f4f1ee] leading-relaxed m-0">{note.text}</p>

                  <div className="flex items-center justify-between pt-2 border-t border-[rgba(255,255,255,0.06)] text-[11px] text-[#9db3ad]">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-[#182b26] text-[#8fe3d0] border border-[#253a33]">
                        {memoryScopeLabel(note)}
                      </span>
                      <span>Stato: {note.status}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      {note.project_id && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onPromoteToSpace(note)}
                          className="cv-unified-btn is-subtle text-xs text-[#8fe3d0]"
                          title="Rendi questa regola valida per tutto lo spazio"
                        >
                          <ArrowUpRight size={12} />
                          <span>Promuovi a Spazio</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(note.id);
                          setEditText(note.text);
                        }}
                        className="cv-unified-btn is-subtle text-xs"
                      >
                        <Edit2 size={12} />
                        <span>Rettifica</span>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onDelete(note.id)}
                        className="cv-unified-btn is-subtle text-xs text-red-400 hover:text-red-300"
                      >
                        <Trash2 size={12} />
                        <span>Elimina</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
