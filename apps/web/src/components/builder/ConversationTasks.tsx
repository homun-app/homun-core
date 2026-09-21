import { useState } from "react";
export type TaskSummary = {
  id: string;
  title: string;
  agent: string;
  phase: string;
  status: string;
  due: string;
  project: string;
  unavailable: boolean;
  needsYou: boolean;
  /** What the person owes next, when the work is blocked on them. */
  nextStep?: string | undefined;
  /** Label for the opening action when the next step is explicit. */
  openLabel?: string | undefined;
};
export function ConversationTasks({
  onReveal,
  items,
  onOpen,
  onDue,
  onMove,
}: {
  onReveal: () => void;
  items: TaskSummary[];
  onOpen: (id: string) => void;
  onDue: (id: string, date: string) => void;
  onMove: (id: string, phase: string) => string;
}) {
  const [feedback, setFeedback] = useState("");
  const [view, setView] = useState("Elenco");
  const [focus, setFocus] = useState("Tutti");
  const [query, setQuery] = useState("");
  const [selected, setSelectedValue] = useState("");
  function setSelected(id: string) {
    setSelectedValue(id);
    if (id) onReveal();
  }
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const item = items.find((i) => i.id === selected);
  const visible = items.filter(
    (i) =>
      (focus === "Tutti" ||
        (focus === "Richiede te"
          ? i.needsYou
          : focus === "In corso"
            ? i.phase === "ready"
            : ["review", "approved"].includes(i.phase))) &&
      (i.title + " " + i.agent + " " + i.project).toLowerCase().includes(query.toLowerCase()),
  );
  const phases = [
    ["proposal", "Da concordare"],
    ["waiting", "Richiede un contributo"],
    ["ready", "Pronti"],
    ["review", "Da verificare"],
    ["approved", "Conclusi"],
  ];
  function card(i: TaskSummary) {
    return (
      <div key={i.id} className="ct-card-row">
        <button
          className="ct-card"
          draggable={!i.unavailable}
          onDragStart={(e) => e.dataTransfer.setData("text/plain", i.id)}
          onClick={() => onOpen(i.id)}
        >
          <strong>{i.title}</strong>
          <small>
            {i.agent}
            {i.unavailable ? " · agente eliminato" : ""} · {i.project || "Senza progetto"}
          </small>
          <small>
            {i.status}
            {i.due ? ` · ${i.due}` : ""}
          </small>
        </button>
        <button
          className="ct-manage"
          aria-label={"Dettagli: " + i.title}
          onClick={() => setSelected(i.id)}
        >
          ···
        </button>
      </div>
    );
  }
  const year = Number(month.slice(0, 4)),
    m = Number(month.slice(5));
  const days = month ? new Date(year, m, 0).getDate() : 0;
  const offset = month ? (new Date(year, m - 1, 1).getDay() + 6) % 7 : 0;
  return (
    <div className="cw-stage with-panel cs-stage">
      <section className="cw-conversation">
        <div className="cw-history">
          <span className="cw-overline">COMPITI</span>
          <h1 className="cs-title">Il lavoro, a colpo d’occhio.</h1>
          <p className="cs-intro">Le stesse conversazioni, viste per stato o scadenza.</p>
          <div className="cs-actions">
            {["Elenco", "Kanban", "Calendario"].map((v) => (
              <button
                key={v}
                className={view === v ? "cw-primary" : "cw-secondary"}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="ct-focus-filters" aria-label="Stato del lavoro">
            {["Tutti", "Richiede te", "In corso", "Risultati"].map((label) => (
              <button key={label} aria-pressed={focus === label} onClick={() => setFocus(label)}>
                {label}
                <span>
                  {
                    items.filter(
                      (i) =>
                        label === "Tutti" ||
                        (label === "Richiede te"
                          ? i.needsYou
                          : label === "In corso"
                            ? i.phase === "ready"
                            : ["review", "approved"].includes(i.phase)),
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <input
            className="cs-member-search"
            aria-label="Cerca compiti"
            placeholder="Cerca lavoro, collaboratore o progetto…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {feedback && (
            <p role="status" className="cw-notice">
              {feedback}
            </p>
          )}
          {!visible.length && (
            <p className="cw-hint">
              Nessun compito. Inizia una conversazione dalla Home o da un progetto.
            </p>
          )}
          {!visible.length && <p className="cw-hint">Nessun lavoro corrisponde a questi filtri.</p>}
          {view === "Elenco" ? (
            visible.map(card)
          ) : view === "Kanban" ? (
            <div className="ct-board">
              {phases.map(([phase, label]) => (
                <section
                  key={phase}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/plain");
                    setSelected(id);
                    setFeedback(onMove(id, phase!));
                  }}
                >
                  <h3>
                    {label} <small>{visible.filter((i) => i.phase === phase).length}</small>
                  </h3>
                  {visible.filter((i) => i.phase === phase).map(card)}
                </section>
              ))}
            </div>
          ) : (
            <>
              <label>
                Mese
                <input
                  aria-label="Mese calendario"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </label>
              <div className="ct-calendar">
                {["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"].map((d) => (
                  <small key={d}>{d}</small>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <div key={`blank${i}`} />
                ))}
                {Array.from({ length: days }, (_, i) => {
                  const day = `${month}-${String(i + 1).padStart(2, "0")}`;
                  return (
                    <div key={day}>
                      <small>{i + 1}</small>
                      {visible.filter((w) => w.due.slice(0, 10) === day).map(card)}
                    </div>
                  );
                })}
              </div>
              <h3>Senza scadenza</h3>
              {visible.filter((i) => !i.due).map(card)}
            </>
          )}
        </div>
      </section>
      <aside className="cw-workspace cs-panel">
        {item ? (
          <>
            <span className="cs-badge">{item.status}</span>
            <h2>{item.title}</h2>
            <p>
              {item.agent} · {item.project || "Senza progetto"}
            </p>
            <label>
              Pronto entro
              <input
                type="date"
                aria-label="Scadenza compito"
                value={item.due.slice(0, 10)}
                onChange={(e) => onDue(item.id, e.target.value)}
              />
            </label>
            <p className="cw-hint">
              {item.unavailable
                ? "L’agente è stato eliminato. Lo storico è disponibile."
                : item.nextStep
                  ? item.nextStep
                  : item.phase === "waiting"
                    ? "Il lavoro aspetta un tuo contributo. Apri la conversazione per vedere cosa serve e fornirlo."
                    : item.phase === "review"
                      ? "Il risultato è pronto. Aprilo nella conversazione per verificarlo e dare indicazioni."
                      : "Apri la conversazione per vedere materiali, passaggi e prossima azione."}
            </p>
            <button className="cw-primary" onClick={() => onOpen(item.id)}>
              {item.openLabel
                ? item.openLabel
                : item.phase === "waiting"
                  ? "Fornisci il contributo"
                  : item.phase === "review"
                    ? "Verifica il risultato"
                    : "Apri conversazione"}{" "}
              ↗
            </button>
          </>
        ) : (
          <>
            <h2>Cosa richiede attenzione?</h2>
            <p className="cw-hint">
              {items.filter((i) => i.needsYou).length} attendono te ·{" "}
              {items.filter((i) => i.phase === "review").length} risultati da verificare.
            </p>
            <p className="cw-hint">
              Seleziona un compito. Lo stato segue il lavoro nella chat: una consegna e una verifica
              hanno effetti concreti, non sono soltanto etichette.
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
