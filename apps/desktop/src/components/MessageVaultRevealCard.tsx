import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { coreBridge } from "../lib/coreBridge";

export interface VaultRevealProposal {
  record_id: string;
  category: string;
  label: string;
  redacted_preview: string;
}

/** Unlocks a vault record on demand without writing the secret back into the transcript. */
export function VaultRevealCard({ proposal }: { proposal: VaultRevealProposal }) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "revealed" | "error">("idle");
  const [secretValue, setSecretValue] = useState("");
  const [showValue, setShowValue] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const busy = status === "running";

  const reveal = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.vaultRecordReveal(proposal.record_id, pin);
      setSecretValue(result.secret_value);
      setPin("");
      setShowValue(true);
      setStatus("revealed");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  return (
    <div className="cmp-confirm">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Vault unlock required</strong>
        <span className="cmp-confirm-name">{proposal.category}</span>
      </div>
      <div className="cmp-confirm-fields">
        <label>Record</label>
        <input className="set-input" readOnly value={proposal.label} />
        <label>Redacted preview</label>
        <input className="set-input" readOnly value={proposal.redacted_preview} />
      </div>
      {status !== "revealed" ? (
        <>
          <p className="cmp-confirm-note">
            Enter your local PIN to reveal this value on this device. The value is not saved back
            into the chat transcript.
          </p>
          <div className="cmp-confirm-fields">
            <label>Local PIN</label>
            <input
              className="set-input"
              inputMode="numeric"
              type="password"
              value={pin}
              disabled={busy}
              onChange={(event) => setPin(event.target.value)}
            />
          </div>
          {status === "error" && <p className="cmp-confirm-err">Error: {note}</p>}
          <div className="cmp-confirm-actions">
            <button
              className="set-btn primary"
              type="button"
              disabled={busy || pin.length === 0}
              onClick={() => void reveal()}
            >
              {busy ? "Unlocking..." : "Reveal value"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="cmp-confirm-fields">
            <label>Value</label>
            <input
              className="set-input"
              readOnly
              type={showValue ? "text" : "password"}
              value={secretValue}
            />
          </div>
          <div className="cmp-confirm-actions">
            <button className="set-btn" type="button" onClick={() => setShowValue((value) => !value)}>
              {showValue ? "Hide value" : "Show value"}
            </button>
            <button
              className="set-btn"
              type="button"
              onClick={() => {
                setSecretValue("");
                setStatus("idle");
                setShowValue(true);
              }}
            >
              Lock
            </button>
          </div>
        </>
      )}
    </div>
  );
}
