import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type MemoryPublicationProposal,
  type MemoryPublicationResolution,
  type MemoryPublicationSensitivity,
  type WorkspaceRecord,
} from "../lib/coreBridge";

type MemoryPublicationDialogProps = {
  sourceRef: string;
  sourceWorkspaceId: string;
  initialText: string;
  opener?: HTMLElement | null;
  onClose: () => void;
  onPublished: () => void;
};

const MEMORY_TYPES = ["preference", "fact", "note", "decision", "goal", "objective", "open_loop", "artifact", "episode"];
const SENSITIVITIES: MemoryPublicationSensitivity[] = ["public", "internal", "private"];

function sourceLabel(workspace: WorkspaceRecord) {
  return workspace.name.trim() || workspace.id;
}

/**
 * Owner-only, explicit publication approval. The editable values are sent as a
 * proposal request, then the server-reloaded/redacted `proposed_text` is what
 * the user actually approves. No browser-selected source or destination is an
 * authority: the gateway validates the current workspace snapshot again.
 */
export function MemoryPublicationDialog({
  sourceRef,
  sourceWorkspaceId,
  initialText,
  opener,
  onClose,
  onPublished,
}: MemoryPublicationDialogProps) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [destinationWorkspaceId, setDestinationWorkspaceId] = useState("");
  const [text, setText] = useState(initialText);
  const [memoryType, setMemoryType] = useState("note");
  const [privacyDomain, setPrivacyDomain] = useState<"personal" | "work" | "general">("personal");
  const [sensitivity, setSensitivity] = useState<MemoryPublicationSensitivity>("private");
  const [proposal, setProposal] = useState<MemoryPublicationProposal | null>(null);
  const [resolution, setResolution] = useState<MemoryPublicationResolution | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const requestGeneration = useRef(0);
  const active = useRef(true);

  const destinations = workspaces.filter((workspace) => workspace.id !== sourceWorkspaceId);

  useEffect(() => {
    active.current = true;
    const generation = ++requestGeneration.current;
    dialogRef.current?.focus();
    void coreBridge.workspaces()
      .then((snapshot) => {
        if (!active.current || requestGeneration.current !== generation) return;
        setWorkspaces(snapshot.workspaces);
      })
      .catch((err) => {
        if (active.current && requestGeneration.current === generation) setError((err as Error).message);
      })
      .finally(() => {
        if (active.current && requestGeneration.current === generation) setLoading(false);
      });
    return () => {
      active.current = false;
      requestGeneration.current += 1;
      queueMicrotask(() => opener?.focus());
    };
  }, [opener]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) void rejectAndClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // rejectAndClose is intentionally defined from the current render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, saving]);

  async function prepareProposal() {
    if (!destinationWorkspaceId) {
      setError(t("memoryPublication.destinationRequired"));
      return;
    }
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError(null);
    try {
      const next = await coreBridge.createMemoryPublication({
        source_ref: sourceRef,
        source_workspace_id: sourceWorkspaceId,
        destination_workspace_id: destinationWorkspaceId,
        edit: {
          proposed_text: text,
          proposed_memory_type: memoryType,
          proposed_privacy_domain: privacyDomain,
          proposed_sensitivity: sensitivity,
        },
      });
      if (!active.current || requestGeneration.current !== generation) return;
      setProposal(next);
      setResolution(null);
      setConfirmed(false);
    } catch (err) {
      if (active.current && requestGeneration.current === generation) setError((err as Error).message);
    } finally {
      if (active.current && requestGeneration.current === generation) setSaving(false);
    }
  }

  async function approve() {
    if (!proposal || !resolution || !confirmed) return;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError(null);
    try {
      await coreBridge.approveMemoryPublication(proposal.id, resolution);
      if (!active.current || requestGeneration.current !== generation) return;
      onPublished();
      onClose();
    } catch (err) {
      if (active.current && requestGeneration.current === generation) setError((err as Error).message);
    } finally {
      if (active.current && requestGeneration.current === generation) setSaving(false);
    }
  }

  async function rejectAndClose() {
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError(null);
    try {
      if (proposal?.status === "pending") await coreBridge.rejectMemoryPublication(proposal.id);
      if (!active.current || requestGeneration.current !== generation) return;
      onClose();
    } catch (err) {
      if (active.current && requestGeneration.current === generation) setError((err as Error).message);
    } finally {
      if (active.current && requestGeneration.current === generation) setSaving(false);
    }
  }

  const exactPreview = proposal?.proposed_text ?? text;
  const selectedDestination = destinations.find((workspace) => workspace.id === destinationWorkspaceId);
  const duplicate = proposal?.candidate?.kind === "compatible_duplicate";
  const conflict = proposal?.candidate?.kind === "conflict";

  return (
    <div className="memory-publication-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="memory-publication-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-publication-title"
        tabIndex={-1}
      >
        <header className="memory-publication-header">
          <div>
            <p className="eyebrow">{t("memoryPublication.title")}</p>
            <h2 id="memory-publication-title">{t("memoryPublication.title")}</h2>
          </div>
          <button type="button" className="small-icon-button" onClick={() => void rejectAndClose()} disabled={saving} aria-label={t("common.close", { defaultValue: "Close" })}>×</button>
        </header>

        {loading ? <p className="memory-publication-status">{t("memoryPublication.loading")}</p> : null}
        {error ? <p className="memory-publication-error" role="alert">{error}</p> : null}

        <label className="memory-publication-field">
          <span>{t("memoryPublication.text")}</span>
          <textarea value={exactPreview} disabled={Boolean(proposal) || saving} onChange={(event) => setText(event.target.value)} />
        </label>
        <div className="memory-publication-grid">
          <label className="memory-publication-field">
            <span>{t("memoryPublication.type")}</span>
            <select value={proposal?.proposed_memory_type ?? memoryType} disabled={Boolean(proposal) || saving} onChange={(event) => setMemoryType(event.target.value)}>
              {MEMORY_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="memory-publication-field">
            <span>{t("memoryPublication.collection")}</span>
            <strong>{proposal ? t(`memoryCollections.${proposal.proposed_collection}`) : t("memoryPublication.collectionDerived")}</strong>
          </div>
        </div>
        <div className="memory-publication-grid">
          <label className="memory-publication-field">
            <span>{t("memoryPublication.privacyDomain")}</span>
            <select value={proposal?.proposed_privacy_domain ?? privacyDomain} disabled={Boolean(proposal) || saving} onChange={(event) => setPrivacyDomain(event.target.value as "personal" | "work" | "general")}>
              {["personal", "work", "general"].map((value) => <option key={value} value={value}>{t(`memoryPublication.domains.${value}`)}</option>)}
            </select>
          </label>
          <label className="memory-publication-field">
            <span>{t("memoryPublication.sensitivity")}</span>
            <select value={proposal?.proposed_sensitivity ?? sensitivity} disabled={Boolean(proposal) || saving} onChange={(event) => setSensitivity(event.target.value as MemoryPublicationSensitivity)}>
              {SENSITIVITIES.map((value) => <option key={value} value={value}>{t(`memorySources.sensitivityValues.${value}`)}</option>)}
            </select>
          </label>
        </div>
        <label className="memory-publication-field">
          <span>{t("memoryPublication.destination")}</span>
          <select value={destinationWorkspaceId} disabled={Boolean(proposal) || saving || loading} onChange={(event) => setDestinationWorkspaceId(event.target.value)}>
            <option value="">{t("memoryPublication.chooseDestination")}</option>
            {destinations.map((workspace) => <option key={workspace.id} value={workspace.id}>{sourceLabel(workspace)}</option>)}
          </select>
          {selectedDestination ? <small>{selectedDestination.name}</small> : null}
        </label>

        {proposal ? (
          <section className={`memory-publication-outcome${conflict ? " is-conflict" : ""}`} aria-live="polite">
            {duplicate ? <strong>{t("memoryPublication.duplicate")}</strong> : null}
            {conflict ? <strong>{t("memoryPublication.conflict")}</strong> : null}
            <p>{t("memoryPublication.consequence")}</p>
            <label><input type="radio" name="memory-publication-resolution" checked={resolution?.kind === "create_new"} onChange={() => setResolution({ kind: "create_new" })} disabled={saving} /> {t("memoryPublication.createNew")}</label>
            {proposal.candidate ? <label><input type="radio" name="memory-publication-resolution" checked={resolution?.kind === "update_existing"} onChange={() => setResolution({ kind: "update_existing", destination_ref: proposal.candidate!.destination_ref })} disabled={saving} /> {t("memoryPublication.updateExisting")}</label> : null}
          </section>
        ) : null}

        {proposal ? (
          <label className="memory-publication-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={saving} />
            <span>{t("memoryPublication.canonicalConfirmation")}</span>
          </label>
        ) : null}
        <footer className="memory-publication-actions">
          <button type="button" className="secondary-button" onClick={() => void rejectAndClose()} disabled={saving}>{t("memoryPublication.reject")}</button>
          {proposal ? <button type="button" className="primary-button" onClick={() => void approve()} disabled={saving || !confirmed || !resolution}>{saving ? t("memoryPublication.saving") : t("memoryPublication.approve")}</button> : <button type="button" className="primary-button" onClick={() => void prepareProposal()} disabled={saving || loading || !destinationWorkspaceId}>{saving ? t("memoryPublication.saving") : t("memoryPublication.review")}</button>}
        </footer>
      </section>
    </div>
  );
}
