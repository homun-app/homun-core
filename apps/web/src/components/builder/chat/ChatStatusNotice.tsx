/**
 * Un avviso di stato del motore disegnato come messaggio di sistema:
 * centrato, discreto, né bolla di Homun né della persona. Gli errori
 * tipizzati ripassano da `HomunErrorNotice`; gli stati parlano con
 * role="status", gli errori bloccanti con role="alert".
 */
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import type { ChatStatusActionId, ChatStatusNotice } from "@/lib/chat-status-notices";

type Props = {
  notice: ChatStatusNotice;
  onAction?: ((id: ChatStatusActionId) => void) | undefined;
  /** Un'azione di refresh in corso ne disabilita il pulsante. */
  busy?: boolean;
};

export function ChatStatusNotice({ notice, onAction, busy = false }: Props) {
  return (
    <div
      className={`cw-chat-status cw-chat-status--${notice.severity}`}
      data-chat-status={notice.kind}
      role={notice.severity === "error" ? "alert" : "status"}
    >
      <p>{notice.text}</p>
      {notice.hint && <p className="cw-chat-status__hint">{notice.hint}</p>}
      {notice.error != null && (
        <HomunErrorNotice error={notice.error} className="cw-chat-status__error" />
      )}
      {notice.actions && notice.actions.length > 0 && (
        <div className="cw-chat-status__row">
          {notice.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="cw-secondary"
              disabled={busy && action.id === "refresh"}
              onClick={() => onAction?.(action.id)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
