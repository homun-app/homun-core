// Settings › Sandbox — the dedicated pane for the ADR 0023 sandbox/approval axes.
// It hosts TWO layers that resolve in strict precedence (see `resolved_sandbox_mode`
// / `resolved_approval_policy` in the gateway):
//   1. a global Default (persisted to `runtime-settings.json` via
//      `coreBridge.setRuntimeSettings`) — the `SandboxModeBlock`/`ApprovalPolicyBlock`
//      controls, moved here from the Model & Runtime pane so the axis lives in ONE place;
//   2. per-workspace overrides (persisted to `workspaces.json` via
//      `coreBridge.setWorkspacePolicy`), where an empty selection clears the override back
//      to inheriting the Default (POST `null`).
// Reconciliation invariant surfaced in copy: NONE of these modes disables the OS kernel
// fence around shell commands — Homun never fully unsandboxes.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { coreBridge, type WorkspaceRecord } from "../lib/coreBridge";

// Option tokens must match exactly what the gateway accepts (SandboxPolicy / AskForApproval
// parsers). Kept as constants so the Default block and the per-workspace selects stay in sync.
const SANDBOX_MODES = ["read-only", "workspace-write", "danger"] as const;
const APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"] as const;

/** ADR 0023 global sandbox mode. Persists to `RuntimeSettings.sandbox_mode` (read by
 *  `resolved_sandbox_mode` as the global default under any per-workspace override). Tokens
 *  match `SandboxPolicy` parsing. Moved here from the Model & Runtime pane. */
function SandboxModeBlock() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<string>("workspace-write");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await coreBridge.runtimeSettings();
        if (!cancelled) setMode(settings.sandbox_mode || "workspace-write");
      } catch {
        /* leave default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (value: string) => {
    setMode(value);
    setBusy(true);
    try {
      const saved = await coreBridge.setRuntimeSettings({ sandbox_mode: value });
      setMode(saved.sandbox_mode || "workspace-write");
    } catch {
      /* a later read corrects the optimistic state */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-trow" aria-busy={busy}>
      <div>
        <div className="tt">{t("settings.sandboxModeTitle")}</div>
        <div className="td">{t("settings.sandboxModeDesc")}</div>
        {mode === "danger" && (
          <div className="td" style={{ marginTop: 4, color: "var(--danger)" }}>
            {t("settings.sandboxModeDangerWarn")}
          </div>
        )}
      </div>
      <select
        className="set-input mdl-row-select"
        value={mode}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="read-only">{t("settings.sandboxModeReadOnly")}</option>
        <option value="workspace-write">{t("settings.sandboxModeWorkspace")}</option>
        <option value="danger">{t("settings.sandboxModeDanger")}</option>
      </select>
    </div>
  );
}

/** ADR 0023 approval axis. Persists to `RuntimeSettings.approval_policy` (read by
 *  `resolved_approval_policy`). Tokens match `AskForApproval::parse` exactly. */
function ApprovalPolicyBlock() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<string>("on-request");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await coreBridge.runtimeSettings();
        if (!cancelled) setPolicy(settings.approval_policy || "on-request");
      } catch {
        /* leave default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (value: string) => {
    setPolicy(value);
    setBusy(true);
    try {
      const saved = await coreBridge.setRuntimeSettings({ approval_policy: value });
      setPolicy(saved.approval_policy || "on-request");
    } catch {
      /* a later read corrects the optimistic state */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-trow" aria-busy={busy}>
      <div>
        <div className="tt">{t("settings.approvalPolicyTitle")}</div>
        <div className="td">{t("settings.approvalPolicyDesc")}</div>
        {policy === "never" && (
          <div className="td" style={{ marginTop: 4, color: "var(--danger)" }}>
            {t("settings.approvalPolicyNeverWarn")}
          </div>
        )}
      </div>
      <select
        className="set-input mdl-row-select"
        value={policy}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="untrusted">{t("settings.approvalPolicyUntrusted")}</option>
        <option value="on-failure">{t("settings.approvalPolicyOnFailure")}</option>
        <option value="on-request">{t("settings.approvalPolicyOnRequest")}</option>
        <option value="never">{t("settings.approvalPolicyNever")}</option>
      </select>
    </div>
  );
}

/** One workspace row: name + effective badge (override vs inherits), expandable into the
 *  two override selects. The empty option (`""`) clears the axis back to the Default by
 *  POSTing JSON `null` — see `merge_workspace_policy` on the gateway. */
function WorkspacePolicyRow({
  record,
  expanded,
  onToggle,
  onChanged,
}: {
  record: WorkspaceRecord;
  expanded: boolean;
  onToggle: () => void;
  onChanged: (updated: WorkspaceRecord) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const hasOverride = Boolean(record.sandbox_mode) || Boolean(record.approval_policy);

  const patch = async (
    field: "sandbox_mode" | "approval_policy",
    value: string,
  ) => {
    setBusy(true);
    try {
      // Empty selection → JSON `null` → clear the override back to inheriting the Default.
      const updated = await coreBridge.setWorkspacePolicy(record.id, {
        [field]: value === "" ? null : value,
      });
      onChanged(updated);
    } catch {
      /* a later reload corrects the row */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mdl-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <button
        type="button"
        className="mdl-row-main"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
        }}
      >
        <strong>{record.name}</strong>
        <span className={`set-badge ${hasOverride ? "green" : "muted"}`}>
          {hasOverride
            ? t("settings.sandboxBadgeOverride")
            : t("settings.sandboxBadgeInherit")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: "var(--s3)", display: "grid", gap: "var(--s3)" }} aria-busy={busy}>
          <div className="set-trow">
            <div>
              <div className="tt">{t("settings.sandboxModeTitle")}</div>
            </div>
            <select
              className="set-input mdl-row-select"
              value={record.sandbox_mode ?? ""}
              disabled={busy}
              onChange={(event) => void patch("sandbox_mode", event.target.value)}
            >
              <option value="">{t("settings.sandboxInheritOption")}</option>
              {SANDBOX_MODES.map((token) => (
                <option key={token} value={token}>
                  {t(SANDBOX_MODE_LABELS[token])}
                </option>
              ))}
            </select>
          </div>
          <div className="set-trow">
            <div>
              <div className="tt">{t("settings.approvalPolicyTitle")}</div>
            </div>
            <select
              className="set-input mdl-row-select"
              value={record.approval_policy ?? ""}
              disabled={busy}
              onChange={(event) => void patch("approval_policy", event.target.value)}
            >
              <option value="">{t("settings.sandboxInheritOption")}</option>
              {APPROVAL_POLICIES.map((token) => (
                <option key={token} value={token}>
                  {t(APPROVAL_POLICY_LABELS[token])}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

// i18n label keys for each token — reuse the Default block's existing strings so the
// per-workspace selects read identically to the global control.
const SANDBOX_MODE_LABELS: Record<(typeof SANDBOX_MODES)[number], string> = {
  "read-only": "settings.sandboxModeReadOnly",
  "workspace-write": "settings.sandboxModeWorkspace",
  danger: "settings.sandboxModeDanger",
};
const APPROVAL_POLICY_LABELS: Record<(typeof APPROVAL_POLICIES)[number], string> = {
  untrusted: "settings.approvalPolicyUntrusted",
  "on-failure": "settings.approvalPolicyOnFailure",
  "on-request": "settings.approvalPolicyOnRequest",
  never: "settings.approvalPolicyNever",
};

function WorkspacePolicyList() {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await coreBridge.workspaces();
        if (!cancelled) setWorkspaces(snapshot.workspaces);
      } catch {
        /* leave empty */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = (updated: WorkspaceRecord) => {
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === updated.id ? { ...w, ...updated } : w)),
    );
  };

  return (
    <>
      <div className="set-section-label" style={{ marginTop: "var(--s4)" }}>
        {t("settings.sandboxProjectsLabel")}
      </div>
      <p className="mdl-detail-sub" style={{ paddingLeft: "var(--s3)" }}>
        {t("settings.sandboxProjectsDesc")}
      </p>
      {loaded && workspaces.length === 0 ? (
        <p className="set-hint">{t("settings.sandboxNoProjects")}</p>
      ) : (
        workspaces.map((record) => (
          <WorkspacePolicyRow
            key={record.id}
            record={record}
            expanded={expanded === record.id}
            onToggle={() => setExpanded((cur) => (cur === record.id ? null : record.id))}
            onChanged={applyUpdate}
          />
        ))
      )}
    </>
  );
}

/** The Settings › Sandbox pane: global Default (top) + per-workspace overrides (below). */
export function SandboxSettingsView() {
  const { t } = useTranslation();
  return (
    <div className="mdl-pane">
      <div className="set-section-label">{t("settings.sandboxDefaultLabel")}</div>
      <p className="mdl-detail-sub" style={{ paddingLeft: "var(--s3)" }}>
        {t("settings.sandboxDefaultDesc")}
      </p>
      <SandboxModeBlock />
      <ApprovalPolicyBlock />
      <WorkspacePolicyList />
    </div>
  );
}
