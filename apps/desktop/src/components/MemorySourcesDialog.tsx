import { Brain, ChevronLeft, Database, Link2, LoaderCircle, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type MemoryCollectionKey,
  type MemorySourceCandidateView,
  type MemorySourceGrantView,
  type MemorySourceUpsertInput,
  type WorkspaceRecord,
} from "../lib/coreBridge";

type MemorySourcesDialogProps = {
  workspace: WorkspaceRecord | null;
  projects: WorkspaceRecord[];
  opener?: HTMLElement | null;
  onClose: () => void;
};

type WizardStep = "source" | "collections" | "advanced" | "review";

const PERSONAL_SOURCE_ID = "__personal__";
const CANDIDATE_PAGE_SIZE = 40;
// The English UI copy is "Read only" (localized through memorySources.readOnly).
// Missing timestamps are disclosed as "Never consulted" through memorySources.neverConsulted.
const COLLECTIONS: MemoryCollectionKey[] = [
  "preferences",
  "profile",
  "knowledge",
  "decisions",
  "goals",
  "artifacts",
  "episodes",
];

function formatDate(value: number | null | undefined, locale: string) {
  if (!value) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value * 1000),
  );
}

function dateTimeInputValue(value: number | null) {
  if (!value) return "";
  const date = new Date(value * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function summaryForGrant(grant: MemorySourceGrantView, locale: string) {
  const expires = formatDate(grant.expires_at, locale);
  const used = formatDate(grant.last_used_at, locale);
  return { expires, used };
}

/**
 * Project-owned management surface for read-only, explicitly authorised memory
 * sources. It intentionally does not reuse ProjectAccessDialog: contacts may
 * restrict a capability, but never create a cross-memory source grant.
 */
export function MemorySourcesDialog({ workspace, projects, opener, onClose }: MemorySourcesDialogProps) {
  const { t, i18n } = useTranslation();
  const [grants, setGrants] = useState<MemorySourceGrantView[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<WizardStep | null>(null);
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState("");
  const [collections, setCollections] = useState<MemoryCollectionKey[]>([]);
  const [maxSensitivity, setMaxSensitivity] = useState<MemorySourceGrantView["max_sensitivity"]>("private");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<MemorySourceUpsertInput["overrides"]>([]);
  const [candidates, setCandidates] = useState<MemorySourceCandidateView[]>([]);
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [candidateHasMore, setCandidateHasMore] = useState(false);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [editingGrant, setEditingGrant] = useState<MemorySourceGrantView | null>(null);
  const [revokeConfirmation, setRevokeConfirmation] = useState<MemorySourceGrantView | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const revokeConfirmRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const sourceOptions = useMemo(
    () => projects.filter((project) => project.id !== workspace?.id),
    [projects, workspace?.id],
  );
  const linkedGrants = grants.filter((grant) => !grant.local && !grant.revoked_at);

  async function loadGrants() {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      setGrants(await coreBridge.memorySources(workspace.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspace) return;
    void loadGrants();
    // A new project must always display its own grant list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  const workspaceId = workspace?.id ?? "";

  function closeDialog() {
    resetWizard();
    setRevokeConfirmation(null);
    setEditingGrant(null);
    setError(null);
    const openerToRestore = openerRef.current;
    onClose();
    window.setTimeout(() => {
      if (openerToRestore?.isConnected) {
        openerToRestore.focus();
        return;
      }
      // A project can disappear while the dialog is open. In that case, retain
      // keyboard continuity by selecting the first still-mounted project trigger.
      document.querySelector<HTMLElement>("[data-project-menu-trigger]")?.focus();
    }, 0);
  }

  function focusTrap(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const root = revokeConfirmation ? revokeConfirmRef.current : dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    if (!workspace) {
      openerRef.current = null;
      return;
    }
    if (opener?.isConnected) {
      // Sidebar passes the persistent project-row trigger on every open; do not
      // capture the short-lived context-menu action as the restoration target.
      openerRef.current = opener;
    } else if (!openerRef.current?.isConnected) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const initialFocus = window.setTimeout(() => {
      const nestedFirstAction = revokeConfirmRef.current?.querySelector<HTMLElement>("button:not([disabled])");
      (nestedFirstAction ?? closeButtonRef.current)?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      focusTrap(event);
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        if (revokeConfirmation) setRevokeConfirmation(null);
        else closeDialog();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(initialFocus);
      document.removeEventListener("keydown", onKeyDown);
    };
  // closeDialog is intentionally recreated with current dialog state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, opener, saving, revokeConfirmation]);

  if (!workspace || !workspaceId) return null;

  function resetWizard() {
    setStep(null);
    setSourceWorkspaceId("");
    setCollections([]);
    setMaxSensitivity("private");
    setExpiresAt(null);
    setOverrides([]);
    setCandidates([]);
    setCandidateOffset(0);
    setCandidateHasMore(false);
    setEditingGrant(null);
    setError(null);
  }

  function openModifyGrant(grant: MemorySourceGrantView) {
    if (!grant.source_available) return;
    setEditingGrant(grant);
    setSourceWorkspaceId(grant.source_workspace_id);
    setCollections(grant.collections);
    setMaxSensitivity(grant.max_sensitivity);
    setExpiresAt(grant.expires_at ?? null);
    setOverrides(grant.overrides);
    setCandidates([]);
    setCandidateOffset(0);
    setCandidateHasMore(false);
    setError(null);
    // Changes remain pending until the review screen and explicit confirmation.
    setStep("collections");
  }

  function chooseSource(value: string) {
    setSourceWorkspaceId(value);
    // No collection crosses the boundary merely by choosing a source. Personal
    // preferences are offered as a convenience only after a second explicit click.
    setCollections([]);
    setOverrides([]);
    setCandidates([]);
    setCandidateOffset(0);
    setCandidateHasMore(false);
    setEditingGrant(null);
    setError(null);
  }

  function toggleCollection(collection: MemoryCollectionKey) {
    setCollections((current) =>
      current.includes(collection)
        ? current.filter((item) => item !== collection)
        : [...current, collection],
    );
  }

  function choosePersonalPreferences() {
    if (sourceWorkspaceId !== PERSONAL_SOURCE_ID) return;
    setCollections((current) =>
      current.includes("preferences") ? current : [...current, "preferences"],
    );
  }

  async function loadCandidates(offset: number, append = false) {
    if (!sourceWorkspaceId) return;
    setLoadingCandidates(true);
    setError(null);
    try {
      const next = await coreBridge.memorySourceCandidates(workspaceId, sourceWorkspaceId, {
        offset,
        limit: CANDIDATE_PAGE_SIZE,
      });
      setCandidates((current) => (append ? [...current, ...next] : next));
      setCandidateOffset(offset + next.length);
      setCandidateHasMore(next.length === CANDIDATE_PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function enterAdvanced() {
    setStep("advanced");
    await loadCandidates(0);
  }

  function setOverride(candidate: MemorySourceCandidateView, effect: "allow" | "deny") {
    setOverrides((current) => {
      const withoutCandidate = current.filter((override) => override.memory_ref !== candidate.ref);
      return [...withoutCandidate, { memory_ref: candidate.ref, effect }];
    });
  }

  function removeOverride(candidate: MemorySourceCandidateView) {
    setOverrides((current) => current.filter((override) => override.memory_ref !== candidate.ref));
  }

  async function confirmGrant() {
    if (!sourceWorkspaceId || collections.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const next = await coreBridge.upsertMemorySource(workspaceId, {
        source_workspace_id: sourceWorkspaceId,
        collections,
        max_sensitivity: maxSensitivity,
        expires_at: expiresAt,
        overrides,
      });
      setGrants(next);
      resetWizard();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmRevokeGrant(grant: MemorySourceGrantView) {
    if (!grant.id) return;
    setSaving(true);
    setError(null);
    try {
      // The API revokes immediately; replacing our list with its response keeps the
      // UI from showing a source that can no longer be consulted.
      setGrants(await coreBridge.revokeMemorySource(workspaceId, grant.id));
      setRevokeConfirmation(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const currentSourceLabel = sourceWorkspaceId === PERSONAL_SOURCE_ID
    ? t("memorySources.personal")
    : sourceOptions.find((project) => project.id === sourceWorkspaceId)?.name ?? sourceWorkspaceId;

  return (
    <div className="memory-sources-backdrop" role="presentation" onMouseDown={() => !saving && closeDialog()}>
      <section
        ref={dialogRef}
        className="memory-sources-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${t("memorySources.title")}: ${workspace.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="memory-sources-header">
          <div>
            <p className="eyebrow">{t("memorySources.title")}</p>
            <h2>{workspace.name}</h2>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={closeDialog} disabled={saving} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>

        {step === null ? (
          <div className="memory-sources-list">
            <article className="memory-sources-card memory-sources-local-card">
              <Database size={18} aria-hidden="true" />
              <div>
                <strong>{t("memorySources.local")}</strong>
                <p>{t("memorySources.localAccess")}</p>
              </div>
            </article>

            {loading ? <p className="memory-sources-status"><LoaderCircle size={15} className="spin" /> {t("memorySources.loading")}</p> : null}
            {!loading && linkedGrants.length === 0 ? <p className="memory-sources-empty">{t("memorySources.empty")}</p> : null}
            {linkedGrants.map((grant) => {
              const { expires, used } = summaryForGrant(grant, i18n.language);
              return (
                <article
                  className={`memory-sources-card ${grant.source_available ? "" : "is-unavailable"}`}
                  key={grant.id ?? grant.source_workspace_id}
                >
                  <Brain size={18} aria-hidden="true" />
                  <div className="memory-sources-card-content">
                    <div className="memory-sources-card-title">
                      <strong>{grant.source_available ? grant.source_label : t("memorySources.unavailable")}</strong>
                      <span>{t("memorySources.readOnly")}</span>
                    </div>
                    {grant.source_available ? (
                      <>
                        <p>{grant.collections.map((collection) => t(`memoryCollections.${collection}`)).join(" · ")}</p>
                        <small>{t("memorySources.sensitivity")}: {t(`memorySources.sensitivityValues.${grant.max_sensitivity}`)}</small>
                        {expires ? <small>{t("memorySources.expires")}: {expires}</small> : null}
                        <small>{used ? `${t("memorySources.lastUsed")}: ${used}` : t("memorySources.neverConsulted")}</small>
                      </>
                    ) : (
                      <p>{t("memorySources.unavailableHint")}</p>
                    )}
                  </div>
                  {grant.id ? <div className="memory-sources-card-actions">
                    {grant.source_available ? <button className="memory-sources-review-action" type="button" disabled={saving} onClick={() => openModifyGrant(grant)}>{t("memorySources.modify")}</button> : null}
                    <button className="memory-sources-revoke" type="button" disabled={saving} onClick={() => setRevokeConfirmation(grant)}>
                      <Trash2 size={14} /> {t("memorySources.revoke")}
                    </button>
                  </div> : null}
                </article>
              );
            })}
            <p className="memory-sources-revoke-warning">{t("memorySources.revokeWarning")}</p>
            <button className="primary-button" type="button" disabled={loading || saving} onClick={() => { resetWizard(); setStep("source"); }}>
              <Link2 size={15} /> {t("memorySources.connect")}
            </button>
          </div>
        ) : (
          <div className="memory-sources-wizard">
            <div className="memory-sources-progress" aria-label={t("memorySources.wizardProgress")}>
              {["source", "collections", "advanced", "review"].map((item) => (
                <span key={item} className={step === item ? "active" : ""}>{t(`memorySources.steps.${item}`)}</span>
              ))}
            </div>

            {step === "source" ? (
              <>
                <h3>{t("memorySources.chooseSource")}</h3>
                <label className="memory-sources-field">
                  <span>{t("memorySources.source")}</span>
                  <select value={sourceWorkspaceId} onChange={(event) => chooseSource(event.target.value)}>
                    <option value="">{t("memorySources.chooseSourcePlaceholder")}</option>
                    <option value={PERSONAL_SOURCE_ID}>{t("memorySources.personal")}</option>
                    {sourceOptions.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </label>
                <div className="memory-sources-actions">
                  <button className="secondary-button" type="button" onClick={resetWizard}>{t("common.cancel")}</button>
                  <button className="primary-button" type="button" disabled={!sourceWorkspaceId} onClick={() => setStep("collections")}>{t("common.continue")}</button>
                </div>
              </>
            ) : null}

            {step === "collections" ? (
              <>
                <button className="memory-sources-back" type="button" onClick={() => setStep("source")}><ChevronLeft size={15} /> {t("common.back")}</button>
                <h3>{editingGrant ? t("memorySources.modify") : t("memorySources.chooseCollections")}</h3>
                {sourceWorkspaceId === PERSONAL_SOURCE_ID ? (
                  <button className="memory-sources-suggestion" type="button" onClick={choosePersonalPreferences}>
                    {t("memorySources.addPersonalPreferences")}
                  </button>
                ) : null}
                <fieldset className="memory-sources-collections">
                  <legend>{currentSourceLabel}</legend>
                  {COLLECTIONS.map((collection) => (
                    <label key={collection}>
                      <input type="checkbox" checked={collections.includes(collection)} onChange={() => toggleCollection(collection)} />
                      <span>{t(`memoryCollections.${collection}`)}</span>
                    </label>
                  ))}
                </fieldset>
                <label className="memory-sources-field">
                  <span>{t("memorySources.sensitivity")}</span>
                  <select value={maxSensitivity} onChange={(event) => setMaxSensitivity(event.target.value as MemorySourceGrantView["max_sensitivity"])}>
                    {(["public", "internal", "private", "confidential"] as const).map((value) => <option key={value} value={value}>{t(`memorySources.sensitivityValues.${value}`)}</option>)}
                  </select>
                </label>
                {maxSensitivity === "confidential" ? <p className="memory-sources-risk">{t("memorySources.confidentialWarning")}</p> : null}
                <label className="memory-sources-field">
                  <span>{t("memorySources.expiryOptional")}</span>
                  <input type="datetime-local" value={dateTimeInputValue(expiresAt)} onChange={(event) => setExpiresAt(event.target.value ? Math.floor(new Date(event.target.value).getTime() / 1000) : null)} />
                </label>
                <div className="memory-sources-actions">
                  <button className="secondary-button" type="button" onClick={() => setStep("source")}>{t("common.back")}</button>
                  <button className="secondary-button" type="button" disabled={!collections.length} onClick={() => void enterAdvanced()}>{t("memorySources.advanced")}</button>
                  <button className="primary-button" type="button" disabled={!collections.length} onClick={() => setStep("review")}>{t("memorySources.review")}</button>
                </div>
              </>
            ) : null}

            {step === "advanced" ? (
              <>
                <button className="memory-sources-back" type="button" onClick={() => setStep("collections")}><ChevronLeft size={15} /> {t("common.back")}</button>
                <h3>{t("memorySources.advanced")}</h3>
                <p>{t("memorySources.advancedHint")}</p>
                <div className="memory-sources-candidates">
                  {candidates.map((candidate) => {
                    const selected = overrides.find((item) => item.memory_ref === candidate.ref);
                    return <article key={candidate.ref}>
                      <div><strong>{candidate.summary}</strong><small>{t(`memoryCollections.${candidate.collection}`)} · {t(`memorySources.sensitivityValues.${candidate.sensitivity}`)}</small></div>
                      <div className="memory-sources-override-actions">
                        <button type="button" className={selected?.effect === "allow" ? "active" : ""} onClick={() => setOverride(candidate, "allow")}>{t("memorySources.allow")}</button>
                        <button type="button" className={selected?.effect === "deny" ? "active" : ""} onClick={() => setOverride(candidate, "deny")}>{t("memorySources.deny")}</button>
                        {selected ? <button type="button" onClick={() => removeOverride(candidate)}>{t("common.clear")}</button> : null}
                      </div>
                    </article>;
                  })}
                </div>
                {loadingCandidates ? <p className="memory-sources-status"><LoaderCircle size={15} className="spin" /> {t("memorySources.loading")}</p> : null}
                {candidateHasMore ? <button className="secondary-button" type="button" disabled={loadingCandidates} onClick={() => void loadCandidates(candidateOffset, true)}>{t("memorySources.loadMore")}</button> : null}
                <div className="memory-sources-actions">
                  <button className="secondary-button" type="button" onClick={() => setStep("collections")}>{t("common.back")}</button>
                  <button className="primary-button" type="button" onClick={() => setStep("review")}>{t("memorySources.review")}</button>
                </div>
              </>
            ) : null}

            {step === "review" ? (
              <>
                <button className="memory-sources-back" type="button" onClick={() => setStep("collections")}><ChevronLeft size={15} /> {t("common.back")}</button>
                <h3>{t("memorySources.review")}</h3>
                <article className="memory-sources-review">
                  <strong>{currentSourceLabel}</strong>
                  <p>{t("memorySources.readOnly")}</p>
                  <p>{collections.map((collection) => t(`memoryCollections.${collection}`)).join(" · ")}</p>
                  <p>{t("memorySources.sensitivity")}: {t(`memorySources.sensitivityValues.${maxSensitivity}`)}</p>
                  {expiresAt ? <p>{t("memorySources.expires")}: {formatDate(expiresAt, i18n.language)}</p> : null}
                  {overrides.length ? <p>{t("memorySources.overridesCount", { count: overrides.length })}</p> : null}
                </article>
                <p className="memory-sources-confirm-copy">{t("memorySources.confirmCopy")}</p>
                <div className="memory-sources-actions">
                  <button className="secondary-button" type="button" onClick={() => setStep("collections")}>{t("common.back")}</button>
                  <button className="primary-button" type="button" disabled={saving} onClick={() => void confirmGrant()}>{saving ? t("memorySources.saving") : t("memorySources.confirm")}</button>
                </div>
              </>
            ) : null}
          </div>
        )}
        {revokeConfirmation ? (
          <section ref={revokeConfirmRef} className="memory-sources-revoke-confirmation" role="alertdialog" aria-modal="true" aria-label={t("memorySources.revokeConfirmTitle")}>
            <h3>{t("memorySources.revokeConfirmTitle")}</h3>
            <p>{t("memorySources.revokeConfirmBody")}</p>
            <div className="memory-sources-actions">
              <button className="secondary-button" type="button" disabled={saving} onClick={() => setRevokeConfirmation(null)}>{t("common.cancel")}</button>
              <button className="memory-sources-revoke" type="button" disabled={saving} onClick={() => void confirmRevokeGrant(revokeConfirmation)}>{saving ? t("memorySources.saving") : t("memorySources.revoke")}</button>
            </div>
          </section>
        ) : null}
        {error ? <p className="memory-sources-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
