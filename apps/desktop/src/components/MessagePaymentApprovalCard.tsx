import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { coreBridge, type PaymentApprovalSnapshot } from "../lib/coreBridge";

export interface PaymentApprovalProposal {
  snapshot: PaymentApprovalSnapshot;
}

export function PaymentApprovalCard({
  proposal,
  messageId,
  threadId,
}: {
  proposal: PaymentApprovalProposal;
  messageId?: string;
  threadId?: string;
}) {
  const snapshot = proposal.snapshot;
  const [pin, setPin] = useState("");
  const [cvv, setCvv] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "approved" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);

  const approve = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result = await coreBridge.vaultPaymentApprovalApprove(snapshot, pin, cvv, {
        threadId,
        messageId,
      });
      setPin("");
      setCvv("");
      setStatus("approved");
      setNote(
        `Pagamento autorizzato: ${result.payment_approval_id}. L'autorizzazione scade tra ${result.expires_in_seconds}s.`,
      );
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };

  const amount = formatPaymentAmount(snapshot.amount_minor, snapshot.currency);
  const busy = status === "running";

  return (
    <div className="cmp-confirm destructive">
      <div className="cmp-confirm-head">
        <ShieldCheck size={15} />
        <strong>Conferma pagamento</strong>
        <span className="cmp-confirm-name">{amount}</span>
      </div>
      <div className="cmp-confirm-fields">
        <label>Merchant</label>
        <input readOnly value={snapshot.merchant} />
        <label>Dominio</label>
        <input readOnly value={snapshot.domain} />
        <label>Prodotto</label>
        <textarea className="set-input" readOnly rows={2} value={snapshot.product_summary} />
        <label>Metodo</label>
        <input readOnly value={snapshot.payment_method_label} />
      </div>
      <p className="cmp-confirm-note">
        Il click finale resta bloccato finché PIN e CVV one-shot non sono verificati localmente.
        Il CVV non viene salvato.
      </p>
      {status !== "approved" && (
        <div className="cmp-confirm-fields">
          <label>PIN locale</label>
          <input
            className="set-input"
            inputMode="numeric"
            type="password"
            value={pin}
            disabled={busy}
            onChange={(event) => setPin(event.target.value)}
          />
          <label>CVV/CV2 one-shot</label>
          <input
            className="set-input"
            inputMode="numeric"
            type="password"
            value={cvv}
            disabled={busy}
            onChange={(event) => setCvv(event.target.value)}
          />
        </div>
      )}
      {status === "error" && <p className="cmp-confirm-err">Errore: {note}</p>}
      {status === "approved" && note && <p className="cmp-confirm-note">{note}</p>}
      {status !== "approved" && (
        <div className="cmp-confirm-actions">
          <button
            className="set-btn primary"
            type="button"
            disabled={busy || pin.length === 0 || cvv.length === 0}
            onClick={() => void approve()}
          >
            {busy ? "Verifico..." : "Autorizza pagamento"}
          </button>
        </div>
      )}
    </div>
  );
}

function formatPaymentAmount(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
