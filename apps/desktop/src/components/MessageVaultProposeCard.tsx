import { Check, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  coreBridge,
  type VaultProposalAcceptResult,
} from "../lib/coreBridge";

export interface VaultProposal {
  category: string;
  label: string;
  redacted_preview: string;
  pending_id?: string;
}

export function VaultProposeCard({
  proposal,
  messageId,
  threadId,
}: {
  proposal: VaultProposal;
  messageId?: string;
  threadId?: string;
}) {
  const [status, setStatus] = useState<
    "idle" | "saving" | "saved" | "dismissed" | "conflict" | "error"
  >("idle");
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<VaultProposalAcceptResult | null>(null);

  const payload = {
    category: proposal.category,
    label: proposal.label,
    redacted_preview: proposal.redacted_preview,
    ...(proposal.pending_id ? { pending_id: proposal.pending_id } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
  };

  // A save can come back "created", "ignored", or "conflict".
  const applyResult = (result: VaultProposalAcceptResult) => {
    if (result.status === "conflict") {
      setConflict(result);
      setStatus("conflict");
      return;
    }
    setConflict(null);
    setStatus("saved");
    setNote(
      result.status === "ignored"
        ? "Già presente nel Vault."
        : `Salvato nel Vault (${result.record_id}).`,
    );
  };

  const save = async () => {
    setStatus("saving");
    setNote(null);
    try {
      applyResult(await coreBridge.vaultProposalAccept(payload));
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const resolveConflict = async (resolution: "add" | "update" | "ignore") => {
    setStatus("saving");
    setNote(null);
    try {
      applyResult(
        await coreBridge.vaultProposalAccept({
          ...payload,
          resolution,
          // update/ignore target the pre-existing record surfaced in the conflict.
          ...(resolution === "add"
            ? {}
            : { record_id: conflict?.existing?.id }),
        }),
      );
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const dismiss = async () => {
    setStatus("saving");
    setNote(null);
    try {
      await coreBridge.vaultProposalDismiss(payload);
      setStatus("dismissed");
      setNote("Proposta scartata.");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const busy = status === "saving";

  if (status === "saved") {
    return (
      <div className="cmp-confirm done">
        <Check size={15} />
        <span>Saved to Vault</span>
      </div>
    );
  }

  if (status === "dismissed") {
    return (
      <div className="cmp-confirm done">
        <Check size={15} />
        <span>Vault proposal dismissed</span>
      </div>
    );
  }

  if (status === "conflict" && conflict) {
    const isKeyMatch = conflict.match_type === "key";
    return (
      <div className="cmp-confirm">
        <div className="cmp-confirm-head">
          <ShieldCheck size={15} />
          <strong>Similar Vault record exists</strong>
          <span className="cmp-confirm-name">{proposal.category}</span>
        </div>
        <div className="cmp-confirm-fields">
          <label>Existing record</label>
          <input className="set-input" readOnly value={conflict.existing?.label ?? ""} />
          <label>Existing preview</label>
          <input
            className="set-input"
            readOnly
            value={conflict.existing?.redacted_preview ?? ""}
          />
        </div>
        <p className="cmp-confirm-note">
          {isKeyMatch
            ? "A record with the same key already exists with a different value. Update it, add a separate record, or keep the existing one."
            : "This value is already stored under a different record. Add it here too, update the existing one, or keep it as is."}
        </p>
        <div className="cmp-confirm-actions">
          <button
            className="set-btn primary"
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("update")}
          >
            Update existing
          </button>
          <button
            className="set-btn"
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("add")}
          >
            Add new
          </button>
          <button
            className="set-btn"
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("ignore")}
          >
            Keep existing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Sensitive data detected</strong>
        <span className="cmp-confirm-name">{proposal.category}</span>
      </div>
      <div className="cmp-confirm-fields">
        <label>Record</label>
        <input className="set-input" readOnly value={proposal.label} />
        <label>Redacted preview</label>
        <input className="set-input" readOnly value={proposal.redacted_preview} />
      </div>
      <p className="cmp-confirm-note">
        The value stays out of normal memory. Save stores the redacted record now; local PIN is
        required later to reveal or edit the value.
      </p>
      {status === "error" && <p className="cmp-confirm-err">Error: {note}</p>}
      <div className="cmp-confirm-actions">
        <button className="set-btn primary" type="button" disabled={busy} onClick={() => void save()}>
          Save to Vault
        </button>
        <button className="set-btn" type="button" disabled={busy} onClick={() => void dismiss()}>
          Do not save
        </button>
      </div>
    </div>
  );
}
