import { useRoutineActivity } from "./StudioRoutineActivity";
import { useState } from "react";
import { StudioChatInput } from "./StudioChatInput";
import { Message } from "../ai-elements/message";

/** A deliberately scripted UX scenario, not a natural-language interpreter. */
export function StudioAutomationSimulation({ onClose }: { onClose: () => void }) {
  const activity = useRoutineActivity();
  const [started, setStarted] = useState(false);
  const [mailbox, setMailbox] = useState("");
  const [time, setTime] = useState("08:00");
  const [days, setDays] = useState("Lunedì–venerdì");
  const [result, setResult] = useState(false);
  const [confirmed, setActive] = useState(false);
  const active = confirmed && !!activity.routines.find((r) => r.id === "email-demo")?.active;
  const [request, setRequest] = useState("");
  const [feedback, setFeedback] = useState("");
  const [revised, setRevised] = useState(false);
  const resetResult = () => {
    setResult(false);
    setActive(false);
  };
  return (
    <section className="st-guided-demo" aria-label="Simulazione automazione email">
      <header>
        <button className="st-text-link" onClick={onClose}>
          ← Automazioni
        </button>
        <span>Scenario guidato · dati fittizi · nessun invio</span>
      </header>
      <h1>Un lavoro in meno, ogni mattina.</h1>
      {!started ? (
        <>
          <p>
            Prova a delegare a Vera il riepilogo delle email. Questa simulazione mostra il percorso
            completo che dovrà gestire il motore.
          </p>
          <button
            className="st-demo-example"
            onClick={() => {
              setRequest("Ogni mattina alle 8 controlla le email e fammele riassumere da @Vera");
              setStarted(true);
            }}
          >
            Ogni mattina alle 8 controlla le email e fammele riassumere da <strong>@Vera</strong>{" "}
            <span>Prova questa richiesta →</span>
          </button>
        </>
      ) : (
        <>
          <Message from="user">
            <p>{request}</p>
          </Message>
          <Message from="assistant">
            <p>
              Vera preparerà una sintesi delle nuove email, evidenziando richieste e scadenze. La
              troverai qui, senza inviare risposte ai mittenti.
            </p>
          </Message>
          <article className="st-demo-plan">
            <div className="st-demo-plan-title">
              <strong>Vera · Riepilogo delle email</strong>
              <span>{active ? "Attiva nella simulazione" : "Bozza"}</span>
            </div>
            <div className="st-demo-inline-fields">
              <label>
                Alle{" "}
                <input
                  aria-label="Ora del riepilogo"
                  type="time"
                  value={time}
                  onChange={(e) => {
                    setTime(e.target.value);
                    resetResult();
                  }}
                />
              </label>
              <label>
                Giorni{" "}
                <select
                  aria-label="Giorni del riepilogo"
                  value={days}
                  onChange={(e) => {
                    setDays(e.target.value);
                    resetResult();
                  }}
                >
                  <option>Lunedì–venerdì</option>
                  <option>Tutti i giorni</option>
                </select>
              </label>
              <span>Risultato: qui in Homun</span>
            </div>
            <label className="st-demo-mailbox">
              <strong>
                {mailbox ? "Casella da controllare" : "Quale casella deve controllare?"}
              </strong>
              <select
                aria-label="Casella da controllare"
                value={mailbox}
                onChange={(e) => {
                  setMailbox(e.target.value);
                  resetResult();
                }}
              >
                <option value="">Scegli una casella della demo</option>
                <option value="Ufficio">Ufficio · casella dimostrativa</option>
                <option value="Assistenza">Assistenza · casella dimostrativa</option>
              </select>
            </label>
            <details>
              <summary>Come lavorerà Vera</summary>
              <ol>
                <li>Legge solo le nuove email della casella scelta.</li>
                <li>Raggruppa richieste e scadenze con riferimenti ai messaggi.</li>
                <li>Prepara una sintesi privata da verificare qui.</li>
              </ol>
              <p>
                In stage: ogni sintesi resta da verificare. Nessuna risposta viene inviata. Modello
                e costo saranno mostrati dal motore; questa prova non consuma AI.
              </p>
            </details>
            {!active && (
              <div className="st-sim-actions">
                <button
                  className="st-btn dark"
                  disabled={!mailbox || !time}
                  onClick={() => {
                    setResult(true);
                    setFeedback("");
                  }}
                >
                  Prova con email di esempio
                </button>
              </div>
            )}
          </article>
          {result && (
            <article className="st-demo-result" aria-label="Anteprima del riepilogo">
              <span className="st-muted">Vera · anteprima simulata · {mailbox}</span>
              <h2>{revised ? "Le richieste urgenti" : "Il tuo riepilogo del mattino"}</h2>
              <p>
                {revised
                  ? "1 richiesta urgente da seguire."
                  : "3 email di esempio: una richiesta urgente, una scadenza e un aggiornamento."}
              </p>
              <h3>Da seguire</h3>
              <p>
                {mailbox === "Assistenza"
                  ? "Un cliente segnala un accesso bloccato e chiede supporto."
                  : "Rossi chiede un preventivo aggiornato entro domani."}
              </p>
              <details>
                <summary>Vedi email di origine · esempio</summary>
                <p>
                  «Buongiorno, potete{" "}
                  {mailbox === "Assistenza"
                    ? "aiutarmi a ripristinare l’accesso"
                    : "inviarci il preventivo aggiornato entro domani"}
                  ? Grazie.»
                </p>
              </details>
              {!revised && (
                <>
                  <h3>Da ricordare</h3>
                  <p>Il fornitore attende conferma della consegna di venerdì.</p>
                  <h3>Per informazione</h3>
                  <p>È disponibile il nuovo listino del fornitore.</p>
                </>
              )}
              {!active && (
                <>
                  <p>È il tipo di riepilogo che vuoi ricevere?</p>
                  <div className="st-sim-actions">
                    <button
                      className="st-btn"
                      onClick={() => {
                        setRevised(true);
                        setFeedback(
                          "Ricevuto: il riepilogo mostrerà soltanto le richieste urgenti.",
                        );
                      }}
                    >
                      Mostra solo le urgenze
                    </button>
                    <button
                      className="st-btn dark"
                      onClick={() => {
                        setActive(true);
                        activity.register({
                          id: "email-demo",
                          name: "Riepilogo email",
                          agent: "Vera",
                          schedule: `${days} alle ${time}`,
                          source: mailbox,
                          scope: revised ? "Solo richieste urgenti" : "Sintesi delle nuove email",
                          active: true,
                        });
                      }}
                    >
                      Va bene, attiva nella demo
                    </button>
                  </div>
                </>
              )}
            </article>
          )}
          {feedback && <p role="status">{feedback}</p>}
          {active && (
            <div className="st-demo-confirmation" role="status">
              <strong>Vera è pronta.</strong>
              <p>
                {days}, alle {time}, controllerà {mailbox} e preparerà{" "}
                {revised ? "le richieste urgenti" : "la sintesi"} qui. Ogni risultato sarà da
                verificare.
              </p>
              <small>
                Stato simulato per questa sessione. Nessuna casella collegata e nessuna
                pianificazione reale.
              </small>
              <button className="st-btn" onClick={() => activity.setSelected("email-demo")}>
                Apri automazione
              </button>
              <button
                className="st-text-link"
                onClick={() => {
                  setActive(false);
                  if (activity.routines.find((r) => r.id === "email-demo")?.active)
                    activity.toggle("email-demo");
                }}
              >
                Metti in pausa nella demo
              </button>
            </div>
          )}
        </>
      )}
      <StudioChatInput
        label="Messaggio nella simulazione"
        onSend={(text) => {
          if (!started) {
            setRequest(text || "Riepiloga le email con Vera");
            setStarted(true);
            setFeedback(
              "Stai provando lo scenario email: il percorso seguente è predefinito, non interpreta liberamente il testo.",
            );
          } else
            setFeedback(
              "In questa simulazione puoi scegliere casella, orario e giorni, provare il risultato e chiedere solo le urgenze usando le scelte qui sopra. Il motore gestirà le altre richieste.",
            );
        }}
      />
    </section>
  );
}
