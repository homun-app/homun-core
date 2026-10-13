/**
 * Slot dove il thread incontra gli stati del motore — mai tra i messaggi.
 *
 * Gli slot del thread passano dalle props `threadTop`/`threadEnd` di
 * `AgentChat`: dentro l'area scorrevole del viewport, dove si legge, ma
 * restano nodi esterni all'elenco messaggi del runtime — derivati dallo
 * stato del client, non inviati al motore né al contesto del modello.
 */
import type { ReactNode } from "react";

import type { ChatStatusNotice } from "@/lib/chat-status-notices";
import { ChatStatusNotice as Notice } from "./ChatStatusNotice";

function StatusSlot({ slot, children }: { slot: string; children: ReactNode }) {
  return (
    <div className="cw-chat-status-slot" data-chat-status-slot={slot}>
      {children}
    </div>
  );
}

/** Condizioni globali subito sopra il campo di scrittura, con l'esito breve di ripristino. */
export function ComposerStatusNotices({
  notices,
  resolved = false,
  busy = false,
  onAction,
}: {
  notices: ChatStatusNotice[];
  resolved?: boolean;
  busy?: boolean;
  onAction?: ((id: "refresh" | "open-models") => void) | undefined;
}) {
  if (!notices.length && !resolved) return null;
  return (
    <StatusSlot slot="composer">
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} onAction={onAction} busy={busy} />
      ))}
      {resolved && (
        <p className="cw-chat-status cw-chat-status--resolved" role="status">
          Connessione ripristinata.
        </p>
      )}
    </StatusSlot>
  );
}

/** Dichiarazione di fonte in cima a ogni conversazione (solo simulazione). */
export function ThreadTopStatusNotices({ notices }: { notices: ChatStatusNotice[] }) {
  if (!notices.length) return null;
  return (
    <StatusSlot slot="thread-top">
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} />
      ))}
    </StatusSlot>
  );
}

/** Condizioni della conversazione aperta in fondo al thread (followup). */
export function ThreadEndStatusNotices({ notices }: { notices: ChatStatusNotice[] }) {
  if (!notices.length) return null;
  return (
    <StatusSlot slot="thread-end">
      {notices.map((notice) => (
        <Notice key={notice.id} notice={notice} />
      ))}
    </StatusSlot>
  );
}
