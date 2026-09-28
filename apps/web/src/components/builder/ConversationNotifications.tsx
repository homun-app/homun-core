import { ArrowUpRight, X } from "lucide-react";
import type { Work } from "./conversation-types";
import { isHumanMember } from "./conversation-members";
import { scenarioForWork, type ConversationScenario } from "./conversation-scenarios";
import type { SpaceData } from "./ConversationSpace";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  pending: Work[];
  completedNotices: Work[];
  scenarios: ConversationScenario[];
  spaceData: SpaceData;
  onOpenWork: (id: string) => void;
};

export function ConversationNotifications({
  isOpen,
  onClose,
  pending,
  completedNotices,
  scenarios,
  spaceData,
  onOpenWork,
}: Props) {
  if (!isOpen) return null;

  const totalCount = pending.length + completedNotices.length;

  return (
    <section className="cw-notifications" aria-label="Pannello notifiche">
      <header>
        <strong>Notifiche</strong>
        <button
          className="cw-icon"
          aria-label="Chiudi notifiche"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      {!totalCount ? (
        <p>Niente in sospeso. Puoi concentrarti sul tuo lavoro.</p>
      ) : (
        pending.map((w) => (
          <button
            key={w.id}
            onClick={() => {
              onOpenWork(w.id);
              onClose();
            }}
          >
            <strong>
              {w.request?.status === "pending"
                ? w.request.need
                : w.phase === "ready" &&
                    isHumanMember(scenarioForWork(w, scenarios).agent, spaceData.profiles)
                  ? "Nuovo incarico"
                  : w.phase === "waiting"
                    ? scenarioForWork(w, scenarios).input
                    : "Verifica il risultato"}
            </strong>
            <small>
              {w.title} · {scenarioForWork(w, scenarios).agent}
            </small>
            <ArrowUpRight size={15} />
          </button>
        ))
      )}
      {completedNotices.length > 0 && (
        <>
          <strong>Risultati pronti</strong>
          {completedNotices.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                onOpenWork(w.id);
                onClose();
              }}
            >
              <strong>
                {w.autoDelivered ? "Consegnato in autonomia" : "Risultato approvato"}
              </strong>
              <small>
                {w.title} · {scenarioForWork(w, scenarios).agent}
              </small>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </>
      )}
    </section>
  );
}
