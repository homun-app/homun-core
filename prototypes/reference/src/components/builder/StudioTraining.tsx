import { useState } from "react";
export type TrainingActivity = {
  id: string;
  title: string;
  scope: string;
  mode: "stage" | "review" | "autonomous";
};
export function StudioTraining({
  activities,
  onChange,
}: {
  activities: TrainingActivity[];
  onChange: (items: TrainingActivity[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="st-paper st-training">
      <div className="st-section-head">
        <h2>Formazione e autonomia</h2>
        <button className="st-text-link" onClick={() => setAdding(!adding)}>
          + Attività
        </button>
      </div>
      <p className="st-muted">
        Le attività specifiche hanno regole proprie e partono in stage. Approvarne un risultato non
        cambia questa scelta.
      </p>
      {!activities.length && (
        <p>
          Nessuna regola specifica. Si usa il livello predefinito per i nuovi incarichi. Definisci
          un’attività quando vuoi affidargli una responsabilità ricorrente.
        </p>
      )}
      {activities.map((a) => (
        <div className="st-training-row" key={a.id}>
          <label>
            Attività
            <input
              value={a.title}
              onChange={(e) =>
                onChange(
                  activities.map((x) =>
                    x.id === a.id
                      ? {
                          ...x,
                          title: e.target.value,
                          mode: e.target.value.trim() ? x.mode : "stage",
                        }
                      : x,
                  ),
                )
              }
            />
          </label>
          <label>
            Ambito e limiti
            <textarea
              value={a.scope}
              placeholder="Quali materiali può usare? Dove deve fermarsi?"
              onChange={(e) =>
                onChange(
                  activities.map((x) =>
                    x.id === a.id
                      ? {
                          ...x,
                          scope: e.target.value,
                          mode: e.target.value.trim() ? x.mode : "stage",
                        }
                      : x,
                  ),
                )
              }
            />
          </label>
          <label>
            Come lavora
            <select
              value={a.mode}
              onChange={(e) =>
                onChange(
                  activities.map((x) =>
                    x.id === a.id ? { ...x, mode: e.target.value as TrainingActivity["mode"] } : x,
                  ),
                )
              }
            >
              <option value="stage">In stage · verifica ogni passaggio</option>
              <option value="review">Prepara · verifica il risultato</option>
              <option value="autonomous" disabled={!a.scope.trim() || !a.title.trim()}>
                Autonomo nell’ambito definito
              </option>
            </select>
          </label>
          <button
            className="st-text-link"
            onClick={() => onChange(activities.filter((x) => x.id !== a.id))}
          >
            Rimuovi attività
          </button>
        </div>
      ))}
      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const title = String(data.get("activity") || "").trim();
            if (!title) return;
            onChange([...activities, { id: crypto.randomUUID(), title, scope: "", mode: "stage" }]);
            setAdding(false);
          }}
        >
          <label>
            Nuova attività
            <input
              name="activity"
              required
              placeholder="Es. preparare il piano di lavoro settimanale"
            />
          </label>
          <button className="st-btn dark">Aggiungi in stage</button>
        </form>
      )}
      <p className="st-muted">
        Policy proposta per il motore. Accessi, budget e approvazioni degli strumenti restano
        vincoli separati.
      </p>
    </section>
  );
}
