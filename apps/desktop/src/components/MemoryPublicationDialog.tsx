import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type MemoryPublicationEditInput,
  type MemoryPublicationProposal,
  type MemoryPublicationResolution,
  type MemoryPublicationSensitivity,
  type WorkspaceRecord,
} from "../lib/coreBridge";

type MemoryPublicationDialogProps = {
  sourceRef: string;
  sourceWorkspaceId: string;
  opener?: HTMLElement | null;
  onClose: () => void;
  onPublished: () => void | Promise<void>;
};

const MEMORY_TYPES = ["preference", "fact", "note", "decision", "goal", "objective", "open_loop", "artifact", "episode"];
const SENSITIVITIES: MemoryPublicationSensitivity[] = ["public", "internal", "private"];
const PUBLICATION_ERROR_CODES = new Set([
  "secret_never_shareable",
  "vault_payload_never_shareable",
  "publication_actor_mismatch",
  "publication_decision_required",
  "publication_conflict",
  "publication_source_changed",
  "publication_edit_invalid",
  "memory_publication_invalid",
  "publication_not_found",
  "publication_source_not_found",
]);

function sourceLabel(workspace: WorkspaceRecord) {
  return workspace.name.trim() || workspace.id;
}

/**
 * The initial preview intentionally contains no client-side payload. Selecting a
 * destination creates a server-first proposal, and every subsequent edit is
 * separately revalidated by the gateway before it can be approved.
 */
export function MemoryPublicationDialog({
  sourceRef,
  sourceWorkspaceId,
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
  const [text, setText] = useState("");
  const [memoryType, setMemoryType] = useState("");
  const [privacyDomain, setPrivacyDomain] = useState<"personal" | "work" | "general" | "">("");
  const [sensitivity, setSensitivity] = useState<MemoryPublicationSensitivity | "">("");
  const [proposal, setProposal] = useState<MemoryPublicationProposal | null>(null);
  const [resolution, setResolution] = useState<MemoryPublicationResolution | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const requestGeneration = useRef(0);
  const active = useRef(true);
  const destinations = workspaces.filter((workspace) => workspace.id !== sourceWorkspaceId);
  const selectedDestination = destinations.find((workspace) => workspace.id === destinationWorkspaceId);

  function localizeError(err: unknown) {
    const code = err instanceof Error ? err.message.trim() : "";
    return t(
      PUBLICATION_ERROR_CODES.has(code)
        ? `memoryPublication.errors.${code}`
        : "memoryPublication.errors.generic",
    );
  }

  function hydrateFromServer(next: MemoryPublicationProposal) {
    setProposal(next);
    setText(next.proposed_text);
    setMemoryType(next.proposed_memory_type);
    setPrivacyDomain(next.proposed_privacy_domain);
    setSensitivity(next.proposed_sensitivity);
    setResolution(null);
    setConfirmed(false);
  }

  function resetApproval() {
    setResolution(null);
    setConfirmed(false);
  }

  function closeDialog() {
    requestGeneration.current += 1;
    setSaving(false);
    setError(null);
    setDestinationWorkspaceId("");
    setText("");
    setMemoryType("");
    setPrivacyDomain("");
    setSensitivity("");
    setProposal(null);
    setResolution(null);
    setConfirmed(false);
    onClose();
  }

  useEffect(() => {
    active.current = true;
    const generation = ++requestGeneration.current;
    closeButtonRef.current?.focus();
    void coreBridge.workspaces()
      .then((snapshot) => {
        if (!active.current || requestGeneration.current !== generation) return;
        setWorkspaces(snapshot.workspaces);
      })
      .catch((err) => {
        if (active.current && requestGeneration.current === generation) setError(localizeError(err));
      })
      .finally(() => {
        if (active.current && requestGeneration.current === generation) setLoading(false);
      });
    return () => {
      active.current = false;
      requestGeneration.current += 1;
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
    // The dialog lifetime owns this loading request and the opener focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opener]);

  async function rejectAndClose() {
    const pendingProposal = proposal;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError(null);
    try {
      if (pendingProposal?.status === "pending") await coreBridge.rejectMemoryPublication(pendingProposal.id);
      if (!active.current || requestGeneration.current !== generation) return;
      closeDialog();
    } catch (err) {
      if (active.current && requestGeneration.current === generation) {
        setSaving(false);
        setError(localizeError(err));
      }
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        void rejectAndClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // The handler deliberately uses the current rendered proposal state.
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
      // No edit is sent here: the server reloads the source and returns the
      // only payload that may be displayed or approved.
      const next = await coreBridge.createMemoryPublication({
        source_ref: sourceRef,
        source_workspace_id: sourceWorkspaceId,
        destination_workspace_id: destinationWorkspaceId,
      });
      if (!active.current || requestGeneration.current !== generation) return;
      hydrateFromServer(next);
      setSaving(false);
    } catch (err) {
      if (active.current && requestGeneration.current === generation) {
        setSaving(false);
        setError(localizeError(err));
      }
    }
  }

  const hasEdits = Boolean(proposal) && (
    text !== proposal?.proposed_text
    || memoryType !== proposal?.proposed_memory_type
    || privacyDomain !== proposal?.proposed_privacy_domain
    || sensitivity !== proposal?.proposed_sensitivity
  );

  async function reviewEdits() {
    if (!proposal || !hasEdits) return;
    const edit: MemoryPublicationEditInput = {};
    if (text !== proposal.proposed_text) edit.proposed_text = text;
    if (memoryType !== proposal.proposed_memory_type) edit.proposed_memory_type = memoryType;
    if (privacyDomain !== proposal.proposed_privacy_domain) edit.proposed_privacy_domain = privacyDomain as "personal" | "work" | "general";
    if (sensitivity !== proposal.proposed_sensitivity) edit.proposed_sensitivity = sensitivity as MemoryPublicationSensitivity;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError(null);
    try {
      const next = await coreBridge.updateMemoryPublication(proposal.id, edit);
      if (!active.current || requestGeneration.current !== generation) return;
      hydrateFromServer(next);
      setSaving(false);
    } catch (err) {
      if (active.current && requestGeneration.current === generation) {
        setSaving(false);
        setError(localizeError(err));
      }
    }
  }

  async function approve() {
    if (!proposal || hasEdits || !resolution || !confirmed) return;
    const generation = ++requestGeneration.current;
    setSaving(true);
    setError(null);
    try {
      await coreBridge.approveMemoryPublication(proposal.id, resolution);
      if (!active.current || requestGeneration.current !== generation) return;
      await onPublished();
      if (!active.current || requestGeneration.current !== generation) return;
      closeDialog();
    } catch (err) {
      if (active.current && requestGeneration.current === generation) {
        setSaving(false);
        setError(localizeError(err));
      }
    }
  }

  const duplicate = proposal?.candidate?.kind === "compatible_duplicate";
  const conflict = proposal?.candidate?.kind === "conflict";

  return (
    <div className="memory-publication-backdrop" role="presentation">
      <section ref={dialogRef} className="memory-publication-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-publication-title" tabIndex={-1}>
        <header className="memory-publication-header">
          <div><p className="eyebrow">{t("memoryPublication.title")}</p><h2 id="memory-publication-title">{t("memoryPublication.title")}</h2></div>
          <button ref={closeButtonRef} type="button" className="small-icon-button" onClick={() => void rejectAndClose()} disabled={saving} aria-label={t("common.close", { defaultValue: "Close" })}>×</button>
        </header>
        {loading ? <p className="memory-publication-status">{t("memoryPublication.loading")}</p> : null}
        {error ? <p className="memory-publication-error" role="alert">{error}</p> : null}

        <label className="memory-publication-field"><span>{t("memoryPublication.destination")}</span>
          <select value={destinationWorkspaceId} disabled={Boolean(proposal) || saving || loading} onChange={(event) => setDestinationWorkspaceId(event.target.value)}>
            <option value="">{t("memoryPublication.chooseDestination")}</option>
            {destinations.map((workspace) => <option key={workspace.id} value={workspace.id}>{sourceLabel(workspace)}</option>)}
          </select>
          {selectedDestination ? <small>{selectedDestination.name}</small> : null}
        </label>

        {proposal ? <>
          <label className="memory-publication-field"><span>{t("memoryPublication.text")}</span>
            <textarea value={text} disabled={saving} onChange={(event) => { setText(event.target.value); resetApproval(); }} />
          </label>
          <div className="memory-publication-grid">
            <label className="memory-publication-field"><span>{t("memoryPublication.type")}</span>
              <select value={memoryType} disabled={saving} onChange={(event) => { setMemoryType(event.target.value); resetApproval(); }}>
                {MEMORY_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <div className="memory-publication-field"><span>{t("memoryPublication.collection")}</span><strong>{t(`memoryCollections.${proposal.proposed_collection}`)}</strong></div>
          </div>
          <div className="memory-publication-grid">
            <label className="memory-publication-field"><span>{t("memoryPublication.privacyDomain")}</span>
              <select value={privacyDomain} disabled={saving} onChange={(event) => { setPrivacyDomain(event.target.value as "personal" | "work" | "general"); resetApproval(); }}>
                {["personal", "work", "general"].map((value) => <option key={value} value={value}>{t(`memoryPublication.domains.${value}`)}</option>)}
              </select>
            </label>
            <label className="memory-publication-field"><span>{t("memoryPublication.sensitivity")}</span>
              <select value={sensitivity} disabled={saving} onChange={(event) => { setSensitivity(event.target.value as MemoryPublicationSensitivity); resetApproval(); }}>
                {SENSITIVITIES.map((value) => <option key={value} value={value}>{t(`memorySources.sensitivityValues.${value}`)}</option>)}
              </select>
            </label>
          </div>
          <section className={`memory-publication-outcome${conflict ? " is-conflict" : ""}`} aria-live="polite">
            {duplicate ? <strong>{t("memoryPublication.duplicate")}</strong> : null}
            {conflict ? <strong>{t("memoryPublication.conflict")}</strong> : null}
            <p>{t("memoryPublication.consequence")}</p>
            <label><input type="radio" name="memory-publication-resolution" checked={resolution?.kind === "create_new"} onChange={() => setResolution({ kind: "create_new" })} disabled={saving || hasEdits} /> {t("memoryPublication.createNew")}</label>
            {proposal.candidate ? <label><input type="radio" name="memory-publication-resolution" checked={resolution?.kind === "update_existing"} onChange={() => setResolution({ kind: "update_existing", destination_ref: proposal.candidate!.destination_ref })} disabled={saving || hasEdits} /> {t("memoryPublication.updateExisting")}</label> : null}
          </section>
          <label className="memory-publication-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={saving || hasEdits} /><span>{t("memoryPublication.canonicalConfirmation")}</span></label>
        </> : null}
        <footer className="memory-publication-actions">
          <button type="button" className="secondary-button" onClick={() => void rejectAndClose()} disabled={saving}>{t("memoryPublication.reject")}</button>
          {!proposal ? <button type="button" className="primary-button" onClick={() => void prepareProposal()} disabled={saving || loading || !destinationWorkspaceId}>{saving ? t("memoryPublication.saving") : t("memoryPublication.review")}</button> : hasEdits ? <button type="button" className="primary-button" onClick={() => void reviewEdits()} disabled={saving}>{saving ? t("memoryPublication.saving") : t("memoryPublication.review")}</button> : <button type="button" className="primary-button" onClick={() => void approve()} disabled={saving || !confirmed || !resolution}>{saving ? t("memoryPublication.saving") : t("memoryPublication.approve")}</button>}
        </footer>
      </section>
    </div>
  );
}
