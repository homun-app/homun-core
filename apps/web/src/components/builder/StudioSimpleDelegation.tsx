import { useEffect, useRef, useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import { useRoutineActivity } from "./StudioRoutineActivity";

type Entry = { id: number; who: "user" | "elio"; text: string };
type Choice = "start" | "board" | "move" | "schedule" | null;
export function StudioSimpleDelegation({ onClose }: { onClose: () => void }) {
  const activity = useRoutineActivity();
  const [messages, setMessages] = useState<Entry[]>([]);
  const [choice, setChoice] = useState<Choice>("start");
  const [board, setBoard] = useState("");
  const [moved, setMoved] = useState(false);
  const [scheduled, setScheduled] = useState(false);
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState("Lunedì–venerdì");
  const end = useRef<HTMLDivElement>(null);
  const task =
    board === "Clienti" ? "Confermare il preventivo Rossi" : "Ripristinare l’accesso al portale";
  const append = (who: Entry["who"], text: string) =>
    setMessages((all) => [...all, { id: Date.now() + all.length, who, text }]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages, choice]);
  function ask(text: string, files: File[] = []) {
    append("user", text || "Allegato");
    if (files.length) {
      append(
        "elio",
        "Questa prova non legge gli allegati. Usa la richiesta di esempio per provare il percorso.",
      );
      return;
    }
    if (!board) {
      append("elio", "Quale bacheca vuoi che controlli?");
      setChoice("board");
      return;
    }
    if (/sposta|assegna/i.test(text)) {
      // Demonstrate one declared intent; never silently substitute unsupported people or destinations.
      if (!/giulia/i.test(text) || !/lavorazione/i.test(text)) {
        append(
          "elio",
          "In questa prova puoi chiedermi: «Assegnalo a Giulia e spostalo in lavorazione». Altre azioni richiederanno il motore.",
        );
        return;
      }
      if (moved) {
        append("elio", "Questa scheda è già in lavorazione, assegnata a Giulia.");
        return;
      }
      append(
        "elio",
        `Sposterò “${task}” in In lavorazione e lo assegnerò a Giulia. La dipendenza dai materiali resterà aperta.`,
      );
      setChoice("move");
      return;
    }
    if (/ogni|ripeti|mattina/i.test(text)) {
      append(
        "elio",
        "Ripeterò il controllo della bacheca e ti porterò qui il risultato. Questa routine non sposta né assegna automaticamente i task.",
      );
      const hour = text.match(/alle\s+(\d{1,2})(?::(\d{2}))?/i);
      setTime(
        hour && Number(hour[1]) < 24 && Number(hour[2] || 0) < 60
          ? `${hour[1]!.padStart(2, "0")}:${hour[2] || "00"}`
          : "09:00",
      );
      setChoice("schedule");
      return;
    }
    append(
      "elio",
      "Per continuare questa simulazione, chiedimi di assegnare il task a Giulia e spostarlo in lavorazione, oppure di ripetere il controllo ogni mattina alle 9.",
    );
  }
  return (
    <section className="st-simple-chat" aria-label="Conversazione guidata con Elio">
      <header>
        <button className="st-text-link" onClick={onClose}>
          ← Torna
        </button>
        <strong>
          Elio <small>Operazioni e qualità</small>
        </strong>
        <span>Simulazione · nessuna azione esterna</span>
      </header>
      <div className="st-simple-history">
        {!messages.length && (
          <div className="st-simple-welcome">
            <h1>Affida un lavoro a Elio.</h1>
            <p>Partiamo da un controllo, poi decidi cosa fare.</p>
            <button
              className="st-demo-example"
              onClick={() => ask("Elio, guarda Trello e dimmi cosa dovremmo fare prima.")}
            >
              Guarda Trello e dimmi cosa fare prima →
            </button>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`st-simple-message ${m.who}`}>
            <small>{m.who === "user" ? "Tu" : "Elio"}</small>
            <p>{m.text}</p>
          </div>
        ))}
        {board && (
          <article className="st-simple-result" aria-label="Risultato del controllo">
            <small>Trello · {board} · esempio</small>
            <h2>{task}</h2>
            <p>
              Scade domani.{" "}
              {board === "Clienti"
                ? "Manca il listino aggiornato"
                : "Mancano le credenziali di test"}{" "}
              che deve fornire Giulia.
            </p>
            {moved && (
              <p role="status">
                <strong>In lavorazione · assegnato a Giulia</strong>
                <br />
                Aggiornato nella demo. Materiali ancora in attesa.
              </p>
            )}
            <details>
              <summary>Vedi fonti</summary>
              <p>Scheda Trello fittizia: «{task}. Scadenza domani. Materiali da recuperare.»</p>
              <p>Messaggio Mattermost fittizio di Giulia: «Recupero il materiale e vi aggiorno.»</p>
            </details>
          </article>
        )}
        {choice === "board" && (
          <div className="st-chat-followups" aria-label="Scegli bacheca">
            {["Prodotto", "Clienti"].map((b) => (
              <button
                key={b}
                onClick={() => {
                  setBoard(b);
                  append("user", b);
                  append(
                    "elio",
                    "Questo è il lavoro da affrontare prima: ha una scadenza vicina e manca un contributo. Ecco le fonti per verificarlo.",
                  );
                  setChoice(null);
                }}
              >
                {b}
              </button>
            ))}
          </div>
        )}
        {choice === "move" && (
          <div className="st-simple-choice">
            <p>
              <strong>{task}</strong>
              <br />
              Da fare → In lavorazione · Giulia
            </p>
            <div className="st-sim-actions">
              <button
                className="st-btn"
                onClick={() => {
                  setChoice(null);
                  append("elio", "Annullato. Nessuna modifica alla scheda.");
                }}
              >
                Annulla
              </button>
              <button
                className="st-btn dark"
                onClick={() => {
                  setMoved(true);
                  setChoice(null);
                  append(
                    "elio",
                    "Fatto nella simulazione. Ho aggiornato la scheda qui sotto; nessuna modifica è stata inviata a Trello.",
                  );
                }}
              >
                Conferma modifica
              </button>
            </div>
          </div>
        )}
        {choice === "schedule" && (
          <div className="st-simple-choice">
            <div className="st-demo-inline-fields">
              <label>
                Alle{" "}
                <input
                  aria-label="Ora del controllo"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <select
                aria-label="Giorni del controllo"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              >
                <option>Lunedì–venerdì</option>
                <option>Tutti i giorni</option>
              </select>
            </div>
            <div className="st-sim-actions">
              <button
                className="st-btn"
                onClick={() => {
                  setChoice(null);
                  append("elio", "Il controllo resta un lavoro singolo.");
                }}
              >
                Non ora
              </button>
              <button
                className="st-btn dark"
                disabled={!time}
                onClick={() => {
                  activity.register({
                    id: "planning-demo",
                    name: "Piano della squadra",
                    agent: "Elio",
                    source: board,
                    scope: "Priorità e dipendenze, da verificare",
                    schedule: `${days} alle ${time}`,
                    active: true,
                  });
                  setScheduled(true);
                  setChoice(null);
                  append(
                    "elio",
                    `Controllo ricorrente salvato nella demo: ${days.toLowerCase()} alle ${time}. Lo ritrovi in Automazioni; i risultati arrivano in Attività.`,
                  );
                }}
              >
                Conferma orario
              </button>
            </div>
          </div>
        )}
        {scheduled && choice === null && (
          <button className="st-text-link" onClick={() => activity.setSelected("planning-demo")}>
            Apri automazione →
          </button>
        )}
        {board && choice === null && (
          <div className="st-chat-followups" aria-label="Continua il lavoro">
            {!moved && (
              <button onClick={() => ask("Assegnalo a Giulia e spostalo in lavorazione")}>
                Assegnalo a Giulia e spostalo in lavorazione
              </button>
            )}
            {!scheduled && (
              <button onClick={() => ask("Fallo ogni mattina alle 9")}>
                Fallo ogni mattina alle 9
              </button>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      <StudioChatInput label="Scrivi a Elio" onSend={ask} />
    </section>
  );
}
