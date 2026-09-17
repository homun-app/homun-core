import { useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
type Model = { id: string; name: string; kind: "local" | "remote"; endpoint: string };
const defaults = {
  name: "Il tuo spazio",
  zone: "Europe/Rome",
  budget: "50",
  alert: "80",
  routing: "ask",
  notify: "attention",
  localFirst: true,
};
export function StudioSettings({
  onAccess,
  people,
  tab,
}: {
  tab: string;
  onAccess: () => void;
  people: { id: string; name: string }[];
}) {
  const [values, setValues] = useState(defaults);
  const [models, setModels] = useState<Model[]>([]);
  const [choices, setChoices] = useState<Record<string, { primary: string; fallback: string }>>({});
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"local" | "remote">("local");
  const [error, setError] = useState("");
  const patch = (value: Partial<typeof defaults>) => {
    setValues((v) => ({ ...v, ...value }));
    setSaved(false);
  };
  const tabs = [
    ["space", "Generali"],
    ["models", "Modelli"],
    ["costs", "Costi e limiti"],
    ["notifications", "Notifiche"],
    ["data", "Dati e connessioni"],
  ];
  return (
    <>
      <span className="st-eyebrow">IL TUO AMBIENTE DI LAVORO</span>
      <h1>{tabs.find(([id]) => id === tab)?.[1] || "Impostazioni"}</h1>
      <p className="st-intro">Modelli, costi e preferenze della tua squadra.</p>
      <p className="st-settings-demo">
        Configurazione dimostrativa, mantenuta fino al ricaricamento. Nessuna impostazione viene
        applicata a modelli o servizi reali.
      </p>
      <div className="st-paper st-preferences">
        {tab === "space" && (
          <>
            <h2>Il tuo spazio</h2>
            <label>
              Nome dello spazio
              <input value={values.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label>
              Fuso orario
              <select value={values.zone} onChange={(e) => patch({ zone: e.target.value })}>
                <option>Europe/Rome</option>
                <option>Europe/London</option>
                <option>UTC</option>
                <option>America/New_York</option>
              </select>
            </label>
            <p className="st-muted">
              Proposta per le future automazioni. Il simulatore usa un orologio virtuale separato,
              il calendario corrente usa l’orario del dispositivo.
            </p>
            <button className="st-btn" onClick={onAccess}>
              Gestisci persone e accessi →
            </button>
          </>
        )}
        {tab === "models" && (
          <>
            <h2>Modelli disponibili</h2>
            <p className="st-muted">
              Aggiungi riferimenti locali o remoti. Ogni collaboratore potrà scegliere quali usare.
              In questa fase non vengono verificati.
            </p>
            {models.length ? (
              models.map((m) => (
                <div className="st-model-row" key={m.id}>
                  <span>
                    <strong>{m.name}</strong>
                    <small>
                      {m.kind === "local" ? "Locale" : "Remoto"} · configurazione da verificare
                    </small>
                    <small>{m.endpoint}</small>
                  </span>
                  <button
                    aria-label={"Rimuovi modello " + m.name}
                    onClick={() => {
                      setModels((all) => all.filter((x) => x.id !== m.id));
                      setChoices((all) =>
                        Object.fromEntries(
                          Object.entries(all).map(([id, c]) => [
                            id,
                            {
                              primary: c.primary === m.id ? "" : c.primary,
                              fallback: c.fallback === m.id ? "" : c.fallback,
                            },
                          ]),
                        ),
                      );
                      setSaved(false);
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
            ) : (
              <div className="st-settings-empty">
                Nessun modello configurato.
                <br />
                Puoi preparare un modello locale e aggiungere quelli remoti quando servono.
              </div>
            )}
            <button
              className="st-btn"
              onClick={() => {
                setAdding(!adding);
                setError("");
              }}
            >
              <Plus size={15} />
              Aggiungi modello
            </button>
            {adding && (
              <form
                className="st-model-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  const name = String(d.get("name") || "").trim();
                  const endpoint = String(d.get("endpoint") || "").trim();
                  try {
                    const url = new URL(endpoint);
                    if (
                      !["http:", "https:"].includes(url.protocol) ||
                      url.username ||
                      url.password ||
                      url.search ||
                      url.hash
                    )
                      throw Error();
                  } catch {
                    setError("Inserisci un URL HTTP o HTTPS, senza credenziali o parametri.");
                    return;
                  }
                  if (!name) return;
                  if (models.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
                    setError("Esiste già un modello con questo nome.");
                    return;
                  }
                  setModels((all) => [...all, { id: crypto.randomUUID(), name, kind, endpoint }]);
                  setAdding(false);
                  setSaved(false);
                }}
              >
                <label>
                  Nome del modello
                  <input name="name" required placeholder="Nome o identificativo del modello" />
                </label>
                <label>
                  Dove viene eseguito
                  <select value={kind} onChange={(e) => setKind(e.target.value as Model["kind"])}>
                    <option value="local">Sul mio computer</option>
                    <option value="remote">Servizio remoto</option>
                  </select>
                </label>
                <label>
                  Indirizzo del servizio
                  <input
                    type="url"
                    name="endpoint"
                    required
                    placeholder={
                      kind === "local" ? "http://localhost:11434" : "https://servizio.example"
                    }
                  />
                </label>
                <p className="st-muted">
                  La gestione protetta delle credenziali sarà collegata al motore. Non inserire
                  chiavi o token qui.
                </p>
                {error && (
                  <p role="alert" className="st-urgency">
                    {error}
                  </p>
                )}
                <button className="st-btn dark">Aggiungi alla bozza</button>
              </form>
            )}
            <h3>Modelli dei collaboratori</h3>
            <p className="st-muted">
              Associazione proposta: modello principale e alternativa. Verrà applicata dal motore.
            </p>
            {people.map((p) => (
              <div className="st-model-assignment" key={p.id}>
                <strong>{p.name}</strong>
                <div className="st-settings">
                  <label>
                    Principale
                    <select
                      aria-label={"Modello principale di " + p.name}
                      value={choices[p.id]?.primary || ""}
                      onChange={(e) => {
                        setChoices((c) => ({
                          ...c,
                          [p.id]: {
                            primary: e.target.value,
                            fallback:
                              c[p.id]?.fallback === e.target.value ? "" : c[p.id]?.fallback || "",
                          },
                        }));
                        setSaved(false);
                      }}
                    >
                      <option value="">Da scegliere</option>
                      {models.map((m) => (
                        <option value={m.id} key={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Alternativa
                    <select
                      aria-label={"Modello alternativo di " + p.name}
                      value={choices[p.id]?.fallback || ""}
                      onChange={(e) => {
                        setChoices((c) => ({
                          ...c,
                          [p.id]: { primary: c[p.id]?.primary || "", fallback: e.target.value },
                        }));
                        setSaved(false);
                      }}
                    >
                      <option value="">Nessuna</option>
                      {models
                        .filter((m) => m.id !== choices[p.id]?.primary)
                        .map((m) => (
                          <option value={m.id} key={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              </div>
            ))}
            <h3>Scelta del modello</h3>
            <label className="st-step-check">
              <input
                type="checkbox"
                checked={values.localFirst}
                onChange={(e) => patch({ localFirst: e.target.checked })}
              />
              Preferisci il locale per i lavori semplici
            </label>
            <label>
              Se serve un modello più capace
              <select value={values.routing} onChange={(e) => patch({ routing: e.target.value })}>
                <option value="ask">Chiedi prima di usare un modello remoto</option>
                <option value="budget">Consenti entro il budget del collaboratore</option>
                <option value="local">Rimani sui modelli locali</option>
              </select>
            </label>
            <p className="st-muted">
              La scelta o la delega a un agente specializzato dovrà rispettare permessi e budget.
              Questa è una preferenza proposta, non un criterio già eseguito.
            </p>
          </>
        )}
        {tab === "costs" && (
          <>
            <h2>Un limite chiaro alla spesa</h2>
            <label>
              Budget mensile dello spazio (€)
              <input
                type="number"
                min="0"
                step="1"
                value={values.budget}
                onChange={(e) => patch({ budget: e.target.value })}
              />
            </label>
            <label>
              Avvisa al raggiungimento del
              <select value={values.alert} onChange={(e) => patch({ alert: e.target.value })}>
                <option value="50">50%</option>
                <option value="80">80%</option>
                <option value="90">90%</option>
              </select>
            </label>
            <div className="st-rule-summary">
              <strong>Al limite: sospendi nuove esecuzioni a pagamento</strong>
              <p>
                Mostra il motivo e chiedi come procedere. I limiti dello spazio e del collaboratore
                devono valere insieme.
              </p>
            </div>
            <p className="st-muted">
              Costi di modelli remoti e servizi separati. Uso locale da stimare, non considerato
              automaticamente gratuito. Gli importi della home restano esempi; questo budget non
              viene applicato al simulatore.
            </p>
          </>
        )}
        {tab === "notifications" && (
          <>
            <h2>Quando richiamare la tua attenzione</h2>
            <label>
              Preferenza
              <select value={values.notify} onChange={(e) => patch({ notify: e.target.value })}>
                <option value="attention">Decisioni, errori e scadenze a rischio</option>
                <option value="results">Anche quando un risultato è pronto</option>
                <option value="digest">Riepilogo, più eventi urgenti</option>
              </select>
            </label>
            <div className="st-rule-summary">
              Le normali attese tra agenti restano nel progetto. Ti coinvolgono se devi intervenire
              o se la consegna è a rischio.
            </div>
            <p className="st-muted">
              Nessuna notifica di sistema, email o messaggio verrà inviato dalla demo.
            </p>
          </>
        )}
        {tab === "data" && (
          <>
            <h2>Dati e connessioni</h2>
            <p>
              File, note, incarichi e configurazioni vivono nella memoria della pagina.
              Ricaricandola, tornano i dati iniziali.
            </p>
            <div className="st-model-row">
              <span>
                <strong>Account e credenziali</strong>
                <small>Non collegati · nessuna credenziale richiesta</small>
              </span>
            </div>
            <div className="st-model-row">
              <span>
                <strong>Materiali e memoria dei progetti</strong>
                <small>Solo dimostrativi · nessuna indicizzazione o sincronizzazione</small>
              </span>
            </div>
            <div className="st-model-row">
              <span>
                <strong>Backup e installazione</strong>
                <small>Da collegare al motore, dopo la definizione della UX</small>
              </span>
            </div>
            <p className="st-muted">
              Il marketplace descrive le capacità disponibili. Qui saranno gestiti gli account
              condivisi; nei bot e nei progetti, gli accessi concessi.
            </p>
          </>
        )}
      </div>
      <div className="st-settings-save">
        <button
          className="st-btn dark"
          onClick={() => {
            if (
              !values.name.trim() ||
              !Number.isFinite(Number(values.budget)) ||
              Number(values.budget) < 0
            ) {
              setError("Verifica nome dello spazio e budget.");
              setSaved(false);
              return;
            }
            setError("");
            setSaved(true);
          }}
        >
          Conferma bozza impostazioni
        </button>
        {saved && (
          <span role="status">
            <Check size={16} />
            Bozza confermata · solo in questa sessione
          </span>
        )}
        {error && !adding && <span role="alert">{error}</span>}
      </div>
    </>
  );
}
