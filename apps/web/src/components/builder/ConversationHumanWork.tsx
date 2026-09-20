import { StudioChatInput } from "./StudioChatInput";
import type { Work } from "./conversation-types";
export function ConversationHumanWork({
  actions,
  work,
  person,
  viewer,
  onChange,
  onMaterials,
  context,
  unavailable,
}: {
  actions?: React.ReactNode;
  work: Work;
  person: string;
  viewer: string;
  onChange: (change: Partial<Work>) => void;
  onMaterials: () => void;
  context?: React.ReactNode;
  unavailable: boolean;
}) {
  const requester = work.requester || "Fabio";
  const owner = viewer === requester;
  const recipient = viewer === person;
  const canTalk = (owner || recipient) && !unavailable;
  function message(text: string, files: File[]) {
    if (!canTalk || (!text.trim() && !files.length)) return;
    onChange({
      messages: [
        ...work.messages,
        {
          who: owner ? "you" : "agent",
          sender: viewer,
          text: text || `${files.length} allegati condivisi`,
        },
      ],
      files: [...work.files, ...files],
      ...(recipient ? { humanDraft: text } : {}),
    });
  }
  function submit() {
    if (!recipient || work.phase !== "ready" || !work.humanDraft?.trim() || unavailable) return;
    onChange({
      phase: "review",
      humanResult: work.humanDraft,
      messages: [
        ...work.messages,
        {
          who: "agent",
          sender: person,
          text: "Ho consegnato il risultato. Puoi verificarlo qui accanto.",
        },
      ],
    });
  }
  return (
    <div className="cw-stage with-panel cs-stage">
      <section className="cw-conversation">
        <div className="cw-conversation-head">
          {actions}
          <span className="cw-avatar sage">{person[0]}</span>
          <div>
            <strong>{person}</strong>
            <span>Persona · incarico di {requester}</span>
          </div>
        </div>
        <div className="cw-history">
          <h1 className="cs-title">{work.title}</h1>
          {work.messages.map((m, i) => (
            <article
              className={`cw-message ${m.sender === viewer || (!m.sender && m.who === "you") ? "you" : "agent"}`}
              key={i}
            >
              <small>{m.sender || (m.who === "you" ? requester : person)}</small>
              <p>{m.text}</p>
            </article>
          ))}
        </div>
        <div className="cw-composer">
          {canTalk ? (
            <StudioChatInput
              label={`Messaggio a ${recipient ? requester : person}`}
              onSend={message}
            />
          ) : (
            <p className="cw-hint">
              {unavailable
                ? "Collaboratore rimosso. Conversazione conservata."
                : "Vista dimostrativa in sola lettura: questo incarico coinvolge il richiedente e il destinatario."}
            </p>
          )}
          <div className="cw-composer-caption">
            Vista di {viewer} · simulazione locale, nessun messaggio inviato
          </div>
        </div>
      </section>
      <aside className="cw-workspace cs-panel">
        <span className="cs-badge">
          {work.phase === "proposal"
            ? "Da assegnare"
            : work.phase === "ready"
              ? "Da svolgere"
              : work.phase === "review"
                ? "Da verificare"
                : "Concluso"}
        </span>
        <h2>
          {work.phase === "ready" && recipient
            ? "Il tuo incarico"
            : work.phase === "review"
              ? "Il risultato consegnato"
              : "Il lavoro, adesso"}
        </h2>
        <p>
          {person} svolge il lavoro · {requester} verifica
        </p>
        {owner && work.phase === "proposal" && (
          <>
            <label>
              Scadenza
              <input
                type="date"
                value={work.due}
                onChange={(e) => onChange({ due: e.target.value })}
              />
            </label>
            <button
              className="cw-primary"
              disabled={unavailable}
              onClick={() => onChange({ phase: "ready" })}
            >
              Assegna a {person}
            </button>
          </>
        )}
        {work.phase === "ready" && (
          <>
            {recipient ? (
              <>
                <p className="cw-hint">
                  Scrivi il risultato in chat e allega eventuali file. Poi consegnalo per la
                  verifica.
                </p>
                <button
                  className="cw-primary"
                  disabled={!work.humanDraft?.trim() || unavailable}
                  onClick={submit}
                >
                  Consegna risultato
                </button>
              </>
            ) : (
              <p className="cw-hint">
                L’incarico compare nelle richieste di {person}. Puoi aggiungere indicazioni nella
                chat.
              </p>
            )}
          </>
        )}
        {work.humanResult && (
          <div className="ch-result">
            <h3>Risultato</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{work.humanResult}</p>
          </div>
        )}
        {work.phase === "review" && owner && (
          <div className="cs-actions">
            <button
              className="cw-secondary"
              onClick={() =>
                onChange({
                  phase: "ready",
                  humanDraft: "",
                  messages: [
                    ...work.messages,
                    {
                      who: "you",
                      sender: viewer,
                      text: "Chiedo una revisione del risultato: le indicazioni sono in questa conversazione.",
                    },
                  ],
                })
              }
            >
              Chiedi revisione
            </button>
            <button
              className="cw-primary"
              onClick={() =>
                onChange({
                  phase: "approved",
                  messages: [
                    ...work.messages,
                    { who: "you", sender: viewer, text: "Risultato verificato e approvato." },
                  ],
                })
              }
            >
              Approva risultato
            </button>
          </div>
        )}
        {context}
        {work.due && <p className="cw-hint">Scadenza: {work.due}</p>}
        <button className="cs-link" onClick={onMaterials}>
          Materiali del lavoro ↗
        </button>
        {work.files.map((file, i) => (
          <p className="cw-file" key={i}>
            {file.name}
          </p>
        ))}
      </aside>
    </div>
  );
}
