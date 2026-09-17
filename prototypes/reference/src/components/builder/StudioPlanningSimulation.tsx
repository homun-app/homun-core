import { useRoutineActivity } from "./StudioRoutineActivity";
import { useState } from "react";
import { Message } from "../ai-elements/message";
import { StudioChatInput } from "./StudioChatInput";

/** Scripted experience target. Sources and outcomes are fixtures, never live services. */
export function StudioPlanningSimulation({ onClose }: { onClose: () => void }) {
  const activity = useRoutineActivity();
  const [started, setStarted] = useState(false);
  const [board, setBoard] = useState("");
  const [wiki, setWiki] = useState(true);
  const [chat, setChat] = useState(true);
  const [tested, setTested] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [confirmed, setActive] = useState(false);
  const active = confirmed && !!activity.routines.find((r) => r.id === "planning-demo")?.active;
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState("Lunedì–venerdì");
  const [notice, setNotice] = useState("");
  const [lastMessage, setLastMessage] = useState("");
  const [settings, setSettings] = useState(true);
  const [change, setChange] = useState<{ task: string; column: string; assignee: string } | null>(
    null,
  );
  const [cards, setCards] = useState<Record<string, { column: string; assignee: string }>>({});
  const [receipt, setReceipt] = useState("");
  function invalidate() {
    setChange(null);
    setReceipt("");
    setCards({});
    setTested(false);
    setActive(false);
    setNotice("Configurazione aggiornata. Prova il piano prima di confermarlo.");
  }
  const technical = board === "Prodotto";
  const task = technical ? "Ripristinare l’accesso al portale" : "Confermare il preventivo Rossi";
  const secondTask = technical
    ? "Aggiornare la guida di configurazione"
    : "Preparare la scheda del nuovo cliente";
  const dependency = technical
    ? "Credenziali dell’ambiente di test"
    : "Listino aggiornato del fornitore";
  return (
    <section className="st-guided-demo" aria-label="Simulazione piano di lavoro">
      <header>
        <button className="st-text-link" onClick={onClose}>
          ← Automazioni
        </button>
        <span>Scenario guidato · fonti e risultati fittizi</span>
      </header>
      <h1>Da task sparsi a un piano chiaro.</h1>
      {!started ? (
        <>
          <p>
            Questa prova usa lo stesso percorso delle email, con più fonti e un lavoro bloccato da
            un collega.
          </p>
          <button className="st-demo-example" onClick={() => setStarted(true)}>
            Ogni mattina alle 9, <strong>@Elio</strong>, controlla Trello, raccogli il contesto da
            Mattermost e dalla wiki e proponimi le priorità.<span>Prova questa richiesta →</span>
          </button>
        </>
      ) : (
        <>
          <Message from="user">
            <p>
              Ogni mattina alle 9, @Elio, controlla Trello, raccogli il contesto da Mattermost e
              dalla wiki e proponimi le priorità.
            </p>
          </Message>
          <Message from="assistant">
            <p>
              Preparo un piano con priorità motivate, fonti e dipendenze. Potrai verificarlo qui
              prima di modificare Trello.
            </p>
          </Message>
          <article className="st-demo-plan" aria-label="Piano proposto da Elio">
            <div className="st-demo-plan-title">
              <strong>Elio · Piano della squadra</strong>
              <span>
                {active ? "Attivo nella demo" : tested ? "Da verificare" : "Da preparare"}
              </span>
            </div>
            <button
              className="st-text-link"
              aria-expanded={settings}
              onClick={() => setSettings(!settings)}
            >
              {board || "Scegli bacheca"} · {days} alle {time} ·{" "}
              {settings ? "Nascondi dettagli" : "Modifica"}
            </button>
            {settings && (
              <>
                <label className="st-demo-mailbox">
                  <strong>Quale bacheca deve seguire?</strong>
                  <select
                    aria-label="Bacheca Trello della demo"
                    value={board}
                    onChange={(e) => {
                      setBoard(e.target.value);
                      invalidate();
                    }}
                  >
                    <option value="">Scegli una bacheca dimostrativa</option>
                    <option>Prodotto</option>
                    <option>Clienti</option>
                  </select>
                </label>
                <div className="st-demo-inline-fields">
                  <label>
                    Alle{" "}
                    <input
                      aria-label="Ora del piano"
                      type="time"
                      value={time}
                      onChange={(e) => {
                        setTime(e.target.value);
                        invalidate();
                      }}
                    />
                  </label>
                  <label>
                    Giorni{" "}
                    <select
                      aria-label="Giorni del piano"
                      value={days}
                      onChange={(e) => {
                        setDays(e.target.value);
                        invalidate();
                      }}
                    >
                      <option>Lunedì–venerdì</option>
                      <option>Tutti i giorni</option>
                    </select>
                  </label>
                </div>
                <fieldset className="st-demo-sources">
                  <legend>Contesto da consultare · connessioni simulate</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={chat}
                      onChange={(e) => {
                        setChat(e.target.checked);
                        invalidate();
                      }}
                    />{" "}
                    Mattermost · canale della squadra
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={wiki}
                      onChange={(e) => {
                        setWiki(e.target.checked);
                        invalidate();
                      }}
                    />{" "}
                    Wiki · procedure del progetto
                  </label>
                </fieldset>
                <p className="st-muted">
                  Accesso in lettura. Il piano resta qui in Homun. Elio è in stage; questa demo non
                  consuma AI.
                </p>
              </>
            )}
            {!tested ? (
              <div className="st-sim-actions">
                <button
                  className="st-btn dark"
                  disabled={!board || !time}
                  onClick={() => {
                    setTested(true);
                    setSettings(false);
                    setNotice("");
                  }}
                >
                  Prepara un piano di esempio
                </button>
              </div>
            ) : (
              <>
                <div className="st-demo-plan-output" aria-label="Anteprima del piano">
                  <details
                    className="st-demo-board"
                    open={Object.keys(cards).length > 0 || undefined}
                  >
                    <summary>Schede della bacheca · stato simulato</summary>
                    {[task, secondTask].map((title, index) => (
                      <div key={title}>
                        <strong>{title}</strong>
                        <p>
                          {cards[title]?.column || "Da fare"} ·{" "}
                          {cards[title]?.assignee || "Non assegnato"}
                        </p>
                        <button
                          className="st-text-link"
                          onClick={() => {
                            setChange({
                              task: title,
                              column: "",
                              assignee: cards[title]?.assignee || "Non assegnato",
                            });
                            setReceipt("");
                          }}
                        >
                          Sposta questa scheda
                        </button>
                        {index === 0 && (
                          <small>
                            La dipendenza da Giulia resta aperta anche se cambi colonna.
                          </small>
                        )}
                      </div>
                    ))}
                  </details>
                  <h2>
                    {blockedOnly ? "Cosa sta bloccando il lavoro" : "Le priorità di questa mattina"}
                  </h2>
                  <p>
                    {blockedOnly
                      ? "1 dipendenza da risolvere prima di procedere."
                      : "2 task di esempio: un lavoro da sbloccare e uno pronto per iniziare."}
                  </p>
                  <h3>
                    1. {task} <span className="st-mode-badge">In attesa</span>
                  </h3>
                  <p>
                    {dependency}: serve il contributo di Giulia.{" "}
                    {chat
                      ? "La dipendenza emerge dalla conversazione della squadra."
                      : "La dipendenza è indicata nella scheda Trello; non è stata verificata nelle conversazioni."}
                  </p>
                  <p>
                    <strong>Proposta:</strong> chiedere a Giulia il materiale mancante, poi
                    riprendere il task.
                  </p>
                  <details>
                    <summary>Perché questa priorità? · Vedi fonti</summary>
                    <p>
                      <strong>Trello · scheda dimostrativa:</strong> «{task}. Scadenza domani. In
                      attesa: {dependency.toLowerCase()}.»
                    </p>
                    {chat && (
                      <p>
                        <strong>Mattermost · messaggio dimostrativo di Giulia:</strong> «Posso
                        recuperarli entro le 14; confermo qui appena disponibili.»
                      </p>
                    )}
                    {wiki && (
                      <p>
                        <strong>Wiki · procedura dimostrativa:</strong> «Verificare i materiali di
                        partenza prima di procedere. Non chiudere il task senza controllo del
                        risultato.»
                      </p>
                    )}
                    <p>
                      Priorità proposta per la scadenza ravvicinata e la dipendenza.{" "}
                      {chat
                        ? "Le 14 sono una disponibilità dichiarata, non una consegna confermata."
                        : "La disponibilità di Giulia non è stata verificata."}
                    </p>
                  </details>
                  {!blockedOnly && (
                    <>
                      <h3>
                        2.{" "}
                        {technical
                          ? "Aggiornare la guida di configurazione"
                          : "Preparare la scheda del nuovo cliente"}{" "}
                        <span className="st-mode-badge autonomous">Pronto</span>
                      </h3>
                      <p>
                        Può procedere in parallelo. Nessuna dipendenza indicata nel task di esempio.
                      </p>
                      <details>
                        <summary>Vedi task di origine · esempio</summary>
                        <p>
                          Trello: «Materiali disponibili. Nessuna scadenza urgente. Preparare una
                          prima bozza.»
                        </p>
                      </details>
                    </>
                  )}
                  {!wiki && (
                    <p className="st-muted">
                      Wiki esclusa: il piano non è stato confrontato con le procedure aziendali.
                    </p>
                  )}
                  <details>
                    <summary>Passaggi del lavoro</summary>
                    <ol>
                      <li>Leggi i task della bacheca {board}.</li>
                      <li>Raccogli il contesto dalle fonti selezionate.</li>
                      <li>Proponi priorità e segnala dipendenze o dati mancanti.</li>
                      <li>Mostra il piano con le fonti per la verifica umana.</li>
                    </ol>
                  </details>
                </div>
                {!active && (
                  <>
                    <p>
                      Puoi correggere il risultato in chat: prova a scrivere{" "}
                      <strong>«Mostra solo i task bloccati»</strong>.
                    </p>
                    <div className="st-sim-actions">
                      <button
                        className="st-btn dark"
                        onClick={() => {
                          setActive(true);
                          activity.register({
                            id: "planning-demo",
                            name: "Piano della squadra",
                            agent: "Elio",
                            schedule: `${days} alle ${time}`,
                            source: board,
                            scope: blockedOnly ? "Solo task bloccati" : "Priorità e dipendenze",
                            active: true,
                          });
                        }}
                      >
                        Va bene, ripeti nella demo
                      </button>
                    </div>
                  </>
                )}
                {active && (
                  <div className="st-demo-confirmation" role="status">
                    <strong>Il piano ricorrente è configurato nella simulazione.</strong>
                    <p>
                      {days} alle {time}, Elio proporrà{" "}
                      {blockedOnly ? "i task bloccati" : "le priorità"} della bacheca {board}. Ogni
                      piano resterà da verificare. Nessun task modificato e nessun sollecito
                      inviato.
                    </p>
                    <button
                      className="st-btn"
                      onClick={() => activity.setSelected("planning-demo")}
                    >
                      Apri automazione
                    </button>
                    <button
                      className="st-text-link"
                      onClick={() => {
                        setActive(false);
                        if (activity.routines.find((r) => r.id === "planning-demo")?.active)
                          activity.toggle("planning-demo");
                      }}
                    >
                      Metti in pausa nella demo
                    </button>
                  </div>
                )}
              </>
            )}
          </article>
          {lastMessage && (
            <Message from="user">
              <p>{lastMessage}</p>
            </Message>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {change && tested && (
        <article className="st-demo-plan" aria-label="Modifica Trello proposta">
          <h2>Modifica proposta · {board}</h2>
          <p>Riguarda questa scheda. L’automazione rimane invariata.</p>
          <label className="st-demo-mailbox">
            {change.task ? "Scheda" : "Quale scheda vuoi spostare?"}
            <select
              aria-label="Scheda da spostare"
              value={change.task}
              onChange={(e) => setChange({ ...change, task: e.target.value })}
            >
              <option value="">Scegli una scheda</option>
              {[task, secondTask].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <div className="st-demo-inline-fields">
            <label>
              Destinazione{" "}
              <select
                aria-label="Colonna di destinazione"
                value={change.column}
                onChange={(e) => setChange({ ...change, column: e.target.value })}
              >
                <option value="">Scegli una colonna</option>
                <option>Da fare</option>
                <option>In lavorazione</option>
                <option>Completato</option>
              </select>
            </label>
            <label>
              Responsabile{" "}
              <select
                aria-label="Responsabile della scheda"
                value={change.assignee}
                onChange={(e) => setChange({ ...change, assignee: e.target.value })}
              >
                <option value="">Mantieni il responsabile attuale</option>
                <option>Non assegnato</option>
                <option>Giulia</option>
                <option>Fabio</option>
              </select>
            </label>
          </div>
          {change.task && (
            <p>
              <strong>Prima:</strong> {cards[change.task]?.column || "Da fare"} ·{" "}
              {cards[change.task]?.assignee || "Non assegnato"}
              <br />
              <strong>Dopo:</strong> {change.column || "Da scegliere"} ·{" "}
              {change.assignee || cards[change.task]?.assignee || "Non assegnato"}
            </p>
          )}
          {change.task === task && (
            <p className="st-muted">
              Il materiale atteso da Giulia non è ancora disponibile. Cambiare colonna non risolve
              questa dipendenza.
            </p>
          )}
          <div className="st-sim-actions">
            <button
              className="st-btn"
              onClick={() => {
                setChange(null);
                setNotice("Modifica annullata. Nessuna scheda cambiata.");
              }}
            >
              Annulla modifica
            </button>
            <button
              className="st-btn dark"
              disabled={!change.task || !change.column}
              onClick={() => {
                const person = change.assignee || cards[change.task]?.assignee || "Non assegnato";
                setCards((all) => ({
                  ...all,
                  [change.task]: { column: change.column, assignee: person },
                }));
                setReceipt(
                  `${change.task} → ${change.column} · ${person}. Modifica applicata alla bacheca simulata, non a Trello.`,
                );
                setChange(null);
                setNotice("");
              }}
            >
              Conferma modifica nella demo
            </button>
          </div>
        </article>
      )}
      {receipt && (
        <div className="st-demo-confirmation" role="status">
          <strong>Scheda aggiornata</strong>
          <p>{receipt}</p>
          <small>La routine e la verifica del piano non sono state modificate.</small>
        </div>
      )}
      <StudioChatInput
        label="Messaggio per Elio nella simulazione"
        onSend={(text, files) => {
          setLastMessage(text);
          if (files.length) {
            setNotice(
              "Gli allegati non sono elaborati in questo scenario guidato. La prova usa soltanto le fonti dimostrative selezionate.",
            );
            return;
          }
          if (!started) {
            setStarted(true);
            setNotice(
              "Scenario guidato Trello: la richiesta iniziale è predefinita. Non è collegato un modello.",
            );
            return;
          }
          if (!tested) {
            setNotice(
              "Scegli la bacheca e prepara il piano di esempio, poi potrai correggerlo qui.",
            );
            return;
          }
          setChange(null);
          setReceipt("");
          if (/\bsposta\b/i.test(text)) {
            const target =
              text.includes(task) || /primo|prima scheda/i.test(text)
                ? task
                : text.includes(secondTask) || /secondo|seconda scheda/i.test(text)
                  ? secondTask
                  : "";
            const column = /in lavorazione/i.test(text)
              ? "In lavorazione"
              : /completato/i.test(text)
                ? "Completato"
                : /da fare/i.test(text)
                  ? "Da fare"
                  : "";
            setChange({
              task: target,
              column,
              assignee: /giulia/i.test(text) ? "Giulia" : /fabio/i.test(text) ? "Fabio" : "",
            });
            setNotice(
              target
                ? "Controlla la modifica proposta prima di confermare."
                : "Ci sono due schede nel risultato: scegli quella a cui ti riferisci.",
            );
          } else if (/solo.*bloccat/i.test(text)) {
            setBlockedOnly(true);
            setActive(false);
            setNotice(
              "Ho aggiornato la stessa anteprima: ora mostra solo i task bloccati. Verifica la modifica prima di confermare.",
            );
          } else if (/tutti|anche.*pront/i.test(text)) {
            setBlockedOnly(false);
            setActive(false);
            setNotice("L’anteprima include di nuovo i task pronti e quelli bloccati.");
          } else
            setNotice(
              "Questa prova simula ‘solo i task bloccati’, ‘mostra tutti’ e ‘sposta il task in lavorazione e assegnalo a Giulia’. Le altre richieste richiedono il motore.",
            );
        }}
      />
      <small className="st-muted">
        Prova anche: «Sposta il primo task in lavorazione e assegnalo a Giulia». Prova UX
        predefinita, azzerata uscendo. Nessun collegamento a Trello, Mattermost o wiki.
      </small>
    </section>
  );
}
