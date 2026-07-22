import { Check, Loader2, Pencil, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TurnSteeringRecord } from "../lib/chatApi";
import { canDelete, canEdit, canSendNow } from "../lib/chatSteeringState";

interface PendingSteeringQueueProps {
  rows: TurnSteeringRecord[];
  onEdit(row: TurnSteeringRecord, visiblePrompt: string, expectedRevision: number): Promise<void>;
  onDelete(row: TurnSteeringRecord, expectedRevision: number): Promise<void>;
  onSendNow(row: TurnSteeringRecord, expectedRevision: number): Promise<void>;
}

function attachmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const raw = record.display_name ?? record.displayName ?? record.name ?? record.title;
    if (typeof raw !== "string" || !raw.trim()) return [];
    const safeName = raw.trim().split(/[\\/]/).pop();
    return safeName ? [safeName] : [];
  });
}

export function PendingSteeringQueue({
  rows,
  onEdit,
  onDelete,
  onSendNow,
}: PendingSteeringQueueProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    if (editingId !== null && !rows.some((row) => row.steering_id === editingId)) {
      setEditingId(null);
      setDraft("");
    }
  }, [editingId, rows]);

  if (rows.length === 0) return null;

  const statusLabel = (row: TurnSteeringRecord) => {
    if (row.status === "claimed") return t("chat.steeringApplied");
    if (row.status === "held") return t("chat.steeringHeld");
    return t("chat.steeringPending");
  };

  const run = async (row: TurnSteeringRecord, action: () => Promise<void>) => {
    setBusyId(row.steering_id);
    try {
      await action();
    } catch {
      // ChatView owns the localized, durable error state; keep the card/edit draft intact.
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="pending-steering-queue" aria-label={t("chat.queueInstruction")}>
      {rows.map((row) => {
        const editing = editingId === row.steering_id;
        const names = attachmentNames(row.attachments);
        const busy = busyId === row.steering_id;
        return (
          <article className={`pending-steering-card ${row.status}`} key={row.steering_id}>
            <header>
              <span className="pending-steering-status">
                {row.status === "claimed" ? <Check size={13} /> : null}
                {statusLabel(row)}
              </span>
              <span className="pending-steering-position">#{rows.indexOf(row) + 1}</span>
            </header>

            {editing ? (
              <div className="pending-steering-edit">
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(null);
                      setDraft("");
                    }}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !draft.trim()}
                    onClick={() => void run(row, async () => {
                      await onEdit(row, draft.trim(), row.revision);
                      setEditingId(null);
                      setDraft("");
                    })}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            ) : (
              <p>{row.visible_prompt}</p>
            )}

            {names.length > 0 && (
              <ul className="pending-steering-attachments">
                {names.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
              </ul>
            )}

            {!editing && (canEdit(row) || canDelete(row) || canSendNow(row)) && (
              <footer>
                {canEdit(row) && (
                  <button
                    type="button"
                    disabled={busy}
                    title={t("chat.editInstruction")}
                    aria-label={t("chat.editInstruction")}
                    onClick={() => {
                      setEditingId(row.steering_id);
                      setDraft(row.visible_prompt);
                    }}
                  >
                    <Pencil size={13} />
                    <span>{t("chat.editInstruction")}</span>
                  </button>
                )}
                {canDelete(row) && (
                  <button
                    type="button"
                    disabled={busy}
                    title={t("chat.deleteInstruction")}
                    aria-label={t("chat.deleteInstruction")}
                    onClick={() => void run(row, () => onDelete(row, row.revision))}
                  >
                    <Trash2 size={13} />
                    <span>{t("chat.deleteInstruction")}</span>
                  </button>
                )}
                {canSendNow(row) && (
                  <button
                    type="button"
                    className="send-now"
                    disabled={busy}
                    onClick={() => void run(row, () => onSendNow(row, row.revision))}
                  >
                    <Send size={13} />
                    <span>{t("chat.sendNow")}</span>
                  </button>
                )}
              </footer>
            )}
            {busy && <Loader2 className="pending-steering-busy" size={12} aria-hidden="true" />}
          </article>
        );
      })}
    </div>
  );
}
