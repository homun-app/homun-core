import {
  defaultRule,
  initialSimulation,
  transition,
  simTime,
  wouldCycle,
  type Rule,
  type Simulation,
  type SimEvent,
} from "../../lib/studio-simulation";
import type { AssignedWork } from "./StudioToday";
const phases = {
  waiting: "In attesa dei requisiti",
  running: "Esecuzione in corso",
  review: "Risultato da approvare",
  delivered: "Risultato consegnato",
  paused: "In pausa",
  error: "Errore da risolvere",
};
export function StudioAutomation({
  task,
  tasks,
  onChange,
}: {
  task: AssignedWork;
  tasks: AssignedWork[];
  onChange: (t: AssignedWork) => void;
}) {
  const rule = task.rule || defaultRule;
  const sim = task.simulation || initialSimulation();
  const config = (value: Partial<Rule>) =>
    onChange({ ...task, rule: { ...rule, ...value }, simulation: initialSimulation() });
  const act = (event: SimEvent) => onChange({ ...task, simulation: transition(sim, event, rule) });
  const ready = (t: AssignedWork) => t.status === "done" && !!t.result?.trim();
  return (
    <details className="st-automation">
      <summary>
        Quando e come parte ·{" "}
        {rule.trigger === "interval"
          ? "ogni " + rule.every + " min"
          : rule.trigger === "event"
            ? "su evento"
            : rule.trigger === "task"
              ? "dopo un incarico"
              : "avvio manuale"}
      </summary>
      <p className="st-muted">
        Regole proposte per questo incarico. Modificarle azzera soltanto la prova sotto.
      </p>
      <label>
        Avvio
        <select
          aria-label="Avvio del lavoro"
          value={rule.trigger}
          onChange={(e) => config({ trigger: e.target.value as Rule["trigger"] })}
        >
          <option value="manual">Quando lo avvio io</option>
          <option value="interval">A intervalli</option>
          <option value="event">Quando arriva un evento</option>
          <option value="task">Quando un altro incarico consegna</option>
        </select>
      </label>
      {rule.trigger === "interval" && (
        <label>
          Ogni
          <select
            aria-label="Intervallo"
            value={rule.every}
            onChange={(e) => config({ every: Number(e.target.value) })}
          >
            <option value={30}>30 minuti</option>
            <option value={60}>1 ora</option>
            <option value={120}>2 ore</option>
            <option value={240}>4 ore</option>
            <option value={1440}>1 giorno</option>
          </select>
        </label>
      )}
      {rule.trigger === "event" && (
        <label>
          Evento atteso
          <input
            aria-label="Evento atteso"
            value={rule.source}
            onChange={(e) => config({ source: e.target.value })}
          />
        </label>
      )}
      <details>
        <summary>Orari, requisiti e limiti</summary>
        <label className="st-step-check">
          <input
            type="checkbox"
            checked={rule.weekdays}
            onChange={(e) => config({ weekdays: e.target.checked })}
          />
          Solo lunedì–venerdì
        </label>
        <div className="st-settings">
          <label>
            Dalle
            <select
              aria-label="Ora inizio finestra"
              value={rule.from}
              onChange={(e) => config({ from: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} disabled={h >= rule.until} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </label>
          <label>
            Alle
            <select
              aria-label="Ora fine finestra"
              value={rule.until}
              onChange={(e) => config({ until: Number(e.target.value) })}
            >
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                <option key={h} disabled={h <= rule.from} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="st-step-check">
          <input
            type="checkbox"
            checked={rule.needsFile}
            onChange={(e) => config({ needsFile: e.target.checked })}
          />
          Serve un materiale prima di partire
        </label>
        <label>
          Risultato necessario
          <select
            aria-label="Incarico necessario"
            value={rule.dependency}
            onChange={(e) => config({ dependency: e.target.value })}
          >
            <option value="">Nessuno</option>
            {tasks
              .filter((t) => t.id !== task.id && t.project === task.project)
              .map((t) => (
                <option key={t.id} value={t.id} disabled={wouldCycle(tasks, task.id, t.id)}>
                  {t.title} · {ready(t) ? "risultato disponibile" : "non pronto"}
                </option>
              ))}
          </select>
        </label>
        <label className="st-step-check">
          <input
            type="checkbox"
            checked={rule.approval}
            onChange={(e) => config({ approval: e.target.checked })}
          />
          Richiedi approvazione prima della consegna
        </label>
        <div className="st-settings">
          <label>
            Budget della prova (€)
            <input
              aria-label="Budget della prova"
              type="number"
              min=".01"
              step=".01"
              value={rule.budget}
              onChange={(e) => {
                if (Number(e.target.value) >= 0.01) config({ budget: Number(e.target.value) });
              }}
            />
          </label>
          <label>
            Costo per esecuzione (€)
            <input
              aria-label="Costo per esecuzione"
              type="number"
              min=".01"
              step=".01"
              value={rule.runCost}
              onChange={(e) => {
                if (Number(e.target.value) >= 0.01) config({ runCost: Number(e.target.value) });
              }}
            />
          </label>
        </div>
      </details>
      <div className="st-rule-summary">
        <strong>
          {rule.trigger === "interval"
            ? "Ogni " + rule.every + " minuti"
            : rule.trigger === "event"
              ? "All’evento: " + (rule.source || "da specificare")
              : rule.trigger === "task"
                ? "Alla consegna dell’incarico collegato"
                : "Su avvio manuale"}
        </strong>
        <p>
          {rule.weekdays ? "Lun–ven" : "Tutti i giorni"}, {rule.from}:00–{rule.until}:00 · orologio
          virtuale locale.
        </p>
        <p>
          {rule.needsFile ? "Attende il materiale. " : ""}
          {rule.dependency ? "Attende il risultato selezionato. " : ""}
          {rule.approval ? "Consegna dopo approvazione." : "Consegna senza approvazione."}
        </p>
        <small>
          Se già in corso, salta il nuovo avvio. Alla ripresa non recupera gli avvii persi. Nessun
          retry automatico.
        </small>
      </div>
      <details className="st-sim-panel">
        <summary>Prova il comportamento · simulazione</summary>
        <p className="st-muted">
          Orologio virtuale da lunedì alle 09:00. Non modifica lo stato reale della scheda, non usa
          file o modelli, non invia nulla.
        </p>
        {rule.trigger === "task" && !rule.dependency && (
          <p className="st-urgency">Scegli un incarico necessario prima di avviare la prova.</p>
        )}
        {rule.trigger === "event" && !rule.source.trim() && (
          <p className="st-urgency">Descrivi l’evento atteso.</p>
        )}
        <div className="st-sim-status" role="status">
          <strong>{phases[sim.phase]}</strong>
          <span>
            {simTime(sim.minute)} · {sim.runs} esecuzioni · {sim.spent.toFixed(2)} € /{" "}
            {rule.budget.toFixed(2)} €
          </span>
          {rule.trigger === "interval" && <small>Prossimo controllo: {simTime(sim.next)}</small>}
        </div>
        <div className="st-sim-actions">
          <button
            className="st-btn"
            disabled={
              (rule.trigger === "task" && !rule.dependency) ||
              (rule.trigger === "event" && !rule.source.trim())
            }
            onClick={() => act("start")}
          >
            Simula avvio
          </button>
          <button className="st-btn" onClick={() => act("tick")}>
            Avanza di {rule.every} min
          </button>
          <button className="st-btn" onClick={() => act("file")}>
            Simula arrivo materiale
          </button>
          <button className="st-btn" disabled={!sim.file} onClick={() => act("duplicate")}>
            Ripeti stesso evento
          </button>
          <button className="st-btn" disabled={!rule.dependency} onClick={() => act("dependency")}>
            Simula risultato collegato
          </button>
          <button
            className="st-btn"
            disabled={sim.phase !== "running"}
            onClick={() => act("finish")}
          >
            Simula fine lavoro
          </button>
          <button
            className="st-btn"
            disabled={sim.phase !== "review"}
            onClick={() => act("approve")}
          >
            Simula approvazione
          </button>
          <button
            className="st-btn"
            onClick={() => act(sim.phase === "paused" ? "resume" : "pause")}
          >
            {sim.phase === "paused" ? "Riprendi prova" : "Metti in pausa"}
          </button>
          <button className="st-btn" disabled={sim.phase !== "running"} onClick={() => act("fail")}>
            Simula errore
          </button>
          <button className="st-btn" disabled={sim.phase !== "error"} onClick={() => act("retry")}>
            Riprova
          </button>
          <button className="st-btn" onClick={() => act("changed")}>
            Simula materiali cambiati
          </button>
        </div>
        <button
          className="st-text-link"
          onClick={() => onChange({ ...task, simulation: initialSimulation() })}
        >
          Azzera prova
        </button>
        <h4>Diario della prova</h4>
        {sim.log.length ? (
          <ol className="st-sim-log">
            {sim.log.map((entry, i) => (
              <li key={i}>{entry}</li>
            ))}
          </ol>
        ) : (
          <p className="st-muted">
            Nessun evento ancora. Configura la regola e simula il primo avvio.
          </p>
        )}
      </details>
    </details>
  );
}
export type { Rule, Simulation };
